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

function sdEllipsoid(
  px: number, py: number, pz: number,
  cx: number, cy: number, cz: number,
  rx: number, ry: number, rz: number,
): number {
  const x = px - cx, y = py - cy, z = pz - cz;
  const k0 = Math.hypot(x / rx, y / ry, z / rz);
  const k1 = Math.hypot(x / (rx * rx), y / (ry * ry), z / (rz * rz));
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
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0));
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
  return Math.hypot(dx, dy, dz) - (ra + (rb - ra) * h);
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

const BOX = { x: 0.46, yMin: -0.62, yMax: 0.46, z: 0.62 };

interface FieldConfig {
  foldDepth: number;
  foldScale: number;
}

/** Cerebrum: hemispheres, temporal lobes, flat base, midline fissure. */
function cerebrumField(n: Noise3, cfg: FieldConfig, x: number, y: number, z: number): number {
  // Narrow the frontal pole and widen the occipital one: a brain is egg-shaped,
  // not symmetric front to back.
  const taper = 1 + 0.22 * Math.max(0, z) - 0.06 * Math.max(0, -z);
  let d = sdEllipsoid(x * taper, y, z, 0, 0.025, -0.01, 0.395, 0.35, 0.55);

  // Temporal lobes, one per side, slung low and forward.
  const tx = Math.abs(x);
  d = smin(d, sdEllipsoid(tx, y, z, 0.25, -0.17, 0.08, 0.12, 0.115, 0.27), 0.085);

  // The brain sits on a flattish base.
  d = smax(d, -(y + 0.235), 0.06);

  // Gyri. Ridged noise biased to a mid value so folds cut in and bulge out.
  const f = cfg.foldScale;
  const ridge = n.ridged(x * f, y * f * 0.85, z * f, 4) - 0.52;
  d += cfg.foldDepth * ridge;

  // A low-frequency wobble keeps the overall silhouette from looking machined.
  d += 0.018 * n.fbm(x * 2.1, y * 2.1, z * 2.1, 2);

  // Longitudinal fissure, open at the top, closed near the corpus callosum.
  // Carved last and with little smoothing: subtract it before the folds are
  // added and the fold displacement simply fills the gap back in.
  const fissure = sdBox(x, y, z, 0, 0.56, -0.02, 0.03, 0.5, 0.52);
  d = smax(d, -fissure, 0.012);

  return d;
}

/** Cerebellum: tucked under the occipital lobe, striped with fine folia. */
function cerebellumField(n: Noise3, x: number, y: number, z: number): number {
  const tx = Math.abs(x);
  let d = sdEllipsoid(x, y, z, 0, -0.315, -0.33, 0.235, 0.115, 0.165);
  d = smin(d, sdEllipsoid(tx, y, z, 0.1, -0.3, -0.3, 0.12, 0.1, 0.14), 0.06);
  // Horizontal folia: the cerebellum's signature texture.
  d += 0.011 * Math.sin(y * 150 + 1.6 * n.sample(x * 6, y * 3, z * 6));
  d += 0.01 * n.fbm(x * 9, y * 9, z * 9, 2);
  return d;
}

/** Brain stem: a tapered capsule dropping out of the base. */
function stemField(n: Noise3, x: number, y: number, z: number): number {
  let d = sdCapsule(x, y, z, 0, -0.16, -0.1, 0, -0.56, -0.15, 0.08, 0.045);
  d += 0.008 * n.fbm(x * 12, y * 12, z * 12, 2);
  return d;
}

/* ----------------------------------------------------------------- sampling */

type Field = (x: number, y: number, z: number) => number;

/** Central-difference gradient, used as an outward normal. */
function gradient(field: Field, x: number, y: number, z: number, out: Float32Array, o: number): void {
  const e = 0.004;
  let gx = field(x + e, y, z) - field(x - e, y, z);
  let gy = field(x, y + e, z) - field(x, y - e, z);
  let gz = field(x, y, z + e) - field(x, y, z - e);
  const len = Math.hypot(gx, gy, gz) || 1;
  gx /= len; gy /= len; gz /= len;
  out[o] = gx; out[o + 1] = gy; out[o + 2] = gz;
}

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

  const cerebrum: Field = (x, y, z) => cerebrumField(noise, cfg, x, y, z);
  const cerebellum: Field = (x, y, z) => cerebellumField(noise, x, y, z);
  const stem: Field = (x, y, z) => stemField(noise, x, y, z);

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

  const fill = (field: Field, others: Field[], target: number, id: Region, shellDepth: number) => {
    let placed = 0;
    // A generous iteration ceiling: rejection sampling a thin shell out of a
    // box converges fast, but never let a bad config spin forever.
    const ceiling = target * 900 + 20000;
    for (let iter = 0; placed < target && iter < ceiling; iter++) {
      const x = rng.range(-BOX.x, BOX.x);
      const y = rng.range(BOX.yMin, BOX.yMax);
      const z = rng.range(-BOX.z, BOX.z);

      const d = field(x, y, z);
      if (d > 0 || d < -shellDepth) {
        // Thin volumetric scatter deeper than the shell, so the mass has an
        // inside and long-range connections have something to pass through.
        if (!(d <= -shellDepth && rng.next() < interiorFraction * 0.06)) continue;
      }

      // Don't stack one region's points inside another's body.
      let occluded = false;
      for (const other of others) {
        if (other(x, y, z) < -0.004) { occluded = true; break; }
      }
      if (occluded) continue;

      const t = Math.min(1, -d / shellDepth);
      // Bias towards the surface: a bright rind over a dim interior.
      if (rng.next() > Math.pow(1 - t, 1.6) * 0.88 + interiorFraction * 0.7) continue;

      const o = written * 3;
      positions[o] = x; positions[o + 1] = y; positions[o + 2] = z;
      gradient(field, x, y, z, normals, o);
      depth[written] = t;
      region[written] = id;
      maxRadius = Math.max(maxRadius, Math.hypot(x, y, z));
      written++;
      placed++;
    }
  };

  fill(cerebrum, [cerebellum, stem], quota[0], REGION.CORTEX, shell);
  fill(cerebellum, [], quota[1], REGION.CEREBELLUM, shell * 0.6);
  fill(stem, [], quota[2], REGION.STEM, shell * 0.75);

  return {
    positions: positions.subarray(0, written * 3),
    normals: normals.subarray(0, written * 3),
    depth: depth.subarray(0, written),
    region: region.subarray(0, written),
    count: written,
    bounds: maxRadius || 1,
  };
}
