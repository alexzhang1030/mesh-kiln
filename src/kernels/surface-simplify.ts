import { filterDegenerateTriangles } from './compact';
import { computeNormals } from './normals';
import { simplify, type SimplifyOptions } from './simplify';
import type { MeshGeometry } from './types';
import { vertexCountOf } from './types';

/**
 * Rejoins exact position duplicates introduced by UV seams and split normals.
 * Material attributes are baked onto a fresh atlas after simplification.
 */
export function weldPositionSeams(mesh: MeshGeometry): MeshGeometry {
	const sourceVertices = vertexCountOf(mesh.positions);
	const remap = new Uint32Array(sourceVertices);
	const byPosition = new Map<string, number>();
	const positions: number[] = [];

	for (let vertex = 0; vertex < sourceVertices; vertex++) {
		const x = mesh.positions[vertex * 3] ?? 0;
		const y = mesh.positions[vertex * 3 + 1] ?? 0;
		const z = mesh.positions[vertex * 3 + 2] ?? 0;
		const key = `${x}:${y}:${z}`;
		let welded = byPosition.get(key);
		if (welded === undefined) {
			welded = positions.length / 3;
			byPosition.set(key, welded);
			positions.push(x, y, z);
		}
		remap[vertex] = welded;
	}

	const weldedPositions = Float32Array.from(positions);
	const weldedIndices = Uint32Array.from(mesh.indices, (index) => remap[index] ?? 0);
	return filterDegenerateTriangles({
		positions: weldedPositions,
		indices: weldedIndices,
		normals: computeNormals(weldedPositions, weldedIndices)
	});
}

export async function simplifySurface(
	mesh: MeshGeometry,
	targetTriangles: number,
	options?: SimplifyOptions
): Promise<MeshGeometry> {
	return simplify(weldPositionSeams(mesh), targetTriangles, options);
}
