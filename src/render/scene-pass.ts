/**
 * Renders the scene into the composer's buffer. Two things a plain RenderPass
 * does not do: it clears with the background colour encoded for the buffer
 * (see clearTo), and when the GPU timer is on it draws one layer at a time so
 * each can be timed separately.
 */
import { Color, HalfFloatType, LinearFilter, WebGLRenderTarget, type Camera, type Object3D, type Scene, type WebGLRenderer } from 'three';
import { Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import type { GpuTimer } from './gpu-timer';

export interface TimedLayer {
  label: string;
  object: Object3D;
}

export class ScenePass extends Pass {
  /** Layers to time individually when the GPU timer is on. */
  layers: TimedLayer[] = [];
  /**
   * When set, the scene renders into a two-attachment target instead of the
   * composer's buffer: colour, and the gooey mask the layers write in the
   * same draw. A later pass composites them into the frame.
   */
  useMask = false;
  /** Colour (textures[0]) and mask (textures[1]) when useMask is on. */
  readonly withMask = new WebGLRenderTarget(1, 1, {
    count: 2,
    type: HalfFloatType,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
  });

  private scene: Scene;
  private camera: Camera;
  private timer: GpuTimer;
  private clearColor = new Color();

  constructor(scene: Scene, camera: Camera, timer: GpuTimer) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.timer = timer;
    this.needsSwap = false;
  }

  render(renderer: WebGLRenderer, _writeBuffer: WebGLRenderTarget, readBuffer: WebGLRenderTarget): void {
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    this.clearTo(renderer, this.useMask ? this.withMask : this.renderToScreen ? null : readBuffer);
    this.draw(renderer);
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
  private clearTo(renderer: WebGLRenderer, target: WebGLRenderTarget | null): void {
    renderer.getClearColor(this.clearColor);
    const alpha = renderer.getClearAlpha();
    renderer.setRenderTarget(target);
    renderer.setClearColor(this.clearColor, alpha);
    renderer.clear();
  }

  setSize(width: number, height: number): void {
    this.withMask.setSize(width, height);
  }

  /** Draws the scene; one layer at a time, timed, when the timer is on. */
  private draw(renderer: WebGLRenderer): void {
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
      this.timer.begin(layer.label);
      renderer.render(this.scene, this.camera);
      this.timer.end();
    }
    this.layers.forEach((l, i) => (l.object.visible = visible[i]));
  }
}
