// ============================================================
//  ENGINE TEST DRIVE - a scripted run for hearing the engine
// ------------------------------------------------------------
//  Lets anyone hear (or render) every engine layer without a car:
//  __dev.audio('sweep') plays it live, and render.ts records it.
//  sweepInput(seconds, out) says what the "car" is doing at each
//  moment of the 18-second run. The rpm follows what the real
//  gearbox does (src/vehicle/carSim.ts): after an upshift it drops
//  to about 0.2 and climbs back to about 0.97 before the next one.
// ============================================================

import type { EngineInput } from './engine'
import { smoothstep } from './synth'

/** How long the scripted drive lasts, seconds. */
export const SWEEP_SECONDS = 18

/**
 * Where each part of the drive starts (seconds). Exported so the render
 * checks can measure the same moments the drive plays.
 */
export const SWEEP_MARKS = {
  idle: 0,
  blips: 1.6, //    two stabs of throttle, standing still
  gears: 2.9, //    full throttle, gears 1 to 4
  cruise: 8.1, //   steady part throttle in 5th
  kick: 10.0, //    floor it again (the turbo spools)
  lift: 10.7, //    lift off at high revs (overrun pops, blow-off)
  jump: 11.9, //    airborne: throttle held (free-rev up), then lifted
  land: 13.4,
  drift: 13.7,
  boost: 14.9,
  offRoad: 15.4,
  mag: 16.6, //     magnetic grip (a loop)
} as const

/** A quick stab of throttle at standstill: rpm jumps up then falls back to idle. */
function blip(u: number): number {
  if (u < 0 || u > 0.75) return 0
  return u < 0.22 ? smoothstep(0, 0.22, u) : 1 - smoothstep(0.22, 0.75, u)
}

/**
 * The scripted engine test drive, as a function of seconds since start.
 * Writes into `out` (no allocation). See SWEEP_MARKS for the timeline.
 */
export function sweepInput(s: number, out: EngineInput): void {
  const M = SWEEP_MARKS
  out.drifting = false
  out.slip = 0
  out.airborne = false
  out.onRoad = true
  out.offRoad = false
  out.magStrength = 0
  out.boost = 0
  if (s < M.gears) {
    // Idle, then two blips of the throttle in neutral.
    const a = blip(s - M.blips)
    const b = blip(s - (M.blips + 0.6))
    out.gear = 1
    out.speedKmh = 0
    out.throttle = (s - M.blips >= 0 && s - M.blips < 0.2) || (s - M.blips >= 0.6 && s - M.blips < 0.8) ? 1 : 0
    out.rpm = 0.1 + 0.32 * Math.max(a, b)
    return
  }
  if (s < M.cruise) {
    // Gear 1 for 1 s from a standing start (rpm 0.4 -> 0.97), then gears 2-4 for 1.4 s each (0.2 -> 0.97).
    const u = s - M.gears
    out.throttle = 1
    if (u < 1) {
      out.gear = 1
      out.rpm = 0.4 + 0.57 * u
      out.speedKmh = 3 + 53 * u
      return
    }
    const g = Math.min(2, Math.floor((u - 1) / 1.4))
    const inGear = (u - 1 - g * 1.4) / 1.4
    out.gear = 2 + g
    out.rpm = 0.2 + 0.77 * inGear
    out.speedKmh = 56 + (g + inGear) * 41
    return
  }
  if (s < M.kick) {
    out.gear = 5
    out.throttle = 0.35
    out.rpm = 0.55
    out.speedKmh = 180
    return
  }
  if (s < M.lift) {
    const u = (s - M.kick) / (M.lift - M.kick)
    out.gear = 5
    out.throttle = 1
    out.rpm = 0.55 + 0.3 * smoothstep(0, 1, u)
    out.speedKmh = 180 + 15 * u
    return
  }
  if (s < M.jump) {
    // Off the throttle at high revs: the engine brakes and the revs fall.
    const u = (s - M.lift) / (M.jump - M.lift)
    out.gear = 5
    out.throttle = 0
    out.rpm = 0.85 - 0.35 * smoothstep(0, 1, u)
    out.speedKmh = 195 - 20 * u
    return
  }
  out.gear = 4
  out.speedKmh = 190
  if (s < M.land) {
    out.airborne = true
    const air = s - M.jump
    out.throttle = air < 0.9 ? 1 : 0
    out.rpm = air < 0.9 ? 0.7 + 0.3 * smoothstep(0, 0.6, air) : 1 - 0.55 * smoothstep(0.9, 1.5, air)
    return
  }
  out.throttle = 0.8
  out.rpm = 0.72
  if (s < M.drift) return
  if (s < M.boost) {
    out.drifting = true
    out.slip = 0.75
    out.speedKmh = 150
    out.rpm = 0.78
    return
  }
  if (s < M.offRoad) {
    out.boost = 1 - (s - M.boost) * 0.6
    out.speedKmh = 230
    out.rpm = 0.9
    return
  }
  if (s < M.mag) {
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
