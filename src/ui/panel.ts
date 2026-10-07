/**
 * Control panel. Structure settings rebuild the network; everything else is
 * live, so the signal can be tuned while a wave is still running.
 */
import GUI from 'lil-gui';
import { BRAIN_SHAPES, type BrainShape } from '../brain/shape';

export interface StructureSettings {
  nodes: number;
  shape: BrainShape;
  seed: number;
  foldDepth: number;
  foldScale: number;
  shell: number;
  /** 1 fills the brain's volume evenly; 0 keeps nodes to the surface shell. */
  fill: number;
  minDegree: number;
  maxDegree: number;
  radius: number;
}

export interface SignalSettings {
  speed: number;
  threshold: number;
  gain: number;
  decay: number;
  refractory: number;
  reliability: number;
  range: number;
  glow: number;
  spontaneous: number;
  shimmer: number;
}

export interface LookSettings {
  pointSize: number;
  edgeOpacity: number;
  pulseIntensity: number;
  cometLength: number;
  bloom: number;
  autoRotate: boolean;
  /** Frame rate while nothing fast is happening; 0 renders every frame. */
  restFps: number;
  /** Draw a share of the nodes as membraned cells with merging neurites. */
  neurons: boolean;
  /** Share of nodes drawn as cells. */
  cellDensity: number;
  /** Cell body radius, model units, at the opening camera distance. */
  cellSize: number;
  /** 0 keeps cells a fixed size in the brain, 1 a fixed size on screen. */
  cellZoom: number;
  /** How far cells merge into one mass when zoomed out, 0 to 1. */
  merge: number;
  /** How much the far side of the brain darkens, activation included. */
  depth: number;
  /** Vertical field of view in degrees; changed as a dolly zoom. */
  fov: number;
}

export interface PanelHandlers {
  onStructureChange(): void;
  onSignalChange(): void;
  onLookChange(): void;
  onStimulate(): void;
  onReset(): void;
}

export interface PanelState {
  structure: StructureSettings;
  signal: SignalSettings;
  look: LookSettings;
}

/**
 * What each option does, shown under the panel for the control under the
 * pointer or keyboard focus, and as a native tooltip.
 */
const HELP: Record<string, string> = {
  nodes: 'How many neurons make up the brain. More is finer and slower; the other settings are normalised, so behaviour and brightness stay the same.',
  shape: 'classic: the original egg with noise folds. anatomical: built from lobes, fissures and named sulci. scan: a real brain, from the MNI ICBM152 template (77 kB, loaded when picked).',
  seed: 'Which brain: the same seed always grows the same shape and wiring.',
  foldDepth: 'How deep the folds (gyri) cut into the surface. 0 is a smooth brain.',
  foldScale: 'How fine the folds are: higher means more, narrower ridges.',
  shell: 'Thickness of the surface layer, which is drawn brightest and, with low fill, holds most nodes.',
  fill: '1 spreads nodes evenly through the whole volume; 0 crowds them into the surface layer.',
  minDegree: 'Fewest synapses a neuron makes to its neighbours.',
  maxDegree: 'Most synapses a neuron makes. Each node picks a random count between min and max.',
  radius: 'How far a synapse can reach, as a share of the brain\'s size.',
  speed: 'How fast a signal travels along a synapse.',
  threshold: 'Charge a neuron must collect before it fires. Higher makes waves die out sooner.',
  gain: 'Charge each arriving signal delivers.',
  decay: 'How fast collected charge leaks away when signals stop arriving.',
  refractory: 'Seconds a neuron stays silent after firing.',
  reliability: 'Chance that a synapse actually passes a signal on.',
  range: 'How far a signal travels before fading out completely.',
  glow: 'How long a neuron keeps glowing after it fires, in seconds (half-life).',
  spontaneous: 'How often, per second, a random neuron fires on its own.',
  shimmer: 'Faint idle flicker across the network while nothing is happening.',
  pointSize: 'Size of the dots drawn for each neuron.',
  edgeOpacity: 'How visible the resting synapses are.',
  pulseIntensity: 'Brightness of signals travelling along synapses.',
  cometLength: 'Length of the bright tail behind each travelling signal.',
  bloom: 'Strength of the soft glow around bright things.',
  depth: 'How much the far side of the brain darkens, so the near side reads in front. Applies to waves too: activation at the back glows dimmer.',
  fov: 'Field of view in degrees. Wider exaggerates perspective; the camera moves so the brain keeps its size on screen.',
  autoRotate: 'Slowly turn the brain when you are not touching it.',
  restFps: 'Frame rate when only the slow drift is moving, to save power. 0 always draws every frame.',
  neurons: 'Draw some neurons as gooey cells, joined by neurites that merge like liquid.',
  cellDensity: 'Share of neurons drawn as cells.',
  cellSize: 'Size of a cell body, as seen from the opening view.',
  cellZoom: 'How cells react to zoom: 0 keeps their size in the brain, so they grow as you close in; 1 keeps their size on screen.',
  merge: 'Zoomed out, cells merge into one uniform brain shape and the dots and synapses fade into it; zoomed in, it comes apart into single neurons. Starts at the opening view, complete at three times its distance. 0 turns it off.',
  fire: 'Fire a random neuron, as if you had clicked it.',
  reset: 'Stop every signal and let the network go dark.',
};

export function createPanel(state: PanelState, handlers: PanelHandlers): GUI {
  const gui = new GUI({ title: 'neuroform' });
  gui.close();

  const structure = gui.addFolder('structure');
  const s = state.structure;
  structure.add(s, 'nodes', 2000, 200000, 1000);
  structure.add(s, 'shape', BRAIN_SHAPES);
  structure.add(s, 'seed', 1, 999, 1);
  structure.add(s, 'foldDepth', 0, 0.08, 0.001).name('fold depth');
  structure.add(s, 'foldScale', 2, 16, 0.1).name('fold scale');
  structure.add(s, 'shell', 0.02, 0.14, 0.002).name('shell');
  structure.add(s, 'fill', 0, 1, 0.05).name('fill volume');
  structure.add(s, 'minDegree', 1, 8, 1).name('min synapses');
  structure.add(s, 'maxDegree', 2, 24, 1).name('max synapses');
  structure.add(s, 'radius', 0.03, 0.16, 0.002).name('reach');
  structure.onFinishChange(() => {
    if (s.maxDegree < s.minDegree) s.maxDegree = s.minDegree;
    handlers.onStructureChange();
  });

  const signal = gui.addFolder('signal');
  const g = state.signal;
  signal.add(g, 'speed', 0.05, 3, 0.01);
  signal.add(g, 'threshold', 0.1, 4, 0.05);
  signal.add(g, 'gain', 0.05, 2, 0.01);
  signal.add(g, 'decay', 0.05, 2, 0.01).name('charge decay');
  signal.add(g, 'refractory', 0.05, 3, 0.01);
  signal.add(g, 'reliability', 0, 1, 0.01);
  signal.add(g, 'range', 0.1, 6, 0.05).name('signal range');
  signal.add(g, 'glow', 0.05, 3, 0.01).name('afterglow');
  signal.add(g, 'spontaneous', 0, 5, 0.01).name('idle chatter');
  signal.add(g, 'shimmer', 0, 600, 5).name('shimmer');
  signal.onChange(() => handlers.onSignalChange());

  const look = gui.addFolder('look');
  const l = state.look;
  look.add(l, 'pointSize', 0.5, 8, 0.1).name('point size');
  look.add(l, 'edgeOpacity', 0, 0.3, 0.002).name('synapse veil');
  look.add(l, 'pulseIntensity', 0, 4, 0.05).name('pulse glow');
  look.add(l, 'cometLength', 0.01, 0.3, 0.005).name('comet length');
  look.add(l, 'bloom', 0, 2, 0.02);
  look.add(l, 'depth', 0, 1, 0.01).name('depth fade');
  look.add(l, 'fov', 15, 90, 1).name('perspective (fov)');
  look.add(l, 'autoRotate').name('drift');
  look.add(l, 'restFps', 0, 60, 1).name('resting fps (0 = off)');
  look.add(l, 'neurons').name('neurons');
  look.add(l, 'cellDensity', 0.01, 1, 0.01).name('cell density');
  look.add(l, 'cellSize', 0.0002, 0.01, 0.0001).name('cell size');
  look.add(l, 'cellZoom', 0, 1, 0.05).name('cells follow zoom');
  look.add(l, 'merge', 0, 1, 0.05).name('merge when far');
  look.onChange(() => handlers.onLookChange());

  gui.add({ fire: () => handlers.onStimulate() }, 'fire').name('fire a node');
  gui.add({ reset: () => handlers.onReset() }, 'reset').name('quiet the network');

  attachHelp(gui);
  return gui;
}

/** Tooltips on every control, plus a help line that follows the pointer and focus. */
function attachHelp(gui: GUI): void {
  const idle = 'Point at an option to see what it does.';
  const line = document.createElement('div');
  line.className = 'panel-help';
  line.textContent = idle;
  // Inside the children so it folds away with the panel.
  gui.$children.appendChild(line);

  for (const controller of gui.controllersRecursive()) {
    const text = HELP[controller.property];
    if (!text) continue;
    const el = controller.domElement;
    el.title = text;
    const show = () => { line.textContent = text; };
    el.addEventListener('pointerenter', show);
    el.addEventListener('focusin', show);
  }
  gui.domElement.addEventListener('pointerleave', () => { line.textContent = idle; });
}
