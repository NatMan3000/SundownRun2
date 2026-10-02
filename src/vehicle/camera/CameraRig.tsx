// ============================================================
//  CAMERA RIG - springs, never parenting
// ------------------------------------------------------------
//  The camera has its own position, look target, up vector and
//  field of view, and each chases its target through a critically
//  damped spring - so it lags into corners, settles without
//  overshoot and never snaps. The one exception is a reset (R,
//  Shift+R, a teleport), the single sanctioned cut.
//
//  What it does, in order, every frame:
//    1. pick the shot: a checker bookmark, the title showroom, the
//       results orbit, or the driving rig (chase / close / bonnet)
//    2. driving: sit behind the car's VELOCITY, not its nose, so a
//       drift reads sideways across the screen; on loops, wall rides
//       and steep banks the up vector springs toward the car's up.
//       The bonnet camera is the exception: it is bolted to the car,
//       on its bonnet, and turns with it everywhere (a crest pitches
//       the view, a bank leans it, a barrel roll rolls it), through
//       a light filter that only soaks up suspension chatter
//    3. never clip: a ray from the car to the camera pulls it in
//       front of any road, wall or barrier, and it stays above the
//       terrain. A slab (road, loop, wall, ramp) is never let inside:
//       lines just beside the camera and a moment ahead see one
//       coming, so the arm eases in before it arrives instead of
//       jumping, and a slab's side between car and camera lifts the
//       camera over it
//    4. FOV = setting + speed + boost kick; speed shake; impact kick
//
//  Zero allocation per frame.
// ============================================================

import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { controlSignals } from '../../core/controls'
import { urlParam, registerDev } from '../../core/devHandles'
import { environment, getCar, telemetry } from '../../core/telemetry'
import { getSettings, useSettings } from '../../core/settings'
import type { CameraMode } from '../../core/settings'
import { getGame } from '../../core/store'
import { GROUPS, surfaceOf } from '../../core/physics'
import { getTrack } from '../../track/current'
import { links } from '../links'
import { computeShot } from './bookmarks'
import type { Shot } from './bookmarks'
import { CAMERA, CAMERA_MODES, RIGS, TRANSITION_S } from './rigs'
import type { CameraRigSpec } from './rigs'
import type { TrackFrame } from '../../track/types'

// ---------------------------------------------------------------- module temps

const _camPos = new THREE.Vector3()
const _lookPos = new THREE.Vector3()
const _up = new THREE.Vector3(0, 1, 0)
const _targetPos = new THREE.Vector3()
const _targetLook = new THREE.Vector3()
const _targetUp = new THREE.Vector3()
const _posA = new THREE.Vector3()
const _lookA = new THREE.Vector3()
const _posB = new THREE.Vector3()
const _lookB = new THREE.Vector3()
const _fwd = new THREE.Vector3()
const _dir = new THREE.Vector3()
const _vel = new THREE.Vector3()
const _tmp = new THREE.Vector3()
const _pivot = new THREE.Vector3()
const _airFwd = new THREE.Vector3(0, 0, 1)
const _carry = new THREE.Vector3()
const WORLD_UP = new THREE.Vector3(0, 1, 0)
const _shot: Shot = { position: new THREE.Vector3(), look: new THREE.Vector3() }
const _rendered = new THREE.Vector3()
const _sight = new THREE.Vector3()
const _leadAxis = new THREE.Vector3()
const _leadQ = new THREE.Quaternion()
const _armDir = new THREE.Vector3()
const _side = new THREE.Vector3()
const _lift = new THREE.Vector3()
const _probe = new THREE.Vector3()
const _rel = new THREE.Vector3()
const _relVel = new THREE.Vector3()
const _pivotAhead = new THREE.Vector3()
/** Where the camera stood relative to the clip pivot last frame (for its swing, see CAMERA.clipAhead). */
const _prevRel = new THREE.Vector3()
const _rise = new THREE.Vector3()
/** The car's orientation through the bonnet camera's chatter filter, and the car's real one last frame. */
const _carQf = new THREE.Quaternion()
const _carQPrev = new THREE.Quaternion()
/** The bonnet camera's own spot and view this frame. */
const _bonnetPos = new THREE.Vector3()
const _bonnetQ = new THREE.Quaternion()
const _tiltQ = new THREE.Quaternion()
const X_AXIS = new THREE.Vector3(1, 0, 0)
/** A camera looks down its own -z and a car's nose is its +z: half a turn about up lines them up. */
const FACE_NOSE = new THREE.Quaternion().setFromAxisAngle(WORLD_UP, Math.PI)
/** The road frame under the car (is it on a bank, or tipped over off the road?). */
const _carFrame: TrackFrame = {
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
/** The slabs the camera must never sit inside: the road and everything built like it. */
function isSlab(collider: { handle: number }): boolean {
  const k = surfaceOf(collider.handle)
  return k === 'road' || k === 'loop' || k === 'wall' || k === 'ramp' || k === 'skirt'
}

/** The arm limits the look-ahead found at each of CAMERA.clipAhead's times (scratch, per frame). */
const ahead = [Infinity, Infinity]

/** Fractions of its height above the pivot tried, highest first, when ducking the target under a slab. */
const DUCK_STEPS = [0.6, 0.3, 0] as const

/** tan(21.5 deg): how far left of the car the showroom camera aims, per metre of distance. */
const SHOWROOM_OFFSET = 0.39
/**
 * Title showroom framing (ui): the sun is the hero, so the orbit is biased off
 * the anti-sun line to put the sun in the open gap between the menu column and
 * the car, and only sways a little around that, so it never leaves the frame.
 */
const SHOWROOM_SUN_BIAS = -0.35 // rad (negative moves the sun left on screen)
const SHOWROOM_SWAY = 0.12 // rad
/** The title showroom's distance and height from the car, metres. */
const SHOWROOM_R = 7.8
const SHOWROOM_H = 1.7
/**
 * Garage framing (ui): the car is the hero. The camera circles it slowly on its own,
 * lingering on the front three-quarter view (nose pointing into the open screen beside
 * the panel) and moving quicker round the back, so you see the front, the side and the
 * back without touching anything. It never dips below the car's roofline.
 */
const GARAGE = {
  radius: 6.4,
  height: 1.9,
  lookHeight: 0.62,
  /** The hero view: this far round from the nose, on the car's left (rad, 40 deg). */
  hero: 0.7,
  /** Orbit speed at the hero view and straight opposite it, rad/s (a lap takes about 40 s). */
  slow: 0.07,
  fast: 0.3,
  /** tan(23 deg): aim this far left of the car per metre, so it sits in the open area right of the panel. */
  offset: 0.42,
  /** Seconds to ease between the title shot and the garage shot. */
  blendS: 0.9,
}
/** Spring time of the showroom orbit angle: the camera swings round the car, never through it. */
const SHOWROOM_YAW_SMOOTH = 0.8
/**
 * Results: the panel sits left like every other menu over the game, so the car is framed
 * in the open area to its right. The orbit is wider and higher than the showroom's.
 */
const RESULTS_R = 9.5
const RESULTS_H = 3.2
const RESULTS_OFFSET = 0.4

// spring velocities: [0..2] position, [3..5] look, [6..8] up, [9] fov, [10] showroom orbit angle
const springVel = new Float64Array(11)

/** Live camera state (inspector: window.__game.get('camera')). */
export const cameraState = {
  mode: 'chase' as CameraMode,
  from: 'chase' as CameraMode,
  transition: 1,
  fov: 62,
  shot: 'drive' as 'drive' | 'showroom' | 'results' | 'bookmark',
  bookmark: '' as string,
  clipped: false,
  /** Metres from the car's pivot up to a slab overhead (Infinity = none within reach): see CAMERA.ceilingPad. */
  ceiling: Infinity,
  /** The camera arm this frame, metres from the pivot: what the springs want, and what it got after the clip. */
  armWant: 0,
  arm: 0,
  /** The look-ahead's arm limit (soft) and the slab on the line itself (Infinity = none), metres. */
  armSoft: Infinity,
  armSlab: Infinity,
  /** How far above the car the clip's pivot is this frame, metres (CAMERA.pivotHeight unless a slab is closer). */
  pivotUp: 1.1,
  /** Metres the target was lifted over a slab's side this frame (0 = not needed, -1 = needed but no lift cleared it). */
  rise: 0,
  /** How far the line from the car to the camera is clear, metres (Infinity = all of it). */
  armClear: Infinity,
  /** The sprung camera position, before the wall clip and the impact kick. */
  position: _camPos,
  /** Where the camera really is this frame (after the clip and the kick). */
  rendered: _rendered,
  up: _up,
  /** 0..1 how much of the view is the bonnet camera right now (eases across a mode change). */
  bonnet: 0,
  /** True this frame if the up vector follows the car's (a loop, a wall ride or a steep bank). */
  followUp: false,
}

// ---------------------------------------------------------------- camLog (dev)
// A per-frame record of the camera against the car, so a checker can prove the bonnet camera
// rides with the car (its up stays on the car's up) and that nothing pops on a mode change:
// __dev.camLog(seconds) starts it, __dev.camLogGet() reads it back. The buffer is made on the
// first recording, never in a normal game, and filling it allocates nothing.
const LOG_COLS = 24
const LOG_ROWS = 120 * 60 // a minute at 120 fps
const camLog = { on: false, t0: -1, seconds: 0, n: 0, rows: null as Float64Array | null }
const _logUp = new THREE.Vector3()

/** Write this frame's row: time, mode, blend, flags, speed, then camera and car quaternions and positions. */
function recordCamLog(camera: THREE.PerspectiveCamera, t: number, dt: number, cut: boolean): void {
  const rows = camLog.rows
  if (!camLog.on || !rows) return
  if (camLog.t0 < 0) camLog.t0 = t
  if (t - camLog.t0 > camLog.seconds || camLog.n >= LOG_ROWS) {
    camLog.on = false
    return
  }
  const o = camLog.n * LOG_COLS
  const q = camera.quaternion
  const c = telemetry.carQuaternion
  rows[o] = t - camLog.t0
  rows[o + 1] = dt
  rows[o + 2] = CAMERA_MODES.indexOf(cameraState.mode)
  rows[o + 3] = cameraState.bonnet
  rows[o + 4] = (telemetry.airborne ? 1 : 0) | (telemetry.magGrip ? 2 : 0) | (cameraState.followUp ? 4 : 0) | (cut ? 8 : 0)
  rows[o + 5] = telemetry.speedKmh
  rows[o + 6] = q.x
  rows[o + 7] = q.y
  rows[o + 8] = q.z
  rows[o + 9] = q.w
  rows[o + 10] = c.x
  rows[o + 11] = c.y
  rows[o + 12] = c.z
  rows[o + 13] = c.w
  rows[o + 14] = camera.position.x
  rows[o + 15] = camera.position.y
  rows[o + 16] = camera.position.z
  rows[o + 17] = telemetry.carPosition.x
  rows[o + 18] = telemetry.carPosition.y
  rows[o + 19] = telemetry.carPosition.z
  // the angle between the camera's up and the car's up, degrees (the number the bonnet camera keeps small)
  _logUp.set(0, 1, 0).applyQuaternion(q)
  rows[o + 20] = (Math.acos(Math.min(1, Math.max(-1, _logUp.dot(telemetry.carUp)))) * 180) / Math.PI
  rows[o + 21] = telemetry.wheelsDown
  rows[o + 22] = cameraState.transition
  rows[o + 23] = telemetry.trackS
  camLog.n++
}

/** The camLog as readable rows (dev only, so this one may allocate). */
function readCamLog(every: number, raw: boolean): Record<string, number | string | boolean | number[]>[] {
  const rows = camLog.rows
  const out: Record<string, number | string | boolean | number[]>[] = []
  if (!rows) return out
  const camQ = new THREE.Quaternion()
  const carQ = new THREE.Quaternion()
  const prevCamQ = new THREE.Quaternion()
  const prevCarQ = new THREE.Quaternion()
  const inv = new THREE.Quaternion()
  const up = new THREE.Vector3()
  const fwd = new THREE.Vector3()
  const carUp = new THREE.Vector3()
  const carFwd = new THREE.Vector3()
  const rel = new THREE.Vector3()
  const prevRel = new THREE.Vector3()
  const deg = (r: number) => (r * 180) / Math.PI
  const r2 = (v: number) => Math.round(v * 100) / 100
  for (let i = 0; i < camLog.n; i++) {
    const o = i * LOG_COLS
    camQ.set(rows[o + 6], rows[o + 7], rows[o + 8], rows[o + 9])
    carQ.set(rows[o + 10], rows[o + 11], rows[o + 12], rows[o + 13])
    up.set(0, 1, 0).applyQuaternion(camQ)
    fwd.set(0, 0, -1).applyQuaternion(camQ) // a camera looks down its own -z
    carUp.set(0, 1, 0).applyQuaternion(carQ)
    carFwd.set(0, 0, 1).applyQuaternion(carQ)
    // the camera's up and its offset from the car, in the car's own frame
    inv.copy(carQ).invert()
    const upLocal = up.clone().applyQuaternion(inv)
    rel.set(rows[o + 14] - rows[o + 17], rows[o + 15] - rows[o + 18], rows[o + 16] - rows[o + 19]).applyQuaternion(inv)
    const first = i === 0
    if (i % every === 0) {
      const flags = rows[o + 4]
      out.push({
        t: r2(rows[o]),
        mode: CAMERA_MODES[rows[o + 2]] ?? '?',
        bonnet: r2(rows[o + 3]),
        transition: r2(rows[o + 22]),
        air: (flags & 1) !== 0,
        mag: (flags & 2) !== 0,
        follow: (flags & 4) !== 0,
        cut: (flags & 8) !== 0,
        kmh: Math.round(rows[o + 5]),
        wheels: rows[o + 21],
        s: Math.round(rows[o + 23]),
        upGap: r2(rows[o + 20]),
        rollGap: r2(deg(Math.atan2(-upLocal.x, upLocal.y))),
        pitchGap: r2(deg(Math.atan2(upLocal.z, upLocal.y))),
        fwdGap: r2(deg(Math.acos(Math.min(1, Math.max(-1, fwd.dot(carFwd)))))),
        tilt: r2(deg(Math.acos(Math.min(1, Math.max(-1, carUp.y))))),
        camTurn: first ? 0 : r2(deg(camQ.angleTo(prevCamQ))),
        carTurn: first ? 0 : r2(deg(carQ.angleTo(prevCarQ))),
        relMove: first ? 0 : Math.round(rel.distanceTo(prevRel) * 1000) / 1000,
        dtMs: r2(rows[o + 1] * 1000),
        ...(raw ? { camQ: camQ.toArray(), carQ: carQ.toArray(), dt: rows[o + 1] } : {}),
      })
    }
    prevCamQ.copy(camQ)
    prevCarQ.copy(carQ)
    prevRel.copy(rel)
  }
  return out
}

/** Critically damped smoothing (Unity's SmoothDamp): stable at any dt, never overshoots. */
function smoothDamp(current: number, target: number, i: number, smoothTime: number, dt: number): number {
  const omega = 2 / Math.max(smoothTime, 1e-4)
  const x = omega * dt
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x)
  const change = current - target
  const temp = (springVel[i] + omega * change) * dt
  springVel[i] = (springVel[i] - omega * temp) * exp
  return target + (change + temp) * exp
}

/** True if the car is on the road and sitting with the road's up (a bank), not tipped over beside it. */
function onTheRoad(track: ReturnType<typeof getTrack>): boolean {
  if (!track) return true
  track.frameAt(telemetry.trackS, _carFrame)
  return Math.abs(telemetry.lateral) <= _carFrame.halfWidth + 0.5 && telemetry.carUp.dot(_carFrame.up) > CAMERA.steepCos
}

/** Move the look target `metres` to the camera's left (on the ground plane), so the car sits right of centre. */
function aimLeftOfCar(metres: number): void {
  _dir.subVectors(_targetLook, _targetPos).setY(0).normalize()
  _vel.crossVectors(_dir, WORLD_UP).normalize() // camera right
  _targetLook.addScaledVector(_vel, -metres)
}

function smoothstep01(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t
  return x * x * (3 - 2 * x)
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Where the bonnet camera sits right now: each body says (CarAnchors.bonnet); the rig's numbers are the fallback. */
function bonnetMount(rig: CameraRigSpec, out: THREE.Vector3): THREE.Vector3 {
  const mount = getCar('player')?.anchors?.bonnet
  _tmp.set(0, mount ? mount.y : rig.mountY, mount ? mount.z : rig.mountZ).applyQuaternion(telemetry.carQuaternion)
  return out.copy(telemetry.carPosition).add(_tmp)
}

/** How far a smoothing step moves toward its target so that wobbles faster than `cutoffHz` fade (a first-order low-pass). */
function lowPassAlpha(cutoffHz: number, dt: number): number {
  return 1 / (1 + 1 / (2 * Math.PI * cutoffHz * Math.max(dt, 1e-4)))
}

/**
 * One step of the bonnet camera's chatter filter (a "one euro" filter, on the car's orientation).
 * It eases _carQf toward the car's real orientation, and the quicker the car is turning, the less it
 * holds back: suspension jiggle (small, quick, going nowhere) is smoothed, while a flip, a roll or a
 * landing (a real turn) goes straight through. `restart` starts it again on the car itself (a cut).
 */
function filterCarTurn(state: { turnRate: number }, restart: boolean, dt: number): void {
  const q = telemetry.carQuaternion
  if (!restart) {
    const rate = q.angleTo(_carQPrev) / Math.max(dt, 1e-3) // rad/s the car turned since last frame
    state.turnRate += (rate - state.turnRate) * lowPassAlpha(CAMERA.bonnetTurnCutoff, dt)
    _carQf.slerp(q, lowPassAlpha(CAMERA.bonnetCutoff + CAMERA.bonnetCutoffPerTurn * state.turnRate, dt))
  }
  // a cut, or anything non-finite: sit exactly on the car again
  if (restart || !Number.isFinite(state.turnRate + _carQf.x + _carQf.y + _carQf.z + _carQf.w)) {
    _carQf.copy(q)
    state.turnRate = 0
  }
  _carQPrev.copy(q)
}

/** Where a rig wants the camera and its look target right now (U = the camera's up). */
function rigTarget(rig: CameraRigSpec, mode: CameraMode, speed: number, outPos: THREE.Vector3, outLook: THREE.Vector3): void {
  const set = getSettings()
  const carPos = telemetry.carPosition
  if (rig.kind === 'mount') {
    bonnetMount(rig, outPos)
    outLook.copy(outPos).addScaledVector(telemetry.carForward, rig.lookAhead + speed * rig.lookAheadSpeedGain).addScaledVector(telemetry.carUp, rig.lookHeight)
    return
  }
  const speedFrac = Math.min(speed / Math.max(10, set.topSpeedKmh / 3.6), 1)
  const baseDist = mode === 'chase' ? set.cameraDistance : rig.distance
  const baseHeight = mode === 'chase' ? set.cameraHeight : rig.height
  const dist = baseDist * (1 + CAMERA.distanceSpeedGain * speedFrac)
  const height = baseHeight * (1 + CAMERA.heightSpeedGain * speedFrac)

  _dir.copy(_fwd)
  if (speed > 3 && !telemetry.airborne) {
    // Swing toward where the car is GOING (never whip round when reversing).
    _vel.copy(telemetry.carVelocity).addScaledVector(_up, -telemetry.carVelocity.dot(_up))
    if (_vel.lengthSq() > 1e-4) {
      _vel.normalize()
      if (_vel.dot(_fwd) > 0) {
        const blend = Math.min(speed / 10, 1) * (rig.velocityBlendBase + rig.velocityBlendSlip * telemetry.slip)
        _dir.lerp(_vel, Math.min(blend, 0.9)).normalize()
      }
    }
  }
  outPos.copy(carPos).addScaledVector(_dir, -dist).addScaledVector(_up, height)
  outLook.copy(carPos).addScaledVector(_fwd, rig.lookAhead + speed * rig.lookAheadSpeedGain).addScaledVector(_up, rig.lookHeight)
}

export function CameraRig() {
  const s = useRef({
    ready: false,
    resetTick: -1,
    cycleSeen: controlSignals.cameraCycle,
    orbitAngle: 0,
    /** The showroom camera's angle round the car (world yaw, rad), eased toward the shot's. */
    showYaw: 0,
    /** Garage orbit: the angle from the car's nose, rad. */
    garageAngle: 0,
    /** 0 = title shot, 1 = garage shot (eased over GARAGE.blendS). */
    garageBlend: 0,
    /** How far a wall or the road shortens the camera arm right now, metres (0 = clear). */
    clipPull: 0,
    /** Last frame's arm length after the clip, metres (Infinity = nothing to ease from). */
    clipArm: Infinity,
    /** The player's last re-seat this camera has carried itself through (CarSim.seatMove.tick). */
    seatTick: -1,
    /** How far the camera is lowered to keep clear of a slab's underside right now, metres. */
    underDuck: 0,
    /** _prevRel holds last frame's camera-from-pivot (false after a cut). */
    prevRelOk: false,
    /** Seconds the look-ahead's pull is held after it last saw a slab coming (CAMERA.clipHold). */
    softHold: 0,
    /** Still cutting after a reset (until the first frame after the next physics step): see the snap below. */
    snapping: false,
    /** links.playerStepAt when the reset was seen. */
    snapStep: 0,
    /** How far the view has eased to the bonnet camera, 0..1 before the ease curve (see bonnetW below). */
    bonnetBlend: 0,
    /** The chatter filter's sense of how fast the car is turning, rad/s (see filterCarTurn). */
    turnRate: 0,
  }).current
  const camera = useThree((st) => st.camera) as THREE.PerspectiveCamera
  const ray = useRef<InstanceType<NonNullable<typeof links.rapier>['Ray']> | null>(null)
  const rayRapier = useRef<typeof links.rapier>(null)
  /** The shared ray, (re)made for the live rapier instance; null before physics is up. */
  const getRay = () => {
    if (!links.rapier) return null
    if (!ray.current || rayRapier.current !== links.rapier) {
      ray.current = new links.rapier.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 })
      rayRapier.current = links.rapier
    }
    return ray.current
  }
  /**
   * Metres straight up (along the camera's up) from `from` to the underside of a road, loop,
   * wall or ramp slab overhead, within `reach`; Infinity if none. Terrain never counts: a hill
   * is not a ceiling.
   */
  const ceilingAbove = (from: THREE.Vector3, reach: number): number => slabHit(from, _up, reach, 2)
  /**
   * Distance along `dir` (unit) from `from` to a road, loop, wall or ramp slab within `reach`
   * whose face turns toward the camera's down by more than `downDot` (2 = any face), else
   * Infinity. Terrain, the floor and barriers never count.
   */
  const slabHit = (from: THREE.Vector3, dir: THREE.Vector3, reach: number, downDot: number): number => {
    const r = getRay()
    if (!r || !links.world) return Infinity
    r.origin.x = from.x
    r.origin.y = from.y
    r.origin.z = from.z
    r.dir.x = dir.x
    r.dir.y = dir.y
    r.dir.z = dir.z
    const hit = links.world.castRayAndGetNormal(r, reach, true, undefined, GROUPS.wheelRay, undefined, links.playerBody ?? undefined)
    if (!hit) return Infinity
    const kind = surfaceOf(hit.collider.handle)
    if (kind === 'terrain' || kind === 'floor' || kind === 'barrier') return Infinity
    if (downDot < 1 && -(hit.normal.x * _up.x + hit.normal.y * _up.y + hit.normal.z * _up.z) < downDot) return Infinity
    return hit.timeOfImpact
  }
  /**
   * Distance along `dir` (unit) from `from` to the first road, loop, wall, ramp or skirt face within
   * `reach` (Infinity if none): the slabs the camera must never sit inside. Terrain, barriers and
   * anything else (a billboard's post) are left out.
   */
  const slabAlong = (from: THREE.Vector3, dir: THREE.Vector3, reach: number): number => {
    const r = getRay()
    if (!r || !links.world) return Infinity
    r.origin.x = from.x
    r.origin.y = from.y
    r.origin.z = from.z
    r.dir.x = dir.x
    r.dir.y = dir.y
    r.dir.z = dir.z
    const hit = links.world.castRay(r, reach, true, undefined, GROUPS.wheelRay, undefined, links.playerBody ?? undefined, isSlab)
    return hit ? hit.timeOfImpact : Infinity
  }
  /**
   * The clip's pivot: CAMERA.pivotHeight above the car along the camera's up, or less if a slab is
   * closer than that over the car (a car tipped into the slot beside a loop): every clip ray starts
   * here, and one that starts inside a slab cannot see the faces round it.
   */
  const setPivot = (): void => {
    _pivot.copy(telemetry.carPosition)
    const room = slabAlong(_pivot, _up, CAMERA.pivotHeight + CAMERA.wallPad)
    const h = Math.max(Math.min(CAMERA.pivotHeight, room - CAMERA.wallPad), 0.2)
    cameraState.pivotUp = h
    _pivot.addScaledVector(_up, h)
  }
  /** True if the first slab on the straight line from `a` to `b` meets it on a side face (its skirt, not its top or underside). */
  const sideBlocked = (a: THREE.Vector3, b: THREE.Vector3): boolean => {
    const r = getRay()
    if (!r || !links.world) return false
    _sight.subVectors(b, a)
    const len = _sight.length()
    if (len < 0.3) return false
    _sight.divideScalar(len)
    r.origin.x = a.x
    r.origin.y = a.y
    r.origin.z = a.z
    r.dir.x = _sight.x
    r.dir.y = _sight.y
    r.dir.z = _sight.z
    const hit = links.world.castRayAndGetNormal(r, len + CAMERA.wallPad, true, undefined, GROUPS.wheelRay, undefined, links.playerBody ?? undefined, isSlab)
    if (!hit) return false
    return Math.abs(hit.normal.x * _up.x + hit.normal.y * _up.y + hit.normal.z * _up.z) < CAMERA.sideFace
  }
  /** True if the straight line from `a` to `b` is blocked by a slab overhead (a face turned down). */
  const blockedFromAbove = (a: THREE.Vector3, b: THREE.Vector3): boolean => {
    _sight.subVectors(b, a)
    const len = _sight.length()
    if (len < 0.3) return false
    _sight.divideScalar(len)
    return slabHit(a, _sight, len + CAMERA.wallPad, 0.3) < Infinity
  }

  // Bookmarks: ?cam= at load, __dev.cam(name) live.
  useEffect(() => {
    const fromUrl = urlParam('cam')
    if (fromUrl && fromUrl !== 'free') cameraState.bookmark = fromUrl
    return registerDev(
      'cam',
      ((name: string) => {
        cameraState.bookmark = !name || name === 'free' ? '' : String(name)
        s.ready = false // the one place a cut is right: jumping to a bookmark
        return cameraState.bookmark || 'free'
      }) as never,
      "cam(name): camera bookmark - 'start', 'aerial', 'piece:<i>', 's:<metres>', or 'free'",
    )
  }, [s])

  // camLog: record the camera against the car every frame (see recordCamLog), read it back.
  useEffect(() => {
    const off = [
      registerDev(
        'camLog',
        ((seconds = 10) => {
          camLog.rows ??= new Float64Array(LOG_COLS * LOG_ROWS)
          camLog.seconds = Math.max(0.1, Number(seconds) || 10)
          camLog.t0 = -1
          camLog.n = 0
          camLog.on = true
          return `recording ${camLog.seconds}s`
        }) as never,
        'camLog(seconds = 10): record the camera against the car every frame (read with camLogGet)',
      ),
      registerDev('camLogGet', ((every = 1, raw = false) => readCamLog(Math.max(1, Math.floor(Number(every) || 1)), raw === true)) as never, 'camLogGet(every = 1, raw = false): the last camLog, one row every N frames (raw adds both quaternions): upGap = degrees between the camera up and the car up, rollGap / pitchGap its parts in the car frame, tilt = the car off level, camTurn / carTurn = degrees turned since the last frame, relMove = metres the camera moved against the car since the last frame'),
    ]
    return () => off.forEach((f) => f())
  }, [])

  // The settings menu can change the mode too; follow it with an eased transition.
  const settingsMode = useSettings((st) => st.camera)
  useEffect(() => {
    if (settingsMode === cameraState.mode) return
    cameraState.from = cameraState.mode
    cameraState.mode = settingsMode
    cameraState.transition = 0
  }, [settingsMode])

  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 1 / 20) // a stall must never fling the camera
    const t = state.clock.elapsedTime
    const g = getGame()
    const set = getSettings()
    const track = getTrack()

    // ---- C / RB: next mode (persisted as the camera setting) ----
    if (s.cycleSeen !== controlSignals.cameraCycle) {
      s.cycleSeen = controlSignals.cameraCycle
      if (g.phase === 'playing') {
        const next = CAMERA_MODES[(CAMERA_MODES.indexOf(cameraState.mode) + 1) % CAMERA_MODES.length]
        useSettings.getState().set('camera', next)
      }
    }
    if (cameraState.transition < 1) cameraState.transition = Math.min(1, cameraState.transition + dt / TRANSITION_S)
    const ease = smoothstep01(cameraState.transition)
    if (cameraState.transition >= 1) cameraState.from = cameraState.mode

    // ---- the road was rebuilt live and the car moved with it (CarSim.seatMove): the camera moves
    // the same way, so the view of the car and its road stays put. Left to the springs it sat at the
    // old road's height (inside the new road under the pause menu) and swung up to 6 m on resume.
    const seat = links.playerSim?.seatMove
    if (seat && seat.tick !== s.seatTick) {
      if (s.ready && s.seatTick >= 0) {
        _camPos.sub(seat.from).applyQuaternion(seat.rotate).add(seat.to)
        _lookPos.sub(seat.from).applyQuaternion(seat.rotate).add(seat.to)
        _up.applyQuaternion(seat.rotate)
        _airFwd.applyQuaternion(seat.rotate)
        _carQf.premultiply(seat.rotate) // the bonnet camera's filter turns with the car too
        _carQPrev.premultiply(seat.rotate)
        for (let k = 0; k < 9; k += 3) {
          _carry.set(springVel[k], springVel[k + 1], springVel[k + 2]).applyQuaternion(seat.rotate)
          springVel[k] = _carry.x
          springVel[k + 1] = _carry.y
          springVel[k + 2] = _carry.z
        }
      }
      s.seatTick = seat.tick
    }

    const speed = telemetry.carVelocity.length()
    const speedFrac = Math.min(speed / Math.max(10, set.topSpeedKmh / 3.6), 1)

    // ---- 1. bookmark: a fixed shot, no springs ----
    if (cameraState.bookmark && track && computeShot(cameraState.bookmark, track, _shot)) {
      cameraState.shot = 'bookmark'
      _camPos.copy(_shot.position)
      _lookPos.copy(_shot.look)
      _up.copy(WORLD_UP)
      camera.position.copy(_camPos)
      camera.up.copy(_up)
      camera.lookAt(_lookPos)
      setFov(camera, set.fov)
      s.ready = false
      return
    }

    // ---- the bonnet blend: how much of the view is the bonnet camera, 0..1 ----
    // It eases over TRANSITION_S like a mode change, but on its own clock, so pressing C twice
    // quickly, or the results coming up halfway through a change, can never make it jump. Only
    // the driving shot has a bonnet camera: the showroom, garage and results always frame the car.
    const driving = !(g.phase === 'title' || g.phase === 'results' || g.phase === 'loading')
    const bonnetWant = driving && cameraState.mode === 'bonnet' ? 1 : 0
    if (!s.ready) s.bonnetBlend = bonnetWant
    else if (s.bonnetBlend < bonnetWant) s.bonnetBlend = Math.min(bonnetWant, s.bonnetBlend + dt / TRANSITION_S)
    else s.bonnetBlend = Math.max(bonnetWant, s.bonnetBlend - dt / TRANSITION_S)
    const bonnetW = smoothstep01(s.bonnetBlend)

    // ---- 2. the target for this frame ----
    let posSmooth = 0.2
    let lookSmooth = 0.15
    let shakeScale = 0
    let fovOffset = 0
    let followUp = false
    _fwd.copy(telemetry.carForward)

    if (g.phase === 'title' || g.phase === 'results' || g.phase === 'loading') {
      const c = telemetry.carPosition
      if (g.phase === 'results') {
        // Results: a full slow orbit, the car in the open area right of the panel.
        cameraState.shot = 'results'
        s.orbitAngle += dt * 0.12
        _targetPos.set(c.x + Math.sin(s.orbitAngle) * RESULTS_R, c.y + RESULTS_H, c.z + Math.cos(s.orbitAngle) * RESULTS_R)
        _targetLook.set(c.x, c.y + 0.55, c.z)
        aimLeftOfCar(RESULTS_OFFSET * RESULTS_R)
        posSmooth = 0.6
        lookSmooth = 0.35
        // The car can still be rolling when the results come up: lead the targets by its
        // velocity so the springs keep it in the frame instead of trailing behind it.
        _targetPos.addScaledVector(telemetry.carVelocity, posSmooth)
        _targetLook.addScaledVector(telemetry.carVelocity, lookSmooth)
      } else {
        // Title showroom (the sun is the hero, the car in front of the sunset) or the
        // Garage (the car is the hero: a slow orbit that lingers on its front three-quarter).
        const garage = g.phase === 'title' && g.garageOpen
        // Arriving from another shot (quit to title, a bookmark): the orbit starts from where the camera is.
        const arriving = cameraState.shot !== 'showroom'
        cameraState.shot = 'showroom'
        const sun = environment.sunDirection
        const sunYaw = Math.atan2(-sun.x, -sun.z) // camera opposite the sun: car in front of the sunset
        s.orbitAngle += dt * 0.16
        let wantYaw = sunYaw + SHOWROOM_SUN_BIAS + Math.sin(s.orbitAngle) * SHOWROOM_SWAY
        if (garage) {
          if (s.garageBlend === 0) s.garageAngle = GARAGE.hero // every visit opens on the hero view
          // Slowest at the hero view, quickest straight opposite it.
          const away = 0.5 - 0.5 * Math.cos(s.garageAngle - GARAGE.hero)
          s.garageAngle = (s.garageAngle + dt * lerp(GARAGE.slow, GARAGE.fast, away)) % (Math.PI * 2)
          wantYaw = Math.atan2(telemetry.carForward.x, telemetry.carForward.z) + s.garageAngle
        }
        s.garageBlend = Math.min(1, Math.max(0, s.garageBlend + (garage ? dt : -dt) / GARAGE.blendS))
        const b = smoothstep01(s.garageBlend)
        // The orbit angle eases the short way round, so moving between the two shots the
        // camera swings round the car instead of cutting straight through it.
        if (!s.ready) s.showYaw = wantYaw
        else if (arriving) s.showYaw = Math.atan2(_camPos.x - c.x, _camPos.z - c.z)
        if (!s.ready || arriving) springVel[10] = 0 // no swing left over from the last visit
        const turn = Math.atan2(Math.sin(wantYaw - s.showYaw), Math.cos(wantYaw - s.showYaw))
        s.showYaw = smoothDamp(s.showYaw, s.showYaw + turn, 10, SHOWROOM_YAW_SMOOTH, dt)
        const r = lerp(SHOWROOM_R, GARAGE.radius, b)
        _targetPos.set(c.x + Math.sin(s.showYaw) * r, c.y + lerp(SHOWROOM_H, GARAGE.height, b), c.z + Math.cos(s.showYaw) * r)
        _targetLook.set(c.x, c.y + lerp(0.55, GARAGE.lookHeight, b), c.z)
        // The menus fill the left of the screen: aim LEFT of the car so it sits whole in the
        // open area to the right (about 70% across).
        aimLeftOfCar(lerp(SHOWROOM_OFFSET, GARAGE.offset, b) * r)
        // The orbit angle is already eased, so the position only needs a light spring.
        posSmooth = 0.12
        lookSmooth = 0.2
      }
      _targetUp.copy(WORLD_UP)
      fovOffset = -4
    } else {
      cameraState.shot = 'drive'
      // Up vector: the car's own up on loops, wall rides and steep banks; world up otherwise.
      // Steep ground means a bank, a loop or a wall: the car on the road and sitting with the road's
      // up. A car tipped over off the road (leaning on a slab in the slot beside a loop) keeps the
      // world's up: following it rolled the camera 55 deg and swung it into the slab.
      followUp = telemetry.magGrip || (!telemetry.airborne && telemetry.carUp.dot(WORLD_UP) < CAMERA.steepCos && onTheRoad(track))
      _targetUp.copy(followUp ? telemetry.carUp : WORLD_UP)
      // A spring trails a steady turn by about its own smooth time: round a 13 m loop at
      // 200 km/h the car's up turns 4.6 rad/s and the camera's up hung 63-77 deg behind it
      // (feel-2 O7). So the target is the car's up a little ahead, turned on by the car's own
      // spin x CAMERA.upLead: the spring still smooths every change, it just stops trailing.
      if (followUp) {
        _leadAxis.copy(telemetry.carAngularVelocity).addScaledVector(telemetry.carUp, -telemetry.carAngularVelocity.dot(telemetry.carUp))
        const rate = _leadAxis.length() // the part of the spin that tips the up
        if (rate > 0.05 && Number.isFinite(rate)) {
          _leadQ.setFromAxisAngle(_leadAxis.divideScalar(rate), Math.min(rate * CAMERA.upLead, CAMERA.upLeadMax))
          _targetUp.applyQuaternion(_leadQ)
        }
      }

      // Forward flattened into the camera's up plane.
      _fwd.addScaledVector(_up, -_fwd.dot(_up))
      if (_fwd.lengthSq() < 1e-6) _fwd.copy(telemetry.carForward)
      _fwd.normalize()
      // Airborne: the orbit keeps its own heading (a spinning car must not spin the world).
      if (telemetry.airborne && !followUp) {
        if (speed > 3) {
          _vel.copy(telemetry.carVelocity)
          _vel.y = 0
          if (_vel.lengthSq() > 1e-4) _airFwd.lerp(_vel.normalize(), Math.min(1, dt * 1.2)).normalize()
        }
        _fwd.copy(_airFwd)
      } else {
        _airFwd.copy(_fwd)
      }

      const modeA = cameraState.from
      const modeB = cameraState.mode
      const rigA = RIGS[modeA]
      const rigB = RIGS[modeB]
      rigTarget(rigA, modeA, speed, _posA, _lookA)
      rigTarget(rigB, modeB, speed, _posB, _lookB)
      _targetPos.lerpVectors(_posA, _posB, ease)
      _targetLook.lerpVectors(_lookA, _lookB, ease)
      const drifting = telemetry.drifting
      posSmooth = lerp(drifting ? rigA.posSmoothDrift : rigA.posSmooth, drifting ? rigB.posSmoothDrift : rigB.posSmooth, ease)
      lookSmooth = lerp(rigA.lookSmooth, rigB.lookSmooth, ease)
      shakeScale = lerp(rigA.shakeScale, rigB.shakeScale, ease)
      fovOffset = lerp(rigA.fovOffset, rigB.fovOffset, ease)
      const lead = lerp(rigA.velocityLead, rigB.velocityLead, ease)
      if (lead > 0.001) {
        // The discrete spring lags a moving target by v x (smooth - dt/2), not v x smooth, so lead
        // by that: a full v x smooth over-led the bonnet camera by half a frame of travel (0.46 m
        // at 200 km/h), out past its own car's nose.
        _targetPos.addScaledVector(telemetry.carVelocity, lead * Math.max(0, posSmooth - dt / 2))
        _targetLook.addScaledVector(telemetry.carVelocity, lead * Math.max(0, lookSmooth - dt / 2))
      }

      // Under a low ceiling - an overpass, or a loop's way-out leg over the ground beside its
      // mouth - the rig's spot above and behind the car is inside or above the slab, and the
      // clip below cut the arm 3.6-4.6 m in one frame to get under it, then left the camera
      // hugging the slab's underside (feel-2 L5). So the target is lowered under the slab here,
      // before the springs, and the camera glides down as the car goes under. Measured from the
      // car itself only: a probe further ahead read a loop's own climb as a ceiling.
      cameraState.ceiling = Infinity
      const clipW = 1 - bonnetW
      if (clipW > 0.001) {
        setPivot()
        const hT = _tmp.subVectors(_targetPos, _pivot).dot(_up)
        if (hT > 0.05) {
          const cap = ceilingAbove(_pivot, hT + CAMERA.ceilingPad)
          cameraState.ceiling = cap
          const allowed = Math.max(cap - CAMERA.ceilingPad, 0)
          if (hT > allowed) _targetPos.addScaledVector(_up, -(hT - allowed) * clipW)
          // A slab overhead between the car and that spot (a ramp of road coming down beside
          // the car): duck the target under it - the highest of a few lower heights the car can
          // be seen from - so the camera settles below the slab, not pinned against it by the
          // clip. If none clears (it is not a slab overhead), the target stays and the clip copes.
          if (blockedFromAbove(_pivot, _targetPos)) {
            const h0 = _tmp.subVectors(_targetPos, _pivot).dot(_up)
            for (let k = 0; k < DUCK_STEPS.length; k++) {
              const f = DUCK_STEPS[k]
              _dir.copy(_targetPos).addScaledVector(_up, -h0 * (1 - f))
              if (!blockedFromAbove(_pivot, _dir)) {
                _targetPos.addScaledVector(_up, -h0 * (1 - f) * clipW)
                break
              }
            }
          }
        }
        // A slab's side between the car and that spot (the car down in the slot beside a loop's
        // ribbon, the camera behind and above it): lift the target over it - the lowest of a few
        // higher spots with a clear view of the car - so the camera rises over the slab instead of
        // the clip pulling the arm in to nothing. A road's top surface (a dip) is left to the clip.
        cameraState.rise = 0
        if (sideBlocked(_pivot, _targetPos)) {
          cameraState.rise = -1
          for (let k = 0; k < CAMERA.riseSteps.length; k++) {
            _rise.copy(_targetPos).addScaledVector(_up, CAMERA.riseSteps[k])
            if (slabAlong(_pivot, _dir.subVectors(_rise, _pivot).normalize(), _rise.distanceTo(_pivot) + CAMERA.wallPad) === Infinity) {
              _targetPos.addScaledVector(_up, CAMERA.riseSteps[k] * clipW)
              cameraState.rise = CAMERA.riseSteps[k]
              break
            }
          }
        }
      }
    }

    // ---- 3. springs (or the one sanctioned snap) ----
    // A reset cuts on every frame until the first one after the next physics step: the car's drawn
    // pose is blended between steps, so until then it still shows the car part of the way from
    // where it was, and cutting to that once left the camera to fly 100 m to the car.
    let cut = !s.ready
    if (s.resetTick !== links.resetTick) {
      s.snapping = true
      s.snapStep = links.playerStepAt
      cut = true
    } else if (s.snapping) {
      cut = true
      if (links.playerStepAt !== s.snapStep) s.snapping = false
    }
    if (cut) {
      s.ready = true
      s.resetTick = links.resetTick
      _camPos.copy(_targetPos)
      _lookPos.copy(_targetLook)
      _up.copy(_targetUp)
      springVel.fill(0)
      s.clipPull = 0
      s.clipArm = Infinity
      s.underDuck = 0
      s.prevRelOk = false
      s.softHold = 0
    } else {
      _camPos.x = smoothDamp(_camPos.x, _targetPos.x, 0, posSmooth, dt)
      _camPos.y = smoothDamp(_camPos.y, _targetPos.y, 1, posSmooth, dt)
      _camPos.z = smoothDamp(_camPos.z, _targetPos.z, 2, posSmooth, dt)
      _lookPos.x = smoothDamp(_lookPos.x, _targetLook.x, 3, lookSmooth, dt)
      _lookPos.y = smoothDamp(_lookPos.y, _targetLook.y, 4, lookSmooth, dt)
      _lookPos.z = smoothDamp(_lookPos.z, _targetLook.z, 5, lookSmooth, dt)
      _up.x = smoothDamp(_up.x, _targetUp.x, 6, CAMERA.upSmooth, dt)
      _up.y = smoothDamp(_up.y, _targetUp.y, 7, CAMERA.upSmooth, dt)
      _up.z = smoothDamp(_up.z, _targetUp.z, 8, CAMERA.upSmooth, dt)
      if (_up.lengthSq() < 1e-6) _up.copy(WORLD_UP)
      _up.normalize()
    }
    if (!Number.isFinite(_camPos.x + _camPos.y + _camPos.z + _lookPos.x + _lookPos.y + _lookPos.z)) {
      s.ready = false // something upstream went non-finite: re-seat next frame
      return
    }

    // ---- 4. never clip through the road, walls or barriers ----
    // The bonnet camera is bolted to the car and needs none of this. Crossing to or
    // from it, the clip test fades with the transition instead of switching at one
    // end of it: switching made a 0.5-1.4 m one-frame pop on every bonnet change.
    const outPos = camera.position
    outPos.copy(_camPos)
    cameraState.clipped = false
    const clipWeight = 1 - bonnetW
    if (clipWeight > 0.001) {
      setPivot()
      _armDir.subVectors(outPos, _pivot)
      const want = _armDir.length()
      let free = Infinity
      let slabFree = Infinity
      let soft = Infinity
      ahead[0] = ahead[1] = Infinity
      cameraState.armClear = Infinity
      const r = want > 0.3 ? getRay() : null
      if (links.world && r) {
        _armDir.divideScalar(want)
        // The line from the car to the camera: the first thing on it of any kind...
        r.origin.x = _pivot.x
        r.origin.y = _pivot.y
        r.origin.z = _pivot.z
        r.dir.x = _armDir.x
        r.dir.y = _armDir.y
        r.dir.z = _armDir.z
        const hit = links.world.castRay(r, want + CAMERA.wallPad, true, undefined, GROUPS.wheelRay, undefined, links.playerBody ?? undefined)
        if (hit) {
          free = Math.max(0.6, hit.timeOfImpact - CAMERA.wallPad)
          cameraState.armClear = hit.timeOfImpact
          // ...and the first slab on it (the same hit, unless something else stands in front).
          const slabT = isSlab(hit.collider) ? hit.timeOfImpact : slabAlong(_pivot, _armDir, want + CAMERA.wallPad)
          if (Number.isFinite(slabT)) slabFree = Math.max(slabT - CAMERA.wallPad, 0.1)
        }
        // A slab about to swing into that line: lines to points CAMERA.clipLookRadius beside the
        // camera (left, right and above it, square to the arm). Whatever they meet, the arm will
        // meet in a moment, so it starts closing in now instead of all at once when it does.
        // Only for a slow car (CAMERA.clipLookKmh), the one that creeps about beside slabs: at speed
        // the camera sits in open road behind the car, and round a loop these lines met the loop
        // itself and pulled the arm in on every lap.
        const looking = telemetry.speedKmh < CAMERA.clipLookKmh
        if (looking) {
          _side.crossVectors(_armDir, _up)
          if (_side.lengthSq() < 1e-6) _side.set(1, 0, 0)
          _side.normalize()
          _lift.crossVectors(_side, _armDir).normalize()
          for (let k = 0; k < 3; k++) {
            _probe.copy(outPos).addScaledVector(k === 2 ? _lift : _side, k === 1 ? -CAMERA.clipLookRadius : CAMERA.clipLookRadius).sub(_pivot)
            const len = _probe.length()
            if (!(len > 0.3)) continue
            _probe.divideScalar(len)
            const t = slabAlong(_pivot, _probe, len)
            if (Number.isFinite(t)) soft = Math.min(soft, (t * want) / len - CAMERA.wallPad)
          }
          // And the line as it will be a moment from now (CAMERA.clipAhead seconds), from where the
          // car will be to where the camera's swing is taking it: a slab that line meets has to be
          // in front of the camera by then, so the arm closes in at the pace that gets it there.
          _rel.subVectors(outPos, _pivot)
          if (s.prevRelOk) _relVel.subVectors(_rel, _prevRel).divideScalar(Math.max(dt, 1e-3))
          else _relVel.set(0, 0, 0)
          for (let k = 0; k < CAMERA.clipAhead.length; k++) {
            const T = CAMERA.clipAhead[k]
            _pivotAhead.copy(telemetry.carVelocity).multiplyScalar(T)
            const move = _pivotAhead.length()
            if (move > 0.05) {
              // the car's own path there must be clear, or the line from it means nothing
              _probe.copy(_pivotAhead).divideScalar(move)
              if (slabAlong(_pivot, _probe, move) < Infinity) continue
            }
            _pivotAhead.add(_pivot)
            _probe.copy(_rel).addScaledVector(_relVel, T)
            const len = _probe.length()
            if (!(len > 0.3)) continue
            _probe.divideScalar(len)
            const t = slabAlong(_pivotAhead, _probe, len + CAMERA.wallPad)
            if (Number.isFinite(t)) {
              const armThen = (t * want) / len - CAMERA.wallPad
              if (armThen < ahead[k]) ahead[k] = armThen
            }
          }
        }
      }
      _prevRel.subVectors(outPos, _pivot)
      s.prevRelOk = true
      // The arm length this frame is the shortest of what the camera wants and these limits:
      //  - a slab on the line: never past it, ever (the camera never sits inside road);
      //  - a slab about to cross the line (soft, and the line a moment ahead): the arm closes in
      //    ahead of it, eased (clipSoftRate) or at the pace the look-ahead needs, never faster
      //    than clipInMax m/s, so when the slab arrives the arm is already short (a crawl turning
      //    under a loop's way-out leg cut the arm 2.5 m in one frame, feel-3 F2);
      //  - anything else on the line (a billboard's post flicking past): closed in a few frames
      //    (clipInRate), a quick glide instead of a one-frame cut;
      //  - the release: a pull lets go at clipOutSpeed, so passing a post doesn't make it pump.
      //    It is measured as a shortening of the arm, so the arm itself growing (a mode change,
      //    more speed) never reads as a clip.
      const prevArm = Number.isFinite(s.clipArm) ? s.clipArm : want
      let step = soft < prevArm ? (prevArm - soft) * (1 - Math.exp(-CAMERA.clipSoftRate * dt)) : 0
      for (let k = 0; k < CAMERA.clipAhead.length; k++) {
        if (ahead[k] < prevArm) step = Math.max(step, ((prevArm - ahead[k]) * dt) / CAMERA.clipAhead[k])
      }
      const softArm = step > 0 ? prevArm - Math.min(step, CAMERA.clipInMax * dt) : Infinity
      const glideArm = free < prevArm ? prevArm + (free - prevArm) * (1 - Math.exp(-CAMERA.clipInRate * dt)) : free
      // The look-ahead flickers as a slab edge slides along its lines: let go at once and the arm
      // swung back out between sightings, then had too far to come in when the slab arrived.
      s.softHold = step > 0 ? CAMERA.clipHold : Math.max(0, s.softHold - dt)
      const releaseArm = want - Math.max(0, s.clipPull - (s.softHold > 0 ? 0 : dt * CAMERA.clipOutSpeed))
      // Shortest arm 0.6 m, unless a slab is closer than that (a car jammed against one).
      const arm = Math.max(Math.min(want, 0.6, slabFree), Math.min(want, softArm, glideArm, releaseArm, slabFree))
      cameraState.armSoft = Math.min(soft, ahead[0], ahead[1])
      cameraState.armSlab = slabFree
      s.clipArm = arm
      s.clipPull = want - arm
      cameraState.armWant = want
      cameraState.arm = arm
      const pull = s.clipPull * clipWeight
      if (pull > 0.01) {
        outPos.copy(_pivot).addScaledVector(_armDir, want - pull)
        cameraState.clipped = true
      }
      // Never touching a slab anywhere: kept CAMERA.slabClear off its nearest face (the arm's own
      // clip only looks along the arm, so a camera could graze a ribbon's edge from the side).
      if (links.world) {
        _probe.copy(outPos)
        const proj = links.world.projectPoint(_probe, false, undefined, GROUPS.wheelRay, undefined, links.playerBody ?? undefined, isSlab)
        if (proj) {
          _side.set(outPos.x - proj.point.x, outPos.y - proj.point.y, outPos.z - proj.point.z)
          const d = _side.length()
          if (d > 1e-3 && d < CAMERA.slabClear) outPos.addScaledVector(_side, ((CAMERA.slabClear - d) / d) * clipWeight)
        }
      }
      // Never pressed against a slab's underside: keep CAMERA.ceilingPad below it. Eased like the
      // arm (clipSoftRate, clipInMax): an underside appearing overhead as the camera slides in
      // under a slab's edge dropped it 0.47 m in one frame. Only the last CAMERA.ceilingMin is
      // taken at once, so the camera's near plane never cuts into the slab.
      const over = ceilingAbove(outPos, CAMERA.ceilingPad)
      const need = over < CAMERA.ceilingPad ? CAMERA.ceilingPad - over : 0
      if (need > s.underDuck) s.underDuck += Math.min((need - s.underDuck) * (1 - Math.exp(-CAMERA.clipSoftRate * dt)), CAMERA.clipInMax * dt)
      else s.underDuck = Math.max(need, s.underDuck - CAMERA.clipOutSpeed * dt)
      if (over < CAMERA.ceilingMin) s.underDuck = Math.max(s.underDuck, CAMERA.ceilingMin - over)
      if (s.underDuck > 0.001) outPos.addScaledVector(_up, -s.underDuck * clipWeight)
      // And stay above the ground.
      if (track) {
        const gy = track.terrainHeight(outPos.x, outPos.z)
        if (Number.isFinite(gy) && outPos.y < gy + CAMERA.clearance) outPos.y += (gy + CAMERA.clearance - outPos.y) * clipWeight
      }
    } else {
      // Bolted to the bonnet: nothing between the camera and the car.
      s.clipPull = 0
      s.clipArm = Infinity
      s.underDuck = 0
      s.prevRelOk = false
      s.softHold = 0
    }

    // ---- 5. the bonnet camera, impact kick, aim, speed shake ----
    // The bonnet camera is bolted to the car (Josh, GitHub #7: "the camera angle should stay aligned
    // with the bonnet"). It sits exactly on the body's bonnet mount, with no spring to fall behind
    // (a spring there dropped back through the cabin on a frame hitch), and looks along the nose of
    // the car's filtered orientation, so it pitches over a crest, leans in a bank and rolls with a
    // barrel roll. Across a mode change it is blended in and out by bonnetW, so C never pops.
    filterCarTurn(s, cut, dt)
    if (bonnetW > 0.001) outPos.lerp(bonnetMount(RIGS.bonnet, _bonnetPos), bonnetW)
    const kick = telemetry.impact * shakeScale
    if (kick > 0.001) {
      outPos.addScaledVector(_up, kick * CAMERA.kickPos * Math.sin(t * 34))
      outPos.addScaledVector(_fwd, kick * CAMERA.kickPos * 0.6 * Math.sin(t * 27))
    }
    _rendered.copy(outPos)
    camera.up.copy(_up)
    camera.lookAt(_lookPos)
    if (bonnetW > 0.001) {
      // along the nose, tipped up toward the rig's look point the way the old sprung aim was
      const lookDist = RIGS.bonnet.lookAhead + speed * RIGS.bonnet.lookAheadSpeedGain
      _tiltQ.setFromAxisAngle(X_AXIS, Math.atan2(RIGS.bonnet.lookHeight, lookDist))
      _bonnetQ.copy(_carQf).multiply(FACE_NOSE).multiply(_tiltQ)
      camera.quaternion.slerp(_bonnetQ, bonnetW)
    }
    const shake = (CAMERA.shakeAmp * speedFrac * speedFrac + kick * CAMERA.kickRot) * shakeScale
    if (shake > 1e-5) {
      camera.rotateZ(shake * Math.sin(t * 31.7) * Math.sin(t * 9.1))
      camera.rotateX(shake * 0.7 * Math.sin(t * 24.3) * Math.sin(t * 5.7))
    }

    // ---- 6. FOV: setting + speed + boost kick, sprung ----
    const fovTarget = set.fov + CAMERA.fovSpeed * speedFrac * speedFrac + set.fovBoost * telemetry.boost + fovOffset
    cameraState.fov = smoothDamp(cameraState.fov, fovTarget, 9, CAMERA.fovSmooth, dt)
    setFov(camera, cameraState.fov)
    cameraState.followUp = followUp
    cameraState.bonnet = bonnetW
    recordCamLog(camera, t, dt, cut)
  })

  return null
}

function setFov(camera: THREE.PerspectiveCamera, fov: number): void {
  if (Number.isFinite(fov) && Math.abs(camera.fov - fov) > 0.01) {
    camera.fov = fov
    camera.updateProjectionMatrix()
  }
}
