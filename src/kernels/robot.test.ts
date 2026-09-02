import { describe, expect, it } from 'vitest';
import { aabbFromPositions } from './math';
import { boxTriangleCount, createRobotGeometry, robotTriangleCount } from './robot';
import { simplify } from './simplify';
import { isTriangleSoup, resolveTopologyForMesh } from './topology';
import { triangleCountOf } from './types';

describe('hard-surface robot fixture', () => {
	it('is a 50k-class indexed model, not a dense sculpt', () => {
		expect(boxTriangleCount(10)).toBe(1200);
		expect(robotTriangleCount()).toBeGreaterThanOrEqual(45_000);
		expect(robotTriangleCount()).toBeLessThan(100_000);
		const mesh = createRobotGeometry();
		expect(triangleCountOf(mesh.indices)).toBe(robotTriangleCount());
		expect(isTriangleSoup(mesh.positions, mesh.indices)).toBe(false);
		expect(resolveTopologyForMesh('auto', mesh)).toBe('authored');
	});

	it('authored QEM to 6000 keeps antenna height', async () => {
		const mesh = createRobotGeometry();
		const reduced = await simplify(mesh, 6000);
		expect(triangleCountOf(reduced.indices)).toBeGreaterThan(100);
		expect(triangleCountOf(reduced.indices)).toBeLessThanOrEqual(6000);
		expect(aabbFromPositions(reduced.positions).max[1]).toBeGreaterThan(1.2);
	});
});
