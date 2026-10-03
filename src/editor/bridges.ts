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
//       the ground over the crossing and smooth 200 m ramps either
//       side. The road coming down is lowered to the ground over the
//       same stretch and blends back into its old heights over 60 m after it.
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
//  An underpass (underDraft) is the same idea the other way up: the
//  chosen road dips UNDER_DEPTH metres into the ground on the same
//  smooth ramps, through a cutting the game digs for it, and the
//  other road comes down to the ground and crosses the cutting on
//  its own short bridge (the builder makes that bit a bridge by
//  itself: road.ts, "over a cutting").
//
//  A swap is remembered by the heights themselves: the raised road
//  is the bridge, and a sunken road is an underpass. Bend, Straight, Curve, Corner, Smooth and moving
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
import { SURFACE_CODE, type NearestHit, type TrackRuntime } from '../track/types'
import { CREST_CHECK_KMH, CREST_LIMIT } from '../track/bankRolls'
import { crestHalf, crestShareAt } from '../track/cuttings'
import { CLEANUP, findCrossings } from './cleanup'
import { type P, dist } from './geom'
import type { Draft } from './draft'
import { fileOfDraft } from './draftFile'
import { gateItems } from './checks'
import { FILL_MAX, WALL_REACH } from '../track/road'
import { roadCurve, LOOP_RUN_IN } from './road'
import { type RoadLine, alongRoad, atOf, densify, dirOf, pointHeight, posOf, roadHeightAt, roadLine, sOf, sOfPoint } from './shape'

/** The ground under a road point with no `y` (see ShapeWorld.pointGround). */
export type GroundFn = (x: number, z: number) => number

/** Without a known world (the self-test's flat maths), heights are just the lifts. */
const FLAT_GROUND: GroundFn = () => 0

/** A car fits under a bridge with this much between the two road levels, metres (the game's `bridges` check). */
export const BRIDGE_GAP = 6.2

/** Past a crossing's ramps, the road held on the ground blends back into its old heights over this many metres. */
const HOLD_BLEND = 60

/** Below this height difference neither road is on top: they meet, metres. */
const LEVEL_GAP = 1

/** How far an underpass's road dips below the ground, metres: the clean-up's bridge height, the other way down. */
export const UNDER_DEPTH = CLEANUP.bridgeLift

/**
 * A crossing whose lower road sits at least this far below the ground is an
 * underpass (the lower road is in a cutting), not a bridge, metres.
 */
export const UNDERPASS_MIN_DEPTH = 3

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
  /** How far it is above the ground here, metres (negative: below it, in a cutting). */
  lift: number
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
  /**
   * What kind of crossing it is: 'bridge' (the upper road is up in the air),
   * 'underpass' (the lower road dips into a cutting under the other, which
   * stays on the ground), or null where the roads meet.
   */
  kind: CrossingKind | null
}

/** A bridge (the upper road goes up) or an underpass (the lower road goes down). */
export type CrossingKind = 'bridge' | 'underpass'

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
    // Both passes stand over the same patch of ground.
    const g = ground(c.at.x, c.at.z)
    const pass = (s: number): CrossingPass => {
      const at = atOf(line, s)
      const height = roadHeightAt(line.points, at, ground)
      return { s, at, heading: headingOf(dirOf(line, s)), height, lift: height - g }
    }
    const passes: [CrossingPass, CrossingPass] = [pass(c.sA), pass(c.sB)]
    const gap = Math.abs(passes[0].height - passes[1].height)
    const over = gap < LEVEL_GAP ? null : passes[0].height > passes[1].height ? 0 : 1
    const kind = over === null ? null : passes[over === 0 ? 1 : 0].lift <= -UNDERPASS_MIN_DEPTH ? 'underpass' : 'bridge'
    return { at: c.at, angleDeg: c.angleDeg, passes, over, gap, kind }
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

/**
 * How many bridges the road has: crossings with a road on top. Raised road away from any
 * crossing is a hill (the map labels it RAISED), not a bridge, so it isn't counted.
 */
export function bridgeCount(_points: readonly RoadPoint[], crossings: readonly RoadCrossing[]): number {
  return crossings.filter((c) => c.over !== null).length
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
  /** Which pass was on top before (0 or 1), or null where the roads met. */
  wasOver?: 0 | 1 | null
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
  return planCrossing(input, spot, up, rampMetres, 'bridge')
}

/**
 * Send pass `under` (0 or 1, in driving order) of the crossing nearest `spot`
 * under the other one: it dips UNDER_DEPTH metres below the ground on the
 * clean-up's ramps (the game digs a cutting for it), and the other road comes
 * down to the ground there (the game makes the bit over the cutting a short
 * bridge). Only the shape; underDraft also builds it and runs the game's checks.
 */
export function planUnder(input: SwapInput, spot: P, under: 0 | 1, rampMetres: number = CLEANUP.bridgeRamp): SwapPlan {
  return planCrossing(input, spot, under, rampMetres, 'underpass')
}

/**
 * The shared shape of a swap and an underpass. `chosen` is the pass that moves:
 * up onto a bridge ('bridge'), or down into a cutting ('underpass'). The other
 * pass is held on the ground through the crossing either way.
 */
function planCrossing(input: SwapInput, spot: P, chosen: 0 | 1, rampMetres: number, kind: CrossingKind): SwapPlan {
  const ground = input.pointGround ?? FLAT_GROUND
  const original = input.points
  const found = crossingNear(roadCrossings(original, ground), spot)
  if (!found) return refuse(original, "There's no crossing there any more. Click a BRIDGE label on the map.")
  const c0 = found.crossing
  if (c0.angleDeg < CLEANUP.minCrossDeg) {
    return refuse(
      original,
      kind === 'bridge'
        ? `These two roads cross at a very flat angle (${Math.round(c0.angleDeg)} degrees), too flat for either one to be a bridge. Redraw one so they cross more squarely.`
        : `These two roads cross at a very flat angle (${Math.round(c0.angleDeg)} degrees), too flat for one to go under the other. Redraw one so they cross more squarely.`,
    )
  }
  const { flat, lift } = bridgeShape(c0.angleDeg, input.width)
  // A bridge goes up by the clean-up's height; an underpass goes down by the same.
  const depth = UNDER_DEPTH
  const ramp = rampMetres
  // The road held on the ground is held there as far as the moving road's ramps reach (its own old bridge,
  // if it was one, reached about as far), then blends back into its old heights over HOLD_BLEND metres: a
  // hill set by hand beyond that stays exactly as it was.
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
  // The moving road (up onto the bridge, or down into the cutting) and the one held on the ground.
  const moveS = c.passes[chosen].s
  const holdS = c.passes[1 - chosen].s

  // New heights, point by point.
  let clash = false
  const next = points.map((p, k) => {
    const s = sOfPoint(line, k)
    const dMove = alongRoad(s, moveS, L)
    const wMove = rampWeight(dMove, flat, ramp)
    const dHold = alongRoad(s, holdS, L)
    const wHold = dHold <= downFull ? 1 : rampWeight(dHold - downFull, 0, HOLD_BLEND)
    // An underpass's road also comes down off any old bridge of its own first (the same reach and blend as the held road).
    const wSelf = kind === 'underpass' ? (dMove <= downFull ? 1 : rampWeight(dMove - downFull, 0, HOLD_BLEND)) : 0
    if (wMove <= 0 && wHold <= 0 && wSelf <= 0) return p
    const g = ground(p.x, p.z)
    const oldLift = pointHeight(p, ground) - g
    let newLift = oldLift
    if (wMove > 0) {
      // This point has to move for the crossing; if it also has to stay on the ground for the other road, it can't be done.
      if (wHold >= 1 || (wHold > 0 && Math.abs(oldLift) > 0.05)) clash = true
      if (kind === 'bridge') newLift = Math.max(oldLift, lift * wMove)
      else newLift = Math.min(oldLift > 0 ? oldLift * (1 - wSelf) : oldLift, -depth * wMove)
    } else {
      // Held on the ground (the other road), or the moving road's old raised heights eased down beside its dip.
      const w = Math.max(wHold, oldLift > 0 ? wSelf : 0)
      newLift = oldLift * (1 - w)
    }
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
    return refuse(
      original,
      kind === 'bridge'
        ? 'The road comes back round to this crossing too soon: there is no room for one road to ramp up while the other ramps down. Make the loop between them bigger.'
        : 'The road comes back round to this crossing too soon: there is no room for one road to dip down while the other stays on the ground. Make the loop between them bigger.',
    )
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
        ? [-WALL_REACH, (piece.length ?? TRACK_DEFAULTS.wallride.length) + WALL_REACH]
        : [-30, 30]
    if (changeAlong(piece.at, span[0], span[1]) > 0.3) {
      return refuse(original, `A ${word} is too close to this crossing: the road under it would have to tip up or down. Move the ${word} further away first.`)
    }
  }
  // The start grid needs flat road from 70 m behind the line to 25 m after it.
  if (changeAlong(input.startAt, -70, 25) > 0.3) {
    return refuse(original, 'The start line is too close to this crossing: the cars on the grid need flat road. Move the start line further away first (Place pieces, Start line).')
  }

  const other = c0.passes[1 - chosen]
  const wasOver = c0.over
  return kind === 'bridge' ? { ok: true, points: next, mapAt, up: c0.passes[chosen], down: other, wasOver } : { ok: true, points: next, mapAt, up: other, down: c0.passes[chosen], wasOver }
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
 * don't like the result, gentler (longer) ones; where neither has room (another
 * crossing, a piece or the start grid in the way), the clean-up's shorter ones.
 * Each length is planned and checked again.
 */
const RAMP_LADDER = [CLEANUP.bridgeRamp, CLEANUP.bridgeRamp + 40, CLEANUP.bridgeRampShort]

/**
 * Checks whose failure is the game's own fault, never the track's (their fix line
 * says "builder bug"). A swap they refuse gets honest words: it isn't Josh's road.
 */
const GAME_BUG_CHECKS = new Set(['winding', 'tracking', 'ground', 'under', 'surface', 'cutting', 'checks'])

/** Put pass `up` of the crossing at `spot` on top (fixes.ts uses it to raise a low bridge's upper road). */
export function tryOneWay(d: Draft, spot: P, up: 0 | 1, o: SwapOptions): SwapResult {
  return tryCrossing(d, spot, up, o, 'bridge')
}

/**
 * Send pass `under` of the crossing at `spot` under the other road: it dips
 * into a cutting and the other road crosses it on the ground (on a short
 * bridge over the cutting). Built and checked like a swap; one Undo step in
 * the editor. Returns the new draft, or why not. Never changes `d`.
 */
export function underDraft(d: Draft, spot: P, under: 0 | 1, o: SwapOptions): SwapResult {
  return tryCrossing(d, spot, under, o, 'underpass')
}

/**
 * At a crossing where the roads meet on the level: send one road under the other
 * (the first pass from the start line, then the other). Like swapDraft's "Make a
 * bridge here", the other way down.
 */
export function underEither(d: Draft, spot: P, o: SwapOptions): SwapResult {
  let firstReason = ''
  for (const under of [0, 1] as const) {
    const res = underDraft(d, spot, under, o)
    if (res.ok) return res
    firstReason ||= res.reason ?? ''
  }
  return { ok: false, reason: firstReason }
}

/** The words a refusal starts with, for each kind. */
const CANT: Record<CrossingKind, string> = { bridge: "Can't swap this bridge", underpass: "Can't send this road under" }

/**
 * Move pass `chosen` of the crossing at `spot` (up onto a bridge, or down into
 * an underpass), build it, run the game's checks, and keep it only if nothing
 * new fails and the right road ends up on top with room for a car. Gentler
 * ramps are tried if the first ones don't pass.
 */
function tryCrossing(d: Draft, spot: P, chosen: 0 | 1, o: SwapOptions, kind: CrossingKind): SwapResult {
  let before: readonly TrackGate[] | null = o.gatesBefore ?? null
  // Ramps as long as the crossing's own first (so swapping back gives back the very same bridge), then the ladder.
  const own = ownRamp(d.points, spot, d.width, o.pointGround ?? FLAT_GROUND)
  const ladder = [...new Set([...(own === null ? [] : [own]), ...RAMP_LADDER])]
  // The road as it is now, built (for the take-off rule: where it already asked more, it may keep that).
  let beforeRun: TrackRuntime | null | undefined
  let firstReason = ''
  const cant = CANT[kind]
  for (const ramp of ladder) {
    const plan = planCrossing({ points: d.points, pieces: d.pieces, startAt: d.startAt, width: d.width, pointGround: o.pointGround }, spot, chosen, ramp, kind)
    if (!plan.ok || !plan.up || !plan.down) {
      // Something on the road is in the way: a longer ramp would only be more in the way, a shorter one may fit.
      firstReason ||= `${cant}. ${plan.reason} Nothing changed.`
      continue
    }
    const next: Draft = {
      ...d,
      points: plan.points,
      pieces: d.pieces.map((p) => ({ ...p, at: Math.round(plan.mapAt(p.at) * 1000) / 1000 })),
      startAt: Math.round(plan.mapAt(d.startAt) * 1000) / 1000,
    }
    const after = buildAndCheck(next, o.id, o.params)
    if (!after.runtime) {
      firstReason ||= `${cant}: the game couldn't build the road that way (${after.error}). Nothing changed.`
      continue
    }
    before ??= buildAndCheck(d, o.id, o.params).gates
    const failedBefore = new Set(before.filter((g) => g.level === 'fail').map((g) => g.name))
    const fresh = after.gates.filter((g) => g.level === 'fail' && !failedBefore.has(g.name))
    // This crossing itself, measured on the built road: the right road on top, with room for a car.
    const built = builtGapAt(after.runtime, spot, plan.up.heading)
    // And a car stays on over the top of the new ramps (the Height tool's and the dips check's rule).
    let flies: { kmh: number } | null = null
    if (!fresh.length && built && built.upperMatches && built.gap >= BRIDGE_GAP) {
      if (beforeRun === undefined) beforeRun = buildAndCheck(d, o.id, o.params).runtime
      flies = takesOff(after.runtime, beforeRun, spot, kind, bridgeShape(c0Angle(plan), d.width).flat + ramp)
    }
    if (!fresh.length && built && built.upperMatches && built.gap >= BRIDGE_GAP && !flies) {
      return {
        ok: true,
        draft: next,
        gap: built.gap,
        done:
          kind === 'bridge' && plan.wasOver === chosen
            ? `Made it a bridge: the road heading ${compassWord(plan.up.heading)} goes over on an ${CLEANUP.bridgeLift} m bridge, and the road heading ${compassWord(plan.down.heading)} goes under it on the ground. Undo puts it back.`
            : kind === 'bridge'
            ? `Swapped: the road heading ${compassWord(plan.up.heading)} goes over now, and the road heading ${compassWord(plan.down.heading)} goes under it. Undo puts it back.`
            : `Sent under: the road heading ${compassWord(plan.down.heading)} dips ${UNDER_DEPTH} m down into a cutting, and the road heading ${compassWord(plan.up.heading)} stays on the ground and crosses over it. Undo puts it back.`,
      }
    }
    if (firstReason) continue
    if (flies) {
      firstReason =
        kind === 'bridge'
          ? `${cant}: there's no room here for ramps gentle enough. A car at ${Math.round(flies.kmh / 10) * 10} km/h would take off over the top of the bridge. Give the road more room either side of the crossing. Nothing changed.`
          : `${cant}: there's no room here for ramps gentle enough. A car at ${Math.round(flies.kmh / 10) * 10} km/h would take off over the lip of the dip. Give the road more room either side of the crossing. Nothing changed.`
      continue
    }
    const title = (g: TrackGate) => gateItems([g], next, roadCurve(next.points)).find((it) => it.tone === 'bad')?.title ?? `The ${g.name} check fails that way.`
    const track = fresh.find((g) => !GAME_BUG_CHECKS.has(g.name))
    if (track || !built || !built.upperMatches || built.gap < BRIDGE_GAP) {
      const words = track ? title(track) : kind === 'bridge' ? 'A bridge is too low for a car to fit underneath.' : 'There would be too little room under the other road for a car.'
      firstReason = kind === 'bridge' ? `${cant}: the other road doesn't fit over here. ${words} Nothing changed.` : `${cant} here: ${lowerFirst(words)} Nothing changed.`
    } else {
      firstReason = `${cant}: the game can't build it cleanly that way yet. ${title(fresh[0])} That's a game bug, not your track. Nothing changed.`
    }
  }
  return { ok: false, reason: firstReason }
}

/**
 * How long the ramps of the crossing at `spot` are now, if they are one of the ladder's lengths
 * (within 15 m): measured along whichever road is off the ground there (up on a bridge, or down
 * in an underpass), out each way to where it is back on the ground. null if neither is.
 */
function ownRamp(points: readonly RoadPoint[], spot: P, width: number, ground: GroundFn): number | null {
  const c = crossingNear(roadCrossings(points, ground), spot)?.crossing
  if (!c || c.over === null) return null
  const pass = c.kind === 'underpass' ? c.passes[c.over === 0 ? 1 : 0] : c.passes[c.over]
  const line = roadLine(points)
  const off = (s: number) => {
    const p = posOf(line, s)
    return Math.abs(roadHeightAt(points, atOf(line, s), ground) - ground(p.x, p.z)) > 0.05
  }
  let reach = 0
  for (const dir of [-1, 1]) {
    let d = 0
    while (d < 400 && off(pass.s + dir * (d + 2))) d += 2
    reach += d / 2
  }
  const ramp = reach - bridgeShape(c.angleDeg, width).flat
  const known = RAMP_LADDER.find((r) => Math.abs(r - ramp) <= 15)
  return known ?? null
}

/** The crossing angle a plan was made at (its moved pass and the other cross at this many degrees). */
function c0Angle(plan: SwapPlan): number {
  if (!plan.up || !plan.down) return 90
  const d = Math.abs((((plan.up.heading - plan.down.heading) % 180) + 180) % 180)
  return d > 90 ? 180 - d : d
}

/**
 * Does the moved road throw a car off at the top of its new ramps? Over the moved pass
 * (the bridge, or the dip) from the crossing out `reach` metres and 30 more each way on
 * the built road: the share of gravity's pull a car needs to stay on (crestShareAt over
 * crestHalf of the whole stretch), at the fastest a car is likely to be there (the racing
 * line plus 15%, up to 250 km/h). Over CREST_LIMIT anywhere the old road asked less
 * (by 0.02) is a take-off: returns the speed, else null. (raise.ts launchOver's rule.)
 * A swapped bridge may also ask as much as the bridge it replaces did (a swap never
 * makes the crossing worse than it was, and is never refused for what it already was).
 */
function takesOff(after: TrackRuntime, before: TrackRuntime | null, spot: P, kind: CrossingKind, reach: number): { kmh: number } | null {
  const S = after.samples
  // The moved pass's sample at the crossing: the upper one for a bridge, the lower for an underpass.
  let moved = -1
  for (let i = 0; i < S.count; i++) {
    if (S.surface[i] === SURFACE_CODE.loop || Math.hypot(S.px[i] - spot.x, S.pz[i] - spot.z) > 4) continue
    if (moved < 0 || (kind === 'bridge' ? S.py[i] > S.py[moved] : S.py[i] < S.py[moved])) moved = i
  }
  if (moved < 0) return null
  const m = Math.round((reach + 30) / S.ds)
  let v = 0
  for (let k = -m; k <= m; k++) v = Math.max(v, after.racingLine.speed[(((moved + k) % S.count) + S.count) % S.count])
  v = Math.min(CREST_CHECK_KMH / 3.6, v * 1.15)
  const half = crestHalf(2 * reach)
  const hit: NearestHit = { s: 0, index: 0, lateral: 0, height: 0, distance: 0, onRoad: false }
  // The bridge this one replaces (the old upper pass at the crossing), at the same speed.
  let oldWorst = 0
  if (before && kind === 'bridge') {
    const B = before.samples
    let old = -1
    for (let i = 0; i < B.count; i++) {
      if (B.surface[i] === SURFACE_CODE.loop || Math.hypot(B.px[i] - spot.x, B.pz[i] - spot.z) > 4) continue
      if (old < 0 || B.py[i] > B.py[old]) old = i
    }
    const mb = Math.round((reach + 30) / B.ds)
    if (old >= 0) for (let k = -mb; k <= mb; k++) oldWorst = Math.max(oldWorst, crestShareAt(before, (((old + k) % B.count) + B.count) % B.count, v, half))
  }
  for (let k = -m; k <= m; k++) {
    const i = (((moved + k) % S.count) + S.count) % S.count
    const share = crestShareAt(after, i, v, half)
    if (share <= Math.max(CREST_LIMIT, oldWorst + 0.02)) continue
    let was = 0
    if (before) {
      before.nearest(S.px[i], S.py[i], S.pz[i], hit, i * S.ds)
      was = crestShareAt(before, hit.index, v, half)
    }
    if (share > was + 0.02) return { kmh: v * 3.6 }
  }
  return null
}

// ---------------------------------------------------------------- remembering through a redraw

/** Which road is on top at a crossing, remembered by place and direction (for the clean-up, see keepOverOf). */
export interface OverChoice {
  at: P
  /** Heading of the road that goes over (0 = north). */
  heading: number
  /** True for an underpass: the other road dips under this one, which stays on the ground. */
  under?: boolean
}

/**
 * The road on top at every bridged crossing of this road, and whether it is
 * an underpass. Redrawing a stretch re-runs the clean-up on the whole road;
 * handing it these keeps every crossing that is still there the way it was
 * (a swap stays swapped, an underpass stays an underpass).
 */
export function keepOverOf(points: readonly RoadPoint[], ground: GroundFn = FLAT_GROUND): OverChoice[] {
  return roadCrossings(points, ground)
    .filter((c) => c.over !== null)
    .map((c) => (c.kind === 'underpass' ? { at: c.at, heading: c.passes[c.over as 0 | 1].heading, under: true } : { at: c.at, heading: c.passes[c.over as 0 | 1].heading }))
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1)
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
