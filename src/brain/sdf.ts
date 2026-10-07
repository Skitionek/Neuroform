/**
 * Signed distance primitives and smooth combinators for the brain shapes.
 */

/**
 * Euclidean length. Not Math.hypot: hypot guards against overflow, which never
 * matters at these magnitudes, and costs 12x as much in V8. The sampler calls
 * this millions of times per build.
 */
export function len3(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z);
}

export function sdEllipsoid(
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

export function sdBox(
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

export function sdCapsule(
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
export function smin(a: number, b: number, k: number): number {
  const h = Math.min(1, Math.max(0, 0.5 + (0.5 * (b - a)) / k));
  return b * (1 - h) + a * h - k * h * (1 - h);
}

/** Smooth intersection. */
export function smax(a: number, b: number, k: number): number {
  const h = Math.min(1, Math.max(0, 0.5 - (0.5 * (b - a)) / k));
  return b * (1 - h) + a * h + k * h * (1 - h);
}

/* ----------------------------------------------------------- field types */

/** An axis-aligned sampling box. */
export interface Box { x: [number, number]; y: [number, number]; z: [number, number] }

/**
 * Upper bound on |simplex| (and therefore on normalised fbm). Measured maximum
 * over 10M samples is 0.973; the margin makes the bounds below safe, and the
 * sampler's output is checked bit-for-bit against the unbounded version.
 */
export const NOISE_MAX = 1.1;
/** Guard against rounding flipping a decision exactly at a bound. */
export const EPS = 1e-9;

export interface FieldConfig {
  foldDepth: number;
  foldScale: number;
}

/**
 * A region of the brain. `exact` is the true distance; `bounds` brackets it
 * using only the analytic geometry plus the most the noise terms could
 * possibly add, which is an order of magnitude cheaper. Most sample candidates
 * are decided by the bounds alone and never pay for noise.
 */
export interface Field {
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
