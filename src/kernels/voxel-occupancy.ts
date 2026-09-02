import { aabbFromPositions, clamp, type Aabb, type Vec3 } from './math';

export type VoxelLayout = {
	origin: Vec3;
	cell: number;
	nx: number;
	ny: number;
	nz: number;
	resolution: number;
};

export type VoxelizeHooks = {
	isCancelled?: () => boolean;
	onProgress?: (value: number) => void;
	maybeYield?: () => Promise<void>;
};

const PAD_CELLS = 2;
const SAT_VOLUME_LIMIT = 768;
const HALF = 0.5 + 1e-4;

export function voxelLayoutFromAabb(box: Aabb, resolution: number, padCells = PAD_CELLS): VoxelLayout {
	const sx = Math.max(box.max[0] - box.min[0], 1e-8);
	const sy = Math.max(box.max[1] - box.min[1], 1e-8);
	const sz = Math.max(box.max[2] - box.min[2], 1e-8);
	const longest = Math.max(sx, sy, sz);
	const res = Math.max(4, Math.floor(resolution));
	const cell = longest / res;
	return {
		origin: [box.min[0] - padCells * cell, box.min[1] - padCells * cell, box.min[2] - padCells * cell],
		cell,
		nx: Math.max(1, Math.ceil(sx / cell)) + padCells * 2,
		ny: Math.max(1, Math.ceil(sy / cell)) + padCells * 2,
		nz: Math.max(1, Math.ceil(sz / cell)) + padCells * 2,
		resolution: res
	};
}

export function voxelLayoutFromPositions(positions: Float32Array, resolution: number): VoxelLayout {
	return voxelLayoutFromAabb(aabbFromPositions(positions), resolution);
}

export function occupancyIndex(layout: VoxelLayout, x: number, y: number, z: number): number {
	return x + y * layout.nx + z * layout.nx * layout.ny;
}

export function occupancyCellCount(layout: VoxelLayout): number {
	return layout.nx * layout.ny * layout.nz;
}

export function countOccupied(occ: Uint8Array): number {
	let n = 0;
	for (let i = 0; i < occ.length; i++) {
		if (occ[i]) n++;
	}
	return n;
}

export function isOccupancySolid(occ: Uint8Array, layout: VoxelLayout, x: number, y: number, z: number): boolean {
	if (x < 0 || y < 0 || z < 0 || x >= layout.nx || y >= layout.ny || z >= layout.nz) return false;
	return occ[occupancyIndex(layout, x, y, z)] === 1;
}

export function cellCenter(layout: VoxelLayout, x: number, y: number, z: number, out: Vec3): Vec3 {
	out[0] = layout.origin[0] + (x + 0.5) * layout.cell;
	out[1] = layout.origin[1] + (y + 0.5) * layout.cell;
	out[2] = layout.origin[2] + (z + 0.5) * layout.cell;
	return out;
}

export function triangleAabbVoxelCount(
	positions: Float32Array,
	ia: number,
	ib: number,
	ic: number,
	layout: VoxelLayout
): number {
	const ax = positions[ia] ?? 0;
	const ay = positions[ia + 1] ?? 0;
	const az = positions[ia + 2] ?? 0;
	const bx = positions[ib] ?? 0;
	const by = positions[ib + 1] ?? 0;
	const bz = positions[ib + 2] ?? 0;
	const cx = positions[ic] ?? 0;
	const cy = positions[ic + 1] ?? 0;
	const cz = positions[ic + 2] ?? 0;
	const bounds = voxelAabb(ax, ay, az, bx, by, bz, cx, cy, cz, layout);
	return (bounds.maxX - bounds.minX + 1) * (bounds.maxY - bounds.minY + 1) * (bounds.maxZ - bounds.minZ + 1);
}

/**
 * Conservative triangle voxelization. A voxel is marked only if the triangle
 * overlaps that cell (Akenine-Möller SAT + 3D DDA on edges). Filling the
 * triangle AABB without an overlap test is incorrect.
 */
export async function voxelizeTriangles(
	positions: Float32Array,
	indices: Uint32Array,
	layout: VoxelLayout,
	hooks: VoxelizeHooks = {}
): Promise<Uint8Array> {
	const occ = new Uint8Array(occupancyCellCount(layout));
	const triangleCount = Math.floor(indices.length / 3);
	for (let t = 0; t < triangleCount; t++) {
		if (hooks.isCancelled?.()) throw new Error('cancelled');
		const ia = (indices[t * 3] ?? 0) * 3;
		const ib = (indices[t * 3 + 1] ?? 0) * 3;
		const ic = (indices[t * 3 + 2] ?? 0) * 3;
		voxelizeOneTriangle(
			positions[ia] ?? 0,
			positions[ia + 1] ?? 0,
			positions[ia + 2] ?? 0,
			positions[ib] ?? 0,
			positions[ib + 1] ?? 0,
			positions[ib + 2] ?? 0,
			positions[ic] ?? 0,
			positions[ic + 1] ?? 0,
			positions[ic + 2] ?? 0,
			layout,
			occ
		);
		if (t % 128 === 127) {
			hooks.onProgress?.((t + 1) / Math.max(1, triangleCount));
			await hooks.maybeYield?.();
		}
	}
	hooks.onProgress?.(1);
	return occ;
}

export type OccupancyAnalysis = {
	n: number;
	shell: number;
	outside: number;
	interior: number;
};

export const SOLID_INTERIOR_TO_SHELL = 0.5;

export function analyzeOccupancy(occ: Uint8Array, layout: VoxelLayout): OccupancyAnalysis {
	return countOccupancy(occ, floodOutside(occ, layout));
}

/** True when the occupancy encloses a real volume, not an open shell. */
export function occupancyLooksSolid(analysis: OccupancyAnalysis): boolean {
	if (analysis.shell < 8) return false;
	if (analysis.outside < analysis.n * 0.05) return false;
	if (analysis.shell + analysis.interior > analysis.n * 0.92) return false;
	return analysis.interior > analysis.shell * SOLID_INTERIOR_TO_SHELL;
}

export function dilateOccupancy(occ: Uint8Array, layout: VoxelLayout): void {
	const { nx, ny, nz } = layout;
	const next = new Uint8Array(occ);
	for (let z = 0; z < nz; z++) {
		for (let y = 0; y < ny; y++) {
			for (let x = 0; x < nx; x++) {
				if (!occ[occupancyIndex(layout, x, y, z)]) continue;
				for (let dz = -1; dz <= 1; dz++) {
					const zz = z + dz;
					if (zz < 0 || zz >= nz) continue;
					for (let dy = -1; dy <= 1; dy++) {
						const yy = y + dy;
						if (yy < 0 || yy >= ny) continue;
						for (let dx = -1; dx <= 1; dx++) {
							const xx = x + dx;
							if (xx < 0 || xx >= nx) continue;
							next[occupancyIndex(layout, xx, yy, zz)] = 1;
						}
					}
				}
			}
		}
	}
	occ.set(next);
}

/** Exterior flood-fill. Remaining empty cells (cavities) become solid. */
export function fillSolidFromSurface(occ: Uint8Array, layout: VoxelLayout): void {
	const outsideMask = floodOutside(occ, layout);
	if (!occupancyLooksSolid(countOccupancy(occ, outsideMask))) return;
	for (let i = 0; i < occ.length; i++) {
		occ[i] = outsideMask[i] ? 0 : 1;
	}
}

function countOccupancy(occ: Uint8Array, outsideMask: Uint8Array): OccupancyAnalysis {
	let shell = 0;
	let outside = 0;
	let interior = 0;
	for (let i = 0; i < occ.length; i++) {
		if (occ[i]) shell += 1;
		else if (outsideMask[i]) outside += 1;
		else interior += 1;
	}
	return { n: occ.length, shell, outside, interior };
}

function floodOutside(occ: Uint8Array, layout: VoxelLayout): Uint8Array {
	const { nx, ny, nz } = layout;
	const n = occupancyCellCount(layout);
	const outside = new Uint8Array(n);
	const queue = new Uint32Array(n);
	let head = 0;
	let tail = 0;

	const tryPush = (x: number, y: number, z: number): void => {
		if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) return;
		const i = occupancyIndex(layout, x, y, z);
		if (occ[i] || outside[i]) return;
		outside[i] = 1;
		queue[tail++] = i;
	};

	for (let z = 0; z < nz; z++) {
		for (let y = 0; y < ny; y++) {
			tryPush(0, y, z);
			tryPush(nx - 1, y, z);
		}
	}
	for (let z = 0; z < nz; z++) {
		for (let x = 0; x < nx; x++) {
			tryPush(x, 0, z);
			tryPush(x, ny - 1, z);
		}
	}
	for (let y = 0; y < ny; y++) {
		for (let x = 0; x < nx; x++) {
			tryPush(x, y, 0);
			tryPush(x, y, nz - 1);
		}
	}

	while (head < tail) {
		const i = queue[head++] ?? 0;
		const x = i % nx;
		const y = Math.floor(i / nx) % ny;
		const z = Math.floor(i / (nx * ny));
		tryPush(x - 1, y, z);
		tryPush(x + 1, y, z);
		tryPush(x, y - 1, z);
		tryPush(x, y + 1, z);
		tryPush(x, y, z - 1);
		tryPush(x, y, z + 1);
	}
	return outside;
}

function voxelizeOneTriangle(
	pax: number,
	pay: number,
	paz: number,
	pbx: number,
	pby: number,
	pbz: number,
	pcx: number,
	pcy: number,
	pcz: number,
	layout: VoxelLayout,
	occ: Uint8Array
): void {
	const inv = 1 / layout.cell;
	const ax = (pax - layout.origin[0]) * inv;
	const ay = (pay - layout.origin[1]) * inv;
	const az = (paz - layout.origin[2]) * inv;
	const bx = (pbx - layout.origin[0]) * inv;
	const by = (pby - layout.origin[1]) * inv;
	const bz = (pbz - layout.origin[2]) * inv;
	const cx = (pcx - layout.origin[0]) * inv;
	const cy = (pcy - layout.origin[1]) * inv;
	const cz = (pcz - layout.origin[2]) * inv;

	const bounds = clampAabb(
		Math.floor(Math.min(ax, bx, cx)),
		Math.floor(Math.min(ay, by, cy)),
		Math.floor(Math.min(az, bz, cz)),
		Math.floor(Math.max(ax, bx, cx)),
		Math.floor(Math.max(ay, by, cy)),
		Math.floor(Math.max(az, bz, cz)),
		layout
	);
	if (bounds.minX > bounds.maxX) return;

	const mark = (x: number, y: number, z: number): void => {
		if (x < 0 || y < 0 || z < 0 || x >= layout.nx || y >= layout.ny || z >= layout.nz) return;
		occ[occupancyIndex(layout, x, y, z)] = 1;
	};

	const tryMark = (x: number, y: number, z: number): void => {
		if (x < 0 || y < 0 || z < 0 || x >= layout.nx || y >= layout.ny || z >= layout.nz) return;
		if (triBoxOverlap(x + 0.5, y + 0.5, z + 0.5, HALF, ax, ay, az, bx, by, bz, cx, cy, cz)) {
			occ[occupancyIndex(layout, x, y, z)] = 1;
		}
	};

	ddaLine(ax, ay, az, bx, by, bz, mark);
	ddaLine(bx, by, bz, cx, cy, cz, mark);
	ddaLine(cx, cy, cz, ax, ay, az, mark);

	const volume =
		(bounds.maxX - bounds.minX + 1) * (bounds.maxY - bounds.minY + 1) * (bounds.maxZ - bounds.minZ + 1);
	if (volume <= SAT_VOLUME_LIMIT) {
		for (let z = bounds.minZ; z <= bounds.maxZ; z++) {
			for (let y = bounds.minY; y <= bounds.maxY; y++) {
				for (let x = bounds.minX; x <= bounds.maxX; x++) {
					tryMark(x, y, z);
				}
			}
		}
		return;
	}

	const e1x = bx - ax;
	const e1y = by - ay;
	const e1z = bz - az;
	const e2x = cx - ax;
	const e2y = cy - ay;
	const e2z = cz - az;
	const tnx = e1y * e2z - e1z * e2y;
	const tny = e1z * e2x - e1x * e2z;
	const tnz = e1x * e2y - e1y * e2x;
	const anx = Math.abs(tnx);
	const any = Math.abs(tny);
	const anz = Math.abs(tnz);

	if (anz >= anx && anz >= any) {
		sweepDominantZ(bounds, ax, ay, az, tnx, tny, tnz, tryMark);
	} else if (any >= anx) {
		sweepDominantY(bounds, ax, ay, az, tnx, tny, tnz, tryMark);
	} else {
		sweepDominantX(bounds, ax, ay, az, tnx, tny, tnz, tryMark);
	}
}

function voxelAabb(
	ax: number,
	ay: number,
	az: number,
	bx: number,
	by: number,
	bz: number,
	cx: number,
	cy: number,
	cz: number,
	layout: VoxelLayout
): { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } {
	const inv = 1 / layout.cell;
	return clampAabb(
		Math.floor((Math.min(ax, bx, cx) - layout.origin[0]) * inv),
		Math.floor((Math.min(ay, by, cy) - layout.origin[1]) * inv),
		Math.floor((Math.min(az, bz, cz) - layout.origin[2]) * inv),
		Math.floor((Math.max(ax, bx, cx) - layout.origin[0]) * inv),
		Math.floor((Math.max(ay, by, cy) - layout.origin[1]) * inv),
		Math.floor((Math.max(az, bz, cz) - layout.origin[2]) * inv),
		layout
	);
}

function clampAabb(
	minX: number,
	minY: number,
	minZ: number,
	maxX: number,
	maxY: number,
	maxZ: number,
	layout: VoxelLayout
): { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } {
	return {
		minX: clamp(minX, 0, layout.nx - 1),
		minY: clamp(minY, 0, layout.ny - 1),
		minZ: clamp(minZ, 0, layout.nz - 1),
		maxX: clamp(maxX, 0, layout.nx - 1),
		maxY: clamp(maxY, 0, layout.ny - 1),
		maxZ: clamp(maxZ, 0, layout.nz - 1)
	};
}

function sweepDominantZ(
	bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number },
	ax: number,
	ay: number,
	az: number,
	tnx: number,
	tny: number,
	tnz: number,
	tryMark: (x: number, y: number, z: number) => void
): void {
	if (Math.abs(tnz) < 1e-12) {
		for (let z = bounds.minZ; z <= bounds.maxZ; z++) {
			for (let y = bounds.minY; y <= bounds.maxY; y++) {
				for (let x = bounds.minX; x <= bounds.maxX; x++) tryMark(x, y, z);
			}
		}
		return;
	}
	const invN = 1 / tnz;
	for (let y = bounds.minY; y <= bounds.maxY; y++) {
		for (let x = bounds.minX; x <= bounds.maxX; x++) {
			let zMin = Infinity;
			let zMax = -Infinity;
			for (const ox of [x, x + 1]) {
				for (const oy of [y, y + 1]) {
					const z = az - (tnx * (ox - ax) + tny * (oy - ay)) * invN;
					if (z < zMin) zMin = z;
					if (z > zMax) zMax = z;
				}
			}
			const z0 = Math.max(bounds.minZ, Math.floor(zMin) - 1);
			const z1 = Math.min(bounds.maxZ, Math.ceil(zMax));
			for (let z = z0; z <= z1; z++) tryMark(x, y, z);
		}
	}
}

function sweepDominantY(
	bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number },
	ax: number,
	ay: number,
	az: number,
	tnx: number,
	tny: number,
	tnz: number,
	tryMark: (x: number, y: number, z: number) => void
): void {
	if (Math.abs(tny) < 1e-12) {
		for (let z = bounds.minZ; z <= bounds.maxZ; z++) {
			for (let y = bounds.minY; y <= bounds.maxY; y++) {
				for (let x = bounds.minX; x <= bounds.maxX; x++) tryMark(x, y, z);
			}
		}
		return;
	}
	const invN = 1 / tny;
	for (let z = bounds.minZ; z <= bounds.maxZ; z++) {
		for (let x = bounds.minX; x <= bounds.maxX; x++) {
			let yMin = Infinity;
			let yMax = -Infinity;
			for (const ox of [x, x + 1]) {
				for (const oz of [z, z + 1]) {
					const y = ay - (tnx * (ox - ax) + tnz * (oz - az)) * invN;
					if (y < yMin) yMin = y;
					if (y > yMax) yMax = y;
				}
			}
			const y0 = Math.max(bounds.minY, Math.floor(yMin) - 1);
			const y1 = Math.min(bounds.maxY, Math.ceil(yMax));
			for (let y = y0; y <= y1; y++) tryMark(x, y, z);
		}
	}
}

function sweepDominantX(
	bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number },
	ax: number,
	ay: number,
	az: number,
	tnx: number,
	tny: number,
	tnz: number,
	tryMark: (x: number, y: number, z: number) => void
): void {
	if (Math.abs(tnx) < 1e-12) {
		for (let z = bounds.minZ; z <= bounds.maxZ; z++) {
			for (let y = bounds.minY; y <= bounds.maxY; y++) {
				for (let x = bounds.minX; x <= bounds.maxX; x++) tryMark(x, y, z);
			}
		}
		return;
	}
	const invN = 1 / tnx;
	for (let z = bounds.minZ; z <= bounds.maxZ; z++) {
		for (let y = bounds.minY; y <= bounds.maxY; y++) {
			let xMin = Infinity;
			let xMax = -Infinity;
			for (const oy of [y, y + 1]) {
				for (const oz of [z, z + 1]) {
					const x = ax - (tny * (oy - ay) + tnz * (oz - az)) * invN;
					if (x < xMin) xMin = x;
					if (x > xMax) xMax = x;
				}
			}
			const x0 = Math.max(bounds.minX, Math.floor(xMin) - 1);
			const x1 = Math.min(bounds.maxX, Math.ceil(xMax));
			for (let x = x0; x <= x1; x++) tryMark(x, y, z);
		}
	}
}

function ddaLine(
	x0: number,
	y0: number,
	z0: number,
	x1: number,
	y1: number,
	z1: number,
	mark: (x: number, y: number, z: number) => void
): void {
	let ix = Math.floor(x0);
	let iy = Math.floor(y0);
	let iz = Math.floor(z0);
	const ix1 = Math.floor(x1);
	const iy1 = Math.floor(y1);
	const iz1 = Math.floor(z1);
	mark(ix, iy, iz);
	if (ix === ix1 && iy === iy1 && iz === iz1) return;

	const dx = x1 - x0;
	const dy = y1 - y0;
	const dz = z1 - z0;
	const sx = dx >= 0 ? 1 : -1;
	const sy = dy >= 0 ? 1 : -1;
	const sz = dz >= 0 ? 1 : -1;
	const ax = Math.abs(dx);
	const ay = Math.abs(dy);
	const az = Math.abs(dz);
	const tDeltaX = ax < 1e-12 ? Infinity : 1 / ax;
	const tDeltaY = ay < 1e-12 ? Infinity : 1 / ay;
	const tDeltaZ = az < 1e-12 ? Infinity : 1 / az;
	let tMaxX = ax < 1e-12 ? Infinity : (sx > 0 ? ix + 1 - x0 : x0 - ix) / ax;
	let tMaxY = ay < 1e-12 ? Infinity : (sy > 0 ? iy + 1 - y0 : y0 - iy) / ay;
	let tMaxZ = az < 1e-12 ? Infinity : (sz > 0 ? iz + 1 - z0 : z0 - iz) / az;

	const maxSteps = Math.abs(ix1 - ix) + Math.abs(iy1 - iy) + Math.abs(iz1 - iz) + 2;
	for (let step = 0; step < maxSteps; step++) {
		if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
			ix += sx;
			tMaxX += tDeltaX;
		} else if (tMaxY <= tMaxZ) {
			iy += sy;
			tMaxY += tDeltaY;
		} else {
			iz += sz;
			tMaxZ += tDeltaZ;
		}
		mark(ix, iy, iz);
		if (ix === ix1 && iy === iy1 && iz === iz1) return;
	}
}

/**
 * Triangle vs AABB SAT. Tomas Akenine-Möller, "Fast 3D Triangle-Box Overlap Testing".
 * Box is axis-aligned, centered at `cx,cy,cz` with half-extent `half`.
 */
export function triBoxOverlap(
	cx: number,
	cy: number,
	cz: number,
	half: number,
	v0x: number,
	v0y: number,
	v0z: number,
	v1x: number,
	v1y: number,
	v1z: number,
	v2x: number,
	v2y: number,
	v2z: number
): boolean {
	const x0 = v0x - cx;
	const y0 = v0y - cy;
	const z0 = v0z - cz;
	const x1 = v1x - cx;
	const y1 = v1y - cy;
	const z1 = v1z - cz;
	const x2 = v2x - cx;
	const y2 = v2y - cy;
	const z2 = v2z - cz;

	const e0x = x1 - x0;
	const e0y = y1 - y0;
	const e0z = z1 - z0;
	const e1x = x2 - x1;
	const e1y = y2 - y1;
	const e1z = z2 - z1;
	const e2x = x0 - x2;
	const e2y = y0 - y2;
	const e2z = z0 - z2;

	const f0x = Math.abs(e0x);
	const f0y = Math.abs(e0y);
	const f0z = Math.abs(e0z);
	if (!axisTestX01(e0z, e0y, f0z, f0y, y0, z0, y2, z2, half)) return false;
	if (!axisTestY02(e0z, e0x, f0z, f0x, x0, z0, x2, z2, half)) return false;
	if (!axisTestZ12(e0y, e0x, f0y, f0x, x1, y1, x2, y2, half)) return false;

	const f1x = Math.abs(e1x);
	const f1y = Math.abs(e1y);
	const f1z = Math.abs(e1z);
	if (!axisTestX01(e1z, e1y, f1z, f1y, y0, z0, y2, z2, half)) return false;
	if (!axisTestY02(e1z, e1x, f1z, f1x, x0, z0, x2, z2, half)) return false;
	if (!axisTestZ0(e1y, e1x, f1y, f1x, x0, y0, x1, y1, half)) return false;

	const f2x = Math.abs(e2x);
	const f2y = Math.abs(e2y);
	const f2z = Math.abs(e2z);
	if (!axisTestX2(e2z, e2y, f2z, f2y, y0, z0, y1, z1, half)) return false;
	if (!axisTestY1(e2z, e2x, f2z, f2x, x0, z0, x1, z1, half)) return false;
	if (!axisTestZ12(e2y, e2x, f2y, f2x, x1, y1, x2, y2, half)) return false;

	const minX = Math.min(x0, x1, x2);
	const maxX = Math.max(x0, x1, x2);
	if (minX > half || maxX < -half) return false;
	const minY = Math.min(y0, y1, y2);
	const maxY = Math.max(y0, y1, y2);
	if (minY > half || maxY < -half) return false;
	const minZ = Math.min(z0, z1, z2);
	const maxZ = Math.max(z0, z1, z2);
	if (minZ > half || maxZ < -half) return false;

	const nx = e0y * e1z - e0z * e1y;
	const ny = e0z * e1x - e0x * e1z;
	const nz = e0x * e1y - e0y * e1x;
	return planeBoxOverlap(nx, ny, nz, x0, y0, z0, half);
}

function axisTestX01(
	a: number,
	b: number,
	fa: number,
	fb: number,
	y0: number,
	z0: number,
	y2: number,
	z2: number,
	half: number
): boolean {
	const p0 = a * y0 - b * z0;
	const p2 = a * y2 - b * z2;
	const rad = fa * half + fb * half;
	return !(Math.min(p0, p2) > rad || Math.max(p0, p2) < -rad);
}

function axisTestX2(
	a: number,
	b: number,
	fa: number,
	fb: number,
	y0: number,
	z0: number,
	y1: number,
	z1: number,
	half: number
): boolean {
	const p0 = a * y0 - b * z0;
	const p1 = a * y1 - b * z1;
	const rad = fa * half + fb * half;
	return !(Math.min(p0, p1) > rad || Math.max(p0, p1) < -rad);
}

function axisTestY02(
	a: number,
	b: number,
	fa: number,
	fb: number,
	x0: number,
	z0: number,
	x2: number,
	z2: number,
	half: number
): boolean {
	const p0 = -a * x0 + b * z0;
	const p2 = -a * x2 + b * z2;
	const rad = fa * half + fb * half;
	return !(Math.min(p0, p2) > rad || Math.max(p0, p2) < -rad);
}

function axisTestY1(
	a: number,
	b: number,
	fa: number,
	fb: number,
	x0: number,
	z0: number,
	x1: number,
	z1: number,
	half: number
): boolean {
	const p0 = -a * x0 + b * z0;
	const p1 = -a * x1 + b * z1;
	const rad = fa * half + fb * half;
	return !(Math.min(p0, p1) > rad || Math.max(p0, p1) < -rad);
}

function axisTestZ12(
	a: number,
	b: number,
	fa: number,
	fb: number,
	x1: number,
	y1: number,
	x2: number,
	y2: number,
	half: number
): boolean {
	const p1 = a * x1 - b * y1;
	const p2 = a * x2 - b * y2;
	const rad = fa * half + fb * half;
	return !(Math.min(p1, p2) > rad || Math.max(p1, p2) < -rad);
}

function axisTestZ0(
	a: number,
	b: number,
	fa: number,
	fb: number,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	half: number
): boolean {
	const p0 = a * x0 - b * y0;
	const p1 = a * x1 - b * y1;
	const rad = fa * half + fb * half;
	return !(Math.min(p0, p1) > rad || Math.max(p0, p1) < -rad);
}

function planeBoxOverlap(
	nx: number,
	ny: number,
	nz: number,
	vx: number,
	vy: number,
	vz: number,
	half: number
): boolean {
	const vminx = nx > 0 ? -half - vx : half - vx;
	const vmaxx = nx > 0 ? half - vx : -half - vx;
	const vminy = ny > 0 ? -half - vy : half - vy;
	const vmaxy = ny > 0 ? half - vy : -half - vy;
	const vminz = nz > 0 ? -half - vz : half - vz;
	const vmaxz = nz > 0 ? half - vz : -half - vz;
	if (nx * vminx + ny * vminy + nz * vminz > 0) return false;
	return nx * vmaxx + ny * vmaxy + nz * vmaxz >= 0;
}
