import { compactGeometry, filterDegenerateTriangles } from './compact';
import { nowMs, yieldToEventLoop } from './cooperative';
import { readVec3, vec3Create, vec3Cross, vec3Dot, vec3Len, vec3Normalize, vec3Sub, type Vec3 } from './math';
import { computeNormals } from './normals';
import { weldPositionSeams } from './surface-simplify';
import type { MeshGeometry } from './types';
import { triangleCountOf } from './types';

/** Crease lock: angle between face normals at or above this is a feature edge. */
export const HARD_SURFACE_FEATURE_DEGREES = 30;

/** Float-noise compare only. Not a spatial snap radius. */
export const HARD_SURFACE_POSITION_EPS = 1e-6;

export const HARD_SURFACE_YIELD_INTERVAL_MS = 250;

export type HardSurfaceOptions = {
	featureDegrees?: number;
	onProgress?: (value: number) => void;
	isCancelled?: () => boolean;
};

const AREA_EPS = 1e-20;
const EAR_AREA_EPS = 1e-16;

/**
 * Hard-surface feature-preserving collapse. Locks large-dihedral panel seams
 * and collapses only coplanar / near-coplanar interior edges. Every output
 * position is copied from an input vertex — no new verts, no QEM slide, not
 * Instant Meshes / organic remesh.
 *
 * Flat patches become larger faces, then fan/ear-triangulate using only those
 * existing verts so export stays on Kiln's triangle / GLB path.
 *
 * `targetTriangles` is the runGeometry ceiling. This kernel is crease-limited
 * and does not QEM-slide toward that count.
 */
export async function simplifyHardSurface(
	mesh: MeshGeometry,
	_targetTriangles: number,
	options: HardSurfaceOptions = {}
): Promise<MeshGeometry> {
	const featureDegrees = options.featureDegrees ?? HARD_SURFACE_FEATURE_DEGREES;
	const isCancelled = options.isCancelled ?? (() => false);
	const onProgress = options.onProgress ?? (() => undefined);
	onProgress(0.05);
	assertRunning(isCancelled);

	const welded = weldPositionSeams(mesh);
	const faceCount = triangleCountOf(welded.indices);
	if (faceCount <= 0) {
		onProgress(1);
		return welded;
	}

	onProgress(0.12);
	const faces = facesFromIndices(welded.indices);
	const normals: Vec3[] = [];
	for (let face = 0; face < faces.length; face++) {
		normals.push(faceNormal(welded.positions, faces[face] ?? [0, 0, 0]));
	}

	const cosFeature = Math.cos((featureDegrees * Math.PI) / 180);
	const edgeFaces = buildEdgeFaces(faces);
	const featureKeys = new Set<number>();
	for (const [key, users] of edgeFaces) {
		if (isCreaseEdge(users, normals, cosFeature)) featureKeys.add(key);
	}

	const parent = new Int32Array(faces.length);
	const seed = new Int32Array(faces.length);
	for (let face = 0; face < faces.length; face++) {
		parent[face] = face;
		seed[face] = face;
	}

	const find = (face: number): number => {
		let root = face;
		while (parent[root] !== root) root = parent[root] ?? root;
		let walk = face;
		while (walk !== root) {
			const next = parent[walk] ?? walk;
			parent[walk] = root;
			walk = next;
		}
		return root;
	};

	const unite = (a: number, b: number): void => {
		const ra = find(a);
		const rb = find(b);
		if (ra === rb) return;
		parent[rb] = ra;
		seed[rb] = seed[ra] ?? ra;
	};

	for (const [key, users] of edgeFaces) {
		if (users.length !== 2) continue;
		if (featureKeys.has(key)) continue;
		const f0 = users[0] ?? 0;
		const f1 = users[1] ?? 0;
		const n0 = normals[f0];
		const n1 = normals[f1];
		if (!n0 || !n1) continue;
		const r0 = find(f0);
		const r1 = find(f1);
		const s0 = normals[seed[r0] ?? r0];
		const s1 = normals[seed[r1] ?? r1];
		if (!s0 || !s1) continue;
		if (vec3Dot(n1, s0) <= cosFeature) continue;
		if (vec3Dot(n0, s1) <= cosFeature) continue;
		unite(f0, f1);
	}

	const groups = new Map<number, number[]>();
	for (let face = 0; face < faces.length; face++) {
		const root = find(face);
		const list = groups.get(root);
		if (list) list.push(face);
		else groups.set(root, [face]);
	}

	const outFaces: Face[] = [];
	let done = 0;
	let lastYield = nowMs();
	for (const members of groups.values()) {
		assertRunning(isCancelled);
		const now = nowMs();
		if (now - lastYield >= HARD_SURFACE_YIELD_INTERVAL_MS) {
			await yieldToEventLoop();
			lastYield = nowMs();
			assertRunning(isCancelled);
		}
		const replaced = retessellatePatch(welded.positions, faces, normals, members, edgeFaces);
		if (replaced) outFaces.push(...replaced);
		else {
			for (const face of members) {
				const tri = faces[face];
				if (tri) outFaces.push(tri);
			}
		}
		done++;
		onProgress(0.12 + (0.82 * done) / groups.size);
	}

	if (outFaces.length === 0) {
		onProgress(1);
		return welded;
	}

	const packed = new Uint32Array(outFaces.length * 3);
	for (let i = 0; i < outFaces.length; i++) {
		const tri = outFaces[i] ?? [0, 0, 0];
		packed[i * 3] = tri[0];
		packed[i * 3 + 1] = tri[1];
		packed[i * 3 + 2] = tri[2];
	}
	const compacted = compactGeometry(welded.positions, packed);
	const geometry = filterDegenerateTriangles({
		positions: compacted.positions,
		indices: compacted.indices,
		normals: computeNormals(compacted.positions, compacted.indices)
	});
	onProgress(1);
	return triangleCountOf(geometry.indices) > 0 ? geometry : welded;
}

/** Shared edges whose face-normal angle is at least `featureDegrees`. */
export function collectFeatureEdges(
	positions: Float32Array,
	indices: Uint32Array,
	featureDegrees = HARD_SURFACE_FEATURE_DEGREES
): Array<[number, number]> {
	const faces = facesFromIndices(indices);
	const normals: Vec3[] = [];
	for (let face = 0; face < faces.length; face++) {
		normals.push(faceNormal(positions, faces[face] ?? [0, 0, 0]));
	}
	const cosFeature = Math.cos((featureDegrees * Math.PI) / 180);
	const edges: Array<[number, number]> = [];
	for (const [key, users] of buildEdgeFaces(faces)) {
		if (!isCreaseEdge(users, normals, cosFeature)) continue;
		edges.push(unpackEdgeKey(key));
	}
	return edges;
}

export function positionExistsIn(
	x: number,
	y: number,
	z: number,
	positions: Float32Array,
	eps = HARD_SURFACE_POSITION_EPS
): boolean {
	const vertices = Math.floor(positions.length / 3);
	for (let vertex = 0; vertex < vertices; vertex++) {
		const dx = (positions[vertex * 3] ?? 0) - x;
		const dy = (positions[vertex * 3 + 1] ?? 0) - y;
		const dz = (positions[vertex * 3 + 2] ?? 0) - z;
		if (dx * dx + dy * dy + dz * dz <= eps * eps) return true;
	}
	return false;
}

type Face = [number, number, number];

function facesFromIndices(indices: Uint32Array): Face[] {
	const faces: Face[] = [];
	for (let i = 0; i + 2 < indices.length; i += 3) {
		faces.push([indices[i] ?? 0, indices[i + 1] ?? 0, indices[i + 2] ?? 0]);
	}
	return faces;
}

function packEdgeKey(a: number, b: number): number {
	const min = a < b ? a : b;
	const max = a < b ? b : a;
	return min * 0x1000000 + max;
}

function unpackEdgeKey(key: number): [number, number] {
	return [Math.floor(key / 0x1000000), key % 0x1000000];
}

function buildEdgeFaces(faces: Face[]): Map<number, number[]> {
	const edgeFaces = new Map<number, number[]>();
	const bump = (a: number, b: number, face: number) => {
		const key = packEdgeKey(a, b);
		const list = edgeFaces.get(key);
		if (list) list.push(face);
		else edgeFaces.set(key, [face]);
	};
	for (let face = 0; face < faces.length; face++) {
		const tri = faces[face] ?? [0, 0, 0];
		bump(tri[0], tri[1], face);
		bump(tri[1], tri[2], face);
		bump(tri[2], tri[0], face);
	}
	return edgeFaces;
}

function isCreaseEdge(users: number[], normals: Vec3[], cosFeature: number): boolean {
	if (users.length < 2) return false;
	for (let i = 0; i < users.length; i++) {
		const n0 = normals[users[i] ?? 0];
		if (!n0) continue;
		for (let j = i + 1; j < users.length; j++) {
			const n1 = normals[users[j] ?? 0];
			if (!n1) continue;
			if (vec3Dot(n0, n1) <= cosFeature) return true;
		}
	}
	return false;
}

function faceNormal(positions: Float32Array, tri: Face): Vec3 {
	const a = vec3Create();
	const b = vec3Create();
	const c = vec3Create();
	const e1 = vec3Create();
	const e2 = vec3Create();
	const n = vec3Create();
	readVec3(positions, tri[0], a);
	readVec3(positions, tri[1], b);
	readVec3(positions, tri[2], c);
	vec3Sub(b, a, e1);
	vec3Sub(c, a, e2);
	vec3Cross(e1, e2, n);
	return vec3Normalize(n, n);
}

function retessellatePatch(
	positions: Float32Array,
	faces: Face[],
	normals: Vec3[],
	members: number[],
	edgeFaces: Map<number, number[]>
): Face[] | null {
	if (members.length <= 2) return null;
	const inPatch = new Set(members);
	const halfEdges: Array<[number, number]> = [];
	const boundaryKeys = new Set<number>();

	for (const face of members) {
		const tri = faces[face];
		if (!tri) continue;
		const edges: Face = [tri[0], tri[1], tri[2]];
		const directed: Array<[number, number]> = [
			[edges[0], edges[1]],
			[edges[1], edges[2]],
			[edges[2], edges[0]]
		];
		for (const [a, b] of directed) {
			const key = packEdgeKey(a, b);
			const users = edgeFaces.get(key) ?? [];
			let inside = 0;
			for (const user of users) {
				if (inPatch.has(user)) inside++;
			}
			if (inside !== 1) continue;
			boundaryKeys.add(key);
			halfEdges.push([a, b]);
		}
	}

	const loops = walkBoundaryLoops(halfEdges);
	if (loops.length !== 1) return null;
	const loop = loops[0] ?? [];
	if (loop.length < 3) return null;

	const patchNormal = averageNormal(members, normals);
	const oriented = orientLoop(loop, positions, patchNormal);
	const indices = triangulateLoop(oriented, positions, patchNormal);
	if (!indices || indices.length < 9) return null;

	const next: Face[] = [];
	for (let i = 0; i + 2 < indices.length; i += 3) {
		const a = indices[i] ?? 0;
		const b = indices[i + 1] ?? 0;
		const c = indices[i + 2] ?? 0;
		if (a === b || b === c || c === a) continue;
		if (triangleArea2(positions, a, b, c) < AREA_EPS) continue;
		next.push([a, b, c]);
	}
	if (next.length === 0 || next.length >= members.length) return null;
	if (!preservesBoundaryEdges(next, boundaryKeys)) return null;
	return next;
}

function averageNormal(members: number[], normals: Vec3[]): Vec3 {
	const acc = vec3Create();
	for (const face of members) {
		const n = normals[face];
		if (!n) continue;
		acc[0] += n[0];
		acc[1] += n[1];
		acc[2] += n[2];
	}
	return vec3Normalize(acc, acc);
}

function walkBoundaryLoops(halfEdges: Array<[number, number]>): number[][] {
	const outgoing = new Map<number, number[]>();
	for (const [a, b] of halfEdges) {
		const list = outgoing.get(a);
		if (list) list.push(b);
		else outgoing.set(a, [b]);
	}
	const used = new Set<number>();
	const loops: number[][] = [];
	for (const [start, dests] of outgoing) {
		for (const dest of dests) {
			if (used.has(directedKey(start, dest))) continue;
			const loop = walkOneLoop(start, dest, outgoing, used);
			if (loop) loops.push(loop);
		}
	}
	return loops;
}

function walkOneLoop(
	start: number,
	firstDest: number,
	outgoing: Map<number, number[]>,
	used: Set<number>
): number[] | null {
	const loop: number[] = [start];
	let current = start;
	let next = firstDest;
	const begin = start;
	for (let step = 0; step < outgoing.size + 2; step++) {
		if (used.has(directedKey(current, next))) return null;
		used.add(directedKey(current, next));
		loop.push(next);
		if (next === begin) {
			loop.pop();
			return loop.length >= 3 ? loop : null;
		}
		const choices = (outgoing.get(next) ?? []).filter((dest) => !used.has(directedKey(next, dest)));
		if (choices.length !== 1) return null;
		current = next;
		next = choices[0] ?? next;
	}
	return null;
}

function directedKey(a: number, b: number): number {
	return a * 0x2000000 + b;
}

function orientLoop(loop: number[], positions: Float32Array, patchNormal: Vec3): number[] {
	const acc = vec3Create();
	const a = vec3Create();
	const b = vec3Create();
	const c = vec3Create();
	const e1 = vec3Create();
	const e2 = vec3Create();
	const n = vec3Create();
	for (let i = 0; i < loop.length; i++) {
		const i0 = loop[i] ?? 0;
		const i1 = loop[(i + 1) % loop.length] ?? 0;
		const i2 = loop[(i + 2) % loop.length] ?? 0;
		readVec3(positions, i0, a);
		readVec3(positions, i1, b);
		readVec3(positions, i2, c);
		vec3Sub(b, a, e1);
		vec3Sub(c, a, e2);
		vec3Cross(e1, e2, n);
		acc[0] += n[0];
		acc[1] += n[1];
		acc[2] += n[2];
	}
	if (vec3Dot(acc, patchNormal) < 0) return loop.slice().reverse();
	return loop;
}

function triangulateLoop(loop: number[], positions: Float32Array, patchNormal: Vec3): number[] | null {
	if (loop.length < 3) return null;
	if (loop.length === 3) {
		if (triangleArea2(positions, loop[0] ?? 0, loop[1] ?? 0, loop[2] ?? 0) < AREA_EPS) return null;
		return [loop[0] ?? 0, loop[1] ?? 0, loop[2] ?? 0];
	}

	const basis = projectionBasis(patchNormal);
	const xy = new Map<number, [number, number]>();
	for (const vertex of loop) {
		xy.set(vertex, project2d(positions, vertex, basis));
	}
	const poly = loop.slice();
	if (signedArea(poly, xy) < 0) poly.reverse();

	const out: number[] = [];
	const guardLimit = poly.length * poly.length;
	let guard = 0;
	while (poly.length > 3) {
		if (guard++ > guardLimit) return null;
		let ear = -1;
		for (let i = 0; i < poly.length; i++) {
			if (isEar(i, poly, xy)) {
				ear = i;
				break;
			}
		}
		if (ear < 0) return null;
		const prev = poly[(ear - 1 + poly.length) % poly.length] ?? 0;
		const curr = poly[ear] ?? 0;
		const next = poly[(ear + 1) % poly.length] ?? 0;
		out.push(prev, curr, next);
		poly.splice(ear, 1);
	}
	if (triangleArea2(positions, poly[0] ?? 0, poly[1] ?? 0, poly[2] ?? 0) < AREA_EPS) return null;
	out.push(poly[0] ?? 0, poly[1] ?? 0, poly[2] ?? 0);
	return out;
}

function projectionBasis(normal: Vec3): { u: Vec3; v: Vec3 } {
	const axis: Vec3 = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
	const u = vec3Create();
	const v = vec3Create();
	vec3Normalize(vec3Cross(normal, axis, u), u);
	vec3Cross(normal, u, v);
	return { u, v };
}

function project2d(
	positions: Float32Array,
	vertex: number,
	basis: { u: Vec3; v: Vec3 }
): [number, number] {
	const p = vec3Create();
	readVec3(positions, vertex, p);
	return [vec3Dot(p, basis.u), vec3Dot(p, basis.v)];
}

function signedArea(poly: number[], xy: Map<number, [number, number]>): number {
	let area = 0;
	for (let i = 0; i < poly.length; i++) {
		const a = xy.get(poly[i] ?? 0) ?? [0, 0];
		const b = xy.get(poly[(i + 1) % poly.length] ?? 0) ?? [0, 0];
		area += a[0] * b[1] - a[1] * b[0];
	}
	return area * 0.5;
}

function isEar(index: number, poly: number[], xy: Map<number, [number, number]>): boolean {
	const a = poly[(index - 1 + poly.length) % poly.length] ?? 0;
	const b = poly[index] ?? 0;
	const c = poly[(index + 1) % poly.length] ?? 0;
	const pa = xy.get(a) ?? [0, 0];
	const pb = xy.get(b) ?? [0, 0];
	const pc = xy.get(c) ?? [0, 0];
	const cross = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0]);
	if (cross <= EAR_AREA_EPS) return false;
	for (let i = 0; i < poly.length; i++) {
		const vertex = poly[i] ?? 0;
		if (vertex === a || vertex === b || vertex === c) continue;
		if (pointInTriangle(xy.get(vertex) ?? [0, 0], pa, pb, pc)) return false;
	}
	return true;
}

function pointInTriangle(
	p: [number, number],
	a: [number, number],
	b: [number, number],
	c: [number, number]
): boolean {
	const c0 = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
	const c1 = (c[0] - b[0]) * (p[1] - b[1]) - (c[1] - b[1]) * (p[0] - b[0]);
	const c2 = (a[0] - c[0]) * (p[1] - c[1]) - (a[1] - c[1]) * (p[0] - c[0]);
	const hasNeg = c0 < -EAR_AREA_EPS || c1 < -EAR_AREA_EPS || c2 < -EAR_AREA_EPS;
	const hasPos = c0 > EAR_AREA_EPS || c1 > EAR_AREA_EPS || c2 > EAR_AREA_EPS;
	return !(hasNeg && hasPos);
}

function triangleArea2(positions: Float32Array, a: number, b: number, c: number): number {
	const pa = vec3Create();
	const pb = vec3Create();
	const pc = vec3Create();
	const e1 = vec3Create();
	const e2 = vec3Create();
	const n = vec3Create();
	readVec3(positions, a, pa);
	readVec3(positions, b, pb);
	readVec3(positions, c, pc);
	vec3Sub(pb, pa, e1);
	vec3Sub(pc, pa, e2);
	vec3Cross(e1, e2, n);
	return vec3Len(n) * 0.5;
}

function preservesBoundaryEdges(faces: Face[], boundaryKeys: Set<number>): boolean {
	const remaining = new Set(boundaryKeys);
	for (const tri of faces) {
		remaining.delete(packEdgeKey(tri[0], tri[1]));
		remaining.delete(packEdgeKey(tri[1], tri[2]));
		remaining.delete(packEdgeKey(tri[2], tri[0]));
	}
	return remaining.size === 0;
}

function assertRunning(isCancelled: () => boolean): void {
	if (isCancelled()) throw new Error('cancelled');
}
