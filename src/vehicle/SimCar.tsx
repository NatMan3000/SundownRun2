// ============================================================
//  SIM CAR - an Ai racer's car (the play worker drives it)
// ------------------------------------------------------------
//  Exactly the player's physics (SimulatedCar + CarSim), with a
//  Driver (src/core/api.ts) as the brain instead of a keyboard.
//  The driver's update() runs at the start of every physics step;
//  it reads the car and writes throttle / brake / steer /
//  handbrake / powerScale.
//
//  Ai cars use neutral handling (every multiplier 1) so the
//  player's handling settings never change how the Ai drives,
//  but they share the world rules: top speed, mag-grip speed and
//  boost strength.
// ============================================================

import { useMemo } from 'react'
import type { SimCarProps } from '../core/api'
import { getSettings } from '../core/settings'
import type { CarState } from '../core/telemetry'
import { CarSim } from './carSim'
import { LapTracker } from './lapTracker'
import { SimulatedCar } from './SimulatedCar'
import { DT } from './tuning'

export function SimCar(props: SimCarProps) {
  const { id, name, body, paint, glow, trail, gridSlot, driver } = props
  const sim = useMemo(() => new CarSim(id), [id])
  const lap = useMemo(() => new LapTracker(null), [])

  const beforeStep = (s: CarSim, car: CarState) => {
    const set = getSettings()
    const h = s.handling
    h.grip = 1
    h.steerGain = 1
    h.stability = 1
    h.power = 1
    h.brakes = 1
    h.topSpeedKmh = set.topSpeedKmh
    h.magGripKmh = set.magGripKmh
    h.boostStrength = set.boostStrength
    try {
      driver.update(car, DT)
    } catch (err) {
      // A broken brain must not take the physics down with it: coast, and say so once.
      if (!s.frozen) console.error(`[vehicle] driver for ${id} threw; the car will coast`, err)
      driver.throttle = 0
      driver.brake = 0
      driver.steer = 0
      driver.handbrake = false
    }
    const c = s.controls
    c.throttle = driver.throttle
    c.brake = driver.brake
    c.steer = driver.steer
    c.handbrake = driver.handbrake
    c.powerScale = driver.powerScale ?? 1
  }

  return (
    <SimulatedCar
      id={id}
      kind="ai"
      name={name}
      body={body}
      paint={paint}
      glow={glow}
      trail={trail}
      gridSlot={gridSlot}
      sim={sim}
      lap={lap}
      beforeStep={beforeStep}
    />
  )
}
