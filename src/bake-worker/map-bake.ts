import {
	buildBvh,
	closestPointToPoint,
	interpolateAttribute,
	raycastAll,
	type MeshBvh,
	type RayHit
} from '../kernels/bvh';
import {
	createImage,
	dilateRadiusForAtlas,
	dilateRgba,
	encodeNormal,
	linearToSrgb,
	sampleBilinear,
	sharpenRgb
} from '../kernels/images';
import { nowMs, yieldToEventLoop } from '../kernels/cooperative';
import { computeSourceTangents } from '../kernels/source-tangents';
import {
	aabbDiagonal,
	aabbFromPositions,
	meanEdgeLength,
	readVec3,
	vec3Add,
	vec3Create,
	vec3Cross,
	vec3Dot,
	vec3Normalize,
	vec3Scale,
	type Vec3
} from '../kernels/math';
import type { LowPolyMesh, RgbaImage, SourceMaterial, SourceMesh } from '../kernels/types';
import { triangleCountOf } from '../kernels/types';

export const BAKE_SHARPEN_AMOUNT = 0.38;
export const DIELECTRIC_ROUGHNESS = 0.5;
export const BAKE_YIELD_TRIANGLES = 256;
export const BAKE_YIELD_INTERVAL_MS = 500;

const vertexColorScratch: number[] = [1, 1, 1];
const sourceTangentScratch: number[] = [1, 0, 0, 1];
const sourceTangentVector: Vec3 = [1, 0, 0];
const sourceBitangentVector: Vec3 = [0, 1, 0];

export async function bakeMaps(
	high: SourceMesh,
	low: LowPolyMesh,
	mapSize: number,
	onProgress: (value: number) => void = () => undefined,
	isCancelled: () => boolean = () => false
): Promise<{
	baseColor: RgbaImage;
	normal: RgbaImage;
	metallicRoughness: RgbaImage;
	emissive: RgbaImage | null;
}> {
	const size = Math.max(32, Math.floor(mapSize));
	const baseColor = createImage(size, size, [118, 118, 116, 0]);
	const normal = createImage(size, size, [128, 128, 255, 0]);
	const metallicRoughness = createImage(size, size, [255, 255, 0, 0]);
	const bakeEmissive = sourceHasEmissive(high);
	const emissive = bakeEmissive ? createImage(size, size, [0, 0, 0, 0]) : null;
	const filled = new Uint8Array(size * size);
	const tree = buildBvh(high.positions, high.indices, high.normals, high.uvs);
	const sourceTangents = high.uvs && sourceHasNormal(high)
		? computeSourceTangents({ positions: high.positions, indices: high.indices, normals: high.normals, uvs: high.uvs })
		: null;
	const box = aabbFromPositions(high.positions);
	const diagonal = Math.max(1e-5, aabbDiagonal(box));
	const spanY = box.max[1] - box.min[1];
	const floorY = box.min[1] + Math.max(1e-4, spanY * 0.03);
	const floorClearance = floorY + spanY * 0.08;
	const edge = meanEdgeLength(low.positions, low.indices);
	const cage = Math.max(diagonal * 1e-5, (edge > 0 ? edge : diagonal * 0.06) * 0.5);
	const maxDistance = Math.max(cage * 16, (edge > 0 ? edge : cage) * 8, diagonal * 0.15);
	const triangleCount = triangleCountOf(low.indices);

	const p0 = vec3Create();
	const p1 = vec3Create();
	const p2 = vec3Create();
	const n0 = vec3Create();
	const n1 = vec3Create();
	const n2 = vec3Create();
	const t0 = vec3Create();
	const t1 = vec3Create();
	const t2 = vec3Create();
	const pos = vec3Create();
	const nrm = vec3Create();
	const tan = vec3Create();
	const bitan = vec3Create();
	const worldN = vec3Create();
	const ts = vec3Create();
	const inwardOrigin = vec3Create();
	const outwardOrigin = vec3Create();
	const inwardDir = vec3Create();
	const sampleNormal = vec3Create();

	let lastYield = nowMs();
	onProgress(0);

	for (let t = 0; t < triangleCount; t++) {
		if (isCancelled()) throw new Error('cancelled');
		const ia = low.indices[t * 3] ?? 0;
		const ib = low.indices[t * 3 + 1] ?? 0;
		const ic = low.indices[t * 3 + 2] ?? 0;
		readVec3(low.positions, ia, p0);
		readVec3(low.positions, ib, p1);
		readVec3(low.positions, ic, p2);
		readVec3(low.normals, ia, n0);
		readVec3(low.normals, ib, n1);
		readVec3(low.normals, ic, n2);
		t0[0] = low.tangents[ia * 4] ?? 1;
		t0[1] = low.tangents[ia * 4 + 1] ?? 0;
		t0[2] = low.tangents[ia * 4 + 2] ?? 0;
		t1[0] = low.tangents[ib * 4] ?? 1;
		t1[1] = low.tangents[ib * 4 + 1] ?? 0;
		t1[2] = low.tangents[ib * 4 + 2] ?? 0;
		t2[0] = low.tangents[ic * 4] ?? 1;
		t2[1] = low.tangents[ic * 4 + 1] ?? 0;
		t2[2] = low.tangents[ic * 4 + 2] ?? 0;
		const s0 = low.tangents[ia * 4 + 3] ?? 1;
		const s1 = low.tangents[ib * 4 + 3] ?? 1;
		const s2 = low.tangents[ic * 4 + 3] ?? 1;
		const uv0: [number, number] = [low.uvs[ia * 2] ?? 0, low.uvs[ia * 2 + 1] ?? 0];
		const uv1: [number, number] = [low.uvs[ib * 2] ?? 0, low.uvs[ib * 2 + 1] ?? 0];
		const uv2: [number, number] = [low.uvs[ic * 2] ?? 0, low.uvs[ic * 2 + 1] ?? 0];

		rasterize(uv0, uv1, uv2, size, (x, y, bary) => {
			const index = y * size + x;
			if (filled[index]) return;
			mix3into(p0, p1, p2, bary, pos);
			vec3Normalize(mix3into(n0, n1, n2, bary, nrm), nrm);
			vec3Normalize(mix3into(t0, t1, t2, bary, tan), tan);
			const sign = s0 * bary[0] + s1 * bary[1] + s2 * bary[2] >= 0 ? 1 : -1;
			vec3Normalize(vec3Scale(vec3Cross(nrm, tan, bitan), sign, bitan), bitan);

			const sample = projectToSource(
				tree,
				high,
				pos,
				nrm,
				cage,
				maxDistance,
				inwardOrigin,
				outwardOrigin,
				inwardDir,
				sampleNormal,
				{
					floorY,
					sampleY: pos[1],
					floorClearance
				}
			);
			const color = shadeHit(high, sample);
			const mr = shadeMetallicRoughness(high, sample);
			shadeNormal(high, sample, sourceTangents, worldN);
			ts[0] = vec3Dot(worldN, tan);
			ts[1] = vec3Dot(worldN, bitan);
			ts[2] = vec3Dot(worldN, nrm);
			vec3Normalize(ts, ts);
			const encoded = encodeNormal(ts[0], ts[1], ts[2]);
			const pix = index * 4;
			baseColor.rgba[pix] = color[0];
			baseColor.rgba[pix + 1] = color[1];
			baseColor.rgba[pix + 2] = color[2];
			baseColor.rgba[pix + 3] = 255;
			normal.rgba[pix] = encoded[0];
			normal.rgba[pix + 1] = encoded[1];
			normal.rgba[pix + 2] = encoded[2];
			normal.rgba[pix + 3] = 255;
			metallicRoughness.rgba[pix] = 255;
			metallicRoughness.rgba[pix + 1] = mr[0];
			metallicRoughness.rgba[pix + 2] = mr[1];
			metallicRoughness.rgba[pix + 3] = 255;
			if (emissive) {
				const glow = shadeEmissive(high, sample);
				emissive.rgba[pix] = glow[0];
				emissive.rgba[pix + 1] = glow[1];
				emissive.rgba[pix + 2] = glow[2];
				emissive.rgba[pix + 3] = 255;
			}
			filled[index] = 1;
		});

		if (t % BAKE_YIELD_TRIANGLES === BAKE_YIELD_TRIANGLES - 1 || nowMs() - lastYield > BAKE_YIELD_INTERVAL_MS) {
			onProgress((t + 1) / Math.max(1, triangleCount));
			await yieldToEventLoop();
			lastYield = nowMs();
		}
	}

	sharpenRgb(baseColor, BAKE_SHARPEN_AMOUNT, filled);
	if (emissive) sharpenRgb(emissive, BAKE_SHARPEN_AMOUNT, filled);
	const bleed = dilateRadiusForAtlas(size);
	dilateRgba(baseColor, filled, bleed);
	dilateRgba(normal, filled, bleed);
	dilateRgba(metallicRoughness, filled, bleed);
	if (emissive) dilateRgba(emissive, filled, bleed);
	onProgress(1);
	return { baseColor, normal, metallicRoughness, emissive };
}

export type ProjectKind = 'ray' | 'closest' | 'fallback';

export type HighSample = {
	kind: ProjectKind;
	normal: Vec3;
	uv: [number, number] | null;
	faceIndex: number;
	barycentric: [number, number, number];
};

export type ProjectOptions = {
	homeIsland?: number;
	islands?: Uint32Array;
	floorY?: number;
	sampleY?: number;
	floorClearance?: number;
};

type ScoredHit = {
	kind: ProjectKind;
	faceIndex: number;
	barycentric: [number, number, number];
	uv: [number, number] | null;
	dist: number;
	island: number;
};

export function projectToSource(
	tree: MeshBvh,
	high: SourceMesh,
	pos: Vec3,
	nrm: Vec3,
	cage: number,
	maxDistance: number,
	inwardOrigin: Vec3,
	outwardOrigin: Vec3,
	inwardDir: Vec3,
	sampleNormal: Vec3,
	options: ProjectOptions = {}
): HighSample {
	const islands = options.islands;
	const homeIsland = options.homeIsland ?? 0;
	const islandOf = (face: number): number => islands?.[face] ?? 0;
	let best: ScoredHit | null = null;

	const considerRay = (hit: RayHit, kind: ProjectKind): void => {
		if (rejectFloor(tree, hit.faceIndex, hit.point[1], options)) return;
		const dist = Math.hypot(hit.point[0] - pos[0], hit.point[1] - pos[1], hit.point[2] - pos[2]);
		best = pickBetter(best, {
			kind,
			faceIndex: hit.faceIndex,
			barycentric: hit.barycentric,
			uv: hit.uv,
			dist,
			island: islandOf(hit.faceIndex)
		}, homeIsland);
	};

	vec3Add(pos, vec3Scale(nrm, cage, inwardOrigin), inwardOrigin);
	vec3Scale(nrm, -1, inwardDir);
	for (const hit of raycastAll(tree, inwardOrigin, inwardDir, maxDistance)) considerRay(hit, 'ray');
	vec3Add(pos, vec3Scale(nrm, -cage, outwardOrigin), outwardOrigin);
	for (const hit of raycastAll(tree, outwardOrigin, nrm, maxDistance)) considerRay(hit, 'ray');

	if (!best) {
		const closest = closestPointToPoint(tree, pos);
		if (closest && !rejectFloor(tree, closest.faceIndex, closest.point[1], options)) {
			best = pickBetter(
				best,
				{
					kind: 'closest',
					faceIndex: closest.faceIndex,
					barycentric: closest.barycentric,
					uv: closest.uv,
					dist: Math.hypot(closest.point[0] - pos[0], closest.point[1] - pos[1], closest.point[2] - pos[2]),
					island: islandOf(closest.faceIndex)
				},
				homeIsland
			);
		}
	}

	if (!best) {
		sampleNormal[0] = nrm[0];
		sampleNormal[1] = nrm[1];
		sampleNormal[2] = nrm[2];
		return { kind: 'fallback', normal: sampleNormal, uv: null, faceIndex: 0, barycentric: [1, 0, 0] };
	}

	interpolateAttribute(high.normals, high.indices, best.faceIndex, best.barycentric, 3, sampleNormal);
	vec3Normalize(sampleNormal, sampleNormal);
	return {
		kind: best.kind,
		normal: sampleNormal,
		uv: best.uv,
		faceIndex: best.faceIndex,
		barycentric: best.barycentric
	};
}

export function shadeHit(high: SourceMesh, sample: HighSample): [number, number, number] {
	const material = materialOf(high, sample.faceIndex);
	const factor = material?.baseColorFactor ?? [0.72, 0.72, 0.7, 1];
	let r = factor[0];
	let g = factor[1];
	let b = factor[2];
	if (material?.baseColor && sample.uv) {
		const texel = sampleBilinear(material.baseColor, sample.uv[0], sample.uv[1], false);
		r *= texel[0] / 255;
		g *= texel[1] / 255;
		b *= texel[2] / 255;
	}
	if (high.colors) {
		interpolateAttribute(high.colors, high.indices, sample.faceIndex, sample.barycentric, 3, vertexColorScratch);
		r *= vertexColorScratch[0] ?? 1;
		g *= vertexColorScratch[1] ?? 1;
		b *= vertexColorScratch[2] ?? 1;
	}
	if (high.colors && !material?.baseColor) {
		r = linearToSrgb(clamp01(r));
		g = linearToSrgb(clamp01(g));
		b = linearToSrgb(clamp01(b));
	}
	return [Math.round(clamp01(r) * 255), Math.round(clamp01(g) * 255), Math.round(clamp01(b) * 255)];
}

export function shadeMetallicRoughness(high: SourceMesh, sample: HighSample): [number, number] {
	const material = materialOf(high, sample.faceIndex);
	let metallic = resolvedMetallic(material);
	let roughness = resolvedRoughness(material);
	if (material?.metallicRoughness && sample.uv) {
		const texel = sampleBilinear(material.metallicRoughness, sample.uv[0], sample.uv[1], false);
		roughness *= (texel[1] ?? 255) / 255;
		metallic *= (texel[2] ?? 0) / 255;
	}
	return [Math.round(clamp01(roughness) * 255), Math.round(clamp01(metallic) * 255)];
}

export function shadeNormal(
	high: SourceMesh,
	sample: HighSample,
	sourceTangents: Float32Array | null,
	out: Vec3
): Vec3 {
	out[0] = sample.normal[0];
	out[1] = sample.normal[1];
	out[2] = sample.normal[2];
	vec3Normalize(out, out);
	const material = materialOf(high, sample.faceIndex);
	if (!material?.normal || !sample.uv || !sourceTangents) return out;

	interpolateAttribute(sourceTangents, high.indices, sample.faceIndex, sample.barycentric, 4, sourceTangentScratch);
	const tangentDot =
		out[0] * (sourceTangentScratch[0] ?? 1) +
		out[1] * (sourceTangentScratch[1] ?? 0) +
		out[2] * (sourceTangentScratch[2] ?? 0);
	sourceTangentVector[0] = (sourceTangentScratch[0] ?? 1) - out[0] * tangentDot;
	sourceTangentVector[1] = (sourceTangentScratch[1] ?? 0) - out[1] * tangentDot;
	sourceTangentVector[2] = (sourceTangentScratch[2] ?? 0) - out[2] * tangentDot;
	vec3Normalize(sourceTangentVector, sourceTangentVector);
	const sign = (sourceTangentScratch[3] ?? 1) >= 0 ? 1 : -1;
	vec3Scale(vec3Cross(out, sourceTangentVector, sourceBitangentVector), sign, sourceBitangentVector);
	vec3Normalize(sourceBitangentVector, sourceBitangentVector);

	const texel = sampleBilinear(material.normal, sample.uv[0], sample.uv[1], false);
	const scale = material.normalScale ?? 1;
	const x = (texel[0] / 255 * 2 - 1) * scale;
	const y = (texel[1] / 255 * 2 - 1) * scale;
	const z = texel[2] / 255 * 2 - 1;
	out[0] = sourceTangentVector[0] * x + sourceBitangentVector[0] * y + out[0] * z;
	out[1] = sourceTangentVector[1] * x + sourceBitangentVector[1] * y + out[1] * z;
	out[2] = sourceTangentVector[2] * x + sourceBitangentVector[2] * y + out[2] * z;
	return vec3Normalize(out, out);
}

export function resolvedMetallic(material: SourceMaterial | undefined): number {
	if (!material) return 0;
	if (material.metallicRoughness) return material.metallicFactor;
	return 0;
}

export function resolvedRoughness(material: SourceMaterial | undefined): number {
	if (!material) return DIELECTRIC_ROUGHNESS;
	if (material.metallicRoughness) return material.roughnessFactor;
	if (material.roughnessFactor > 0 && material.roughnessFactor < 1) return material.roughnessFactor;
	if (material.roughnessFactor <= 0) return 0;
	return DIELECTRIC_ROUGHNESS;
}

function shadeEmissive(high: SourceMesh, sample: HighSample): [number, number, number] {
	const material = materialOf(high, sample.faceIndex);
	const factor = material?.emissiveFactor ?? [0, 0, 0];
	if (material?.emissive && sample.uv) {
		const texel = sampleBilinear(material.emissive, sample.uv[0], sample.uv[1], false);
		return [
			Math.round(texel[0] * factor[0]),
			Math.round(texel[1] * factor[1]),
			Math.round(texel[2] * factor[2])
		];
	}
	return [Math.round(clamp01(factor[0]) * 255), Math.round(clamp01(factor[1]) * 255), Math.round(clamp01(factor[2]) * 255)];
}

function materialOf(high: SourceMesh, faceIndex: number): SourceMaterial | undefined {
	const materialId = high.triangleMaterials[faceIndex] ?? 0;
	return high.materials[materialId] ?? high.materials[0];
}

function sourceHasEmissive(high: SourceMesh): boolean {
	for (const material of high.materials) {
		if (material.emissive) return true;
		if ((material.emissiveFactor[0] ?? 0) > 1e-4) return true;
		if ((material.emissiveFactor[1] ?? 0) > 1e-4) return true;
		if ((material.emissiveFactor[2] ?? 0) > 1e-4) return true;
	}
	return false;
}

function sourceHasNormal(high: SourceMesh): boolean {
	return high.materials.some((material) => Boolean(material.normal));
}

function pickBetter(current: ScoredHit | null, next: ScoredHit, homeIsland: number): ScoredHit {
	if (!current) return next;
	if (next.dist + 1e-7 < current.dist) return next;
	if (current.dist + 1e-7 < next.dist) return current;
	const nextHome = next.island === homeIsland;
	const currentHome = current.island === homeIsland;
	if (nextHome !== currentHome) return nextHome ? next : current;
	return current;
}

function rejectFloor(
	tree: MeshBvh,
	faceIndex: number,
	hitY: number,
	options: ProjectOptions
): boolean {
	const floorY = options.floorY;
	if (floorY === undefined || !Number.isFinite(floorY)) return false;
	const sampleY = options.sampleY ?? 0;
	const clearance = options.floorClearance ?? floorY;
	if (sampleY <= clearance) return false;
	if (hitY > floorY) return false;
	const ia = tree.indices[faceIndex * 3] ?? 0;
	const ib = tree.indices[faceIndex * 3 + 1] ?? 0;
	const ic = tree.indices[faceIndex * 3 + 2] ?? 0;
	const ny =
		((tree.normals[ia * 3 + 1] ?? 0) + (tree.normals[ib * 3 + 1] ?? 0) + (tree.normals[ic * 3 + 1] ?? 0)) / 3;
	return ny > 0.82;
}

function clamp01(value: number): number {
	return Math.min(1, Math.max(0, value));
}

function mix3into(a: Vec3, b: Vec3, c: Vec3, bary: [number, number, number], out: Vec3): Vec3 {
	out[0] = a[0] * bary[0] + b[0] * bary[1] + c[0] * bary[2];
	out[1] = a[1] * bary[0] + b[1] * bary[1] + c[1] * bary[2];
	out[2] = a[2] * bary[0] + b[2] * bary[1] + c[2] * bary[2];
	return out;
}

function rasterize(
	uv0: [number, number],
	uv1: [number, number],
	uv2: [number, number],
	size: number,
	write: (x: number, y: number, bary: [number, number, number]) => void
): void {
	const a = toPixel(uv0, size);
	const b = toPixel(uv1, size);
	const c = toPixel(uv2, size);
	const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
	const maxX = Math.min(size - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
	const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
	const maxY = Math.min(size - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
	if (maxX < minX || maxY < minY) return;

	const area = edge(a, b, c);
	if (Math.abs(area) < 1e-8) return;
	const inv = 1 / area;

	for (let y = minY; y <= maxY; y++) {
		const py = y + 0.5;
		for (let x = minX; x <= maxX; x++) {
			const px = x + 0.5;
			const w0 = edge(b, c, [px, py]) * inv;
			const w1 = edge(c, a, [px, py]) * inv;
			const w2 = edge(a, b, [px, py]) * inv;
			if (w0 < -0.001 || w1 < -0.001 || w2 < -0.001) continue;
			write(x, y, [w0, w1, w2]);
		}
	}
}

function toPixel(uv: [number, number], size: number): [number, number] {
	return [uv[0] * size, uv[1] * size];
}

function edge(a: [number, number], b: [number, number], c: [number, number]): number {
	return (c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0]);
}
