import { compactGeometry, filterDegenerateTriangles } from './compact';
import { nowMs, yieldToEventLoop } from './cooperative';
import { closestPointToPoint, raycastFirst, type MeshBvh, buildBvh } from './bvh';
import { clampToDualCube, extractDualContour } from './dual-contour';
import {
	aabbDiagonal,
	aabbFromPositions,
	meanEdgeLength,
	readVec3,
	vec3Create,
	vec3Normalize,
	writeVec3,
	type Aabb
} from './math';
import { computeNormals } from './normals';
import { simplify } from './simplify';
import type { MeshGeometry } from './types';
import { triangleCountOf, vertexCountOf } from './types';
import {
	analyzeOccupancy,
	countOccupied,
	dilateOccupancy,
	fillSolidFromSurface,
	occupancyLooksSolid,
	voxelLayoutFromAabb,
	voxelizeTriangles,
	type VoxelLayout
} from './voxel-occupancy';

export type RemeshOptions = {
	voxelResolution?: number;
	voxelSolve?: boolean;
	voxelDilate?: boolean;
	targetError?: number;
	onProgress?: (value: number) => void;
	isCancelled?: () => boolean;
};

export const REMESH_YIELD_INTERVAL_MS = 250;

/**
 * Voxel remesh. meshoptimizer 1.2.0 has no remesh API, so Kiln voxelizes with
 * conservative triangle tests, dual-contours the occupancy field (QEF),
 * optionally snaps vertices to the source, then QEM-collapses to a triangle
 * ceiling. Resolution is cells along the longest AABB axis.
 *
 * Dilate + interior fill run only when occupancy encloses a real volume
 * (watertight sculpts). Open reconstructions keep the voxelized shell so
 * nearby leaves do not fuse. QEM on that shell does not prune islands.
 *
 * Voxel rebuild runs only when the source is over the triangle budget. A clean
 * 3k mesh with budget 6000 keeps that mesh; the voxel bake path still builds a
 * new atlas onto it. Over budget, QEM targets the budget. A remesh that leaves
 * the source surface (max BVH distance, axis extents) is discarded in favor of
 * authored QEM. Authored QEM on a clean model copies source maps instead of
 * unwrapping.
 */
export async function remesh(
	mesh: MeshGeometry,
	triangleBudget: number,
	options: RemeshOptions = {}
): Promise<MeshGeometry> {
	const sourceCount = triangleCountOf(mesh.indices);
	const target = remeshTriangleTarget(sourceCount, triangleBudget);
	if (sourceCount > 0 && sourceCount <= target) {
		options.onProgress?.(1);
		return mesh;
	}

	const box = aabbFromPositions(mesh.positions);
	const diagonal = aabbDiagonal(box);
	if (!Number.isFinite(diagonal) || diagonal <= 1e-8) {
		throw new Error('Mesh bounding box is empty; cannot remesh.');
	}

	const resolution = remeshResolution(options.voxelResolution);
	const voxelSolve = options.voxelSolve ?? true;
	const layout = voxelLayoutFromAabb(box, resolution);
	const coop = createCoop(options);

	coop.progress(0.02);
	const occupancy = await voxelizeTriangles(mesh.positions, mesh.indices, layout, {
		isCancelled: coop.isCancelled,
		maybeYield: coop.maybeYield,
		onProgress: (value) => coop.progress(0.02 + value * 0.28)
	});
	coop.assertRunning();

	const solid = occupancyLooksSolid(analyzeOccupancy(occupancy, layout));
	const voxelDilate = (options.voxelDilate ?? true) && solid;
	const extraCells = voxelDilate ? 2 : 0;
	if (voxelDilate) dilateOccupancy(occupancy, layout);
	if (countOccupied(occupancy) < 8) {
		coop.progress(1);
		return simplify(mesh, target);
	}
	if (solid) fillSolidFromSurface(occupancy, layout);
	coop.progress(0.34);
	await coop.maybeYield();
	coop.assertRunning();

	const tree = buildBvh(mesh.positions, mesh.indices, mesh.normals, null);
	const extracted = await extractDualContour(
		occupancy,
		layout,
		{
			isCancelled: coop.isCancelled,
			maybeYield: coop.maybeYield,
			onProgress: (value) => coop.progress(0.34 + value * 0.36)
		},
		tree
	);
	if (extracted.indices.length < 12) {
		coop.progress(1);
		return simplify(mesh, target);
	}

	const compacted = compactGeometry(extracted.positions, extracted.indices, [
		{ src: intCellsToFloat(extracted.cells), stride: 3 }
	]);
	const cellCoords = compacted.extras[0];
	clampPositionsToDualCubes(compacted.positions, cellCoords, layout);

	let geometry: MeshGeometry = filterDegenerateTriangles({
		positions: compacted.positions,
		indices: compacted.indices,
		normals: computeNormals(compacted.positions, compacted.indices)
	});

	if (voxelSolve) {
		geometry = {
			positions: solveVerticesToSurface(
				geometry.positions,
				geometry.normals,
				tree,
				layout.cell * (voxelDilate ? 4 : 1)
			),
			indices: geometry.indices,
			normals: geometry.normals
		};
		// Dilated cubes sit outside the source. Clamping after the snap pulls
		// vertices off the surface again.
		if (!voxelDilate) clampPositionsToDualCubes(geometry.positions, cellCoords, layout);
		geometry = filterDegenerateTriangles({
			positions: geometry.positions,
			indices: geometry.indices,
			normals: computeNormals(geometry.positions, geometry.indices)
		});
	}

	if (!remeshFollowsSource(mesh, geometry, tree, layout, { extraCells })) {
		coop.progress(1);
		return simplify(mesh, target);
	}

	coop.progress(0.82);
	await coop.maybeYield();
	coop.assertRunning();

	if (triangleCountOf(geometry.indices) > target || options.targetError != null) {
		geometry = await simplify(geometry, target, { prune: solid, targetError: options.targetError });
	}
	if (!remeshFollowsSource(mesh, geometry, tree, layout, { extraCells, checkCentroids: false })) {
		return simplify(mesh, target);
	}
	if (solid && triangleCountOf(geometry.indices) > target) {
		geometry = await simplify(geometry, target);
	}
	coop.progress(1);
	return geometry;
}

/** Ceiling: never above the source count, never above the user budget. */
export function remeshTriangleTarget(sourceTriangleCount: number, triangleBudget: number): number {
	const budget = Math.max(4, Math.floor(triangleBudget));
	const source = Math.max(0, Math.floor(sourceTriangleCount));
	if (source === 0) return budget;
	return Math.min(budget, source);
}

/** Voxel rebuild is for meshes over the budget, not a clean model already under it. */
export function shouldVoxelRemesh(sourceTriangleCount: number, triangleBudget: number): boolean {
	const source = Math.max(0, Math.floor(sourceTriangleCount));
	return source > remeshTriangleTarget(source, triangleBudget);
}

export function remeshDistanceLimit(source: MeshGeometry, layout: VoxelLayout, extraCells = 0): number {
	const edge = meanEdgeLength(source.positions, source.indices);
	const cells = 2 + Math.max(0, extraCells);
	return cells * Math.max(layout.cell, edge);
}

export function maxVertexDistanceToMesh(positions: Float32Array, tree: MeshBvh): number {
	const vertexCount = vertexCountOf(positions);
	if (vertexCount === 0) return Infinity;
	const p = vec3Create();
	let max = 0;
	for (let i = 0; i < vertexCount; i++) {
		readVec3(positions, i, p);
		const closest = closestPointToPoint(tree, p);
		if (!closest) return Infinity;
		const dist = Math.hypot(closest.point[0] - p[0], closest.point[1] - p[1], closest.point[2] - p[2]);
		if (dist > max) max = dist;
	}
	return max;
}

export function remeshFollowsSource(
	source: MeshGeometry,
	candidate: MeshGeometry,
	tree: MeshBvh,
	layout: VoxelLayout,
	options: { extraCells?: number; checkCentroids?: boolean } = {}
): boolean {
	if (triangleCountOf(candidate.indices) < 12) return false;
	if (!extentsWithin(aabbFromPositions(source.positions), aabbFromPositions(candidate.positions), 0.15)) {
		return false;
	}
	const extraCells = options.extraCells ?? 0;
	const checkCentroids = options.checkCentroids ?? true;
	const limit = remeshDistanceLimit(source, layout, extraCells);
	if (maxVertexDistanceToMesh(candidate.positions, tree) > limit) return false;
	if (!checkCentroids) return true;
	return maxTriangleCentroidDistanceToMesh(candidate.positions, candidate.indices, tree) <= limit;
}

export function maxTriangleCentroidDistanceToMesh(
	positions: Float32Array,
	indices: Uint32Array,
	tree: MeshBvh
): number {
	if (indices.length < 3) return Infinity;
	const p = vec3Create();
	let max = 0;
	for (let i = 0; i + 2 < indices.length; i += 3) {
		const ia = (indices[i] ?? 0) * 3;
		const ib = (indices[i + 1] ?? 0) * 3;
		const ic = (indices[i + 2] ?? 0) * 3;
		p[0] = ((positions[ia] ?? 0) + (positions[ib] ?? 0) + (positions[ic] ?? 0)) / 3;
		p[1] = ((positions[ia + 1] ?? 0) + (positions[ib + 1] ?? 0) + (positions[ic + 1] ?? 0)) / 3;
		p[2] = ((positions[ia + 2] ?? 0) + (positions[ib + 2] ?? 0) + (positions[ic + 2] ?? 0)) / 3;
		const closest = closestPointToPoint(tree, p);
		if (!closest) return Infinity;
		const dist = Math.hypot(closest.point[0] - p[0], closest.point[1] - p[1], closest.point[2] - p[2]);
		if (dist > max) max = dist;
	}
	return max;
}

export function solveVerticesToSurface(
	positions: Float32Array,
	normals: Float32Array,
	tree: MeshBvh,
	maxDistance: number
): Float32Array {
	const out = new Float32Array(positions.length);
	const vertexCount = vertexCountOf(positions);
	const p = vec3Create();
	const n = vec3Create();
	const inward = vec3Create();
	const outward = vec3Create();
	const inwardDir = vec3Create();
	for (let i = 0; i < vertexCount; i++) {
		readVec3(positions, i, p);
		readVec3(normals, i, n);
		vec3Normalize(n, n);
		const offset = Math.max(maxDistance * 0.15, 1e-6);
		inward[0] = p[0] + n[0] * offset;
		inward[1] = p[1] + n[1] * offset;
		inward[2] = p[2] + n[2] * offset;
		inwardDir[0] = -n[0];
		inwardDir[1] = -n[1];
		inwardDir[2] = -n[2];
		let hit = raycastFirst(tree, inward, inwardDir, maxDistance);
		if (!hit) {
			outward[0] = p[0] - n[0] * offset;
			outward[1] = p[1] - n[1] * offset;
			outward[2] = p[2] - n[2] * offset;
			hit = raycastFirst(tree, outward, n, maxDistance);
		}
		if (hit) {
			writeVec3(out, i, hit.point);
			continue;
		}
		const closest = closestPointToPoint(tree, p);
		if (closest) {
			const dist = Math.hypot(closest.point[0] - p[0], closest.point[1] - p[1], closest.point[2] - p[2]);
			if (dist <= maxDistance) writeVec3(out, i, closest.point);
			else writeVec3(out, i, p);
		} else writeVec3(out, i, p);
	}
	return out;
}

export function countLatticeCorners(positions: Float32Array, layout: VoxelLayout, epsilon = 1e-4): number {
	let n = 0;
	const inv = 1 / layout.cell;
	for (let i = 0; i + 2 < positions.length; i += 3) {
		const tx = ((positions[i] ?? 0) - layout.origin[0]) * inv;
		const ty = ((positions[i + 1] ?? 0) - layout.origin[1]) * inv;
		const tz = ((positions[i + 2] ?? 0) - layout.origin[2]) * inv;
		if (
			Math.abs(tx - Math.round(tx)) <= epsilon &&
			Math.abs(ty - Math.round(ty)) <= epsilon &&
			Math.abs(tz - Math.round(tz)) <= epsilon
		) {
			n++;
		}
	}
	return n;
}

function createCoop(options: RemeshOptions): {
	isCancelled: () => boolean;
	progress: (value: number) => void;
	maybeYield: () => Promise<void>;
	assertRunning: () => void;
} {
	let last = nowMs();
	const isCancelled = options.isCancelled ?? (() => false);
	return {
		isCancelled,
		progress: options.onProgress ?? (() => undefined),
		async maybeYield() {
			const t = nowMs();
			if (t - last >= REMESH_YIELD_INTERVAL_MS) {
				await yieldToEventLoop();
				last = nowMs();
			}
		},
		assertRunning() {
			if (isCancelled()) throw new Error('cancelled');
		}
	};
}

function remeshResolution(value: number | undefined): number {
	if (value !== undefined && Number.isFinite(value)) {
		return Math.max(8, Math.min(512, Math.floor(value)));
	}
	return 160;
}

function extentsWithin(source: Aabb, candidate: Aabb, fraction: number): boolean {
	const axes: Array<0 | 1 | 2> = [0, 1, 2];
	for (const axis of axes) {
		const sourceExtent = source.max[axis] - source.min[axis];
		const candidateExtent = candidate.max[axis] - candidate.min[axis];
		if (sourceExtent <= 1e-8) {
			if (candidateExtent > 1e-6) return false;
			continue;
		}
		const ratio = candidateExtent / sourceExtent;
		if (ratio > 1 + fraction || ratio < 1 - fraction) return false;
	}
	return true;
}

function clampPositionsToDualCubes(
	positions: Float32Array,
	cellCoords: Float32Array | null,
	layout: VoxelLayout
): void {
	if (!cellCoords) return;
	const p = vec3Create();
	const vertexCount = vertexCountOf(positions);
	for (let i = 0; i < vertexCount; i++) {
		readVec3(positions, i, p);
		clampToDualCube(
			layout,
			Math.round(cellCoords[i * 3] ?? 0),
			Math.round(cellCoords[i * 3 + 1] ?? 0),
			Math.round(cellCoords[i * 3 + 2] ?? 0),
			p
		);
		writeVec3(positions, i, p);
	}
}

function intCellsToFloat(cells: Int32Array): Float32Array {
	const out = new Float32Array(cells.length);
	for (let i = 0; i < cells.length; i++) out[i] = cells[i] ?? 0;
	return out;
}
