/**
 * Depth cue: everything darkens with distance from the camera across the
 * brain's own depth, so the near side reads in front of the far side. It
 * applies to the resting tissue and to activation alike, so a wave on the
 * far side glows dimmer than the same wave facing the viewer.
 *
 * The range runs from the near side of the brain's bounding sphere to just
 * past its centre, updated every frame so it follows orbiting and zoom. The
 * near half is what is seen through the tissue, so that is where the fade
 * has to happen to read: the silhouette (at centre depth) is already almost
 * fully faded, which shades the brain like a lit ball, and everything behind
 * sits at (1 - strength).
 */
import type { PerspectiveCamera, Vector3 } from 'three';

/** Where the fade bottoms out, in bounding radii past the centre. */
const FAR_PAST_CENTRE = 0.25;

/** Shared by every material that uses DEPTH_CUE_GLSL: one update moves them all. */
export const depthUniforms = {
  uDepthNear: { value: 0 },
  uDepthFar: { value: 1 },
  uDepthCue: { value: 0 },
};

export const DEPTH_CUE_GLSL = /* glsl */ `
  uniform float uDepthNear;
  uniform float uDepthFar;
  uniform float uDepthCue;

  /** 0 at the near side of the brain, 1 at the far side, for a view-space z. */
  float viewDepth(float viewZ) {
    return clamp((-viewZ - uDepthNear) / max(1e-4, uDepthFar - uDepthNear), 0.0, 1.0);
  }

  /** Brightness multiplier for a view-space z. */
  float depthCue(float viewZ) {
    return 1.0 - uDepthCue * viewDepth(viewZ);
  }
`;

/** Sets the cue's range from the camera's distance to the brain. */
export function updateDepthCue(camera: PerspectiveCamera, centre: Vector3, radius: number, strength: number): void {
  const distance = camera.position.distanceTo(centre);
  depthUniforms.uDepthNear.value = Math.max(0, distance - radius);
  depthUniforms.uDepthFar.value = distance + FAR_PAST_CENTRE * radius;
  depthUniforms.uDepthCue.value = strength;
}
