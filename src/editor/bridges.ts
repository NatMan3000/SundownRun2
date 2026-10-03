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
//    3. The road going up gets the clean-up's own bridge (deck.ts): a
//       straight top 8 m above the road under it at the crossing, and
//       smooth 200 m ramps either side. The road coming down is lowered
//       to the ground over the same stretch and blends back into its old
//       heights over 60 m after it.
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
//  A tunnel (tunnelDraft) is the third kind: both roads stay on the
//  ground through the crossing, and a Tunnel piece goes on the chosen
//  road, centred on the crossing and long enough that the other road
//  only ever crosses over its roof. The game digs that road down under
//  the roof, and the other road runs over the hill on top, on ground
//  (src/track/tunnels.ts). If the builder can't fit it, or a check
//  that passed starts failing, it is refused with the reason.
//
//  A swap is remembered by the heights themselves: the raised road
//  is the bridge, and a sunken road is an underpass; a tunnel by its
//  Tunnel piece. Bend, Straight, Curve, Corner, Smooth and moving
//  points all keep every point's height, so they never flip it.
//  Redrawing a stretch with the pencil re-runs the clean-up on the
//  whole road; it is handed the old road's choices (keepOverOf) so
//  every crossing that still exists keeps the road it had on top.
//
//  Pure: points in, points out. Checked by selfTest.ts.
// ============================================================

import { TRACK_DEFAULTS, type Piece, type RoadPoint } from '../track/schema'
import { TUNNEL_CLEAR_BESIDE } from '../track/tunnels'
import { judgeTunnel } from './tunnelPlace'
import type { Judged } from './judge'
import { TUNNEL_EDIT_MAX, TUNNEL_EDIT_MIN, tunnelStartFor } from './pieces'
import { validateTrack } from '../track/validate'
import { buildTrack } from '../track/build'
import { runTrackGates, type TrackGate } from '../track/gates'
import { SURFACE_CODE, type NearestHit, type TrackRuntime } from '../track/types'
import { CREST_CHECK_KMH, CREST_LIMIT } from '../track/bankRolls'
import { crestHalf, crestShareAt } from '../track/cuttings'
import { CLEANUP, findCrossings } from './cleanup'
import { deckHeight, planDeck, rampWeight, tabulate } from './deck'
import { type P, dist } from './geom'
import type { Draft } from './draft'
import { fileOfDraft } from './draftFile'
import { gateItems } from './checks'
import { FILL_MAX, WALL_REACH } from '../track/road'
import { roadCurve, LOOP_RUN_IN } from './road'
import { type RoadLine, alongRoad, atOf, densify, dirOf, pointHeight, posOf, roadHeightAt, roadLine, sOf, sOfPoint, wrapS } from './shape'

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
  /** Height between the two road surfaces, metres (NaN at a tunnel: the game works out how deep it digs, and the `tunnel` check measures it). */
  gap: number
  /**
   * What kind of crossing it is: 'bridge' (the upper road is up in the air),
   * 'underpass' (the lower road dips into a cutting under the other, which
   * stays on the ground), 'tunnel' (a Tunnel piece covers the lower road here:
   * it goes under in a tunnel and the other road runs over the hill on top;
   * only crossingsWithTunnels says so), or null where the roads meet.
   */
  kind: CrossingKind | null
}

/** A bridge (the upper road goes up), an underpass (the lower road goes down into a cutting) or a tunnel (down under a roof). */
export type CrossingKind = 'bridge' | 'underpass' | 'tunnel'

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

// ---------------------------------------------------------------- tunnels at crossings

/** Index of the tunnel piece whose covered stretch holds the spot `s` metres along the editor's line, or -1. */
function tunnelCovering(line: RoadLine, pieces: readonly Piece[], s: number): number {
  return pieces.findIndex((p) => p.type === 'tunnel' && wrapS(s - sOf(line, p.at), line.length) <= (p.length ?? TRACK_DEFAULTS.tunnelLength))
}

const tunnelMemo = new WeakMap<readonly RoadPoint[], { pieces: readonly Piece[]; ground: GroundFn; list: RoadCrossing[] }>()

/**
 * Every crossing (roadCrossings) with the tunnels in: where a Tunnel piece covers one pass, that
 * pass goes under in the tunnel and the other runs over its roof (kind 'tunnel', `over` the other
 * pass). The points alone can't say how deep the game digs it, so `gap` is NaN there.
 */
export function crossingsWithTunnels(points: readonly RoadPoint[], pieces: readonly Piece[], ground: GroundFn = FLAT_GROUND): RoadCrossing[] {
  const memo = tunnelMemo.get(points)
  if (memo && memo.pieces === pieces && memo.ground === ground) return memo.list
  const plain = roadCrossings(points, ground)
  let list = plain
  if (plain.length && pieces.some((p) => p.type === 'tunnel')) {
    const line = roadLine(points)
    list = plain.map((c) => {
      const k = ([0, 1] as const).find((pass) => tunnelCovering(line, pieces, c.passes[pass].s) >= 0)
      return k === undefined ? c : { ...c, over: k === 0 ? 1 : 0, kind: 'tunnel' as const, gap: NaN }
    })
  }
  tunnelMemo.set(points, { pieces, ground, list })
  return list
}

/** The draft's pieces without any Tunnel piece covering either road at the crossing nearest `spot` (a new crossing choice replaces it). */
function withoutCrossingTunnels(d: Draft, spot: P, ground: GroundFn): Piece[] {
  const c = crossingNear(roadCrossings(d.points, ground), spot)?.crossing
  if (!c) return d.pieces
  const line = roadLine(d.points)
  const drop = new Set(c.passes.map((pass) => tunnelCovering(line, d.pieces, pass.s)).filter((i) => i >= 0))
  return drop.size ? d.pieces.filter((_, i) => !drop.has(i)) : d.pieces
}

/**
 * How long a tunnel at a crossing at `angleDeg` must be (metres, rounded up to 10) so the other road
 * crosses only over its roof: it must keep TUNNEL_CLEAR_BESIDE metres past this road's edge to its
 * own edge, beside the open approaches either side (src/track/tunnels.ts), plus a margin for bends.
 */
export function crossingTunnelLength(angleDeg: number, width: number): number {
  const half = (width + TUNNEL_CLEAR_BESIDE) / Math.sin((Math.max(angleDeg, 1) * Math.PI) / 180) + 10
  return Math.min(TUNNEL_EDIT_MAX, Math.max(TUNNEL_EDIT_MIN, Math.ceil((2 * half) / 10) * 10))
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
 * How many bridges the road has: crossings with a road on top (a tunnel's isn't a bridge). Raised
 * road away from any crossing is a hill (the map labels it RAISED), not a bridge, so it isn't counted.
 */
export function bridgeCount(_points: readonly RoadPoint[], crossings: readonly RoadCrossing[]): number {
  return crossings.filter((c) => c.over !== null && c.kind !== 'tunnel').length
}

// ---------------------------------------------------------------- the bridge's shape (the clean-up's own)

/** How a bridge over a crossing at this angle is shaped: the same numbers the clean-up uses. */
export function bridgeShape(angleDeg: number, width: number): { flat: number; ramp: number; lift: number } {
  // Full height over the other road's width plus 3 m each side (longer the flatter they cross), then the ramps.
  const flat = (width / 2 + 3) / Math.sin((Math.max(angleDeg, 1) * Math.PI) / 180) + 4
  return { flat, ramp: CLEANUP.bridgeRamp, lift: CLEANUP.bridgeLift }
}

/** 1 within `d0` metres, easing smoothly to 0 over the next `blend` metres (how the road held on the ground blends back into its old heights). */
function holdWeight(d: number, d0: number, blend: number): number {
  if (d <= d0) return 1
  if (d >= d0 + blend) return 0
  const t = 1 - (d - d0) / blend
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
 * Hold BOTH passes of the crossing nearest `spot` on the ground through it (for a tunnel: pass
 * `chosen` is the one that will go under, dug down by its Tunnel piece). Pass `chosen` comes down
 * off any old bridge or up out of any old dip for `holdChosen` metres either side, the other for a
 * bridge's reach; both blend back into their old heights beyond. Only the shape; tunnelDraft adds
 * the piece, builds it and runs the game's checks.
 */
export function planGround(input: SwapInput, spot: P, chosen: 0 | 1, holdChosen: number): SwapPlan {
  return planCrossing(input, spot, chosen, CLEANUP.bridgeRamp, 'tunnel', holdChosen)
}

/**
 * The shared shape of a swap, an underpass and a tunnel. `chosen` is the pass that moves:
 * up onto a bridge ('bridge'), or down into a cutting ('underpass'); for a tunnel it is the
 * pass that will go under, held on the ground here for `holdChosen` metres (the game digs it).
 * The other pass is held on the ground through the crossing every time.
 */
function planCrossing(input: SwapInput, spot: P, chosen: 0 | 1, rampMetres: number, kind: CrossingKind, holdChosen = 0): SwapPlan {
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
        : kind === 'tunnel'
          ? `These two roads cross at a very flat angle (${Math.round(c0.angleDeg)} degrees), too flat for one to go under the other in a tunnel (the tunnel would have to be very long). Redraw one so they cross more squarely.`
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
  /** Signed metres from the crossing along the moving road (negative: before it, in driving order). */
  const along = (s: number) => {
    const d = wrapS(s - moveS, L)
    return d > L / 2 ? d - L : d
  }
  // An underpass's road also comes down off any old bridge of its own first (the same reach and blend as the held road);
  // a tunnel's road comes back to the ground from any old bridge or dip over the whole tunnel and its ramps.
  const selfWeight = (dMove: number) => (kind === 'underpass' ? holdWeight(dMove, downFull, HOLD_BLEND) : kind === 'tunnel' ? holdWeight(dMove, Math.max(downFull, holdChosen), HOLD_BLEND) : 0)
  /** The moving road's height before its new shape: as it is, or for an underpass, with any old bridge of its own eased down. */
  const startHeight = (height: number, g: number, dMove: number) => {
    const oldLift = height - g
    return kind === 'underpass' && oldLift > 0 ? g + oldLift * (1 - selfWeight(dMove)) : height
  }
  // The moving road's straight-topped deck (deck.ts, the clean-up's own): through the crossing a bridge's
  // height over (or an underpass's depth under) the road held on the ground there, on these ramps.
  const wasAt = tabulate((d) => {
    const s = moveS + d
    const p = posOf(line, s)
    return startHeight(roadHeightAt(points, atOf(line, s), ground), ground(p.x, p.z), Math.abs(d))
  }, -downFull - 40, downFull + 40)
  const deck = planDeck(wasAt, ground(c.at.x, c.at.z), kind === 'bridge' ? lift : -depth, flat, ramp)
  /** How much pass `chosen` moves onto the deck d metres along it (a tunnel's road doesn't: it is held on the ground). */
  const moveWeight = (d: number) => (kind === 'tunnel' ? 0 : rampWeight(d, flat, ramp))

  // New heights, point by point.
  let clash = false
  const next = points.map((p, k) => {
    const s = sOfPoint(line, k)
    const dMove = alongRoad(s, moveS, L)
    const wMove = moveWeight(dMove)
    const dHold = alongRoad(s, holdS, L)
    const wHold = holdWeight(dHold, downFull, HOLD_BLEND)
    const wSelf = selfWeight(dMove)
    if (wMove <= 0 && wHold <= 0 && wSelf <= 0) return p
    const g = ground(p.x, p.z)
    const oldLift = pointHeight(p, ground) - g
    let newLift = oldLift
    if (wMove > 0) {
      // This point has to move for the crossing; if it also has to stay on the ground for the other road, it can't be done.
      if (wHold >= 1 || (wHold > 0 && Math.abs(oldLift) > 0.05)) clash = true
      newLift = deckHeight(deck, along(s), startHeight(g + oldLift, g, dMove)) - g
    } else {
      // Held on the ground (the other road), or the moving road's old raised heights eased down beside its dip
      // (a tunnel's road: raised or dug, back to the ground).
      const w = Math.max(wHold, oldLift > 0 || kind === 'tunnel' ? wSelf : 0)
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
const CANT: Record<CrossingKind, string> = { bridge: "Can't swap this bridge", underpass: "Can't send this road under", tunnel: "Can't put this road in a tunnel" }

/**
 * Put pass `under` (0 or 1, in driving order) of the crossing nearest `spot` in a tunnel: both
 * roads come to the ground through the crossing (planGround), and a Tunnel piece goes on that
 * pass, centred on the crossing, as long as crossingTunnelLength says (then 40 and 80 m longer if
 * that doesn't fit). The game digs that road down under the roof and the other road runs over the
 * hill on top. It is built with the real builder: it lands only if the tunnel is built, no check
 * that passed starts failing, and the other road ends up on top with room for a car. A tunnel
 * already at this crossing is replaced (so Swap moves it to the other road). Never changes `d`.
 */
export function tunnelDraft(d: Draft, spot: P, under: 0 | 1, o: SwapOptions): SwapResult {
  const ground = o.pointGround ?? FLAT_GROUND
  const cant = CANT.tunnel
  const found = crossingNear(roadCrossings(d.points, ground), spot)
  if (!found) return { ok: false, reason: "There's no crossing there any more. Click a BRIDGE label on the map." }
  const c0 = found.crossing
  const base: Draft = { ...d, pieces: withoutCrossingTunnels(d, spot, ground) }
  const L0 = crossingTunnelLength(c0.angleDeg, d.width)
  const lengths = [...new Set([L0, L0 + 40, L0 + 80].map((l) => Math.min(TUNNEL_EDIT_MAX, l)))]
  // Back to the ground over the longest tunnel tried and its ramps (about 280 m at most each side).
  const plan = planGround({ points: base.points, pieces: base.pieces, startAt: base.startAt, width: base.width, pointGround: o.pointGround }, spot, under, lengths[lengths.length - 1] / 2 + 280)
  if (!plan.ok || !plan.up || !plan.down) return { ok: false, reason: `${cant}. ${plan.reason} Nothing changed.` }
  const rc = roadCurve(plan.points)
  const middle = plan.mapAt(c0.passes[under].at)
  const moved = base.pieces.map((p) => ({ ...p, at: Math.round(plan.mapAt(p.at) * 1000) / 1000 }))
  const startAt = Math.round(plan.mapAt(base.startAt) * 1000) / 1000
  const params = o.params ?? {}
  // The checks before: the live preview's if known, else the draft as it is (built once, on the first try).
  let before: Draft | Judged = o.gatesBefore ? { runtime: null, gates: [...o.gatesBefore], errors: [], warnings: [] } : d
  let firstReason = ''
  for (const length of lengths) {
    const piece: Piece = { type: 'tunnel', at: tunnelStartFor(rc, middle, length) }
    if (length !== TRACK_DEFAULTS.tunnelLength) piece.length = length
    const next: Draft = { ...base, points: plan.points, pieces: [...moved, piece], startAt }
    const v = judgeTunnel(before, next, next.pieces.length - 1, o.id, params, null, 'Try putting the other road in the tunnel, or make it a bridge instead.')
    if (!('gates' in before)) before = { runtime: null, gates: buildAndCheck(d, o.id, params).gates, errors: [], warnings: [] }
    if (!v.ok) {
      firstReason ||= `${v.message.replace(/^Can't put a tunnel here/, cant)} Nothing changed.`
      continue
    }
    // This crossing on the built road: the other road on top, with room for a car under it.
    const built = v.judged.runtime ? builtGapAt(v.judged.runtime, spot, plan.up.heading) : null
    if (!built || !built.upperMatches || built.gap < BRIDGE_GAP) {
      firstReason ||= `${cant}: the game built it with too little room under the other road (a bug in the game, not your track). Nothing changed.`
      continue
    }
    return {
      ok: true,
      draft: next,
      gap: built.gap,
      done: `Put in a tunnel: the road heading ${compassWord(plan.down.heading)} dips ${v.depth.toFixed(1)} m into the ground and runs under ${length} m of roof, and the road heading ${compassWord(plan.up.heading)} stays on the ground and goes over the hill on top. Undo puts it back.`,
    }
  }
  return { ok: false, reason: firstReason }
}

/** Where the roads meet on the level: put one in a tunnel (the first pass from the start line, then the other). */
export function tunnelEither(d: Draft, spot: P, o: SwapOptions): SwapResult {
  let firstReason = ''
  for (const under of [0, 1] as const) {
    const res = tunnelDraft(d, spot, under, o)
    if (res.ok) return res
    firstReason ||= res.reason ?? ''
  }
  return { ok: false, reason: firstReason }
}

/**
 * Move pass `chosen` of the crossing at `spot` (up onto a bridge, or down into
 * an underpass), build it, run the game's checks, and keep it only if nothing
 * new fails and the right road ends up on top with room for a car. Gentler
 * ramps are tried if the first ones don't pass.
 */
function tryCrossing(d0: Draft, spot: P, chosen: 0 | 1, o: SwapOptions, kind: CrossingKind): SwapResult {
  // A tunnel at this crossing comes out first: a bridge or an underpass replaces it.
  const pieces = withoutCrossingTunnels(d0, spot, o.pointGround ?? FLAT_GROUND)
  const d: Draft = pieces === d0.pieces ? d0 : { ...d0, pieces }
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
          kind === 'bridge' && (plan.wasOver === chosen || d !== d0)
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
  /** True for a tunnel: the other road goes under this one in a tunnel (its Tunnel piece), and both stay on the ground here. */
  tunnel?: boolean
}

/**
 * The road on top at every bridged crossing of this road, and whether it is
 * an underpass or a tunnel (pass the draft's pieces to see tunnels). Redrawing
 * a stretch re-runs the clean-up on the whole road; handing it these keeps
 * every crossing that is still there the way it was (a swap stays swapped, an
 * underpass stays an underpass, a tunnel's roads stay on the ground).
 */
export function keepOverOf(points: readonly RoadPoint[], ground: GroundFn = FLAT_GROUND, pieces: readonly Piece[] = []): OverChoice[] {
  return crossingsWithTunnels(points, pieces, ground)
    .filter((c) => c.over !== null)
    .map((c) => {
      const heading = c.passes[c.over as 0 | 1].heading
      return c.kind === 'underpass' ? { at: c.at, heading, under: true } : c.kind === 'tunnel' ? { at: c.at, heading, tunnel: true } : { at: c.at, heading }
    })
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
