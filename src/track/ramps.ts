// ============================================================
//  RAMPS - kicker wedges that sit on the road
// ------------------------------------------------------------
//  A ramp is a wedge: it rises from the road surface to `height` at
//  its lip, which faces the driving direction, then drops straight
//  down. Its sides slope outward (about 45 degrees) so a car that
//  clips the edge rolls off it rather than being flicked sideways.
//
//  The base sinks 0.15 m into the road: the top surface grows out
//  of the asphalt with no step to bump over, and no face of the
//  wedge lies flat on the road (flat-on-flat faces flicker).
//
//  Each ramp gives a convex point cloud (the collider is a convex
//  hull, the most reliable shape rapier has) and faces for the mesh.
// ============================================================

import type { RampPiece } from './schema'
import { SURFACE_CODE, type MeshBuffers, type TrackFrame } from './types'
import type { RoadQueries } from './query'
import { MeshBuilder } from './ribbon'

const SINK = 0.15

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
    const run = Math.min(h, Math.max(0.5 * h, hw + 0.3 - (Math.abs(off) + w / 2)))
    const C = frame.position
    const T = frame.tangent
    const U = frame.up
    const R = frame.right
    const P = (a: number, l: number, v: number): [number, number, number] => [
      C.x + T.x * a + R.x * l + U.x * v,
      C.y + T.y * a + R.y * l + U.y * v,
      C.z + T.z * a + R.z * l + U.z * v,
    ]
    const a0 = -len / 2
    const a1 = len / 2
    const lL = off - w / 2
    const lR = off + w / 2
    const FL = P(a0, lL, -SINK)
    const FR = P(a0, lR, -SINK)
    const BLb = P(a1, lL - run, -SINK)
    const BRb = P(a1, lR + run, -SINK)
    const BLt = P(a1, lL, h)
    const BRt = P(a1, lR, h)
    hulls.push(Float32Array.from([...FL, ...FR, ...BLb, ...BRb, ...BLt, ...BRt]))

    // The wedge's middle: every face must point away from it.
    const mid = P(0, off, h * 0.3)
    // Faces, each with its own flat normal, wound to face outward.
    const face = (ptsIn: [number, number, number][], uvsIn: [number, number][], alongIn: number[]) => {
      let pts = ptsIn
      let uvs = uvsIn
      let along = alongIn
      const [a, b, c] = pts
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
      const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
      let nx = e1[1] * e2[2] - e1[2] * e2[1]
      let ny = e1[2] * e2[0] - e1[0] * e2[2]
      let nz = e1[0] * e2[1] - e1[1] * e2[0]
      const l = Math.hypot(nx, ny, nz) || 1
      nx /= l
      ny /= l
      nz /= l
      let cx = 0
      let cy = 0
      let cz = 0
      for (const p of pts) {
        cx += p[0] / pts.length
        cy += p[1] / pts.length
        cz += p[2] / pts.length
      }
      if ((cx - mid[0]) * nx + (cy - mid[1]) * ny + (cz - mid[2]) * nz < 0) {
        pts = [...pts].reverse()
        uvs = [...uvs].reverse()
        along = [...along].reverse()
        nx = -nx
        ny = -ny
        nz = -nz
      }
      const ids = pts.map((p, k) => mb.vertex(p[0], p[1], p[2], nx, ny, nz, uvs[k][0], uvs[k][1], { aAlong: along[k], aKind: SURFACE_CODE.ramp }))
      if (ids.length === 3) mb.idx.push(ids[0], ids[1], ids[2])
      else mb.idx.push(ids[0], ids[1], ids[2], ids[0], ids[2], ids[3])
    }
    face([FL, BLt, BRt, FR], [[0, 0], [0, len], [1, len], [1, 0]], [0, 1, 1, 0]) // top (the run-up)
    face([BLb, BRb, BRt, BLt], [[0, 0], [1, 0], [1, h], [0, h]], [1, 1, 1, 1]) // lip face
    face([FL, BLb, BLt], [[0, 0], [0, len], [1, len]], [0, 1, 1]) // left slope
    face([FR, BRt, BRb], [[0, 0], [1, len], [0, len]], [0, 1, 1]) // right slope
  }
  return { mesh: mb.build(), hulls }
}
