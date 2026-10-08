/**
 * Every setting, its default, and the rules for changing them: presets,
 * themes, and values given as text (URL parameters, element attributes).
 * Settings are grouped by what changing them costs: structure rebuilds the
 * network, signal and look are live.
 */
import { DEFAULT_PARAMS } from './sim/network';
import { THEME_BACKGROUND, THEME_BRAIN } from './render/theme-pass';
import type { LookSettings, PanelState, SignalSettings, StructureSettings } from './ui/panel';
import { PRESETS } from './ui/presets';

/** All settings in one flat record; no name appears in two groups. */
export type NeuroformSettings = StructureSettings & SignalSettings & LookSettings;

export type SettingGroup = keyof PanelState;

/** The settings as shipped, before any preset changes them. */
export function defaultState(): PanelState {
  return {
    structure: {
      nodes: 200000,
      shape: 'scan',
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
      restFps: 24,
      neurons: true,
      // Small blobs on every node; the merge is depth-aware, so only nodes
      // that are actually close fuse.
      cellDensity: 0.38,
      cellSize: 0.003,
      cellZoom: 1,
      depth: 0.7,
      theme: 'dark',
      background: THEME_BACKGROUND.dark,
      brainColor: THEME_BRAIN.dark,
      transparent: false,
      merge: 1,
      fov: 55,
    },
  };
}

const DEFAULTS = defaultState();

/** Which group each setting belongs to. */
export const SETTING_GROUP: Readonly<Record<keyof NeuroformSettings, SettingGroup>> = Object.fromEntries(
  (Object.keys(DEFAULTS) as SettingGroup[]).flatMap((group) => Object.keys(DEFAULTS[group]).map((key) => [key, group])),
) as Record<keyof NeuroformSettings, SettingGroup>;

export const SETTING_NAMES = Object.keys(SETTING_GROUP) as (keyof NeuroformSettings)[];

/** The settings as one flat record (a copy). */
export function flatten(state: PanelState): NeuroformSettings {
  return { ...state.structure, ...state.signal, ...state.look };
}

/**
 * Reads a setting given as text, typed after its default: numbers, booleans
 * (`0`, `false` and `off` are false, anything else true, so a bare attribute
 * is true) and strings. Colours may leave out the `#`. Returns undefined for
 * unknown names and unreadable numbers.
 */
export function parseSetting(key: string, raw: string): unknown {
  const group = SETTING_GROUP[key as keyof NeuroformSettings];
  if (!group) return undefined;
  const fallback = (DEFAULTS[group] as unknown as Record<string, unknown>)[key];
  if (typeof fallback === 'boolean') return !/^(0|false|off|no)$/i.test(raw.trim());
  if (typeof fallback === 'number') {
    const value = Number(raw);
    return raw.trim() !== '' && Number.isFinite(value) ? value : undefined;
  }
  return /^[0-9a-f]{6}$/i.test(raw) ? `#${raw}` : raw;
}

/** Which groups a change touched. */
export type Changed = Record<SettingGroup, boolean>;

/**
 * Applies `changes` to `state`, ignoring unknown names and values of the wrong
 * type. Picking a theme brings its own background and brain colour unless the
 * same change gives them.
 */
export function applySettings(state: PanelState, changes: Partial<NeuroformSettings>): Changed {
  const changed: Changed = { structure: false, signal: false, look: false };
  const next: Record<string, unknown> = { ...changes };
  if (next.theme !== undefined && next.theme !== state.look.theme) {
    const theme = next.theme === 'light' ? 'light' : 'dark';
    next.background ??= THEME_BACKGROUND[theme];
    next.brainColor ??= THEME_BRAIN[theme];
  }
  for (const [key, raw] of Object.entries(next)) {
    const group = SETTING_GROUP[key as keyof NeuroformSettings];
    if (!group || raw === undefined) continue;
    const target = state[group] as unknown as Record<string, unknown>;
    let value: unknown = raw;
    if (typeof value === 'string' && typeof target[key] !== 'string') value = parseSetting(key, value);
    if (typeof value !== typeof target[key]) continue;
    if (typeof value === 'string' && /^[0-9a-f]{6}$/i.test(value)) value = `#${value}`;
    if (target[key] === value) continue;
    target[key] = value;
    changed[group] = true;
  }
  if (state.look.theme !== 'light') state.look.theme = 'dark';
  return changed;
}

/**
 * The settings of a preset: the defaults with the preset's own on top.
 * Unknown names give the defaults.
 */
export function presetSettings(name: string | null | undefined): NeuroformSettings {
  return { ...flatten(DEFAULTS), ...(name ? PRESETS[name]?.settings : undefined) };
}
