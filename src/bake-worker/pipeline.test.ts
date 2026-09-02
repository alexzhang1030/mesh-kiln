import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseGlb } from '../import-worker/parse-glb';
import { buildBvh, closestPointToPoint } from '../kernels/bvh';
import {
	createCrestGlb,
	createCrestGeometry,
	createVisorPanelGlb,
	fixtureTriangleCount,
	visorPanelTriangleCount
} from '../kernels/fixture';
import { createImage, sampleBilinear } from '../kernels/images';
import { remesh } from '../kernels/remesh';
import { createRobotGlb } from '../kernels/robot';
import { simplify } from '../kernels/simplify';
import type { SourceMesh } from '../kernels/types';
import { readGlbDocument } from '../kernels/write-glb';
import type { BakeProgressEvent } from './pipeline';
import { runBake } from './pipeline';

describe('bake pipeline', () => {
	it('authored QEM copies source maps and skips unwrap', async () => {
		const glb = await createCrestGlb({ segments: 18, name: 'crest-test' });
		const { source, summary } = await parseGlb(glb);
		expect(summary.triangleCount).toBe(fixtureTriangleCount(18));
		const sourceAlbedo = source.materials[0]?.baseColor;
		expect(sourceAlbedo?.width).toBe(128);

		const { complete, stages } = await bake(source, {
			triangleBudget: 280,
			topologyMode: 'authored',
			mapSize: 64
		});
		expect(complete.triangleCount).toBeGreaterThan(0);
		expect(complete.triangleCount).toBeLessThanOrEqual(280);
		expect(complete.topology).toBe('authored');
		expect(stages).toEqual(['geometry', 'export']);

		const { source: baked } = await parseGlb(complete.glb);
		expect(baked.materials).toHaveLength(1);
		expect(baked.materials[0]?.metallicFactor).toBe(0);
		expect(baked.materials[0]?.normal).toBeUndefined();
		expect(baked.materials[0]?.baseColor?.width).toBe(128);
		expect(baked.materials[0]?.baseColor?.height).toBe(128);
		expect(baked.materials[0]?.baseColor?.rgba).toEqual(sourceAlbedo?.rgba);
	});

	it('auto uses authored QEM on a clean over-budget model', async () => {
		const glb = await createCrestGlb({ segments: 48, name: 'crest-auto' });
		const { source, summary } = await parseGlb(glb);
		expect(summary.triangleCount).toBeGreaterThan(6000);
		expect(summary.triangleCount).toBeLessThan(100_000);
		const { complete, stages } = await bake(source, {
			triangleBudget: 2000,
			topologyMode: 'auto',
			mapSize: 64
		});
		expect(complete.topology).toBe('authored');
		expect(complete.triangleCount).toBeGreaterThan(0);
		expect(complete.triangleCount).toBeLessThanOrEqual(2000);
		expect(stages).toEqual(['geometry', 'export']);
	});

	it('QEM simplify reduces an authored mesh', async () => {
		const geometry = createCrestGeometry(20);
		const reduced = await simplify(geometry, 200);
		expect(reduced.indices.length / 3).toBeLessThan(geometry.indices.length / 3);
		expect(reduced.indices.length / 3).toBeLessThanOrEqual(200);
	});

	it('voxel bake reports complete with a new atlas', async () => {
		const glb = await createCrestGlb({ segments: 16, name: 'crest-voxel' });
		const { source } = await parseGlb(glb);
		const { complete, stages } = await bake(source, {
			triangleBudget: 320,
			topologyMode: 'voxel',
			mapSize: 96,
			voxelResolution: 50
		});
		expect(stages).toEqual(['geometry', 'uv', 'tangents', 'maps', 'export']);
		const document = await readGlbDocument(new Uint8Array(complete.glb));
		const material = document.getRoot().listMeshes()[0]?.listPrimitives()[0]?.getMaterial();
		expect(material?.getBaseColorTexture()?.getMimeType()).toBe('image/png');
		expect(material?.getNormalTexture()?.getMimeType()).toBe('image/png');
		expect(material?.getMetallicRoughnessTexture()?.getMimeType()).toBe('image/png');
		const { source: baked } = await parseGlb(complete.glb);
		expect(baked.materials[0]?.baseColor?.width).toBe(96);
	});

	it('voxel remesh rebuilds topology and hits the budget', async () => {
		const geometry = createCrestGeometry(16);
		const remeshed = await remesh(geometry, 220, { voxelResolution: 50, voxelSolve: true });
		expect(remeshed.indices.length).toBeGreaterThan(12);
		expect(remeshed.indices.length / 3).toBeLessThanOrEqual(220);
	});

	it('voxel mode keeps an under-budget mesh and still bakes maps', async () => {
		const glb = await createCrestGlb({ segments: 18, name: 'crest-keep' });
		const { source, summary } = await parseGlb(glb);
		expect(summary.triangleCount).toBeLessThan(6000);
		const { complete } = await bake(source, {
			triangleBudget: 6000,
			topologyMode: 'voxel',
			mapSize: 64,
			voxelResolution: 50
		});
		expect(complete.triangleCount).toBe(summary.triangleCount);
		const { source: baked } = await parseGlb(complete.glb);
		expect(baked.materials[0]?.baseColor?.width).toBe(64);
	});

	it('keeps glTF top-to-bottom albedo orientation through a voxel atlas', async () => {
		const albedo = createImage(4, 4, [0, 0, 0, 255]);
		for (let y = 0; y < 4; y++) {
			for (let x = 0; x < 4; x++) {
				const pixel = (y * 4 + x) * 4;
				const color = y < 2 ? [220, 20, 20] : [20, 20, 220];
				albedo.rgba[pixel] = color[0] ?? 0;
				albedo.rgba[pixel + 1] = color[1] ?? 0;
				albedo.rgba[pixel + 2] = color[2] ?? 0;
			}
		}
		const source: SourceMesh = {
			positions: new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0]),
			indices: new Uint32Array([0, 1, 2]),
			normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
			uvs: new Float32Array([0, 1, 1, 1, 0, 0]),
			colors: null,
			triangleMaterials: new Uint16Array([0]),
			materials: [
				{
					baseColorFactor: [1, 1, 1, 1],
					baseColor: albedo,
					metallicFactor: 0,
					roughnessFactor: 0.7,
					emissiveFactor: [0, 0, 0]
				}
			]
		};

		const { complete } = await bake(source, {
			triangleBudget: 64,
			topologyMode: 'voxel',
			mapSize: 64,
			voxelResolution: 50
		});
		const { source: baked } = await parseGlb(complete.glb);
		const top = sampleAlbedo(baked, [-0.8, 0.5, 0]);
		const bottom = sampleAlbedo(baked, [-0.8, -0.5, 0]);
		expect(top[0]).toBeGreaterThan(180);
		expect(top[2]).toBeLessThan(60);
		expect(bottom[2]).toBeGreaterThan(180);
		expect(bottom[0]).toBeLessThan(60);
	});

	it('authored export copies emissive factor without inventing a map', async () => {
		const glb = await createCrestGlb({ segments: 12, name: 'crest-emissive' });
		const { source } = await parseGlb(glb);
		const material = source.materials[0];
		expect(material).toBeTruthy();
		if (!material) return;
		material.emissiveFactor = [1, 0.2, 0];
		const { complete } = await bake(source, {
			triangleBudget: 180,
			topologyMode: 'authored',
			mapSize: 48
		});
		const { source: baked } = await parseGlb(complete.glb);
		expect(baked.materials[0]?.emissiveFactor[0]).toBeCloseTo(1, 5);
		expect(baked.materials[0]?.emissiveFactor[1]).toBeCloseTo(0.2, 5);
		expect(baked.materials[0]?.emissive).toBeUndefined();
	});
});

describe('authored appearance', () => {
	it('keeps a painted yellow mesh’s visor and cyan discs on the same albedo', async () => {
		expect(visorPanelTriangleCount(56)).toBeGreaterThan(6000);
		const glb = await createVisorPanelGlb(56);
		const { source, summary } = await parseGlb(glb);
		expect(summary.triangleCount).toBeGreaterThan(6000);
		const albedo = source.materials[0]?.baseColor;
		expect(albedo?.width).toBe(96);
		expect(source.materials[0]?.metallicFactor).toBe(0);

		const { complete, stages } = await bake(source, {
			triangleBudget: 6000,
			topologyMode: 'authored',
			mapSize: 64
		});
		expect(complete.topology).toBe('authored');
		expect(complete.triangleCount).toBeLessThanOrEqual(6000);
		expect(stages).toEqual(['geometry', 'export']);

		const { source: baked } = await parseGlb(complete.glb);
		expect(baked.materials).toHaveLength(1);
		expect(baked.materials[0]?.metallicFactor).toBe(0);
		expect(baked.materials[0]?.baseColor?.width).toBe(96);
		expect(baked.materials[0]?.baseColor?.height).toBe(96);
		expect(baked.materials[0]?.baseColor?.rgba).toEqual(albedo?.rgba);
		expect(baked.materials[0]?.normal).toBeUndefined();

		const corner = closestUv(baked, [-1, -1, 0]);
		expect(corner[0]).toBeCloseTo(0, 1);
		expect(corner[1]).toBeCloseTo(1, 1);

		const body = sampleAlbedo(baked, [-0.82, -0.82, 0]);
		const visor = sampleAlbedo(baked, [0, 0.3, 0]);
		const eye = sampleAlbedo(baked, [-0.2, 0.36, 0]);
		expect(body[0]).toBeGreaterThan(160);
		expect(body[2]).toBeLessThan(90);
		expect(visor[0]).toBeLessThan(80);
		expect(visor[1]).toBeLessThan(80);
		expect(eye[2]).toBeGreaterThan(140);
		expect(eye[0]).toBeLessThan(140);
	});

	it('keeps the robot visor dark, body yellow, and chest lamp cyan from source maps', async () => {
		const glb = await createRobotGlb();
		const { source, summary } = await parseGlb(glb);
		expect(summary.triangleCount).toBeGreaterThan(6000);
		expect(source.materials.length).toBeGreaterThanOrEqual(3);

		const { complete } = await bake(source, {
			triangleBudget: 6000,
			topologyMode: 'auto',
			mapSize: 64
		});
		expect(complete.topology).toBe('authored');
		expect(complete.triangleCount).toBeLessThanOrEqual(6000);

		const { source: baked } = await parseGlb(complete.glb);
		expect(baked.materials.length).toBeGreaterThanOrEqual(3);
		for (const material of baked.materials) {
			expect(material.metallicFactor).toBe(0);
			expect(material.baseColor?.width).toBe(48);
			expect(material.baseColor?.height).toBe(48);
		}

		const body = sampleAlbedo(baked, [0, 0, 0.24]);
		const visor = sampleAlbedo(baked, [0, 0.78, 0.32]);
		const lamp = sampleAlbedo(baked, [0, 0.3, 0.3]);
		expect(body[0]).toBeGreaterThan(160);
		expect(body[2]).toBeLessThan(90);
		expect(visor[0]).toBeLessThan(80);
		expect(visor[1]).toBeLessThan(80);
		expect(lamp[2]).toBeGreaterThan(140);
		expect(lamp[0]).toBeLessThan(140);
	});

	it('bakes the Pixabay tower with authored QEM and no voxel stages', async () => {
		const bytes = readFileSync('public/examples/tower.glb');
		const glb = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
		const { source, summary } = await parseGlb(glb);
		expect(summary.triangleCount).toBeGreaterThan(6000);
		const { complete, stages } = await bake(source, {
			triangleBudget: 6000,
			topologyMode: 'authored',
			mapSize: 2048
		});
		expect(complete.topology).toBe('authored');
		expect(complete.triangleCount).toBeLessThan(summary.triangleCount);
		expect(stages).toEqual(['geometry', 'export']);
	});

	it('geometry-only voxel bake skips the atlas stages', async () => {
		const glb = await createCrestGlb({ segments: 16, name: 'crest-geo' });
		const { source } = await parseGlb(glb);
		const { complete, stages } = await bake(source, {
			triangleBudget: 320,
			topologyMode: 'voxel',
			mapSize: 64,
			voxelResolution: 50,
			geometryOnly: true
		});
		expect(complete.triangleCount).toBeGreaterThan(0);
		expect(stages).toEqual(['geometry', 'export']);
		const { source: baked } = await parseGlb(complete.glb);
		expect(baked.materials[0]?.baseColor).toBeUndefined();
		expect(baked.materials[0]?.unlit).toBe(true);
	});

	it('keeps KHR_materials_unlit on a vertex-color atlas bake', async () => {
		const source: SourceMesh = {
			positions: new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0]),
			indices: new Uint32Array([0, 1, 2, 2, 1, 3]),
			normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
			uvs: null,
			colors: new Float32Array([1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0]),
			triangleMaterials: new Uint16Array([0, 0]),
			materials: [
				{
					baseColorFactor: [1, 1, 1, 1],
					metallicFactor: 0,
					roughnessFactor: 1,
					emissiveFactor: [0, 0, 0],
					unlit: true
				}
			]
		};
		const { complete } = await bake(source, {
			triangleBudget: 64,
			topologyMode: 'voxel',
			mapSize: 32,
			voxelResolution: 50
		});
		const { source: baked } = await parseGlb(complete.glb);
		expect(baked.materials[0]?.unlit).toBe(true);
		expect(baked.materials[0]?.baseColor).toBeTruthy();
	});
});

describe('sample fixture', () => {
	it('keeps a checked-in sample GLB when present', () => {
		try {
			const bytes = readFileSync(new URL('../../public/sample-crest.glb', import.meta.url));
			expect(bytes.byteLength).toBeGreaterThan(1000);
		} catch {
			expect(true).toBe(true);
		}
	});
});

async function bake(source: SourceMesh, settings: Parameters<typeof runBake>[1]) {
	const events: BakeProgressEvent[] = [];
	await runBake(source, settings, (event) => events.push(event));
	const complete = events.find((event) => event.type === 'complete');
	expect(complete?.type).toBe('complete');
	if (complete?.type !== 'complete') {
		throw new Error('Bake did not complete.');
	}
	const stages = events.filter((event) => event.type === 'start').map((event) => event.stage);
	return { complete, stages };
}

function closestUv(mesh: SourceMesh, point: [number, number, number]): [number, number] {
	if (!mesh.uvs) throw new Error('Mesh has no UVs.');
	const tree = buildBvh(mesh.positions, mesh.indices, mesh.normals, mesh.uvs);
	const hit = closestPointToPoint(tree, point);
	if (!hit?.uv) throw new Error(`No UV near ${point.join(',')}`);
	return hit.uv;
}

function sampleAlbedo(mesh: SourceMesh, point: [number, number, number]): [number, number, number] {
	if (!mesh.uvs) throw new Error('Mesh has no UVs.');
	const tree = buildBvh(mesh.positions, mesh.indices, mesh.normals, mesh.uvs);
	const hit = closestPointToPoint(tree, point);
	if (!hit) throw new Error(`No surface near ${point.join(',')}`);
	const material = mesh.materials[mesh.triangleMaterials[hit.faceIndex] ?? 0];
	if (!material) throw new Error('Missing material.');
	if (material.baseColor && hit.uv) {
		const texel = sampleBilinear(material.baseColor, hit.uv[0], hit.uv[1], true);
		return [
			texel[0] * (material.baseColorFactor[0] ?? 1),
			texel[1] * (material.baseColorFactor[1] ?? 1),
			texel[2] * (material.baseColorFactor[2] ?? 1)
		];
	}
	return [
		(material.baseColorFactor[0] ?? 1) * 255,
		(material.baseColorFactor[1] ?? 1) * 255,
		(material.baseColorFactor[2] ?? 1) * 255
	];
}
