/**
 * The package's graph worker, inlined: a bundle that ends up anywhere (a
 * CDN, another bundler's node_modules cache) still finds it.
 */
import GraphWorker from './worker?worker&inline';

export function createGraphWorker(): Worker {
  return new GraphWorker();
}
