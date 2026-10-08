/**
 * `<neuro-form>`: the piece as an HTML element.
 *
 *   <neuro-form preset="storm" bloom="0.8" panel></neuro-form>
 *
 * Every setting is an attribute, in kebab case (`brain-color`, `point-size`,
 * `auto-rotate="false"`), applied on top of `preset`. Changing one changes
 * the brain live; structure settings rebuild it. The element sizes like a
 * block (full width, 16:10) unless given a size of its own.
 *
 * Other attributes:
 * - `panel`: show the control panel in the element's corner;
 * - `placeholder`: an image shown until the first frame is drawn (make one
 *   with `captureFirstRender()` or `npx neuroform-snapshot`);
 * - `keyboard`: where `space` (fire) and `r` (quiet) are heard: `element`
 *   (default, once focused), `window`, or `none`;
 * - `dataset`: a network to load (JSON) instead of generating one;
 * - `scan-url`: where the scan brain's grid is, if not next to the code;
 * - `preserve-drawing-buffer`, `gpu-timer` (`query` or `finish`),
 *   `cell-resolution`: for tooling and measuring.
 *
 * Events (the engine's, re-sent from the element): `ready`, `firstrender`,
 * `stats`, `change`, `error`. Methods: `set`, `loadPreset`, `stimulate`,
 * `reset`, `snapshot`, `captureFirstRender`, `saveSnapshot`. `neuroform` is
 * the engine itself.
 */
import { Neuroform, type NeuroformOptions, type SnapshotOptions } from './engine';
import type { TimerMode } from './render/gpu-timer';
import { THEME_BACKGROUND, THEME_BRAIN } from './render/theme-pass';
import { parseSetting, presetSettings, SETTING_NAMES, type NeuroformSettings } from './settings';
import { ELEMENT_CSS } from './element-css';

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** Attribute name for each setting. */
const SETTING_ATTRIBUTES = new Map(SETTING_NAMES.map((key) => [kebab(key), key]));

/** Attributes that only take effect on a fresh engine. */
const OPTION_ATTRIBUTES = [
  'panel',
  'dataset',
  'scan-url',
  'keyboard',
  'preserve-drawing-buffer',
  'gpu-timer',
  'cell-resolution',
];

const ENGINE_EVENTS = ['ready', 'firstrender', 'stats', 'change', 'error'];

/** Roots (the document, or shadow roots) that already have the styles. */
const styled = new WeakSet<Document | ShadowRoot>();

function addStyles(root: Node): void {
  const target = root instanceof ShadowRoot ? root : document;
  if (styled.has(target)) return;
  styled.add(target);
  const style = document.createElement('style');
  style.dataset.neuroform = '';
  style.textContent = ELEMENT_CSS;
  if (target instanceof ShadowRoot) target.prepend(style);
  else document.head.prepend(style);
}

export class NeuroformElement extends HTMLElement {
  static readonly observedAttributes = ['preset', 'placeholder', ...OPTION_ATTRIBUTES, ...SETTING_ATTRIBUTES.keys()];

  /** The engine drawing this element, while it is in the document. */
  neuroform: Neuroform | null = null;

  private canvas: HTMLCanvasElement | null = null;
  private visibility: IntersectionObserver | null = null;
  private pendingDisconnect = false;
  /** Waiting for an engine: callers that came before the element was connected. */
  private engineWaiters: ((engine: Neuroform) => void)[] = [];

  connectedCallback(): void {
    // Moved within the page: keep running.
    if (this.pendingDisconnect) {
      this.pendingDisconnect = false;
      return;
    }
    addStyles(this.getRootNode());
    if (!this.hasAttribute('tabindex')) this.tabIndex = 0;
    this.start();
  }

  disconnectedCallback(): void {
    // Wait a moment: an element moved elsewhere is reconnected at once.
    this.pendingDisconnect = true;
    queueMicrotask(() => {
      if (!this.pendingDisconnect) return;
      this.pendingDisconnect = false;
      this.stop();
    });
  }

  attributeChangedCallback(name: string, before: string | null, after: string | null): void {
    if (before === after) return;
    if (name === 'placeholder') {
      this.showPlaceholder();
      return;
    }
    const engine = this.neuroform;
    if (!engine) return;
    if (name === 'preset') {
      engine.set(this.attributeSettings());
    } else if (OPTION_ATTRIBUTES.includes(name)) {
      // `dataset` and `scan-url` change the network; the rest keep it.
      const keepGraph = name !== 'dataset' && name !== 'scan-url';
      this.restart({ graph: keepGraph ? engine.graph : undefined });
    } else {
      const key = SETTING_ATTRIBUTES.get(name)!;
      const value = after === null ? presetSettings(this.preset)[key] : parseSetting(key, after);
      if (value === undefined) return;
      const changes: Record<string, unknown> = { [key]: value };
      // A theme without colours of its own brings the theme's.
      if (key === 'theme') {
        const theme = value === 'light' ? 'light' : 'dark';
        if (!this.hasAttribute('background')) changes.background = THEME_BACKGROUND[theme];
        if (!this.hasAttribute('brain-color')) changes.brainColor = THEME_BRAIN[theme];
      }
      engine.set(changes as Partial<NeuroformSettings>);
    }
  }

  /* ------------------------------------------------------------ properties */

  get preset(): string | null {
    return this.getAttribute('preset');
  }

  set preset(name: string | null) {
    if (name === null) this.removeAttribute('preset');
    else this.setAttribute('preset', name);
  }

  /** The current settings, as one flat record (a copy). */
  get settings(): NeuroformSettings | null {
    return this.neuroform?.settings ?? null;
  }

  /** Resolves once the first frame is on the canvas. */
  get firstRender(): Promise<void> {
    return this.engine().then((engine) => engine.firstRender);
  }

  /* ---------------------------------------------------------------- methods */

  /** Changes settings live, e.g. `set({ bloom: 1, theme: 'light' })`. Attributes are left as they are. */
  set(changes: Partial<NeuroformSettings>): void {
    this.neuroform?.set(changes);
  }

  /** Resets every setting to the default, then applies a preset's own. */
  loadPreset(name: string): void {
    this.neuroform?.loadPreset(name);
  }

  /** Fires a node, a random one by default. */
  stimulate(node?: number): void {
    this.neuroform?.stimulate(node);
  }

  /** Stops every signal. */
  reset(): void {
    this.neuroform?.reset();
  }

  /** Draws a frame now and returns it as an image (see SnapshotOptions). */
  async snapshot(options?: SnapshotOptions): Promise<Blob> {
    return (await this.engine()).snapshot(options);
  }

  /**
   * The first frame drawn, as an image: a seamless `placeholder`. Call it
   * before the element is drawn (right after adding it); later, it draws a
   * new frame instead.
   */
  async captureFirstRender(options?: SnapshotOptions): Promise<Blob> {
    return (await this.engine()).captureFirstRender(options);
  }

  /**
   * Downloads a snapshot: `saveSnapshot('placeholder.jpg', { type: 'image/jpeg' })`.
   * The type follows the file's extension when not given.
   */
  async saveSnapshot(filename = 'neuroform.png', options: SnapshotOptions = {}): Promise<void> {
    const extension = filename.split('.').pop()?.toLowerCase();
    const type = options.type ?? (extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : extension === 'webp' ? 'image/webp' : 'image/png');
    const blob = await this.snapshot({ ...options, type });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  /* ---------------------------------------------------------------- engine */

  /** The engine, once the element is in the document. */
  private engine(): Promise<Neuroform> {
    if (this.neuroform) return Promise.resolve(this.neuroform);
    return new Promise((resolve) => this.engineWaiters.push(resolve));
  }

  /** Settings from the preset and the setting attributes. */
  private attributeSettings(): Partial<NeuroformSettings> {
    const settings: Record<string, unknown> = { ...presetSettings(this.preset) };
    for (const [attribute, key] of SETTING_ATTRIBUTES) {
      const raw = this.getAttribute(attribute);
      if (raw === null) continue;
      const value = parseSetting(key, raw);
      if (value !== undefined) settings[key] = value;
    }
    // A theme without colours of its own brings the theme's.
    const theme = this.getAttribute('theme');
    if (theme !== null) {
      const t = theme === 'light' ? 'light' : 'dark';
      if (!this.hasAttribute('background')) settings.background = THEME_BACKGROUND[t];
      if (!this.hasAttribute('brain-color')) settings.brainColor = THEME_BRAIN[t];
    }
    return settings as Partial<NeuroformSettings>;
  }

  private start(overrides: Partial<NeuroformOptions> = {}): void {
    const canvas = (this.canvas = document.createElement('canvas'));
    canvas.className = 'neuroform-canvas';
    this.prepend(canvas);
    this.showPlaceholder();

    const keyboard = this.getAttribute('keyboard') ?? 'element';
    const number = (name: string) => {
      const value = Number(this.getAttribute(name));
      return Number.isFinite(value) && value > 0 ? value : undefined;
    };
    const gpu = this.getAttribute('gpu-timer');
    const engine = (this.neuroform = new Neuroform({
      canvas,
      preset: this.preset ?? undefined,
      settings: this.attributeSettings(),
      dataset: this.getAttribute('dataset') ?? undefined,
      scanUrl: this.getAttribute('scan-url') ?? undefined,
      panel: this.hasAttribute('panel') ? this : false,
      keyboardTarget: keyboard === 'window' ? window : keyboard === 'none' ? null : this,
      preserveDrawingBuffer: this.hasAttribute('preserve-drawing-buffer'),
      gpuTimer: (gpu === 'finish' ? 'finish' : gpu !== null ? 'query' : 'off') as TimerMode,
      cellResolution: number('cell-resolution'),
      ...overrides,
    }));
    this.engineWaiters.forEach((resolve) => resolve(engine));
    this.engineWaiters = [];

    for (const type of ENGINE_EVENTS) {
      engine.addEventListener(type, (event) => {
        if (engine !== this.neuroform) return;
        this.dispatchEvent(new CustomEvent(type, { detail: (event as CustomEvent).detail }));
      });
    }
    engine.addEventListener('change', () => this.reflectLook());
    engine.addEventListener('firstrender', () => {
      canvas.classList.add('drawn');
      this.style.removeProperty('--neuroform-placeholder');
    });
    // The canvas only has an alpha channel if made with one: start again
    // with one, keeping the network and the settings.
    engine.addEventListener('needsalpha', () => {
      if (engine !== this.neuroform) return;
      queueMicrotask(() => this.restart({ alpha: true, graph: engine.graph }));
    });
    canvas.addEventListener('pointerdown', () => {
      if (keyboard === 'element') this.focus({ preventScroll: true });
    });
    this.reflectLook();

    // Nothing to draw while off screen.
    this.visibility = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) engine.resume();
      else engine.pause();
    });
    this.visibility.observe(this);
  }

  private stop(): void {
    this.visibility?.disconnect();
    this.visibility = null;
    this.neuroform?.dispose();
    this.neuroform = null;
    this.canvas?.remove();
    this.canvas = null;
  }

  /** Starts a fresh engine with the current settings. */
  private restart(overrides: Partial<NeuroformOptions>): void {
    const settings = this.neuroform?.settings;
    this.stop();
    this.start({ settings, ...overrides });
  }

  /** The element's own background and theme follow the look. */
  private reflectLook(): void {
    const look = this.neuroform?.state.look;
    if (!look) return;
    this.dataset.theme = look.theme;
    this.style.setProperty('--neuroform-background', look.transparent ? 'transparent' : look.background);
  }

  private showPlaceholder(): void {
    const url = this.getAttribute('placeholder');
    if (url && !this.canvas?.classList.contains('drawn')) {
      this.style.setProperty('--neuroform-placeholder', `url(${JSON.stringify(new URL(url, document.baseURI).href)})`);
    } else {
      this.style.removeProperty('--neuroform-placeholder');
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'neuro-form': NeuroformElement;
  }
}
