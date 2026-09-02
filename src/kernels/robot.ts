import { writeFixtureGlb, type FixturePrimitive } from './fixture';
import { computeNormals } from './normals';
import type { MeshGeometry, RgbaImage } from './types';

export type RobotMesh = MeshGeometry & { uvs: Float32Array };

type RobotPart = {
	cx: number;
	cy: number;
	cz: number;
	sx: number;
	sy: number;
	sz: number;
	segments: number;
	materialName: string;
	color: [number, number, number];
};

const ENAMEL: [number, number, number] = [228, 168, 42];
const JOINT: [number, number, number] = [118, 78, 28];
const VISOR: [number, number, number] = [16, 22, 28];
const ACCENT: [number, number, number] = [64, 196, 206];

const ROBOT_PARTS: readonly RobotPart[] = [
	{ cx: 0, cy: 0.18, cz: 0, sx: 0.74, sy: 0.8, sz: 0.46, segments: 28, materialName: 'enamel', color: ENAMEL },
	{ cx: 0, cy: 0.8, cz: 0.02, sx: 0.58, sy: 0.5, sz: 0.52, segments: 28, materialName: 'enamel', color: ENAMEL },
	{ cx: 0, cy: 0.78, cz: 0.28, sx: 0.42, sy: 0.22, sz: 0.08, segments: 12, materialName: 'visor', color: VISOR },
	{ cx: 0, cy: 0.3, cz: 0.25, sx: 0.2, sy: 0.2, sz: 0.08, segments: 10, materialName: 'accent', color: ACCENT },
	{ cx: 0, cy: -0.3, cz: 0, sx: 0.52, sy: 0.18, sz: 0.38, segments: 12, materialName: 'enamel', color: JOINT },
	{ cx: -0.16, cy: -0.58, cz: 0, sx: 0.2, sy: 0.38, sz: 0.22, segments: 14, materialName: 'enamel', color: ENAMEL },
	{ cx: 0.16, cy: -0.58, cz: 0, sx: 0.2, sy: 0.38, sz: 0.22, segments: 14, materialName: 'enamel', color: ENAMEL },
	{ cx: -0.16, cy: -0.92, cz: 0.02, sx: 0.18, sy: 0.34, sz: 0.2, segments: 14, materialName: 'enamel', color: ENAMEL },
	{ cx: 0.16, cy: -0.92, cz: 0.02, sx: 0.18, sy: 0.34, sz: 0.2, segments: 14, materialName: 'enamel', color: ENAMEL },
	{ cx: -0.16, cy: -1.14, cz: 0.08, sx: 0.24, sy: 0.1, sz: 0.34, segments: 10, materialName: 'enamel', color: JOINT },
	{ cx: 0.16, cy: -1.14, cz: 0.08, sx: 0.24, sy: 0.1, sz: 0.34, segments: 10, materialName: 'enamel', color: JOINT },
	{ cx: -0.54, cy: 0.28, cz: 0, sx: 0.2, sy: 0.44, sz: 0.2, segments: 12, materialName: 'enamel', color: ENAMEL },
	{ cx: 0.54, cy: 0.28, cz: 0, sx: 0.2, sy: 0.44, sz: 0.2, segments: 12, materialName: 'enamel', color: ENAMEL },
	{ cx: -0.56, cy: -0.1, cz: 0.04, sx: 0.16, sy: 0.36, sz: 0.16, segments: 12, materialName: 'enamel', color: ENAMEL },
	{ cx: 0.56, cy: -0.1, cz: 0.04, sx: 0.16, sy: 0.36, sz: 0.16, segments: 12, materialName: 'enamel', color: ENAMEL },
	{ cx: -0.56, cy: -0.34, cz: 0.04, sx: 0.2, sy: 0.12, sz: 0.18, segments: 8, materialName: 'enamel', color: JOINT },
	{ cx: 0.56, cy: -0.34, cz: 0.04, sx: 0.2, sy: 0.12, sz: 0.18, segments: 8, materialName: 'enamel', color: JOINT },
	{ cx: -0.14, cy: 1.18, cz: 0, sx: 0.045, sy: 0.46, sz: 0.045, segments: 12, materialName: 'accent', color: ACCENT },
	{ cx: 0.14, cy: 1.24, cz: 0, sx: 0.045, sy: 0.56, sz: 0.045, segments: 12, materialName: 'accent', color: ACCENT },
	{ cx: -0.14, cy: 1.42, cz: 0, sx: 0.08, sy: 0.08, sz: 0.08, segments: 8, materialName: 'accent', color: ACCENT },
	{ cx: 0.14, cy: 1.54, cz: 0.02, sx: 0.07, sy: 0.1, sz: 0.07, segments: 8, materialName: 'accent', color: ACCENT }
];

export function boxTriangleCount(segments: number): number {
	return 12 * segments * segments;
}

export function robotTriangleCount(): number {
	let n = 0;
	for (const part of ROBOT_PARTS) n += boxTriangleCount(part.segments);
	return n;
}

export function createRobotGeometry(): RobotMesh {
	return mergeMeshes(
		ROBOT_PARTS.map((part) =>
			boxGeometry(part.cx, part.cy, part.cz, part.sx, part.sy, part.sz, part.segments)
		)
	);
}

export function createRobotPrimitives(): FixturePrimitive[] {
	return ROBOT_PARTS.map((part) => ({
		...boxGeometry(part.cx, part.cy, part.cz, part.sx, part.sy, part.sz, part.segments),
		materialName: part.materialName,
		albedo: solidAlbedo(part.color)
	}));
}

export async function createRobotGlb(): Promise<ArrayBuffer> {
	return writeFixtureGlb('robot', createRobotPrimitives());
}

function boxGeometry(
	cx: number,
	cy: number,
	cz: number,
	sx: number,
	sy: number,
	sz: number,
	segments: number
): RobotMesh {
	const hx = sx * 0.5;
	const hy = sy * 0.5;
	const hz = sz * 0.5;
	const faces: RobotMesh[] = [
		gridFace([cx - hx, cy + hy, cz + hz], [sx, 0, 0], [0, 0, -sz], segments),
		gridFace([cx - hx, cy - hy, cz - hz], [sx, 0, 0], [0, 0, sz], segments),
		gridFace([cx - hx, cy - hy, cz - hz], [0, 0, sz], [0, sy, 0], segments),
		gridFace([cx + hx, cy - hy, cz + hz], [0, 0, -sz], [0, sy, 0], segments),
		gridFace([cx - hx, cy - hy, cz + hz], [sx, 0, 0], [0, sy, 0], segments),
		gridFace([cx + hx, cy - hy, cz - hz], [-sx, 0, 0], [0, sy, 0], segments)
	];
	return mergeMeshes(faces);
}

function gridFace(
	origin: [number, number, number],
	uDir: [number, number, number],
	vDir: [number, number, number],
	segments: number
): RobotMesh {
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

function mergeMeshes(parts: RobotMesh[]): RobotMesh {
	let vertCount = 0;
	let indexCount = 0;
	for (const part of parts) {
		vertCount += part.positions.length / 3;
		indexCount += part.indices.length;
	}
	const positions = new Float32Array(vertCount * 3);
	const normals = new Float32Array(vertCount * 3);
	const uvs = new Float32Array(vertCount * 2);
	const indices = new Uint32Array(indexCount);
	let v = 0;
	let t = 0;
	for (const part of parts) {
		const base = v;
		positions.set(part.positions, v * 3);
		normals.set(part.normals, v * 3);
		uvs.set(part.uvs, v * 2);
		for (let i = 0; i < part.indices.length; i++) {
			indices[t++] = base + (part.indices[i] ?? 0);
		}
		v += part.positions.length / 3;
	}
	return { positions, indices, normals, uvs };
}

function solidAlbedo(rgb: [number, number, number], size = 48): RgbaImage {
	const rgba = new Uint8Array(size * size * 4);
	for (let i = 0; i < rgba.length; i += 4) {
		rgba[i] = rgb[0];
		rgba[i + 1] = rgb[1];
		rgba[i + 2] = rgb[2];
		rgba[i + 3] = 255;
	}
	return { width: size, height: size, rgba };
}
