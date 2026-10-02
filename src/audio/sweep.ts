// ============================================================
//  ENGINE TEST DRIVES - scripted runs for hearing the engine
// ------------------------------------------------------------
//  Lets anyone hear (or render) every engine layer without a car:
//  __dev.audio('sweep') plays it live, and render.ts records it.
//  sweepInput(seconds, out) says what the "car" is doing at each
//  moment of the 18-second run. The rpm follows what the real
//  gearbox does (src/vehicle/carSim.ts): after an upshift it drops
//  to about 0.2 and climbs back to about 0.97 before the next one.
//
//  driftInput() further down is a second run, all about the tyres:
//  long drifts, a big one, a small slide and a slide on the grass.
//  speedInput() is a third, all about going fast: every gear up to
//  250 km/h, held there, a boost pad, then a lift.
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

// ============================================================
//  TYRE TEST DRIVE - 19 seconds of sliding, for hearing the tyres
// ------------------------------------------------------------
//  __dev.audio('sweep', 'drift') plays it live and
//  __dev.audio('render', 'drift', 'muscle') records it. The slip
//  rises and falls the way the real car's does (logged from a
//  handbrake drift on Afterglow): about 0.4 s to break grip, flat
//  at 1 through a big drift, about 0.5 s to catch it again.
// ============================================================

/** How long the tyre test drive lasts, seconds. */
export const DRIFT_SECONDS = 19

/** Where each part of the tyre test drive starts (seconds). */
export const DRIFT_MARKS = {
  cruise: 0, //      60 km/h in 2nd, tyres gripping
  break60: 1.2, //   the back steps out
  drift60: 1.6, //   a long drift at 60 km/h (what Josh was doing)
  catch60: 6.6, //   grip comes back
  pull: 7.1, //      full throttle up to 120 km/h
  break120: 9.2, //  the back steps out again
  drift120: 9.55, // a big drift at 120 km/h
  catch120: 13.55,
  straight: 14.05,
  slide: 15.0, //    a small slide through a fast bend
  offRoad: 17.0, //  sliding on the grass and dirt
  end: 18.5,
} as const

/** Driver feathering the throttle in a drift: a slow, uneven wobble (two sines). */
function feather(s: number): number {
  return 0.6 * Math.sin(s * 2 * Math.PI * 1.3) + 0.4 * Math.sin(s * 2 * Math.PI * 0.55 + 1)
}

/**
 * The tyre test drive, as a function of seconds since start.
 * Writes into `out` (no allocation). See DRIFT_MARKS for the timeline.
 */
export function driftInput(s: number, out: EngineInput): void {
  const M = DRIFT_MARKS
  out.airborne = false
  out.onRoad = true
  out.offRoad = false
  out.magStrength = 0
  out.boost = 0
  out.slip = 0
  out.gear = 2
  if (s < M.break60) {
    out.speedKmh = 60
    out.throttle = 0.45
    out.rpm = 0.55
  } else if (s < M.pull) {
    // Break, hold a long drift at about 60 km/h, then catch it.
    out.speedKmh = 60 + 3 * Math.sin(s * 1.7)
    out.throttle = 0.72 + 0.15 * feather(s)
    out.rpm = 0.72 + 0.05 * feather(s + 0.2)
    if (s < M.drift60) out.slip = smoothstep(M.break60, M.drift60, s)
    else if (s < M.catch60) out.slip = 0.92 + 0.08 * Math.sin(s * 2 * Math.PI * 0.7)
    else out.slip = 0.92 * (1 - smoothstep(M.catch60, M.pull, s))
  } else if (s < M.break120) {
    // Full throttle from 60 to 120 km/h: the top of 2nd, then 3rd.
    const u = (s - M.pull) / (M.break120 - M.pull)
    out.throttle = 1
    out.speedKmh = 60 + 60 * u
    if (u < 0.4) {
      out.rpm = 0.62 + 0.35 * (u / 0.4)
    } else {
      out.gear = 3
      out.rpm = 0.45 + 0.35 * ((u - 0.4) / 0.6)
    }
  } else if (s < M.straight) {
    // A big drift at 120 km/h, scrubbing speed off, then the catch.
    out.gear = 3
    out.speedKmh = 120 - 15 * smoothstep(M.break120, M.catch120, s)
    out.throttle = 0.75 + 0.15 * feather(s)
    out.rpm = 0.76 + 0.05 * feather(s + 0.2)
    if (s < M.drift120) out.slip = smoothstep(M.break120, M.drift120, s)
    else if (s < M.catch120) out.slip = 1
    else out.slip = 1 - smoothstep(M.catch120, M.straight, s)
  } else if (s < M.offRoad) {
    // Straight, then a small slide (a bend taken a little too fast).
    out.gear = 3
    out.speedKmh = 105 - 10 * smoothstep(M.straight, M.slide + 1, s)
    out.throttle = 0.6
    out.rpm = 0.66
    if (s >= M.slide) out.slip = 0.36 * Math.sin((Math.PI * (s - M.slide)) / (M.offRoad - M.slide))
  } else {
    // Sliding off the road onto the grass, then rolling to a stop.
    out.onRoad = false
    out.offRoad = true
    out.speedKmh = 70 * (1 - smoothstep(M.offRoad, DRIFT_SECONDS, s))
    out.throttle = s < M.end ? 0.5 : 0
    out.rpm = s < M.end ? 0.6 : 0.3
    out.slip = s < M.end ? 0.8 * smoothstep(M.offRoad, M.offRoad + 0.3, s) : 0.8 * (1 - smoothstep(M.end, M.end + 0.4, s))
  }
  out.drifting = out.slip > 0.25
}

// ============================================================
//  TOP SPEED TEST DRIVE - 19 seconds of going fast
// ------------------------------------------------------------
//  __dev.audio('sweep', 'speed') plays it live and
//  __dev.audio('render', 'speed', 'muscle') records it. Full throttle
//  through all six gears to 250 km/h, hold it, hit a boost pad, lift.
//  The rpm in each gear is what the real gearbox gives at that speed.
// ============================================================

/** How long the top speed test drive lasts, seconds. */
export const SPEED_SECONDS = 19

/**
 * Top speed of each gear, km/h. A copy of GEAR_TOP_KMH in src/vehicle/tuning.ts
 * (audio keeps its own so it does not reach into the car's files).
 */
const GEAR_TOP = [56, 96, 138, 178, 218, 270]

/** Where each part of the top speed drive starts (seconds), and the moments the checks measure. */
export const SPEED_MARKS = {
  pull: 0.4, //    full throttle from a standstill
  at150: 4.7, //   passing 150 km/h in 4th
  at200: 7.5, //   passing 200 km/h in 5th
  hold: 11.0, //   250 km/h in 6th, held
  boost: 14.0, //  a boost pad
  lift: 15.5, //   off the throttle
} as const

/** Seconds spent in each gear on the pull (the last one ends at 250 km/h). */
const GEAR_TIME = [1.0, 1.2, 1.5, 2.0, 2.5, 2.4]

/** The rpm the gearbox gives at this speed in this gear (carSim.ts updateGearAndRpm). */
function gearRpm(gear: number, kmh: number): number {
  const lo = gear === 1 ? 0 : GEAR_TOP[gear - 2]
  const hi = GEAR_TOP[gear - 1]
  const frac = Math.min(1, Math.max(-0.19, (kmh - lo) / (hi - lo)))
  return Math.max(0.14, 0.2 + 0.78 * frac)
}

/**
 * The top speed test drive, as a function of seconds since start.
 * Writes into `out` (no allocation). See SPEED_MARKS for the timeline.
 */
export function speedInput(s: number, out: EngineInput): void {
  const M = SPEED_MARKS
  out.airborne = false
  out.onRoad = true
  out.offRoad = false
  out.magStrength = 0
  out.boost = 0
  out.slip = 0
  out.drifting = false
  if (s < M.pull) {
    out.gear = 1
    out.speedKmh = 0
    out.throttle = 0
    out.rpm = 0.1
    return
  }
  if (s < M.hold) {
    // The pull: each gear from its bottom speed to its top (6th stops at 250).
    let u = s - M.pull
    let gear = 1
    while (gear < 6 && u >= GEAR_TIME[gear - 1]) {
      u -= GEAR_TIME[gear - 1]
      gear++
    }
    const lo = gear === 1 ? 0 : GEAR_TOP[gear - 2]
    const hi = gear === 6 ? 250 : GEAR_TOP[gear - 1]
    out.gear = gear
    out.throttle = 1
    out.speedKmh = lo + (hi - lo) * Math.min(1, u / GEAR_TIME[gear - 1])
    out.rpm = gearRpm(gear, out.speedKmh)
    return
  }
  out.gear = 6
  if (s < M.boost) {
    out.throttle = 1
    out.speedKmh = 250
  } else if (s < M.lift) {
    // A boost pad: the kick fades over 1.5 s and carries the car past 250.
    const u = (s - M.boost) / (M.lift - M.boost)
    out.throttle = 1
    out.boost = 1 - smoothstep(0, 1, u)
    out.speedKmh = 250 + 14 * Math.sin(Math.PI * Math.min(1, u * 0.8))
  } else {
    // Lift: the car coasts down from top speed.
    out.throttle = 0
    out.speedKmh = 252 - 45 * smoothstep(M.lift, SPEED_SECONDS, s)
  }
  out.rpm = gearRpm(6, out.speedKmh)
}

/** The scripted drives, by name: the engine, the tyres, and top speed. */
export const TEST_DRIVES = {
  sweep: { seconds: SWEEP_SECONDS, input: sweepInput },
  drift: { seconds: DRIFT_SECONDS, input: driftInput },
  speed: { seconds: SPEED_SECONDS, input: speedInput },
} as const

export type TestDriveId = keyof typeof TEST_DRIVES

export function isTestDrive(id: string): id is TestDriveId {
  // hasOwnProperty, not `in`: 'toString' is "in" every object.
  return Object.prototype.hasOwnProperty.call(TEST_DRIVES, id)
}
