import { describe, expect, it } from 'vitest';
import { createTorusGeometry } from './example-meshes';
import { aabbFromPositions } from './math';
import { generateTangents } from './tangents';
import { triangleCountOf } from './types';

describe('generateTangents', () => {
	it('keeps shared-vertex positions when welding corner tangents', async () => {
		const mesh = createTorusGeometry(32, 16);
		const welded = await generateTangents(mesh);
		expect(triangleCountOf(welded.indices)).toBe(triangleCountOf(mesh.indices));
		expect(welded.tangents.length).toBe((welded.positions.length / 3) * 4);

		const sourceBox = aabbFromPositions(mesh.positions);
		const weldedBox = aabbFromPositions(welded.positions);
		const axes: Array<0 | 1 | 2> = [0, 1, 2];
		for (const axis of axes) {
			const sourceExtent = sourceBox.max[axis] - sourceBox.min[axis];
			const weldedExtent = weldedBox.max[axis] - weldedBox.min[axis];
			expect(weldedExtent / sourceExtent).toBeGreaterThan(0.98);
			expect(weldedExtent / sourceExtent).toBeLessThan(1.02);
		}
	});
});
