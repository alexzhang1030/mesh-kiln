# Kiln

Local-in-browser GLB triangle reducer (Nuxt SPA, pnpm@12). Drop a GLB, choose a triangle budget (or a surface error) and bake strategy, then download the result. Geometry only updates the mesh before the atlas bake. Import and bake stay on this machine.

- Live: https://mesh-kiln.alexzx.com
- Source: https://github.com/alexzhang1030/mesh-kiln

Auto chooses the appearance-preserving path for each model:

- Clean meshes below 100k triangles use authored QEM and retain source UVs and maps.
- Open reconstructions (gaussian_mesh, scans: unique positions, few shared edges, ≥10k triangles) voxel-remesh, unwrap a fresh watlas atlas, and bake PBR maps. Unlit vertex-color sources stay unlit.
- Dense connected sculpts and triangle soup weld exact position seams, simplify the continuous surface, unwrap a fresh watlas atlas, and bake PBR maps.
- Explicit Voxel mode rebuilds the surface through occupancy and dual contouring before atlas bake.

The atlas bake transfers base color, tangent-space normal, metallic/roughness, emissive, and vertex color. Source sampling and exported UVs follow the glTF upper-left texture origin.

## Run

```bash
git clone https://github.com/alexzhang1030/mesh-kiln.git
cd mesh-kiln
pnpm install
pnpm dev
```

Open `http://127.0.0.1:43173`. Drop a `.glb`, or pick Tower / Car / Dog / Bear. Attribution is in `NOTICE.md`.

```bash
pnpm test
pnpm build
```

`pnpm fixture` writes `public/sample-crest.glb` for kernel tests. Product examples remain in `public/examples/`.

`pnpm quality:geometry -- --source source.glb --reference reference.glb --budget 6000 --topology auto` measures bidirectional surface distance, normal error, silhouette IoU, and depth error against a reference bake.

`vercel.json` installs and builds with `npx pnpm@12.1.0`, bypassing Vercel's cached placeholder shim.

`pnpm build` copies `node_modules/watlas/dist/watlas.wasm` to `public/watlas.wasm` before Nuxt runs. This keeps `/watlas.wasm` present in `.vercel/output/static` across Vercel install-cache paths.

The bake worker loads `/watlas.wasm` through watlas `findWasmBinary`. A direct public URL sidesteps Rolldown’s `0+new URL(...).href` transform around Vite `?url` imports.

## Pipeline

| Stage | Owner | What it does |
| --- | --- | --- |
| **Import** (import worker) | glTF-Transform `WebIO` | GLB → merged `SourceMesh`. Transferable buffers only. |
| **Geometry · Auto reconstruction** | `kernels/remesh.ts` | Open splat/scan meshes voxel-remesh a surface shell (no dilate/fill) before atlas bake. |
| **Geometry · Auto dense** | `kernels/surface-simplify.ts` | Weld exact position seams and simplify the continuous surface to the triangle ceiling. |
| **Geometry · Authored** | `kernels/simplify.ts` | Attribute-aware QEM with source positions, UVs, vertex colors, and material groups. |
| **Geometry · Voxel** | `kernels/remesh.ts` | Occupancy, dual contour/QEF, source snap, and QEM ceiling. Dilate/fill only when occupancy is a solid volume. |
| **Atlas** | watlas + `bake-worker/map-bake.ts` | Fresh UV charts and BVH projection of PBR source maps. |
| **Export** | glTF-Transform | One GLB with geometry, tangents, and embedded PNG maps. |

Preview (`preview/`) is two OffscreenCanvas viewers, source left / baked right, shared orbit. Lit, Unlit, map channels, and wireframe are preview-only.

## Module boundaries

- `session/` — the only `postMessage` surface. The import worker owns vertex parsing.
- `import-worker/` — GLB parse.
- `bake-worker/` — bake state machine.
- `kernels/` — geometry, texture, and third-party mesh-library adapters.
- `preview/` — read-only dual compare.

Pinned packages: `meshoptimizer@1.2.0`, `watlas@1.0.1`.

## Out of scope (v1)

Impostors, splats, generative models, AO maps, OBJ/FBX import.
