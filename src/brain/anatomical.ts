/**
 * The "anatomical" brain: a procedural shape built from named parts, with the
 * proportions of the MNI ICBM152 template (the "scan" shape), instead of one
 * egg with noise on it.
 *
 * - Two hemispheres meet only below the corpus callosum; above it, and all
 *   the way through at the frontal and occipital poles, the longitudinal
 *   fissure separates them.
 * - Each hemisphere has a temporal lobe slung low and forward, divided from
 *   the frontal and parietal lobes by the lateral (Sylvian) fissure. A
 *   central sulcus runs from the vertex down and forward to meet it.
 * - Gyri are the zero contours of smooth noise, stretched front to back:
 *   narrow, deep sulci winding between broad, rounded gyri, which is what
 *   folded cortex looks like, rather than the uniform bumps of ridged noise.
 * - The cerebellum has two hemispheres and a vermis, tucked under the
 *   occipital lobes, with folia that follow its curve. The brain stem has a
 *   pons bulging forward of a tapering medulla.
 */
import type { Noise3 } from '../core/noise';
import {
  EPS, NOISE_MAX, len3, sdBox, sdCapsule, sdEllipsoid, smax, smin,
  type Box, type Field, type FieldConfig,
} from './sdf';

/* ------------------------------------------------------------------ cerebrum */

/** Corpus callosum and below: the only place the hemispheres join. */
function sdBridge(x: number, y: number, z: number): number {
  return sdBox(x, y, z, 0, -0.1, -0.03, 1, 0.155, 0.27);
}

/** Longitudinal fissure: a thin midline slab, everywhere but the bridge. */
function sdFissure(x: number, y: number, z: number): number {
  return Math.max(Math.abs(x) - 0.011, -sdBridge(x, y, z));
}

/**
 * A groove carved `depth` deep into the surface `d` along the plane through
 * (y0, z0) with unit normal (ny, nz) (the plane contains the x axis), only
 * where the region `within` (an SDF, negative inside) allows. Depth-limited:
 * removes {in slab} ∩ {within depth of the surface}, so a groove never cuts
 * a lobe in two.
 */
function groove(
  d: number, y: number, z: number,
  y0: number, z0: number, ny: number, nz: number,
  halfWidth: number, depth: number, within: number,
): number {
  const slab = Math.max(Math.abs((y - y0) * ny + (z - z0) * nz) - halfWidth, within);
  return Math.max(d, Math.min(-slab, d + depth));
}

// Lateral fissure: rises from the temporal pole towards the back.
const SYLVIAN_N = (() => { const l = Math.hypot(1, 0.33); return [1 / l, 0.33 / l]; })();
// Central sulcus: from the vertex just behind the middle, down and forward.
const CENTRAL_N = (() => { const l = Math.hypot(0.2, 0.35); return [0.2 / l, 0.35 / l]; })();

/** One hemisphere (x >= 0; mirrored by the caller) before folding. */
function hemisphere(x: number, y: number, z: number): number {
  // Dorsal body: one brain-wide form, so each hemisphere's medial face is
  // flat where the fissure cuts it, not rounded away into a V. Tallest just
  // behind the middle, narrowing to both poles, the frontal more bluntly.
  const front = Math.max(0, z);
  const taper = 1 + 0.18 * front;
  const back = Math.max(0, -z - 0.1);
  // Sheared down at the front, so the frontal lobe curves down over the
  // temporal pole instead of sitting on it like a brim.
  const sag = 0.12 * back * back + 0.14 * front;
  let d = sdEllipsoid(x * taper, y + sag, z, 0, 0.1, -0.03, 0.45, 0.31, 0.56);
  // Orbital surface: the frontal lobe's underside is flat.
  d = smax(d, -(y + 0.2), 0.05);

  // Temporal lobe: low and forward, its pole tipping down under the frontal
  // lobe, its back blending into the occipital.
  const ty = y + 0.17 + 0.2 * Math.max(0, z);
  const temporal = sdEllipsoid(x, ty, z, 0.285, 0, -0.06, 0.13, 0.13, 0.39);
  d = smin(d, temporal, 0.09);

  // Lateral fissure: a short tilted cleft in the front half of the side,
  // above the temporal lobe, not a cut all the way round.
  const lateral = sdBox(x, y, z, 0.47, 0, 0.14, 0.2, 0.4, 0.17);
  d = groove(d, y, z, -0.06, 0.25, SYLVIAN_N[0], SYLVIAN_N[1], 0.006, 0.045, lateral);

  // Central sulcus, above the lateral fissure.
  const dorsal = Math.max(0.02 - y, Math.abs(x) - 0.47);
  d = groove(d, y, z, 0.4, -0.1, CENTRAL_N[0], CENTRAL_N[1], 0.005, 0.05, dorsal);
  return d;
}

function cerebrumBase(x: number, y: number, z: number): number {
  const ax = Math.abs(x);
  let d = hemisphere(ax, y, z);
  // Diencephalon: fills the bridge between the hemispheres.
  d = smin(d, sdEllipsoid(x, y, z, 0, -0.08, -0.06, 0.13, 0.12, 0.24), 0.04);
  return smax(d, -sdFissure(x, y, z), 0.008);
}

/** Sulcus profile: 1 on a contour line, falling to 0 at `width` either side. */
function sulcus(n: number, width: number): number {
  const a = Math.abs(n);
  if (a >= width) return 0;
  const t = 1 - a / width;
  return t * t * (3 - 2 * t);
}

function cerebrumField(n: Noise3, cfg: FieldConfig): Field {
  const f = cfg.foldScale * 0.78;
  const amp = cfg.foldDepth * 1.6;
  // Primary sulci plus half-depth secondary ones; gyral crowns swell a little.
  const bias = 0.25 * amp;
  const lo = -bias;
  const hi = 1.5 * amp - bias;
  return {
    exact(x, y, z) {
      const d = cerebrumBase(x, y, z);
      // Mirror the folding so the hemispheres match, as real ones nearly do.
      const ax = Math.abs(x);
      // Stretched front to back: frontal and temporal gyri run lengthwise.
      const s1 = sulcus(n.sample(ax * f, y * f, z * f * 0.62), 0.16);
      const s2 = sulcus(n.sample(ax * f * 2.1 + 17, y * f * 2.1, z * f * 1.5), 0.13);
      return d + amp * (s1 + 0.5 * s2) - bias;
    },
    smooth: cerebrumBase,
    bounds(x, y, z, out) {
      const base = cerebrumBase(x, y, z);
      out[0] = base + lo - EPS;
      out[1] = base + hi + EPS;
    },
  };
}

/* ---------------------------------------------------------------- cerebellum */

const CEREBELLUM_C = [0, -0.33, -0.29] as const;

function cerebellumBase(x: number, y: number, z: number): number {
  const [, cy, cz] = CEREBELLUM_C;
  // Two hemispheres either side of a narrower, taller vermis.
  const ax = Math.abs(x);
  let d = sdEllipsoid(ax, y, z, 0.15, cy, cz, 0.17, 0.12, 0.18);
  d = smin(d, sdEllipsoid(x, y, z, 0, cy + 0.01, cz - 0.01, 0.07, 0.135, 0.17), 0.04);
  // Flattened on top, under the occipital lobes.
  return smax(d, y - (-0.2 - 0.25 * Math.max(0, ax - 0.1)), 0.03);
}

const FOLIA = 0.009;
const CEREBELLUM_GRAIN = 0.006;

function cerebellumField(n: Noise3): Field {
  const reach = FOLIA + CEREBELLUM_GRAIN * NOISE_MAX + EPS;
  const [, cy, cz] = CEREBELLUM_C;
  return {
    exact(x, y, z) {
      let d = cerebellumBase(x, y, z);
      // Folia: fine ridges that follow the cerebellum's curve, like the
      // leaves of a tree in section.
      const r = len3(0, y - cy - 0.06, z - cz + 0.04);
      d += FOLIA * Math.sin(r * 170 + 1.4 * n.sample(x * 5, y * 5, z * 5));
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

/* ---------------------------------------------------------------------- stem */

function stemBase(x: number, y: number, z: number): number {
  // Midbrain down to the medulla, leaning slightly back.
  let d = sdCapsule(x, y, z, 0, -0.12, -0.08, 0, -0.55, -0.15, 0.065, 0.04);
  // The pons bulges forward.
  d = smin(d, sdEllipsoid(x, y, z, 0, -0.3, -0.045, 0.085, 0.075, 0.07), 0.035);
  return d;
}

const STEM_GRAIN = 0.006;

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

/* --------------------------------------------------------------------- parts */

export interface AnatomicalFields {
  cerebrum: Field;
  cerebellum: Field;
  stem: Field;
}

export function anatomicalFields(n: Noise3, cfg: FieldConfig): AnatomicalFields {
  return { cerebrum: cerebrumField(n, cfg), cerebellum: cerebellumField(n), stem: stemField(n) };
}

/**
 * Sampling boxes: each covers everywhere its field's lower bound can be <= 0
 * (checked by sampling in development, with margin).
 */
export const ANATOMICAL_BOXES: { cerebrum: Box; cerebellum: Box; stem: Box } = {
  cerebrum: { x: [-0.5, 0.5], y: [-0.42, 0.47], z: [-0.64, 0.64] },
  cerebellum: { x: [-0.38, 0.38], y: [-0.5, -0.15], z: [-0.52, -0.08] },
  stem: { x: [-0.14, 0.14], y: [-0.64, -0.02], z: [-0.24, 0.08] },
};
