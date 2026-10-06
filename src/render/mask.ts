/**
 * A second output from the scene pass, for gooey cells made in post.
 *
 * Every layer writes its colour to location 0 and a "mask" to location 1 in
 * the same draw, so the network's geometry is drawn once. Two encodings:
 *
 * - DEPTH (1): (coverage, coverage x view depth, coverage x glow). Post
 *   blurs it with a depth-aware filter: only samples near the front-most
 *   depth in the kernel count, so near and far blobs don't merge.
 * - CHANNELS (2): depth as a red/green split, brightness as blue:
 *   (coverage x (1 - t), coverage x t, coverage x brightness), t = 0 at the
 *   near side of the brain, 1 at the far side. Post makes the red (near)
 *   share gooey with a plain blur; the green (far) share stays as sharp
 *   dots. Two soft depth layers, no per-sample depth logic.
 *
 * Coverage is additive across overlapping fragments (alpha is written as 1,
 * so additive blending adds the rgb as-is), which is what a blur expects.
 */

export const MASK_OFF = 0;
export const MASK_DEPTH = 1;
export const MASK_CHANNELS = 2;

export interface MaskUniforms {
  uMaskMode: { value: number };
  /** View depth of the brain's near side, model units. */
  uDepthNear: { value: number };
  /** Distance from the brain's near side to its far side. */
  uDepthRange: { value: number };
}

export function createMaskUniforms(): MaskUniforms {
  return {
    uMaskMode: { value: MASK_OFF },
    uDepthNear: { value: 1 },
    uDepthRange: { value: 1 },
  };
}

/** Fragment outputs and the mask encoder. Requires glslVersion GLSL3. */
export const MASK_FRAGMENT_GLSL = /* glsl */ `
  layout(location = 0) out highp vec4 outColor;
  layout(location = 1) out highp vec4 outMask;
  uniform float uMaskMode;
  uniform float uDepthNear;
  uniform float uDepthRange;

  vec4 encodeMask(float coverage, float viewDepth, float glow) {
    if (uMaskMode < 0.5 || coverage <= 0.0) return vec4(0.0, 0.0, 0.0, 1.0);
    if (uMaskMode < 1.5) return vec4(coverage, coverage * viewDepth, coverage * glow, 1.0);
    float t = clamp((viewDepth - uDepthNear) / uDepthRange, 0.0, 1.0);
    // Red falls off steeply with depth, so only the front of the surface
    // counts as near: a linear split fused the whole near half into a sheet.
    float near = pow(1.0 - t, 4.0);
    return vec4(coverage * near, coverage * (1.0 - near), coverage * (0.6 + glow), 1.0);
  }
`;
