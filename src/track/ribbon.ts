// ============================================================
//  RIBBON MESHES - the road as triangles
// ------------------------------------------------------------
//  Builds the MeshBuffers in TrackRuntime.meshes from the sampled
//  centreline. The same triangles feed the look worker's shaders AND
//  the physics colliders, so what you see is exactly what you drive on.
//
//    road      the drivable top: 13 vertices across every sample, plus
//              the curved walls of wall rides. Carries the shader
//              attributes aLateral, aHalfWidth, aCurv, aKind.
//    skirt     the slab's sides and underside (and the back of every
//              wall-ride wall), so the road is a solid you can see and
//              can't fall through, never a paper-thin sheet.
//    barriers  stadium walls along both edges (road.barriers = 'walls').
//    ramps     kicker wedges (ramps.ts).
//
//  Every face is a quad strip between two consecutive samples. Rather
//  than hand-picking each strip's winding, quad() checks the triangle
//  against the intended normal and flips it if needed: one rule, no
//  inside-out faces anywhere.
// ============================================================

import { SURFACE_CODE, type MeshBuffers, type TrackSamples } from './types'
import type { Centerline } from './road'

/** Vertices across the road surface (12 strips). */
export const ACROSS = 13
/** Vertices along a wall-ride wall's curve. */
const WALL_STEPS = 12
/** Thickness of a wall-ride wall, metres. */
const WALL_THICKNESS = 0.8
/** Thickness of a stadium barrier, metres. */
const BARRIER_THICKNESS = 0.7

/** Growable vertex/index buffers with optional extra attributes. */
export class MeshBuilder {
  pos: number[] = []
  nor: number[] = []
  uv: number[] = []
  idx: number[] = []
  extra: Record<string, number[]>

  constructor(extraNames: string[]) {
    this.extra = {}
    for (const n of extraNames) this.extra[n] = []
  }

  get vertexCount(): number {
    return this.pos.length / 3
  }

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, extra?: Record<string, number>): number {
    this.pos.push(x, y, z)
    this.nor.push(nx, ny, nz)
    this.uv.push(u, v)
    if (extra) for (const k in this.extra) this.extra[k].push(extra[k] ?? 0)
    else for (const k in this.extra) this.extra[k].push(0)
    return this.pos.length / 3 - 1
  }

  /**
   * Quad a-b-c-d (a,b on one row, d,c on the next, so a->b->c->d goes round it).
   * Winds both triangles so they face the average of the four vertex normals.
   */
  quad(a: number, b: number, c: number, d: number): void {
    const P = this.pos
    const N = this.nor
    const ax = P[a * 3]
    const ay = P[a * 3 + 1]
    const az = P[a * 3 + 2]
    // Face normal of a->b->c->d from its diagonals: (c - a) x (d - b), which points
    // the way the counter-clockwise winding a, b, c faces (robust for skinny quads).
    const e1x = P[c * 3] - ax
    const e1y = P[c * 3 + 1] - ay
    const e1z = P[c * 3 + 2] - az
    const e2x = P[d * 3] - P[b * 3]
    const e2y = P[d * 3 + 1] - P[b * 3 + 1]
    const e2z = P[d * 3 + 2] - P[b * 3 + 2]
    const gx = e1y * e2z - e1z * e2y
    const gy = e1z * e2x - e1x * e2z
    const gz = e1x * e2y - e1y * e2x
    const wx = N[a * 3] + N[b * 3] + N[c * 3] + N[d * 3]
    const wy = N[a * 3 + 1] + N[b * 3 + 1] + N[c * 3 + 1] + N[d * 3 + 1]
    const wz = N[a * 3 + 2] + N[b * 3 + 2] + N[c * 3 + 2] + N[d * 3 + 2]
    if (gx * wx + gy * wy + gz * wz >= 0) this.idx.push(a, b, c, a, c, d)
    else this.idx.push(a, c, b, a, d, c)
  }

  build(): MeshBuffers {
    const attributes: MeshBuffers['attributes'] = {}
    for (const k in this.extra) attributes[k] = { array: Float32Array.from(this.extra[k]), itemSize: 1 }
    return {
      positions: Float32Array.from(this.pos),
      normals: Float32Array.from(this.nor),
      uvs: Float32Array.from(this.uv),
      indices: Uint32Array.from(this.idx),
      attributes,
    }
  }
}

/** Row r of the strip set: sample index (row `count` repeats sample 0 with s = length). */
function rowSample(r: number, count: number): number {
  return r % count
}

export interface RibbonMeshes {
  road: MeshBuffers
  skirt: MeshBuffers
  barriers: MeshBuffers | null
}

/** Build the road top, skirt and (optionally) barrier meshes. */
export function buildRibbonMeshes(c: Centerline, barriers: boolean, barrierHeight: number): RibbonMeshes {
  const S = c.samples
  const count = S.count
  const rows = count + 1

  // ---------------- road top ----------------
  const road = new MeshBuilder(['aLateral', 'aHalfWidth', 'aCurv', 'aKind'])
  const extra = { aLateral: 0, aHalfWidth: 0, aCurv: 0, aKind: 0 }
  const topRow: number[] = []
  for (let r = 0; r < rows; r++) {
    const i = rowSample(r, count)
    const s = r * S.ds
    const hw = S.halfWidth[i]
    topRow.push(road.vertexCount)
    for (let a = 0; a < ACROSS; a++) {
      const l = -hw + (2 * hw * a) / (ACROSS - 1)
      extra.aLateral = l
      extra.aHalfWidth = hw
      extra.aCurv = S.curvature[i]
      extra.aKind = S.surface[i]
      road.vertex(
        S.px[i] + S.rx[i] * l,
        S.py[i] + S.ry[i] * l,
        S.pz[i] + S.rz[i] * l,
        S.ux[i],
        S.uy[i],
        S.uz[i],
        (l + hw) / (2 * hw),
        s,
        extra,
      )
    }
  }
  for (let r = 0; r < count; r++) {
    const A = topRow[r]
    const B = topRow[r + 1]
    for (let a = 0; a < ACROSS - 1; a++) road.quad(A + a, A + a + 1, B + a + 1, B + a)
  }

  // Wall-ride walls: their own strips, one per contiguous run of sweep > 0 per side.
  const skirt = new MeshBuilder(['aLateral', 'aHalfWidth'])
  for (const side of [-1, 1] as const) {
    const sweepArr = side < 0 ? c.wallLeft : c.wallRight
    for (const run of contiguousRuns(sweepArr, count)) addWall(road, skirt, S, c, side, sweepArr, run)
  }

  // ---------------- skirt: sides and underside ----------------
  const sk = { aLateral: 0, aHalfWidth: 0 }
  const skRow: number[] = []
  for (let r = 0; r < rows; r++) {
    const i = rowSample(r, count)
    const s = r * S.ds
    const hw = S.halfWidth[i]
    const t = c.thickness[i]
    const cx = S.px[i]
    const cy = S.py[i]
    const cz = S.pz[i]
    const Rx = S.rx[i]
    const Ry = S.ry[i]
    const Rz = S.rz[i]
    const Ux = S.ux[i]
    const Uy = S.uy[i]
    const Uz = S.uz[i]
    const Lx = cx - Rx * hw
    const Ly = cy - Ry * hw
    const Lz = cz - Rz * hw
    const Qx = cx + Rx * hw
    const Qy = cy + Ry * hw
    const Qz = cz + Rz * hw
    sk.aHalfWidth = hw
    skRow.push(skirt.vertexCount)
    // left side: lip, then down
    sk.aLateral = -hw
    skirt.vertex(Lx, Ly, Lz, -Rx, -Ry, -Rz, 0, s, sk)
    skirt.vertex(Lx - Ux * t, Ly - Uy * t, Lz - Uz * t, -Rx, -Ry, -Rz, t, s, sk)
    // underside: left, middle, right
    skirt.vertex(Lx - Ux * t, Ly - Uy * t, Lz - Uz * t, -Ux, -Uy, -Uz, t, s, sk)
    sk.aLateral = 0
    skirt.vertex(cx - Ux * t, cy - Uy * t, cz - Uz * t, -Ux, -Uy, -Uz, t + hw, s, sk)
    sk.aLateral = hw
    skirt.vertex(Qx - Ux * t, Qy - Uy * t, Qz - Uz * t, -Ux, -Uy, -Uz, t, s, sk)
    // right side: down, then lip
    skirt.vertex(Qx - Ux * t, Qy - Uy * t, Qz - Uz * t, Rx, Ry, Rz, t, s, sk)
    skirt.vertex(Qx, Qy, Qz, Rx, Ry, Rz, 0, s, sk)
  }
  for (let r = 0; r < count; r++) {
    const A = skRow[r]
    const B = skRow[r + 1]
    skirt.quad(A, A + 1, B + 1, B) // left side
    skirt.quad(A + 2, A + 3, B + 3, B + 2) // underside, left half
    skirt.quad(A + 3, A + 4, B + 4, B + 3) // underside, right half
    skirt.quad(A + 5, A + 6, B + 6, B + 5) // right side
  }

  // ---------------- barriers ----------------
  let barrierMesh: MeshBuffers | null = null
  if (barriers) {
    const bm = new MeshBuilder(['aLateral', 'aHalfWidth'])
    for (const side of [-1, 1] as const) addBarrier(bm, S, c, side, barrierHeight)
    barrierMesh = bm.build()
  }

  return { road: road.build(), skirt: skirt.build(), barriers: barrierMesh }
}

/** Contiguous index runs [start, end] (inclusive, may wrap past count) where arr > 0. */
export function contiguousRuns(arr: Float32Array, count: number): { start: number; end: number }[] {
  const runs: { start: number; end: number }[] = []
  // Start scanning at a zero so a run that wraps through index 0 is found whole.
  let z = 0
  while (z < count && arr[z] > 0) z++
  if (z >= count) return [{ start: 0, end: count }] // the whole lap (edge case)
  let i = 0
  while (i < count) {
    const a = (z + i) % count
    if (arr[a] > 0) {
      let len = 1
      while (len < count && arr[(a + len) % count] > 0) len++
      runs.push({ start: z + i, end: z + i + len - 1 })
      i += len
    } else i++
  }
  return runs
}

/** One wall-ride wall (front face into the road mesh, back + caps into the skirt). */
function addWall(
  road: MeshBuilder,
  skirt: MeshBuilder,
  S: TrackSamples,
  c: Centerline,
  side: -1 | 1,
  sweepArr: Float32Array,
  run: { start: number; end: number },
): void {
  const count = S.count
  const front: number[] = []
  const back: number[] = []
  const ex = { aLateral: 0, aHalfWidth: 0, aCurv: 0, aKind: SURFACE_CODE.wall }
  const sk = { aLateral: 0, aHalfWidth: 0 }
  for (let r = run.start; r <= run.end; r++) {
    const i = ((r % count) + count) % count
    const s = r * S.ds
    const hw = S.halfWidth[i]
    const R = c.wallRadius[i]
    const sweep = sweepArr[i]
    // Edge point, and the right vector pointing outward on this side.
    const ox = S.rx[i] * side
    const oy = S.ry[i] * side
    const oz = S.rz[i] * side
    const Ex = S.px[i] + ox * hw
    const Ey = S.py[i] + oy * hw
    const Ez = S.pz[i] + oz * hw
    ex.aHalfWidth = hw
    ex.aCurv = S.curvature[i]
    sk.aHalfWidth = hw
    front.push(road.vertexCount)
    back.push(skirt.vertexCount)
    for (let k = 0; k <= WALL_STEPS; k++) {
      const phi = (sweep * k) / WALL_STEPS
      const sp = Math.sin(phi)
      const cp = 1 - Math.cos(phi)
      const x = Ex + R * (ox * sp + S.ux[i] * cp)
      const y = Ey + R * (oy * sp + S.uy[i] * cp)
      const z = Ez + R * (oz * sp + S.uz[i] * cp)
      // Surface normal points at the curve's centre.
      const nx = S.ux[i] * Math.cos(phi) - ox * sp
      const ny = S.uy[i] * Math.cos(phi) - oy * sp
      const nz = S.uz[i] * Math.cos(phi) - oz * sp
      const arc = R * phi
      ex.aLateral = side * (hw + arc)
      const u = side > 0 ? 1 + arc / (2 * hw) : -arc / (2 * hw)
      road.vertex(x, y, z, nx, ny, nz, u, s, ex)
      sk.aLateral = side * (hw + arc)
      // uv.x on the back: metres from the wall's top lip (across the lip, then down the back).
      skirt.vertex(x - nx * WALL_THICKNESS, y - ny * WALL_THICKNESS, z - nz * WALL_THICKNESS, -nx, -ny, -nz, WALL_THICKNESS + R * (sweep - phi), s, sk)
    }
  }
  const rowsN = front.length
  for (let r = 0; r < rowsN - 1; r++) {
    for (let k = 0; k < WALL_STEPS; k++) {
      road.quad(front[r] + k, front[r] + k + 1, front[r + 1] + k + 1, front[r + 1] + k)
      skirt.quad(back[r] + k, back[r] + k + 1, back[r + 1] + k + 1, back[r + 1] + k)
    }
  }
  // Top lip: joins the front curve's last vertex to the back's along the run.
  const P = road.pos
  const Q = skirt.pos
  const lip: number[] = []
  for (let r = 0; r < rowsN; r++) {
    const i = (((run.start + r) % count) + count) % count
    const f = (front[r] + WALL_STEPS) * 3
    const b = (back[r] + WALL_STEPS) * 3
    // Lip normal: along the curve's direction at its end (tangent to the arc, outward).
    const sweep = sweepArr[i]
    const ox = S.rx[i] * side
    const oy = S.ry[i] * side
    const oz = S.rz[i] * side
    const nx = ox * Math.cos(sweep) + S.ux[i] * Math.sin(sweep)
    const ny = oy * Math.cos(sweep) + S.uy[i] * Math.sin(sweep)
    const nz = oz * Math.cos(sweep) + S.uz[i] * Math.sin(sweep)
    const s = (run.start + r) * S.ds
    sk.aHalfWidth = S.halfWidth[i]
    sk.aLateral = side * S.halfWidth[i]
    lip.push(skirt.vertex(P[f], P[f + 1], P[f + 2], nx, ny, nz, 0, s, sk))
    skirt.vertex(Q[b], Q[b + 1], Q[b + 2], nx, ny, nz, WALL_THICKNESS, s, sk)
  }
  for (let r = 0; r < rowsN - 1; r++) skirt.quad(lip[r], lip[r] + 1, lip[r + 1] + 1, lip[r + 1])
  // End caps: close the wall's cross-section at both ends of the run.
  for (const [r, dir] of [
    [0, -1],
    [rowsN - 1, 1],
  ] as const) {
    const i = (((run.start + r) % count) + count) % count
    const nx = S.tx[i] * dir
    const ny = S.ty[i] * dir
    const nz = S.tz[i] * dir
    const s = (run.start + r) * S.ds
    const capF: number[] = []
    const capB: number[] = []
    for (let k = 0; k <= WALL_STEPS; k++) {
      const f = (front[r] + k) * 3
      const b = (back[r] + k) * 3
      capF.push(skirt.vertex(P[f], P[f + 1], P[f + 2], nx, ny, nz, 0, s))
      capB.push(skirt.vertex(Q[b], Q[b + 1], Q[b + 2], nx, ny, nz, WALL_THICKNESS, s))
    }
    for (let k = 0; k < WALL_STEPS; k++) skirt.quad(capF[k], capF[k + 1], capB[k + 1], capB[k])
  }
}

/** A stadium barrier along one edge: inner face, top, outer face down to the slab bottom. */
function addBarrier(bm: MeshBuilder, S: TrackSamples, c: Centerline, side: -1 | 1, H: number): void {
  const count = S.count
  const rows = count + 1
  const rowStart: number[] = []
  const ex = { aLateral: 0, aHalfWidth: 0 }
  for (let r = 0; r < rows; r++) {
    const i = r % count
    const s = r * S.ds
    const hw = S.halfWidth[i]
    const t = c.thickness[i]
    const ox = S.rx[i] * side
    const oy = S.ry[i] * side
    const oz = S.rz[i] * side
    const Ux = S.ux[i]
    const Uy = S.uy[i]
    const Uz = S.uz[i]
    const Ex = S.px[i] + ox * hw
    const Ey = S.py[i] + oy * hw
    const Ez = S.pz[i] + oz * hw
    const Tk = BARRIER_THICKNESS
    ex.aHalfWidth = hw
    ex.aLateral = side * hw
    rowStart.push(bm.vertexCount)
    // inner face (faces the road)
    bm.vertex(Ex, Ey, Ez, -ox, -oy, -oz, 0, s, ex)
    bm.vertex(Ex + Ux * H, Ey + Uy * H, Ez + Uz * H, -ox, -oy, -oz, H, s, ex)
    // top
    bm.vertex(Ex + Ux * H, Ey + Uy * H, Ez + Uz * H, Ux, Uy, Uz, H, s, ex)
    bm.vertex(Ex + Ux * H + ox * Tk, Ey + Uy * H + oy * Tk, Ez + Uz * H + oz * Tk, Ux, Uy, Uz, H + Tk, s, ex)
    // outer face, down past the slab
    bm.vertex(Ex + Ux * H + ox * Tk, Ey + Uy * H + oy * Tk, Ez + Uz * H + oz * Tk, ox, oy, oz, H + Tk, s, ex)
    bm.vertex(Ex - Ux * t + ox * Tk, Ey - Uy * t + oy * Tk, Ez - Uz * t + oz * Tk, ox, oy, oz, 2 * H + Tk + t, s, ex)
  }
  for (let r = 0; r < count; r++) {
    // Skip where the road is a loop or a wall ride on this side.
    const i = r % count
    const j = (r + 1) % count
    if (S.surface[i] !== SURFACE_CODE.road || S.surface[j] !== SURFACE_CODE.road) continue
    const wall = side < 0 ? c.wallLeft : c.wallRight
    if (wall[i] > 0 || wall[j] > 0) continue
    const A = rowStart[r]
    const B = rowStart[r + 1]
    bm.quad(A, A + 1, B + 1, B)
    bm.quad(A + 2, A + 3, B + 3, B + 2)
    bm.quad(A + 4, A + 5, B + 5, B + 4)
  }
}

/** Indices of only the triangles whose every vertex has aKind / predicate true. For collider splits. */
export function splitBy(mesh: MeshBuffers, keep: (tri: number) => boolean): { vertices: Float32Array; indices: Uint32Array } {
  const idx = mesh.indices
  const remap = new Int32Array(mesh.positions.length / 3).fill(-1)
  const verts: number[] = []
  const out: number[] = []
  const P = mesh.positions
  for (let t = 0; t < idx.length / 3; t++) {
    if (!keep(t)) continue
    const a = idx[t * 3]
    const b = idx[t * 3 + 1]
    const c = idx[t * 3 + 2]
    // Drop degenerate slivers (zero-area triangles upset collision normals).
    const e1x = P[b * 3] - P[a * 3]
    const e1y = P[b * 3 + 1] - P[a * 3 + 1]
    const e1z = P[b * 3 + 2] - P[a * 3 + 2]
    const e2x = P[c * 3] - P[a * 3]
    const e2y = P[c * 3 + 1] - P[a * 3 + 1]
    const e2z = P[c * 3 + 2] - P[a * 3 + 2]
    const cx = e1y * e2z - e1z * e2y
    const cy = e1z * e2x - e1x * e2z
    const cz = e1x * e2y - e1y * e2x
    if (cx * cx + cy * cy + cz * cz < 1e-8) continue
    for (const v of [a, b, c]) {
      if (remap[v] < 0) {
        remap[v] = verts.length / 3
        verts.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2])
      }
      out.push(remap[v])
    }
  }
  return { vertices: Float32Array.from(verts), indices: Uint32Array.from(out) }
}
