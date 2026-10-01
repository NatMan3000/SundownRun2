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
const STEER_DAMP = 0.25
/** Rejoining the lane: aim at least this many metres ahead per metre off it. */
const REJOIN_RATIO = 5
/** No overtaking when the road ahead bends tighter than this (1/m): passing is for straights. */
const PASS_MAX_CURVATURE = 0.006
/** Aim point distance: base metres + metres per (m/s) of speed. */
const LOOK_BASE = 7
const LOOK_PER_MS = 0.38
const LOOK_MIN = 7
const LOOK_MAX = 55
/** Braking the brain plans with, m/s^2 (a bit under what the car can do, so it is never late). */
const PLAN_DECEL = 6.5
/** How far up the road to look for slow sections, metres (more when fast). */
const SPEED_SCAN_MAX = 240
/** Never plan on less braking than this, even on the steepest downhill. */
const MIN_DECEL = 2.5
const GRAVITY = 9.81
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
/** Steering demand (fraction of full lock) above which the brain treats the turn as too tight for its speed. */
const STEER_SATURATION = 0.7
/** How hard it slows per unit of demand over that: 0.25 -> 7.5 % below current speed at full lock. */
const UNDERSTEER_CUT = 0.25
/** Sideways grip the brain trusts on flat road, m/s^2 (wall-ride corners are taken on this). */
const WALL_FLAT_ALAT = 7.5
/** Boost pads: only take one if the road after it can use this much extra speed, m/s. */
const BOOST_GAIN = 12
/** If the hinted road point is further than this from the car, the hint is stale (teleport). */
const HINT_LOST_M = 25
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

/**
 * Tuning aid: trace every Ai driver every 5 m through the stretch [s0, s1]
 * (set with __dev.aiWatch(s0, s1), read with __dev.aiWatchGet()).
 */
export const aiWatch = {
  s0: -1,
  s1: -1,
  rows: [] as string[],
}

/** Is distance s inside a wall-ride piece? */
function inWallRide(track: TrackRuntime, s: number): boolean {
  const pieces = track.pieces
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i]
    if (p.type !== 'wallride') continue
    if (track.deltaS(p.s0, s) >= 0 && track.deltaS(s, p.s1) >= 0) return true
  }
  return false
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
  resetLog: { s: number; why: 'flipped' | 'stuck'; kmh: number; lateral: number; height: number }[] = []
  /** The approach to the last few loops: every 10 m over the final 60 m (for tuning loop entries). */
  loopLog: { s: number; toLoop: number; kmh: number; targetKmh: number; lateral: number; headingDeg: number }[] = []
  private loopBucket = -1

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

  /** Fixed settings for this brain (the demo autopilot); undefined = follow the player's settings. */
  private readonly opts: AiDriverOptions

  constructor(id: string, personality: Personality, phase: number, opts: AiDriverOptions = {}) {
    this.id = id
    this.personality = personality
    this.phase = phase
    this.opts = opts
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
    else {
      track.nearest(p.x, p.y, p.z, this.hit, this.s)
      // Far from where the hint says we are: we were teleported (restart, grid). Search fresh.
      if (this.hit.distance > HINT_LOST_M) track.nearest(p.x, p.y, p.z, this.hit)
    }
    const prevS = this.s
    this.s = this.hit.s

    // Countdown / no race: hold still (the car is frozen anyway).
    if (this.opts.raceGated !== false && g.raceState !== 'running' && g.raceState !== 'finished') {
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
    const difficulty = clamp(this.opts.difficulty ?? settings.aiDifficulty, 0, 1)
    let pace = (PACE_AT_EASIEST + (1 - PACE_AT_EASIEST) * difficulty) * this.personality.pace
    this.powerScale = 1
    if ((this.opts.catchUp ?? settings.catchUp) && me && !finished) {
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
    let look = clamp((LOOK_BASE + LOOK_PER_MS * speed) * this.personality.lookahead, LOOK_MIN, LOOK_MAX)
    // Far off our lane (after a pass, a slide, a reset): aim further up the road so
    // we rejoin at a shallow angle (about 11 degrees at most) instead of swinging
    // across the road and overshooting the other edge.
    const offLane = Math.abs(this.hit.lateral - this.laneNow)
    if (offLane * REJOIN_RATIO > look) look = Math.min(LOOK_MAX * 1.5, offLane * REJOIN_RATIO)
    const aimS = this.s + look
    track.frameAt(aimS, _frame)
    const lineOff = sampleAt(track, track.racingLine.offset, aimS)
    const wander = Math.sin(this.time * 0.37 + this.phase) * this.personality.wander * 0.9
    let desired = lineOff + this.personality.lane * 0.8 + wander

    desired = this.boostLane(track, desired, v, pace)
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
    const steerWanted = STEER_GAIN * alpha + STEER_DAMP * alphaRate
    this.steer = clamp(steerWanted, -1, 1)

    // ---- target speed with braking look-ahead ----
    const magFloor = (settings.magGripKmh / 3.6) * MAG_MARGIN
    const vTop = settings.topSpeedKmh / 3.6
    // Braking we can count on, m/s^2. Downhill, gravity pushes us along the road and
    // eats into it (g x the slope); uphill it helps. The scan looks further ahead the
    // faster we go, sized for the weakest braking we might have.
    const decel = PLAN_DECEL * (0.92 + 0.16 * this.personality.aggression)
    const scan = Math.min(SPEED_SCAN_MAX, (speed * speed) / (2 * decel * 0.6) + 25)
    const n = track.samples.count
    const ds = track.samples.ds
    let vt = Infinity
    let slopeSum = 0
    let slopeCount = 0
    let loopAt = -1
    for (let j = 0; j <= scan; j += SPEED_SCAN_STEP) {
      const sj = this.s + j
      const idx = Math.floor(track.wrapS(sj) / ds) % n
      slopeSum += track.samples.ty[idx] // sin(climb angle): + uphill, - downhill
      slopeCount++
      const slope = slopeSum / slopeCount
      // Cap at the car's top speed BEFORE scaling: the line can ask for more than the
      // engine has, and 80 % of "faster than possible" would still be flat out.
      let line = Math.min(sampleAt(track, track.racingLine.speed, sj), vTop) * pace
      if (slope < -0.02) line *= Math.max(0.88, 1 + slope * 1.2) // a corner at the bottom of a hill: leave margin
      // Through a wall ride we stay on the flat road (inside the edge), so the corner has
      // to be taken on tyre grip alone, not leaning on the wall: cap to what grip can hold.
      const k = Math.abs(track.samples.curvature[idx])
      if (k > 0.002 && inWallRide(track, sj)) line = Math.min(line, Math.sqrt(WALL_FLAT_ALAT / k))
      const surf = track.samples.surface[idx]
      if (surf === SURFACE_CODE.loop && loopAt < 0) loopAt = j
      if ((surf === SURFACE_CODE.loop || surf === SURFACE_CODE.wall) && line < magFloor) line = magFloor
      const brakeHere = Math.max(MIN_DECEL, decel + GRAVITY * slope)
      const allowed = Math.sqrt(line * line + 2 * brakeHere * j)
      if (allowed < vt) vt = allowed
    }
    this.logLoopApproach(track, car, loopAt, v)
    if (followCap < vt) vt = followCap
    // Understeer governor. The car's steering is speed-sensitive: at speed even full
    // lock only turns so tightly. If the brain is asking for most of the lock, the
    // car can't follow the line at this speed, whatever the line says. Slow down
    // (brake below the current speed) until the turn fits.
    const demand = Math.abs(steerWanted)
    if (demand > STEER_SATURATION && v > 8) {
      const cut = 1 - UNDERSTEER_CUT * (Math.min(demand, 1.8) - STEER_SATURATION)
      if (v * cut < vt) vt = v * cut
    }
    // a big angle to the aim point means we are well off line: ease off as well
    if (Math.abs(alpha) > 0.35) vt *= 1 - Math.min(0.35, (Math.abs(alpha) - 0.35) * 0.5)
    this.targetKmh = vt * 3.6

    const e = vt - v
    if (e > 0) {
      this.throttle = clamp(0.35 + e * 0.35, 0, 1)
      this.brake = 0
    } else if (e < -1.2 && vt < vTop * pace * 0.98) {
      // a real slow-down ahead (corner, loop, landing): brake
      this.throttle = 0
      this.brake = clamp(-e * 0.22, 0, 1)
    } else if (e < -1.2) {
      // only over our cruising cap (a boost pad shoved us past it): lift, never brake away a boost
      this.throttle = 0
      this.brake = 0
    } else {
      this.throttle = 0.3
      this.brake = 0
    }
    this.handbrake = false
    if (this.mode !== 'pass') this.mode = finished ? 'cooldown' : 'drive'
    if (aiWatch.s0 >= 0) this.watchRow(track, car, v, vt)
  }

  /** Record speed, line and heading every 10 m over the last 60 m before a loop. */
  private logLoopApproach(track: TrackRuntime, car: CarState, toLoop: number, v: number): void {
    if (toLoop < 0 || toLoop > 60) {
      this.loopBucket = -1
      return
    }
    const bucket = Math.floor(toLoop / 10)
    if (bucket === this.loopBucket) return
    this.loopBucket = bucket
    const i = this.hit.index
    const S = track.samples
    _fwd.set(0, 0, 1).applyQuaternion(car.quaternion)
    const along = _fwd.x * S.tx[i] + _fwd.y * S.ty[i] + _fwd.z * S.tz[i]
    const side = _fwd.x * S.rx[i] + _fwd.y * S.ry[i] + _fwd.z * S.rz[i]
    this.loopLog.push({
      s: Math.round(this.s),
      toLoop: Math.round(toLoop),
      kmh: Math.round(v * 3.6),
      targetKmh: Math.round(this.targetKmh),
      lateral: +this.hit.lateral.toFixed(1),
      headingDeg: Math.round((Math.atan2(side, along) * 180) / Math.PI),
    })
    if (this.loopLog.length > 21) this.loopLog.shift()
  }

  private watchBucket = -1

  /** One trace row every 5 m inside the watch window (rare: tuning only). */
  private watchRow(track: TrackRuntime, car: CarState, v: number, vt: number): void {
    const inside = track.deltaS(aiWatch.s0, this.s) >= 0 && track.deltaS(this.s, aiWatch.s1) >= 0
    if (!inside) {
      this.watchBucket = -1
      return
    }
    const b = Math.floor(this.s / 5)
    if (b === this.watchBucket) return
    this.watchBucket = b
    const i = this.hit.index
    const S = track.samples
    _fwd.set(0, 0, 1).applyQuaternion(car.quaternion)
    const hdg = (Math.atan2(_fwd.x * S.rx[i] + _fwd.y * S.ry[i] + _fwd.z * S.rz[i], _fwd.x * S.tx[i] + _fwd.y * S.ty[i] + _fwd.z * S.tz[i]) * 180) / Math.PI
    aiWatch.rows.push(
      `${this.id} s${Math.round(this.s)} ${Math.round(v * 3.6)}/${Math.round(vt * 3.6)} lat${this.hit.lateral.toFixed(1)}>${this.laneNow.toFixed(1)} h${this.hit.height.toFixed(1)} hdg${Math.round(hdg)} st${this.steer.toFixed(2)} th${this.throttle.toFixed(1)} br${this.brake.toFixed(1)} ${this.mode}`,
    )
    if (aiWatch.rows.length > 400) aiWatch.rows.shift()
  }

  private idle(): void {
    this.throttle = 0
    this.brake = 0
    this.steer = 0
    this.handbrake = false
    this.powerScale = 1
  }

  /**
   * Boost pads. A pad near our line that the road after it can use: swing
   * onto it. A pad whose extra speed we'd only have to brake away (a loop
   * or a tight corner right after it): steer round it instead.
   */
  private boostLane(track: TrackRuntime, desired: number, v: number, pace: number): number {
    const zones = track.boostZones
    for (let i = 0; i < zones.length; i++) {
      const z = zones[i]
      const ahead = track.deltaS(this.s, z.s0)
      const inside = track.deltaS(z.s0, this.s) >= 0 && track.deltaS(this.s, z.s1) >= 0
      if (!inside && (ahead < 0 || ahead > 70)) continue
      const centre = (z.lat0 + z.lat1) * 0.5
      if (this.boostUseful(track, z.s1, v, pace)) {
        if (Math.abs(centre - desired) <= 5.5) return centre
        continue
      }
      // not wanted: if our line crosses the pad, pass beside it
      const clear = 1.6
      if (desired < z.lat0 - clear || desired > z.lat1 + clear) continue
      const lim = Math.max(0, track.samples.halfWidth[this.hit.index] - EDGE_MARGIN)
      const left = z.lat0 - clear
      const right = z.lat1 + clear
      const leftOk = left >= -lim
      const rightOk = right <= lim
      if (leftOk && (!rightOk || Math.abs(left - desired) <= Math.abs(right - desired))) return left
      if (rightOk) return right
    }
    return desired
  }

  /** Can the 220 m after a pad (ending at sEnd) carry BOOST_GAIN more speed than we have, braking allowed? */
  private boostUseful(track: TrackRuntime, sEnd: number, v: number, pace: number): boolean {
    const want = Math.max(0, v) + BOOST_GAIN
    const vTop = getSettings().topSpeedKmh / 3.6
    for (let j = 0; j <= 220; j += 5) {
      const sj = sEnd + j
      const idx = Math.floor(track.wrapS(sj) / track.samples.ds) % track.samples.count
      const line = Math.min(track.racingLine.speed[idx], vTop * 1.2) * pace
      if (track.samples.surface[idx] === SURFACE_CODE.loop) return false // never boost into a loop
      if (Math.sqrt(line * line + 2 * PLAN_DECEL * j) < want) return false
    }
    return true
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

    // passing is for straights: in a bend, follow instead of pulling out
    let bendy = false
    for (let j = 0; j <= 80 && !bendy; j += 8) {
      const idx = Math.floor(track.wrapS(this.s + j) / track.samples.ds) % track.samples.count
      if (Math.abs(track.samples.curvature[idx]) > PASS_MAX_CURVATURE) bendy = true
    }
    if (blocker >= 0 && bendy && this.passTimer <= 0) {
      if (blockerDs < 9) cap = Math.max(0, list[blocker].speed - 0.5)
      blocker = -1
    }

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
      this.resetLog.push({ s: Math.round(this.s), why: this.flippedT > FLIPPED_RESET_S ? 'flipped' : 'stuck', kmh: Math.round(v * 3.6), lateral: +this.hit.lateral.toFixed(1), height: +this.hit.height.toFixed(1) })
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
      // keep this.s: resetToRoad puts us back near it, and the hint keeps a
      // bridge's upper deck from being mistaken for the road underneath
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

// ---------------------------------------------------------------- the factory

export interface AiDriverOptions {
  /** 0..1; omit to follow the player's Ai difficulty setting. */
  difficulty?: number
  /** Omit to follow the player's catch-up setting. */
  catchUp?: boolean
  /** Only drive while a race is running (true for Ai racers). The demo autopilot drives any time. */
  raceGated?: boolean
}

/**
 * One driving brain for everything that drives itself: Ai racers and the
 * ?demo=1 autopilot (vehicle feeds it through driveOverride). The demo uses
 *   createAiDriver({ id: 'player', difficulty: 1, catchUp: false })
 * which drives the racing line at full pace, at any time, in any mode.
 */
export function createAiDriver(o: {
  id?: string
  name?: string
  difficulty?: number
  catchUp?: boolean
  /** Metres right (+) / left (-) of the racing line to sit. */
  lateralBias?: number
  raceGated?: boolean
}): AiDriver {
  const personality: Personality = { pace: 1, lane: o.lateralBias ?? 0, lookahead: 1, aggression: 0.5, wander: 0 }
  return new AiDriver(o.id ?? 'player', personality, 0, {
    difficulty: o.difficulty,
    catchUp: o.catchUp,
    raceGated: o.raceGated ?? false,
  })
}
