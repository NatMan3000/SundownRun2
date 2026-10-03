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
//
//  The 3D view (look3d.ts) uses a second, ordinary perspective
//  camera. Pressing 3D swaps to it while it is still pointing
//  straight down from the height where the ground looks the same
//  size as on the map, so the swap can't be seen; then it tilts and
//  swoops into 3D. Going back, it tilts up to that same spot first
//  and only then swaps back to the map camera.
// ============================================================

import { useEffect, useLayoutEffect, useMemo } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { getTrack } from '../track/current'
import { registerInspector } from '../core/devHandles'
import { view } from './view'
import { look, resetLook3d, stepLook3d, groundAt, useLook3d, worldHalf } from './look3d'
import { LOOK, aim, blendOrbit, ease, filmOffsetFor, followOrbit, mapOrbit, orbitOk, placeCamera, poseCamera } from './look3dMath'

/** How high above the tallest hill the camera hangs. Low enough that the world's haze stays thin. */
const HEIGHT_ABOVE_TERRAIN = 350
/**
 * The 3D camera's near and far planes. Far reaches past the most zoomed-out map's matching
 * camera (look3dMath.ts LOOK.maxMapDist) to the corners of its picture; the sky dome is drawn
 * behind everything whatever its size, so it doesn't mind.
 */
const NEAR_3D = 0.5
const FAR_3D = 11000
/** A frame longer than this is counted as this long, so a hitch can't make the tilt skip ahead. */
const MAX_STEP = 1 / 30

// scratch (no allocation per frame)
const _aim = { yaw: 0, pitch: 0 }

export function TopDownCamera() {
  const scene = useThree((s) => s.scene)
  const set = useThree((s) => s.set)
  const get = useThree((s) => s.get)
  const perspective = useLook3d((s) => s.mode !== 'map')

  const mapCam = useMemo(() => {
    const c = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 2000)
    c.position.set(0, 400, 0)
    // We size it ourselves every frame; r3f must not reshape it on a window resize.
    ;(c as THREE.OrthographicCamera & { manual?: boolean }).manual = true
    return c
  }, [])
  const lookCam = useMemo(() => {
    const c = new THREE.PerspectiveCamera(LOOK.fovDeg, 16 / 9, NEAR_3D, FAR_3D)
    ;(c as THREE.PerspectiveCamera & { manual?: boolean }).manual = true
    return c
  }, [])

  // Checkers can look at what is under the map: __game.get('editorScene').
  useEffect(() => registerInspector('editorScene', () => scene), [scene])

  // While the editor is open one of our cameras is the one the game draws with; the
  // game's own camera comes back when it closes (and the 3D view resets to the map).
  useLayoutEffect(() => {
    const before = get().camera
    return () => {
      resetLook3d()
      set({ camera: before as THREE.PerspectiveCamera })
    }
  }, [get, set])
  useLayoutEffect(() => {
    set({ camera: (perspective ? lookCam : mapCam) as unknown as THREE.PerspectiveCamera })
  }, [perspective, lookCam, mapCam, set])

  useFrame((state, delta) => {
    if (perspective) placeLookCamera(lookCam, state.size.width, state.size.height, Math.min(MAX_STEP, Math.max(0, delta)))
    else placeMapCamera(mapCam)
  })

  return null
}

/** The flat map camera: straight down over view.ts's centre, as wide as the screen at view.mpp. */
function placeMapCamera(c: THREE.OrthographicCamera): void {
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
}

/**
 * The 3D camera: glide after your hand, ease between the map's pose and the
 * 3D one while tilting in or out, then keep inside the world and above the
 * ground (look3dMath.ts placeCamera).
 */
function placeLookCamera(c: THREE.PerspectiveCamera, width: number, height: number, dt: number): void {
  // The map as an Orbit, from view.ts as it is now (the 3D view never changes it).
  mapOrbit(view.cx, view.cz, groundAt(view.cx, view.cz), view.height, view.mpp, look.cur.yaw, look.map)
  // The spot you look at rests on the ground as it slides over hills.
  look.goal.y = groundAt(look.goal.x, look.goal.z)
  followOrbit(look.cur, look.goal, 1 - Math.exp(-LOOK.follow * dt))
  if (!orbitOk(look.cur)) {
    // NaN firewall: a broken number never reaches the camera; start from the map again.
    console.error('[editor 3D] the camera got a bad number; starting again from the map view')
    look.cur.x = look.goal.x = look.map.x
    look.cur.z = look.goal.z = look.map.z
    look.cur.y = look.goal.y = look.map.y
    look.cur.yaw = look.goal.yaw = 0
    look.cur.pitch = look.goal.pitch = LOOK.openPitch
    look.cur.dist = look.goal.dist = 300
  }
  const mix = ease(stepLook3d(dt))
  blendOrbit(look.map, look.cur, mix, look.shown)
  const pos = placeCamera(look.shown, groundAt, worldHalf(), look.camera)
  // Face the spot. Straight down (the map) keeps the map's "north up".
  aim(pos, look.shown, look.shown.yaw, _aim)
  if (!Number.isFinite(pos.x + pos.y + pos.z + _aim.yaw + _aim.pitch)) return
  poseCamera(c, pos, _aim)
  // The spot sits in the middle of the open map (left of the panel), not the middle of the window:
  // the lens is slid sideways (film offset), by none at all on the map and fully in 3D.
  const aspect = width / Math.max(1, height)
  const filmOffset = filmOffsetFor(look.shiftPx * mix, width, aspect, c.filmGauge)
  if (c.aspect !== aspect || c.fov !== LOOK.fovDeg || c.filmOffset !== filmOffset) {
    c.aspect = aspect
    c.fov = LOOK.fovDeg
    c.filmOffset = filmOffset
    c.updateProjectionMatrix()
  }
  look.version++
}
