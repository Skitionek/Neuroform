/**
 * Where a network comes from.
 *
 * `proceduralBrain` generates one; `datasetGraph` reads one. Both satisfy the
 * same `GraphSource`, so swapping the generator for real connectome data is a
 * one-line change at the call site in main.ts.
 */
import { Rng } from '../core/rng';
import { decodeTypedArray, isTypedArraySpec, type TypedArraySpec } from '../core/typed';
import { sampleBrain, type BrainSampleOptions } from '../brain/shape';
import { assembleGraph, wireNetwork, type Cloud, type WireOptions } from './build';
import type { GraphSource, NetworkGraph } from './types';

export interface ProceduralOptions extends BrainSampleOptions, WireOptions {}

export function proceduralBrain(options: ProceduralOptions): GraphSource {
  return {
    id: 'procedural',
    label: 'procedural brain',
    load(): NetworkGraph {
      const cloud = sampleBrain(options);
      return wireNetwork(cloud, options);
    },
  };
}

/* ------------------------------------------------------------ dataset loader */

/**
 * The on-disk shape a dataset should take. Positions may be any scale or
 * origin; they are centred and normalised on load.
 */
export interface GraphDataset {
  /** Flat xyz triples, an array of [x, y, z], or a typed-array spec. */
  nodes: NumericField;
  /** Flat index pairs, an array of [a, b], or a typed-array spec. */
  edges: NumericField;
  /** Optional cluster id per node, used for colour. */
  regions?: number[] | TypedArraySpec;
  /** Optional 0 = surface, 1 = deep, per node. */
  depth?: number[] | TypedArraySpec;
}

/**
 * Any numeric field may be plain JSON numbers or, for large data, plotly's
 * binary typed-array spec `{ dtype, bdata, shape }`.
 */
type NumericField = number[] | number[][] | TypedArraySpec;

function flatten(values: NumericField, stride: number, label: string): ArrayLike<number> {
  if (isTypedArraySpec(values)) {
    const out = decodeTypedArray(values, label);
    if (out.length % stride !== 0) throw new Error(`${label}: ${out.length} values is not a multiple of ${stride}`);
    return out;
  }
  if (values.length > 0 && Array.isArray(values[0])) {
    const rows = values as number[][];
    const out = new Float64Array(rows.length * stride);
    for (let i = 0; i < rows.length; i++) {
      for (let a = 0; a < stride; a++) out[i * stride + a] = rows[i][a];
    }
    return out;
  }
  return Float64Array.from(values as number[]);
}

/** Centres on the centroid and scales so the cloud fits a unit-ish radius. */
function normalise(raw: ArrayLike<number>, count: number): { positions: Float32Array; bounds: number } {
  const centre = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    for (let a = 0; a < 3; a++) centre[a] += raw[i * 3 + a];
  }
  for (let a = 0; a < 3; a++) centre[a] /= Math.max(1, count);

  let maxRadius = 0;
  for (let i = 0; i < count; i++) {
    const r = Math.hypot(
      raw[i * 3] - centre[0],
      raw[i * 3 + 1] - centre[1],
      raw[i * 3 + 2] - centre[2],
    );
    if (r > maxRadius) maxRadius = r;
  }
  const scale = maxRadius > 0 ? 0.62 / maxRadius : 1;

  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    for (let a = 0; a < 3; a++) {
      positions[i * 3 + a] = (raw[i * 3 + a] - centre[a]) * scale;
    }
  }
  return { positions, bounds: maxRadius * scale || 1 };
}

export function graphFromDataset(data: GraphDataset, seed = 11): NetworkGraph {
  const rawNodes = flatten(data.nodes, 3, 'nodes');
  const count = Math.floor(rawNodes.length / 3);
  if (count === 0) throw new Error('dataset has no nodes');

  const { positions, bounds } = normalise(rawNodes, count);

  // Radial direction doubles as a normal when the dataset has no surface info.
  const normals = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    const len = Math.hypot(x, y, z) || 1;
    normals[i * 3] = x / len;
    normals[i * 3 + 1] = y / len;
    normals[i * 3 + 2] = z / len;
  }

  const depth = new Float32Array(count);
  if (data.depth) {
    const values = flatten(data.depth, 1, 'depth');
    for (let i = 0; i < count; i++) depth[i] = values[i] ?? 0;
  }

  const region = new Uint8Array(count);
  if (data.regions) {
    const values = flatten(data.regions, 1, 'regions');
    for (let i = 0; i < count; i++) region[i] = (values[i] ?? 0) & 0xff;
  }

  const pairs = flatten(data.edges, 2, 'edges');
  const src: number[] = [];
  const dst: number[] = [];
  for (let e = 0; e < pairs.length / 2; e++) {
    const a = pairs[e * 2] | 0;
    const b = pairs[e * 2 + 1] | 0;
    if (a === b || a < 0 || b < 0 || a >= count || b >= count) continue;
    src.push(a);
    dst.push(b);
  }

  const cloud: Cloud = { positions, normals, depth, region, count, bounds };
  // The reference radius only scales edge reliability; the median edge length
  // is a reasonable stand-in when we didn't choose the wiring ourselves.
  let reference = 0.075;
  if (src.length > 0) {
    let total = 0;
    for (let e = 0; e < src.length; e++) {
      const a = src[e], b = dst[e];
      total += Math.hypot(
        positions[b * 3] - positions[a * 3],
        positions[b * 3 + 1] - positions[a * 3 + 1],
        positions[b * 3 + 2] - positions[a * 3 + 2],
      );
    }
    reference = (total / src.length) * 1.4;
  }

  return assembleGraph(cloud, src, dst, reference, new Rng(seed));
}

export function datasetGraph(url: string): GraphSource {
  return {
    id: `dataset:${url}`,
    label: url,
    async load(): Promise<NetworkGraph> {
      // Imported lazily: request.ts imports this module.
      const { buildGraph } = await import('./request');
      return buildGraph({ kind: 'dataset', url: new URL(url, globalThis.location?.href).href });
    },
  };
}
