// ============================================================
//  BRIDGES - which road goes over where the road crosses itself
// ------------------------------------------------------------
//  When a road crosses itself (a figure-eight), one side has to be
//  a bridge and the other goes underneath. The pencil's clean-up
//  picks for you (the straighter side goes over). This file lets
//  Josh pick instead: click the crossing, press Swap, and the road
//  that was on top comes down to the ground while the other one
//  rises over it.
//
//  How a swap works (swapDraft):
//    1. Find the crossing (roadCrossings): where the road's map line
//       crosses itself, and how high each pass is there, worked out
//       exactly the way the game builds the road (shape.ts
//       roadHeightAt), so it works on a copied built-in track too,
//       whose points can be 200 m apart and carry `y` heights.
//    2. Give both stretches close, even points (shape.ts densify:
//       the road does not move), so there are points to shape.
//    3. The road going up gets the clean-up's own bridge: 8 m above
//       the ground over the crossing and smooth 80 m ramps either
//       side. The road coming down is lowered to the ground over the
//       same stretch and blends back into its old heights after it.
//       Points further away are never touched, so heights set by
//       hand elsewhere stay exactly as they were.
//    4. Refuse (and say why, in plain words) rather than do half a
//       swap: a crossing too flat to bridge, the road coming back to
//       the crossing too soon, another bridge too close, a loop, ramp
//       or wall ride (or the start grid) that would end up on a
//       slope. Last, the swapped road is built with the real track
//       builder and the game's own checks run on it (the same rows as
//       `bun run tracks:check`): if any check fails that passed
//       before (a bridge too low for a car, a kink, a sudden tilt),
//       the swap is refused with that check's words.
//
//  A swap is remembered by the heights themselves: the raised road
//  is the bridge. Bend, Straight, Curve, Corner, Smooth and moving
//  points all keep every point's height, so they never flip it.
//  Redrawing a stretch with the pencil re-runs the clean-up on the
//  whole road; it is handed the old road's choices (keepOverOf) so
//  every crossing that still exists keeps the road it had on top.
//
//  Pure: points in, points out. Checked by selfTest.ts.
// ============================================================

import { TRACK_DEFAULTS, type Piece, type RoadPoint } from '../track/schema'
import { validateTrack } from '../track/validate'
import { buildTrack } from '../track/build'
import { runTrackGates, type TrackGate } from '../track/gates'
import { SURFACE_CODE, type TrackRuntime } from '../track/types'
import { CLEANUP, findCrossings } from './cleanup'
import { type P, dist } from './geom'
import type { Draft } from './draft'
import { fileOfDraft } from './draftFile'
import { gateItems } from './checks'
import { FILL_MAX } from '../track/road'
import { roadCurve, LOOP_RUN_IN } from './road'
import { type RoadLine, alongRoad, atOf, densify, dirOf, pointHeight, roadHeightAt, roadLine, sOf, sOfPoint } from './shape'

/** The ground under a road point with no `y` (see ShapeWorld.pointGround). */
export type GroundFn = (x: number, z: number) => number

/** Without a known world (the self-test's flat maths), heights are just the lifts. */
const FLAT_GROUND: GroundFn = () => 0

/** A car fits under a bridge with this much between the two road levels, metres (the game's `bridges` check). */
export const BRIDGE_GAP = 6.2

/** Below this height difference neither road is on top: they meet, metres. */
const LEVEL_GAP = 1

/** One pass of the road through a crossing. */
export interface CrossingPass {
  /** Metres along the road from point 0 (the editor's map line). */
  s: number
  /** The same spot as an `at` (control point index + fraction). */
  at: number
  /** Which way the road is heading here: 0 = north (up the map), 90 = east. */
  heading: number
  /** The road's surface height here, metres (as the game builds it). */
  height: number
}

/** A place where the road crosses itself. */
export interface RoadCrossing {
  at: P
  /** Angle between the two roads, 0..90 degrees. */
  angleDeg: number
  /** The two passes, in driving order from point 0. */
  passes: [CrossingPass, CrossingPass]
  /** Which pass is on top (0 or 1), or null if they meet at about the same height. */
  over: 0 | 1 | null
  /** Height between the two road surfaces, metres. */
  gap: number
}

// ---------------------------------------------------------------- finding crossings

const crossingMemo = new WeakMap<readonly RoadPoint[], { ground: GroundFn; list: RoadCrossing[] }>()

/** Compass heading of a direction on the map (0 = north, -z; 90 = east, +x). */
function headingOf(dir: P): number {
  const deg = (Math.atan2(dir.x, -dir.z) * 180) / Math.PI
  return (deg + 360) % 360
}

/** Every place the road crosses itself, with how high each pass is. Worked out once per road. */
export function roadCrossings(points: readonly RoadPoint[], ground: GroundFn = FLAT_GROUND): RoadCrossing[] {
  const memo = crossingMemo.get(points)
  if (memo && memo.ground === ground) return memo.list
  const list = points.length >= 4 ? crossingsOn(roadLine(points), ground) : []
  crossingMemo.set(points, { ground, list })
  return list
}

function crossingsOn(line: RoadLine, ground: GroundFn): RoadCrossing[] {
  // The map line the editor draws is the same sampled curve roadLine measures, so s agrees.
  return findCrossings(line.rc.curve).map((c) => {
    const pass = (s: number): CrossingPass => {
      const at = atOf(line, s)
      return { s, at, heading: headingOf(dirOf(line, s)), height: roadHeightAt(line.points, at, ground) }
    }
    const passes: [CrossingPass, CrossingPass] = [pass(c.sA), pass(c.sB)]
    const gap = Math.abs(passes[0].height - passes[1].height)
    const over = gap < LEVEL_GAP ? null : passes[0].height > passes[1].height ? 0 : 1
    return { at: c.at, angleDeg: c.angleDeg, passes, over, gap }
  })
}

/** The crossing nearest a map spot, if one is within `within` metres. */
export function crossingNear(list: readonly RoadCrossing[], spot: P, within = 30): { crossing: RoadCrossing; index: number } | null {
  let best: { crossing: RoadCrossing; index: number } | null = null
  let bestD = within
  list.forEach((c, index) => {
    const d = dist(c.at, spot)
    if (d <= bestD) {
      bestD = d
      best = { crossing: c, index }
    }
  })
  return best
}

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west']

/** "north-east": a heading in words (map up is north). */
export function compassWord(heading: number): string {
  return COMPASS[Math.round((((heading % 360) + 360) % 360) / 45) % 8]
}

/**
 * Road raised by hand with `lift` that is not at a crossing: each stretch
 * raised a metre or more whose top reaches 6 m (FILL_MAX: below that the game
 * fills the ground up to the road, so it is a crest, not a bridge), and that
 * is more than 150 m from every crossing (those have their own label).
 * Returns the index of each stretch's highest point.
 */
export function raisedTops(points: readonly RoadPoint[], crossings: readonly RoadCrossing[]): number[] {
  const n = points.length
  const lift = (i: number) => points[((i % n) + n) % n].lift ?? 0
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    if (lift(i) < 1 || lift(i - 1) >= 1) continue
    let top = i
    for (let k = 0; k < n && lift(i + k) >= 1; k++) if (lift(i + k) > lift(top)) top = i + k
    const t = top % n
    if (lift(t) < FILL_MAX) continue
    if (crossings.some((c) => dist(c.at, points[t]) < 150)) continue
    out.push(t)
  }
  return out
}

/** How many bridges the road has: crossings with a road on top, plus raised road away from any crossing. */
export function bridgeCount(points: readonly RoadPoint[], crossings: readonly RoadCrossing[]): number {
  return crossings.filter((c) => c.over !== null).length + raisedTops(points, crossings).length
}

// ---------------------------------------------------------------- the bridge's shape (the clean-up's own)

/** How a bridge over a crossing at this angle is shaped: the same numbers the clean-up uses. */
export function bridgeShape(angleDeg: number, width: number): { flat: number; ramp: number; lift: number } {
  // Full height over the other road's width plus 3 m each side (longer the flatter they cross), then the ramps.
  const flat = (width / 2 + 3) / Math.sin((Math.max(angleDeg, 1) * Math.PI) / 180) + 4
  return { flat, ramp: CLEANUP.bridgeRamp, lift: CLEANUP.bridgeLift }
}

/** 1 over the flat middle of a bridge, easing smoothly to 0 at the foot of each ramp (the clean-up's liftAt). */
function rampWeight(d: number, flat: number, ramp: number): number {
  if (d <= flat) return 1
  if (d >= flat + ramp) return 0
  const t = 1 - (d - flat) / ramp
  return 0.5 - 0.5 * Math.cos(Math.PI * t)
}

// ---------------------------------------------------------------- swapping

export interface SwapInput {
  points: readonly RoadPoint[]
  pieces: readonly Piece[]
  startAt: number
  /** Road width, metres. */
  width: number
  /** The ground under road points (exact, from the draft's world); without it, flat ground. */
  pointGround?: GroundFn
}

export interface SwapPlan {
  ok: boolean
  /** The new road points (the old ones, untouched, when refused). */
  points: RoadPoint[]
  /** Moves an `at` on the old road (a piece, the start line) to the same spot on the new one. */
  mapAt: (at: number) => number
  /** Why not, in plain words (when refused). */
  reason?: string
  /** The pass that goes over now and the one that goes under, as they were on the old road. */
  up?: CrossingPass
  down?: CrossingPass
}

/** Heights to the centimetre (like the shaping tools). */
function roundCm(v: number): number {
  return Math.round(v * 100) / 100
}

function refuse(points: readonly RoadPoint[], reason: string): SwapPlan {
  return { ok: false, points: points.map((p) => ({ ...p })), mapAt: (at) => at, reason }
}

const PIECE_WORDS: Partial<Record<Piece['type'], string>> = { loop: 'loop', ramp: 'ramp', wallride: 'wall ride' }

/**
 * Put pass `up` (0 or 1, in driving order) of the crossing nearest `spot`
 * on top, and bring the other down to the ground there. Only the shape of
 * the road is worked out here; swapDraft also builds it and runs the game's
 * checks. Refuses (points untouched) if it can't be done cleanly.
 */
export function planSwap(input: SwapInput, spot: P, up: 0 | 1, rampMetres: number = CLEANUP.bridgeRamp): SwapPlan {
  const ground = input.pointGround ?? FLAT_GROUND
  const original = input.points
  const found = crossingNear(roadCrossings(original, ground), spot)
  if (!found) return refuse(original, "There's no crossing there any more. Click a BRIDGE label on the map.")
  const c0 = found.crossing
  if (c0.angleDeg < CLEANUP.minCrossDeg) {
    return refuse(original, `These two roads cross at a very flat angle (${Math.round(c0.angleDeg)} degrees), too flat for either one to be a bridge. Redraw one so they cross more squarely.`)
  }
  const { flat, lift } = bridgeShape(c0.angleDeg, input.width)
  const ramp = rampMetres
  // The road coming down is held on the ground as far as the bridge's ramps reach, then blends back over one more ramp.
  const downFull = flat + ramp

  // Close, even points all round (like the shaping tools' evenRoad), so the ramps have points to shape.
  // The whole road, not just the two stretches: the game's curve through a point depends on the points
  // either side, so a short new gap next to a long old one would bend the road beside it. Each new point
  // gets the road's own height there, so the road stays where it was (a few centimetres at most).
  const even = densify(roadLine(original), 0, roadLine(original).length, 20, CLEANUP.spacing, { pointGround: input.pointGround })
  const points = even.points
  const mapAt = even.mapAt
  const line = roadLine(points)
  const L = line.length
  const now = crossingNear(crossingsOn(line, ground), c0.at)
  if (!now) return refuse(original, "There's no crossing there any more. Click a BRIDGE label on the map.")
  const c = now.crossing
  const upS = c.passes[up].s
  const downS = c.passes[1 - up].s

  // New heights, point by point.
  let clash = false
  const next = points.map((p, k) => {
    const s = sOfPoint(line, k)
    const wUp = rampWeight(alongRoad(s, upS, L), flat, ramp)
    const dDown = alongRoad(s, downS, L)
    const wDown = dDown <= downFull ? 1 : rampWeight(dDown - downFull, 0, ramp)
    if (wUp <= 0 && wDown <= 0) return p
    const g = ground(p.x, p.z)
    const oldLift = pointHeight(p, ground) - g
    let newLift = oldLift
    if (wUp > 0) {
      // This point has to rise for the bridge; if it also has to stay down for the road below, it can't be done.
      if (wDown >= 1 || (wDown > 0 && Math.abs(oldLift) > 0.05)) clash = true
      newLift = Math.max(oldLift, lift * wUp)
    } else newLift = oldLift * (1 - wDown)
    if (Math.abs(newLift - oldLift) < 0.005) return p
    const out: RoadPoint = { ...p }
    if (typeof p.y === 'number') out.y = roundCm(g + newLift)
    else {
      const l = roundCm(newLift)
      if (l === 0) delete out.lift
      else out.lift = l
    }
    return out
  })
  if (clash) {
    return refuse(original, 'The road comes back round to this crossing too soon: there is no room for one road to ramp up while the other ramps down. Make the loop between them bigger.')
  }

  // How much the road's height changed at a spot on the OLD road.
  const oldLine = roadLine(original)
  const change = (atOld: number) => roadHeightAt(next, mapAt(atOld), ground) - roadHeightAt(original, atOld, ground)
  const changeAlong = (atOld: number, from: number, to: number) => {
    const s0 = sOf(oldLine, atOld)
    let worst = 0
    for (let d = from; d <= to; d += 5) worst = Math.max(worst, Math.abs(change(atOf(oldLine, s0 + d))))
    return worst
  }

  // Other crossings: a bridge there must not be lowered, a road under one must not be raised.
  for (const o of roadCrossings(original, ground)) {
    if (dist(o.at, c0.at) < 1 || o.over === null) continue
    for (const k of [0, 1] as const) {
      const delta = change(o.passes[k].at)
      if ((o.over === k && delta < -0.3) || (o.over !== k && delta > 0.3)) {
        return refuse(original, 'Another crossing is too close along the road: changing the heights here would squash the bridge there. Spread the two crossings further apart.')
      }
    }
  }

  // Pieces that need their road to stay as it is: loops, ramps and wall rides.
  for (const piece of input.pieces) {
    const word = PIECE_WORDS[piece.type]
    if (!word) continue
    const span =
      piece.type === 'loop'
        ? [-(LOOP_RUN_IN + 10), LOOP_RUN_IN + 5 * (piece.radius ?? TRACK_DEFAULTS.loopRadius)]
        : piece.type === 'wallride'
        ? [0, piece.length ?? TRACK_DEFAULTS.wallride.length]
        : [-30, 30]
    if (changeAlong(piece.at, span[0], span[1]) > 0.3) {
      return refuse(original, `A ${word} is too close to this crossing: the road under it would have to tip up or down. Move the ${word} further away first.`)
    }
  }
  // The start grid needs flat road from 70 m behind the line to 25 m after it.
  if (changeAlong(input.startAt, -70, 25) > 0.3) {
    return refuse(original, 'The start line is too close to this crossing: the cars on the grid need flat road. Move the start line further away first (Place pieces, Start line).')
  }

  return { ok: true, points: next, mapAt, up: c0.passes[up], down: c0.passes[1 - up] }
}

// ---------------------------------------------------------------- the built road

/**
 * At a crossing on the BUILT road: the height between the two levels, and
 * whether the pass heading `heading` is the upper one. null if the built
 * road has no two levels there.
 */
export function builtGapAt(t: TrackRuntime, spot: P, heading: number): { gap: number; upperMatches: boolean } | null {
  const S = t.samples
  const near: number[] = []
  for (let i = 0; i < S.count; i++) {
    if (S.surface[i] === SURFACE_CODE.loop) continue
    if (Math.hypot(S.px[i] - spot.x, S.pz[i] - spot.z) < 4) near.push(i)
  }
  // Two passes: samples more than 80 m apart along the road.
  const groups: number[][] = []
  for (const i of near) {
    const g = groups.find((list) => Math.abs(t.deltaS(list[0] * S.ds, i * S.ds)) < 80)
    if (g) g.push(i)
    else groups.push([i])
  }
  if (groups.length < 2) return null
  const closest = (list: number[]) => list.reduce((a, b) => (Math.hypot(S.px[a] - spot.x, S.pz[a] - spot.z) <= Math.hypot(S.px[b] - spot.x, S.pz[b] - spot.z) ? a : b))
  const [a, b] = [closest(groups[0]), closest(groups[1])]
  const upper = S.py[a] >= S.py[b] ? a : b
  const h = (headingOf({ x: S.tx[upper], z: S.tz[upper] }) - heading + 360) % 360
  return { gap: Math.abs(S.py[a] - S.py[b]), upperMatches: h < 90 || h > 270 }
}

/** Build a draft into a real track and run the game's checks on it (the same rows as `bun run tracks:check`). */
export function buildAndCheck(d: Draft, id: string, params: Record<string, number> = {}): { runtime: TrackRuntime | null; gates: TrackGate[]; error?: string } {
  const v = validateTrack(fileOfDraft(d, id))
  if (!v.ok || !v.track) return { runtime: null, gates: [], error: v.errors[0]?.message ?? 'the track has a problem' }
  try {
    const runtime = buildTrack(v.track, params)
    return { runtime, gates: runTrackGates(runtime) }
  } catch (err) {
    return { runtime: null, gates: [], error: (err as Error).message }
  }
}

export interface SwapResult {
  ok: boolean
  /** The draft after the swap (only when ok). */
  draft?: Draft
  /** Why not, in plain words. */
  reason?: string
  /** What happened, in plain words (when ok). */
  done?: string
  /** The built road's gap at the crossing after the swap, metres. */
  gap?: number
}

export interface SwapOptions {
  /** The id the draft builds under (its world's hills are seeded from it when it has no seed). */
  id: string
  pointGround?: GroundFn
  /** Live track parameters (a bank slider), as the preview builds with. */
  params?: Record<string, number>
  /** The game's checks on the draft as it is now, if already known (saves a build). */
  gatesBefore?: readonly TrackGate[]
}

/**
 * Swap which road goes over at the crossing nearest `spot`: the road on top
 * comes down, the other goes over. (At a crossing where the roads meet on
 * the level, the straighter-looking first pass is tried, then the other.)
 * Returns the new draft, or why not. Never changes `d`.
 */
export function swapDraft(d: Draft, spot: P, o: SwapOptions): SwapResult {
  const ground = o.pointGround ?? FLAT_GROUND
  const found = crossingNear(roadCrossings(d.points, ground), spot)
  if (!found) return { ok: false, reason: "There's no crossing there any more. Click a BRIDGE label on the map." }
  const c = found.crossing
  const tries: (0 | 1)[] = c.over === null ? [0, 1] : [c.over === 0 ? 1 : 0]
  let firstReason = ''
  for (const up of tries) {
    const res = tryOneWay(d, spot, up, o)
    if (res.ok) return res
    firstReason ||= res.reason ?? ''
  }
  return { ok: false, reason: firstReason }
}

/**
 * Ramp lengths to try, metres: the clean-up's own first; if the game's checks
 * don't like the result, gentler (longer) ones. A longer ramp needs more road
 * clear of other crossings and pieces, so the plan is checked again each time.
 */
const RAMP_LADDER = [CLEANUP.bridgeRamp, 100, 120]

/**
 * Checks whose failure is the game's own fault, never the track's (their fix line
 * says "builder bug"). A swap they refuse gets honest words: it isn't Josh's road.
 */
const GAME_BUG_CHECKS = new Set(['winding', 'tracking', 'ground', 'under', 'surface', 'checks'])

function tryOneWay(d: Draft, spot: P, up: 0 | 1, o: SwapOptions): SwapResult {
  let before: readonly TrackGate[] | null = o.gatesBefore ?? null
  let firstReason = ''
  for (const ramp of RAMP_LADDER) {
    const plan = planSwap({ points: d.points, pieces: d.pieces, startAt: d.startAt, width: d.width, pointGround: o.pointGround }, spot, up, ramp)
    if (!plan.ok || !plan.up || !plan.down) {
      // Something on the road is in the way: a longer ramp would only be more in the way.
      return { ok: false, reason: firstReason || `Can't swap this bridge. ${plan.reason} Nothing changed.` }
    }
    const next: Draft = {
      ...d,
      points: plan.points,
      pieces: d.pieces.map((p) => ({ ...p, at: Math.round(plan.mapAt(p.at) * 1000) / 1000 })),
      startAt: Math.round(plan.mapAt(d.startAt) * 1000) / 1000,
    }
    const after = buildAndCheck(next, o.id, o.params)
    if (!after.runtime) {
      firstReason ||= `Can't swap this bridge: the game couldn't build the road that way (${after.error}). Nothing changed.`
      continue
    }
    before ??= buildAndCheck(d, o.id, o.params).gates
    const failedBefore = new Set(before.filter((g) => g.level === 'fail').map((g) => g.name))
    const fresh = after.gates.filter((g) => g.level === 'fail' && !failedBefore.has(g.name))
    // This crossing itself, measured on the built road: the right road on top, with room for a car.
    const built = builtGapAt(after.runtime, spot, plan.up.heading)
    if (!fresh.length && built && built.upperMatches && built.gap >= BRIDGE_GAP) {
      return {
        ok: true,
        draft: next,
        gap: built.gap,
        done: `Swapped: the road heading ${compassWord(plan.up.heading)} goes over now, and the road heading ${compassWord(plan.down.heading)} goes under it. Undo puts it back.`,
      }
    }
    if (firstReason) continue
    const title = (g: TrackGate) => gateItems([g], next, roadCurve(next.points)).find((it) => it.tone === 'bad')?.title ?? `The ${g.name} check fails that way.`
    const track = fresh.find((g) => !GAME_BUG_CHECKS.has(g.name))
    if (track || !built || !built.upperMatches || built.gap < BRIDGE_GAP) {
      const words = track ? title(track) : 'A bridge is too low for a car to fit underneath.'
      firstReason = `Can't swap this bridge: the other road doesn't fit over here. ${words} Nothing changed.`
    } else {
      firstReason = `Can't swap this bridge: the game can't build it cleanly that way yet. ${title(fresh[0])} That's a game bug, not your track. Nothing changed.`
    }
  }
  return { ok: false, reason: firstReason }
}

// ---------------------------------------------------------------- remembering through a redraw

/** Which road is on top at a crossing, remembered by place and direction (for the clean-up, see keepOverOf). */
export interface OverChoice {
  at: P
  /** Heading of the road that goes over (0 = north). */
  heading: number
}

/**
 * The road on top at every bridged crossing of this road. Redrawing a stretch
 * re-runs the clean-up on the whole road; handing it these keeps every
 * crossing that is still there the way it was (a swap stays swapped).
 */
export function keepOverOf(points: readonly RoadPoint[], ground: GroundFn = FLAT_GROUND): OverChoice[] {
  return roadCrossings(points, ground)
    .filter((c) => c.over !== null)
    .map((c) => ({ at: c.at, heading: c.passes[c.over as 0 | 1].heading }))
}

/** Of two headings, which matches `want` best (0 or 1), or null if neither is within 60 degrees. */
export function matchHeading(want: number, a: number, b: number): 0 | 1 | null {
  const off = (h: number) => {
    const d = Math.abs((((h - want) % 360) + 540) % 360 - 180)
    return d
  }
  const da = off(a)
  const db = off(b)
  if (Math.min(da, db) > 60) return null
  return da <= db ? 0 : 1
}

export { headingOf }
