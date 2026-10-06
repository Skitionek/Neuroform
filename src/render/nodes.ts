/**
 * The point cloud itself. One draw call, one dynamic float per node.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Points,
  ShaderMaterial,
} from 'three';
import type { NetworkGraph } from '../graph/types';
import { PALETTE, tissueColorFor } from './palette';

const vertexShader = /* glsl */ `
  attribute float aDepth;
  attribute float aActivation;
  attribute float aSeed;
  attribute vec3 aTissue;

  uniform float uSize;
  uniform float uViewportScale;
  uniform float uTime;
  uniform float uBreath;
  uniform float uDim;

  varying vec3 vColor;
  varying float vGlow;

  void main() {
    // A slow, per-point drift. Barely visible on any one dot; collectively it
    // keeps the mass from looking like a frozen render.
    float phase = aSeed * 6.2831853;
    vec3 pos = position + normalize(position + 0.0001) *
               sin(uTime * 0.35 + phase) * 0.0035 * uBreath;

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;

    float act = clamp(aActivation, 0.0, 1.0);

    // Deep points are smaller and dimmer: the surface should read first.
    float depthFade = mix(1.0, 0.42, aDepth);
    // uSize is a pixel size at one unit of distance, on a reference 800px-tall
    // viewport. uViewportScale carries resolution and device pixel ratio, so
    // the cloud looks the same on a laptop and on a phone.
    float size = uSize * depthFade * (0.72 + 0.5 * aSeed) * (1.0 + 3.2 * act);
    gl_PointSize = clamp(size * uViewportScale / max(0.08, -mv.z), 0.6, 96.0);

    vec3 rest = aTissue * (0.55 + 0.45 * (1.0 - aDepth)) * uDim;
    // Cubic on the white mix: a firing node reaches cyan quickly but only
    // the very hottest go all the way to white, which keeps the crest of a
    // wave from flattening into one solid blob.
    vColor = mix(rest, mix(SIGNAL, SIGNAL_CORE, act * act * act), act);
    vGlow = act;
  }
`;

const fragmentShader = /* glsl */ `
  varying vec3 vColor;
  varying float vGlow;

  void main() {
    float r = length(gl_PointCoord - 0.5) * 2.0;
    if (r > 1.0) discard;

    // Soft disc plus a tight core, so firing nodes get a visible hot centre.
    float disc = pow(1.0 - r, 1.9);
    float core = pow(max(0.0, 1.0 - r * 2.4), 3.0);
    float alpha = disc * (0.42 + 0.58 * vGlow) + core * (0.3 + 1.6 * vGlow);

    gl_FragColor = vec4(vColor * (1.0 + 1.1 * vGlow), alpha);
  }
`;

export interface NodeLayerOptions {
  size?: number;
}

export class NodeLayer {
  readonly points: Points;
  readonly material: ShaderMaterial;
  private activation: BufferAttribute;
  private scratch: Float32Array;

  constructor(graph: NetworkGraph, options: NodeLayerOptions = {}) {
    const { size = 4.8 } = options;
    const n = graph.nodeCount;

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(graph.positions, 3));
    geometry.setAttribute('aDepth', new BufferAttribute(graph.depth, 1));

    const seeds = new Float32Array(n);
    const tissue = new Float32Array(n * 3);
    const c = new Color();
    for (let i = 0; i < n; i++) {
      // Hashed from the index: stable per node, nothing extra to store upstream.
      const h = Math.sin(i * 12.9898) * 43758.5453;
      seeds[i] = h - Math.floor(h);
      c.copy(tissueColorFor(graph.region[i]));
      tissue[i * 3] = c.r;
      tissue[i * 3 + 1] = c.g;
      tissue[i * 3 + 2] = c.b;
    }
    geometry.setAttribute('aSeed', new BufferAttribute(seeds, 1));
    geometry.setAttribute('aTissue', new BufferAttribute(tissue, 3));

    this.scratch = new Float32Array(n);
    this.activation = new BufferAttribute(this.scratch, 1);
    this.activation.setUsage(DynamicDrawUsage);
    geometry.setAttribute('aActivation', this.activation);
    geometry.computeBoundingSphere();

    const { signal, signalCore } = PALETTE;
    this.material = new ShaderMaterial({
      vertexShader: vertexShader
        .replace(/SIGNAL_CORE/g, glslColor(signalCore))
        .replace(/SIGNAL/g, glslColor(signal)),
      fragmentShader,
      uniforms: {
        uSize: { value: size },
        uViewportScale: { value: 1 },
        uTime: { value: 0 },
        uBreath: { value: 1 },
        uDim: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });

    this.points = new Points(geometry, this.material);
    this.points.frustumCulled = false;
  }

  /**
   * Copies simulation glow into the GPU buffer. `hovered` gets an extra lift so
   * the pointer has something to aim at before the node is actually fired.
   */
  update(activation: Float32Array, time: number, hovered = -1): void {
    this.scratch.set(activation);
    if (hovered >= 0 && hovered < this.scratch.length) {
      this.scratch[hovered] = Math.min(1, this.scratch[hovered] + 0.75);
    }
    this.activation.needsUpdate = true;
    this.material.uniforms.uTime.value = time;
  }

  /** Keeps dots the same apparent size across resolutions and screen heights. */
  setViewport(pixelRatio: number, heightPx: number): void {
    this.material.uniforms.uViewportScale.value = pixelRatio * (heightPx / 800);
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}

function glslColor(c: Color): string {
  return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
}
