/**
 * A uniform grid over a point cloud, built with a counting sort: two passes
 * over the points, no per-point allocation. Points in one cell are contiguous
 * in `items`, in ascending index order.
 */
export class UniformGrid {
  readonly cell: number;
  readonly min: [number, number, number];
  readonly dims: [number, number, number];
  /** Cell b holds items[start[b]] .. items[start[b + 1] - 1]. */
  readonly start: Uint32Array;
  readonly items: Uint32Array;

  constructor(positions: Float32Array, count: number, cell: number) {
    this.cell = cell;
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < count; i++) {
      for (let a = 0; a < 3; a++) {
        const v = positions[i * 3 + a];
        if (v < min[a]) min[a] = v;
        if (v > max[a]) max[a] = v;
      }
    }
    if (count === 0) min.fill(0);
    this.min = min;
    this.dims = [1, 1, 1];
    for (let a = 0; a < 3; a++) {
      this.dims[a] = Math.max(1, Math.floor((max[a] - min[a]) / cell) + 1);
    }

    const buckets = this.dims[0] * this.dims[1] * this.dims[2];
    const start = new Uint32Array(buckets + 1);
    const keys = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      const k = this.cellOf(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      keys[i] = k;
      start[k + 1]++;
    }
    for (let b = 0; b < buckets; b++) start[b + 1] += start[b];
    const items = new Uint32Array(count);
    const cursor = start.slice(0, buckets);
    for (let i = 0; i < count; i++) items[cursor[keys[i]]++] = i;

    this.start = start;
    this.items = items;
  }

  /** Cell coordinate along one axis, clamped into the grid. */
  coord(v: number, axis: 0 | 1 | 2): number {
    const c = Math.floor((v - this.min[axis]) / this.cell);
    return c < 0 ? 0 : c >= this.dims[axis] ? this.dims[axis] - 1 : c;
  }

  cellOf(x: number, y: number, z: number): number {
    return this.coord(x, 0) + this.dims[0] * (this.coord(y, 1) + this.dims[1] * this.coord(z, 2));
  }

  /** Cell size that puts roughly `perCell` points in an average occupied cell. */
  static cellFor(positions: Float32Array, count: number, perCell: number): number {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < count; i++) {
      for (let a = 0; a < 3; a++) {
        const v = positions[i * 3 + a];
        if (v < min[a]) min[a] = v;
        if (v > max[a]) max[a] = v;
      }
    }
    const volume = Math.max(1e-9, (max[0] - min[0]) * (max[1] - min[1]) * (max[2] - min[2]));
    return Math.cbrt((volume * perCell) / Math.max(1, count));
  }
}

/**
 * Exact k-nearest-neighbour queries on a grid, by expanding rings of cells.
 *
 * Cost depends on k, not on how many points lie within the search radius, so
 * it stays flat as the cloud gets denser. The previous approach gathered every
 * point within reach and sorted them all, which grows linearly with density
 * and made wiring quadratic in node count.
 */
export class NearestFinder {
  private grid: UniformGrid;
  private positions: Float32Array;
  // Max-heap of the best k so far, keyed by (distance², index).
  private heapIdx = new Int32Array(0);
  private heapD2 = new Float64Array(0);
  private size = 0;
  /** Results of the last query, nearest first. */
  idx = new Int32Array(0);
  d2 = new Float64Array(0);

  constructor(grid: UniformGrid, positions: Float32Array) {
    this.grid = grid;
    this.positions = positions;
  }

  /**
   * Finds up to `k` nearest points to node `self` within `radius`, excluding
   * `self`, ordered by distance then index. Returns how many were found.
   * Distances are computed exactly as `positions[j] - positions[self]` in
   * doubles, so callers can rely on the ordering matching a brute-force sort.
   */
  query(self: number, k: number, radius: number): number {
    if (this.heapIdx.length < k) {
      this.heapIdx = new Int32Array(k);
      this.heapD2 = new Float64Array(k);
      this.idx = new Int32Array(k);
      this.d2 = new Float64Array(k);
    }
    this.size = 0;

    const { grid, positions } = this;
    const x = positions[self * 3], y = positions[self * 3 + 1], z = positions[self * 3 + 2];
    const cx = grid.coord(x, 0), cy = grid.coord(y, 1), cz = grid.coord(z, 2);
    const [dx, dy, dz] = grid.dims;
    const r2 = radius * radius;
    const maxRing = Math.max(dx, dy, dz);

    for (let ring = 0; ring <= maxRing; ring++) {
      for (let kz = cz - ring; kz <= cz + ring; kz++) {
        if (kz < 0 || kz >= dz) continue;
        const onZ = kz === cz - ring || kz === cz + ring;
        for (let ky = cy - ring; ky <= cy + ring; ky++) {
          if (ky < 0 || ky >= dy) continue;
          const onY = onZ || ky === cy - ring || ky === cy + ring;
          // Only the shell of the ring: interior cells were visited already.
          const step = onY ? 1 : 2 * ring;
          for (let kx = cx - ring; kx <= cx + ring; kx += step || 1) {
            if (kx < 0 || kx >= dx) continue;
            const b = kx + dx * (ky + dy * kz);
            for (let s = grid.start[b], e = grid.start[b + 1]; s < e; s++) {
              const j = grid.items[s];
              if (j === self) continue;
              const ex = positions[j * 3] - x;
              const ey = positions[j * 3 + 1] - y;
              const ez = positions[j * 3 + 2] - z;
              const d2 = ex * ex + ey * ey + ez * ez;
              if (d2 > r2) continue;
              this.offer(j, d2, k);
            }
          }
        }
      }
      // Everything within ring * cell of the query is now known. Stop once
      // that covers either the search radius or the k-th best distance.
      const covered = ring * grid.cell;
      if (covered >= radius) break;
      if (this.size === k && this.heapD2[0] <= covered * covered) break;
    }

    // Heap to ascending order.
    const n = this.size;
    for (let i = n - 1; i >= 0; i--) {
      this.idx[i] = this.heapIdx[0];
      this.d2[i] = this.heapD2[0];
      this.popMax();
    }
    return n;
  }

  /** (d2, j) sorts after (d2', j') when farther, or equally far with a larger index. */
  private worse(d2a: number, ia: number, d2b: number, ib: number): boolean {
    return d2a > d2b || (d2a === d2b && ia > ib);
  }

  private offer(j: number, d2: number, k: number): void {
    const { heapIdx: hi, heapD2: hd } = this;
    if (this.size < k) {
      let i = this.size++;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (!this.worse(d2, j, hd[p], hi[p])) break;
        hi[i] = hi[p]; hd[i] = hd[p]; i = p;
      }
      hi[i] = j; hd[i] = d2;
    } else if (this.worse(hd[0], hi[0], d2, j)) {
      this.siftDown(j, d2);
    }
  }

  private popMax(): void {
    const last = --this.size;
    if (last > 0) this.siftDown(this.heapIdx[last], this.heapD2[last]);
  }

  /** Places (j, d2) at the root and sifts it down. */
  private siftDown(j: number, d2: number): void {
    const { heapIdx: hi, heapD2: hd, size } = this;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= size) break;
      const r = l + 1;
      const c = r < size && this.worse(hd[r], hi[r], hd[l], hi[l]) ? r : l;
      if (!this.worse(hd[c], hi[c], d2, j)) break;
      hi[i] = hi[c]; hd[i] = hd[c]; i = c;
    }
    hi[i] = j; hd[i] = d2;
  }
}
