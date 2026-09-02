import type { Primitive, Texture } from '@gltf-transform/core';
import { createGlbIo } from '../kernels/glb-io';
import { decodeImage } from '../kernels/images';
import { invertMat4, mulMat4Vec3, transposeMat4, vec3Create, vec3Normalize } from '../kernels/math';
import { computeNormals } from '../kernels/normals';
import type { RgbaImage, SourceMaterial, SourceMesh } from '../kernels/types';

export type ImportSummary = {
	name: string;
	triangleCount: number;
	vertexCount: number;
	materialCount: number;
};

export async function parseGlb(buffer: ArrayBuffer): Promise<{ source: SourceMesh; summary: ImportSummary }> {
	const document = await createGlbIo().readBinary(new Uint8Array(buffer));
	const root = document.getRoot();
	const positions: number[] = [];
	const normals: number[] = [];
	const uvs: number[] = [];
	const colors: number[] = [];
	const indices: number[] = [];
	const triangleMaterials: number[] = [];
	const materials: SourceMaterial[] = [];
	const materialIndex = new Map<object, number>();
	let hasUv = false;
	let hasColor = false;

	const ensureMaterial = async (primitive: Primitive): Promise<number> => {
		const material = primitive.getMaterial();
		if (!material) {
			if (!materialIndex.has(fallbackKey)) {
				materialIndex.set(fallbackKey, materials.length);
				materials.push({
					baseColorFactor: [0.72, 0.72, 0.7, 1],
					metallicFactor: 0,
					roughnessFactor: 1,
					emissiveFactor: [0, 0, 0]
				});
			}
			return materialIndex.get(fallbackKey) ?? 0;
		}
		const existing = materialIndex.get(material);
		if (existing !== undefined) return existing;
		const factor = material.getBaseColorFactor();
		const emissive = material.getEmissiveFactor();
		const index = materials.length;
		materialIndex.set(material, index);
		materials.push({
			baseColorFactor: [factor[0] ?? 1, factor[1] ?? 1, factor[2] ?? 1, factor[3] ?? 1],
			baseColor: await textureImage(material.getBaseColorTexture()),
			normal: await textureImage(material.getNormalTexture()),
			normalScale: material.getNormalScale(),
			metallicFactor: material.getMetallicFactor(),
			roughnessFactor: material.getRoughnessFactor(),
			metallicRoughness: await textureImage(material.getMetallicRoughnessTexture()),
			occlusion: await textureImage(material.getOcclusionTexture()),
			occlusionStrength: material.getOcclusionStrength(),
			emissiveFactor: [emissive[0] ?? 0, emissive[1] ?? 0, emissive[2] ?? 0],
			emissive: await textureImage(material.getEmissiveTexture()),
			alphaMode: material.getAlphaMode(),
			alphaCutoff: material.getAlphaCutoff(),
			unlit: Boolean(material.getExtension('KHR_materials_unlit'))
		});
		return index;
	};

	for (const node of root.listNodes()) {
		const mesh = node.getMesh();
		if (!mesh) continue;
		const world = Array.from(node.getWorldMatrix());
		for (const primitive of mesh.listPrimitives()) {
			await absorbPrimitive(primitive, world);
		}
	}

	if (indices.length < 3) {
		throw new Error('GLB has no triangle primitives.');
	}

	const pos = Float32Array.from(positions);
	const idx = Uint32Array.from(indices);
	const nrm = normals.length === positions.length ? Float32Array.from(normals) : computeNormals(pos, idx);

	const meshName = root.listMeshes()[0]?.getName() || root.getName() || 'mesh';
	return {
		source: {
			positions: pos,
			indices: idx,
			normals: nrm,
			uvs: hasUv ? Float32Array.from(uvs) : null,
			colors: hasColor ? Float32Array.from(colors) : null,
			triangleMaterials: Uint16Array.from(triangleMaterials),
			materials
		},
		summary: {
			name: meshName,
			triangleCount: Math.floor(idx.length / 3),
			vertexCount: Math.floor(pos.length / 3),
			materialCount: materials.length
		}
	};

	async function absorbPrimitive(primitive: Primitive, world: number[]): Promise<void> {
		const mode = primitive.getMode();
		if (mode <= 3) return;
		const positionAcc = primitive.getAttribute('POSITION');
		if (!positionAcc) return;
		const srcPos = positionAcc.getArray();
		if (!srcPos) return;
		const srcNrm = primitive.getAttribute('NORMAL')?.getArray() ?? null;
		const srcUv = primitive.getAttribute('TEXCOORD_0')?.getArray() ?? null;
		const colorAcc = primitive.getAttribute('COLOR_0');
		const srcIndex = primitive.getIndices()?.getArray() ?? null;
		const materialId = await ensureMaterial(primitive);
		const vertexOffset = positions.length / 3;
		const inverse = invertMat4(world);
		const normalMat = inverse ? transposeMat4(inverse) : world;
		const p = vec3Create();
		const n = vec3Create();
		const vertexCount = Math.floor(srcPos.length / 3);

		for (let i = 0; i < vertexCount; i++) {
			p[0] = srcPos[i * 3] ?? 0;
			p[1] = srcPos[i * 3 + 1] ?? 0;
			p[2] = srcPos[i * 3 + 2] ?? 0;
			mulMat4Vec3(world, p, p, false);
			positions.push(p[0], p[1], p[2]);
			if (srcNrm) {
				n[0] = srcNrm[i * 3] ?? 0;
				n[1] = srcNrm[i * 3 + 1] ?? 0;
				n[2] = srcNrm[i * 3 + 2] ?? 0;
				mulMat4Vec3(normalMat, n, n, true);
				vec3Normalize(n, n);
				normals.push(n[0], n[1], n[2]);
			}
			if (srcUv) {
				hasUv = true;
				uvs.push(srcUv[i * 2] ?? 0, srcUv[i * 2 + 1] ?? 0);
			} else {
				uvs.push(0, 0);
			}
			if (colorAcc) {
				hasColor = true;
				const rgba = [1, 1, 1, 1];
				colorAcc.getElement(i, rgba);
				colors.push(rgba[0] ?? 1, rgba[1] ?? 1, rgba[2] ?? 1);
			} else {
				colors.push(1, 1, 1);
			}
		}

		const rawIndices = expandIndices(srcIndex, vertexCount, mode);
		for (let i = 0; i + 2 < rawIndices.length; i += 3) {
			indices.push(
				(rawIndices[i] ?? 0) + vertexOffset,
				(rawIndices[i + 1] ?? 0) + vertexOffset,
				(rawIndices[i + 2] ?? 0) + vertexOffset
			);
			triangleMaterials.push(materialId);
		}
	}
}

const fallbackKey = { fallback: true };

async function textureImage(texture: Texture | null): Promise<RgbaImage | undefined> {
	if (!texture) return undefined;
	const imageBytes = texture.getImage();
	if (!imageBytes) return undefined;
	return (await decodeImage(imageBytes, texture.getMimeType())) ?? undefined;
}

function expandIndices(srcIndex: ArrayLike<number> | null, vertexCount: number, mode: number): number[] {
	if (srcIndex) {
		if (mode === 5) return stripToTriangles(Array.from(srcIndex));
		if (mode === 6) return fanToTriangles(Array.from(srcIndex));
		return Array.from(srcIndex);
	}
	const sequential = Array.from({ length: vertexCount }, (_, i) => i);
	if (mode === 5) return stripToTriangles(sequential);
	if (mode === 6) return fanToTriangles(sequential);
	return sequential;
}

function stripToTriangles(indices: number[]): number[] {
	const out: number[] = [];
	for (let i = 0; i + 2 < indices.length; i++) {
		const a = indices[i] ?? 0;
		const b = indices[i + 1] ?? 0;
		const c = indices[i + 2] ?? 0;
		if (i % 2 === 0) out.push(a, b, c);
		else out.push(b, a, c);
	}
	return out;
}

function fanToTriangles(indices: number[]): number[] {
	const out: number[] = [];
	const first = indices[0] ?? 0;
	for (let i = 1; i + 1 < indices.length; i++) {
		out.push(first, indices[i] ?? 0, indices[i + 1] ?? 0);
	}
	return out;
}
