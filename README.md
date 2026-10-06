# Neuroform

A brain-shaped cloud of points, wired to each other by synapses. Touch a node
and it fires: the signal runs down its connections at a finite speed, charges
whatever it reaches, and whatever crosses threshold fires in turn. What you see
is a wave of activation sweeping out through the tissue and fading.

```
npm install
npm run dev
```

Click a node to fire it. Drag to orbit, scroll to zoom. `space` fires a random
node, `r` quiets the network. The panel in the corner opens with the structure,
signal and look controls.

## What's going on

**The shape** (`src/brain/shape.ts`) is an approximate signed distance field —
a cerebrum ellipsoid with a narrowed frontal pole, temporal lobes smooth-unioned
on, a flat base, a midline fissure subtracted from the top, a folia-striped
cerebellum and a brain stem. Ridged noise added to the distance carves the gyri,
which is what makes a cloud of dots read as cortex rather than as a lumpy egg.
Points are rejection-sampled from a thin shell just inside the surface, with a
sparse scatter deeper in so the mass has an interior.

**The wiring** (`src/graph/build.ts`) gives every node a random number of
synapses and spends them on its nearest neighbours, preferring close ones but
skipping some — strict nearest-neighbour wiring makes
a wave front that advances as a clean sphere, and a little disorder makes it
ragged. A few long-range tracts cross the midline so activation can jump
hemispheres.

**The activation** (`src/sim/network.ts`) is an excitable medium. A firing node
launches a pulse down each synapse that holds; pulses travel at a finite speed,
so long wires arrive late. Arriving signal deposits charge scaled by the
synapse's strength, charge leaks away continuously, and a node that crosses
threshold fires and then sits refractory. Signal amplitude decays with the
*distance travelled* rather than per hop, so how far a wave spreads stays the
same whether the cloud has 5,000 points or 100,000.

**The rendering** is three draw calls: the point cloud; every synapse, as a
very dim line (long-range tracts tinted violet in the same draw); and every
pulse in flight, drawn as a comet running from the firing node toward its
neighbour. Synapses and pulses pull their endpoints from node textures by
`gl_VertexID`, so each one knows both of its ends.

## Performance

The network is generated on a Web Worker, so the current one keeps animating
while its replacement is built. 100,000 nodes and 340,000 synapses build in
about 2 seconds off the main thread; swapping them in costs ~70ms on it.

- **Sampling** brackets each field with cheap analytic bounds and only
  evaluates the noise where those bounds can't decide, which is under 8% of
  candidates. The small regions are drawn from their own tight boxes rather
  than the whole brain's, and normals come from the smooth surface rather than
  the noisy one.
- **Wiring** finds each node's exact k nearest neighbours in an implicit k-d
  tree (kdbush's layout, in 3D), so its cost depends on k rather than on how
  many points sit within reach, and stays flat on clustered data or data with
  stray outliers, where a grid goes quadratic. Same graph as an exhaustive
  search.
- **The simulation is event-driven.** Pulses sit in a heap keyed by arrival
  time; charge leaks lazily when a pulse lands; glow is stored as (peak, start
  time) and decayed in the vertex shader. A frame costs time proportional to
  what happens in it, and a resting network costs nothing however large.
- **Uploads are sparse.** Only the nodes and pulses that changed are sent to
  the GPU each frame, and a pulse's position along its wire is computed from
  the shader clock, so its data is written once. Synapses are an index buffer
  over the node attributes rather than a copy of them.
- **Picking** marches the pointer ray through a grid instead of testing every
  point.
- **Lines are not instanced.** Instancing a two-vertex line hundreds of
  thousands of times wastes most of each vertex batch (it was 18x slower in
  testing); a plain draw that works out its synapse from `gl_VertexID` is not.
- **Rendering is paced.** While a wave runs or the camera is being handled,
  every frame is drawn; at rest only slow motion remains, so frames are drawn
  at `restFps` (20 by default) and the rest are skipped, about two thirds of
  them. The orbit is driven by elapsed time, so it turns at the same speed at
  any frame rate or refresh rate.

### Measuring the GPU

`?gpu=1` times each render pass with WebGL timer queries and shows the result
under the readout (synapses, points and pulses separately, then bloom and
output). Where the browser or GPU lacks the timer extension, `?gpu=finish`
brackets each pass with `gl.finish()` instead: it stalls the pipeline, so the
totals are inflated, but it still ranks the passes. From a script:
`neuroform.gpuTimings()` and `neuroform.resetGpuTimings()`.

## Driving it from data

The generator is one implementation of `GraphSource` (`src/graph/types.ts`); a
dataset is another. Load one with `?dataset=/your-graph.json`:

```json
{
  "nodes": [[x, y, z], ...],
  "edges": [[a, b], ...],
  "regions": [0, 1, ...],
  "depth": [0.0, ...]
}
```

`nodes` and `edges` may also be flat arrays. `regions` (colour grouping) and
`depth` (0 at the surface, 1 deep) are optional. Positions are centred and
scaled on load, so any units work. `public/sample-graph.json` is a worked
example: `?dataset=/sample-graph.json`.

For large data, any field can instead be a binary typed array in plotly's
format, which is what plotly.py writes for numpy arrays:

```json
{ "nodes": { "dtype": "f4", "bdata": "<base64>", "shape": "100000,3" },
  "edges": { "dtype": "u4", "bdata": "<base64>", "shape": "340000,2" } }
```

It loads about 40x faster than plain numbers (100k nodes and 340k synapses in
~12 ms instead of ~490 ms) and is smaller. Plain and binary fields can be mixed.
`public/sample-graph.typed.json` is the same sample in this form.

Everything downstream reads the same `NetworkGraph`, so nothing in the
simulation or the renderer changes when the network starts coming from a
dataset instead of from noise.

## Knobs

Any setting is also a URL parameter, so a particular brain is a link:
`?nodes=60000&foldScale=9&range=3&bloom=1.2&seed=42`.

| | |
|---|---|
| `nodes`, `seed` | how many points, and which brain |
| `foldDepth`, `foldScale`, `shell` | how deep and how fine the gyri, how thick the surface layer |
| `minDegree`, `maxDegree`, `radius` | synapses per node and how far they reach |
| `speed`, `range` | how fast signal travels and how far it gets before fading |
| `threshold`, `gain`, `decay`, `refractory` | what it takes to make a node fire |
| `reliability` | how often a synapse actually transmits |
| `glow`, `shimmer`, `spontaneous` | afterglow, idle sparkle, how often the network fires on its own |
| `pointSize`, `edgeOpacity`, `pulseIntensity`, `cometLength`, `bloom` | the look |
| `restFps` | frame rate while nothing fast is happening; `0` draws every frame |
| `gpu` | `1` for GPU pass timings, `finish` for the stalling fallback |

`?capture=1` keeps the drawing buffer readable for screenshots.
`window.neuroform` exposes the graph, the simulation and the layers for driving
the piece from a script: `stimulate(node?)`, `reset()`,
`look({ bloom: 1 })` and `rebuild({ nodes: 60000, seed: 3 })`.
