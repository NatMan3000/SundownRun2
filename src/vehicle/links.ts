// ============================================================
//  VEHICLE LINKS - handles shared inside the vehicle system
// ------------------------------------------------------------
//  A few parts of the vehicle system live in different places in
//  the scene tree: the cars are inside <Physics>, the camera is
//  outside it. This mutable singleton is how they find each other
//  (the camera's anti-clip ray needs the physics world; the ghost
//  needs the player's lap clock). Owners set and clear their own
//  entries on mount / unmount. Nothing outside src/vehicle and
//  src/dev reads this.
// ============================================================

import type { RapierContext, RapierRigidBody } from '@react-three/rapier'
import type { CarSim } from './carSim'
import type { LapTracker } from './lapTracker'

export const links = {
  /** The physics world + rapier API (null while no <Physics> is mounted). */
  world: null as RapierContext['world'] | null,
  rapier: null as RapierContext['rapier'] | null,
  /** The player's car. */
  playerSim: null as CarSim | null,
  playerBody: null as RapierRigidBody | null,
  playerLap: null as LapTracker | null,
  /** performance.now() of the player's last physics step (ghost interpolation). */
  playerStepAt: 0,
  /** Bumped on every player teleport / reset: the camera's one sanctioned snap. */
  resetTick: 0,
}
