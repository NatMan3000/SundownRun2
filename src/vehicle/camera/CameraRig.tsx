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
//       and steep banks the up vector springs toward the car's up
//    3. never clip: a ray from the car to the camera pulls it in
//       front of any road, wall or barrier, and it stays above the
//       terrain
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
  /** The sprung camera position, before the wall clip and the impact kick. */
  position: _camPos,
  /** Where the camera really is this frame (after the clip and the kick). */
  rendered: _rendered,
  up: _up,
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

/** Where a rig wants the camera and its look target right now (U = the camera's up). */
function rigTarget(rig: CameraRigSpec, mode: CameraMode, speed: number, outPos: THREE.Vector3, outLook: THREE.Vector3): void {
  const set = getSettings()
  const carPos = telemetry.carPosition
  if (rig.kind === 'mount') {
    // each body says where its bonnet camera sits (CarAnchors.bonnet); the rig's numbers are the fallback
    const mount = getCar('player')?.anchors?.bonnet
    _tmp.set(0, mount ? mount.y : rig.mountY, mount ? mount.z : rig.mountZ).applyQuaternion(telemetry.carQuaternion)
    outPos.copy(carPos).add(_tmp)
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
      followUp = telemetry.magGrip || (!telemetry.airborne && telemetry.carUp.dot(WORLD_UP) < CAMERA.steepCos)
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
      const clipW = cameraState.mode === 'bonnet' ? 1 - ease : cameraState.from === 'bonnet' ? ease : 1
      if (clipW > 0.001) {
        _pivot.copy(telemetry.carPosition).addScaledVector(_up, CAMERA.pivotHeight)
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
      }
    }

    // ---- 3. springs (or the one sanctioned snap) ----
    if (!s.ready || s.resetTick !== links.resetTick) {
      s.ready = true
      s.resetTick = links.resetTick
      _camPos.copy(_targetPos)
      _lookPos.copy(_targetLook)
      _up.copy(_targetUp)
      springVel.fill(0)
      s.clipPull = 0
      s.clipArm = Infinity
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
    const clipWeight = cameraState.mode === 'bonnet' ? 1 - ease : cameraState.from === 'bonnet' ? ease : 1
    if (clipWeight > 0.001) {
      _pivot.copy(telemetry.carPosition).addScaledVector(_up, CAMERA.pivotHeight)
      _tmp.subVectors(outPos, _pivot)
      const want = _tmp.length()
      let free = want
      const r = want > 0.3 ? getRay() : null
      if (links.world && r) {
        _tmp.divideScalar(want)
        r.origin.x = _pivot.x
        r.origin.y = _pivot.y
        r.origin.z = _pivot.z
        r.dir.x = _tmp.x
        r.dir.y = _tmp.y
        r.dir.z = _tmp.z
        const hit = links.world.castRay(r, want + CAMERA.wallPad, true, undefined, GROUPS.wheelRay, undefined, links.playerBody ?? undefined)
        if (hit) free = Math.max(0.6, hit.timeOfImpact - CAMERA.wallPad)
      }
      // The arm length this frame is the shortest of what the camera wants and two limits:
      //  - the wall: never past it. The camera swinging INTO a wall stops at it, but a wall that
      //    APPEARS in front of where the camera already is (a post flicking past) is closed in a
      //    few frames (clipInRate), a quick glide instead of a one-frame cut;
      //  - the release: a pull lets go at clipOutSpeed, so passing a post doesn't make it pump.
      //    It is measured as a shortening of the arm, so the arm itself growing (a mode change,
      //    more speed) never reads as a clip.
      let wallArm = free
      if (Number.isFinite(s.clipArm) && s.clipArm > free) wallArm = s.clipArm + (free - s.clipArm) * (1 - Math.exp(-CAMERA.clipInRate * dt))
      const releaseArm = want - Math.max(0, s.clipPull - dt * CAMERA.clipOutSpeed)
      const arm = Math.max(Math.min(want, 0.6), Math.min(want, wallArm, releaseArm))
      s.clipArm = arm
      s.clipPull = want - arm
      const pull = s.clipPull * clipWeight
      if (pull > 0.01) {
        outPos.copy(_pivot).addScaledVector(_tmp.normalize(), want - pull)
        cameraState.clipped = true
      }
      // Never pressed against a slab's underside: keep CAMERA.ceilingPad below it.
      const over = ceilingAbove(outPos, CAMERA.ceilingPad)
      if (over < CAMERA.ceilingPad) outPos.addScaledVector(_up, -(CAMERA.ceilingPad - over) * clipWeight)
      // And stay above the ground.
      if (track) {
        const gy = track.terrainHeight(outPos.x, outPos.z)
        if (Number.isFinite(gy) && outPos.y < gy + CAMERA.clearance) outPos.y += (gy + CAMERA.clearance - outPos.y) * clipWeight
      }
    } else {
      // Bolted to the bonnet: nothing between the camera and the car.
      s.clipPull = 0
      s.clipArm = Infinity
    }

    // ---- 5. impact kick, aim, speed shake ----
    const kick = telemetry.impact * shakeScale
    if (kick > 0.001) {
      outPos.addScaledVector(_up, kick * CAMERA.kickPos * Math.sin(t * 34))
      outPos.addScaledVector(_fwd, kick * CAMERA.kickPos * 0.6 * Math.sin(t * 27))
    }
    _rendered.copy(outPos)
    camera.up.copy(_up)
    camera.lookAt(_lookPos)
    const shake = (CAMERA.shakeAmp * speedFrac * speedFrac + kick * CAMERA.kickRot) * shakeScale
    if (shake > 1e-5) {
      camera.rotateZ(shake * Math.sin(t * 31.7) * Math.sin(t * 9.1))
      camera.rotateX(shake * 0.7 * Math.sin(t * 24.3) * Math.sin(t * 5.7))
    }

    // ---- 6. FOV: setting + speed + boost kick, sprung ----
    const fovTarget = set.fov + CAMERA.fovSpeed * speedFrac * speedFrac + set.fovBoost * telemetry.boost + fovOffset
    cameraState.fov = smoothDamp(cameraState.fov, fovTarget, 9, CAMERA.fovSmooth, dt)
    setFov(camera, cameraState.fov)
  })

  return null
}

function setFov(camera: THREE.PerspectiveCamera, fov: number): void {
  if (Number.isFinite(fov) && Math.abs(camera.fov - fov) > 0.01) {
    camera.fov = fov
    camera.updateProjectionMatrix()
  }
}
