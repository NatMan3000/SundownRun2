// ============================================================
//  GHOST CAR - your best lap, replayed as a car made of light
// ------------------------------------------------------------
//  A translucent copy of the car that drove the best lap on this
//  track version. No physics body, no collider: its pose comes
//  straight from the recorded trace (ghost.ts), synced to the
//  player's live lap clock, so when you cross the line it sets off
//  beside you.
//
//  Shown in time trial, and in free roam when the Ghost setting is
//  on, only while a lap is being timed. It appears in the `cars`
//  registry as kind 'ghost' (so the look worker can give it a faint
//  trail and the minimap can draw it).
// ============================================================

import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { PALETTE } from '../core/palette'
import { getSettings } from '../core/settings'
import { getGame, useGame } from '../core/store'
import { addCar, makeCarState, removeCar } from '../core/telemetry'
import { buildCarModel, disposeCarModel, poseCarModel, WHEEL_REST_Y } from './carModel'
import { getGhost, sampleGhost } from './ghost'
import { links } from './links'
import { DT } from './tuning'

const _qa = new THREE.Quaternion()
const _qb = new THREE.Quaternion()
const _prev = new THREE.Vector3()
const REST_HUBS = [WHEEL_REST_Y, WHEEL_REST_Y, WHEEL_REST_Y, WHEEL_REST_Y]
const SPIN = new Float64Array(4)

export function GhostCar() {
  const ghostVersion = useGame((s) => s.ghostVersion)
  const trace = useMemo(() => getGhost(), [ghostVersion])
  const model = useMemo(() => (trace ? buildCarModel(trace.body, PALETTE.ghost, PALETTE.ghost, { ghost: true }) : null), [trace])
  useEffect(() => () => {
    if (model) disposeCarModel(model)
  }, [model])

  const car = useMemo(() => {
    const c = makeCarState('ghost', 'ghost', 'Ghost')
    c.paint = PALETTE.ghost
    c.glow = PALETTE.ghost
    c.trail = PALETTE.ghost
    return c
  }, [])

  useEffect(() => {
    if (!model || !trace) return
    car.body = trace.body
    car.object = model
    car.anchors = model.userData.anchors
    model.visible = false
    addCar(car)
    return () => removeCar(car.id)
  }, [model, trace, car])

  useFrame((_, dt) => {
    if (!model || !trace) return
    const lap = links.playerLap
    const g = getGame()
    const wanted = g.mode === 'timetrial' || (g.mode === 'free' && getSettings().ghost)
    if (!lap || !lap.timing || !wanted || g.phase === 'title') {
      model.visible = false
      return
    }
    // The player's car renders one interpolated step behind physics; match it.
    const alpha = Math.min(1, Math.max(0, (performance.now() - links.playerStepAt) / (DT * 1000)))
    const t = (lap.stepsThisLap - 1 + alpha) * DT
    _prev.copy(model.position)
    if (!sampleGhost(trace, t, model.position, model.quaternion, _qa, _qb)) {
      model.visible = false // the ghost has finished its lap
      return
    }
    model.visible = true
    car.position.copy(model.position)
    car.quaternion.copy(model.quaternion)
    if (dt > 0) car.velocity.subVectors(model.position, _prev).divideScalar(Math.max(dt, 1e-3))
    car.speedKmh = car.velocity.length() * 3.6
    // Wheels roll at the ghost's speed (fake but convincing).
    const roll = (car.speedKmh / 3.6 / 0.34) * dt
    for (let i = 0; i < 4; i++) SPIN[i] += roll
    poseCarModel(model, { wheelHubY: REST_HUBS, wheelSpin: SPIN, steerAngle: 0, roll: 0, pitch: 0 })
  }, -40)

  return model ? <primitive object={model} /> : null
}
