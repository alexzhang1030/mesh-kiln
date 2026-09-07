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
 * and collapses only non-feature edges onto an existing endpoint. Every output
 * position is copied from an input vertex — no new verts, no QEM slide, not
 * Instant Meshes / organic remesh.
 *
 * `targetTriangles` is a ceiling, same as the other Kiln geometry paths.
 * After feature lock + coplanar patch merge, legal endpoint collapses continue
 * until the count is at or below the ceiling or no legal collapse remains.
 * A crease mesh may stop above the budget if every remaining edge is locked.
 */
export async function simplifyHardSurface(
	mesh: MeshGeometry,
	targetTriangles: number,
	options: HardSurfaceOptions = {}
): Promise<MeshGeometry> {
	const featureDegrees = options.featureDegrees ?? HARD_SURFACE_FEATURE_DEGREES;
	const isCancelled = options.isCancelled ?? (() => false);
	const onProgress = options.onProgress ?? (() => undefined);
	onProgress(0.04);
	assertRunning(isCancelled);

	const welded = weldPositionSeams(mesh);
	const target = Math.max(1, Math.floor(targetTriangles));
	const sourceCount = triangleCountOf(welded.indices);
	if (sourceCount <= 0) {
		onProgress(1);
		return welded;
	}
	if (sourceCount <= target) {
		onProgress(1);
		return finalizeFaces(welded.positions, facesFromIndices(welded.indices), welded);
	}

	onProgress(0.1);
	const sourceFaces = facesFromIndices(welded.indices);
	const sourceNormals: Vec3[] = [];
	for (let face = 0; face < sourceFaces.length; face++) {
		sourceNormals.push(faceNormal(welded.positions, sourceFaces[face] ?? [0, 0, 0]));
	}

	const cosFeature = Math.cos((featureDegrees * Math.PI) / 180);
	const sourceEdges = buildEdgeFaces(sourceFaces);
	const featureKeys = new Set<number>();
	for (const [key, users] of sourceEdges) {
		if (isCreaseEdge(users, sourceNormals, cosFeature)) featureKeys.add(key);
	}
	const featureVerts = new Set<number>();
	for (const key of featureKeys) {
		const [a, b] = unpackEdgeKey(key);
		featureVerts.add(a);
		featureVerts.add(b);
	}

	onProgress(0.16);
	const merged = await mergeCoplanarPatches(
		welded.positions,
		sourceFaces,
		sourceNormals,
		sourceEdges,
		featureKeys,
		cosFeature,
		(value) => onProgress(0.16 + value * 0.24),
		isCancelled
	);
	const working = merged.length > 0 ? merged : sourceFaces;
	if (working.length <= target) {
		onProgress(1);
		return finalizeFaces(welded.positions, working, welded);
	}

	onProgress(0.42);
	const collapsed = await collapseToBudget(
		welded.positions,
		working,
		featureKeys,
		featureVerts,
		target,
		(value) => onProgress(0.42 + value * 0.54),
		isCancelled
	);
	onProgress(1);
	return finalizeFaces(welded.positions, collapsed, welded);
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

type LiveFace = {
	verts: Face;
	deleted: boolean;
};

type CollapseCand = {
	remove: number;
	keep: number;
	score: number;
};

const FLIP_DOT = 0;

function finalizeFaces(positions: Float32Array, faces: Face[], fallback: MeshGeometry): MeshGeometry {
	if (faces.length === 0) return fallback;
	const packed = new Uint32Array(faces.length * 3);
	for (let i = 0; i < faces.length; i++) {
		const tri = faces[i] ?? [0, 0, 0];
		packed[i * 3] = tri[0];
		packed[i * 3 + 1] = tri[1];
		packed[i * 3 + 2] = tri[2];
	}
	const compacted = compactGeometry(positions, packed);
	const geometry = filterDegenerateTriangles({
		positions: compacted.positions,
		indices: compacted.indices,
		normals: computeNormals(compacted.positions, compacted.indices)
	});
	return triangleCountOf(geometry.indices) > 0 ? geometry : fallback;
}

async function mergeCoplanarPatches(
	positions: Float32Array,
	faces: Face[],
	normals: Vec3[],
	edgeFaces: Map<number, number[]>,
	featureKeys: Set<number>,
	cosFeature: number,
	onProgress: (value: number) => void,
	isCancelled: () => boolean
): Promise<Face[]> {
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
		const replaced = retessellatePatch(positions, faces, normals, members, edgeFaces);
		if (replaced) outFaces.push(...replaced);
		else {
			for (const face of members) {
				const tri = faces[face];
				if (tri) outFaces.push(tri);
			}
		}
		done++;
		onProgress(done / Math.max(1, groups.size));
	}
	return outFaces;
}

async function collapseToBudget(
	positions: Float32Array,
	inputFaces: Face[],
	featureKeys: Set<number>,
	featureVerts: Set<number>,
	target: number,
	onProgress: (value: number) => void,
	isCancelled: () => boolean
): Promise<Face[]> {
	const vertexCount = Math.floor(positions.length / 3);
	const live: LiveFace[] = inputFaces.map((verts) => ({ verts, deleted: false }));
	const vertFaces: Array<Set<number>> = Array.from({ length: vertexCount }, () => new Set());
	for (let face = 0; face < live.length; face++) {
		const tri = live[face]?.verts;
		if (!tri) continue;
		vertFaces[tri[0]]?.add(face);
		vertFaces[tri[1]]?.add(face);
		vertFaces[tri[2]]?.add(face);
	}
	let faceCount = inputFaces.length;
	const start = faceCount;
	let lastYield = nowMs();

	const featureDist = minFeatureDistance(positions, featureVerts, vertexCount);

	while (faceCount > target) {
		assertRunning(isCancelled);
		const now = nowMs();
		if (now - lastYield >= HARD_SURFACE_YIELD_INTERVAL_MS) {
			await yieldToEventLoop();
			lastYield = nowMs();
			assertRunning(isCancelled);
		}

		const candidates = collectCollapseCandidates(
			positions,
			live,
			vertFaces,
			featureKeys,
			featureVerts,
			featureDist
		);
		if (candidates.length === 0) break;
		candidates.sort((a, b) => b.score - a.score);

		const blocked = new Set<number>();
		let collapsed = 0;
		for (const cand of candidates) {
			if (faceCount <= target) break;
			if (blocked.has(cand.remove) || blocked.has(cand.keep)) continue;
			if (!collapseIsLegal(positions, live, vertFaces, featureKeys, cand.remove, cand.keep)) continue;
			const before = faceCount;
			faceCount = applyCollapse(live, vertFaces, cand.remove, cand.keep, faceCount);
			if (faceCount >= before) continue;
			collapsed++;
			blocked.add(cand.remove);
			blocked.add(cand.keep);
			for (const neighbor of vertexNeighbors(vertFaces, live, cand.keep)) blocked.add(neighbor);
		}
		if (collapsed === 0) break;
		onProgress(Math.min(1, (start - faceCount) / Math.max(1, start - target)));
	}

	const kept: Face[] = [];
	for (const face of live) {
		if (!face.deleted) kept.push(face.verts);
	}
	return kept;
}

function minFeatureDistance(positions: Float32Array, featureVerts: Set<number>, vertexCount: number): Float64Array {
	const dist = new Float64Array(vertexCount);
	if (featureVerts.size === 0) return dist;
	const fx: number[] = [];
	const fy: number[] = [];
	const fz: number[] = [];
	for (const vertex of featureVerts) {
		fx.push(positions[vertex * 3] ?? 0);
		fy.push(positions[vertex * 3 + 1] ?? 0);
		fz.push(positions[vertex * 3 + 2] ?? 0);
	}
	for (let vertex = 0; vertex < vertexCount; vertex++) {
		if (featureVerts.has(vertex)) {
			dist[vertex] = 0;
			continue;
		}
		const x = positions[vertex * 3] ?? 0;
		const y = positions[vertex * 3 + 1] ?? 0;
		const z = positions[vertex * 3 + 2] ?? 0;
		let best = Infinity;
		for (let i = 0; i < fx.length; i++) {
			const dx = x - (fx[i] ?? 0);
			const dy = y - (fy[i] ?? 0);
			const dz = z - (fz[i] ?? 0);
			const d = dx * dx + dy * dy + dz * dz;
			if (d < best) best = d;
		}
		dist[vertex] = best;
	}
	return dist;
}

function collectCollapseCandidates(
	positions: Float32Array,
	live: LiveFace[],
	vertFaces: Array<Set<number>>,
	featureKeys: Set<number>,
	featureVerts: Set<number>,
	featureDist: Float64Array
): CollapseCand[] {
	const seen = new Set<number>();
	const candidates: CollapseCand[] = [];
	for (let fi = 0; fi < live.length; fi++) {
		const face = live[fi];
		if (!face || face.deleted) continue;
		const [a, b, c] = face.verts;
		const edges: Array<[number, number]> = [
			[a, b],
			[b, c],
			[c, a]
		];
		for (const [u, v] of edges) {
			const key = packEdgeKey(u, v);
			if (seen.has(key)) continue;
			seen.add(key);
			if (featureKeys.has(key)) continue;
			const featU = featureVerts.has(u);
			const featV = featureVerts.has(v);
			if (featU && featV) continue;
			const users = edgeIncidentCount(vertFaces, live, u, v);
			if (users < 1 || users > 2) continue;

			let remove = u;
			let keep = v;
			if (featU && !featV) {
				remove = v;
				keep = u;
			} else if (featV && !featU) {
				remove = u;
				keep = v;
			} else if ((featureDist[u] ?? 0) < (featureDist[v] ?? 0)) {
				remove = v;
				keep = u;
			}

			if (!collapseIsLegal(positions, live, vertFaces, featureKeys, remove, keep)) {
				if (featU || featV) continue;
				if (!collapseIsLegal(positions, live, vertFaces, featureKeys, keep, remove)) continue;
				const swap = remove;
				remove = keep;
				keep = swap;
			}

			const n0 = faceNormal(positions, face.verts);
			const other = oppositeFace(vertFaces, live, u, v, fi);
			const n1 = other ? faceNormal(positions, other.verts) : n0;
			const flat = clamp01(vec3Dot(n0, n1));
			const length = edgeLength(positions, u, v);
			const interior = featU || featV ? 0 : 1_000_000;
			const away = featureDist[remove] ?? 0;
			candidates.push({
				remove,
				keep,
				score: interior + away * 10 + flat * 1_000 - length
			});
		}
	}
	return candidates;
}

function collapseIsLegal(
	positions: Float32Array,
	live: LiveFace[],
	vertFaces: Array<Set<number>>,
	featureKeys: Set<number>,
	remove: number,
	keep: number
): boolean {
	if (remove === keep) return false;
	if (featureKeys.has(packEdgeKey(remove, keep))) return false;
	const star = vertFaces[remove];
	if (!star || star.size === 0) return false;
	if (!sharesEdge(live, star, remove, keep)) return false;
	if (!linkCondition(vertFaces, live, remove, keep)) return false;
	if (collapseFlips(positions, live, star, remove, keep)) return false;
	if (collapseDropsFeature(live, vertFaces, featureKeys, remove, keep)) return false;
	return true;
}

function sharesEdge(live: LiveFace[], star: Set<number>, remove: number, keep: number): boolean {
	for (const fi of star) {
		const face = live[fi];
		if (!face || face.deleted) continue;
		if (faceHasVertex(face.verts, keep)) return true;
	}
	return false;
}

function linkCondition(
	vertFaces: Array<Set<number>>,
	live: LiveFace[],
	remove: number,
	keep: number
): boolean {
	const keepNeighbors = vertexNeighbors(vertFaces, live, keep);
	const shared = new Set<number>();
	for (const vertex of vertexNeighbors(vertFaces, live, remove)) {
		if (vertex === keep) continue;
		if (keepNeighbors.has(vertex)) shared.add(vertex);
	}
	const opposites = new Set<number>();
	for (const fi of vertFaces[remove] ?? []) {
		const face = live[fi];
		if (!face || face.deleted) continue;
		if (!faceHasVertex(face.verts, keep)) continue;
		for (const vertex of face.verts) {
			if (vertex !== remove && vertex !== keep) opposites.add(vertex);
		}
	}
	if (opposites.size === 0 || opposites.size > 2) return false;
	if (shared.size !== opposites.size) return false;
	for (const vertex of opposites) {
		if (!shared.has(vertex)) return false;
	}
	return true;
}

function collapseFlips(
	positions: Float32Array,
	live: LiveFace[],
	star: Set<number>,
	remove: number,
	keep: number
): boolean {
	for (const fi of star) {
		const face = live[fi];
		if (!face || face.deleted) continue;
		const remapped = remapFace(face.verts, remove, keep);
		if (!remapped) continue;
		const next = faceNormal(positions, remapped);
		const prev = faceNormal(positions, face.verts);
		if (vec3Dot(prev, next) < FLIP_DOT) return true;
	}
	return false;
}

function collapseDropsFeature(
	live: LiveFace[],
	vertFaces: Array<Set<number>>,
	featureKeys: Set<number>,
	remove: number,
	keep: number
): boolean {
	const star = vertFaces[remove] ?? new Set();
	const affected = new Set<number>();
	for (const fi of star) {
		const face = live[fi];
		if (!face || face.deleted) continue;
		affected.add(packEdgeKey(face.verts[0], face.verts[1]));
		affected.add(packEdgeKey(face.verts[1], face.verts[2]));
		affected.add(packEdgeKey(face.verts[2], face.verts[0]));
	}
	for (const key of affected) {
		if (!featureKeys.has(key)) continue;
		const [fa, fb] = unpackEdgeKey(key);
		let survived = false;
		const carriers = facesWithEdge(vertFaces, live, fa, fb);
		for (const fi of carriers) {
			const face = live[fi];
			if (!face || face.deleted) continue;
			if (!star.has(fi)) {
				survived = true;
				break;
			}
			const remapped = remapFace(face.verts, remove, keep);
			if (remapped && faceHasEdge(remapped, fa, fb)) {
				survived = true;
				break;
			}
		}
		if (!survived) return true;
	}
	return false;
}

function applyCollapse(
	live: LiveFace[],
	vertFaces: Array<Set<number>>,
	remove: number,
	keep: number,
	faceCount: number
): number {
	const star = [...(vertFaces[remove] ?? [])];
	for (const fi of star) {
		const face = live[fi];
		if (!face || face.deleted) continue;
		for (const vertex of face.verts) vertFaces[vertex]?.delete(fi);
		const remapped = remapFace(face.verts, remove, keep);
		if (!remapped) {
			face.deleted = true;
			faceCount--;
			continue;
		}
		face.verts = remapped;
		for (const vertex of remapped) vertFaces[vertex]?.add(fi);
	}
	vertFaces[remove]?.clear();
	return faceCount;
}

function remapFace(tri: Face, remove: number, keep: number): Face | null {
	const a = tri[0] === remove ? keep : tri[0];
	const b = tri[1] === remove ? keep : tri[1];
	const c = tri[2] === remove ? keep : tri[2];
	if (a === b || b === c || c === a) return null;
	return [a, b, c];
}

function vertexNeighbors(vertFaces: Array<Set<number>>, live: LiveFace[], vertex: number): Set<number> {
	const neighbors = new Set<number>();
	for (const fi of vertFaces[vertex] ?? []) {
		const face = live[fi];
		if (!face || face.deleted) continue;
		for (const other of face.verts) {
			if (other !== vertex) neighbors.add(other);
		}
	}
	return neighbors;
}

function faceHasVertex(tri: Face, vertex: number): boolean {
	return tri[0] === vertex || tri[1] === vertex || tri[2] === vertex;
}

function faceHasEdge(tri: Face, a: number, b: number): boolean {
	return (
		(tri[0] === a && tri[1] === b) ||
		(tri[1] === a && tri[2] === b) ||
		(tri[2] === a && tri[0] === b) ||
		(tri[0] === b && tri[1] === a) ||
		(tri[1] === b && tri[2] === a) ||
		(tri[2] === b && tri[0] === a)
	);
}

function facesWithEdge(
	vertFaces: Array<Set<number>>,
	live: LiveFace[],
	a: number,
	b: number
): number[] {
	const out: number[] = [];
	for (const fi of vertFaces[a] ?? []) {
		const face = live[fi];
		if (!face || face.deleted) continue;
		if (faceHasVertex(face.verts, b)) out.push(fi);
	}
	return out;
}

function edgeIncidentCount(
	vertFaces: Array<Set<number>>,
	live: LiveFace[],
	a: number,
	b: number
): number {
	return facesWithEdge(vertFaces, live, a, b).length;
}

function oppositeFace(
	vertFaces: Array<Set<number>>,
	live: LiveFace[],
	a: number,
	b: number,
	self: number
): LiveFace | null {
	for (const fi of facesWithEdge(vertFaces, live, a, b)) {
		if (fi === self) continue;
		const face = live[fi];
		if (face && !face.deleted) return face;
	}
	return null;
}

function edgeLength(positions: Float32Array, a: number, b: number): number {
	const dx = (positions[a * 3] ?? 0) - (positions[b * 3] ?? 0);
	const dy = (positions[a * 3 + 1] ?? 0) - (positions[b * 3 + 1] ?? 0);
	const dz = (positions[a * 3 + 2] ?? 0) - (positions[b * 3 + 2] ?? 0);
	return Math.hypot(dx, dy, dz);
}

function clamp01(value: number): number {
	if (value <= 0) return 0;
	if (value >= 1) return 1;
	return value;
}

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
