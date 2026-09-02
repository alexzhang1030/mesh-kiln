/// <reference lib="webworker" />

import {
	ACESFilmicToneMapping,
	AmbientLight,
	Box3,
	Color,
	DataTexture,
	DirectionalLight,
	LineBasicMaterial,
	LineSegments,
	Mesh,
	MeshBasicMaterial,
	MeshStandardMaterial,
	NearestFilter,
	PMREMGenerator,
	PerspectiveCamera,
	PlaneGeometry,
	RepeatWrapping,
	SRGBColorSpace,
	Scene,
	Vector3,
	WebGLRenderer,
	WireframeGeometry,
	type Material,
	type Object3D
} from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { previewLook, type PreviewInspect, type PreviewLook, type PreviewShading } from './shading';

export type PreviewCommand =
	| {
			type: 'init';
			canvasA: OffscreenCanvas;
			canvasB: OffscreenCanvas;
			widthA: number;
			heightA: number;
			widthB: number;
			heightB: number;
			dpr: number;
	  }
	| { type: 'loadSource'; glb: ArrayBuffer }
	| { type: 'loadBaked'; glb: ArrayBuffer }
	| { type: 'clearSource' }
	| { type: 'clearBaked' }
	| { type: 'clear' }
	| { type: 'set'; wireframe: boolean; shading: PreviewShading; inspect: PreviewInspect }
	| { type: 'resize'; widthA: number; heightA: number; widthB: number; heightB: number; dpr: number }
	| { type: 'pointer'; kind: 'down' | 'move' | 'up'; x: number; y: number; button: number; shift: boolean }
	| { type: 'zoom'; delta: number };

type PreviewReady = { type: 'ready'; backend: 'webgpu' | 'webgl' };
type PreviewError = { type: 'error'; message: string };

type DragMode = 'orbit' | 'pan' | 'none';

type Pane = {
	canvas: OffscreenCanvas;
	renderer: WebGLRenderer;
	scene: Scene;
	camera: PerspectiveCamera;
	root: Object3D | null;
	overlays: LineSegments[];
	ambient: AmbientLight;
	sun: DirectionalLight;
	fill: DirectionalLight;
	ground: Mesh;
};

const ctx = self as DedicatedWorkerGlobalScope;
const SURFACE_GRAY = 0xc4c4c4;

let sourcePane: Pane | null = null;
let bakedPane: Pane | null = null;
let backend: 'webgpu' | 'webgl' = 'webgl';
let shading: PreviewShading = 'lit';
let inspect: PreviewInspect = 'result';
let wireframe = false;
let dragging: DragMode = 'none';
let lastX = 0;
let lastY = 0;
let yaw = 0.7;
let pitch = 0.45;
let distance = 3;
const target = new Vector3();
const panRight = new Vector3();
const panUp = new Vector3();
const panForward = new Vector3();
const worldUp = new Vector3(0, 1, 0);

ctx.onmessage = (event: MessageEvent<PreviewCommand>) => {
	void handle(event.data);
};

async function handle(command: PreviewCommand): Promise<void> {
	switch (command.type) {
		case 'init':
			await init(command);
			return;
		case 'loadSource':
			await loadGlb('source', command.glb, true);
			return;
		case 'loadBaked':
			await loadGlb('baked', command.glb, false);
			return;
		case 'clearSource':
			if (sourcePane) clearRoot(sourcePane);
			render();
			return;
		case 'clearBaked':
			if (bakedPane) clearRoot(bakedPane);
			render();
			return;
		case 'clear':
			if (sourcePane) clearRoot(sourcePane);
			if (bakedPane) clearRoot(bakedPane);
			render();
			return;
		case 'set':
			wireframe = command.wireframe;
			shading = command.shading;
			inspect = command.inspect;
			applyPreviewFlags();
			render();
			return;
		case 'resize':
			resize(command);
			return;
		case 'pointer':
			onPointer(command.kind, command.x, command.y, command.button, command.shift);
			return;
		case 'zoom':
			distance = Math.min(80, Math.max(0.4, distance * Math.exp(command.delta * 0.001)));
			updateCameras();
			render();
			return;
		default: {
			const exhausted: never = command;
			post({ type: 'error', message: `Unknown preview command: ${String(exhausted)}` });
		}
	}
}

async function init(command: Extract<PreviewCommand, { type: 'init' }>): Promise<void> {
	const pair = await createRenderers(command.canvasA, command.canvasB);
	backend = pair.backend;
	sourcePane = makePane(command.canvasA, pair.rendererA);
	bakedPane = makePane(command.canvasB, pair.rendererB);
	attachStudioIbl(sourcePane);
	attachStudioIbl(bakedPane);
	resize(command);
	updateCameras();
	render();
	post({ type: 'ready', backend });
}

async function loadGlb(side: 'source' | 'baked', glb: ArrayBuffer, fitCamera: boolean): Promise<void> {
	const pane = side === 'source' ? sourcePane : bakedPane;
	if (!pane) return;
	clearRoot(pane);
	try {
		const loader = new GLTFLoader();
		const parsed = await loader.parseAsync(glb, '');
		parsed.scene.traverse((obj) => {
			if (!(obj instanceof Mesh)) return;
			if (obj.userData.kilnHelper) return;
			obj.castShadow = false;
			obj.receiveShadow = false;
			const overlay = new LineSegments(
				new WireframeGeometry(obj.geometry),
				new LineBasicMaterial({
					color: 0xb7d3ea,
					transparent: true,
					opacity: 0.42,
					depthTest: true,
					depthWrite: false
				})
			);
			overlay.visible = wireframe;
			obj.add(overlay);
			pane.overlays.push(overlay);
		});
		pane.scene.add(parsed.scene);
		pane.root = parsed.scene;
		if (fitCamera) fit(parsed.scene);
		applyPreviewFlags();
		render();
	} catch (error) {
		post({
			type: 'error',
			message: error instanceof Error ? error.message : 'Preview failed to parse the GLB.'
		});
	}
}

function makePane(canvas: OffscreenCanvas, renderer: WebGLRenderer): Pane {
	const scene = new Scene();
	scene.background = new Color(0x0b0b0b);
	const camera = new PerspectiveCamera(45, 1, 0.05, 400);
	const ambient = new AmbientLight(0xfff4e8, 0.18);
	const sun = new DirectionalLight(0xffe0c2, 1.15);
	sun.position.set(2.4, 3.2, 1.6);
	const fill = new DirectionalLight(0x9bb6d4, 0.28);
	fill.position.set(-2.8, 1.4, -1.8);
	const ground = makeGround();
	scene.add(ambient, sun, fill, ground);
	return {
		canvas,
		renderer,
		scene,
		camera,
		root: null,
		overlays: [],
		ambient,
		sun,
		fill,
		ground
	};
}

function makeGround(): Mesh {
	const data = new Uint8Array([36, 36, 36, 255, 56, 56, 56, 255, 56, 56, 56, 255, 36, 36, 36, 255]);
	const map = new DataTexture(data, 2, 2);
	map.magFilter = NearestFilter;
	map.minFilter = NearestFilter;
	map.wrapS = RepeatWrapping;
	map.wrapT = RepeatWrapping;
	map.repeat.set(32, 32);
	map.colorSpace = SRGBColorSpace;
	map.generateMipmaps = false;
	map.needsUpdate = true;
	const mesh = new Mesh(new PlaneGeometry(80, 80), new MeshBasicMaterial({ map }));
	mesh.rotation.x = -Math.PI / 2;
	mesh.position.y = 0;
	mesh.userData.kilnHelper = true;
	mesh.frustumCulled = false;
	return mesh;
}

function clearRoot(pane: Pane): void {
	if (!pane.root) {
		disposeOverlays(pane);
		return;
	}
	pane.scene.remove(pane.root);
	pane.root.traverse((obj) => {
		if (!(obj instanceof Mesh) || obj.userData.kilnHelper) return;
		obj.geometry.dispose();
		disposeMaterial(obj.material);
	});
	disposeOverlays(pane);
	pane.root = null;
}

function disposeOverlays(pane: Pane): void {
	for (const overlay of pane.overlays) {
		overlay.geometry.dispose();
		disposeMaterial(overlay.material);
	}
	pane.overlays = [];
}

function disposeMaterial(material: Material | Material[]): void {
	if (Array.isArray(material)) {
		for (const item of material) item.dispose();
		return;
	}
	material.dispose();
}

function applyPreviewFlags(): void {
	for (const pane of [sourcePane, bakedPane]) {
		if (!pane) continue;
		for (const overlay of pane.overlays) overlay.visible = wireframe;
		if (pane.root) applyShading(pane.root);
	}
}

function applyShading(root: Object3D): void {
	const look = previewLook(inspect, shading);
	root.traverse((obj) => {
		if (!(obj instanceof Mesh) || obj.userData.kilnHelper) return;
		const original = originalMaterial(obj);
		const next = mapMaterials(original, (material) => previewMaterial(material, look));
		disposePreview(obj);
		if (next !== original) obj.userData.kilnPreviewMat = next;
		obj.material = next;
	});
}

function originalMaterial(mesh: Mesh): Material | Material[] {
	if (!mesh.userData.kilnOriginal) mesh.userData.kilnOriginal = mesh.material;
	return mesh.userData.kilnOriginal as Material | Material[];
}

function disposePreview(mesh: Mesh): void {
	const preview = mesh.userData.kilnPreviewMat as Material | Material[] | undefined;
	if (!preview) return;
	disposeMaterial(preview);
	mesh.userData.kilnPreviewMat = null;
}

function mapMaterials(
	material: Material | Material[],
	map: (item: Material) => Material
): Material | Material[] {
	if (Array.isArray(material)) return material.map(map);
	return map(material);
}

function previewMaterial(material: Material, look: PreviewLook): Material {
	switch (look.kind) {
		case 'mesh':
			return new MeshStandardMaterial({ color: SURFACE_GRAY, metalness: 0.05, roughness: 0.55 });
		case 'normal':
			return basicFrom(material, 'normal');
		case 'roughness':
			return basicFrom(material, 'roughness');
		case 'metallic':
			return basicFrom(material, 'metallic');
		case 'occlusion':
			return basicFrom(material, 'occlusion');
		case 'color':
			return look.lit ? litColorFrom(material) : basicFrom(material, 'color');
		case 'original':
			return material;
		default: {
			const exhausted: never = look;
			return exhausted;
		}
	}
}

function colorSources(material: Material): {
	std: MeshStandardMaterial | null;
	basic: MeshBasicMaterial | null;
} {
	return {
		std: material instanceof MeshStandardMaterial ? material : null,
		basic: material instanceof MeshBasicMaterial ? material : null
	};
}

function basicFrom(
	material: Material,
	channel: 'color' | 'normal' | 'roughness' | 'metallic' | 'occlusion'
): MeshBasicMaterial {
	const { std, basic } = colorSources(material);
	let map = std?.map ?? basic?.map ?? null;
	if (channel === 'normal') map = std?.normalMap ?? null;
	else if (channel === 'roughness') map = std?.roughnessMap ?? std?.metalnessMap ?? null;
	else if (channel === 'metallic') map = std?.metalnessMap ?? std?.roughnessMap ?? null;
	else if (channel === 'occlusion') map = std?.aoMap ?? std?.metalnessMap ?? std?.roughnessMap ?? null;
	return new MeshBasicMaterial({
		map,
		color: channel === 'color' ? (std?.color ?? basic?.color ?? new Color(0xffffff)) : new Color(0xffffff),
		vertexColors: Boolean(std?.vertexColors || basic?.vertexColors)
	});
}

function litColorFrom(material: Material): Material {
	if (!(material instanceof MeshStandardMaterial)) return basicFrom(material, 'color');
	return new MeshStandardMaterial({
		map: material.map,
		color: material.color,
		vertexColors: material.vertexColors,
		metalness: 0,
		roughness: 0.55
	});
}

function attachStudioIbl(pane: Pane): void {
	try {
		const environment = new RoomEnvironment();
		const pmrem = new PMREMGenerator(pane.renderer);
		pane.scene.environment = pmrem.fromScene(environment, 0.04).texture;
		pane.scene.environmentIntensity = 1;
		environment.dispose();
		pmrem.dispose();
	} catch {
		pane.ambient.intensity = 0.55;
		pane.sun.intensity = 1.35;
	}
}

function fit(object: Object3D): void {
	object.updateMatrixWorld(true);
	const box = new Box3();
	object.traverse((obj) => {
		if (!(obj instanceof Mesh) || obj.userData.kilnHelper) return;
		const geometry = obj.geometry;
		if (!geometry.boundingBox) geometry.computeBoundingBox();
		const geoBox = geometry.boundingBox;
		if (!geoBox || geoBox.isEmpty()) return;
		box.union(geoBox.clone().applyMatrix4(obj.matrixWorld));
	});
	if (box.isEmpty()) return;
	box.getCenter(target);
	const size = box.getSize(new Vector3());
	const radius = Math.max(size.length() * 0.5, 0.4);
	const fov = ((sourcePane ?? bakedPane)?.camera.fov ?? 45) * (Math.PI / 180);
	distance = Math.max((radius / Math.max(1e-4, Math.tan(fov * 0.5))) * 1.4, 1.6);
	yaw = 0.7;
	pitch = 0.45;
	const groundY = box.min.y;
	if (sourcePane) sourcePane.ground.position.y = groundY;
	if (bakedPane) bakedPane.ground.position.y = groundY;
	updateCameras();
}

function updateCameras(): void {
	for (const pane of [sourcePane, bakedPane]) {
		if (!pane) continue;
		const cp = Math.cos(pitch);
		pane.camera.position.set(
			target.x + Math.sin(yaw) * cp * distance,
			target.y + Math.sin(pitch) * distance,
			target.z + Math.cos(yaw) * cp * distance
		);
		pane.camera.lookAt(target);
	}
}

function resize(size: {
	widthA: number;
	heightA: number;
	widthB: number;
	heightB: number;
	dpr: number;
}): void {
	resizePane(sourcePane, size.widthA, size.heightA, size.dpr);
	resizePane(bakedPane, size.widthB, size.heightB, size.dpr);
	render();
}

function resizePane(pane: Pane | null, width: number, height: number, dpr: number): void {
	if (!pane) return;
	const w = Math.max(1, Math.floor(width * dpr));
	const h = Math.max(1, Math.floor(height * dpr));
	pane.canvas.width = w;
	pane.canvas.height = h;
	pane.renderer.setSize(width, height, false);
	pane.camera.aspect = width / Math.max(1, height);
	pane.camera.updateProjectionMatrix();
}

function onPointer(kind: 'down' | 'move' | 'up', x: number, y: number, button: number, shift: boolean): void {
	switch (kind) {
		case 'down':
			dragging = shift || button === 1 || button === 2 ? 'pan' : 'orbit';
			lastX = x;
			lastY = y;
			return;
		case 'up':
			dragging = 'none';
			return;
		case 'move':
			switch (dragging) {
				case 'none':
					return;
				case 'pan':
					panBy(x - lastX, y - lastY);
					break;
				case 'orbit':
					yaw -= (x - lastX) * 0.008;
					pitch = Math.min(1.4, Math.max(-1.4, pitch + (y - lastY) * 0.008));
					break;
				default: {
					const exhausted: never = dragging;
					void exhausted;
				}
			}
			lastX = x;
			lastY = y;
			updateCameras();
			render();
			return;
		default: {
			const exhausted: never = kind;
			void exhausted;
		}
	}
}

function panBy(dx: number, dy: number): void {
	const pane = sourcePane ?? bakedPane;
	if (!pane) return;
	const speed = distance * 0.0025;
	panForward.subVectors(target, pane.camera.position).normalize();
	panRight.crossVectors(panForward, worldUp);
	if (panRight.lengthSq() < 1e-8) panRight.set(1, 0, 0);
	else panRight.normalize();
	panUp.crossVectors(panRight, panForward).normalize();
	target.addScaledVector(panRight, -dx * speed);
	target.addScaledVector(panUp, dy * speed);
}

function render(): void {
	for (const pane of [sourcePane, bakedPane]) {
		if (!pane) continue;
		pane.renderer.render(pane.scene, pane.camera);
	}
}

async function createRenderers(
	canvasA: OffscreenCanvas,
	canvasB: OffscreenCanvas
): Promise<{ rendererA: WebGLRenderer; rendererB: WebGLRenderer; backend: 'webgpu' | 'webgl' }> {
	const gpuA = await tryWebGpu(canvasA);
	const gpuB = gpuA ? await tryWebGpu(canvasB) : null;
	if (gpuA && gpuB) {
		configureRenderer(gpuA);
		configureRenderer(gpuB);
		const nativeGpu = !isGlFallback(gpuA) && !isGlFallback(gpuB);
		return { rendererA: gpuA, rendererB: gpuB, backend: nativeGpu ? 'webgpu' : 'webgl' };
	}
	if (gpuA) {
		configureRenderer(gpuA);
		const rendererB = new WebGLRenderer({ canvas: canvasB, antialias: true, alpha: false });
		configureRenderer(rendererB);
		return { rendererA: gpuA, rendererB, backend: 'webgpu' };
	}
	const rendererA = new WebGLRenderer({ canvas: canvasA, antialias: true, alpha: false });
	const rendererB = new WebGLRenderer({ canvas: canvasB, antialias: true, alpha: false });
	configureRenderer(rendererA);
	configureRenderer(rendererB);
	return { rendererA, rendererB, backend: 'webgl' };
}

async function tryWebGpu(canvas: OffscreenCanvas): Promise<WebGLRenderer | null> {
	try {
		const gpu = (navigator as Navigator & { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu;
		if (!gpu) return null;
		const adapter = await gpu.requestAdapter();
		if (!adapter) return null;
		const mod = await import('three/webgpu');
		const renderer = new mod.WebGPURenderer({ canvas, antialias: true, alpha: false });
		await renderer.init();
		return renderer as unknown as WebGLRenderer;
	} catch {
		return null;
	}
}

function isGlFallback(renderer: WebGLRenderer): boolean {
	const backend = (renderer as { backend?: { isWebGLBackend?: boolean } }).backend;
	return Boolean(backend?.isWebGLBackend);
}

function configureRenderer(renderer: WebGLRenderer): void {
	renderer.toneMapping = ACESFilmicToneMapping;
	renderer.toneMappingExposure = 1;
	renderer.outputColorSpace = SRGBColorSpace;
}

function post(message: PreviewReady | PreviewError): void {
	ctx.postMessage(message);
}
