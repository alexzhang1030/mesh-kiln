import { readVec3, vec3Add, vec3Create, vec3Cross, vec3Normalize, vec3Sub, writeVec3 } from './math';
import type { MeshGeometry } from './types';

export function computeNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
	const normals = new Float32Array(positions.length);
	const a = vec3Create();
	const b = vec3Create();
	const c = vec3Create();
	const e1 = vec3Create();
	const e2 = vec3Create();
	const n = vec3Create();
	const acc = vec3Create();

	for (let i = 0; i + 2 < indices.length; i += 3) {
		const ia = indices[i] ?? 0;
		const ib = indices[i + 1] ?? 0;
		const ic = indices[i + 2] ?? 0;
		readVec3(positions, ia, a);
		readVec3(positions, ib, b);
		readVec3(positions, ic, c);
		vec3Sub(b, a, e1);
		vec3Sub(c, a, e2);
		vec3Cross(e1, e2, n);
		for (const index of [ia, ib, ic]) {
			readVec3(normals, index, acc);
			vec3Add(acc, n, acc);
			writeVec3(normals, index, acc);
		}
	}

	const vertexCount = Math.floor(positions.length / 3);
	for (let i = 0; i < vertexCount; i++) {
		readVec3(normals, i, acc);
		vec3Normalize(acc, acc);
		writeVec3(normals, i, acc);
	}
	return normals;
}

export function withComputedNormals(mesh: Omit<MeshGeometry, 'normals'>): MeshGeometry {
	return {
		positions: mesh.positions,
		indices: mesh.indices,
		normals: computeNormals(mesh.positions, mesh.indices)
	};
}
