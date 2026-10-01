// ============================================================
//  DEMO DRIVE - ?demo=1, the scripted drive the perf check uses
// ------------------------------------------------------------
//  An autopilot that drives the track's own racing line
//  (track.racingLine, derived from the track file) through the
//  driveOverride channel - the same steering rack, tyres and
//  friction circle a human gets, so the frames it measures are the
//  frames a player gets.
//
//    steering  pure pursuit: aim at a point on the racing line a
//              speed-dependent distance ahead, turn the wheels to
//              the arc that reaches it
//    speed     the racing line's target speed, braking early for the
//              slowest point inside the braking distance ahead
//    unstick   stuck for 2 s: reverse out; stuck three times: reset
//
//  After a 3 s warm-up it starts a 30 s perf recording
//  (core/perf.ts -> window.__perf), then keeps driving, so a checker
//  can screenshot a moving car afterwards. Deterministic: no random
//  numbers, no wall-clock branches (it counts physics steps).
//  Works on every track, drawn ones included.
// ============================================================

import * as THREE from 'three'
import { driveOverride } from '../core/controls'
import { urlParam } from '../core/devHandles'
import { startPerfRecording } from '../core/perf'
import { getGame } from '../core/store'
import type { TrackFrame, TrackRuntime } from '../track/types'
import type { CarSim } from '../vehicle/carSim'
import { GRAVITY, STEERING } from '../vehicle/tuning'

const WARMUP_STEPS = 180 // 3 s
const RECORD_SECONDS = 30
const LOOK_BASE = 7
const LOOK_PER_MS = 0.55
/** Fraction of the racing line's pace the demo drives at (calm and repeatable). */
const PACE = 0.92
/** Assumed braking for the look-ahead, m/s^2 (well inside the car's ~1.3 g). */
const PLAN_DECEL = 8
const STUCK_SPEED = 1.5
const STUCK_STEPS = 120
const REVERSE_STEPS = 72

const _frame: TrackFrame = {
  s: 0,
  position: new THREE.Vector3(),
  tangent: new THREE.Vector3(),
  up: new THREE.Vector3(),
  right: new THREE.Vector3(),
  halfWidth: 7,
  bank: 0,
  curvature: 0,
  surface: 'road',
}
const _to = new THREE.Vector3()

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function sampleIndex(track: TrackRuntime, s: number): number {
  const n = track.samples.count
  let i = Math.round(track.wrapS(s) / track.samples.ds) % n
  if (i < 0) i += n
  return i
}

export const demoDrive = {
  active: urlParam('demo') === '1',
  steps: 0,
  recording: false,
  stuckSteps: 0,
  reverseSteps: 0,
  unsticks: 0,
  /** Racing-line speed the autopilot is aiming for right now, km/h (inspector). */
  targetKmh: 0,

  /** Once per physics step while the demo runs: writes driveOverride. */
  update(sim: CarSim, track: TrackRuntime): void {
    driveOverride.active = true
    this.steps++
    if (!this.recording && this.steps >= WARMUP_STEPS) {
      this.recording = true
      startPerfRecording({ seconds: RECORD_SECONDS, label: 'demo', track: track.id, quality: getGame().qualityLevel })
    }

    const v = Math.max(0, sim.forwardSpeed)
    const sNow = sim.hasTrackS ? sim.trackS : 0

    // ---- unstick ----
    if (this.reverseSteps > 0) {
      this.reverseSteps--
      driveOverride.throttle = 0
      driveOverride.brake = 1 // at a standstill the brake IS reverse
      driveOverride.steer = clamp(-sim.lateral * 0.2, -1, 1)
      driveOverride.handbrake = false
      return
    }
    if (!sim.frozen && sim.speed < STUCK_SPEED && this.steps > WARMUP_STEPS / 2) this.stuckSteps++
    else this.stuckSteps = 0
    if (this.stuckSteps > STUCK_STEPS) {
      this.stuckSteps = 0
      this.unsticks++
      if (this.unsticks % 3 === 0) sim.requestReset('road', 'demo-unstick')
      else this.reverseSteps = REVERSE_STEPS
    }

    // ---- steer: pure pursuit onto the racing line ----
    const look = LOOK_BASE + v * LOOK_PER_MS
    const sLook = sNow + look
    track.frameAt(track.wrapS(sLook), _frame)
    const off = track.racingLine.offset[sampleIndex(track, sLook)] ?? 0
    _to.copy(_frame.position).addScaledVector(_frame.right, off).sub(sim.pos)
    const ahead = _to.dot(sim.fwd)
    const rightward = _to.dot(sim.right)
    const dist = Math.max(2, Math.hypot(ahead, rightward))
    const alpha = Math.atan2(rightward, Math.max(ahead, 0.1))
    // Arc through the target: curvature 2 sin(alpha) / L, wheel angle atan(k * wheelbase).
    const wheel = Math.atan((2 * STEERING.wheelbase * Math.sin(alpha)) / dist)
    const limit = Math.min(STEERING.maxAngleLow, Math.max(STEERING.minAngle, (STEERING.wheelbase * STEERING.latLimitG * GRAVITY) / Math.max(v * v, 1)))
    driveOverride.steer = clamp(wheel / limit, -1, 1)

    // ---- speed: slowest racing-line target within braking distance ----
    const speeds = track.racingLine.speed
    const reach = (v * v) / (2 * PLAN_DECEL) + 6
    let target = Infinity
    for (let d = 0; d <= reach; d += 2) {
      const want = (speeds[sampleIndex(track, sNow + d)] ?? 20) * PACE
      // A point further away may be approached faster: v^2 = want^2 + 2 a d.
      const allowed = Math.sqrt(want * want + 2 * PLAN_DECEL * d)
      if (allowed < target) target = allowed
    }
    if (!Number.isFinite(target)) target = 20
    this.targetKmh = target * 3.6
    driveOverride.throttle = v < 1 ? 1 : clamp((target - v) * 0.35 + 0.15, 0, 1)
    driveOverride.brake = clamp((v - target - 1.0) * 0.3, 0, 1)
    if (driveOverride.brake > 0) driveOverride.throttle = 0
    driveOverride.handbrake = false
  },
}
