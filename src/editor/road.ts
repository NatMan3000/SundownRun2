// ============================================================
//  ROAD MATHS FOR EDITING - "where on the road is this?"
// ------------------------------------------------------------
//  The track file says where things are along the road with `at`:
//  a control-point index plus a fraction (at 3.5 = halfway from
//  point 3 to point 4). When Josh clicks on the map, the editor needs
//  the opposite: which `at` is nearest this spot, and how far right
//  or left of the centreline is it? This module answers that, using
//  the same smooth curve the game builds through the points.
//
//  It also keeps everything that uses `at` (pieces, the start line)
//  pointing at the same bit of road when points are inserted,
//  deleted or the road is redrawn. Pure functions, no game state.
// ============================================================

import type { Piece, RoadPoint } from '../track/schema'
import { type P, catmullRomClosed, dist } from './geom'

/** Curve samples per control-point segment: sample k sits at at = k / PER. */
export const PER = 12

export interface RoadCurve {
  points: readonly RoadPoint[]
  /** The smooth centreline, PER samples per segment. */
  curve: P[]
}

export function roadCurve(points: readonly RoadPoint[]): RoadCurve {
  return { points, curve: points.length >= 3 ? catmullRomClosed(points, PER) : [] }
}

/** at wrapped into [0, points.length). */
export function wrapAt(at: number, count: number): number {
  return ((at % count) + count) % count
}

/** Position, unit direction and unit right vector of the road at `at`. */
export function frameAt(rc: RoadCurve, at: number): { p: P; dir: P; right: P } {
  const n = rc.curve.length
  const f = wrapAt(at, rc.points.length) * PER
  const i = Math.floor(f) % n
  const t = f - Math.floor(f)
  const a = rc.curve[i]
  const b = rc.curve[(i + 1) % n]
  const p = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t }
  const dx = b.x - a.x
  const dz = b.z - a.z
  const len = Math.hypot(dx, dz) || 1
  const dir = { x: dx / len, z: dz / len }
  // Right of the driving direction (the track file's +offset side): tangent x up = (-dz, dx).
  return { p, dir, right: { x: -dir.z, z: dir.x } }
}

export interface RoadHit {
  at: number
  /** Metres right (+) or left (-) of the centreline. */
  lateral: number
  /** Straight-line distance from the query point to the centreline. */
  distance: number
  p: P
}

/** The nearest spot on the road to world point q. */
export function nearestOnRoad(rc: RoadCurve, q: P): RoadHit {
  const n = rc.curve.length
  let best: RoadHit = { at: 0, lateral: 0, distance: Infinity, p: rc.curve[0] ?? q }
  for (let i = 0; i < n; i++) {
    const a = rc.curve[i]
    const b = rc.curve[(i + 1) % n]
    const vx = b.x - a.x
    const vz = b.z - a.z
    const len2 = vx * vx + vz * vz || 1
    const t = Math.max(0, Math.min(1, ((q.x - a.x) * vx + (q.z - a.z) * vz) / len2))
    const px = a.x + vx * t
    const pz = a.z + vz * t
    const d = Math.hypot(q.x - px, q.z - pz)
    if (d < best.distance) {
      const len = Math.sqrt(len2)
      // Signed: positive when q is to the right of travel.
      const side = ((q.x - px) * -vz + (q.z - pz) * vx) / len
      best = { at: (i + t) / PER, lateral: side, distance: d, p: { x: px, z: pz } }
    }
  }
  return best
}

/** Distance along the road from at a to at b going forward (both in control-point units), in metres. */
export function metresBetween(rc: RoadCurve, a: number, b: number): number {
  const n = rc.curve.length
  const count = rc.points.length
  let fa = wrapAt(a, count) * PER
  const fbRaw = wrapAt(b, count) * PER
  const fb = fbRaw < fa ? fbRaw + n : fbRaw
  let m = 0
  while (fa < fb) {
    const i = Math.floor(fa) % n
    const step = Math.min(fb, Math.floor(fa) + 1) - fa
    const a1 = rc.curve[i]
    const b1 = rc.curve[(i + 1) % n]
    m += Math.hypot(b1.x - a1.x, b1.z - a1.z) * step
    fa += step
  }
  return m
}

/** Length of the whole road, metres (along the smooth curve). */
export function roadLength(rc: RoadCurve): number {
  let m = 0
  const n = rc.curve.length
  for (let i = 0; i < n; i++) m += Math.hypot(rc.curve[(i + 1) % n].x - rc.curve[i].x, rc.curve[(i + 1) % n].z - rc.curve[i].z)
  return m
}

/** The `at` that is `metres` further along the road from `at` (negative goes backwards). */
export function advanceAt(rc: RoadCurve, at: number, metres: number): number {
  const n = rc.curve.length
  let f = wrapAt(at, rc.points.length) * PER
  let left = metres < 0 ? roadLength(rc) + metres : metres
  for (let guard = 0; guard < n * 2 && left > 0; guard++) {
    const i = Math.floor(f) % n
    const a = rc.curve[i]
    const b = rc.curve[(i + 1) % n]
    const seg = Math.hypot(b.x - a.x, b.z - a.z)
    const remainFrac = Math.floor(f) + 1 - f
    const remain = seg * remainFrac
    if (remain >= left) {
      f += seg > 0 ? left / seg : 0
      left = 0
    } else {
      left -= remain
      f = Math.floor(f) + 1
    }
  }
  return wrapAt(f / PER, rc.points.length)
}

// ---------------------------------------------------------------- keeping `at` values pointed at the same road

/**
 * After the road changed shape (redrawn, smoothed, points moved), move each
 * `at` to the spot on the new road nearest where it was on the old road.
 */
export function reanchor(oldRc: RoadCurve, newRc: RoadCurve, at: number): number {
  const was = frameAt(oldRc, at).p
  return round3(nearestOnRoad(newRc, was).at)
}

/** Point `index` was inserted (the old segment index-1 -> index was split at fraction t). Remap an at. */
export function atAfterInsert(at: number, index: number, t: number): number {
  const k = index - 1
  if (at < k) return at
  if (at <= k + t) return round3(k + (t > 0 ? (at - k) / t : 0))
  if (at < k + 1) return round3(k + 1 + (at - k - t) / (1 - t))
  return at + 1
}

/**
 * Point `index` was deleted from a road that had `count` points. The two
 * segments either side of it merge into one; remap an at onto the new road.
 */
export function atAfterDelete(at: number, index: number, count: number): number {
  const prev = (index - 1 + count) % count
  const d = wrapAt(at - prev, count)
  const prevNew = index === 0 ? count - 2 : prev
  if (d < 2) return round3(wrapAt(prevNew + d / 2, count - 1))
  return round3(at > index ? at - 1 : at)
}

export function remapPieces(pieces: Piece[], fn: (at: number) => number): void {
  for (const p of pieces) p.at = fn(p.at)
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000
}

// ---------------------------------------------------------------- redrawing part of the road

/**
 * A pencil line that starts AND ends on the existing road (and is not a
 * whole loop) redraws just that stretch: the road between the two ends is
 * swapped for the new line. Returns the full new loop to clean up, or
 * null if this stroke is a whole new road.
 */
export function sectionRedraw(raw: readonly P[], points: readonly RoadPoint[], width: number): P[] | null {
  if (raw.length < 4 || points.length < 4) return null
  const rc = roadCurve(points)
  const first = raw[0]
  const last = raw[raw.length - 1]
  const attach = Math.max(25, width * 1.8)
  const a = nearestOnRoad(rc, first)
  const b = nearestOnRoad(rc, last)
  if (a.distance > attach || b.distance > attach) return null
  if (dist(first, last) < 60) return null // ends together: a whole new loop
  const forward = metresBetween(rc, a.at, b.at)
  const backward = metresBetween(rc, b.at, a.at)
  // Replace the shorter way round between the two ends.
  const keep = forward <= backward ? { from: b.at, to: a.at } : { from: a.at, to: b.at }
  const kept = sampleBetween(rc, keep.from, keep.to)
  const line = forward <= backward ? [...raw] : [...raw].reverse()
  return [...kept, ...line]
}

/** Curve samples from at `from` forward to at `to`. */
function sampleBetween(rc: RoadCurve, from: number, to: number): P[] {
  const n = rc.curve.length
  const count = rc.points.length
  const f0 = Math.ceil(wrapAt(from, count) * PER)
  let f1 = Math.floor(wrapAt(to, count) * PER)
  if (f1 < f0) f1 += n
  const out: P[] = []
  for (let f = f0; f <= f1; f++) out.push(rc.curve[f % n])
  return out
}

