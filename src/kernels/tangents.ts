import { MeshoptTangents } from 'meshoptimizer';
import type { LowPolyMesh, MeshGeometry } from './types';

export async function generateTangents(
	mesh: MeshGeometry & { uvs: Float32Array }
): Promise<LowPolyMesh> {
	await MeshoptTangents.ready;
	const corners = MeshoptTangents.generateTangents(
		mesh.indices,
		mesh.positions,
		3,
		mesh.normals,
		3,
		mesh.uvs,
		2
	);

	const vertexCount = mesh.indices.length;
	const positions = new Float32Array(vertexCount * 3);
	const normals = new Float32Array(vertexCount * 3);
	const uvs = new Float32Array(vertexCount * 2);
	const tangents = new Float32Array(vertexCount * 4);
	const indices = new Uint32Array(vertexCount);

	for (let corner = 0; corner < vertexCount; corner++) {
		const src = mesh.indices[corner] ?? 0;
		positions[corner * 3] = mesh.positions[src * 3] ?? 0;
		positions[corner * 3 + 1] = mesh.positions[src * 3 + 1] ?? 0;
		positions[corner * 3 + 2] = mesh.positions[src * 3 + 2] ?? 0;
		normals[corner * 3] = mesh.normals[src * 3] ?? 0;
		normals[corner * 3 + 1] = mesh.normals[src * 3 + 1] ?? 0;
		normals[corner * 3 + 2] = mesh.normals[src * 3 + 2] ?? 0;
		uvs[corner * 2] = mesh.uvs[src * 2] ?? 0;
		uvs[corner * 2 + 1] = mesh.uvs[src * 2 + 1] ?? 0;
		tangents[corner * 4] = corners[corner * 4] ?? 1;
		tangents[corner * 4 + 1] = corners[corner * 4 + 1] ?? 0;
		tangents[corner * 4 + 2] = corners[corner * 4 + 2] ?? 0;
		tangents[corner * 4 + 3] = corners[corner * 4 + 3] ?? 1;
		indices[corner] = corner;
	}

	const welded = weldMatching(positions, normals, uvs, tangents, indices);
	return welded;
}

function weldMatching(
	positions: Float32Array,
	normals: Float32Array,
	uvs: Float32Array,
	tangents: Float32Array,
	indices: Uint32Array
): LowPolyMesh {
	const keyOf = (i: number) =>
		[
			positions[i * 3]?.toFixed(6),
			positions[i * 3 + 1]?.toFixed(6),
			positions[i * 3 + 2]?.toFixed(6),
			normals[i * 3]?.toFixed(5),
			normals[i * 3 + 1]?.toFixed(5),
			normals[i * 3 + 2]?.toFixed(5),
			uvs[i * 2]?.toFixed(6),
			uvs[i * 2 + 1]?.toFixed(6),
			tangents[i * 4 + 3]?.toFixed(3)
		].join('|');

	const remap = new Map<string, number>();
	const used: number[] = [];
	const newIndices = new Uint32Array(indices.length);
	for (let i = 0; i < indices.length; i++) {
		const old = indices[i] ?? 0;
		const key = keyOf(old);
		let next = remap.get(key);
		if (next === undefined) {
			next = used.length;
			remap.set(key, next);
			used.push(old);
		}
		newIndices[i] = next;
	}

	const newPositions = new Float32Array(used.length * 3);
	const newNormals = new Float32Array(used.length * 3);
	const newUvs = new Float32Array(used.length * 2);
	const newTangents = new Float32Array(used.length * 4);
	for (let i = 0; i < used.length; i++) {
		const src = used[i] ?? 0;
		newPositions[i * 3] = positions[src * 3] ?? 0;
		newPositions[i * 3 + 1] = positions[src * 3 + 1] ?? 0;
		newPositions[i * 3 + 2] = positions[src * 3 + 2] ?? 0;
		newNormals[i * 3] = normals[src * 3] ?? 0;
		newNormals[i * 3 + 1] = normals[src * 3 + 1] ?? 0;
		newNormals[i * 3 + 2] = normals[src * 3 + 2] ?? 0;
		newUvs[i * 2] = uvs[src * 2] ?? 0;
		newUvs[i * 2 + 1] = uvs[src * 2 + 1] ?? 0;
		newTangents[i * 4] = tangents[src * 4] ?? 1;
		newTangents[i * 4 + 1] = tangents[src * 4 + 1] ?? 0;
		newTangents[i * 4 + 2] = tangents[src * 4 + 2] ?? 0;
		newTangents[i * 4 + 3] = tangents[src * 4 + 3] ?? 1;
	}

	return {
		positions: newPositions,
		indices: newIndices,
		normals: newNormals,
		uvs: newUvs,
		tangents: newTangents
	};
}
