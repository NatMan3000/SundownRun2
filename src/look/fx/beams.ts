// ============================================================
//  HEADLIGHT BEAMS - where every car's headlight beams are
// ------------------------------------------------------------
//  The visible beams at night (the glow of light hanging in the
//  air in front of each car) are NOT meshes. A mesh beam is a cone
//  of triangles, and wherever it pokes into the road or a hillside
//  you see its hard straight edges. Instead the post stack draws
//  the beams as real volumes of light: for every pixel it walks
//  along the line of sight, adds up how much beam it passes
//  through, and stops at whatever the pixel is showing (the road,
//  a hill, a car). So a beam fades softly at its edges, along its
//  length and into anything it meets, and has no polygons to see.
//  (post/HeadlightBeamsEffect.ts does the drawing.)
//
//  This file is the hand-over between the two halves:
//    CarLights.tsx writes one entry per lamp every frame (world
//      space: where the lamp is, which way it points, how bright)
//    PostStack.tsx turns them into camera space for the shader
//
//  The player's real road lighting (the bright pool on the wet
//  road) is still the two SpotLights in HeadlightRig.tsx; these
//  beams are the light you see in the air on the way there.
// ============================================================

import * as THREE from 'three'

/** Most lamps drawn at once: two each for the player and five Ai racers. */
export const MAX_BEAM_LAMPS = 12

/**
 * The beam's shape and strength. Josh: these are fun to play with
 * live with __dev.lookBeams({ ... }).
 */
export const BEAM_TUNE = {
  /** How far the visible glow reaches, metres. */
  length: 34,
  /** How fast the beam widens: metres of radius gained per metre travelled (0.12 = about 7 degrees). */
  spread: 0.12,
  /** Radius of the beam right at the lamp, metres. */
  startRadius: 0.1,
  /** Overall brightness. Kept low: beams are a haze, not a hero glow (they never reach bloom). */
  intensity: 0.15,
  /** The brightest a pixel of beam can get, however much of it you look through (stays under bloom's 1.0). */
  maxBrightness: 0.24,
  /**
   * Haze throws light mostly onward, so your own beams (seen from behind)
   * are dimmer than an oncoming car's. 0 = same from every side.
   */
  forwardScatter: 0.35,
  /** The beam fades out over this many metres before it touches the road or a hill. */
  softContact: 2,
  /** How far below level the beams aim, metres of drop per metre ahead. */
  aimDrop: 0.018,
  /** Beams of cars further than this from the camera fade out (metres, start..end). */
  fadeNear: 90,
  fadeFar: 150,
}

/** One frame's lamps, world space. Filled by CarLights, read by the post stack. No allocation per frame. */
export const beamLamps = {
  count: 0,
  position: Array.from({ length: MAX_BEAM_LAMPS }, () => new THREE.Vector3()),
  direction: Array.from({ length: MAX_BEAM_LAMPS }, () => new THREE.Vector3(0, 0, 1)),
  /** 0..1 strength of each lamp (night x car kind). */
  gain: new Float32Array(MAX_BEAM_LAMPS),
}
