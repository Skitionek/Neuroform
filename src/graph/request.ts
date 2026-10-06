/**
 * A serialisable description of which network to build, so the work can be
 * shipped to a worker, plus the main-thread client that does the shipping.
 */
import { graphFromDataset, proceduralBrain, type GraphDataset, type ProceduralOptions } from './sources';
import type { NetworkGraph } from './types';

export type GraphRequest =
  | { kind: 'procedural'; options: ProceduralOptions }
  /** `url` must be absolute: a worker resolves relative URLs against itself. */
  | { kind: 'dataset'; url: string };

/** Runs a request to completion on whatever thread calls it. */
export async function buildGraph(request: GraphRequest): Promise<NetworkGraph> {
  if (request.kind === 'procedural') return proceduralBrain(request.options).load();

  const response = await fetch(request.url);
  if (!response.ok) throw new Error(`cannot load ${request.url}: ${response.status}`);
  // A dev server answers an unknown path with index.html, so a typo in the
  // filename otherwise surfaces as a baffling JSON parse error.
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('json')) {
    throw new Error(`${request.url} is not JSON (got ${type.split(';')[0] || 'no content type'})`);
  }
  return graphFromDataset((await response.json()) as GraphDataset);
}

/** Every distinct buffer behind the graph's arrays, for a zero-copy transfer. */
export function transferablesOf(graph: NetworkGraph): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  for (const value of Object.values(graph)) {
    if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer) buffers.add(value.buffer);
  }
  return [...buffers];
}

/**
 * Builds graphs on a worker. Only the latest request matters: starting a new
 * one terminates whatever the worker was still doing, rather than letting a
 * stale build finish first. Falls back to the main thread if workers are
 * unavailable.
 */
export class GraphBuilder {
  private worker: Worker | null = null;
  /** Set once a worker has failed outright; build on the main thread after. */
  private workersBroken = false;
  private nextId = 0;
  private pending: { id: number; reject: (error: Error) => void } | null = null;

  build(request: GraphRequest): Promise<NetworkGraph> {
    if (this.pending) {
      // Abandon the stale build outright; its worker may be deep in a loop.
      this.worker?.terminate();
      this.worker = null;
      this.pending.reject(new SupersededError());
      this.pending = null;
    }

    const worker = this.ensureWorker();
    if (!worker) return buildGraph(request);

    const id = ++this.nextId;
    return new Promise<NetworkGraph>((resolve, reject) => {
      this.pending = { id, reject };
      worker.onmessage = (event: MessageEvent<{ id: number; graph?: NetworkGraph; error?: string }>) => {
        if (event.data.id !== id) return;
        this.pending = null;
        if (event.data.error !== undefined) reject(new Error(event.data.error));
        else resolve(event.data.graph!);
      };
      // Errors inside a build are posted back as messages, so an error event
      // means the worker itself is unusable (it failed to load, say, under a
      // strict content security policy). Finish this build on the main thread
      // and stop trying workers.
      worker.onerror = (event) => {
        event.preventDefault();
        if (this.pending?.id !== id) return;
        this.pending = null;
        this.worker?.terminate();
        this.worker = null;
        this.workersBroken = true;
        buildGraph(request).then(resolve, reject);
      };
      worker.postMessage({ id, request });
    });
  }

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    if (this.workersBroken || typeof Worker === 'undefined') return null;
    try {
      this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    } catch {
      return null;
    }
    return this.worker;
  }
}

/** The build was replaced by a newer one; not a failure worth reporting. */
export class SupersededError extends Error {
  constructor() {
    super('superseded by a newer build');
    this.name = 'SupersededError';
  }
}
