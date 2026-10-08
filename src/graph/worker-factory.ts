/**
 * Starts the graph worker. The site loads it as its own file; the package
 * build swaps this module for worker-factory.inline.ts (see
 * vite.lib.config.ts), which carries the worker inside the bundle.
 */
export function createGraphWorker(): Worker {
  return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
}
