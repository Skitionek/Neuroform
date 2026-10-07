/**
 * Per-node data as float textures, so synapses and pulses can look up both
 * of their endpoints in the vertex shader.
 */
import {
  BufferAttribute,
  DataTexture,
  FloatType,
  NearestFilter,
  RGBAFormat,
  Sphere,
  Vector3,
  type BufferGeometry,
  type PixelFormat,
} from 'three';
import type { NetworkGraph } from '../graph/types';
import { writeTissue } from './palette';

/** GLSL for fetching node `index` from a texture laid out by NodeTextures. */
export const NODE_FETCH_GLSL = /* glsl */ `
  uniform highp sampler2D uNodePositions; // xyz, depth
  uniform highp sampler2D uNodeTissue;    // resting colour
  uniform int uNodesWidth;

  ivec2 nodeTexel(float index) {
    int i = int(index + 0.5);
    return ivec2(i % uNodesWidth, i / uNodesWidth);
  }
  vec4 nodePosition(float index) { return texelFetch(uNodePositions, nodeTexel(index), 0); }
  vec3 nodeTissue(float index) { return texelFetch(uNodeTissue, nodeTexel(index), 0).rgb; }
`;

export class NodeTextures {
  readonly positions: DataTexture;
  readonly tissue: DataTexture;
  readonly width: number;
  private regions: Uint8Array;
  private tissueData: Float32Array<ArrayBuffer>;

  constructor(graph: NetworkGraph) {
    const n = graph.nodeCount;
    this.width = Math.min(DATA_TEXTURE_WIDTH, Math.max(1, n));
    const height = Math.max(1, Math.ceil(n / this.width));
    const pos = new Float32Array(this.width * height * 4);
    const tissue = new Float32Array(this.width * height * 4);
    for (let i = 0; i < n; i++) {
      pos[i * 4] = graph.positions[i * 3];
      pos[i * 4 + 1] = graph.positions[i * 3 + 1];
      pos[i * 4 + 2] = graph.positions[i * 3 + 2];
      pos[i * 4 + 3] = graph.depth[i];
    }
    writeTissue(graph.region, tissue, 4);
    this.regions = graph.region;
    this.tissueData = tissue;
    this.positions = floatTexture(pos, this.width, height);
    this.tissue = floatTexture(tissue, this.width, height);
  }

  /** Picks up a new brain colour (see setBrainColor). */
  refreshTissue(): void {
    writeTissue(this.regions, this.tissueData, 4);
    this.tissue.needsUpdate = true;
  }

  /** Uniforms matching NODE_FETCH_GLSL. */
  uniforms() {
    return {
      uNodePositions: { value: this.positions },
      uNodeTissue: { value: this.tissue },
      uNodesWidth: { value: this.width },
    };
  }

  dispose(): void {
    this.positions.dispose();
    this.tissue.dispose();
  }
}

/**
 * Texture width for per-item data. WebGL2 guarantees textures 2048 texels on a
 * side, so this layout holds up to 4M items (nodes or synapses).
 */
export const DATA_TEXTURE_WIDTH = 2048;

export function floatTexture(
  data: Float32Array<ArrayBuffer>,
  width: number,
  height: number,
  format: PixelFormat = RGBAFormat,
): DataTexture {
  const texture = new DataTexture(data, width, height, format, FloatType);
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/**
 * A `position` attribute that only sets how many vertices a draw has. Shaders
 * that pull their data by gl_VertexID never read it (so it is never bound),
 * but three.js takes a draw's vertex count from it. One byte per vertex.
 */
export function vertexCountCarrier(count: number): BufferAttribute {
  return new BufferAttribute(new Uint8Array(Math.max(1, count)), 1);
}

/**
 * Gives a vertex-pulled geometry real bounds. three.js computes bounds from
 * `position` when it depth-sorts transparent objects, and the count carrier
 * is not a position, which yields NaN. Nodes lie within `radius` of the
 * origin, so this sphere holds everything drawn between them.
 */
export function setPulledBounds(geometry: BufferGeometry, radius: number): void {
  geometry.boundingSphere = new Sphere(new Vector3(), radius);
}
