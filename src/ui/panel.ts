/**
 * Control panel. Structure settings rebuild the network; everything else is
 * live, so the signal can be tuned while a wave is still running.
 */
import GUI from 'lil-gui';

export interface StructureSettings {
  nodes: number;
  seed: number;
  foldDepth: number;
  foldScale: number;
  shell: number;
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

export function createPanel(state: PanelState, handlers: PanelHandlers): GUI {
  const gui = new GUI({ title: 'neuroform' });
  gui.close();

  const structure = gui.addFolder('structure');
  const s = state.structure;
  structure.add(s, 'nodes', 2000, 200000, 1000);
  structure.add(s, 'seed', 1, 999, 1);
  structure.add(s, 'foldDepth', 0, 0.08, 0.001).name('fold depth');
  structure.add(s, 'foldScale', 2, 16, 0.1).name('fold scale');
  structure.add(s, 'shell', 0.02, 0.14, 0.002).name('shell');
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
  look.add(l, 'autoRotate').name('drift');
  look.add(l, 'restFps', 0, 60, 1).name('resting fps (0 = off)');
  look.onChange(() => handlers.onLookChange());

  gui.add({ fire: () => handlers.onStimulate() }, 'fire').name('fire a node');
  gui.add({ reset: () => handlers.onReset() }, 'reset').name('quiet the network');

  return gui;
}
