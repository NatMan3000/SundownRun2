// ============================================================
//  HUNT TURNS FX - what the pulse and a catch look like
// ------------------------------------------------------------
//  Listens to the event feed (the game logic is net/turns.ts) and
//  draws through look's fx API, in the hunter's colour (tag's "it"):
//    turns.pulse   a ring on the ground as wide as the pulse reaches,
//                  and a spray of sparks flying forward through its
//                  cone, so both players see it fire
//    turns.catch   a burst where the runner was caught
//    turns.thrown  a flash where our car vanished and where it landed
// ============================================================

import { on } from '../core/events'
import { fx } from '../core/api'
import { getCar } from '../core/telemetry'
import { PALETTE } from '../core/palette'

const _at = { x: 0, y: 0, z: 0 }
const _v = { x: 0, y: 0, z: 0 }

/** Start drawing Hunt Turns' moments. Returns the stop function. */
export function installTurnsFx(): () => void {
  const offs = [
    on('turns.pulse', (e) => {
      if (!Number.isFinite(e.x + e.y + e.z + e.dx + e.dz + e.range)) return
      _at.x = e.x
      _at.y = e.y
      _at.z = e.z
      fx.pulse(_at, PALETTE.tagIt, Math.max(2, e.range))
      // The spray: out through the cone, about as far as the pulse reaches in its short life.
      _at.y = e.y + 0.8
      _v.x = e.dx * e.range * 2.2
      _v.y = 1.5
      _v.z = e.dz * e.range * 2.2
      fx.shards({ position: _at, velocity: _v, color: PALETTE.tagIt, count: 48, speed: 4 + e.range * Math.sin((Math.min(170, e.coneDeg) * Math.PI) / 360), size: 0.32, life: 0.45 })
    }),
    on('turns.catch', (e) => {
      const c = getCar(e.runnerId)
      if (!c) return
      _at.x = c.position.x
      _at.y = c.position.y + 0.6
      _at.z = c.position.z
      if (!Number.isFinite(_at.x + _at.y + _at.z)) return
      fx.shards({ position: _at, color: PALETTE.tagIt, count: 40, speed: 9, size: 0.3, life: 0.8 })
    }),
    on('turns.thrown', (e) => {
      _at.x = e.fromX
      _at.y = e.y
      _at.z = e.fromZ
      fx.pulse(_at, PALETTE.tagIt, 5)
      _at.x = e.x
      _at.z = e.z
      fx.pulse(_at, PALETTE.uiAccent, 7)
    }),
  ]
  return () => {
    for (const off of offs) off()
  }
}
