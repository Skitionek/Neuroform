/**
 * The view split: a plane through the brain's centre, facing the camera,
 * divides the scene into a near half and a far half. Everything is drawn
 * additively without depth, so the frame is exactly near + far, and the far
 * half can be rendered at lower resolution and added back in.
 *
 * Every layer shares these uniform objects, so the scene pass flips them once
 * per half and all materials follow.
 */
import { Vector3 } from 'three';

export interface SplitUniforms {
  /** World-space centre of the cloud. */
  uSplitCentre: { value: Vector3 };
  /** Unit vector from the centre toward the camera. */
  uSplitDir: { value: Vector3 };
  /** 1 draws the near half, -1 the far half, 0 everything. */
  uSplitSide: { value: number };
  /**
   * Resolution of the target being drawn, relative to the screen. Points
   * shrink by it to keep their apparent size; one-pixel lines dim by it,
   * because upscaling widens them by the same factor.
   */
  uPixelScale: { value: number };
}

export function createSplitUniforms(): SplitUniforms {
  return {
    uSplitCentre: { value: new Vector3() },
    uSplitDir: { value: new Vector3(0, 0, 1) },
    uSplitSide: { value: 0 },
    uPixelScale: { value: 1 },
  };
}

export const SPLIT_GLSL = /* glsl */ `
  uniform vec3 uSplitCentre;
  uniform vec3 uSplitDir;
  uniform float uSplitSide;
  uniform float uPixelScale;

  // A clip-space position outside the view volume: primitives sent here are
  // dropped before rasterisation, so the culled half costs no fill at all.
  const vec4 CULLED = vec4(2.0, 2.0, 2.0, 1.0);

  // Whether something at world position p belongs to the half being drawn.
  // Ties go to the near half, so nothing is ever drawn twice or dropped.
  bool onDrawnSide(vec3 p) {
    if (uSplitSide == 0.0) return true;
    bool near = dot(p - uSplitCentre, uSplitDir) >= 0.0;
    return uSplitSide > 0.0 ? near : !near;
  }
`;
