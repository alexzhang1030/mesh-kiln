import { describe, expect, it } from 'vitest';
import { createCrestGeometry } from './fixture';
import { createTorusGeometry } from './example-meshes';
import { DEFAULT_BAKE_SETTINGS } from './types';
import {
	AUTHORED_KEEP_RATIO,
	DENSE_SCULPT_TRIANGLES,
	isFragmentedSurface,
	isTriangleSoup,
	resolveTopologyForMesh,
	resolveTopologyMode,
	sharedEdgeRatio,
	uniquePositionRatio
} from './topology';

describe('topology auto', () => {
	it('is the product default', () => {
		expect(DEFAULT_BAKE_SETTINGS.topologyMode).toBe('auto');
	});

	it('uses authored QEM for clean models under 100k triangles', () => {
		expect(resolveTopologyMode('auto', 50_000, false)).toBe('authored');
		expect(resolveTopologyMode('auto', 6_400, false)).toBe('authored');
		expect(resolveTopologyMode('auto', DENSE_SCULPT_TRIANGLES - 1, false)).toBe('authored');
	});

	it('keeps authored QEM when Auto only trims a clean mesh', () => {
		expect(resolveTopologyMode('auto', 50_000, false, false, { triangleBudget: 40_000 })).toBe('authored');
		expect(AUTHORED_KEEP_RATIO).toBe(0.5);
	});

	it('rebakes a watlas atlas when Auto drops a clean mesh below half its triangles', () => {
		expect(resolveTopologyMode('auto', 50_000, false, false, { triangleBudget: 6_000 })).toBe('surface');
		expect(resolveTopologyMode('auto', 50_000, false, false, { triangleBudget: 24_999 })).toBe('surface');
		expect(resolveTopologyMode('auto', 50_000, false, false, { triangleBudget: 25_000 })).toBe('authored');
	});

	it('does not use the keep-ratio when targeting surface error', () => {
		expect(
			resolveTopologyMode('auto', 50_000, false, false, {
				triangleBudget: 6_000,
				geometryTarget: 'error'
			})
		).toBe('authored');
	});

	it('routes dense sculpts and triangle soup through seam-welded surface bake', () => {
		expect(resolveTopologyMode('auto', 129_060, false)).toBe('surface');
		expect(resolveTopologyMode('auto', DENSE_SCULPT_TRIANGLES, false)).toBe('surface');
		expect(resolveTopologyMode('auto', 20_000, true)).toBe('surface');
	});

	it('routes fragmented reconstructions through voxel remesh', () => {
		expect(resolveTopologyMode('auto', 739_856, false, true)).toBe('voxel');
		expect(resolveTopologyMode('auto', 20_000, false, true)).toBe('voxel');
		expect(resolveTopologyMode('auto', 2, false, true)).toBe('authored');
		expect(resolveTopologyMode('auto', 129_060, false, false)).toBe('surface');
	});

	it('honors an explicit Voxel or Authored override', () => {
		expect(resolveTopologyMode('voxel', 50_000, false)).toBe('voxel');
		expect(resolveTopologyMode('authored', 200_000, false)).toBe('authored');
	});

	it('treats an indexed torus or crest as a clean model, not soup', () => {
		const torus = createTorusGeometry();
		expect(isTriangleSoup(torus.positions, torus.indices)).toBe(false);
		expect(resolveTopologyForMesh('auto', torus)).toBe('authored');
		const crest = createCrestGeometry(48);
		expect(crest.indices.length / 3).toBeLessThan(DENSE_SCULPT_TRIANGLES);
		expect(isTriangleSoup(crest.positions, crest.indices)).toBe(false);
		expect(resolveTopologyForMesh('auto', crest)).toBe('authored');
	});

	it('detects a triangle soup with unique vertices per face', () => {
		const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 2, 1, 0]);
		const indices = new Uint32Array([0, 1, 2, 3, 4, 5]);
		expect(isTriangleSoup(positions, indices)).toBe(true);
	});

	it('treats a closed tetrahedron as connected, not a reconstruction mesh', () => {
		const positions = new Float32Array([1, 1, 1, 1, -1, -1, -1, 1, -1, -1, -1, 1]);
		const indices = new Uint32Array([0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2]);
		expect(uniquePositionRatio(positions)).toBe(1);
		expect(sharedEdgeRatio(indices)).toBe(1);
		expect(isFragmentedSurface(positions, indices)).toBe(false);
		expect(resolveTopologyForMesh('auto', { positions, indices, normals: positions })).toBe('authored');
	});

	it('treats an open triangle strip as a fragmented reconstruction', () => {
		const triangles = 12;
		const positions = new Float32Array((triangles + 2) * 3);
		for (let i = 0; i < triangles + 2; i++) {
			positions[i * 3] = i;
			positions[i * 3 + 1] = i % 2;
			positions[i * 3 + 2] = 0;
		}
		const indices = new Uint32Array(triangles * 3);
		for (let i = 0; i < triangles; i++) {
			if (i % 2 === 0) {
				indices[i * 3] = i;
				indices[i * 3 + 1] = i + 1;
				indices[i * 3 + 2] = i + 2;
			} else {
				indices[i * 3] = i + 1;
				indices[i * 3 + 1] = i;
				indices[i * 3 + 2] = i + 2;
			}
		}
		expect(uniquePositionRatio(positions)).toBe(1);
		expect(sharedEdgeRatio(indices)).toBeLessThan(0.65);
		expect(isFragmentedSurface(positions, indices)).toBe(true);
		expect(resolveTopologyForMesh('auto', { positions, indices, normals: positions })).toBe('authored');
	});
});
