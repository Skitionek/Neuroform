# TODO

## Measure: single-channel cell density
Question: does dropping colours improve performance? Per-vertex colour is
almost free; cost is fill rate and overdraw. The exception is the cells'
density buffer, RGBA half-float, written with additive blending every frame
and the costliest pass. A single-channel buffer moves a quarter of the
bytes. Measure the gain against losing the cells' region tint and glow
colour; they could be looked up per node instead of carried per pixel.

## Done
- Pull request previews on GitHub Pages, at `/pr/<number>/`, linked from the
  pull request (`.github/workflows/pages.yml`). They start once the workflow
  is on the default branch.
- README renders in light and dark pairs that follow the reader's GitHub
  theme.
- Packaged as a web component, `<neuro-form>`, installable from GitHub
  (`npm install github:Skitionek/Neuroform`), MIT licensed. The site is one
  of those elements.
- Placeholder images: `captureFirstRender()`, `snapshot()` and
  `saveSnapshot()` in the browser, `npx neuroform-snapshot` from the command
  line, and a `placeholder` attribute that shows the image until the first
  frame.
- Zoom-based goo: zoomed out, the cells merge into one uniform brain mass and
  dots and synapses fade into it; zoomed in, it resolves into neurons
  (`merge`).
- Brain shape: `scan` (MNI ICBM152, 77 kB half grid at 2 mm) is the default;
  `anatomical` and `classic` stay selectable. If the grid cannot load, the
  app falls back to `anatomical`.
- Dark and light themes, a background setting and a transparent mode: one
  ThemePass composites the light the scene draws onto the ground (added on
  dark, as ink on light, with alpha when transparent).
