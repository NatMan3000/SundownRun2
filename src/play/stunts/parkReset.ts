// ============================================================
//  PARK RESETS AND HOPS - the stunt park on a walled track
// ------------------------------------------------------------
//  On a stadium track (barriers along both edges of the road, like
//  the Hyperdrome) the park sits in the infield, where no car can
//  drive to. So (Kai's ruling, 2026-10-02):
//
//    Stunt Attack   starts in the park, at the start of its first
//                   zone's run-in (the mega ramp)
//    R              inside the park: back to the nearest zone's
//                   run-in start (the road is behind a barrier)
//    Shift+R        in Stunt Attack: back to the park's start
//    pause menu     Free Roam starts on the road as usual; the pause
//                   menu offers "Stunt park" to hop in and "Back to
//                   the track" to hop out (core/api.ts play.parkHop)
//
//  On an open track none of this applies: the park is beside the
//  road and every reset works as normal.
// ============================================================

import * as THREE from 'three'
import { getGame } from '../../core/store'
import { getCar } from '../../core/telemetry'
import { getTrack } from '../../track/current'
import type { TrackFrame, TrackRuntime } from '../../track/types'
import { resetPoseHook } from '../../vehicle/trackNav'
import { parkLive } from './parkLive'

/** The car's middle sits this far above the ground when it is put down. */
const LIFT = 0.65
/** A car this far beyond the road's edge (and inside the infield) is "in the park". */
const PARK_MARGIN = 3

const _up = new THREE.Vector3(0, 1, 0)
const _fwd = new THREE.Vector3()
const _left = new THREE.Vector3()
const _basis = new THREE.Matrix4()
const _pos = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _hit = { s: 0, index: 0, lateral: 0, height: 0, distance: 0, onRoad: false }
const _frame: TrackFrame = {
  s: 0,
  position: new THREE.Vector3(),
  tangent: new THREE.Vector3(),
  up: new THREE.Vector3(),
  right: new THREE.Vector3(),
  halfWidth: 0,
  bank: 0,
  curvature: 0,
  surface: 'road',
}

/** A pose standing on the ground at (x, z), facing (dx, dz). */
function groundPose(t: TrackRuntime, x: number, z: number, dx: number, dz: number, outPos: THREE.Vector3, outQuat: THREE.Quaternion): void {
  outPos.set(x, t.terrainHeight(x, z) + LIFT, z)
  _fwd.set(dx, 0, dz).normalize()
  _left.crossVectors(_up, _fwd).normalize()
  _basis.makeBasis(_left, _up, _fwd)
  outQuat.setFromRotationMatrix(_basis)
}

/** Is the park enclosed (a walled road) and in the world right now? */
function enclosedPark(): boolean {
  return !!parkLive.layout?.enclosed
}

/** Is (x, y, z) in the park: off the road (beyond its edge) and inside the infield? */
export function inPark(t: TrackRuntime, x: number, y: number, z: number): boolean {
  t.nearest(x, y, z, _hit)
  const hw = t.samples.halfWidth[_hit.index] ?? 7
  if (Math.abs(_hit.lateral) < hw + PARK_MARGIN) return false
  // Inside the infield: the road's right is the outside on a lap that runs anticlockwise, so use
  // the even-odd test on the minimap path rather than the side of the road.
  const p = t.minimap.path
  const n = p.length / 2
  let inside = false
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = p[i * 2]
    const zi = p[i * 2 + 1]
    const xj = p[j * 2]
    const zj = p[j * 2 + 1]
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside
  }
  return inside
}

/** The park's start: the first zone's run-in (zone 0, the mega ramp). */
export function parkStartPose(outPos: THREE.Vector3, outQuat: THREE.Quaternion): boolean {
  const t = getTrack()
  const z = parkLive.layout?.zones[0]
  if (!t || !z || !enclosedPark()) return false
  groundPose(t, z.x, z.z, z.dx, z.dz, outPos, outQuat)
  return true
}

/** The nearest zone's run-in start to (x, z). */
function nearestSpot(t: TrackRuntime, x: number, z: number, outPos: THREE.Vector3, outQuat: THREE.Quaternion): boolean {
  const L = parkLive.layout
  if (!L || L.zones.length === 0) return false
  let best = L.zones[0]
  let bestD = Infinity
  for (const zn of L.zones) {
    const d = (zn.x - x) ** 2 + (zn.z - z) ** 2
    if (d < bestD) {
      bestD = d
      best = zn
    }
  }
  groundPose(t, best.x, best.z, best.dx, best.dz, outPos, outQuat)
  return true
}

/** The vehicle's reset hook (trackNav.ts resetPoseHook): only on a walled track's park. */
function resetHook(kind: 'road' | 'start' | 'auto', x: number, y: number, z: number, outPos: THREE.Vector3, outQuat: THREE.Quaternion): boolean {
  const t = getTrack()
  if (!t || !enclosedPark()) return false
  if (kind === 'start') return getGame().mode === 'stunt' ? parkStartPose(outPos, outQuat) : false
  if (!inPark(t, x, y, z)) return false
  return nearestSpot(t, x, z, outPos, outQuat)
}

/** Install the reset hook while a park is in the world. Returns the uninstall. */
export function installParkResets(): () => void {
  resetPoseHook.fn = resetHook
  return () => {
    if (resetPoseHook.fn === resetHook) resetPoseHook.fn = null
  }
}

/** Where the pause menu's hop goes right now (core/api.ts play.parkHop). */
export function parkHop(): 'park' | 'track' | null {
  const t = getTrack()
  const car = getCar('player')
  if (!t || !car || !enclosedPark()) return null
  const p = car.position
  return inPark(t, p.x, p.y, p.z) ? 'track' : 'park'
}

/** Do the hop: into the park's start, or back onto the road beside the park. */
export function doParkHop(): void {
  const t = getTrack()
  const car = getCar('player')
  const hop = parkHop()
  if (!t || !car?.api || !hop) return
  if (hop === 'park') {
    if (parkStartPose(_pos, _quat)) car.api.teleport(_pos, _quat)
    return
  }
  // Back to the track: the nearest plain road, facing the way the lap runs.
  const p = car.position
  t.nearest(p.x, p.y, p.z, _hit)
  t.frameAt(_hit.s, _frame)
  _pos.copy(_frame.position).addScaledVector(_frame.up, LIFT)
  _fwd.copy(_frame.tangent)
  _left.crossVectors(_frame.up, _fwd).normalize()
  _basis.makeBasis(_left, _frame.up, _fwd)
  _quat.setFromRotationMatrix(_basis)
  car.api.teleport(_pos, _quat)
}
