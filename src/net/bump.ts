// ============================================================
//  BUMPS - making a ram actually shove the other car
// ------------------------------------------------------------
//  The problem: each computer simulates ONLY its own car. Everyone
//  else is a kinematic body: we move it from their pose stream, and
//  physics treats it as infinitely heavy. So when Josh rams Dad:
//    - on Josh's screen, Dad's car is a wall: Josh stops dead
//    - so Josh's pose stream never pushes into Dad's car
//    - so on Dad's screen, nothing ever shoves him
//  (v1 lived with "ramming a parked car feels like hitting a wall".)
//
//  The fix, a momentum hand-off:
//    1. The rammer's computer sees the real contact between its own
//       chassis and the other car's body (RemoteCars checks every step).
//    2. It works out how fast the two were closing along the line
//       between them, and sends the other car its share of that speed
//       as a `bump` (only the car doing most of the closing sends, so a
//       crash is never counted twice).
//    3. The victim's computer adds that velocity change to its own car
//       on its next physics step. Its new motion flows back out through
//       its pose stream, so both screens see the shove.
//    4. The rammer keeps the rest: its velocity goes back to what it was
//       before the hit, minus the push it handed over (equal cars sharing
//       the crash), and their body turns see-through for BUMP_GHOST_MS so
//       it doesn't hit the same stale "wall" again.
//
//  The NaN firewall applies to every bump, sent or received.
// ============================================================

import * as THREE from 'three'
import { useRapier, useBeforePhysicsStep } from '@react-three/rapier'
import type { RapierCollider, RapierRigidBody } from '@react-three/rapier'
import { ownerOf } from '../core/physics'
import { getSettings } from '../core/settings'
import type { CarState } from '../core/telemetry'
import { onMessage, send } from './client'
import { getNet } from './netStore'
import type { BumpMsg } from './protocol'

/** Share of the closing speed the hit car receives (equal masses, a slightly bouncy hit). */
export const BUMP_SHARE = 0.65
/** Closing speed below this (m/s) is a nudge, not a ram: physics alone handles it. */
const MIN_CLOSING = 1.2
/** One bump per pair of cars per this many ms (a long scrape is not a machine gun). */
const COOLDOWN_MS = 220
/** Biggest velocity change one bump can carry, m/s (about 65 km/h). */
const MAX_DV = 18
/** A little lift so a big hit hops the car instead of grinding it into the road. */
const LIFT_PER_MS = 0.04

const lastBumpAt = new Map<number, number>()

const _n = new THREE.Vector3()
const _sum = { x: 0, y: 0, z: 0 }
const _keep = { x: 0, y: 0, z: 0 }
const _keepAng = { x: 0, y: 0, z: 0 }
const _dv = new THREE.Vector3()

/**
 * RemoteCars calls this when OUR chassis is touching remote car `relayId`.
 * `mine` is our chassis body; `them` is their car state (velocity estimated from their stream).
 * Returns true if a bump was sent.
 */
export function maybeBump(relayId: number, mine: RapierRigidBody, them: CarState): boolean {
  if (!getSettings().multiplayerRam) return false
  const now = performance.now()
  if (now - (lastBumpAt.get(relayId) ?? 0) < COOLDOWN_MS) return false
  // Our speed from BEFORE this step: by now physics has already stopped us
  // against their (immovable) body, so the current velocity says nothing.
  if (!preStep.valid) return false

  const p = mine.translation()
  const v = preStep
  // Line from us to them, flat (a ram pushes sideways and forwards, not into the road).
  _n.set(them.position.x - p.x, 0, them.position.z - p.z)
  const len = _n.length()
  if (!(len > 0.01)) return false
  _n.divideScalar(len)

  const mineToward = v.x * _n.x + v.z * _n.z
  const theirsToward = -(them.velocity.x * _n.x + them.velocity.z * _n.z)
  const closing = mineToward + theirsToward
  // Only the car doing most of the closing sends; a head-on tie sends from both (fair).
  if (!(closing > MIN_CLOSING) || mineToward < theirsToward) return false

  const push = Math.min(MAX_DV, closing * BUMP_SHARE)
  _dv.set(_n.x * push, Math.min(2.5, push * push * LIFT_PER_MS), _n.z * push)
  if (!Number.isFinite(_dv.x) || !Number.isFinite(_dv.y) || !Number.isFinite(_dv.z)) return false

  lastBumpAt.set(relayId, now)
  const msg: BumpMsg = { t: 'bump', to: relayId, dvx: _dv.x, dvy: _dv.y, dvz: _dv.z }
  send(msg)
  stats.sent++

  // Our half of the exchange. On our screen they are an immovable body, so
  // physics just stopped us dead (and bounced us back). Undo that: carry on
  // with our speed from before the hit, minus exactly the push we handed them.
  // RemoteCars then lets us pass through their body for a moment, until their
  // stream shows them moving off.
  _keep.x = preStep.x - _dv.x
  _keep.y = preStep.y
  _keep.z = preStep.z - _dv.z
  if (Number.isFinite(_keep.x) && Number.isFinite(_keep.z)) {
    mine.setLinvel(_keep, true)
    _keepAng.x = preStep.ax
    _keepAng.y = preStep.ay
    _keepAng.z = preStep.az
    mine.setAngvel(_keepAng, true)
  }
  return true
}

/** How long a rammed car stays see-through on the rammer's screen (ms). */
export const BUMP_GHOST_MS = 350

/** Bumps for our car, waiting for the next physics step. */
const pending: { x: number; y: number; z: number }[] = []

/** Counters for the inspector. */
export const stats = { sent: 0, received: 0, applied: 0 }

let wired = false
let unsub: (() => void) | null = null

export function startBumps(): void {
  if (wired) return
  wired = true
  unsub = onMessage('bump', (m) => {
    if (m.to !== getNet().myId) return
    // NaN firewall + a sanity cap: never trust a number off the network.
    const mag = Math.hypot(m.dvx, m.dvy, m.dvz)
    if (!Number.isFinite(mag) || mag > MAX_DV * 1.5) return
    stats.received++
    if (pending.length < 8) pending.push({ x: m.dvx, y: m.dvy, z: m.dvz })
  })
}

export function stopBumps(): void {
  unsub?.()
  unsub = null
  wired = false
  pending.length = 0
}

/** Our chassis velocity (and spin) at the start of the current physics step. */
const preStep = { x: 0, y: 0, z: 0, ax: 0, ay: 0, az: 0, valid: false }

interface ColliderWorld {
  forEachCollider: (f: (c: RapierCollider) => void) => void
  getCollider: (handle: number) => RapierCollider | null | undefined
}

/** Cached handle of our chassis collider (the vehicle tags it { kind: 'car', id: 'player' }). */
let playerColliderHandle = -1
let lastScanAt = 0

/** Our own chassis body. Uses the cached handle; rescans at most twice a second when it is lost. */
function playerBody(world: ColliderWorld): RapierRigidBody | null {
  if (playerColliderHandle >= 0 && ownerOf(playerColliderHandle)?.id === 'player') {
    const c = world.getCollider(playerColliderHandle)
    if (c) return c.parent() as RapierRigidBody | null
  }
  const now = performance.now()
  if (now - lastScanAt < 500) return null
  lastScanAt = now
  playerColliderHandle = -1
  world.forEachCollider((c) => {
    if (playerColliderHandle < 0 && ownerOf(c.handle)?.id === 'player') playerColliderHandle = c.handle
  })
  if (playerColliderHandle < 0) return null
  return (world.getCollider(playerColliderHandle)?.parent() as RapierRigidBody | null) ?? null
}

/**
 * Every physics step, before it runs: remember our velocity (for working out
 * a ram after the step) and apply any bumps other players sent us.
 * Mounted by NetLayer.
 */
export function BumpApplier() {
  const { world } = useRapier()
  useBeforePhysicsStep(() => {
    const body = playerBody(world as unknown as ColliderWorld)
    if (!body) {
      preStep.valid = false
      pending.length = 0
      return
    }
    const v = body.linvel()
    const w = body.angvel()
    preStep.x = v.x
    preStep.y = v.y
    preStep.z = v.z
    preStep.ax = w.x
    preStep.ay = w.y
    preStep.az = w.z
    preStep.valid = Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z) && Number.isFinite(w.x) && Number.isFinite(w.y) && Number.isFinite(w.z)
    if (pending.length === 0) return
    let x = v.x
    let y = v.y
    let z = v.z
    for (let i = 0; i < pending.length; i++) {
      x += pending[i].x
      y += pending[i].y
      z += pending[i].z
    }
    pending.length = 0
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return
    _sum.x = x
    _sum.y = y
    _sum.z = z
    body.setLinvel(_sum, true)
    stats.applied++
  })
  return null
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => stopBumps())
}
