import type { MeshGeometry } from './types';
import { vertexCountOf } from './types';

type UvMesh = MeshGeometry & { uvs: Float32Array };

export function computeSourceTangents(mesh: UvMesh): Float32Array {
	const vertices = vertexCountOf(mesh.positions);
	const tangentSum = new Float32Array(vertices * 3);
	const bitangentSum = new Float32Array(vertices * 3);
	const accumulate = (
		vertex: number,
		tx: number,
		ty: number,
		tz: number,
		bx: number,
		by: number,
		bz: number
	) => {
		tangentSum[vertex * 3] = (tangentSum[vertex * 3] ?? 0) + tx;
		tangentSum[vertex * 3 + 1] = (tangentSum[vertex * 3 + 1] ?? 0) + ty;
		tangentSum[vertex * 3 + 2] = (tangentSum[vertex * 3 + 2] ?? 0) + tz;
		bitangentSum[vertex * 3] = (bitangentSum[vertex * 3] ?? 0) + bx;
		bitangentSum[vertex * 3 + 1] = (bitangentSum[vertex * 3 + 1] ?? 0) + by;
		bitangentSum[vertex * 3 + 2] = (bitangentSum[vertex * 3 + 2] ?? 0) + bz;
	};

	for (let index = 0; index + 2 < mesh.indices.length; index += 3) {
		const a = mesh.indices[index] ?? 0;
		const b = mesh.indices[index + 1] ?? 0;
		const c = mesh.indices[index + 2] ?? 0;
		const ax = mesh.positions[a * 3] ?? 0;
		const ay = mesh.positions[a * 3 + 1] ?? 0;
		const az = mesh.positions[a * 3 + 2] ?? 0;
		const e1x = (mesh.positions[b * 3] ?? 0) - ax;
		const e1y = (mesh.positions[b * 3 + 1] ?? 0) - ay;
		const e1z = (mesh.positions[b * 3 + 2] ?? 0) - az;
		const e2x = (mesh.positions[c * 3] ?? 0) - ax;
		const e2y = (mesh.positions[c * 3 + 1] ?? 0) - ay;
		const e2z = (mesh.positions[c * 3 + 2] ?? 0) - az;
		const au = mesh.uvs[a * 2] ?? 0;
		const av = mesh.uvs[a * 2 + 1] ?? 0;
		const du1 = (mesh.uvs[b * 2] ?? 0) - au;
		const dv1 = (mesh.uvs[b * 2 + 1] ?? 0) - av;
		const du2 = (mesh.uvs[c * 2] ?? 0) - au;
		const dv2 = (mesh.uvs[c * 2 + 1] ?? 0) - av;
		const determinant = du1 * dv2 - dv1 * du2;
		if (Math.abs(determinant) < 1e-12) continue;
		const inverse = 1 / determinant;
		const tx = (e1x * dv2 - e2x * dv1) * inverse;
		const ty = (e1y * dv2 - e2y * dv1) * inverse;
		const tz = (e1z * dv2 - e2z * dv1) * inverse;
		const bx = (e2x * du1 - e1x * du2) * inverse;
		const by = (e2y * du1 - e1y * du2) * inverse;
		const bz = (e2z * du1 - e1z * du2) * inverse;
		accumulate(a, tx, ty, tz, bx, by, bz);
		accumulate(b, tx, ty, tz, bx, by, bz);
		accumulate(c, tx, ty, tz, bx, by, bz);
	}

	const tangents = new Float32Array(vertices * 4);
	for (let vertex = 0; vertex < vertices; vertex++) {
		const nx = mesh.normals[vertex * 3] ?? 0;
		const ny = mesh.normals[vertex * 3 + 1] ?? 0;
		const nz = mesh.normals[vertex * 3 + 2] ?? 1;
		const dot =
			nx * (tangentSum[vertex * 3] ?? 0) +
			ny * (tangentSum[vertex * 3 + 1] ?? 0) +
			nz * (tangentSum[vertex * 3 + 2] ?? 0);
		let tx = (tangentSum[vertex * 3] ?? 0) - nx * dot;
		let ty = (tangentSum[vertex * 3 + 1] ?? 0) - ny * dot;
		let tz = (tangentSum[vertex * 3 + 2] ?? 0) - nz * dot;
		let length = Math.hypot(tx, ty, tz);
		if (length < 1e-10) {
			if (Math.abs(nz) < 0.9) {
				tx = -ny;
				ty = nx;
				tz = 0;
			} else {
				tx = 1;
				ty = 0;
				tz = 0;
			}
			length = Math.hypot(tx, ty, tz);
		}
		tx /= length;
		ty /= length;
		tz /= length;
		const crossX = ny * tz - nz * ty;
		const crossY = nz * tx - nx * tz;
		const crossZ = nx * ty - ny * tx;
		const handedness =
			crossX * (bitangentSum[vertex * 3] ?? 0) +
				crossY * (bitangentSum[vertex * 3 + 1] ?? 0) +
				crossZ * (bitangentSum[vertex * 3 + 2] ?? 0) <
			0
				? -1
				: 1;
		tangents[vertex * 4] = tx;
		tangents[vertex * 4 + 1] = ty;
		tangents[vertex * 4 + 2] = tz;
		tangents[vertex * 4 + 3] = handedness;
	}
	return tangents;
}
