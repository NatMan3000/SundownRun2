// ============================================================
//  TUNNEL COVER - how far inside a covered tunnel a spot is
// ------------------------------------------------------------
//  Inside a tunnel the sun, the sky and their reflections can't
//  reach. The road and the tunnel's walls carry that as a value per
//  vertex (src/track/tunnels.ts, the "cover": 0 in the open, rising
//  to 1 over the first 30 m past a portal). Things that move need it
//  at their own spot, every frame:
//
//    - the player's car (telemetry.tunnel: track/index.tsx writes it,
//      the look and the audio read it: the engine echoes inside)
//    - every car's paint and glass (vehicle/carModel.ts dims them)
//
//  tunnelCoverAt() answers for any spot: the cover of the road under
//  it, if it is under that road's roof (below the ceiling, within the
//  walls, near the road's surface), else 0. So a car on the hill over
//  a tunnel, or on a road crossing over its roof, stays in the open.
// ============================================================

import { getTrack } from './current'
import { trackInternals } from './build'
import type { NearestHit } from './types'

const hit: NearestHit = { s: 0, index: 0, lateral: 0, height: 0, distance: 0, onRoad: false }

/** The answer (reused: read it straight away). */
export const coverResult = { cover: 0, s: 0 }

/**
 * The tunnel cover at world spot (x, y, z), 0..1, into coverResult (with the road's s there, to
 * pass back as `hintS` next frame so the look-up stays quick). No allocation.
 */
export function tunnelCoverAt(x: number, y: number, z: number, hintS?: number): typeof coverResult {
  coverResult.cover = 0
  const t = getTrack()
  if (!t || !t.tunnels.length || !Number.isFinite(x + y + z)) return coverResult
  const ts = trackInternals(t)?.tunnels
  if (!ts) return coverResult
  t.nearest(x, y, z, hit, hintS !== undefined && Number.isFinite(hintS) ? hintS : undefined)
  coverResult.s = hit.s
  const i = hit.index
  const S = t.samples
  // Under this road's roof: below its ceiling, within its walls, and not far above or below the road.
  if (ts.covered[i] === 1 && y < ts.ceil[i] && Math.abs(hit.lateral) < S.halfWidth[i] + 1 && hit.height > -1.5 && hit.height < 4) {
    const v = ts.cover[i]
    coverResult.cover = Number.isFinite(v) ? v : 0
  }
  return coverResult
}
