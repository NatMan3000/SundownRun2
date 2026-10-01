// ============================================================
//  HEADLIGHT RIG - the player's real headlights
// ------------------------------------------------------------
//  Two SpotLights (no shadows) that genuinely light the road and
//  everything in front of the player's car once night falls. Their
//  strength follows environment.headlights (0 before timeOfDay 0.35,
//  full by 0.6), written by the world's clock.
//
//  They live here, in the always-mounted fx system, and are never
//  removed: adding or removing a light makes three.js recompile
//  every lit material, which would hitch the game each time you
//  open the editor. At sundown they simply sit at intensity 0.
//  Every other car's headlights are fake (emissive beams in
//  CarLights.tsx), per the light budget in CONSTITUTION section 2.
// ============================================================

import { useMemo } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { PALETTE } from '../../core/palette'
import { cars, environment } from '../../core/telemetry'
import type { CarState } from '../../core/telemetry'

/** Candela at full night. The road is near-black glass, so it takes a strong lamp to show. */
const INTENSITY = 700
const _local = new THREE.Vector3()
const _target = new THREE.Vector3(0, -0.9, 18)

/**
 * Where the player's headlights are this frame (midpoint of the two lamps,
 * beam direction, 0..1 strength). The road shader draws their pool from this.
 */
export const headlightState = {
  position: new THREE.Vector3(),
  direction: new THREE.Vector3(0, 0, 1),
  strength: 0,
}

function playerCar(): CarState | null {
  for (let i = 0; i < cars.length; i++) if (cars[i].kind === 'player') return cars[i]
  return null
}

export function HeadlightRig() {
  const rig = useMemo(() => {
    const make = () => {
      const l = new THREE.SpotLight(PALETTE.laneLine, 0, 95, 0.46, 0.6, 1.25)
      l.castShadow = false
      return l
    }
    const lights = [make(), make()]
    const targets = [new THREE.Object3D(), new THREE.Object3D()]
    lights[0].target = targets[0]
    lights[1].target = targets[1]
    return { lights, targets }
  }, [])

  useFrame(() => {
    const car = playerCar()
    const strength = car && car.anchors ? environment.headlights : 0
    headlightState.strength = strength
    if (car && car.anchors && strength > 0) {
      const hl = car.anchors.headLights
      headlightState.position.set(0, hl.length ? hl[0].y : 0.5, hl.length ? hl[0].z : 2).applyQuaternion(car.quaternion).add(car.position)
      headlightState.direction.copy(_target).normalize().applyQuaternion(car.quaternion)
    }
    for (let k = 0; k < 2; k++) {
      const light = rig.lights[k]
      light.intensity = strength * INTENSITY
      if (!car || !car.anchors || strength <= 0) continue
      const hl = car.anchors.headLights[Math.min(k, car.anchors.headLights.length - 1)]
      light.position.copy(hl).applyQuaternion(car.quaternion).add(car.position)
      _local.set(hl.x * 1.6, _target.y, _target.z)
      rig.targets[k].position.copy(_local).applyQuaternion(car.quaternion).add(car.position)
      rig.targets[k].updateMatrixWorld()
    }
  })

  return (
    <>
      <primitive object={rig.lights[0]} />
      <primitive object={rig.lights[1]} />
      <primitive object={rig.targets[0]} />
      <primitive object={rig.targets[1]} />
    </>
  )
}
