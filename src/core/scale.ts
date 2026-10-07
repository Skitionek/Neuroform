/**
 * Settings are tuned at REFERENCE_NODES and rescaled for the actual node
 * count, so a slider means the same thing whatever the size of the brain:
 * 2,000 nodes and 200,000 sweep the same share of the brain in the same time
 * and look equally bright, only coarser or finer.
 *
 * The brain's volume is fixed, so typical node spacing goes as N^(-1/3).
 * Anything measured against the spacing scales with it; anything summed over
 * the screen (lines, comets) is divided by how much more of it there is.
 * Speed, range and the timings are already per unit of distance or time,
 * and fan-in does not depend on N, so they need nothing.
 */
export const REFERENCE_NODES = 55000;

/** Typical node spacing relative to the reference brain: (N0 / N)^(1/3). */
export function spacingScale(nodes: number): number {
  return Math.cbrt(REFERENCE_NODES / Math.max(1, nodes));
}

export interface ScalableLook {
  pointSize: number;
  edgeOpacity: number;
  pulseIntensity: number;
  cometLength: number;
  cellSize: number;
}

/** The look as drawn for `nodes`, from settings given at the reference count. */
export function scaleLook(look: ScalableLook, nodes: number): ScalableLook {
  const s = spacingScale(nodes);
  return {
    // Dots and cells keep their size relative to the gaps between them.
    pointSize: look.pointSize * s,
    cellSize: look.cellSize * s,
    // Comets keep their share of an edge.
    cometLength: look.cometLength * s,
    // Total synapse length grows as N * spacing = N^(2/3): the veil thins to match.
    edgeOpacity: Math.min(1, look.edgeOpacity * s * s),
    // Comets on a wave front grow as N^(2/3), each one ~spacing long.
    pulseIntensity: look.pulseIntensity * s,
  };
}

/** Synapse reach, which also sets how strongly short synapses are weighted. */
export function scaleReach(radius: number, nodes: number): number {
  return radius * spacingScale(nodes);
}

/** Pulses in flight grow with the network; the pool has to as well. */
export function pulseCapacity(nodes: number): number {
  return Math.max(24000, Math.ceil(nodes * 0.5));
}
