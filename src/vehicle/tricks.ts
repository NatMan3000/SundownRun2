// ============================================================
//  TRICKS - air, spins, flips, rolls, loops, wall rides, drifts
// ------------------------------------------------------------
//  The player's car feeds this once per physics step. It scores
//  and announces through the event feed (src/core/events.ts):
//
//    air.start     the car has really left the ground
//    trick.land    a landing (or a finished loop / wall ride) scored
//    trick.wipeout landed on the roof or crashed mid-air: the pending
//                  combo is lost (points already banked are kept)
//    drift.end     a held drift finished and scored
//
//  ONE AIR SESSION = ONE COMBO. Takeoff opens a session; touchdown
//  closes it. Everything in between is scored AT THE LANDING, never
//  mid-air - that is the only honest way for a crash to void the
//  combo. There are no participation points: just landing earns
//  nothing, only tricks do.
//
//  WHY INTEGRATE ANGULAR RATE: a trick is a winding number. A 720
//  is two full turns; comparing takeoff and landing rotations says
//  "zero". Adding up the spin rate every step counts the turns.
//
//  Landings are forgiving: a scruffy two-wheel touchdown gets a
//  short recovery window (~0.35 s) to settle upright and still
//  score. Settling wrong, or landing on the roof, is a wipeout.
//  "Upright" is judged against the surface under the car, never
//  world up, so a 60 deg bank or a wall ride is not "on its side".
// ============================================================

import type * as THREE from 'three'
import { emit } from '../core/events'
import type { TrickName } from '../core/events'
import { useGame } from '../core/store'
import type { TrackRuntime } from '../track/types'
import { DT } from './tuning'

const TWO_PI = Math.PI * 2
const RAD2DEG = 180 / Math.PI

// ---------- what counts, and what it is worth ----------

/** Below this hang time the session is a kerb bump: nothing scores. */
const MIN_AIR_S = 0.4
/** air.start fires once the car has been off the ground this long (no kerb-bump spam). */
const AIR_START_S = 0.2
/** Car up vs ground normal at touchdown: at or above this it landed on its wheels. */
const UPRIGHT_MIN = 0.5
/** The two-wheel save: steps a scruffy landing gets to settle upright (~0.35 s). */
const RECOVER_STEPS = 21
/** After a reset or teleport, this many steps of falling are ignored (~0.75 s). */
const QUIET_STEPS = 45
/** ...and an air session that starts inside that window must last this long to count. */
const QUIET_AIR_S = 1.0
/** Wheels up with the body on the ground for this long (~0.15 s) = a wipeout, not air. */
const RESTING_STEPS = 9

/** Air tiers by hang time, highest first: [seconds, name, label]. */
const AIR_TIERS: ReadonlyArray<readonly [number, TrickName, string]> = [
  [2.4, 'hugeAir', 'TO THE MOON'],
  [1.7, 'hugeAir', 'HUGE AIR'],
  [1.1, 'bigAir', 'BIG AIR'],
  [0.6, 'air', 'AIR'],
]
/** Air points grow with the square of hang time: 0.6 s = 20, 1 s = 55, 2.4 s = 317. */
const AIR_PTS_PER_S2 = 55
const SPIN_HALF_PTS = 100 // per 180 degrees
const FLIP_PTS = 250 //      per full flip
const ROLL_PTS = 250 //      per full barrel roll
/** Each trick beyond the first in one landing adds this much of the total. */
const COMBO_RATE = 0.25

const LOOP_PTS = 400
/** Wall ride: at least this long on the wall to count; points grow with time. */
const WALL_MIN_S = 0.8
const WALL_PTS_PER_S = 120
/** A wall ride flowing straight into a jump joins that jump's combo if takeoff comes this soon. */
const WALL_CHAIN_S = 0.35

const DRIFT_MIN_S = 1.0
/** A drift may flicker for a moment and stay one drift. */
const DRIFT_GAP_STEPS = 24
/** Drift points grow with the square of held time: 1 s = 15, 3 s = 135, 5 s = 375. */
const DRIFT_PTS_PER_S2 = 15

interface Trick {
  name: TrickName
  label: string
  points: number
}

/** Live state for the dev inspector (watch rotation build mid-air). */
export const trickState = {
  airborne: false,
  airSeconds: 0,
  spinDeg: 0,
  flipDeg: 0,
  rollDeg: 0,
  links: 0,
  wallSeconds: 0,
}

/** Dev: the last few wipeouts and why they fired (window.__dev.wipeouts()). Written only on a wipeout. */
export const wipeoutLog: { why: string; trackS: number; upY: number; upDot: number; airS: number; speedKmh: number }[] = []

function multi(n: number, base: string): string {
  if (n <= 1) return base
  if (n === 2) return 'DOUBLE ' + base
  if (n === 3) return 'TRIPLE ' + base
  return `${n}x ${base}`
}

/**
 * Turn a finished air session into the tricks it earned. Pure: unit-testable
 * without physics. `extra` holds a wall ride that flowed into the jump.
 */
export function classifyLanding(airSeconds: number, yaw: number, pitch: number, roll: number, extra: Trick | null): Trick[] {
  const out: Trick[] = []
  if (extra) out.push(extra)
  for (let i = 0; i < AIR_TIERS.length; i++) {
    if (airSeconds >= AIR_TIERS[i][0]) {
      out.push({ name: AIR_TIERS[i][1], label: AIR_TIERS[i][2], points: Math.round(airSeconds * airSeconds * AIR_PTS_PER_S2) })
      break
    }
  }
  const halves = Math.floor(Math.abs(yaw) / Math.PI)
  if (halves > 0) out.push({ name: 'spin', label: `${halves * 180} SPIN`, points: halves * SPIN_HALF_PTS })
  // + pitch rate lifts the nose: over backwards is a backflip.
  const flips = Math.floor(Math.abs(pitch) / TWO_PI)
  if (flips > 0) out.push({ name: 'flip', label: multi(flips, pitch < 0 ? 'FRONT FLIP' : 'BACKFLIP'), points: flips * FLIP_PTS })
  const rolls = Math.floor(Math.abs(roll) / TWO_PI)
  if (rolls > 0) out.push({ name: 'roll', label: multi(rolls, 'BARREL ROLL'), points: rolls * ROLL_PTS })
  return out
}

/** Live link count mid-air (for the HUD combo number). */
function liveLinks(airSeconds: number, yaw: number, pitch: number, roll: number, wall: boolean): number {
  let n = wall ? 1 : 0
  if (airSeconds >= AIR_TIERS[AIR_TIERS.length - 1][0]) n++
  if (Math.abs(yaw) >= Math.PI) n++
  if (Math.abs(pitch) >= TWO_PI) n++
  if (Math.abs(roll) >= TWO_PI) n++
  return n
}

/** What the detector needs from the car each step (the sim's own fields). */
export interface TrickInput {
  airborne: boolean
  up: THREE.Vector3
  fwd: THREE.Vector3
  right: THREE.Vector3
  angvel: THREE.Vector3
  groundNormal: THREE.Vector3
  speedKmh: number
  drifting: boolean
  driftAngle: number
  impact: number
  onWall: boolean
  trackS: number
  hasTrackS: boolean
  /** No wheel down but the body is touching the world (lying on the roof or side, or beached). */
  chassisTouching: boolean
  /** While chassisTouching: car up . the surface normal at the body contact (1 belly, 0 side, -1 roof). */
  chassisSupportUp: number
  /** Up of the surface under the car (ground normal, or the road's up when flying over it). */
  surfaceUp: THREE.Vector3
}

export class TrickDetector {
  private active = false
  private airSteps = 0
  private airStarted = false
  private yaw = 0
  private pitch = 0
  private roll = 0
  private pendingSteps = 0
  private pendingAir = 0
  private lastUp = 1
  private links = 0
  // wall rides
  private wallSteps = 0
  private wallOffSteps = 0
  private wallCarry: Trick | null = null
  // drifts
  private driftSteps = 0
  private driftGap = 0
  private driftMaxAngle = 0
  // loops: index of the loop piece we entered, its entry s
  private loopIndex = -1
  /** Steps after a reset / teleport during which a fall is not "air" (the 1 m settle drop). */
  private quietSteps = 0
  /** This air session began right after a reset: a short one is the settle drop, not air. */
  private quietSession = false
  /** Steps the car has spent wheels-up but not really flying (lying on its roof or side). */
  private restingSteps = 0
  /** Set after a resting wipeout: no new air session until a wheel touches down again. */
  private grounded = true

  /**
   * Drop whatever is in flight (a reset or teleport is not a landing). A reset
   * that arrives while the car is DOWN - on its roof, or inside the recovery
   * window - counts as the wipeout it is.
   */
  cancel(): void {
    if (this.pendingSteps > 0 || (this.active && this.lastUp < UPRIGHT_MIN)) this.wipeout('reset while down')
    this.settle()
    this.driftSteps = 0
    this.driftGap = 0
    this.wallSteps = 0
    this.wallOffSteps = 0
    this.wallCarry = null
    this.loopIndex = -1
    this.quietSteps = QUIET_STEPS
    this.restingSteps = 0
  }

  /** Once per physics step. Ground: a handful of comparisons. Air: three dot products. */
  update(c: TrickInput, track: TrackRuntime | null, enabled: boolean): void {
    if (!enabled) {
      if (this.active || this.pendingSteps > 0) this.settle()
      return
    }
    // "Upright" is always judged against the SURFACE under the car (the wheels' ground normal,
    // or in the air the road's own up), never world up: on a 60 deg bank or a wall-ride exit
    // a car on its wheels is upright, whatever world up says.
    const upDot = c.up.dot(c.surfaceUp)
    this.lastUp = upDot
    // The body touching the world with the car upright on it (beached on a crest, a belly
    // landing) is not flying and not a wipeout: it counts as down on its wheels' side.
    const onBelly = c.airborne && c.chassisTouching && c.chassisSupportUp >= UPRIGHT_MIN
    const airborne = c.airborne && !onBelly

    this.stepDrift(!c.airborne && c.drifting, c.driftAngle)
    this.stepWall(c)
    if (track) this.stepLoop(c, track)

    if (!airborne) this.grounded = true
    if (this.quietSteps > 0) this.quietSteps-- // see quietSession
    // Wheels up and the body on the ground ON ITS ROOF OR SIDE: a wipeout, never "air".
    if (airborne && c.chassisTouching) {
      this.restingSteps++
      if (this.restingSteps === RESTING_STEPS) {
        if (this.active || this.pendingSteps > 0) this.wipeout('resting on the body', c)
        this.settle()
        this.grounded = false
      }
      if (this.restingSteps >= RESTING_STEPS) return
    } else {
      this.restingSteps = 0
    }
    // After a wipeout, nothing new starts until a wheel touches down again.
    if (airborne && !this.active && !this.grounded) return

    if (airborne) {
      if (!this.active) {
        this.active = true
        // A bounce out of a scruffy landing continues the SAME session.
        if (this.pendingSteps === 0) {
          this.airSteps = 0
          this.yaw = 0
          this.pitch = 0
          this.roll = 0
          this.airStarted = false
          this.quietSession = this.quietSteps > 0
        }
        this.pendingSteps = 0
      }
      this.airSteps++
      this.yaw += c.angvel.dot(c.up) * DT
      this.pitch += c.angvel.dot(c.right) * DT
      this.roll += c.angvel.dot(c.fwd) * DT
      const airS = this.airSteps * DT
      if (!this.airStarted && airS >= (this.quietSession ? QUIET_AIR_S : AIR_START_S)) {
        this.airStarted = true
        emit('air.start', { speedKmh: Math.round(c.speedKmh) })
      }
      // A hard hit while upside down mid-air (roof first into the ground, a wall): wipeout now.
      if (c.impact > 0.25 && upDot < -0.2 && airS >= MIN_AIR_S) {
        this.wipeout('hit while upside down', c)
        this.settle()
        return
      }
      this.publishLive(airS)
      return
    }

    // Just touched down.
    if (this.active) {
      const airS = this.airSteps * DT
      this.active = false
      if (airS < MIN_AIR_S || (this.quietSession && airS < QUIET_AIR_S)) {
        this.settle()
        return
      }
      if (upDot >= UPRIGHT_MIN) {
        this.score(airS, true)
        return
      }
      this.pendingSteps = RECOVER_STEPS
      this.pendingAir = airS
      trickState.airborne = false
      return
    }
    // Scruffy landing: settle upright inside the window and it still scores.
    if (this.pendingSteps > 0) {
      if (upDot >= UPRIGHT_MIN) {
        this.score(this.pendingAir, false)
        return
      }
      this.pendingSteps--
      if (this.pendingSteps === 0) {
        this.wipeout('did not settle upright', c)
        this.settle()
      }
    }
  }

  // ---------------------------------------------------------------- scoring

  private score(airS: number, clean: boolean): void {
    const tricks = classifyLanding(airS, this.yaw, this.pitch, this.roll, this.wallCarry)
    this.wallCarry = null
    this.settle()
    this.bank(tricks, airS, clean)
  }

  /** Bank a set of tricks as one landing: combo bonus, store, event. */
  private bank(tricks: Trick[], airS: number, clean: boolean): void {
    if (tricks.length === 0) return
    const links = tricks.length
    let total = 0
    for (const t of tricks) total += t.points
    if (links >= 2) {
      const bonus = Math.round(total * COMBO_RATE * (links - 1))
      tricks.push({ name: tricks[0].name, label: `COMBO x${links}`, points: bonus })
      total += bonus
    }
    const combo = links
    useGame.setState((s) => ({ trickScore: s.trickScore + total, comboCount: 0 }))
    emit('trick.land', { tricks, airTimeS: Math.round(airS * 100) / 100, combo, points: total, clean })
  }

  private wipeout(why: string, c?: TrickInput): void {
    if (wipeoutLog.length >= 20) wipeoutLog.shift()
    wipeoutLog.push({
      why,
      trackS: c ? Math.round(c.trackS) : -1,
      upY: c ? Math.round(c.up.y * 100) / 100 : NaN,
      upDot: Math.round(this.lastUp * 100) / 100,
      airS: Math.round((this.pendingSteps > 0 ? this.pendingAir : this.airSteps * DT) * 100) / 100,
      speedKmh: c ? Math.round(c.speedKmh) : -1,
    })
    // What the pending session WOULD have scored is what was lost.
    const airS = this.pendingSteps > 0 ? this.pendingAir : this.airSteps * DT
    const tricks = classifyLanding(airS >= MIN_AIR_S ? airS : 0, this.yaw, this.pitch, this.roll, this.wallCarry)
    let lost = 0
    for (const t of tricks) lost += t.points
    if (tricks.length >= 2) lost += Math.round(lost * COMBO_RATE * (tricks.length - 1))
    this.wallCarry = null
    this.grounded = false
    useGame.setState({ comboCount: 0 })
    emit('trick.wipeout', { lostPoints: lost })
  }

  private publishLive(airS: number): void {
    trickState.airborne = true
    trickState.airSeconds = airS
    trickState.spinDeg = this.yaw * RAD2DEG
    trickState.flipDeg = this.pitch * RAD2DEG
    trickState.rollDeg = this.roll * RAD2DEG
    const links = liveLinks(airS, this.yaw, this.pitch, this.roll, this.wallCarry !== null)
    trickState.links = links
    if (links !== this.links) {
      this.links = links
      useGame.setState({ comboCount: links }) // changes a few times per jump at most
    }
  }

  private settle(): void {
    this.active = false
    this.airSteps = 0
    this.airStarted = false
    this.yaw = 0
    this.pitch = 0
    this.roll = 0
    this.pendingSteps = 0
    this.pendingAir = 0
    trickState.airborne = false
    trickState.airSeconds = 0
    trickState.spinDeg = 0
    trickState.flipDeg = 0
    trickState.rollDeg = 0
    trickState.links = 0
    if (this.links !== 0) {
      this.links = 0
      useGame.setState({ comboCount: 0 })
    }
  }

  // ---------------------------------------------------------------- drift

  private stepDrift(drifting: boolean, angle: number): void {
    if (drifting) {
      this.driftSteps++
      this.driftGap = 0
      const a = Math.abs(angle) * RAD2DEG
      if (a > this.driftMaxAngle) this.driftMaxAngle = a
      return
    }
    if (this.driftSteps === 0) return
    this.driftGap++
    if (this.driftGap < DRIFT_GAP_STEPS) return
    const held = this.driftSteps * DT
    const maxAngle = this.driftMaxAngle
    this.driftSteps = 0
    this.driftGap = 0
    this.driftMaxAngle = 0
    if (held < DRIFT_MIN_S) return
    const points = Math.round(held * held * DRIFT_PTS_PER_S2)
    useGame.setState((s) => ({ trickScore: s.trickScore + points }))
    emit('drift.end', { seconds: Math.round(held * 10) / 10, points, maxAngleDeg: Math.round(maxAngle) })
  }

  // ---------------------------------------------------------------- wall rides

  private stepWall(c: TrickInput): void {
    if (c.onWall && !c.airborne) {
      this.wallSteps++
      this.wallOffSteps = 0
      trickState.wallSeconds = this.wallSteps * DT
      return
    }
    if (this.wallSteps === 0) return
    this.wallOffSteps++
    const secs = this.wallSteps * DT
    // Flowing straight off the wall into the air: the ride joins the jump's combo.
    if (c.airborne && this.wallOffSteps * DT <= WALL_CHAIN_S) {
      if (secs >= WALL_MIN_S) this.wallCarry = this.wallTrick(secs)
      this.wallSteps = 0
      trickState.wallSeconds = 0
      return
    }
    if (this.wallOffSteps * DT < WALL_CHAIN_S) return
    this.wallSteps = 0
    trickState.wallSeconds = 0
    if (secs >= WALL_MIN_S) this.bank([this.wallTrick(secs)], 0, true)
  }

  private wallTrick(secs: number): Trick {
    return { name: 'wallRide', label: `WALL RIDE ${secs.toFixed(1)}s`, points: Math.round(secs * WALL_PTS_PER_S) }
  }

  // ---------------------------------------------------------------- loops

  /** A loop counts when the car goes in at its start and comes out past its end, in order. */
  private stepLoop(c: TrickInput, track: TrackRuntime): void {
    if (!c.hasTrackS) return
    const pieces = track.pieces
    if (this.loopIndex >= 0) {
      const p = pieces[this.loopIndex]
      if (!p || p.type !== 'loop') {
        this.loopIndex = -1
        return
      }
      const along = track.deltaS(p.s0, c.trackS)
      const len = track.deltaS(p.s0, p.s1)
      if (along > len + 2) {
        this.loopIndex = -1
        if (!c.airborne) this.bank([{ name: 'loop', label: 'LOOP', points: LOOP_PTS }], 0, true)
      } else if (along < -4) {
        this.loopIndex = -1 // rolled back out of the entry: no loop
      }
      return
    }
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i]
      if (p.type !== 'loop') continue
      const along = track.deltaS(p.s0, c.trackS)
      if (along >= 0 && along < 3) {
        this.loopIndex = i
        return
      }
    }
  }
}
