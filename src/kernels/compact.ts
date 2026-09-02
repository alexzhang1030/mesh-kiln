import type { MeshGeometry } from './types';

export function compactGeometry(
	positions: Float32Array,
	indices: Uint32Array,
	extras: Array<{ src: Float32Array; stride: number } | null> = []
): { positions: Float32Array; indices: Uint32Array; extras: Array<Float32Array | null> } {
	const remap = new Map<number, number>();
	const newIndices = new Uint32Array(indices.length);
	const used: number[] = [];

	for (let i = 0; i < indices.length; i++) {
		const oldIndex = indices[i] ?? 0;
		let next = remap.get(oldIndex);
		if (next === undefined) {
			next = used.length;
			remap.set(oldIndex, next);
			used.push(oldIndex);
		}
		newIndices[i] = next;
	}

	const newPositions = new Float32Array(used.length * 3);
	for (let i = 0; i < used.length; i++) {
		const src = (used[i] ?? 0) * 3;
		const dst = i * 3;
		newPositions[dst] = positions[src] ?? 0;
		newPositions[dst + 1] = positions[src + 1] ?? 0;
		newPositions[dst + 2] = positions[src + 2] ?? 0;
	}

	const gathered = extras.map((extra) => {
		if (!extra) return null;
		const dest = new Float32Array(used.length * extra.stride);
		for (let i = 0; i < used.length; i++) {
			const srcBase = (used[i] ?? 0) * extra.stride;
			const dstBase = i * extra.stride;
			for (let c = 0; c < extra.stride; c++) {
				dest[dstBase + c] = extra.src[srcBase + c] ?? 0;
			}
		}
		return dest;
	});

	return { positions: newPositions, indices: newIndices, extras: gathered };
}

export function filterDegenerateTriangles(mesh: MeshGeometry): MeshGeometry {
	const kept: number[] = [];
	for (let i = 0; i + 2 < mesh.indices.length; i += 3) {
		const a = mesh.indices[i] ?? 0;
		const b = mesh.indices[i + 1] ?? 0;
		const c = mesh.indices[i + 2] ?? 0;
		if (a === b || b === c || c === a) continue;
		const ax = mesh.positions[a * 3] ?? 0;
		const ay = mesh.positions[a * 3 + 1] ?? 0;
		const az = mesh.positions[a * 3 + 2] ?? 0;
		const bx = mesh.positions[b * 3] ?? 0;
		const by = mesh.positions[b * 3 + 1] ?? 0;
		const bz = mesh.positions[b * 3 + 2] ?? 0;
		const cx = mesh.positions[c * 3] ?? 0;
		const cy = mesh.positions[c * 3 + 1] ?? 0;
		const cz = mesh.positions[c * 3 + 2] ?? 0;
		const e1x = bx - ax;
		const e1y = by - ay;
		const e1z = bz - az;
		const e2x = cx - ax;
		const e2y = cy - ay;
		const e2z = cz - az;
		const nx = e1y * e2z - e1z * e2y;
		const ny = e1z * e2x - e1x * e2z;
		const nz = e1x * e2y - e1y * e2x;
		if (nx * nx + ny * ny + nz * nz < 1e-20) continue;
		kept.push(a, b, c);
	}
	return {
		positions: mesh.positions,
		normals: mesh.normals,
		indices: Uint32Array.from(kept)
	};
}
