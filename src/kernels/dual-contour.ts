import { closestPointToPoint, interpolateAttribute, raycastFirst, type MeshBvh } from './bvh';
import { vec3Create, vec3Normalize, type Vec3 } from './math';
import {
	cellCenter,
	isOccupancySolid,
	occupancyIndex,
	type VoxelLayout
} from './voxel-occupancy';

export type DualContourHooks = {
	isCancelled?: () => boolean;
	onProgress?: (value: number) => void;
	maybeYield?: () => Promise<void>;
};

/**
 * Dual contouring of a binary occupancy field (Ju, Losasso, Schaefer, Warren).
 * One QEF vertex per mixed dual cube, quads from sign-changing occupancy edges.
 */
export async function extractDualContour(
	occ: Uint8Array,
	layout: VoxelLayout,
	hooks: DualContourHooks = {},
	tree: MeshBvh | null = null
): Promise<{ positions: Float32Array; indices: Uint32Array; cells: Int32Array }> {
	const dx = layout.nx - 1;
	const dy = layout.ny - 1;
	const dz = layout.nz - 1;
	if (dx < 1 || dy < 1 || dz < 1) {
		return { positions: new Float32Array(), indices: new Uint32Array(), cells: new Int32Array() };
	}

	const vertexOf = new Map<number, number>();
	const positions: number[] = [];
	const cells: number[] = [];
	const ata = new Float64Array(6);
	const atb = new Float64Array(3);
	const mass = vec3Create();
	const hermiteP = vec3Create();
	const hermiteN = vec3Create();
	const solved = vec3Create();
	const cubeMin = vec3Create();
	const cubeMax = vec3Create();
	const center = vec3Create();

	const cubeKey = (i: number, j: number, k: number) => i + j * dx + k * dx * dy;

	const ensureVertex = (i: number, j: number, k: number): number => {
		const key = cubeKey(i, j, k);
		const existing = vertexOf.get(key);
		if (existing !== undefined) return existing;
		const index = positions.length / 3;
		placeQefVertex(
			occ,
			layout,
			i,
			j,
			k,
			ata,
			atb,
			mass,
			hermiteP,
			hermiteN,
			solved,
			cubeMin,
			cubeMax,
			center,
			tree
		);
		vertexOf.set(key, index);
		positions.push(solved[0], solved[1], solved[2]);
		cells.push(i, j, k);
		return index;
	};

	const indices: number[] = [];
	const { nx, ny, nz } = layout;

	for (let z = 0; z < nz; z++) {
		if (hooks.isCancelled?.()) throw new Error('cancelled');
		for (let y = 0; y < ny; y++) {
			for (let x = 0; x < nx; x++) {
				const solid = occ[occupancyIndex(layout, x, y, z)] === 1;
				if (x + 1 < nx) {
					const other = occ[occupancyIndex(layout, x + 1, y, z)] === 1;
					if (solid !== other) {
						emitEdgeQuad(x, y, z, 0, !solid, dx, dy, dz, ensureVertex, indices);
					}
				}
				if (y + 1 < ny) {
					const other = occ[occupancyIndex(layout, x, y + 1, z)] === 1;
					if (solid !== other) {
						emitEdgeQuad(x, y, z, 1, !solid, dx, dy, dz, ensureVertex, indices);
					}
				}
				if (z + 1 < nz) {
					const other = occ[occupancyIndex(layout, x, y, z + 1)] === 1;
					if (solid !== other) {
						emitEdgeQuad(x, y, z, 2, !solid, dx, dy, dz, ensureVertex, indices);
					}
				}
			}
		}
		if (z % 2 === 1) {
			hooks.onProgress?.((z + 1) / nz);
			await hooks.maybeYield?.();
		}
	}

	orientOutward(positions, indices, layout);
	hooks.onProgress?.(1);
	return {
		positions: Float32Array.from(positions),
		indices: Uint32Array.from(indices),
		cells: Int32Array.from(cells)
	};
}

export function dualCubeCenter(layout: VoxelLayout, i: number, j: number, k: number, out: Vec3): Vec3 {
	out[0] = layout.origin[0] + (i + 1) * layout.cell;
	out[1] = layout.origin[1] + (j + 1) * layout.cell;
	out[2] = layout.origin[2] + (k + 1) * layout.cell;
	return out;
}

export function clampToDualCube(layout: VoxelLayout, i: number, j: number, k: number, p: Vec3): void {
	const minX = layout.origin[0] + (i + 0.5) * layout.cell;
	const minY = layout.origin[1] + (j + 0.5) * layout.cell;
	const minZ = layout.origin[2] + (k + 0.5) * layout.cell;
	const maxX = minX + layout.cell;
	const maxY = minY + layout.cell;
	const maxZ = minZ + layout.cell;
	p[0] = Math.min(maxX, Math.max(minX, p[0]));
	p[1] = Math.min(maxY, Math.max(minY, p[1]));
	p[2] = Math.min(maxZ, Math.max(minZ, p[2]));
}

function emitEdgeQuad(
	x: number,
	y: number,
	z: number,
	axis: 0 | 1 | 2,
	flip: boolean,
	dx: number,
	dy: number,
	dz: number,
	ensureVertex: (i: number, j: number, k: number) => number,
	indices: number[]
): void {
	const cells: Array<[number, number, number]> = [
		[0, 0, 0],
		[0, 0, 0],
		[0, 0, 0],
		[0, 0, 0]
	];
	if (axis === 0) {
		cells[0] = [x, y - 1, z - 1];
		cells[1] = [x, y, z - 1];
		cells[2] = [x, y, z];
		cells[3] = [x, y - 1, z];
	} else if (axis === 1) {
		cells[0] = [x - 1, y, z - 1];
		cells[1] = [x - 1, y, z];
		cells[2] = [x, y, z];
		cells[3] = [x, y, z - 1];
	} else {
		cells[0] = [x - 1, y - 1, z];
		cells[1] = [x, y - 1, z];
		cells[2] = [x, y, z];
		cells[3] = [x - 1, y, z];
	}

	const verts: number[] = [];
	for (const cell of cells) {
		const i = cell[0];
		const j = cell[1];
		const k = cell[2];
		if (i < 0 || j < 0 || k < 0 || i >= dx || j >= dy || k >= dz) return;
		verts.push(ensureVertex(i, j, k));
	}
	const a = verts[0] ?? 0;
	const b = verts[1] ?? 0;
	const c = verts[2] ?? 0;
	const d = verts[3] ?? 0;
	if (a === b || b === c || c === d || d === a) return;
	if (flip) {
		indices.push(a, d, c, a, c, b);
	} else {
		indices.push(a, b, c, a, c, d);
	}
}

function placeQefVertex(
	occ: Uint8Array,
	layout: VoxelLayout,
	i: number,
	j: number,
	k: number,
	ata: Float64Array,
	atb: Float64Array,
	mass: Vec3,
	hermiteP: Vec3,
	hermiteN: Vec3,
	out: Vec3,
	cubeMin: Vec3,
	cubeMax: Vec3,
	center: Vec3,
	tree: MeshBvh | null
): void {
	ata.fill(0);
	atb.fill(0);
	mass[0] = 0;
	mass[1] = 0;
	mass[2] = 0;
	let planes = 0;

	const addEdge = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void => {
		const s0 = isOccupancySolid(occ, layout, x0, y0, z0);
		const s1 = isOccupancySolid(occ, layout, x1, y1, z1);
		if (s0 === s1) return;
		cellCenter(layout, x0, y0, z0, cubeMin);
		cellCenter(layout, x1, y1, z1, cubeMax);
		hermiteP[0] = (cubeMin[0] + cubeMax[0]) * 0.5;
		hermiteP[1] = (cubeMin[1] + cubeMax[1]) * 0.5;
		hermiteP[2] = (cubeMin[2] + cubeMax[2]) * 0.5;
		occupancyGradient(occ, layout, x0, y0, z0, x1, y1, z1, hermiteN);
		if (tree) {
			const dx = cubeMax[0] - cubeMin[0];
			const dy = cubeMax[1] - cubeMin[1];
			const dz = cubeMax[2] - cubeMin[2];
			const span = Math.hypot(dx, dy, dz);
			let hit = raycastFirst(tree, cubeMin, [dx, dy, dz], span * 1.2);
			if (!hit) hit = raycastFirst(tree, cubeMax, [-dx, -dy, -dz], span * 1.2);
			if (!hit) {
				const closest = closestPointToPoint(tree, hermiteP);
				if (closest) {
					const dist = Math.hypot(
						closest.point[0] - hermiteP[0],
						closest.point[1] - hermiteP[1],
						closest.point[2] - hermiteP[2]
					);
					if (dist <= layout.cell) {
						hermiteP[0] = closest.point[0];
						hermiteP[1] = closest.point[1];
						hermiteP[2] = closest.point[2];
						interpolateAttribute(tree.normals, tree.indices, closest.faceIndex, closest.barycentric, 3, hermiteN);
						vec3Normalize(hermiteN, hermiteN);
					}
				}
			} else {
				hermiteP[0] = hit.point[0];
				hermiteP[1] = hit.point[1];
				hermiteP[2] = hit.point[2];
				interpolateAttribute(tree.normals, tree.indices, hit.faceIndex, hit.barycentric, 3, hermiteN);
				vec3Normalize(hermiteN, hermiteN);
			}
		}
		clampToDualCube(layout, i, j, k, hermiteP);
		addPlane(ata, atb, mass, hermiteP, hermiteN);
		planes++;
	};

	addEdge(i, j, k, i + 1, j, k);
	addEdge(i, j + 1, k, i + 1, j + 1, k);
	addEdge(i, j, k + 1, i + 1, j, k + 1);
	addEdge(i, j + 1, k + 1, i + 1, j + 1, k + 1);
	addEdge(i, j, k, i, j + 1, k);
	addEdge(i + 1, j, k, i + 1, j + 1, k);
	addEdge(i, j, k + 1, i, j + 1, k + 1);
	addEdge(i + 1, j, k + 1, i + 1, j + 1, k + 1);
	addEdge(i, j, k, i, j, k + 1);
	addEdge(i + 1, j, k, i + 1, j, k + 1);
	addEdge(i, j + 1, k, i, j + 1, k + 1);
	addEdge(i + 1, j + 1, k, i + 1, j + 1, k + 1);

	cellCenter(layout, i, j, k, cubeMin);
	cellCenter(layout, i + 1, j + 1, k + 1, cubeMax);
	center[0] = (cubeMin[0] + cubeMax[0]) * 0.5;
	center[1] = (cubeMin[1] + cubeMax[1]) * 0.5;
	center[2] = (cubeMin[2] + cubeMax[2]) * 0.5;

	if (planes === 0) {
		out[0] = center[0];
		out[1] = center[1];
		out[2] = center[2];
		return;
	}

	mass[0] /= planes;
	mass[1] /= planes;
	mass[2] /= planes;
	clampToDualCube(layout, i, j, k, mass);
	solveQef(ata, atb, mass, out);
	const drift = Math.hypot(out[0] - mass[0], out[1] - mass[1], out[2] - mass[2]);
	if (!Number.isFinite(drift) || drift > layout.cell * 0.5) {
		out[0] = mass[0];
		out[1] = mass[1];
		out[2] = mass[2];
	}
	clampToDualCube(layout, i, j, k, out);
}

function occupancyGradient(
	occ: Uint8Array,
	layout: VoxelLayout,
	x0: number,
	y0: number,
	z0: number,
	x1: number,
	y1: number,
	z1: number,
	out: Vec3
): void {
	const s0 = isOccupancySolid(occ, layout, x0, y0, z0) ? 1 : 0;
	const s1 = isOccupancySolid(occ, layout, x1, y1, z1) ? 1 : 0;
	out[0] = s1 - s0;
	out[1] = 0;
	out[2] = 0;
	if (y1 !== y0) {
		out[0] = 0;
		out[1] = s1 - s0;
	} else if (z1 !== z0) {
		out[0] = 0;
		out[2] = s1 - s0;
	}
	if (out[0] === 0 && out[1] === 0 && out[2] === 0) {
		out[1] = 1;
		return;
	}
	vec3Normalize(out, out);
}

function addPlane(ata: Float64Array, atb: Float64Array, mass: Vec3, p: Vec3, n: Vec3): void {
	const nx = n[0];
	const ny = n[1];
	const nz = n[2];
	ata[0] += nx * nx;
	ata[1] += nx * ny;
	ata[2] += nx * nz;
	ata[3] += ny * ny;
	ata[4] += ny * nz;
	ata[5] += nz * nz;
	const d = nx * p[0] + ny * p[1] + nz * p[2];
	atb[0] += nx * d;
	atb[1] += ny * d;
	atb[2] += nz * d;
	mass[0] += p[0];
	mass[1] += p[1];
	mass[2] += p[2];
}

function solveQef(ata: Float64Array, atb: Float64Array, mass: Vec3, out: Vec3): void {
	const m00 = ata[0] ?? 0;
	const m01 = ata[1] ?? 0;
	const m02 = ata[2] ?? 0;
	const m11 = ata[3] ?? 0;
	const m12 = ata[4] ?? 0;
	const m22 = ata[5] ?? 0;
	const rhs0 = (atb[0] ?? 0) - (m00 * mass[0] + m01 * mass[1] + m02 * mass[2]);
	const rhs1 = (atb[1] ?? 0) - (m01 * mass[0] + m11 * mass[1] + m12 * mass[2]);
	const rhs2 = (atb[2] ?? 0) - (m02 * mass[0] + m12 * mass[1] + m22 * mass[2]);
	const trace = m00 + m11 + m22;
	const eps = Math.max(1e-3, 0.05 * (Math.abs(trace) + 1));
	const delta = solveSymmetric3(m00 + eps, m01, m02, m11 + eps, m12, m22 + eps, rhs0, rhs1, rhs2);
	if (!delta) {
		out[0] = mass[0];
		out[1] = mass[1];
		out[2] = mass[2];
		return;
	}
	out[0] = mass[0] + delta[0];
	out[1] = mass[1] + delta[1];
	out[2] = mass[2] + delta[2];
	if (!Number.isFinite(out[0]) || !Number.isFinite(out[1]) || !Number.isFinite(out[2])) {
		out[0] = mass[0];
		out[1] = mass[1];
		out[2] = mass[2];
	}
}

function solveSymmetric3(
	m00: number,
	m01: number,
	m02: number,
	m11: number,
	m12: number,
	m22: number,
	b0: number,
	b1: number,
	b2: number
): [number, number, number] | null {
	let a00 = m00;
	let a01 = m01;
	let a02 = m02;
	let a03 = b0;
	let a10 = m01;
	let a11 = m11;
	let a12 = m12;
	let a13 = b1;
	let a20 = m02;
	let a21 = m12;
	let a22 = m22;
	let a23 = b2;

	const swapRows = (r: 0 | 1 | 2, s: 0 | 1 | 2): void => {
		if (r === s) return;
		const row = (i: 0 | 1 | 2): [number, number, number, number] => {
			if (i === 0) return [a00, a01, a02, a03];
			if (i === 1) return [a10, a11, a12, a13];
			return [a20, a21, a22, a23];
		};
		const set = (i: 0 | 1 | 2, v: [number, number, number, number]): void => {
			if (i === 0) {
				a00 = v[0];
				a01 = v[1];
				a02 = v[2];
				a03 = v[3];
				return;
			}
			if (i === 1) {
				a10 = v[0];
				a11 = v[1];
				a12 = v[2];
				a13 = v[3];
				return;
			}
			a20 = v[0];
			a21 = v[1];
			a22 = v[2];
			a23 = v[3];
		};
		const tmp = row(r);
		set(r, row(s));
		set(s, tmp);
	};

	const abs0 = Math.abs(a00);
	const abs1 = Math.abs(a10);
	const abs2 = Math.abs(a20);
	if (abs1 >= abs0 && abs1 >= abs2) swapRows(0, 1);
	else if (abs2 >= abs0 && abs2 >= abs1) swapRows(0, 2);
	if (Math.abs(a00) < 1e-12) return null;
	let f = a10 / a00;
	a10 -= f * a00;
	a11 -= f * a01;
	a12 -= f * a02;
	a13 -= f * a03;
	f = a20 / a00;
	a20 -= f * a00;
	a21 -= f * a01;
	a22 -= f * a02;
	a23 -= f * a03;

	if (Math.abs(a21) > Math.abs(a11)) swapRows(1, 2);
	if (Math.abs(a11) < 1e-12) return null;
	f = a21 / a11;
	a21 -= f * a11;
	a22 -= f * a12;
	a23 -= f * a13;
	if (Math.abs(a22) < 1e-12) return null;

	const z = a23 / a22;
	const y = (a13 - a12 * z) / a11;
	const x = (a03 - a01 * y - a02 * z) / a00;
	if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
	return [x, y, z];
}

function orientOutward(positions: number[], indices: number[], layout: VoxelLayout): void {
	const cx = layout.origin[0] + (layout.nx * 0.5) * layout.cell;
	const cy = layout.origin[1] + (layout.ny * 0.5) * layout.cell;
	const cz = layout.origin[2] + (layout.nz * 0.5) * layout.cell;
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
		const cxp = positions[ic] ?? 0;
		const cyp = positions[ic + 1] ?? 0;
		const czp = positions[ic + 2] ?? 0;
		const e1x = bx - ax;
		const e1y = by - ay;
		const e1z = bz - az;
		const e2x = cxp - ax;
		const e2y = cyp - ay;
		const e2z = czp - az;
		const nx = e1y * e2z - e1z * e2y;
		const ny = e1z * e2x - e1x * e2z;
		const nz = e1x * e2y - e1y * e2x;
		const mx = (ax + bx + cxp) / 3 - cx;
		const my = (ay + by + cyp) / 3 - cy;
		const mz = (az + bz + czp) / 3 - cz;
		if (nx * mx + ny * my + nz * mz >= 0) votes++;
		else votes--;
	}
	if (votes >= 0) return;
	for (let i = 0; i + 2 < indices.length; i += 3) {
		const b = indices[i + 1] ?? 0;
		indices[i + 1] = indices[i + 2] ?? 0;
		indices[i + 2] = b;
	}
}
