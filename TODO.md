# TODO

## Refine the brain shape
The current shape is too simplistic: an ellipsoid cerebrum with noise for
gyri, a ridged cerebellum and a capsule stem. Make it read as a brain:
- Distinct lobes (frontal, parietal, temporal, occipital).
- A real longitudinal fissure between the hemispheres.
- A lateral (Sylvian) fissure separating the temporal lobe.
- Gyri and sulci that follow the anatomy instead of isotropic noise.
- A cerebellum and brainstem with proper proportions and attachment.
- Option: sample from a real brain surface, for example an SDF built from
  an MNI template mesh.

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
