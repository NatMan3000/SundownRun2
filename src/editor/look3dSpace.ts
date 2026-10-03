// ============================================================
//  MAP OR 3D - where a screen spot is in the world, either way
// ------------------------------------------------------------
//  Every editor tool works the same on the flat map and in the 3D
//  view, because the tools never ask view.ts directly "where is
//  this screen spot?": they ask this file. On the map it gives
//  view.ts's answer, exactly as before. In 3D it asks the 3D
//  camera instead:
//
//    toWorld()       the spot the mouse points at: the road (the first
//                    surface you see) or the ground; while dragging a
//                    road point, a piece or a bend, a flat sheet at the
//                    height you grabbed it, so it follows your hand
//    roadUnder()     the road under the mouse, with the map's reach (12
//                    pixels past the edge), and the right road at a
//                    crossing (the one you're looking at)
//    roadNearest()   the nearest road to a spot, the one it was picked
//                    on when there are two (a crossing)
//    worldToScreen() where a spot on the road or the ground shows on
//                    screen (the map's marks are drawn there in 3D);
//                    pointToScreen() puts a spot the mouse picked (the
//                    pencil's line) back at the very height it was picked
//    setRoadShown()  off on an empty map: the empty world's hidden
//                    stand-in road is never picked or drawn on
//    mppAt()         how many metres one pixel covers at a spot
//    dragView() / zoomViewAt()   the view under your hand: the map pans,
//                    the 3D view turns (right-drag) or slides
//
//  The picking maths is look3dPick.ts. The 3D camera tells this file
//  each frame it has moved (TopDownCamera.tsx calls posed()), and the
//  overlay draws its 3D marks then, so they never lag the picture.
// ============================================================

import type * as THREE from 'three'
import type { P } from './geom'
import { type RoadCurve, type RoadHit, PER, nearestOnRoad } from './road'
import { look, look3dOn, shownTrack, slideLook, turnLook, zoomLook } from './look3d'
import { LOOK, metresPerPixelAt } from './look3dMath'
import { PICK_REACH, type RoadPick, RoadPicker, lastRay, project } from './look3dPick'
import { panBy, screenToWorld, view, worldToScreen as mapToScreen, zoomAt } from './view'

/** The 3D view's camera (TopDownCamera.tsx hands it over), or null before it exists. */
let camera: THREE.PerspectiveCamera | null = null
export function setLookCamera(c: THREE.PerspectiveCamera | null): void {
  camera = c
}

/** Bumped by the 3D camera whenever it really moved (the overlay redraws then, and only then). */
export const pose = { version: 0 }

/** One picker per built track (it keeps a grid of the road's samples). */
let picker: RoadPicker | null = null
/** False on an empty map: the empty world's stand-in road is hidden, so it is never picked or drawn on. */
let roadShown = true
export function setRoadShown(on: boolean): void {
  roadShown = on
}
function pickerNow(): RoadPicker | null {
  const t = shownTrack()
  if (!t) return null
  if (!picker || picker.track !== t) picker = new RoadPicker(t)
  return picker
}

/** True while the editor's tools are working through the 3D camera (the 3D view, or tilting in or out). */
export function in3d(): boolean {
  return look3dOn() && camera !== null
}

// ---------------------------------------------------------------- the frame hook

let afterPose: (() => void) | null = null
/** The overlay's 3D frame: called right after the 3D camera has been placed (so marks never lag the picture). */
export function onPosed(fn: (() => void) | null): void {
  afterPose = fn
}
/** What the overlay's 3D frame costs (for the dev handle: the tools' marks must leave the frame budget alone). */
export const frame3dStats = { frames: 0, ms: 0, maxMs: 0 }
/** The 3D camera has been placed for this frame (`moved`: it is somewhere new). */
export function posed(moved: boolean): void {
  if (moved) pose.version++
  if (!afterPose) return
  const t0 = performance.now()
  afterPose()
  const ms = performance.now() - t0
  frame3dStats.frames++
  frame3dStats.ms += ms
  if (ms > frame3dStats.maxMs) frame3dStats.maxMs = ms
}

// ---------------------------------------------------------------- the road under the mouse

/** The last road pick, kept so several questions about the same spot in the same frame cost one pick. */
const lastPick = { sx: NaN, sy: NaN, version: -1, track: null as unknown, hit: null as RoadPick | null, copy: { i: -1, f: 0, x: 0, y: 0, z: 0, lateral: 0, dirX: 1, dirZ: 0, direct: false, px: 0 } as RoadPick }
/** Picks worked out (for the dev handle: proves hover work is once a frame at most). */
export const pickStats = { picks: 0 }

/** The road under screen spot (sx, sy) in 3D, as the built road has it (null on the map, or off every road). */
export function pick3d(sx: number, sy: number): RoadPick | null {
  const p = pickerNow()
  if (!camera || !p || !roadShown) return null
  if (lastPick.sx === sx && lastPick.sy === sy && lastPick.version === pose.version && lastPick.track === p.track) return lastPick.hit
  pickStats.picks++
  const hit = p.pick(camera, sx, sy, view.width, view.height, PICK_REACH.px, PICK_REACH.metres)
  lastPick.sx = sx
  lastPick.sy = sy
  lastPick.version = pose.version
  lastPick.track = p.track
  lastPick.hit = hit ? Object.assign(lastPick.copy, hit) : null
  return lastPick.hit
}

/**
 * The nearest spot on the editor's road to q, on the stretch heading (dirX, dirZ) (the
 * driving direction, within about 37 degrees): at a crossing, the road you picked, not the
 * one across it. With no stretch heading that way nearby, plain nearest.
 */
export function nearestOnRoadHeading(rc: RoadCurve, q: P, dirX: number, dirZ: number): RoadHit {
  const n = rc.curve.length
  let best: RoadHit | null = null
  let bestScore = Infinity
  for (let i = 0; i < n; i++) {
    const a = rc.curve[i]
    const b = rc.curve[(i + 1) % n]
    const vx = b.x - a.x
    const vz = b.z - a.z
    const len2 = vx * vx + vz * vz || 1
    const len = Math.sqrt(len2)
    const t = Math.max(0, Math.min(1, ((q.x - a.x) * vx + (q.z - a.z) * vz) / len2))
    const px = a.x + vx * t
    const pz = a.z + vz * t
    const d = Math.hypot(q.x - px, q.z - pz)
    const heading = (vx * dirX + vz * dirZ) / len
    const score = d + (heading < 0.8 ? 1e6 : 0)
    if (score < bestScore) {
      bestScore = score
      const side = ((q.x - px) * -vz + (q.z - pz) * vx) / len
      best = { at: (i + t) / PER, lateral: side, distance: d, p: { x: px, z: pz } }
    }
  }
  return best ?? nearestOnRoad(rc, q)
}

/**
 * 3D only: the road under the mouse as the editor's road (its `at`), or null. The pick is the
 * built road you can see; this finds the same spot on the editor's road, on the stretch heading
 * the same way (so at a crossing it stays on the road you're looking at).
 */
export function roadUnder(rc: RoadCurve, sx: number, sy: number): RoadHit | null {
  if (!rc.curve.length) return null
  const hit = pick3d(sx, sy)
  if (!hit) return null
  return nearestOnRoadHeading(rc, { x: hit.x, z: hit.z }, hit.dirX, hit.dirZ)
}

/** The road heading each 3D-picked world spot was on (so a later "nearest road" keeps to that road). */
const headingOf = new WeakMap<P, { x: number; z: number }>()
/** How high each 3D-picked world spot was (the pencil's line is drawn at the very height it was drawn on). */
const heightOf = new WeakMap<P, number>()

/** The nearest spot on the road to q: on the map plain nearest; in 3D, on the road q was picked on. */
export function roadNearest(rc: RoadCurve, q: P): RoadHit {
  const dir = headingOf.get(q)
  return dir ? nearestOnRoadHeading(rc, q, dir.x, dir.z) : nearestOnRoad(rc, q)
}

// ---------------------------------------------------------------- the spot under the mouse

/** While dragging something in 3D: the height of the flat sheet it slides on (null: point at surfaces). */
let dragPlaneY: number | null = null
/** How high the last toWorld() spot was (3D), metres. */
let lastY = 0

/** Drag on a flat sheet at height y (3D), or stop (null). */
export function setDragPlane(y: number | null): void {
  dragPlaneY = y !== null && Number.isFinite(y) ? y : null
}

/** How high the last spot toWorld() found was (the ground or road under the mouse in 3D; 0 on the map). */
export function lastWorldY(): number {
  return lastY
}

/** Where the line of sight (from the last aim) meets the flat sheet at height y, or null (it points away). */
function onSheet(y: number, out: P): boolean {
  const r = lastRay()
  if (Math.abs(r.dy) < 1e-6) return false
  const t = (y - r.oy) / r.dy
  if (!(t > 0) || t > 20000) return false
  out.x = r.ox + r.dx * t
  out.z = r.oz + r.dz * t
  return Number.isFinite(out.x + out.z)
}

/**
 * The world spot under screen spot (sx, sy). On the map: view.ts's answer. In 3D: on the
 * drag sheet while dragging, else the road you see there, else the ground, else (the sky)
 * the flat sheet at the height the camera looks at, else far off towards the horizon.
 */
export function toWorld(sx: number, sy: number): P {
  if (!in3d()) {
    lastY = 0
    return screenToWorld(sx, sy)
  }
  const p = pickerNow()
  const out: P = { x: look.cur.x, z: look.cur.z }
  if (!p || !camera || !p.aim(camera, sx, sy, view.width, view.height)) return out
  if (dragPlaneY !== null && onSheet(dragPlaneY, out)) {
    lastY = dragPlaneY
    heightOf.set(out, lastY)
    return out
  }
  const road = pick3d(sx, sy)
  if (road?.direct) {
    out.x = road.x
    out.z = road.z
    lastY = road.y
    headingOf.set(out, { x: road.dirX, z: road.dirZ })
    heightOf.set(out, lastY)
    return out
  }
  if (!p.aim(camera, sx, sy, view.width, view.height)) return out
  const g = p.groundAt(camera, sx, sy, view.width, view.height)
  if (g) {
    out.x = g.x
    out.z = g.z
    lastY = g.y
    heightOf.set(out, lastY)
    return out
  }
  if (onSheet(look.cur.y, out)) {
    lastY = look.cur.y
    return out
  }
  // Pointing above the horizon: a spot far off that way, inside the world.
  const r = lastRay()
  const flat = Math.hypot(r.dx, r.dz) || 1
  const half = shownTrack()?.world.half ?? 1000
  out.x = Math.max(-half, Math.min(half, r.ox + (r.dx / flat) * 3000))
  out.z = Math.max(-half, Math.min(half, r.oz + (r.dz / flat) * 3000))
  lastY = p.ground(out.x, out.z)
  return out
}

// ---------------------------------------------------------------- world to screen

const _s = { sx: 0, sy: 0, depth: 0 }

/**
 * Where world spot x, z shows on screen. On the map: view.ts's answer. In 3D: on the road
 * there (`along`: the way the road heads, so at a crossing it is the right road, and spots a
 * little past the edge stay with the road), the top road when no heading is given, or the
 * ground ('ground'). Behind the camera: NaN (the canvas skips anything drawn at NaN).
 */
export function worldToScreen(x: number, z: number, along?: P | 'ground' | null): { sx: number; sy: number } {
  if (!in3d()) return mapToScreen(x, z)
  const p = pickerNow()
  if (!p || !camera) return { sx: NaN, sy: NaN }
  const y = along === 'ground' || !roadShown ? p.ground(x, z) : along ? p.surfaceY(x, z, along.x, along.z, 14) : p.surfaceY(x, z, 0, 0, 1)
  return project(camera, x, y, z, view.width, view.height, _s) ? { sx: _s.sx, sy: _s.sy } : { sx: NaN, sy: NaN }
}

/**
 * A world spot to the screen: in 3D, a spot the mouse picked shows at the very height it was
 * picked at (the pencil's line lies on what it was drawn on); any other spot as worldToScreen.
 */
export function pointToScreen(p: P, along?: P | 'ground' | null): { sx: number; sy: number } {
  if (in3d()) {
    const y = heightOf.get(p)
    if (y !== undefined) return worldToScreenY(p.x, y, p.z)
  }
  return worldToScreen(p.x, p.z, along)
}

/** World spot (x, y, z), height given, to the screen (3D; on the map the height doesn't matter). */
export function worldToScreenY(x: number, y: number, z: number): { sx: number; sy: number } {
  if (!in3d() || !camera) return mapToScreen(x, z)
  return project(camera, x, y, z, view.width, view.height, _s) ? { sx: _s.sx, sy: _s.sy } : { sx: NaN, sy: NaN }
}

/** The road surface (or ground) height at x, z, as worldToScreen() would draw it (3D; 0 on the map). */
export function heightAt(x: number, z: number, along?: P | null): number {
  const p = in3d() ? pickerNow() : null
  if (!p) return 0
  if (!roadShown) return p.ground(x, z)
  return along ? p.surfaceY(x, z, along.x, along.z, 14) : p.surfaceY(x, z, 0, 0, 1)
}

/**
 * Which way world direction `d` points on screen at spot `at` (a unit screen vector). On the
 * map it is d itself (north is up); in 3D the camera's view of it.
 */
export function screenDir(at: P, d: P, along?: P | null): { x: number; y: number } {
  const flat = Math.hypot(d.x, d.z) || 1
  if (!in3d()) return { x: d.x / flat, y: d.z / flat }
  // Both ends at the same height: a flat direction, wherever the road or ground goes.
  const y = heightAt(at.x, at.z, along ?? null)
  const a = worldToScreenY(at.x, y, at.z)
  const b = worldToScreenY(at.x + (d.x / flat) * 4, y, at.z + (d.z / flat) * 4)
  const dx = b.sx - a.sx
  const dy = b.sy - a.sy
  const len = Math.hypot(dx, dy)
  return len > 1e-6 && Number.isFinite(len) ? { x: dx / len, y: dy / len } : { x: d.x / flat, y: d.z / flat }
}

/** Metres one screen pixel covers at world spot x, z (on the map: everywhere the same). */
export function mppAt(x: number, z: number, along?: P | null): number {
  if (!in3d() || !camera) return view.mpp
  const y = heightAt(x, z, along)
  const dx = x - camera.position.x
  const dy = y - camera.position.y
  const dz = z - camera.position.z
  const dist = Math.max(LOOK.minDist * 0.25, Math.hypot(dx, dy, dz))
  return (2 * dist * Math.tan(((camera.fov || LOOK.fovDeg) * Math.PI) / 360)) / Math.max(1, view.height)
}

/** How zoomed in the view is, as metres per pixel: the map's, or in 3D at the spot the camera looks at. */
export function viewMpp(): number {
  return in3d() ? metresPerPixelAt(look.cur, view.height) : view.mpp
}

// ---------------------------------------------------------------- moving the view by hand

/** One full turn for a drag the height of the screen (the same feel as most 3D viewers). */
export function turnPerPixel(): number {
  return (Math.PI * 2) / Math.max(300, view.height)
}

/**
 * The view under your hand: on the map every drag pans; in 3D 'turn' looks round (right-drag,
 * or a left-drag where the tool has nothing to do) and 'slide' moves along the ground
 * (middle-drag, or Space + drag).
 */
export function dragView(kind: 'turn' | 'slide', dx: number, dy: number): void {
  if (!in3d()) {
    panBy(dx, dy)
    return
  }
  if (kind === 'turn') turnLook(-dx * turnPerPixel(), dy * turnPerPixel())
  else slideLook(dx, dy)
}

/** Zoom: on the map about the mouse; in 3D closer to or further from the spot the camera looks at. */
export function zoomViewAt(sx: number, sy: number, factor: number): void {
  if (!in3d()) zoomAt(sx, sy, factor)
  else zoomLook(factor)
}
