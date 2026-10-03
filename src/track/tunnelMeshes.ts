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
//  The roof follows the hill the tunnel is dug through: the natural
//  ground, or where another road crosses over the tunnel, the ground
//  as that road shaped it. Under that road the roof tucks just under
//  its surface (its own closed slab is what a car drives on there).
//
//  Every row of every part sits on a road sample, every ROW samples,
//  so the pieces meet exactly; physics vertices that land on the same
//  spot are welded, so the walls are one surface a car slides along.
// ============================================================

import { MeshBuilder } from './ribbon'
import { SURFACE_CODE, type MeshBuffers, type TrackSamples, type TunnelMeshes } from './types'
import { gridHeight, openShoulderY, tunnelWallAt, TUNNEL_HOLLOW_FROM, TUNNEL_WALL_MIN, type NaturalGrid } from './terrain'
import { smoothstep } from './noise'
import { TUNNEL_LIP, TUNNEL_WALL, type TunnelSamples } from './tunnels'

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
/**
 * Under a road crossing over the roof, the roof's top tucks this far (metres) under its surface
 * across the middle, rising to OVER_EDGE_TUCK under its edges over the last OVER_EDGE_BAND metres
 * (as the ground under a road does, terrain.ts): just past the edge the roof meets the road nearly
 * flush, with no groove where a triangle reaches from under the road out to the roof beside it...
 */
const OVER_TUCK = 0.3
const OVER_EDGE_TUCK = 0.05
const OVER_EDGE_BAND = 2.5
/** ...and for this far (metres) past its edges the roof stands no higher than OVER_EDGE_TUCK under the edge. */
const OVER_EDGE_CAP = 1.5
/** ...and roof triangles whose corners are all this far (metres) in from its edges are left out of physics: the road's closed slab holds a car there (like the ground under a road, terrain.ts). */
const OVER_COVER_MARGIN = 0.25

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
  // (Where a wall is just starting to grow its top can sit a hair under the road's edge: never
  // fold the face down below the edge. A wall of no height collapses to nothing, which the weld drops.)
  const h = Math.max(0, H)
  out.length = 0
  out.push(-WALL_FOOT, 0)
  for (let k = 1; k <= 4; k++) out.push(Math.min(1.2 * k, (h * k) / 5))
  out.push(h)
  return out
}

/**
 * Build every built tunnel's meshes. `hillGrid` is the hill the tunnels are dug through, on the
 * terrain grid (terrain.ts hillGroundOf: the natural ground, shaped by any road crossing over a
 * tunnel), and `ground` the final, cut-and-filled ground (terrain.ts flattenToRoad).
 */
export function buildTunnelMeshes(S: TrackSamples, ts: TunnelSamples, hillGrid: NaturalGrid, ground: NaturalGrid): TunnelBuild | null {
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
    // Road crossing over this tunnel's roof (other road, not its own stretch): the roof tucks under it.
    const overAt = makeOverRoad(S, ts, id, a, b)
    /** A top vertex at (x, z) with height y, kept under any road crossing over it. */
    const underOver = (x: number, z: number, y: number): number => {
      const o = overAt(x, z)
      if (!o || o.beyond > OVER_EDGE_CAP) return y
      // Just past the edge, no higher than just under it, as the ground beside a road sits (so no
      // triangle reaching from here in under the road comes up near its surface).
      if (o.beyond > 0) return Math.min(y, o.surface - OVER_EDGE_TUCK)
      const tuck = OVER_EDGE_TUCK + (OVER_TUCK - OVER_EDGE_TUCK) * (1 - smoothstep(-OVER_EDGE_BAND - 2, -OVER_EDGE_BAND, o.beyond))
      return Math.min(y, o.surface - tuck)
    }

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
          const natural = gridHeight(hillGrid, x, z)
          // The wall's top: the usual shoulder blended into the hill by how much of a wall stands
          // here, plus the lip. The ground's own vertices past the hollow follow the same blend
          // (terrain.ts), so the ground beside the tube meets its edge exactly a lip below it.
          // (Not the ground grid read between its vertices: a 3 m cell reaching in to the hollow
          // next to the road sags metres below the blend, and the top took that sag as a groove
          // along both sides of every roof, 6 m out from the road's edges. At the outer edge it is
          // the grid, which no cell reaching the hollow touches, so the edge meets the ground
          // beside it exactly as it lies between its vertices.)
          const hn = openShoulderY(S, i, lat, 0, natural)
          const k = (r * 2 + sd) * nb + c
          // Next to the road the ground only sinks under a wall that is more than a kerb (eased
          // in as it grows), and until it does the top there is that ground plus the lip.
          const onGround = gridHeight(ground, x, z) + TUNNEL_LIP
          // (Further out, the same: no hollow next to the road, no sag in the grid.)
          const sunk = c === nb - 1 ? 0 : smoothstep(TUNNEL_WALL_MIN, TUNNEL_HOLLOW_FROM, w)
          topY[k] = underOver(x, z, onGround + (hn + Math.max(0, natural - hn) * w + TUNNEL_LIP - onGround) * sunk)
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
                // (Not under a road crossing over the tube, where the road meets the ground instead.)
                if (!nearOver(overAt, posX[k], posZ[k])) rim.push(posX[k], topY[k], posZ[k], (S.rx[i] * side) / ol, (S.rz[i] * side) / ol)
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
                  if (!nearOver(overAt, posX[k], posZ[k])) rim.push(posX[k], topY[k], posZ[k], nx / nl, nz / nl)
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
          const vx = S.px[i] + S.rx[i] * lat
          const vz = S.pz[i] + S.rz[i] * lat
          const y = c === 0 ? topAt(r, 0, 0) : c === m ? topAt(r, 1, 0) : underOver(vx, vz, gridHeight(hillGrid, vx, vz) + TUNNEL_LIP)
          mb.vertex(vx, y, vz, 0, 1, 0, lat, i * S.ds)
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

    solids.push({ walls: weld(wallP.build()), top: weld(withoutUnderOver(topP.build(), overAt)), rim: Float32Array.from(rim) })
  }

  return { meshes: { inside: inside.build(), hill: hill.build() }, solids }
}

/** Where a road crosses over a tunnel: its surface over a spot, and how far the spot is past its edge (negative: under it). */
interface OverHit {
  surface: number
  beyond: number
}

/** Samples closer than this (metres) to a tunnel's stretch along the road are its own road. */
const OWN_ROAD = 80

/**
 * A lookup for "is there a road crossing over tunnel `id` at (x, z)?": other road (not the
 * tunnel's own stretch [a, b], nor OWN_ROAD metres either side) that passes over the tube's
 * footprint. Returns its surface there and how far past its edge the spot is, or null.
 */
function makeOverRoad(S: TrackSamples, ts: TunnelSamples, id: number, a: number, b: number): (x: number, z: number) => OverHit | null {
  // The tube's footprint, roughly: a box round its samples, out past its walls.
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (let i = a; i <= b; i++) {
    if (ts.slot[i] !== id) continue
    minX = Math.min(minX, S.px[i])
    maxX = Math.max(maxX, S.px[i])
    minZ = Math.min(minZ, S.pz[i])
    maxZ = Math.max(maxZ, S.pz[i])
  }
  const pad = TUNNEL_WALL + 30
  const own = Math.round(OWN_ROAD / S.ds)
  const list: number[] = []
  for (let j = 0; j < S.count; j++) {
    if (S.surface[j] !== SURFACE_CODE.road) continue
    if (j >= a - own && j <= b + own) continue
    if (j + S.count <= b + own || j - S.count >= a - own) continue
    if (S.px[j] < minX - pad || S.px[j] > maxX + pad || S.pz[j] < minZ - pad || S.pz[j] > maxZ + pad) continue
    list.push(j)
  }
  if (!list.length) return () => null
  return (x, z) => {
    let best = -1
    let bestD = Infinity
    for (const j of list) {
      const d = (x - S.px[j]) ** 2 + (z - S.pz[j]) ** 2
      if (d < bestD) {
        bestD = d
        best = j
      }
    }
    const dx = x - S.px[best]
    const dz = z - S.pz[best]
    if (Math.abs(dx * S.tx[best] + dz * S.tz[best]) > S.ds) return null
    const rh2 = S.rx[best] * S.rx[best] + S.rz[best] * S.rz[best]
    const lat = rh2 > 1e-4 ? (dx * S.rx[best] + dz * S.rz[best]) / rh2 : 0
    const hw = S.halfWidth[best]
    if (Math.abs(lat) > hw + 3) return null
    return { surface: S.py[best] + S.ry[best] * Math.max(-hw, Math.min(hw, lat)), beyond: Math.abs(lat) - hw }
  }
}

/**
 * Is (x, z) under a road crossing over the tube, or close enough past its edge that the roof is held
 * just under that edge (OVER_EDGE_CAP, half a metre more)? The rim there meets that road, not the
 * ground: the tunnel check's lip measure leaves it out, and its over-road measure judges it.
 */
function nearOver(overAt: (x: number, z: number) => OverHit | null, x: number, z: number): boolean {
  const o = overAt(x, z)
  return !!o && o.beyond <= OVER_EDGE_CAP + 0.5
}

/**
 * The tube's top for physics, under a road crossing over it, without:
 *  - the triangles wholly under its deck: that road's closed slab holds a car there, and a face a
 *    few centimetres under the deck only gives a car's body something to catch on through the
 *    road (the ground under a road is left out too);
 *  - steep faces (the short skirts round the tube's edge) under it or within OVER_EDGE_CAP of its
 *    edges: their top edge runs across the road just under its surface, and a car's soft CCD,
 *    looking a whole step ahead, takes an edge there for a wall across the road (CLAUDE.md). The
 *    road's slab meets the ground there instead.
 */
function withoutUnderOver(m: MeshBuffers, overAt: (x: number, z: number) => OverHit | null): MeshBuffers {
  const P = m.positions
  const under = new Uint8Array(P.length / 3)
  const near = new Uint8Array(P.length / 3)
  let any = false
  for (let v = 0; v < under.length; v++) {
    const o = overAt(P[v * 3], P[v * 3 + 2])
    if (!o || o.beyond > OVER_EDGE_CAP) continue
    near[v] = 1
    if (o.beyond <= -OVER_COVER_MARGIN) under[v] = 1
    any = true
  }
  if (!any) return m
  const keep: number[] = []
  for (let t = 0; t < m.indices.length; t += 3) {
    const i0 = m.indices[t]
    const i1 = m.indices[t + 1]
    const i2 = m.indices[t + 2]
    if (under[i0] && under[i1] && under[i2]) continue
    if ((near[i0] || near[i1] || near[i2]) && steep(P, i0, i1, i2)) continue
    keep.push(i0, i1, i2)
  }
  return { ...m, indices: Uint32Array.from(keep) }
}

/** Is triangle (a, b, c) steeper than 60 degrees (its normal less than half up)? */
function steep(P: Float32Array, a: number, b: number, c: number): boolean {
  const ux = P[b * 3] - P[a * 3]
  const uy = P[b * 3 + 1] - P[a * 3 + 1]
  const uz = P[b * 3 + 2] - P[a * 3 + 2]
  const vx = P[c * 3] - P[a * 3]
  const vy = P[c * 3 + 1] - P[a * 3 + 1]
  const vz = P[c * 3 + 2] - P[a * 3 + 2]
  const nx = uy * vz - uz * vy
  const ny = uz * vx - ux * vz
  const nz = ux * vy - uy * vx
  return Math.abs(ny) < 0.5 * Math.hypot(nx, ny, nz)
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
