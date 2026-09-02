<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { EXAMPLES, exampleById, type ExampleId } from 'kiln/examples/catalog';
import {
	DEFAULT_BAKE_SETTINGS,
	MAP_SIZES,
	SURFACE_ERRORS,
	VOXEL_RESOLUTIONS,
	type GeometryTarget,
	type TopologyMode
} from 'kiln/kernels/types';
import { topologyChoiceLabel, type TopologyChoice } from 'kiln/kernels/topology';
import {
	attachPreview,
	type PreviewHandle,
	type PreviewInspect,
	type PreviewShading
} from 'kiln/preview/controller';
import { BakeSession, type SessionSnapshot } from 'kiln/session/session';
import {
	compareTriangleCounts,
	triangleCompareKicker,
	type TriangleCompare
} from 'kiln/session/triangle-compare';

const snapshot = reactive<SessionSnapshot>({
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
});

const sourceCanvas = ref<HTMLCanvasElement | null>(null);
const bakedCanvas = ref<HTMLCanvasElement | null>(null);
const previewError = ref<string | null>(null);
const wireframe = ref(false);
const shading = ref<PreviewShading>('lit');
const inspect = ref<PreviewInspect>('result');
const dragOver = ref(false);
const activeExample = ref<ExampleId | null>(null);

let session: BakeSession | null = null;
let preview: PreviewHandle | null = null;
let lastResultKey = false;
let lastSourceGen = 0;
let unsub: (() => void) | null = null;

onMounted(() => {
	session = new BakeSession();
	void nextTick(() => {
		try {
			if (sourceCanvas.value && bakedCanvas.value) {
				preview = attachPreview(
					sourceCanvas.value,
					bakedCanvas.value,
					() => undefined,
					(message) => {
						previewError.value = message;
					}
				);
				preview.set({ wireframe: wireframe.value, shading: shading.value, inspect: inspect.value });
				preview.resize();
			}
		} catch (error) {
			previewError.value = error instanceof Error ? error.message : 'Preview failed to start.';
		}
		unsub = session?.subscribe((next) => {
			Object.assign(snapshot, next);
			if (next.sourceGen !== lastSourceGen) {
				lastSourceGen = next.sourceGen;
				if (next.hasSource) {
					const glb = session?.takeSourceCopy();
					if (glb) preview?.loadSource(glb);
				} else {
					preview?.clearSource();
				}
				preview?.clearBaked();
			}
			if (next.hasResult && !lastResultKey) {
				const glb = session?.takeResultCopy();
				if (glb) preview?.loadBaked(glb);
			}
			if (!next.hasResult && lastResultKey) preview?.clearBaked();
			lastResultKey = next.hasResult;
		});
	});
});

onBeforeUnmount(() => {
	unsub?.();
	preview?.dispose();
	session?.dispose();
});

function onFiles(files: FileList | null): void {
	const file = files?.[0];
	if (!file) return;
	if (!file.name.toLowerCase().endsWith('.glb')) {
		snapshot.status = 'error';
		snapshot.error = 'Kiln reads GLB only.';
		return;
	}
	activeExample.value = null;
	void session?.importFile(file);
}

function onDrop(event: DragEvent): void {
	event.preventDefault();
	dragOver.value = false;
	onFiles(event.dataTransfer?.files ?? null);
}

async function loadExample(id: ExampleId): Promise<void> {
	const example = exampleById(id);
	activeExample.value = id;
	const response = await fetch(example.file);
	if (!response.ok) {
		snapshot.status = 'error';
		snapshot.error = `Could not load ${example.label}.`;
		return;
	}
	const buffer = await response.arrayBuffer();
	const file = new File([buffer], `${id}.glb`, { type: 'model/gltf-binary' });
	void session?.importFile(file);
}

function setBudget(event: Event): void {
	const value = Number((event.target as HTMLInputElement).value);
	session?.setSettings({ triangleBudget: Math.max(64, Math.floor(value) || 6000) });
}

function setTarget(event: Event): void {
	const value = (event.target as HTMLSelectElement).value as GeometryTarget;
	if (value === 'triangles' || value === 'error') session?.setSettings({ geometryTarget: value });
}

function setSurfaceError(event: Event): void {
	const value = Number((event.target as HTMLSelectElement).value);
	if (SURFACE_ERRORS.some((error) => error === value)) session?.setSettings({ surfaceError: value });
}

function setInteractive(event: Event): void {
	session?.setInteractiveGeometry((event.target as HTMLInputElement).checked);
}

function setTopology(event: Event): void {
	const value = (event.target as HTMLSelectElement).value as TopologyMode;
	if (value === 'auto' || value === 'voxel' || value === 'authored') {
		session?.setSettings({ topologyMode: value });
	}
}

function setMapSize(event: Event): void {
	const value = Number((event.target as HTMLSelectElement).value);
	if (MAP_SIZES.some((size) => size === value)) session?.setSettings({ mapSize: value });
}

function setVoxelResolution(event: Event): void {
	const value = Number((event.target as HTMLSelectElement).value);
	if (VOXEL_RESOLUTIONS.some((resolution) => resolution === value)) {
		session?.setSettings({ voxelResolution: value as (typeof VOXEL_RESOLUTIONS)[number] });
	}
}

function setShading(mode: PreviewShading): void {
	shading.value = mode;
	applyPreview();
}

function setInspect(event: Event): void {
	inspect.value = (event.target as HTMLSelectElement).value as PreviewInspect;
	applyPreview();
}

function applyPreview(): void {
	preview?.set({ wireframe: wireframe.value, shading: shading.value, inspect: inspect.value });
}

function formatTris(count: number | null | undefined): string {
	if (count == null) return '—';
	return `${count.toLocaleString()} tris`;
}

function bakedTriangleCompare(): TriangleCompare | null {
	const sourceCount = snapshot.summary?.triangleCount;
	const bakedCount = snapshot.triangleCount;
	if (!sourceCount || bakedCount == null || sourceCount <= 0) return null;
	return compareTriangleCounts(sourceCount, bakedCount);
}

function reductionLabel(): string | null {
	const compare = bakedTriangleCompare();
	if (!compare) return null;
	return triangleCompareKicker(compare);
}

function topologyResultLabel(topology: TopologyChoice): string {
	if (!snapshot.atlasBaked && topology !== 'authored') {
		return `${topologyChoiceLabel(topology)} · geometry only`;
	}
	const maps = topology === 'authored' ? 'source maps' : 'PBR atlas';
	return `${topologyChoiceLabel(topology)} + ${maps}`;
}

function bakedHudClass(): string {
	const compare = bakedTriangleCompare();
	if (!compare) return 'hud hud-baked';
	switch (compare.kind) {
		case 'reduced':
			return 'hud hud-baked hud-better';
		case 'worse':
			return 'hud hud-baked hud-worse';
		case 'same':
			return 'hud hud-baked hud-same';
		default: {
			const exhausted: never = compare;
			return exhausted;
		}
	}
}
</script>

<template>
	<main class="app">
		<section class="board">
			<header class="mast">
				<h1>Kiln</h1>
			</header>

			<label
				class="drop"
				:class="{ hot: dragOver, busy: snapshot.status === 'importing' || snapshot.status === 'baking' }"
				@dragover.prevent="dragOver = true"
				@dragleave="dragOver = false"
				@drop="onDrop"
			>
				<input
					type="file"
					accept=".glb,model/gltf-binary"
					@change="onFiles(($event.target as HTMLInputElement).files)"
				/>
				<span class="drop-title">Drop a .glb here</span>
				<span class="drop-copy">or click to open</span>
			</label>

			<div v-if="EXAMPLES.length" class="examples">
				<p class="examples-label">Examples</p>
				<div class="example-grid">
					<button
						v-for="example in EXAMPLES"
						:key="example.id"
						type="button"
						class="ghost example"
						:class="{ on: activeExample === example.id }"
						:disabled="snapshot.status === 'importing' || snapshot.status === 'baking'"
						@click="void loadExample(example.id)"
					>
						<strong>{{ example.label }}</strong>
					</button>
				</div>
			</div>

			<p v-if="snapshot.summary" class="stat">
				<span class="mono">{{ snapshot.summary.name }}</span>
				· {{ snapshot.summary.triangleCount.toLocaleString() }} tris
				· {{ snapshot.summary.materialCount }} materials
			</p>

			<fieldset class="settings">
				<legend>Bake</legend>
				<label class="field">
					<span>Target</span>
					<select :value="snapshot.settings.geometryTarget ?? 'triangles'" @change="setTarget">
						<option value="triangles">Triangle count</option>
						<option value="error">Surface error</option>
					</select>
				</label>
				<label v-if="(snapshot.settings.geometryTarget ?? 'triangles') === 'triangles'" class="field">
					<span>Count</span>
					<input
						type="number"
						min="64"
						max="200000"
						step="100"
						:value="snapshot.settings.triangleBudget"
						@input="setBudget"
					/>
				</label>
				<label v-else class="field">
					<span>Error</span>
					<select :value="snapshot.settings.surfaceError ?? 0.01" @change="setSurfaceError">
						<option v-for="error in SURFACE_ERRORS" :key="error" :value="error">
							{{ error }}
						</option>
					</select>
				</label>
				<label class="field">
					<span>Topology</span>
					<select :value="snapshot.settings.topologyMode" @change="setTopology">
						<option value="auto">Auto · model aware</option>
						<option value="voxel">Voxel remesh · PBR atlas</option>
						<option value="authored">Simplify authored mesh</option>
					</select>
					<small class="field-note">Auto voxel-remeshes open reconstructions, seam-welds dense sculpts, and keeps source maps on clean models unless the budget cuts more than half the triangles.</small>
				</label>
				<label class="field check">
					<input
						type="checkbox"
						:checked="snapshot.interactiveGeometry"
						@change="setInteractive"
					/>
					<span>Geometry only</span>
				</label>
				<label class="field">
					<span>Texture atlas</span>
					<select :value="snapshot.settings.mapSize" @change="setMapSize">
						<option v-for="size in MAP_SIZES" :key="size" :value="size">{{ size }} px</option>
					</select>
				</label>
				<label v-if="snapshot.settings.topologyMode === 'voxel'" class="field">
					<span>Voxel detail</span>
					<select :value="snapshot.settings.voxelResolution" @change="setVoxelResolution">
						<option v-for="resolution in VOXEL_RESOLUTIONS" :key="resolution" :value="resolution">
							{{ resolution }} cells
						</option>
					</select>
				</label>
			</fieldset>

			<p v-if="snapshot.status === 'baking'" class="stat">
				Baking… {{ Math.round(snapshot.progress * 100) }}%
			</p>

			<p v-if="snapshot.error" class="error" role="alert">{{ snapshot.error }}</p>

			<div class="actions">
				<button
					type="button"
					class="ember"
					:disabled="!snapshot.summary || snapshot.status === 'baking' || snapshot.status === 'importing'"
					@click="session?.optimize()"
				>
					{{ snapshot.status === 'baking' ? 'Baking…' : 'Bake' }}
				</button>
				<button type="button" class="ghost" :disabled="snapshot.status !== 'baking'" @click="session?.cancel()">
					Cancel
				</button>
				<button type="button" class="copper" :disabled="!snapshot.hasResult" @click="session?.download()">
					Download
				</button>
			</div>

			<p v-if="snapshot.hasResult && snapshot.triangleCount !== null" class="stat">
				Baked to {{ snapshot.triangleCount.toLocaleString() }} triangles
				<span v-if="snapshot.geometryTopology">
					· {{ topologyResultLabel(snapshot.geometryTopology) }}
				</span>
			</p>
		</section>

		<section class="stage">
			<div class="stage-bar">
				<span>Compare</span>
			</div>
			<div class="compare">
				<div class="pane">
					<div v-if="snapshot.hasSource" class="hud">
						<span class="hud-kicker">Original</span>
						<strong>{{ formatTris(snapshot.summary?.triangleCount) }}</strong>
					</div>
					<canvas ref="sourceCanvas" aria-label="Original mesh preview"></canvas>
					<div v-if="!snapshot.hasSource" class="empty">
						<p>Source on the left, baked on the right.</p>
					</div>
				</div>
				<div class="pane">
					<div v-if="snapshot.hasResult" :class="bakedHudClass()">
						<span class="hud-kicker">{{ reductionLabel() ?? 'Baked' }}</span>
						<strong>{{ formatTris(snapshot.triangleCount) }}</strong>
					</div>
					<canvas ref="bakedCanvas" aria-label="Baked mesh preview"></canvas>
					<div v-if="snapshot.status === 'baking'" class="empty">
						<p>Baking…</p>
					</div>
					<div v-else-if="snapshot.hasSource && !snapshot.hasResult" class="empty">
						<p>Baked mesh after Bake.</p>
					</div>
					<div v-if="previewError" class="empty"><p>{{ previewError }}</p></div>
				</div>
			</div>
			<div class="toggles">
				<div class="seg">
					<button type="button" :class="{ on: shading === 'lit' }" @click="setShading('lit')">Lit</button>
					<button type="button" :class="{ on: shading === 'unlit' }" @click="setShading('unlit')">Unlit</button>
				</div>
				<label class="inspect">
					<span>Maps</span>
					<select :value="inspect" @change="setInspect">
						<option value="result">Result</option>
						<option value="mesh">Mesh</option>
						<option value="baseColor">Base color</option>
						<option value="normal">Normal</option>
						<option value="roughness">Roughness</option>
						<option value="metallic">Metallic</option>
						<option value="occlusion">Occlusion</option>
					</select>
				</label>
				<label>
					<input v-model="wireframe" type="checkbox" @change="applyPreview" />
					Wireframe
				</label>
			</div>
		</section>
	</main>
</template>

<style scoped>
.app {
	min-height: 100dvh;
	height: 100dvh;
	overflow: hidden;
	display: grid;
	grid-template-columns: minmax(280px, 420px) 1fr;
}

.board {
	padding: 28px 24px 40px;
	border-right: 1px solid var(--line);
	background: linear-gradient(180deg, rgba(34, 28, 22, 0.92), rgba(20, 17, 14, 0.94));
	min-height: 0;
	overflow-y: auto;
}

.mast h1 {
	margin: 0 0 18px;
	font-size: clamp(2.4rem, 4vw, 3.4rem);
	letter-spacing: -0.04em;
	font-weight: 600;
}

.drop-copy,
.empty p {
	color: var(--muted);
	line-height: 1.45;
}

.drop {
	display: flex;
	flex-direction: column;
	gap: 6px;
	padding: 22px 18px;
	border: 1px dashed var(--line);
	border-radius: 14px;
	background: rgba(0, 0, 0, 0.18);
	cursor: pointer;
	position: relative;
}

.drop.hot,
.drop:hover {
	border-color: var(--ember);
	background: rgba(226, 103, 42, 0.08);
}

.drop.busy {
	opacity: 0.7;
}

.drop input {
	position: absolute;
	inset: 0;
	opacity: 0;
	cursor: pointer;
}

.drop-title {
	font-size: 1.15rem;
}

.actions,
.toggles,
.stage-bar {
	display: flex;
	align-items: center;
	gap: 12px;
	flex-wrap: wrap;
}

.examples {
	margin: 16px 0 0;
}

.examples-label {
	margin: 0 0 8px;
	color: var(--copper);
	text-transform: uppercase;
	letter-spacing: 0.14em;
	font-size: 0.72rem;
}

.example-grid {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 8px;
}

.example {
	text-align: left;
}

.example.on {
	border-color: var(--ember);
	background: rgba(226, 103, 42, 0.12);
}

.stat {
	margin: 14px 0 0;
}

.settings {
	border: 1px solid var(--line);
	border-radius: 14px;
	padding: 14px 14px 8px;
	margin: 18px 0 0;
}

.settings legend {
	padding: 0 6px;
	color: var(--copper);
}

.field {
	display: flex;
	flex-direction: column;
	gap: 6px;
	margin-bottom: 12px;
}

.field input[type='number'],
.field select {
	width: 100%;
	padding: 8px 10px;
	border-radius: 8px;
	border: 1px solid var(--line);
	background: var(--bg);
	color: var(--text);
}

.field-note {
	color: var(--muted);
	line-height: 1.35;
}

.field.check {
	flex-direction: row;
	align-items: center;
	gap: 8px;
}

.field.check input {
	width: auto;
}

.seg {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 6px;
}

.seg button,
.ghost,
.ember,
.copper {
	border-radius: 10px;
	border: 1px solid var(--line);
	padding: 9px 12px;
	background: var(--bg-2);
	color: var(--text);
}

.seg button.on,
.ember {
	background: var(--ember);
	border-color: var(--ember-deep);
	color: #fff8f2;
}

.copper {
	background: var(--copper);
	border-color: #b8863f;
	color: #2a1c0d;
}

.ghost:disabled,
.ember:disabled,
.copper:disabled {
	opacity: 0.4;
	cursor: not-allowed;
}

.actions {
	margin: 16px 0 12px;
}

.error {
	color: var(--danger);
}

.stage {
	display: flex;
	flex-direction: column;
	min-height: 0;
	height: 100%;
	overflow: hidden;
	padding: 16px;
}

.stage-bar {
	justify-content: space-between;
	padding: 4px 4px 10px;
	color: var(--muted);
}

.compare {
	flex: 1;
	min-height: 0;
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 8px;
}

.pane {
	position: relative;
	min-height: 0;
	border-radius: 16px;
	overflow: hidden;
	background: #0b0b0b;
	box-shadow: var(--shadow);
}

.hud {
	position: absolute;
	top: 14px;
	left: 16px;
	z-index: 2;
	pointer-events: none;
	display: flex;
	flex-direction: column;
	gap: 2px;
	text-shadow: 0 1px 8px rgba(0, 0, 0, 0.7);
}

.hud-baked {
	left: auto;
	right: 16px;
	text-align: right;
}

.hud-kicker {
	color: #cfcfcf;
	text-transform: uppercase;
	letter-spacing: 0.12em;
	font-size: 0.68rem;
}

.hud strong {
	font-size: clamp(1.35rem, 2.2vw, 1.9rem);
	letter-spacing: -0.03em;
	font-weight: 600;
}

.hud-better strong,
.hud-better .hud-kicker {
	color: #86e59a;
}

.hud-worse strong,
.hud-worse .hud-kicker {
	color: #e59a86;
}

.hud-same strong,
.hud-same .hud-kicker {
	color: #cfcfcf;
}

canvas {
	width: 100%;
	height: 100%;
	display: block;
	touch-action: none;
}

.empty {
	position: absolute;
	inset: 0;
	display: grid;
	place-items: center;
	padding: 24px;
	text-align: center;
	pointer-events: none;
}

.toggles {
	padding: 12px 4px 0;
	color: var(--muted);
}

.toggles .seg {
	width: min(220px, 100%);
}

.toggles .inspect {
	display: flex;
	align-items: center;
	gap: 8px;
	margin: 8px 0;
}

.toggles .inspect select {
	padding: 6px 8px;
	border-radius: 8px;
	border: 1px solid var(--line);
	background: var(--bg);
	color: var(--text);
}

@media (max-width: 840px) {
	.app {
		grid-template-columns: 1fr;
		height: auto;
		overflow: visible;
	}

	.board {
		border-right: 0;
		border-bottom: 1px solid var(--line);
		overflow: visible;
	}

	.stage {
		min-height: 70dvh;
		height: auto;
		overflow: visible;
	}

	.compare {
		grid-template-columns: 1fr;
		min-height: 80dvh;
	}

	.pane {
		min-height: 38dvh;
	}
}
</style>
