#!/usr/bin/env node
/**
 * Renders a <neuro-form> in a headless browser and saves its first frame:
 * a placeholder to show until the piece loads, or a still for a page's
 * preview card. Needs Playwright (npm i -D playwright, then
 * npx playwright install chromium).
 *
 *   npx neuroform-snapshot --out placeholder.jpg --width 1200 --height 630 --preset storm
 *
 * Options:
 *   --out FILE           where to write; .png, .jpg or .webp (neuroform.png)
 *   --width, --height    size in CSS pixels (1200 x 750)
 *   --pixel-ratio N      device pixels per CSS pixel (1)
 *   --quality Q          0 to 1, for .jpg and .webp (0.9)
 *   --dataset FILE       a network to load (JSON), a local path or a URL
 *   --gpu                use the machine's GPU instead of software rendering
 *   --timeout SECONDS    how long to wait for the first frame (300)
 * Every other --name value is an attribute of the element, so any setting
 * works: --preset paper --nodes 60000 --brain-color '#6b4f9a' --bloom 0.8.
 */
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OWN = new Set(['out', 'width', 'height', 'pixel-ratio', 'quality', 'dataset', 'gpu', 'timeout', 'help']);
const FLAGS = new Set(['gpu', 'help']);

function parseArgs(argv) {
  const options = {};
  const attributes = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    let [name, value] = arg.slice(2).split(/=(.*)/s);
    if (value === undefined && !FLAGS.has(name)) {
      const next = argv[i + 1];
      // A setting given bare (--panel) is a boolean attribute.
      if (next === undefined || next.startsWith('--')) value = '';
      else value = argv[++i];
    }
    (OWN.has(name) ? options : attributes)[name] = value ?? true;
  }
  return { options, attributes };
}

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    // Also found through NODE_PATH (a global install), which import() ignores.
    try {
      return createRequire(import.meta.url)('playwright');
    } catch {
      console.error('neuroform-snapshot needs Playwright: npm i -D playwright && npx playwright install chromium');
      process.exit(1);
    }
  }
}

const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

async function main() {
  const { options, attributes } = parseArgs(process.argv.slice(2));
  if (options.help) {
    const source = await readFile(fileURLToPath(import.meta.url), 'utf8');
    console.log(source.match(/\/\*\*([\s\S]*?)\*\//)[1].replace(/^ \* ?/gm, '').trim());
    return;
  }
  const out = resolve(options.out ?? 'neuroform.png');
  const type = TYPES[extname(out).toLowerCase()];
  if (!type) throw new Error(`unknown image type for ${out}: use .png, .jpg or .webp`);
  const width = Number(options.width ?? 1200);
  const height = Number(options.height ?? 750);
  const pixelRatio = Number(options['pixel-ratio'] ?? 1);
  const quality = Number(options.quality ?? 0.9);
  const timeout = Number(options.timeout ?? 300) * 1000;

  const bundle = await readFile(new URL('../dist-lib/neuroform.standalone.js', import.meta.url)).catch(() => {
    throw new Error('dist-lib/neuroform.standalone.js is missing: run npm run build:lib');
  });
  let dataset = null;
  if (typeof options.dataset === 'string') {
    if (/^https?:/.test(options.dataset)) attributes.dataset = options.dataset;
    else {
      dataset = await readFile(resolve(options.dataset));
      attributes.dataset = 'dataset.json';
    }
  }
  attributes.keyboard = 'none';

  const page = /* html */ `<!doctype html>
<meta charset="utf-8">
<style>html, body { margin: 0; background: transparent; }</style>
<script type="module">
  import './neuroform.js';
  const element = document.createElement('neuro-form');
  for (const [name, value] of Object.entries(${JSON.stringify(attributes)})) element.setAttribute(name, value);
  element.style.width = '${width}px';
  element.style.height = '${height}px';
  element.addEventListener('error', (event) => { window.snapshotError = String(event.detail?.message ?? event.detail); });
  document.body.append(element);
  // Asked for before anything is drawn, so this is the very first frame.
  element.captureFirstRender({ type: '${type}', quality: ${quality} }).then(
    (blob) => new Promise((done) => {
      const reader = new FileReader();
      reader.onload = () => done(reader.result);
      reader.readAsDataURL(blob);
    }),
  ).then((url) => { window.snapshot = url; }, (error) => { window.snapshotError = error.message; });
</script>`;

  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path === '/') response.writeHead(200, { 'content-type': 'text/html' }).end(page);
    else if (path === '/neuroform.js') response.writeHead(200, { 'content-type': 'text/javascript' }).end(bundle);
    else if (path === '/dataset.json' && dataset) response.writeHead(200, { 'content-type': 'application/json' }).end(dataset);
    else response.writeHead(404).end();
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();

  const { chromium } = await loadPlaywright();
  const args = options.gpu
    ? ['--enable-gpu', '--ignore-gpu-blocklist']
    : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  const browser = await chromium.launch({ args });
  try {
    const tab = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: pixelRatio });
    tab.on('pageerror', (error) => console.error('page error:', error.message));
    await tab.goto(`http://127.0.0.1:${port}/`);
    await tab.waitForFunction(() => window.snapshot || window.snapshotError, null, { timeout, polling: 250 });
    const { snapshot, snapshotError } = await tab.evaluate(() => ({ snapshot: window.snapshot, snapshotError: window.snapshotError }));
    if (snapshotError) throw new Error(snapshotError);
    await writeFile(out, Buffer.from(snapshot.split(',')[1], 'base64'));
    console.log(`wrote ${out} (${width}x${height} at ${pixelRatio}x)`);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
