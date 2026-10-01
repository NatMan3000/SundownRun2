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
import { environment, telemetry } from '../../core/telemetry'
import { getSettings, useSettings } from '../../core/settings'
import type { CameraMode } from '../../core/settings'
import { getGame } from '../../core/store'
import { GROUPS } from '../../core/physics'
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
const WORLD_UP = new THREE.Vector3(0, 1, 0)
const _shot: Shot = { position: new THREE.Vector3(), look: new THREE.Vector3() }
const _rendered = new THREE.Vector3()

/** tan(21.5 deg): how far left of the car the showroom camera aims, per metre of distance. */
const SHOWROOM_OFFSET = 0.39
/**
 * Title showroom framing (ui): the sun is the hero, so the orbit is biased off
 * the anti-sun line to put the sun in the open gap between the menu column and
 * the car, and only sways a little around that, so it never leaves the frame.
 */
const SHOWROOM_SUN_BIAS = -0.35 // rad (negative moves the sun left on screen)
const SHOWROOM_SWAY = 0.12 // rad

// spring velocities: [0..2] position, [3..5] look, [6..8] up, [9] fov
const springVel = new Float64Array(10)

/** Live camera state (inspector: window.__game.get('camera')). */
export const cameraState = {
  mode: 'chase' as CameraMode,
  from: 'chase' as CameraMode,
  transition: 1,
  fov: 62,
  shot: 'drive' as 'drive' | 'showroom' | 'results' | 'bookmark',
  bookmark: '' as string,
  clipped: false,
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
    _tmp.set(0, rig.mountY, rig.mountZ).applyQuaternion(telemetry.carQuaternion)
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
    /** How far a wall or the road shortens the camera arm right now, metres (0 = clear). */
    clipPull: 0,
    /** Last frame's arm length after the clip, metres (Infinity = nothing to ease from). */
    clipArm: Infinity,
  }).current
  const camera = useThree((st) => st.camera) as THREE.PerspectiveCamera
  const ray = useRef<InstanceType<NonNullable<typeof links.rapier>['Ray']> | null>(null)
  const rayRapier = useRef<typeof links.rapier>(null)

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
      // Showroom: a slow orbit with the sun behind the car. Results: a full slow orbit.
      const showroom = g.phase !== 'results'
      cameraState.shot = showroom ? 'showroom' : 'results'
      const sun = environment.sunDirection
      const sunYaw = Math.atan2(-sun.x, -sun.z) // camera opposite the sun: car in front of the sunset
      s.orbitAngle += dt * (showroom ? 0.16 : 0.12)
      const yaw = showroom ? sunYaw + SHOWROOM_SUN_BIAS + Math.sin(s.orbitAngle) * SHOWROOM_SWAY : s.orbitAngle
      const r = showroom ? 7.8 : 9.5
      const hgt = showroom ? 1.7 : 3.2
      const c = telemetry.carPosition
      _targetPos.set(c.x + Math.sin(yaw) * r, c.y + hgt, c.z + Math.cos(yaw) * r)
      _targetLook.set(c.x, c.y + 0.55, c.z)
      if (showroom) {
        // The menus fill the left half of the screen: aim LEFT of the car so it sits whole in
        // the right half, ~70% across (21 deg right of centre at this lens).
        _dir.subVectors(_targetLook, _targetPos).setY(0).normalize()
        _vel.crossVectors(_dir, WORLD_UP).normalize() // camera right
        _targetLook.addScaledVector(_vel, -SHOWROOM_OFFSET * r)
      }
      _targetUp.copy(WORLD_UP)
      posSmooth = 0.6
      lookSmooth = 0.35
      fovOffset = -4
    } else {
      cameraState.shot = 'drive'
      // Up vector: the car's own up on loops, wall rides and steep banks; world up otherwise.
      followUp = telemetry.magGrip || (!telemetry.airborne && telemetry.carUp.dot(WORLD_UP) < CAMERA.steepCos)
      _targetUp.copy(followUp ? telemetry.carUp : WORLD_UP)

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
        _targetPos.addScaledVector(telemetry.carVelocity, lead * posSmooth)
        _targetLook.addScaledVector(telemetry.carVelocity, lead * lookSmooth)
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
      _pivot.copy(telemetry.carPosition).addScaledVector(_up, 1.1)
      _tmp.subVectors(outPos, _pivot)
      const want = _tmp.length()
      let free = want
      if (links.world && links.rapier && want > 0.3) {
        if (!ray.current || rayRapier.current !== links.rapier) {
          ray.current = new links.rapier.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 })
          rayRapier.current = links.rapier
        }
        const r = ray.current
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
