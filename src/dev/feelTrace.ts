// ============================================================
//  FEEL TRACE - a 60 Hz flight recorder for the player's car
// ------------------------------------------------------------
//  How the feel standard gets measured, the way v1's checkers did
//  it: start a trace, drive a manoeuvre (with the probe holding
//  keys, or a real pad), then read every physics step back.
//
//    window.__dev.trace(8)        record the next 8 seconds
//    window.__dev.traceGet(6)     read it, one row every 6 steps
//
//  Channels: t (s), kmh, drift (deg), yaw (deg/s), steer, throttle,
//  brake, hb, air, wheels, latG, up (car up . world up), rpm, mag,
//  x, y, z, s, lat, slip, drifting, hbBody (signed forward km/h),
//  boost (envelope 0..1), rack (road-wheel angle, deg), aF / aR (front /
//  rear slip angle, deg, axle average), fyF / fyR (axle sideways force, kN)
//  fxF / fxR (axle forward force, kN; braking is negative) and
//  nFL / nFR / nRL / nRR (each wheel's suspension load, kN; 0 = off the ground)
//  loopG (the turn a loop is asking for, in g; 0 off a loop) and the loop
//  guidance: gLatV (sideways speed, m/s), gAcc (its correction, m/s^2) and
//  gHead (heading error to the road, deg); hgt = the car's height above the
//  road surface (m, ~0.54 sitting on its wheels); suspG = all four springs'
//  push in g of the car's weight (1 at rest on the flat); body = the chassis
//  touching the world (only with trace(s, true)); imp = impact 0..1; and the
//  loop's force budget along the ground normal, m/s^2 (Lsup support, Lspr
//  springs, Lmag magnet, Lgrav gravity, Lacc measured, Lk curvature 1/m).
//  Buffers are preallocated: recording costs a few array writes per step
//  and nothing at all when idle.
// ============================================================

import type { CarSim } from '../vehicle/carSim'
import { DT, GRAVITY } from '../vehicle/tuning'

const CHANNELS = ['t', 'kmh', 'drift', 'yaw', 'steer', 'throttle', 'brake', 'hb', 'air', 'wheels', 'latG', 'up', 'rpm', 'mag', 'x', 'y', 'z', 's', 'lat', 'slip', 'drifting', 'hbBody', 'boost', 'rack', 'aF', 'aR', 'fyF', 'fyR', 'fxF', 'fxR', 'nFL', 'nFR', 'nRL', 'nRR', 'loopG', 'gLatV', 'gAcc', 'gHead', 'hgt', 'suspG', 'body', 'imp', 'Lsup', 'Lspr', 'Lmag', 'Lgrav', 'Lacc', 'Lk'] as const
const MAX_STEPS = 60 * 60
const RAD2DEG = 180 / Math.PI

const buf = new Float32Array(MAX_STEPS * CHANNELS.length)
let count = 0
let remaining = 0

export const feelTrace = {
  /** Start recording for `seconds` (max 60). `body` = 1 also probes the chassis for contact every step. */
  start(seconds: number, sim?: CarSim | null, probeBody = false): void {
    if (sim) sim.debugProbeChassis = probeBody
    count = 0
    remaining = Math.min(MAX_STEPS, Math.max(1, Math.round(seconds / DT)))
  },

  get recording(): boolean {
    return remaining > 0
  },

  /** Called by the player's car after every physics step. */
  sample(s: CarSim): void {
    if (remaining <= 0) return
    remaining--
    const o = count * CHANNELS.length
    const c = s.controls
    buf[o] = count * DT
    buf[o + 1] = s.speedKmh
    buf[o + 2] = s.driftAngle * RAD2DEG
    buf[o + 3] = s.angvel.dot(s.up) * RAD2DEG
    buf[o + 4] = c.steer
    buf[o + 5] = c.throttle
    buf[o + 6] = c.brake
    buf[o + 7] = c.handbrake ? 1 : 0
    buf[o + 8] = s.airborne ? 1 : 0
    buf[o + 9] = s.wheelsDown
    buf[o + 10] = s.latAccel / GRAVITY
    buf[o + 11] = s.upright
    buf[o + 12] = s.rpm
    buf[o + 13] = s.magStrength
    buf[o + 14] = s.pos.x
    buf[o + 15] = s.pos.y
    buf[o + 16] = s.pos.z
    buf[o + 17] = s.trackS
    buf[o + 18] = s.lateral
    buf[o + 19] = s.slip
    buf[o + 20] = s.drifting ? 1 : 0
    buf[o + 21] = s.forwardSpeed * 3.6
    const ty = s.debugTyre
    buf[o + 22] = s.boost
    buf[o + 23] = s.steerAngle * RAD2DEG
    buf[o + 24] = ((ty[0] + ty[4]) / 2) * RAD2DEG
    buf[o + 25] = ((ty[8] + ty[12]) / 2) * RAD2DEG
    buf[o + 26] = (ty[1] + ty[5]) / 1000
    buf[o + 27] = (ty[9] + ty[13]) / 1000
    buf[o + 28] = (ty[2] + ty[6]) / 1000
    buf[o + 29] = (ty[10] + ty[14]) / 1000
    buf[o + 30] = ty[3] / 1000
    buf[o + 31] = ty[7] / 1000
    buf[o + 32] = ty[11] / 1000
    buf[o + 33] = ty[15] / 1000
    buf[o + 34] = s.loopAccel / GRAVITY
    buf[o + 35] = s.debugGuide[1]
    buf[o + 36] = s.debugGuide[2]
    buf[o + 37] = s.debugGuide[3] * RAD2DEG
    buf[o + 38] = s.debugRoadHeight
    buf[o + 39] = s.debugSuspSum / (GRAVITY * 1200 * s.tuning.mass)
    buf[o + 40] = s.debugChassisContact ? 1 : 0
    buf[o + 41] = s.impact
    for (let k = 0; k < 6; k++) buf[o + 42 + k] = s.debugLoop[k]
    count++
  },

  /** The recording as { channel: number[] }, every `every`-th step, rounded for reading. */
  get(every = 1): Record<string, number[]> {
    const out: Record<string, number[]> = {}
    for (const ch of CHANNELS) out[ch] = []
    const step = Math.max(1, Math.round(every))
    for (let i = 0; i < count; i += step) {
      for (let k = 0; k < CHANNELS.length; k++) out[CHANNELS[k]].push(Math.round(buf[i * CHANNELS.length + k] * 100) / 100)
    }
    return out
  },
}
