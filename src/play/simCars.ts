// ============================================================
//  SIM CARS - helpers for "every car that is simulated here"
// ------------------------------------------------------------
//  Props, posts and cores react to cars driving into them. The cars
//  that matter are the ones THIS machine simulates: the player and
//  the Ai racers (remote multiplayer cars are simulated on their own
//  machines; ghosts are see-through).
//
//  Car poses come from the car registry (core/telemetry.ts `cars`),
//  which holds the RENDER pose: smooth, but up to a physics step or
//  two behind the simulation. Hit tests therefore look a little way
//  ahead along the car's velocity (`lookAheadSteps`), so a fast car
//  is always caught before contact, never after.
//
//  carBody() finds a car's chassis rigid body through the collider
//  owner tags (core/physics.ts), for the one thing play does to a car
//  directly: the small speed loss when it smashes through a post.
// ============================================================

import type { RapierContext, RapierRigidBody } from '@react-three/rapier'
import type { CarState } from '../core/telemetry'
import { rewind } from '../core/telemetry'
import { ownerOf } from '../core/physics'

export type PhysicsWorld = RapierContext['world']

/**
 * True for cars this machine simulates (player and Ai racers). While rewind is held nothing is
 * simulated (every car is sliding back along its own path), so no car knocks anything over.
 */
export function isLocalSimCar(c: CarState): boolean {
  return !rewind.active && (c.kind === 'player' || c.kind === 'ai')
}

/** Physics steps since the last rendered frame (counted by <StepClock /> in index.tsx, reset per frame). */
export const stepClock = { stepsSinceFrame: 0 }

/** How many steps ahead to sweep a car for a hit test this step. */
export function lookAheadSteps(): number {
  return stepClock.stepsSinceFrame + 2.5
}

/** Car body size for hit tests: from the body's fx anchors when known, else a typical car. */
export function carHalfWidth(c: CarState): number {
  return c.anchors ? Math.max(0.8, c.anchors.underglow.halfWidth + 0.15) : 1.0
}
export function carHalfLength(c: CarState): number {
  return c.anchors ? Math.max(1.6, c.anchors.underglow.halfLength + 0.2) : 2.2
}

const handleCache = new WeakMap<object, Map<string, number>>()

/** The chassis rigid body of a local car, or null. Cached; a cache miss scans the colliders once. */
export function carBody(world: PhysicsWorld, carId: string): RapierRigidBody | null {
  let map = handleCache.get(world)
  if (!map) {
    map = new Map()
    handleCache.set(world, map)
  }
  const cached = map.get(carId)
  if (cached !== undefined) {
    const owner = ownerOf(cached)
    if (owner && owner.kind === 'car' && owner.id === carId) {
      const col = world.getCollider(cached)
      const body = col?.parent()
      if (body) return body
    }
    map.delete(carId)
  }
  let found: RapierRigidBody | null = null
  world.forEachCollider((col) => {
    if (found) return
    const owner = ownerOf(col.handle)
    if (owner && owner.kind === 'car' && owner.id === carId) {
      const body = col.parent()
      if (body) {
        found = body
        map!.set(carId, col.handle)
      }
    }
  })
  return found
}

