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
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

import { GraphBuilder, SupersededError, type GraphRequest } from './graph/request';
import type { NetworkGraph } from './graph/types';
import { DEFAULT_PARAMS, NetworkSim } from './sim/network';
import { EdgeLayer } from './render/edges';
import { NodeLayer } from './render/nodes';
import { NodePicker } from './render/picker';
import { PulseLayer } from './render/pulses';
import { PALETTE } from './render/palette';
import { createPanel, type PanelState } from './ui/panel';

const canvas = document.querySelector<HTMLCanvasElement>('#stage')!;
const readout = document.querySelector<HTMLElement>('#readout-text')!;

/* ----------------------------------------------------------------- settings */

const state: PanelState = {
  structure: {
    nodes: 26000,
    seed: 7,
    foldDepth: 0.034,
    foldScale: 7.4,
    shell: 0.055,
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
const camera = new PerspectiveCamera(42, 1, 0.01, 50);
camera.position.set(1.35, 0.42, 1.5);

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

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
// A high threshold keeps the bloom on firing nodes and pulses instead of
// lifting the whole resting cloud into a haze.
const bloom = new UnrealBloomPass(new Vector2(1, 1), state.look.bloom, 0.5, 0.5);
composer.addPass(bloom);
// Without this the composer's linear buffer reaches the canvas unconverted and
// the near-black background lifts to navy.
composer.addPass(new OutputPass());

/* ------------------------------------------------------------------ network */

let graph: NetworkGraph;
let sim: NetworkSim;
let nodeLayer: NodeLayer;
let edgeLayer: EdgeLayer;
let pulseLayer: PulseLayer;
let picker: NodePicker;
/** False until the first network is in place. */
let ready = false;
/** Shown in the readout while a rebuild runs; the old network keeps animating. */
let building = false;

const builder = new GraphBuilder();

function currentRequest(): GraphRequest {
  // `?dataset=/my-graph.json` loads a network from data instead of generating
  // one. Everything downstream reads the same NetworkGraph either way.
  const dataset = new URLSearchParams(window.location.search).get('dataset');
  if (dataset) return { kind: 'dataset', url: new URL(dataset, window.location.href).href };

  return {
    kind: 'procedural',
    options: {
      count: state.structure.nodes,
      seed: state.structure.seed,
      shell: state.structure.shell,
      foldDepth: state.structure.foldDepth,
      foldScale: state.structure.foldScale,
      minDegree: state.structure.minDegree,
      maxDegree: state.structure.maxDegree,
      radius: state.structure.radius,
    },
  };
}

function teardown(): void {
  if (!nodeLayer) return;
  world.remove(nodeLayer.points, edgeLayer.object, pulseLayer.lines);
  // Edges first: they borrow the node layer's attributes.
  edgeLayer.dispose();
  nodeLayer.dispose();
  pulseLayer.dispose();
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
  sim = new NetworkSim(graph, { ...DEFAULT_PARAMS, ...state.signal });

  nodeLayer = new NodeLayer(graph, sim, { size: state.look.pointSize });
  edgeLayer = new EdgeLayer(graph, nodeLayer.geometry, { opacity: state.look.edgeOpacity });
  pulseLayer = new PulseLayer(graph, sim, {
    cometLength: state.look.cometLength,
    intensity: state.look.pulseIntensity,
  });
  picker = new NodePicker(graph.positions, graph.nodeCount);
  world.add(edgeLayer.object, pulseLayer.lines, nodeLayer.points);
  hovered = -1;

  applyLook();
  resize();
  ready = true;

  // Open with a few firings so the piece is never a dead object on load.
  for (let i = 0; i < 3; i++) {
    sim.stimulate(Math.floor(Math.random() * graph.nodeCount), 1);
  }
}

function applySignal(): void {
  Object.assign(sim.params, state.signal);
}

function applyLook(): void {
  const { look } = state;
  nodeLayer.material.uniforms.uSize.value = look.pointSize;
  edgeLayer.setOpacity(look.edgeOpacity);
  pulseLayer.setIntensity(look.pulseIntensity);
  pulseLayer.setCometLength(look.cometLength);
  bloom.strength = look.bloom;
  controls.autoRotate = look.autoRotate;
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
  bloom.setSize(width * ratio, height * ratio);

  camera.aspect = width / Math.max(1, height);
  camera.updateProjectionMatrix();
  nodeLayer?.setViewport(ratio, height);
}

window.addEventListener('resize', resize);

const clock = new Clock();
let fps = 60;
let lastReadout = 0;
let firingsAt = 0;
let firingRate = 0;

function frame(): void {
  requestAnimationFrame(frame);
  const dt = clock.getDelta();
  if (!ready) return;

  sim.step(dt);

  if (needsPick && pointerInside) {
    hovered = pick();
    needsPick = false;
  }

  nodeLayer.update(pointerInside ? hovered : -1);
  pulseLayer.update();

  controls.update();
  if (window.neuroform.postprocessing) {
    composer.render();
  } else {
    renderer.render(scene, camera);
  }

  fps += ((dt > 0 ? 1 / dt : 60) - fps) * 0.08;
  const now = performance.now();
  if (now - lastReadout > 180) {
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
      /** Rebuilds the network, optionally changing structure settings first. */
      rebuild(structure?: Partial<PanelState['structure']>): Promise<void>;
      get graph(): NetworkGraph;
      get sim(): NetworkSim;
      layers: { nodes: NodeLayer; edges: EdgeLayer; pulses: PulseLayer };
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
  reset: () => sim.reset(),
  rebuild: (structure) => {
    Object.assign(state.structure, structure);
    return build();
  },
  get graph() { return graph; },
  get sim() { return sim; },
  get layers() { return { nodes: nodeLayer, edges: edgeLayer, pulses: pulseLayer }; },
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
