# Neuroform: notes for contributors

## Answer every question

When a message mixes questions with tasks, answer every question explicitly,
even the ones asked in passing. Open work lives in `TODO.md`; keep it current.

## Every PR needs before and after renders

Every pull request must include **before** and **after** renders of the
visualization, so a reviewer can see the change without running it. This
applies to changes that alter the look, and also to changes that should not:
there the matching renders are the evidence.

- Render the visualization only, without the UI. Hide the masthead, the
  readout and the panel: `.masthead, .readout, .lil-gui { display: none !important; }`.
- Take the before and after renders with the same camera, the same settings
  and the same waves. Disable randomness that is not part of the change
  (`?autoRotate=0&spontaneous=0&shimmer=0`). Then, in one `page.evaluate`,
  call `neuroform.reset()`, which also reseeds the simulation's random
  stream, stimulate fixed node ids, and replace `sim.step` with fixed 1/60 s
  steps that stop after a set number of frames:

  ```js
  const n = window.neuroform, sim = n.sim, step = sim.step.bind(sim);
  n.reset(); n.stimulate(9000); n.stimulate(26000);
  let frames = 0;
  sim.step = () => { if (frames < 48) { step(1 / 60); frames++; } };
  ```

  Wait a few frames after the freeze, then take the screenshot. Waves fade
  after about 1.5 s, so 30 to 60 frames is a good moment. Two runs of the
  same build should then match to within a few levels per pixel.
- Build the before render from the base branch (for example in a
  `git worktree`) and the after render from the PR head, served with
  `vite preview`.
- Put the images side by side in the PR description, labelled with what
  differs. When the PR is opened through the API, which can't upload
  attachments, commit the renders to the PR branch under
  `docs/renders/<branch>/` and link them with their
  `https://github.com/Skitionek/Neuroform/raw/<branch>/...` URLs.

## Commits

Commits are authored as Skitionek <skitionek@gmail.com>, with no
co-author or session trailers.
