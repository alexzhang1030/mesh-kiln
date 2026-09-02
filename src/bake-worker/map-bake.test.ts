import { describe, expect, it } from 'vitest';
import { buildBvh, closestPointToPoint, triangleIslands } from '../kernels/bvh';
import { createImage } from '../kernels/images';
import { vec3Create } from '../kernels/math';
import type { SourceMaterial, SourceMesh } from '../kernels/types';
import { vertexCountOf } from '../kernels/types';
import {
	DIELECTRIC_ROUGHNESS,
	projectToSource,
	resolvedMetallic,
	resolvedRoughness,
	shadeHit,
	shadeNormal,
	shadeMetallicRoughness,
	shadeOcclusion
} from './map-bake';
import { computeSourceTangents } from '../kernels/source-tangents';

describe('cage projection', () => {
	it('uses the closest source hit when cage rays miss', () => {
		const positions = new Float32Array([
			-6, -0.5, 0, -5, 0.5, 0, -4, -0.5, 0, -1, -1, 0, 1, -1, 0, 0, 1, 0
		]);
		const indices = new Uint32Array([0, 1, 2, 3, 4, 5]);
		const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
		const uvs = new Float32Array([0.875, 0.5, 0.875, 0.5, 0.875, 0.5, 0.125, 0.5, 0.125, 0.5, 0.125, 0.5]);
		const albedo = createImage(8, 1, [0, 0, 255, 255]);
		for (let x = 0; x < 4; x++) {
			albedo.rgba[x * 4] = 220;
			albedo.rgba[x * 4 + 1] = 12;
			albedo.rgba[x * 4 + 2] = 12;
			albedo.rgba[x * 4 + 3] = 255;
		}
		const high: SourceMesh = {
			positions,
			indices,
			normals,
			uvs,
			colors: null,
			triangleMaterials: new Uint16Array([0, 0]),
			materials: [
				{
					baseColorFactor: [1, 1, 1, 1],
					baseColor: albedo,
					metallicFactor: 0,
					roughnessFactor: 1,
					emissiveFactor: [0, 0, 0]
				}
			]
		};
		const tree = buildBvh(positions, indices, normals, uvs);
		const pos = vec3Create(0, 0, 2);
		const nrm = vec3Create(1, 0, 0);
		const sampleNormal = vec3Create();
		const sample = projectToSource(
			tree,
			high,
			pos,
			nrm,
			0.02,
			0.05,
			vec3Create(),
			vec3Create(),
			vec3Create(),
			sampleNormal
		);
		const color = shadeHit(high, sample);

		expect(sample.kind).toBe('closest');
		expect(sample.faceIndex).toBe(1);
		expect(sample.uv).not.toBeNull();
		expect(sample.uv?.[0] ?? 1).toBeLessThan(0.5);
		expect(Math.abs(sample.normal[2] ?? 0)).toBeGreaterThan(0.85);
		expect(Math.abs(sample.normal[0] ?? 1)).toBeLessThan(0.25);
		expect(color[0]).toBeGreaterThan(180);
		expect(color[2]).toBeLessThan(40);
	});

	it('prefers the body island when a cyan disc sits in front of the sample', () => {
		const positions = new Float32Array([
			-1, -1, 0, 1, -1, 0, 0, 1, 0, -0.2, -0.2, 0.08, 0.2, -0.2, 0.08, 0, 0.2, 0.08
		]);
		const indices = new Uint32Array([0, 1, 2, 3, 4, 5]);
		const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
		const yellow = createImage(4, 4, [228, 168, 42, 255]);
		const cyan = createImage(4, 4, [48, 196, 210, 255]);
		const high: SourceMesh = {
			positions,
			indices,
			normals,
			uvs: new Float32Array([0, 0, 1, 0, 0.5, 1, 0, 0, 1, 0, 0.5, 1]),
			colors: null,
			triangleMaterials: new Uint16Array([0, 1]),
			materials: [
				{
					baseColorFactor: [1, 1, 1, 1],
					baseColor: yellow,
					metallicFactor: 0,
					roughnessFactor: 0.5,
					emissiveFactor: [0, 0, 0]
				},
				{
					baseColorFactor: [1, 1, 1, 1],
					baseColor: cyan,
					metallicFactor: 0,
					roughnessFactor: 0.5,
					emissiveFactor: [0, 0, 0]
				}
			]
		};
		const tree = buildBvh(positions, indices, normals, high.uvs);
		const islands = triangleIslands(indices, vertexCountOf(positions));
		expect(islands[0]).not.toBe(islands[1]);
		const sample = projectToSource(
			tree,
			high,
			vec3Create(0, 0, 0),
			vec3Create(0, 0, 1),
			0.12,
			0.4,
			vec3Create(),
			vec3Create(),
			vec3Create(),
			vec3Create(),
			{ homeIsland: islands[0] ?? 0, islands }
		);
		const color = shadeHit(high, sample);
		expect(sample.faceIndex).toBe(0);
		expect(color[0]).toBeGreaterThan(180);
		expect(color[2]).toBeLessThan(80);
	});

	it('uses the nearest surface when the assigned island is farther away', () => {
		const positions = new Float32Array([
			-1, -1, 0, 1, -1, 0, 0, 1, 0, -0.2, -0.2, 0.08, 0.2, -0.2, 0.08, 0, 0.2, 0.08
		]);
		const indices = new Uint32Array([0, 1, 2, 3, 4, 5]);
		const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
		const yellow = createImage(4, 4, [228, 168, 42, 255]);
		const cyan = createImage(4, 4, [48, 196, 210, 255]);
		const high: SourceMesh = {
			positions,
			indices,
			normals,
			uvs: new Float32Array([0, 0, 1, 0, 0.5, 1, 0, 0, 1, 0, 0.5, 1]),
			colors: null,
			triangleMaterials: new Uint16Array([0, 1]),
			materials: [
				{
					baseColorFactor: [1, 1, 1, 1],
					baseColor: yellow,
					metallicFactor: 0,
					roughnessFactor: 0.5,
					emissiveFactor: [0, 0, 0]
				},
				{
					baseColorFactor: [1, 1, 1, 1],
					baseColor: cyan,
					metallicFactor: 0,
					roughnessFactor: 0.5,
					emissiveFactor: [0, 0, 0]
				}
			]
		};
		const tree = buildBvh(positions, indices, normals, high.uvs);
		const islands = triangleIslands(indices, vertexCountOf(positions));
		const sample = projectToSource(
			tree,
			high,
			vec3Create(0, 0, 0.075),
			vec3Create(0, 0, 1),
			0.02,
			0.2,
			vec3Create(),
			vec3Create(),
			vec3Create(),
			vec3Create(),
			{ homeIsland: islands[0] ?? 0, islands }
		);
		const color = shadeHit(high, sample);
		expect(sample.faceIndex).toBe(1);
		expect(color[0]).toBeLessThan(100);
		expect(color[2]).toBeGreaterThan(140);
	});

	it('keeps the original triangle index so a cyan island is not shaded as yellow', () => {
		const positions = new Float32Array([
			-3, -1, 0, -1, -1, 0, -2, 1, 0, 1, -1, 0, 3, -1, 0, 2, 1, 0
		]);
		const indices = new Uint32Array([0, 1, 2, 3, 4, 5]);
		const before = Uint32Array.from(indices);
		const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
		const yellow = createImage(4, 4, [228, 168, 42, 255]);
		const cyan = createImage(4, 4, [48, 196, 210, 255]);
		const high: SourceMesh = {
			positions,
			indices,
			normals,
			uvs: new Float32Array([0, 0, 1, 0, 0.5, 1, 0, 0, 1, 0, 0.5, 1]),
			colors: null,
			triangleMaterials: new Uint16Array([0, 1]),
			materials: [
				{
					baseColorFactor: [1, 1, 1, 1],
					baseColor: yellow,
					metallicFactor: 0,
					roughnessFactor: 0.5,
					emissiveFactor: [0, 0, 0]
				},
				{
					baseColorFactor: [1, 1, 1, 1],
					baseColor: cyan,
					metallicFactor: 0,
					roughnessFactor: 0.5,
					emissiveFactor: [0, 0, 0]
				}
			]
		};
		const tree = buildBvh(positions, indices, normals, high.uvs);
		expect(Array.from(indices)).toEqual(Array.from(before));
		const hit = closestPointToPoint(tree, [2, 0, 0]);
		expect(hit?.faceIndex).toBe(1);
		expect(shadeHit(high, {
			kind: 'closest',
			normal: [0, 0, 1],
			uv: hit?.uv ?? [0, 0],
			faceIndex: hit?.faceIndex ?? -1,
			barycentric: hit?.barycentric ?? [1, 0, 0]
		})[2]).toBeGreaterThan(140);
	});
});

describe('dielectric metal', () => {
	it('treats a missing metallic map as metal 0 even if the glTF factor is 1', () => {
		const dielectric: SourceMaterial = {
			baseColorFactor: [1, 1, 1, 1],
			metallicFactor: 1,
			roughnessFactor: 1,
			emissiveFactor: [0, 0, 0]
		};
		expect(resolvedMetallic(dielectric)).toBe(0);
		expect(resolvedRoughness(dielectric)).toBe(DIELECTRIC_ROUGHNESS);
		expect(
			resolvedRoughness({
				...dielectric,
				roughnessFactor: 0.9
			})
		).toBe(0.9);
	});
});

describe('source normal map', () => {
	it('transforms tangent-space normal Y into the source surface basis', () => {
		const normalMap = createImage(2, 2, [128, 255, 128, 255]);
		const high: SourceMesh = {
			positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
			indices: new Uint32Array([0, 1, 2]),
			normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
			uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
			colors: null,
			triangleMaterials: new Uint16Array([0]),
			materials: [
				{
					baseColorFactor: [1, 1, 1, 1],
					normal: normalMap,
					normalScale: 1,
					metallicFactor: 0,
					roughnessFactor: 0.5,
					emissiveFactor: [0, 0, 0]
				}
			]
		};
		const tangents = computeSourceTangents({
			positions: high.positions,
			indices: high.indices,
			normals: high.normals,
			uvs: high.uvs
		});
		const world = shadeNormal(
			high,
			{ kind: 'closest', normal: [0, 0, 1], uv: [0.25, 0.25], faceIndex: 0, barycentric: [0.5, 0.25, 0.25] },
			tangents,
			vec3Create()
		);
		expect(world[1]).toBeGreaterThan(0.99);
		expect(Math.abs(world[2])).toBeLessThan(0.02);
	});
});

describe('vertex color', () => {
	it('multiplies source vertex color onto the hit albedo', () => {
		const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
		const indices = new Uint32Array([0, 1, 2]);
		const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
		const albedo = createImage(4, 4, [255, 255, 255, 255]);
		const high: SourceMesh = {
			positions,
			indices,
			normals,
			uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
			colors: new Float32Array([1, 0, 0, 1, 0, 0, 1, 0, 0]),
			triangleMaterials: new Uint16Array([0]),
			materials: [
				{
					baseColorFactor: [1, 1, 1, 1],
					baseColor: albedo,
					metallicFactor: 1,
					roughnessFactor: 1,
					emissiveFactor: [0, 0, 0]
				}
			]
		};
		const color = shadeHit(high, {
			kind: 'closest',
			normal: [0, 0, 1],
			uv: [0.25, 0.25],
			faceIndex: 0,
			barycentric: [1, 0, 0]
		});
		expect(color[0]).toBeGreaterThan(200);
		expect(color[1]).toBeLessThan(20);
		expect(color[2]).toBeLessThan(20);
		const mr = shadeMetallicRoughness(high, {
			kind: 'closest',
			normal: [0, 0, 1],
			uv: [0.25, 0.25],
			faceIndex: 0,
			barycentric: [1, 0, 0]
		});
		expect(mr[0]).toBe(Math.round(DIELECTRIC_ROUGHNESS * 255));
		expect(mr[1]).toBe(0);
	});

	it('encodes vertex-only linear color into an sRGB atlas byte', () => {
		const high: SourceMesh = {
			positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
			indices: new Uint32Array([0, 1, 2]),
			normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
			uvs: null,
			colors: new Float32Array([0.214, 0.214, 0.214, 0.214, 0.214, 0.214, 0.214, 0.214, 0.214]),
			triangleMaterials: new Uint16Array([0]),
			materials: [
				{
					baseColorFactor: [1, 1, 1, 1],
					metallicFactor: 0,
					roughnessFactor: 1,
					emissiveFactor: [0, 0, 0]
				}
			]
		};
		const color = shadeHit(high, {
			kind: 'closest',
			normal: [0, 0, 1],
			uv: null,
			faceIndex: 0,
			barycentric: [1, 0, 0]
		});
		expect(color[0]).toBeGreaterThan(120);
		expect(color[0]).toBeLessThan(140);
		expect(color[1]).toBe(color[0]);
		expect(color[2]).toBe(color[0]);
	});
});

describe('opacity', () => {
	it('writes source albedo alpha onto the hit', () => {
		const albedo = createImage(4, 4, [20, 180, 40, 90]);
		const color = shadeHit(oneTriangle({ baseColor: albedo, baseColorFactor: [1, 1, 1, 1] }), {
			kind: 'closest',
			normal: [0, 0, 1],
			uv: [0.25, 0.25],
			faceIndex: 0,
			barycentric: [1, 0, 0]
		});
		expect(color[3]).toBeGreaterThan(80);
		expect(color[3]).toBeLessThan(100);
	});

	it('multiplies baseColorFactor alpha when there is no albedo map', () => {
		const color = shadeHit(oneTriangle({ baseColorFactor: [1, 1, 1, 0.5] }), {
			kind: 'closest',
			normal: [0, 0, 1],
			uv: null,
			faceIndex: 0,
			barycentric: [1, 0, 0]
		});
		expect(color[3]).toBe(128);
	});
});

describe('occlusion', () => {
	it('samples the occlusion R channel and applies strength', () => {
		const occlusion = createImage(4, 4, [40, 0, 0, 255]);
		const value = shadeOcclusion(
			oneTriangle({ occlusion, occlusionStrength: 1 }),
			{
				kind: 'closest',
				normal: [0, 0, 1],
				uv: [0.25, 0.25],
				faceIndex: 0,
				barycentric: [1, 0, 0]
			}
		);
		expect(value).toBeGreaterThan(30);
		expect(value).toBeLessThan(50);
	});

	it('defaults to unoccluded without a map', () => {
		const value = shadeOcclusion(oneTriangle({}), {
			kind: 'closest',
			normal: [0, 0, 1],
			uv: null,
			faceIndex: 0,
			barycentric: [1, 0, 0]
		});
		expect(value).toBe(255);
	});
});

function oneTriangle(
	material: Partial<SourceMaterial> & { occlusion?: SourceMaterial['occlusion'] }
): SourceMesh {
	return {
		positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
		indices: new Uint32Array([0, 1, 2]),
		normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
		uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
		colors: null,
		triangleMaterials: new Uint16Array([0]),
		materials: [
			{
				baseColorFactor: [1, 1, 1, 1],
				metallicFactor: 0,
				roughnessFactor: 1,
				emissiveFactor: [0, 0, 0],
				...material
			}
		]
	};
}
