import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseGlb } from '../import-worker/parse-glb';
import { computeNormals } from './normals';
import { simplifySurface, weldPositionSeams } from './surface-simplify';
import { vertexCountOf } from './types';

describe('seam-welded surface simplify', () => {
	it('rejoins duplicate UV-seam positions before simplification', () => {
		const positions = new Float32Array([
			0, 0, 0, 1, 0, 0, 0, 1, 0,
			1, 0, 0, 1, 1, 0, 0, 1, 0
		]);
		const indices = new Uint32Array([0, 1, 2, 3, 4, 5]);
		const welded = weldPositionSeams({ positions, indices, normals: computeNormals(positions, indices) });
		expect(vertexCountOf(welded.positions)).toBe(4);
		expect(welded.indices.length / 3).toBe(2);
	});

	it('hits the 6k ceiling on the seam-heavy Bear example', async () => {
		const file = readFileSync('public/examples/bear.glb');
		const glb = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
		const { source } = await parseGlb(glb);
		const reduced = await simplifySurface(source, 6000);
		expect(reduced.indices.length / 3).toBeLessThanOrEqual(6000);
		expect(vertexCountOf(reduced.positions)).toBeLessThan(vertexCountOf(source.positions));
	});
});
