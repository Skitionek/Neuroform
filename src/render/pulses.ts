/**
 * Signals in flight.
 *
 * Only the synapses currently carrying a pulse are drawn here, as a second line
 * mesh rebuilt each frame from the simulation's live-pulse list. A comet of
 * light runs from the firing node towards its neighbour, so you can watch the
 * wave advance wire by wire rather than seeing nodes blink in sequence.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  LineSegments,
  ShaderMaterial,
} from 'three';
import type { NetworkGraph } from '../graph/types';
import type { PulseView } from '../sim/network';
import { PALETTE } from './palette';

const vertexShader = /* glsl */ `
  attribute float aT;
  attribute float aHead;
  attribute float aAmp;
  attribute float aSpan;

  varying float vT;
  varying float vHead;
  varying float vAmp;
  varying float vSpan;

  void main() {
    vT = aT;
    vHead = aHead;
    vAmp = aAmp;
    vSpan = aSpan;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
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

export interface PulseLayerOptions {
  /** Most pulses drawn in one frame. */
  capacity?: number;
  /** Comet length in model units. */
  cometLength?: number;
  intensity?: number;
}

export class PulseLayer {
  readonly lines: LineSegments;
  readonly material: ShaderMaterial;

  private graph: NetworkGraph;
  private capacity: number;
  private cometLength: number;

  private position: BufferAttribute;
  private head: BufferAttribute;
  private amp: BufferAttribute;
  private span: BufferAttribute;

  constructor(graph: NetworkGraph, options: PulseLayerOptions = {}) {
    const { capacity = 24000, cometLength = 0.055, intensity = 1.2 } = options;
    this.graph = graph;
    this.capacity = capacity;
    this.cometLength = cometLength;

    const verts = capacity * 2;
    this.position = dynamic(new Float32Array(verts * 3), 3);
    this.head = dynamic(new Float32Array(verts), 1);
    this.amp = dynamic(new Float32Array(verts), 1);
    this.span = dynamic(new Float32Array(verts), 1);

    // Constant: 0 at the firing end, 1 at the receiving end.
    const t = new Float32Array(verts);
    for (let i = 0; i < capacity; i++) {
      t[i * 2] = 0;
      t[i * 2 + 1] = 1;
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', this.position);
    geometry.setAttribute('aT', new BufferAttribute(t, 1));
    geometry.setAttribute('aHead', this.head);
    geometry.setAttribute('aAmp', this.amp);
    geometry.setAttribute('aSpan', this.span);
    geometry.setDrawRange(0, 0);

    this.material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
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

  /** Rewrites the buffers from this frame's live pulses. */
  update(pulses: PulseView): void {
    const count = Math.min(pulses.count, this.capacity);
    const pos = this.position.array as Float32Array;
    const head = this.head.array as Float32Array;
    const amp = this.amp.array as Float32Array;
    const span = this.span.array as Float32Array;
    const nodes = this.graph.positions;

    for (let i = 0; i < count; i++) {
      const from = pulses.from[i] * 3;
      const to = pulses.to[i] * 3;
      const o = i * 6;

      pos[o] = nodes[from];
      pos[o + 1] = nodes[from + 1];
      pos[o + 2] = nodes[from + 2];
      pos[o + 3] = nodes[to];
      pos[o + 4] = nodes[to + 1];
      pos[o + 5] = nodes[to + 2];

      const h = pulses.progress[i];
      const a = pulses.amplitude[i];
      // Normalise comet length into the edge's own 0..1 parameter space so a
      // long tract gets a long streak and a short synapse a compact spark.
      const length = Math.max(1e-4, this.graph.edgeLength[pulses.edge[i]]);
      const s = Math.min(1, this.cometLength / length);

      head[i * 2] = h;
      head[i * 2 + 1] = h;
      amp[i * 2] = a;
      amp[i * 2 + 1] = a;
      span[i * 2] = s;
      span[i * 2 + 1] = s;
    }

    const verts = count * 2;
    markRange(this.position, verts * 3);
    markRange(this.head, verts);
    markRange(this.amp, verts);
    markRange(this.span, verts);
    this.lines.geometry.setDrawRange(0, verts);
  }

  setIntensity(value: number): void {
    this.material.uniforms.uIntensity.value = value;
  }

  setCometLength(value: number): void {
    this.cometLength = value;
  }

  dispose(): void {
    this.lines.geometry.dispose();
    this.material.dispose();
  }
}

function dynamic(array: Float32Array, itemSize: number): BufferAttribute {
  const attribute = new BufferAttribute(array, itemSize);
  attribute.setUsage(DynamicDrawUsage);
  return attribute;
}

/**
 * Uploads only the slice actually in use. Pulse counts swing wildly between
 * frames, and re-sending the whole capacity every frame is most of the
 * bandwidth this scene would otherwise spend.
 */
function markRange(attribute: BufferAttribute, used: number): void {
  const withRanges = attribute as BufferAttribute & {
    addUpdateRange?: (start: number, count: number) => void;
    clearUpdateRanges?: () => void;
  };
  if (used > 0 && typeof withRanges.addUpdateRange === 'function') {
    withRanges.clearUpdateRanges?.();
    withRanges.addUpdateRange(0, used);
  }
  attribute.needsUpdate = used > 0;
}
