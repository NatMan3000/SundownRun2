// ============================================================
//  ENGINE TEST DRIVE - a scripted run for hearing the engine
// ------------------------------------------------------------
//  Lets anyone hear (or render) every engine layer without a car:
//  __dev.audio('sweep') plays it live, and render.ts records it.
//  sweepInput(seconds, out) says what the "car" is doing at each
//  moment of the 13-second run.
// ============================================================

import type { EngineInput } from './engine'
import { smoothstep } from './synth'

/** How long the scripted drive lasts, seconds. */
export const SWEEP_SECONDS = 13

/**
 * The scripted engine test drive, as a function of seconds since start.
 * Writes into `out` (no allocation). Timeline:
 *   0-1.5  idle            1.5-6.5  full throttle through gears 1-4
 *   6.5-8  jump: airborne, throttle held (free-rev up), lift at 7.4 (falls)
 *   8      land            8.3-9.5  drift (slip high)
 *   9.5    boost kick      10-11.2  off-road     11.2-12.6 loop (mag grip)
 */
export function sweepInput(s: number, out: EngineInput): void {
  out.drifting = false
  out.slip = 0
  out.airborne = false
  out.onRoad = true
  out.offRoad = false
  out.magStrength = 0
  out.boost = 0
  if (s < 1.5) {
    out.rpm = 0.12
    out.throttle = 0
    out.speedKmh = 0
    out.gear = 1
    return
  }
  if (s < 6.5) {
    // Four gears of 1.25 s each: rpm climbs from 0.35 to 0.95, then drops on the shift.
    const u = (s - 1.5) / 1.25
    const gear = Math.min(4, Math.floor(u) + 1)
    const inGear = u - (gear - 1)
    out.gear = gear
    out.throttle = 1
    out.rpm = (gear === 1 ? 0.15 : 0.5) + (0.95 - (gear === 1 ? 0.15 : 0.5)) * Math.min(1, inGear)
    out.speedKmh = 20 + (s - 1.5) * 34
    return
  }
  out.gear = 4
  out.speedKmh = 190
  if (s < 8) {
    out.airborne = true
    const air = s - 6.5
    out.throttle = air < 0.9 ? 1 : 0
    out.rpm = air < 0.9 ? 0.7 + 0.3 * smoothstep(0, 0.6, air) : 1 - 0.55 * smoothstep(0.9, 1.5, air)
    return
  }
  out.throttle = 0.8
  out.rpm = 0.72
  if (s < 8.3) return
  if (s < 9.5) {
    out.drifting = true
    out.slip = 0.75
    out.speedKmh = 150
    out.rpm = 0.78
    return
  }
  if (s < 10) {
    out.boost = 1 - (s - 9.5) * 0.6
    out.speedKmh = 230
    out.rpm = 0.9
    return
  }
  if (s < 11.2) {
    out.onRoad = false
    out.offRoad = true
    out.speedKmh = 90
    out.rpm = 0.55
    out.gear = 3
    out.slip = 0.25
    return
  }
  out.magStrength = 1
  out.speedKmh = 160
  out.rpm = 0.8
}
