# Project context map

These records are unstamped drafts. They capture the current repository state; a human review can vouch their direction.

| Scope or hotspot | Read | Current gist |
| --- | --- | --- |
| Product intent, supported workflow, and v1 scope | [Root README](../../README.md) | Kiln is a local browser GLB reducer with model-aware topology selection and downloadable GLB output. |
| Pipeline stages and module ownership | [Pipeline](../../README.md#pipeline) and [module boundaries](../../README.md#module-boundaries) | Import, geometry, atlas, export, session, and preview responsibilities are already documented at the repository root. |
| Auto topology and continuous-surface simplification | [Bake quality gotchas — topology](gotchas.md#route-topology-from-source-structure) | Open reconstructions voxel-remesh a surface shell (no dilate/fill); dense connected sculpts seam-weld then QEM; clean models keep source maps only when the budget stays above half the triangles. |
| UV, projection, source maps, and normal transfer | [Bake quality gotchas — material transfer](gotchas.md#keep-the-texture-coordinate-chain-consistent) | Texture orientation, geometric hit scoring, and tangent bases form one coupled transfer contract. |
| Geometry and browser acceptance | [Bake quality gotchas — acceptance](gotchas.md#run-reference-relative-and-visual-gates) | Triangle count, surface metrics, and live Lit/Unlit on both panes (Result and Base color) are separate gates. |
| UI styling, layout, and component treatment | [DESIGN.md](DESIGN.md) | Warm workshop palette, compact control board, and dominant side-by-side preview stage. |
| Needle Mesh Baker feature parity | [needle-parity.md](needle-parity.md) | Default workbench: budget or surface error, geometry only, Unlit, channel views. AO/impostors stay out. |

## Durable evidence

- Regression suite: [`src/**/*.test.ts`](../../src/)
- Reference-relative gate: [`scripts/geometry-quality.ts`](../../scripts/geometry-quality.ts)
