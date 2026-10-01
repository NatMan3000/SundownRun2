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
//  Its sides slope outward (about 35 degrees where the road has room)
//  so a car that clips the edge is tipped up and rolls off rather than
//  being flicked sideways, while the slope stays narrow enough to leave
//  the rest of the road clear.
//
//  The base sinks 0.15 m into the road and the top starts 5 cm below
//  it, so no face of the ramp lies flat on the road (flat-on-flat
//  faces flicker).
//
//  Collider: one closed triangle mesh per ramp, tagged 'ramp'.
// ============================================================

import type { RampPiece } from './schema'
import { SURFACE_CODE, type MeshBuffers, type TrackFrame } from './types'
import type { RoadQueries } from './query'
import { MeshBuilder } from './ribbon'

/** A ramp's collision shape: a closed triangle mesh. */
export interface RampSolid {
  vertices: Float32Array
  indices: Uint32Array
}

const SINK = 0.15
/** Side slope: this many metres out per metre of height where the road has room (1.4 = ~35 degrees). */
export const SIDE_RUN = 1.4
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
): { mesh: MeshBuffers | null; solids: RampSolid[] } {
  if (spots.length === 0) return { mesh: null, solids: [] }
  const mb = new MeshBuilder(['aAlong', 'aKind'])
  const solids: RampSolid[] = []
  for (const { s, piece } of spots) {
    const len = piece.length ?? 12
    const w = piece.width ?? 8
    const h = piece.height ?? 2.4
    const off = piece.offset ?? 0
    q.frameAt(s, frame)
    const hw = frame.halfWidth
    // Side slope run at full height, per side: a gentle ~27 degrees (2 x height)
    // where there is room, steepened only where the road edge is close.
    const lL = off - w / 2
    const lR = off + w / 2
    const runL = Math.min(SIDE_RUN * h, Math.max(0.5 * h, hw + 0.3 + lL))
    const runR = Math.min(SIDE_RUN * h, Math.max(0.5 * h, hw + 0.3 - lR))
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
    const st: { a: number; y: number; runL: number; runR: number; f: number }[] = []
    for (let k = 0; k <= SLICES; k++) {
      const f = k / SLICES
      // Start a touch below the road so the top grows out of it (never lies flat on it).
      const y = -TOE + (h + TOE) * Math.pow(f, POWER)
      const rise = Math.max(0, y) / h
      st.push({ a: -len / 2 + len * f, y, runL: runL * rise, runR: runR * rise, f })
    }
    // The collider: one closed triangle mesh per ramp (top, both sides, the lip,
    // the toe and the bottom). One mesh, not a stack of convex slices: a car sliding
    // across the seam between two slices catches on it (measured: a 1500 m/s^2 jolt
    // at 30 m/s). colliders.ts builds it with FIX_INTERNAL_EDGES.
    {
      const verts: number[] = []
      const idx: number[] = []
      for (const S of st) {
        verts.push(...P(S.a, lL, S.y), ...P(S.a, lR, S.y), ...P(S.a, lL - S.runL, -SINK), ...P(S.a, lR + S.runR, -SINK))
      }
      // Corners per station: 0 top-left, 1 top-right, 2 base-left, 3 base-right.
      const q = (a: number, b: number, c: number, d: number) => idx.push(a, b, c, a, c, d)
      for (let k = 0; k < SLICES; k++) {
        const A = k * 4
        const B = (k + 1) * 4
        q(A, A + 1, B + 1, B) // top
        q(A + 2, A, B, B + 2) // left side
        q(A + 1, A + 3, B + 3, B + 1) // right side
        q(A + 3, A + 2, B + 2, B + 3) // bottom
      }
      q(0, 2, 3, 1) // toe
      const E = SLICES * 4
      q(E, E + 1, E + 3, E + 2) // lip face
      solids.push({ vertices: Float32Array.from(verts), indices: Uint32Array.from(idx) })
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
      // Side normals: outward and up, matching each side's slope (run vs height).
      const sl = (s2: number): [number, number, number] => {
        const run = s2 < 0 ? runL : runR
        const nx = R.x * s2 * (h + SINK) + U.x * run
        const ny = R.y * s2 * (h + SINK) + U.y * run
        const nz = R.z * s2 * (h + SINK) + U.z * run
        const l = Math.hypot(nx, ny, nz)
        return [nx / l, ny / l, nz / l]
      }
      left.push(vert(P(S.a, lL, S.y), sl(-1), 0, S.a + len / 2, S.f), vert(P(S.a, lL - S.runL, -SINK), sl(-1), 1, S.a + len / 2, S.f))
      right.push(vert(P(S.a, lR, S.y), sl(1), 0, S.a + len / 2, S.f), vert(P(S.a, lR + S.runR, -SINK), sl(1), 1, S.a + len / 2, S.f))
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
    const a = vert(P(L.a, lL - L.runL, -SINK), nF, 0, 0, 1)
    const b = vert(P(L.a, lR + L.runR, -SINK), nF, 1, 0, 1)
    const c = vert(P(L.a, lR, L.y), nF, 1, h, 1)
    const d = vert(P(L.a, lL, L.y), nF, 0, h, 1)
    mb.quad(a, b, c, d)
  }
  return { mesh: mb.build(), solids }
}
