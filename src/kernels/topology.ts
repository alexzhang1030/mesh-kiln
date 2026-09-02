import {
	triangleCountOf,
	vertexCountOf,
	type GeometryTarget,
	type MeshGeometry,
	type TopologyMode
} from './types';

export type TopologyChoice = 'voxel' | 'surface' | 'authored';

export const DENSE_SCULPT_TRIANGLES = 100_000;
export const FRAGMENT_UNIQUE_POSITION_RATIO = 0.97;
export const FRAGMENT_SHARED_EDGE_RATIO = 0.65;
export const FRAGMENT_VOXEL_TRIANGLES = 10_000;
/** Authored QEM keeps source UVs. Below this keep-ratio those UVs mosaic. */
export const AUTHORED_KEEP_RATIO = 0.5;

export type TopologyHints = {
	triangleBudget?: number;
	geometryTarget?: GeometryTarget;
};

export function isTriangleSoup(positions: Float32Array, indices: Uint32Array): boolean {
	const triangles = triangleCountOf(indices);
	const vertices = vertexCountOf(positions);
	if (triangles <= 0) return false;
	return vertices >= triangles * 2.5;
}

export function uniquePositionRatio(positions: Float32Array): number {
	const vertices = vertexCountOf(positions);
	if (vertices <= 0) return 1;
	const seen = new Set<string>();
	for (let vertex = 0; vertex < vertices; vertex++) {
		const x = positions[vertex * 3] ?? 0;
		const y = positions[vertex * 3 + 1] ?? 0;
		const z = positions[vertex * 3 + 2] ?? 0;
		seen.add(`${x}:${y}:${z}`);
	}
	return seen.size / vertices;
}

export function sharedEdgeRatio(indices: Uint32Array): number {
	const faces = triangleCountOf(indices);
	if (faces <= 0) return 0;
	const counts = new Map<number, number>();
	const bump = (a: number, b: number) => {
		const min = a < b ? a : b;
		const max = a < b ? b : a;
		const key = min * 0x1000000 + max;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	};
	for (let face = 0; face < faces; face++) {
		const a = indices[face * 3] ?? 0;
		const b = indices[face * 3 + 1] ?? 0;
		const c = indices[face * 3 + 2] ?? 0;
		bump(a, b);
		bump(b, c);
		bump(c, a);
	}
	let shared = 0;
	for (const count of counts.values()) {
		if (count >= 2) shared++;
	}
	return shared / Math.max(1, counts.size);
}

/**
 * Open reconstruction meshes: unique positions, few shared edges.
 * Seam-welded QEM shreds them; voxel remesh rebuilds a surface.
 * Closed sculpts with UV splits stay on the surface path.
 */
export function isFragmentedSurface(positions: Float32Array, indices: Uint32Array): boolean {
	if (triangleCountOf(indices) <= 0) return false;
	if (uniquePositionRatio(positions) < FRAGMENT_UNIQUE_POSITION_RATIO) return false;
	return sharedEdgeRatio(indices) < FRAGMENT_SHARED_EDGE_RATIO;
}

export function resolveTopologyMode(
	mode: TopologyMode,
	sourceTriangleCount: number,
	soup: boolean,
	fragmented = false,
	hints: TopologyHints = {}
): TopologyChoice {
	switch (mode) {
		case 'voxel':
			return 'voxel';
		case 'authored':
			return 'authored';
		case 'auto':
			if (fragmented && sourceTriangleCount >= FRAGMENT_VOXEL_TRIANGLES) return 'voxel';
			if (sourceTriangleCount >= DENSE_SCULPT_TRIANGLES || soup) return 'surface';
			if (authoredKeepsSourceMaps(sourceTriangleCount, hints)) return 'authored';
			return 'surface';
		default: {
			const exhausted: never = mode;
			return exhausted;
		}
	}
}

export function resolveTopologyForMesh(
	mode: TopologyMode,
	mesh: MeshGeometry,
	hints: TopologyHints = {}
): TopologyChoice {
	return resolveTopologyMode(
		mode,
		triangleCountOf(mesh.indices),
		isTriangleSoup(mesh.positions, mesh.indices),
		isFragmentedSurface(mesh.positions, mesh.indices),
		hints
	);
}

function authoredKeepsSourceMaps(sourceTriangleCount: number, hints: TopologyHints): boolean {
	if (hints.geometryTarget === 'error') return true;
	const budget = hints.triangleBudget;
	if (budget == null || sourceTriangleCount <= 0) return true;
	return budget >= sourceTriangleCount * AUTHORED_KEEP_RATIO;
}

export function topologyChoiceLabel(choice: TopologyChoice): string {
	switch (choice) {
		case 'voxel':
			return 'Voxel remesh';
		case 'surface':
			return 'Seam-welded surface';
		case 'authored':
			return 'Authored QEM';
		default: {
			const exhausted: never = choice;
			return exhausted;
		}
	}
}
