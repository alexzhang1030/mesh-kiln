export type { PreviewInspect, PreviewShading } from './shading';

export type PreviewHandle = {
	loadSource(glb: ArrayBuffer): void;
	loadBaked(glb: ArrayBuffer): void;
	clearSource(): void;
	clearBaked(): void;
	clear(): void;
	set(flags: { wireframe: boolean; shading: PreviewShading; inspect: PreviewInspect }): void;
	resize(): void;
	dispose(): void;
};

function takeOffscreen(canvas: HTMLCanvasElement): { canvas: HTMLCanvasElement; offscreen: OffscreenCanvas } {
	let node = canvas;
	if (typeof node.transferControlToOffscreen !== 'function') {
		const fresh = document.createElement('canvas');
		const label = node.getAttribute('aria-label');
		if (label) fresh.setAttribute('aria-label', label);
		fresh.className = node.className;
		node.replaceWith(fresh);
		node = fresh;
	}
	return { canvas: node, offscreen: node.transferControlToOffscreen() };
}

export function attachPreview(
	sourceCanvas: HTMLCanvasElement,
	bakedCanvas: HTMLCanvasElement,
	onBackend: (backend: 'webgpu' | 'webgl') => void,
	onError: (message: string) => void
): PreviewHandle {
	const sourceTaken = takeOffscreen(sourceCanvas);
	const bakedTaken = takeOffscreen(bakedCanvas);
	const sourceNode = sourceTaken.canvas;
	const bakedNode = bakedTaken.canvas;
	const worker = new Worker(new URL('./preview-worker.ts', import.meta.url), { type: 'module' });

	const sendSize = () => {
		const sourceRect = sourceNode.getBoundingClientRect();
		const bakedRect = bakedNode.getBoundingClientRect();
		worker.postMessage({
			type: 'resize',
			widthA: Math.max(1, sourceRect.width),
			heightA: Math.max(1, sourceRect.height),
			widthB: Math.max(1, bakedRect.width),
			heightB: Math.max(1, bakedRect.height),
			dpr: window.devicePixelRatio || 1
		});
	};

	worker.postMessage(
		{
			type: 'init',
			canvasA: sourceTaken.offscreen,
			canvasB: bakedTaken.offscreen,
			widthA: Math.max(1, sourceNode.clientWidth || 640),
			heightA: Math.max(1, sourceNode.clientHeight || 480),
			widthB: Math.max(1, bakedNode.clientWidth || 640),
			heightB: Math.max(1, bakedNode.clientHeight || 480),
			dpr: window.devicePixelRatio || 1
		},
		[sourceTaken.offscreen, bakedTaken.offscreen]
	);

	worker.onmessage = (event: MessageEvent<{ type: string; backend?: 'webgpu' | 'webgl'; message?: string }>) => {
		if (event.data.type === 'ready' && event.data.backend) onBackend(event.data.backend);
		if (event.data.type === 'error' && event.data.message) onError(event.data.message);
	};

	const bindCanvas = (canvas: HTMLCanvasElement) => {
		const onPointerDown = (event: PointerEvent) => {
			canvas.setPointerCapture(event.pointerId);
			worker.postMessage({
				type: 'pointer',
				kind: 'down',
				x: event.clientX,
				y: event.clientY,
				button: event.button,
				shift: event.shiftKey
			});
		};
		const onPointerMove = (event: PointerEvent) => {
			worker.postMessage({
				type: 'pointer',
				kind: 'move',
				x: event.clientX,
				y: event.clientY,
				button: event.button,
				shift: event.shiftKey
			});
		};
		const onPointerUp = (event: PointerEvent) => {
			worker.postMessage({
				type: 'pointer',
				kind: 'up',
				x: event.clientX,
				y: event.clientY,
				button: event.button,
				shift: event.shiftKey
			});
		};
		const onWheel = (event: WheelEvent) => {
			event.preventDefault();
			worker.postMessage({ type: 'zoom', delta: event.deltaY });
		};
		const onContextMenu = (event: Event) => {
			event.preventDefault();
		};
		canvas.addEventListener('pointerdown', onPointerDown);
		canvas.addEventListener('pointermove', onPointerMove);
		canvas.addEventListener('pointerup', onPointerUp);
		canvas.addEventListener('pointercancel', onPointerUp);
		canvas.addEventListener('wheel', onWheel, { passive: false });
		canvas.addEventListener('contextmenu', onContextMenu);
		return () => {
			canvas.removeEventListener('pointerdown', onPointerDown);
			canvas.removeEventListener('pointermove', onPointerMove);
			canvas.removeEventListener('pointerup', onPointerUp);
			canvas.removeEventListener('pointercancel', onPointerUp);
			canvas.removeEventListener('wheel', onWheel);
			canvas.removeEventListener('contextmenu', onContextMenu);
		};
	};

	const unbindSource = bindCanvas(sourceNode);
	const unbindBaked = bindCanvas(bakedNode);
	window.addEventListener('resize', sendSize);
	const observer = new ResizeObserver(() => sendSize());
	observer.observe(sourceNode);
	observer.observe(bakedNode);

	return {
		loadSource(glb) {
			worker.postMessage({ type: 'loadSource', glb }, [glb]);
		},
		loadBaked(glb) {
			worker.postMessage({ type: 'loadBaked', glb }, [glb]);
		},
		clearSource() {
			worker.postMessage({ type: 'clearSource' });
		},
		clearBaked() {
			worker.postMessage({ type: 'clearBaked' });
		},
		clear() {
			worker.postMessage({ type: 'clear' });
		},
		set(flags) {
			worker.postMessage({ type: 'set', ...flags });
		},
		resize: sendSize,
		dispose() {
			unbindSource();
			unbindBaked();
			window.removeEventListener('resize', sendSize);
			observer.disconnect();
			worker.terminate();
		}
	};
}
