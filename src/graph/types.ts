/**
 * The contract between "where the points and wires are" and everything that
 * draws or simulates them. A procedural brain is one implementation; a dataset
 * loader is another.
 */

export interface NetworkGraph {
  nodeCount: number;
  /** xyz triples, length = nodeCount * 3. */
  positions: Float32Array;
  /** Per-node outward normal, length = nodeCount * 3. Zeroes are fine. */
  normals: Float32Array;
  /** Per-node 0 = surface, 1 = deep. */
  depth: Float32Array;
  /** Per-node region/cluster id, used for colour. */
  region: Uint8Array;

  edgeCount: number;
  /** Node index pairs, length = edgeCount * 2. */
  edges: Uint32Array;
  /** Euclidean length per edge, length = edgeCount. */
  edgeLength: Float32Array;
  /** Transmission reliability per edge in (0, 1], length = edgeCount. */
  edgeWeight: Float32Array;

  /** CSR adjacency: edge indices for node i are in [offset[i], offset[i+1]). */
  adjOffset: Uint32Array;
  adjEdge: Uint32Array;
  /** The node at the far end of adjEdge[k], from node i's point of view. */
  adjPeer: Uint32Array;

  /** Radius of a sphere enclosing the cloud, for camera framing. */
  bounds: number;
}

export interface GraphSource {
  readonly id: string;
  readonly label: string;
  load(): Promise<NetworkGraph> | NetworkGraph;
}
