import { MeshoptSimplifier, type SimplifierFlags } from 'meshoptimizer';
import { compactGeometry, filterDegenerateTriangles } from './compact';
import { computeNormals } from './normals';
import type { MeshGeometry, SourceMesh } from './types';
import { triangleCountOf, vertexCountOf } from './types';

export type SimplifyOptions = {
	prune?: boolean;
	targetError?: number;
};

export async function simplify(
	mesh: MeshGeometry,
	targetTriangles: number,
	options: SimplifyOptions = {}
): Promise<MeshGeometry> {
	await MeshoptSimplifier.ready;
	const current = triangleCountOf(mesh.indices);
	const target = Math.max(4, Math.min(current, Math.floor(targetTriangles)));
	if (options.targetError == null && current <= target) {
		return filterDegenerateTriangles({
			...mesh,
			normals: mesh.normals.length === mesh.positions.length ? mesh.normals : computeNormals(mesh.positions, mesh.indices)
		});
	}

	const errorLimit = options.targetError;
	const targetIndices = errorLimit != null ? 12 : target * 3;
	const allowPrune = options.prune !== false && errorLimit == null;
	const firstError = errorLimit ?? 1e-2;
	let [reduced] = MeshoptSimplifier.simplify(mesh.indices, mesh.positions, 3, targetIndices, firstError, ['LockBorder']);

	if (reduced.length > targetIndices) {
		[reduced] = MeshoptSimplifier.simplify(
			mesh.indices,
			mesh.positions,
			3,
			targetIndices,
			errorLimit ?? 0.2,
			['LockBorder']
		);
	}

	if (reduced.length > targetIndices) {
		[reduced] = MeshoptSimplifier.simplify(
			mesh.indices,
			mesh.positions,
			3,
			targetIndices,
			errorLimit ?? 1,
			['Permissive']
		);
	}

	if (allowPrune && (reduced.length === 0 || reduced.length > targetIndices)) {
		[reduced] = MeshoptSimplifier.simplify(mesh.indices, mesh.positions, 3, targetIndices, 1, ['Prune', 'Permissive']);
	}

	if (reduced.length === 0) {
		return filterDegenerateTriangles({
			...mesh,
			normals: mesh.normals.length === mesh.positions.length ? mesh.normals : computeNormals(mesh.positions, mesh.indices)
		});
	}

	const compacted = compactGeometry(mesh.positions, reduced, [{ src: mesh.normals, stride: 3 }]);
	const positions = compacted.positions;
	const indices = compacted.indices;
	const geometry: MeshGeometry = {
		positions,
		indices,
		normals: computeNormals(positions, indices)
	};
	return filterDegenerateTriangles(geometry);
}

/**
 * Authored QEM. Keeps the source vertex buffer's UVs, colors, and material
 * table. Does not interpolate attributes (no simplifyWithUpdate) and does not
 * use Permissive, which would collapse across UV seams.
 */
export async function simplifyAuthored(
	source: SourceMesh,
	targetTriangles: number,
	options: SimplifyOptions = {}
): Promise<SourceMesh> {
	await MeshoptSimplifier.ready;
	const normals =
		source.normals.length === source.positions.length
			? source.normals
			: computeNormals(source.positions, source.indices);
	const current = triangleCountOf(source.indices);
	const errorLimit = options.targetError;
	const target = errorLimit != null ? 4 : Math.max(4, Math.min(current, Math.floor(targetTriangles)));
	const prepared: SourceMesh = { ...source, normals };
	if (errorLimit == null && current <= target) return filterAuthored(prepared);

	const packed = packVertexAttributes(prepared);
	const reduced = reduceAuthoredIndices(
		prepared.indices,
		prepared.positions,
		packed,
		target * 3,
		errorLimit
	);
	if (reduced.length === 0) return filterAuthored(prepared);

	const triangleMaterials = remapTriangleMaterials(
		prepared.indices,
		prepared.triangleMaterials,
		reduced,
		vertexCountOf(prepared.positions)
	);
	const compacted = compactGeometry(prepared.positions, reduced, [
		{ src: normals, stride: 3 },
		prepared.uvs ? { src: prepared.uvs, stride: 2 } : null,
		prepared.colors ? { src: prepared.colors, stride: 3 } : null
	]);
	return filterAuthored({
		positions: compacted.positions,
		indices: compacted.indices,
		normals: computeNormals(compacted.positions, compacted.indices),
		uvs: compacted.extras[1] ?? null,
		colors: compacted.extras[2] ?? null,
		triangleMaterials,
		materials: prepared.materials
	});
}

type PackedAttributes = {
	data: Float32Array;
	stride: number;
	weights: number[];
};

function packVertexAttributes(source: SourceMesh): PackedAttributes {
	const count = vertexCountOf(source.positions);
	const hasUv = Boolean(source.uvs);
	const hasColor = Boolean(source.colors);
	const stride = 3 + (hasUv ? 2 : 0) + (hasColor ? 3 : 0);
	const data = new Float32Array(count * stride);
	const weights = [1, 1, 1];
	if (hasUv) weights.push(4, 4);
	if (hasColor) weights.push(1, 1, 1);

	for (let i = 0; i < count; i++) {
		let offset = i * stride;
		data[offset] = source.normals[i * 3] ?? 0;
		data[offset + 1] = source.normals[i * 3 + 1] ?? 0;
		data[offset + 2] = source.normals[i * 3 + 2] ?? 0;
		offset += 3;
		if (hasUv && source.uvs) {
			data[offset] = source.uvs[i * 2] ?? 0;
			data[offset + 1] = source.uvs[i * 2 + 1] ?? 0;
			offset += 2;
		}
		if (hasColor && source.colors) {
			data[offset] = source.colors[i * 3] ?? 1;
			data[offset + 1] = source.colors[i * 3 + 1] ?? 1;
			data[offset + 2] = source.colors[i * 3 + 2] ?? 1;
		}
	}
	return { data, stride, weights };
}

function reduceAuthoredIndices(
	indices: Uint32Array,
	positions: Float32Array,
	packed: PackedAttributes,
	targetIndices: number,
	targetError?: number
): Uint32Array {
	const attempts: Array<{ error: number; flags?: SimplifierFlags[] }> =
		targetError != null
			? [
					{ error: targetError, flags: ['LockBorder'] },
					{ error: targetError, flags: ['Permissive'] }
				]
			: [
					{ error: 1e-2, flags: ['LockBorder'] },
					{ error: 0.2, flags: ['LockBorder'] },
					{ error: 1, flags: ['LockBorder'] },
					{ error: 1 },
					{ error: 5 },
					{ error: 10, flags: ['Permissive'] },
					{ error: 100, flags: ['Prune', 'Permissive'] }
				];
	let best = new Uint32Array(0);
	for (const attempt of attempts) {
		const [next] = MeshoptSimplifier.simplifyWithAttributes(
			indices,
			positions,
			3,
			packed.data,
			packed.stride,
			packed.weights,
			null,
			targetIndices,
			attempt.error,
			attempt.flags
		);
		if (next.length === 0) continue;
		best = next;
		if (next.length <= targetIndices) return next;
	}
	return best;
}

function remapTriangleMaterials(
	oldIndices: Uint32Array,
	oldMaterials: Uint16Array,
	newIndices: Uint32Array,
	vertexCount: number
): Uint16Array {
	const vertMat = new Uint16Array(vertexCount);
	const oldFaces = Math.floor(oldIndices.length / 3);
	for (let face = 0; face < oldFaces; face++) {
		const mat = oldMaterials[face] ?? 0;
		vertMat[oldIndices[face * 3] ?? 0] = mat;
		vertMat[oldIndices[face * 3 + 1] ?? 0] = mat;
		vertMat[oldIndices[face * 3 + 2] ?? 0] = mat;
	}
	const outFaces = Math.floor(newIndices.length / 3);
	const out = new Uint16Array(outFaces);
	for (let face = 0; face < outFaces; face++) {
		const a = vertMat[newIndices[face * 3] ?? 0] ?? 0;
		const b = vertMat[newIndices[face * 3 + 1] ?? 0] ?? 0;
		const c = vertMat[newIndices[face * 3 + 2] ?? 0] ?? 0;
		out[face] = majorityMaterial(a, b, c);
	}
	return out;
}

function majorityMaterial(a: number, b: number, c: number): number {
	if (a === b || a === c) return a;
	if (b === c) return b;
	return a;
}

function filterAuthored(mesh: SourceMesh): SourceMesh {
	const kept: number[] = [];
	const keptMats: number[] = [];
	for (let i = 0, face = 0; i + 2 < mesh.indices.length; i += 3, face++) {
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
		keptMats.push(mesh.triangleMaterials[face] ?? 0);
	}
	return {
		...mesh,
		indices: Uint32Array.from(kept),
		triangleMaterials: Uint16Array.from(keptMats)
	};
}
