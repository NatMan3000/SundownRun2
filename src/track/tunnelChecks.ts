// ============================================================
//  TUNNEL CHECKS - "is every tunnel a real tunnel?" without physics
// ------------------------------------------------------------
//  The `tunnel` gate in runTrackGates (gates.ts) comes from here,
//  one row per tunnel piece:
//
//    refused     a tunnel that couldn't be built says why, in plain
//                words (tunnels.ts planTunnelDigs), and fails
//    clearance   from the road up to the ceiling, over every lane:
//                at least TUNNEL_CLEARANCE_MIN metres
//    roof        the roof over the ceiling is solid ground, not paper
//    no ground   no physics ground inside the tube under the roof: the
//                ground under the road and its walls is a hole, or
//                sits below the road's edge, so nothing pokes up into
//                the tunnel
//    lip         the edge of the tube's top meets the ground beside
//                it within TUNNEL_LIP_MAX metres (it sits a road-edge
//                lip above it, never a step a car catches on)
//
//  The physics checks (a car sliding along the walls, cars dropped on
//  the roof) are in selftest.ts. Pure: reads the built track.
// ============================================================

import { trackInternals } from './build'
import { gridHeight, TUNNEL_WALL_MIN } from './terrain'
import { groundHoleAt } from './terrainTiles'
import { TUNNEL_HOLLOW, TUNNEL_LIP, TUNNEL_WALL } from './tunnels'
import type { NearestHit, TrackRuntime } from './types'

/** The least room (metres) from the road up to a tunnel's ceiling, over any lane. */
export const TUNNEL_CLEARANCE_MIN = 5
/** The thinnest roof (metres) the check accepts over the ceiling. */
export const TUNNEL_ROOF_CHECK = 0.8
/** The edge of the tube's top may stand at most this far above the ground beside it (metres). */
export const TUNNEL_LIP_MAX = 0.1
/** Ground inside the tube must sit at least this far below the road's edge, or be a hole (metres). */
export const TUNNEL_GROUND_BELOW = 0.04

export interface TunnelCheck {
  /** Index in file.pieces. */
  index: number
  /** Where it was asked for (s along the road) and how long its covered stretch is. */
  s0: number
  length: number
  /** Why it couldn't be built, or null. */
  problem: string | null
  /** Least metres from the road (any lane) up to the ceiling. */
  clearance: number
  clearanceAt: number
  /** Least metres of roof over the ceiling. */
  roof: number
  roofAt: number
  /** Highest physics ground inside the tube, metres relative to the road edge beside it (negative = below). */
  ground: number
  groundAt: number
  /** Largest gap between the tube top's outer edge and the ground just beside it (metres), and the most it sits below that ground. */
  lip: number
  lipAt: number
  under: number
  /** How long the approaches are (metres, both together) and how deep the road goes. */
  approach: number
  depth: number
}

/** Check every tunnel piece. Empty when the track has none. */
export function tunnelChecks(t: TrackRuntime): TunnelCheck[] {
  const x = trackInternals(t)
  if (!x) return []
  const ts = x.tunnels
  const S = t.samples
  const out: TunnelCheck[] = []
  const hit: NearestHit = { s: 0, index: 0, lateral: 0, height: 0, distance: 0, onRoad: false }
  for (const plan of ts.plans) {
    const piece = t.pieces.find((p) => p.index === plan.index)
    const c: TunnelCheck = {
      index: plan.index,
      s0: piece ? piece.s0 : 0,
      length: plan.sb1 - plan.sb0,
      problem: plan.problem,
      clearance: Infinity,
      clearanceAt: 0,
      roof: Infinity,
      roofAt: 0,
      ground: -Infinity,
      groundAt: 0,
      lip: 0,
      lipAt: 0,
      under: 0,
      approach: 0,
      depth: plan.depth,
    }
    out.push(c)
    if (plan.problem) continue
    const id = t.tunnels.findIndex((tn) => tn.index === plan.index) + 1
    if (id <= 0) {
      c.problem = 'it was planned but the road came out without it (a builder bug, not your file)'
      continue
    }
    const tn = t.tunnels[id - 1]
    c.approach = tn.a1 - tn.a0 - (tn.s1 - tn.s0)
    for (let i = 0; i < S.count; i++) {
      if (ts.slot[i] !== id) continue
      const hw = S.halfWidth[i]
      const s = i * S.ds
      if (ts.covered[i]) {
        // Room over every lane, and the roof over the ceiling right across the tube.
        for (let k = 0; k <= 8; k++) {
          const l = -hw + (2 * hw * k) / 8
          const room = ts.ceil[i] - (S.py[i] + S.ry[i] * l)
          if (room < c.clearance) {
            c.clearance = room
            c.clearanceAt = s
          }
        }
        for (let k = 0; k <= 8; k++) {
          const l = -(hw + TUNNEL_WALL) + (2 * (hw + TUNNEL_WALL) * k) / 8
          const roof = gridHeight(x.natGrid, S.px[i] + S.rx[i] * l, S.pz[i] + S.rz[i] * l) + TUNNEL_LIP - ts.ceil[i]
          if (roof < c.roof) {
            c.roof = roof
            c.roofAt = s
          }
        }
      }
      for (const side of [-1, 1] as const) {
        const w = ts.covered[i] ? 1 : side < 0 ? ts.wallL[i] : ts.wallR[i]
        if (w <= TUNNEL_WALL_MIN) continue
        const edgeY = S.py[i] + S.ry[i] * side * hw
        // No ground inside, under the roof: across the road and out under the walls to the
        // hollow's edge (every half metre), the physics ground is a hole there or sits below
        // the road's edge. (Along an approach the road is open to the sky; the ground row
        // judges it.)
        for (let b = -hw; ts.covered[i] && b <= TUNNEL_HOLLOW - 0.5; b += 0.5) {
          const l = side * (hw + b)
          const gx = S.px[i] + S.rx[i] * l
          const gz = S.pz[i] + S.rz[i] * l
          if (groundHoleAt(t, gx, gz)) continue
          const rel = t.terrainHeight(gx, gz) - (b < 0 ? S.py[i] + S.ry[i] * l : edgeY)
          if (rel > c.ground) {
            c.ground = rel
            c.groundAt = s
          }
        }
      }
    }
    // The lip: every point round the edge of the tube's top (its outer edges and the ends of
    // its walls' tops) against the ground just beside it, outside the tube.
    const rim = x.tunnelSolids[id - 1]?.rim
    if (rim) {
      for (let k = 0; k < rim.length; k += 5) {
        const beside = t.terrainHeight(rim[k] + rim[k + 3] * 0.05, rim[k + 2] + rim[k + 4] * 0.05)
        const lip = rim[k + 1] - beside
        if (lip > c.lip) {
          c.lip = lip
          t.nearest(rim[k], rim[k + 1], rim[k + 2], hit)
          c.lipAt = hit.s
        }
        c.under = Math.max(c.under, -lip)
      }
    }
  }
  return out
}
