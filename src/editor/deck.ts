// ============================================================
//  DECK - the shape of a bridge (or an underpass's dip) along its road
// ------------------------------------------------------------
//  Where the road crosses itself, one pass goes up over the other
//  (a bridge) or down under it (an underpass). This file is the
//  shape that pass gets, shared by the pencil's clean-up
//  (cleanup.ts) and Swap / Send under (bridges.ts), so a bridge
//  swapped back is exactly the bridge the clean-up made.
//
//  Two parts:
//    - The DECK: the bit over the crossing runs on a straight line,
//      level, or at a steady slope where the ground under it slopes.
//      Bridges used to sit a fixed height above the ground all the
//      way, so every hill under one showed through as a bump, right
//      at the top where a car at full speed is lightest.
//    - The RAMPS: either side, the road climbs from where it leaves
//      its old line (the foot of the ramp) up to the deck. Each ramp
//      is two curves that bend at a steady rate, like the curves real
//      road builders put over a hill: a long gentle one where the road
//      goes over the top (a car can fly off a crest), and a shorter
//      firmer one at the other end, where the road only presses the
//      car into its springs. They meet the old road and the deck at
//      the same height AND the same slope, so there is no kink. The
//      ground under a ramp doesn't change its shape at all: where the
//      ground dips, the ramp stands higher on its bank; where it bumps
//      up, the ramp runs through it.
//
//  The deck's slope is picked so the sharpest crest on either ramp is
//  as gentle as it can be. The rule a ramp must pass is the Height
//  tool's (raise.ts): over the top, the road may fall away from a car
//  no faster than PLAN_SHARE of gravity's pull can hold it on, at the
//  fastest a car goes (250 km/h); the built road is then judged at
//  80% (CREST_LIMIT). deckCrest measures that on the planned heights.
//
//  Pure maths: no editor state, no builder.
// ============================================================

import { CREST_CHECK_KMH } from '../track/bankRolls'

/** A planned hill (or ramp) may ask at most this share of gravity's pull at its top; the built road is judged at CREST_LIMIT (80%). */
export const PLAN_SHARE = 0.65

/** The fastest a car is likely to be anywhere: the crest checks' own speed cap (250 km/h), in m/s. */
export const DECK_TOP_SPEED = CREST_CHECK_KMH / 3.6

const G = 9.81

/**
 * How much of each ramp is the gentle curve over the top. 0.6 bends the road
 * over the top a sixth less sharply than two equal curves would (and a third
 * less than the half-cosine ramps bridges had before), and the firm curve at
 * the other end bends about as sharply as that old half-cosine's top did.
 */
export const RAMP_CREST_PART = 0.6

/** The steepest a deck may slope, metres up per metre along (a steady 8% climb). */
const MAX_GRADE = 0.08

/**
 * 1 over the deck (`flat` metres either side of the crossing), easing to 0 at
 * the foot of each ramp (`ramp` metres further), smoothly. Only says how much
 * of a ramp's change a spot has (the clean-up and Swap use it to know which
 * road points a crossing moves); the ramp's real shape is deckHeight.
 */
export function rampWeight(d: number, flat: number, ramp: number): number {
  if (d <= flat) return 1
  if (d >= flat + ramp) return 0
  const t = 1 - (d - flat) / ramp
  return t <= 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t)
}

/**
 * One ramp: from its foot (height `y0`, slope `s0`, both measured walking
 * toward the crossing) along `foot` metres bending at `k1` (per metre; plus
 * is a dip, minus a crest), then `top` metres bending at `k2`, onto the deck.
 */
export interface Ramp {
  y0: number
  s0: number
  foot: number
  top: number
  k1: number
  k2: number
}

/** The deck: a straight line through the crossing, and the two ramps onto it. */
export interface Deck {
  /** Height at the crossing, metres (the road held on the ground there, plus or minus the bridge's height). */
  top: number
  /** Metres up per metre along the road, in driving order (0 = level). */
  grade: number
  /** True for an underpass's dip (the line is below the old road), false for a bridge. */
  dip: boolean
  /** Metres either side of the crossing on the line, and how long each ramp is. */
  flat: number
  ramp: number
  /** The ramp before the crossing (in driving order) and the one after it, each measured from its foot. */
  before: Ramp
  after: Ramp
}

/**
 * The two bends of a ramp `ramp` metres long, from a foot at height y0 and
 * slope s0 to a top at height y1 and slope s1 (slopes walking from the foot to
 * the top). The first `footPart` of it bends one way, the rest the other.
 */
function fitRamp(y0: number, s0: number, y1: number, s1: number, ramp: number, footPart: number): Ramp {
  const foot = ramp * footPart
  const top = ramp - foot
  // Slope: s0 + k1 foot + k2 top = s1. Height: y0 + s0 ramp + k1 foot^2/2 + k1 foot top + k2 top^2/2 = y1.
  const turn = s1 - s0
  const climb = y1 - y0 - s0 * ramp
  const k1 = (2 * climb - turn * top) / (foot * ramp)
  const k2 = (turn - k1 * foot) / top
  return { y0, s0, foot, top, k1, k2 }
}

/** Height on a ramp `u` metres up from its foot. */
function rampHeight(r: Ramp, u: number): number {
  if (u <= r.foot) return r.y0 + r.s0 * u + (r.k1 * u * u) / 2
  const v = u - r.foot
  return r.y0 + r.s0 * r.foot + (r.k1 * r.foot * r.foot) / 2 + (r.s0 + r.k1 * r.foot) * v + (r.k2 * v * v) / 2
}

/** How sharply a ramp crests (the most it bends over, per metre; 0 if it never does) and dips. */
function rampBends(r: Ramp): { crest: number; sag: number } {
  return { crest: Math.max(0, -r.k1, -r.k2), sag: Math.max(0, r.k1, r.k2) }
}

/**
 * Plan a deck. `wasAt(d)` is the road's height now, `d` metres from the
 * crossing along it (negative: before it). The line goes through the crossing
 * at `crossingHeight + rise` (rise negative for a dip). Each ramp starts from
 * the road as it is at its foot (height and slope), so the road leaves its old
 * line without a kink. The deck's slope is the one (up to MAX_GRADE either
 * way) whose sharpest crest on either ramp is gentlest, with a dip's bottom
 * counting half as much (it presses a car on rather than throwing it off).
 */
export function planDeck(wasAt: (d: number) => number, crossingHeight: number, rise: number, flat: number, ramp: number): Deck {
  const reach = flat + ramp
  const dip = rise < 0
  const top = crossingHeight + rise
  // The road at the two feet: height, and slope walking toward the crossing.
  const yB = wasAt(-reach)
  const sB = (wasAt(-reach + 2) - wasAt(-reach - 2)) / 4
  const yA = wasAt(reach)
  const sA = -(wasAt(reach + 2) - wasAt(reach - 2)) / 4
  // The gentle bend goes where the road crests: at the top of a bridge's ramp, at the lip of a dip.
  const footPart = dip ? RAMP_CREST_PART : 1 - RAMP_CREST_PART
  const make = (grade: number): Deck => ({
    top,
    grade,
    dip,
    flat,
    ramp,
    before: fitRamp(yB, sB, top - grade * flat, grade, ramp, footPart),
    after: fitRamp(yA, sA, top + grade * flat, -grade, ramp, footPart),
  })
  const cost = (deck: Deck) => {
    const a = rampBends(deck.before)
    const b = rampBends(deck.after)
    return Math.max(a.crest, b.crest, 0.5 * a.sag, 0.5 * b.sag)
  }
  // Start from the slope of the line between the two feet, then try every slope a step apart.
  const chord = Math.max(-MAX_GRADE, Math.min(MAX_GRADE, (yA - yB) / (2 * reach)))
  let best = make(chord)
  let bestCost = cost(best)
  for (let g = -MAX_GRADE; g <= MAX_GRADE + 1e-9; g += 0.002) {
    const deck = make(g)
    const c = cost(deck)
    if (c < bestCost - 1e-9) {
      best = deck
      bestCost = c
    }
  }
  return best
}

/** Where the deck line is, `d` metres from the crossing (negative: before it). */
export function deckLine(deck: Deck, d: number): number {
  return deck.top + deck.grade * d
}

/**
 * The road's new height `d` metres from the crossing: the deck line over the
 * crossing, the ramps either side, and `was` (the road as it was) beyond them.
 */
export function deckHeight(deck: Deck, d: number, was: number): number {
  const reach = deck.flat + deck.ramp
  if (Math.abs(d) <= deck.flat) return deckLine(deck, d)
  if (Math.abs(d) >= reach) return was
  return d < 0 ? rampHeight(deck.before, d + reach) : rampHeight(deck.after, reach - d)
}

/**
 * The most of gravity's pull a car at `v` m/s needs to stay on anywhere over
 * the planned deck and its ramps (and 30 m past the feet), measured like the
 * game's crest check (the change of slope over a window an eighth of the
 * whole stretch long, 6 to 20 m each way). `over` is the worst amount by
 * which it asks more than `limit`, where the road as it was asked less
 * (raise.ts launchOver's rule: a lumpy hill already there may stay as lumpy,
 * no lumpier). over <= 0: a car stays on.
 */
export function deckCrest(deck: Deck, wasAt: (d: number) => number, v: number = DECK_TOP_SPEED, limit: number = PLAN_SHARE): { worst: number; over: number; at: number } {
  const reach = deck.flat + deck.ramp
  const half = Math.max(6, Math.min(20, (2 * reach) / 8))
  const now = (d: number) => deckHeight(deck, d, wasAt(d))
  const share = (h: (d: number) => number, d: number) => {
    const slope = (x: number) => (h(x + 2) - h(x - 2)) / 4
    const crest = -(slope(d + half) - slope(d - half)) / (2 * half)
    return crest > 0 ? (v * v * crest) / G : 0
  }
  let worst = 0
  let over = -Infinity
  let at = 0
  for (let d = -reach - 30; d <= reach + 30; d += 2) {
    const s = share(now, d)
    const by = s - Math.max(limit, share(wasAt, d) + 0.02)
    if (s > worst) worst = s
    if (by > over) {
      over = by
      at = d
    }
  }
  return { worst, over, at }
}

/**
 * A height along the road worked out once every `step` metres from `from` to
 * `to` (metres from the crossing) and read back in between: the ground's
 * heights take a while to work out, and the deck asks for each spot many times.
 */
export function tabulate(fn: (d: number) => number, from: number, to: number, step = 2): (d: number) => number {
  const n = Math.ceil((to - from) / step)
  const v = new Float64Array(n + 1)
  for (let k = 0; k <= n; k++) v[k] = fn(from + k * step)
  return (d: number) => {
    const f = Math.max(0, Math.min(n, (d - from) / step))
    const k = Math.min(n - 1, Math.floor(f))
    return v[k] + (v[k + 1] - v[k]) * (f - k)
  }
}
