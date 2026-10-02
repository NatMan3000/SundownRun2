// ============================================================
//  DEV PICK - "what is that glowing thing?" for checkers
// ------------------------------------------------------------
//  __dev.lookPick(x, y)       names of the objects under a screen
//                             point (0..1 across, 0..1 down), nearest
//                             first, with their distance
//  __dev.lookHide(name, on)   hide (or show again) every object whose
//                             name contains `name`, to see what is
//                             behind it
//  ?hide=<name>,<name>        the same from the URL, for a computer
//                             without a console (e.g. ?hide=road-skirt
//                             to see if a glitch goes with the slab
//                             sides); re-applied once a second, so it
//                             catches things that load late
//  Dev only in spirit, harmless in a build: nothing runs per frame.
// ============================================================

import { useEffect } from 'react'
import * as THREE from 'three'
import { useThree } from '@react-three/fiber'
import { registerDev, urlParam } from '../core/devHandles'

function label(o: THREE.Object3D): string {
  const names: string[] = []
  let p: THREE.Object3D | null = o
  while (p && names.length < 4) {
    if (p.name) names.push(p.name)
    p = p.parent
  }
  return names.length ? names.join(' < ') : o.type
}

/** Hide (or show) every scene object whose name contains `name`; returns how many. */
function hideMatching(scene: THREE.Scene, name: string, hidden: boolean): number {
  let n = 0
  scene.traverse((o) => {
    if (o.name && o.name.includes(name)) {
      o.visible = !hidden
      n++
    }
  })
  return n
}

export function DevPick(): null {
  const scene = useThree((s) => s.scene)
  const camera = useThree((s) => s.camera)

  // ?hide=a,b: keep hiding the named layers (things mount late, and a track change rebuilds them).
  useEffect(() => {
    const names = (urlParam('hide') ?? '')
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean)
    if (names.length === 0) return
    const apply = () => {
      for (const n of names) hideMatching(scene, n, true)
    }
    apply()
    const timer = window.setInterval(apply, 1000)
    return () => window.clearInterval(timer)
  }, [scene])

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
        const n = hideMatching(scene, name, hidden)
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
