declare module 'watlas' {
	export class Atlas {
		addMesh(decl: {
			vertexPositionData: Float32Array;
			vertexCount: number;
			vertexPositionStride: number;
			vertexNormalData?: Float32Array;
			vertexNormalStride?: number;
			indexData?: Uint32Array | Uint16Array;
			indexCount?: number;
		}): void;
		generate(chartOptions?: Record<string, unknown>, packOptions?: Record<string, unknown>): void;
		getMesh(index: number): {
			indexCount: number;
			vertexCount: number;
			getIndexArray(jsArray: Uint32Array): boolean;
			getVertex(index: number): { uv: [number, number]; xref: number };
		};
		delete(): void;
		get width(): number;
		get height(): number;
		get meshCount(): number;
	}
	export function Initialize(): Promise<void>;
}

declare module 'jpeg-js' {
	const jpeg: {
		decode: (
			bytes: Uint8Array,
			options?: { useTArray?: boolean }
		) => { width: number; height: number; data: Uint8Array };
	};
	export default jpeg;
}
