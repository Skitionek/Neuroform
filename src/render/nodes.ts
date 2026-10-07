/**
 * The point cloud itself. One draw call.
 *
 * Glow is computed here, not on the CPU: each node carries (peak, start time)
 * and the vertex shader applies the exponential decay against the current
 * time. The buffer is the simulation's own array, and only the entries that
 * changed this frame are uploaded, so a resting network costs nothing per
 * frame however many points it has.
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
import { uploadDirty } from '../core/dirty';
import type { NetworkGraph } from '../graph/types';
import { GLOW_FLOOR, type NetworkSim } from '../sim/network';
import { DEPTH_CUE_GLSL, depthUniforms } from './depth';
import { PALETTE, tissueColorFor } from './palette';

const vertexShader = /* glsl */ `
  attribute float aDepth;
  attribute vec2 aGlow;
  attribute float aSeed;
  attribute vec3 aTissue;

  uniform float uSize;
  uniform float uViewportScale;
  uniform float uTime;
  uniform float uGlowHalfLife;
  uniform float uBreath;
  uniform float uDim;
  uniform int uHover;

  ${DEPTH_CUE_GLSL}

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

    // glow = peak * 0.5^(elapsed / half-life), floored to zero like the sim.
    float act = aGlow.x * exp2(-max(0.0, uTime - aGlow.y) / uGlowHalfLife);
    act = act < GLOW_FLOOR ? 0.0 : act;
    // The pointer gets a lift so it has something to aim at before firing.
    if (gl_VertexID == uHover) act += 0.75;
    act = clamp(act, 0.0, 1.0);

    // Deep points are smaller and dimmer: the surface should read first.
    // uSize is a pixel size at one unit of distance, on a reference 800px-tall
    // viewport. uViewportScale carries resolution and device pixel ratio, so
    // the cloud looks the same on a laptop and on a phone.
    float depthFade = mix(1.0, 0.42, aDepth);
    float size = uSize * depthFade * (0.72 + 0.5 * aSeed) * (1.0 + 3.2 * act);
    gl_PointSize = clamp(size * uViewportScale / max(0.08, -mv.z), 0.6, 96.0);

    vec3 rest = aTissue * (0.55 + 0.45 * (1.0 - aDepth)) * uDim;
    // Cubic on the white mix: a firing node reaches cyan quickly but only
    // the very hottest go all the way to white, which keeps the crest of a
    // wave from flattening into one solid blob.
    vColor = mix(rest, mix(SIGNAL, SIGNAL_CORE, act * act * act), act);
    // The far side recedes, firing or not.
    vColor *= depthCue(mv.z);
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

/** Field of view, in degrees, that point sizes are tuned for. */
const REFERENCE_FOV = 42;

export interface NodeLayerOptions {
  size?: number;
}

export class NodeLayer {
  readonly points: Points;
  readonly geometry: BufferGeometry;
  readonly material: ShaderMaterial;
  private glow: BufferAttribute;
  private sim: NetworkSim;

  constructor(graph: NetworkGraph, sim: NetworkSim, options: NodeLayerOptions = {}) {
    const { size = 4.8 } = options;
    const n = graph.nodeCount;
    this.sim = sim;

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

    // The simulation's own array: no per-frame copy.
    this.glow = new BufferAttribute(sim.glow, 2);
    this.glow.setUsage(DynamicDrawUsage);
    geometry.setAttribute('aGlow', this.glow);
    geometry.computeBoundingSphere();
    this.geometry = geometry;

    const { signal, signalCore } = PALETTE;
    this.material = new ShaderMaterial({
      vertexShader: vertexShader
        .replace(/SIGNAL_CORE/g, glslColor(signalCore))
        .replace(/SIGNAL/g, glslColor(signal))
        .replace(/GLOW_FLOOR/g, GLOW_FLOOR.toFixed(6)),
      fragmentShader,
      uniforms: {
        uSize: { value: size },
        uViewportScale: { value: 1 },
        uTime: { value: 0 },
        uGlowHalfLife: { value: 0.65 },
        uBreath: { value: 1 },
        uDim: { value: 1 },
        uHover: { value: -1 },
        ...depthUniforms,
      },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });

    this.points = new Points(geometry, this.material);
    this.points.frustumCulled = false;
  }

  /** Uploads the glow entries that changed and advances the shader clock. */
  update(hovered = -1): void {
    uploadDirty(this.glow, this.sim.glowDirty);
    const u = this.material.uniforms;
    u.uTime.value = this.sim.now;
    u.uGlowHalfLife.value = Math.max(0.01, this.sim.params.glow);
    u.uHover.value = hovered;
  }

  /** Keeps dots the same apparent size across resolutions and screen heights. */
  /**
   * Point sizes are in pixels, which perspective division alone would keep
   * at the same size whatever the field of view; scaling by the projection
   * keeps dots in proportion to the brain when the fov changes.
   */
  setViewport(pixelRatio: number, heightPx: number, fov = REFERENCE_FOV): void {
    const projection = Math.tan((REFERENCE_FOV * Math.PI) / 360) / Math.tan((fov * Math.PI) / 360);
    this.material.uniforms.uViewportScale.value = pixelRatio * (heightPx / 800) * projection;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

function glslColor(c: Color): string {
  return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
}
