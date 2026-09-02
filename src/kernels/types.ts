export type TopologyMode = 'auto' | 'voxel' | 'authored';

export type GeometryTarget = 'triangles' | 'error';

export const SURFACE_ERRORS = [0.001, 0.01, 0.02, 0.05, 0.1] as const;

export type BakeStage = 'geometry' | 'uv' | 'tangents' | 'maps' | 'export';

export const VOXEL_RESOLUTIONS = [50, 100, 160, 256] as const;
export type VoxelResolution = (typeof VOXEL_RESOLUTIONS)[number];

export const MAP_SIZES = [256, 512, 1024, 2048, 4096] as const;
export type MapSize = (typeof MAP_SIZES)[number];

export type RgbaImage = {
	width: number;
	height: number;
	rgba: Uint8Array;
};

export type AlphaMode = 'OPAQUE' | 'MASK' | 'BLEND';

export type SourceMaterial = {
	baseColorFactor: [number, number, number, number];
	baseColor?: RgbaImage;
	normal?: RgbaImage;
	normalScale?: number;
	alpha?: RgbaImage;
	metallicFactor: number;
	roughnessFactor: number;
	metallicRoughness?: RgbaImage;
	occlusion?: RgbaImage;
	occlusionStrength?: number;
	emissiveFactor: [number, number, number];
	emissive?: RgbaImage;
	alphaMode?: AlphaMode;
	alphaCutoff?: number;
	unlit?: boolean;
};

export type MeshGeometry = {
	positions: Float32Array;
	indices: Uint32Array;
	normals: Float32Array;
};

export type SourceMesh = MeshGeometry & {
	uvs: Float32Array | null;
	colors: Float32Array | null;
	triangleMaterials: Uint16Array;
	materials: SourceMaterial[];
};

export type LowPolyMesh = MeshGeometry & {
	uvs: Float32Array;
	tangents: Float32Array;
};

export type BakeSettings = {
	triangleBudget: number;
	topologyMode: TopologyMode;
	mapSize: number;
	voxelResolution?: VoxelResolution;
	geometryTarget?: GeometryTarget;
	surfaceError?: number;
	geometryOnly?: boolean;
};

export const DEFAULT_BAKE_SETTINGS: BakeSettings = {
	triangleBudget: 6000,
	topologyMode: 'auto',
	mapSize: 2048,
	voxelResolution: 160,
	geometryTarget: 'triangles',
	surfaceError: 0.01
};

export type ResolvedBakeSettings = {
	triangleBudget: number;
	topologyMode: TopologyMode;
	mapSize: number;
	voxelResolution: VoxelResolution;
	geometryTarget: GeometryTarget;
	surfaceError: number;
	geometryOnly: boolean;
};

export function normalizeVoxelResolution(value: number | undefined): VoxelResolution {
	if (value === 50 || value === 100 || value === 160 || value === 256) return value;
	return 160;
}

export function normalizeSurfaceError(value: number | undefined): number {
	if (value !== undefined && Number.isFinite(value) && value > 0) return Math.min(1, value);
	return 0.01;
}

export function resolveBakeSettings(settings: BakeSettings): ResolvedBakeSettings {
	return {
		triangleBudget: settings.triangleBudget,
		topologyMode: settings.topologyMode,
		mapSize: settings.mapSize,
		voxelResolution: normalizeVoxelResolution(settings.voxelResolution),
		geometryTarget: settings.geometryTarget === 'error' ? 'error' : 'triangles',
		surfaceError: normalizeSurfaceError(settings.surfaceError),
		geometryOnly: settings.geometryOnly === true
	};
}

export function triangleCountOf(indices: Uint32Array): number {
	return Math.floor(indices.length / 3);
}

export function vertexCountOf(positions: Float32Array): number {
	return Math.floor(positions.length / 3);
}
