/**
 * Finds the node under the pointer.
 *
 * Marches the pick ray through a uniform grid and tests only the points in
 * cells near it, instead of measuring the ray's distance to every point. The
 * result matches a brute-force test: the hit nearest the camera among points
 * within `threshold` of the ray.
 */
import type { Ray } from 'three';
import { UniformGrid } from '../graph/spatial';

export class NodePicker {
  private grid: UniformGrid;
  private positions: Float32Array;
  private stamp: Uint32Array;
  private generation = 0;

  /** Largest pick threshold this grid answers exactly. */
  readonly maxThreshold: number;

  constructor(positions: Float32Array, count: number, maxThreshold = 0.05) {
    this.positions = positions;
    // Cells hold a few points each, but are never narrower than the largest
    // threshold: the march's coverage argument below needs threshold <= cell.
    const cell = Math.max(UniformGrid.cellFor(positions, count, 8), maxThreshold / 0.95);
    this.grid = new UniformGrid(positions, count, cell);
    this.stamp = new Uint32Array(this.grid.start.length - 1);
    this.maxThreshold = maxThreshold;
  }

  /** Index of the picked node, or -1. `ray` is in the cloud's local space. */
  pick(ray: Ray, threshold: number): number {
    const { grid, positions } = this;
    const t2 = threshold * threshold;
    const o = ray.origin, d = ray.direction;
    const h = grid.cell;

    // Clip the ray to the grid's box, padded by one cell.
    let tMin = 0, tMax = Infinity;
    for (let a = 0 as 0 | 1 | 2; a < 3; a = (a + 1) as 0 | 1 | 2) {
      const lo = grid.min[a] - h;
      const hi = grid.min[a] + grid.dims[a] * h + h;
      const oa = a === 0 ? o.x : a === 1 ? o.y : o.z;
      const da = a === 0 ? d.x : a === 1 ? d.y : d.z;
      if (Math.abs(da) < 1e-12) {
        if (oa < lo || oa > hi) return -1;
        continue;
      }
      let t0 = (lo - oa) / da, t1 = (hi - oa) / da;
      if (t0 > t1) { const s = t0; t0 = t1; t1 = s; }
      tMin = Math.max(tMin, t0);
      tMax = Math.min(tMax, t1);
      if (tMin > tMax) return -1;
    }

    if (++this.generation === 0xffffffff) { this.stamp.fill(0); this.generation = 1; }
    const gen = this.generation;
    const [dx, dy] = grid.dims;

    let best = -1;
    let bestT = Infinity;
    // Sample the ray every half cell and test the 27 cells around each sample.
    // A point within `threshold` of the ray is within sqrt(threshold² +
    // (h/4)²) < h of the nearest sample, so it lies in one of those cells.
    const stepT = h * 0.5;
    for (let t = tMin; t <= tMax + stepT; t += stepT) {
      // Everything left is farther along the ray than the best hit so far.
      if (t - 2 * h > bestT) break;
      const cx = grid.coord(o.x + d.x * t, 0);
      const cy = grid.coord(o.y + d.y * t, 1);
      const cz = grid.coord(o.z + d.z * t, 2);
      for (let kz = cz - 1; kz <= cz + 1; kz++) {
        if (kz < 0 || kz >= grid.dims[2]) continue;
        for (let ky = cy - 1; ky <= cy + 1; ky++) {
          if (ky < 0 || ky >= dy) continue;
          for (let kx = cx - 1; kx <= cx + 1; kx++) {
            if (kx < 0 || kx >= dx) continue;
            const b = kx + dx * (ky + dy * kz);
            if (this.stamp[b] === gen) continue;
            this.stamp[b] = gen;
            for (let s = grid.start[b], e = grid.start[b + 1]; s < e; s++) {
              const i = grid.items[s];
              const px = positions[i * 3] - o.x;
              const py = positions[i * 3 + 1] - o.y;
              const pz = positions[i * 3 + 2] - o.z;
              const along = px * d.x + py * d.y + pz * d.z;
              if (along < 0) continue;
              const qx = px - d.x * along, qy = py - d.y * along, qz = pz - d.z * along;
              if (qx * qx + qy * qy + qz * qz > t2) continue;
              if (along < bestT) { bestT = along; best = i; }
            }
          }
        }
      }
    }
    return best;
  }
}
