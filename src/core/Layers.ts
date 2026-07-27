/**
 * Render layer allocation.
 *
 * The view-model (weapon) lives in the SAME scene as the world so it is lit by
 * the same lights and the same environment probe - duplicating a light rig for
 * the gun is the classic way to make a view-model look pasted on.
 *
 * Separation is done with layers instead:
 *   - world objects  -> layer WORLD
 *   - weapon objects -> layer VIEWMODEL
 *   - lights         -> enabled on BOTH, so `camera.layers.test(light.layers)`
 *                       passes for the weapon camera too.
 *
 * The weapon camera shares near/far with the main camera and differs only in
 * FOV. That keeps a single, consistent depth space, which is what lets SSAO and
 * depth-of-field read the depth buffer without special-casing the gun.
 */
export const LAYER = {
  WORLD: 0,
  VIEWMODEL: 2,
} as const;
