// ============================================================
//  BILLBOARD PLAN - which kind of billboard stands on each spot,
//  and which ads it shows
// ------------------------------------------------------------
//  The track decides WHERE billboards go (track.roadside.billboards,
//  spots 14-30 m from the road). This file decides WHAT stands on
//  each spot:
//
//    1. Kind. Walking the spots in lap order, it picks a kind for
//       each from a weighted lucky dip, never the same kind twice
//       in a row. A big screen only goes where it has room (wide
//       gaps to its neighbours, both legs well clear of the road);
//       a small sign is likelier close to the road, where it reads.
//    2. Ads. Every shape of ad (wide, tall, square) has its own
//       shuffled deck. Billboards deal from their deck in lap order,
//       so an ad only comes round again after the whole deck has
//       been used, and never within REPEAT_GAP metres of itself.
//
//  The lucky dips use the track's own seed, so the same track
//  shows the same billboards with the same ads on every load
//  (ghosts and screenshots always match).
//
//  Pure numbers, no three.js: the game, the inspector and the
//  check scripts all call planBillboards().
// ============================================================

import { mulberry32 } from '../track/noise'
import type { GroundPose, TrackRuntime } from '../track/types'
import { ALL_ADS } from './ads'
import type { AdShape } from './ads/adKit'
import { KINDS, type BoardKind } from './billboardKinds'

export interface BoardPlan {
  /** Which spot of track.roadside.billboards this is. */
  spot: number
  x: number
  y: number
  z: number
  heading: number
  kind: BoardKind
  /** Ad numbers (places in ALL_ADS): one for most kinds, two for a screen, four for a cube. */
  ads: number[]
  /** How far round the lap the nearest road is, metres. */
  s: number
}

/** The same ad never shows on two billboards closer than this, metres (when the deck allows). */
export const REPEAT_GAP = 400

/** How often each kind comes up in the lucky dip (before the room rules). */
const WEIGHTS: Record<BoardKind, number> = { panel: 3, banner: 2.4, sign: 1.8, screen: 1.2, cube: 1.3 }
/** The two show-offs (a big screen, a spinning cube) never come up within this many billboards of their own kind. */
const SHOWOFF_GAP = 2
const KIND_ORDER: BoardKind[] = ['panel', 'banner', 'sign', 'screen', 'cube']

/** Clearance from (x, z) to the nearest road edge, and the lap distance of the nearest road. */
function roadGap(t: TrackRuntime, x: number, z: number): { gap: number; s: number } {
  const S = t.samples
  let best = Infinity
  let bestI = 0
  for (let i = 0; i < S.count; i += 2) {
    const d = Math.hypot(S.px[i] - x, S.pz[i] - z) - S.halfWidth[i]
    if (d < best) {
      best = d
      bestI = i
    }
  }
  return { gap: best, s: bestI * S.ds }
}

/** A point `along` metres along the billboard's local +x (the direction the road runs past it). */
function along(b: GroundPose, a: number): [number, number] {
  return [b.x + Math.cos(b.heading) * a, b.z - Math.sin(b.heading) * a]
}

function shuffled(n: number, first: number, rand: () => number): number[] {
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(first + i)
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const t = out[i]
    out[i] = out[j]
    out[j] = t
  }
  return out
}

const planCache = new WeakMap<TrackRuntime, BoardPlan[]>()

/** Plan every billboard on a track. Same track, same plan (worked out once per built track). */
export function planBillboards(t: TrackRuntime): BoardPlan[] {
  let plans = planCache.get(t)
  if (!plans) {
    plans = makePlan(t)
    planCache.set(t, plans)
  }
  return plans
}

function makePlan(t: TrackRuntime): BoardPlan[] {
  const spots = t.roadside.billboards
  if (spots.length === 0) return []
  const rand = mulberry32((t.file.environment.seed ^ 0x6a09e667) >>> 0)

  // Where each spot is: lap distance, room to the road, room to its neighbours.
  const info = spots.map((b, i) => {
    const { gap, s } = roadGap(t, b.x, b.z)
    let nn = Infinity
    for (let j = 0; j < spots.length; j++) if (j !== i) nn = Math.min(nn, Math.hypot(spots[j].x - b.x, spots[j].z - b.z))
    return { i, gap, s, nn }
  })
  const order = info.slice().sort((a, b) => a.s - b.s)

  const fits = (b: GroundPose, nn: number, kind: BoardKind): boolean => {
    const k = KINDS[kind]
    if (nn < 2 * k.halfSpan + 6) return false
    if (kind === 'screen') {
      for (const a of [-7.5, 7.5]) if (roadGap(t, ...along(b, a)).gap < 10) return false
      for (const a of [-k.halfSpan, k.halfSpan]) if (roadGap(t, ...along(b, a)).gap < 7) return false
    } else {
      for (const a of [-k.halfSpan, k.halfSpan]) if (roadGap(t, ...along(b, a)).gap < 5) return false
    }
    return true
  }

  // 1. A kind for every spot.
  const kinds: BoardKind[] = new Array(spots.length)
  const recent: BoardKind[] = []
  for (const o of order) {
    const b = spots[o.i]
    const w: number[] = KIND_ORDER.map((k) => {
      if (k === recent[recent.length - 1] || !fits(b, o.nn, k)) return 0
      if ((k === 'screen' || k === 'cube') && recent.slice(-SHOWOFF_GAP).includes(k)) return 0
      let wt = WEIGHTS[k]
      if (k === 'sign') wt *= o.gap < 20 ? 2 : o.gap > 26 ? 0.4 : 1
      if (k === 'screen') wt *= o.gap > 18 ? 1.4 : 0.6
      return wt
    })
    let total = w.reduce((a, v) => a + v, 0)
    if (total <= 0) {
      // Nothing else fits (or only the kind we just had): a small sign always fits.
      w.fill(0)
      w[KIND_ORDER.indexOf('sign')] = 1
      total = 1
    }
    let r = rand() * total
    let pick = KIND_ORDER[KIND_ORDER.length - 1]
    for (let k = 0; k < KIND_ORDER.length; k++) {
      r -= w[k]
      if (r <= 0 && w[k] > 0) {
        pick = KIND_ORDER[k]
        break
      }
    }
    kinds[o.i] = pick
    recent.push(pick)
  }

  // 2. Deal the ads, in lap order, from one shuffled deck per shape.
  const decks: Record<AdShape, { cards: number[]; next: number }> = {
    wide: { cards: [], next: 0 },
    tall: { cards: [], next: 0 },
    square: { cards: [], next: 0 },
  }
  for (const shape of ['wide', 'tall', 'square'] as AdShape[]) {
    const ids: number[] = []
    ALL_ADS.forEach((a, i) => {
      if (a.shape === shape) ids.push(i)
    })
    decks[shape].cards = shuffled(ids.length, 0, rand).map((k) => ids[k])
    decks[shape].next = Math.floor(rand() * ids.length)
  }
  const plans: BoardPlan[] = new Array(spots.length)
  const dealt: BoardPlan[] = []
  for (const o of order) {
    const b = spots[o.i]
    const spec = KINDS[kinds[o.i]]
    const deck = decks[spec.shape]
    const ads: number[] = []
    for (let n = 0; n < spec.ads; n++) {
      let chosen = -1
      // Take the next card, unless it is already on this board or shows nearby; then try the
      // following ones. If every card clashes, take the one that clashes least badly.
      let fallback = -1
      for (let tries = 0; tries < deck.cards.length; tries++) {
        const card = deck.cards[(deck.next + tries) % deck.cards.length]
        if (ads.includes(card)) continue
        if (fallback < 0) fallback = tries
        let near = false
        for (const d of dealt) {
          if (d.ads.includes(card) && Math.hypot(d.x - b.x, d.z - b.z) < REPEAT_GAP) {
            near = true
            break
          }
        }
        if (!near) {
          chosen = tries
          break
        }
      }
      if (chosen < 0) chosen = Math.max(0, fallback)
      // Swap the chosen card into the dealing position, so a skipped card comes up next time.
      const cards = deck.cards
      const here = deck.next % cards.length
      const there = (deck.next + chosen) % cards.length
      const card = cards[there]
      cards[there] = cards[here]
      cards[here] = card
      ads.push(card)
      deck.next = (deck.next + 1) % cards.length
    }
    const plan: BoardPlan = { spot: o.i, x: b.x, y: b.y, z: b.z, heading: b.heading, kind: kinds[o.i], ads, s: o.s }
    plans[o.i] = plan
    dealt.push(plan)
  }
  return plans
}

/** Numbers for the inspector and the reports: kinds, how many different ads, the closest repeat. */
export function planSummary(plans: BoardPlan[]) {
  const kinds: Record<string, number> = {}
  const ads = new Set<number>()
  let slots = 0
  for (const p of plans) {
    kinds[p.kind] = (kinds[p.kind] ?? 0) + 1
    for (const a of p.ads) ads.add(a)
    slots += p.ads.length
  }
  let closest = Infinity
  let closestAd = -1
  for (let i = 0; i < plans.length; i++) {
    for (let j = i + 1; j < plans.length; j++) {
      const shared = plans[i].ads.find((a) => plans[j].ads.includes(a))
      if (shared === undefined) continue
      const d = Math.hypot(plans[i].x - plans[j].x, plans[i].z - plans[j].z)
      if (d < closest) {
        closest = d
        closestAd = shared
      }
    }
  }
  return {
    billboards: plans.length,
    kinds,
    adSlots: slots,
    distinctAds: ads.size,
    adsInGame: ALL_ADS.length,
    closestRepeatM: Number.isFinite(closest) ? Math.round(closest) : null,
    closestRepeatAd: closestAd >= 0 ? ALL_ADS[closestAd].name : null,
  }
}
