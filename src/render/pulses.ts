/**
 * Signals in flight.
 *
 * One instanced line per live pulse. Each instance carries only which two
 * nodes it runs between and when it started; endpoints are fetched from a
 * texture of node positions, and the comet's position along the wire is
 * computed from the shader clock. A pulse's data is therefore written once,
 * when it spawns, instead of being rebuilt every frame.
 *
 * A comet of light runs from the firing node toward its neighbour, so you can
 * watch the wave advance wire by wire rather than seeing nodes blink in turn.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  DataTexture,
  DynamicDrawUsage,
  FloatType,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LineSegments,
  NearestFilter,
  RGBAFormat,
  ShaderMaterial,
} from 'three';
import type { NetworkGraph } from '../graph/types';
import type { NetworkSim } from '../sim/network';
import { PALETTE } from './palette';

const vertexShader = /* glsl */ `
  uniform highp sampler2D uNodes;
  uniform int uNodesWidth;
  uniform float uTime;
  uniform float uCometLength;

  // position.x is 0 at the firing end and 1 at the receiving end.
  attribute vec2 aEnds;    // from node, to node
  attribute vec3 aTiming;  // start time, duration, amplitude

  varying float vT;
  varying float vHead;
  varying float vAmp;
  varying float vSpan;

  vec3 nodeAt(float index) {
    int i = int(index + 0.5);
    return texelFetch(uNodes, ivec2(i % uNodesWidth, i / uNodesWidth), 0).xyz;
  }

  void main() {
    vec3 a = nodeAt(aEnds.x);
    vec3 b = nodeAt(aEnds.y);
    vT = position.x;
    vHead = clamp((uTime - aTiming.x) / aTiming.y, 0.0, 1.0);
    vAmp = aTiming.z;
    // Comet length in the edge's own 0..1 parameter space, so a long tract
    // gets a long streak and a short synapse a compact spark.
    vSpan = min(1.0, uCometLength / max(1e-4, length(b - a)));
    gl_Position = projectionMatrix * modelViewMatrix * vec4(mix(a, b, vT), 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform float uIntensity;

  varying float vT;
  varying float vHead;
  varying float vAmp;
  varying float vSpan;

  void main() {
    // Bright head at the signal's current position along the wire...
    float d = (vT - vHead) / max(0.02, vSpan);
    float head = exp(-d * d * 4.0);

    // ...and an exponential tail trailing behind it.
    float behind = max(0.0, vHead - vT) / max(0.02, vSpan * 3.0);
    float tail = exp(-behind) * step(vT, vHead) * 0.55;

    float glow = (head + tail) * vAmp * uIntensity;
    if (glow < 0.004) discard;

    gl_FragColor = vec4(uColor * glow, clamp(glow, 0.0, 1.0));
  }
`;

/** Node positions as a float texture, so instances can look endpoints up. */
function nodeTexture(graph: NetworkGraph): { texture: DataTexture; width: number } {
  const width = Math.min(2048, Math.max(1, graph.nodeCount));
  const height = Math.max(1, Math.ceil(graph.nodeCount / width));
  const data = new Float32Array(width * height * 4);
  for (let i = 0; i < graph.nodeCount; i++) {
    data[i * 4] = graph.positions[i * 3];
    data[i * 4 + 1] = graph.positions[i * 3 + 1];
    data[i * 4 + 2] = graph.positions[i * 3 + 2];
  }
  const texture = new DataTexture(data, width, height, RGBAFormat, FloatType);
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return { texture, width };
}

export interface PulseLayerOptions {
  /** Comet length in model units. */
  cometLength?: number;
  intensity?: number;
}

export class PulseLayer {
  readonly lines: LineSegments;
  readonly material: ShaderMaterial;

  private geometry: InstancedBufferGeometry;
  private sim: NetworkSim;
  private ends: InstancedBufferAttribute;
  private timing: InstancedBufferAttribute;
  private nodes: DataTexture;

  constructor(graph: NetworkGraph, sim: NetworkSim, options: PulseLayerOptions = {}) {
    const { cometLength = 0.055, intensity = 1.2 } = options;
    this.sim = sim;
    const pool = sim.pulses;

    const geometry = new InstancedBufferGeometry();
    // Two vertices per instance; x is the parameter along the wire.
    geometry.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0]), 3));

    // The pool's own arrays: no per-frame copy, and only changed slots upload.
    // Both attributes are driven by one dirty set, so it is drained once for
    // the pair (see update).
    this.ends = new InstancedBufferAttribute(pool.ends, 2);
    this.timing = new InstancedBufferAttribute(pool.timing, 3);
    this.ends.setUsage(DynamicDrawUsage);
    this.timing.setUsage(DynamicDrawUsage);
    geometry.setAttribute('aEnds', this.ends);
    geometry.setAttribute('aTiming', this.timing);
    geometry.instanceCount = 0;
    this.geometry = geometry;

    const { texture, width } = nodeTexture(graph);
    this.nodes = texture;

    this.material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uNodes: { value: texture },
        uNodesWidth: { value: width },
        uTime: { value: 0 },
        uCometLength: { value: cometLength },
        uColor: { value: PALETTE.pulse.clone() },
        uIntensity: { value: intensity },
      },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });

    this.lines = new LineSegments(geometry, this.material);
    this.lines.frustumCulled = false;
  }

  update(): void {
    const pool = this.sim.pulses;
    // One dirty set covers both attributes: record the ranges once, apply to
    // each. ('all' adds no ranges, which three treats as a full upload.)
    const ranges: number[] = [];
    const result = pool.dirty.drain((first, count) => ranges.push(first, count));
    if (result !== 'none') {
      for (let r = 0; r < ranges.length; r += 2) {
        this.ends.addUpdateRange(ranges[r] * 2, ranges[r + 1] * 2);
        this.timing.addUpdateRange(ranges[r] * 3, ranges[r + 1] * 3);
      }
      this.ends.needsUpdate = true;
      this.timing.needsUpdate = true;
    }
    this.geometry.instanceCount = pool.count;
    this.material.uniforms.uTime.value = this.sim.now;
  }

  setIntensity(value: number): void {
    this.material.uniforms.uIntensity.value = value;
  }

  setCometLength(value: number): void {
    this.material.uniforms.uCometLength.value = value;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.nodes.dispose();
  }
}
