/**
 * The element's styles, added once per document (or shadow root) that holds
 * one. Selectors are wrapped in :where() where they set defaults, so a page's
 * own rules win without a fight.
 */
export const ELEMENT_CSS = /* css */ `
:where(neuro-form) {
  display: block;
  position: relative;
  overflow: hidden;
  aspect-ratio: 16 / 10;
  background: var(--neuroform-placeholder, none) center / cover no-repeat, var(--neuroform-background, #04040a);
  --neuroform-ink: #e8ecff;
  --neuroform-ink-dim: #7b86b4;
  --neuroform-panel: rgba(10, 11, 22, 0.72);
  --neuroform-panel-solid: rgba(10, 11, 22, 0.94);
  --neuroform-panel-edge: rgba(255, 255, 255, 0.06);
  --neuroform-widget: rgba(255, 255, 255, 0.08);
  --neuroform-widget-hover: rgba(255, 255, 255, 0.12);
  --neuroform-widget-focus: rgba(255, 255, 255, 0.16);
  --neuroform-value: #2cc9ff;
}
:where(neuro-form[data-theme="light"]) {
  --neuroform-ink: #1b2140;
  --neuroform-ink-dim: #5d6690;
  --neuroform-panel: rgba(250, 249, 245, 0.8);
  --neuroform-panel-solid: rgba(250, 249, 245, 0.96);
  --neuroform-panel-edge: rgba(20, 24, 48, 0.08);
  --neuroform-widget: rgba(20, 24, 48, 0.07);
  --neuroform-widget-hover: rgba(20, 24, 48, 0.11);
  --neuroform-widget-focus: rgba(20, 24, 48, 0.15);
  --neuroform-value: #0b6f9e;
}
neuro-form:focus:not(:focus-visible) { outline: none; }

neuro-form > .neuroform-canvas {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
  touch-action: none;
  cursor: crosshair;
  /* Hidden until the first frame, so the placeholder shows until then. */
  opacity: 0;
  transition: opacity 0.35s ease-out;
}
neuro-form > .neuroform-canvas.drawn { opacity: 1; }

/* The control panel (lil-gui), dressed down to match. */
neuro-form > .lil-gui.root {
  position: absolute;
  top: 0;
  right: 15px;
  max-height: 100%;
  overflow-y: auto;
  z-index: 1;
}
neuro-form .lil-gui {
  --background-color: var(--neuroform-panel);
  --widget-color: var(--neuroform-widget);
  --focus-color: var(--neuroform-widget-focus);
  --hover-color: var(--neuroform-widget-hover);
  --text-color: var(--neuroform-ink);
  --title-text-color: var(--neuroform-ink);
  --number-color: var(--neuroform-value);
  --string-color: var(--neuroform-value);
  --title-background-color: var(--neuroform-widget);
  --font-family: ui-monospace, Menlo, monospace;
  --font-size: 10.5px;
  --widget-height: 18px;
  --name-width: 52%;
  backdrop-filter: blur(14px);
  border-left: 1px solid var(--neuroform-panel-edge);
}
/* What the option under the pointer does; pinned to the panel's bottom. */
neuro-form .panel-help {
  position: sticky;
  bottom: 0;
  padding: 8px var(--padding, 4px);
  min-height: 3.6em;
  font-size: 10px;
  line-height: 1.45;
  color: var(--neuroform-ink-dim);
  background: var(--neuroform-panel-solid);
  border-top: 1px solid var(--neuroform-panel-edge);
}
@media (max-width: 640px) {
  neuro-form > .lil-gui.root { width: 240px; }
}
`;
