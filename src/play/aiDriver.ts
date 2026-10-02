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
//  5. JUMPS - in the air a car can turn its nose but not its path, so
//     a long jump lands wherever the take-off pointed. Before a kicker
//     the brain works out where the car will come down (from its speed
//     and the ramp's shape) and lines the car's direction of travel up
//     on that spot, to about a degree, before it leaves the lip.
//
//  6. RECOVERY - stuck against something: reverse out and try again.
//     Still stuck after about 4 seconds, or lying on its roof: reset
//     to the road, exactly like you pressing R. Too slow just before a
//     loop: back up for a fresh run-up. It only ever reverses with the
//     road behind it clear of other cars.
// ============================================================

import * as THREE from 'three'
import type { Driver } from '../core/api'
import type { CarState } from '../core/telemetry'
import { cars } from '../core/telemetry'
import { getGame } from '../core/store'
import { getSettings } from '../core/settings'
import { frameStats } from '../core/perf'
import { getTrack } from '../track/current'
import { SURFACE_CODE } from '../track/types'
import type { NearestHit, TrackFrame, TrackRuntime } from '../track/types'
import type { Personality } from './aiRoster'
import { raceBook, racerById } from './raceBook'

// ---- tuning (plain numbers, so they are easy to find and change) ----

/** Sideways acceleration the brain may spend correcting its position, on top of the road's curve, m/s^2. */
const CORRECTION_ALAT = 4
/** ...plus this much per metre off the lane, up to CORRECTION_ALAT_MAX. */
const CORRECTION_PER_M = 0.9
const CORRECTION_ALAT_MAX = 12
/** In the air: steer this hard (per radian) to turn the nose back along the road. */
const AIR_ALIGN_GAIN = 1.5
/** Steering damping on how fast the angle to the aim point is changing (stops overshoot). */
const STEER_DAMP = 0.42
/** Rejoining the lane: aim at least this many metres ahead per metre off it. */
const REJOIN_RATIO = 5
/** Trail braking: above this much lock the brake is eased, down to (1 - TRAIL_EASE) at full lock. */
const TRAIL_FROM = 0.35
const TRAIL_EASE = 0.8
/** Ramps: line up for the jump from this far before the ramp's toe, metres. */
const RAMP_AIM_M = 130
/** The kicker's face costs a little speed: the car leaves the lip at about this share of its run-in speed (traces on vehicle5's landing catch: 173 -> 168 km/h). */
const RAMP_KEEP = 0.97
/** From this far before the ramp's toe until the lip: no brake, and the steering capped (the face jolts the car), metres. */
const RAMP_STEADY_M = 10
const RAMP_STEADY_STEER = 0.5
/**
 * The last this-many metres before the toe: steer the car's direction of travel
 * (its velocity, which is what the jump follows) straight at the landing point,
 * correcting over RAMP_HEADING_D metres. Needs to be right to about a degree.
 */
const RAMP_HEADING_M = 50
const RAMP_HEADING_D = 15
const RAMP_HEADING_STEER = 0.4
/** Steer for the landing only while the car will cross the lip at least this far inside the ramp's edges (m); else get onto the ramp first. */
const RAMP_EDGE_IN = 1.2
/** In the air: hold the nose up this much more than the landing road (radians), and full throttle holds about this much (the car's own levelling wins beyond it). */
const AIR_NOSE_UP = 0.03
const AIR_PITCH_FULL = 0.1
/** Touching down after a real jump (this long in the air, s): keep the steering gentle for a moment while the suspension takes the landing. */
const LAND_AIR_S = 0.6
const LAND_SETTLE_S = 0.2
const LAND_SETTLE_STEER = 0.5
/** A jump that meets the road steeper than this (radians between the fall and the road, ~22 deg) can bounce the car back up: take off slower. Afterglow kicker 1 (downhill into a dip) meets it at ~24 deg from 160 km/h; the others ~20. */
const LAND_IMPACT_MAX = 0.38
/** Where a jump comes down: aim this far inside the road edge (on top of EDGE_MARGIN), metres. */
const LAND_MARGIN = 1
/** ...and only this share of the way from the middle of the road out to the racing line: the most room either side. */
const LAND_LINE_SHARE = 1
/** Clearance from a boost pad's edge for the car to miss it, metres. */
const PAD_CLEAR = 1.6
/** Half a car's width (the pad fires on the car's centre within 0.6 m of its edge), metres. */
const PAD_HALF_CAR = 0.3
/** Which side to pass a pad on: wherever the racing line is, on average, from this far before the pad to its end, metres. */
const PAD_LINE_BEFORE = 40
/** Stepping round a pad starts this many metres before it, plus this many per metre of sideways move. */
const DODGE_LEAD_M = 15
const DODGE_LEAD_PER_M = 6
/** Sideways acceleration the brain will use to step round a pad, m/s^2 (sets how late it can still dodge). */
const DODGE_ALAT = 5
/** A pad we can't avoid: plan to brake away this much extra speed after it (the 7 m/s kick plus the push that follows), m/s. */
const PAD_KICK_PLAN = 12
/** The last stretch before a loop is driven dead centre, metres. */
const LOOP_CENTRE_M = 45
/** Loops: the slowest entry worth trying, and the distance inside which a too-slow car backs up for a fresh run-up. */
const LOOP_MIN_KMH = 110
const LOOP_ABORT_M = 60
/**
 * Backing up for a run-up: back to this far before the loop (room to reach
 * LOOP_MIN_KMH from a standstill), for at most RUNUP_MAX_S, no faster than
 * RUNUP_REV_MS backwards (m/s).
 */
const RUNUP_FROM_M = 140
const RUNUP_MAX_S = 14
const RUNUP_REV_MS = 5
/** Backing up but standing still for this long (reverse asked for, the car not moving): something is in the way, give up on it. */
const RUNUP_STILL_S = 1.5
/** At most this many back-ups per loop approach; after that, drive on and take the loop as it comes. */
const RUNUP_TRIES = 2
/**
 * Backing up is only safe with nobody behind. Never reverse with another car
 * closer than REAR_CLEAR_M behind us (bumper to bumper) in our path, or one
 * closing on us fast enough to get there within REAR_TTC_S seconds.
 */
const REAR_CLEAR_M = 12
/** A car this close to our line sideways (centre to centre, m) is "in our path": a car's width plus room. */
const REAR_LANE_M = 3.2
const REAR_TTC_S = 3
/** A car's length (m), for bumper-to-bumper gaps measured from centres. */
const CAR_LEN = 4.2
/** Wedged and backing out: the smaller gap behind that still lets us reverse, m. */
const STUCK_REAR_M = 3
/** Lining up for a loop (no passing): stop at least this far behind a slow car ahead, m. */
const FOLLOW_GAP_M = 6
/** Final approach to a loop, metres: one steady lane, then centre. */
const LOOP_LINEUP_M = 260
/** No overtaking when the road ahead bends tighter than this (1/m): passing is for straights. */
const PASS_MAX_CURVATURE = 0.006
/** Aim point distance: base metres + metres per (m/s) of speed. */
const LOOK_BASE = 7
const LOOK_PER_MS = 0.55
const LOOK_MIN = 7
const LOOK_MAX = 75
/** Braking the brain plans with, m/s^2 (a bit under what the car can do, so it is never late). */
const PLAN_DECEL = 5
/** How far up the road to look for slow sections, metres (more when fast). */
const SPEED_SCAN_MAX = 240
/** Never plan on less braking than this, even on the steepest downhill. */
const MIN_DECEL = 2.5
const GRAVITY = 9.81
const SPEED_SCAN_STEP = 3
/** Stay this far inside the road edge, metres. */
const EDGE_MARGIN = 2.0
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
/** Speeds (m/s) at the centre of each learned steering band. */
const STEER_BAND_CENTRES = [10, 27, 42, 60]
/** Measured steering response (curvature per unit steer) per speed band, 1 Oct: the starting point and the anchor for learning. */
const STEER_GAIN_SEED = [0.14, 0.02, 0.011, 0.005]
/** Don't learn the steering response while the tyres are sliding more than this (0..1): a slide isn't the rack. */
const LEARN_MAX_SLIP = 0.25
/** How quickly the steering response is learned (per physics step). */
const STEER_LEARN_RATE = 0.01
/** Pure-pursuit gain on the learned steer response (1 = exactly the arc through the aim point). */
const PP_WEIGHT = 1.0
/** Lane-loss governor: kicks in when more than this far off our lane and drifting further at this rate (m/s). */
const LANE_LOSS_M = 1.0
const LANE_LOSS_RATE = 0.6
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
const _o = new THREE.Vector3()
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

/**
 * The best single lane (metres from the centreline) for the run-in to a loop:
 * touch as few boost pads as possible, a pad nearer the loop counting worse,
 * and stay near the middle when it's a tie.
 */
function planRunInLane(track: TrackRuntime, s: number, toLoop: number, lim: number): number {
  let best = 0
  let bestCost = Infinity
  const zones = track.boostZones
  for (let x = -lim; x <= lim + 1e-6; x += 0.25) {
    let cost = Math.abs(x) * 0.15
    for (let i = 0; i < zones.length; i++) {
      const z = zones[i]
      const ahead = track.deltaS(s, z.s0)
      if (ahead < -2 || ahead > toLoop) continue
      if (x >= z.lat0 - PAD_CLEAR && x <= z.lat1 + PAD_CLEAR) cost += 10 + 10 * (1 - (toLoop - ahead) / Math.max(1, toLoop))
    }
    if (cost < bestCost) {
      bestCost = cost
      best = x
    }
  }
  return best
}

/**
 * Every time a brain wanted to back up, and what happened (tuning and race-safety
 * proof, read with __dev.aiReverse()). Rare, so a plain array is fine.
 *   backed   - the road behind was clear, so it reversed
 *   blocked  - a car was behind, so it drove on instead
 *   stopped  - a car came up behind mid-reverse, so it stopped reversing
 *   contact  - it touched a car behind it while reversing (should never happen)
 */
export const reverseLog = {
  rows: [] as { id: string; s: number; kmh: number; kind: 'loop' | 'stuck'; what: 'backed' | 'blocked' | 'stopped' | 'contact'; other: string }[],
  contacts: 0,
}
function logReverse(id: string, s: number, kmh: number, kind: 'loop' | 'stuck', what: 'backed' | 'blocked' | 'stopped' | 'contact', other = ''): void {
  reverseLog.rows.push({ id, s: Math.round(s), kmh: Math.round(kmh), kind, what, other })
  if (reverseLog.rows.length > 200) reverseLog.rows.shift()
  if (what === 'contact') reverseLog.contacts++
}

/** Filled by rampAhead: the ramp we're approaching or on. */
const rampInfo = { s0: 0, s1: 0, offset: 0, toStart: 0, height: 2.4, length: 12, width: 6 }
/** The jump plan (planRampLine): the landing point, and the lane to hold before the final run-in. */
const _rampL = new THREE.Vector3()
const _rampT = new THREE.Vector3()
const _rampDir = new THREE.Vector3()
const rampPlan = { lanePre: 0, sL: 0, vTakeMax: Infinity }
const _frame2: TrackFrame = {
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

/**
 * Where a car leaving a kicker's lip at speed v (m/s) comes down, metres past
 * the lip. The face steepens toward the lip (height grows as (x / length)^1.6,
 * src/track/ramps.ts), so it launches at atan(1.6 x height / length), about 18
 * degrees; then a plain throw (the sim has no air drag) against the road's own
 * height below. Checked against traces off Afterglow's second kicker: 160 km/h
 * lands 131 m out (measured 129-134), 145 km/h 109 m (measured 107-109).
 */
function flightDistance(track: TrackRuntime, s1: number, height: number, length: number, v: number): number {
  // the lip's angle is measured from the road, so a kicker on a downhill launches flatter
  const theta = Math.atan((1.6 * height) / Math.max(1, length)) + Math.asin(clamp(sampleAt(track, track.samples.ty, s1), -1, 1))
  const vh = v * Math.cos(theta)
  const vz = v * Math.sin(theta)
  const y0 = sampleAt(track, track.samples.py, s1) + height
  for (let t = 0.2; t < 6; t += 0.05) {
    const d = vh * t
    if (y0 + vz * t - 0.5 * GRAVITY * t * t <= sampleAt(track, track.samples.py, s1 + d)) {
      // how steeply the car meets the road: its fall angle plus the road's climb there
      flight.impact = Math.atan2(GRAVITY * t - vz, vh) + Math.asin(clamp(sampleAt(track, track.samples.ty, s1 + d), -1, 1))
      return d
    }
  }
  flight.impact = 0
  return vh * 6
}
/** Filled by flightDistance: the angle (radians) the car meets the road at. */
const flight = { impact: 0 }

/** If a kicker ramp starts within RAMP_AIM_M ahead (or we're on one), its end s (details in rampInfo); else -1. */
function rampAhead(track: TrackRuntime, s: number): number {
  const pieces = track.pieces
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i]
    if (p.type !== 'ramp') continue
    const toStart = track.deltaS(s, p.s0)
    const toEnd = track.deltaS(s, p.s1)
    if ((toStart >= 0 && toStart <= RAMP_AIM_M) || (toStart < 0 && toEnd >= 0)) {
      rampInfo.s0 = p.s0
      rampInfo.s1 = p.s1
      const src = p.source as { offset?: number; height?: number; length?: number; width?: number }
      rampInfo.offset = src.offset ?? 0
      rampInfo.width = src.width ?? 6
      rampInfo.height = src.height ?? 2.4
      rampInfo.length = src.length ?? 12
      rampInfo.toStart = toStart
      return p.s1
    }
  }
  return -1
}

/** Metres along the road to the start of the next loop piece (within 400 m), or -1. */
function nextLoopStart(track: TrackRuntime, s: number): number {
  let best = -1
  const pieces = track.pieces
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i]
    if (p.type !== 'loop') continue
    const d = track.deltaS(s, p.s0)
    if (d >= 0 && d <= 400 && (best < 0 || d < best)) best = d
  }
  return best
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
  /**
   * Learned steering response: road curvature (1/m) the car turns per unit of
   * steer, in four speed bands (0-20, 20-35, 35-50, 50+ m/s). Starts from a
   * guess and settles within a few corners. Public for the inspector.
   */
  readonly steerGains = new Float32Array(STEER_GAIN_SEED)
  private prevFwd = new THREE.Vector3()
  private hasPrevFwd = false
  private yawDt = 0
  /** Loops this racer went all the way round (upside down at the top, out past the end). */
  loopsDone = 0
  /** Loops it passed the end of without ever going upside down (bypassed or fell off). */
  loopsMissed = 0
  private loopIn = -1
  private loopInverted = false
  /** The approach to the last few loops: every 10 m over the final 60 m (for tuning loop entries). */
  loopLog: { s: number; toLoop: number; kmh: number; targetKmh: number; lateral: number; headingDeg: number }[] = []
  private loopBucket = -1

  private hit: NearestHit = { s: 0, index: 0, lateral: 0, height: 0, distance: 0, onRoad: true }
  private prevAlpha = 0
  private time = 0
  private phase: number
  private passOffset = 0
  private dodgingPad = false
  /** The boost pad (its s0) we've picked a side for, and the side. */
  private dodgeFor = -1
  private dodgeLeft = true
  /** Metres ahead of an unwanted pad we'll cross anyway (-1 = none): the speed plan brakes for its kick first. */
  private padKickAhead = -1
  private prevLaneErr = 0
  private runUpT = 0
  /** How long the current back-up has been standing still, and how many back-ups this approach. */
  private runUpStillT = 0
  private runUpTries = 0
  /** Test hook: stop dead just before the next loop (set by __dev.aiStall). */
  stallAtNextLoop = false
  /** The loop (its start s) we already gave up backing up for: no second try on this approach. */
  private runUpBanFor = -1
  /** Cars we have already logged touching while reversing (this reverse only). */
  private touched = ''
  private lineupFor = -1
  private lineupLane = 0
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

    // Countdown: hold still, every brain (the demo's too). The car is frozen, and a
    // brain driving against the freeze thinks it's stuck and starts backing up at GO.
    // No race running: race-gated brains (the Ai racers) hold still as well.
    if (g.raceState === 'countdown' || (this.opts.raceGated !== false && g.raceState !== 'running' && g.raceState !== 'finished')) {
      this.mode = 'grid'
      return this.idle()
    }

    _fwd.set(0, 0, 1).applyQuaternion(car.quaternion)
    _up.set(0, 1, 0).applyQuaternion(car.quaternion)
    _right.crossVectors(_fwd, _up)
    const v = car.velocity.dot(_fwd) // signed forward speed, m/s
    this.learnSteering(v, dt, car.airborne || car.slip > LEARN_MAX_SLIP)

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
    // Kicker ramps: in the air the car can turn its nose but not its path, so a
    // long jump comes down wherever the take-off pointed (over 130 m, one degree
    // off is two metres off). From RAMP_AIM_M out, work out where the car will come
    // down and line up for it (planRampLine, then rampHeadingSteer for the last bit).
    const ramp = rampAhead(track, this.s)
    if (ramp >= 0) {
      this.planRampLine(track, speed, pace)
      this.airLandS = rampPlan.sL
    } else {
      this.rampVTake = 0
      if (!car.airborne && track.deltaS(this.airLandS, this.s) > 0) this.airLandS = -1
    }
    track.frameAt(aimS, _frame)
    const lineOff = sampleAt(track, track.racingLine.offset, aimS)
    const wander = Math.sin(this.time * 0.37 + this.phase) * this.personality.wander * 0.9
    let desired = lineOff + this.personality.lane * 0.8 + wander

    // Lining up for a loop: the last LOOP_LINEUP_M metres are dead centre and
    // square to the road. No lane bias, weave, passing or boost-chasing: a loop
    // entered off-centre or at an angle is a loop missed.
    const toLoop = nextLoopStart(track, this.s)
    const lining = toLoop >= 0 && toLoop <= LOOP_LINEUP_M
    let followCap = Infinity
    // Never crawl into a loop: below LOOP_MIN_KMH the car can't stay on, it falls
    // off at the top. If we're close and that slow (after a bump or a reset), back
    // up for a fresh run-up instead.
    // Backing up is only for an empty road behind: with a car there (racing up to
    // the loop, or stopped behind us), drive on and take the loop as it comes.
    // Once we've given up on backing up for this loop, don't try again until past it.
    const loopS0 = lining ? track.wrapS(this.s + toLoop) : -1
    // A fresh approach (further out than any back-up ends) forgets the last one's tries.
    // Not "no loop ahead": a car sitting in a loop's mouth flickers in and out of that.
    if (lining && toLoop > RUNUP_FROM_M + 30) {
      this.runUpBanFor = -1
      this.runUpTries = 0
    }
    // Test hook (__dev.aiStall): stop dead just before the next loop, as if knocked
    // there, so backing up for a fresh run-up can be proven in traffic.
    if (this.stallAtNextLoop && lining && toLoop < 45) {
      if (Math.abs(v) < 0.5) this.stallAtNextLoop = false
      else {
        this.throttle = 0
        this.brake = v > 0 ? 1 : 0
        this.steer = 0
        this.handbrake = v < 4
        return
      }
    }
    // (only from rolling forward or stopped: still rolling back means a run-up just ended)
    if (lining && toLoop < LOOP_ABORT_M && v > -1 && v * 3.6 < LOOP_MIN_KMH * 0.75 && this.runUpT <= 0 && this.runUpBanFor !== loopS0) {
      if (this.rearClear(car, REAR_CLEAR_M, REAR_TTC_S)) {
        this.runUpT = RUNUP_MAX_S
        this.runUpStillT = 0
        if (++this.runUpTries >= RUNUP_TRIES) this.runUpBanFor = loopS0
        this.touched = ''
        logReverse(this.id, this.s, v * 3.6, 'loop', 'backed')
      } else {
        this.runUpBanFor = loopS0
        logReverse(this.id, this.s, v * 3.6, 'loop', 'blocked', this.rearWho)
      }
    }
    if (this.runUpT > 0 && !this.rearClear(car, REAR_CLEAR_M, REAR_TTC_S)) {
      // someone came up behind us while we were backing: stop and drive on
      this.runUpT = 0
      this.runUpBanFor = loopS0
      logReverse(this.id, this.s, v * 3.6, 'loop', 'stopped', this.rearWho)
    }
    // far enough back for a proper run-up: go for it
    if (this.runUpT > 0 && (toLoop < 0 || toLoop >= RUNUP_FROM_M)) this.runUpT = 0
    // Asking for reverse but standing still (wedged against something the rear check
    // can't see, a barrier say): give up on backing up for this loop and drive on.
    // (Slowing down from forward speed first is fine: the car is moving then.)
    if (this.runUpT > 0) this.runUpStillT = Math.abs(v) < 0.5 ? this.runUpStillT + dt : 0
    if (this.runUpT > 0 && this.runUpStillT > RUNUP_STILL_S) {
      this.runUpT = 0
      this.runUpBanFor = loopS0
      logReverse(this.id, this.s, v * 3.6, 'loop', 'stopped', 'no-room')
    }
    if (this.runUpT > 0) {
      this.runUpT -= dt
      this.mode = 'reverse'
      this.throttle = 0
      this.brake = v > -RUNUP_REV_MS ? 1 : 0 // stopped, the brake is reverse; past a jog, coast
      // Reversing steers backwards (the tail goes the way the wheel turns), and steering on
      // where we are alone snakes and runs off the road over a long back-up. Steer on how
      // fast we drift sideways instead: toward the middle of the road, gently.
      track.frameAt(this.s, _frame2)
      const latVel = car.velocity.dot(_frame2.right)
      this.steer = clamp(0.35 * (-0.5 * this.hit.lateral - latVel), -0.6, 0.6)
      this.handbrake = false
      this.checkReverseContact(car, 'loop')
      return
    }
    if (lining) {
      this.padKickAhead = -1
      // One steady lane for the run-in that hits the fewest boost pads (a pad
      // right before a loop only adds speed we'd have to brake away, and the car
      // steers badly while boosted), then dead centre for the last stretch.
      if (this.lineupFor !== loopS0) {
        this.lineupFor = loopS0
        this.lineupLane = planRunInLane(track, this.s, toLoop, Math.max(0, track.samples.halfWidth[this.hit.index] - EDGE_MARGIN))
      }
      desired = toLoop > LOOP_CENTRE_M ? this.lineupLane : 0
      this.passTarget = 0
      this.sideShove = 0
      this.passOffset += clamp(-this.passOffset, -LANE_SLEW * 2 * dt, LANE_SLEW * 2 * dt)
      // still never drive into the back of someone: no passing here, so follow
      followCap = Math.min(this.racecraft(track, desired, v, dt), this.followCapAhead(track, desired + this.passOffset, v))
      this.passTarget = 0
      desired += this.passOffset
    } else {
      desired = this.boostLane(track, desired, v, pace)
      followCap = this.racecraft(track, desired, v, dt)
      this.passOffset += clamp(this.passTarget - this.passOffset, -LANE_SLEW * dt, LANE_SLEW * dt)
      desired += this.passOffset + this.sideShove
    }

    if (ramp >= 0) {
      // Hold the lane that ends up in the middle of the lip once the final run-in has
      // turned us toward the landing; in the final run-in itself, the ramp's middle
      // (only steered for if the car is heading off the ramp's top).
      desired = rampInfo.toStart > RAMP_HEADING_M ? rampPlan.lanePre : rampInfo.offset
      this.passTarget = 0
      this.sideShove = 0
      this.passOffset = 0
    }
    const lim = Math.max(0, _frame.halfWidth - EDGE_MARGIN)
    desired = clamp(desired, -lim, lim)
    // slew the lane so lateral changes are smooth, never a twitch (quicker when
    // stepping round a boost pad, or we don't get there in time)
    const slew = this.dodgingPad || ramp >= 0 ? LANE_SLEW * 3 : LANE_SLEW * 1.5
    this.laneNow += clamp(desired - this.laneNow, -slew * dt, slew * dt)
    this.aimLateral = this.laneNow

    _d.copy(_frame.right).multiplyScalar(this.laneNow).add(_frame.position).sub(p)
    const x = _d.dot(_right)
    const z = _d.dot(_fwd)
    const alpha = Math.atan2(x, z) // + = aim point to my right
    const alphaRate = clamp((alpha - this.prevAlpha) / dt, -8, 8)
    this.prevAlpha = alpha
    // Pure pursuit, done properly: the curvature that arcs the car through the aim
    // point is 2 sin(alpha) / distance. Turn that into steer with what we've learned
    // about this car (curvature per unit of steer at this speed - the rack is
    // speed-sensitive, so the same steer turns far less at 200 km/h than at 50).
    // A curved road ahead is already in the aim point, so no separate feedforward.
    const chord = Math.max(3, Math.hypot(x, z))
    // Correction budget: follow the road's own curve, plus at most CORRECTION_ALAT of
    // sideways acceleration to fix our position. Without it, a few metres off line at
    // 250 km/h asks for 4 g, slams full lock and spins the car.
    // The road's curve ALONG ITS SURFACE, like the aim point's curvature above (measured in the
    // car's own plane): on a bank a horizontal curve is gentler seen from the road, x cos(bank)
    // (half on a 60 deg bank). The plain horizontal curvature here held every Ai to twice the
    // turn a 60 deg end needs, and they steered into its inner barrier.
    const sMid = this.s + chord * 0.5
    const kRoad = sampleAt(track, track.samples.curvature, sMid) * Math.cos(sampleAt(track, track.samples.bank, sMid))
    // the further off line, the more we may spend getting back (a car 15 m off
    // the road needs a real turn, not a polite nudge)
    const offLine = Math.abs(this.hit.lateral - this.laneNow)
    const kBudget = Math.min(CORRECTION_ALAT_MAX, CORRECTION_ALAT + CORRECTION_PER_M * offLine) / Math.max(25, speed * speed)
    const kWanted = clamp((2 * Math.sin(alpha)) / chord, kRoad - kBudget, kRoad + kBudget)
    const steerWanted = (kWanted / this.steerGain(v)) * PP_WEIGHT + STEER_DAMP * alphaRate
    this.steer = clamp(steerWanted, -1, 1)
    // In the air, steering is air control: it yaws the car. Chasing an aim point up
    // there just lands us crooked. Instead line the nose up with the road below, so
    // the car lands straight.
    if (car.airborne) {
      const i = this.hit.index
      const S = track.samples
      const along = _fwd.x * S.tx[i] + _fwd.y * S.ty[i] + _fwd.z * S.tz[i]
      const side = _fwd.x * S.rx[i] + _fwd.y * S.ry[i] + _fwd.z * S.rz[i]
      this.steer = clamp(-AIR_ALIGN_GAIN * Math.atan2(side, along), -0.6, 0.6)
    }
    // Final run-in to a kicker: steer where the car is actually GOING (velocity, not the
    // nose), straight at the landing point as seen from the lip. Hitting the face at an
    // angle jolts the car square to the ramp, so it keeps correcting on the face too.
    const onKicker = ramp >= 0 && rampInfo.toStart <= RAMP_STEADY_M && !car.airborne
    if (ramp >= 0 && rampInfo.toStart <= RAMP_HEADING_M && !car.airborne) this.steer = this.rampHeadingSteer(track, car, v, dt)
    else this.prevHeadErr = NaN
    // Just landed from a real jump: a big steer while the springs are still taking the
    // hit unsettles the car (it can float over the next rise with no grip). Ease in.
    if (car.airborne) {
      this.airT += dt
      this.settleT = 0
    } else {
      if (this.airT > LAND_AIR_S) this.settleT = LAND_SETTLE_S
      this.airT = 0
      if (this.settleT > 0) {
        this.settleT -= dt
        this.steer = clamp(this.steer, -LAND_SETTLE_STEER, LAND_SETTLE_STEER)
      }
    }

    // ---- target speed with braking look-ahead ----
    const magFloor = (settings.magGripKmh / 3.6) * MAG_MARGIN
    const vTop = settings.topSpeedKmh / 3.6
    // Braking we can count on, m/s^2. Downhill, gravity pushes us along the road and
    // eats into it (g x the slope); uphill it helps. The scan looks further ahead the
    // faster we go, sized for the weakest braking we might have.
    const decel = PLAN_DECEL * (0.92 + 0.16 * this.personality.aggression)
    // A kicker ahead: there's no braking on its face or in the air, so slowing for
    // anything past the landing has to be done before the toe. Those metres don't
    // count as braking room (the landing used to scrub off ~40 km/h; it doesn't now).
    const airFrom = ramp >= 0 ? Math.max(0, rampInfo.toStart) : -1
    const airTo = ramp >= 0 ? Math.max(airFrom, track.deltaS(this.s, rampPlan.sL)) : -1
    const scan = Math.min(SPEED_SCAN_MAX, (speed * speed) / (2 * decel * 0.6) + 25) + (ramp >= 0 ? airTo - airFrom : 0)
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
      // A loop is taken at the line's own loop speed, whatever the difficulty: it works
      // by magnetic grip, so arriving slower (falls off) or faster (misses the mouth) both fail.
      if (surf === SURFACE_CODE.loop) line = Math.max(magFloor, (LOOP_MIN_KMH / 3.6) * 1.08, track.racingLine.speed[idx])
      else if (surf === SURFACE_CODE.wall && line < magFloor) line = magFloor
      const brakeHere = Math.max(MIN_DECEL, decel + GRAVITY * slope)
      const room = airFrom >= 0 && j > airFrom ? airFrom + Math.max(0, j - airTo) : j
      let allowed = Math.sqrt(line * line + 2 * brakeHere * room)
      const kickAt = this.padKickAhead
      if (kickAt >= 0 && j > kickAt) {
        // a boost pad we can't avoid comes first: its kick has to be braked away too
        const after = Math.max(0, Math.sqrt(line * line + 2 * brakeHere * (j - kickAt)) - PAD_KICK_PLAN)
        allowed = Math.min(allowed, Math.sqrt(after * after + 2 * brakeHere * kickAt))
      }
      if (allowed < vt) vt = allowed
    }
    this.logLoopApproach(track, car, loopAt, v)
    if (followCap < vt) vt = followCap
    // a kicker that must be taken slower than this to land gently (see planRampLine)
    if (ramp >= 0 && rampPlan.vTakeMax < Infinity) {
      const atToe = rampPlan.vTakeMax / RAMP_KEEP
      const cap = Math.sqrt(atToe * atToe + 2 * decel * airFrom)
      if (cap < vt) vt = cap
    }
    // Understeer governor. The car's steering is speed-sensitive: at speed even full
    // lock only turns so tightly. If the brain is asking for most of the lock, the
    // car can't follow the line at this speed, whatever the line says. Slow down
    // (brake below the current speed) until the turn fits.
    const demand = Math.abs(steerWanted)
    if (demand > STEER_SATURATION && v > 8) {
      const cut = 1 - UNDERSTEER_CUT * (Math.min(demand, 1.8) - STEER_SATURATION)
      if (v * cut < vt) vt = v * cut
    }
    // Lane-loss governor: drifting further from our lane even though we're steering
    // back toward it means the tyres have given up (understeer, often downhill)
    // before the steering is anywhere near full lock. Slow down until it holds.
    const laneErr = this.hit.lateral - this.laneNow
    const laneErrRate = (laneErr - this.prevLaneErr) / dt
    this.prevLaneErr = laneErr
    if (Math.abs(laneErr) > LANE_LOSS_M && laneErr * laneErrRate > 0 && Math.abs(laneErrRate) > LANE_LOSS_RATE && this.steer * laneErr < 0 && v > 10) {
      const cut = v * (1 - Math.min(0.12, 0.03 * Math.abs(laneErrRate)))
      if (cut < vt) vt = cut
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
      // Trail braking: the tyres can brake OR turn, not both flat out. When we need
      // a lot of lock, ease the brake so the front still steers (full brake + full
      // lock at speed just slides straight on).
      const lock = Math.abs(this.steer)
      if (lock > TRAIL_FROM) {
        let cap = 1 - TRAIL_EASE * (lock - TRAIL_FROM) / (1 - TRAIL_FROM)
        // well over the speed for this bend: shedding speed matters more than turning
        // (a car that can't slow down can't turn either)
        if (v > vt * 1.12) cap = Math.max(cap, 0.55)
        this.brake = Math.min(this.brake, cap)
      }
    } else if (e < -1.2) {
      // only over our cruising cap (a boost pad shoved us past it): lift, never brake away a boost
      this.throttle = 0
      this.brake = 0
    } else {
      this.throttle = 0.3
      this.brake = 0
    }
    // No braking on the kicker (it pitches the nose down as the car leaves the lip).
    // In the air, throttle tips the nose up and brake tips it down (the car otherwise
    // levels itself to the road below it). Use that to meet the landing: the road where
    // we'll come down can climb more steeply than the road we're flying over (a jump
    // into a dip), and landing nose-first into a rise bounces the car back into the air.
    if (onKicker) this.brake = 0
    if (car.airborne) {
      this.airPitch(track)
    }
    this.handbrake = false
    if (this.mode !== 'pass') this.mode = finished ? 'cooldown' : 'drive'
    if (aiWatch.s0 >= 0) this.watchRow(track, car, v, vt)
    this.countLoops(track, car)
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

  private bandOf(v: number): number {
    return v < 20 ? 0 : v < 35 ? 1 : v < 50 ? 2 : 3
  }

  /** Curvature per unit steer at speed v (interpolated between bands). */
  private steerGain(v: number): number {
    const g = this.steerGains
    const centres = STEER_BAND_CENTRES
    if (v <= centres[0]) return g[0]
    for (let b = 0; b < 3; b++) {
      if (v <= centres[b + 1]) {
        const t = (v - centres[b]) / (centres[b + 1] - centres[b])
        return g[b] + (g[b + 1] - g[b]) * t
      }
    }
    return g[3]
  }

  /**
   * Watch how much the car actually turned for the steer we gave it last step:
   * curvature = yaw rate / speed. Only on the ground, moving, with a real steer.
   */
  private learnSteering(v: number, dt: number, airborne: boolean): void {
    // The car's pose here is the RENDER pose, which only changes once per drawn
    // frame; when a frame holds two physics steps it hasn't moved between them.
    // So measure the turn over the real time since the pose last changed.
    this.yawDt += dt
    if (this.hasPrevFwd && this.prevFwd.equals(_fwd)) return
    const span = this.yawDt
    this.yawDt = 0
    if (this.hasPrevFwd && !airborne && v > 6 && Math.abs(this.steer) > 0.12 && span > 0 && span < 0.1) {
      dt = span
      // yaw about the car's up: + = turning left; curvature + = turning right
      const cross = this.prevFwd.y * _fwd.z - this.prevFwd.z * _fwd.y
      const crossY = this.prevFwd.z * _fwd.x - this.prevFwd.x * _fwd.z
      const crossZ = this.prevFwd.x * _fwd.y - this.prevFwd.y * _fwd.x
      const sinYaw = cross * _up.x + crossY * _up.y + crossZ * _up.z
      const curv = -Math.asin(clamp(sinYaw, -1, 1)) / (v * dt)
      const sample = curv / this.steer
      if (Number.isFinite(sample) && sample > 0.002 && sample < 0.4) {
        const b = this.bandOf(v)
        this.steerGains[b] += (sample - this.steerGains[b]) * STEER_LEARN_RATE
        // never wander far from the measured response (a long session must not drift)
        this.steerGains[b] = clamp(this.steerGains[b], STEER_GAIN_SEED[b] * 0.6, STEER_GAIN_SEED[b] * 1.6)
      }
    }
    this.prevFwd.copy(_fwd)
    this.hasPrevFwd = true
  }

  /** Loop completions vs misses, for proving the Ai actually go round the loops. */
  private countLoops(track: TrackRuntime, car: CarState): void {
    const pieces = track.pieces
    if (this.loopIn < 0) {
      for (let i = 0; i < pieces.length; i++) {
        const p = pieces[i]
        if (p.type !== 'loop') continue
        const d = track.deltaS(p.s0, this.s)
        if (d >= 0 && d < 15) {
          this.loopIn = i
          this.loopInverted = false
          break
        }
      }
      return
    }
    const p = pieces[this.loopIn]
    _up.set(0, 1, 0).applyQuaternion(car.quaternion)
    if (_up.y < -0.5) this.loopInverted = true
    const past = track.deltaS(p.s1, this.s)
    if (past > 5 && past < 200) {
      if (this.loopInverted) this.loopsDone++
      else this.loopsMissed++
      this.loopIn = -1
    } else if (track.deltaS(p.s0, this.s) < -20 || past >= 200) {
      this.loopIn = -1 // reset away or wandered off: not a pass either way
    }
  }

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
    const u = car.velocity
    const vhdg = (Math.atan2(u.x * S.rx[i] + u.y * S.ry[i] + u.z * S.rz[i], u.x * S.tx[i] + u.y * S.ty[i] + u.z * S.tz[i]) * 180) / Math.PI
    aiWatch.rows.push(
      `${this.id} s${Math.round(this.s)} ${Math.round(v * 3.6)}/${Math.round(vt * 3.6)} lat${this.hit.lateral.toFixed(1)}>${this.laneNow.toFixed(1)} h${this.hit.height.toFixed(1)} hdg${Math.round(hdg)} v${vhdg.toFixed(1)} st${this.steer.toFixed(2)} th${this.throttle.toFixed(1)} br${this.brake.toFixed(1)} sl${car.slip.toFixed(2)}${car.airborne ? ' AIR' : ''} f${Math.round(frameStats.fpsEma)} ${this.mode}`,
    )
    if (aiWatch.rows.length > 3000) aiWatch.rows.shift()
  }

  private idle(): void {
    this.throttle = 0
    this.brake = 0
    this.steer = 0
    this.handbrake = false
    this.powerScale = 1
  }

  /**
   * The jump plan for the kicker in rampInfo. The landing point: where a car
   * taking off at this speed comes down, halfway from the middle of the road
   * to the racing line there (the most room either side for a landing that's
   * a little off). The lane to hold before the final run-in: the ramp's middle,
   * moved over by the drift the car picks up while it turns toward the landing,
   * so it crosses the lip near the middle.
   */
  private planRampLine(track: TrackRuntime, speed: number, pace: number): void {
    const r = rampInfo
    // The take-off speed: what we'll have at the toe (now, or the racing line's speed
    // there if we're still slowing for it), less what the face costs. Held from the
    // toe on: on the face the car slows, and re-guessing there would swing the plan.
    if (r.toStart > 0 || this.rampVTake <= 0) {
      const atToe = Math.min(speed, sampleAt(track, track.racingLine.speed, r.s0) * pace)
      this.rampVTake = Math.max(15, atToe * RAMP_KEEP)
    }
    // Too steep a landing (a downhill kicker into a dip, say) bounces: find the take-off
    // speed that comes down gently enough, and plan the jump (and the run-in) at that.
    let vt = this.rampVTake
    let d = flightDistance(track, r.s1, r.height, r.length, vt)
    while (flight.impact > LAND_IMPACT_MAX && vt > 20) {
      vt -= 1
      d = flightDistance(track, r.s1, r.height, r.length, vt)
    }
    rampPlan.vTakeMax = vt < this.rampVTake ? vt : Infinity
    const sL = r.s1 + d
    rampPlan.sL = sL
    track.frameAt(r.s1, _frame2)
    _rampT.copy(_frame2.right).multiplyScalar(r.offset).add(_frame2.position)
    track.frameAt(sL, _frame2)
    const limL = Math.max(0, _frame2.halfWidth - EDGE_MARGIN - LAND_MARGIN)
    const latL = clamp(sampleAt(track, track.racingLine.offset, sL) * LAND_LINE_SHARE, -limL, limL)
    _rampL.copy(_frame2.right).multiplyScalar(latL).add(_frame2.position)
    _rampDir.subVectors(_rampL, _rampT)
    _rampDir.y = 0
    _rampDir.normalize()
    // sideways share of the take-off direction (+ = right), at the lip
    track.frameAt(r.s1, _frame2)
    const side = _rampDir.x * _frame2.right.x + _rampDir.z * _frame2.right.z
    const edge = Math.max(0, r.width * 0.5 - RAMP_EDGE_IN)
    // (the turn mostly happens early in the final run-in, so most of it counts)
    rampPlan.lanePre = r.offset - clamp(side * (RAMP_HEADING_M + r.length) * 0.75, -edge, edge)
  }

  /**
   * In the air: throttle / brake to tip the nose toward the slope of the road where
   * we'll land (relative to the road below, which the car levels to by itself), plus a
   * touch of nose-up so the back wheels touch first.
   */
  private airPitch(track: TrackRuntime): void {
    // where we come down: the jump plan if we've just left a kicker, else a little way on
    const sL = this.airLandS >= 0 ? this.airLandS : this.s + 20
    const below = sampleAt(track, track.samples.ty, this.s)
    const landing = sampleAt(track, track.samples.ty, sL)
    const want = Math.asin(clamp(landing, -1, 1)) - Math.asin(clamp(below, -1, 1)) + AIR_NOSE_UP
    this.throttle = clamp(want / AIR_PITCH_FULL, 0, 1)
    this.brake = clamp(-want / AIR_PITCH_FULL, 0, 1)
  }

  /** Time in the air so far, and time left in the landing settle (s). */
  private airT = 0
  private settleT = 0

  /** Where the jump we're flying (from a kicker) comes down, road distance; -1 = not from a kicker. */
  private airLandS = -1

  /** Last step's heading error toward the landing (radians), for damping; NaN = none yet. */
  private prevHeadErr = NaN
  /** The take-off speed this brain planned its current jump for (m/s), held from the ramp's toe. */
  private rampVTake = 0

  /**
   * Steer that turns the car's direction of travel toward the landing point,
   * seen from where it will leave the lip. + = right, like the steer.
   */
  private rampHeadingSteer(track: TrackRuntime, car: CarState, v: number, dt: number): number {
    const vel = car.velocity
    const vh = Math.hypot(vel.x, vel.z)
    if (vh < 5) return this.steer
    const toLip = Math.max(0, track.deltaS(this.s, rampInfo.s1))
    const lipX = car.position.x + (vel.x / vh) * toLip
    const lipZ = car.position.z + (vel.z / vh) * toLip
    // Heading for a spot off the ramp's top (after a pass, a bump, a reset)? Getting
    // onto the ramp comes first: keep the line-following steer until we will.
    track.frameAt(rampInfo.s1, _frame2)
    const lipLat = (lipX - _frame2.position.x) * _frame2.right.x + (lipZ - _frame2.position.z) * _frame2.right.z
    if (Math.abs(lipLat - rampInfo.offset) > rampInfo.width * 0.5 - RAMP_EDGE_IN) {
      this.prevHeadErr = NaN
      return this.steer
    }
    // heading angles in the level plane; a larger angle is further LEFT (right = forward x up)
    let err = Math.atan2(vel.x, vel.z) - Math.atan2(_rampL.x - lipX, _rampL.z - lipZ)
    if (err > Math.PI) err -= 2 * Math.PI
    if (err < -Math.PI) err += 2 * Math.PI
    // err + = the landing is to our right
    const rate = Number.isNaN(this.prevHeadErr) ? 0 : clamp((err - this.prevHeadErr) / dt, -2, 2)
    this.prevHeadErr = err
    const k = (2 * Math.sin(err)) / RAMP_HEADING_D
    const lim = rampInfo.toStart <= RAMP_STEADY_M ? RAMP_STEADY_STEER : RAMP_HEADING_STEER
    return clamp(k / this.steerGain(v) + STEER_DAMP * rate, -lim, lim)
  }

  /**
   * Boost pads. A pad near our line that the road after it can use: swing
   * onto it. A pad whose extra speed we'd only have to brake away (a loop
   * or a tight corner right after it): steer round it instead.
   */
  private boostLane(track: TrackRuntime, desired: number, v: number, pace: number): number {
    this.dodgingPad = false
    this.padKickAhead = -1
    const zones = track.boostZones
    let near = false
    for (let i = 0; i < zones.length; i++) {
      const z = zones[i]
      const ahead = track.deltaS(this.s, z.s0)
      const inside = track.deltaS(z.s0, this.s) >= 0 && track.deltaS(this.s, z.s1) >= 0
      if (!inside && (ahead < 0 || ahead > 140)) continue
      near = true
      const centre = (z.lat0 + z.lat1) * 0.5
      if (this.boostUseful(track, z.s1, v, pace)) {
        if (Math.abs(centre - desired) <= 5.5) return centre
        continue
      }
      // Not wanted: if our line crosses the pad, pass beside it. The side is picked
      // once per pad (re-picking every step flips sides as the line swings across,
      // and the car ends up on the pad), and switched only if we can no longer get there.
      if (desired < z.lat0 - PAD_CLEAR && this.dodgeFor !== z.s0) continue
      if (desired > z.lat1 + PAD_CLEAR && this.dodgeFor !== z.s0) continue
      this.dodgingPad = true
      const lim = Math.max(0, track.samples.halfWidth[this.hit.index] - EDGE_MARGIN)
      const left = z.lat0 - PAD_CLEAR
      const right = z.lat1 + PAD_CLEAR
      const t = Math.max(0, ahead) / Math.max(5, v)
      const reach = DODGE_ALAT * t * t * 0.25 + 0.3 // sideways metres we can still make before the pad
      const leftOk = left >= -lim && (inside ? this.hit.lateral <= left + 0.3 : Math.abs(left - this.hit.lateral) <= reach)
      const rightOk = right <= lim && (inside ? this.hit.lateral >= right - 0.3 : Math.abs(right - this.hit.lateral) <= reach)
      if (this.dodgeFor !== z.s0) {
        // The side the racing line is on through the run-up to the pad (from 40 m
        // before it to its end: the line can be crossing over right at the pad), unless
        // we can't get there.
        this.dodgeFor = z.s0
        let lineAt = 0
        let count = 0
        for (let d = -PAD_LINE_BEFORE; d <= track.deltaS(z.s0, z.s1); d += 5) {
          lineAt += sampleAt(track, track.racingLine.offset, z.s0 + d)
          count++
        }
        lineAt /= Math.max(1, count)
        const preferLeft = Math.abs(left - lineAt) <= Math.abs(right - lineAt)
        this.dodgeLeft = preferLeft ? leftOk || !rightOk : !(rightOk || !leftOk)
      } else if (this.dodgeLeft ? !leftOk && rightOk : !rightOk && leftOk) {
        this.dodgeLeft = !this.dodgeLeft
      }
      // Can't make either side: we'll cross the pad, so the speed plan allows for its kick.
      if (!leftOk && !rightOk && this.hit.lateral > z.lat0 - 0.6 - PAD_HALF_CAR && this.hit.lateral < z.lat1 + 0.6 + PAD_HALF_CAR) this.padKickAhead = Math.max(0, ahead)
      // Side picked early, but only start crossing when we need to: well before the pad
      // the racing line knows best (it may be setting up a bend, or we've just landed).
      const dodgeLat = this.dodgeLeft ? left : right
      if (!inside && ahead > DODGE_LEAD_M + DODGE_LEAD_PER_M * Math.abs(dodgeLat - desired)) return desired
      // already clear on that side: no need to come closer to the pad
      if (this.dodgeLeft) return Math.min(left, desired)
      return Math.max(right, desired)
    }
    if (!near) this.dodgeFor = -1
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
    // backing up for a loop run-up is deliberate, not stuck
    if (this.runUpT > 0) {
      this.watchT = 0
      this.watchProgress = 0
      this.stuckT = 0
      return false
    }
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

    // reversing out of something (but never into a car behind us: if one is
    // there, stop and let the watchdog reset us if we stay stuck)
    if (this.reverseT > 0 && !this.rearClear(car, STUCK_REAR_M, 1.5)) {
      this.reverseT = 0
      logReverse(this.id, this.s, v * 3.6, 'stuck', 'stopped', this.rearWho)
    }
    if (this.reverseT > 0) {
      this.reverseT -= dt
      this.mode = 'reverse'
      this.throttle = 0
      this.brake = 1 // at a standstill the brake is reverse
      this.steer = this.reverseSteer
      this.handbrake = false
      this.checkReverseContact(car, 'stuck')
      return true
    }

    // wedged: trying to go but not moving (waiting on purpose behind a car that
    // hasn't moved yet, on the grid say, isn't stuck: the target speed is ~0 then)
    if (Math.abs(v) < STUCK_SPEED && this.targetKmh > 10) this.stuckT += dt
    else this.stuckT = 0
    if (this.stuckT > STUCK_TRIGGER_S) {
      this.stuckT = 0
      if (!this.rearClear(car, STUCK_REAR_M, 1.5)) {
        logReverse(this.id, this.s, v * 3.6, 'stuck', 'blocked', this.rearWho)
        return false
      }
      this.reverseT = REVERSE_S
      this.reverseSteer = this.steer >= 0 ? -1 : 1
      this.touched = ''
      logReverse(this.id, this.s, v * 3.6, 'stuck', 'backed')
      return true
    }
    return false
  }

  /** Who blocked the last rearClear check (for the log). */
  private rearWho = ''

  /**
   * Is the road behind us clear to back up? Not if another car sits within
   * clearM behind us in our path (bumper to bumper), or is closing on us fast
   * enough to get that close within ttc seconds. "Behind" is in the car's own
   * frame, so it works whichever way the car points.
   */
  private rearClear(me: CarState, clearM: number, ttc: number): boolean {
    for (let i = 0; i < cars.length; i++) {
      const o = cars[i]
      if (o === me || o.kind === 'ghost') continue
      _o.subVectors(o.position, me.position)
      const along = _o.dot(_fwd) // - = behind us
      if (along > CAR_LEN * 0.5 || along < -250) continue
      if (Math.abs(_o.dot(_right)) > REAR_LANE_M || Math.abs(_o.dot(_up)) > 4) continue
      const gap = -along - CAR_LEN
      // + = the gap is shrinking: it's catching us, or we're backing into it
      const closing = o.velocity.dot(_fwd) - me.velocity.dot(_fwd)
      if (gap < clearM || (closing > 0 && gap < clearM + closing * ttc)) {
        this.rearWho = o.id
        return false
      }
    }
    return true
  }

  /** While reversing: log any car we touch (the proof that backing up is safe). */
  private checkReverseContact(me: CarState, kind: 'loop' | 'stuck'): void {
    for (let i = 0; i < cars.length; i++) {
      const o = cars[i]
      if (o === me || o.kind === 'ghost') continue
      _o.subVectors(o.position, me.position)
      const along = _o.dot(_fwd)
      // two 4 m x 1.8 m boxes touch when their centres are this close (plus a little
      // for the render pose lagging the physics)
      if (along < -(CAR_LEN + 0.4) || along > 0.5) continue
      if (Math.abs(_o.dot(_right)) > 2.1 || Math.abs(_o.dot(_up)) > 2.5) continue
      if (this.touched.includes(o.id + ',')) continue
      this.touched += o.id + ','
      logReverse(this.id, this.s, me.velocity.dot(_fwd) * 3.6, kind, 'contact', o.id)
    }
  }

  /**
   * Lining up for a loop there's no passing, so a slow or stopped car ahead in
   * our lane (one backing up for its own run-up, say) is followed: the fastest
   * speed from which we can still stop FOLLOW_GAP_M behind it. Infinity if none.
   */
  private followCapAhead(track: TrackRuntime, lane: number, v: number): number {
    let cap = Infinity
    const list = raceBook.racers
    const reach = (v * v) / (2 * PLAN_DECEL) + 40
    for (let i = 0; i < list.length; i++) {
      const o = list[i]
      if (o.id === this.id) continue
      const gap = track.deltaS(this.s, o.s) - CAR_LEN
      if (gap < -CAR_LEN * 0.5 || gap > reach) continue
      if (Math.abs(o.lateral - lane) > 2.6 && Math.abs(o.lateral - this.hit.lateral) > 2.6) continue
      const ov = Math.max(0, o.speed)
      if (ov >= v) continue
      const c = Math.sqrt(ov * ov + 2 * PLAN_DECEL * Math.max(0, gap - FOLLOW_GAP_M))
      if (c < cap) cap = c
    }
    return cap
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
