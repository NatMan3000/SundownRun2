// ============================================================
//  DEV PICK - "what is that glowing thing?" for checkers
// ------------------------------------------------------------
//  __dev.lookPick(x, y)       names of the objects under a screen
//                             point (0..1 across, 0..1 down), nearest
//                             first, with their distance
//  __dev.lookHide(name, on)   hide (or show again) every object whose
//                             name contains `name`, to see what is
//                             behind it
//  Dev only in spirit, harmless in a build: nothing runs per frame.
// ============================================================

import { useEffect } from 'react'
import * as THREE from 'three'
import { useThree } from '@react-three/fiber'
import { registerDev } from '../core/devHandles'

function label(o: THREE.Object3D): string {
  const names: string[] = []
  let p: THREE.Object3D | null = o
  while (p && names.length < 4) {
    if (p.name) names.push(p.name)
    p = p.parent
  }
  return names.length ? names.join(' < ') : o.type
}

export function DevPick(): null {
  const scene = useThree((s) => s.scene)
  const camera = useThree((s) => s.camera)

  useEffect(() => {
    const ray = new THREE.Raycaster()
    const offPick = registerDev(
      'lookPick',
      ((x = 0.5, y = 0.5) => {
        ray.setFromCamera(new THREE.Vector2(x * 2 - 1, -(y * 2 - 1)), camera)
        const hits = ray.intersectObjects(scene.children, true)
        return hits.slice(0, 8).map((h) => `${label(h.object)} @ ${h.distance.toFixed(1)} m`)
      }) as (...args: never[]) => unknown,
      'lookPick(x, y) - objects under a screen point (0..1, 0..1), nearest first',
    )
    const offHide = registerDev(
      'lookHide',
      ((name: string, hidden = true) => {
        let n = 0
        scene.traverse((o) => {
          if (o.name && o.name.includes(name)) {
            o.visible = !hidden
            n++
          }
        })
        return `${hidden ? 'hid' : 'showed'} ${n} object(s) matching "${name}"`
      }) as (...args: never[]) => unknown,
      'lookHide(name, hidden = true) - hide or show every scene object whose name contains name',
    )
    return () => {
      offPick()
      offHide()
    }
  }, [scene, camera])

  return null
}
