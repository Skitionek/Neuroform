/**
 * Wires a point cloud into a network.
 *
 * Each node gets a random number of synapses and spends them on nearby nodes
 * (found through a uniform spatial hash), preferring close neighbours but not
 * strictly nearest — a little disorder makes the propagating wave front ragged
 * and organic instead of spherical. A handful of long-range tracts cross the
 * hemispheres so activation can jump the midline, as it does through the
 * corpus callosum.
 */
import { Rng } from '../core/rng';
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

/** Uniform grid over the cloud, for radius queries. */
class SpatialHash {
  private cell: number;
  private min = [0, 0, 0];
  private dims = [1, 1, 1];
  private start: Uint32Array;
  private items: Uint32Array;

  constructor(positions: Float32Array, count: number, cell: number) {
    this.cell = cell;
    const max = [-Infinity, -Infinity, -Infinity];
    const min = [Infinity, Infinity, Infinity];
    for (let i = 0; i < count; i++) {
      for (let a = 0; a < 3; a++) {
        const v = positions[i * 3 + a];
        if (v < min[a]) min[a] = v;
        if (v > max[a]) max[a] = v;
      }
    }
    this.min = min;
    for (let a = 0; a < 3; a++) {
      this.dims[a] = Math.max(1, Math.ceil((max[a] - min[a]) / cell) + 1);
    }

    const buckets = this.dims[0] * this.dims[1] * this.dims[2];
    const counts = new Uint32Array(buckets + 1);
    const keys = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      const k = this.bucketOf(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      keys[i] = k;
      counts[k + 1]++;
    }
    for (let b = 0; b < buckets; b++) counts[b + 1] += counts[b];
    this.start = counts;
    this.items = new Uint32Array(count);
    const cursor = counts.slice(0, buckets);
    for (let i = 0; i < count; i++) {
      this.items[cursor[keys[i]]++] = i;
    }
  }

  private bucketOf(x: number, y: number, z: number): number {
    const [dx, dy] = this.dims;
    const ix = Math.min(this.dims[0] - 1, Math.max(0, Math.floor((x - this.min[0]) / this.cell)));
    const iy = Math.min(this.dims[1] - 1, Math.max(0, Math.floor((y - this.min[1]) / this.cell)));
    const iz = Math.min(this.dims[2] - 1, Math.max(0, Math.floor((z - this.min[2]) / this.cell)));
    return ix + dx * (iy + dy * iz);
  }

  /** Appends every index in the 27 cells around the point to `out`. */
  near(x: number, y: number, z: number, out: number[]): void {
    out.length = 0;
    const [dx, dy, dz] = this.dims;
    const ix = Math.floor((x - this.min[0]) / this.cell);
    const iy = Math.floor((y - this.min[1]) / this.cell);
    const iz = Math.floor((z - this.min[2]) / this.cell);
    for (let kz = Math.max(0, iz - 1); kz <= Math.min(dz - 1, iz + 1); kz++) {
      for (let ky = Math.max(0, iy - 1); ky <= Math.min(dy - 1, iy + 1); ky++) {
        const rowBase = dx * (ky + dy * kz);
        for (let kx = Math.max(0, ix - 1); kx <= Math.min(dx - 1, ix + 1); kx++) {
          const b = kx + rowBase;
          for (let s = this.start[b]; s < this.start[b + 1]; s++) out.push(this.items[s]);
        }
      }
    }
  }
}

/** 64-bit-safe-enough key for an undirected pair, used to dedupe. */
function pairKey(a: number, b: number): number {
  return a < b ? a * 0x2000000 + b : b * 0x2000000 + a;
}

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
  const hash = new SpatialHash(positions, count, radius);

  const srcList: number[] = [];
  const dstList: number[] = [];
  const seen = new Set<number>();
  const degree = new Uint16Array(count);

  const scratch: number[] = [];
  const candidates: { idx: number; d2: number }[] = [];
  const r2 = radius * radius;
  // Nodes with the fewest synapses so far get priority as targets, which keeps
  // the graph from leaving isolated dots behind.
  const degreeCap = maxDegree + 4;

  for (let i = 0; i < count; i++) {
    const want = rng.int(minDegree, maxDegree);
    if (degree[i] >= want) continue;

    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    hash.near(x, y, z, scratch);

    candidates.length = 0;
    for (const j of scratch) {
      if (j === i) continue;
      const dx = positions[j * 3] - x;
      const dy = positions[j * 3 + 1] - y;
      const dz = positions[j * 3 + 2] - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) continue;
      candidates.push({ idx: j, d2 });
    }
    if (candidates.length === 0) continue;
    candidates.sort((a, b) => a.d2 - b.d2);

    let made = degree[i];
    // Walk outward from the nearest, skipping some: close enough to look like
    // local connectivity, loose enough to look grown rather than meshed.
    for (let c = 0; c < candidates.length && made < want; c++) {
      const j = candidates[c].idx;
      if (degree[j] >= degreeCap) continue;
      if (rng.next() < 0.22) continue;
      const key = pairKey(i, j);
      if (seen.has(key)) continue;
      seen.add(key);
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
    const key = pairKey(a, best);
    if (seen.has(key)) continue;
    seen.add(key);
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
    edgeLength[e] = Math.hypot(dx, dy, dz);
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
