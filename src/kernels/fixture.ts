import { Document, WebIO, type Material } from '@gltf-transform/core';
import { encodePngUncompressed } from './images';
import { computeNormals } from './normals';
import type { RgbaImage } from './types';

export type FixtureOptions = {
	segments?: number;
	name?: string;
};

export type FixturePrimitive = {
	name?: string;
	positions: Float32Array;
	indices: Uint32Array;
	normals: Float32Array;
	uvs: Float32Array;
	materialName: string;
	albedo?: RgbaImage;
	baseColorFactor?: [number, number, number, number];
	metallicFactor?: number;
	roughnessFactor?: number;
};

/** Displaced UV sphere with a banded albedo PNG. ~2*(seg-1)*seg tris. */
export function createCrestGeometry(segments = 48): {
	positions: Float32Array;
	indices: Uint32Array;
	normals: Float32Array;
	uvs: Float32Array;
} {
	const rings = segments;
	const slices = segments * 2;
	const positions: number[] = [];
	const uvs: number[] = [];

	for (let y = 0; y <= rings; y++) {
		const v = y / rings;
		const phi = v * Math.PI;
		for (let x = 0; x <= slices; x++) {
			const u = x / slices;
			const theta = u * Math.PI * 2;
			const sx = Math.sin(phi) * Math.cos(theta);
			const sy = Math.cos(phi);
			const sz = Math.sin(phi) * Math.sin(theta);
			const bump = 0.08 * Math.sin(theta * 7) * Math.cos(phi * 5);
			const r = 1 + bump;
			positions.push(sx * r, sy * r, sz * r);
			uvs.push(u, 1 - v);
		}
	}

	const indices: number[] = [];
	const stride = slices + 1;
	for (let y = 0; y < rings; y++) {
		for (let x = 0; x < slices; x++) {
			const a = y * stride + x;
			const b = a + stride;
			indices.push(a, b, a + 1, a + 1, b, b + 1);
		}
	}

	const pos = Float32Array.from(positions);
	const idx = Uint32Array.from(indices);
	return { positions: pos, indices: idx, normals: computeNormals(pos, idx), uvs: Float32Array.from(uvs) };
}

/**
 * Closed-ish lathe vase. rings=36, slices=48 → 3456 tris, the checkered vase
 * triangle count from the Kiln preview fail.
 */
export function createWavyVaseGeometry(
	rings = 36,
	slices = 48
): {
	positions: Float32Array;
	indices: Uint32Array;
	normals: Float32Array;
	uvs: Float32Array;
} {
	const positions: number[] = [];
	const uvs: number[] = [];
	for (let y = 0; y <= rings; y++) {
		const t = y / rings;
		const height = t * 2.2 - 1.1;
		const radius = 0.28 + 0.22 * Math.sin(t * Math.PI * 3.2) + 0.06 * t;
		for (let x = 0; x <= slices; x++) {
			const u = x / slices;
			const theta = u * Math.PI * 2;
			positions.push(radius * Math.cos(theta), height, radius * Math.sin(theta));
			uvs.push(u, 1 - t);
		}
	}
	const indices: number[] = [];
	const stride = slices + 1;
	for (let y = 0; y < rings; y++) {
		for (let x = 0; x < slices; x++) {
			const a = y * stride + x;
			const b = a + stride;
			indices.push(a, b, a + 1, a + 1, b, b + 1);
		}
	}
	const pos = Float32Array.from(positions);
	const idx = Uint32Array.from(indices);
	return { positions: pos, indices: idx, normals: computeNormals(pos, idx), uvs: Float32Array.from(uvs) };
}

export function createBandedAlbedo(size = 128): { width: number; height: number; rgba: Uint8Array } {
	const rgba = new Uint8Array(size * size * 4);
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const u = x / size;
			const v = y / size;
			const band = Math.floor(u * 6) % 6;
			const palette: Array<[number, number, number]> = [
				[196, 86, 42],
				[232, 168, 74],
				[74, 122, 138],
				[214, 214, 198],
				[92, 58, 42],
				[48, 92, 74]
			];
			const [r, g, b] = palette[band] ?? [180, 180, 180];
			const shade = 0.75 + 0.25 * Math.sin(v * Math.PI);
			const i = (y * size + x) * 4;
			rgba[i] = Math.round(r * shade);
			rgba[i + 1] = Math.round(g * shade);
			rgba[i + 2] = Math.round(b * shade);
			rgba[i + 3] = 255;
		}
	}
	return { width: size, height: size, rgba };
}

export async function writeFixtureGlb(name: string, primitives: FixturePrimitive[]): Promise<ArrayBuffer> {
	if (primitives.length === 0) {
		throw new Error('writeFixtureGlb needs at least one primitive.');
	}
	const document = new Document();
	const buffer = document.createBuffer();
	const mesh = document.createMesh(name);
	const materials = new Map<string, Material>();

	for (const [index, part] of primitives.entries()) {
		let material = materials.get(part.materialName);
		if (!material) {
			material = document
				.createMaterial(part.materialName)
				.setMetallicFactor(part.metallicFactor ?? 0)
				.setRoughnessFactor(part.roughnessFactor ?? 0.9);
			if (part.baseColorFactor) {
				material.setBaseColorFactor(part.baseColorFactor);
			}
			if (part.albedo) {
				material.setBaseColorTexture(
					document
						.createTexture(`${part.materialName}-albedo`)
						.setImage(encodePngUncompressed(part.albedo))
						.setMimeType('image/png')
				);
			}
			materials.set(part.materialName, material);
		}
		const suffix = `${index}`;
		const primitive = document
			.createPrimitive()
			.setAttribute(
				'POSITION',
				document
					.createAccessor(`POSITION_${suffix}`)
					.setArray(new Float32Array(part.positions))
					.setType('VEC3')
					.setBuffer(buffer)
			)
			.setAttribute(
				'NORMAL',
				document
					.createAccessor(`NORMAL_${suffix}`)
					.setArray(new Float32Array(part.normals))
					.setType('VEC3')
					.setBuffer(buffer)
			)
			.setAttribute(
				'TEXCOORD_0',
				document
					.createAccessor(`TEXCOORD_0_${suffix}`)
					.setArray(new Float32Array(part.uvs))
					.setType('VEC2')
					.setBuffer(buffer)
			)
			.setIndices(
				document
					.createAccessor(`indices_${suffix}`)
					.setArray(new Uint32Array(part.indices))
					.setType('SCALAR')
					.setBuffer(buffer)
			)
			.setMaterial(material);
		mesh.addPrimitive(primitive);
	}

	document.createScene(name).addChild(document.createNode(name).setMesh(mesh));
	const bytes = await new WebIO().writeBinary(document);
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

export async function createCrestGlb(options: FixtureOptions = {}): Promise<ArrayBuffer> {
	const segments = options.segments ?? 48;
	const geometry = createCrestGeometry(segments);
	return writeFixtureGlb(options.name ?? 'crest', [
		{
			...geometry,
			materialName: 'crest',
			albedo: createBandedAlbedo(128)
		}
	]);
}

export function fixtureTriangleCount(segments = 48): number {
	return segments * (segments * 2) * 2;
}

export const VISOR_YELLOW: [number, number, number] = [228, 168, 42];
export const VISOR_DARK: [number, number, number] = [18, 22, 28];
export const VISOR_CYAN: [number, number, number] = [48, 196, 210];

export function visorPanelTriangleCount(segments = 72): number {
	return segments * segments * 2;
}

export function createVisorAlbedo(size = 96): RgbaImage {
	const rgba = new Uint8Array(size * size * 4);
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const u = (x + 0.5) / size;
			const v = 1 - (y + 0.5) / size;
			const visor = u > 0.3 && u < 0.7 && v > 0.55 && v < 0.78;
			const leftEye = (u - 0.4) * (u - 0.4) + (v - 0.68) * (v - 0.68) < 0.006;
			const rightEye = (u - 0.6) * (u - 0.6) + (v - 0.68) * (v - 0.68) < 0.006;
			let rgb: [number, number, number] = VISOR_YELLOW;
			if (leftEye || rightEye) rgb = VISOR_CYAN;
			else if (visor) rgb = VISOR_DARK;
			const i = (y * size + x) * 4;
			rgba[i] = rgb[0];
			rgba[i + 1] = rgb[1];
			rgba[i + 2] = rgb[2];
			rgba[i + 3] = 255;
		}
	}
	return { width: size, height: size, rgba };
}

export function createPanelGrid(segments = 72): {
	positions: Float32Array;
	indices: Uint32Array;
	normals: Float32Array;
	uvs: Float32Array;
} {
	const positions: number[] = [];
	const uvs: number[] = [];
	for (let y = 0; y <= segments; y++) {
		const v = y / segments;
		const py = v * 2 - 1;
		for (let x = 0; x <= segments; x++) {
			const u = x / segments;
			positions.push(u * 2 - 1, py, 0);
			uvs.push(u, 1 - v);
		}
	}
	const indices: number[] = [];
	const stride = segments + 1;
	for (let y = 0; y < segments; y++) {
		for (let x = 0; x < segments; x++) {
			const a = y * stride + x;
			const b = a + stride;
			indices.push(a, a + 1, b, a + 1, b + 1, b);
		}
	}
	const pos = Float32Array.from(positions);
	const idx = Uint32Array.from(indices);
	return { positions: pos, indices: idx, normals: computeNormals(pos, idx), uvs: Float32Array.from(uvs) };
}

export async function createVisorPanelGlb(segments = 72): Promise<ArrayBuffer> {
	const body = createPanelGrid(segments);
	return writeFixtureGlb('visor-panel', [
		{
			...body,
			materialName: 'enamel',
			albedo: createVisorAlbedo(96),
			metallicFactor: 0,
			roughnessFactor: 0.9
		}
	]);
}
