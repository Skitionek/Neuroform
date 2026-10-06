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

export function tissueColorFor(region: number): Color {
  return PALETTE.tissue[region] ?? PALETTE.tissue[0];
}
