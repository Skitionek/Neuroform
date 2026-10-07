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
 * Exact k-nearest-neighbour queries on an implicit k-d tree.
 *
 * The tree is kdbush's layout extended to 3D: point ids and coordinates are
 * reordered in place by recursive Floyd-Rivest selection, so every subtree is
 * a contiguous index range split at its median and there are no node objects
 * at all. Unlike a uniform grid it adapts to density: clustered data, or one
 * stray point that inflates the bounding box, cost the same as an even cloud.
 * (A grid sized from the bounding box went quadratic on exactly those: 40x
 * slower with a single outlier.)
 *
 * Results are ordered by (distance², index) and distances are computed from
 * the original float32 positions in doubles, so callers can rely on the order
 * matching a brute-force sort exactly.
 */
export class NearestFinder {
  /** Subtrees at most this large are scanned linearly. */
  private static readonly LEAF = 16;

  private ids: Uint32Array;
  private coords: Float32Array;
  private positions: Float32Array;
  private count: number;
  // Traversal stack: [left, right, axis, lower bound on distance²] per entry.
  private stack = new Float64Array(256);
  // Max-heap of the best k so far, keyed by (distance², index).
  private heapIdx = new Int32Array(0);
  private heapD2 = new Float64Array(0);
  private size = 0;
  private self = -1;
  /** Results of the last query, nearest first. */
  idx = new Int32Array(0);
  d2 = new Float64Array(0);

  constructor(positions: Float32Array, count: number) {
    this.positions = positions;
    this.count = count;
    this.ids = new Uint32Array(count);
    this.coords = positions.slice(0, count * 3);
    for (let i = 0; i < count; i++) this.ids[i] = i;
    if (count > 0) this.build(0, count - 1, 0);
  }

  private build(left: number, right: number, axis: number): void {
    if (right - left <= NearestFinder.LEAF) return;
    const m = (left + right) >> 1;
    this.select(m, left, right, axis);
    const next = axis === 2 ? 0 : axis + 1;
    this.build(left, m - 1, next);
    this.build(m + 1, right, next);
  }

  /**
   * Floyd-Rivest selection: reorders [left, right] so the item at k is the
   * one a sort on `axis` would put there, with smaller ones before it.
   */
  private select(k: number, left: number, right: number, axis: number): void {
    const c = this.coords;
    while (right > left) {
      if (right - left > 600) {
        const n = right - left + 1;
        const m = k - left + 1;
        const z = Math.log(n);
        const s = 0.5 * Math.exp((2 * z) / 3);
        const sd = 0.5 * Math.sqrt((z * s * (n - s)) / n) * (m - n / 2 < 0 ? -1 : 1);
        const newLeft = Math.max(left, Math.floor(k - (m * s) / n + sd));
        const newRight = Math.min(right, Math.floor(k + ((n - m) * s) / n + sd));
        this.select(k, newLeft, newRight, axis);
      }
      const t = c[3 * k + axis];
      let i = left;
      let j = right;
      this.swap(left, k);
      if (c[3 * right + axis] > t) this.swap(left, right);
      while (i < j) {
        this.swap(i, j);
        i++;
        j--;
        while (c[3 * i + axis] < t) i++;
        while (c[3 * j + axis] > t) j--;
      }
      if (c[3 * left + axis] === t) this.swap(left, j);
      else {
        j++;
        this.swap(j, right);
      }
      if (j <= k) left = j + 1;
      if (k <= j) right = j - 1;
    }
  }

  private swap(i: number, j: number): void {
    const { ids, coords: c } = this;
    const id = ids[i]; ids[i] = ids[j]; ids[j] = id;
    for (let a = 0; a < 3; a++) {
      const t = c[3 * i + a]; c[3 * i + a] = c[3 * j + a]; c[3 * j + a] = t;
    }
  }

  /**
   * Finds up to `k` nearest points to node `self` within `radius`, excluding
   * `self`, ordered by distance then index. Returns how many were found.
   */
  query(self: number, k: number, radius: number): number {
    if (this.heapIdx.length < k) {
      this.heapIdx = new Int32Array(k);
      this.heapD2 = new Float64Array(k);
      this.idx = new Int32Array(k);
      this.d2 = new Float64Array(k);
    }
    this.size = 0;
    this.self = self;
    if (this.count === 0) return 0;

    const { coords: c, positions } = this;
    const x = positions[self * 3], y = positions[self * 3 + 1], z = positions[self * 3 + 2];
    const r2 = radius * radius;
    let stack = this.stack;
    let sp = 0;
    stack[sp++] = 0; stack[sp++] = this.count - 1; stack[sp++] = 0; stack[sp++] = 0;

    while (sp > 0) {
      const bound = stack[--sp];
      const axis = stack[--sp];
      const right = stack[--sp];
      const left = stack[--sp];
      // Nothing in this subtree can beat the current k-th best (or the reach).
      if (bound > (this.size === k ? this.heapD2[0] : r2)) continue;

      if (right - left <= NearestFinder.LEAF) {
        for (let i = left; i <= right; i++) this.consider(i, x, y, z, k, r2);
        continue;
      }

      const m = (left + right) >> 1;
      this.consider(m, x, y, z, k, r2);
      const diff = (axis === 0 ? x : axis === 1 ? y : z) - c[3 * m + axis];
      const next = axis === 2 ? 0 : axis + 1;
      const farBound = Math.max(bound, diff * diff);
      if (sp + 8 > stack.length) {
        const grown = new Float64Array(stack.length * 2);
        grown.set(stack);
        this.stack = stack = grown;
      }
      // Far side pushed first so the near side pops first and tightens the
      // bound before the far side is reconsidered.
      if (diff < 0) {
        stack[sp++] = m + 1; stack[sp++] = right; stack[sp++] = next; stack[sp++] = farBound;
        stack[sp++] = left; stack[sp++] = m - 1; stack[sp++] = next; stack[sp++] = bound;
      } else {
        stack[sp++] = left; stack[sp++] = m - 1; stack[sp++] = next; stack[sp++] = farBound;
        stack[sp++] = m + 1; stack[sp++] = right; stack[sp++] = next; stack[sp++] = bound;
      }
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

  /**
   * Tests the point at tree slot `t`. Reads the tree's own coordinate copy,
   * which is laid out in traversal order (sequential memory access), and holds
   * the same float32 values as `positions`, so distances are bit-identical.
   */
  private consider(t: number, x: number, y: number, z: number, k: number, r2: number): void {
    const j = this.ids[t];
    if (j === this.self) return;
    const c = this.coords;
    const ex = c[t * 3] - x;
    const ey = c[t * 3 + 1] - y;
    const ez = c[t * 3 + 2] - z;
    const d2 = ex * ex + ey * ey + ez * ez;
    if (d2 > r2) return;
    this.offer(j, d2, k);
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
