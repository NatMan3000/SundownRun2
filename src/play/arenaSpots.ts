// ============================================================
//  ARENA SPOTS - where Hunt Turns puts everyone (play.arenaSpots)
// ------------------------------------------------------------
//  Hunt Turns starts every turn with the players spread round the
//  arena, not side by side on a grid, and throws a caught runner to
//  the spot farthest from the hunter. The spots are worked out here
//  from the track and its stunt park, never stored in the track file:
//
//    eight directions round the middle; along each, the first point
//    (about 70% of the way out, then nearer and further) that is on
//    open ground: clear of the road, the park's lanes, crash props
//    and energy cores, and well inside the world edge. Each faces
//    the middle.
//
//  A pure function of the track (and the megaRampHeight knob, which
//  shapes the park), so every computer gets the same list in the same
//  order. Nothing here uses Math.random.
// ============================================================

import type { ArenaSpot } from '../core/api'
import type { NearestHit, TrackRuntime } from '../track/types'
import type { ParkLayout } from './stunts/parkLayout'

/** Directions round the middle. */
const DIRECTIONS = 8
/** How far out to try along each direction, as a share of the open radius, best first. */
const RADII = [0.72, 0.64, 0.8, 0.56, 0.86, 0.48]
/** Turns either side of each direction to try, degrees, best first. */
const NUDGES = [0, 7, -7, 14, -14, 21, -21]
/** Clear ground needed round a spot: from the road's edge, a park lane, a prop or core (metres). */
const ROAD_CLEAR = 15
const PARK_CLEAR = 14
const PROP_CLEAR = 16
/** Keep this far in from a wall edge (metres). */
const WALL_CLEAR = 20

/** Cached per park layout (StuntPark keeps one per track file and megaRampHeight). */
const cache = new WeakMap<ParkLayout, readonly ArenaSpot[]>()

/** Distance from (x, z) to a park lane (a rectangle along its heading). */
function laneDistance(L: ParkLayout['zones'][number], x: number, z: number): number {
  const px = x - L.x
  const pz = z - L.z
  const a = px * L.dx + pz * L.dz
  const l = -px * L.dz + pz * L.dx
  const da = a < 0 ? -a : a > L.length ? a - L.length : 0
  const dl = Math.max(0, Math.abs(l) - L.halfWidth)
  return Math.hypot(da, dl)
}

/** The start spots for a track and its park layout (play/index.tsx installs this as play.arenaSpots). */
export function spotsFor(t: TrackRuntime, park: ParkLayout): readonly ArenaSpot[] {
  const hit = cache.get(park)
  if (hit) return hit
  // A walled road (a stadium like the Hyperdrome) fences everyone onto it: no open arena, no spots.
  if (park.enclosed) {
    cache.set(park, [])
    return cache.get(park)!
  }
  const walled = t.world.edge === 'wall'
  // The same open radius the park uses: inside the wall, or off a ridge's foothills.
  const open = walled ? t.world.playRadius - WALL_CLEAR : Math.min(t.world.half * 0.92, t.world.playRadius - 140)
  const roadHalf = (t.file.road.width ?? 14) / 2
  const near: NearestHit = { s: 0, index: 0, lateral: 0, height: 0, distance: 0, onRoad: false }
  const clear = (x: number, z: number): boolean => {
    const y = t.terrainHeight(x, z)
    if (!Number.isFinite(y)) return false
    t.nearest(x, y, z, near)
    if (near.distance < roadHalf + ROAD_CLEAR) return false
    for (const L of park.zones) if (laneDistance(L, x, z) < PARK_CLEAR) return false
    for (const it of park.items) if (Math.hypot(it.x - x, it.z - z) < PARK_CLEAR) return false
    for (const p of t.props) if (Math.hypot(p.x - x, p.z - z) < PROP_CLEAR) return false
    for (const c of t.cores) if (Math.hypot(c.x - x, c.z - z) < PROP_CLEAR) return false
    return true
  }
  const out: ArenaSpot[] = []
  for (let k = 0; k < DIRECTIONS; k++) {
    const base = ((k + 0.5) / DIRECTIONS) * Math.PI * 2
    let found: ArenaSpot | null = null
    for (const f of RADII) {
      for (const n of NUDGES) {
        const a = base + (n * Math.PI) / 180
        const r = open * f
        const x = Math.sin(a) * r
        const z = -Math.cos(a) * r
        if (!clear(x, z)) continue
        // Facing the middle: the car's nose is +z, so yaw = atan2(dx, dz) toward (0, 0).
        found = { x, y: t.terrainHeight(x, z), z, yaw: Math.atan2(-x, -z) }
        break
      }
      if (found) break
    }
    if (found) out.push(found)
  }
  cache.set(park, out)
  return out
}
