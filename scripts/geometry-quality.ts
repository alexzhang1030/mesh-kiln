import { readFileSync, writeFileSync } from 'node:fs';
import { WebIO, type Primitive } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
	buildBvh,
	closestPointToPoint,
	interpolateAttribute,
	raycastFirst,
	triangleIslands,
	type MeshBvh
} from '../src/kernels/bvh';
import { invertMat4, mulMat4Vec3, transposeMat4, vec3Create, vec3Normalize } from '../src/kernels/math';
import { computeNormals } from '../src/kernels/normals';
import type { SourceMaterial, SourceMesh, TopologyMode } from '../src/kernels/types';
import { runBake, type BakeProgressEvent } from '../src/bake-worker/pipeline';

type Bounds = {
	min: [number, number, number];
	max: [number, number, number];
	diagonal: number;
};

type DistanceStats = {
	rms: number;
	p95: number;
	max: number;
};

type QualityMetrics = {
	triangles: number;
	sourceToResult: DistanceStats;
	resultToSource: DistanceStats;
	normalMeanDegrees: number;
	silhouetteIou: number;
	depthMae: number;
};

type SurfaceSample = {
	faceIndex: number;
	barycentric: [number, number, number];
	point: [number, number, number];
};

const sourcePath = requiredArg('--source');
const referencePath = requiredArg('--reference');
const candidatePath = optionalArg('--candidate');
const outputPath = optionalArg('--output');
const budget = Math.max(64, Number(optionalArg('--budget') ?? 6000));
const samples = Math.max(256, Number(optionalArg('--samples') ?? 6000));
const topology = (optionalArg('--topology') ?? 'auto') as TopologyMode;

const source = await readGeometry(sourcePath);
const reference = await readGeometry(referencePath);
const candidate = candidatePath
	? await readGeometry(candidatePath)
	: await bakeCandidate(source, topology, budget, outputPath);

const bounds = boundsOf(source.positions);
const sourceTree = buildBvh(source.positions, source.indices, source.normals, source.uvs);
const sourceSamples = sampleSurface(source, samples);
const referenceMetrics = measureQuality(source, reference, bounds, sourceTree, sourceSamples);
const candidateMetrics = measureQuality(source, candidate, bounds, sourceTree, sourceSamples);

console.log(
	JSON.stringify(
		{ budget, topology, source: meshStats(source), reference: referenceMetrics, candidate: candidateMetrics },
		null,
		2
	)
);

const failures = compareAgainstReference(referenceMetrics, candidateMetrics, budget);
if (failures.length > 0) {
	for (const failure of failures) console.error(`QUALITY FAIL: ${failure}`);
	process.exitCode = 1;
} else {
	console.log('QUALITY PASS: candidate stays within the reference-relative geometry envelope.');
}

function requiredArg(name: string): string {
	const value = optionalArg(name);
	if (!value) throw new Error(`Missing ${name}.`);
	return value;
}

function optionalArg(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

async function bakeCandidate(
	sourceMesh: SourceMesh,
	topologyMode: TopologyMode,
	triangleBudget: number,
	writePath: string | undefined
): Promise<SourceMesh> {
	const events: BakeProgressEvent[] = [];
	await runBake(
		sourceMesh,
		{
			triangleBudget,
			topologyMode,
			mapSize: 256,
			voxelResolution: 160
		},
		(event) => events.push(event)
	);
	const complete = events.find((event) => event.type === 'complete');
	if (complete?.type !== 'complete') {
		const error = events.find((event) => event.type === 'error');
		throw new Error(error?.type === 'error' ? error.message : 'Candidate bake did not complete.');
	}
	if (writePath) writeFileSync(writePath, new Uint8Array(complete.glb));
	return readGeometryBytes(new Uint8Array(complete.glb));
}

async function readGeometry(path: string): Promise<SourceMesh> {
	return readGeometryBytes(new Uint8Array(readFileSync(path)));
}

async function readGeometryBytes(bytes: Uint8Array): Promise<SourceMesh> {
	const document = await new WebIO().registerExtensions(ALL_EXTENSIONS).readBinary(bytes);
	const positions: number[] = [];
	const normals: number[] = [];
	const uvs: number[] = [];
	const colors: number[] = [];
	const indices: number[] = [];
	const triangleMaterials: number[] = [];
	const materials: SourceMaterial[] = [];
	const materialIds = new Map<object, number>();
	let hasUv = false;
	let hasColor = false;

	for (const node of document.getRoot().listNodes()) {
		const mesh = node.getMesh();
		if (!mesh) continue;
		const world = Array.from(node.getWorldMatrix());
		for (const primitive of mesh.listPrimitives()) absorbPrimitive(primitive, world);
	}

	if (indices.length < 3) throw new Error('GLB has no triangle primitives.');
	const positionArray = Float32Array.from(positions);
	const indexArray = Uint32Array.from(indices);
	const normalArray = normals.length === positions.length ? Float32Array.from(normals) : computeNormals(positionArray, indexArray);
	if (materials.length === 0) materials.push(defaultMaterial());
	return {
		positions: positionArray,
		indices: indexArray,
		normals: normalArray,
		uvs: hasUv ? Float32Array.from(uvs) : null,
		colors: hasColor ? Float32Array.from(colors) : null,
		triangleMaterials: Uint16Array.from(triangleMaterials),
		materials
	};

	function absorbPrimitive(primitive: Primitive, world: number[]): void {
		const mode = primitive.getMode();
		if (mode <= 3) return;
		const positionAccessor = primitive.getAttribute('POSITION');
		const sourcePositions = positionAccessor?.getArray();
		if (!sourcePositions) return;
		const sourceNormals = primitive.getAttribute('NORMAL')?.getArray() ?? null;
		const sourceUvs = primitive.getAttribute('TEXCOORD_0')?.getArray() ?? null;
		const colorAccessor = primitive.getAttribute('COLOR_0');
		const sourceIndices = primitive.getIndices()?.getArray() ?? null;
		const vertexOffset = positions.length / 3;
		const inverse = invertMat4(world);
		const normalMatrix = inverse ? transposeMat4(inverse) : world;
		const point = vec3Create();
		const normal = vec3Create();
		const vertexCount = Math.floor(sourcePositions.length / 3);

		for (let vertex = 0; vertex < vertexCount; vertex++) {
			point[0] = sourcePositions[vertex * 3] ?? 0;
			point[1] = sourcePositions[vertex * 3 + 1] ?? 0;
			point[2] = sourcePositions[vertex * 3 + 2] ?? 0;
			mulMat4Vec3(world, point, point, false);
			positions.push(point[0], point[1], point[2]);
			if (sourceNormals) {
				normal[0] = sourceNormals[vertex * 3] ?? 0;
				normal[1] = sourceNormals[vertex * 3 + 1] ?? 0;
				normal[2] = sourceNormals[vertex * 3 + 2] ?? 0;
				mulMat4Vec3(normalMatrix, normal, normal, true);
				vec3Normalize(normal, normal);
				normals.push(normal[0], normal[1], normal[2]);
			}
			if (sourceUvs) {
				hasUv = true;
				uvs.push(sourceUvs[vertex * 2] ?? 0, sourceUvs[vertex * 2 + 1] ?? 0);
			} else {
				uvs.push(0, 0);
			}
			if (colorAccessor) {
				hasColor = true;
				const rgba = [1, 1, 1, 1];
				colorAccessor.getElement(vertex, rgba);
				colors.push(rgba[0] ?? 1, rgba[1] ?? 1, rgba[2] ?? 1);
			} else {
				colors.push(1, 1, 1);
			}
		}

		const material = primitive.getMaterial();
		let materialId = 0;
		if (material) {
			const existing = materialIds.get(material);
			if (existing !== undefined) materialId = existing;
			else {
				materialId = materials.length;
				materialIds.set(material, materialId);
				const base = material.getBaseColorFactor();
				const emissive = material.getEmissiveFactor();
				materials.push({
					baseColorFactor: [base[0] ?? 1, base[1] ?? 1, base[2] ?? 1, base[3] ?? 1],
					metallicFactor: material.getMetallicFactor(),
					roughnessFactor: material.getRoughnessFactor(),
					emissiveFactor: [emissive[0] ?? 0, emissive[1] ?? 0, emissive[2] ?? 0],
					alphaMode: material.getAlphaMode(),
					alphaCutoff: material.getAlphaCutoff()
				});
			}
		}

		const expanded = expandIndices(sourceIndices, vertexCount, mode);
		for (let index = 0; index + 2 < expanded.length; index += 3) {
			indices.push(
				(expanded[index] ?? 0) + vertexOffset,
				(expanded[index + 1] ?? 0) + vertexOffset,
				(expanded[index + 2] ?? 0) + vertexOffset
			);
			triangleMaterials.push(materialId);
		}
	}
}

function defaultMaterial(): SourceMaterial {
	return {
		baseColorFactor: [0.72, 0.72, 0.7, 1],
		metallicFactor: 0,
		roughnessFactor: 1,
		emissiveFactor: [0, 0, 0]
	};
}

function meshStats(mesh: SourceMesh): { triangles: number; vertices: number; islands: number } {
	const islands = triangleIslands(mesh.indices, Math.floor(mesh.positions.length / 3));
	return {
		triangles: Math.floor(mesh.indices.length / 3),
		vertices: Math.floor(mesh.positions.length / 3),
		islands: new Set(islands).size
	};
}

function expandIndices(source: ArrayLike<number> | null, vertexCount: number, mode: number): number[] {
	const raw = source ? Array.from(source) : Array.from({ length: vertexCount }, (_, index) => index);
	if (mode === 5) {
		const triangles: number[] = [];
		for (let index = 0; index + 2 < raw.length; index++) {
			const a = raw[index] ?? 0;
			const b = raw[index + 1] ?? 0;
			const c = raw[index + 2] ?? 0;
			triangles.push(index % 2 === 0 ? a : b, index % 2 === 0 ? b : a, c);
		}
		return triangles;
	}
	if (mode === 6) {
		const triangles: number[] = [];
		for (let index = 1; index + 1 < raw.length; index++) triangles.push(raw[0] ?? 0, raw[index] ?? 0, raw[index + 1] ?? 0);
		return triangles;
	}
	return raw;
}

function measureQuality(
	sourceMesh: SourceMesh,
	resultMesh: SourceMesh,
	bounds: Bounds,
	sourceTree: MeshBvh,
	sourceSamples: SurfaceSample[]
): QualityMetrics {
	const resultTree = buildBvh(resultMesh.positions, resultMesh.indices, resultMesh.normals, resultMesh.uvs);
	const resultSamples = sampleSurface(resultMesh, sourceSamples.length);
	const sourceToResult: number[] = [];
	const resultToSource: number[] = [];
	let normalDegrees = 0;
	let normalCount = 0;
	const sourceNormal: number[] = [];
	const resultNormal: number[] = [];

	for (const sample of sourceSamples) {
		const hit = closestPointToPoint(resultTree, sample.point);
		if (!hit) continue;
		sourceToResult.push(distance(sample.point, hit.point) / bounds.diagonal);
		interpolateAttribute(sourceMesh.normals, sourceMesh.indices, sample.faceIndex, sample.barycentric, 3, sourceNormal);
		interpolateAttribute(resultMesh.normals, resultMesh.indices, hit.faceIndex, hit.barycentric, 3, resultNormal);
		const cosine = Math.max(-1, Math.min(1, normalizedDot(sourceNormal, resultNormal)));
		normalDegrees += (Math.acos(cosine) * 180) / Math.PI;
		normalCount += 1;
	}

	for (const sample of resultSamples) {
		const hit = closestPointToPoint(sourceTree, sample.point);
		if (hit) resultToSource.push(distance(sample.point, hit.point) / bounds.diagonal);
	}

	const silhouette = measureSilhouette(sourceTree, resultTree, bounds, 48);
	return {
		triangles: Math.floor(resultMesh.indices.length / 3),
		sourceToResult: stats(sourceToResult),
		resultToSource: stats(resultToSource),
		normalMeanDegrees: normalCount > 0 ? normalDegrees / normalCount : 180,
		silhouetteIou: silhouette.iou,
		depthMae: silhouette.depthMae
	};
}

function sampleSurface(mesh: SourceMesh, count: number): SurfaceSample[] {
	const faces = Math.floor(mesh.indices.length / 3);
	const cumulative = new Float64Array(faces);
	let totalArea = 0;
	for (let face = 0; face < faces; face++) {
		totalArea += triangleArea(mesh, face);
		cumulative[face] = totalArea;
	}
	if (totalArea <= 0) throw new Error('Mesh surface area is zero.');

	const output: SurfaceSample[] = [];
	let face = 0;
	for (let index = 0; index < count; index++) {
		const targetArea = ((index + 0.5) / count) * totalArea;
		while (face + 1 < faces && (cumulative[face] ?? 0) < targetArea) face += 1;
		const u = fractional((index + 1) * 0.7548776662466927);
		const v = fractional((index + 1) * 0.5698402909980532);
		const root = Math.sqrt(u);
		const barycentric: [number, number, number] = [1 - root, root * (1 - v), root * v];
		output.push({ faceIndex: face, barycentric, point: interpolatePosition(mesh, face, barycentric) });
	}
	return output;
}

function triangleArea(mesh: SourceMesh, face: number): number {
	const ia = (mesh.indices[face * 3] ?? 0) * 3;
	const ib = (mesh.indices[face * 3 + 1] ?? 0) * 3;
	const ic = (mesh.indices[face * 3 + 2] ?? 0) * 3;
	const abx = (mesh.positions[ib] ?? 0) - (mesh.positions[ia] ?? 0);
	const aby = (mesh.positions[ib + 1] ?? 0) - (mesh.positions[ia + 1] ?? 0);
	const abz = (mesh.positions[ib + 2] ?? 0) - (mesh.positions[ia + 2] ?? 0);
	const acx = (mesh.positions[ic] ?? 0) - (mesh.positions[ia] ?? 0);
	const acy = (mesh.positions[ic + 1] ?? 0) - (mesh.positions[ia + 1] ?? 0);
	const acz = (mesh.positions[ic + 2] ?? 0) - (mesh.positions[ia + 2] ?? 0);
	const x = aby * acz - abz * acy;
	const y = abz * acx - abx * acz;
	const z = abx * acy - aby * acx;
	return Math.hypot(x, y, z) * 0.5;
}

function interpolatePosition(
	mesh: SourceMesh,
	face: number,
	barycentric: [number, number, number]
): [number, number, number] {
	const a = mesh.indices[face * 3] ?? 0;
	const b = mesh.indices[face * 3 + 1] ?? 0;
	const c = mesh.indices[face * 3 + 2] ?? 0;
	return [0, 1, 2].map((axis) =>
		(mesh.positions[a * 3 + axis] ?? 0) * barycentric[0] +
		(mesh.positions[b * 3 + axis] ?? 0) * barycentric[1] +
		(mesh.positions[c * 3 + axis] ?? 0) * barycentric[2]
	) as [number, number, number];
}

function measureSilhouette(source: MeshBvh, result: MeshBvh, bounds: Bounds, grid: number): { iou: number; depthMae: number } {
	const spans = bounds.max.map((value, axis) => value - bounds.min[axis]) as [number, number, number];
	let intersection = 0;
	let union = 0;
	let depthError = 0;
	let depthCount = 0;
	for (let axis = 0; axis < 3; axis++) {
		const uAxis = (axis + 1) % 3;
		const vAxis = (axis + 2) % 3;
		const margin = Math.max(spans[axis] * 0.05, bounds.diagonal * 1e-4);
		const maxDistance = spans[axis] + margin * 2;
		for (let y = 0; y < grid; y++) {
			for (let x = 0; x < grid; x++) {
				const origin: [number, number, number] = [0, 0, 0];
				origin[axis] = bounds.min[axis] - margin;
				origin[uAxis] = bounds.min[uAxis] + ((x + 0.5) / grid) * spans[uAxis];
				origin[vAxis] = bounds.min[vAxis] + ((y + 0.5) / grid) * spans[vAxis];
				const direction: [number, number, number] = [0, 0, 0];
				direction[axis] = 1;
				const sourceHit = raycastFirst(source, origin, direction, maxDistance);
				const resultHit = raycastFirst(result, origin, direction, maxDistance);
				if (sourceHit || resultHit) union += 1;
				if (sourceHit && resultHit) {
					intersection += 1;
					depthError += Math.abs(sourceHit.distance - resultHit.distance) / Math.max(spans[axis], 1e-9);
					depthCount += 1;
				}
			}
		}
	}
	return { iou: union > 0 ? intersection / union : 0, depthMae: depthCount > 0 ? depthError / depthCount : 1 };
}

function compareAgainstReference(reference: QualityMetrics, candidate: QualityMetrics, triangleBudget: number): string[] {
	const failures: string[] = [];
	if (candidate.triangles > triangleBudget) failures.push(`${candidate.triangles} triangles exceed budget ${triangleBudget}`);
	if (candidate.sourceToResult.p95 > reference.sourceToResult.p95 * 1.3 + 0.0005) {
		failures.push(`source coverage p95 ${format(candidate.sourceToResult.p95)} exceeds reference ${format(reference.sourceToResult.p95)}`);
	}
	if (candidate.resultToSource.p95 > reference.resultToSource.p95 * 1.3 + 0.0005) {
		failures.push(`surface drift p95 ${format(candidate.resultToSource.p95)} exceeds reference ${format(reference.resultToSource.p95)}`);
	}
	if (candidate.normalMeanDegrees > reference.normalMeanDegrees * 1.35 + 2) {
		failures.push(`normal error ${candidate.normalMeanDegrees.toFixed(2)}° exceeds reference ${reference.normalMeanDegrees.toFixed(2)}°`);
	}
	if (candidate.silhouetteIou + 0.025 < reference.silhouetteIou) {
		failures.push(`silhouette IoU ${format(candidate.silhouetteIou)} trails reference ${format(reference.silhouetteIou)}`);
	}
	if (candidate.depthMae > reference.depthMae * 1.5 + 0.005) {
		failures.push(`depth MAE ${format(candidate.depthMae)} exceeds reference ${format(reference.depthMae)}`);
	}
	return failures;
}

function boundsOf(positions: Float32Array): Bounds {
	const min: [number, number, number] = [Infinity, Infinity, Infinity];
	const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
	for (let index = 0; index + 2 < positions.length; index += 3) {
		for (let axis = 0; axis < 3; axis++) {
			const value = positions[index + axis] ?? 0;
			min[axis] = Math.min(min[axis], value);
			max[axis] = Math.max(max[axis], value);
		}
	}
	return { min, max, diagonal: Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) };
}

function stats(values: number[]): DistanceStats {
	if (values.length === 0) return { rms: Infinity, p95: Infinity, max: Infinity };
	const sorted = values.slice().sort((a, b) => a - b);
	const sumSquares = values.reduce((sum, value) => sum + value * value, 0);
	return {
		rms: Math.sqrt(sumSquares / values.length),
		p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? Infinity,
		max: sorted[sorted.length - 1] ?? Infinity
	};
}

function distance(a: [number, number, number], b: [number, number, number]): number {
	return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function normalizedDot(a: number[], b: number[]): number {
	const aLength = Math.hypot(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0);
	const bLength = Math.hypot(b[0] ?? 0, b[1] ?? 0, b[2] ?? 0);
	if (aLength <= 1e-9 || bLength <= 1e-9) return 0;
	return (((a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0)) / (aLength * bLength));
}

function fractional(value: number): number {
	return value - Math.floor(value);
}

function format(value: number): string {
	return value.toFixed(6);
}
