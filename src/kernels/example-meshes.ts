import { createBandedAlbedo, createCrestGlb, writeFixtureGlb, type FixturePrimitive } from './fixture';
import { computeNormals } from './normals';
import { createOwlGlb } from './owl';
import { createRobotGlb } from './robot';
import type { MeshGeometry, RgbaImage } from './types';

export type ExampleMesh = MeshGeometry & { uvs: Float32Array };

export function createCheckerAlbedo(
	size: number,
	a: [number, number, number],
	b: [number, number, number]
): RgbaImage {
	const rgba = new Uint8Array(size * size * 4);
	const cells = 8;
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const cell = (Math.floor((x / size) * cells) + Math.floor((y / size) * cells)) % 2 === 0;
			const [r, g, bl] = cell ? a : b;
			const i = (y * size + x) * 4;
			rgba[i] = r;
			rgba[i + 1] = g;
			rgba[i + 2] = bl;
			rgba[i + 3] = 255;
		}
	}
	return { width: size, height: size, rgba };
}

export function createGrainAlbedo(size: number, warm: boolean): RgbaImage {
	const rgba = new Uint8Array(size * size * 4);
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const stripe = 0.5 + 0.5 * Math.sin((x / size) * Math.PI * 18 + Math.sin((y / size) * 9));
			const i = (y * size + x) * 4;
			if (warm) {
				rgba[i] = Math.round(120 + stripe * 90);
				rgba[i + 1] = Math.round(72 + stripe * 40);
				rgba[i + 2] = Math.round(38 + stripe * 18);
			} else {
				rgba[i] = Math.round(48 + stripe * 30);
				rgba[i + 1] = Math.round(62 + stripe * 40);
				rgba[i + 2] = Math.round(78 + stripe * 50);
			}
			rgba[i + 3] = 255;
		}
	}
	return { width: size, height: size, rgba };
}

export function torusTriangleCount(major = 80, minor = 40): number {
	return major * minor * 2;
}

export function createTorusGeometry(major = 80, minor = 40, R = 1.15, r = 0.38): ExampleMesh {
	const positions: number[] = [];
	const uvs: number[] = [];
	for (let j = 0; j <= minor; j++) {
		const v = j / minor;
		const phi = v * Math.PI * 2;
		for (let i = 0; i <= major; i++) {
			const u = i / major;
			const theta = u * Math.PI * 2;
			const cx = Math.cos(theta);
			const cz = Math.sin(theta);
			positions.push((R + r * Math.cos(phi)) * cx, r * Math.sin(phi), (R + r * Math.cos(phi)) * cz);
			uvs.push(u, 1 - v);
		}
	}
	const indices: number[] = [];
	const stride = major + 1;
	for (let j = 0; j < minor; j++) {
		for (let i = 0; i < major; i++) {
			const a = j * stride + i;
			const b = a + stride;
			indices.push(a, b, a + 1, a + 1, b, b + 1);
		}
	}
	const pos = Float32Array.from(positions);
	const idx = Uint32Array.from(indices);
	return { positions: pos, indices: idx, normals: computeNormals(pos, idx), uvs: Float32Array.from(uvs) };
}

export function crateTriangleCount(segments = 20): number {
	return segments * segments * 2 * 6;
}

function gridFace(
	origin: [number, number, number],
	uDir: [number, number, number],
	vDir: [number, number, number],
	segments: number
): ExampleMesh {
	const positions: number[] = [];
	const uvs: number[] = [];
	for (let y = 0; y <= segments; y++) {
		const v = y / segments;
		for (let x = 0; x <= segments; x++) {
			const u = x / segments;
			positions.push(
				origin[0] + uDir[0] * u + vDir[0] * v,
				origin[1] + uDir[1] * u + vDir[1] * v,
				origin[2] + uDir[2] * u + vDir[2] * v
			);
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

export function createCratePrimitives(segments = 20): FixturePrimitive[] {
	const s = 1.1;
	const lid = createCheckerAlbedo(96, [210, 168, 92], [92, 58, 32]);
	const side = createGrainAlbedo(96, true);
	const stamp = createGrainAlbedo(96, false);
	return [
		{ ...gridFace([-s, s, s], [2 * s, 0, 0], [0, 0, -2 * s], segments), materialName: 'lid', albedo: lid },
		{ ...gridFace([-s, -s, -s], [2 * s, 0, 0], [0, 0, 2 * s], segments), materialName: 'lid', albedo: lid },
		{ ...gridFace([-s, -s, -s], [0, 0, 2 * s], [0, 2 * s, 0], segments), materialName: 'side', albedo: side },
		{ ...gridFace([s, -s, s], [0, 0, -2 * s], [0, 2 * s, 0], segments), materialName: 'side', albedo: side },
		{ ...gridFace([-s, -s, s], [2 * s, 0, 0], [0, 2 * s, 0], segments), materialName: 'stamp', albedo: stamp },
		{ ...gridFace([s, -s, -s], [-2 * s, 0, 0], [0, 2 * s, 0], segments), materialName: 'stamp', albedo: stamp }
	];
}

export function spireTriangleCount(rings = 48, slices = 36): number {
	return rings * slices * 2;
}

export function createSpireGeometry(rings = 48, slices = 36): ExampleMesh {
	const positions: number[] = [];
	const uvs: number[] = [];
	for (let y = 0; y <= rings; y++) {
		const v = y / rings;
		const height = v * 2.4 - 1.2;
		const twist = v * 2.8;
		const radius = 0.22 + 0.28 * (1 - v) + 0.07 * Math.sin(v * Math.PI * 6);
		for (let x = 0; x <= slices; x++) {
			const u = x / slices;
			const ang = u * Math.PI * 2 + twist;
			const flute = 1 + 0.16 * Math.cos(ang * 4);
			positions.push(radius * flute * Math.cos(ang), height, radius * flute * Math.sin(ang));
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

export async function createTorusGlb(): Promise<ArrayBuffer> {
	return writeFixtureGlb('torus', [
		{
			...createTorusGeometry(),
			materialName: 'enamel',
			albedo: createBandedAlbedo(128)
		}
	]);
}

export async function createCrateGlb(): Promise<ArrayBuffer> {
	return writeFixtureGlb('crate', createCratePrimitives());
}

export async function createSpireGlb(): Promise<ArrayBuffer> {
	return writeFixtureGlb('spire', [
		{
			...createSpireGeometry(),
			materialName: 'oxide',
			albedo: createCheckerAlbedo(96, [186, 92, 48], [62, 78, 92])
		}
	]);
}

export type FixtureId = 'owl' | 'robot' | 'crest' | 'torus' | 'crate' | 'spire';

export async function buildFixtureGlb(id: FixtureId): Promise<ArrayBuffer> {
	switch (id) {
		case 'owl':
			return createOwlGlb();
		case 'robot':
			return createRobotGlb();
		case 'crest':
			return createCrestGlb({ segments: 48, name: 'crest' });
		case 'torus':
			return createTorusGlb();
		case 'crate':
			return createCrateGlb();
		case 'spire':
			return createSpireGlb();
		default: {
			const exhausted: never = id;
			throw new Error(`Unknown fixture: ${String(exhausted)}`);
		}
	}
}

