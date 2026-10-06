/**
 * Procedural brain geometry.
 *
 * The silhouette is an approximate signed distance field: a cerebrum ellipsoid
 * with temporal lobes smooth-unioned on, a flat base, a midline fissure
 * subtracted from the top, a folia-striped cerebellum and a brain stem.
 * Ridged noise added to the distance carves gyri and sulci, which is what makes
 * a cloud of dots read as cortex instead of as a lumpy egg.
 *
 * Points are rejection-sampled from the shell just inside the surface, with a
 * thin volumetric scatter deeper in so the mass has interior.
 */
import { Noise3 } from '../core/noise';
import { Rng } from '../core/rng';

export const REGION = { CORTEX: 0, CEREBELLUM: 1, STEM: 2 } as const;
export type Region = (typeof REGION)[keyof typeof REGION];

export interface BrainSampleOptions {
  /** How many points to place. */
  count: number;
  seed?: number;
  /** Depth of the surface shell, in model units. */
  shell?: number;
  /** Amplitude of the cortical folding. */
  foldDepth?: number;
  /** Spatial frequency of the cortical folding. */
  foldScale?: number;
  /** Fraction of points scattered through the interior volume. */
  interiorFraction?: number;
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

/* ---------------------------------------------------------------- primitives */

/**
 * Euclidean length. Not Math.hypot: hypot guards against overflow, which never
 * matters at these magnitudes, and costs 12x as much in V8. The sampler calls
 * this millions of times per build.
 */
function len3(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z);
}

function sdEllipsoid(
  px: number, py: number, pz: number,
  cx: number, cy: number, cz: number,
  rx: number, ry: number, rz: number,
): number {
  const x = px - cx, y = py - cy, z = pz - cz;
  const k0 = len3(x / rx, y / ry, z / rz);
  const k1 = len3(x / (rx * rx), y / (ry * ry), z / (rz * rz));
  if (k1 === 0) return -Math.min(rx, ry, rz);
  return (k0 * (k0 - 1)) / k1;
}

function sdBox(
  px: number, py: number, pz: number,
  cx: number, cy: number, cz: number,
  hx: number, hy: number, hz: number,
): number {
  const qx = Math.abs(px - cx) - hx;
  const qy = Math.abs(py - cy) - hy;
  const qz = Math.abs(pz - cz) - hz;
  const outside = len3(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0));
  return outside + Math.min(Math.max(qx, Math.max(qy, qz)), 0);
}

function sdCapsule(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  ra: number, rb: number,
): number {
  const pax = px - ax, pay = py - ay, paz = pz - az;
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  const denom = bax * bax + bay * bay + baz * baz;
  const h = denom === 0 ? 0 : Math.min(1, Math.max(0, (pax * bax + pay * bay + paz * baz) / denom));
  const dx = pax - bax * h, dy = pay - bay * h, dz = paz - baz * h;
  return len3(dx, dy, dz) - (ra + (rb - ra) * h);
}

/** Smooth union. */
function smin(a: number, b: number, k: number): number {
  const h = Math.min(1, Math.max(0, 0.5 + (0.5 * (b - a)) / k));
  return b * (1 - h) + a * h - k * h * (1 - h);
}

/** Smooth intersection. */
function smax(a: number, b: number, k: number): number {
  const h = Math.min(1, Math.max(0, 0.5 - (0.5 * (b - a)) / k));
  return b * (1 - h) + a * h + k * h * (1 - h);
}

/* --------------------------------------------------------------- the fields */

interface Box { x: [number, number]; y: [number, number]; z: [number, number] }

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

/**
 * Upper bound on |simplex| (and therefore on normalised fbm). Measured maximum
 * over 10M samples is 0.973; the margin makes the bounds below safe, and the
 * sampler's output is checked bit-for-bit against the unbounded version.
 */
const NOISE_MAX = 1.1;
/** Guard against rounding flipping a decision exactly at a bound. */
const EPS = 1e-9;

interface FieldConfig {
  foldDepth: number;
  foldScale: number;
}

/**
 * A region of the brain. `exact` is the true distance; `bounds` brackets it
 * using only the analytic geometry plus the most the noise terms could
 * possibly add, which is an order of magnitude cheaper. Most sample candidates
 * are decided by the bounds alone and never pay for noise.
 */
interface Field {
  exact(x: number, y: number, z: number): number;
  /**
   * The region's smooth surface, without fold or grain noise. Normals come
   * from this: it is a handful of arithmetic operations where `exact` costs
   * several noise evaluations, and the normal of the underlying form is what
   * a normal is for.
   */
  smooth(x: number, y: number, z: number): number;
  /** Writes [lower, upper] bounds on `exact` into `out`. */
  bounds(x: number, y: number, z: number, out: Float64Array): void;
}

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
    interiorFraction = 0.17,
  } = options;

  const noise = new Noise3(seed);
  const rng = new Rng(seed * 2654435761);
  const cfg: FieldConfig = { foldDepth, foldScale };

  const cerebrum = cerebrumField(noise, cfg);
  const cerebellum = cerebellumField(noise);
  const stem = stemField(noise);

  // Region quotas, roughly proportional to real volume share.
  const quota = [
    Math.round(count * 0.845),
    Math.round(count * 0.115),
    0,
  ];
  quota[2] = Math.max(0, count - quota[0] - quota[1]);

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

  const fill = (field: Field, others: Field[], target: number, id: Region, shellDepth: number, box: Box) => {
    const smooth: FieldFn = (x, y, z) => field.smooth(x, y, z);
    const interiorChance = interiorFraction * 0.06;
    let placed = 0;
    // A generous iteration ceiling: rejection sampling a thin shell out of a
    // box converges fast, but never let a bad config spin forever.
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
      }

      if (d > 0 || d < -shellDepth) {
        // Thin volumetric scatter deeper than the shell, so the mass has an
        // inside and long-range connections have something to pass through.
        if (!(d <= -shellDepth && rng.next() < interiorChance)) continue;
      }

      // Don't stack one region's points inside another's body.
      let occluded = false;
      for (const other of others) {
        if (occludedBy(other, x, y, z)) { occluded = true; break; }
      }
      if (occluded) continue;

      const t = Math.min(1, -d / shellDepth);
      // Bias towards the surface: a bright rind over a dim interior.
      if (rng.next() > Math.pow(1 - t, 1.6) * 0.88 + interiorFraction * 0.7) continue;

      const o = written * 3;
      positions[o] = x; positions[o + 1] = y; positions[o + 2] = z;
      gradient(smooth, x, y, z, normals, o);
      depth[written] = t;
      region[written] = id;
      maxRadius = Math.max(maxRadius, len3(x, y, z));
      written++;
      placed++;
    }
  };

  fill(cerebrum, [cerebellum, stem], quota[0], REGION.CORTEX, shell, BOX);
  fill(cerebellum, [], quota[1], REGION.CEREBELLUM, shell * 0.6, CEREBELLUM_BOX);
  fill(stem, [], quota[2], REGION.STEM, shell * 0.75, STEM_BOX);

  return {
    positions: positions.subarray(0, written * 3),
    normals: normals.subarray(0, written * 3),
    depth: depth.subarray(0, written),
    region: region.subarray(0, written),
    count: written,
    bounds: maxRadius || 1,
  };
}
