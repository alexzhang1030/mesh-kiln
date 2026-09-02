import { DEFAULT_BAKE_SETTINGS, type BakeSettings, type BakeStage, type SourceMesh } from '../kernels/types';
import type { TopologyChoice } from '../kernels/topology';
import type { ImportSummary } from '../import-worker/parse-glb';
import type { BakeResponse, ImportResponse } from './protocol';
import { cloneSource, sourceTransferList } from './protocol';

export type SessionStatus = 'idle' | 'importing' | 'ready' | 'baking' | 'complete' | 'error';

export type SessionSnapshot = {
	status: SessionStatus;
	summary: ImportSummary | null;
	settings: BakeSettings;
	stage: BakeStage | null;
	progress: number;
	triangleCount: number | null;
	geometryTopology: TopologyChoice | null;
	error: string | null;
	resultName: string;
	hasResult: boolean;
	hasSource: boolean;
	sourceGen: number;
	atlasBaked: boolean;
	interactiveGeometry: boolean;
};

type Listener = (snapshot: SessionSnapshot) => void;

export class BakeSession {
	private importWorker: Worker;
	private bakeWorker: Worker;
	private source: SourceMesh | null = null;
	private result: ArrayBuffer | null = null;
	private sourceGlb: ArrayBuffer | null = null;
	private jobId = 1;
	private importJob = 0;
	private bakeJob = 0;
	private listeners = new Set<Listener>();
	private previewTimer: ReturnType<typeof setTimeout> | null = null;
	private lastGeometryOnly = false;
	private snapshot: SessionSnapshot = {
		status: 'idle',
		summary: null,
		settings: { ...DEFAULT_BAKE_SETTINGS },
		stage: null,
		progress: 0,
		triangleCount: null,
		geometryTopology: null,
		error: null,
		resultName: 'kiln-baked.glb',
		hasResult: false,
		hasSource: false,
		sourceGen: 0,
		atlasBaked: false,
		interactiveGeometry: false
	};

	constructor() {
		this.importWorker = new Worker(new URL('../import-worker/import-worker.ts', import.meta.url), {
			type: 'module'
		});
		this.bakeWorker = new Worker(new URL('../bake-worker/bake-worker.ts', import.meta.url), {
			type: 'module'
		});
		this.importWorker.onmessage = (event: MessageEvent<ImportResponse>) => this.onImport(event.data);
		this.bakeWorker.onmessage = (event: MessageEvent<BakeResponse>) => this.onBake(event.data);
		this.importWorker.onerror = (event) => this.fail(event.message || 'Import worker failed.');
		this.bakeWorker.onerror = (event) => this.fail(event.message || 'Bake worker failed.');
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		listener(this.snapshot);
		return () => this.listeners.delete(listener);
	}

	getSnapshot(): SessionSnapshot {
		return this.snapshot;
	}

	async importFile(file: File): Promise<void> {
		const glb = await file.arrayBuffer();
		this.sourceGlb = glb.slice(0);
		this.importJob = ++this.jobId;
		this.source = null;
		this.result = null;
		this.patch({
			status: 'importing',
			summary: null,
			error: null,
			hasResult: false,
			hasSource: true,
			sourceGen: this.snapshot.sourceGen + 1,
			triangleCount: null,
			geometryTopology: null,
			atlasBaked: false,
			resultName: file.name.replace(/\.glb$/i, '') + '-kiln.glb',
			stage: null,
			progress: 0
		});
		this.importWorker.postMessage({ type: 'import', jobId: this.importJob, glb }, [glb]);
	}

	setSettings(partial: Partial<BakeSettings>): void {
		this.patch({ settings: { ...this.snapshot.settings, ...partial } });
		if (!this.snapshot.interactiveGeometry || !this.source) return;
		if (this.snapshot.status === 'importing') return;
		const geometryKeys: Array<keyof BakeSettings> = [
			'triangleBudget',
			'topologyMode',
			'geometryTarget',
			'surfaceError',
			'voxelResolution'
		];
		if (!geometryKeys.some((key) => partial[key] !== undefined)) return;
		this.scheduleGeometryPreview();
	}

	setInteractiveGeometry(enabled: boolean): void {
		this.patch({ interactiveGeometry: enabled });
		if (!enabled || !this.source || this.snapshot.status === 'importing') return;
		this.scheduleGeometryPreview();
	}

	optimize(options: { geometryOnly?: boolean } = {}): void {
		if (!this.source) {
			this.fail('Drop a GLB before baking.');
			return;
		}
		this.bakeJob = ++this.jobId;
		const geometryOnly = options.geometryOnly === true;
		this.lastGeometryOnly = geometryOnly;
		const payload = cloneSource(this.source);
		this.result = null;
		this.patch({
			status: 'baking',
			error: null,
			hasResult: false,
			atlasBaked: false,
			stage: 'geometry',
			progress: 0,
			triangleCount: null,
			geometryTopology: null
		});
		this.bakeWorker.postMessage(
			{
				type: 'bake',
				jobId: this.bakeJob,
				source: payload,
				settings: { ...this.snapshot.settings, geometryOnly }
			},
			sourceTransferList(payload)
		);
	}

	cancel(): void {
		this.bakeJob = ++this.jobId;
		this.bakeWorker.postMessage({ type: 'cancel', jobId: this.bakeJob });
		if (this.source) {
			this.patch({ status: 'ready', stage: null, progress: 0 });
		} else {
			this.patch({ status: 'idle', stage: null, progress: 0 });
		}
	}

	takeResultCopy(): ArrayBuffer | null {
		if (!this.result) return null;
		return this.result.slice(0);
	}

	takeSourceCopy(): ArrayBuffer | null {
		if (!this.sourceGlb) return null;
		return this.sourceGlb.slice(0);
	}

	download(): void {
		if (!this.result) return;
		const blob = new Blob([this.result], { type: 'model/gltf-binary' });
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement('a');
		anchor.href = url;
		anchor.download = this.snapshot.resultName;
		anchor.click();
		URL.revokeObjectURL(url);
	}

	dispose(): void {
		if (this.previewTimer != null) clearTimeout(this.previewTimer);
		this.importWorker.terminate();
		this.bakeWorker.terminate();
		this.listeners.clear();
	}

	private scheduleGeometryPreview(): void {
		if (this.previewTimer != null) clearTimeout(this.previewTimer);
		this.previewTimer = setTimeout(() => {
			this.previewTimer = null;
			if (!this.source || !this.snapshot.interactiveGeometry) return;
			if (this.snapshot.status === 'importing') return;
			this.optimize({ geometryOnly: true });
		}, 280);
	}

	private onImport(message: ImportResponse): void {
		if (message.jobId !== this.importJob) return;
		switch (message.type) {
			case 'start':
				return;
			case 'complete':
				this.source = message.source;
				this.patch({ status: 'ready', summary: message.summary, error: null });
				return;
			case 'error':
				this.fail(message.message);
				return;
			default: {
				const exhausted: never = message;
				this.fail(`Unknown import message: ${String(exhausted)}`);
			}
		}
	}

	private onBake(message: BakeResponse): void {
		if (message.jobId !== this.bakeJob) return;
		switch (message.type) {
			case 'start':
				this.patch({
					status: 'baking',
					stage: message.stage,
					progress: 0,
					...(message.topology ? { geometryTopology: message.topology } : {})
				});
				return;
			case 'progress':
				this.patch({
					status: 'baking',
					stage: message.stage,
					progress: message.value,
					...(message.topology ? { geometryTopology: message.topology } : {})
				});
				return;
			case 'complete':
				this.result = message.glb;
				this.patch({
					status: 'complete',
					stage: 'export',
					progress: 1,
					hasResult: true,
					atlasBaked: message.topology === 'authored' || !this.lastGeometryOnly,
					triangleCount: message.triangleCount,
					geometryTopology: message.topology
				});
				return;
			case 'error':
				this.fail(message.message);
				return;
			default: {
				const exhausted: never = message;
				this.fail(`Unknown bake message: ${String(exhausted)}`);
			}
		}
	}

	private fail(message: string): void {
		this.patch({ status: 'error', error: message, stage: null });
	}

	private patch(partial: Partial<SessionSnapshot>): void {
		this.snapshot = { ...this.snapshot, ...partial };
		for (const listener of this.listeners) listener(this.snapshot);
	}
}
