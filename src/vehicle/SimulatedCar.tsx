// ============================================================
//  SIMULATED CAR - one physics car in the scene (player or Ai)
// ------------------------------------------------------------
//  Wires a CarSim (the physics, carSim.ts) to the scene:
//
//    - a dynamic rapier body with CCD and a chassis box collider
//      (density 0: the sim sets mass and inertia explicitly), in
//      GROUPS.car, tagged with tagCollider so crashes know who hit
//    - the car model (carModel.ts), parented to the body so it
//      carries rapier's INTERPOLATED pose - smooth at 165 Hz
//    - a CarState in the `cars` registry (pose, speed, laps, api)
//    - a LapTracker (race laps + the timed-lap rules)
//
//  The owner (PlayerCar or SimCar) supplies the brain through two
//  hooks that run inside every fixed physics step: beforeStep
//  (write sim.controls) and afterStep (read what happened).
//
//  Every car also joins the rewind recorder (rewind.ts): it saves
//  a snapshot each step, and while rewind is held it is SHOWN at an
//  older snapshot instead of being simulated.
// ============================================================

import { useEffect, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { RoundCuboidCollider, RigidBody, useBeforePhysicsStep, useRapier } from '@react-three/rapier'
import type { RapierCollider, RapierRigidBody } from '@react-three/rapier'
import { on } from '../core/events'
import { GROUPS, tagCollider, untagCollider } from '../core/physics'
import { addCar, makeCarState, removeCar } from '../core/telemetry'
import type { CarKind, CarState } from '../core/telemetry'
import { getTrack } from '../track/current'
import { bodyEntry } from './bodies/catalog'
import { CarSim } from './carSim'
import { buildCarModel, disposeCarModel, poseCarModel, setCarBrake, setCarColors, setCarReverse } from './carModel'
import type { LapTracker } from './lapTracker'
import { startPose } from './trackNav'
import { CHASSIS, VISUAL } from './tuning'
import { addRewindCar, rewindAfterCarStep, rewindBeforeCarStep, rewindPlaying, rewindShowCar } from './rewind'

export interface SimulatedCarProps {
  id: string
  kind: CarKind
  name: string
  body: string
  paint: string
  glow: string
  trail: string
  gridSlot: number
  sim: CarSim
  lap: LapTracker
  /** Inside every physics step, before forces: write sim.controls / sim.handling. */
  beforeStep: (sim: CarSim, car: CarState) => void
  /** Inside every physics step, after forces and the lap tracker. */
  afterStep?: (sim: CarSim, car: CarState) => void
  /** Every rendered frame, after the interpolated pose is read (priority -40). */
  onFrame?: (sim: CarSim, car: CarState, dt: number) => void
  /** Rewind held: instead of beforeStep / afterStep, after the car was put at an older moment (rewind.ts). */
  onRewindFrame?: (sim: CarSim, car: CarState) => void
  /** Rewind let go: the car was put back at the moment on screen and drives on from there. */
  onRewindResume?: (sim: CarSim, car: CarState) => void
  onBody?: (body: RapierRigidBody | null) => void
  shadows?: boolean
  children?: ReactNode
}

// Module temps for the render frame.
const _p = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _seatM = new THREE.Matrix4()
const _seatParent = new THREE.Matrix4()
const _seatScale = new THREE.Vector3()
const _spawnPos = new THREE.Vector3()
const _spawnQuat = new THREE.Quaternion()
/** Chassis edge radius, metres. */
const CHASSIS_ROUND = 0.25
const _hit = { s: 0, index: 0, lateral: 0, height: 0, distance: 0, onRoad: false }

/**
 * Reverse lights. They come on the moment the car reverses (brake held from
 * a stop: carSim's `reversing`), like putting a real car in reverse, and stay
 * on while it is still backing up with no throttle: the Ai coasts between
 * pushes when it backs up for a fresh run at a loop, and letting go of S
 * still rolls you back, so they must not blink off and on. They also stay on
 * while the brake is still held near a stop (on a slope a car can tip between
 * braking and reversing). Throttle, or coming to rest, turns them off.
 *   backingMs  rolling backward faster than this (m/s) counts as backing up
 *   holdMs     with the brake held, below this forward speed (m/s) they stay on
 */
const REVERSE_LAMP = { backingMs: 0.3, holdMs: 1.5 }

function reverseLightsOn(sim: CarSim, wasOn: boolean): boolean {
  if (sim.reversing) return true
  if (!wasOn || sim.frozen) return false
  const c = sim.controls
  if (Number.isFinite(c.throttle) && c.throttle >= 0.1) return false
  const v = Number.isFinite(sim.forwardSpeed) ? sim.forwardSpeed : 0
  const braking = Number.isFinite(c.brake) && c.brake > 0.05
  return v < -REVERSE_LAMP.backingMs || (braking && v < REVERSE_LAMP.holdMs)
}

export function SimulatedCar(props: SimulatedCarProps) {
  const { id, kind, name, body, paint, glow, trail, gridSlot, sim, lap, shadows } = props
  const { world, rapier } = useRapier()
  const ray = useMemo(() => new rapier.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 }), [rapier])
  const bodyRef = useRef<RapierRigidBody>(null)
  const colliderRef = useRef<RapierCollider>(null)
  const visualRef = useRef<THREE.Group>(null)
  const hooks = useRef(props)
  hooks.current = props
  const spring = useRef({ roll: 0, rollV: 0, pitch: 0, pitchV: 0 }).current
  const lamps = useRef({ reverse: false }).current

  // Spawn pose: computed once, at mount. Later moves go through the sim (teleport / reset).
  const spawn = useMemo(() => {
    const t = getTrack()
    if (t) {
      const s = startPose(t, gridSlot, _spawnPos, _spawnQuat)
      lap.restartFresh(s)
      sim.trackS = s
      sim.hasTrackS = true
    } else {
      _spawnPos.set(0, 3, 0)
      _spawnQuat.identity()
    }
    sim.gridSlot = gridSlot
    const e = new THREE.Euler().setFromQuaternion(_spawnQuat)
    return { position: [_spawnPos.x, _spawnPos.y, _spawnPos.z] as [number, number, number], rotation: [e.x, e.y, e.z] as [number, number, number] }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  sim.gridSlot = gridSlot

  // The car's entry in the registry.
  const car = useMemo(() => {
    const c = makeCarState(id, kind, name)
    c.api = {
      // Re-seed the road hint from the target, so the car's track position can't jump to
      // another level (a crossover bridge) on the first lookup after the move.
      teleport: (p, q) => {
        const t = getTrack()
        if (!t) return sim.teleport(p, q)
        const near = sim.hasTrackS && sim.pos.distanceTo(p) < 40
        t.nearest(p.x, p.y, p.z, _hit, near ? sim.trackS : undefined)
        sim.teleport(p, q, Number.isFinite(_hit.s) ? _hit.s : -1)
      },
      setFrozen: (f) => {
        sim.frozen = f
      },
      resetToRoad: () => sim.requestReset('road'),
    }
    return c
  }, [id, kind, name, sim])
  car.body = body
  car.paint = paint
  car.glow = glow
  car.trail = trail
  sim.tuning = bodyEntry(body).tuning

  useEffect(() => {
    addCar(car)
    return () => removeCar(car.id)
  }, [car])

  // The model: rebuilt when the body changes, recoloured in place otherwise.
  const model = useMemo(() => buildCarModel(body, paint, glow, { shadows }), [body, shadows]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => disposeCarModel(model), [model])
  useEffect(() => setCarColors(model, paint, glow), [model, paint, glow])
  car.object = model
  car.anchors = model.userData.anchors

  // Tag the chassis so a crash (ours or anyone's) knows which car it hit.
  useEffect(() => {
    const c = colliderRef.current
    if (!c) return
    const handle = c.handle
    tagCollider(handle, { kind: 'car', id })
    return () => untagCollider(handle)
  }, [id])

  // Join the rewind recorder for as long as this car exists.
  useEffect(
    () =>
      addRewindCar({
        id,
        sim,
        lap,
        car,
        body: () => bodyRef.current,
        collider: () => colliderRef.current,
        onResume: () => hooks.current.onRewindResume?.(sim, car),
      }),
    [id, sim, lap, car],
  )

  useEffect(() => {
    props.onBody?.(bodyRef.current)
    return () => props.onBody?.(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A live road rebuild (the Hyperdrome's bank slider): move with the road the moment it changes,
  // even under the pause menu, not on the next physics step. Physics doesn't step while paused,
  // so rapier won't copy the new pose to the drawn car either: do that here too.
  useEffect(
    () =>
      on('track.param', () => {
        const b = bodyRef.current
        if (!b || !sim.reseatTo(b, getTrack())) return
        const obj = visualRef.current?.parent
        if (!obj) return
        const t = b.translation()
        const r = b.rotation()
        _p.set(t.x, t.y, t.z)
        _q.set(r.x, r.y, r.z, r.w)
        _seatScale.copy(obj.scale)
        _seatM.compose(_p, _q, _seatScale)
        if (obj.parent) {
          obj.parent.updateWorldMatrix(true, false)
          _seatM.premultiply(_seatParent.copy(obj.parent.matrixWorld).invert())
        }
        _seatM.decompose(obj.position, obj.quaternion, _seatScale)
        obj.updateMatrixWorld(true)
      }),
    [sim],
  )

  // ---------------------------------------------------------------- fixed 60 Hz step
  useBeforePhysicsStep(() => {
    const b = bodyRef.current
    if (!b) return
    const h = hooks.current
    const track = getTrack()
    if (rewindPlaying()) {
      // Rewind held: no brain, no physics, no laps. The car is put where it was a step earlier.
      rewindShowCar(sim, car, b, colliderRef.current)
      if (track) car.progress = lap.progress(track, sim.trackS)
      h.onRewindFrame?.(sim, car)
      return
    }
    rewindBeforeCarStep(sim)
    h.beforeStep(sim, car)
    sim.step(b, world, ray, colliderRef.current, track)

    if (track) {
      const news = sim.news
      if (news.reset === 'start') lap.onRestart(sim.trackS)
      else if (news.reset) lap.onRoadReset(sim.trackS)
      else if (news.teleported) lap.restartFresh(sim.hasTrackS ? sim.trackS : track.nearest(sim.pos.x, sim.pos.y, sim.pos.z, _hit).s)
      else lap.update(track, sim.trackS, sim.onRoad)
      car.trackS = sim.trackS
      car.lap = lap.lap
      // Same step as the lap count, so a reader that sees lap change sees that lap's verdict.
      car.lastLapMs = lap.lastLapMs
      car.lastLapDirty = lap.lastLapDirty
      car.progress = lap.progress(track, sim.trackS)
    }
    rewindAfterCarStep(sim)
    car.speedKmh = sim.speedKmh
    car.boost = sim.boost
    car.slip = sim.slip
    car.airborne = sim.airborne
    car.velocity.copy(sim.linvel)
    h.afterStep?.(sim, car)
  })

  // ---------------------------------------------------------------- render frame
  // Priority -40: after the physics step + interpolation (Physics runs at -50 once
  // App sets it), before the camera, fx and HUD (0) read the pose.
  useFrame((_, rawDt) => {
    const v = visualRef.current
    if (!v) return
    const dt = Math.min(rawDt, 1 / 20)
    v.getWorldPosition(_p)
    v.getWorldQuaternion(_q)
    if (Number.isFinite(_p.x + _p.y + _p.z)) car.position.copy(_p)
    if (Number.isFinite(_q.w)) car.quaternion.copy(_q)

    // Body roll / pitch on a critically damped spring over the physics pose:
    // cornering left throws the body right, throttle lifts the nose.
    const rollT = THREE.MathUtils.clamp(-sim.latAccel * VISUAL.rollGain, -VISUAL.rollMax, VISUAL.rollMax)
    const pitchT = THREE.MathUtils.clamp(sim.longAccel * VISUAL.pitchGain, -VISUAL.pitchMax, VISUAL.pitchMax)
    const w = VISUAL.omega
    spring.rollV += (-2 * w * spring.rollV - w * w * (spring.roll - rollT)) * dt
    spring.roll += spring.rollV * dt
    spring.pitchV += (-2 * w * spring.pitchV - w * w * (spring.pitch - pitchT)) * dt
    spring.pitch += spring.pitchV * dt
    if (!Number.isFinite(spring.roll + spring.pitch)) spring.roll = spring.rollV = spring.pitch = spring.pitchV = 0
    poseCarModel(model, { wheelHubY: sim.wheelHubY, wheelSpin: sim.wheelSpin, steerAngle: sim.steerAngle, roll: spring.roll, pitch: spring.pitch })
    setCarBrake(model, sim.brakeLight)
    lamps.reverse = reverseLightsOn(sim, lamps.reverse)
    setCarReverse(model, lamps.reverse ? 1 : 0)
    hooks.current.onFrame?.(sim, car, dt)
  }, -40)

  return (
    <RigidBody
      ref={bodyRef}
      type="dynamic"
      colliders={false}
      canSleep={false}
      // Soft CCD, not hard CCD: on rapier 0.19 hard CCD halves the travel of a body sliding on a
      // trimesh (every surface here is one). Soft prediction still stops a 150 m/s drop. It stays
      // on with the wheels down too (rapier caps it at one step's travel): cutting it on the ground
      // let a 320 km/h car pass straight through a parked one. The look-ahead's catch is that it
      // treats nearby triangles as endless planes, so nothing solid may sit just under a road
      // (the 2026-10-02 bank-60 rollover): the track keeps its ground well clear of the deck.
      softCcdPrediction={2}
      linearDamping={0}
      angularDamping={CHASSIS.angularDamping}
      position={spawn.position}
      rotation={spawn.rotation}
    >
      {/* Rounded edges, same outer size: a nose that touches a kicker or kerb rides up it
          instead of its sharp edge digging in (a square box stopped dead on a ramp at 190 km/h). */}
      <RoundCuboidCollider
        ref={colliderRef}
        args={[CHASSIS.halfExtents.x - CHASSIS_ROUND, CHASSIS.halfExtents.y - CHASSIS_ROUND, CHASSIS.halfExtents.z - CHASSIS_ROUND, CHASSIS_ROUND]}
        position={[0, CHASSIS.offsetY, 0]}
        density={0}
        friction={0.1}
        restitution={0.08}
        collisionGroups={GROUPS.car}
      />
      <group ref={visualRef}>
        <primitive object={model} />
      </group>
      {props.children}
    </RigidBody>
  )
}

