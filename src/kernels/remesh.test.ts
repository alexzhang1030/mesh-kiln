import { describe, expect, it } from 'vitest';
import { buildBvh, islandCount } from './bvh';
import { extractDualContour, dualCubeCenter, clampToDualCube } from './dual-contour';
import { createCrestGeometry, createWavyVaseGeometry } from './fixture';
import { aabbFromPositions, type Vec3 } from './math';
import { computeNormals } from './normals';
import { vertexCountOf } from './types';
import {
	countLatticeCorners,
	maxVertexDistanceToMesh,
	maxTriangleCentroidDistanceToMesh,
	remesh,
	remeshDistanceLimit,
	remeshFollowsSource,
	remeshTriangleTarget,
	shouldVoxelRemesh,
	solveVerticesToSurface
} from './remesh';
import {
	analyzeOccupancy,
	countOccupied,
	dilateOccupancy,
	fillSolidFromSurface,
	occupancyLooksSolid,
	occupancyCellCount,
	occupancyIndex,
	triangleAabbVoxelCount,
	voxelLayoutFromAabb,
	voxelizeTriangles
} from './voxel-occupancy';

describe('voxel thicken', () => {
	it('dilates a single occupied cell so a thin rod survives the grid', () => {
		const layout = voxelLayoutFromAabb({ min: [0, 0, 0], max: [8, 8, 8] }, 8, 0);
		const occ = new Uint8Array(occupancyCellCount(layout));
		occ[occupancyIndex(layout, 4, 4, 4)] = 1;
		dilateOccupancy(occ, layout);
		expect(countOccupied(occ)).toBe(27);
	});
});

describe('conservative voxelization', () => {
	it('does not AABB-fill a thin triangle spanning many voxels', async () => {
		const layout = voxelLayoutFromAabb(
			{
				min: [0, 0, 0],
				max: [16, 16, 16]
			},
			16,
			0
		);
		expect(layout.nx).toBe(16);
		expect(layout.cell).toBe(1);

		const positions = new Float32Array([0.2, 0.2, 0.5, 14.8, 0.2, 0.5, 0.2, 14.8, 0.5]);
		const indices = new Uint32Array([0, 1, 2]);
		const occ = await voxelizeTriangles(positions, indices, layout);
		const occupied = countOccupied(occ);
		const aabbCount = triangleAabbVoxelCount(positions, 0, 3, 6, layout);

		expect(aabbCount).toBeGreaterThan(100);
		expect(occupied).toBeGreaterThan(20);
		expect(occupied).toBeLessThan(aabbCount * 0.72);
		expect(occ[occupancyIndex(layout, 14, 14, 0)] ?? 0).toBe(0);
		expect(occ[occupancyIndex(layout, 1, 1, 0)] ?? 0).toBe(1);
	});
});

describe('voxelSolve', () => {
	it('moves vertices off integer grid corners', () => {
		const mesh = createCrestGeometry(12);
		const box = aabbFromPositions(mesh.positions);
		const layout = voxelLayoutFromAabb(box, 50);
		const tree = buildBvh(mesh.positions, mesh.indices, mesh.normals, null);
		const ix = Math.round(layout.nx * 0.5);
		const iy = Math.round(layout.ny * 0.5);
		const iz = Math.round(layout.nz * 0.72);
		const positions = new Float32Array([
			layout.origin[0] + ix * layout.cell,
			layout.origin[1] + iy * layout.cell,
			layout.origin[2] + iz * layout.cell
		]);
		expect(countLatticeCorners(positions, layout)).toBe(1);
		const normals = new Float32Array([0, 1, 0]);
		const solved = solveVerticesToSurface(positions, normals, tree, layout.cell * 12);
		expect(countLatticeCorners(solved, layout)).toBe(0);
		const moved =
			Math.hypot(
				(solved[0] ?? 0) - positions[0],
				(solved[1] ?? 0) - positions[1],
				(solved[2] ?? 0) - positions[2]
			) > layout.cell * 0.05;
		expect(moved).toBe(true);
	});
});

describe('dual contour remesh', () => {
	it('does not emit a lattice-corner cube mesh', async () => {
		const mesh = createCrestGeometry(10);
		const layout = voxelLayoutFromAabb(aabbFromPositions(mesh.positions), 28);
		const occ = await voxelizeTriangles(mesh.positions, mesh.indices, layout);
		fillSolidFromSurface(occ, layout);
		const tree = buildBvh(mesh.positions, mesh.indices, mesh.normals, null);
		const extracted = await extractDualContour(occ, layout, {}, tree);
		expect(extracted.indices.length).toBeGreaterThan(36);
		const corners = countLatticeCorners(extracted.positions, layout);
		expect(corners / Math.max(1, extracted.positions.length / 3)).toBeLessThan(0.2);

		const remeshed = await remesh(mesh, 180, { voxelResolution: 28, voxelSolve: true });
		expect(countLatticeCorners(remeshed.positions, layout) / Math.max(1, remeshed.positions.length / 3)).toBeLessThan(
			0.05
		);
	});

	it('hits the triangle budget with rebuilt topology', async () => {
		const geometry = createCrestGeometry(16);
		const remeshed = await remesh(geometry, 220, { voxelResolution: 50, voxelSolve: true });
		expect(remeshed.indices.length).toBeGreaterThan(12);
		expect(remeshed.indices.length / 3).toBeLessThanOrEqual(220);
		expect(computeNormals(remeshed.positions, remeshed.indices).length).toBe(remeshed.positions.length);
	});

	it('keeps the source mesh when it is already under the triangle budget', async () => {
		const geometry = createCrestGeometry(28);
		const sourceTris = geometry.indices.length / 3;
		expect(sourceTris).toBeGreaterThan(2000);
		expect(sourceTris).toBeLessThan(6000);
		expect(shouldVoxelRemesh(sourceTris, 6000)).toBe(false);
		const remeshed = await remesh(geometry, 6000, { voxelResolution: 50, voxelSolve: true });
		expect(remeshed.positions).toBe(geometry.positions);
		expect(remeshed.indices).toBe(geometry.indices);
		expect(remeshed.indices.length / 3).toBe(sourceTris);
	});

	it('treats the triangle budget as a ceiling, not a fill-up target', () => {
		expect(remeshTriangleTarget(3456, 6000)).toBe(3456);
		expect(remeshTriangleTarget(12000, 6000)).toBe(6000);
		expect(remeshTriangleTarget(0, 6000)).toBe(6000);
		expect(shouldVoxelRemesh(3456, 6000)).toBe(false);
		expect(shouldVoxelRemesh(12000, 6000)).toBe(true);
	});
});

describe('dual contour QEF bounds', () => {
	it('keeps every vertex within one cell of its dual-cube center', async () => {
		const layout = voxelLayoutFromAabb({ min: [0, 0, 0], max: [16, 16, 16] }, 16, 0);
		const occ = new Uint8Array(layout.nx * layout.ny * layout.nz);
		for (let z = 0; z < layout.nz; z++) {
			for (let y = 0; y < layout.ny; y++) {
				for (let x = 0; x < layout.nx; x++) {
					if (z < 8) occ[occupancyIndex(layout, x, y, z)] = 1;
				}
			}
		}
		const extracted = await extractDualContour(occ, layout);
		expect(extracted.indices.length).toBeGreaterThan(36);
		expect(extracted.cells.length).toBe(extracted.positions.length);
		const center: [number, number, number] = [0, 0, 0];
		let outside = 0;
		for (let v = 0; v < extracted.positions.length / 3; v++) {
			const i = extracted.cells[v * 3] ?? 0;
			const j = extracted.cells[v * 3 + 1] ?? 0;
			const k = extracted.cells[v * 3 + 2] ?? 0;
			const minX = layout.origin[0] + (i + 0.5) * layout.cell;
			const minY = layout.origin[1] + (j + 0.5) * layout.cell;
			const minZ = layout.origin[2] + (k + 0.5) * layout.cell;
			const maxX = minX + layout.cell;
			const maxY = minY + layout.cell;
			const maxZ = minZ + layout.cell;
			const x = extracted.positions[v * 3] ?? 0;
			const y = extracted.positions[v * 3 + 1] ?? 0;
			const z = extracted.positions[v * 3 + 2] ?? 0;
			const pad = layout.cell * 1e-4;
			if (x < minX - pad || x > maxX + pad || y < minY - pad || y > maxY + pad || z < minZ - pad || z > maxZ + pad) {
				outside += 1;
			}
			dualCubeCenter(layout, i, j, k, center);
			const dist = Math.hypot(x - center[0], y - center[1], z - center[2]);
			expect(dist).toBeLessThanOrEqual(layout.cell * 1.01);
		}
		expect(outside).toBe(0);
	});

	it('clamps a QEF outlier into its dual cube', () => {
		const layout = voxelLayoutFromAabb({ min: [0, 0, 0], max: [16, 16, 16] }, 16, 0);
		const p: Vec3 = [100, -40, 8];
		clampToDualCube(layout, 4, 4, 4, p);
		const center: Vec3 = [0, 0, 0];
		dualCubeCenter(layout, 4, 4, 4, center);
		expect(Math.hypot(p[0] - center[0], p[1] - center[1], p[2] - center[2])).toBeLessThanOrEqual(
			layout.cell * 1.01
		);
		const minX = layout.origin[0] + (4 + 0.5) * layout.cell;
		expect(p[0]).toBeGreaterThanOrEqual(minX);
		expect(p[0]).toBeLessThanOrEqual(minX + layout.cell);
	});
});

describe('occupancy fillSolid', () => {
	it('treats a closed crest as solid and open foliage as a shell', async () => {
		const crest = createCrestGeometry(16);
		const crestLayout = voxelLayoutFromAabb(aabbFromPositions(crest.positions), 40);
		const crestOcc = await voxelizeTriangles(crest.positions, crest.indices, crestLayout);
		expect(occupancyLooksSolid(analyzeOccupancy(crestOcc, crestLayout))).toBe(true);

		const foliage = createFoliageSprigs();
		const foliageLayout = voxelLayoutFromAabb(aabbFromPositions(foliage.positions), 48);
		const foliageOcc = await voxelizeTriangles(foliage.positions, foliage.indices, foliageLayout);
		const foliageAnalysis = analyzeOccupancy(foliageOcc, foliageLayout);
		expect(foliageAnalysis.interior).toBeLessThan(foliageAnalysis.shell * 0.5);
		expect(occupancyLooksSolid(foliageAnalysis)).toBe(false);
	});

	it('does not paint a closed organic into the entire AABB', async () => {
		const mesh = createCrestGeometry(12);
		const layout = voxelLayoutFromAabb(aabbFromPositions(mesh.positions), 24);
		const occ = await voxelizeTriangles(mesh.positions, mesh.indices, layout);
		fillSolidFromSurface(occ, layout);
		const occupied = countOccupied(occ);
		const n = layout.nx * layout.ny * layout.nz;
		expect(occupied).toBeGreaterThan(20);
		expect(occupied).toBeLessThan(n * 0.92);
	});

	it('keeps a vase-shaped occupancy at 160³, not a handful of cells or an AABB fill', async () => {
		const mesh = createWavyVaseGeometry();
		const layout = voxelLayoutFromAabb(aabbFromPositions(mesh.positions), 160);
		const occ = await voxelizeTriangles(mesh.positions, mesh.indices, layout);
		fillSolidFromSurface(occ, layout);
		const occupied = countOccupied(occ);
		const n = layout.nx * layout.ny * layout.nz;
		expect(occupied).toBeGreaterThan(200);
		expect(occupied).toBeLessThan(n * 0.92);

		let minY = layout.ny;
		let maxY = 0;
		let midSlice = 0;
		const mid = Math.floor(layout.ny * 0.5);
		for (let z = 0; z < layout.nz; z++) {
			for (let y = 0; y < layout.ny; y++) {
				for (let x = 0; x < layout.nx; x++) {
					if (!occ[occupancyIndex(layout, x, y, z)]) continue;
					if (y < minY) minY = y;
					if (y > maxY) maxY = y;
					if (y === mid) midSlice += 1;
				}
			}
		}
		expect(maxY - minY).toBeGreaterThan(layout.ny * 0.4);
		expect(midSlice).toBeGreaterThan(8);
	});
});

describe('remesh surface metric', () => {
	it('rejects a spike that shares the vase AABB', () => {
		const vase = createWavyVaseGeometry();
		const layout = voxelLayoutFromAabb(aabbFromPositions(vase.positions), 160);
		const tree = buildBvh(vase.positions, vase.indices, vase.normals, null);
		const spike = createSpikeGeometry(aabbFromPositions(vase.positions));
		expect(remeshFollowsSource(vase, spike, tree, layout)).toBe(false);
		expect(maxVertexDistanceToMesh(spike.positions, tree)).toBeGreaterThan(remeshDistanceLimit(vase, layout));
	});

	it('rejects a chord whose vertices sit on the source but whose face cuts through', () => {
		const sphere = createCrestGeometry(16);
		const layout = voxelLayoutFromAabb(aabbFromPositions(sphere.positions), 50);
		const tree = buildBvh(sphere.positions, sphere.indices, sphere.normals, null);
		const chord = {
			positions: new Float32Array([1, 0, 0, -0.5, 0, Math.sqrt(3) / 2, -0.5, 0, -Math.sqrt(3) / 2]),
			indices: new Uint32Array([0, 1, 2]),
			normals: computeNormals(new Float32Array([1, 0, 0, -0.5, 0, Math.sqrt(3) / 2, -0.5, 0, -Math.sqrt(3) / 2]), new Uint32Array([0, 1, 2]))
		};
		expect(maxVertexDistanceToMesh(chord.positions, tree)).toBeLessThan(0.2);
		expect(maxTriangleCentroidDistanceToMesh(chord.positions, chord.indices, tree)).toBeGreaterThan(
			remeshDistanceLimit(sphere, layout)
		);
		expect(remeshFollowsSource(sphere, chord, tree, layout)).toBe(false);
	});

	it('keeps a 3456-tri vase under budget as the source mesh', async () => {
		const geometry = createWavyVaseGeometry();
		expect(geometry.indices.length / 3).toBe(3456);
		const remeshed = await remesh(geometry, 6000, { voxelResolution: 160, voxelSolve: true });
		expect(remeshed.positions).toBe(geometry.positions);
		expect(remeshed.indices).toBe(geometry.indices);
	});

	it('keeps foliage sprigs as separate islands instead of one dilated blob', async () => {
		const foliage = createFoliageSprigs();
		const sourceIslands = islandCount(foliage.indices, vertexCountOf(foliage.positions));
		expect(sourceIslands).toBeGreaterThan(40);
		const remeshed = await remesh(foliage, 800, { voxelResolution: 48, voxelSolve: true });
		expect(remeshed.indices.length / 3).toBeGreaterThan(40);
		expect(islandCount(remeshed.indices, vertexCountOf(remeshed.positions))).toBeGreaterThan(12);
	});

	it('voxel-remeshes a vase at 160³ onto the source surface, not a spike', async () => {
		const geometry = createWavyVaseGeometry();
		const layout = voxelLayoutFromAabb(aabbFromPositions(geometry.positions), 160);
		const occ = await voxelizeTriangles(geometry.positions, geometry.indices, layout);
		fillSolidFromSurface(occ, layout);
		const tree = buildBvh(geometry.positions, geometry.indices, geometry.normals, null);
		const extracted = await extractDualContour(occ, layout, {}, tree);
		expect(extracted.indices.length).toBeGreaterThan(36);
		const candidate = {
			positions: extracted.positions,
			indices: extracted.indices,
			normals: computeNormals(extracted.positions, extracted.indices)
		};
		expect(remeshFollowsSource(geometry, candidate, tree, layout)).toBe(true);
		expect(maxVertexDistanceToMesh(extracted.positions, tree)).toBeLessThanOrEqual(
			remeshDistanceLimit(geometry, layout)
		);
	});
});

function createFoliageSprigs(): {
	positions: Float32Array;
	indices: Uint32Array;
	normals: Float32Array;
} {
	const cols = 8;
	const rows = 8;
	const positions: number[] = [];
	const indices: number[] = [];
	let vertex = 0;
	for (let i = 0; i < rows * cols; i++) {
		const col = i % cols;
		const row = Math.floor(i / cols);
		const x = col * 0.09;
		const y = -row * 0.09;
		const z = (col % 2) * 0.08;
		const s = 0.04;
		positions.push(x, y, z, x + s, y, z, x + s, y + s, z, x, y + s, z);
		indices.push(vertex, vertex + 1, vertex + 2, vertex, vertex + 2, vertex + 3);
		vertex += 4;
	}
	const pos = Float32Array.from(positions);
	const idx = Uint32Array.from(indices);
	return { positions: pos, indices: idx, normals: computeNormals(pos, idx) };
}

function createSpikeGeometry(box: { min: Vec3; max: Vec3 }) {
	const cx = (box.min[0] + box.max[0]) * 0.5;
	const cz = (box.min[2] + box.max[2]) * 0.5;
	const apex: Vec3 = [cx, box.max[1], cz];
	const y0 = box.min[1];
	const rx = (box.max[0] - box.min[0]) * 0.12;
	const rz = (box.max[2] - box.min[2]) * 0.12;
	const segs = 12;
	const positions: number[] = [apex[0], apex[1], apex[2]];
	const indices: number[] = [];
	for (let i = 0; i < segs; i++) {
		const a = (i / segs) * Math.PI * 2;
		positions.push(cx + Math.cos(a) * rx, y0, cz + Math.sin(a) * rz);
	}
	for (let i = 0; i < segs; i++) {
		const b = 1 + i;
		const c = 1 + ((i + 1) % segs);
		indices.push(0, b, c);
	}
	const pos = Float32Array.from(positions);
	const idx = Uint32Array.from(indices);
	return { positions: pos, indices: idx, normals: computeNormals(pos, idx) };
}
