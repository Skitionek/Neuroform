import { Color } from 'three';

/**
 * Cool, desaturated tissue; hot, near-white signal. The contrast between the
 * two is the whole image, so the resting palette stays deliberately dim.
 */
export const PALETTE = {
  background: new Color('#04040a'),
  /** Resting colour per region: cortex, cerebellum, stem. */
  tissue: [new Color('#3d4a8f'), new Color('#2f6d78'), new Color('#6b5a86')],
  /** Firing colour, and the hotter core of a firing node. */
  signal: new Color('#7fe6ff'),
  signalCore: new Color('#ffffff'),
  /** Travelling pulse. */
  pulse: new Color('#aef0ff'),
  /** Long-range tracts, so midline crossings read differently. */
  tract: new Color('#c98ff5'),
};

/** The tissue colours as designed, around the default cortex blue. */
const BASE_TISSUE = PALETTE.tissue.map((c) => c.clone());

/**
 * Recolours the brain from one colour: the cortex takes `css`, and the
 * cerebellum and stem keep their designed offsets from it in hue,
 * saturation and lightness, so the regions still read apart.
 */
export function setBrainColor(css: string): void {
  const base = { h: 0, s: 0, l: 0 };
  const target = { h: 0, s: 0, l: 0 };
  const region = { h: 0, s: 0, l: 0 };
  BASE_TISSUE[0].getHSL(base);
  new Color(css).getHSL(target);
  PALETTE.tissue.forEach((colour, i) => {
    BASE_TISSUE[i].getHSL(region);
    const h = target.h + region.h - base.h;
    const s = Math.min(1, Math.max(0, target.s + region.s - base.s));
    const l = Math.min(1, Math.max(0, target.l * (region.l / Math.max(base.l, 1e-3))));
    colour.setHSL(h - Math.floor(h), s, l);
  });
}

/** Writes each node's tissue colour into `out`, `stride` floats per node. */
export function writeTissue(regions: Uint8Array, out: Float32Array, stride: number): void {
  for (let i = 0; i < regions.length; i++) {
    const c = tissueColorFor(regions[i]);
    out[i * stride] = c.r;
    out[i * stride + 1] = c.g;
    out[i * stride + 2] = c.b;
  }
}

export function tissueColorFor(region: number): Color {
  return PALETTE.tissue[region] ?? PALETTE.tissue[0];
}
