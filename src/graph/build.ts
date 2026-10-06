/**
 * Wires a point cloud into a network.
 *
 * Each node gets a random number of synapses and spends them on its nearest
 * neighbours (found by an exact k-nearest search on a uniform grid), preferring
 * close ones but not strictly nearest — a little disorder makes the
 * propagating wave front ragged and organic instead of spherical. A handful of long-range tracts cross the
 * hemispheres so activation can jump the midline, as it does through the
 * corpus callosum.
 */
import { Rng } from '../core/rng';
import { NearestFinder, UniformGrid } from './spatial';
import type { NetworkGraph } from './types';

export interface WireOptions {
  seed?: number;
  /** Fewest synapses a node will try to make. */
  minDegree?: number;
  /** Most synapses a node will try to make. */
  maxDegree?: number;
  /** Neighbour search radius, in model units. */
  radius?: number;
  /** Share of edges rerouted as long-range tracts. */
  longRangeFraction?: number;
}

export interface Cloud {
  positions: Float32Array;
  normals: Float32Array;
  depth: Float32Array;
  region: Uint8Array;
  count: number;
  bounds: number;
}

/**
 * Per-node neighbour lists, for rejecting duplicate synapses without a global
 * Set of pair keys (which costs tens of megabytes at 100k nodes and boxed
 * hashing on every check). Local wiring caps degree, so a fixed number of
 * slots covers almost every node; the rare overflow from long-range tracts
 * spills into a small map.
 */
class NeighbourSets {
  private slots: Int32Array;
  private counts: Uint16Array;
  private overflow = new Map<number, number[]>();

  constructor(count: number, private cap: number) {
    this.slots = new Int32Array(count * cap);
    this.counts = new Uint16Array(count);
  }

  has(a: number, b: number): boolean {
    const n = this.counts[a];
    const base = a * this.cap;
    for (let k = 0; k < n; k++) if (this.slots[base + k] === b) return true;
    return this.overflow.get(a)?.includes(b) ?? false;
  }

  add(a: number, b: number): void {
    this.push(a, b);
    this.push(b, a);
  }

  private push(a: number, b: number): void {
    const n = this.counts[a];
    if (n < this.cap) {
      this.slots[a * this.cap + n] = b;
      this.counts[a] = n + 1;
    } else {
      let list = this.overflow.get(a);
      if (!list) this.overflow.set(a, (list = []));
      list.push(b);
    }
  }
}

/** First nearest-neighbour batch size; grown only when a walk runs past it. */
const NEAREST_BATCH = 24;

export function wireNetwork(cloud: Cloud, options: WireOptions = {}): NetworkGraph {
  const {
    seed = 11,
    minDegree = 2,
    maxDegree = 9,
    radius = 0.075,
    longRangeFraction = 0.003,
  } = options;

  const { positions, count } = cloud;
  const rng = new Rng(seed * 22695477 + 1);

  // A fine grid (a few points per cell) sized from the data, independent of
  // the reach: the reach caps edge length, it no longer drives the cost.
  const grid = new UniformGrid(positions, count, UniformGrid.cellFor(positions, count, 3));
  const nearest = new NearestFinder(grid, positions);

  const srcList: number[] = [];
  const dstList: number[] = [];
  const degree = new Uint16Array(count);
  // Nodes with the fewest synapses so far get priority as targets, which keeps
  // the graph from leaving isolated dots behind.
  const degreeCap = maxDegree + 4;
  const linked = new NeighbourSets(count, degreeCap + 2);

  for (let i = 0; i < count; i++) {
    const want = rng.int(minDegree, maxDegree);
    if (degree[i] >= want) continue;

    let k = NEAREST_BATCH;
    let found = nearest.query(i, k, radius);
    if (found === 0) continue;

    let made = degree[i];
    // Walk outward from the nearest, skipping some: close enough to look like
    // local connectivity, loose enough to look grown rather than meshed.
    for (let c = 0; made < want; c++) {
      if (c === found) {
        // Ran past the batch. If the batch was full there may be more within
        // reach: fetch a bigger one. Its first `c` entries are the same
        // candidates in the same order, so the walk continues seamlessly.
        if (found < k) break;
        k *= 4;
        found = nearest.query(i, k, radius);
        if (c >= found) break;
      }
      const j = nearest.idx[c];
      if (degree[j] >= degreeCap) continue;
      if (rng.next() < 0.22) continue;
      if (linked.has(i, j)) continue;
      linked.add(i, j);
      srcList.push(i);
      dstList.push(j);
      degree[i]++;
      degree[j]++;
      made++;
    }
  }

  // Long-range tracts: mostly midline crossings, plus some front-to-back.
  const longRange = Math.round(srcList.length * longRangeFraction);
  for (let n = 0; n < longRange; n++) {
    const a = rng.int(0, count - 1);
    const ax = positions[a * 3];
    let best = -1;
    let bestScore = Infinity;
    // Sample a few far candidates and take the most mirror-like one.
    for (let t = 0; t < 24; t++) {
      const b = rng.int(0, count - 1);
      if (b === a) continue;
      const bx = positions[b * 3];
      if (ax * bx > 0 && rng.next() < 0.75) continue; // prefer opposite sides
      const dy = positions[b * 3 + 1] - positions[a * 3 + 1];
      const dz = positions[b * 3 + 2] - positions[a * 3 + 2];
      const score = Math.abs(bx + ax) + Math.abs(dy) * 1.5 + Math.abs(dz) * 1.5;
      if (score < bestScore) { bestScore = score; best = b; }
    }
    if (best < 0) continue;
    if (linked.has(a, best)) continue;
    linked.add(a, best);
    srcList.push(a);
    dstList.push(best);
    degree[a]++;
    degree[best]++;
  }

  return assembleGraph(cloud, srcList, dstList, radius, rng);
}

/**
 * Turns a flat edge list into the CSR-backed graph the renderer and the
 * simulation both read. Shared by the procedural wiring and by data loaders.
 */
export function assembleGraph(
  cloud: Cloud,
  srcList: ArrayLike<number>,
  dstList: ArrayLike<number>,
  radius: number,
  rng: Rng,
): NetworkGraph {
  const { positions, count } = cloud;
  const edgeCount = srcList.length;
  const edges = new Uint32Array(edgeCount * 2);
  const edgeLength = new Float32Array(edgeCount);
  const edgeWeight = new Float32Array(edgeCount);

  for (let e = 0; e < edgeCount; e++) {
    const a = srcList[e], b = dstList[e];
    edges[e * 2] = a;
    edges[e * 2 + 1] = b;
    const dx = positions[b * 3] - positions[a * 3];
    const dy = positions[b * 3 + 1] - positions[a * 3 + 1];
    const dz = positions[b * 3 + 2] - positions[a * 3 + 2];
    edgeLength[e] = Math.sqrt(dx * dx + dy * dy + dz * dz);
    // Short, thick local synapses fire reliably; long tracts drop signal.
    const slack = Math.min(1, edgeLength[e] / radius);
    edgeWeight[e] = 0.55 + 0.45 * (1 - slack) * rng.range(0.7, 1);
  }

  const adjOffset = new Uint32Array(count + 1);
  for (let e = 0; e < edgeCount; e++) {
    adjOffset[edges[e * 2] + 1]++;
    adjOffset[edges[e * 2 + 1] + 1]++;
  }
  for (let i = 0; i < count; i++) adjOffset[i + 1] += adjOffset[i];
  const adjEdge = new Uint32Array(edgeCount * 2);
  const adjPeer = new Uint32Array(edgeCount * 2);
  const cursor = adjOffset.slice(0, count);
  for (let e = 0; e < edgeCount; e++) {
    const a = edges[e * 2], b = edges[e * 2 + 1];
    adjEdge[cursor[a]] = e; adjPeer[cursor[a]] = b; cursor[a]++;
    adjEdge[cursor[b]] = e; adjPeer[cursor[b]] = a; cursor[b]++;
  }

  return {
    nodeCount: count,
    positions,
    normals: cloud.normals,
    depth: cloud.depth,
    region: cloud.region,
    edgeCount,
    edges,
    edgeLength,
    edgeWeight,
    adjOffset,
    adjEdge,
    adjPeer,
    bounds: cloud.bounds,
  };
}
