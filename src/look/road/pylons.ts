// ============================================================
//  PYLONS - where a raised road gets its supports
// ------------------------------------------------------------
//  A road held up in the air with nothing under it reads as a
//  floating slab, not a bridge. This works out where to stand
//  slim pylons under every raised stretch, straight from the track
//  runtime, so any track (drawn ones too) gets them for free.
//
//  The rules, walking the road every SPACING metres:
//    - only plain road (never under a loop, a wall ride or a ramp)
//    - only where the road is lifted off the ground: the runtime
//      says it is not grounded, or the slab's underside is still
//      well clear of the terrain (the ends of a bridge)
//    - a pair of pylons, one under each side of the deck, from the
//      ground up to the slab's underside, at least MIN_HEIGHT tall
//    - never where a pylon would stand on, or pass through, any
//      other part of the road (a bridge crossing over the track)
//
//  Pure maths, no three.js objects. BridgePylons.tsx draws them and
//  BridgePylonColliders.tsx makes them solid, both from trackPylons()
//  so what you see is exactly what you hit. The placement keeps them
//  off every road, so only a car that has left the road can meet one.
// ============================================================

import { SURFACE_CODE, type TrackRuntime } from '../../track/types'
import { SLAB_THICKNESS } from '../../track/road'
import { skirtExtras } from './skirtExtras'

/** One pylon: foot on the ground, top under the deck, turned to the road. */
export interface Pylon {
  x: number
  z: number
  /** Ground height at the foot. */
  footY: number
  /** Height of the slab's underside above the foot. */
  height: number
  /** Radians about +y, so the pylon's faces line up with the road. */
  heading: number
  /** Distance along the road of the deck it holds up. */
  s: number
  /** Which side of the deck: -1 left, +1 right (of the driving direction). */
  side: -1 | 1
}

/** Column cross-section, metres (square). The drawing and the collider both use it. */
export const PYLON_WIDTH = 0.55
/** How far each pylon continues into the ground, so it never floats on a slope. */
export const PYLON_BURY = 0.8

/** Metres between pylon pairs along the road. */
const SPACING = 24
/** A pylon shorter than this is not worth drawing (the deck is nearly on the ground). */
const MIN_HEIGHT = 2.5
/** Pylons sit this far in from each edge of the deck. */
const INSET = 1.4
/** Keep this far (metres, sideways) from any other stretch of road. */
const ROAD_CLEARANCE = 3
/** ...unless that stretch is this far along the road from the pylon (it is the same bridge). */
const SAME_BRIDGE = 40
/** Keep clear of loops, wall rides and ramps by this much along the road. */
const PIECE_MARGIN = 12


function inPiece(track: TrackRuntime, s: number): boolean {
  for (const p of track.pieces) {
    if (p.type !== 'loop' && p.type !== 'wallride' && p.type !== 'ramp') continue
    const a = track.deltaS(p.s0 - PIECE_MARGIN, s)
    const span = p.s1 - p.s0 + 2 * PIECE_MARGIN
    if (a >= 0 && a <= span) return true
  }
  return false
}

/** True if a column at (x, z) from footY to topY would touch any part of the road far (along the road) from s. */
function hitsOtherRoad(track: TrackRuntime, x: number, z: number, footY: number, topY: number, s: number): boolean {
  const S = track.samples
  for (let j = 0; j < S.count; j++) {
    const sj = j * S.ds
    if (Math.abs(track.deltaS(s, sj)) < SAME_BRIDGE) continue
    const y = S.py[j]
    if (y < footY - 2 || y > topY + 2) continue
    const dx = x - S.px[j]
    const dz = z - S.pz[j]
    // sideways distance from that sample's centreline, and along it
    const across = Math.abs(dx * S.rx[j] + dz * S.rz[j])
    const along = Math.abs(dx * S.tx[j] + dz * S.tz[j])
    if (along < S.ds * 1.5 && across < S.halfWidth[j] + ROAD_CLEARANCE) return true
  }
  return false
}

/**
 * Every pylon for this track. `thickness[i]` is the slab thickness at
 * sample i (skirtExtras.ts reads it off the mesh); null assumes the
 * lifted-road default.
 */
export function placePylons(track: TrackRuntime, thickness: Float32Array | null): Pylon[] {
  const S = track.samples
  const out: Pylon[] = []
  const step = Math.max(1, Math.round(SPACING / S.ds))
  for (let i = 0; i < S.count; i += step) {
    if (S.surface[i] !== SURFACE_CODE.road) continue
    const s = i * S.ds
    if (inPiece(track, s)) continue
    const t = thickness ? thickness[i] : SLAB_THICKNESS
    const hw = S.halfWidth[i]
    const lateral = Math.max(0.5, hw - INSET)
    // under the deck's middle: is the road lifted here at all?
    const midUnderY = S.py[i] - S.uy[i] * t
    const midClear = midUnderY - track.terrainHeight(S.px[i], S.pz[i])
    if (S.grounded[i] && midClear < MIN_HEIGHT) continue
    const heading = Math.atan2(S.tx[i], S.tz[i])
    for (const side of [-1, 1] as const) {
      const l = side * lateral
      const x = S.px[i] + S.rx[i] * l - S.ux[i] * t
      const topY = S.py[i] + S.ry[i] * l - S.uy[i] * t
      const z = S.pz[i] + S.rz[i] * l - S.uz[i] * t
      const footY = track.terrainHeight(x, z)
      const height = topY - footY
      if (!Number.isFinite(height) || height < MIN_HEIGHT) continue
      if (hitsOtherRoad(track, x, z, footY, topY, s)) continue
      out.push({ x, z, footY, height, heading, s, side })
    }
  }
  return out
}

const cache = new WeakMap<TrackRuntime, readonly Pylon[]>()

/** The pylons for this runtime, worked out once and shared by the drawing and the colliders. */
export function trackPylons(track: TrackRuntime): readonly Pylon[] {
  let p = cache.get(track)
  if (!p) {
    p = placePylons(track, skirtExtras(track).thickness)
    cache.set(track, p)
  }
  return p
}
