// ============================================================
//  POSE BUFFERS - where other players' cars are, 60 times a second
// ------------------------------------------------------------
//  Each remote player gets a PoseBuffer: a ring of their last 32
//  pose packets, each stamped with OUR clock at the moment it
//  arrived. Their car is drawn INTERP_MS in the past, smoothly
//  interpolated between the two packets either side of that moment.
//
//  Why in the past? Packets arrive a little unevenly (wifi). If we
//  drew the newest packet, the car would stutter whenever one ran
//  late. 80 ms behind, there is almost always a packet on each side
//  to blend between. 80 ms is small enough that a ram still lands
//  where you aimed it.
//
//  Why our clock? Two computers' clocks never agree, so packets carry
//  no time at all; on a LAN, arrival time is honest enough.
//
//  No React and no allocation in here: this runs every frame.
// ============================================================

import * as THREE from 'three'
import { POSE, POSE_FLOATS } from './protocol'

/** How far behind live remote cars are drawn, ms. */
export const INTERP_MS = 80
/** No packet for this long: their tab is hidden or their wifi dropped. Fade the car out. */
export const STALE_MS = 1500

const RING = 32

/**
 * Two packets this far apart can't be driving (6 m in one packet gap is over
 * 1000 km/h): it's a teleport (R, a race grid, a reset). Never blend across
 * one, or the car would sweep through everything in between.
 */
export const JUMP_M = 6
const JUMP2 = JUMP_M * JUMP_M

const _qa = new THREE.Quaternion()
const _qb = new THREE.Quaternion()

export class PoseBuffer {
  private times = new Float64Array(RING)
  private data = new Float32Array(RING * POSE_FLOATS)
  private count = 0
  /** Index of the NEWEST sample. */
  private head = -1
  /** Packets received in total (the inspector shows a rate from it). */
  received = 0

  push(tRecv: number, pose: Float32Array, offset = 0): void {
    this.head = (this.head + 1) % RING
    if (this.count < RING) this.count++
    this.times[this.head] = tRecv
    for (let i = 0; i < POSE_FLOATS; i++) this.data[this.head * POSE_FLOATS + i] = pose[offset + i]
    this.received++
  }

  clear(): void {
    this.count = 0
    this.head = -1
  }

  /** performance.now() when the newest packet arrived (0 = none yet). */
  get lastRecv(): number {
    return this.count === 0 ? 0 : this.times[this.head]
  }

  /** A field of the newest packet (speed, boost, slip, flags). */
  latest(field: number): number {
    return this.count === 0 ? 0 : this.data[this.head * POSE_FLOATS + field]
  }

  /** Interpolated speed, boost and slip land here after sample(). */
  speedKmh = 0
  boost = 0
  slip = 0
  flags = 0

  /**
   * The pose at time `t` (our clock). Walks back from the newest packet to
   * find the pair either side (at most 32 steps). Before the oldest: the
   * oldest. After the newest: the newest, held still. No guessing ahead: a
   * car that stops is better than a car that sails through a wall on a guess.
   */
  sample(t: number, outPos: THREE.Vector3, outQuat: THREE.Quaternion): boolean {
    if (this.count === 0) return false

    let newer = this.head
    let older = this.head
    for (let step = 0; step < this.count - 1; step++) {
      const prev = (newer - 1 + RING) % RING
      if (this.times[newer] <= t) break
      older = prev
      if (this.times[prev] <= t) break
      newer = prev
    }

    if (older === newer || this.times[newer] <= t) {
      // Off one end of the buffer: hold that end.
      const i = (this.times[newer] <= t ? newer : older) * POSE_FLOATS
      outPos.set(this.data[i + POSE.px], this.data[i + POSE.py], this.data[i + POSE.pz])
      outQuat.set(this.data[i + POSE.qx], this.data[i + POSE.qy], this.data[i + POSE.qz], this.data[i + POSE.qw])
      this.speedKmh = this.data[i + POSE.speedKmh]
      this.boost = this.data[i + POSE.boost]
      this.slip = this.data[i + POSE.slip]
      this.flags = this.data[i + POSE.flags] | 0
      return true
    }

    const iO = older * POSE_FLOATS
    const iN = newer * POSE_FLOATS
    const t0 = this.times[older]
    const t1 = this.times[newer]
    const d = this.data
    let a = t1 > t0 ? Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : 1
    // A teleport between these two packets: jump, don't glide (see JUMP_M).
    const jx = d[iN + POSE.px] - d[iO + POSE.px]
    const jy = d[iN + POSE.py] - d[iO + POSE.py]
    const jz = d[iN + POSE.pz] - d[iO + POSE.pz]
    if (jx * jx + jy * jy + jz * jz > JUMP2) a = a < 0.5 ? 0 : 1
    outPos.set(
      d[iO + POSE.px] + (d[iN + POSE.px] - d[iO + POSE.px]) * a,
      d[iO + POSE.py] + (d[iN + POSE.py] - d[iO + POSE.py]) * a,
      d[iO + POSE.pz] + (d[iN + POSE.pz] - d[iO + POSE.pz]) * a,
    )
    _qa.set(d[iO + POSE.qx], d[iO + POSE.qy], d[iO + POSE.qz], d[iO + POSE.qw])
    _qb.set(d[iN + POSE.qx], d[iN + POSE.qy], d[iN + POSE.qz], d[iN + POSE.qw])
    outQuat.slerpQuaternions(_qa, _qb, a)
    this.speedKmh = d[iO + POSE.speedKmh] + (d[iN + POSE.speedKmh] - d[iO + POSE.speedKmh]) * a
    this.boost = d[iO + POSE.boost] + (d[iN + POSE.boost] - d[iO + POSE.boost]) * a
    this.slip = d[iO + POSE.slip] + (d[iN + POSE.slip] - d[iO + POSE.slip]) * a
    this.flags = d[a < 0.5 ? iO + POSE.flags : iN + POSE.flags] | 0
    return true
  }
}

/** Every remote player's buffer, by relay id. RemoteCar reads this, never the store. */
export const peerPoses = new Map<number, PoseBuffer>()

export function poseBufferFor(id: number): PoseBuffer {
  let b = peerPoses.get(id)
  if (!b) {
    b = new PoseBuffer()
    peerPoses.set(id, b)
  }
  return b
}
