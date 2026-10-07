/**
 * The resting synapses: very dim additive lines. Tens of thousands of
 * near-invisible wires that only read as a mass, which is exactly what makes
 * the bright pulses legible when they run across it.
 *
 * One plain line draw with two vertices per synapse. Each vertex works out
 * which synapse it belongs to from gl_VertexID, fetches both node indices from
 * an edge texture, and both nodes from the node textures. Knowing both ends
 * lets long-range tracts be recognised (and tinted) by their length, so they
 * need no mesh of their own.
 *
 * Not instanced on purpose: instancing a two-vertex line 340k times wastes
 * most of every vertex batch on real GPUs, and was 18x slower here.
 */
import { AdditiveBlending, BufferGeometry, LineSegments, RGFormat, ShaderMaterial, type DataTexture } from 'three';
import type { NetworkGraph } from '../graph/types';
import {
  DATA_TEXTURE_WIDTH,
  NODE_FETCH_GLSL,
  floatTexture,
  setPulledBounds,
  vertexCountCarrier,
  type NodeTextures,
} from './node-textures';
import { DEPTH_CUE_GLSL, depthUniforms } from './depth';
import { PALETTE } from './palette';

const vertexShader = /* glsl */ `
  ${NODE_FETCH_GLSL}
  uniform highp sampler2D uEdges; // node indices (a, b) per synapse
  uniform int uEdgesWidth;
  uniform float uTractLength;
  uniform vec3 uTractColor;
  ${DEPTH_CUE_GLSL}

  varying vec3 vColor;
  varying float vFade;

  void main() {
    int edge = gl_VertexID >> 1;
    bool first = (gl_VertexID & 1) == 0;
    vec2 ends = texelFetch(uEdges, ivec2(edge % uEdgesWidth, edge / uEdgesWidth), 0).xy;
    vec4 a = nodePosition(ends.x);
    vec4 b = nodePosition(ends.y);

    vec4 end = first ? a : b;
    vec3 tissue = nodeTissue(first ? ends.x : ends.y);

    // Long-range tracts carry a violet tint and stay readable, so the
    // midline crossings read as structure rather than noise.
    bool tract = length(b.xyz - a.xyz) > uTractLength;
    vColor = tract ? mix(tissue, uTractColor, 0.45) : tissue;
    // Deep wires recede so the surface structure reads first.
    vFade = (tract ? 0.85 : 1.0) * (1.0 - 0.55 * end.w);

    vec4 mv = modelViewMatrix * vec4(end.xyz, 1.0);
    vFade *= depthCue(mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uOpacity;
  varying vec3 vColor;
  varying float vFade;

  void main() {
    gl_FragColor = vec4(vColor * vFade, uOpacity * vFade);
  }
`;

export interface EdgeLayerOptions {
  opacity?: number;
  /** Edges longer than this fraction of the cloud radius count as tracts. */
  tractThreshold?: number;
}

export class EdgeLayer {
  readonly lines: LineSegments;
  private geometry: BufferGeometry;
  private material: ShaderMaterial;
  private edges: DataTexture;

  constructor(graph: NetworkGraph, nodes: NodeTextures, options: EdgeLayerOptions = {}) {
    const { opacity = 0.032, tractThreshold = 0.28 } = options;
    const m = graph.edgeCount;

    // Float indices are exact up to 2^24, i.e. networks of 16.7M nodes.
    const width = Math.min(DATA_TEXTURE_WIDTH, Math.max(1, m));
    const height = Math.max(1, Math.ceil(m / width));
    const pairs = new Float32Array(width * height * 2);
    pairs.set(graph.edges);
    this.edges = floatTexture(pairs, width, height, RGFormat);

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', vertexCountCarrier(m * 2));
    setPulledBounds(geometry, graph.bounds);
    this.geometry = geometry;

    this.material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        ...nodes.uniforms(),
        uEdges: { value: this.edges },
        uEdgesWidth: { value: width },
        uOpacity: { value: opacity },
        uTractLength: { value: graph.bounds * tractThreshold },
        uTractColor: { value: PALETTE.tract.clone() },
        ...depthUniforms,
      },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });

    this.lines = new LineSegments(geometry, this.material);
    this.lines.frustumCulled = false;
  }

  setOpacity(value: number): void {
    this.material.uniforms.uOpacity.value = value;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.edges.dispose();
  }
}
