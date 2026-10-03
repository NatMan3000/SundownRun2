// ============================================================
//  TUNNEL MESHES - the tube that puts the hill back over a tunnel
// ------------------------------------------------------------
//  tunnels.ts decides where each tunnel is, how deep the road goes
//  and how much of a wall of ground stands beside each edge. This
//  file turns that into triangles, for drawing and for physics:
//
//    inside (drawn)   the walls and ceiling round the road under the
//                     roof: dark, with glowing strips (look/road/
//                     TunnelView.tsx draws it, with the cover value)
//    hill (drawn)     everything that is part of the hillside: the
//                     roof over each covered stretch (the natural
//                     ground, 5 cm up), the walls of ground along the
//                     approaches and their tops, and a face of
//                     hillside over each mouth (the portal), drawn in
//                     the ground's own material (world/Terrain.tsx)
//    walls (physics)  one continuous mesh per tunnel: both walls from
//                     where the approach starts to where it ends, and
//                     the ceiling. Tagged 'barrier' (cars slide along).
//                     Cut into car-sized pieces (2 m along, at most
//                     1.2 m up the face where a car touches it), never
//                     a chain of boxes or tall slivers (CLAUDE.md).
//    top (physics)    the roof, the walls' tops, the portal faces and
//                     the short faces round the edges: the hill a car
//                     drives over. Tagged 'terrain'.
//
//  Every row of every part sits on a road sample, every ROW samples,
//  so the pieces meet exactly; physics vertices that land on the same
//  spot are welded, so the walls are one surface a car slides along.
// ============================================================

import { MeshBuilder } from './ribbon'
import type { MeshBuffers, TrackSamples, TunnelMeshes } from './types'
import { gridHeight, openShoulderY, tunnelWallAt, TUNNEL_HOLLOW_FROM, TUNNEL_WALL_MIN, type NaturalGrid } from './terrain'
import { smoothstep } from './noise'
import { TUNNEL_HOLLOW, TUNNEL_LIP, type TunnelSamples } from './tunnels'

/** One row of the tube every this many road samples (about 2 m). */
const ROW = 2
/** Columns across each wall's top, metres past the road edge (out to TUNNEL_WALL, tunnels.ts). */
const BAND = [0, 1.5, 3, 4.5, 6, 7.5, 9]
/** The walls reach this far below the road edge (into the road's slab, so no gap shows). */
const WALL_FOOT = 0.3
/** The short faces round the tube's outer edges and ends reach this far down into the ground. */
const SKIRT_DOWN = 1
/** Columns across the roof over the road: no wider apart than this, metres. */
const ROOF_STEP = 2

/** A plain triangle mesh (for a physics collider). */
export interface SolidMesh {
  vertices: Float32Array
  indices: Uint32Array
}

/** Per tunnel, its physics. */
export interface TunnelSolids {
  walls: SolidMesh
  top: SolidMesh
  /**
   * Points round the edge of the tube's top where it meets the ground (its outer edges and the
   * ends of its walls' tops): x, y, z and the horizontal direction out of the tube (dx, dz),
   * five numbers each. The tunnel check measures the lip there.
   */
  rim: Float32Array
}

export interface TunnelBuild {
  meshes: TunnelMeshes
  solids: TunnelSolids[]
}

/**
 * Corner heights up a wall face `H` metres tall (above the road edge): from under the slab,
 * the edge, then about 1.2 m apart (closer on a short wall), the same count on every row so
 * neighbouring rows share whole edges.
 */
function faceCorners(H: number, out: number[]): number[] {
  out.length = 0
  out.push(-WALL_FOOT, 0)
  for (let k = 1; k <= 4; k++) out.push(Math.min(1.2 * k, (H * k) / 5))
  out.push(H)
  return out
}

/**
 * Build every built tunnel's meshes. `natGrid` is the natural ground on the terrain grid and
 * `ground` the final, cut-and-filled ground (terrain.ts flattenToRoad).
 */
export function buildTunnelMeshes(S: TrackSamples, ts: TunnelSamples, natGrid: NaturalGrid, ground: NaturalGrid): TunnelBuild | null {
  if (!ts.list.length) return null
  const inside = new MeshBuilder(['aCover', 'aPart'])
  const hill = new MeshBuilder([])
  const solids: TunnelSolids[] = []
  const corners: number[] = []

  for (let t = 0; t < ts.list.length; t++) {
    const id = t + 1
    // This tunnel's samples, its portals, and its rows.
    let a = -1
    let b = -1
    let c0 = -1
    let c1 = -1
    for (let i = 0; i < S.count; i++) {
      if (ts.slot[i] !== id) continue
      if (a < 0) a = i
      b = i
      if (ts.covered[i]) {
        if (c0 < 0) c0 = i
        c1 = i
      }
    }
    if (a < 0 || c0 < 0) continue
    const rowSet = new Set<number>()
    for (let i = a; i < c0; i += ROW) rowSet.add(i)
    for (let i = c0; i < c1; i += ROW) rowSet.add(i)
    for (let i = c1; i < b; i += ROW) rowSet.add(i)
    rowSet.add(b)
    // Every wall starts and stops on a row of its own: the ground is left out under a wall's
    // solid exactly from its first sample to its last (terrain.ts), so the solid must be there.
    const has = (i: number, lat: number) => tunnelWallAt(ts, i, lat) > TUNNEL_WALL_MIN
    for (let i = a + 1; i <= b; i++) {
      for (const lat of [-1, 1]) {
        if (has(i, lat) && !has(i - 1, lat)) rowSet.add(i)
        if (has(i - 1, lat) && !has(i, lat)) rowSet.add(i - 1)
      }
    }
    const rows = [...rowSet].sort((p, q) => p - q)
    const isCov = (i: number) => i >= c0 && i <= c1

    // ---- per row: the cross-section ----
    // Horizontal outward unit vector, edge points, natural ground and the walls' tops.
    const R = rows.length
    const nb = BAND.length
    const topY = new Float64Array(R * 2 * nb) // [row][side 0 = left, 1 = right][band column]
    const posX = new Float64Array(R * 2 * nb)
    const posZ = new Float64Array(R * 2 * nb)
    const wOf = new Float32Array(R * 2)
    const edgeY = new Float64Array(R * 2)
    for (let r = 0; r < R; r++) {
      const i = rows[r]
      const hw = S.halfWidth[i]
      for (let sd = 0; sd < 2; sd++) {
        const side = sd === 0 ? -1 : 1
        const w = isCov(i) ? 1 : sd === 0 ? ts.wallL[i] : ts.wallR[i]
        wOf[r * 2 + sd] = w
        edgeY[r * 2 + sd] = S.py[i] + S.ry[i] * side * hw
        for (let c = 0; c < nb; c++) {
          const lat = side * (hw + BAND[c])
          const x = S.px[i] + S.rx[i] * lat
          const z = S.pz[i] + S.rz[i] * lat
          const natural = gridHeight(natGrid, x, z)
          // The wall's top: the usual shoulder blended into the natural ground by how much of
          // a wall stands here. Past the hollow next to the road the ground under it follows the
          // same blend (terrain.ts), so there the top is simply that ground plus the lip: the
          // ground beside the tube meets its edge exactly a lip below it.
          const hn = openShoulderY(S, i, lat, 0, natural)
          const k = (r * 2 + sd) * nb + c
          // Next to the road the ground only sinks under a wall that is more than a kerb (eased
          // in as it grows), and until it does the top is that ground plus the lip as well.
          const onGround = gridHeight(ground, x, z) + TUNNEL_LIP
          const sunk = BAND[c] >= TUNNEL_HOLLOW + 1 ? 0 : smoothstep(TUNNEL_WALL_MIN, TUNNEL_HOLLOW_FROM, w)
          topY[k] = onGround + (hn + Math.max(0, natural - hn) * w + TUNNEL_LIP - onGround) * sunk
          posX[k] = x
          posZ[k] = z
        }
      }
    }
    const topAt = (r: number, sd: number, c: number) => topY[(r * 2 + sd) * nb + c]

    // ---- physics builders for this tunnel ----
    const wallP = new MeshBuilder([])
    const topP = new MeshBuilder([])
    const rim: number[] = []

    // ---- the walls' tops (both sides, every row where a wall stands): hill + physics top ----
    for (let sd = 0; sd < 2; sd++) {
      const side = sd === 0 ? -1 : 1
      // Runs of rows where this side has a wall.
      let r = 0
      while (r < R) {
        if (wOf[r * 2 + sd] <= TUNNEL_WALL_MIN) {
          r++
          continue
        }
        let e = r
        while (e + 1 < R && wOf[(e + 1) * 2 + sd] > TUNNEL_WALL_MIN) e++
        if (e > r) {
          for (const mb of [hill, topP]) {
            const vTop: number[] = []
            const vSkirt: number[] = []
            for (let q = r; q <= e; q++) {
              const i = rows[q]
              const s = i * S.ds
              const ox = S.rx[i] * side
              const oz = S.rz[i] * side
              const ol = Math.hypot(ox, oz) || 1
              vTop.push(mb.vertexCount)
              for (let c = 0; c < nb; c++) {
                const k = (q * 2 + sd) * nb + c
                mb.vertex(posX[k], topY[k], posZ[k], 0, 1, 0, BAND[c], s)
              }
              // The outer edge's short face down into the ground beside it.
              const k = (q * 2 + sd) * nb + nb - 1
              vSkirt.push(mb.vertexCount)
              mb.vertex(posX[k], topY[k], posZ[k], ox / ol, 0, oz / ol, 0, s)
              mb.vertex(posX[k], topY[k] - SKIRT_DOWN, posZ[k], ox / ol, 0, oz / ol, SKIRT_DOWN, s)
            }
            for (let q = 0; q < e - r; q++) {
              for (let c = 0; c < nb - 1; c++) mb.quad(vTop[q] + c, vTop[q] + c + 1, vTop[q + 1] + c + 1, vTop[q + 1] + c)
              mb.quad(vSkirt[q], vSkirt[q] + 1, vSkirt[q + 1] + 1, vSkirt[q + 1])
            }
            if (mb === topP) {
              for (let q = r; q <= e; q++) {
                const i = rows[q]
                const ol = Math.hypot(S.rx[i], S.rz[i]) || 1
                const k = (q * 2 + sd) * nb + nb - 1
                rim.push(posX[k], topY[k], posZ[k], (S.rx[i] * side) / ol, (S.rz[i] * side) / ol)
              }
            }
            // End caps where the wall stops (fading out at the ends of the approaches).
            for (const [q, dir] of [
              [r, -1],
              [e, 1],
            ] as const) {
              const i = rows[q]
              const nx = S.tx[i] * dir
              const nz = S.tz[i] * dir
              const nl = Math.hypot(nx, nz) || 1
              const capTop: number[] = []
              for (let c = 0; c < nb; c++) {
                const k = (q * 2 + sd) * nb + c
                capTop.push(mb.vertex(posX[k], topY[k], posZ[k], nx / nl, 0, nz / nl, BAND[c], i * S.ds))
                mb.vertex(posX[k], Math.min(topY[k], edgeY[q * 2 + sd]) - SKIRT_DOWN, posZ[k], nx / nl, 0, nz / nl, BAND[c], i * S.ds)
              }
              for (let c = 0; c < nb - 1; c++) mb.quad(capTop[c], capTop[c + 1], capTop[c + 1] + 1, capTop[c] + 1)
              if (mb === topP) {
                for (let c = 1; c < nb; c++) {
                  const k = (q * 2 + sd) * nb + c
                  rim.push(posX[k], topY[k], posZ[k], nx / nl, nz / nl)
                }
              }
            }
          }
        }
        r = e + 1
      }
    }

    // ---- the roof over the road (covered rows), and the portal faces ----
    const covRows: number[] = []
    for (let r = 0; r < R; r++) if (isCov(rows[r])) covRows.push(r)
    for (const mb of [hill, topP]) {
      const roofRow: number[] = []
      const nCols: number[] = []
      for (const r of covRows) {
        const i = rows[r]
        const hw = S.halfWidth[i]
        const m = Math.max(2, Math.ceil((2 * hw) / ROOF_STEP))
        nCols.push(m)
        roofRow.push(mb.vertexCount)
        for (let c = 0; c <= m; c++) {
          const lat = -hw + (2 * hw * c) / m
          // The two end columns are the walls' tops' first columns (the same point).
          const y = c === 0 ? topAt(r, 0, 0) : c === m ? topAt(r, 1, 0) : gridHeight(natGrid, S.px[i] + S.rx[i] * lat, S.pz[i] + S.rz[i] * lat) + TUNNEL_LIP
          mb.vertex(S.px[i] + S.rx[i] * lat, y, S.pz[i] + S.rz[i] * lat, 0, 1, 0, lat, i * S.ds)
        }
      }
      for (let q = 0; q < covRows.length - 1; q++) {
        // (The road's width can change along it: both rows have m + 1 columns of the same m.)
        const m = Math.min(nCols[q], nCols[q + 1])
        if (nCols[q] === nCols[q + 1]) for (let c = 0; c < m; c++) mb.quad(roofRow[q] + c, roofRow[q] + c + 1, roofRow[q + 1] + c + 1, roofRow[q + 1] + c)
        else {
          // Zip two rows with different column counts (no T-junctions).
          const A = roofRow[q]
          const B = roofRow[q + 1]
          const kA = nCols[q]
          const kB = nCols[q + 1]
          let ca = 0
          let cb = 0
          while (ca < kA || cb < kB) {
            if (cb < kB && (ca >= kA || (cb + 1) / kB <= (ca + 1) / kA)) {
              tri(mb, A + ca, B + cb + 1, B + cb)
              cb++
            } else {
              tri(mb, A + ca, A + ca + 1, B + cb)
              ca++
            }
          }
        }
      }
      // Portals: a face of hillside over each mouth, from the ceiling up to the roof.
      for (const [q, dir] of [
        [0, -1],
        [covRows.length - 1, 1],
      ] as const) {
        const r = covRows[q]
        const i = rows[r]
        const hw = S.halfWidth[i]
        const m = nCols[q]
        const ceil = ts.ceil[i]
        const nx = S.tx[i] * dir
        const nz = S.tz[i] * dir
        const nl = Math.hypot(nx, nz) || 1
        const up: number[] = []
        for (let c = 0; c <= m; c++) {
          const lat = -hw + (2 * hw * c) / m
          const x = S.px[i] + S.rx[i] * lat
          const z = S.pz[i] + S.rz[i] * lat
          const yTop = mb.pos[(roofRow[q] + c) * 3 + 1]
          up.push(mb.vertex(x, yTop, z, nx / nl, 0, nz / nl, lat, i * S.ds))
          mb.vertex(x, Math.min(ceil, yTop), z, nx / nl, 0, nz / nl, lat, i * S.ds)
        }
        for (let c = 0; c < m; c++) mb.quad(up[c], up[c + 1], up[c + 1] + 1, up[c] + 1)
      }
    }

    // ---- the walls' faces: the approaches (hill look) and under the roof (inside) ----
    // Physics: one strip per side over every row with a wall, the face up to the wall's top on
    // an approach and up to the ceiling under the roof.
    for (let sd = 0; sd < 2; sd++) {
      const side = sd === 0 ? -1 : 1
      let r = 0
      while (r < R) {
        if (wOf[r * 2 + sd] <= TUNNEL_WALL_MIN) {
          r++
          continue
        }
        let e = r
        while (e + 1 < R && wOf[(e + 1) * 2 + sd] > TUNNEL_WALL_MIN) e++
        if (e > r) {
          const faceRow: number[] = []
          for (let q = r; q <= e; q++) {
            const i = rows[q]
            const hw = S.halfWidth[i]
            const ex = S.px[i] + S.rx[i] * side * hw
            const ez = S.pz[i] + S.rz[i] * side * hw
            const ey = edgeY[q * 2 + sd]
            // Faces the road: the horizontal inward direction.
            const nx = -S.rx[i] * side
            const nz = -S.rz[i] * side
            const nl = Math.hypot(nx, nz) || 1
            const H = (isCov(i) ? ts.ceil[i] : topAt(q, sd, 0)) - ey
            faceCorners(H, corners)
            faceRow.push(wallP.vertexCount)
            for (const h of corners) wallP.vertex(ex, ey + h, ez, nx / nl, 0, nz / nl, h, i * S.ds)
          }
          const K = corners.length
          for (let q = 0; q < e - r; q++) for (let k = 0; k < K - 1; k++) wallP.quad(faceRow[q] + k, faceRow[q] + k + 1, faceRow[q + 1] + k + 1, faceRow[q + 1] + k)
          // At a portal the approach's face stands taller than the ceiling row it meets: the
          // triangle left above that row closes it.
          for (let q = r; q < e; q++) {
            const i0 = rows[q]
            const i1 = rows[q + 1]
            if (isCov(i0) === isCov(i1)) continue
            const open = isCov(i0) ? q + 1 : q // the approach row
            const shut = isCov(i0) ? q : q + 1 // the portal (covered) row
            const is = rows[shut]
            const hw = S.halfWidth[is]
            const ex = S.px[is] + S.rx[is] * side * hw
            const ez = S.pz[is] + S.rz[is] * side * hw
            const tall = topAt(shut, sd, 0)
            if (tall <= ts.ceil[is] + 0.01) continue
            const nx = -S.rx[is] * side
            const nz = -S.rz[is] * side
            const nl = Math.hypot(nx, nz) || 1
            const pTop = faceRow[open - r] + K - 1
            const sTop = faceRow[shut - r] + K - 1
            const extra = wallP.vertex(ex, tall, ez, nx / nl, 0, nz / nl, 0, is * S.ds)
            tri(wallP, pTop, sTop, extra, nx / nl, 0, nz / nl)
          }
          // Drawn faces: the approach's in the hill look, the covered stretch's inside.
          buildFaceRuns(S, ts, rows, r, e, sd, side, edgeY, topAt, isCov, hill, inside)
        }
        r = e + 1
      }
    }

    // ---- the ceiling (physics and inside) ----
    {
      const cRow: number[] = []
      for (const r of covRows) {
        const i = rows[r]
        const hw = S.halfWidth[i]
        const y = ts.ceil[i]
        cRow.push(wallP.vertexCount)
        for (const lat of [-hw, 0, hw]) wallP.vertex(S.px[i] + S.rx[i] * lat, y, S.pz[i] + S.rz[i] * lat, 0, -1, 0, lat, i * S.ds)
      }
      for (let q = 0; q < cRow.length - 1; q++) for (let k = 0; k < 2; k++) wallP.quad(cRow[q] + k, cRow[q] + k + 1, cRow[q + 1] + k + 1, cRow[q + 1] + k)
      // Drawn: the same ceiling, across from the left wall's top to the right wall's.
      const dRow: number[] = []
      for (const r of covRows) {
        const i = rows[r]
        const hw = S.halfWidth[i]
        const y = ts.ceil[i]
        dRow.push(inside.vertexCount)
        for (const lat of [-hw, 0, hw]) {
          // uv.x across the ceiling: metres from the middle.
          inside.vertex(S.px[i] + S.rx[i] * lat, y, S.pz[i] + S.rz[i] * lat, 0, -1, 0, lat, i * S.ds, { aCover: ts.cover[i], aPart: 1 })
        }
      }
      for (let q = 0; q < dRow.length - 1; q++) for (let k = 0; k < 2; k++) inside.quad(dRow[q] + k, dRow[q] + k + 1, dRow[q + 1] + k + 1, dRow[q + 1] + k)
    }

    solids.push({ walls: weld(wallP.build()), top: weld(topP.build()), rim: Float32Array.from(rim) })
  }

  return { meshes: { inside: inside.build(), hill: hill.build() }, solids }
}

/**
 * The drawn wall faces along one run of rows on one side: the approaches' faces go into the
 * hill mesh (a wall of ground), the covered stretch's into the inside mesh (the tunnel wall,
 * up to the ceiling). At a portal both meet on the portal row.
 */
function buildFaceRuns(
  S: TrackSamples,
  ts: TunnelSamples,
  rows: number[],
  r: number,
  e: number,
  sd: number,
  side: -1 | 1,
  edgeY: Float64Array,
  topAt: (r: number, sd: number, c: number) => number,
  isCov: (i: number) => boolean,
  hill: MeshBuilder,
  inside: MeshBuilder,
): void {
  // Split the run into stretches of the same kind, sharing the row where they meet.
  let q0 = r
  while (q0 < e) {
    const cov = isCov(rows[q0]) && isCov(rows[Math.min(e, q0 + 1)])
    let q1 = q0 + 1
    while (q1 < e && (isCov(rows[q1]) && isCov(rows[q1 + 1])) === cov) q1++
    const mb = cov ? inside : hill
    const ids: number[] = []
    for (let q = q0; q <= q1; q++) {
      const i = rows[q]
      const hw = S.halfWidth[i]
      const ex = S.px[i] + S.rx[i] * side * hw
      const ez = S.pz[i] + S.rz[i] * side * hw
      const ey = edgeY[q * 2 + sd]
      const nx = -S.rx[i] * side
      const nz = -S.rz[i] * side
      const nl = Math.hypot(nx, nz) || 1
      // Under the roof the wall stops at the ceiling; on an approach (and on the portal row,
      // seen from outside) it runs up to the wall's top.
      const top = cov ? ts.ceil[i] : topAt(q, sd, 0)
      const s = i * S.ds
      ids.push(mb.vertexCount)
      if (cov) {
        // uv.x up a wall: metres above the road's edge.
        for (const h of [-0.3, top - ey]) mb.vertex(ex, ey + h, ez, nx / nl, 0, nz / nl, h, s, { aCover: ts.cover[i], aPart: 0 })
      } else {
        for (const h of [-0.3, top - ey]) mb.vertex(ex, ey + h, ez, nx / nl, 0, nz / nl, h, s)
      }
    }
    for (let q = 0; q < ids.length - 1; q++) mb.quad(ids[q], ids[q] + 1, ids[q + 1] + 1, ids[q + 1])
    q0 = q1
  }
}

/** One triangle wound to face along (nx, ny, nz), or along the average of its vertex normals. */
function tri(mb: MeshBuilder, a: number, b: number, c: number, nx?: number, ny?: number, nz?: number): void {
  const P = mb.pos
  const e1x = P[b * 3] - P[a * 3]
  const e1y = P[b * 3 + 1] - P[a * 3 + 1]
  const e1z = P[b * 3 + 2] - P[a * 3 + 2]
  const e2x = P[c * 3] - P[a * 3]
  const e2y = P[c * 3 + 1] - P[a * 3 + 1]
  const e2z = P[c * 3 + 2] - P[a * 3 + 2]
  const N = mb.nor
  const wx = nx ?? N[a * 3] + N[b * 3] + N[c * 3]
  const wy = ny ?? N[a * 3 + 1] + N[b * 3 + 1] + N[c * 3 + 1]
  const wz = nz ?? N[a * 3 + 2] + N[b * 3 + 2] + N[c * 3 + 2]
  const g = (e1y * e2z - e1z * e2y) * wx + (e1z * e2x - e1x * e2z) * wy + (e1x * e2y - e1y * e2x) * wz
  if (g >= 0) mb.idx.push(a, b, c)
  else mb.idx.push(a, c, b)
}

/**
 * A physics mesh with the vertices that sit on the same spot merged into one (so neighbouring
 * pieces share whole edges, which rapier needs to slide a body smoothly across them) and the
 * triangles that collapse to nothing dropped. Every value is checked finite (the NaN firewall).
 */
function weld(m: MeshBuffers): SolidMesh {
  const P = m.positions
  const map = new Map<string, number>()
  const remap = new Int32Array(P.length / 3)
  const verts: number[] = []
  for (let v = 0; v < P.length / 3; v++) {
    const x = P[v * 3]
    const y = P[v * 3 + 1]
    const z = P[v * 3 + 2]
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      remap[v] = -1
      continue
    }
    const k = `${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`
    let id = map.get(k)
    if (id === undefined) {
      id = verts.length / 3
      map.set(k, id)
      verts.push(x, y, z)
    }
    remap[v] = id
  }
  const out: number[] = []
  let bad = 0
  for (let t = 0; t < m.indices.length; t += 3) {
    const a = remap[m.indices[t]]
    const b = remap[m.indices[t + 1]]
    const c = remap[m.indices[t + 2]]
    if (a < 0 || b < 0 || c < 0) {
      bad++
      continue
    }
    if (a === b || b === c || a === c) continue
    const e1x = verts[b * 3] - verts[a * 3]
    const e1y = verts[b * 3 + 1] - verts[a * 3 + 1]
    const e1z = verts[b * 3 + 2] - verts[a * 3 + 2]
    const e2x = verts[c * 3] - verts[a * 3]
    const e2y = verts[c * 3 + 1] - verts[a * 3 + 1]
    const e2z = verts[c * 3 + 2] - verts[a * 3 + 2]
    const cx = e1y * e2z - e1z * e2y
    const cy = e1z * e2x - e1x * e2z
    const cz = e1x * e2y - e1y * e2x
    if (cx * cx + cy * cy + cz * cz < 1e-8) continue
    out.push(a, b, c)
  }
  if (bad) console.error(`[track] a tunnel mesh had ${bad} triangles with a non-finite corner; left out`)
  return { vertices: Float32Array.from(verts), indices: Uint32Array.from(out) }
}
