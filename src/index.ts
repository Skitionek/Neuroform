/**
 * The package: `import 'neuroform'` defines `<neuro-form>`; the engine,
 * settings and presets are exported for driving it from code.
 */
import { NeuroformElement } from './element';

export { Neuroform } from './engine';
export type { NeuroformOptions, NeuroformStats, SnapshotOptions } from './engine';
export { NeuroformElement } from './element';
export { defaultState, presetSettings, SETTING_NAMES } from './settings';
export type { NeuroformSettings } from './settings';
export { PRESETS, PRESET_NAMES } from './ui/presets';
export type { Preset } from './ui/presets';
export { THEME_BACKGROUND, THEME_BRAIN } from './render/theme-pass';
export type { Theme } from './render/theme-pass';
export type { NetworkGraph } from './graph/types';

/** Defines `<neuro-form>` (or another tag name); safe to call more than once. */
export function defineNeuroform(tag = 'neuro-form'): void {
  if (!customElements.get(tag)) customElements.define(tag, tag === 'neuro-form' ? NeuroformElement : class extends NeuroformElement {});
}

defineNeuroform();
