// ============================================================
//  RAMPS - kicker ramps that sit on the road
// ------------------------------------------------------------
//  A ramp rises from the road surface to `height` at its lip, which
//  faces the driving direction, then drops straight down. Its top is
//  a curve, not a flat wedge: it leaves the road with no kink at all
//  and steepens toward the lip (height grows as (x / length)^1.6).
//  A flat wedge kicks the front wheels up in one instant at the toe,
//  which at speed sends the car into a tumble; a curve tips the car
//  up smoothly so it leaves the lip flying straight.
//
//  Its sides slope outward (about 45 degrees) so a car that clips the
//  edge rolls off rather than being flicked sideways.
//
//  The base sinks 0.15 m into the road and the top starts 5 cm below
//  it, so no face of the ramp lies flat on the road (flat-on-flat
//  faces flicker).
//
//  Colliders: one convex hull per slice along the curve (convex
//  shapes are rapier's most reliable), all tagged 'ramp'.
// ============================================================

import type { RampPiece } from './schema'
import { SURFACE_CODE, type MeshBuffers, type TrackFrame } from './types'
import type { RoadQueries } from './query'
import { MeshBuilder } from './ribbon'

const SINK = 0.15
/** The top surface starts this far below the road at the toe. */
const TOE = 0.05
/** Slices along the ramp (more = smoother curve). */
const SLICES = 10
/** Shape of the curve: height = h * (x / length)^POWER. */
const POWER = 1.6

export function buildRampMeshes(
  spots: { s: number; piece: RampPiece }[],
  q: RoadQueries,
  frame: TrackFrame,
): { mesh: MeshBuffers | null; hulls: Float32Array[] } {
  if (spots.length === 0) return { mesh: null, hulls: [] }
  const mb = new MeshBuilder(['aAlong', 'aKind'])
  const hulls: Float32Array[] = []
  for (const { s, piece } of spots) {
    const len = piece.length ?? 12
    const w = piece.width ?? 8
    const h = piece.height ?? 2.4
    const off = piece.offset ?? 0
    q.frameAt(s, frame)
    const hw = frame.halfWidth
    // Side slope run at full height: ~45 degrees, narrowed if the road edge is close.
    const runMax = Math.min(h, Math.max(0.5 * h, hw + 0.3 - (Math.abs(off) + w / 2)))
    const C = frame.position
    const T = frame.tangent
    const U = frame.up
    const R = frame.right
    const P = (a: number, l: number, v: number): [number, number, number] => [
      C.x + T.x * a + R.x * l + U.x * v,
      C.y + T.y * a + R.y * l + U.y * v,
      C.z + T.z * a + R.z * l + U.z * v,
    ]
    // Stations along the ramp: a (metres from the centre), top height, side run.
    const st: { a: number; y: number; run: number; f: number }[] = []
    for (let k = 0; k <= SLICES; k++) {
      const f = k / SLICES
      // Start a touch below the road so the top grows out of it (never lies flat on it).
      const y = -TOE + (h + TOE) * Math.pow(f, POWER)
      st.push({ a: -len / 2 + len * f, y, run: (runMax * Math.max(0, y)) / h, f })
    }
    const lL = off - w / 2
    const lR = off + w / 2
    // Convex slices for the collider.
    for (let k = 0; k < SLICES; k++) {
      const A = st[k]
      const B = st[k + 1]
      const pts = [
        P(A.a, lL - A.run, -SINK),
        P(A.a, lR + A.run, -SINK),
        P(B.a, lL - B.run, -SINK),
        P(B.a, lR + B.run, -SINK),
        P(A.a, lL, A.y),
        P(A.a, lR, A.y),
        P(B.a, lL, B.y),
        P(B.a, lR, B.y),
      ]
      hulls.push(Float32Array.from(pts.flat()))
    }

    // Mesh: top, two sloped sides, and the lip face. Every vertex carries aAlong (0 toe .. 1 lip).
    const ex = { aAlong: 0, aKind: SURFACE_CODE.ramp }
    const vert = (p: [number, number, number], n: [number, number, number], u: number, v: number, along: number) => {
      ex.aAlong = along
      return mb.vertex(p[0], p[1], p[2], n[0], n[1], n[2], u, v, ex)
    }
    const top: number[] = []
    const left: number[] = []
    const right: number[] = []
    for (const S of st) {
      // Top normal: perpendicular to the curve's slope dy/da.
      const slope = S.f > 0 ? (POWER * (h + TOE) * Math.pow(S.f, POWER - 1)) / len : 0
      const nl = Math.hypot(1, slope)
      const nT: [number, number, number] = [(U.x - T.x * slope) / nl, (U.y - T.y * slope) / nl, (U.z - T.z * slope) / nl]
      top.push(vert(P(S.a, lL, S.y), nT, 0, S.a + len / 2, S.f), vert(P(S.a, lR, S.y), nT, 1, S.a + len / 2, S.f))
      // Side normals: outward and up at about 45 degrees.
      const sl = (s2: number): [number, number, number] => {
        const nx = R.x * s2 + U.x
        const ny = R.y * s2 + U.y
        const nz = R.z * s2 + U.z
        const l = Math.hypot(nx, ny, nz)
        return [nx / l, ny / l, nz / l]
      }
      left.push(vert(P(S.a, lL, S.y), sl(-1), 0, S.a + len / 2, S.f), vert(P(S.a, lL - S.run, -SINK), sl(-1), 1, S.a + len / 2, S.f))
      right.push(vert(P(S.a, lR, S.y), sl(1), 0, S.a + len / 2, S.f), vert(P(S.a, lR + S.run, -SINK), sl(1), 1, S.a + len / 2, S.f))
    }
    for (let k = 0; k < SLICES; k++) {
      const i = k * 2
      mb.quad(top[i], top[i + 1], top[i + 3], top[i + 2])
      mb.quad(left[i], left[i + 1], left[i + 3], left[i + 2])
      mb.quad(right[i], right[i + 1], right[i + 3], right[i + 2])
    }
    // Lip face (facing forward, the way you fly off).
    const L = st[SLICES]
    const nF: [number, number, number] = [T.x, T.y, T.z]
    const a = vert(P(L.a, lL - L.run, -SINK), nF, 0, 0, 1)
    const b = vert(P(L.a, lR + L.run, -SINK), nF, 1, 0, 1)
    const c = vert(P(L.a, lR, L.y), nF, 1, h, 1)
    const d = vert(P(L.a, lL, L.y), nF, 0, h, 1)
    mb.quad(a, b, c, d)
  }
  return { mesh: mb.build(), hulls }
}
