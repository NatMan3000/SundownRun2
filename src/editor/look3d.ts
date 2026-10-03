// ============================================================
//  3D VIEW - look round the real track from any angle
// ------------------------------------------------------------
//  The map is a flat view straight down, which can't show how high
//  a hill is, which way a bank tilts or how a bridge crosses. The
//  3D button (beside the compass, or the T key) tilts the camera
//  down out of the map into a 3D view of the same spot:
//
//    drag            turn round the spot (and tilt up and down)
//    right-drag      slide along the ground (also middle-drag, or
//                    Space + drag, or WASD / the arrow keys)
//    mouse wheel     closer and further (also + and -)
//    controller      left stick slides, right stick turns,
//                    triggers zoom, B goes back to the map
//    3D again, T,    back to the map, exactly where it was
//    or Esc
//
//  It is for looking only: the drawing tools wait on the map (the
//  rail dims and says "Back to the map to edit"). The map's own view
//  (view.ts) is never touched while you look round in 3D, so the map
//  comes back exactly as you left it.
//
//  How the pieces fit:
//    look3dMath.ts   the camera-on-a-stick maths (Orbit)
//    look3d.ts       this file: what the 3D view is doing now, and
//                    the actions (open, close, turn, slide, zoom)
//    TopDownCamera   the editor's two cameras: the flat map camera and
//                    the 3D one, and the tilt between them
//    Look3dUi.tsx    the 3D button, the note at the top, your mouse,
//                    keys and controller in 3D, and the problem pins
//    look3dMarks.tsx what is selected, lit up on the real road in 3D
// ============================================================

import { create } from 'zustand'
import { getTrack } from '../track/current'
import { audio } from '../core/api'
import { view } from './view'
import { LOOK, type Orbit, type V3, clampDist, clampPitch, clampToWorld, copyOrbit, mapOrbit, metresPerPixelAt, openingOrbit, orbit, orbitOk, panOrbit } from './look3dMath'

/**
 * What the 3D view is doing:
 *   map      the flat map (the 3D view is off)
 *   opening  tilting down out of the map
 *   3d       looking round
 *   closing  tilting back up into the map
 * The drawing tools only work in 'map'.
 */
export type LookMode = 'map' | 'opening' | '3d' | 'closing'

export const useLook3d = create<{ mode: LookMode }>(() => ({ mode: 'map' }))

/** True while the 3D view is showing (or tilting in or out): the map's tools wait. */
export function look3dOn(): boolean {
  return useLook3d.getState().mode !== 'map'
}

/**
 * The 3D camera's state, changed every frame (a plain object, not React
 * state, like view.ts). `goal` is where your hand has put the camera; `cur`
 * glides after it; `mix` is how far the view has tilted from the map (0)
 * into 3D (1).
 */
export const look = {
  goal: orbit(),
  cur: orbit(),
  /** The map as an Orbit (worked out every frame from view.ts; never changes it). */
  map: orbit(),
  /** The camera pose actually drawn this frame (after the ground and edge rules). */
  shown: orbit(),
  camera: { x: 0, y: 0, z: 0 } as V3,
  /** 0 = the map, 1 = 3D. */
  mix: 0,
  /** The map's view when 3D opened, to prove it comes back the same (dev handle). */
  mapAtOpen: null as { cx: number; cz: number; mpp: number } | null,
  /**
   * How far left of the screen's middle the 3D view centres its spot, pixels:
   * the middle of the map you can see between the rail and the panel, not the
   * middle of the whole window (the panel covers the right of it).
   */
  shiftPx: 0,
  /** Bumped whenever the camera moved this frame (the pins redraw then). */
  version: 0,
}

/**
 * The middle of the open map between the tool rail and the panel, as a
 * screen x (CSS pixels). Read from the page when 3D opens, so it follows
 * however wide the window made the panel.
 */
function openMiddleX(): number {
  if (typeof document === 'undefined') return view.width / 2
  const panel = document.querySelector('.sre-panel')?.getBoundingClientRect()
  const rail = document.querySelector('.sre-tools')?.getBoundingClientRect()
  const left = rail ? rail.right : 0
  const right = panel && panel.left > left + 200 ? panel.left : view.width
  return (left + right) / 2
}

/** The ground height under x, z on the track being shown (0 before there is one). */
export function groundAt(x: number, z: number): number {
  const t = getTrack()
  if (!t) return 0
  const half = t.world.half
  const h = t.terrainHeight(Math.min(half, Math.max(-half, x)), Math.min(half, Math.max(-half, z)))
  return Number.isFinite(h) ? h : 0
}

/** Half the side of the world square (the 3D camera stays inside it). */
export function worldHalf(): number {
  return getTrack()?.world.half ?? 1000
}

/** Tilt down out of the map into 3D, looking at what the map is looking at. */
export function openLook3d(): boolean {
  const mode = useLook3d.getState().mode
  if (mode === 'opening' || mode === '3d') return false
  if (mode === 'map') {
    // Start from the map exactly as it is, then glide into the opening view.
    mapOrbit(view.cx, view.cz, groundAt(view.cx, view.cz), view.height, view.mpp, 0, look.map)
    copyOrbit(look.map, look.shown)
    look.mix = 0
    look.mapAtOpen = { cx: view.cx, cz: view.cz, mpp: view.mpp }
    openingOrbit(look.map, look.goal)
    // Look at the spot in the middle of the open map (it stays in the middle of what you can see).
    const middle = openMiddleX()
    look.shiftPx = view.width / 2 - middle
    look.goal.x = view.cx - look.shiftPx * view.mpp
    const half = worldHalf()
    look.goal.x = clampToWorld(look.goal.x, half, LOOK.edgeMargin + 8)
    look.goal.z = clampToWorld(look.goal.z, half, LOOK.edgeMargin + 8)
    look.goal.y = groundAt(look.goal.x, look.goal.z)
    copyOrbit(look.goal, look.cur)
  }
  // From 'closing', it simply turns round and tilts back down from where it is.
  useLook3d.setState({ mode: 'opening' })
  audio.ui('select')
  return true
}

/** Tilt back up into the map. Returns true if the 3D view was showing (so Esc did something). */
export function closeLook3d(): boolean {
  const mode = useLook3d.getState().mode
  if (mode === 'map') return false
  if (mode === 'closing') return true
  useLook3d.setState({ mode: 'closing' })
  audio.ui('back')
  return true
}

export function toggleLook3d(): void {
  const mode = useLook3d.getState().mode
  if (mode === 'map' || mode === 'closing') openLook3d()
  else closeLook3d()
}

/**
 * Snap straight to the map, no tilt (the editor closing, a test drive
 * starting). The map's view was never changed, so there is nothing to put back.
 */
export function resetLook3d(): void {
  look.mix = 0
  if (useLook3d.getState().mode !== 'map') useLook3d.setState({ mode: 'map' })
}

/** Someone who asked their computer for less motion gets a quick fade of a tilt, not a swoop. */
const lessMotion = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null
const QUICK_SECONDS = 0.12

/** Moves the animation along one frame (called by the camera, dt in seconds). Returns the mix. */
export function stepLook3d(dt: number): number {
  const mode = useLook3d.getState().mode
  const quick = !!lessMotion?.matches
  if (mode === 'opening') {
    look.mix = Math.min(1, look.mix + dt / (quick ? QUICK_SECONDS : LOOK.openSeconds))
    if (look.mix >= 1) useLook3d.setState({ mode: '3d' })
  } else if (mode === 'closing') {
    look.mix = Math.max(0, look.mix - dt / (quick ? QUICK_SECONDS : LOOK.closeSeconds))
    if (look.mix <= 0) useLook3d.setState({ mode: 'map' })
  } else if (mode === '3d') look.mix = 1
  else look.mix = 0
  return look.mix
}

// ---------------------------------------------------------------- your hands in 3D

/** Turn round the spot (radians): yaw round the compass, pitch up and down. */
export function turnLook(dYaw: number, dPitch: number): void {
  if (!Number.isFinite(dYaw) || !Number.isFinite(dPitch)) return
  look.goal.yaw += dYaw
  look.goal.pitch = clampPitch(look.goal.pitch + dPitch)
}

/** Slide the spot along the ground by screen pixels (the ground follows your hand). */
export function slideLook(dxPx: number, dyPx: number): void {
  if (!Number.isFinite(dxPx) || !Number.isFinite(dyPx)) return
  panOrbit(look.goal, dxPx, dyPx, metresPerPixelAt(look.goal, view.height))
  const half = worldHalf()
  look.goal.x = clampToWorld(look.goal.x, half, LOOK.edgeMargin + 8)
  look.goal.z = clampToWorld(look.goal.z, half, LOOK.edgeMargin + 8)
}

/** Closer (factor under 1) or further (over 1). */
export function zoomLook(factor: number): void {
  if (!Number.isFinite(factor) || factor <= 0) return
  look.goal.dist = clampDist(look.goal.dist * factor)
}

/** The camera's goal, for the dev handle (rounded). */
export function lookSummary() {
  const r = (v: number, k = 10) => Math.round(v * k) / k
  const deg = (v: number) => r((v * 180) / Math.PI)
  const o: Orbit = look.cur
  return {
    mode: useLook3d.getState().mode,
    mix: r(look.mix, 1000),
    target: { x: r(o.x), y: r(o.y), z: r(o.z) },
    yawDeg: deg(o.yaw),
    pitchDeg: deg(o.pitch),
    dist: r(o.dist),
    camera: { x: r(look.camera.x), y: r(look.camera.y), z: r(look.camera.z) },
    groundUnderCamera: r(groundAt(look.camera.x, look.camera.z)),
    worldHalf: worldHalf(),
    ok: orbitOk(look.cur) && Number.isFinite(look.camera.x + look.camera.y + look.camera.z),
    mapAtOpen: look.mapAtOpen,
    mapNow: { cx: view.cx, cz: view.cz, mpp: view.mpp },
  }
}
