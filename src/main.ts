/**
 * The site: one full-window `<neuro-form>` with the panel, a masthead and a
 * readout. Any setting is also a URL parameter, so a particular brain is a
 * link: `?preset=storm&bloom=1.2&seed=42`.
 *
 * Other parameters: `dataset=my-graph.json` loads a network from data,
 * `gpu=1` (or `gpu=finish`) times each render pass and shows it under the
 * readout, `capture=1` keeps the drawing buffer for reading the canvas back,
 * `cellRes=1` pins the cells' density buffer to full resolution.
 */
import type { Neuroform, NeuroformStats } from './index';

const element = document.querySelector('neuro-form')!;
const readout = document.querySelector<HTMLElement>('#readout-text')!;
const gpuReadout = document.querySelector<HTMLElement>('#gpu-text')!;
const params = new URLSearchParams(window.location.search);

// URL parameters become attributes before the element is defined, so it
// starts with them rather than building the default brain first. Settings
// keep their names, in kebab case; unknown ones do nothing.
const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const renamed: Record<string, string> = { gpu: 'gpu-timer', cellRes: 'cell-resolution' };
params.forEach((value, param) => {
  if (param === 'capture') {
    if (value === '1') element.setAttribute('preserve-drawing-buffer', '');
  } else if (/^[a-zA-Z]+$/.test(param)) {
    element.setAttribute(renamed[param] ?? kebab(param), value);
  }
});
await import('./index');

/** The page follows the brain's theme and background. */
element.addEventListener('change', () => syncPage());
function syncPage(): void {
  const look = element.neuroform?.state.look;
  if (!look) return;
  const root = document.documentElement;
  root.dataset.theme = look.theme;
  root.style.setProperty('--void', look.transparent ? 'transparent' : look.background);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', look.background);
}
syncPage();

readout.textContent = 'growing network…';
element.addEventListener('error', (event) => {
  readout.textContent = `could not build network: ${((event as unknown as CustomEvent<Error>).detail).message}`;
});
element.addEventListener('stats', (event) => {
  const stats = (event as CustomEvent<NeuroformStats>).detail;
  if (stats.gpu) gpuReadout.textContent = stats.gpu;
  readout.textContent = [
    `${stats.nodes.toLocaleString()} nodes`,
    `${stats.synapses.toLocaleString()} synapses`,
    `${stats.inFlight.toLocaleString()} in flight`,
    `${stats.firingsPerSecond.toFixed(0)} firings/s`,
    `${stats.fps.toFixed(0)} fps`,
    stats.building
      ? 'growing a new network…'
      : stats.hovered >= 0
        ? `node ${stats.hovered}`
        : 'click a node · space fires one · r quiets',
  ].join('   ·   ');
});

/**
 * The engine, from the console or a page script: `neuroform.stimulate()`,
 * `neuroform.set({ bloom: 1 })`, `neuroform.sim`, `neuroform.gpuTimings()`.
 */
declare global {
  interface Window {
    neuroform: Neuroform;
  }
}
Object.defineProperty(window, 'neuroform', { get: () => element.neuroform, configurable: true });
