/**
 * Curated combinations of settings. A preset lists only what it changes:
 * picking one resets everything else to the defaults first, so presets do
 * not leak into each other. `?preset=name` picks one in a link; any other
 * setting in the same link applies on top of it.
 */
import type { LookSettings, SignalSettings, StructureSettings } from './panel';

export type PresetSettings = Partial<StructureSettings & SignalSettings & LookSettings>;

export interface Preset {
  /** One line for the panel's help and the README. */
  description: string;
  settings: PresetSettings;
}

export const PRESETS: Record<string, Preset> = {
  default: {
    description: 'The tuned look: a busy brain of 200,000 neurons, cells on, drifting.',
    settings: {},
  },
  calm: {
    description: 'Slow, sparse waves with long afterglow and little idle noise.',
    settings: {
      speed: 0.28,
      glow: 1.8,
      spontaneous: 0.5,
      shimmer: 90,
      pulseIntensity: 1.5,
      cometLength: 0.09,
      bloom: 0.6,
    },
  },
  storm: {
    description: 'Everything fires: reliable synapses, low threshold, waves that sweep the whole brain.',
    settings: {
      threshold: 0.42,
      gain: 0.7,
      reliability: 0.5,
      speed: 0.8,
      refractory: 0.6,
      range: 3.2,
      spontaneous: 3.5,
      shimmer: 420,
      bloom: 0.4,
      pulseIntensity: 1.1,
    },
  },
  paper: {
    description: 'Light theme: activity drawn as ink on warm paper.',
    settings: {
      theme: 'light',
      background: '#f3f1ec',
      brainColor: '#5465c4',
      bloom: 0.3,
      depth: 0.6,
      spontaneous: 1.5,
    },
  },
  wiring: {
    description: 'The connectome: no cells, brighter synapses and long signal trails.',
    settings: {
      neurons: false,
      edgeOpacity: 0.16,
      pointSize: 4.4,
      pulseIntensity: 2.2,
      cometLength: 0.13,
      bloom: 0.55,
      depth: 0.6,
    },
  },
  cells: {
    description: 'Every neuron a cell, larger and looser, in violet: the gooey, organic look.',
    settings: {
      cellDensity: 1,
      cellSize: 0.0045,
      cellZoom: 0.7,
      pointSize: 3.6,
      brainColor: '#6b4f9a',
      bloom: 0.5,
    },
  },
  ember: {
    description: 'Warm tissue on a near-black ground, with the cool signal for contrast.',
    settings: {
      brainColor: '#a8552f',
      background: '#0a0605',
      edgeOpacity: 0.04,
      bloom: 0.55,
      depth: 0.75,
    },
  },
  afterglow: {
    description: 'A near-black brain on black, revealed only by constant chatter and its long afterglow.',
    settings: {
      brainColor: '#0c0e18',
      background: '#000000',
      // Sparkle everywhere draws the outline; chatter adds small bursts,
      // kept local by unreliable synapses and a higher threshold.
      shimmer: 2500,
      spontaneous: 5,
      reliability: 0.35,
      threshold: 0.46,
      glow: 2.6,
      pointSize: 6,
      edgeOpacity: 0.012,
      pulseIntensity: 1.3,
      bloom: 0.5,
      depth: 0.4,
    },
  },
  lite: {
    description: 'For laptops and phones: 40,000 neurons and fewer cells, same character.',
    settings: {
      nodes: 40000,
      cellDensity: 0.25,
      restFps: 20,
      bloom: 0.4,
    },
  },
};

export const PRESET_NAMES = Object.keys(PRESETS);
