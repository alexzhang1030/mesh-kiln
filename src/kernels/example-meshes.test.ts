import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EXAMPLES } from '../examples/catalog';
import { parseGlb } from '../import-worker/parse-glb';
import {
	buildFixtureGlb,
	crateTriangleCount,
	createCratePrimitives,
	spireTriangleCount,
	torusTriangleCount
} from './example-meshes';
import { fixtureTriangleCount } from './fixture';
import { isFragmentedSurface, resolveTopologyForMesh } from './topology';

function arrayBufferOf(path: string): ArrayBuffer {
	const bytes = readFileSync(path);
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

describe('example catalog', () => {
	it('ships four Pixabay GLBs with short names only', () => {
		expect(EXAMPLES.map((example) => example.id)).toEqual(['tower', 'car', 'dog', 'bear']);
		expect(EXAMPLES.map((example) => example.label)).toEqual(['Tower', 'Car', 'Dog', 'Bear']);
		const banned = new Set(['owl', 'crest', 'torus', 'crate', 'spire', 'robot', 'book']);
		expect(EXAMPLES.some((example) => banned.has(example.id))).toBe(false);
		for (const example of EXAMPLES) {
			expect(example).not.toHaveProperty('hint');
			expect(example).not.toHaveProperty('topologyMode');
			const header = readFileSync(`public${example.file}`).subarray(0, 4);
			expect(header.equals(Buffer.from('glTF'))).toBe(true);
		}
	});

	it('tower parses and authored QEM is the product path', async () => {
		const parsed = await parseGlb(arrayBufferOf('public/examples/tower.glb'));
		expect(parsed.summary.triangleCount).toBeGreaterThan(0);
		expect(parsed.summary.materialCount).toBeGreaterThanOrEqual(1);
		expect(parsed.source.uvs).not.toBeNull();
		expect(resolveTopologyForMesh('authored', parsed.source)).toBe('authored');
		expect(resolveTopologyForMesh('auto', parsed.source)).toBe('authored');
	});

	it('bear stays on seam-welded surface, not voxel reconstruction', async () => {
		const parsed = await parseGlb(arrayBufferOf('public/examples/bear.glb'));
		expect(parsed.summary.triangleCount).toBeGreaterThan(100_000);
		expect(isFragmentedSurface(parsed.source.positions, parsed.source.indices)).toBe(false);
		expect(resolveTopologyForMesh('auto', parsed.source)).toBe('surface');
	});
});

describe('test fixtures', () => {
	it('crest torus crate and spire parse with expected counts', async () => {
		const crest = await parseGlb(await buildFixtureGlb('crest'));
		expect(crest.summary.name).toBe('crest');
		expect(crest.summary.triangleCount).toBe(fixtureTriangleCount(48));
		expect(crest.source.materials).toHaveLength(1);

		const torus = await parseGlb(await buildFixtureGlb('torus'));
		expect(torus.summary.name).toBe('torus');
		expect(torus.summary.triangleCount).toBe(torusTriangleCount());
		expect(torus.source.materials).toHaveLength(1);

		const crate = await parseGlb(await buildFixtureGlb('crate'));
		expect(crate.summary.name).toBe('crate');
		expect(crate.summary.triangleCount).toBe(crateTriangleCount());
		expect(crate.source.materials).toHaveLength(3);
		expect(createCratePrimitives()).toHaveLength(6);

		const spire = await parseGlb(await buildFixtureGlb('spire'));
		expect(spire.summary.name).toBe('spire');
		expect(spire.summary.triangleCount).toBe(spireTriangleCount());
		expect(spire.source.materials).toHaveLength(1);
	});
});
