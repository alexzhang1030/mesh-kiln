import * as watlas from 'watlas';
import { dilateRadiusForAtlas } from './images';
import { computeNormals } from './normals';
import type { MeshGeometry } from './types';

export type UnwrappedMesh = MeshGeometry & {
	uvs: Float32Array;
	atlasWidth: number;
	atlasHeight: number;
};

let watlasReady: Promise<void> | null = null;

export async function unwrap(mesh: MeshGeometry, resolution = 512): Promise<UnwrappedMesh> {
	if (!watlasReady) watlasReady = watlas.Initialize();
	await watlasReady;

	const atlas = new watlas.Atlas();
	try {
		atlas.addMesh({
			vertexPositionData: mesh.positions,
			vertexCount: Math.floor(mesh.positions.length / 3),
			vertexPositionStride: 12,
			vertexNormalData: mesh.normals,
			vertexNormalStride: 12,
			indexData: mesh.indices,
			indexCount: mesh.indices.length
		});
		atlas.generate(
			{
				useInputMeshUvs: false,
				fixWinding: true,
				maxIterations: 4
			},
			{
				padding: Math.max(2, dilateRadiusForAtlas(resolution)),
				resolution,
				bilinear: true,
				rotateCharts: true
			}
		);

		if (atlas.meshCount < 1) {
			throw new Error('watlas produced no atlas meshes.');
		}

		const packed = atlas.getMesh(0);
		const width = Math.max(1, atlas.width);
		const height = Math.max(1, atlas.height);
		const newIndices = new Uint32Array(packed.indexCount);
		if (!packed.getIndexArray(newIndices)) {
			throw new Error('watlas failed to read atlas indices.');
		}

		const positions = new Float32Array(packed.vertexCount * 3);
		const normals = new Float32Array(packed.vertexCount * 3);
		const uvs = new Float32Array(packed.vertexCount * 2);

		for (let i = 0; i < packed.vertexCount; i++) {
			const vertex = packed.getVertex(i);
			const xref = vertex.xref;
			positions[i * 3] = mesh.positions[xref * 3] ?? 0;
			positions[i * 3 + 1] = mesh.positions[xref * 3 + 1] ?? 0;
			positions[i * 3 + 2] = mesh.positions[xref * 3 + 2] ?? 0;
			normals[i * 3] = mesh.normals[xref * 3] ?? 0;
			normals[i * 3 + 1] = mesh.normals[xref * 3 + 1] ?? 0;
			normals[i * 3 + 2] = mesh.normals[xref * 3 + 2] ?? 0;
			uvs[i * 2] = (vertex.uv[0] ?? 0) / width;
			uvs[i * 2 + 1] = (vertex.uv[1] ?? 0) / height;
		}

		return {
			positions,
			indices: newIndices,
			normals: computeNormals(positions, newIndices),
			uvs,
			atlasWidth: width,
			atlasHeight: height
		};
	} finally {
		atlas.delete();
	}
}
