/**
 * The "scan" brain: a signed distance field built from the MNI ICBM152 2009
 * template (see scripts/build-brain-sdf.py), so nodes fill a real brain's
 * volume, folds, fissures and all, instead of a procedural approximation.
 *
 * The template is symmetric, so only the right half is stored and x is
 * mirrored. It is fetched only when the scan shape is chosen.
 */

/** A signed distance grid in model space, with a region label per voxel. */
export interface BrainGrid {
  nx: number;
  ny: number;
  nz: number;
  /** Model-space position of voxel (0, 0, 0); x is 0, the midline. */
  origin: [number, number, number];
  /** Voxel size, model units. */
  voxel: number;
  /** Signed distance per voxel in `step` units, negative inside. x fastest. */
  sdf: Int8Array;
  step: number;
  /** 0 cortex, 1 cerebellum, 2 stem, 255 outside. */
  region: Uint8Array;
}

const MAGIC = 'NFSDF2';
const HEADER_BYTES = 32;

/** Parses the uncompressed file written by scripts/build-brain-sdf.py. */
export function parseBrainGrid(buffer: ArrayBuffer): BrainGrid {
  const bytes = new Uint8Array(buffer);
  const magic = String.fromCharCode(...bytes.subarray(0, 6));
  if (magic !== MAGIC) throw new Error('not a Neuroform brain grid');
  const view = new DataView(buffer);
  const nx = view.getUint16(6, true);
  const ny = view.getUint16(8, true);
  const nz = view.getUint16(10, true);
  const origin: [number, number, number] = [
    view.getFloat32(12, true),
    view.getFloat32(16, true),
    view.getFloat32(20, true),
  ];
  const voxel = view.getFloat32(24, true);
  const step = view.getFloat32(28, true);
  const n = nx * ny * nz;
  if (buffer.byteLength < HEADER_BYTES + 2 * n) throw new Error('brain grid is truncated');
  // Rows are delta coded along x: the running sum is the distance.
  const deltas = new Int8Array(buffer, HEADER_BYTES, n);
  const sdf = new Int8Array(n);
  for (let row = 0; row < n; row += nx) {
    let v = 0;
    for (let i = row; i < row + nx; i++) {
      v += deltas[i];
      sdf[i] = v;
    }
  }
  return { nx, ny, nz, origin, voxel, step, sdf, region: new Uint8Array(buffer, HEADER_BYTES + n, n) };
}

const cache = new Map<string, Promise<BrainGrid>>();

/** Fetches and decompresses a grid once per URL. */
export function loadBrainGrid(url: string): Promise<BrainGrid> {
  let grid = cache.get(url);
  if (!grid) {
    grid = (async () => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`cannot load ${url}: ${response.status}`);
      const bytes = await response.arrayBuffer();
      // Some servers send .gz files with Content-Encoding: gzip, and the
      // browser has already unpacked them; only gunzip what is still gzip.
      const head = new Uint8Array(bytes, 0, 2);
      if (head[0] !== 0x1f || head[1] !== 0x8b) return parseBrainGrid(bytes);
      const unzipped = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      return parseBrainGrid(await new Response(unzipped).arrayBuffer());
    })();
    grid.catch(() => cache.delete(url));
    cache.set(url, grid);
  }
  return grid;
}

/** Distance reported outside the grid: anything positive will do. */
const OUTSIDE = 0.1;

/** Signed distance at a model-space point: trilinear inside the grid. */
export function gridDistance(g: BrainGrid, x: number, y: number, z: number): number {
  const fx = (Math.abs(x) - g.origin[0]) / g.voxel;
  const fy = (y - g.origin[1]) / g.voxel;
  const fz = (z - g.origin[2]) / g.voxel;
  // Outside the grid: outside the brain, by at least the grid's margin.
  if (fx < 0 || fy < 0 || fz < 0 || fx >= g.nx - 1 || fy >= g.ny - 1 || fz >= g.nz - 1) {
    return OUTSIDE;
  }
  const ix = fx | 0, iy = fy | 0, iz = fz | 0;
  const tx = fx - ix, ty = fy - iy, tz = fz - iz;
  const sx = 1, sy = g.nx, sz = g.nx * g.ny;
  const i = ix + iy * sy + iz * sz;
  const d = g.sdf;
  const c00 = d[i] + (d[i + sx] - d[i]) * tx;
  const c10 = d[i + sy] + (d[i + sy + sx] - d[i + sy]) * tx;
  const c01 = d[i + sz] + (d[i + sz + sx] - d[i + sz]) * tx;
  const c11 = d[i + sz + sy] + (d[i + sz + sy + sx] - d[i + sz + sy]) * tx;
  const c0 = c00 + (c10 - c00) * ty;
  const c1 = c01 + (c11 - c01) * ty;
  return (c0 + (c1 - c0) * tz) * g.step;
}

/** Region label of the voxel nearest a point; 0 (cortex) outside labelled tissue. */
export function gridRegion(g: BrainGrid, x: number, y: number, z: number): number {
  const ix = Math.round((Math.abs(x) - g.origin[0]) / g.voxel);
  const iy = Math.round((y - g.origin[1]) / g.voxel);
  const iz = Math.round((z - g.origin[2]) / g.voxel);
  if (ix < 0 || iy < 0 || iz < 0 || ix >= g.nx || iy >= g.ny || iz >= g.nz) return 0;
  const r = g.region[ix + iy * g.nx + iz * g.nx * g.ny];
  return r === 255 ? 0 : r;
}

/** Model-space bounding box of the grid, mirrored half included. */
export function gridBox(g: BrainGrid): { x: [number, number]; y: [number, number]; z: [number, number] } {
  const [ox, oy, oz] = g.origin;
  const half = ox + (g.nx - 1) * g.voxel;
  return {
    x: [-half, half],
    y: [oy, oy + (g.ny - 1) * g.voxel],
    z: [oz, oz + (g.nz - 1) * g.voxel],
  };
}
