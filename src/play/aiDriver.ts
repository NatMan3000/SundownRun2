// ============================================================
//  AI DRIVER - the brain behind every Ai racer
// ------------------------------------------------------------
//  An Ai racer is the SAME car as yours (vehicle's <SimCar>), with
//  this brain in the driver's seat instead of your hands. Once per
//  physics step the car calls update(), and the brain writes the
//  same four controls you do: throttle, brake, steer, handbrake.
//  It cannot cheat the physics; it can only drive well.
//
//  How it drives:
//
//  1. STEER - "pure pursuit". Pick a point a little way up the road
//     on the racing line (further ahead when going faster, which
//     keeps it smooth at speed), and steer toward it. The angle to
//     that point, measured in the car's own frame, works upside down
//     on a loop and sideways on a wall ride too.
//
//  2. SPEED - the track hands us a target speed for every metre of
//     road (slow for corners, loops, landings). We scale it by the
//     difficulty slider, then look up the road for anything slower
//     coming and start braking in time: the fastest speed allowed
//     now is sqrt(v_ahead^2 + 2 * braking * distance).
//
//  3. RACECRAFT - each racer has a favourite lane and a slow weave
//     (personality), swings onto boost pads near its line, keeps the
//     speed up for loops and wall rides (or it would fall off), and
//     pulls out to pass a slower car close ahead.
//
//  4. CATCH-UP - a gentle nudge: a racer far ahead of you gets a
//     little less power, one far behind a little more (at most about
//     10 percent). Enough to keep races close, never enough to feel
//     like the game is cheating.
//
//  5. RECOVERY - stuck against something: reverse out and try again.
//     Still stuck after about 4 seconds, or lying on its roof: reset
//     to the road, exactly like you pressing R.
// ============================================================

import * as THREE from 'three'
import type { Driver } from '../core/api'
import type { CarState } from '../core/telemetry'
import { getGame } from '../core/store'
import { getSettings } from '../core/settings'
import { getTrack } from '../track/current'
import { SURFACE_CODE } from '../track/types'
import type { NearestHit, TrackFrame, TrackRuntime } from '../track/types'
import type { Personality } from './aiRoster'
import { raceBook, racerById } from './raceBook'

// ---- tuning (plain numbers, so they are easy to find and change) ----

/** Steering: how hard to turn toward the aim point (per radian of angle) and how much to damp it. */
const STEER_GAIN = 1.9
const STEER_DAMP = 0.12
/** Aim point distance: base metres + metres per (m/s) of speed. */
const LOOK_BASE = 7
const LOOK_PER_MS = 0.38
const LOOK_MIN = 7
const LOOK_MAX = 55
/** Braking the brain plans with, m/s^2 (a bit under what the car can do, so it is never late). */
const PLAN_DECEL = 6.5
/** How far up the road to look for slow sections, metres (more when fast). */
const SPEED_SCAN_MAX = 170
const SPEED_SCAN_STEP = 3
/** Stay this far inside the road edge, metres. */
const EDGE_MARGIN = 1.3
/** Difficulty 0 drives at this share of the racing line's pace; difficulty 1 at 100 percent. */
const PACE_AT_EASIEST = 0.8
/** Catch-up limits: power +/- 10 percent, corner pace +/- 3 percent, fully in by this gap (m). */
const CATCHUP_POWER = 0.1
const CATCHUP_PACE = 0.03
const CATCHUP_GAP = 180
/** Overtaking: how wide to pass, how long to commit. */
const PASS_OFFSET = 3.4
const PASS_HOLD_S = 1.6
const LANE_SLEW = 2.6 // m/s the aim line can move sideways
/** Side-by-side room: cars overlapping along the road within SIDE_LEN m keep SIDE_GAP m apart sideways. */
const SIDE_LEN = 5.5
const SIDE_GAP = 3.0
/** Recovery. */
const STUCK_SPEED = 1.5
const STUCK_TRIGGER_S = 1.2
const REVERSE_S = 1.3
const WATCHDOG_S = 4
const WATCHDOG_MIN_PROGRESS = 5
const FLIPPED_RESET_S = 2.5
/** Loops and wall rides: hold at least this many times the magnetic grip speed. */
const MAG_MARGIN = 1.3

export type AiMode = 'grid' | 'drive' | 'pass' | 'reverse' | 'reset' | 'cooldown'

// ---- module temps: update() never allocates ----
const _fwd = new THREE.Vector3()
const _up = new THREE.Vector3()
const _right = new THREE.Vector3()
const _d = new THREE.Vector3()
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

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** Linear sample of a per-sample array at distance s (wraps). */
function sampleAt(track: TrackRuntime, arr: Float32Array, s: number): number {
  const n = track.samples.count
  const f = track.wrapS(s) / track.samples.ds
  const i0 = Math.floor(f) % n
  const i1 = (i0 + 1) % n
  const t = f - Math.floor(f)
  return arr[i0] + (arr[i1] - arr[i0]) * t
}

function surfaceAt(track: TrackRuntime, s: number): number {
  const n = track.samples.count
  return track.samples.surface[Math.floor(track.wrapS(s) / track.samples.ds) % n]
}

export class AiDriver implements Driver {
  throttle = 0
  brake = 0
  steer = 0
  handbrake = false
  powerScale = 1

  readonly id: string
  readonly personality: Personality

  // ---- brain state (public so the 'play' inspector can show it) ----
  mode: AiMode = 'grid'
  s = -1
  targetKmh = 0
  aimLateral = 0
  /** How many times this racer has had to reset to the road (inspector, balance checks). */
  resets = 0
  /** The last few resets: where, why, and how fast it was going (for tuning; rare, so allocation is fine). */
  resetLog: { s: number; why: 'flipped' | 'stuck'; kmh: number; lateral: number }[] = []

  private hit: NearestHit = { s: 0, index: 0, lateral: 0, height: 0, distance: 0, onRoad: true }
  private prevAlpha = 0
  private time = 0
  private phase: number
  private passOffset = 0
  private sideShove = 0
  private passTarget = 0
  private passTimer = 0
  private laneNow = 0
  private stuckT = 0
  private reverseT = 0
  private reverseSteer = 1
  private flippedT = 0
  private watchT = 0
  private watchProgress = 0
  private resetCooldown = 0

  constructor(id: string, personality: Personality, phase: number) {
    this.id = id
    this.personality = personality
    this.phase = phase
    this.laneNow = personality.lane
  }

  /** Forget recovery state (after a teleport to the grid). */
  resetBrain(): void {
    this.s = -1
    this.mode = 'grid'
    this.passOffset = 0
    this.passTarget = 0
    this.passTimer = 0
    this.stuckT = 0
    this.reverseT = 0
    this.flippedT = 0
    this.watchT = 0
    this.watchProgress = 0
    this.resetCooldown = 0
    this.prevAlpha = 0
  }

  update(car: CarState, dt: number): void {
    const track = getTrack()
    if (!track || !(dt > 0)) return this.idle()
    const g = getGame()
    this.time += dt

    // ---- where am I on the road? ----
    const p = car.position
    if (this.s < 0) track.nearest(p.x, p.y, p.z, this.hit)
    else track.nearest(p.x, p.y, p.z, this.hit, this.s)
    const prevS = this.s
    this.s = this.hit.s

    // Countdown / no race: hold still (the car is frozen anyway).
    if (g.raceState !== 'running' && g.raceState !== 'finished') {
      this.mode = 'grid'
      return this.idle()
    }

    _fwd.set(0, 0, 1).applyQuaternion(car.quaternion)
    _up.set(0, 1, 0).applyQuaternion(car.quaternion)
    _right.crossVectors(_fwd, _up)
    const v = car.velocity.dot(_fwd) // signed forward speed, m/s

    // ---- progress watchdog + recovery ----
    if (prevS >= 0) {
      const ds = track.deltaS(prevS, this.s)
      if (Math.abs(ds) < 25) this.watchProgress += ds
    }
    if (this.resetCooldown > 0) this.resetCooldown -= dt
    if (this.recover(car, track, dt, v)) return

    const me = racerById(this.id)
    const finished = me?.finished ?? false

    // ---- pace: difficulty x personality x catch-up ----
    const settings = getSettings()
    const difficulty = clamp(settings.aiDifficulty, 0, 1)
    let pace = (PACE_AT_EASIEST + (1 - PACE_AT_EASIEST) * difficulty) * this.personality.pace
    this.powerScale = 1
    if (settings.catchUp && me && !finished) {
      const player = racerById('player')
      if (player && !player.finished) {
        const k = Math.tanh((player.dist - me.dist) / CATCHUP_GAP) // + = player ahead of me
        this.powerScale = 1 + CATCHUP_POWER * k
        pace *= 1 + CATCHUP_PACE * k
      }
    }
    if (finished) pace *= 0.72 // cool-down lap
    if (!this.hit.onRoad) pace *= 0.75 // off the road: grip is worse, take it easy until back on

    // ---- aim point ----
    const speed = Math.max(0, v)
    const look = clamp((LOOK_BASE + LOOK_PER_MS * speed) * this.personality.lookahead, LOOK_MIN, LOOK_MAX)
    const aimS = this.s + look
    track.frameAt(aimS, _frame)
    const lineOff = sampleAt(track, track.racingLine.offset, aimS)
    const wander = Math.sin(this.time * 0.37 + this.phase) * this.personality.wander * 0.9
    let desired = lineOff + this.personality.lane * 0.8 + wander

    desired = this.boostLane(track, desired)
    const followCap = this.racecraft(track, desired, v, dt)
    this.passOffset += clamp(this.passTarget - this.passOffset, -LANE_SLEW * dt, LANE_SLEW * dt)
    desired += this.passOffset + this.sideShove

    const lim = Math.max(0, _frame.halfWidth - EDGE_MARGIN)
    desired = clamp(desired, -lim, lim)
    // slew the lane so lateral changes are smooth, never a twitch
    this.laneNow += clamp(desired - this.laneNow, -LANE_SLEW * 1.5 * dt, LANE_SLEW * 1.5 * dt)
    this.aimLateral = this.laneNow

    _d.copy(_frame.right).multiplyScalar(this.laneNow).add(_frame.position).sub(p)
    const x = _d.dot(_right)
    const z = _d.dot(_fwd)
    const alpha = Math.atan2(x, z) // + = aim point to my right
    const alphaRate = clamp((alpha - this.prevAlpha) / dt, -8, 8)
    this.prevAlpha = alpha
    this.steer = clamp(STEER_GAIN * alpha + STEER_DAMP * alphaRate, -1, 1)

    // ---- target speed with braking look-ahead ----
    const magFloor = (settings.magGripKmh / 3.6) * MAG_MARGIN
    const decel = PLAN_DECEL * (0.92 + 0.16 * this.personality.aggression)
    const scan = Math.min(SPEED_SCAN_MAX, (speed * speed) / (2 * decel) + 20)
    let vt = Infinity
    for (let j = 0; j <= scan; j += SPEED_SCAN_STEP) {
      const sj = this.s + j
      let line = sampleAt(track, track.racingLine.speed, sj) * pace
      const surf = surfaceAt(track, sj)
      if ((surf === SURFACE_CODE.loop || surf === SURFACE_CODE.wall) && line < magFloor) line = magFloor
      const allowed = Math.sqrt(line * line + 2 * decel * j)
      if (allowed < vt) vt = allowed
    }
    if (followCap < vt) vt = followCap
    // a big steering angle at speed means we are off line: ease off a touch
    if (Math.abs(alpha) > 0.5) vt *= 1 - Math.min(0.35, (Math.abs(alpha) - 0.5) * 0.5)
    this.targetKmh = vt * 3.6

    const e = vt - v
    if (e > 0) {
      this.throttle = clamp(0.35 + e * 0.35, 0, 1)
      this.brake = 0
    } else if (e < -1.2) {
      this.throttle = 0
      this.brake = clamp(-e * 0.22, 0, 1)
    } else {
      this.throttle = 0.3
      this.brake = 0
    }
    this.handbrake = false
    if (this.mode !== 'pass') this.mode = finished ? 'cooldown' : 'drive'
  }

  private idle(): void {
    this.throttle = 0
    this.brake = 0
    this.steer = 0
    this.handbrake = false
    this.powerScale = 1
  }

  /** Swing onto a boost pad that is near our line and coming up soon. */
  private boostLane(track: TrackRuntime, desired: number): number {
    const zones = track.boostZones
    for (let i = 0; i < zones.length; i++) {
      const z = zones[i]
      const ahead = track.deltaS(this.s, z.s0)
      const inside = track.deltaS(z.s0, this.s) >= 0 && track.deltaS(this.s, z.s1) >= 0
      if (!inside && (ahead < 0 || ahead > 70)) continue
      const centre = (z.lat0 + z.lat1) * 0.5
      if (Math.abs(centre - desired) > 5.5) continue
      return centre
    }
    return desired
  }

  /**
   * Overtaking. Look for a car close ahead in roughly our lane and moving
   * slower; pick the side with room and commit to it for a moment. If both
   * sides are blocked, follow (returns a speed cap, m/s), else Infinity.
   */
  private racecraft(track: TrackRuntime, desired: number, v: number, dt: number): number {
    if (this.passTimer > 0) this.passTimer -= dt
    let cap = Infinity
    let blocker = -1
    let blockerDs = Infinity
    const list = raceBook.racers
    for (let i = 0; i < list.length; i++) {
      const o = list[i]
      if (o.id === this.id) continue
      const ds = track.deltaS(this.s, o.s)
      if (ds <= 0 || ds > 10 + Math.max(0, v) * 0.7) continue
      if (Math.abs(o.lateral - (desired + this.passOffset)) > 2.6) continue
      if (o.speed > v + 0.5) continue
      if (ds < blockerDs) {
        blockerDs = ds
        blocker = i
      }
    }
    // Personal space: a car right alongside (overlapping us along the road)
    // and closer than SIDE_GAP sideways gets room, so packs don't trade paint and flip.
    let shove = 0
    for (let i = 0; i < list.length; i++) {
      const o = list[i]
      if (o.id === this.id) continue
      const ds = track.deltaS(this.s, o.s)
      if (ds < -SIDE_LEN || ds > SIDE_LEN) continue
      const gap = this.hit.lateral - o.lateral
      const ag = Math.abs(gap)
      if (ag >= SIDE_GAP) continue
      shove += (gap >= 0 ? 1 : -1) * (SIDE_GAP - ag) * 0.9
    }
    this.sideShove = shove

    if (blocker >= 0) {
      const o = list[blocker]
      const half = Math.max(0, _frame.halfWidth - EDGE_MARGIN)
      const keen = 0.4 + 0.6 * this.personality.aggression
      const rightLat = o.lateral + PASS_OFFSET
      const leftLat = o.lateral - PASS_OFFSET
      const rightOk = rightLat <= half
      const leftOk = leftLat >= -half
      if ((rightOk || leftOk) && keen > 0.3) {
        // prefer the side that is closer to where we wanted to be anyway
        const goRight = rightOk && (!leftOk || Math.abs(rightLat - desired) <= Math.abs(leftLat - desired))
        this.passTarget = (goRight ? rightLat : leftLat) - desired
        this.passTimer = PASS_HOLD_S
        this.mode = 'pass'
      } else if (blockerDs < 7) {
        cap = Math.max(0, o.speed - 0.5)
      }
    } else if (this.passTimer <= 0) {
      this.passTarget = 0
      if (this.mode === 'pass') this.mode = 'drive'
    }
    return cap
  }

  /** Stuck, wedged or upside down: reverse out, then reset to the road. Returns true while recovering. */
  private recover(car: CarState, track: TrackRuntime, dt: number, v: number): boolean {
    // upside down (relative to the road here, so loops are fine)
    track.frameAt(this.s, _frame)
    const roadUp = _up.set(0, 1, 0).applyQuaternion(car.quaternion).dot(_frame.up)
    if (roadUp < 0.15 && Math.abs(v) < 4) this.flippedT += dt
    else this.flippedT = 0

    // no real progress for a while (counts while reversing too, so a car that
    // keeps wedging itself still gets reset after about 4 seconds)
    this.watchT += dt
    let reset = this.flippedT > FLIPPED_RESET_S
    if (this.watchT >= WATCHDOG_S) {
      if (this.watchProgress < WATCHDOG_MIN_PROGRESS) reset = true
      this.watchT = 0
      this.watchProgress = 0
    }
    if (reset && this.resetCooldown <= 0 && car.api) {
      this.resetLog.push({ s: Math.round(this.s), why: this.flippedT > FLIPPED_RESET_S ? 'flipped' : 'stuck', kmh: Math.round(v * 3.6), lateral: +this.hit.lateral.toFixed(1) })
      if (this.resetLog.length > 12) this.resetLog.shift()
      car.api.resetToRoad()
      this.resets++
      this.mode = 'reset'
      this.resetCooldown = 2
      this.flippedT = 0
      this.stuckT = 0
      this.reverseT = 0
      this.watchT = 0
      this.watchProgress = 0
      this.s = -1
      this.idle()
      return true
    }

    // reversing out of something
    if (this.reverseT > 0) {
      this.reverseT -= dt
      this.mode = 'reverse'
      this.throttle = 0
      this.brake = 1 // at a standstill the brake is reverse
      this.steer = this.reverseSteer
      this.handbrake = false
      return true
    }

    // wedged: trying to go but not moving
    if (Math.abs(v) < STUCK_SPEED) this.stuckT += dt
    else this.stuckT = 0
    if (this.stuckT > STUCK_TRIGGER_S) {
      this.stuckT = 0
      this.reverseT = REVERSE_S
      this.reverseSteer = this.steer >= 0 ? -1 : 1
      return true
    }
    return false
  }
}
