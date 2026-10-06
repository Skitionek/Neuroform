/**
 * Measures how long render passes take on the GPU.
 *
 * Uses EXT_disjoint_timer_query_webgl2 where available: queries are queued
 * around each labelled section and read back a few frames later, without
 * stalling anything. Where the extension is missing (many mobile GPUs, some
 * browsers, software renderers), `finish` mode instead brackets each section
 * with gl.finish() and wall-clock time. That stalls the pipeline and inflates
 * the total, but still ranks sections against each other.
 *
 * Sections must not nest: WebGL allows one timer query at a time.
 */

export type TimerMode = 'query' | 'finish' | 'off';

interface TimerQueryExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

export class GpuTimer {
  readonly mode: TimerMode;
  /** Smoothed milliseconds per section, in first-seen order. */
  readonly ms = new Map<string, number>();

  private gl: WebGL2RenderingContext;
  private ext: TimerQueryExt | null = null;
  private pending: { label: string; query: WebGLQuery }[] = [];
  private open: { label: string; query: WebGLQuery | null; start: number } | null = null;

  constructor(gl: WebGL2RenderingContext, requested: TimerMode) {
    this.gl = gl;
    if (requested === 'query') {
      this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerQueryExt | null;
      this.mode = this.ext ? 'query' : 'off';
    } else {
      this.mode = requested;
    }
  }

  get enabled(): boolean {
    return this.mode !== 'off';
  }

  begin(label: string): void {
    if (this.mode === 'off' || this.open) return;
    const { gl } = this;
    if (this.mode === 'query') {
      const query = gl.createQuery();
      if (!query) return;
      gl.beginQuery(this.ext!.TIME_ELAPSED_EXT, query);
      this.open = { label, query, start: 0 };
    } else {
      gl.finish();
      this.open = { label, query: null, start: performance.now() };
    }
  }

  end(): void {
    const open = this.open;
    if (!open) return;
    this.open = null;
    if (this.mode === 'query') {
      this.gl.endQuery(this.ext!.TIME_ELAPSED_EXT);
      this.pending.push({ label: open.label, query: open.query! });
    } else {
      this.gl.finish();
      this.record(open.label, performance.now() - open.start);
    }
  }

  /** Collects finished queries. Call once per frame. */
  poll(): void {
    if (this.mode !== 'query' || this.pending.length === 0) return;
    const { gl } = this;
    // A disjoint event (e.g. a GPU frequency change) invalidates in-flight
    // results; drop them rather than report garbage.
    const disjoint = gl.getParameter(this.ext!.GPU_DISJOINT_EXT);
    let done = 0;
    for (const { label, query } of this.pending) {
      if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) break;
      if (!disjoint) this.record(label, gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(query);
      done++;
    }
    this.pending.splice(0, done);
    // Never let a stalled query queue grow without bound.
    if (this.pending.length > 256) {
      for (const { query } of this.pending.splice(0, this.pending.length - 256)) gl.deleteQuery(query);
    }
  }

  /** Forgets all timings, e.g. after changing what is being measured. */
  reset(): void {
    this.ms.clear();
    for (const { query } of this.pending) this.gl.deleteQuery(query);
    this.pending.length = 0;
  }

  private record(label: string, ms: number): void {
    const prev = this.ms.get(label);
    this.ms.set(label, prev === undefined ? ms : prev + (ms - prev) * 0.1);
  }

  /** One-line summary for the readout. */
  summary(): string {
    if (this.mode === 'off') return 'gpu timer unavailable here; try ?gpu=finish';
    if (this.ms.size === 0) return 'gpu timing…';
    let total = 0;
    for (const v of this.ms.values()) total += v;
    const parts = [...this.ms].map(([label, v]) => `${label} ${v.toFixed(2)}`);
    return `gpu${this.mode === 'finish' ? ' (finish, approx)' : ''} ${total.toFixed(2)} ms · ${parts.join(' · ')}`;
  }
}
