// ============================================================
//  3D VIEW MATHS - where the editor's 3D camera sits
// ------------------------------------------------------------
//  The editor's 3D view (look3d.ts) is a camera on an invisible
//  stick: it looks at one spot on the ground (the "target") from
//  a direction (yaw: round the compass, pitch: how high up) and a
//  distance (how long the stick is). Dragging turns the stick,
//  the wheel makes it longer or shorter, right-drag slides the
//  spot along the ground. All of that is an `Orbit`.
//
//  The map is the same stick pointing straight down (pitch 90
//  degrees, north at the top of the screen), as long as it needs
//  to be for the ground to look the same size as on the map. So
//  going from the map to 3D is just easing one Orbit into another:
//  the camera tilts down out of the map and swoops in.
//
//  This file is plain maths with no game state, so the editor's
//  self-test (selfTest3d.ts) can check it with Bun.
// ============================================================

import * as THREE from 'three'

/** A camera on a stick: the spot it looks at, its direction, and the stick's length. */
export interface Orbit {
  /** The spot on the ground it looks at (world metres). */
  x: number
  y: number
  z: number
  /** Round the compass, radians. 0 = the camera is south of the spot, looking north (like the map). */
  yaw: number
  /** How high up, radians. 90 degrees = straight down, like the map. */
  pitch: number
  /** The stick's length, metres. */
  dist: number
}

/** A point in the world. */
export interface V3 {
  x: number
  y: number
  z: number
}

/** The ground height at x, z (the built track's terrain). */
export type GroundAt = (x: number, z: number) => number

const DEG = Math.PI / 180

/** The 3D view's settings. Change them here; everything else reads them. */
export const LOOK = {
  /** The 3D camera's field of view, degrees (top to bottom). Narrower than the game's 62, so hills don't look stretched. */
  fovDeg: 50,
  /** The angle the 3D view opens at: low enough to show hills, banks and bridges side-on. */
  openPitch: 28 * DEG,
  /** Never flatter than this (a camera lying on the ground sees nothing but the nearest hill). */
  minPitch: 5 * DEG,
  /** Never past straight down. */
  maxPitch: 89 * DEG,
  /** Closest the camera comes to the spot it looks at, metres. */
  minDist: 12,
  /** Furthest away, metres. */
  maxDist: 2400,
  /** The map's matching camera never goes further than this (enough for the most zoomed-out map on a 1600 px tall window). */
  maxMapDist: 7500,
  /** How much closer the 3D view starts than the map's camera (it swoops in as it tilts). */
  openCloser: 0.55,
  /** Seconds to tilt from the map into 3D, and back. */
  openSeconds: 0.75,
  closeSeconds: 0.6,
  /** The camera always stays this far above the ground, metres. */
  clearance: 3,
  /** The camera and the spot stay this far inside the world's edge, metres. */
  edgeMargin: 12,
  /** How quickly the camera catches up with your hand (per second): high = snappy, low = floaty. */
  follow: 14,
} as const

/** A fresh Orbit (looking straight down at the middle of the world). */
export function orbit(): Orbit {
  return { x: 0, y: 0, z: 0, yaw: 0, pitch: LOOK.maxPitch, dist: 500 }
}

export function copyOrbit(from: Orbit, to: Orbit): Orbit {
  to.x = from.x
  to.y = from.y
  to.z = from.z
  to.yaw = from.yaw
  to.pitch = from.pitch
  to.dist = from.dist
  return to
}

/**
 * How far from the ground a camera with the 3D view's lens must be, looking
 * straight down, for the ground to look the same size as on the map: the
 * map shows `screenH * mpp` metres top to bottom.
 */
export function mapDistance(screenH: number, mpp: number, fovDeg: number = LOOK.fovDeg): number {
  const metres = Math.max(1, screenH) * mpp
  return Math.min(LOOK.maxMapDist, metres / 2 / Math.tan((fovDeg * DEG) / 2))
}

/**
 * The map as an Orbit: looking straight down at the map's centre, north up.
 * `yawNear`: the 3D view's yaw, so the map's "north up" is reached the short
 * way round (after turning round twice you don't spin back twice).
 */
export function mapOrbit(cx: number, cz: number, groundY: number, screenH: number, mpp: number, yawNear: number, out: Orbit): Orbit {
  out.x = cx
  out.y = groundY
  out.z = cz
  out.yaw = Math.round(yawNear / (Math.PI * 2)) * Math.PI * 2
  out.pitch = Math.PI / 2
  out.dist = mapDistance(screenH, mpp)
  return out
}

/** The 3D view's first look: the same spot, from a low angle, a little closer, still facing north. */
export function openingOrbit(map: Orbit, out: Orbit): Orbit {
  copyOrbit(map, out)
  out.yaw = map.yaw
  out.pitch = LOOK.openPitch
  out.dist = clampDist(map.dist * LOOK.openCloser)
  return out
}

export function clampDist(d: number): number {
  return Math.min(LOOK.maxDist, Math.max(LOOK.minDist, d))
}

export function clampPitch(p: number): number {
  return Math.min(LOOK.maxPitch, Math.max(LOOK.minPitch, p))
}

/** Keep a spot inside the world square (half = half its side), `margin` metres in from the edge. */
export function clampToWorld(v: number, half: number, margin: number = LOOK.edgeMargin): number {
  const lim = Math.max(0, half - margin)
  return Math.min(lim, Math.max(-lim, v))
}

/** Smooth start and end for the tilt between the map and 3D (0..1 in, 0..1 out). */
export function ease(t: number): number {
  const x = Math.min(1, Math.max(0, t))
  return x * x * x * (x * (x * 6 - 15) + 10)
}

/**
 * Part way between two Orbits (t = 0 is `a`, 1 is `b`). The distance eases
 * in proportion (half way from 2000 m to 200 m is about 630 m, not 1100 m),
 * so the swoop feels even all the way down.
 */
export function blendOrbit(a: Orbit, b: Orbit, t: number, out: Orbit): Orbit {
  out.x = a.x + (b.x - a.x) * t
  out.y = a.y + (b.y - a.y) * t
  out.z = a.z + (b.z - a.z) * t
  out.yaw = a.yaw + (b.yaw - a.yaw) * t
  out.pitch = a.pitch + (b.pitch - a.pitch) * t
  out.dist = Math.exp(Math.log(a.dist) + (Math.log(b.dist) - Math.log(a.dist)) * t)
  return out
}

/** Move `cur` part of the way to `goal`, so the camera glides after your hand (k: 0 = stay, 1 = arrive). */
export function followOrbit(cur: Orbit, goal: Orbit, k: number): void {
  cur.x += (goal.x - cur.x) * k
  cur.y += (goal.y - cur.y) * k
  cur.z += (goal.z - cur.z) * k
  cur.yaw += (goal.yaw - cur.yaw) * k
  cur.pitch += (goal.pitch - cur.pitch) * k
  cur.dist = Math.exp(Math.log(cur.dist) + (Math.log(goal.dist) - Math.log(cur.dist)) * k)
}

/** Where the camera is on its stick, before any ground or edge rule. */
export function stickEnd(o: Orbit, out: V3): V3 {
  const flat = Math.cos(o.pitch) * o.dist
  out.x = o.x + Math.sin(o.yaw) * flat
  out.y = o.y + Math.sin(o.pitch) * o.dist
  out.z = o.z + Math.cos(o.yaw) * flat
  return out
}

/** How many spots along the line from the target to the camera are checked for hills in the way. */
const RAY_STEPS = 32
/** Spots this close to the target are not checked (the target itself sits on the ground). */
const RAY_FROM = 0.2

/**
 * Where the camera really goes: the end of its stick, then
 *   1. pulled in sideways to stay inside the world's edge, and
 *   2. lifted until the line from it to the target clears every hill on
 *      the way by `clearance` (it rises over a hill rather than looking
 *      into it, and is never under the ground).
 * Lifting (rather than pulling the camera in) changes smoothly as the
 * camera moves, so it never jumps. Returns `out`; every number in it is
 * finite whenever the Orbit's are.
 */
export function placeCamera(o: Orbit, ground: GroundAt, half: number, out: V3): V3 {
  stickEnd(o, out)
  out.x = clampToWorld(out.x, half)
  out.z = clampToWorld(out.z, half)
  let lift = 0
  for (let i = 0; i <= RAY_STEPS; i++) {
    const t = RAY_FROM + ((1 - RAY_FROM) * i) / RAY_STEPS
    const px = o.x + (out.x - o.x) * t
    const pz = o.z + (out.z - o.z) * t
    const py = o.y + (out.y - o.y) * t
    const need = ground(px, pz) + LOOK.clearance - py
    if (need > 0) lift = Math.max(lift, need / t)
  }
  out.y += lift
  return out
}

/**
 * Which way a camera at `pos` must face to look at `target`, as yaw and
 * pitch (the same angles as an Orbit). Straight down has no "which way",
 * so then it keeps `yawIfStraightDown` (north up for the map).
 */
export function aim(pos: V3, target: V3, yawIfStraightDown: number, out: { yaw: number; pitch: number }): { yaw: number; pitch: number } {
  const dx = target.x - pos.x
  const dy = target.y - pos.y
  const dz = target.z - pos.z
  const flat = Math.hypot(dx, dz)
  out.yaw = flat < 1e-6 * Math.max(1, Math.abs(dy)) ? yawIfStraightDown : Math.atan2(-dx, -dz)
  out.pitch = Math.atan2(-dy, flat)
  return out
}

/** True when every number in the Orbit is a real number (the NaN firewall for the camera). */
export function orbitOk(o: Orbit): boolean {
  return Number.isFinite(o.x) && Number.isFinite(o.y) && Number.isFinite(o.z) && Number.isFinite(o.yaw) && Number.isFinite(o.pitch) && Number.isFinite(o.dist) && o.dist > 0
}

/**
 * Right-drag in 3D: slide the spot along the ground the way your hand
 * moves, so the ground under the mouse follows it. `metresPerPixel` is how
 * much ground one pixel covers at the spot; looking along the ground it
 * covers more front to back (by 1 / sin(pitch)), capped so a flat view
 * doesn't fling the spot away.
 */
export function panOrbit(o: Orbit, dxPx: number, dyPx: number, metresPerPixel: number): void {
  const right = dxPx * metresPerPixel
  const ahead = (dyPx * metresPerPixel) / Math.max(0.35, Math.sin(o.pitch))
  // Screen right is (cos yaw, -sin yaw); straight ahead (away from the camera) is (-sin yaw, -cos yaw).
  o.x += -Math.cos(o.yaw) * right + -Math.sin(o.yaw) * ahead
  o.z += Math.sin(o.yaw) * right + -Math.cos(o.yaw) * ahead
}

/** How much ground one screen pixel covers at the spot the camera looks at (CSS pixels, screen `screenH` tall). */
export function metresPerPixelAt(o: Orbit, screenH: number): number {
  return (2 * o.dist * Math.tan((LOOK.fovDeg * DEG) / 2)) / Math.max(1, screenH)
}

// scratch (no allocation per frame)
const _euler = new THREE.Euler(0, 0, 0, 'YXZ')

/** Put a camera at `pos`, facing `facing` (yaw and pitch, as aim() gives them). */
export function poseCamera(c: THREE.Camera, pos: V3, facing: { yaw: number; pitch: number }): void {
  c.position.set(pos.x, pos.y, pos.z)
  // Tip down by the pitch first, then turn round by the yaw (three.js cameras look along -z).
  _euler.set(-facing.pitch, facing.yaw, 0, 'YXZ')
  c.quaternion.setFromEuler(_euler)
  c.updateMatrixWorld()
}

/**
 * The film offset that moves the middle of the picture `shiftPx` pixels to
 * the left on a screen `width` pixels wide. three.js slides the lens by
 * near x filmOffset / filmWidth at the near plane, where half the picture
 * is near x tan(fov / 2) x aspect wide.
 */
export function filmOffsetFor(shiftPx: number, width: number, aspect: number, filmGauge: number): number {
  const halfTan = Math.tan((LOOK.fovDeg * DEG) / 2) * aspect
  const filmWidth = filmGauge * Math.min(aspect, 1)
  const offset = ((2 * shiftPx) / Math.max(1, width)) * halfTan * filmWidth
  return Number.isFinite(offset) ? Math.round(offset * 1e4) / 1e4 : 0
}
