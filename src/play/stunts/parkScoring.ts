// ============================================================
//  STUNT PARK SCORING - rings, named gaps and bullseye landings
// ------------------------------------------------------------
//  The park scores through the trick detector (src/vehicle/
//  tricks.ts), so its stunts are part of the jump they belong to:
//  one combo per jump, banked at the landing, lost on a wipeout.
//  This is the detector's "air judge" (tricks.ts AirJudge). It is
//  told when the car takes off, every step it flies, when it
//  touches down and when the jump scores, and it adds:
//
//    RING          flying through a ring (150; a chain of rings in
//                  one jump grows: 2 rings 450, 3 rings 900)
//    a named gap   taking off from a gap's launch and landing past
//                  the gap ("NEON CANYON GAP" 500 ... MEGA RAMP 1500)
//    BULLSEYE      landing on a target pad: the whole jump's points
//                  x2 on the outer ring, x3 on the inner one
//
//  Events (core/events.ts): stunt.ring the moment a ring is passed
//  (sound and flash right away), stunt.gap and stunt.target at the
//  landing, just before its trick.land.
//
//  Everything here runs inside the player's physics step and
//  allocates nothing except when it announces something.
// ============================================================

import { emit } from '../../core/events'
import { fx } from '../../core/api'
import { PALETTE } from '../../core/palette'
import type { AirJudge, Trick, TrickInput } from '../../vehicle/tricks'
import { parkLive } from './parkLive'
import { RING_MARGIN } from './parkLayout'
import type { FrameBox, ParkLayout } from './parkLayout'

/** Points for one ring; a chain of n rings in one jump scores RING_POINTS x (1 + 2 + ... + n). */
export const RING_POINTS = 150
/** Most rings one jump can chain (more than any zone has). */
const MAX_CHAIN = 8
/** A target counts a touchdown this far above or below its top (metres). */
const TARGET_HEIGHT = 2.5

/** Is (x, z) inside a box in a piece frame? */
function inBox(b: FrameBox, x: number, z: number): boolean {
  const f = b.frame
  const px = x - f.ox
  const pz = z - f.oz
  const a = px * f.dx + pz * f.dz
  const l = -px * f.dz + pz * f.dx
  return a >= b.a0 && a <= b.a1 && Math.abs(l) <= b.hw
}

/** The jump in progress, as the judge sees it. */
const jump = {
  open: false,
  /** The named jump whose launch the car took off from (-1 = none). */
  launch: -1,
  /** Rings passed in this jump, in order. */
  chain: 0,
  rings: new Int32Array(MAX_CHAIN),
  /** Where the car was last step (for the ring crossing test). */
  hasPrev: false,
  px: 0,
  py: 0,
  pz: 0,
  /** Where it touched down. */
  hasTouch: false,
  tx: 0,
  ty: 0,
  tz: 0,
}

function reset(): void {
  jump.open = false
  jump.launch = -1
  jump.chain = 0
  jump.hasPrev = false
  jump.hasTouch = false
}

function ringPoints(n: number): number {
  return (RING_POINTS * n * (n + 1)) / 2
}

/** Did the car's path this step pass through ring i? */
function throughRing(L: ParkLayout, i: number, x: number, y: number, z: number): boolean {
  const r = L.rings[i]
  const d1 = (x - r.x) * r.nx + (y - r.y) * r.ny + (z - r.z) * r.nz
  const d0 = (jump.px - r.x) * r.nx + (jump.py - r.y) * r.ny + (jump.pz - r.z) * r.nz
  // It must cross the ring's plane this step (either way: a car flying backwards counts too).
  if ((d0 < 0 && d1 < 0) || (d0 > 0 && d1 > 0) || d0 === d1) return false
  const t = d0 / (d0 - d1)
  const cx = jump.px + (x - jump.px) * t - r.x
  const cy = jump.py + (y - jump.py) * t - r.y
  const cz = jump.pz + (z - jump.pz) * t - r.z
  return cx * cx + cy * cy + cz * cz <= (r.radius - RING_MARGIN) * (r.radius - RING_MARGIN)
}

const _pulse = { x: 0, y: 0, z: 0 }

export const parkJudge: AirJudge = {
  takeoff(c: TrickInput): void {
    reset()
    const L = parkLive.layout
    if (!L) return
    jump.open = true
    for (let i = 0; i < L.jumps.length; i++) {
      if (inBox(L.jumps[i].launch, c.pos.x, c.pos.z)) {
        jump.launch = i
        break
      }
    }
    jump.hasPrev = true
    jump.px = c.pos.x
    jump.py = c.pos.y
    jump.pz = c.pos.z
  },

  air(c: TrickInput): void {
    const L = parkLive.layout
    if (!L || !jump.open) return
    const x = c.pos.x
    const y = c.pos.y
    const z = c.pos.z
    if (jump.hasPrev && jump.chain < MAX_CHAIN) {
      for (let i = 0; i < L.rings.length; i++) {
        const r = L.rings[i]
        // Cheap reject first: only rings within reach of this step's path.
        const dx = x - r.x
        const dy = y - r.y
        const dz = z - r.z
        if (dx * dx + dy * dy + dz * dz > (r.radius + 12) * (r.radius + 12)) continue
        let seen = false
        for (let k = 0; k < jump.chain; k++) if (jump.rings[k] === i) seen = true
        if (seen || !throughRing(L, i, x, y, z)) continue
        jump.rings[jump.chain++] = i
        parkLive.ringFlash[i] = 1
        _pulse.x = r.x
        _pulse.y = r.y
        _pulse.z = r.z
        fx.pulse(_pulse, PALETTE.core, r.radius * 1.25)
        emit('stunt.ring', { ring: r.id, chain: jump.chain })
      }
    }
    jump.hasPrev = true
    jump.px = x
    jump.py = y
    jump.pz = z
  },

  touchdown(c: TrickInput): void {
    if (!jump.open) return
    jump.hasTouch = true
    jump.tx = c.pos.x
    jump.ty = c.pos.y
    jump.tz = c.pos.z
  },

  land(tricks: Trick[]): number {
    const L = parkLive.layout
    if (!L || !jump.open) {
      reset()
      return 1
    }
    if (jump.chain > 0) {
      tricks.push({ name: 'ring', label: jump.chain === 1 ? 'RING' : `${jump.chain} RING CHAIN`, points: ringPoints(jump.chain) })
    }
    let mult = 1
    if (jump.hasTouch) {
      const j = jump.launch >= 0 ? L.jumps[jump.launch] : null
      if (j && inBox(j.landing, jump.tx, jump.tz)) {
        tricks.push({ name: 'gap', label: j.name, points: j.points })
        emit('stunt.gap', { name: j.name, points: j.points })
      }
      for (const t of L.targets) {
        const dx = jump.tx - t.x
        const dz = jump.tz - t.z
        const d2 = dx * dx + dz * dz
        if (d2 > t.outer * t.outer || Math.abs(jump.ty - t.y) > TARGET_HEIGHT) continue
        // A target only multiplies a jump that scored something.
        if (tricks.length === 0) break
        const inner = d2 <= t.inner * t.inner
        mult = inner ? 3 : 2
        emit('stunt.target', { multiplier: mult, ring: inner ? 'inner' : 'outer' })
        break
      }
    }
    reset()
    return mult
  },

  pending(): number {
    return jump.open ? ringPoints(jump.chain) : 0
  },

  links(): number {
    // A chain of rings is one trick at the landing (RING, 2 RING CHAIN...), so one link.
    return jump.open && jump.chain > 0 ? 1 : 0
  },

  drop(): void {
    reset()
  },
}

// ---------------------------------------------------------------- rewind

/** Numbers in one rewind snapshot of the judge. */
export const PARK_REWIND_FLOATS = 11 + MAX_CHAIN

/** Rewind: save the jump in progress (so a rewound jump scores its rings once, as one jump). */
export function saveParkJudge(out: Float64Array, at: number): void {
  out[at] = jump.open ? 1 : 0
  out[at + 1] = jump.launch
  out[at + 2] = jump.chain
  out[at + 3] = jump.hasPrev ? 1 : 0
  out[at + 4] = jump.px
  out[at + 5] = jump.py
  out[at + 6] = jump.pz
  out[at + 7] = jump.hasTouch ? 1 : 0
  out[at + 8] = jump.tx
  out[at + 9] = jump.ty
  out[at + 10] = jump.tz
  for (let k = 0; k < MAX_CHAIN; k++) out[at + 11 + k] = jump.rings[k]
}

/** Rewind: carry on from a saved moment. A broken number drops the jump rather than scoring it. */
export function loadParkJudge(src: Float64Array, at: number): void {
  for (let k = 0; k < 11 + MAX_CHAIN; k++) {
    if (!Number.isFinite(src[at + k])) {
      reset()
      return
    }
  }
  jump.open = src[at] === 1
  jump.launch = src[at + 1] | 0
  jump.chain = Math.max(0, Math.min(MAX_CHAIN, src[at + 2] | 0))
  jump.hasPrev = src[at + 3] === 1
  jump.px = src[at + 4]
  jump.py = src[at + 5]
  jump.pz = src[at + 6]
  jump.hasTouch = src[at + 7] === 1
  jump.tx = src[at + 8]
  jump.ty = src[at + 9]
  jump.tz = src[at + 10]
  for (let k = 0; k < MAX_CHAIN; k++) jump.rings[k] = src[at + 11 + k] | 0
}

/** Forget any jump in progress (the park unmounted, the track changed). */
export function resetParkJudge(): void {
  reset()
}
