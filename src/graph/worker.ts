/**
 * Builds networks off the main thread, so generating or parsing a large one
 * never freezes the animation. The result's typed arrays are transferred,
 * not copied.
 */
import { buildGraph, transferablesOf, type GraphRequest } from './request';

interface WorkerScope {
  onmessage: ((event: MessageEvent<{ id: number; request: GraphRequest }>) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = async (event) => {
  const { id, request } = event.data;
  try {
    const graph = await buildGraph(request);
    scope.postMessage({ id, graph }, transferablesOf(graph));
  } catch (error) {
    scope.postMessage({ id, error: (error as Error).message }, []);
  }
};
