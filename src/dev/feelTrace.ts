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
//  x, y, z, s, lat, slip, drifting, hbBody (signed forward km/h). Buffers are preallocated: recording costs a few
//  array writes per step and nothing at all when idle.
// ============================================================

import type { CarSim } from '../vehicle/carSim'
import { DT, GRAVITY } from '../vehicle/tuning'

const CHANNELS = ['t', 'kmh', 'drift', 'yaw', 'steer', 'throttle', 'brake', 'hb', 'air', 'wheels', 'latG', 'up', 'rpm', 'mag', 'x', 'y', 'z', 's', 'lat', 'slip', 'drifting', 'hbBody'] as const
const MAX_STEPS = 60 * 60
const RAD2DEG = 180 / Math.PI

const buf = new Float32Array(MAX_STEPS * CHANNELS.length)
let count = 0
let remaining = 0

export const feelTrace = {
  /** Start recording for `seconds` (max 60). */
  start(seconds: number): void {
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
