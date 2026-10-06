/**
 * Tracks which items of a GPU buffer changed since the last upload, and turns
 * them into a short list of contiguous ranges. Lets a buffer of 100k nodes
 * upload the handful that fired this frame instead of all of them.
 */
export class DirtySet {
  private flags: Uint8Array;
  private list: Int32Array;
  private size = 0;
  /** Everything changed; upload the whole buffer. */
  all = true;

  constructor(capacity: number) {
    this.flags = new Uint8Array(capacity);
    this.list = new Int32Array(capacity);
  }

  mark(i: number): void {
    if (this.all || this.flags[i]) return;
    this.flags[i] = 1;
    this.list[this.size++] = i;
  }

  markAll(): void {
    this.all = true;
  }

  get empty(): boolean {
    return !this.all && this.size === 0;
  }

  /**
   * Calls `emit(first, count)` for each run of changed items, merging runs
   * separated by fewer than `gap` clean items (one larger upload beats many
   * tiny ones). Falls back to a single span past `maxRanges`. Returns 'all'
   * without emitting when everything changed, so the caller uploads the whole
   * buffer; 'none' when nothing did. Clears the set.
   */
  drain(emit: (first: number, count: number) => void, gap = 32, maxRanges = 96): 'all' | 'some' | 'none' {
    if (this.all) {
      this.reset();
      return 'all';
    }
    const n = this.size;
    if (n === 0) return 'none';

    const sorted = this.list.subarray(0, n).sort();
    let runs = 1;
    for (let k = 1; k < n; k++) if (sorted[k] - sorted[k - 1] > gap) runs++;

    if (runs > maxRanges) {
      emit(sorted[0], sorted[n - 1] - sorted[0] + 1);
    } else {
      let first = sorted[0];
      let last = first;
      for (let k = 1; k < n; k++) {
        const i = sorted[k];
        if (i - last > gap) {
          emit(first, last - first + 1);
          first = i;
        }
        last = i;
      }
      emit(first, last - first + 1);
    }
    this.reset();
    return 'some';
  }

  private reset(): void {
    for (let k = 0; k < this.size; k++) this.flags[this.list[k]] = 0;
    this.size = 0;
    this.all = false;
  }
}

/** Uploads only what changed in `attribute`, per `dirty`. */
export function uploadDirty(
  attribute: { addUpdateRange(start: number, count: number): void; needsUpdate: boolean; itemSize: number },
  dirty: DirtySet,
): void {
  const size = attribute.itemSize;
  const result = dirty.drain((first, count) => attribute.addUpdateRange(first * size, count * size));
  if (result !== 'none') attribute.needsUpdate = true;
}
