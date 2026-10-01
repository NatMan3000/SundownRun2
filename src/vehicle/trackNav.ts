// ============================================================
//  TRACK NAV - where a car goes when it is put back on the road
// ------------------------------------------------------------
//  Small helpers over the track runtime (src/track/types.ts) used
//  by the car sim and the camera bookmarks:
//
//    roadResetPose   R / auto reset: the nearest plain road point,
//                    facing the driving direction, lifted a metre
//    startPose       Shift+R / spawn: a start-grid slot
//    poseFromFrame   turn a road frame into a car position + rotation
//
//  Car axes (everywhere in src/vehicle): +Z forward, +Y up, +X is
//  the car's LEFT. So a car sitting on the road has
//  X = -right, Y = up, Z = tangent.
// ============================================================

import * as THREE from 'three'
import type { NearestHit, TrackFrame, TrackRuntime } from '../track/types'
import { SURFACE_CODE } from '../track/types'

const _m = new THREE.Matrix4()
const _left = new THREE.Vector3()
const _hit: NearestHit = { s: 0, index: 0, lateral: 0, height: 0, distance: 0, onRoad: false }
const _frame: TrackFrame = {
  s: 0,
  position: new THREE.Vector3(),
  tangent: new THREE.Vector3(),
  up: new THREE.Vector3(),
  right: new THREE.Vector3(),
  halfWidth: 7,
  bank: 0,
  curvature: 0,
  surface: 'road',
}

/** Height of the car's origin above the road when it sits at rest on its wheels. */
export const RIDE_HEIGHT = 0.55

/** Car rotation for a car sitting on a road frame. Writes `out`. */
export function quatFromFrame(tangent: THREE.Vector3, up: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
  // left = up x tangent (right-handed: tangent x up = right).
  _left.crossVectors(up, tangent).normalize()
  _m.makeBasis(_left, up, tangent)
  return out.setFromRotationMatrix(_m)
}

/**
 * Put a car back on the road near (x, y, z): the closest road sample that is
 * plain road (never upside down on a loop or halfway up a wall ride), facing
 * the driving direction, `lift` metres above the surface. Returns the s used.
 */
export function roadResetPose(
  track: TrackRuntime,
  x: number,
  y: number,
  z: number,
  hintS: number | undefined,
  lift: number,
  outPos: THREE.Vector3,
  outQuat: THREE.Quaternion,
): number {
  const ok = Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)
  let s = 0
  if (ok) {
    track.nearest(x, y, z, _hit, hintS)
    s = Number.isFinite(_hit.s) ? _hit.s : 0
  }
  // Walk back to plain road: resetting onto a loop or wall would drop the car.
  const smp = track.samples
  let i = Math.round(s / smp.ds) % smp.count
  if (i < 0) i += smp.count
  for (let n = 0; n < smp.count && smp.surface[i] !== SURFACE_CODE.road && smp.surface[i] !== SURFACE_CODE.ramp; n++) {
    i = (i - 1 + smp.count) % smp.count
  }
  // Ramps are road too, but a reset onto a kicker launches you: step back off it.
  for (let n = 0; n < 60 && smp.surface[i] === SURFACE_CODE.ramp; n++) i = (i - 1 + smp.count) % smp.count
  s = i * smp.ds
  track.frameAt(s, _frame)
  outPos.copy(_frame.position).addScaledVector(_frame.up, RIDE_HEIGHT + lift)
  quatFromFrame(_frame.tangent, _frame.up, outQuat)
  return s
}

/**
 * Start-grid slot i (0 = pole), ready to drop a car into. gridSlot() may hand
 * back a point on the road surface or one already at car height; either way
 * this returns the car's origin at ride height plus a small settle drop.
 */
export function startPose(track: TrackRuntime, slot: number, outPos: THREE.Vector3, outQuat: THREE.Quaternion): number {
  track.gridSlot(slot, outPos, outQuat)
  track.nearest(outPos.x, outPos.y, outPos.z, _hit)
  track.frameAt(_hit.s, _frame)
  const target = RIDE_HEIGHT + 0.15
  if (Number.isFinite(_hit.height) && _hit.height < target) outPos.addScaledVector(_frame.up, target - _hit.height)
  return _hit.s
}

/** Frame at s (wrapped). The returned object is shared: copy what you need. */
export function frameAt(track: TrackRuntime, s: number): TrackFrame {
  return track.frameAt(track.wrapS(s), _frame)
}
