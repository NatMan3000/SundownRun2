// ============================================================
//  TOP-DOWN CAMERA - the editor's map view of the real world
// ------------------------------------------------------------
//  While the editor is open this replaces the chase camera with an
//  orthographic one (no perspective: things far away are not
//  smaller, like a map) hanging high above the world and looking
//  straight down, north at the top. The terrain, road, pieces, sky
//  light and glow all render live underneath, so what Josh sees is
//  the actual track, not a drawing of it.
//
//  Where it looks comes from the `view` singleton (view.ts), which
//  the overlay's pan and zoom controls change.
// ============================================================

import { useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { OrthographicCamera } from '@react-three/drei'
import { getTrack } from '../track/current'
import { view } from './view'

/** How high above the tallest hill the camera hangs. Low enough that the world's haze stays thin. */
const HEIGHT_ABOVE_TERRAIN = 350

export function TopDownCamera() {
  const cam = useRef<THREE.OrthographicCamera>(null)

  useFrame(() => {
    const c = cam.current
    if (!c) return
    const track = getTrack()
    const top = track ? track.terrain.maxHeight : 60
    const bottom = track ? Math.min(track.terrain.minHeight, track.world.catchFloorY) : -40
    const halfW = (view.width * view.mpp) / 2
    const halfH = (view.height * view.mpp) / 2
    if (c.right !== halfW || c.top !== halfH) {
      c.left = -halfW
      c.right = halfW
      c.top = halfH
      c.bottom = -halfH
    }
    const y = top + HEIGHT_ABOVE_TERRAIN
    c.near = 1
    c.far = y - bottom + 200
    c.position.set(view.cx, y, view.cz)
    // Looking straight down with -z (north) at the top of the screen.
    c.up.set(0, 0, -1)
    c.lookAt(view.cx, 0, view.cz)
    c.updateProjectionMatrix()
  })

  return <OrthographicCamera ref={cam} makeDefault manual position={[0, 400, 0]} near={1} far={2000} />
}
