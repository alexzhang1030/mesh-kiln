# Needle Mesh Baker feature map

Researched 2026-09-02 from the [official Mesh Baker docs](https://engine.needle.tools/docs/products/needle-mesh-baker.html) (build `7a4eec2` on [mesh-baker.needle.tools](https://mesh-baker.needle.tools/)) and the live workbench. Kiln v1 stays local-GLB; Needle Cloud, accounts, impostors, AO, OBJ/FBX, and generative models stay out of scope.

## Default workbench (ship in Kiln)

| Needle control | What it does | Kiln |
| --- | --- | --- |
| Triangle budget | Ceiling on output triangles | Yes |
| Target: triangle count \| surface error | Count ceiling, or meshoptimizer relative error and let the count fall out | Surface error added |
| Topology: voxel remesh \| simplify authored | Rebuild vs keep authored connectivity | Auto / Voxel / Authored |
| Interactive geometry preview | Drag the budget; geometry updates before atlas bake | Added |
| Texture resolution 256–4096 | Atlas size | Yes |
| Shading Lit \| Unlit | Preview lighting off | Yes. Mesh (untextured) lives under Maps |
| Channel views | Result, mesh, base color, normal, roughness, metallic | Added on the baked pane |
| Wireframe | Overlay | Yes |
| Linked orbit cameras | Source left, result right | Yes |
| PBR atlas | Base color, normal, MR, emissive | Yes (opacity/AO not in v1) |

## Documented, not in Kiln v1

| Needle | Why it stays out |
| --- | --- |
| OBJ / FBX / ZIP / Cloud import | README v1: GLB only |
| Optional AO map | README v1 |
| GPU bake | Kiln is CPU meshopt + watlas |
| Impostors, splat→mesh, image/text generate | README v1; Needle docs also mark impostors / splats / quads / vertex-color PBR as coming soon |
| Hard-edge / small-part / silhouette sliders | Extra options; Auto already lock-borders then permissive |
| WebMCP, Inspector handoff, paid download | Product, not the baker kernel |

## Live extra options (Show ALL)

Needle's hidden panel includes voxel resolution 50/100/160/256 (Kiln exposes this on explicit Voxel), crease weights, chart packing, Fast/Quality/Accurate map bake, separate alpha blends, and CPU/GPU. Kiln keeps voxel resolution on the Voxel path only.

## Sources

- https://engine.needle.tools/docs/products/needle-mesh-baker.html
- https://mesh-baker.needle.tools/ (commit `7a4eec2`, 2026-09-01)
