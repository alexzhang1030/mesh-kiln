import { describe, expect, it } from 'vitest';
import {
	HARD_SURFACE_FEATURE_DEGREES,
	HARD_SURFACE_POSITION_EPS,
	collectFeatureEdges,
	positionExistsIn,
	simplifyHardSurface
} from './hardsurface';
import { computeNormals } from './normals';
import { weldPositionSeams } from './surface-simplify';
import type { MeshGeometry } from './types';
import { triangleCountOf, vertexCountOf } from './types';

describe('hard-surface kernel', () => {
	it('drops redundant loops on a flat panel and keeps only input positions', async () => {
		const input = createGridPanel(8);
		expect(vertexCountOf(input.positions)).toBe(81);
		expect(triangleCountOf(input.indices)).toBe(128);

		const reduced = await simplifyHardSurface(input, 8);
		expect(vertexCountOf(reduced.positions)).toBeLessThan(vertexCountOf(input.positions));
		expect(triangleCountOf(reduced.indices)).toBeLessThan(triangleCountOf(input.indices));
		expect(triangleCountOf(reduced.indices)).toBeGreaterThan(0);
		assertEveryOutputVertexInInput(reduced, input);
	});

	it('never collapses large-dihedral feature edges on a beveled box', async () => {
		const input = createBeveledBox(4, 0.28);
		const welded = weldPositionSeams(input);
		const creases = collectFeatureEdges(welded.positions, welded.indices, 40);
		expect(creases.length).toBeGreaterThan(8);

		const reduced = await simplifyHardSurface(input, 16);
		expect(vertexCountOf(reduced.positions)).toBeLessThan(vertexCountOf(welded.positions));
		expect(triangleCountOf(reduced.indices)).toBeLessThan(triangleCountOf(welded.indices));
		assertEveryOutputVertexInInput(reduced, input);
		assertFeatureEdgesSurvive(welded, creases, reduced);
	});

	it('locks the twelve 90-degree edges of a segmented box', async () => {
		const input = createSegmentedBox(3);
		const welded = weldPositionSeams(input);
		const creases = collectFeatureEdges(welded.positions, welded.indices, HARD_SURFACE_FEATURE_DEGREES);
		expect(creases.length).toBeGreaterThanOrEqual(12);

		const reduced = await simplifyHardSurface(input, 12);
		expect(vertexCountOf(reduced.positions)).toBeLessThan(vertexCountOf(welded.positions));
		assertEveryOutputVertexInInput(reduced, input);
		assertFeatureEdgesSurvive(welded, creases, reduced);
	});
});

function assertEveryOutputVertexInInput(output: MeshGeometry, input: MeshGeometry): void {
	const vertices = vertexCountOf(output.positions);
	expect(vertices).toBeGreaterThan(0);
	for (let vertex = 0; vertex < vertices; vertex++) {
		const x = output.positions[vertex * 3] ?? 0;
		const y = output.positions[vertex * 3 + 1] ?? 0;
		const z = output.positions[vertex * 3 + 2] ?? 0;
		expect(
			positionExistsIn(x, y, z, input.positions, HARD_SURFACE_POSITION_EPS),
			`output vertex ${vertex} (${x}, ${y}, ${z}) is not in the input position set`
		).toBe(true);
	}
}

function assertFeatureEdgesSurvive(
	source: MeshGeometry,
	creases: Array<[number, number]>,
	output: MeshGeometry
): void {
	const outputEdges = positionEdgeSet(output);
	for (const [ia, ib] of creases) {
		const a: [number, number, number] = [
			source.positions[ia * 3] ?? 0,
			source.positions[ia * 3 + 1] ?? 0,
			source.positions[ia * 3 + 2] ?? 0
		];
		const b: [number, number, number] = [
			source.positions[ib * 3] ?? 0,
			source.positions[ib * 3 + 1] ?? 0,
			source.positions[ib * 3 + 2] ?? 0
		];
		expect(
			positionExistsIn(a[0], a[1], a[2], output.positions),
			`feature vertex ${a.join(',')} was removed`
		).toBe(true);
		expect(
			positionExistsIn(b[0], b[1], b[2], output.positions),
			`feature vertex ${b.join(',')} was removed`
		).toBe(true);
		expect(outputEdges.has(positionEdgeKey(a, b)), `feature edge ${a.join(',')} — ${b.join(',')} was collapsed`).toBe(
			true
		);
	}
}

function positionEdgeSet(mesh: MeshGeometry): Set<string> {
	const keys = new Set<string>();
	for (let i = 0; i + 2 < mesh.indices.length; i += 3) {
		const a = vertexPosition(mesh.positions, mesh.indices[i] ?? 0);
		const b = vertexPosition(mesh.positions, mesh.indices[i + 1] ?? 0);
		const c = vertexPosition(mesh.positions, mesh.indices[i + 2] ?? 0);
		keys.add(positionEdgeKey(a, b));
		keys.add(positionEdgeKey(b, c));
		keys.add(positionEdgeKey(c, a));
	}
	return keys;
}

function vertexPosition(positions: Float32Array, index: number): [number, number, number] {
	return [positions[index * 3] ?? 0, positions[index * 3 + 1] ?? 0, positions[index * 3 + 2] ?? 0];
}

function positionEdgeKey(a: [number, number, number], b: [number, number, number]): string {
	const left = `${roundEps(a[0])}:${roundEps(a[1])}:${roundEps(a[2])}`;
	const right = `${roundEps(b[0])}:${roundEps(b[1])}:${roundEps(b[2])}`;
	return left < right ? `${left}|${right}` : `${right}|${left}`;
}

function roundEps(value: number): string {
	return (Math.round(value / HARD_SURFACE_POSITION_EPS) * HARD_SURFACE_POSITION_EPS).toFixed(6);
}

function createGridPanel(segments: number): MeshGeometry {
	return gridQuad([0, 0, 0], [1, 0, 0], [0, 1, 0], segments, segments);
}

function createSegmentedBox(segments: number): MeshGeometry {
	const s = 1;
	const faces = [
		gridQuad([-s, -s, s], [2 * s, 0, 0], [0, 2 * s, 0], segments, segments),
		gridQuad([s, -s, -s], [-2 * s, 0, 0], [0, 2 * s, 0], segments, segments),
		gridQuad([s, -s, s], [0, 0, -2 * s], [0, 2 * s, 0], segments, segments),
		gridQuad([-s, -s, -s], [0, 0, 2 * s], [0, 2 * s, 0], segments, segments),
		gridQuad([-s, s, s], [2 * s, 0, 0], [0, 0, -2 * s], segments, segments),
		gridQuad([-s, -s, -s], [2 * s, 0, 0], [0, 0, 2 * s], segments, segments)
	];
	return weldPositionSeams(mergeGeometries(faces));
}

function createBeveledBox(segments: number, bevel: number): MeshGeometry {
	const s = 1;
	const b = bevel;
	const e = s - b;
	const parts: MeshGeometry[] = [
		gridQuad([-e, -e, s], [2 * e, 0, 0], [0, 2 * e, 0], segments, segments),
		gridQuad([e, -e, -s], [-2 * e, 0, 0], [0, 2 * e, 0], segments, segments),
		gridQuad([s, -e, e], [0, 0, -2 * e], [0, 2 * e, 0], segments, segments),
		gridQuad([-s, -e, -e], [0, 0, 2 * e], [0, 2 * e, 0], segments, segments),
		gridQuad([-e, s, e], [2 * e, 0, 0], [0, 0, -2 * e], segments, segments),
		gridQuad([-e, -s, -e], [2 * e, 0, 0], [0, 0, 2 * e], segments, segments),
		gridQuad([e, -e, s], [0, 2 * e, 0], [b, 0, -b], segments, 1),
		gridQuad([-e, e, s], [0, -2 * e, 0], [-b, 0, -b], segments, 1),
		gridQuad([-e, e, s], [2 * e, 0, 0], [0, b, -b], segments, 1),
		gridQuad([e, -e, s], [-2 * e, 0, 0], [0, -b, -b], segments, 1),
		gridQuad([e, e, -s], [0, -2 * e, 0], [b, 0, b], segments, 1),
		gridQuad([-e, -e, -s], [0, 2 * e, 0], [-b, 0, b], segments, 1),
		gridQuad([e, e, -s], [-2 * e, 0, 0], [0, b, b], segments, 1),
		gridQuad([-e, -e, -s], [2 * e, 0, 0], [0, -b, b], segments, 1),
		gridQuad([s, e, e], [0, 0, -2 * e], [-b, b, 0], segments, 1),
		gridQuad([s, -e, -e], [0, 0, 2 * e], [-b, -b, 0], segments, 1),
		gridQuad([-s, e, -e], [0, 0, 2 * e], [b, b, 0], segments, 1),
		gridQuad([-s, -e, e], [0, 0, -2 * e], [b, -b, 0], segments, 1)
	];
	const corners: Array<[[number, number, number], [number, number, number], [number, number, number]]> = [
		[
			[e, e, s],
			[s, e, e],
			[e, s, e]
		],
		[
			[-e, e, s],
			[-e, s, e],
			[-s, e, e]
		],
		[
			[e, -e, s],
			[e, -s, e],
			[s, -e, e]
		],
		[
			[-e, -e, s],
			[-s, -e, e],
			[-e, -s, e]
		],
		[
			[e, e, -s],
			[e, s, -e],
			[s, e, -e]
		],
		[
			[-e, e, -s],
			[-s, e, -e],
			[-e, s, -e]
		],
		[
			[e, -e, -s],
			[s, -e, -e],
			[e, -s, -e]
		],
		[
			[-e, -e, -s],
			[-e, -s, -e],
			[-s, -e, -e]
		]
	];
	for (const [a, b, c] of corners) {
		parts.push(triangleGeom(a, b, c));
	}
	return weldPositionSeams(mergeGeometries(parts));
}

function gridQuad(
	origin: [number, number, number],
	uDir: [number, number, number],
	vDir: [number, number, number],
	segU: number,
	segV: number
): MeshGeometry {
	const positions: number[] = [];
	for (let v = 0; v <= segV; v++) {
		const tv = v / segV;
		for (let u = 0; u <= segU; u++) {
			const tu = u / segU;
			positions.push(
				origin[0] + uDir[0] * tu + vDir[0] * tv,
				origin[1] + uDir[1] * tu + vDir[1] * tv,
				origin[2] + uDir[2] * tu + vDir[2] * tv
			);
		}
	}
	const indices: number[] = [];
	const stride = segU + 1;
	for (let v = 0; v < segV; v++) {
		for (let u = 0; u < segU; u++) {
			const a = v * stride + u;
			const b = a + stride;
			indices.push(a, a + 1, b, a + 1, b + 1, b);
		}
	}
	const pos = Float32Array.from(positions);
	const idx = Uint32Array.from(indices);
	return { positions: pos, indices: idx, normals: computeNormals(pos, idx) };
}

function triangleGeom(
	a: [number, number, number],
	b: [number, number, number],
	c: [number, number, number]
): MeshGeometry {
	const toward = [a[0] + b[0] + c[0], a[1] + b[1] + c[1], a[2] + b[2] + c[2]] as const;
	const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as const;
	const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]] as const;
	const nx = e1[1] * e2[2] - e1[2] * e2[1];
	const ny = e1[2] * e2[0] - e1[0] * e2[2];
	const nz = e1[0] * e2[1] - e1[1] * e2[0];
	const flip = nx * toward[0] + ny * toward[1] + nz * toward[2] < 0;
	const positions = flip ? Float32Array.from([...a, ...c, ...b]) : Float32Array.from([...a, ...b, ...c]);
	const indices = new Uint32Array([0, 1, 2]);
	return { positions, indices, normals: computeNormals(positions, indices) };
}

function mergeGeometries(parts: MeshGeometry[]): MeshGeometry {
	let vertCount = 0;
	let indexCount = 0;
	for (const part of parts) {
		vertCount += vertexCountOf(part.positions);
		indexCount += part.indices.length;
	}
	const positions = new Float32Array(vertCount * 3);
	const normals = new Float32Array(vertCount * 3);
	const indices = new Uint32Array(indexCount);
	let v = 0;
	let t = 0;
	for (const part of parts) {
		const base = v;
		positions.set(part.positions, v * 3);
		normals.set(part.normals, v * 3);
		for (let i = 0; i < part.indices.length; i++) {
			indices[t++] = base + (part.indices[i] ?? 0);
		}
		v += vertexCountOf(part.positions);
	}
	return { positions, indices, normals };
}