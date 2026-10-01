// ============================================================
//  INTENSITY - how exciting the drive is right now, 0..1
// ------------------------------------------------------------
//  The music arranger reads this number to pick its sections:
//  low = intro / groove / breakdown, high = build and drop.
//
//  It rises with:  speed, boost, time in the air, a race running,
//                  the final lap, a close fight with another car,
//                  the last ten seconds of a stunt run.
//  It is smoothed: quick to rise (about a second), slow to fall
//  (a few seconds), so a single bump never flips the music.
//
//  update() runs every frame and allocates nothing.
// ============================================================

import { cars, telemetry } from '../core/telemetry'
import { getGame } from '../core/store'
import { getSettings } from '../core/settings'
import { getTrack } from '../track/current'
import type { EngineInput } from './engine'
import { clamp01, smoothstep } from './synth'

/** Within this many metres of another car counts as close racing. */
const CLOSE_RACING_M = 30
/** Seconds between close-racing checks (it loops over every car). */
const CLOSE_CHECK_S = 0.25

export class Intensity {
  value = 0
  /** The raw (unsmoothed) target, for the inspector. */
  target = 0
  finalLap = false
  closeRacing = 0
  private closeTimer = 0

  update(e: EngineInput, dt: number): number {
    const g = getGame()
    const top = Math.max(80, getSettings().topSpeedKmh)
    const speedN = clamp01(Math.abs(e.speedKmh) / top)
    let target = 0.62 * smoothstep(0.04, 0.85, speedN) + 0.3 * clamp01(e.boost)
    if (e.airborne) target += 0.12 + 0.1 * Math.min(telemetry.airTime, 2)

    const racing = g.raceState === 'running'
    this.finalLap = racing && g.raceLaps > 1 && g.lapCount >= g.raceLaps - 1
    if (racing) {
      target += 0.1
      if (this.finalLap) target += 0.2
      this.closeTimer -= dt
      if (this.closeTimer <= 0) {
        this.closeTimer = CLOSE_CHECK_S
        this.closeRacing = closeRacingBonus()
      }
      target += this.closeRacing
    } else {
      this.closeRacing = 0
    }
    if (g.stuntEndsAt > 0) {
      const left = (g.stuntEndsAt - performance.now()) / 1000
      if (left > 0 && left < 10) target += 0.2
    }

    this.target = clamp01(target)
    const tau = this.target > this.value ? 1.1 : 3.5
    this.value += (this.target - this.value) * (1 - Math.exp(-dt / tau))
    return this.value
  }
}

/** 0..0.15: how close the nearest rival is, by distance along the road. */
function closeRacingBonus(): number {
  const track = getTrack()
  if (!track) return 0
  let me = -1
  for (let i = 0; i < cars.length; i++) if (cars[i].kind === 'player') me = i
  if (me < 0) return 0
  const mine = cars[me].progress
  let nearest = Number.POSITIVE_INFINITY
  for (let i = 0; i < cars.length; i++) {
    const c = cars[i]
    if (i === me || (c.kind !== 'ai' && c.kind !== 'remote')) continue
    const d = Math.abs(c.progress - mine) * track.length
    if (d < nearest) nearest = d
  }
  return nearest < CLOSE_RACING_M ? 0.15 * (1 - nearest / CLOSE_RACING_M) : 0
}
