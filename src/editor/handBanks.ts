// ============================================================
//  HAND-SET BANKS - the stretches where Josh set the bank himself
// ------------------------------------------------------------
//  A road point's `bank` is a bank Josh set by hand (the Bank tool);
//  points without one are banked by the game to suit the bend. The
//  Checks list (problems.ts) and Fix it (fixes.ts) both need to know
//  which stretch of hand-set bank a problem is next to, so a tilt
//  that comes from his setting is mended there, and "Show me" selects
//  that same stretch. This file finds those stretches.
// ============================================================

import type { RoadPoint } from '../track/schema'
import { type RoadLine, alongRoad, roadLine, sOfPoint, wrapS } from './shape'

/**
 * A stretch of road where Josh set the bank by hand: road points `k0` to `k1`
 * (k1 may run past the end of the list: it wraps round the lap). Two
 * hand-set stretches with only a little road between them count as one,
 * since the game rolls the road between them as one piece.
 */
export interface BankRegion {
  k0: number
  k1: number
}

/** Hand-set stretches closer than this along the road are one region, metres. */
export const REGION_JOIN = 120

/** Every hand-set region on these points, in order. */
export function bankRegions(points: readonly RoadPoint[], line: RoadLine): BankRegion[] {
  const n = points.length
  const has = (k: number) => points[((k % n) + n) % n].bank !== undefined
  if (!points.some((p) => p.bank !== undefined)) return []
  if (points.every((p) => p.bank !== undefined)) return [{ k0: 0, k1: n - 1 }]
  // Start the walk just after a point with no bank, so no run is cut in two at the seam.
  const first = points.findIndex((p) => p.bank === undefined)
  const runs: BankRegion[] = []
  for (let j = 1; j <= n; j++) {
    const k = first + j
    if (!has(k)) continue
    if (runs.length && runs[runs.length - 1].k1 === k - 1) runs[runs.length - 1].k1 = k
    else runs.push({ k0: k, k1: k })
  }
  // Join runs with only a little road between them (and the last to the first, round the lap).
  const gap = (a: BankRegion, b: BankRegion) => wrapS(sOfPoint(line, b.k0 % n) - sOfPoint(line, a.k1 % n), line.length)
  const out: BankRegion[] = []
  for (const r of runs) {
    const last = out[out.length - 1]
    if (last && gap(last, r) <= REGION_JOIN) last.k1 = r.k1
    else out.push({ ...r })
  }
  if (out.length > 1 && gap(out[out.length - 1], out[0]) <= REGION_JOIN) {
    const last = out.pop() as BankRegion
    out[0] = { k0: last.k0 - n, k1: out[0].k1 }
  }
  return out.map((r) => (r.k0 < 0 ? { k0: r.k0 + n, k1: r.k1 + n } : r))
}

/**
 * The hand-set region a problem at road distance `s` (metres, on `line`) is about:
 * one that reaches within `reach` metres of it, nearest first. Null when no bank
 * Josh set is near, so the problem isn't his settings' doing.
 */
export function regionNear(points: readonly RoadPoint[], line: RoadLine, s0: number, s1: number, reach: number): BankRegion | null {
  const L = line.length
  const n = points.length
  let best: BankRegion | null = null
  let bestD = Infinity
  for (const r of bankRegions(points, line)) {
    const a = sOfPoint(line, r.k0 % n)
    const len = wrapS(sOfPoint(line, r.k1 % n) - a, L)
    // How far the problem's stretch [s0, s1] is from the region [a, a + len], round the lap.
    const span = wrapS(s1 - s0, L)
    const d0 = wrapS(s0 - a, L)
    const inside = d0 <= len || wrapS(a - s0, L) <= span
    const dist = inside ? 0 : Math.min(wrapS(s0 - (a + len), L), wrapS(a - (s0 + span), L))
    if (dist <= reach && dist < bestD) {
      bestD = dist
      best = r
    }
  }
  return best
}

/** How far along the road the bank under a bridge is read, metres either side of the crossing. */
const UNDER_REACH = 40

/** The steepest hand-set bank within UNDER_REACH metres of road distance `s` (0 when none is set there). */
export function handBankNear(points: readonly RoadPoint[], s: number): number {
  const line = roadLine(points)
  let most = 0
  points.forEach((p, k) => {
    if (p.bank === undefined) return
    if (alongRoad(sOfPoint(line, k), s, line.length) <= UNDER_REACH) most = Math.max(most, Math.abs(p.bank))
  })
  return most
}

/** A region as a stretch selection's two ends (`at`s on these points). */
export function regionStretch(points: readonly RoadPoint[], r: BankRegion): { from: number; to: number } {
  const n = points.length
  return { from: r.k0 % n, to: r.k1 % n }
}
