import type { BakeSettings, BakeStage, RgbaImage, SourceMesh } from '../kernels/types';
import type { TopologyChoice } from '../kernels/topology';
import type { ImportSummary } from '../import-worker/parse-glb';

export type { BakeSettings, BakeStage, ImportSummary, SourceMesh };

export type ImportRequest = {
	type: 'import';
	jobId: number;
	glb: ArrayBuffer;
};

export type ImportResponse =
	| { type: 'start'; jobId: number }
	| { type: 'complete'; jobId: number; source: SourceMesh; summary: ImportSummary }
	| { type: 'error'; jobId: number; message: string };

export type BakeRequest = {
	type: 'bake';
	jobId: number;
	source: SourceMesh;
	settings: BakeSettings;
};

export type CancelRequest = {
	type: 'cancel';
	jobId: number;
};

export type BakeResponse =
	| { type: 'start'; jobId: number; stage: BakeStage; topology?: TopologyChoice }
	| { type: 'progress'; jobId: number; stage: BakeStage; value: number; topology?: TopologyChoice }
	| { type: 'complete'; jobId: number; glb: ArrayBuffer; triangleCount: number; topology: TopologyChoice }
	| { type: 'error'; jobId: number; message: string };

export function sourceTransferList(source: SourceMesh): Transferable[] {
	const list: Transferable[] = [
		source.positions.buffer,
		source.indices.buffer,
		source.normals.buffer,
		source.triangleMaterials.buffer
	];
	if (source.uvs) list.push(source.uvs.buffer);
	if (source.colors) list.push(source.colors.buffer);
	for (const material of source.materials) {
		if (material.baseColor) list.push(material.baseColor.rgba.buffer);
		if (material.normal) list.push(material.normal.rgba.buffer);
		if (material.alpha) list.push(material.alpha.rgba.buffer);
		if (material.metallicRoughness) list.push(material.metallicRoughness.rgba.buffer);
		if (material.emissive) list.push(material.emissive.rgba.buffer);
	}
	return list;
}

export function cloneSource(source: SourceMesh): SourceMesh {
	return {
		positions: source.positions.slice(),
		indices: source.indices.slice(),
		normals: source.normals.slice(),
		uvs: source.uvs ? source.uvs.slice() : null,
		colors: source.colors ? source.colors.slice() : null,
		triangleMaterials: source.triangleMaterials.slice(),
		materials: source.materials.map((material) => ({
			baseColorFactor: [...material.baseColorFactor],
			baseColor: cloneImage(material.baseColor),
			normal: cloneImage(material.normal),
			normalScale: material.normalScale,
			alpha: cloneImage(material.alpha),
			metallicFactor: material.metallicFactor,
			roughnessFactor: material.roughnessFactor,
			metallicRoughness: cloneImage(material.metallicRoughness),
			emissiveFactor: [...material.emissiveFactor],
			emissive: cloneImage(material.emissive),
			alphaMode: material.alphaMode,
			alphaCutoff: material.alphaCutoff,
			unlit: material.unlit
		}))
	};
}

function cloneImage(image: RgbaImage | undefined): RgbaImage | undefined {
	if (!image) return undefined;
	return {
		width: image.width,
		height: image.height,
		rgba: image.rgba.slice()
	};
}
