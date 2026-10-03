// ============================================================
//  BANKS UNDER BRIDGES - keep a car's room under a bridge when the
//  road beneath it is banked
// ------------------------------------------------------------
//  An open road tilts about its LOW edge (src/track/road.ts, "the
//  bank's pivot"): the high side rises and so does the middle, by
//  half the road's width x sin(bank), and the high lane by twice that.
//  Bank the lower road of a crossing by 30 degrees and its high lane
//  comes up 7 m towards the bridge above, so a bridge that had room
//  for a car (6.2 m between the two roads) is left with none: the
//  game's `bridges` check (measured over every lane) fails (LOW
//  BRIDGE).
//
//  Two things here:
//    liftBridgeBy       raise the upper road at a crossing by some
//                       metres, on its bridge, easing in over longer
//                       ramps the higher it goes (Fix it uses it with
//                       the built road's real shortfall)
//    keepBridgesClear   after Josh sets a bank on a stretch (draft.ts
//                       setSectionBank): any bridge over that stretch
//                       goes up by as much as the bank lifts the road
//                       under it, so it keeps its room. If it can't,
//                       it says why (and Checks will show LOW BRIDGE)
//
//  Pure: points in, points out. Nothing here builds the track; the
//  live preview and the game's checks still judge the result.
// ============================================================

import { TRACK_DEFAULTS, type Piece, type RoadPoint } from '../track/schema'
import { BRIDGE_GAP, type GroundFn, type RoadCrossing, bridgeShape, crossingNear, roadCrossings } from './bridges'
import { CLEANUP } from './cleanup'
import type { P } from './geom'
import { handBankNear } from './handBanks'
import { LOOP_RUN_IN } from './road'
import { alongRoad, densify, pointHeight, roadLine, sOf, sOfPoint } from './shape'

/**
 * Room to spare over the 6.2 m a car needs, when guessing from the points before the
 * road is built: the built road comes out up to about a metre lower in the gap than
 * the points' heights say (the check measures the closest pair of spots across the
 * crossing, where the bridge's ramps have started), and the bank's roll nibbles more.
 */
const SPARE = 1.5
/** The most a bridge is raised for a bank under it, metres (more than this and the bank is the thing to change). */
const MOST = 8
/** What the road's bank lifts its middle by at a hand-set bank (an open road tilts about its low edge). */
function pivotLift(width: number, bankDeg: number): number {
  return (width / 2) * Math.abs(Math.sin((bankDeg * Math.PI) / 180))
}

export interface LiftResult {
  ok: boolean
  points: RoadPoint[]
  /** Moves an `at` on the old road to the same spot on the new one (the road is evened first). */
  mapAt: (at: number) => number
  reason?: string
}

/**
 * Raise the upper road at the crossing near `spot` by `extra` metres over the
 * bridge's flat middle, easing in and out over ramps longer than the bridge's own
 * (in proportion to the new height, so they are no steeper than before). Each
 * point keeps its kind of height (`y` stays `y`, `lift` stays `lift`). Refuses
 * when the ramps would reach a loop, ramp or wall ride, the start grid, or the
 * lower road of this or another crossing.
 */
export function liftBridgeBy(points: readonly RoadPoint[], pieces: readonly Piece[], startAt: number, width: number, spot: P, extra: number, ground: GroundFn): LiftResult {
  const refuse = (reason: string): LiftResult => ({ ok: false, points: points.map((p) => ({ ...p })), mapAt: (a) => a, reason })
  const found = crossingNear(roadCrossings(points, ground), spot, 60)
  if (!found || found.crossing.over === null) return refuse("there's no bridge there")
  const even = densify(roadLine(points), 0, roadLine(points).length, 20, CLEANUP.spacing, { pointGround: ground })
  const pts = even.points
  const line = roadLine(pts)
  const L = line.length
  const c = crossingNear(roadCrossings(pts, ground), found.crossing.at, 30)?.crossing
  if (!c || c.over === null) return refuse("there's no bridge there")
  const upS = c.passes[c.over].s
  const downS = c.passes[c.over === 0 ? 1 : 0].s
  const { flat, lift } = bridgeShape(c.angleDeg, width)
  const ramp = CLEANUP.bridgeRamp * Math.max(1, (lift + extra) / lift)
  const reach = flat + ramp
  const weight = (s: number) => {
    const d = alongRoad(s, upS, L)
    if (d <= flat) return 1
    if (d >= reach) return 0
    const u = 1 - (d - flat) / ramp
    return 0.5 - 0.5 * Math.cos(Math.PI * u)
  }
  // Nothing that needs its road left alone may sit under the new ramps.
  if (alongRoad(downS, upS, L) < reach + 20) return refuse('the road comes back under the bridge too soon for longer ramps')
  for (const o of roadCrossings(pts, ground)) {
    if (Math.hypot(o.at.x - c.at.x, o.at.z - c.at.z) < 1) continue
    for (const k of [0, 1] as const) if (o.over !== k && weight(o.passes[k].s) > 0) return refuse('another crossing is too close along the road')
  }
  for (const piece of pieces) {
    if (piece.type !== 'loop' && piece.type !== 'ramp' && piece.type !== 'wallride') continue
    const s = sOf(line, even.mapAt(piece.at))
    const room = piece.type === 'loop' ? LOOP_RUN_IN + 5 * (piece.radius ?? TRACK_DEFAULTS.loopRadius) : piece.type === 'wallride' ? (piece.length ?? TRACK_DEFAULTS.wallride.length) : 30
    if (alongRoad(s, upS, L) < reach + room) return refuse(`a ${piece.type === 'wallride' ? 'wall ride' : piece.type} is too close to the bridge`)
  }
  if (alongRoad(sOf(line, even.mapAt(startAt)), upS, L) < reach + 70) return refuse('the start line is too close to the bridge')
  const out = pts.map((p, k) => {
    const w = weight(sOfPoint(line, k))
    if (w <= 0) return p
    const q: RoadPoint = { ...p }
    const rise = extra * w
    if (typeof p.y === 'number') q.y = Math.round((p.y + rise) * 100) / 100
    else q.lift = Math.round((pointHeight(p, ground) - ground(p.x, p.z) + rise) * 100) / 100
    return q
  })
  return { ok: true, points: out, mapAt: even.mapAt }
}

export interface KeepClear extends LiftResult {
  /** What happened, in Josh's words (empty when nothing needed doing). */
  words: string
}

/**
 * After the bank on some road changed from `before` to `after` (same points, new
 * `bank` settings): every bridge over road whose hand-set bank grew goes up by as
 * much as the bank lifts the road under it, so a car still fits. Bridges that
 * already have the room are left alone. Returns the points to use (the same
 * `after` points when nothing had to change), and words for the status line.
 */
export function keepBridgesClear(before: readonly RoadPoint[], after: readonly RoadPoint[], pieces: readonly Piece[], startAt: number, width: number, ground: GroundFn): KeepClear {
  let points: RoadPoint[] = after.map((p) => ({ ...p }))
  let mapAt = (a: number) => a
  const words: string[] = []
  const list = roadCrossings(after, ground).filter((c) => c.over !== null)
  for (const c0 of list) {
    const c: RoadCrossing | undefined = crossingNear(roadCrossings(points, ground), c0.at, 30)?.crossing
    if (!c || c.over === null) continue
    const under = c.passes[c.over === 0 ? 1 : 0]
    const bankNow = handBankNear(points, under.s)
    const was = crossingNear(roadCrossings(before, ground), c.at, 30)?.crossing
    const bankWas = was && was.over !== null ? handBankNear(before, was.passes[was.over === 0 ? 1 : 0].s) : 0
    if (bankNow <= bankWas) continue
    // The room there once the road is built: the gap between the two roads' heights, less what
    // the lower road's bank lifts its HIGH lane (twice its middle's lift: the game's `bridges`
    // check measures over every lane). The upper road's own bank adds nothing: its low edge
    // stays at its height, over some lane of the road below.
    const room = c.gap - 2 * pivotLift(width, bankNow)
    const need = BRIDGE_GAP + SPARE - room
    if (need <= 0) continue
    if (need > MOST) {
      words.push(`A bank that steep lifts the road under the bridge too far for the bridge to follow (it would need ${need.toFixed(1)} m more), so the bridge may be too low now: Checks will say.`)
      continue
    }
    const res = liftBridgeBy(points, pieces, mapAt(startAt), width, c.at, need, ground)
    if (!res.ok) {
      words.push(`The bridge over it couldn't go up to make room: ${res.reason}. It may be too low for a car now: Checks will say.`)
      continue
    }
    const prev = mapAt
    points = res.points
    mapAt = (a) => res.mapAt(prev(a))
    words.push(`The bridge over it went up ${need.toFixed(1)} m so a car still fits underneath.`)
  }
  return { ok: true, points, mapAt, words: words.join(' ') }
}
