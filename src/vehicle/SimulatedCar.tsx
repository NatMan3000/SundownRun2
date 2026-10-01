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
// ============================================================

import { useEffect, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { CuboidCollider, RigidBody, useBeforePhysicsStep, useRapier } from '@react-three/rapier'
import type { RapierCollider, RapierRigidBody } from '@react-three/rapier'
import { GROUPS, tagCollider, untagCollider } from '../core/physics'
import { addCar, makeCarState, removeCar } from '../core/telemetry'
import type { CarKind, CarState } from '../core/telemetry'
import { getTrack } from '../track/current'
import { bodyEntry } from './bodies/catalog'
import { CarSim } from './carSim'
import { buildCarModel, disposeCarModel, poseCarModel, setCarBrake, setCarColors } from './carModel'
import type { LapTracker } from './lapTracker'
import { startPose } from './trackNav'
import { CHASSIS, VISUAL } from './tuning'

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
  onBody?: (body: RapierRigidBody | null) => void
  shadows?: boolean
  children?: ReactNode
}

// Module temps for the render frame.
const _p = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _spawnPos = new THREE.Vector3()
const _spawnQuat = new THREE.Quaternion()
const _hit = { s: 0, index: 0, lateral: 0, height: 0, distance: 0, onRoad: false }

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
      teleport: (p, q) => sim.teleport(p, q),
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

  useEffect(() => {
    props.onBody?.(bodyRef.current)
    return () => props.onBody?.(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------------------------------------------------------------- fixed 60 Hz step
  useBeforePhysicsStep(() => {
    const b = bodyRef.current
    if (!b) return
    const h = hooks.current
    const track = getTrack()
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
      car.progress = lap.progress(track, sim.trackS)
    }
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
    hooks.current.onFrame?.(sim, car, dt)
  }, -40)

  return (
    <RigidBody
      ref={bodyRef}
      type="dynamic"
      colliders={false}
      canSleep={false}
      ccd
      linearDamping={0}
      angularDamping={CHASSIS.angularDamping}
      position={spawn.position}
      rotation={spawn.rotation}
    >
      <CuboidCollider
        ref={colliderRef}
        args={[CHASSIS.halfExtents.x, CHASSIS.halfExtents.y, CHASSIS.halfExtents.z]}
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

