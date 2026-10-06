/**
 * Signals in flight.
 *
 * One line per live pulse, carrying only which two nodes it runs between and
 * when it started; endpoints are fetched from the
 * node textures, and the comet's position along the wire is
 * computed from the shader clock. A pulse's data is therefore written once,
 * when it spawns, instead of being rebuilt every frame.
 *
 * A comet of light runs from the firing node toward its neighbour, so you can
 * watch the wave advance wire by wire rather than seeing nodes blink in turn.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  GLSL3,
  LineSegments,
  ShaderMaterial,
} from 'three';
import type { NetworkSim } from '../sim/network';
import { NODE_FETCH_GLSL, setPulledBounds, vertexCountCarrier, type NodeTextures } from './node-textures';
import { PALETTE } from './palette';

const vertexShader = /* glsl */ `
  ${NODE_FETCH_GLSL}
  uniform float uTime;
  uniform float uCometLength;

  // Two vertices per pulse: even ids at the firing end, odd at the receiving.
  attribute vec2 aEnds;    // from node, to node
  attribute vec3 aTiming;  // start time, duration, amplitude

  varying float vT;
  varying float vHead;
  varying float vAmp;
  varying float vSpan;

  void main() {
    vec3 a = nodePosition(aEnds.x).xyz;
    vec3 b = nodePosition(aEnds.y).xyz;
    vT = float(gl_VertexID & 1);
    vHead = clamp((uTime - aTiming.x) / aTiming.y, 0.0, 1.0);
    vAmp = aTiming.z;
    // Comet length in the edge's own 0..1 parameter space, so a long tract
    // gets a long streak and a short synapse a compact spark.
    vSpan = min(1.0, uCometLength / max(1e-4, length(b - a)));
    gl_Position = projectionMatrix * modelViewMatrix * vec4(mix(a, b, vT), 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  layout(location = 0) out highp vec4 outColor;
  layout(location = 1) out highp vec4 outMask;
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

    outColor = vec4(uColor * glow, clamp(glow, 0.0, 1.0));
    // Pulses are light, not tissue: nothing in the gooey mask.
    outMask = vec4(0.0, 0.0, 0.0, 1.0);
  }
`;

export interface PulseLayerOptions {
  /** Comet length in model units. */
  cometLength?: number;
  intensity?: number;
}

export class PulseLayer {
  readonly lines: LineSegments;
  readonly material: ShaderMaterial;

  private geometry: BufferGeometry;
  private sim: NetworkSim;
  // Per vertex (two per pulse slot): [from, to] and [start, duration, amp].
  private ends: BufferAttribute;
  private timing: BufferAttribute;

  constructor(sim: NetworkSim, nodes: NodeTextures, options: PulseLayerOptions = {}) {
    const { cometLength = 0.055, intensity = 1.2 } = options;
    this.sim = sim;
    const capacity = sim.pulses.capacity;

    // Two plain vertices per pulse rather than an instanced two-vertex line:
    // instancing meshes that small wastes most of each vertex batch. The
    // pool keeps one entry per pulse; update() expands just the slots that
    // changed into both of their vertices.
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', vertexCountCarrier(capacity * 2));
    this.ends = new BufferAttribute(new Float32Array(capacity * 2 * 2), 2);
    this.timing = new BufferAttribute(new Float32Array(capacity * 2 * 3), 3);
    this.ends.setUsage(DynamicDrawUsage);
    this.timing.setUsage(DynamicDrawUsage);
    geometry.setAttribute('aEnds', this.ends);
    geometry.setAttribute('aTiming', this.timing);
    geometry.setDrawRange(0, 0);
    setPulledBounds(geometry, sim.graph.bounds);
    this.geometry = geometry;

    this.material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      glslVersion: GLSL3,
      uniforms: {
        ...nodes.uniforms(),
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
    const ends = this.ends.array as Float32Array;
    const timing = this.timing.array as Float32Array;

    // Copies pool slots [first, first + count) into both of their vertices.
    const expand = (first: number, count: number) => {
      for (let slot = first; slot < first + count; slot++) {
        for (let v = 0; v < 2; v++) {
          const vertex = slot * 2 + v;
          ends[vertex * 2] = pool.ends[slot * 2];
          ends[vertex * 2 + 1] = pool.ends[slot * 2 + 1];
          timing[vertex * 3] = pool.timing[slot * 3];
          timing[vertex * 3 + 1] = pool.timing[slot * 3 + 1];
          timing[vertex * 3 + 2] = pool.timing[slot * 3 + 2];
        }
      }
    };

    const ranges: number[] = [];
    const result = pool.dirty.drain((first, count) => {
      expand(first, count);
      ranges.push(first, count);
    });
    if (result === 'all') {
      // No ranges recorded: three uploads the whole buffer.
      expand(0, pool.count);
    }
    if (result !== 'none') {
      for (let r = 0; r < ranges.length; r += 2) {
        this.ends.addUpdateRange(ranges[r] * 4, ranges[r + 1] * 4);
        this.timing.addUpdateRange(ranges[r] * 6, ranges[r + 1] * 6);
      }
      this.ends.needsUpdate = true;
      this.timing.needsUpdate = true;
    }
    this.geometry.setDrawRange(0, pool.count * 2);
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
  }
}
