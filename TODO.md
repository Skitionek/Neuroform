# TODO

## Refine the brain shape: pick one
Three shapes are now selectable with `shape`: `classic`, `anatomical`
(procedural: lobes, longitudinal and lateral fissures, central sulcus,
contour-line gyri, cerebellum with vermis and curved folia, stem with pons)
and `scan` (signed distance field from the MNI ICBM152 template). Waiting on
the user's choice of default, from the renders in `docs/renders/`.
- Folds do not read in any shape at 55k nodes with cells on, even with
  `fill 0`. Showing gyri needs rendering work: shading by surface depth or
  curvature, or fewer and larger surface cells.
- `anatomical` still has a slight lip where the temporal lobe meets the
  body, seen from slightly above.

## Dark and light themes
Background colour becomes a setting, or the scene renders with an alpha
channel so it can sit on any page. A light theme needs more than a new
clear colour: nodes, pulses, synapses and cells all use additive blending,
which disappears on white. They need a blend mode and palette that work on
light backgrounds, and bloom needs checking there.

## Measure: single-channel cell density
Question: does dropping colours improve performance? Per-vertex colour is
almost free; cost is fill rate and overdraw. The exception is the cells'
density buffer, RGBA half-float, written with additive blending every frame
and the costliest pass. A single-channel buffer moves a quarter of the
bytes. Measure the gain against losing the cells' region tint and glow
colour; they could be looked up per node instead of carried per pixel.

## Done
- Zoom-based goo: zoomed out, the cells merge into one uniform brain mass and
  dots and synapses fade into it; zoomed in, it resolves into neurons
  (`merge`).
