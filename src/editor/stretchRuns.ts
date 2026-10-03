// ============================================================
//  STRETCH RUNS - finding the stretches Josh already changed
// ------------------------------------------------------------
//  Three tools change a stretch of road: Height, Bank and Width.
//  What they leave behind is stored on the road points themselves
//  (a point's `lift` or `y`, its `bank`, its `width`), so to let Josh
//  click a change he made before and change it again, this file
//  reads the points back into "runs": one run per stretch, with
//  where it starts and ends and the value it has.
//
//    bank runs     points next to each other with a bank set by hand
//    width runs    points next to each other with a width set by hand
//    raised runs   road a metre or more above the ground, plus the
//                  ramps either side of it down to the ground (and
//                  road dug a metre or more below it, the same way:
//                  its value is negative)
//
//  It also picks "a sensible stretch" around a spot Josh clicks
//  with one of those tools when there is no run there yet: for
//  Height, long enough for a car-sized bridge; for Bank, the whole
//  corner; for Width, a short stretch either side.
//
//  Pure: points in, runs out. The map draws the runs (mapDraw.ts)
//  and the tools select them (stretchTools.ts).
// ============================================================

import { TRACK_DEFAULTS, type Piece, type RoadPoint } from '../track/schema'
import type { TrackRuntime } from '../track/types'
import type { GroundFn } from './bridges'
import { atOf, dirOf, pointHeight, roadLine, sOf, wrapS, type RoadLine } from './shape'
import { LOOP_RUN_IN, wrapAt } from './road'
import { WALL_REACH } from '../track/road'
import { liftAt, stretchFor, stretchSpeed } from './raise'

/** The three tools that change a stretch of road (draft.ts EditorTool). */
export type StretchTool = 'height' | 'bank' | 'width'

export function isStretchTool(tool: string): tool is StretchTool {
  return tool === 'height' || tool === 'bank' || tool === 'width'
}

/** A stretch of road with one tool's change on it. */
export interface StretchRun {
  tool: StretchTool
  /** The stretch as a selection: `at` values, forward from `from` to `to`. */
  from: number
  to: number
  /** The first and last road point in it (indices; `last` may be smaller when it wraps past point 0). */
  first: number
  last: number
  /** Its value: degrees of bank, metres of width, or metres above the ground at its highest (below it at its deepest, negative, for a dug run). */
  value: number
  /** The road point its label sits beside (the middle, or the top of a raised run). */
  labelPoint: number
}

/** Everything the map marks and the tools can pick up again. */
export interface StretchMarks {
  bank: StretchRun[]
  width: StretchRun[]
  raised: StretchRun[]
  /** For each road point: is it a metre or more above the ground? (the violet dots) */
  raisedPoint: boolean[]
}

/** Road at least this far above the ground counts as raised (and gets a violet dot), metres. */
export const RAISED_MIN = 1

/** Indices `first` to `last` going forward round a road of `n` points. */
function indicesOf(first: number, last: number, n: number): number[] {
  const out: number[] = []
  for (let k = 0, i = first; k < n; k++, i = (i + 1) % n) {
    out.push(i)
    if (i === last) break
  }
  return out
}

/**
 * Runs of neighbouring points where `has` is true. A run that goes past the
 * last point carries on round to point 0 (the road is a loop).
 */
function runsWhere(n: number, has: (i: number) => boolean): { first: number; last: number }[] {
  const out: { first: number; last: number }[] = []
  if (n === 0) return out
  const at = (i: number) => has(((i % n) + n) % n)
  if (Array.from({ length: n }, (_, i) => at(i)).every(Boolean)) return [{ first: 0, last: n - 1 }]
  for (let i = 0; i < n; i++) {
    if (!at(i) || at(i - 1)) continue
    let count = 0
    while (count < n && at(i + count)) count++
    out.push({ first: i, last: (i + count - 1) % n })
  }
  return out
}

/** A run of points as a selection: from just before the first point to just after the last, so exactly those points are in it. */
function asRun(tool: StretchTool, first: number, last: number, n: number, value: number, labelPoint: number): StretchRun {
  return { tool, first, last, from: wrapAt(first - 0.45, n), to: wrapAt(last + 0.45, n), value, labelPoint }
}

/** Stretches with a bank set by hand (the amber line and BANK label). Their value is the bank at the middle. */
export function bankRuns(points: readonly RoadPoint[]): StretchRun[] {
  const n = points.length
  return runsWhere(n, (i) => points[i].bank !== undefined).map(({ first, last }) => {
    const idx = indicesOf(first, last, n)
    const mid = idx[Math.floor((idx.length - 1) / 2)]
    return asRun('bank', first, last, n, points[mid].bank ?? 0, mid)
  })
}

/** Stretches with a width set by hand. Their value is the width at the middle. */
export function widthRuns(points: readonly RoadPoint[]): StretchRun[] {
  const n = points.length
  return runsWhere(n, (i) => points[i].width !== undefined).map(({ first, last }) => {
    const idx = indicesOf(first, last, n)
    const mid = idx[Math.floor((idx.length - 1) / 2)]
    return asRun('width', first, last, n, points[mid].width ?? 0, mid)
  })
}

/** How high each road point sits above the ground, metres (its `lift`, or its `y` minus the ground). */
export function heightsAboveGround(points: readonly RoadPoint[], ground: GroundFn): number[] {
  return points.map((p) => pointHeight(p, ground) - ground(p.x, p.z))
}

/**
 * Raised road: points a metre or more above the ground, together with the
 * ramps either side down to the ground (so selecting one picks up the whole
 * hill or bridge, the same stretch the Height tool raised). Each ramp runs
 * outward while the road keeps coming down, and ends at the first point back
 * on the ground (under 3 cm up). Road dug a metre or more below the ground
 * (a dip, an underpass's road) makes runs the same way, upside down: their
 * value is how deep they go, negative.
 */
export function raisedRuns(points: readonly RoadPoint[], ground: GroundFn): StretchRun[] {
  const above = heightsAboveGround(points, ground)
  return [...signedRuns(above, 1), ...signedRuns(above, -1)]
}

/** raisedRuns for road above the ground (sign 1) or below it (sign -1). */
function signedRuns(above: readonly number[], sign: 1 | -1): StretchRun[] {
  const n = above.length
  const h = above.map((v) => v * sign)
  const hAt = (i: number) => h[((i % n) + n) % n]
  const core = runsWhere(n, (i) => h[i] >= RAISED_MIN)
  return core.map(({ first, last }) => {
    if (first === 0 && last === n - 1) {
      // The whole road is up: nothing to ramp down to.
      let top = 0
      for (let i = 0; i < n; i++) if (h[i] > h[top]) top = i
      return { tool: 'height' as const, first, last, from: 0, to: wrapAt(n - 1.01, n), value: sign * h[top], labelPoint: top }
    }
    // Walk down each ramp: outward while the road keeps coming down, to the first point on the ground.
    let a = first
    for (let k = 0; k < n && hAt(a - 1) < RAISED_MIN && hAt(a - 1) <= hAt(a) + 0.05; k++) {
      a--
      if (hAt(a) < 0.03) break
    }
    let b = first <= last ? last : last + n
    for (let k = 0; k < n && hAt(b + 1) < RAISED_MIN && hAt(b + 1) <= hAt(b) + 0.05; k++) {
      b++
      if (hAt(b) < 0.03) break
    }
    if (b - a >= n - 1) b = a + n - 2
    let top = first
    for (let i = first; i <= (first <= last ? last : last + n); i++) if (hAt(i) > hAt(top)) top = i
    const fa = ((a % n) + n) % n
    const fb = ((b % n) + n) % n
    return { tool: 'height' as const, first: fa, last: fb, from: fa, to: fb, value: sign * hAt(top), labelPoint: ((top % n) + n) % n }
  })
}

/** Every run the map shows, worked out once per road (the map asks every frame). */
export function stretchMarks(points: readonly RoadPoint[], ground: GroundFn): StretchMarks {
  const memo = marksMemo.get(points)
  if (memo && memo.ground === ground) return memo.marks
  const h = heightsAboveGround(points, ground)
  const marks: StretchMarks = { bank: bankRuns(points), width: widthRuns(points), raised: raisedRuns(points, ground), raisedPoint: h.map((v) => v >= RAISED_MIN) }
  marksMemo.set(points, { ground, marks })
  return marks
}

const marksMemo = new WeakMap<readonly RoadPoint[], { ground: GroundFn; marks: StretchMarks }>()

/** Is the spot `at` inside run `r`? */
export function inRun(r: StretchRun, at: number, n: number): boolean {
  return wrapAt(at - r.from, n) <= wrapAt(r.to - r.from, n)
}

/** The run of tool `tool` that the spot `at` is in, if any. */
export function runAt(marks: StretchMarks, tool: StretchTool, at: number, n: number): StretchRun | null {
  const list = tool === 'bank' ? marks.bank : tool === 'width' ? marks.width : marks.raised
  return list.find((r) => inRun(r, at, n)) ?? null
}

// ---------------------------------------------------------------- a sensible stretch around a click

/** The height a click with the Height tool sizes its stretch for: a bridge a car fits under. */
export const SIZE_FOR_HEIGHT = 8

/** `metres` of road centred on `at`, as a selection. */
function centred(line: RoadLine, at: number, metres: number): { from: number; to: number } {
  const s = sOf(line, at)
  return { from: atOf(line, s - metres / 2), to: atOf(line, s + metres / 2) }
}

/**
 * Road a height change must leave alone, metres either side of a piece or the
 * start line (the same spans raise.ts planRaise checks, plus a few metres):
 * the start grid, and loops, ramps and wall rides.
 */
function keepOuts(pieces: readonly Piece[], startAt: number): { at: number; before: number; after: number }[] {
  const out = [{ at: startAt, before: 75, after: 30 }]
  for (const p of pieces) {
    if (p.type === 'loop') out.push({ at: p.at, before: LOOP_RUN_IN + 15, after: LOOP_RUN_IN + 5 * (p.radius ?? TRACK_DEFAULTS.loopRadius) + 5 })
    else if (p.type === 'wallride') out.push({ at: p.at, before: WALL_REACH + 5, after: (p.length ?? TRACK_DEFAULTS.wallride.length) + WALL_REACH + 5 })
    else if (p.type === 'ramp') out.push({ at: p.at, before: 35, after: 35 })
  }
  return out
}

/**
 * Height: the stretch centred on the click, as long as a car at the speed cars
 * go there needs to stay on over an 8 m hill (raise.ts stretchFor), at least
 * 120 m and at most 40% of the road, then cut short of the start grid and any
 * loop, ramp or wall ride either side (a height change there would be refused).
 * The panel then offers as high as that stretch can go.
 */
export function heightStretchAround(d: { points: readonly RoadPoint[]; pieces: readonly Piece[]; startAt: number }, at: number, runtime: TrackRuntime | null, ground: GroundFn): { from: number; to: number } {
  const points = d.points
  const line = roadLine(points)
  const rise = Math.max(1, SIZE_FOR_HEIGHT - liftAt(line, at, ground))
  let metres = 160
  for (let pass = 0; pass < 2; pass++) {
    const sel = centred(line, at, metres)
    const v = stretchSpeed(runtime, points, sel.from, sel.to)
    metres = Math.min(line.length * 0.4, Math.max(120, Math.ceil(stretchFor(rise, v) * 1.05)))
  }
  return fitAround(d, line, at, metres)
}

/**
 * `metres` of road around `at` for a height change: centred on it, but where
 * the start grid or a loop, ramp or wall ride is in the way on one side, it
 * stops short of it there and reaches further the other way instead (as far
 * as that side allows). A spot right on one is left as it is: the panel says
 * why it can't change height there.
 */
function fitAround(d: { pieces: readonly Piece[]; startAt: number }, line: RoadLine, at: number, metres: number): { from: number; to: number } {
  const sc = sOf(line, at)
  const half = line.length / 2
  // How far back and ahead the stretch may reach before something it must leave alone.
  let roomBack = half
  let roomAhead = half
  for (const k of keepOuts(d.pieces, d.startAt)) {
    const rel = wrapS(sOf(line, k.at) - sc + half, line.length) - half
    const k0 = rel - k.before
    const k1 = rel + k.after
    if (k0 > 0) roomAhead = Math.min(roomAhead, k0)
    else if (k1 < 0) roomBack = Math.min(roomBack, -k1)
  }
  let back = Math.min(metres / 2, roomBack)
  let ahead = Math.min(metres / 2, roomAhead)
  const short = metres - back - ahead
  if (short > 0) {
    ahead = Math.min(roomAhead, ahead + short)
    back = Math.min(roomBack, metres - ahead)
  }
  return { from: atOf(line, sc - back), to: atOf(line, sc + ahead) }
}

/** How sharply the road turns `s` metres along (1 / radius), from its heading 10 m either side. */
function bendAt(line: RoadLine, s: number): number {
  const a = dirOf(line, s - 10)
  const b = dirOf(line, s + 10)
  const turn = Math.atan2(a.x * b.z - a.z * b.x, a.x * b.x + a.z * b.z)
  return Math.abs(turn) / 20
}

/** A bend gentler than this (1 / radius, a 400 m circle) counts as straight road for picking a corner. */
const CORNER_BEND = 1 / 400

/**
 * Bank: the whole corner around the click (where the road turns tighter than a
 * 400 m circle, up to 300 m each way), so a click picks what Josh means to
 * tilt. On a straight, 40 m either side.
 */
export function bankStretchAround(points: readonly RoadPoint[], at: number): { from: number; to: number } {
  const line = roadLine(points)
  const s = sOf(line, at)
  if (bendAt(line, s) < CORNER_BEND) return centred(line, at, 80)
  const reach = (sign: number) => {
    let d = 0
    while (d < 300 && bendAt(line, s + sign * (d + 5)) >= CORNER_BEND) d += 5
    return Math.max(40, d + 15)
  }
  const back = reach(-1)
  const ahead = reach(1)
  if (back + ahead > line.length - 60) return centred(line, at, 80)
  return { from: atOf(line, s - back), to: atOf(line, s + ahead) }
}

/** Width: 60 m either side of the click. */
export function widthStretchAround(points: readonly RoadPoint[], at: number): { from: number; to: number } {
  return centred(roadLine(points), at, 120)
}

/** Metres along the road from `from` forward to `to`. */
export function stretchMetres(points: readonly RoadPoint[], from: number, to: number): number {
  const line = roadLine(points)
  return wrapS(sOf(line, to) - sOf(line, from), line.length)
}

/** The middle of a stretch (an `at` value). */
export function stretchMiddle(points: readonly RoadPoint[], from: number, to: number): number {
  const line = roadLine(points)
  const s0 = sOf(line, from)
  return atOf(line, s0 + wrapS(sOf(line, to) - s0, line.length) / 2)
}

/**
 * The same stretch grown (or shrunk) to `metres` long about its middle, kept
 * under 45% of the road and clear of the start grid and loops, ramps and wall
 * rides (reaching further the other way where one is in the way).
 */
export function resizeStretch(d: { points: readonly RoadPoint[]; pieces: readonly Piece[]; startAt: number }, from: number, to: number, metres: number): { from: number; to: number } {
  const line = roadLine(d.points)
  return fitAround(d, line, stretchMiddle(d.points, from, to), Math.min(metres, line.length * 0.45))
}
