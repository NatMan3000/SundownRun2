// ============================================================
//  VEHICLE - how the game feels: input, cars, camera
// ------------------------------------------------------------
//  The front door to src/vehicle. App.tsx mounts:
//
//    <InputSystem />   keyboard + Xbox controller, polled every frame
//                      before physics (src/core/input.ts)
//    <VehicleLayer />  inside <Physics>: the player's car and the ghost
//    <CameraRig />     inside the Canvas: chase / close / bonnet camera
//
//  and the play worker mounts one <SimCar> per Ai racer.
//
//  Where things live:
//    carSim.ts        the physics of one car (suspension, tyres, grip ...)
//    tuning.ts        the numbers that make it feel right
//    PlayerCar.tsx    your car's brain: input, laps, tricks, events
//    SimCar.tsx       an Ai car's brain: a Driver from the play worker
//    SimulatedCar.tsx a physics car in the scene (shared by both)
//    lapTracker.ts    laps, sectors, dirty laps
//    tricks.ts        air, spins, flips, rolls, loops, wall rides, drifts
//    ghost.ts         best-lap recording; GhostCar.tsx replays it
//    bodies/          the five car shapes; carModel.ts draws them
//    camera/          the camera rig, its modes and bookmarks
// ============================================================

import { useEffect } from 'react'
import { addEffect } from '@react-three/fiber'
import { useRapier } from '@react-three/rapier'
import * as THREE from 'three'
import { installVehicle } from '../core/api'
import { registerDev, registerInspector } from '../core/devHandles'
import { initInput, inputDebug, pollInput } from '../core/input'
import { getTrack } from '../track/current'
import { demoDrive } from '../dev/demoDrive'
import { feelTrace } from '../dev/feelTrace'
import '../dev/feelPad'
import { BODIES } from './bodies/catalog'
import { buildCarModel, disposeCarModel } from './carModel'
import { cameraState } from './camera/CameraRig'
import { GhostCar } from './GhostCar'
import { links } from './links'
import { PlayerCar } from './PlayerCar'
import { trickState } from './tricks'
import { frameAt, quatFromFrame, RIDE_HEIGHT } from './trackNav'

export { CameraRig } from './camera/CameraRig'
export { SimCar } from './SimCar'

// The garage catalog is plain data + a model builder: install it straight away,
// so the title screen can list the cars before any track or physics exists.
installVehicle({
  bodies: () => BODIES,
  buildModel: (bodyId, paint, glow) => buildCarModel(bodyId, paint, glow),
  disposeModel: (model) => disposeCarModel(model),
})

/** Keyboard + gamepad. Polled once per frame BEFORE physics and every useFrame. */
export function InputSystem() {
  useEffect(() => {
    const dispose = initInput()
    const remove = addEffect((now) => pollInput(now))
    return () => {
      remove()
      dispose()
    }
  }, [])
  return null
}

const _p = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _qYaw = new THREE.Quaternion()
const _e = new THREE.Euler()

/** Everything vehicle that lives inside <Physics>. */
export function VehicleLayer() {
  const { world, rapier } = useRapier()

  useEffect(() => {
    links.world = world
    links.rapier = rapier
    return () => {
      if (links.world === world) {
        links.world = null
        links.rapier = null
      }
    }
  }, [world, rapier])

  useEffect(() => {
    const off = [
      registerDev(
        'teleport',
        ((s: number, lateral = 0, yawDeg = 0) => {
          const t = getTrack()
          const sim = links.playerSim
          if (!t || !sim || !Number.isFinite(s)) return 'no track or car'
          const f = frameAt(t, s)
          _p.copy(f.position).addScaledVector(f.right, Number(lateral) || 0).addScaledVector(f.up, RIDE_HEIGHT + 0.1)
          quatFromFrame(f.tangent, f.up, _q)
          // Optional heading offset (+ = nose left), about the road's up: handy for feel tests.
          const yaw = ((Number(yawDeg) || 0) * Math.PI) / 180
          if (yaw !== 0) _q.premultiply(_qYaw.setFromAxisAngle(f.up, yaw))
          sim.teleport(_p, _q, t.wrapS(s))
          return { s: t.wrapS(s), x: _p.x, y: _p.y, z: _p.z }
        }) as never,
        'teleport(s, lateral = 0, yawDeg = 0): put the player on the road s metres from the start, lateral metres right, nose turned yawDeg left',
      ),
      registerDev(
        'drop',
        ((height = 8, rollDeg = 0, pitchDeg = 0) => {
          const sim = links.playerSim
          if (!sim) return 'no car'
          // Lift the car straight up from where it is, keep its speed, tilt it: air and landing tests.
          _p.copy(sim.pos)
          _p.y += Number(height) || 0
          _e.set(((Number(pitchDeg) || 0) * Math.PI) / 180, 0, ((Number(rollDeg) || 0) * Math.PI) / 180)
          _q.copy(sim.quat).multiply(_qYaw.setFromEuler(_e))
          const kmh = sim.forwardSpeed * 3.6
          sim.teleport(_p, _q, sim.trackS)
          if (kmh > 1) sim.setForwardSpeed(kmh)
          return { y: +_p.y.toFixed(2), kmh: Math.round(kmh) }
        }) as never,
        'drop(height = 8, rollDeg = 0, pitchDeg = 0): lift the player into the air (keeping its speed), tilted - air control, landing and roof tests',
      ),
      registerDev(
        'setSpeed',
        ((kmh: number) => {
          links.playerSim?.setForwardSpeed(kmh)
          return kmh
        }) as never,
        'setSpeed(kmh): launch the player along its nose at this speed (loop and wall tests)',
      ),
      registerDev(
        'trace',
        ((seconds = 8) => {
          feelTrace.start(Number(seconds) || 8)
          return `recording ${seconds}s`
        }) as never,
        'trace(seconds): record the player car at 60 Hz (read with traceGet)',
      ),
      registerDev('traceGet', ((every = 1) => feelTrace.get(Number(every) || 1)) as never, 'traceGet(every = 1): the last trace, one row every N steps'),
      registerDev(
        'resetCar',
        ((kind: 'road' | 'start' = 'road') => {
          links.playerSim?.requestReset(kind === 'start' ? 'start' : 'road')
          return kind
        }) as never,
        "resetCar('road' | 'start'): same as R / Shift+R",
      ),
      registerInspector('vehicle', () => {
        const s = links.playerSim
        if (!s) return null
        return {
          speedKmh: +s.speedKmh.toFixed(1),
          gear: s.gear,
          rpm: +s.rpm.toFixed(2),
          driftDeg: +((s.driftAngle * 180) / Math.PI).toFixed(1),
          slip: +s.slip.toFixed(2),
          airborne: s.airborne,
          wheelsDown: s.wheelsDown,
          wheels: [0, 1, 2, 3].map((i) => ({
            contact: s.wheelContact[i],
            surface: s.wheelSurface[i],
            compression: +s.wheelCompression[i].toFixed(2),
            slip: +s.wheelSlip[i].toFixed(2),
          })),
          surface: s.surface,
          onRoad: s.onRoad,
          forces: { suspSum: Math.round(s.debugSuspSum), wheelY: Math.round(s.debugWheelForceY), weight: Math.round(s.speed >= 0 ? 9.81 * 1200 * s.tuning.mass : 0) },
          mag: { grip: s.magGrip, strength: +s.magStrength.toFixed(2), guide: Array.from(s.debugGuide).map((v) => +v.toFixed(2)) },
          boost: +s.boost.toFixed(2),
          frozen: s.frozen,
          trackS: +s.trackS.toFixed(1),
          lateral: +s.lateral.toFixed(2),
          lap: links.playerLap
            ? {
                lap: links.playerLap.lap,
                timing: links.playerLap.timing,
                elapsedMs: Math.round(links.playerLap.elapsedMs),
                sectors: `${links.playerLap.sectorsPassed}/${links.playerLap.sectorCount}`,
                dirty: links.playerLap.dirty,
                offRoadMs: Math.round(links.playerLap.offRoadSteps * (1000 / 60)),
              }
            : null,
          tricks: { ...trickState },
          demo: demoDrive.active ? { steps: demoDrive.steps, targetKmh: +demoDrive.targetKmh.toFixed(1), unsticks: demoDrive.unsticks } : null,
        }
      }),
      registerInspector('camera', () => ({
        mode: cameraState.mode,
        transition: +cameraState.transition.toFixed(2),
        fov: +cameraState.fov.toFixed(2),
        shot: cameraState.shot,
        bookmark: cameraState.bookmark || 'free',
        clipped: cameraState.clipped,
        position: cameraState.position.toArray().map((v) => +v.toFixed(2)),
        up: cameraState.up.toArray().map((v) => +v.toFixed(3)),
      })),
      registerInspector('input', () => ({ ...inputDebug, keys: { ...inputDebug.keys } })),
    ]
    return () => off.forEach((f) => f())
  }, [])

  return (
    <>
      <PlayerCar />
      <GhostCar />
    </>
  )
}
