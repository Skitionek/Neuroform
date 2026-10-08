/**
 * Neuroform: a brain-shaped point cloud whose synapses carry waves of
 * activation, drawn into one canvas. Click a node to make it fire; the wave
 * does the rest.
 *
 * This is the whole piece without a page around it: it owns a canvas and
 * nothing else in the document, so several can share a page. The
 * `<neuro-form>` element (element.ts) wraps it for HTML; the site is one of
 * those elements.
 */
import {
  Clock,
  Group,
  Matrix4,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import type GUI from 'lil-gui';

import { GraphBuilder, SupersededError, type GraphRequest } from './graph/request';
import type { NetworkGraph } from './graph/types';
import { pulseCapacity, scaleLook, scaleReach } from './core/scale';
import { DEFAULT_PARAMS, NetworkSim } from './sim/network';
import { EdgeLayer } from './render/edges';
import { GpuTimer, type TimerMode } from './render/gpu-timer';
import { NodeTextures } from './render/node-textures';
import { ScenePass } from './render/scene-pass';
import { MembraneLayer, MembranePass } from './render/membranes';
import { layoutNeurons } from './graph/neurons';
import { NodeLayer } from './render/nodes';
import { updateDepthCue } from './render/depth';
import { ThemePass } from './render/theme-pass';
import { setBrainColor } from './render/palette';
import { NodePicker } from './render/picker';
import { PulseLayer } from './render/pulses';
import { createPanel, type PanelState } from './ui/panel';
import { PRESETS } from './ui/presets';
import { SCAN_URL } from './brain/scan-url';
import {
  applySettings,
  defaultState,
  flatten,
  presetSettings,
  type NeuroformSettings,
} from './settings';

export interface NeuroformOptions {
  /** The canvas to draw into. Its CSS size sets the drawing size. */
  canvas: HTMLCanvasElement;
  /** A preset to start from (see presets.ts); `settings` apply on top. */
  preset?: string;
  settings?: Partial<NeuroformSettings>;
  /** A network to load (JSON, see the README) instead of generating one. */
  dataset?: string;
  /** Where the scan brain's grid lives; the copy bundled with the code by default. */
  scanUrl?: string;
  /**
   * Give the canvas an alpha channel. Defaults to the `transparent` setting;
   * an opaque canvas is faster. Fixed for the canvas's life: turning
   * `transparent` on without it raises a `needsalpha` event instead.
   */
  alpha?: boolean;
  /** Keep the drawing buffer, so the canvas can be read back at any time (slower). */
  preserveDrawingBuffer?: boolean;
  /** Time each render pass on the GPU; see `gpuTimings()`. */
  gpuTimer?: TimerMode;
  /** Pins the cells' density buffer to this share of full resolution. */
  cellResolution?: number;
  /** Show the control panel, inside this element (or over the page, for `true`). */
  panel?: HTMLElement | boolean;
  /** Where `space` (fire) and `r` (quiet) are heard; none by default. */
  keyboardTarget?: HTMLElement | Window | null;
  /** Start from this network instead of building one. */
  graph?: NetworkGraph;
}

/** Sent about five times a second, for a readout. */
export interface NeuroformStats {
  nodes: number;
  synapses: number;
  inFlight: number;
  firingsPerSecond: number;
  fps: number;
  /** A new network is being built while the current one animates. */
  building: boolean;
  /** Node under the pointer, or -1. */
  hovered: number;
  /** GPU milliseconds per pass, as text, when the timer is on. */
  gpu: string;
}

export interface SnapshotOptions {
  /** Image type, as for canvas.toBlob: 'image/png' (default), 'image/jpeg', 'image/webp'. */
  type?: string;
  /** 0 to 1, for lossy types. */
  quality?: number;
  /** Size in CSS pixels; the canvas's own by default. The framing follows the aspect. */
  width?: number;
  height?: number;
  /** Device pixels per CSS pixel; the screen's (up to 2) by default. */
  pixelRatio?: number;
}

/**
 * Events (all CustomEvent):
 * - `ready`: the first network is in place (detail: the NetworkGraph);
 * - `firstrender`: the first frame is on the canvas;
 * - `stats`: NeuroformStats, about five times a second;
 * - `change`: settings changed (detail: the flat settings);
 * - `needsalpha`: `transparent` was turned on but the canvas has no alpha
 *   channel; make a new Neuroform with `alpha: true` (the element does);
 * - `error`: a network could not be built (detail: the Error).
 */
export class Neuroform extends EventTarget {
  readonly canvas: HTMLCanvasElement;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly renderer: WebGLRenderer;
  /** Whether the canvas has an alpha channel; fixed for its life. */
  readonly alpha: boolean;
  /** Draw through the post-processing passes; false draws the scene alone. */
  postprocessing = true;
  /** Resolves once the first frame is on the canvas. */
  readonly firstRender: Promise<void>;

  /** Live settings, grouped. Change them through `set`. */
  readonly state: PanelState;
  /** The preset the settings started from, if any. */
  readonly preset: string | null;

  private readonly controls: OrbitControls;
  private readonly world = new Group();
  private readonly composer: EffectComposer;
  private readonly scenePass: ScenePass;
  private readonly membranePass: MembranePass;
  private readonly bloom: UnrealBloomPass;
  private readonly themePass: ThemePass;
  private readonly gpuTimer: GpuTimer;
  private readonly timerMode: TimerMode;
  private readonly builder = new GraphBuilder();
  private readonly dataset: string | null;
  private readonly scanUrl: string;
  private readonly homeDistanceAt42: number;
  /** Where the camera opens, seen from the target: drifting turns it about y. */
  private readonly homeDirection: Vector3;
  /** How much further back the opening view sits so the brain fits the width too. */
  private fit = 1;
  /** Set once the user orbits or zooms; the view is theirs from then on. */
  private handled = false;
  private readonly panel: GUI | null = null;
  private readonly cleanup: (() => void)[] = [];

  private _graph!: NetworkGraph;
  private _sim!: NetworkSim;
  private nodeLayer!: NodeLayer;
  private edgeLayer!: EdgeLayer;
  private nodeTextures!: NodeTextures;
  private pulseLayer!: PulseLayer;
  private picker!: NodePicker;
  private membraneLayer: MembraneLayer | null = null;
  /** The cell density the current membrane layer was laid out for. */
  private laidOutDensity = -1;
  private relayoutTimer = 0;
  /** False until the first network is in place. */
  private ready = false;
  /** Shown in the stats while a rebuild runs; the old network keeps animating. */
  private building = false;
  private disposed = false;
  private initialGraph: NetworkGraph | null;
  /** Brain colour the palette was last set to for this brain. */
  private brainColor = '';
  /** Synapse opacity from the look, before zoom merging fades it. */
  private edgeOpacity = 0;

  // Render pacing (see shouldRender).
  private frameRequest = 0;
  private paused = false;
  private lastRender = 0;
  private activeUntil = 0;
  private interacting = false;
  private rendered = false;
  private resolveFirstRender!: () => void;
  private firstRenderCaptures: { options: SnapshotOptions; resolve: (blob: Blob) => void; reject: (e: Error) => void }[] = [];

  // Interaction.
  private readonly raycaster = new Raycaster();
  private readonly toLocal = new Matrix4();
  private readonly pointer = new Vector2();
  private readonly pressPosition = new Vector2();
  private pointerInside = false;
  private pointerMoved = false;
  private hovered = -1;
  private needsPick = false;
  private pressedAt = 0;

  // Stats.
  private readonly clock = new Clock();
  private fps = 60;
  private lastStats = 0;
  private firingsAt = 0;

  constructor(options: NeuroformOptions) {
    super();
    this.canvas = options.canvas;
    this.preset = options.preset && PRESETS[options.preset] ? options.preset : null;
    this.state = defaultState();
    applySettings(this.state, presetSettings(this.preset));
    applySettings(this.state, options.settings ?? {});
    this.dataset = options.dataset ?? null;
    this.scanUrl = options.scanUrl ?? SCAN_URL;
    this.initialGraph = options.graph ?? null;
    this.firstRender = new Promise((resolve) => (this.resolveFirstRender = resolve));

    // An alpha channel only when transparency is asked for: an opaque canvas
    // spares the browser blending it over the page every frame. three.js
    // always asks for alpha itself, so the context is made here.
    this.alpha = options.alpha ?? this.state.look.transparent;
    const context = this.canvas.getContext('webgl2', {
      alpha: this.alpha,
      depth: true,
      stencil: false,
      antialias: false,
      premultipliedAlpha: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: options.preserveDrawingBuffer ?? false,
    });
    if (!context) throw new Error('WebGL2 is not available');
    this.renderer = new WebGLRenderer({ canvas: this.canvas, context });
    // Everything draws light on black; ThemePass puts it on the background.
    this.renderer.setClearColor(0x000000, 0);

    // Opens at 42° and the home position; a different fov is applied as a
    // dolly zoom from there (see setFov), so the framing stays the same.
    this.camera = new PerspectiveCamera(42, 1, 0.01, 50);
    this.camera.position.set(1.35, 0.42, 1.5);
    this.homeDistanceAt42 = this.camera.position.length();
    this.homeDirection = this.camera.position.clone().normalize();

    const controls = (this.controls = new OrbitControls(this.camera, this.canvas));
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.rotateSpeed = 0.55;
    controls.zoomSpeed = 0.7;
    controls.minDistance = 0.35;
    controls.maxDistance = 6;
    controls.autoRotateSpeed = 0.28;
    controls.addEventListener('start', () => {
      this.interacting = true;
      this.handled = true;
      this.wake();
    });
    controls.addEventListener('end', () => {
      this.interacting = false;
      // Damping keeps the camera gliding for a while after release.
      this.wake(1500);
    });

    this.scene.add(this.world);

    this.timerMode = options.gpuTimer ?? 'off';
    this.gpuTimer = new GpuTimer(this.renderer.getContext() as WebGL2RenderingContext, this.timerMode);

    this.composer = new EffectComposer(this.renderer);
    this.scenePass = new ScenePass(this.scene, this.camera, this.gpuTimer);
    this.composer.addPass(this.scenePass);
    // Neurons as merging, membraned cells, drawn over the scene before bloom.
    this.membranePass = new MembranePass(this.camera, this.gpuTimer);
    // By default the cells' density buffer drops as far as their size allows.
    if (options.cellResolution && options.cellResolution > 0) this.membranePass.setResolution(options.cellResolution);
    this.composer.addPass(this.membranePass);
    // A high threshold keeps the bloom on firing nodes and pulses instead of
    // lifting the whole resting cloud into a haze.
    this.bloom = new UnrealBloomPass(new Vector2(1, 1), this.state.look.bloom, 0.5, 0.5);
    this.composer.addPass(this.bloom);
    // Last: composites onto the background and encodes to sRGB, in place of
    // three's OutputPass (see theme-pass.ts). Without the encoding the linear
    // buffer reaches the canvas unconverted and the near-black background
    // lifts to navy.
    this.themePass = new ThemePass();
    this.composer.addPass(this.themePass);

    // Bloom and the theme (output) pass are timed as wholes.
    for (const [pass, label] of [[this.bloom, 'bloom'], [this.themePass, 'theme']] as [Pass, string][]) {
      const render = pass.render.bind(pass);
      pass.render = (...args: Parameters<Pass['render']>) => {
        this.gpuTimer.begin(label);
        render(...args);
        this.gpuTimer.end();
      };
    }

    this.listen(this.canvas, 'pointermove', (event) => {
      this.updatePointer(event);
      this.wake(300); // hover feedback should track the pointer at full rate
      if (this.pressPosition.distanceTo(new Vector2(event.clientX, event.clientY)) > 6) this.pointerMoved = true;
    });
    this.listen(this.canvas, 'pointerleave', () => {
      this.pointerInside = false;
      this.hovered = -1;
    });
    this.listen(this.canvas, 'pointerdown', (event) => {
      this.pressedAt = performance.now();
      this.pointerMoved = false;
      this.pressPosition.set(event.clientX, event.clientY);
      this.updatePointer(event);
    });
    this.listen(this.canvas, 'pointerup', (event) => {
      // A click fires a node; a drag is the user orbiting the camera.
      if (!this.ready || this.pointerMoved || performance.now() - this.pressedAt > 450) return;
      this.updatePointer(event);
      const node = this.pick();
      if (node >= 0) this._sim.stimulate(node, 1);
    });
    if (options.keyboardTarget) {
      this.listen(options.keyboardTarget, 'keydown', (event) => {
        if (!this.ready) return;
        // Not while typing into something, the panel included.
        const target = event.target as HTMLElement | null;
        if (target?.closest?.('input, textarea, select, [contenteditable]')) return;
        this.wake();
        if (event.key === ' ') {
          event.preventDefault();
          this.stimulate();
        } else if (event.key === 'r' || event.key === 'R') {
          this._sim.reset();
        }
      });
    }

    const resizer = new ResizeObserver(() => this.resize());
    resizer.observe(this.canvas);
    this.cleanup.push(() => resizer.disconnect());

    if (options.panel) {
      this.panel = createPanel(
        this.state,
        {
          onStructureChange: () => this.changed({ structure: true, signal: false, look: false }),
          onSignalChange: () => this.changed({ structure: false, signal: true, look: false }),
          onLookChange: () => this.changed({ structure: false, signal: false, look: true }),
          onStimulate: () => this.stimulate(),
          onReset: () => this.reset(),
          onPreset: (name) => this.loadPreset(name),
        },
        { container: options.panel === true ? undefined : options.panel, preset: this.preset },
      );
    }

    void this.build();
    this.frameRequest = requestAnimationFrame(this.frame);
  }

  /* ---------------------------------------------------------- public api */

  get graph(): NetworkGraph {
    return this._graph;
  }

  get sim(): NetworkSim {
    return this._sim;
  }

  get layers() {
    return { nodes: this.nodeLayer, edges: this.edgeLayer, pulses: this.pulseLayer, membranes: this.membraneLayer };
  }

  /** The current settings, as one flat record (a copy). */
  get settings(): NeuroformSettings {
    return flatten(this.state);
  }

  /**
   * Changes settings: `set({ bloom: 1, theme: 'light' })`. Structure settings
   * rebuild the network (the current one animates until the new one is in);
   * everything else applies at once.
   */
  set(changes: Partial<NeuroformSettings>): void {
    this.changed(applySettings(this.state, changes));
    this.panel?.controllersRecursive().forEach((c) => c.updateDisplay());
  }

  /** Resets every setting to the default, then applies a preset's own. */
  loadPreset(name: string): void {
    if (!PRESETS[name]) return;
    this.set(presetSettings(name));
  }

  /** Fires a node, a random one by default. */
  stimulate(node?: number): void {
    if (!this.ready) return;
    this._sim.stimulate(node ?? Math.floor(Math.random() * this._graph.nodeCount), 1);
    this.wake();
  }

  /** Stops every signal and reseeds the simulation's random stream. */
  reset(): void {
    this._sim?.reset();
    this.wake();
  }

  /** Changes look settings, e.g. `look({ bloom: 1, restFps: 30 })`. */
  look(changes: Partial<PanelState['look']>): void {
    this.set(changes);
  }

  /** Rebuilds the network, optionally changing structure settings first. */
  rebuild(structure?: Partial<PanelState['structure']>): Promise<void> {
    applySettings(this.state, structure ?? {});
    return this.build();
  }

  /** Smoothed GPU milliseconds per render section, when the timer is on. */
  gpuTimings(): Record<string, number> {
    return Object.fromEntries(this.gpuTimer.ms);
  }

  /** Clears the GPU timings, e.g. after changing a setting. */
  resetGpuTimings(): void {
    this.gpuTimer.reset();
  }

  /** Stops drawing (while off screen, say) until `resume`. */
  pause(): void {
    this.paused = true;
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.clock.getDelta(); // the time away is not simulated
    this.wake();
  }

  /**
   * Draws a frame now and returns it as an image: a placeholder to show
   * until the piece loads, or a still for a page's preview. Waits for the
   * first network if there is none yet.
   */
  async snapshot(options: SnapshotOptions = {}): Promise<Blob> {
    await this.firstRender;
    return this.capture(options);
  }

  /**
   * The very first frame drawn, as an image: exactly what a visitor sees
   * when the piece appears, so it makes a seamless placeholder. Once that
   * frame has passed, this draws a new one instead (as `snapshot`).
   */
  captureFirstRender(options: SnapshotOptions = {}): Promise<Blob> {
    if (this.rendered) return this.capture(options);
    return new Promise((resolve, reject) => this.firstRenderCaptures.push({ options, resolve, reject }));
  }

  /** Stops drawing and releases the GPU resources, worker and listeners. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.frameRequest);
    clearTimeout(this.relayoutTimer);
    this.builder.dispose();
    this.cleanup.forEach((undo) => undo());
    this.panel?.destroy();
    this.teardown();
    this.controls.dispose();
    this.composer.dispose();
    this.bloom.dispose();
    this.themePass.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    for (const capture of this.firstRenderCaptures) capture.reject(new Error('disposed before the first render'));
    this.firstRenderCaptures = [];
  }

  /* ------------------------------------------------------------- network */

  private emit<T>(type: string, detail?: T): void {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  private listen<K extends keyof HTMLElementEventMap>(
    target: HTMLElement | Window,
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void,
  ): void {
    const listener = handler as EventListener;
    target.addEventListener(type, listener);
    this.cleanup.push(() => target.removeEventListener(type, listener));
  }

  /** Applies whatever a settings change needs. */
  private changed(changed: { structure: boolean; signal: boolean; look: boolean }): void {
    if (changed.structure) void this.build();
    if (this.ready) {
      if (changed.signal) {
        Object.assign(this._sim.params, this.state.signal);
        this.wake();
      }
      if (changed.look) this.applyLook();
    }
    if (changed.structure || changed.signal || changed.look) this.emit('change', this.settings);
  }

  private currentRequest(): GraphRequest {
    // A dataset is loaded instead of generating a network. Everything
    // downstream reads the same NetworkGraph either way.
    if (this.dataset) return { kind: 'dataset', url: new URL(this.dataset, document.baseURI).href };
    const s = this.state.structure;
    return {
      kind: 'procedural',
      scanUrl: new URL(this.scanUrl, document.baseURI).href,
      options: {
        shape: s.shape,
        count: s.nodes,
        seed: s.seed,
        shell: s.shell,
        fill: s.fill,
        foldDepth: s.foldDepth,
        foldScale: s.foldScale,
        minDegree: s.minDegree,
        maxDegree: s.maxDegree,
        radius: scaleReach(s.radius, s.nodes),
      },
    };
  }

  private teardown(): void {
    if (!this.nodeLayer) return;
    this.world.remove(this.nodeLayer.points, this.edgeLayer.lines, this.pulseLayer.lines);
    this.edgeLayer.dispose();
    this.nodeLayer.dispose();
    this.pulseLayer.dispose();
    this.disposeMembranes();
    this.nodeTextures.dispose();
  }

  private async build(): Promise<void> {
    this.building = true;

    // The network is generated on a worker, so the current one keeps
    // animating (and stays interactive) until its replacement is ready.
    let next: NetworkGraph;
    try {
      if (this.initialGraph) {
        next = this.initialGraph;
        this.initialGraph = null;
      } else {
        next = await this.builder.build(this.currentRequest());
      }
    } catch (error) {
      if (error instanceof SupersededError) return; // a newer build is on its way
      this.building = false;
      this.emit('error', error);
      return;
    }
    if (this.disposed) return;
    this.building = false;

    // Swap synchronously, so no frame ever sees a half-built scene.
    this.teardown();
    const graph = (this._graph = next);
    const sim = (this._sim = new NetworkSim(graph, {
      ...DEFAULT_PARAMS,
      ...this.state.signal,
      maxPulses: pulseCapacity(graph.nodeCount),
    }));

    // The palette is shared by every brain on the page and read as layers
    // are built: make it this brain's.
    this.brainColor = this.state.look.brainColor;
    setBrainColor(this.brainColor);
    const look = scaleLook(this.state.look, graph.nodeCount);
    this.nodeTextures = new NodeTextures(graph);
    this.nodeLayer = new NodeLayer(graph, sim, { size: look.pointSize });
    this.edgeLayer = new EdgeLayer(graph, this.nodeTextures, { opacity: look.edgeOpacity });
    this.pulseLayer = new PulseLayer(sim, this.nodeTextures, {
      cometLength: look.cometLength,
      intensity: look.pulseIntensity,
    });
    this.picker = new NodePicker(graph.positions, graph.nodeCount);
    this.world.add(this.edgeLayer.lines, this.pulseLayer.lines, this.nodeLayer.points);
    this.layOutNeurons();
    this.scenePass.layers = [
      { label: 'synapses', object: this.edgeLayer.lines },
      { label: 'points', object: this.nodeLayer.points },
      { label: 'pulses', object: this.pulseLayer.lines },
    ];
    this.hovered = -1;

    const first = !this.ready;
    this.applyLook();
    this.resize();
    this.ready = true;
    this.wake();

    // Open with a few firings so the piece is never a dead object on load.
    for (let i = 0; i < 3; i++) sim.stimulate(Math.floor(Math.random() * graph.nodeCount), 1);
    if (first) this.emit('ready', graph);
  }

  /** (Re)builds the somas and neurites for the current network and density. */
  private layOutNeurons(): void {
    this.disposeMembranes();
    const layout = layoutNeurons(this._graph, { fraction: this.state.look.cellDensity });
    this.membraneLayer = new MembraneLayer(this._sim, layout, this.nodeLayer.geometry, this.nodeTextures, {
      cellSize: scaleLook(this.state.look, this._graph.nodeCount).cellSize,
      cellZoom: this.state.look.cellZoom,
      referenceDistance: this.homeDistance(),
    });
    this.membranePass.layer = this.membraneLayer;
    this.laidOutDensity = this.state.look.cellDensity;
  }

  private disposeMembranes(): void {
    this.membranePass.layer = null;
    this.membraneLayer?.dispose();
    this.membraneLayer = null;
  }

  /* ---------------------------------------------------------------- look */

  /** The opening distance at the current fov, after the dolly zoom, fitted to the shape of the view. */
  private homeDistance(): number {
    return this.fov42Distance() * this.fit;
  }

  /** The opening distance at the current fov, framed by height alone. */
  private fov42Distance(): number {
    return (this.homeDistanceAt42 * Math.tan((42 * Math.PI) / 360)) / Math.tan((this.camera.fov * Math.PI) / 360);
  }

  /**
   * The opening view is framed by height: on a wide view that leaves room at
   * the sides, but a tall one (a phone held upright) would cut the brain
   * off left and right. This moves the opening view back just far enough
   * that the brain fills the width with the same margin it leaves top and
   * bottom: at every angle the drift turns it through, or at the opening
   * angle when it does not drift. Landscape views are
   * left exactly as they were. Until the user handles the camera, it is
   * moved to match.
   */
  private refit(): void {
    if (!this.nodeLayer) return;
    const camera = this.camera;
    const base = this.fov42Distance();
    const tanV = Math.tan((camera.fov * Math.PI) / 360);
    const tanH = tanV * camera.aspect;
    const positions = this.nodeLayer.geometry.getAttribute('position');
    const stride = Math.max(1, Math.floor(positions.count / 3000));
    const up = new Vector3(0, 1, 0);
    const toCamera = new Vector3();
    const right = new Vector3();
    const p = new Vector3();
    const world = this.nodeLayer.points.matrixWorld;
    let need = base;
    // Eight turns of the drift about the vertical axis, or none.
    const turns = this.state.look.autoRotate ? 8 : 1;
    for (let turn = 0; turn < turns; turn++) {
      toCamera.copy(this.homeDirection).applyAxisAngle(up, (turn * Math.PI) / 4);
      right.crossVectors(up, toCamera).normalize();
      const upright = new Vector3().crossVectors(toCamera, right);
      // The margin the height leaves at this angle, then the distance at
      // which the width leaves the same.
      let margin = 0;
      for (let i = 0; i < positions.count; i += stride) {
        p.fromBufferAttribute(positions, i).applyMatrix4(world).sub(this.controls.target);
        margin = Math.max(margin, Math.abs(p.dot(upright)) / ((base - p.dot(toCamera)) * tanV));
      }
      if (margin <= 0) continue;
      for (let i = 0; i < positions.count; i += stride) {
        p.fromBufferAttribute(positions, i).applyMatrix4(world).sub(this.controls.target);
        need = Math.max(need, Math.abs(p.dot(right)) / (margin * tanH) + p.dot(toCamera));
      }
    }
    const fit = need / base;
    if (Math.abs(fit - this.fit) < 1e-3) return;
    this.fit = fit;
    if (!this.handled) {
      const offset = camera.position.clone().sub(this.controls.target);
      camera.position.copy(this.controls.target).addScaledVector(offset.normalize(), this.homeDistance());
    }
    // Cells are sized as seen from the opening view.
    const look = this.state.look;
    this.membraneLayer?.setCellSize(scaleLook(look, this._graph.nodeCount).cellSize, look.cellZoom, this.homeDistance());
  }

  /** Background and brain colour for the look's theme. */
  private applyTheme(): void {
    const look = this.state.look;
    if (look.brainColor !== this.brainColor) {
      this.brainColor = look.brainColor;
      setBrainColor(this.brainColor);
      // Layers built later read the palette directly; live ones need a nudge.
      this.nodeLayer?.refreshTissue();
      this.nodeTextures?.refreshTissue();
    }
    const transparent = look.transparent && this.alpha;
    if (look.transparent && !this.alpha) this.emit('needsalpha');
    this.themePass.set(look.theme, look.background, transparent);
  }

  /**
   * Zoomed out, the cells merge into one brain-shaped mass and the dots and
   * synapses fade into it; zoomed in, they come apart into neurons. 0 at the
   * opening view and closer, 1 from three times that distance out.
   */
  private applyMerge(distance: number): void {
    const home = this.homeDistance();
    const t = Math.min(1, Math.max(0, (distance - home) / (2 * home)));
    const merge = this.state.look.neurons ? this.state.look.merge * t * t * (3 - 2 * t) : 0;
    this.membraneLayer?.setMerge(merge);
    // Resting tissue fades into the mass; activation still shows through.
    this.nodeLayer.material.uniforms.uDim.value = 1 - 0.85 * merge;
    this.edgeLayer.setOpacity(this.edgeOpacity * (1 - merge));
  }

  private applyLook(): void {
    const { look } = this.state;
    const scaled = scaleLook(look, this._graph.nodeCount);
    this.nodeLayer.material.uniforms.uSize.value = scaled.pointSize;
    this.edgeOpacity = scaled.edgeOpacity;
    this.edgeLayer.setOpacity(this.edgeOpacity);
    this.pulseLayer.setIntensity(scaled.pulseIntensity);
    this.pulseLayer.setCometLength(scaled.cometLength);
    this.bloom.strength = look.bloom;
    this.controls.autoRotate = look.autoRotate;
    this.setFov(look.fov);
    this.refit();
    this.applyTheme();
    this.membranePass.enabled = look.neurons;
    // Re-laying out takes up to ~0.4 s at 200k nodes and the slider fires on
    // every tick of a drag, so wait for it to settle.
    if (look.cellDensity !== this.laidOutDensity) {
      clearTimeout(this.relayoutTimer);
      this.relayoutTimer = window.setTimeout(() => this.layOutNeurons(), 150);
    }
    this.membraneLayer?.setCellSize(scaled.cellSize, look.cellZoom, this.homeDistance());
    this.wake();
  }

  /**
   * Changes the field of view as a dolly zoom: the camera moves so the brain
   * keeps its size on screen, and only the strength of the perspective changes.
   */
  private setFov(fov: number): void {
    const camera = this.camera;
    if (fov === camera.fov) return;
    const scale = Math.tan((camera.fov * Math.PI) / 360) / Math.tan((fov * Math.PI) / 360);
    camera.position.sub(this.controls.target).multiplyScalar(scale).add(this.controls.target);
    camera.fov = fov;
    camera.updateProjectionMatrix();
    this.resize();
  }

  /* ------------------------------------------------------- render pacing */

  /*
   * Render on demand, the way plotly's 3D scenes skip redraws when nothing
   * changed. While a wave runs or the user is handling the brain, every
   * frame is drawn. At rest only slow things move (drift of a fraction of a
   * pixel per second, a slow orbit, the shimmer), which look identical at
   * `restFps`, so frames in between are skipped. Most of a frame's cost is
   * the GPU (bloom especially), so skipped frames are where the power goes.
   */

  /** Keeps the full frame rate for at least `ms` more milliseconds. */
  private wake(ms = 400): void {
    this.activeUntil = Math.max(this.activeUntil, performance.now() + ms);
  }

  private shouldRender(now: number): boolean {
    // Below 10 fps a frame's step would exceed the sim's 0.1 s clamp and
    // slow time down, so the slider's 1-9 behave as 10.
    const rest = this.state.look.restFps;
    const restFps = rest > 0 ? Math.max(10, rest) : 0;
    if (restFps <= 0 || this.interacting || now < this.activeUntil || this._sim.livePulses > 0) return true;
    // A few ms of tolerance so rAF jitter doesn't skip a frame that is due.
    return now - this.lastRender >= 1000 / restFps - 4;
  }

  /* --------------------------------------------------------- interaction */

  private updatePointer(event: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.pointerInside = true;
    this.needsPick = true;
  }

  private pick(): number {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    // The picker works in the cloud's own space.
    this.toLocal.copy(this.nodeLayer.points.matrixWorld).invert();
    this.raycaster.ray.applyMatrix4(this.toLocal);
    // Scale the pick radius with distance so far-away dots stay clickable.
    const threshold = Math.min(this.picker.maxThreshold, 0.008 * this.camera.position.length());
    return this.picker.pick(this.raycaster.ray, threshold);
  }

  /* ----------------------------------------------------------- rendering */

  private resize(width?: number, height?: number, ratio?: number): void {
    width ??= this.canvas.clientWidth || this.canvas.width || 300;
    height ??= this.canvas.clientHeight || this.canvas.height || 150;
    ratio ??= Math.min(window.devicePixelRatio || 1, 2);

    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(width, height, false);
    this.composer.setPixelRatio(ratio);
    this.composer.setSize(width, height);
    // Bloom is a wide blur: from CSS pixels it looks the same as from device
    // pixels on a high-density screen, at a quarter of the cost.
    this.bloom.setSize(width, height);

    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
    this.refit();
    this.nodeLayer?.setViewport(ratio, height, this.camera.fov);
    this.wake(100);
  }

  /** Draws the current state of the network to the canvas. */
  private draw(): void {
    const sphere = this.nodeLayer.geometry.boundingSphere!;
    // The depth cue's uniforms are shared by every brain on the page.
    updateDepthCue(this.camera, sphere.center, sphere.radius, this.state.look.depth);
    this.applyMerge(this.camera.position.distanceTo(sphere.center));
    if (this.postprocessing) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  /**
   * Draws a frame and reads it back. The canvas is read in the same task as
   * the draw, before the browser presents and clears it, so this works
   * without `preserveDrawingBuffer`.
   */
  private capture(options: SnapshotOptions): Promise<Blob> {
    const sized = options.width !== undefined || options.height !== undefined || options.pixelRatio !== undefined;
    if (sized) {
      const width = options.width ?? (this.canvas.clientWidth || 300);
      const height = options.height ?? (this.canvas.clientHeight || 150);
      this.resize(width, height, options.pixelRatio ?? 1);
    }
    this.draw();
    const blob = this.readCanvas(options);
    if (sized) {
      this.resize();
      this.draw();
    }
    return blob;
  }

  private frame = (): void => {
    if (this.disposed) return;
    this.frameRequest = requestAnimationFrame(this.frame);
    if (!this.ready || this.paused) {
      this.clock.getDelta();
      return;
    }
    const now = performance.now();
    if (!this.shouldRender(now)) return;
    this.lastRender = now;
    // Time since the last drawn frame, whatever the pacing.
    const dt = this.clock.getDelta();

    this._sim.step(dt);

    if (this.needsPick && this.pointerInside) {
      this.hovered = this.pick();
      this.needsPick = false;
    }

    this.nodeLayer.update(this.pointerInside ? this.hovered : -1);
    this.pulseLayer.update();
    this.gpuTimer.poll();

    // Real elapsed time, so the orbit turns at the same speed at any frame
    // rate (without it OrbitControls steps a fixed angle per call: three
    // times slower at a 20 fps rest, twice as fast on a 120 Hz display).
    this.controls.update(Math.min(dt, 0.1));
    this.draw();

    if (!this.rendered) {
      this.rendered = true;
      // Read back in the same task as the draw (see capture).
      const captures = this.firstRenderCaptures;
      this.firstRenderCaptures = [];
      for (const { options, resolve, reject } of captures) {
        const sized = options.width !== undefined || options.height !== undefined || options.pixelRatio !== undefined;
        (sized ? this.capture(options) : this.readCanvas(options)).then(resolve, reject);
      }
      this.resolveFirstRender();
      this.emit('firstrender');
    }

    this.fps += ((dt > 0 ? 1 / dt : 60) - this.fps) * 0.08;
    if (now - this.lastStats > 180) {
      const sim = this._sim;
      // The counter restarts when the network is rebuilt or reset.
      if (sim.stats.firings < this.firingsAt) this.firingsAt = 0;
      const firingsPerSecond = ((sim.stats.firings - this.firingsAt) * 1000) / (now - this.lastStats);
      this.firingsAt = sim.stats.firings;
      this.lastStats = now;
      this.emit<NeuroformStats>('stats', {
        nodes: this._graph.nodeCount,
        synapses: this._graph.edgeCount,
        inFlight: sim.livePulses,
        firingsPerSecond,
        fps: this.fps,
        building: this.building,
        hovered: this.hovered,
        gpu: this.timerMode !== 'off' ? this.gpuTimer.summary() : '',
      });
    }
  };

  /** Reads the canvas as it is now; toBlob copies the pixels before returning. */
  private readCanvas(options: SnapshotOptions): Promise<Blob> {
    return new Promise((resolve, reject) => {
      this.canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('the canvas could not be read'))),
        options.type ?? 'image/png',
        options.quality,
      );
    });
  }
}
