---
version: alpha
name: Kiln Workshop
description: A warm industrial workspace for reducing and comparing GLB meshes.
colors:
  background: "#14110E"
  background-raised: "#1C1814"
  panel: "#221C16"
  border: "#3A3128"
  ember: "#E2672A"
  ember-deep: "#B04316"
  copper: "#D8A15D"
  copper-deep: "#B8863F"
  text: "#F4EBE0"
  text-muted: "#9C8D7B"
  danger: "#E36A5A"
  result-better: "#86E59A"
  result-worse: "#E59A86"
  result-neutral: "#CFCFCF"
  preview: "#0B0B0B"
  on-ember: "#FFF8F2"
  on-copper: "#2A1C0D"
typography:
  display:
    fontFamily: "Iowan Old Style, Palatino Linotype, Palatino, Georgia, ui-serif, serif"
    fontSize: "3.4rem"
    fontWeight: 600
    letterSpacing: "-0.04em"
  body:
    fontFamily: "Iowan Old Style, Palatino Linotype, Palatino, Georgia, ui-serif, serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.45
  label-caps:
    fontFamily: "Iowan Old Style, Palatino Linotype, Palatino, Georgia, ui-serif, serif"
    fontSize: "0.72rem"
    fontWeight: 400
    letterSpacing: "0.14em"
  technical:
    fontFamily: "ui-monospace, Cascadia Code, SF Mono, Menlo, monospace"
    fontSize: "1rem"
    fontWeight: 400
rounded:
  input: "8px"
  button: "10px"
  control: "14px"
  preview: "16px"
spacing:
  xs: "4px"
  micro: "6px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  board: "28px"
  xxl: "40px"
components:
  button-primary:
    backgroundColor: "{colors.ember}"
    textColor: "{colors.on-ember}"
    rounded: "{rounded.button}"
    padding: "9px 12px"
  button-download:
    backgroundColor: "{colors.copper}"
    textColor: "{colors.on-copper}"
    rounded: "{rounded.button}"
    padding: "9px 12px"
  input:
    backgroundColor: "{colors.background}"
    textColor: "{colors.text}"
    rounded: "{rounded.input}"
    padding: "8px 10px"
  preview-pane:
    backgroundColor: "{colors.preview}"
    textColor: "{colors.text}"
    rounded: "{rounded.preview}"
    padding: "0px"
---

# Kiln visual system

This unstamped draft describes the UI implemented in [`app/assets/css/app.css`](../../app/assets/css/app.css) and [`app/pages/index.vue`](../../app/pages/index.vue). Its structure follows the [Google Labs DESIGN.md alpha format](https://github.com/google-labs-code/design.md/blob/main/docs/spec.md).

## Overview

Kiln feels like a compact workshop instrument: warm, dark, tactile, and technically precise. A narrow control board manages import and bake settings while the comparison stage receives most of the screen. The visual hierarchy keeps source and baked geometry as the primary evidence.

## Colors

- **Background and panel:** charred brown surfaces create the kiln/workshop atmosphere and keep the model preview visually dominant.
- **Ember:** orange marks the primary Bake action, active examples, drag focus, and active segmented controls.
- **Copper:** gold marks secondary emphasis and the Download action.
- **Text:** warm ivory carries primary copy; muted taupe carries helper text and stage chrome.
- **Status:** green communicates reduction success, coral communicates a larger result or an error, and neutral gray communicates equal triangle counts.
- **Preview:** near-black isolates mesh lighting and material color from the warm application chrome.

Use the frontmatter tokens as the normative palette. Keep status color paired with a text label or numeric result.

## Typography

The interface uses an old-style serif stack for a crafted workshop character. The `Kiln` masthead is fluid from `2.4rem` to `3.4rem`, weight 600, with tight `-0.04em` tracking. Uppercase labels use generous tracking for compact technical grouping. File names and numeric mesh metadata use the monospace stack.

## Layout

Desktop uses a two-column application shell: a `280px–420px` control board and a fluid comparison stage. The stage divides source and baked previews into equal columns with an `8px` gap. Controls follow a compact `4/6/8/12/16/24/28/40px` rhythm.

At `840px`, the shell becomes one column, the control board sits above the stage, and source/baked panes stack vertically. Each mobile pane keeps at least `38dvh` for mesh inspection.

## Elevation & Depth

Warm radial gradients lift the application background, and a subtle vertical gradient separates the control board. Borders and tonal layers group forms and settings. The deep `0 18px 50px rgba(0, 0, 0, 0.35)` shadow is reserved for preview panes so the evidence surface reads as the deepest layer.

## Shapes

Corner radius communicates hierarchy:

- `8px` for inputs and selects;
- `10px` for buttons and segmented controls;
- `14px` for drop zones and settings groups;
- `16px` for preview panes.

The shape language stays softly engineered: compact radii, one-pixel borders, and a dashed border for the upload target.

## Components

- **Drop zone:** full-width bordered target with direct title/copy hierarchy; hover and drag states use ember border and wash.
- **Example grid:** two equal columns of left-aligned ghost buttons; active selection uses the ember state.
- **Settings:** bordered fieldset with copper legend, stacked labels, and full-width dark controls. Expose target (triangle count or surface error), topology, geometry only, and atlas size; show voxel detail for the explicit Voxel path.
- **Actions:** Ember Bake, neutral Cancel, and copper Download establish clear operational priority. Disabled controls use 40% opacity.
- **Compare stage:** source stays on the left and baked output stays on the right on desktop. HUDs sit at the upper outer corners to preserve the central silhouette.
- **HUD:** uppercase kicker plus large triangle count; result state colors communicate reduced, larger, or equal output.
- **Result summary:** print the resolved topology and whether the output uses source maps or a fresh PBR atlas.
- **Preview toggles:** Lit and Unlit use a two-cell segmented control. Maps inspection (result, mesh, base color, normal, roughness, metallic) sits next to Wireframe. Mesh is the untextured view.

## Do's and Don'ts

- Keep the source/baked comparison visible as the dominant screen area.
- Keep source on the left and baked output on the right for every desktop comparison.
- Reserve ember for active state and the primary Bake action.
- Reserve copper for secondary emphasis and Download.
- Pair geometry quality colors with labels and exact triangle counts.
- Use monospace for file names, triangle metadata, and technical values.
- Preserve compact controls and generous preview space.
- Preserve the `840px` stacking breakpoint and minimum mobile preview heights.
- Keep new colors, spacing, radii, and typography synchronized with the frontmatter tokens and implementation CSS.
