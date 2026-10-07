/**
 * Which nodes are drawn as neurons, and which neurons are linked.
 *
 * Every node takes part in the simulation; only a sparse subset is drawn as a
 * cell body (soma), because blobs for all of them would fuse into one mass.
 * Two somas are linked by a neurite when a short synaptic path joins them, so
 * the visible wiring follows the real graph: with a dataset in which every
 * node is a neuron, set the fraction to 1 and the links are the synapses.
 */
import type { NetworkGraph } from './types';

export interface NeuronLayout {
  /** Node index of each soma. */
  somas: Uint32Array;
  /** Node index pairs (a, b) per neurite. */
  links: Uint32Array;
}

export interface NeuronOptions {
  /** Share of nodes drawn as somas, in (0, 1]. */
  fraction: number;
  /**
   * How many synapses apart two somas may be and still be linked. Defaults to
   * scaling with soma spacing: in a 3D network the hop distance to the
   * nearest soma grows as (1 / fraction)^(1/3), and a fixed small limit left
   * sparse somas with no neurites at all.
   */
  maxHops?: number;
  /** Neurites per soma, at most (nearest first). */
  linksPerSoma?: number;
  /** Longest neurite drawn, in model units. */
  maxLength?: number;
  seed?: number;
}

/** Stable per-node hash in [0, 1): the same nodes stay somas across frames and rebuilds. */
function nodeHash(i: number, seed: number): number {
  const h = Math.sin(i * 78.233 + seed * 12.9898) * 43758.5453;
  return h - Math.floor(h);
}

export function layoutNeurons(graph: NetworkGraph, options: NeuronOptions): NeuronLayout {
  const { fraction, linksPerSoma = 3, maxLength = 0.16, seed = 1 } = options;
  const maxHops = options.maxHops ?? Math.min(10, Math.max(2, Math.ceil(2.2 * Math.cbrt(1 / Math.max(1e-4, fraction)))));
  const n = graph.nodeCount;

  const isSoma = new Uint8Array(n);
  const somaList: number[] = [];
  for (let i = 0; i < n; i++) {
    if (fraction >= 1 || nodeHash(i, seed) < fraction) {
      isSoma[i] = 1;
      somaList.push(i);
    }
  }

  const { positions: p, adjOffset, adjPeer } = graph;
  const seen = new Int32Array(n).fill(-1);
  let frontier: number[] = [];
  let next: number[] = [];
  const found: { node: number; d2: number }[] = [];
  const pairs = new Set<number>();
  const links: number[] = [];
  const max2 = maxLength * maxLength;

  for (const s of somaList) {
    // Breadth-first over synapses, up to maxHops away, collecting somas.
    found.length = 0;
    frontier.length = 0;
    frontier.push(s);
    seen[s] = s;
    // Stops early once there are comfortably more candidates than links to
    // make: each further hop multiplies the work by the branching factor.
    for (let hop = 0; hop < maxHops && frontier.length > 0 && found.length < linksPerSoma * 2; hop++) {
      next.length = 0;
      for (const v of frontier) {
        for (let k = adjOffset[v]; k < adjOffset[v + 1]; k++) {
          const u = adjPeer[k];
          if (seen[u] === s) continue;
          seen[u] = s;
          next.push(u);
          if (isSoma[u]) {
            const dx = p[u * 3] - p[s * 3], dy = p[u * 3 + 1] - p[s * 3 + 1], dz = p[u * 3 + 2] - p[s * 3 + 2];
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 <= max2) found.push({ node: u, d2 });
          }
        }
      }
      [frontier, next] = [next, frontier];
    }

    found.sort((a, b) => a.d2 - b.d2 || a.node - b.node);
    for (let k = 0; k < Math.min(linksPerSoma, found.length); k++) {
      const u = found[k].node;
      const a = Math.min(s, u), b = Math.max(s, u);
      const key = a * n + b;
      if (pairs.has(key)) continue;
      pairs.add(key);
      links.push(a, b);
    }
  }

  return { somas: Uint32Array.from(somaList), links: Uint32Array.from(links) };
}
