// ============================================================
//  RANDOM TRACK - the dice button: a brand new road, ready to drive
// ------------------------------------------------------------
//  Press Random track and the editor makes a whole new road in this
//  world. Every one it hands over has passed the same checks Josh's
//  own roads have to pass, so it always drives.
//
//  How one is made (randomTrack below):
//    1. pick a kind of shape with the dice: a wobbly blob, a figure
//       eight or a bow tie (their crossing becomes a bridge), a
//       circuit of straights and corners, or a peanut
//    2. pick a size, a turn and a spot, so it fits inside the world
//    3. "draw" it like a pencil line and put it through the very same
//       clean-up a pencil road gets (cleanup.ts): corners opened for
//       a car, the loop closed, the bridge built, the start line put
//       on a straight
//    4. build it with the game's real track builder and run the
//       game's own checks on it (the same rows `bun run tracks:check`
//       prints). Anything that fails, or even warns, is thrown away
//       and the dice roll again, behind the scenes
//    5. on the longest straight, maybe a speed trap and a boost pad,
//       kept only if the checks still pass with them
//
//  The same seed always makes the same track (handy for tests:
//  __dev.editor('random', seed) and the self-test use it). Pure: no
//  editor state is read or changed here; draft.ts randomRoad() makes
//  the result the draft.
// ============================================================

import type { EnvironmentSpec, Piece, RoadPoint } from '../track/schema'
import { validateTrack } from '../track/validate'
import { buildTrack, trackInternals } from '../track/build'
import { runTrackGates, type TrackGate } from '../track/gates'
import type { TrackRuntime } from '../track/types'
import { cleanStroke, type CleanResult } from './cleanup'
import { fileOfDraft, pointGroundOf, roadBound } from './draftFile'
import type { Draft } from './draft'
import type { P } from './geom'
import { roadLine, sOf, atOf, tightestBetween, type RoadLine } from './shape'

/** The smallest random road reaches this far from its middle, metres (if the world has room). */
const SMALLEST_RADIUS = 190

/** The kinds of shape the dice can pick. */
export type RandomShape = 'blob' | 'eight' | 'bowtie' | 'circuit' | 'peanut'

/**
 * How often each shape is tried (out of the total). A figure eight and a bow
 * tie bring a bridge. An eight is tried less often: it has little straight
 * road away from its crossing for the start grid, so most get thrown away,
 * and each throw costs time.
 */
const SHAPE_ODDS: readonly [RandomShape, number][] = [
  ['circuit', 0.34],
  ['blob', 0.22],
  ['eight', 0.1],
  ['bowtie', 0.22],
  ['peanut', 0.12],
]

export interface RandomOptions {
  /** The dice: the same seed always gives the same track. */
  seed: number
  /** The id the track builds under (a world with no seed takes its hills from it). */
  id: string
  /** The world's reachable radius, if the editor already knows it (from the live preview). */
  playRadius?: number
  /** Live track parameters (a bank slider), as the preview builds with. */
  params?: Record<string, number>
  /** Give up after this many shapes (default 40)... */
  maxTries?: number
  /** ...or after this long, in milliseconds (default 2500; whichever comes first, after at least one try). */
  budgetMs?: number
  /** Leave the speed trap and boost pad off. */
  noPieces?: boolean
}

/** One finished random road: what goes into the draft. */
export interface RandomPick {
  points: RoadPoint[]
  pieces: Piece[]
  startAt: number
  shape: RandomShape
  /** Metres round. */
  length: number
  /** How many crossings got a bridge. */
  bridges: number
}

export interface RandomResult {
  ok: boolean
  pick?: RandomPick
  /** Shapes tried (1 = the first one passed). */
  tries: number
  /** Milliseconds it took, all tries included. */
  ms: number
  /** Why each thrown-away shape was thrown away (for checkers and tests). */
  rejects: string[]
}

/** Small seeded random numbers (mulberry32): the same seed, the same numbers. */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TAU = Math.PI * 2

/**
 * Make a random road for draft `d`'s world (its environment and width; its
 * own road is ignored). Tries shape after shape until one passes every
 * check, within the budget. ok false only if none did (very rare: the
 * self-test counts it).
 */
export function randomTrack(d: Draft, o: RandomOptions): RandomResult {
  const t0 = performance.now()
  const maxTries = o.maxTries ?? 40
  const budget = o.budgetMs ?? 2500
  const rejects: string[] = []
  const limit = fitRadius(d.environment, d.width, o.playRadius)
  // The ground the road will ride on (the world under this id), so each bridge's top runs straight over its hills.
  const pointGround = pointGroundOf(d.environment, o.id, d.roadSettings?.surfaceSmoothing)
  let tries = 0
  while (tries < maxTries && (tries === 0 || performance.now() - t0 < budget)) {
    const roll = seededRandom(mixSeed(o.seed, tries))
    tries++
    const shape = pickShape(roll)
    const raw = drawShape(shape, roll, limit)
    const res = cleanStroke(raw, { width: d.width, bound: roadBound(d.environment), playRadius: o.playRadius ?? Infinity, smoothing: 8, fairing: 12, pointGround })
    const cleanProblem = cleanupProblem(res)
    if (cleanProblem) {
      rejects.push(`${shape}: ${cleanProblem}`)
      continue
    }
    const base: Draft = { ...d, points: res.points, pieces: [], props: [], cores: [], startAt: 0 }
    // Where the road crosses itself (metres from the start line, both passes): no start grid or piece goes near.
    const crossingS = res.crossings.flatMap((c) => [c.sA, c.sB])
    const nearCrossing = (sv: number, length: number) => crossingS.some((c) => Math.min(Math.abs(sv - c), length - Math.abs(sv - c)) < CROSSING_CLEAR)
    let check = judge(base, o)
    // The clean-up puts the start line on a straight, but a corner's banking can still lean into the
    // grid, or the straight can be the one through a bridge: move it to the flattest straight the
    // built road has, away from any crossing, and check again.
    const startNearCrossing = nearCrossing(0, res.length)
    if ((check.problem?.startsWith('start.at') || startNearCrossing) && check.runtime) {
      const at = levelStart(check.runtime, nearCrossing)
      if (at !== null) {
        base.startAt = at
        check = judge(base, o)
      } else if (startNearCrossing) check = { problem: 'the only straight start is beside a bridge', runtime: null }
    }
    if (check.problem) {
      rejects.push(`${shape}: ${check.problem}`)
      continue
    }
    // A speed trap (and a boost pad) on the longest straight, only if the checks still pass with them.
    let pieces: Piece[] = []
    if (!o.noPieces) {
      const extra = straightPieces(res.points, base.startAt, roll, nearCrossing)
      if (extra.length && !judge({ ...base, pieces: extra }, o).problem) pieces = extra
    }
    return {
      ok: true,
      pick: { points: res.points, pieces, startAt: base.startAt, shape, length: res.length, bridges: res.crossings.filter((c) => c.over !== null).length },
      tries,
      ms: performance.now() - t0,
      rejects,
    }
  }
  return { ok: false, tries, ms: performance.now() - t0, rejects }
}

/** A different seed for each try, so a failed shape never comes back on the next try. */
function mixSeed(seed: number, tryIndex: number): number {
  return (Math.imul(seed >>> 0, 2654435761) + Math.imul(tryIndex + 1, 40503)) >>> 0
}

function pickShape(roll: () => number): RandomShape {
  const total = SHAPE_ODDS.reduce((sum, [, w]) => sum + w, 0)
  let r = roll() * total
  for (const [shape, w] of SHAPE_ODDS) {
    r -= w
    if (r <= 0) return shape
  }
  return SHAPE_ODDS[0][0]
}

/**
 * How far from the middle of the world the road may reach, metres: inside
 * the world's edge limit (the same rule the track validator uses), and inside
 * the reachable circle too, so the corners of the map never poke into the
 * edge mountains or the stadium wall.
 */
function fitRadius(environment: EnvironmentSpec, width: number, playRadius?: number): number {
  const square = roadBound(environment) - 15
  const round = playRadius !== undefined && Number.isFinite(playRadius) ? playRadius - width - 30 : Infinity
  return Math.max(120, Math.min(square, round))
}

/**
 * The road as if drawn with the pencil: a closed shape (a bit past the start,
 * the way a hand closes a loop), a point every 4 m, scaled, turned and moved
 * to a random spot that keeps it inside `limit` metres of the middle.
 */
function drawShape(shape: RandomShape, roll: () => number, limit: number): P[] {
  const unit = unitShape(shape, roll)
  // Small, medium or big (a third of the time each), between SMALLEST_RADIUS and the room there is.
  // A road much smaller than that is all corner: its banking never settles, so nowhere suits a start grid.
  const most = limit * 0.96
  const least = Math.min(most, SMALLEST_RADIUS)
  const band = Math.floor(roll() * 3)
  const radius = least + (most - least) * ((band + roll()) / 3)
  const turn = roll() * TAU
  const cos = Math.cos(turn)
  const sin = Math.sin(turn)
  // Off-centre by up to the room left over.
  const room = Math.max(0, limit - radius)
  const offA = roll() * TAU
  const offR = room * Math.sqrt(roll())
  const cx = Math.cos(offA) * offR
  const cz = Math.sin(offA) * offR
  const placed = unit.map((p) => ({ x: cx + (p.x * cos - p.z * sin) * radius, z: cz + (p.x * sin + p.z * cos) * radius }))
  return evenly(placed, 4)
}

/** One lap of the shape, scaled so its furthest point is 1 from the middle. */
function unitShape(shape: RandomShape, roll: () => number): P[] {
  const out: P[] = []
  const steps = 720
  if (shape === 'circuit') {
    // Corners round a ring, each at its own distance: straights between them, the clean-up rounds the corners.
    const n = 4 + Math.floor(roll() * 5)
    const corners: P[] = []
    for (let k = 0; k < n; k++) {
      const a = ((k + (roll() - 0.5) * 0.5) / n) * TAU
      const r = 0.55 + roll() * 0.45
      corners.push({ x: Math.cos(a) * r, z: Math.sin(a) * r })
    }
    // Once round, then a little way past the first corner, the way a hand closes a loop.
    for (let k = 0; k < n; k++) {
      const a = corners[k]
      const b = corners[(k + 1) % n]
      for (let i = 0; i < 40; i++) out.push({ x: a.x + ((b.x - a.x) * i) / 40, z: a.z + ((b.z - a.z) * i) / 40 })
    }
    const a = corners[0]
    const b = corners[1 % n]
    for (let i = 0; i <= 4; i++) out.push({ x: a.x + ((b.x - a.x) * i) / 40, z: a.z + ((b.z - a.z) * i) / 40 })
    return normalise(out)
  }
  if (shape === 'bowtie') {
    // A bow tie: up one end, diagonally across the middle (where it crosses itself, and the clean-up
    // bridges it), up the other end and back across. The two ends are long straights, well away
    // from the crossing, for the start grid; the clean-up rounds the four corners for a car.
    const b = 0.5 + roll() * 0.3
    const corners: P[] = [
      { x: -1, z: -b },
      { x: -1, z: b },
      { x: 1, z: -b },
      { x: 1, z: b },
    ]
    for (let k = 0; k < 4; k++) {
      const a = corners[k]
      const c = corners[(k + 1) % 4]
      for (let i = 0; i < 60; i++) out.push({ x: a.x + ((c.x - a.x) * i) / 60, z: a.z + ((c.z - a.z) * i) / 60 })
    }
    for (let i = 0; i <= 6; i++) out.push({ x: -1, z: -b + (2 * b * i) / 60 })
    return normalise(out)
  }
  if (shape === 'eight') {
    // A figure eight: its middle crosses itself (at 70 degrees or more), and the clean-up bridges it.
    const b = 0.35 + roll() * 0.25
    const lean = (roll() - 0.5) * 0.3
    for (let i = 0; i <= steps * 1.02; i++) {
      const t = (i / steps) * TAU
      const x = Math.sin(t)
      out.push({ x: x + lean * Math.sin(2 * t) * 0.3, z: b * Math.sin(2 * t) })
    }
    return normalise(out)
  }
  // Blob and peanut: a radius that wobbles as it goes round, squashed into an oval. A peanut's
  // two-bump wave is big enough to pull its middle in (its sides curve inward), so it is barely squashed.
  const squash = shape === 'peanut' ? 0.85 + roll() * 0.15 : 0.55 + roll() * 0.45
  const waves =
    shape === 'peanut'
      ? [
          { k: 2, a: 0.3 + roll() * 0.12, p: Math.PI / 2 },
          { k: 3, a: roll() * 0.06, p: roll() * TAU },
        ]
      : [
          { k: 2, a: roll() * 0.16, p: roll() * TAU },
          { k: 3, a: roll() * 0.12, p: roll() * TAU },
          { k: 4, a: roll() * 0.05, p: roll() * TAU },
        ]
  for (let i = 0; i <= steps * 1.02; i++) {
    const t = (i / steps) * TAU
    let r = 1
    for (const w of waves) r += w.a * Math.sin(w.k * t + w.p)
    out.push({ x: Math.cos(t) * r, z: Math.sin(t) * r * squash })
  }
  return normalise(out)
}

function normalise(pts: P[]): P[] {
  const far = Math.max(...pts.map((p) => Math.hypot(p.x, p.z))) || 1
  return pts.map((p) => ({ x: p.x / far, z: p.z / far }))
}

/** The line again with a point every `step` metres (like mouse moves along a drawn line). */
function evenly(pts: readonly P[], step: number): P[] {
  const out: P[] = [pts[0]]
  let carry = 0
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    const seg = Math.hypot(b.x - a.x, b.z - a.z)
    let t = step - carry
    while (t <= seg) {
      out.push({ x: a.x + ((b.x - a.x) * t) / seg, z: a.z + ((b.z - a.z) * t) / seg })
      t += step
    }
    carry = seg - (t - step)
  }
  return out
}

/** Anything the clean-up was not happy with (a random road must come out perfect, not just usable). */
function cleanupProblem(res: CleanResult): string | null {
  if (!res.ok) return res.issues.find((i) => i.level === 'error')?.message ?? 'the clean-up refused it'
  const worry = res.issues.find((i) => i.level === 'warning' || i.level === 'error')
  if (worry) return worry.message
  if (res.crossings.some((c) => c.over === null)) return 'a crossing has no bridge'
  return null
}

/**
 * Warnings a random road may keep: "fewer billboards fit than the world asks
 * for" is about the world, not the road (the gate itself says fewer is fine).
 * Every other warning, and every failure, throws the road away.
 */
const HARMLESS_WARNINGS = new Set(['environment.roadside.billboards'])

/**
 * Build the draft with the game's real builder and run the game's checks.
 * `problem` is null if every check passes with no warning that matters,
 * otherwise what was wrong (the first failure, else the first warning).
 */
function judge(d: Draft, o: RandomOptions): { problem: string | null; runtime: TrackRuntime | null } {
  const v = validateTrack(fileOfDraft(d, o.id))
  if (!v.ok || !v.track) return { problem: `validator: ${v.errors[0]?.message ?? 'invalid'}`, runtime: null }
  if (v.warnings.length) return { problem: `validator warns: ${v.warnings[0].message}`, runtime: null }
  let runtime: TrackRuntime
  let gates: TrackGate[]
  try {
    runtime = buildTrack(v.track, o.params ?? {})
    gates = runTrackGates(runtime)
  } catch (err) {
    return { problem: `builder threw: ${(err as Error).message}`, runtime: null }
  }
  const bad = gates.find((g) => g.level === 'fail') ?? gates.find((g) => g.level === 'warn' && !HARMLESS_WARNINGS.has(g.name))
  return { problem: bad ? `${bad.name} ${bad.level}: ${bad.message}` : null, runtime }
}

/**
 * Where the start line goes on a built road: the spot whose whole grid (50 m
 * behind the line to 10 m after it, the start.at check's window) is straightest,
 * least banked and most level, if one is good enough for that check. As an
 * `at` for the track file, or null if the road has nowhere like that.
 */
function levelStart(t: TrackRuntime, nearCrossing: (s: number, length: number) => boolean): number | null {
  const x = trackInternals(t)
  if (!x) return null
  const S = t.samples
  const idx = (s: number) => ((Math.round(t.wrapS(s) / S.ds) % S.count) + S.count) % S.count
  let best: { s: number; score: number } | null = null
  for (let s = 0; s < t.length; s += 4) {
    if (nearCrossing(s, t.length)) continue
    let k = 0
    let bank = 0
    for (let sv = s - 54; sv <= s + 14; sv += 2) {
      const i = idx(sv)
      k = Math.max(k, Math.abs(S.curvature[i]))
      bank = Math.max(bank, Math.abs(S.bank[i]))
    }
    const climb = Math.abs(S.py[idx(s + 14)] - S.py[idx(s - 54)])
    // A little inside the check's own limits (radius 400 m, 3 degrees), so it passes for sure.
    if (k >= 1 / 450 || (bank * 180) / Math.PI >= 2.5 || climb > 2) continue
    const score = k * 400 + (bank * 180) / Math.PI / 3 + climb / 2
    if (!best || score < best.score) best = { s, score }
  }
  return best ? round3(x.atOfS(t.wrapS(best.s))) : null
}

/** Straight means no bend tighter than this radius, metres. */
const STRAIGHT_RADIUS = 600

/** The start grid and pieces stay this far (metres along the road) from where the road crosses itself: off the bridge and its ramps. */
const CROSSING_CLEAR = 140

/**
 * A speed trap in the middle of the longest straight (if it is long enough to
 * get up to speed), and on a long one a boost pad near its start. Never in
 * the start area, never on or under a bridge.
 */
function straightPieces(points: RoadPoint[], startAt: number, roll: () => number, nearCrossing: (s: number, length: number) => boolean): Piece[] {
  const line = roadLine(points)
  const run = longestStraight(line, points, sOf(line, startAt), nearCrossing)
  if (!run || run.length < 160) return []
  const pieces: Piece[] = [{ type: 'speedtrap', at: round3(atOf(line, run.s0 + run.length * (0.55 + roll() * 0.2))) }]
  if (run.length >= 260 && roll() < 0.7) pieces.push({ type: 'boost', at: round3(atOf(line, run.s0 + 30)) })
  return pieces
}

/** The longest stretch with no bend tighter than STRAIGHT_RADIUS, away from the start line and clear of any crossing. */
function longestStraight(line: RoadLine, points: RoadPoint[], startS: number, nearCrossing: (s: number, length: number) => boolean): { s0: number; length: number } | null {
  const step = 4
  const n = Math.floor(line.length / step)
  let best: { s0: number; length: number } | null = null
  let runStart = -1
  for (let i = 0; i <= n; i++) {
    const s = i * step
    const fromStart = Math.min(Math.abs(s - startS), line.length - Math.abs(s - startS))
    const at = atOf(line, s)
    const k = Math.floor(at) % points.length
    const raised = (points[k].lift ?? 0) > 0.05 || (points[(k + 1) % points.length].lift ?? 0) > 0.05
    const ok = i < n && fromStart > 90 && !raised && !nearCrossing(s, line.length) && tightestBetween(line, s, s).radius >= STRAIGHT_RADIUS
    if (ok && runStart < 0) runStart = s
    if (!ok && runStart >= 0) {
      const length = s - runStart
      if (!best || length > best.length) best = { s0: runStart, length }
      runStart = -1
    }
  }
  return best
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000
}
