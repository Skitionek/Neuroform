/**
 * Procedural brain geometry.
 *
 * The silhouette is an approximate signed distance field: a cerebrum ellipsoid
 * with temporal lobes smooth-unioned on, a flat base, a midline fissure
 * subtracted from the top, a folia-striped cerebellum and a brain stem.
 * Ridged noise added to the distance carves gyri and sulci, which is what makes
 * a cloud of dots read as cortex instead of as a lumpy egg.
 *
 * Points are rejection-sampled from the brain's volume: evenly throughout by
 * default, or concentrated in the shell just inside the surface (see fill).
 */
import { Noise3 } from '../core/noise';
import { Rng } from '../core/rng';
import { ANATOMICAL_BOXES, anatomicalFields } from './anatomical';
import { gridBox, gridDistance, gridRegion, type BrainGrid } from './scan';
import { EPS, NOISE_MAX, len3, sdBox, sdCapsule, sdEllipsoid, smax, smin, type Box, type Field, type FieldConfig } from './sdf';

export const REGION = { CORTEX: 0, CEREBELLUM: 1, STEM: 2 } as const;
export type Region = (typeof REGION)[keyof typeof REGION];

/**
 * Which brain: `classic` is the original egg with ridged-noise folds,
 * `anatomical` is built from lobes, fissures and named sulci, and `scan` fills
 * a real brain from the MNI ICBM152 template (its grid must be loaded first,
 * see scan.ts).
 */
export type BrainShape = 'classic' | 'anatomical' | 'scan';
export const BRAIN_SHAPES: readonly BrainShape[] = ['classic', 'anatomical', 'scan'];

export interface BrainSampleOptions {
  /** How many points to place. */
  count: number;
  shape?: BrainShape;
  /** The scan shape's distance grid; required when `shape` is 'scan'. */
  grid?: BrainGrid;
  seed?: number;
  /**
   * Depth below the surface over which a node goes from surface to deep, in
   * model units. Deep nodes are drawn smaller and dimmer, so the surface and
   * its folds still read when the volume is filled.
   */
  shell?: number;
  /** Amplitude of the cortical folding. */
  foldDepth?: number;
  /** Spatial frequency of the cortical folding. */
  foldScale?: number;
  /**
   * How nodes are spread through the brain: 1 fills the whole volume
   * evenly, 0 concentrates them in the surface shell (with a thin interior
   * scatter), values between blend the two.
   */
  fill?: number;
}

export interface BrainCloud {
  /** xyz triples, length = count * 3. */
  positions: Float32Array;
  /** Outward surface normal estimate per point, length = count * 3. */
  normals: Float32Array;
  /** 0 at the surface, 1 at the core. */
  depth: Float32Array;
  /** Region id per point. */
  region: Uint8Array;
  count: number;
  /** Radius of a sphere enclosing the cloud, for camera framing. */
  bounds: number;
}

/* --------------------------------------------------------------- the fields */


/** The whole brain. The cortex is sampled from this. */
const BOX: Box = { x: [-0.46, 0.46], y: [-0.62, 0.46], z: [-0.62, 0.62] };

/**
 * Tight boxes for the small regions. Sampled from the whole-brain box, the
 * cerebellum and stem (15% of the points) took 73% of all candidates. Each box
 * covers everywhere its field's lower bound can be <= 0 (the analytic shape
 * plus smooth-union bulge plus the full noise reach), with margin: measured
 * over 10M points per seed, the regions sit at least 0.027 inside, except
 * where the stem meets the brain box's own floor, which the full box shares.
 * Uniform samples from any box containing a region are distributed exactly
 * as samples from a larger one, so this changes which points are drawn for a
 * seed but not the distribution they are drawn from.
 */
const CEREBELLUM_BOX: Box = { x: [-0.3, 0.3], y: [-0.49, -0.14], z: [-0.56, -0.1] };
const STEM_BOX: Box = { x: [-0.12, 0.12], y: [-0.62, -0.04], z: [-0.27, 0.02] };

/** Cerebrum before folding: hemispheres, temporal lobes, flat base. */
function cerebrumBase(x: number, y: number, z: number): number {
  // Narrow the frontal pole and widen the occipital one: a brain is egg-shaped,
  // not symmetric front to back.
  const taper = 1 + 0.22 * Math.max(0, z) - 0.06 * Math.max(0, -z);
  let d = sdEllipsoid(x * taper, y, z, 0, 0.025, -0.01, 0.395, 0.35, 0.55);

  // Temporal lobes, one per side, slung low and forward.
  const tx = Math.abs(x);
  d = smin(d, sdEllipsoid(tx, y, z, 0.25, -0.17, 0.08, 0.12, 0.115, 0.27), 0.085);

  // The brain sits on a flattish base.
  d = smax(d, -(y + 0.235), 0.06);
  return d;
}

/** Longitudinal fissure, open at the top, closed near the corpus callosum. */
function fissureSlab(x: number, y: number, z: number): number {
  return sdBox(x, y, z, 0, 0.56, -0.02, 0.03, 0.5, 0.52);
}

const FISSURE_K = 0.012;
const WOBBLE = 0.018;

function cerebrumField(n: Noise3, cfg: FieldConfig): Field {
  const f = cfg.foldScale;
  // Ridged fbm lies in [0, 1], so the fold term lies in this range.
  const foldLo = cfg.foldDepth * (0 - 0.52);
  const foldHi = cfg.foldDepth * (1 - 0.52);

  return {
    exact(x, y, z) {
      let d = cerebrumBase(x, y, z);

      // Gyri. Ridged noise biased to a mid value so folds cut in and bulge out.
      const ridge = n.ridged(x * f, y * f * 0.85, z * f, 4) - 0.52;
      d += cfg.foldDepth * ridge;

      // A low-frequency wobble keeps the overall silhouette from looking machined.
      d += WOBBLE * n.fbm(x * 2.1, y * 2.1, z * 2.1, 2);

      // Carved last and with little smoothing: subtract the fissure before the
      // folds are added and the fold displacement simply fills the gap back in.
      return smax(d, -fissureSlab(x, y, z), FISSURE_K);
    },
    smooth(x, y, z) {
      return smax(cerebrumBase(x, y, z), -fissureSlab(x, y, z), FISSURE_K);
    },
    bounds(x, y, z, out) {
      const base = cerebrumBase(x, y, z);
      const fissure = -fissureSlab(x, y, z);
      // smax is monotone in its first argument, so bounding the input bounds
      // the output.
      out[0] = smax(base + foldLo - WOBBLE * NOISE_MAX, fissure, FISSURE_K) - EPS;
      out[1] = smax(base + foldHi + WOBBLE * NOISE_MAX, fissure, FISSURE_K) + EPS;
    },
  };
}

/** Cerebellum: tucked under the occipital lobe, striped with fine folia. */
function cerebellumBase(x: number, y: number, z: number): number {
  const tx = Math.abs(x);
  const d = sdEllipsoid(x, y, z, 0, -0.315, -0.33, 0.235, 0.115, 0.165);
  return smin(d, sdEllipsoid(tx, y, z, 0.1, -0.3, -0.3, 0.12, 0.1, 0.14), 0.06);
}

const FOLIA = 0.011;
const CEREBELLUM_GRAIN = 0.01;

function cerebellumField(n: Noise3): Field {
  const reach = FOLIA + CEREBELLUM_GRAIN * NOISE_MAX + EPS;
  return {
    exact(x, y, z) {
      let d = cerebellumBase(x, y, z);
      // Horizontal folia: the cerebellum's signature texture.
      d += FOLIA * Math.sin(y * 150 + 1.6 * n.sample(x * 6, y * 3, z * 6));
      d += CEREBELLUM_GRAIN * n.fbm(x * 9, y * 9, z * 9, 2);
      return d;
    },
    smooth: cerebellumBase,
    bounds(x, y, z, out) {
      const base = cerebellumBase(x, y, z);
      out[0] = base - reach;
      out[1] = base + reach;
    },
  };
}

/** Brain stem: a tapered capsule dropping out of the base. */
function stemBase(x: number, y: number, z: number): number {
  return sdCapsule(x, y, z, 0, -0.16, -0.1, 0, -0.56, -0.15, 0.08, 0.045);
}

const STEM_GRAIN = 0.008;

function stemField(n: Noise3): Field {
  const reach = STEM_GRAIN * NOISE_MAX + EPS;
  return {
    exact(x, y, z) {
      return stemBase(x, y, z) + STEM_GRAIN * n.fbm(x * 12, y * 12, z * 12, 2);
    },
    smooth: stemBase,
    bounds(x, y, z, out) {
      const base = stemBase(x, y, z);
      out[0] = base - reach;
      out[1] = base + reach;
    },
  };
}

/* ----------------------------------------------------------------- sampling */

type FieldFn = (x: number, y: number, z: number) => number;

/** Central-difference gradient, used as an outward normal. */
function gradient(field: FieldFn, x: number, y: number, z: number, out: Float32Array, o: number): void {
  const e = 0.004;
  let gx = field(x + e, y, z) - field(x - e, y, z);
  let gy = field(x, y + e, z) - field(x, y - e, z);
  let gz = field(x, y, z + e) - field(x, y, z - e);
  const len = len3(gx, gy, gz) || 1;
  gx /= len; gy /= len; gz /= len;
  out[o] = gx; out[o + 1] = gy; out[o + 2] = gz;
}

/** Counters from the last `sampleBrain` call, for profiling. */
export const samplerStats = { candidates: 0, exactEvals: 0 };

export function sampleBrain(options: BrainSampleOptions): BrainCloud {
  const {
    count,
    seed = 7,
    shell = 0.055,
    foldDepth = 0.034,
    foldScale = 7.4,
    fill = 1,
  } = options;

  const noise = new Noise3(seed);
  const rng = new Rng(seed * 2654435761);
  const cfg: FieldConfig = { foldDepth, foldScale };

  const parts = brainParts(options.shape ?? 'classic', noise, cfg, options.grid);

  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const depth = new Float32Array(count);
  const region = new Uint8Array(count);

  let written = 0;
  let maxRadius = 0;
  const range = new Float64Array(2);
  samplerStats.candidates = 0;
  samplerStats.exactEvals = 0;

  /** Is the point inside another region's body? Bounds first, noise if needed. */
  const occludedBy = (other: Field, x: number, y: number, z: number): boolean => {
    other.bounds(x, y, z, range);
    if (range[0] >= -0.004) return false;
    if (range[1] < -0.004) return true;
    samplerStats.exactEvals++;
    return other.exact(x, y, z) < -0.004;
  };

  const sampleRegion = ({ field, others, target, id, shellDepth, box, regionOf }: SampleTarget) => {
    const smooth: FieldFn = (x, y, z) => field.smooth(x, y, z);
    let placed = 0;
    // A generous iteration ceiling: sampling converges fast, but never let a
    // bad config spin forever.
    const ceiling = target * 900 + 20000;
    for (let iter = 0; placed < target && iter < ceiling; iter++) {
      const x = rng.range(box.x[0], box.x[1]);
      const y = rng.range(box.y[0], box.y[1]);
      const z = rng.range(box.z[0], box.z[1]);
      samplerStats.candidates++;

      // Most candidates are nowhere near the surface. Decide those from the
      // cheap bounds and only pay for noise inside the band where the bounds
      // straddle a threshold. The RNG is drawn in exactly the same places as
      // the unbounded test, so the output is identical.
      field.bounds(x, y, z, range);
      if (range[0] > 0) continue; // certainly outside
      let d: number;
      if (range[1] < -shellDepth) {
        d = -Infinity; // certainly deeper than the shell; depth clamps to 1
      } else {
        samplerStats.exactEvals++;
        d = field.exact(x, y, z);
        if (d > 0) continue;
      }

      // Don't stack one region's points inside another's body.
      let occluded = false;
      for (const other of others) {
        if (occludedBy(other, x, y, z)) { occluded = true; break; }
      }
      if (occluded) continue;

      const t = Math.min(1, -d / shellDepth);
      // Acceptance by depth: uniform through the volume at fill 1; at fill 0
      // a rind concentrated at the surface with a thin interior scatter.
      const rind = Math.pow(1 - t, 1.6) * 0.99 + 0.01;
      if (rng.next() > fill + (1 - fill) * rind) continue;

      const o = written * 3;
      positions[o] = x; positions[o + 1] = y; positions[o + 2] = z;
      gradient(smooth, x, y, z, normals, o);
      depth[written] = t;
      region[written] = regionOf ? regionOf(x, y, z) : id;
      maxRadius = Math.max(maxRadius, len3(x, y, z));
      written++;
      placed++;
    }
  };

  // Region quotas, roughly proportional to real volume share.
  let assigned = 0;
  parts.forEach((part, i) => {
    const target = i === parts.length - 1 ? count - assigned : Math.round(count * part.share);
    assigned += target;
    sampleRegion({ ...part, target, shellDepth: shell * part.shellScale });
  });

  return {
    positions: positions.subarray(0, written * 3),
    normals: normals.subarray(0, written * 3),
    depth: depth.subarray(0, written),
    region: region.subarray(0, written),
    count: written,
    bounds: maxRadius || 1,
  };
}

/* --------------------------------------------------------------- the shapes */

/** One region to sample: its field, what it must not overlap, and its share. */
interface Part {
  field: Field;
  /** Regions sampled before this one whose bodies it must stay out of. */
  others: Field[];
  /** Share of all nodes. */
  share: number;
  id: Region;
  /** Shell depth relative to the cortex's. */
  shellScale: number;
  box: Box;
  /** For a part spanning several regions: the region at a point. */
  regionOf?: (x: number, y: number, z: number) => Region;
}

interface SampleTarget extends Part {
  target: number;
  shellDepth: number;
}

function brainParts(shape: BrainShape, noise: Noise3, cfg: FieldConfig, grid?: BrainGrid): Part[] {
  if (shape === 'scan') {
    if (!grid) throw new Error('the scan shape needs its grid loaded');
    // One field for the whole brain, labelled by region per voxel. Sampled
    // uniformly, regions get nodes in proportion to their real volume.
    const distance = (x: number, y: number, z: number) => gridDistance(grid, x, y, z);
    const field: Field = {
      exact: distance,
      smooth: distance,
      bounds(x, y, z, out) {
        out[0] = out[1] = distance(x, y, z);
      },
    };
    return [{
      field, others: [], share: 1, id: REGION.CORTEX, shellScale: 1, box: gridBox(grid),
      regionOf: (x, y, z) => gridRegion(grid, x, y, z) as Region,
    }];
  }
  const f = shape === 'anatomical' ? anatomicalFields(noise, cfg) : {
    cerebrum: cerebrumField(noise, cfg),
    cerebellum: cerebellumField(noise),
    stem: stemField(noise),
  };
  const boxes = shape === 'anatomical'
    ? ANATOMICAL_BOXES
    : { cerebrum: BOX, cerebellum: CEREBELLUM_BOX, stem: STEM_BOX };
  return [
    { field: f.cerebrum, others: [f.cerebellum, f.stem], share: 0.845, id: REGION.CORTEX, shellScale: 1, box: boxes.cerebrum },
    { field: f.cerebellum, others: [], share: 0.115, id: REGION.CEREBELLUM, shellScale: 0.6, box: boxes.cerebellum },
    { field: f.stem, others: [], share: 0.04, id: REGION.STEM, shellScale: 0.75, box: boxes.stem },
  ];
}
