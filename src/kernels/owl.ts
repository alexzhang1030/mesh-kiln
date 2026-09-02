import { computeNormals } from './normals';
import type { MeshGeometry, RgbaImage } from './types';
import { writeFixtureGlb } from './fixture';

/** Kiln's own perched owl (CC0). Not Needle's demo mesh. */

export type OwlMesh = MeshGeometry & { uvs: Float32Array };

const OWL_MIN: [number, number, number] = [-1.08, -0.78, -0.78];
const OWL_MAX: [number, number, number] = [1.08, 1.46, 0.68];
const OWL_GRID = 108;
const OWL_TRI_MIN = 100_000;
const OWL_TRI_MAX = 400_000;

const TET_VERTS: Array<[number, number, number, number]> = [
	[0, 1, 3, 7],
	[0, 1, 5, 7],
	[0, 2, 3, 7],
	[0, 2, 6, 7],
	[0, 4, 5, 7],
	[0, 4, 6, 7]
];

const CUBE_CORNER: Array<[number, number, number]> = [
	[0, 0, 0],
	[1, 0, 0],
	[0, 1, 0],
	[1, 1, 0],
	[0, 0, 1],
	[1, 0, 1],
	[0, 1, 1],
	[1, 1, 1]
];

export function owlSdf(x: number, y: number, z: number): number {
	let d = sdEllipsoid(x, y, z, 0, 0.22, 0.04, 0.44, 0.54, 0.4);
	d = smin(d, sdEllipsoid(x, y, z, 0, 0.86, 0.08, 0.36, 0.32, 0.34), 0.14);
	d = smin(d, sdEllipsoid(x, y, z, 0, 0.8, 0.3, 0.3, 0.24, 0.12), 0.08);
	d = smin(d, sdEllipsoid(x, y, z, -0.2, 1.18, 0.02, 0.11, 0.22, 0.09), 0.07);
	d = smin(d, sdEllipsoid(x, y, z, 0.2, 1.18, 0.02, 0.11, 0.22, 0.09), 0.07);
	d = smin(d, sdEllipsoid(x, y, z, -0.38, 0.18, -0.04, 0.18, 0.44, 0.24), 0.11);
	d = smin(d, sdEllipsoid(x, y, z, 0.38, 0.18, -0.04, 0.18, 0.44, 0.24), 0.11);
	d = smin(d, sdEllipsoid(x, y, z, 0, -0.02, -0.46, 0.2, 0.14, 0.3), 0.1);
	d = smax(d, -sdEllipsoid(x, y, z, -0.13, 0.88, 0.32, 0.09, 0.09, 0.07), 0.04);
	d = smax(d, -sdEllipsoid(x, y, z, 0.13, 0.88, 0.32, 0.09, 0.09, 0.07), 0.04);
	d = smin(d, sdEllipsoid(x, y, z, -0.13, 0.88, 0.34, 0.075, 0.075, 0.055), 0.03);
	d = smin(d, sdEllipsoid(x, y, z, 0.13, 0.88, 0.34, 0.075, 0.075, 0.055), 0.03);
	d = smin(d, sdEllipsoid(x, y, z, 0, 0.72, 0.42, 0.07, 0.055, 0.15), 0.04);
	d = smin(d, sdEllipsoid(x, y, z, 0, 0.66, 0.4, 0.055, 0.04, 0.1), 0.03);
	d = smin(d, sdEllipsoid(x, y, z, -0.12, -0.36, 0.14, 0.09, 0.07, 0.11), 0.05);
	d = smin(d, sdEllipsoid(x, y, z, 0.12, -0.36, 0.14, 0.09, 0.07, 0.11), 0.05);
	d = smin(d, sdCapsule(x, y, z, -0.14, -0.4, 0.2, -0.18, -0.46, 0.08, 0.025), 0.03);
	d = smin(d, sdCapsule(x, y, z, -0.1, -0.4, 0.22, -0.08, -0.46, 0.1, 0.022), 0.03);
	d = smin(d, sdCapsule(x, y, z, 0.14, -0.4, 0.2, 0.18, -0.46, 0.08, 0.025), 0.03);
	d = smin(d, sdCapsule(x, y, z, 0.1, -0.4, 0.22, 0.08, -0.46, 0.1, 0.022), 0.03);
	d = smin(d, sdCapsule(x, y, z, -0.95, -0.5, 0.06, 0.95, -0.54, -0.04, 0.075), 0.06);
	d = smin(d, sdEllipsoid(x, y, z, -0.55, -0.52, 0.04, 0.12, 0.08, 0.1), 0.05);
	d = smin(d, sdEllipsoid(x, y, z, 0.55, -0.52, 0.02, 0.11, 0.075, 0.09), 0.05);
	const plumage = featherMask(x, y, z);
	if (plumage > 0.2) {
		d += 0.016 * plumage * (fbm(x * 11, y * 6, z * 11) * 2 - 1);
	}
	return d;
}

export function createOwlGeometry(): OwlMesh {
	let mesh = marchingTetrahedra(OWL_GRID);
	let triangles = mesh.indices.length / 3;
	for (let pass = 0; pass < 2 && triangles < OWL_TRI_MIN && triangles * 4 <= OWL_TRI_MAX; pass++) {
		mesh = subdivideOnce(mesh);
		triangles = mesh.indices.length / 3;
	}
	if (triangles < OWL_TRI_MIN || triangles > OWL_TRI_MAX) {
		throw new Error(`Owl sculpt is ${triangles} tris; tune OWL_GRID so the fixture stays in 100k–400k.`);
	}
	displaceFeathers(mesh.positions, mesh.indices);
	orientOutward(mesh.positions, mesh.indices);
	return {
		positions: mesh.positions,
		indices: mesh.indices,
		normals: computeNormals(mesh.positions, mesh.indices),
		uvs: sphericalUv(mesh.positions)
	};
}

export function createOwlAlbedo(mesh: OwlMesh, size = 512): RgbaImage {
	const rgba = new Uint8Array(size * size * 4);
	for (let i = 0; i < rgba.length; i += 4) {
		rgba[i] = 62;
		rgba[i + 1] = 42;
		rgba[i + 2] = 28;
		rgba[i + 3] = 255;
	}
	const { positions, indices, uvs } = mesh;
	for (let t = 0; t + 2 < indices.length; t += 3) {
		const ia = indices[t] ?? 0;
		const ib = indices[t + 1] ?? 0;
		const ic = indices[t + 2] ?? 0;
		rasterTriangle(
			rgba,
			size,
			uvs[ia * 2] ?? 0,
			uvs[ia * 2 + 1] ?? 0,
			uvs[ib * 2] ?? 0,
			uvs[ib * 2 + 1] ?? 0,
			uvs[ic * 2] ?? 0,
			uvs[ic * 2 + 1] ?? 0,
			positions[ia * 3] ?? 0,
			positions[ia * 3 + 1] ?? 0,
			positions[ia * 3 + 2] ?? 0,
			positions[ib * 3] ?? 0,
			positions[ib * 3 + 1] ?? 0,
			positions[ib * 3 + 2] ?? 0,
			positions[ic * 3] ?? 0,
			positions[ic * 3 + 1] ?? 0,
			positions[ic * 3 + 2] ?? 0
		);
	}
	return { width: size, height: size, rgba };
}

export async function createOwlGlb(): Promise<ArrayBuffer> {
	const geometry = createOwlGeometry();
	return writeFixtureGlb('owl', [
		{
			...geometry,
			materialName: 'plumage',
			albedo: createOwlAlbedo(geometry, 512)
		}
	]);
}

function marchingTetrahedra(resolution: number): { positions: Float32Array; indices: Uint32Array } {
	const sx = OWL_MAX[0] - OWL_MIN[0];
	const sy = OWL_MAX[1] - OWL_MIN[1];
	const sz = OWL_MAX[2] - OWL_MIN[2];
	const longest = Math.max(sx, sy, sz);
	const cell = longest / resolution;
	const nx = Math.max(8, Math.ceil(sx / cell));
	const ny = Math.max(8, Math.ceil(sy / cell));
	const nz = Math.max(8, Math.ceil(sz / cell));
	const gx = nx + 1;
	const gy = ny + 1;
	const gz = nz + 1;
	const sdf = new Float32Array(gx * gy * gz);
	const gridIndex = (ix: number, iy: number, iz: number) => ix + iy * gx + iz * gx * gy;
	for (let iz = 0; iz < gz; iz++) {
		const z = OWL_MIN[2] + iz * cell;
		for (let iy = 0; iy < gy; iy++) {
			const y = OWL_MIN[1] + iy * cell;
			for (let ix = 0; ix < gx; ix++) {
				const x = OWL_MIN[0] + ix * cell;
				sdf[gridIndex(ix, iy, iz)] = owlSdf(x, y, z);
			}
		}
	}

	const positions: number[] = [];
	const indices: number[] = [];
	const vertexOf = new Map<string, number>();
	const corner = new Int32Array(4);
	const values = new Float32Array(4);

	const ensureEdge = (a: number, b: number): number => {
		const key = a < b ? `${a}:${b}` : `${b}:${a}`;
		const existing = vertexOf.get(key);
		if (existing !== undefined) return existing;
		const sa = sdf[a] ?? 1;
		const sb = sdf[b] ?? 1;
		const t = sa / (sa - sb);
		const ax = OWL_MIN[0] + (a % gx) * cell;
		const ay = OWL_MIN[1] + (Math.floor(a / gx) % gy) * cell;
		const az = OWL_MIN[2] + Math.floor(a / (gx * gy)) * cell;
		const bx = OWL_MIN[0] + (b % gx) * cell;
		const by = OWL_MIN[1] + (Math.floor(b / gx) % gy) * cell;
		const bz = OWL_MIN[2] + Math.floor(b / (gx * gy)) * cell;
		const index = positions.length / 3;
		positions.push(ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t);
		vertexOf.set(key, index);
		return index;
	};

	for (let iz = 0; iz < nz; iz++) {
		for (let iy = 0; iy < ny; iy++) {
			for (let ix = 0; ix < nx; ix++) {
				const cube: number[] = [];
				for (const [dx, dy, dz] of CUBE_CORNER) {
					cube.push(gridIndex(ix + dx, iy + dy, iz + dz));
				}
				for (const tet of TET_VERTS) {
					for (let c = 0; c < 4; c++) {
						const gi = cube[tet[c] ?? 0] ?? 0;
						corner[c] = gi;
						values[c] = sdf[gi] ?? 1;
					}
					emitTet(values, corner, ensureEdge, indices);
				}
			}
		}
	}

	return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

function emitTet(
	values: Float32Array,
	corner: Int32Array,
	ensureEdge: (a: number, b: number) => number,
	indices: number[]
): void {
	let mask = 0;
	for (let i = 0; i < 4; i++) {
		if ((values[i] ?? 1) < 0) mask |= 1 << i;
	}
	if (mask === 0 || mask === 15) return;

	const inside: number[] = [];
	const outside: number[] = [];
	for (let i = 0; i < 4; i++) {
		if (mask & (1 << i)) inside.push(i);
		else outside.push(i);
	}

	if (inside.length === 1) {
		const i = inside[0] ?? 0;
		const a = outside[0] ?? 0;
		const b = outside[1] ?? 0;
		const c = outside[2] ?? 0;
		pushTri(indices, ensureEdge(corner[i] ?? 0, corner[a] ?? 0), ensureEdge(corner[i] ?? 0, corner[b] ?? 0), ensureEdge(corner[i] ?? 0, corner[c] ?? 0));
		return;
	}
	if (inside.length === 3) {
		const o = outside[0] ?? 0;
		const a = inside[0] ?? 0;
		const b = inside[1] ?? 0;
		const c = inside[2] ?? 0;
		pushTri(indices, ensureEdge(corner[o] ?? 0, corner[a] ?? 0), ensureEdge(corner[o] ?? 0, corner[c] ?? 0), ensureEdge(corner[o] ?? 0, corner[b] ?? 0));
		return;
	}
	const i0 = inside[0] ?? 0;
	const i1 = inside[1] ?? 0;
	const o0 = outside[0] ?? 0;
	const o1 = outside[1] ?? 0;
	const e00 = ensureEdge(corner[i0] ?? 0, corner[o0] ?? 0);
	const e01 = ensureEdge(corner[i0] ?? 0, corner[o1] ?? 0);
	const e10 = ensureEdge(corner[i1] ?? 0, corner[o0] ?? 0);
	const e11 = ensureEdge(corner[i1] ?? 0, corner[o1] ?? 0);
	pushTri(indices, e00, e10, e11);
	pushTri(indices, e00, e11, e01);
}

function pushTri(indices: number[], a: number, b: number, c: number): void {
	if (a === b || b === c || c === a) return;
	indices.push(a, b, c);
}

function subdivideOnce(mesh: { positions: Float32Array; indices: Uint32Array }): {
	positions: Float32Array;
	indices: Uint32Array;
} {
	const positions = Array.from(mesh.positions);
	const indices: number[] = [];
	const midOf = new Map<string, number>();
	const midpoint = (a: number, b: number): number => {
		const key = a < b ? `${a}:${b}` : `${b}:${a}`;
		const existing = midOf.get(key);
		if (existing !== undefined) return existing;
		const index = positions.length / 3;
		positions.push(
			((mesh.positions[a * 3] ?? 0) + (mesh.positions[b * 3] ?? 0)) * 0.5,
			((mesh.positions[a * 3 + 1] ?? 0) + (mesh.positions[b * 3 + 1] ?? 0)) * 0.5,
			((mesh.positions[a * 3 + 2] ?? 0) + (mesh.positions[b * 3 + 2] ?? 0)) * 0.5
		);
		midOf.set(key, index);
		return index;
	};
	for (let i = 0; i + 2 < mesh.indices.length; i += 3) {
		const a = mesh.indices[i] ?? 0;
		const b = mesh.indices[i + 1] ?? 0;
		const c = mesh.indices[i + 2] ?? 0;
		const ab = midpoint(a, b);
		const bc = midpoint(b, c);
		const ca = midpoint(c, a);
		indices.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
	}
	return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

function displaceFeathers(positions: Float32Array, indices: Uint32Array): void {
	const normals = computeNormals(positions, indices);
	for (let i = 0; i + 2 < positions.length; i += 3) {
		const x = positions[i] ?? 0;
		const y = positions[i + 1] ?? 0;
		const z = positions[i + 2] ?? 0;
		const mask = featherMask(x, y, z);
		if (mask <= 0) continue;
		const n = 0.016 * mask * (fbm(x * 16, y * 7, z * 16) * 2 - 1);
		const j = i;
		positions[j] = x + (normals[j] ?? 0) * n;
		positions[j + 1] = y + (normals[j + 1] ?? 0) * n;
		positions[j + 2] = z + (normals[j + 2] ?? 0) * n;
	}
}

function featherMask(x: number, y: number, z: number): number {
	if (sdEllipsoid(x, y, z, 0, 0.7, 0.42, 0.1, 0.08, 0.18) < 0.03) return 0;
	if (sdCapsule(x, y, z, -0.95, -0.5, 0.06, 0.95, -0.54, -0.04, 0.075) < 0.02) return 0.05;
	if (sdEllipsoid(x, y, z, -0.13, 0.88, 0.34, 0.08, 0.08, 0.06) < 0.015) return 0.15;
	if (sdEllipsoid(x, y, z, 0.13, 0.88, 0.34, 0.08, 0.08, 0.06) < 0.015) return 0.15;
	return 1;
}

function sphericalUv(positions: Float32Array): Float32Array {
	const uvs = new Float32Array((positions.length / 3) * 2);
	const cx = 0;
	const cy = 0.35;
	const cz = 0;
	for (let i = 0, v = 0; i + 2 < positions.length; i += 3, v += 2) {
		const x = (positions[i] ?? 0) - cx;
		const y = (positions[i + 1] ?? 0) - cy;
		const z = (positions[i + 2] ?? 0) - cz;
		uvs[v] = 0.5 + Math.atan2(z, x) / (Math.PI * 2);
		uvs[v + 1] = 0.5 + Math.atan2(y, Math.hypot(x, z)) / Math.PI;
	}
	return uvs;
}

function orientOutward(positions: Float32Array, indices: Uint32Array): void {
	let votes = 0;
	for (let i = 0; i + 2 < indices.length; i += 3) {
		const ia = (indices[i] ?? 0) * 3;
		const ib = (indices[i + 1] ?? 0) * 3;
		const ic = (indices[i + 2] ?? 0) * 3;
		const ax = positions[ia] ?? 0;
		const ay = positions[ia + 1] ?? 0;
		const az = positions[ia + 2] ?? 0;
		const bx = positions[ib] ?? 0;
		const by = positions[ib + 1] ?? 0;
		const bz = positions[ib + 2] ?? 0;
		const cx = positions[ic] ?? 0;
		const cy = positions[ic + 1] ?? 0;
		const cz = positions[ic + 2] ?? 0;
		const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
		const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
		const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
		const mx = (ax + bx + cx) / 3;
		const my = (ay + by + cy) / 3 - 0.3;
		const mz = (az + bz + cz) / 3;
		if (nx * mx + ny * my + nz * mz >= 0) votes += 1;
		else votes -= 1;
	}
	if (votes >= 0) return;
	for (let i = 0; i + 2 < indices.length; i += 3) {
		const b = indices[i + 1] ?? 0;
		indices[i + 1] = indices[i + 2] ?? 0;
		indices[i + 2] = b;
	}
}

function owlPaint(x: number, y: number, z: number): [number, number, number] {
	const branch = sdCapsule(x, y, z, -0.95, -0.5, 0.06, 0.95, -0.54, -0.04, 0.075);
	if (branch < 0.03) {
		const grain = 0.55 + 0.45 * fbm(x * 9, y * 22, z * 9);
		return [Math.round(92 * grain), Math.round(62 * grain), Math.round(38 * grain)];
	}
	if (sdEllipsoid(x, y, z, 0, 0.7, 0.42, 0.1, 0.08, 0.18) < 0.025) {
		return [214, 132, 48];
	}
	const eyeL = Math.hypot(x + 0.13, y - 0.88, z - 0.34);
	const eyeR = Math.hypot(x - 0.13, y - 0.88, z - 0.34);
	const eye = Math.min(eyeL, eyeR);
	if (eye < 0.055) {
		if (eye < 0.022) return [18, 14, 12];
		if (eye < 0.038) return [186, 112, 36];
		return [36, 28, 22];
	}
	if (y < -0.3 && Math.abs(x) < 0.28 && z > 0) {
		return [196, 118, 52];
	}
	const belly = z > 0.05 && y > -0.15 && y < 0.55 && Math.hypot(x, z - 0.1) < 0.32;
	const mottled = fbm(x * 18, y * 8, z * 18);
	if (belly) {
		const cream = 0.82 + 0.18 * mottled;
		return [Math.round(214 * cream), Math.round(196 * cream), Math.round(168 * cream)];
	}
	const brown = 0.55 + 0.45 * mottled;
	const streak = 0.85 + 0.15 * Math.sin(y * 28 + mottled * 4);
	return [Math.round(118 * brown * streak), Math.round(78 * brown * streak), Math.round(48 * brown * streak)];
}

function rasterTriangle(
	rgba: Uint8Array,
	size: number,
	u0: number,
	v0: number,
	u1: number,
	v1: number,
	u2: number,
	v2: number,
	x0: number,
	y0: number,
	z0: number,
	x1: number,
	y1: number,
	z1: number,
	x2: number,
	y2: number,
	z2: number
): void {
	if (Math.abs(u0 - u1) > 0.5 || Math.abs(u1 - u2) > 0.5 || Math.abs(u2 - u0) > 0.5) return;
	const ax = u0 * (size - 1);
	const ay = (1 - v0) * (size - 1);
	const bx = u1 * (size - 1);
	const by = (1 - v1) * (size - 1);
	const cx = u2 * (size - 1);
	const cy = (1 - v2) * (size - 1);
	const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
	const maxX = Math.min(size - 1, Math.ceil(Math.max(ax, bx, cx)));
	const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
	const maxY = Math.min(size - 1, Math.ceil(Math.max(ay, by, cy)));
	const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
	if (Math.abs(area) < 1e-8) return;
	for (let py = minY; py <= maxY; py++) {
		for (let px = minX; px <= maxX; px++) {
			const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area;
			const w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area;
			const w2 = 1 - w0 - w1;
			if (w0 < -0.01 || w1 < -0.01 || w2 < -0.01) continue;
			const x = x0 * w0 + x1 * w1 + x2 * w2;
			const y = y0 * w0 + y1 * w1 + y2 * w2;
			const z = z0 * w0 + z1 * w1 + z2 * w2;
			const [r, g, b] = owlPaint(x, y, z);
			const i = (py * size + px) * 4;
			rgba[i] = r;
			rgba[i + 1] = g;
			rgba[i + 2] = b;
			rgba[i + 3] = 255;
		}
	}
}

function sdEllipsoid(
	x: number,
	y: number,
	z: number,
	cx: number,
	cy: number,
	cz: number,
	rx: number,
	ry: number,
	rz: number
): number {
	return Math.hypot((x - cx) / rx, (y - cy) / ry, (z - cz) / rz) - 1;
}

function sdCapsule(
	x: number,
	y: number,
	z: number,
	ax: number,
	ay: number,
	az: number,
	bx: number,
	by: number,
	bz: number,
	r: number
): number {
	const pax = x - ax;
	const pay = y - ay;
	const paz = z - az;
	const bax = bx - ax;
	const bay = by - ay;
	const baz = bz - az;
	const baba = bax * bax + bay * bay + baz * baz;
	const h = Math.max(0, Math.min(1, (pax * bax + pay * bay + paz * baz) / Math.max(baba, 1e-8)));
	return Math.hypot(pax - bax * h, pay - bay * h, paz - baz * h) - r;
}

function smin(a: number, b: number, k: number): number {
	const h = Math.max(k - Math.abs(a - b), 0) / k;
	return Math.min(a, b) - h * h * k * 0.25;
}

function smax(a: number, b: number, k: number): number {
	return -smin(-a, -b, k);
}

function fbm(x: number, y: number, z: number): number {
	let sum = 0;
	let amp = 0.5;
	let fx = x;
	let fy = y;
	let fz = z;
	for (let i = 0; i < 4; i++) {
		sum += amp * valueNoise(fx, fy, fz);
		fx *= 2.03;
		fy *= 2.03;
		fz *= 2.03;
		amp *= 0.5;
	}
	return sum;
}

function valueNoise(x: number, y: number, z: number): number {
	const x0 = Math.floor(x);
	const y0 = Math.floor(y);
	const z0 = Math.floor(z);
	const tx = x - x0;
	const ty = y - y0;
	const tz = z - z0;
	const sx = tx * tx * (3 - 2 * tx);
	const sy = ty * ty * (3 - 2 * ty);
	const sz = tz * tz * (3 - 2 * tz);
	const n000 = hash3(x0, y0, z0);
	const n100 = hash3(x0 + 1, y0, z0);
	const n010 = hash3(x0, y0 + 1, z0);
	const n110 = hash3(x0 + 1, y0 + 1, z0);
	const n001 = hash3(x0, y0, z0 + 1);
	const n101 = hash3(x0 + 1, y0, z0 + 1);
	const n011 = hash3(x0, y0 + 1, z0 + 1);
	const n111 = hash3(x0 + 1, y0 + 1, z0 + 1);
	const nx00 = n000 + (n100 - n000) * sx;
	const nx10 = n010 + (n110 - n010) * sx;
	const nx01 = n001 + (n101 - n001) * sx;
	const nx11 = n011 + (n111 - n011) * sx;
	const nxy0 = nx00 + (nx10 - nx00) * sy;
	const nxy1 = nx01 + (nx11 - nx01) * sy;
	return nxy0 + (nxy1 - nxy0) * sz;
}

function hash3(ix: number, iy: number, iz: number): number {
	let n = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(iz, 2147483647);
	n = Math.imul(n ^ (n >>> 13), 1274126177);
	return ((n >>> 0) % 1000000) / 1000000;
}
