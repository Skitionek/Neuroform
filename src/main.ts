/**
 * Neuroform — a brain-shaped point cloud whose synapses carry waves of
 * activation. Click a node to make it fire; the wave does the rest.
 */
import {
  Clock,
  Group,
  Matrix4,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector2,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

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
import { NodePicker } from './render/picker';
import { PulseLayer } from './render/pulses';
import { PALETTE } from './render/palette';
import { createPanel, type PanelState } from './ui/panel';

const canvas = document.querySelector<HTMLCanvasElement>('#stage')!;
const readout = document.querySelector<HTMLElement>('#readout-text')!;

/* ----------------------------------------------------------------- settings */

const state: PanelState = {
  structure: {
    nodes: 55000,
    seed: 7,
    foldDepth: 0.034,
    foldScale: 7.4,
    shell: 0.055,
    fill: 1,
    minDegree: 2,
    maxDegree: 9,
    radius: 0.075,
  },
  signal: {
    speed: DEFAULT_PARAMS.speed,
    threshold: DEFAULT_PARAMS.threshold,
    gain: DEFAULT_PARAMS.gain,
    decay: DEFAULT_PARAMS.decay,
    refractory: DEFAULT_PARAMS.refractory,
    reliability: DEFAULT_PARAMS.reliability,
    range: DEFAULT_PARAMS.range,
    glow: DEFAULT_PARAMS.glow,
    spontaneous: DEFAULT_PARAMS.spontaneous,
    shimmer: DEFAULT_PARAMS.shimmer,
  },
  look: {
    pointSize: 4.8,
    edgeOpacity: 0.032,
    pulseIntensity: 1.2,
    cometLength: 0.055,
    bloom: 0.45,
    autoRotate: true,
    restFps: 20,
    neurons: true,
    // Small blobs on every node; the merge is depth-aware, so only nodes
    // that are actually close fuse.
    cellDensity: 1,
    cellSize: 0.003,
    cellZoom: 1,
    depth: 0.7,
    fov: 55,
  },
};

/**
 * Query parameters override any setting, so a particular brain is a link:
 * `?nodes=60000&foldScale=9&bloom=1.2&seed=42`.
 */
function applyUrlOverrides(): void {
  const params = new URLSearchParams(window.location.search);
  if (params.size === 0) return;
  const groups = [state.structure, state.signal, state.look] as unknown as Record<string, unknown>[];
  for (const group of groups) {
    for (const key of Object.keys(group)) {
      const raw = params.get(key);
      if (raw === null) continue;
      if (typeof group[key] === 'boolean') {
        group[key] = raw !== '0' && raw !== 'false';
      } else {
        const value = Number(raw);
        if (Number.isFinite(value)) group[key] = value;
      }
    }
  }
}

applyUrlOverrides();

/* -------------------------------------------------------------- scene setup */

// `?capture=1` keeps the drawing buffer around so the canvas can be read back
// with toDataURL. It costs a little performance, so it stays opt-in.
const captureMode = new URLSearchParams(window.location.search).get('capture') === '1';

const renderer = new WebGLRenderer({
  canvas,
  antialias: false,
  powerPreference: 'high-performance',
  preserveDrawingBuffer: captureMode,
});
renderer.setClearColor(PALETTE.background, 1);

const scene = new Scene();
// Opens at 42° and the home position; a different fov is applied as a dolly
// zoom from there (see setFov), so the framing stays the same.
const camera = new PerspectiveCamera(42, 1, 0.01, 50);
camera.position.set(1.35, 0.42, 1.5);
/** Opening camera distance at 42°: cell sizes are given as seen from here. */
const HOME_DISTANCE = camera.position.length();

/** The opening distance at the current fov, after the dolly zoom. */
function homeDistance(): number {
  return (HOME_DISTANCE * Math.tan((42 * Math.PI) / 360)) / Math.tan((camera.fov * Math.PI) / 360);
}

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.rotateSpeed = 0.55;
controls.zoomSpeed = 0.7;
controls.minDistance = 0.35;
controls.maxDistance = 6;
controls.autoRotateSpeed = 0.28;

const world = new Group();
scene.add(world);

// `?gpu=1` times each render pass with GPU timer queries and shows the result
// under the readout; `?gpu=finish` is a stalling fallback for GPUs and
// browsers without the timer extension.
const gpuParam = new URLSearchParams(window.location.search).get('gpu');
const timerMode: TimerMode = gpuParam === 'finish' ? 'finish' : gpuParam ? 'query' : 'off';
const gpuTimer = new GpuTimer(renderer.getContext() as WebGL2RenderingContext, timerMode);
const gpuReadout = document.querySelector<HTMLElement>('#gpu-text')!;

const composer = new EffectComposer(renderer);
const scenePass = new ScenePass(scene, camera, gpuTimer);
composer.addPass(scenePass);
// Neurons as merging, membraned cells, drawn over the scene before bloom.
const membranePass = new MembranePass(camera, gpuTimer);
// `?cellRes=1` pins the cells' density buffer to full resolution (or any
// share of it); by default it drops as far as the cells' size allows.
const cellRes = Number(new URLSearchParams(window.location.search).get('cellRes'));
if (cellRes > 0) membranePass.setResolution(cellRes);
composer.addPass(membranePass);
// A high threshold keeps the bloom on firing nodes and pulses instead of
// lifting the whole resting cloud into a haze.
const bloom = new UnrealBloomPass(new Vector2(1, 1), state.look.bloom, 0.5, 0.5);
composer.addPass(bloom);
// Without this the composer's linear buffer reaches the canvas unconverted and
// the near-black background lifts to navy.
const output = new OutputPass();
composer.addPass(output);

// Bloom and output are timed as wholes.
for (const [label, pass] of [['bloom', bloom], ['output', output]] as const) {
  const render = pass.render.bind(pass);
  pass.render = (...args: Parameters<typeof render>) => {
    gpuTimer.begin(label);
    render(...args);
    gpuTimer.end();
  };
}

/* ------------------------------------------------------------------ network */

let graph: NetworkGraph;
let sim: NetworkSim;
let nodeLayer: NodeLayer;
let edgeLayer: EdgeLayer;
let nodeTextures: NodeTextures;
let membraneLayer: MembraneLayer | null = null;
/** The cell density the current membrane layer was laid out for. */
let laidOutDensity = -1;
let relayoutTimer = 0;
let pulseLayer: PulseLayer;
let picker: NodePicker;
/** False until the first network is in place. */
let ready = false;
/** Shown in the readout while a rebuild runs; the old network keeps animating. */
let building = false;

const builder = new GraphBuilder();

function currentRequest(): GraphRequest {
  // `?dataset=my-graph.json` loads a network from data instead of generating
  // one. Everything downstream reads the same NetworkGraph either way.
  const dataset = new URLSearchParams(window.location.search).get('dataset');
  if (dataset) return { kind: 'dataset', url: new URL(dataset, window.location.href).href };

  return {
    kind: 'procedural',
    options: {
      count: state.structure.nodes,
      seed: state.structure.seed,
      shell: state.structure.shell,
      fill: state.structure.fill,
      foldDepth: state.structure.foldDepth,
      foldScale: state.structure.foldScale,
      minDegree: state.structure.minDegree,
      maxDegree: state.structure.maxDegree,
      radius: scaleReach(state.structure.radius, state.structure.nodes),
    },
  };
}

function teardown(): void {
  if (!nodeLayer) return;
  world.remove(nodeLayer.points, edgeLayer.lines, pulseLayer.lines);
  edgeLayer.dispose();
  nodeLayer.dispose();
  pulseLayer.dispose();
  disposeMembranes();
  nodeTextures.dispose();
}

async function build(): Promise<void> {
  building = true;
  if (!ready) readout.textContent = 'growing network…';

  // The network is generated on a worker, so the current one keeps animating
  // (and stays interactive) until its replacement is ready.
  let next: NetworkGraph;
  try {
    next = await builder.build(currentRequest());
  } catch (error) {
    if (error instanceof SupersededError) return; // a newer build owns the readout
    building = false;
    readout.textContent = `could not build network: ${(error as Error).message}`;
    return;
  }
  building = false;

  // Swap synchronously, so no frame ever sees a half-built scene.
  teardown();
  graph = next;
  sim = new NetworkSim(graph, { ...DEFAULT_PARAMS, ...state.signal, maxPulses: pulseCapacity(graph.nodeCount) });

  const look = scaleLook(state.look, graph.nodeCount);
  nodeTextures = new NodeTextures(graph);
  nodeLayer = new NodeLayer(graph, sim, { size: look.pointSize });
  edgeLayer = new EdgeLayer(graph, nodeTextures, { opacity: look.edgeOpacity });
  pulseLayer = new PulseLayer(sim, nodeTextures, {
    cometLength: look.cometLength,
    intensity: look.pulseIntensity,
  });
  picker = new NodePicker(graph.positions, graph.nodeCount);
  world.add(edgeLayer.lines, pulseLayer.lines, nodeLayer.points);
  layOutNeurons();
  scenePass.layers = [
    { label: 'synapses', object: edgeLayer.lines },
    { label: 'points', object: nodeLayer.points },
    { label: 'pulses', object: pulseLayer.lines },
  ];
  hovered = -1;

  applyLook();
  resize();
  ready = true;
  wake();

  // Open with a few firings so the piece is never a dead object on load.
  for (let i = 0; i < 3; i++) {
    sim.stimulate(Math.floor(Math.random() * graph.nodeCount), 1);
  }
}

/** (Re)builds the somas and neurites for the current network and density. */
function layOutNeurons(): void {
  disposeMembranes();
  const layout = layoutNeurons(graph, { fraction: state.look.cellDensity });
  membraneLayer = new MembraneLayer(sim, layout, nodeLayer.geometry, nodeTextures, {
    cellSize: scaleLook(state.look, graph.nodeCount).cellSize,
    cellZoom: state.look.cellZoom,
    referenceDistance: homeDistance(),
  });
  membranePass.layer = membraneLayer;
  laidOutDensity = state.look.cellDensity;
}

function disposeMembranes(): void {
  membranePass.layer = null;
  membraneLayer?.dispose();
  membraneLayer = null;
}

function applySignal(): void {
  Object.assign(sim.params, state.signal);
  wake();
}

function applyLook(): void {
  const { look } = state;
  const scaled = scaleLook(look, graph.nodeCount);
  nodeLayer.material.uniforms.uSize.value = scaled.pointSize;
  edgeLayer.setOpacity(scaled.edgeOpacity);
  pulseLayer.setIntensity(scaled.pulseIntensity);
  pulseLayer.setCometLength(scaled.cometLength);
  bloom.strength = look.bloom;
  controls.autoRotate = look.autoRotate;
  setFov(look.fov);
  membranePass.enabled = look.neurons;
  // Re-laying out takes up to ~0.4 s at 200k nodes and the slider fires on
  // every tick of a drag, so wait for it to settle.
  if (look.cellDensity !== laidOutDensity) {
    clearTimeout(relayoutTimer);
    relayoutTimer = window.setTimeout(layOutNeurons, 150);
  }
  membraneLayer?.setCellSize(scaled.cellSize, look.cellZoom, homeDistance());
  wake();
}

/**
 * Changes the field of view as a dolly zoom: the camera moves so the brain
 * keeps its size on screen, and only the strength of the perspective changes.
 */
function setFov(fov: number): void {
  if (fov === camera.fov) return;
  const scale = Math.tan((camera.fov * Math.PI) / 360) / Math.tan((fov * Math.PI) / 360);
  camera.position.sub(controls.target).multiplyScalar(scale).add(controls.target);
  camera.fov = fov;
  camera.updateProjectionMatrix();
  resize();
}

/* ---------------------------------------------------------- render pacing */

/**
 * Render on demand, the way plotly's 3D scenes skip redraws when nothing
 * changed. While a wave runs or the user is handling the brain, every frame is
 * drawn. At rest only slow things move (drift of a fraction of a pixel per
 * second, a slow orbit, the shimmer), which look identical at `restFps`, so
 * frames in between are skipped. Most of a frame's cost is the GPU (bloom
 * especially), so skipped frames are where the power goes.
 */
let lastRender = 0;
let activeUntil = 0;
let interacting = false;

/** Keeps the full frame rate for at least `ms` more milliseconds. */
function wake(ms = 400): void {
  activeUntil = Math.max(activeUntil, performance.now() + ms);
}

controls.addEventListener('start', () => {
  interacting = true;
  wake();
});
controls.addEventListener('end', () => {
  interacting = false;
  // Damping keeps the camera gliding for a while after release.
  wake(1500);
});

function shouldRender(now: number): boolean {
  // Below 10 fps a frame's step would exceed the sim's 0.1 s clamp and slow
  // time down, so the slider's 1-9 behave as 10.
  const restFps = state.look.restFps > 0 ? Math.max(10, state.look.restFps) : 0;
  if (restFps <= 0 || interacting || now < activeUntil || sim.livePulses > 0) return true;
  // A few ms of tolerance so rAF jitter doesn't skip a frame that is due.
  return now - lastRender >= 1000 / restFps - 4;
}

/* -------------------------------------------------------------- interaction */

const raycaster = new Raycaster();
const toLocal = new Matrix4();
const pointer = new Vector2();
let pointerInside = false;
let pointerMoved = false;
let hovered = -1;
let needsPick = false;
let pressedAt = 0;
let pressPosition = new Vector2();

function updatePointer(event: PointerEvent): void {
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  pointerInside = true;
  needsPick = true;
}

function pick(): number {
  raycaster.setFromCamera(pointer, camera);
  // The picker works in the cloud's own space.
  toLocal.copy(nodeLayer.points.matrixWorld).invert();
  raycaster.ray.applyMatrix4(toLocal);
  // Scale the pick radius with distance so far-away dots stay clickable.
  const threshold = Math.min(picker.maxThreshold, 0.008 * camera.position.length());
  return picker.pick(raycaster.ray, threshold);
}

canvas.addEventListener('pointermove', (event) => {
  updatePointer(event);
  wake(300); // hover feedback should track the pointer at full rate
  if (pressPosition.distanceTo(new Vector2(event.clientX, event.clientY)) > 6) {
    pointerMoved = true;
  }
});

canvas.addEventListener('pointerleave', () => {
  pointerInside = false;
  hovered = -1;
});

canvas.addEventListener('pointerdown', (event) => {
  pressedAt = performance.now();
  pointerMoved = false;
  pressPosition.set(event.clientX, event.clientY);
  updatePointer(event);
});

canvas.addEventListener('pointerup', (event) => {
  // A click fires a node; a drag is the user orbiting the camera.
  if (!ready || pointerMoved || performance.now() - pressedAt > 450) return;
  updatePointer(event);
  const node = pick();
  if (node >= 0) sim.stimulate(node, 1);
});

window.addEventListener('keydown', (event) => {
  if (!ready) return;
  wake();
  if (event.key === ' ') {
    event.preventDefault();
    sim.stimulate(Math.floor(Math.random() * graph.nodeCount), 1);
  } else if (event.key === 'r' || event.key === 'R') {
    sim.reset();
  }
});

/* ---------------------------------------------------------------- resize/run */

function resize(): void {
  const width = canvas.clientWidth || window.innerWidth;
  const height = canvas.clientHeight || window.innerHeight;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);

  renderer.setPixelRatio(ratio);
  renderer.setSize(width, height, false);
  composer.setPixelRatio(ratio);
  composer.setSize(width, height);
  // Bloom is a wide blur: from CSS pixels it looks the same as from device
  // pixels on a high-density screen, at a quarter of the cost.
  bloom.setSize(width, height);

  camera.aspect = width / Math.max(1, height);
  camera.updateProjectionMatrix();
  nodeLayer?.setViewport(ratio, height, camera.fov);
}

window.addEventListener('resize', resize);

const clock = new Clock();
let fps = 60;
let lastReadout = 0;
let firingsAt = 0;
let firingRate = 0;

function frame(): void {
  requestAnimationFrame(frame);
  if (!ready) {
    clock.getDelta();
    return;
  }
  const now = performance.now();
  if (!shouldRender(now)) return;
  lastRender = now;
  // Time since the last drawn frame, whatever the pacing.
  const dt = clock.getDelta();

  sim.step(dt);

  if (needsPick && pointerInside) {
    hovered = pick();
    needsPick = false;
  }

  nodeLayer.update(pointerInside ? hovered : -1);
  pulseLayer.update();
  gpuTimer.poll();

  // Real elapsed time, so the orbit turns at the same speed at any frame rate
  // (without it OrbitControls steps a fixed angle per call: three times slower
  // at a 20 fps rest, twice as fast on a 120 Hz display).
  controls.update(Math.min(dt, 0.1));
  const sphere = nodeLayer.geometry.boundingSphere!;
  updateDepthCue(camera, sphere.center, sphere.radius, state.look.depth);
  if (window.neuroform.postprocessing) {
    composer.render();
  } else {
    renderer.render(scene, camera);
  }

  fps += ((dt > 0 ? 1 / dt : 60) - fps) * 0.08;
  if (now - lastReadout > 180) {
    if (timerMode !== 'off') gpuReadout.textContent = gpuTimer.summary();
    // The counter restarts when the network is rebuilt or reset.
    if (sim.stats.firings < firingsAt) firingsAt = 0;
    firingRate = ((sim.stats.firings - firingsAt) * 1000) / (now - lastReadout);
    firingsAt = sim.stats.firings;
    lastReadout = now;
    readout.textContent = [
      `${graph.nodeCount.toLocaleString()} nodes`,
      `${graph.edgeCount.toLocaleString()} synapses`,
      `${sim.livePulses.toLocaleString()} in flight`,
      `${firingRate.toFixed(0)} firings/s`,
      `${fps.toFixed(0)} fps`,
      building ? 'growing a new network…' : hovered >= 0 ? `node ${hovered}` : 'click a node · space fires one · r quiets',
    ].join('   ·   ');
  }
}

/* ------------------------------------------------------------ public handle */

/**
 * A small console-facing API: handy for driving the piece from a page script,
 * loading a dataset at runtime, or poking at it while tuning.
 */
declare global {
  interface Window {
    neuroform: {
      stimulate(node?: number): void;
      reset(): void;
      /** Changes look settings, e.g. `look({ bloom: 1, restFps: 30 })`. */
      look(changes: Partial<PanelState['look']>): void;
      /** Rebuilds the network, optionally changing structure settings first. */
      rebuild(structure?: Partial<PanelState['structure']>): Promise<void>;
      get graph(): NetworkGraph;
      get sim(): NetworkSim;
      layers: { nodes: NodeLayer; edges: EdgeLayer; pulses: PulseLayer; membranes: MembraneLayer | null };
      /** Smoothed GPU milliseconds per render section, when ?gpu is set. */
      gpuTimings(): Record<string, number>;
      /** Clears the GPU timings, e.g. after changing a setting. */
      resetGpuTimings(): void;
      scene: Scene;
      camera: PerspectiveCamera;
      renderer: WebGLRenderer;
      postprocessing: boolean;
    };
  }
}

window.neuroform = {
  stimulate: (node) => {
    if (ready) sim.stimulate(node ?? Math.floor(Math.random() * graph.nodeCount), 1);
  },
  reset: () => {
    sim.reset();
    wake();
  },
  look: (changes) => {
    Object.assign(state.look, changes);
    applyLook();
  },
  rebuild: (structure) => {
    Object.assign(state.structure, structure);
    return build();
  },
  get graph() { return graph; },
  get sim() { return sim; },
  get layers() { return { nodes: nodeLayer, edges: edgeLayer, pulses: pulseLayer, membranes: membraneLayer }; },
  gpuTimings: () => Object.fromEntries(gpuTimer.ms),
  resetGpuTimings: () => gpuTimer.reset(),
  scene,
  camera,
  renderer,
  postprocessing: true,
};

/* -------------------------------------------------------------------- start */

createPanel(state, {
  onStructureChange: () => void build(),
  onSignalChange: () => applySignal(),
  onLookChange: () => applyLook(),
  onStimulate: () => window.neuroform.stimulate(),
  onReset: () => sim.reset(),
});

void build().then(() => frame());
