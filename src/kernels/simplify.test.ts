import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseGlb } from '../import-worker/parse-glb';
import { createVisorPanelGlb } from './fixture';
import { createCrestGeometry } from './fixture';
import { simplify, simplifyAuthored } from './simplify';
import { vertexCountOf } from './types';

describe('authored QEM attributes', () => {
	it('honors the triangle ceiling on the dense Bear example', async () => {
		const bytes = readFileSync('public/examples/bear.glb');
		const glb = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
		const { source } = await parseGlb(glb);
		const reduced = await simplifyAuthored(source, 6000);
		expect(reduced.indices.length / 3).toBeLessThanOrEqual(6000);
	});

	it('keeps source UVs in range while hitting the budget', async () => {
		const glb = await createVisorPanelGlb(56);
		const { source } = await parseGlb(glb);
		const reduced = await simplifyAuthored(source, 6000);
		expect(reduced.indices.length / 3).toBeLessThanOrEqual(6000);
		expect(reduced.uvs).toBeTruthy();
		expect(reduced.materials).toBe(source.materials);
		const verts = vertexCountOf(reduced.positions);
		expect(reduced.uvs?.length).toBe(verts * 2);
		let outside = 0;
		for (let i = 0; i < verts; i++) {
			const u = reduced.uvs?.[i * 2] ?? 0;
			const v = reduced.uvs?.[i * 2 + 1] ?? 0;
			if (u < -1e-4 || u > 1 + 1e-4 || v < -1e-4 || v > 1 + 1e-4) outside += 1;
		}
		expect(outside).toBe(0);
	});
});

describe('surface error targeting', () => {
	it('lets a looser error drop more triangles than a tight one', async () => {
		const geometry = createCrestGeometry(28);
		const tight = await simplify(geometry, 4, { targetError: 0.001, prune: false });
		const loose = await simplify(geometry, 4, { targetError: 0.2, prune: false });
		expect(tight.indices.length / 3).toBeLessThan(geometry.indices.length / 3);
		expect(loose.indices.length).toBeLessThan(tight.indices.length);
	});
});
