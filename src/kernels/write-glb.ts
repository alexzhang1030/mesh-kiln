import { Document, type Material, type Texture } from '@gltf-transform/core';
import { KHRMaterialsUnlit } from '@gltf-transform/extensions';
import { createGlbIo } from './glb-io';
import { encodePngUncompressed } from './images';
import type { AlphaMode, LowPolyMesh, MeshGeometry, RgbaImage, SourceMaterial, SourceMesh } from './types';
import { triangleCountOf } from './types';

export type BakedMaps = {
	baseColor: RgbaImage;
	normal: RgbaImage;
	metallicRoughness: RgbaImage;
	emissive: RgbaImage | null;
};

export type WriteGlbOptions = {
	unlit?: boolean;
	alphaMode?: AlphaMode;
	alphaCutoff?: number;
};

export function sourceIsUnlit(source: SourceMesh): boolean {
	return source.materials.length > 0 && source.materials.every((material) => material.unlit === true);
}

export function atlasAlphaMode(source: SourceMesh): { alphaMode: AlphaMode; alphaCutoff?: number } {
	let mask = false;
	let cutoff: number | undefined;
	for (const material of source.materials) {
		if (material.alphaMode === 'BLEND' || (material.baseColorFactor[3] ?? 1) < 0.999) {
			return { alphaMode: 'BLEND' };
		}
		if (material.alphaMode === 'MASK') {
			mask = true;
			cutoff = material.alphaCutoff ?? cutoff ?? 0.5;
		}
		if (material.baseColor && textureHasAlpha(material.baseColor)) return { alphaMode: 'BLEND' };
	}
	return mask ? { alphaMode: 'MASK', alphaCutoff: cutoff } : { alphaMode: 'OPAQUE' };
}

function textureHasAlpha(image: RgbaImage): boolean {
	for (let i = 3; i < image.rgba.length; i += 4) {
		if ((image.rgba[i] ?? 255) < 250) return true;
	}
	return false;
}

export async function writeGeometryGlb(mesh: MeshGeometry): Promise<ArrayBuffer> {
	const document = new Document();
	const buffer = document.createBuffer('kiln');
	const position = document
		.createAccessor('POSITION')
		.setArray(new Float32Array(mesh.positions))
		.setType('VEC3')
		.setBuffer(buffer);
	const normal = document
		.createAccessor('NORMAL')
		.setArray(new Float32Array(mesh.normals))
		.setType('VEC3')
		.setBuffer(buffer);
	const indices = document
		.createAccessor('indices')
		.setArray(new Uint32Array(mesh.indices))
		.setType('SCALAR')
		.setBuffer(buffer);
	const material = document
		.createMaterial('kilnPreview')
		.setBaseColorFactor([0.72, 0.72, 0.7, 1])
		.setMetallicFactor(0)
		.setRoughnessFactor(1);
	applyUnlit(document, material);
	const primitive = document
		.createPrimitive()
		.setAttribute('POSITION', position)
		.setAttribute('NORMAL', normal)
		.setIndices(indices)
		.setMaterial(material);
	const bakedMesh = document.createMesh('kilnMesh').addPrimitive(primitive);
	const node = document.createNode('kilnNode').setMesh(bakedMesh);
	document.createScene('kilnScene').addChild(node);
	const bytes = await createGlbIo().writeBinary(document);
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

export async function writeGlb(
	mesh: LowPolyMesh,
	maps: BakedMaps,
	options: WriteGlbOptions = {}
): Promise<ArrayBuffer> {
	const document = new Document();
	const buffer = document.createBuffer('kiln');

	const position = document
		.createAccessor('POSITION')
		.setArray(new Float32Array(mesh.positions))
		.setType('VEC3')
		.setBuffer(buffer);
	const normal = document
		.createAccessor('NORMAL')
		.setArray(new Float32Array(mesh.normals))
		.setType('VEC3')
		.setBuffer(buffer);
	const uv = document
		.createAccessor('TEXCOORD_0')
		.setArray(new Float32Array(mesh.uvs))
		.setType('VEC2')
		.setBuffer(buffer);
	const tangent = document
		.createAccessor('TANGENT')
		.setArray(new Float32Array(mesh.tangents))
		.setType('VEC4')
		.setBuffer(buffer);
	const indices = document
		.createAccessor('indices')
		.setArray(new Uint32Array(mesh.indices))
		.setType('SCALAR')
		.setBuffer(buffer);

	const baseColorTexture = document
		.createTexture('kilnBaseColor')
		.setImage(encodePngUncompressed(maps.baseColor))
		.setMimeType('image/png');
	const normalTexture = document
		.createTexture('kilnNormal')
		.setImage(encodePngUncompressed(maps.normal))
		.setMimeType('image/png');
	const metallicRoughnessTexture = document
		.createTexture('kilnMetallicRoughness')
		.setImage(encodePngUncompressed(maps.metallicRoughness))
		.setMimeType('image/png');

	const material = document
		.createMaterial('kilnMaterial')
		.setMetallicFactor(1)
		.setRoughnessFactor(1)
		.setBaseColorTexture(baseColorTexture)
		.setNormalTexture(normalTexture)
		.setMetallicRoughnessTexture(metallicRoughnessTexture)
		.setOcclusionTexture(metallicRoughnessTexture)
		.setOcclusionStrength(1);
	applyAlphaMode(material, options.alphaMode, options.alphaCutoff);

	if (maps.emissive) {
		material
			.setEmissiveFactor([1, 1, 1])
			.setEmissiveTexture(
				document.createTexture('kilnEmissive').setImage(encodePngUncompressed(maps.emissive)).setMimeType('image/png')
			);
	}
	if (options.unlit) applyUnlit(document, material);

	const primitive = document
		.createPrimitive()
		.setAttribute('POSITION', position)
		.setAttribute('NORMAL', normal)
		.setAttribute('TEXCOORD_0', uv)
		.setAttribute('TANGENT', tangent)
		.setIndices(indices)
		.setMaterial(material);

	const bakedMesh = document.createMesh('kilnMesh').addPrimitive(primitive);
	const node = document.createNode('kilnNode').setMesh(bakedMesh);
	document.createScene('kilnScene').addChild(node);

	const io = createGlbIo();
	const bytes = await io.writeBinary(document);
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

export async function writeAuthoredGlb(mesh: SourceMesh): Promise<ArrayBuffer> {
	const document = new Document();
	const buffer = document.createBuffer('kiln');
	const textureCache = new Map<RgbaImage, Texture>();

	const position = document
		.createAccessor('POSITION')
		.setArray(new Float32Array(mesh.positions))
		.setType('VEC3')
		.setBuffer(buffer);
	const normal = document
		.createAccessor('NORMAL')
		.setArray(new Float32Array(mesh.normals))
		.setType('VEC3')
		.setBuffer(buffer);
	const uv = mesh.uvs
		? document.createAccessor('TEXCOORD_0').setArray(new Float32Array(mesh.uvs)).setType('VEC2').setBuffer(buffer)
		: null;
	const color = mesh.colors
		? document.createAccessor('COLOR_0').setArray(new Float32Array(mesh.colors)).setType('VEC3').setBuffer(buffer)
		: null;

	const groups = splitIndicesByMaterial(mesh);
	const authoredMesh = document.createMesh('kilnMesh');
	for (let materialId = 0; materialId < mesh.materials.length; materialId++) {
		const indices = groups.get(materialId);
		if (!indices || indices.length < 3) continue;
		const sourceMaterial = mesh.materials[materialId];
		if (!sourceMaterial) continue;
		const primitive = document
			.createPrimitive()
			.setAttribute('POSITION', position)
			.setAttribute('NORMAL', normal)
			.setIndices(
				document
					.createAccessor(`indices_${materialId}`)
					.setArray(indices)
					.setType('SCALAR')
					.setBuffer(buffer)
			)
			.setMaterial(createCopiedMaterial(document, sourceMaterial, textureCache));
		if (uv) primitive.setAttribute('TEXCOORD_0', uv);
		if (color) primitive.setAttribute('COLOR_0', color);
		authoredMesh.addPrimitive(primitive);
	}

	if (authoredMesh.listPrimitives().length === 0) {
		throw new Error('Authored export produced no primitives.');
	}

	const node = document.createNode('kilnNode').setMesh(authoredMesh);
	document.createScene('kilnScene').addChild(node);

	const io = createGlbIo();
	const bytes = await io.writeBinary(document);
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

export async function readGlbDocument(bytes: Uint8Array) {
	return createGlbIo().readBinary(bytes);
}

function splitIndicesByMaterial(mesh: SourceMesh): Map<number, Uint32Array> {
	const buckets = new Map<number, number[]>();
	const faces = triangleCountOf(mesh.indices);
	for (let face = 0; face < faces; face++) {
		const materialId = mesh.triangleMaterials[face] ?? 0;
		let list = buckets.get(materialId);
		if (!list) {
			list = [];
			buckets.set(materialId, list);
		}
		list.push(mesh.indices[face * 3] ?? 0, mesh.indices[face * 3 + 1] ?? 0, mesh.indices[face * 3 + 2] ?? 0);
	}
	const out = new Map<number, Uint32Array>();
	for (const [materialId, list] of buckets) {
		out.set(materialId, Uint32Array.from(list));
	}
	return out;
}

function createCopiedMaterial(
	document: Document,
	source: SourceMaterial,
	cache: Map<RgbaImage, Texture>
) {
	const material = document
		.createMaterial('kilnMaterial')
		.setBaseColorFactor(source.baseColorFactor)
		.setMetallicFactor(source.metallicFactor)
		.setRoughnessFactor(source.roughnessFactor)
		.setEmissiveFactor(source.emissiveFactor);
	applyAlphaMode(material, source.alphaMode, source.alphaCutoff);
	if (source.baseColor) material.setBaseColorTexture(copiedTexture(document, cache, 'baseColor', source.baseColor));
	if (source.normal) {
		material
			.setNormalTexture(copiedTexture(document, cache, 'normal', source.normal))
			.setNormalScale(source.normalScale ?? 1);
	}
	if (source.metallicRoughness) {
		material.setMetallicRoughnessTexture(copiedTexture(document, cache, 'metallicRoughness', source.metallicRoughness));
	}
	if (source.occlusion) {
		material
			.setOcclusionTexture(copiedTexture(document, cache, 'occlusion', source.occlusion))
			.setOcclusionStrength(source.occlusionStrength ?? 1);
	}
	if (source.emissive) material.setEmissiveTexture(copiedTexture(document, cache, 'emissive', source.emissive));
	if (source.alpha && !source.baseColor) {
		material.setBaseColorTexture(copiedTexture(document, cache, 'alpha', source.alpha));
	}
	if (source.unlit) applyUnlit(document, material);
	return material;
}

function applyUnlit(document: Document, material: Material): void {
	const extension = document.createExtension(KHRMaterialsUnlit);
	material.setExtension('KHR_materials_unlit', extension.createUnlit());
}

function applyAlphaMode(material: Material, mode: AlphaMode | undefined, cutoff: number | undefined): void {
	if (!mode) return;
	switch (mode) {
		case 'OPAQUE':
		case 'MASK':
		case 'BLEND':
			material.setAlphaMode(mode);
			break;
		default: {
			const exhausted: never = mode;
			throw new Error(`Unknown alpha mode: ${String(exhausted)}`);
		}
	}
	if (mode === 'MASK' && cutoff !== undefined) material.setAlphaCutoff(cutoff);
}

function copiedTexture(
	document: Document,
	cache: Map<RgbaImage, Texture>,
	name: string,
	image: RgbaImage
): Texture {
	const existing = cache.get(image);
	if (existing) return existing;
	const texture = document.createTexture(name).setImage(encodePngUncompressed(image)).setMimeType('image/png');
	cache.set(image, texture);
	return texture;
}
