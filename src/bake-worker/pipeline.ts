import { remesh } from '../kernels/remesh';
import { simplifyAuthored } from '../kernels/simplify';
import { simplifySurface } from '../kernels/surface-simplify';
import { generateTangents } from '../kernels/tangents';
import { resolveTopologyForMesh, type TopologyChoice } from '../kernels/topology';
import type { BakeSettings, BakeStage, MeshGeometry, SourceMesh } from '../kernels/types';
import { resolveBakeSettings, triangleCountOf } from '../kernels/types';
import { unwrap } from '../kernels/unwrap';
import { sourceIsUnlit, writeAuthoredGlb, writeGeometryGlb, writeGlb } from '../kernels/write-glb';
import { bakeMaps } from './map-bake';

export type BakeProgressFn = (event: BakeProgressEvent) => void;

export type BakeProgressEvent =
	| { type: 'start'; stage: BakeStage; topology?: TopologyChoice }
	| { type: 'progress'; stage: BakeStage; value: number; topology?: TopologyChoice }
	| { type: 'complete'; glb: ArrayBuffer; triangleCount: number; topology: TopologyChoice }
	| { type: 'error'; message: string };

export type BakeControl = {
	isCancelled: () => boolean;
};

type GeometryPass =
	| { topology: 'voxel'; geometry: MeshGeometry }
	| { topology: 'surface'; geometry: MeshGeometry }
	| { topology: 'authored'; mesh: SourceMesh };

export async function runBake(
	source: SourceMesh,
	settings: BakeSettings,
	emit: BakeProgressFn,
	control: BakeControl = { isCancelled: () => false }
): Promise<void> {
	try {
		assertNotCancelled(control);
		const resolved = resolveBakeSettings(settings);
		const topology = resolveTopologyForMesh(resolved.topologyMode, source, {
			triangleBudget: resolved.triangleBudget,
			geometryTarget: resolved.geometryTarget
		});
		emit({ type: 'start', stage: 'geometry', topology });
		emit({ type: 'progress', stage: 'geometry', value: 0, topology });
		const pass = await runGeometry(
			source,
			resolved,
			topology,
			(value) => emit({ type: 'progress', stage: 'geometry', value, topology }),
			control
		);
		assertNotCancelled(control);
		emit({ type: 'progress', stage: 'geometry', value: 1, topology });

		if (resolved.geometryOnly && pass.topology !== 'authored') {
			emit({ type: 'start', stage: 'export', topology });
			emit({ type: 'progress', stage: 'export', value: 0, topology });
			const glb = await writeGeometryGlb(pass.geometry);
			assertNotCancelled(control);
			emit({ type: 'progress', stage: 'export', value: 1, topology });
			emit({
				type: 'complete',
				glb,
				triangleCount: triangleCountOf(pass.geometry.indices),
				topology: pass.topology
			});
			return;
		}

		switch (pass.topology) {
			case 'authored': {
				emit({ type: 'start', stage: 'export', topology });
				emit({ type: 'progress', stage: 'export', value: 0, topology });
				const glb = await writeAuthoredGlb(pass.mesh);
				assertNotCancelled(control);
				emit({ type: 'progress', stage: 'export', value: 1, topology });
				emit({
					type: 'complete',
					glb,
					triangleCount: triangleCountOf(pass.mesh.indices),
					topology: pass.topology
				});
				return;
			}
			case 'voxel':
			case 'surface': {
				emit({ type: 'start', stage: 'uv', topology });
				emit({ type: 'progress', stage: 'uv', value: 0, topology });
				const unwrapped = await unwrap(pass.geometry, settings.mapSize);
				assertNotCancelled(control);
				emit({ type: 'progress', stage: 'uv', value: 1, topology });

				emit({ type: 'start', stage: 'tangents', topology });
				emit({ type: 'progress', stage: 'tangents', value: 0, topology });
				const withTangents = await generateTangents(unwrapped);
				assertNotCancelled(control);
				emit({ type: 'progress', stage: 'tangents', value: 1, topology });

				emit({ type: 'start', stage: 'maps', topology });
				emit({ type: 'progress', stage: 'maps', value: 0, topology });
				const maps = await bakeMaps(
					source,
					withTangents,
					settings.mapSize,
					(value) => emit({ type: 'progress', stage: 'maps', value, topology }),
					control.isCancelled
				);
				assertNotCancelled(control);
				emit({ type: 'progress', stage: 'maps', value: 1, topology });

				emit({ type: 'start', stage: 'export', topology });
				emit({ type: 'progress', stage: 'export', value: 0, topology });
				const glb = await writeGlb(withTangents, maps, { unlit: sourceIsUnlit(source) });
				assertNotCancelled(control);
				emit({ type: 'progress', stage: 'export', value: 1, topology });
				emit({
					type: 'complete',
					glb,
					triangleCount: triangleCountOf(withTangents.indices),
					topology: pass.topology
				});
				return;
			}
			default: {
				const exhausted: never = pass;
				throw new Error(`Unknown geometry pass: ${String(exhausted)}`);
			}
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Bake failed.';
		if (message !== 'cancelled') emit({ type: 'error', message });
	}
}

async function runGeometry(
	source: SourceMesh,
	settings: ReturnType<typeof resolveBakeSettings>,
	topology: TopologyChoice,
	onProgress: (value: number) => void,
	control: BakeControl
): Promise<GeometryPass> {
	const input: MeshGeometry = {
		positions: source.positions,
		indices: source.indices,
		normals: source.normals
	};
	const error = settings.geometryTarget === 'error' ? settings.surfaceError : undefined;
	const qemTarget = error != null ? 4 : settings.triangleBudget;
	const remeshBudget = error != null ? Math.max(settings.triangleBudget, 30_000) : settings.triangleBudget;
	switch (topology) {
		case 'voxel': {
			const geometry = await remesh(input, remeshBudget, {
				voxelResolution: settings.voxelResolution,
				targetError: error,
				onProgress,
				isCancelled: control.isCancelled
			});
			return { geometry, topology };
		}
		case 'surface': {
			onProgress(0.1);
			const geometry = await simplifySurface(input, qemTarget, { targetError: error });
			onProgress(1);
			return { geometry, topology };
		}
		case 'authored': {
			onProgress(0.15);
			const mesh = await simplifyAuthored(source, qemTarget, { targetError: error });
			onProgress(1);
			return { mesh, topology };
		}
		default: {
			const exhausted: never = topology;
			throw new Error(`Unknown topology: ${String(exhausted)}`);
		}
	}
}

function assertNotCancelled(control: BakeControl): void {
	if (control.isCancelled()) throw new Error('cancelled');
}
