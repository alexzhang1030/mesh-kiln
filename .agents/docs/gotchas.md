# Bake quality gotchas

Evaluate every low-poly result through topology continuity, material transfer, and visual comparison. Tests under [`src/`](../../src/) and [`scripts/geometry-quality.ts`](../../scripts/geometry-quality.ts) are the current baseline.

## Route topology from source structure

Auto applies three appearance-preserving paths:

- Clean indexed meshes below 100,000 triangles use authored QEM and retain source UVs and maps.
- Open reconstructions — unique positions, shared-edge ratio below 0.65, at least 10,000 triangles — voxel-remesh, unwrap a fresh watlas atlas, and bake PBR maps. `gaussian_mesh` vertex-color plants are this class: seam-welded QEM collapses the foliage into debris because almost every vertex sits on a border.
- Dense connected sculpts at or above 100,000 triangles and triangle soup use seam-welded surface simplification, a fresh watlas atlas, and PBR map baking.
- Explicit Voxel mode remains available for occupancy and dual-contour reconstruction.

Dilate and interior fill run only when occupancy encloses a real volume (interior cells > half the voxelized shell). Open reconstructions keep the triangle-overlapping shell so nearby leaves stay separate; QEM on that shell does not prune islands. A 160³ gaussian plant had ~37k shell cells and ~400 interior cells — dilation nearly tripled the shell and fused the foliage. Closed sculpts (crest) still fill. Evidence: [`remesh.test.ts`](../../src/kernels/remesh.test.ts) foliage sprigs keep multiple islands; [`voxel-occupancy.ts`](../../src/kernels/voxel-occupancy.ts) `occupancyLooksSolid()`.

UV seams and split normals create duplicate vertices at the same position. Treating those duplicates as disconnected topology can open seams and remove facial or limb features during aggressive reduction. [`weldPositionSeams()`](../../src/kernels/surface-simplify.ts) rejoins exact position duplicates, filters degenerate faces, recomputes normals, and feeds the continuous surface into QEM. The fresh atlas carries material attributes after this weld. Unlit sources keep `KHR_materials_unlit` on atlas export so vertex-color reconstructions do not pick up studio lighting.

The routing policy lives in [`topology.ts`](../../src/kernels/topology.ts). [`topology.test.ts`](../../src/kernels/topology.test.ts) fixes the 100k threshold, triangle-soup heuristic, reconstruction-vs-tetrahedron split, Auto default, and explicit overrides. [`example-meshes.test.ts`](../../src/kernels/example-meshes.test.ts) pins Bear to the surface path. [`surface-simplify.test.ts`](../../src/kernels/surface-simplify.test.ts) covers UV-seam welding and the Bear 6k ceiling.

Authored QEM also treats the triangle budget as a ceiling. [`simplify.ts`](../../src/kernels/simplify.ts) progresses from border-locked low-error attempts through permissive and prune-permissive attempts, returning as soon as the target is reached. [`simplify.test.ts`](../../src/kernels/simplify.test.ts) pins the dense Bear ceiling.

## Keep the texture-coordinate chain consistent

glTF texture coordinate `(0, 0)` addresses the upper-left image corner. The same orientation must flow through all three boundaries:

1. Source sampling maps `y = v * (height - 1)` in [`images.ts`](../../src/kernels/images.ts).
2. watlas output stores normalized `v` directly in [`unwrap.ts`](../../src/kernels/unwrap.ts).
3. Atlas rasterization maps target `y = v * size` in [`map-bake.ts`](../../src/bake-worker/map-bake.ts).

A vertical flip at one boundary rotates the sampled material relationship and can turn recognizable colors into a global mosaic. [`images.test.ts`](../../src/kernels/images.test.ts) pins the glTF origin, while [`pipeline.test.ts`](../../src/bake-worker/pipeline.test.ts) pins top-to-bottom color through a complete atlas bake. The external contract is the [Khronos glTF 2.0 texture specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#images).

## Score projection hits by geometry

Source projection chooses the smallest geometric distance. Source-island identity resolves equal-distance ties. An absolute island preference can select a farther surface and transfer unrelated eye, scarf, or body texels.

Keep the selected source `faceIndex`, barycentric coordinates, and UV together through shading. That tuple identifies the material and drives base color, opacity, vertex color, metallic/roughness, occlusion, emissive, and normal sampling. Occlusion from a source map (or a short hemisphere estimate) is packed into the ORM red channel. [`map-bake.test.ts`](../../src/bake-worker/map-bake.test.ts) covers nearest-surface priority and original triangle/material identity.

## Transfer source normal maps through both tangent bases

The atlas normal map represents the source shading normal in the low-poly tangent basis:

1. [`source-tangents.ts`](../../src/kernels/source-tangents.ts) computes the source vertex tangent and handedness from source positions, normals, and UVs.
2. `shadeNormal()` samples the source tangent-space normal, applies `normalScale`, and converts it to world space.
3. The bake loop projects that world normal into the target tangent, bitangent, and normal basis before encoding the atlas texel.

Copy `normalScale` through import, session cloning, and authored export. [`source-tangents.test.ts`](../../src/kernels/source-tangents.test.ts) fixes the source basis, and [`map-bake.test.ts`](../../src/bake-worker/map-bake.test.ts) fixes the tangent-space Y transformation.

## Preserve browser responsiveness during CPU baking

Long geometry and map loops yield through [`cooperative.ts`](../../src/kernels/cooperative.ts). Map baking yields after 256 triangles or 500 ms; voxel remeshing yields after 250 ms. `MessageChannel` provides the worker task boundary, with a timer fallback for compatible runtimes.

Keep cancellation checks adjacent to these yield points. Browser acceptance includes visible progress and interaction on dense examples alongside output quality.

## Keep import and bake as separate user actions

Import completes in the ready state and loads the source preview. The user can then choose triangle budget, topology, atlas size, and voxel detail before pressing Bake. This boundary prevents a dense default bake from starting before the chosen settings are visible.

Surface and Voxel progress both report Geometry, UV atlas, Tangents, Maps, and Export. Authored progress reports Geometry and Export. Keep the resolved topology in the result summary so reviewers can tell which quality contract produced the file.

## Run reference-relative and visual gates

[`scripts/geometry-quality.ts`](../../scripts/geometry-quality.ts) compares a candidate with a reference using:

- triangle ceiling;
- bidirectional normalized surface-distance p95;
- mean normal error;
- three-axis silhouette IoU;
- three-axis depth MAE.

The merged Needle owl evidence used one decoded public source and a 6k budget:

| Metric | Needle result | Kiln Auto |
| --- | ---: | ---: |
| Triangles | 5,964 | 5,996 |
| Source-to-result p95 | 0.003486 | 0.002166 |
| Result-to-source p95 | 0.001965 | 0.002075 |
| Mean normal error | 19.96 degrees | 15.12 degrees |
| Three-axis silhouette IoU | 0.990964 | 0.989555 |
| Depth MAE | 0.002348 | 0.002969 |

The browser gate used the checked-in Bear: 499,932 source triangles to 5,995 baked triangles at a 256px atlas, with face, scarf, limbs, and continuous surface preserved. Re-run Lit and Surface comparison whenever topology routing, UV orientation, projection scoring, tangent construction, material decoding, or preview shading changes.

Lit and Unlit must apply to both compare panes for Result and Base color. Map inspect used to swap only the baked pane to `MeshBasicMaterial` for Base color, so studio lighting hit the source and skipped the bake. Compare then looked like a color-transfer failure. Normal, roughness, and metallic stay unlit debug views. `KHR_materials_unlit` sources still load as `MeshBasicMaterial` so vertex-color reconstructions do not pick up the studio lights. Evidence: [`shading.test.ts`](../../src/preview/shading.test.ts).

The standard verification set is:

```bash
node_modules/.bin/vitest run
node scripts/sync-watlas-wasm.mjs
node_modules/.bin/nuxi build
node scripts/assert-client-assets.mjs
node_modules/.bin/vite-node scripts/geometry-quality.ts \
  --source <decoded-source.glb> \
  --reference <decoded-reference.glb> \
  --budget 6000 \
  --topology auto
```
