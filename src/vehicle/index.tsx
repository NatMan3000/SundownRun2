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
import { cars } from '../core/telemetry'
import { getTrack } from '../track/current'
import { demoDrive } from '../dev/demoDrive'
import { feelTrace } from '../dev/feelTrace'
import '../dev/feelPad'
import '../dev/fakePad'
import '../dev/tune'
import '../dev/rayProbe'
import { BODIES } from './bodies/catalog'
import { buildCarModel, disposeCarModel } from './carModel'
import { cameraState } from './camera/CameraRig'
import { GhostCar } from './GhostCar'
import { links } from './links'
import { PlayerCar } from './PlayerCar'
import { BODY_LOG_FIELDS } from './carSim'
import { trickState, wipeoutLog } from './tricks'
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
const jumpWatch = { timer: 0, last: new Map<string, number>(), max: new Map<string, number>() }
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
        ((seconds = 8, probeBody = false) => {
          feelTrace.start(Number(seconds) || 8, links.playerSim, probeBody === true)
          return `recording ${seconds}s`
        }) as never,
        'trace(seconds, probeBody = false): record the player car at 60 Hz (read with traceGet); probeBody also checks the chassis for contact every step',
      ),
      registerDev('traceGet', ((every = 1) => feelTrace.get(Number(every) || 1)) as never, 'traceGet(every = 1): the last trace, one row every N steps'),
      registerDev(
        'trackJumps',
        (() => {
          // Start (first call) a 10 Hz watcher; every call returns the biggest trackS jump per car so far.
          if (!jumpWatch.timer) {
            jumpWatch.timer = window.setInterval(() => {
              const t = getTrack()
              if (!t) return
              for (const c of cars) {
                const prev = jumpWatch.last.get(c.id)
                if (prev !== undefined) {
                  const d = Math.abs(t.deltaS(prev, c.trackS))
                  if (d > (jumpWatch.max.get(c.id) ?? 0)) jumpWatch.max.set(c.id, d)
                }
                jumpWatch.last.set(c.id, c.trackS)
              }
            }, 100)
          }
          return Object.fromEntries([...jumpWatch.max].map(([k, v]) => [k, Math.round(v)]))
        }) as never,
        'trackJumps(): watch every car; returns the biggest trackS jump (m) per 100 ms sample so far (level-jump check)',
      ),
      registerDev(
        'bodyLog',
        (() => {
          // Dev: the player's hard body contacts recorded during trace(s, true), oldest first.
          const sim = links.playerSim
          const t = getTrack()
          if (!sim) return 'no car'
          const L = sim.bodyLog
          const n = Math.min(sim.bodyLogCount, 64)
          const out = []
          for (let k = sim.bodyLogCount - n; k < sim.bodyLogCount; k++) {
            const o = (k % 64) * BODY_LOG_FIELDS
            const r = (i: number, d = 3) => +L[o + i].toFixed(d)
            const row: Record<string, unknown> = { step: L[o], what: L[o + 1], imp: r(2, 0), pts: L[o + 3], solver: L[o + 4], n: [r(5), r(6), r(7)], p: [r(8, 2), r(9, 2), r(10, 2)], dist: r(11), v: [r(12, 1), r(13, 1), r(14, 1)], tri: L[o + 15] }
            if (t && Number.isFinite(L[o + 8])) {
              // Where the contact point sits against the road: s, lateral and height above its surface.
              const h = t.nearest(L[o + 8], L[o + 9], L[o + 10], { s: 0, index: 0, lateral: 0, height: 0, distance: 0, onRoad: false }, sim.trackS)
              row.road = { s: +h.s.toFixed(1), lat: +h.lateral.toFixed(2), above: +h.height.toFixed(3) }
              const f = frameAt(t, h.s)
              const vx = L[o + 12], vy = L[o + 13], vz = L[o + 14], nx = L[o + 5], ny = L[o + 6], nz = L[o + 7]
              row.nVsRoadUp = +(nx * f.up.x + ny * f.up.y + nz * f.up.z).toFixed(3)
              row.vIntoN = +-(vx * nx + vy * ny + vz * nz).toFixed(2)
            }
            out.push(row)
          }
          return out
        }) as never,
        'bodyLog(): the player body hard contacts (over 300 N s) recorded during trace(s, true), with where each sits against the road',
      ),
      registerDev('wipeouts', (() => wipeoutLog.slice()) as never, 'wipeouts(): the last 20 trick wipeouts and why each fired (dev)'),
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
          chassis: { touching: s.chassisTouching, supportUp: +s.chassisSupportUp.toFixed(2) },
          holding: s.holding,
          beached: s.beached,
          loopSlide: s.loopSlide,
          rollbackBrake: +s.rollbackBrake.toFixed(2),
          reseats: { ...s.reseats },
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
          demo: demoDrive.active ? { steps: demoDrive.steps, unsticks: demoDrive.unsticks, brain: 'play aiDriver' } : null,
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
        rendered: cameraState.rendered.toArray().map((v) => +v.toFixed(2)),
        up: cameraState.up.toArray().map((v) => +v.toFixed(3)),
        arm: { want: +cameraState.armWant.toFixed(2), got: +cameraState.arm.toFixed(2), clear: Number.isFinite(cameraState.armClear) ? +cameraState.armClear.toFixed(2) : null, soft: Number.isFinite(cameraState.armSoft) ? +cameraState.armSoft.toFixed(2) : null, slab: Number.isFinite(cameraState.armSlab) ? +cameraState.armSlab.toFixed(2) : null, pivotUp: +cameraState.pivotUp.toFixed(2), rise: cameraState.rise },
        ceiling: Number.isFinite(cameraState.ceiling) ? +cameraState.ceiling.toFixed(2) : null,
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
