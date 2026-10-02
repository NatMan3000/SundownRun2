// ============================================================
//  GROUND POOLS - soft light that cars throw on the ground
// ------------------------------------------------------------
//  Two kinds, both soft ovals of light on whatever is under or
//  behind a car:
//    - the underglow pool: the car's glow colour, under the car
//    - the reverse glow: cool white, behind a car that is backing up
//
//  They used to be flat squares drawn just above the wheels, tilted
//  with the car. On bumpy ground the ground rose through the square
//  and cut the light off with a hard straight edge (Nathan saw it
//  on the Brick off the road), and the light leaned when the car
//  rolled. Now they are not meshes at all: the post stack
//  (post/GroundPoolsEffect.ts) looks at what every pixel shows, and
//  if that spot is on the ground near a car, it adds the car's
//  light there. So the light lands on the real road, hill or kerb
//  and follows its shape, never cut off.
//
//  This file is the hand-over between the two halves, like
//  fx/beams.ts is for the headlight beams:
//    CarLights.tsx writes one entry per pool every frame (world
//      space: where it is, which way the car faces, its size and
//      colour)
//    PostStack.tsx turns them into camera space for the shader
// ============================================================

import * as THREE from 'three'

/** Room for an underglow pool and a reverse glow for every car with fx (CarLights' MAX_FX_CARS x 2). */
export const MAX_GROUND_POOLS = 24

/**
 * How the pools sit on the ground. Josh: try these live with
 * __dev.lookPools({ ... }).
 */
export const POOL_TUNE = {
  /**
   * The car's own body, as a box round the pool's car (half width and
   * half length, metres). Ground light never climbs the car itself:
   * inside this box only surfaces at road level are lit.
   */
  bodyHalfWidth: 1.0,
  bodyHalfLength: 2.2,
  /** Inside the car's box, light reaches this far above the road (metres): the road under the car, not its sides. */
  riseUnderCar: 0.12,
  /** Away from the car, light climbs this far up a hill or kerb (metres) before it fades. */
  riseAway: 1.2,
  /** Light still lands this far below the car's road level (a dip or the far side of a crest), metres. */
  dropBelow: 1.6,
  /** Pools of cars this far from the camera fade out (metres, start..end). */
  fadeNear: 180,
  fadeFar: 320,
}

/** One frame's pools, world space. Filled by CarLights, read by the post stack. No allocation per frame. */
export const groundPools = {
  count: 0,
  /** The middle of the pool, at the car's road level. */
  centre: Array.from({ length: MAX_GROUND_POOLS }, () => new THREE.Vector3()),
  /** The car's nose direction and its up (unit length). */
  forward: Array.from({ length: MAX_GROUND_POOLS }, () => new THREE.Vector3(0, 0, 1)),
  up: Array.from({ length: MAX_GROUND_POOLS }, () => new THREE.Vector3(0, 1, 0)),
  /** Half width and half length of the oval of light, metres. */
  halfWidth: new Float32Array(MAX_GROUND_POOLS),
  halfLength: new Float32Array(MAX_GROUND_POOLS),
  /** Where the car's body box sits along `forward`, measured from the pool's middle (0 = right over it). */
  bodyOffset: new Float32Array(MAX_GROUND_POOLS),
  /** The light's colour x its strength (linear, HDR; kept under the bloom threshold by the glow tier). */
  colour: Array.from({ length: MAX_GROUND_POOLS }, () => new THREE.Color()),
}
