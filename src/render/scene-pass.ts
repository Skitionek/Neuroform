/**
 * Renders the scene split at the view plane: the far half into a
 * reduced-resolution target, the near half at full resolution, then adds the
 * far image back. With additive blending and no depth the frame is exactly
 * near + far, so nothing is lost but sharpness behind the centre, where it
 * reads as depth of field. Fill cost for the far half falls with the square of
 * the scale (a quarter at 0.5).
 *
 * At farScale 1 (the default) it renders in one pass, like a plain RenderPass.
 *
 * Trade-off, measured: each half still runs the vertex shader for every point
 * and synapse (culling happens inside it), plus a clear and an upscale pass.
 * Where the scene is vertex-bound rather than fill-bound that costs more than
 * the fill it saves; in a software renderer 0.5 was ~10% slower than no split.
 */
import {
  Color,
  CustomBlending,
  HalfFloatType,
  LinearFilter,
  OneFactor,
  ShaderMaterial,
  WebGLRenderTarget,
  type Camera,
  type Object3D,
  type Scene,
  type WebGLRenderer,
} from 'three';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import type { GpuTimer } from './gpu-timer';
import type { SplitUniforms } from './split';

export interface TimedLayer {
  label: string;
  object: Object3D;
}

export class SplitScenePass extends Pass {
  /** Layers to time individually when the GPU timer is on. */
  layers: TimedLayer[] = [];

  private scene: Scene;
  private camera: Camera;
  private split: SplitUniforms;
  private timer: GpuTimer;
  private far: WebGLRenderTarget;
  private quad: FullScreenQuad;
  private scale = 1;
  private width = 1;
  private height = 1;
  private clearColor = new Color();

  constructor(scene: Scene, camera: Camera, split: SplitUniforms, timer: GpuTimer) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.split = split;
    this.timer = timer;
    this.needsSwap = false;

    this.far = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: false,
    });

    // The far target already holds summed rgb * alpha contributions, so it is
    // added as-is (ONE, ONE). Three's AdditiveBlending would multiply by alpha
    // a second time. Alpha is written as zero to leave the frame's alone.
    this.quad = new FullScreenQuad(
      new ShaderMaterial({
        uniforms: { tFar: { value: this.far.texture } },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform sampler2D tFar;
          varying vec2 vUv;
          void main() {
            gl_FragColor = vec4(texture2D(tFar, vUv).rgb, 0.0);
          }
        `,
        blending: CustomBlending,
        blendSrc: OneFactor,
        blendDst: OneFactor,
        depthTest: false,
        depthWrite: false,
        transparent: true,
      }),
    );
  }

  /** Resolution of the far half relative to the screen, in (0, 1]. */
  get farScale(): number {
    return this.scale;
  }

  set farScale(value: number) {
    const scale = Math.min(1, Math.max(0.1, value));
    // The timed sections differ with and without the split; drop stale ones.
    if (scale !== this.scale) this.timer.reset();
    this.scale = scale;
    this.resizeFar();
  }

  setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.resizeFar();
  }

  private resizeFar(): void {
    this.far.setSize(
      Math.max(1, Math.round(this.width * this.scale)),
      Math.max(1, Math.round(this.height * this.scale)),
    );
  }

  render(renderer: WebGLRenderer, _writeBuffer: WebGLRenderTarget, readBuffer: WebGLRenderTarget): void {
    const { split } = this;
    const target = this.renderToScreen ? null : readBuffer;
    split.uSplitDir.value.copy(this.camera.position).sub(split.uSplitCentre.value).normalize();

    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.getClearColor(this.clearColor);
    const clearAlpha = renderer.getClearAlpha();

    if (this.scale >= 1) {
      split.uSplitSide.value = 0;
      split.uPixelScale.value = 1;
      this.clearTo(renderer, target, clearAlpha);
      this.draw(renderer, 'scene');
    } else {
      // Far half, into the small target, from transparent black.
      split.uSplitSide.value = -1;
      split.uPixelScale.value = this.far.width / Math.max(1, this.width);
      renderer.setRenderTarget(this.far);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      this.draw(renderer, 'far');

      // Near half, full resolution, over the background.
      split.uSplitSide.value = 1;
      split.uPixelScale.value = 1;
      this.clearTo(renderer, target, clearAlpha);
      this.draw(renderer, 'near');

      this.timer.begin('upscale');
      this.quad.render(renderer);
      this.timer.end();
    }

    // Leave every layer drawing everything, for any direct render.
    split.uSplitSide.value = 0;
    split.uPixelScale.value = 1;
    renderer.autoClear = autoClear;
  }

  /**
   * Binds `target` and clears it to the background colour.
   *
   * three.js converts the clear colour for whichever target is bound when the
   * colour is *set*: sRGB-encoded for the screen, linear for an offscreen
   * buffer. UnrealBloomPass restores the clear colour while the screen is
   * bound, so clearing an offscreen buffer without setting it again uses the
   * screen's encoding, and the output pass encodes it a second time: #04040a
   * comes out as navy (34, 34, 56). three's own RenderPass does exactly that.
   * Setting the colour after binding the target encodes it correctly.
   */
  private clearTo(renderer: WebGLRenderer, target: WebGLRenderTarget | null, alpha: number): void {
    renderer.setRenderTarget(target);
    renderer.setClearColor(this.clearColor, alpha);
    renderer.clear();
  }

  /** Draws the scene; one layer at a time, timed, when the timer is on. */
  private draw(renderer: WebGLRenderer, half: string): void {
    if (!this.timer.enabled || this.layers.length === 0) {
      renderer.render(this.scene, this.camera);
      return;
    }
    // Decide from the visibility saved up front: the loop itself hides the
    // other layers while timing each one.
    const visible = this.layers.map((l) => l.object.visible);
    for (const [i, layer] of this.layers.entries()) {
      if (!visible[i]) continue;
      for (const other of this.layers) other.object.visible = other === layer;
      this.timer.begin(`${half} ${layer.label}`);
      renderer.render(this.scene, this.camera);
      this.timer.end();
    }
    this.layers.forEach((l, i) => (l.object.visible = visible[i]));
  }

  dispose(): void {
    this.far.dispose();
    this.quad.material.dispose();
    this.quad.dispose();
  }
}
