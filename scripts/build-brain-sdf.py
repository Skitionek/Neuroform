#!/usr/bin/env python3
"""
Builds src/assets/brain-mni152.sdf.gz, the "scan" brain shape, from the MNI
ICBM152 2009a symmetric template's grey- and white-matter probability maps.

The output is a signed distance field on a regular grid, in Neuroform's
model space (x left/right, y up, z towards the front, about 1.1 units from
the frontal to the occipital pole), plus a region label per voxel (cortex,
cerebellum, brain stem). The app rejection-samples nodes from it exactly as
it does from the procedural shapes.

Usage:
    pip install numpy scipy nibabel
    python3 scripts/build-brain-sdf.py GM.nii.gz WM.nii.gz src/assets/brain-mni152.sdf.gz [VOXEL_MM]

The two maps ship with nilearn (nilearn/datasets/data/
mni_icbm152_{gm,wm}_tal_nlin_sym_09a_converted.nii.gz) and with the original
distribution at https://www.bic.mni.mcgill.ca/ServicesAtlases/ICBM152NLin2009.
Licence: see src/assets/brain-mni152.LICENSE.txt.

File format (gzip of):
    6 bytes   magic "NFSDF2"
    3 uint16  nx, ny, nz (little endian; x varies fastest in the arrays)
    3 float32 model-space position of voxel (0, 0, 0); x is always 0
    float32   voxel size, model units
    float32   distance step, model units per step
    int8      signed distance per voxel in steps (negative inside), delta
              coded along x: each row stores its first value, then
              differences; the running sum is the distance
    uint8     region per voxel (0 cortex, 1 cerebellum, 2 stem; 255 outside)

Only the right half (x >= 0) is stored: the template is symmetric, and the
app mirrors it.
"""
import gzip
import struct
import sys

import nibabel as nib
import numpy as np
from scipy import ndimage

# 2 mm: at 1.5 mm the file is twice the size and renders the same.
VOXEL_MM = 2.0
# The procedural brain is about 1.1 model units from pole to pole; the
# template's cerebrum is about 172 mm. Same size on screen, same settings.
MODEL_PER_MM = 1.1 / 172.0
# Distances are stored in half-millimetre steps, clamped to +-12 mm.
STEP_MM = 0.5
CLAMP_MM = 12.0
MARGIN_MM = 6.0


def main(gm_path: str, wm_path: str, out_path: str, voxel_mm: float = VOXEL_MM) -> None:
    gm = nib.load(gm_path)
    wm = nib.load(wm_path)
    assert np.allclose(gm.affine, wm.affine)
    affine = gm.affine
    tissue = (gm.get_fdata() + wm.get_fdata()) / 255.0

    # Brain = grey or white matter more likely than not. One piece, no holes
    # (ventricles and deep CSF are filled: nodes there are fine).
    mask = tissue > 0.5
    labels, count = ndimage.label(mask)
    sizes = ndimage.sum(mask, labels, range(1, count + 1))
    mask = labels == (1 + int(np.argmax(sizes)))
    mask = ndimage.binary_fill_holes(mask)
    # MNI coordinates (mm) of every voxel: x right, y anterior, z superior.
    i, j, k = np.indices(mask.shape, dtype=np.float32)
    xs = affine[0, 0] * i + affine[0, 3]
    ys = affine[1, 1] * j + affine[1, 3]
    zs = affine[2, 2] * k + affine[2, 3]

    # The tentorium: the dural sheet between the occipital lobes and the
    # cerebellum, which slopes down from the back and to the sides. In the
    # averaged template the two touch; carve the 2 mm gap back in so the
    # cerebellum reads as its own structure.
    stem_column = (np.abs(xs) < 15) & (ys > -48) & (ys < -6)
    tentorium = -10.0 - 0.18 * np.maximum(0.0, np.abs(xs) - 12.0) + 0.12 * np.minimum(0.0, ys + 60.0)
    mask &= ~((np.abs(zs - tentorium) < 1.0) & (ys < -40) & ~stem_column)

    # Smooth the surface by a fraction of a voxel, so the resampling
    # does not alias single-voxel noise.
    mask = ndimage.gaussian_filter(mask.astype(np.float32), 0.6) > 0.5

    # Signed distance in mm at 1 mm, negative inside.
    inside = ndimage.distance_transform_edt(mask)
    outside = ndimage.distance_transform_edt(~mask)
    sdf_mm = np.where(mask, -(inside - 0.5), outside - 0.5).astype(np.float32)

    # Regions, from MNI landmarks. The brain stem: the midline column below
    # the midbrain, between the cerebellum and the temporal lobes. The
    # cerebellum: everything behind and below the tentorium, which slopes
    # down from the back and to the sides.
    stem = mask & stem_column & (zs < -8)
    cerebellum = mask & ~stem & (ys < -36) & (zs < tentorium)
    region = np.full(mask.shape, 255, np.uint8)
    region[mask] = 0
    region[cerebellum] = 1
    region[stem] = 2

    # Crop to the brain plus a margin and resample to the output grid. The
    # template is symmetric, so only the right half is stored, starting at
    # the midline (MNI x = 0); the app mirrors it.
    nz_idx = np.argwhere(mask)
    lo = np.maximum(nz_idx.min(axis=0) - int(MARGIN_MM), 0)
    hi = np.minimum(nz_idx.max(axis=0) + int(MARGIN_MM), np.array(mask.shape) - 1)
    midline = -affine[0, 3] / affine[0, 0]
    lo[0] = int(midline)
    extent = (hi - lo).astype(np.float32)
    dims = np.floor(extent / voxel_mm).astype(int) + 1
    starts = [midline, lo[1], lo[2]]
    grid = [starts[a] + np.arange(dims[a]) * voxel_mm for a in range(3)]
    gi, gj, gk = np.meshgrid(*grid, indexing="ij")
    coords = np.stack([gi, gj, gk])
    sdf = ndimage.map_coordinates(sdf_mm, coords, order=1, mode="nearest")
    reg = ndimage.map_coordinates(region, coords, order=0, mode="nearest").astype(np.uint8)
    reg[sdf > 0] = 255

    # Model space: x = MNI x, y = MNI z (up), z = MNI y (front). Centred on
    # the cerebrum's bounding box, like the procedural brain.
    cortex = np.argwhere(region == 0)
    centre_mm = np.array([
        0.0,
        (affine[1, 1] * (cortex[:, 1].min() + cortex[:, 1].max()) / 2 + affine[1, 3]),
        (affine[2, 2] * (cortex[:, 2].min() + cortex[:, 2].max()) / 2 + affine[2, 3]),
    ])
    origin_mm = np.array([
        0.0,
        affine[1, 1] * lo[1] + affine[1, 3],
        affine[2, 2] * lo[2] + affine[2, 3],
    ])
    # Model axes in output order (x, y, z) = MNI (x, z, y): reorder the grid.
    sdf = np.transpose(sdf, (0, 2, 1))
    reg = np.transpose(reg, (0, 2, 1))
    model_dims = sdf.shape
    model_origin = np.array([
        0.0,
        origin_mm[2] - centre_mm[2],
        origin_mm[1] - centre_mm[1],
    ]) * MODEL_PER_MM

    # Distances in STEP_MM steps, clamped to +-CLAMP_MM: the sampler needs
    # the sign everywhere but the value only within the shell (~9 mm).
    limit = int(round(CLAMP_MM / STEP_MM))
    quantised = np.clip(np.round(sdf / STEP_MM), -limit, limit).astype(np.int16)
    # x fastest: C order over (z, y, x). Each x row is delta-coded: the
    # field is smooth, so differences are small and compress far better.
    rows = quantised.transpose(2, 1, 0)
    deltas = np.diff(rows, axis=2, prepend=0).astype(np.int8)
    header = b"NFSDF2" + struct.pack(
        "<3H5f",
        *model_dims,
        *model_origin.astype(np.float32),
        voxel_mm * MODEL_PER_MM,
        STEP_MM * MODEL_PER_MM,
    )
    body = deltas.tobytes() + reg.transpose(2, 1, 0).tobytes()
    with gzip.open(out_path, "wb", compresslevel=9) as f:
        f.write(header + body)

    counts = [(reg == r).sum() for r in (0, 1, 2)]
    total = sum(counts)
    print(f"half grid {model_dims}, voxel {voxel_mm} mm; regions cortex {counts[0] / total:.1%}, "
          f"cerebellum {counts[1] / total:.1%}, stem {counts[2] / total:.1%}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4]) if len(sys.argv) > 4 else VOXEL_MM)
