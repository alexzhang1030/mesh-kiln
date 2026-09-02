import {
	BufferAttribute,
	BufferGeometry,
	DoubleSide,
	Ray,
	Triangle,
	Vector3
} from 'three';
import { MeshBVH } from 'three-mesh-bvh';

export type RayHit = {
	point: [number, number, number];
	distance: number;
	faceIndex: number;
	barycentric: [number, number, number];
	uv: [number, number] | null;
};

export type ClosestHit = {
	point: [number, number, number];
	faceIndex: number;
	barycentric: [number, number, number];
	uv: [number, number] | null;
};

export type MeshBvh = {
	bvh: MeshBVH;
	positions: Float32Array;
	indices: Uint32Array;
	normals: Float32Array;
	uvs: Float32Array | null;
};

const ray = new Ray();
const originVec = new Vector3();
const dirVec = new Vector3();
const pointVec = new Vector3();
const closestVec = new Vector3();
const triA = new Vector3();
const triB = new Vector3();
const triC = new Vector3();
const baryVec = new Vector3();
const islandHits: RayHit[] = [];

export function buildBvh(
	positions: Float32Array,
	indices: Uint32Array,
	normals: Float32Array,
	uvs: Float32Array | null
): MeshBvh {
	const geometry = new BufferGeometry();
	geometry.setAttribute('position', new BufferAttribute(positions, 3));
	geometry.setAttribute('normal', new BufferAttribute(normals, 3));
	if (uvs) geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
	geometry.setIndex(new BufferAttribute(indices.slice(), 1));
	geometry.computeBoundingBox();
	const bvh = new MeshBVH(geometry, { targetLeafSize: 10, indirect: true });
	return { bvh, positions, indices, normals, uvs };
}

export function raycastFirst(
	tree: MeshBvh,
	origin: [number, number, number],
	direction: [number, number, number],
	maxDistance: number
): RayHit | null {
	originVec.set(origin[0], origin[1], origin[2]);
	dirVec.set(direction[0], direction[1], direction[2]).normalize();
	ray.origin.copy(originVec);
	ray.direction.copy(dirVec);
	const hit = tree.bvh.raycastFirst(ray, DoubleSide, 0, maxDistance);
	if (!hit) return null;
	const faceIndex = hit.faceIndex ?? 0;
	const bary = barycentricOf(tree, faceIndex, hit.point);
	return {
		point: [hit.point.x, hit.point.y, hit.point.z],
		distance: hit.distance,
		faceIndex,
		barycentric: bary,
		uv: interpolateUv(tree, faceIndex, bary)
	};
}

export function closestPointToPoint(
	tree: MeshBvh,
	point: [number, number, number],
	maxDistance = Infinity
): ClosestHit | null {
	pointVec.set(point[0], point[1], point[2]);
	const found = tree.bvh.closestPointToPoint(pointVec, undefined, 0, maxDistance);
	if (!found) return null;
	const faceIndex = found.faceIndex ?? 0;
	const barycentric = barycentricOf(tree, faceIndex, found.point);
	return {
		point: [found.point.x, found.point.y, found.point.z],
		faceIndex,
		barycentric,
		uv: interpolateUv(tree, faceIndex, barycentric)
	};
}

export function raycastAll(
	tree: MeshBvh,
	origin: [number, number, number],
	direction: [number, number, number],
	maxDistance: number
): RayHit[] {
	originVec.set(origin[0], origin[1], origin[2]);
	dirVec.set(direction[0], direction[1], direction[2]).normalize();
	ray.origin.copy(originVec);
	ray.direction.copy(dirVec);
	const hits = tree.bvh.raycast(ray, DoubleSide, 0, maxDistance);
	islandHits.length = 0;
	for (const hit of hits) {
		const faceIndex = hit.faceIndex ?? 0;
		const bary = barycentricOf(tree, faceIndex, hit.point);
		islandHits.push({
			point: [hit.point.x, hit.point.y, hit.point.z],
			distance: hit.distance,
			faceIndex,
			barycentric: bary,
			uv: interpolateUv(tree, faceIndex, bary)
		});
	}
	return islandHits;
}

export function closestPointOnIsland(
	tree: MeshBvh,
	point: [number, number, number],
	island: number,
	islands: Uint32Array,
	maxDistance: number
): ClosestHit | null {
	pointVec.set(point[0], point[1], point[2]);
	let bestDist = maxDistance;
	let bestFace = -1;
	closestVec.set(0, 0, 0);
	tree.bvh.shapecast({
		intersectsBounds: (box) => box.distanceToPoint(pointVec) <= bestDist,
		intersectsTriangle: (tri, triangleIndex) => {
			if ((islands[triangleIndex] ?? 0) !== island) return false;
			tri.closestPointToPoint(pointVec, baryVec);
			const dist = pointVec.distanceTo(baryVec);
			if (dist < bestDist) {
				bestDist = dist;
				bestFace = triangleIndex;
				closestVec.copy(baryVec);
			}
			return false;
		}
	});
	if (bestFace < 0) return null;
	const barycentric = barycentricOf(tree, bestFace, closestVec);
	return {
		point: [closestVec.x, closestVec.y, closestVec.z],
		faceIndex: bestFace,
		barycentric,
		uv: interpolateUv(tree, bestFace, barycentric)
	};
}

export function triangleIslands(indices: Uint32Array, vertexCount: number): Uint32Array {
	const parent = new Uint32Array(vertexCount);
	for (let i = 0; i < vertexCount; i++) parent[i] = i;
	const find = (index: number): number => {
		let x = index;
		while ((parent[x] ?? x) !== x) {
			const up = parent[x] ?? x;
			parent[x] = parent[up] ?? up;
			x = parent[x] ?? x;
		}
		return x;
	};
	const unite = (a: number, b: number): void => {
		const pa = find(a);
		const pb = find(b);
		if (pa !== pb) parent[pa] = pb;
	};
	for (let i = 0; i + 2 < indices.length; i += 3) {
		const a = indices[i] ?? 0;
		unite(a, indices[i + 1] ?? 0);
		unite(a, indices[i + 2] ?? 0);
	}
	const islands = new Uint32Array(Math.floor(indices.length / 3));
	for (let t = 0; t < islands.length; t++) {
		islands[t] = find(indices[t * 3] ?? 0);
	}
	return islands;
}

export function islandCount(indices: Uint32Array, vertexCount: number): number {
	const islands = triangleIslands(indices, vertexCount);
	const seen = new Set<number>();
	for (let i = 0; i < islands.length; i++) seen.add(islands[i] ?? 0);
	return seen.size;
}

export function clampBarycentric(bary: [number, number, number]): [number, number, number] {
	const a = Math.max(0, bary[0]);
	const b = Math.max(0, bary[1]);
	const c = Math.max(0, bary[2]);
	const sum = a + b + c;
	if (sum < 1e-8) return [1, 0, 0];
	return [a / sum, b / sum, c / sum];
}

function barycentricOf(
	tree: MeshBvh,
	faceIndex: number,
	point: Vector3
): [number, number, number] {
	const ia = tree.indices[faceIndex * 3] ?? 0;
	const ib = tree.indices[faceIndex * 3 + 1] ?? 0;
	const ic = tree.indices[faceIndex * 3 + 2] ?? 0;
	triA.set(tree.positions[ia * 3] ?? 0, tree.positions[ia * 3 + 1] ?? 0, tree.positions[ia * 3 + 2] ?? 0);
	triB.set(tree.positions[ib * 3] ?? 0, tree.positions[ib * 3 + 1] ?? 0, tree.positions[ib * 3 + 2] ?? 0);
	triC.set(tree.positions[ic * 3] ?? 0, tree.positions[ic * 3 + 1] ?? 0, tree.positions[ic * 3 + 2] ?? 0);
	Triangle.getBarycoord(point, triA, triB, triC, baryVec);
	return clampBarycentric([baryVec.x, baryVec.y, baryVec.z]);
}

export function interpolateUv(
	tree: MeshBvh,
	faceIndex: number,
	bary: [number, number, number]
): [number, number] | null {
	if (!tree.uvs) return null;
	const ia = tree.indices[faceIndex * 3] ?? 0;
	const ib = tree.indices[faceIndex * 3 + 1] ?? 0;
	const ic = tree.indices[faceIndex * 3 + 2] ?? 0;
	const u =
		(tree.uvs[ia * 2] ?? 0) * bary[0] +
		(tree.uvs[ib * 2] ?? 0) * bary[1] +
		(tree.uvs[ic * 2] ?? 0) * bary[2];
	const v =
		(tree.uvs[ia * 2 + 1] ?? 0) * bary[0] +
		(tree.uvs[ib * 2 + 1] ?? 0) * bary[1] +
		(tree.uvs[ic * 2 + 1] ?? 0) * bary[2];
	return [u, v];
}

export function interpolateAttribute(
	values: Float32Array,
	indices: Uint32Array,
	faceIndex: number,
	bary: [number, number, number],
	stride: number,
	out: number[]
): number[] {
	const ia = indices[faceIndex * 3] ?? 0;
	const ib = indices[faceIndex * 3 + 1] ?? 0;
	const ic = indices[faceIndex * 3 + 2] ?? 0;
	for (let c = 0; c < stride; c++) {
		out[c] =
			(values[ia * stride + c] ?? 0) * bary[0] +
			(values[ib * stride + c] ?? 0) * bary[1] +
			(values[ic * stride + c] ?? 0) * bary[2];
	}
	return out;
}
