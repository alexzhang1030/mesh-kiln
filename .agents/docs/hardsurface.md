# Hard-surface geometry kernel

Applies to the explicit `hardsurface` topology only — [`src/kernels/hardsurface.ts`](../../src/kernels/hardsurface.ts), wired through [`topology.ts`](../../src/kernels/topology.ts), [`types.ts`](../../src/kernels/types.ts) `TopologyMode`, bake `runGeometry`, and the Topology select.

Hard-surface collapse locks large-dihedral panel seams and removes only coplanar / near-coplanar interior edges (redundant subdivision on flat panels). Every output vertex position must already exist in the input position set. Compare with `1e-6` for float noise only — not a snap radius. Flat regions may become larger faces; export triangulates with existing verts only.

This is not Instant Meshes, not organic remesh, and not meshoptimizer QEM. Those paths invent or slide vertices. Do not implement this kernel inside [`simplify.ts`](../../src/kernels/simplify.ts).

Auto must never select this path. Auto stays authored QEM under 100k (when the budget keeps source maps), seam-welded surface QEM at or above 100k or soup, and voxel remesh for open reconstructions. Users pick Hard-surface on purpose.

Atlas bake is a follow-up. v1 reuses the existing geometry-then-atlas switch: Geometry only writes a geometry GLB; a full bake still unwraps and bakes maps like surface/voxel. Do not invent a separate product story for hard-surface maps.

Evidence: [`hardsurface.test.ts`](../../src/kernels/hardsurface.test.ts) (flat panel + beveled box; position subset; feature edges survive), [`topology.test.ts`](../../src/kernels/topology.test.ts) (explicit override; Auto never returns `hardsurface`).
