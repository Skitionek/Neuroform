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
synapses and spends them on nearby nodes found through a spatial hash,
preferring close ones but skipping some — strict nearest-neighbour wiring makes
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

**The rendering** is three draw calls: one static point cloud with a single
dynamic float per node, one very dim static line mesh for the synapses at rest,
and one dynamic line mesh rebuilt each frame holding only the synapses currently
carrying a pulse, each drawn as a comet running from the firing node toward its
neighbour.

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

`?capture=1` keeps the drawing buffer readable for screenshots.
`window.neuroform` exposes the graph, the simulation and the layers for driving
the piece from a script.
