// ============================================================
//  ROAD SHAPING - the maths behind the road-shaping tools
// ------------------------------------------------------------
//  The pencil makes a whole new road. These tools change the road
//  you already have, a bit at a time, and always hand back a road a
//  car can drive: no corner tighter than the clean-up's minimum
//  radius, inside the world, pieces and settings still attached.
//
//    Smooth    irons wobbles and kinks out of the whole road. Every
//              point, piece and setting stays; the points just slide
//              onto a smoother line. Press it again for smoother still.
//    Bend      grab the road and pull: the road near your hand comes
//              with it, less and less further away (a soft "falloff"),
//              so a corner can be moved, widened or tightened in one drag.
//    Straight  pick two spots on the road and the road between them
//              becomes a dead straight line, eased in at both ends.
//    Curve     pick two spots, then pull the middle out: the road
//              between becomes one smooth curve through where you
//              pulled, joining the road at both ends without a kink.
//    Corner    make one corner gentler (a bigger radius) or tighter.
//    Steady    the pencil's "lazy mouse": the line trails behind the
//              pointer on a short string, so hand wobble never reaches it.
//
//  How a stretch of road is swapped (spliceRoad): the road is measured
//  in metres along it (s). A tool makes a new centreline for a window
//  of road, from s0 to s1. The control points inside the window are
//  replaced by new ones 16 m apart along the new line, and every `at`
//  (pieces, the start line) moves to the same place on the new road.
//  Points outside the window are not touched at all. Every new point
//  gets the old road's height at its spot, worked out exactly the way
//  the game builds it (newPointHeight), so no tool lifts or sinks the
//  road by adding points.
//
//  Pure maths, no React or game state: points in, points out.
//  selfTest.ts checks every tool (bun src/editor/selfTest.ts).
// ============================================================

import type { RoadPoint } from '../track/schema'
import { CLEANUP, type WorldLimit, findCrossings, relaxLoop, worldLimit } from './cleanup'
import { type P, catmullRomAt, circumradius, dist, gaussianSmoothClosed, resample, turnAngle } from './geom'
import { type RoadCurve, PER, roadCurve, wrapAt } from './road'

/** What the shaping tools need to know about the draft's world. */
export interface ShapeWorld {
  /** Road width, metres. */
  width: number
  /** How far the road may reach from the centre along x or z (roadBound() in draftFile.ts), metres. */
  bound: number
  /** The world's reachable radius, metres (Infinity when unknown). */
  playRadius: number
  /**
   * The ground a road point with no `y` sits on, worked out exactly the way the
   * game does it (the natural ground averaged over about 12 m: averagedHeight in
   * src/track/terrain.ts). With it, every point a tool adds keeps the road at
   * exactly the height it had (see newPointHeight). Without it (the self-test's
   * flat-world maths) new points simply sit on the ground.
   */
  pointGround?: (x: number, z: number) => number
}

/** Where settingsAt gets heights from: the part of ShapeWorld about the ground. */
export type HeightSource = Pick<ShapeWorld, 'pointGround'>

/** No corner tighter than this, metres (the clean-up's and the track validator's minimum). */
export const MIN_RADIUS = CLEANUP.minRadius

/** What a shaping tool hands back. */
export interface ShapeResult {
  ok: boolean
  points: RoadPoint[]
  /** Moves an `at` on the old road (a piece, the start line) to the same place on the new road. */
  mapAt: (at: number) => number
  /** The tightest corner in the changed stretch, metres (on the curve the game builds). */
  tightest: number
  /** Where that tightest corner is. */
  tightAt: P | null
  /** The new road's centreline along the changed stretch (the editor draws it as a preview). */
  preview: P[]
  /** Why it can't be done, in plain words (only when ok is false). */
  reason?: string
  /** Things worth telling Josh about the result (one short sentence each). */
  notes: string[]
}

// ---------------------------------------------------------------- the road, measured in metres

/** The road's smooth curve with the distance along it at every sample, so we can work in metres. */
export interface RoadLine {
  points: readonly RoadPoint[]
  rc: RoadCurve
  /** Metres from point 0 to every sample of rc.curve; cum[curve.length] is the whole lap. */
  cum: Float64Array
  length: number
}

export function roadLine(points: readonly RoadPoint[]): RoadLine {
  const rc = roadCurve(points)
  const n = rc.curve.length
  const cum = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + dist(rc.curve[i], rc.curve[(i + 1) % n])
  return { points, rc, cum, length: cum[n] }
}

/** s wrapped into one lap, [0, length). */
export function wrapS(s: number, length: number): number {
  return ((s % length) + length) % length
}

/** Metres from point 0 forward to `at`. */
export function sOf(line: RoadLine, at: number): number {
  const f = wrapAt(at, line.points.length) * PER
  const i = Math.min(Math.floor(f), line.cum.length - 2)
  return line.cum[i] + (f - i) * (line.cum[i + 1] - line.cum[i])
}

/** Metres from point 0 to control point k. */
export function sOfPoint(line: RoadLine, k: number): number {
  return line.cum[(((k % line.points.length) + line.points.length) % line.points.length) * PER]
}

/** The `at` that is s metres along from point 0 (any s: it wraps round the lap). */
export function atOf(line: RoadLine, s: number): number {
  const ss = wrapS(s, line.length)
  let lo = 0
  let hi = line.cum.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (line.cum[mid] <= ss) lo = mid
    else hi = mid
  }
  const seg = line.cum[lo + 1] - line.cum[lo]
  const t = seg > 0 ? (ss - line.cum[lo]) / seg : 0
  return wrapAt((lo + t) / PER, line.points.length)
}

/** The road's centre s metres along (exactly on the curve the game builds). */
export function posOf(line: RoadLine, s: number): P {
  return catmullRomAt(line.points, atOf(line, s))
}

/** Which way the road runs s metres along (a unit vector). */
export function dirOf(line: RoadLine, s: number): P {
  const a = posOf(line, s - 1.5)
  const b = posOf(line, s + 1.5)
  const d = dist(a, b) || 1
  return { x: (b.x - a.x) / d, z: (b.z - a.z) / d }
}

/** The road from s0 forward to s1 (s1 >= s0), a point every `step` metres or less, both ends included. */
export function stretchOf(line: RoadLine, s0: number, s1: number, step = 2): P[] {
  const count = Math.max(1, Math.ceil((s1 - s0) / step))
  const out: P[] = []
  for (let i = 0; i <= count; i++) out.push(posOf(line, s0 + ((s1 - s0) * i) / count))
  return out
}

/** Shortest distance along the road between two spots, metres (either way round). */
export function alongRoad(a: number, b: number, length: number): number {
  const d = wrapS(b - a, length)
  return Math.min(d, length - d)
}

/**
 * The tightest corner from s0 to s1, measured like the track validator does:
 * the circle through three spots 6 m apart, every metre.
 */
export function tightestBetween(line: RoadLine, s0: number, s1: number): { radius: number; at: P | null; s: number } {
  let radius = Infinity
  let at: P | null = null
  let where = s0
  for (let s = s0; s <= s1; s += 1) {
    const r = circumradius(posOf(line, s - 6), posOf(line, s), posOf(line, s + 6))
    if (r < radius) {
      radius = r
      at = posOf(line, s)
      where = s
    }
  }
  return { radius, at, s: where }
}

/**
 * The smallest gap between two neighbouring road points, metres. The track
 * file needs at least 2 m (a tool that squeezed points closer would make a
 * track the game refuses to build).
 */
export function closestPoints(points: readonly RoadPoint[]): number {
  let m = Infinity
  for (let i = 0; i < points.length; i++) m = Math.min(m, dist(points[i], points[(i + 1) % points.length]))
  return m
}

/** The tightest corner anywhere on the road. */
export function tightestOnRoad(points: readonly RoadPoint[]): { radius: number; at: P | null } {
  const line = roadLine(points)
  return tightestBetween(line, 0, line.length)
}

/**
 * The road's bend (1 / radius, + one way, - the other) every `step` metres
 * from s0 to s1, measured like the track builder does: the change of
 * direction over 8 m.
 */
export function bendProfile(line: RoadLine, s0: number, s1: number, step = 1): number[] {
  const heading = (s: number) => {
    const a = posOf(line, s - step)
    const b = posOf(line, s + step)
    return Math.atan2(b.z - a.z, b.x - a.x)
  }
  const out: number[] = []
  for (let s = s0; s <= s1 + 1e-9; s += step) {
    let d = heading(s + 4) - heading(s - 4)
    if (d > Math.PI) d -= Math.PI * 2
    if (d < -Math.PI) d += Math.PI * 2
    out.push(d / 8)
  }
  return out
}

/**
 * How wobbly a road is: how much its bend changes from one metre to the next,
 * added up round the lap and divided by its length (x 1,000,000, so the
 * numbers are easy to read). The bend is measured the way the track builder
 * measures it (the change of direction over 8 m, then averaged over about
 * 10 m), so this agrees with the road the game builds. A clean drawn road
 * scores under 200; a wobbly drive-to-draw road 400 or more.
 */
export function roadRoughness(points: readonly RoadPoint[]): number {
  const line = roadLine(points)
  const n = Math.max(32, Math.round(line.length))
  const h = line.length / n
  const pts: P[] = []
  for (let i = 0; i < n; i++) pts.push(posOf(line, i * h))
  const at = (i: number) => pts[((i % n) + n) % n]
  const heading = (i: number) => Math.atan2(at(i + 1).z - at(i - 1).z, at(i + 1).x - at(i - 1).x)
  let k = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let d = heading(i + 4) - heading(i - 4)
    if (d > Math.PI) d -= Math.PI * 2
    if (d < -Math.PI) d += Math.PI * 2
    k[i] = d / (8 * h)
  }
  const r = Math.max(1, Math.round(5 / h))
  for (let pass = 0; pass < 2; pass++) {
    const next = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      let sum = 0
      for (let j = -r; j <= r; j++) sum += k[(((i + j) % n) + n) % n]
      next[i] = sum / (2 * r + 1)
    }
    k = next
  }
  let rough = 0
  for (let i = 0; i < n; i++) rough += Math.abs(k[(i + 1) % n] - k[i])
  return (rough / (n * h)) * 1e6
}

// ---------------------------------------------------------------- settings carried onto new points

function round1(v: number): number {
  return Math.round(v * 10) / 10
}

/**
 * New road point positions are kept to the millimetre. (The clean-up keeps
 * 10 cm, but even 1 cm of jitter on points 10 m apart bends a Straight to a
 * 4 km radius; to the millimetre it is dead straight.)
 */
function roundMm(v: number): number {
  return Math.round(v * 1000) / 1000
}

/** A smooth (Catmull-Rom) blend through four values, t of the way from v1 to v2: the same family of curve the road itself is. */
function smoothBlend(v0: number, v1: number, v2: number, v3: number, t: number): number {
  return 0.5 * (2 * v1 + (v2 - v0) * t + (2 * v0 - 5 * v1 + 4 * v2 - v3) * t * t + (3 * v1 - v0 - 3 * v2 + v3) * t * t * t)
}

// ---------------------------------------------------------------- road height, exactly as the game builds it

/** The ground under a road point with no `y` (see ShapeWorld.pointGround). */
type PointGround = (x: number, z: number) => number

/** Heights to the centimetre: closer than anyone can see, and short in the saved file. */
function roundCm(v: number): number {
  return Math.round(v * 100) / 100
}

/** How high the game builds a road point: its own `y`, or the ground under it plus its `lift` (src/track/road.ts, step 1). */
export function pointHeight(p: RoadPoint, ground: PointGround): number {
  return typeof p.y === 'number' ? p.y : ground(p.x, p.z) + (p.lift ?? 0)
}

/** Every point's height, worked out once per road (a Bend asks on every mouse move, for the same road). */
const heightMemo = new WeakMap<readonly RoadPoint[], { ground: PointGround; h: Float64Array }>()

function pointHeights(points: readonly RoadPoint[], ground: PointGround): Float64Array {
  const memo = heightMemo.get(points)
  if (memo && memo.ground === ground) return memo.h
  const h = Float64Array.from(points, (p) => pointHeight(p, ground))
  heightMemo.set(points, { ground, h })
  return h
}

/**
 * The road's surface height at `at`, exactly as the game builds it. The game
 * runs one smooth curve (centripetal Catmull-Rom, src/track/spline.ts) through
 * the points in 3D, so the height between two points depends on the points
 * either side AND on how far apart they all are, height included. This is the
 * same sum (the Barry-Goldman "pyramid" of in-betweens), for one spot.
 */
export function roadHeightAt(points: readonly RoadPoint[], at: number, ground: PointGround): number {
  const n = points.length
  const h = pointHeights(points, ground)
  const a = wrapAt(at, n)
  const i = Math.floor(a) % n
  const u = a - Math.floor(a)
  const k = [(i - 1 + n) % n, i, (i + 1) % n, (i + 2) % n]
  const y = k.map((j) => h[j])
  // Knot spacing: the square root of the 3D distance between neighbours (the game's ALPHA = 0.5).
  const knot = (j0: number, j1: number) =>
    Math.max(1e-4, Math.sqrt(Math.hypot(points[k[j1]].x - points[k[j0]].x, y[j1] - y[j0], points[k[j1]].z - points[k[j0]].z)))
  const t0 = 0
  const t1 = t0 + knot(0, 1)
  const t2 = t1 + knot(1, 2)
  const t3 = t2 + knot(2, 3)
  const t = t1 + (t2 - t1) * u
  const mix = (va: number, vb: number, ta: number, tb: number) => va + ((vb - va) * (t - ta)) / (tb - ta)
  const a1 = mix(y[0], y[1], t0, t1)
  const a2 = mix(y[1], y[2], t1, t2)
  const a3 = mix(y[2], y[3], t2, t3)
  return mix(mix(a1, a2, t0, t2), mix(a2, a3, t1, t3), t1, t2)
}

/**
 * The height for a new road point a tool adds at `at` on the road (sitting at
 * `spot` on the map): exactly the height the road has there now, so adding
 * points never lifts or sinks the road. (Built-in tracks have points up to
 * 200 m apart; a new point that just sat on its own bit of ground moved the
 * road by up to 7 m on Afterglow, into a ramp.)
 *  - Where the nearer of the two points either side has a set height (`y`),
 *    the stretch's height was set by hand: the new point gets a `y` too.
 *  - Where it sits on the ground, the new point gets its height above the
 *    ground under it (`lift`, a little below zero where the road dips between
 *    far-apart points), so it keeps riding the ground like its neighbours if
 *    the road is moved later.
 */
export function newPointHeight(points: readonly RoadPoint[], at: number, spot: P, ground: PointGround): Pick<RoadPoint, 'y' | 'lift'> {
  const n = points.length
  const a = wrapAt(at, n)
  const k = Math.floor(a) % n
  const near = a - Math.floor(a) < 0.5 ? points[k] : points[(k + 1) % n]
  const y = roadHeightAt(points, a, ground)
  if (!Number.isFinite(y)) return {}
  if (near.y === undefined) {
    const lift = roundCm(y - ground(spot.x, spot.z))
    // The track format takes a lift from -30 to 200 m; past that (never on a real world) a set height does it.
    if (lift >= -30 && lift <= 200) return lift === 0 ? {} : { lift }
  }
  return { y: roundCm(y) }
}

/**
 * A road point's own settings (height, lift, bank, width) at s metres along
 * the old road, from the points either side. `spot` is where the new point
 * will sit on the map (on the old road unless a tool reshaped it).
 *  - Height: with `pointGround`, exactly the old road's height there (see
 *    newPointHeight). Without it, the old road's set heights blend along the
 *    same smooth curve the game runs, and points with none sit on the ground.
 *  - Bank and width blend between the two neighbours; a setting only one of
 *    them has comes from the nearer, so a banked or widened stretch keeps its length.
 */
export function settingsAt(line: RoadLine, s: number, heights: HeightSource = {}, spot?: P): Omit<RoadPoint, 'x' | 'z'> {
  const pts = line.points
  const n = pts.length
  const at = atOf(line, s)
  const k = Math.floor(at) % n
  const t = at - Math.floor(at)
  const q = [pts[(k - 1 + n) % n], pts[k], pts[(k + 1) % n], pts[(k + 2) % n]]
  const [, a, b] = q
  const out: Omit<RoadPoint, 'x' | 'z'> = {}
  const ground = heights.pointGround
  if (ground) {
    Object.assign(out, newPointHeight(pts, at, spot ?? posOf(line, s), ground))
  } else if (a.y !== undefined || b.y !== undefined) {
    let y: number | undefined
    if (a.y !== undefined && b.y !== undefined) {
      const ay = a.y
      const by = b.y
      y = smoothBlend(q[0].y ?? ay, ay, by, q[3].y ?? by, t)
    } else y = t < 0.5 ? a.y : b.y
    if (y !== undefined && Number.isFinite(y)) out.y = round1(y)
  } else {
    const lift = Math.max(0, smoothBlend(q[0].lift ?? 0, a.lift ?? 0, b.lift ?? 0, q[3].lift ?? 0, t))
    if (lift > 0.05) out.lift = round1(lift)
  }
  const blend = (va: number | undefined, vb: number | undefined): number | undefined => {
    if (va !== undefined && vb !== undefined) return va * (1 - t) + vb * t
    return t < 0.5 ? va : vb
  }
  const bank = blend(a.bank, b.bank)
  if (bank !== undefined) out.bank = round1(bank)
  const width = blend(a.width, b.width)
  if (width !== undefined) out.width = Math.round(width)
  return out
}

// ---------------------------------------------------------------- swapping a stretch of road

export interface Splice {
  points: RoadPoint[]
  /** Old `at` to new `at`. */
  mapAt: (at: number) => number
  /** The new control points, first and last index in the new list (the changed stretch). */
  first: number
  last: number
}

/**
 * Swap the road from s0 forward to s1 (metres; s1 may run past the end of
 * the lap) for the line `win`, which starts on the road at s0 and ends on
 * it at s1. Control points inside the window (and within 3 m of its ends)
 * are replaced by new ones about `spacing` metres apart along the new line;
 * the rest are kept exactly. Settings carry over by how far through the
 * window a new point sits. Returns null if the window is nearly the whole road.
 */
export function spliceRoad(line: RoadLine, s0: number, s1: number, win: readonly P[], spacing: number = CLEANUP.spacing, heights: HeightSource = {}): Splice | null {
  const pts = line.points
  const n = pts.length
  const L = line.length
  const span = s1 - s0
  const gap = 3
  const rel = (k: number) => wrapS(sOfPoint(line, k) - s0, L)
  const kept: number[] = []
  for (let k = 0; k < n; k++) {
    const r = rel(k)
    if (r >= span + gap && r <= L - gap) kept.push(k)
  }
  if (kept.length < 3) return null
  kept.sort((a, b) => rel(a) - rel(b))
  const kFirst = kept[0]
  const kLast = kept[kept.length - 1]
  // The road from the last kept point to the first: old road, the new window, old road.
  const a = L - rel(kLast)
  const b = rel(kFirst) - span
  const pre = stretchOf(line, s0 - a, s0, 2)
  const post = stretchOf(line, s1, s1 + b, 2)
  const path: P[] = [...pre, ...win.slice(1), ...post.slice(1)]
  const cum = [0]
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + dist(path[i - 1], path[i]))
  const T = cum[cum.length - 1]
  const winLen = (() => {
    let m = 0
    for (let i = 1; i < win.length; i++) m += dist(win[i - 1], win[i])
    return m
  })()
  const uA = cum[pre.length - 1]
  const uB = uA + winLen
  const pathAt = (u: number): P => {
    let j = 1
    while (j < cum.length - 1 && cum[j] < u) j++
    const seg = cum[j] - cum[j - 1]
    const t = seg > 0 ? (u - cum[j - 1]) / seg : 0
    return { x: path[j - 1].x + (path[j].x - path[j - 1].x) * t, z: path[j - 1].z + (path[j].z - path[j - 1].z) * t }
  }
  /** Where on the old road a spot u metres along the new path came from. */
  const oldS = (u: number) => (u <= uA ? s0 - a + u : u <= uB ? s0 + ((u - uA) / Math.max(winLen, 1e-6)) * span : s1 + (u - uB))
  const c = Math.max(2, Math.round(T / spacing))
  const fresh: RoadPoint[] = []
  for (let i = 1; i < c; i++) {
    const u = (T * i) / c
    const p = pathAt(u)
    const spot = { x: roundMm(p.x), z: roundMm(p.z) }
    fresh.push({ ...spot, ...settingsAt(line, oldS(u), heights, spot) })
  }
  // New list: the kept points in order, then the new ones. Old point 0 stays first when it was kept.
  let list: RoadPoint[] = [...kept.map((k) => ({ ...pts[k] })), ...fresh]
  const rot = Math.max(0, kept.indexOf(0))
  list = [...list.slice(rot), ...list.slice(0, rot)]
  const N = list.length
  const newIndexOfKept = (pos: number) => (((pos - rot) % N) + N) % N
  const keptPos = new Map<number, number>()
  kept.forEach((k, i) => keptPos.set(k, i))
  const lastIdx = newIndexOfKept(kept.length - 1)
  const mapAt = (at: number): number => {
    const r = wrapS(sOf(line, at) - sOfPoint(line, kLast), L)
    if (r < a + span + b) {
      const u = r <= a ? r : r <= a + span ? uA + ((r - a) / span) * winLen : uB + (r - a - span)
      return wrapAt(lastIdx + (u / T) * c, N)
    }
    const k = Math.floor(wrapAt(at, n)) % n
    const pos = keptPos.get(k)
    if (pos === undefined) return wrapAt(lastIdx, N)
    return wrapAt(newIndexOfKept(pos) + (wrapAt(at, n) - Math.floor(wrapAt(at, n))), N)
  }
  return { points: list, mapAt, first: newIndexOfKept(kept.length), last: newIndexOfKept(kept.length + fresh.length - 1) }
}

/** The new road's centreline over a spliced stretch, with a little road either side (for the preview). */
function splicePreview(sp: Splice): { line: RoadLine; s0: number; s1: number; preview: P[] } {
  const line = roadLine(sp.points)
  const s0 = sOfPoint(line, sp.first - 1)
  let s1 = sOfPoint(line, sp.last + 1)
  if (s1 <= s0) s1 += line.length
  return { line, s0, s1, preview: stretchOf(line, s0, s1, 3) }
}

// ---------------------------------------------------------------- world edge

function limitFor(world: ShapeWorld): WorldLimit {
  return worldLimit({ bound: world.bound, playRadius: world.playRadius, width: world.width, worldMargin: CLEANUP.worldMargin })
}

/** Pull a point back inside the world if it has strayed past the edge. */
export function clampToWorld(p: P, world: ShapeWorld): P {
  const lim = limitFor(world)
  let x = Math.max(-lim.square, Math.min(lim.square, p.x))
  let z = Math.max(-lim.square, Math.min(lim.square, p.z))
  const r = Math.hypot(x, z)
  if (r > lim.radius) {
    x *= lim.radius / r
    z *= lim.radius / r
  }
  return { x, z }
}

function insideWorld(p: P, world: ShapeWorld): boolean {
  const lim = limitFor(world)
  return Math.abs(p.x) <= lim.square + 0.5 && Math.abs(p.z) <= lim.square + 0.5 && Math.hypot(p.x, p.z) <= lim.radius + 0.5
}

function crossingCount(points: readonly RoadPoint[]): number {
  const line = roadLine(points)
  return findCrossings(resample(line.rc.curve, 4, true)).length
}

// ---------------------------------------------------------------- Smooth

/** How hard one press of Smooth irons the road, metres (bigger = smoother). */
export const SMOOTH_SIGMA = 18

/** A stretch of road Smooth must leave alone: `before` metres behind `at` to `after` metres past it. */
export interface KeepZone {
  at: number
  before: number
  after: number
}

/**
 * Smooth the whole road. The road is laid out every 2 m, each spot is
 * averaged with its neighbours (a Gaussian over about 3 x SMOOTH_SIGMA
 * metres), and then the clean-up's rules open any corner that ended up too
 * tight. Each control point moves to the smoothed line at the same place
 * along the road, so the number of points, the pieces and every per-point
 * setting stay exactly where they were.
 *
 * `keep` lists stretches that must stay exactly as they are (a loop's
 * straight run-in, the start grid): smoothing fades out over 40 m before
 * reaching them, so a corner next to a loop doesn't creep onto its straight.
 */
export function smoothRoad(points: readonly RoadPoint[], world: ShapeWorld, sigma = SMOOTH_SIGMA, keep: readonly KeepZone[] = []): ShapeResult {
  const line = roadLine(points)
  const L = line.length
  const m = Math.max(32, Math.round(L / 2))
  const dense: P[] = []
  for (let j = 0; j < m; j++) dense.push(posOf(line, (j * L) / m))
  const fully = gaussianSmoothClosed(dense, sigma)
  // How much smoothing each spot gets: none inside a keep zone, all of it 40 m away.
  const zones = keep.map((z) => ({ s: sOf(line, z.at), before: z.before, after: z.after }))
  const amount = (s: number) => {
    let w = 1
    for (const z of zones) {
      const d = wrapS(s - z.s, L)
      const ahead = d <= L / 2 ? d - z.after : Infinity
      const behind = d > L / 2 ? L - d - z.before : Infinity
      const gap = Math.min(ahead, behind)
      w = Math.min(w, gap <= 0 ? 0 : Math.min(1, gap / 40))
    }
    return w * w * (3 - 2 * w)
  }
  const smoothed = fully.map((p, j) => {
    const w = zones.length ? amount((j * L) / m) : 1
    return { x: dense[j].x + (p.x - dense[j].x) * w, z: dense[j].z + (p.z - dense[j].z) * w }
  })
  const where = points.map((_, k) => (sOfPoint(line, k) / L) * m)
  const onLine = (poly: readonly P[], f: number): P => {
    const N = poly.length
    const g = (f / m) * N
    const i = Math.floor(g) % N
    const t = g - Math.floor(g)
    const a = poly[i]
    const c = poly[(i + 1) % N]
    return { x: a.x + (c.x - a.x) * t, z: a.z + (c.z - a.z) * t }
  }
  const options = { width: world.width, bound: world.bound, playRadius: world.playRadius }
  let best: RoadPoint[] | null = null
  let bestTight = { radius: 0, at: null as P | null }
  for (const margin of [CLEANUP.cornerMargin, CLEANUP.cornerMargin + 0.2, CLEANUP.cornerMargin + 0.4]) {
    // The clean-up's corner, spacing and world-edge rules, then its light fairing pass.
    const relaxed = resample(gaussianSmoothClosed(relaxLoop(smoothed, options, margin), 6), 2, true)
    const out = points.map((p, k) => {
      // A point inside a keep zone stays exactly where it is.
      if (zones.length && amount(sOfPoint(line, k)) === 0) return { ...p }
      const guess = onLine(smoothed, where[k])
      const q = nearestNear(relaxed, guess, (where[k] / m) * relaxed.length, 40)
      return { ...p, x: roundMm(q.x), z: roundMm(q.z) }
    })
    const tight = tightestOnRoad(out)
    if (!best || tight.radius > bestTight.radius) {
      best = out
      bestTight = tight
    }
    if (tight.radius >= MIN_RADIUS) break
  }
  const result = best ?? points.map((p) => ({ ...p }))
  const notes: string[] = []
  if (bestTight.radius < MIN_RADIUS) notes.push(`One corner is still tight (${Math.round(bestTight.radius)} m). Bend it wider, or press Smooth again.`)
  return { ok: true, points: result, mapAt: (at) => at, tightest: bestTight.radius, tightAt: bestTight.at, preview: [], notes }
}

/** The spot on a closed polyline nearest p, looking only within `window` samples of index `guess`. */
function nearestNear(poly: readonly P[], p: P, guess: number, window: number): P {
  const N = poly.length
  let best = poly[0]
  let bestD = Infinity
  const g = Math.round(guess)
  for (let d = -window; d <= window; d++) {
    const i = (((g + d) % N) + N) % N
    const a = poly[i]
    const c = poly[(i + 1) % N]
    const vx = c.x - a.x
    const vz = c.z - a.z
    const len2 = vx * vx + vz * vz || 1
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.z - a.z) * vz) / len2))
    const q = { x: a.x + vx * t, z: a.z + vz * t }
    const dd = dist(p, q)
    if (dd < bestD) {
      bestD = dd
      best = q
    }
  }
  return best
}

// ---------------------------------------------------------------- Bend

/** The Bend tool's reach (how much road comes along, metres each way from your hand). */
export const BEND_REACH = { start: 120, min: 30, max: 400 }

/**
 * How much of the pull a spot d metres along the road from your hand gets:
 * all of it at your hand, none at the reach, and in between a smooth bump
 * (1 - t^2)^3. Its slope AND its bend are zero at the reach, so the bent
 * road joins the still road with no kink and no sudden change of curve.
 */
export function bendWeight(d: number, reach: number): number {
  const t = Math.abs(d) / reach
  if (t >= 1) return 0
  const u = 1 - t * t
  return u * u * u
}

/**
 * Give a stretch of road enough control points to bend smoothly: any gap
 * longer than `maxGap` metres between s0 and s1 gets new points on the curve
 * about 16 m apart (built-in tracks have points up to 200 m apart). The road
 * does not move, up or down, as long as `heights` knows the ground (each new
 * point gets the road's own height there, see newPointHeight); pieces keep
 * their places.
 */
export function densify(
  line: RoadLine,
  s0: number,
  s1: number,
  maxGap = 20,
  spacing: number = CLEANUP.spacing,
  heights: HeightSource = {},
): { points: RoadPoint[]; mapAt: (at: number) => number } {
  const pts = line.points
  const n = pts.length
  const L = line.length
  const parts = new Array<number>(n).fill(1)
  let changed = false
  for (let k = 0; k < n; k++) {
    const a = sOfPoint(line, k)
    const len = (k === n - 1 ? L : sOfPoint(line, k + 1)) - a
    if (len <= maxGap) continue
    // Does this segment touch [s0, s1]?
    const startRel = wrapS(a - s0, L)
    const touches = startRel <= s1 - s0 || startRel + len >= L
    if (!touches) continue
    parts[k] = Math.ceil(len / spacing)
    changed = true
  }
  if (!changed) return { points: pts.map((p) => ({ ...p })), mapAt: (at) => at }
  const out: RoadPoint[] = []
  const firstNew = new Array<number>(n)
  for (let k = 0; k < n; k++) {
    firstNew[k] = out.length
    out.push({ ...pts[k] })
    const a = sOfPoint(line, k)
    const len = (k === n - 1 ? L : sOfPoint(line, k + 1)) - a
    for (let j = 1; j < parts[k]; j++) {
      const s = a + (len * j) / parts[k]
      const p = posOf(line, s)
      const spot = { x: roundMm(p.x), z: roundMm(p.z) }
      out.push({ ...spot, ...settingsAt(line, s, heights, spot) })
    }
  }
  const mapAt = (at: number): number => {
    const w = wrapAt(at, n)
    const k = Math.floor(w) % n
    if (parts[k] === 1) return wrapAt(firstNew[k] + (w - Math.floor(w)), out.length)
    const a = sOfPoint(line, k)
    const len = (k === n - 1 ? L : sOfPoint(line, k + 1)) - a
    const f = Math.max(0, Math.min(1, wrapS(sOf(line, at) - a, L) / len))
    return wrapAt(firstNew[k] + f * parts[k], out.length)
  }
  return { points: out, mapAt }
}

/**
 * Bend: every control point within `reach` metres (along the road) of the
 * grab spot moves by `pull` x bendWeight. Points never leave the world.
 * The number of points does not change.
 */
export function bendRoad(line: RoadLine, grabS: number, reach: number, pull: P, world: ShapeWorld): RoadPoint[] {
  return line.points.map((p, k) => {
    const w = bendWeight(alongRoad(sOfPoint(line, k), grabS, line.length), reach)
    if (w <= 0) return { ...p }
    const q = clampToWorld({ x: p.x + pull.x * w, z: p.z + pull.z * w }, world)
    return { ...p, x: roundMm(q.x), z: roundMm(q.z) }
  })
}

/**
 * The road with no gap between points longer than 20 m (built-in tracks have
 * points up to 200 m apart). The game's curve through the points takes its
 * shape at each point from the points either side, so a short new gap next to
 * a long old one would put a kink in the road beside a change; with even gaps
 * a stretch can be swapped cleanly. The road itself moves a few centimetres
 * at most (its height too, when `world` knows the ground), and pieces keep
 * their places (mapAt).
 */
export function evenRoad(points: readonly RoadPoint[], world: ShapeWorld): { line: RoadLine; mapAt: (at: number) => number } {
  const line0 = roadLine(points)
  const dz = densify(line0, 0, line0.length, 20, CLEANUP.spacing, world)
  return { line: roadLine(dz.points), mapAt: dz.mapAt }
}

/** A result worked out on the evened road, told in terms of the road you gave (see evenRoad). */
function onOriginal(res: ShapeResult, even: { mapAt: (at: number) => number }, original: readonly RoadPoint[]): ShapeResult {
  if (!res.ok) return { ...res, points: original.map((p) => ({ ...p })), mapAt: (at) => at }
  return { ...res, mapAt: (at) => res.mapAt(even.mapAt(at)) }
}

/**
 * Open up any corner tighter than `radius` on an open stretch of road,
 * using the clean-up's corner rule (a point that turns too sharply is eased
 * toward the middle of its neighbours, a little at a time, over and over).
 * `radius` can change along the stretch (a function of metres from its
 * start), so a join can be eased gently without flattening the corners
 * beside it. The first and last few metres never move, so it still meets
 * the road.
 */
export function openCornersOnStretch(line: readonly P[], radius: number | ((u: number) => number), fixedMetres = 6, step = 2): P[] {
  let pts = resample(line, step, false)
  const fixed = Math.max(2, Math.ceil(fixedMetres / step))
  const radiusAt = typeof radius === 'number' ? () => radius : radius
  for (let iter = 0; iter < 3000; iter++) {
    const n = pts.length
    const h = (() => {
      let m = 0
      for (let i = 1; i < n; i++) m += dist(pts[i - 1], pts[i])
      return m / Math.max(1, n - 1)
    })()
    let over = 0
    const next = pts.map((p) => ({ ...p }))
    for (let i = fixed; i < n - fixed; i++) {
      const a = pts[i - 1]
      const b = pts[i]
      const c = pts[i + 1]
      const maxTurn = 2 * Math.asin(Math.min(1, h / (2 * radiusAt(i * h))))
      const turn = Math.abs(turnAngle(a, b, c))
      if (turn > maxTurn * 1.05) over = Math.max(over, turn / maxTurn)
      if (turn > maxTurn) next[i] = { x: b.x + 0.25 * ((a.x + c.x) / 2 - b.x), z: b.z + 0.25 * ((a.z + c.z) / 2 - b.z) }
    }
    pts = next
    if (iter % 4 === 3) pts = resample(pts, step, false)
    if (over === 0 && iter > 3) break
  }
  return pts
}

/**
 * A light, even smoothing of an open stretch (each spot averaged with its
 * neighbours within about 3 x sigma metres, the window shrinking toward the
 * ends so the ends never move). It turns a sudden change of bend, where a
 * straight meets an arc, into a quick but smooth one: the game's curve through
 * the points overshoots at a sudden change and makes a little kink. Straight
 * lines stay exactly straight.
 */
export function fairStretch(line: readonly P[], sigma = 6, step = 2): P[] {
  const pts = resample(line, step, false)
  const n = pts.length
  const reach = Math.ceil((3 * sigma) / step)
  const w: number[] = []
  for (let k = 0; k <= reach; k++) w.push(Math.exp(-((k * step) ** 2) / (2 * sigma * sigma)))
  return pts.map((p, i) => {
    const r = Math.min(reach, i, n - 1 - i)
    if (r === 0) return { ...p }
    let x = p.x * w[0]
    let z = p.z * w[0]
    let total = w[0]
    for (let k = 1; k <= r; k++) {
      x += (pts[i - k].x + pts[i + k].x) * w[k]
      z += (pts[i - k].z + pts[i + k].z) * w[k]
      total += 2 * w[k]
    }
    return { x: x / total, z: z / total }
  })
}

// ---------------------------------------------------------------- Straight and Curve: the stretch between two spots

interface Ends {
  sA: number
  sB: number
  A: P
  B: P
}

/**
 * The two clicked spots as a stretch running forward along the road. The
 * shorter way round between them is the one that changes.
 */
function endsOf(line: RoadLine, fromAt: number, toAt: number): Ends | string {
  const L = line.length
  let sA = sOf(line, fromAt)
  let sB = sOf(line, toAt)
  let fwd = wrapS(sB - sA, L)
  if (fwd > L / 2) {
    ;[sA, sB] = [sB, sA]
    fwd = L - fwd
  }
  if (fwd < 30) return 'Pick two spots further apart (at least 30 m along the road).'
  if (fwd > L - 200) return 'That is nearly the whole road. Pick two spots closer together.'
  sB = sA + fwd
  return { sA, sB, A: posOf(line, sA), B: posOf(line, sB) }
}

/** Shared tail of Straight, Curve and Corner: splice, then check it is drivable and inside the world. */
function finishStretch(line: RoadLine, s0: number, s1: number, win: P[], world: ShapeWorld, beforeCrossings: number, spacing: number = CLEANUP.spacing, fair = 6): ShapeResult {
  const fail = (reason: string, preview: P[] = win, tight = { radius: Infinity, at: null as P | null }): ShapeResult => ({
    ok: false,
    points: line.points.map((p) => ({ ...p })),
    mapAt: (at) => at,
    tightest: tight.radius,
    tightAt: tight.at,
    preview,
    reason,
    notes: [],
  })
  const sp = spliceRoad(line, s0, s1, fairStretch(win, fair), spacing, world)
  if (!sp) return fail('That is nearly the whole road. Pick two spots closer together.')
  const pv = splicePreview(sp)
  const tight = tightestBetween(pv.line, pv.s0, pv.s1)
  if (tight.radius < MIN_RADIUS) {
    return fail(`Too tight for a car: that would make a ${Math.floor(tight.radius)} m corner, and the smallest a car can take is ${MIN_RADIUS} m.`, pv.preview, tight)
  }
  for (let i = sp.first; ; i = (i + 1) % sp.points.length) {
    if (!insideWorld(sp.points[i], world)) return fail('That goes off the edge of the world. Keep it further in.', pv.preview, tight)
    if (i === sp.last) break
  }
  if (closestPoints(sp.points) < 2.5) return fail('That folds the road over itself. Try other spots.', pv.preview, tight)
  const notes: string[] = []
  if (crossingCount(sp.points) > beforeCrossings) notes.push('It now crosses another bit of road: the Checks panel shows where.')
  return { ok: true, points: sp.points, mapAt: sp.mapAt, tightest: tight.radius, tightAt: tight.at, preview: pv.preview, notes }
}

/** Joins the parts of a window into one line, dropping the repeated point where two parts meet. */
function joinParts(...parts: P[][]): P[] {
  const out: P[] = []
  for (const part of parts) {
    for (const p of part) if (!out.length || dist(out[out.length - 1], p) > 0.05) out.push(p)
  }
  return out
}

/** Angle between two unit vectors, radians (0 = same way). */
function angleBetween(u: P, v: P): number {
  return Math.acos(Math.max(-1, Math.min(1, u.x * v.x + u.z * v.z)))
}

/**
 * Metres between the new points a Straight or a Corner makes (closer than the
 * clean-up's 16: the game's curve through the points is only dead straight
 * between four points in a line, and follows an arc's radius more closely).
 */
export const SHAPE_SPACING = 10

/**
 * Straight: the road from one clicked spot to the other becomes a dead
 * straight line. Where it meets the road at each end, the corner is rounded
 * off with the clean-up's corner rule (so the very ends of the straight
 * curve gently into the road you had), and nothing outside those joins moves.
 */
export function straightStretch(points: readonly RoadPoint[], fromAt: number, toAt: number, world: ShapeWorld): ShapeResult {
  const even = evenRoad(points, world)
  const line = even.line
  const ends = endsOf(line, even.mapAt(fromAt), even.mapAt(toAt))
  const nothing = (reason: string): ShapeResult => ({ ok: false, points: points.map((p) => ({ ...p })), mapAt: (at) => at, tightest: Infinity, tightAt: null, preview: [], reason, notes: [] })
  if (typeof ends === 'string') return nothing(ends)
  const { sA, sB, A, B } = ends
  const chord = dist(A, B)
  if (chord < 25) return nothing('Those two spots are too close together on the map. Pick spots further apart.')
  const u = { x: (B.x - A.x) / chord, z: (B.z - A.z) / chord }
  const thA = angleBetween(dirOf(line, sA), u)
  const thB = angleBetween(u, dirOf(line, sB))
  if (thA > (120 * Math.PI) / 180 || thB > (120 * Math.PI) / 180) return nothing('A straight there would turn right back on the road. Pick two spots further along it.')
  const before = crossingCount(line.points)
  let last: ShapeResult | null = null
  for (const grow of [1.35, 1.6, 1.9]) {
    const floor = MIN_RADIUS * grow
    // How gently each end eases in: as wide as fits in an eighth of the straight
    // (so a small change of direction gets a long, sweeping join), never
    // tighter than the floor and never wider than 120 m.
    const ease = (th: number) => Math.min(120, Math.max(floor, chord / 8 / Math.max(Math.tan(th / 2), 1e-3)))
    const rA = ease(thA)
    const rB = ease(thB)
    // Road either side of the straight that may move to make the join (the ease needs about r x tan(angle / 2)).
    const room = (r: number, th: number) => Math.min(160, Math.max(24, 1.3 * r * Math.tan(th / 2) + 16))
    const mA = room(rA, thA)
    const mB = room(rB, thB)
    if (mA + mB + (sB - sA) > line.length - 60) return nothing('That is nearly the whole road. Pick two spots closer together.')
    const raw = joinParts(stretchOf(line, sA - mA, sA, 2), resample([A, B], 2, false), stretchOf(line, sB, sB + mB, 2))
    // The gentle ease only where the straight meets the road; the rest just has to be drivable.
    const zoneA = rA * Math.tan(thA / 2) + 10
    const zoneB = rB * Math.tan(thB / 2) + 10
    const radiusAt = (u: number) => (Math.abs(u - mA) <= zoneA ? rA : Math.abs(u - (mA + chord)) <= zoneB ? rB : floor)
    const win = openCornersOnStretch(raw, radiusAt)
    last = finishStretch(line, sA - mA, sB + mB, win, world, before, SHAPE_SPACING)
    if (last.ok) break
  }
  return last ? onOriginal(last, even, points) : nothing('That straight did not work. Try other spots.')
}

/**
 * A smooth curve from A to B through M that leaves A going the way the road
 * goes at A and arrives at B going the way the road goes at B: two cubic
 * pieces (A to M, M to B) that join at M with the same direction AND the
 * same bend, so it is one clean curve. Spaced by the distances between the
 * three spots, so it does not bunch up on the short side.
 */
export function curveThrough(A: P, M: P, B: P, tA: P, tB: P, step = 1): P[] {
  const h1 = Math.max(1, dist(A, M))
  const h2 = Math.max(1, dist(M, B))
  const k = 4 / h1 + 4 / h2
  const tM = {
    x: ((6 * (B.x - M.x)) / (h2 * h2) + (6 * (M.x - A.x)) / (h1 * h1) - (2 * tA.x) / h1 - (2 * tB.x) / h2) / k,
    z: ((6 * (B.z - M.z)) / (h2 * h2) + (6 * (M.z - A.z)) / (h1 * h1) - (2 * tA.z) / h1 - (2 * tB.z) / h2) / k,
  }
  const piece = (p0: P, p1: P, m0: P, m1: P, h: number, last: boolean): P[] => {
    const out: P[] = []
    const count = Math.max(8, Math.ceil((h * 2) / step))
    for (let i = 0; i <= (last ? count : count - 1); i++) {
      const s = i / count
      const s2 = s * s
      const s3 = s2 * s
      const h00 = 2 * s3 - 3 * s2 + 1
      const h10 = s3 - 2 * s2 + s
      const h01 = -2 * s3 + 3 * s2
      const h11 = s3 - s2
      out.push({ x: h00 * p0.x + h10 * h * m0.x + h01 * p1.x + h11 * h * m1.x, z: h00 * p0.z + h10 * h * m0.z + h01 * p1.z + h11 * h * m1.z })
    }
    return out
  }
  return resample([...piece(A, M, tA, tM, h1, false), ...piece(M, B, tM, tB, h2, true)], step, false)
}

/**
 * Curve: the road between two clicked spots becomes one smooth curve
 * through the pulled spot M, matching the road's direction at both ends
 * (no kink where it joins). Refused, with the reason, if any part of it
 * would be tighter than a car can take.
 */
export function curveStretch(points: readonly RoadPoint[], fromAt: number, toAt: number, pull: P, world: ShapeWorld): ShapeResult {
  const even = evenRoad(points, world)
  const line = even.line
  const ends = endsOf(line, even.mapAt(fromAt), even.mapAt(toAt))
  if (typeof ends === 'string') return { ok: false, points: points.map((p) => ({ ...p })), mapAt: (at) => at, tightest: Infinity, tightAt: null, preview: [], reason: ends, notes: [] }
  const { sA, sB, A, B } = ends
  const mid = curveThrough(A, pull, B, dirOf(line, sA), dirOf(line, sB), 1)
  const m = 20
  const win = joinParts(stretchOf(line, sA - m, sA, 2), mid, stretchOf(line, sB, sB + m, 2))
  // Too tight already on the drawn curve? Say where, without building anything.
  let tight = { radius: Infinity, at: null as P | null }
  for (let i = 3; i < mid.length - 3; i++) {
    const r = circumradius(mid[i - 3], mid[i], mid[i + 3])
    if (r < tight.radius) tight = { radius: r, at: mid[i] }
  }
  if (tight.radius < MIN_RADIUS) {
    return {
      ok: false,
      points: points.map((p) => ({ ...p })),
      mapAt: (at) => at,
      tightest: tight.radius,
      tightAt: tight.at,
      preview: win,
      reason: `Too tight for a car: that curve has a ${Math.floor(tight.radius)} m corner, and the smallest a car can take is ${MIN_RADIUS} m. Pull it out less, or pick spots further apart.`,
      notes: [],
    }
  }
  return onOriginal(finishStretch(line, sA - m, sB + m, win, world, crossingCount(line.points)), even, points)
}

// ---------------------------------------------------------------- Corner: gentler or tighter

/** A corner found around a road point (see cornerAt). */
export interface Corner {
  /** Metres along the road where the corner starts and ends (it bends between them). */
  sIn: number
  sOut: number
  /** Where it starts and ends, and which way the road runs there. */
  E: P
  X: P
  tIn: P
  tOut: P
  /** How far it turns, radians (always positive), and which way: +1 or -1. */
  turn: number
  side: number
  /** Where the straight lines into and out of the corner meet (the corner's "point"). */
  V: P
  /** Distance from E to V and from V to X along those lines, metres. */
  toV: number
  fromV: number
  /** Straight-ish road before E and after X the corner may grow into, metres. */
  roomIn: number
  roomOut: number
  /** Its radius now, as an arc between the lines in and out, metres. */
  radius: number
  /** The slider's range: tightest a car can take, gentlest that fits. */
  min: number
  max: number
}

/** Tightest a corner may be made with the corner slider, metres (a little above the minimum, for the ease in and out). */
export const CORNER_MIN = Math.ceil(MIN_RADIUS * 1.3)

/**
 * The corner road point `index` sits on: the stretch around it that keeps
 * bending the same way. A string says why there isn't one (a straight, or a
 * corner that turns almost all the way round, which has no point to aim at).
 */
export function cornerAt(points: readonly RoadPoint[], index: number): Corner | string {
  const line = roadLine(points)
  const L = line.length
  const sP = sOfPoint(line, index)
  const step = 2
  const reach = Math.min(700, L / 2 - 10)
  const prof = bendProfile(line, sP - reach, sP + reach, step)
  // A light average so the spline's small ripples don't split a corner in two.
  const k = prof.map((_, i) => {
    let sum = 0
    let n = 0
    for (let j = i - 3; j <= i + 3; j++) {
      if (j < 0 || j >= prof.length) continue
      sum += prof[j]
      n++
    }
    return sum / n
  })
  const mid = Math.round(reach / step)
  const kP = k[mid]
  if (Math.abs(kP) < 1 / 800) return 'This point is on a straight. Pick a point in the middle of a corner.'
  const side = Math.sign(kP)
  const keep = Math.max(1 / 2500, 0.12 * Math.abs(kP))
  let i0 = mid
  while (i0 > 0 && Math.sign(k[i0 - 1]) === side && Math.abs(k[i0 - 1]) >= keep) i0--
  let i1 = mid
  while (i1 < k.length - 1 && Math.sign(k[i1 + 1]) === side && Math.abs(k[i1 + 1]) >= keep) i1++
  const sIn = sP - reach + i0 * step
  const sOut = sP - reach + i1 * step
  let turned = 0
  for (let i = i0; i < i1; i++) turned += Math.abs(k[i]) * step
  if (turned > (150 * Math.PI) / 180) return 'This corner turns almost all the way round, so it has no point to aim at. Use Bend to reshape it.'
  const E = posOf(line, sIn)
  const X = posOf(line, sOut)
  const tIn = dirOf(line, sIn)
  const tOut = dirOf(line, sOut)
  // The angle between the straight lines in and out (what the new arc must turn).
  const turn = Math.acos(Math.max(-1, Math.min(1, tIn.x * tOut.x + tIn.z * tOut.z)))
  if (turn < (8 * Math.PI) / 180) return 'This corner is too gentle to change. Pick a point in a proper corner.'
  const cross = (u: P, v: P) => u.x * v.z - u.z * v.x
  const den = cross(tIn, tOut)
  if (Math.abs(den) < 1e-6) return 'This corner is too gentle to change. Pick a point in a proper corner.'
  const XE = { x: X.x - E.x, z: X.z - E.z }
  const toV = cross(XE, tOut) / den
  const fromV = cross(tIn, XE) / den
  if (!(toV > 0 && fromV > 0)) return 'This bend is an S or a wiggle, not one corner. Pick a point in the middle of a corner.'
  const V = { x: E.x + tIn.x * toV, z: E.z + tIn.z * toV }
  // Road either side the corner may grow into: up to where the next bend gets going
  // (bending the other way, or a real corner), and never more than 200 m.
  const roomOf = (from: number, dir: number) => {
    let m = 0
    for (; m < 200; m += step) {
      const s = from + dir * (m + step)
      const kk = bendProfile(line, s, s, step)[0]
      if (Math.sign(kk) !== side ? Math.abs(kk) > 1 / 1500 : Math.abs(kk) > Math.max(1 / 600, 0.35 * Math.abs(kP))) break
    }
    return m
  }
  const roomIn = roomOf(sIn, -1)
  const roomOut = roomOf(sOut, 1)
  const tanHalf = Math.tan(turn / 2)
  // Its radius now: how sharply the middle half of the corner bends (a corner
  // eases in and out, so its middle is the part that counts).
  const middle = k.slice(i0 + Math.floor((i1 - i0) / 4), i1 - Math.floor((i1 - i0) / 4) + 1).map(Math.abs).sort((a, b) => a - b)
  const typical = middle[Math.floor(middle.length / 2)] || Math.abs(kP)
  // Gentler needs road: an arc meets both straight lines its radius x tan(turn / 2) from their point.
  const maxTangent = Math.min(toV + roomIn * 0.8, fromV + roomOut * 0.8)
  const max = Math.min(400, maxTangent / tanHalf)
  const radius = Math.min(max, 1 / typical)
  const min = Math.min(radius, CORNER_MIN)
  if (max < min + 2) return 'There is no room either side of this corner to change it. Use Bend instead.'
  return { sIn, sOut, E, X, tIn, tOut, turn, side, V, toV, fromV, roomIn, roomOut, radius, min, max }
}

/**
 * Give the corner around road point `index` a new radius. The corner
 * becomes a circular arc of that radius running between the two straight
 * lines into and out of it (so it meets them with no kink): smaller is
 * tighter (the arc moves toward the corner's point and the straights get
 * longer), bigger is gentler (it starts earlier and finishes later). The
 * road beyond the corner does not move.
 */
export function cornerRadius(points: readonly RoadPoint[], index: number, radius: number, world: ShapeWorld): ShapeResult {
  const nothing = (reason: string): ShapeResult => ({ ok: false, points: points.map((p) => ({ ...p })), mapAt: (at) => at, tightest: Infinity, tightAt: null, preview: [], reason, notes: [] })
  const c = cornerAt(points, index)
  if (typeof c === 'string') return nothing(c)
  let R = Math.max(c.min, Math.min(c.max, radius))
  // The corner was found on the road as it is; the evened road is the same road (to a few centimetres).
  const even = evenRoad(points, world)
  const line = even.line
  // The new corner starts where the road still runs straight into it (further back
  // if it is gentler): the lines in and out are the road's own direction there, so
  // the new road leaves the old one with no kink at all.
  const d0 = R * Math.tan(c.turn / 2)
  const sStart = c.sIn - Math.max(0, d0 - c.toV) - 15
  const sEnd = c.sOut + Math.max(0, d0 - c.fromV) + 15
  const P1 = posOf(line, sStart)
  const t1 = dirOf(line, sStart)
  const P2 = posOf(line, sEnd)
  const t2 = dirOf(line, sEnd)
  const cross = (u: P, v: P) => u.x * v.z - u.z * v.x
  const den = cross(t1, t2)
  if (Math.abs(den) < 1e-6) return nothing('This corner is too gentle to change. Pick a point in a proper corner.')
  const P12 = { x: P2.x - P1.x, z: P2.z - P1.z }
  const toV = cross(P12, t2) / den
  const fromV = cross(t1, P12) / den
  if (!(toV > 0 && fromV > 0)) return nothing('This bend is an S or a wiggle, not one corner. Pick a point in the middle of a corner.')
  const V = { x: P1.x + t1.x * toV, z: P1.z + t1.z * toV }
  const turn = Math.acos(Math.max(-1, Math.min(1, t1.x * t2.x + t1.z * t2.z)))
  // The arc must start after P1 and end before P2 (a little room for the ease).
  R = Math.min(R, (Math.min(toV, fromV) - 4) / Math.tan(turn / 2))
  if (R < MIN_RADIUS) return nothing('There is no room either side of this corner to change it. Use Bend instead.')
  const d = R * Math.tan(turn / 2)
  // Where the arc starts and ends, on the lines into and out of the corner.
  const T1 = { x: V.x - t1.x * d, z: V.z - t1.z * d }
  const T2 = { x: V.x + t2.x * d, z: V.z + t2.z * d }
  // The arc: its centre sits inside the corner, R from both lines.
  const inward = { x: t2.x - t1.x, z: t2.z - t1.z }
  const il = Math.hypot(inward.x, inward.z) || 1
  const cd = R / Math.cos(turn / 2)
  const C = { x: V.x + (inward.x / il) * cd, z: V.z + (inward.z / il) * cd }
  const a1 = Math.atan2(T1.z - C.z, T1.x - C.x)
  const sweep = Math.sign(den) * turn
  const arc: P[] = []
  const count = Math.max(8, Math.ceil((R * turn) / 2))
  for (let i = 0; i <= count; i++) {
    const a = a1 + (sweep * i) / count
    arc.push({ x: C.x + Math.cos(a) * R, z: C.z + Math.sin(a) * R })
  }
  const win = joinParts(stretchOf(line, sStart - 10, sStart, 2), resample([P1, T1], 2, false), arc, resample([T2, P2], 2, false), stretchOf(line, sEnd, sEnd + 10, 2))
  // A bigger corner gets a longer ease from the straight onto the arc (see fairStretch).
  const fair = Math.min(16, Math.max(6, R / 9))
  const res = onOriginal(finishStretch(line, sStart - 10, sEnd + 10, win, world, crossingCount(line.points), SHAPE_SPACING, fair), even, points)
  if (res.ok) res.notes.unshift(`The corner is now about ${Math.round(R)} m round (it was ${Math.round(c.radius)} m).`)
  return res
}

// ---------------------------------------------------------------- the start grid

/** True when the start grid (50 m behind the line to 10 m after it) is on straight road, like the game's start check. */
export function startGridStraight(points: readonly RoadPoint[], startAt: number): boolean {
  const line = roadLine(points)
  const s = sOf(line, startAt)
  return tightestBetween(line, s - 50, s + 10).radius >= 400
}

/**
 * The nearest spot (either way along the road from startAt) where the whole
 * grid sits on straight road and no piece but a boost pad or speed trap is
 * within the start area (70 m before to 25 m after). Null if there is none.
 */
export function nearestStraightStart(points: readonly RoadPoint[], startAt: number, pieceAts: readonly { at: number; type: string }[]): number | null {
  const line = roadLine(points)
  const L = line.length
  const s0 = sOf(line, startAt)
  const blocked = pieceAts.filter((p) => p.type !== 'boost' && p.type !== 'speedtrap').map((p) => sOf(line, p.at))
  const fits = (s: number) => {
    if (blocked.some((b) => {
      const d = wrapS(b - s, L)
      return d <= 25 || d >= L - 70
    }))
      return false
    return tightestBetween(line, s - 60, s + 15).radius >= 600
  }
  for (let m = 0; m <= L / 2; m += 5) {
    for (const sign of m === 0 ? [1] : [1, -1]) {
      const s = s0 + sign * m
      if (fits(s)) return atOf(line, s)
    }
  }
  return null
}

// ---------------------------------------------------------------- Steady pencil

/** The pencil's steadiness levels: how long the string is, in screen pixels (0 = off). */
export const STEADY_STRING = [0, 10, 20, 34] as const
/** What each level is called in the panel. */
export const STEADY_NAMES = ['Off', 'A little', 'Some', 'A lot'] as const
/** The level a new editor starts on. */
export const STEADY_DEFAULT = 2

/**
 * The "lazy mouse": the pen is pulled along behind the pointer on a string.
 * While the pointer wobbles about inside the string's length, the pen stays
 * still; only when the string goes tight does the pen move, straight toward
 * the pointer. Small shakes never reach the line, and big movements still do.
 */
export class SteadyPen {
  x = 0
  y = 0
  constructor(public stringPx: number) {}
  start(x: number, y: number): void {
    this.x = x
    this.y = y
  }
  /** The pointer is at (x, y). Returns true if the pen moved. */
  follow(x: number, y: number): boolean {
    const dx = x - this.x
    const dy = y - this.y
    const d = Math.hypot(dx, dy)
    if (d <= this.stringPx || d === 0) return false
    const k = (d - this.stringPx) / d
    this.x += dx * k
    this.y += dy * k
    return true
  }
}

/** A whole pointer path through the steady pen (what the pencil draws), keeping points `minStep` apart. */
export function steadyPath(path: readonly P[], stringPx: number, minStep = 3): P[] {
  if (!path.length) return []
  const pen = new SteadyPen(stringPx)
  pen.start(path[0].x, path[0].z)
  const out: P[] = [{ x: pen.x, z: pen.y }]
  for (let i = 1; i < path.length; i++) {
    pen.follow(path[i].x, path[i].z)
    const last = out[out.length - 1]
    if (Math.hypot(pen.x - last.x, pen.y - last.z) >= minStep) out.push({ x: pen.x, z: pen.y })
  }
  const end = path[path.length - 1]
  if (dist(out[out.length - 1], end) > 0.5) out.push({ x: end.x, z: end.z })
  return out
}
