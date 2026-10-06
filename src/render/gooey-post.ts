/**
 * Gooey cells made in post from the scene pass's mask output, so the
 * network's geometry is drawn only once.
 *
 * Two separable passes, the CSS recipe's feGaussianBlur split into
 * horizontal and vertical; the vertical one also applies the threshold
 * (feColorMatrix "18 -6") and membrane rim, and adds the result to the
 * scene's colour.
 *
 * - DEPTH mask: a depth-aware blur. Each pixel takes the front-most depth
 *   in its kernel as reference and weights samples by closeness to it, so
 *   a gap between a near blob and a far one takes the near one's depth and
 *   the far one doesn't merge across. Blur radius follows that depth, so
 *   near blobs are bigger.
 * - CHANNELS mask: red (near share) and blue (brightness) get a plain
 *   gaussian at one size for the frame; green (far share) is not blurred,
 *   so far nodes stay as the scene's sharp dots.
 */
import {
  Color,
  HalfFloatType,
  LinearFilter,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
  type PerspectiveCamera,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import type { GpuTimer } from './gpu-timer';
import { MASK_CHANNELS, MASK_DEPTH } from './mask';
import { PALETTE } from './palette';

/** Kernel half-width in pixels; blur sigma is clamped to a third of it. */
const RADIUS = 12;

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/** Shared by both passes: one blur step along uDir. */
const blurGlsl = /* glsl */ `
  #define RADIUS ${RADIUS}
  uniform sampler2D tIn;
  uniform vec2 uTexel;
  uniform vec2 uDir;
  uniform float uBlobPx;   // blur sigma in pixels at unit view depth
  uniform float uSlack;    // depth tolerance, model units
  uniform float uNearDepth;
  varying vec2 vUv;

  float sigmaAt(float depth) {
    return clamp(uBlobPx / max(depth, 0.05), 0.6, float(RADIUS) / 3.0);
  }

  #ifdef DEPTH_AWARE
  // In: (coverage, coverage x depth, coverage x glow). Same layout out.
  vec4 blurStep() {
    // Reference depth: the pixel's own where it is covered; in a gap, that
    // of its strongest neighbour, so a neck forms toward whatever is
    // actually adjacent. (The front-most depth in the kernel, tried first,
    // erased any dot with a nearer dot within the kernel.)
    vec4 centre = texture2D(tIn, vUv);
    float ref = centre.r > 0.05 ? centre.g / centre.r : -1.0;
    if (ref < 0.0) {
      float best = 0.0;
      float sigma0 = sigmaAt(uNearDepth);
      for (int i = -RADIUS; i <= RADIUS; i++) {
        float x = float(i);
        vec4 m = texture2D(tIn, vUv + uDir * (x * uTexel));
        float s = m.r * exp(-0.5 * x * x / (sigma0 * sigma0));
        if (s > best) { best = s; ref = m.g / max(m.r, 1e-4); }
      }
      if (best <= 1e-4) return vec4(0.0);
    }
    float sigma = sigmaAt(ref);
    vec3 acc = vec3(0.0);
    float norm = 0.0;
    for (int i = -RADIUS; i <= RADIUS; i++) {
      float x = float(i);
      float w = exp(-0.5 * x * x / (sigma * sigma));
      norm += w;
      vec4 m = texture2D(tIn, vUv + uDir * (x * uTexel));
      if (m.r <= 1e-4) continue;
      float dz = (m.g / m.r - ref) / uSlack;
      acc += w * exp(-dz * dz) * m.rgb;
    }
    return vec4(acc / norm, 1.0);
  }
  #else
  // In: (near coverage, far coverage, brightness). Out: (near coverage, -,
  // near brightness). Brightness is masked with red, the near share, before
  // blurring: near brightness = blue x red / (red + green).
  vec4 blurStep() {
    float sigma = sigmaAt(uNearDepth);
    vec2 acc = vec2(0.0);
    float norm = 0.0;
    for (int i = -RADIUS; i <= RADIUS; i++) {
      float x = float(i);
      float w = exp(-0.5 * x * x / (sigma * sigma));
      norm += w;
      vec4 m = texture2D(tIn, vUv + uDir * (x * uTexel));
      #ifdef FIRST_PASS
      float nearBright = m.b * m.r / max(m.r + m.g, 1e-4);
      acc += w * vec2(m.r, nearBright);
      #else
      acc += w * m.rb;
      #endif
    }
    acc /= norm;
    return vec4(acc.x, 0.0, acc.y, 1.0);
  }
  #endif
`;

const horizontalFragment = /* glsl */ `
  #define FIRST_PASS
  ${blurGlsl}
  void main() { gl_FragColor = blurStep(); }
`;

const verticalFragment = /* glsl */ `
  ${blurGlsl}
  uniform sampler2D tScene;
  uniform float uGain;
  uniform float uBody;
  uniform float uRim;
  uniform vec3 uTint;
  uniform vec3 uSignal;

  void main() {
    vec4 b = blurStep();
    float a = b.r * uGain;
    #ifdef DEPTH_AWARE
    float glow = clamp(b.b / max(b.r, 1e-4), 0.0, 1.0);
    #else
    // Brightness was written as 0.6 + glow.
    float glow = clamp(b.b / max(b.r, 1e-4) - 0.6, 0.0, 1.0);
    #endif
    // CSS feColorMatrix alpha row "18 -6": 0 at a = 1/3, 1 at a = 7/18.
    float inside = clamp(18.0 * a - 6.0, 0.0, 1.0);
    float rim = inside * (1.0 - smoothstep(0.39, 0.85, a));
    vec3 cell = mix(uTint, uSignal, glow) * (uBody * inside + uRim * rim);
    gl_FragColor = vec4(texture2D(tScene, vUv).rgb + cell, 1.0);
  }
`;

export class GooeyPostPass extends Pass {
  /** MASK_DEPTH or MASK_CHANNELS. */
  mode = MASK_DEPTH;
  /** Cell radius, model units (same meaning as the geometry cells' size). */
  cellSize = 0.0018;
  /** The scene pass's colour and mask outputs. */
  sources: { color: Texture; mask: Texture } | null = null;

  private camera: PerspectiveCamera;
  private timer: GpuTimer;
  private centre: () => { distance: number; radius: number };
  private temp: WebGLRenderTarget;
  private quads: Record<number, { h: FullScreenQuad; v: FullScreenQuad }>;
  private width = 1;
  private height = 1;

  /**
   * @param centre the brain's distance from the camera and its radius, for
   * the near-side depth the channel variant blurs at.
   */
  constructor(camera: PerspectiveCamera, timer: GpuTimer, centre: () => { distance: number; radius: number }) {
    super();
    this.camera = camera;
    this.timer = timer;
    this.centre = centre;
    this.needsSwap = false;
    this.temp = new WebGLRenderTarget(1, 1, { type: HalfFloatType, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false });

    const make = (fragmentShader: string, depthAware: boolean, vertical: boolean) =>
      new FullScreenQuad(
        new ShaderMaterial({
          vertexShader,
          fragmentShader,
          defines: depthAware ? { DEPTH_AWARE: '' } : {},
          uniforms: {
            tIn: { value: null },
            tScene: { value: null },
            uTexel: { value: new Vector2() },
            uDir: { value: vertical ? new Vector2(0, 1) : new Vector2(1, 0) },
            uBlobPx: { value: 1 },
            uSlack: { value: 0.01 },
            uNearDepth: { value: 1 },
            uGain: { value: 2.6 },
            uBody: { value: 0.32 },
            uRim: { value: 0.95 },
            uTint: { value: new Color().copy(PALETTE.tissue[0]).multiplyScalar(1.6) },
            uSignal: { value: PALETTE.signal.clone() },
          },
          depthTest: false,
          depthWrite: false,
        }),
      );
    this.quads = {
      [MASK_DEPTH]: { h: make(horizontalFragment, true, false), v: make(verticalFragment, true, true) },
      [MASK_CHANNELS]: { h: make(horizontalFragment, false, false), v: make(verticalFragment, false, true) },
    };
  }

  setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.temp.setSize(width, height);
  }

  render(renderer: WebGLRenderer, _writeBuffer: WebGLRenderTarget, readBuffer: WebGLRenderTarget): void {
    if (!this.sources) return;
    const { h, v } = this.quads[this.mode];
    const { distance, radius } = this.centre();
    // Pixels per model unit at unit depth, for this target.
    const projScale = this.camera.projectionMatrix.elements[5] * 0.5 * this.height;
    for (const quad of [h, v]) {
      const u = (quad.material as ShaderMaterial).uniforms;
      (u.uTexel.value as Vector2).set(1 / this.width, 1 / this.height);
      // A blob's blur sigma: about its radius, so neighbours within roughly
      // two radii merge.
      // The channel variant blurs everything near at one size, so it runs
      // smaller; the depth-aware one scales per pixel.
      u.uBlobPx.value = this.cellSize * (this.mode === MASK_CHANNELS ? 0.65 : 0.9) * projScale;
      u.uGain.value = this.mode === MASK_CHANNELS ? 2.6 : 2.0;
      // Depth tolerance: about one synapse length, so connected neighbours
      // merge while the other side of a fold does not.
      u.uSlack.value = Math.max(this.cellSize * 8, 0.015);
      u.uNearDepth.value = Math.max(0.05, distance - radius * 0.5);
    }

    this.timer.begin('gooey blur');
    (h.material as ShaderMaterial).uniforms.tIn.value = this.sources.mask;
    renderer.setRenderTarget(this.temp);
    h.render(renderer);
    this.timer.end();

    this.timer.begin('gooey threshold');
    const vu = (v.material as ShaderMaterial).uniforms;
    vu.tIn.value = this.temp.texture;
    vu.tScene.value = this.sources.color;
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    v.render(renderer);
    this.timer.end();
  }

  dispose(): void {
    this.temp.dispose();
    for (const { h, v } of Object.values(this.quads)) {
      h.material.dispose();
      v.material.dispose();
      h.dispose();
      v.dispose();
    }
  }
}
