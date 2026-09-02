import { describe, expect, it } from 'vitest';
import { computeSourceTangents } from './source-tangents';

describe('source tangent basis', () => {
	it('aligns tangent X and bitangent Y with glTF UV axes', () => {
		const tangents = computeSourceTangents({
			positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
			indices: new Uint32Array([0, 1, 2]),
			normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
			uvs: new Float32Array([0, 0, 1, 0, 0, 1])
		});

		expect(tangents[0]).toBeCloseTo(1, 5);
		expect(tangents[1]).toBeCloseTo(0, 5);
		expect(tangents[2]).toBeCloseTo(0, 5);
		expect(tangents[3]).toBe(1);
	});
});
