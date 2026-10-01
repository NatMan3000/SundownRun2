// ============================================================
//  EVENT FX - light that answers the game-event feed
// ------------------------------------------------------------
//  Listens to core/events.ts (read only) and answers a few car
//  moments with light, through the same fx API everyone uses:
//    boost       a mint ring kicks out under the car (T3 flash)
//    crash       hot sparks off the front of the car, scaled by
//                how hard the hit was
//    speedtrap   an amber ring as you blast through the trap
//    lap.complete a cyan ring on the line
//  Gameplay systems fire their own bursts for their own objects
//  (props, cores, smashables); this file only covers the car.
// ============================================================

import { useEffect } from 'react'
import * as THREE from 'three'
import { fx } from '../../core/api'
import { on } from '../../core/events'
import { PALETTE } from '../../core/palette'
import { telemetry } from '../../core/telemetry'

const _p = new THREE.Vector3()
const _n = new THREE.Vector3()

export function EventFx(): null {
  useEffect(() => {
    const offs = [
      on('boost', (e) => {
        _p.copy(telemetry.carPosition).addScaledVector(telemetry.carUp, -0.5)
        fx.pulse(_p, PALETTE.boost, 5 + 2 * Math.min(2, e.strength))
      }),
      on('crash', (e) => {
        if (e.intensity < 0.15) return
        _p.copy(telemetry.carPosition).addScaledVector(telemetry.carForward, 2.1).addScaledVector(telemetry.carUp, -0.2)
        _n.copy(telemetry.carForward).negate()
        fx.sparks(_p, _n, Math.min(1, e.intensity))
      }),
      on('speedtrap', () => {
        _p.copy(telemetry.carPosition).addScaledVector(telemetry.carUp, -0.5)
        fx.pulse(_p, PALETTE.speedTrap, 8)
      }),
      on('lap.complete', (e) => {
        _p.copy(telemetry.carPosition).addScaledVector(telemetry.carUp, -0.5)
        fx.pulse(_p, e.best ? PALETTE.uiGood : PALETTE.uiAccent, 9)
      }),
    ]
    return () => {
      for (const off of offs) off()
    }
  }, [])
  return null
}
