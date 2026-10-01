// ============================================================
//  RIBBON MESHES - the road as triangles
// ------------------------------------------------------------
//  Builds the MeshBuffers in TrackRuntime.meshes from the sampled
//  centreline. Every vertex sits on a sample's frame (position + right
//  x lateral), so the look worker's shaders and the physics colliders
//  describe the same surface: what you see is what you drive on.
//  The colliders use buildDriveSurface (below): the same surface with
//  fewer triangles, more of them only where the road twists.
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
    // Where a stadium barrier stands on the ground, the slab's side stops where the barrier's
    // underside meets it (addBarrier): the barrier closes everything below, and a side carried
    // on down poked out of the ground's dips beside a steep bank's high edge.
    const tl = barriers && barrierStandsOnGround(S, c, i, -1) ? Math.min(t, BARRIER_BACK_FOOT / Uy) : t
    const tr = barriers && barrierStandsOnGround(S, c, i, 1) ? Math.min(t, BARRIER_BACK_FOOT / Uy) : t
    sk.aHalfWidth = hw
    skRow.push(skirt.vertexCount)
    // left side: lip, then down
    sk.aLateral = -hw
    skirt.vertex(Lx, Ly, Lz, -Rx, -Ry, -Rz, 0, s, sk)
    skirt.vertex(Lx - Ux * tl, Ly - Uy * tl, Lz - Uz * tl, -Rx, -Ry, -Rz, tl, s, sk)
    // underside: left, middle, right
    skirt.vertex(Lx - Ux * tl, Ly - Uy * tl, Lz - Uz * tl, -Ux, -Uy, -Uz, tl, s, sk)
    sk.aLateral = 0
    skirt.vertex(cx - Ux * t, cy - Uy * t, cz - Uz * t, -Ux, -Uy, -Uz, t + hw, s, sk)
    sk.aLateral = hw
    skirt.vertex(Qx - Ux * tr, Qy - Uy * tr, Qz - Uz * tr, -Ux, -Uy, -Uz, tr, s, sk)
    // right side: down, then lip
    skirt.vertex(Qx - Ux * tr, Qy - Uy * tr, Qz - Uz * tr, Rx, Ry, Rz, tr, s, sk)
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

/**
 * The barrier's solid (its physics box) reaches this far out from the road edge, and
 * this far below the bottom of the road's slab: far bigger than the visible wall, so it
 * can't be tunnelled, and big enough that every ground triangle reaching from under the
 * road to behind the barrier lies inside something solid (terrain.ts leaves those out
 * of the physics ground). Behind and under a wall nobody drives.
 */
export const BARRIER_DEPTH = 5
export const BARRIER_BELOW = 2
/** The barrier on a bank's LOW edge leans back toward upright, but never closer to the road than this (degrees). */
export const BARRIER_MIN_ROAD_ANGLE_DEG = 60

/** Which way a barrier stands at one sample: up along its face, and out away from the road. */
export interface BarrierAxes {
  /** Up the barrier's face (unit). */
  dx: number
  dy: number
  dz: number
  /** Out from the road, square to the face (unit). */
  ox: number
  oy: number
  oz: number
}

/**
 * The way a stadium barrier stands at sample i on one side (-1 left, +1 right).
 *
 * On the HIGH edge of a bank the barrier stands square to the road (along its up): a
 * car sliding up the bank meets it face on. On the LOW edge it leans back from square
 * toward upright: square to a 60 degree bank, a barrier would lean out over the infield
 * at 30 degrees, a ramp a car simply drives up and over (hyper-1 D3). It stands fully
 * upright on banks up to 30 degrees; steeper than that it stops at
 * BARRIER_MIN_ROAD_ANGLE_DEG to the road, because a truly upright wall on a 60 degree
 * bank meets the road at only 30 degrees and overhangs the bottom two metres of it: a
 * car parked there leaned its body on the wall and couldn't pull away (measured). At 60
 * degrees it is then a 60 degree face (too steep for tyres to climb) meeting the road at
 * 60. A flat road's barriers are unchanged. Both the visible wall (ribbon.ts) and its
 * physics box (colliders.ts) use this, so the two always agree.
 */
export function barrierAxes(S: TrackSamples, i: number, side: -1 | 1, out: BarrierAxes): BarrierAxes {
  const tx = S.tx[i]
  const ty = S.ty[i]
  const tz = S.tz[i]
  // World up, made square to the road's direction (it stays in the road's cross-section).
  let vx = -tx * ty
  let vy = 1 - ty * ty
  let vz = -tz * ty
  const vl = Math.hypot(vx, vy, vz) || 1
  vx /= vl
  vy /= vl
  vz /= vl
  // How far this side's edge drops (the sine of the bank, + on the low side): lean the
  // barrier back from square by that bank, up to (90 - BARRIER_MIN_ROAD_ANGLE_DEG) degrees.
  const drop = -side * S.ry[i]
  const lean = Math.min(Math.asin(Math.max(0, Math.min(1, drop))), ((90 - BARRIER_MIN_ROAD_ANGLE_DEG) * Math.PI) / 180)
  // Rotating the road's up toward world up (made square to the road's direction) by the
  // full bank would give upright; by `lean` it stops part way. (slerp between the two)
  const full = Math.acos(Math.max(-1, Math.min(1, S.ux[i] * vx + S.uy[i] * vy + S.uz[i] * vz)))
  const w = full > 1e-6 ? Math.sin(Math.min(lean, full)) / Math.sin(full) : 0
  const w0 = full > 1e-6 ? Math.sin(full - Math.min(lean, full)) / Math.sin(full) : 1
  let dx = S.ux[i] * w0 + vx * w
  let dy = S.uy[i] * w0 + vy * w
  let dz = S.uz[i] * w0 + vz * w
  const dl = Math.hypot(dx, dy, dz) || 1
  dx /= dl
  dy /= dl
  dz /= dl
  // Out: the road's own outward direction on this side, made square to the face.
  let ox = S.rx[i] * side
  let oy = S.ry[i] * side
  let oz = S.rz[i] * side
  const od = ox * dx + oy * dy + oz * dz
  ox -= dx * od
  oy -= dy * od
  oz -= dz * od
  const ol = Math.hypot(ox, oy, oz) || 1
  out.dx = dx
  out.dy = dy
  out.dz = dz
  out.ox = ox / ol
  out.oy = oy / ol
  out.oz = oz / ol
  return out
}

/**
 * How far below the road edge's height a barrier's back ends where the road sits on the ground
 * (metres). The ground behind a walled road is a level floor 5 cm under the edge (terrain.ts,
 * EDGE_DEPTH), so the back's foot sinks 10 cm into it.
 */
const BARRIER_BACK_FOOT = 0.15

/**
 * True where a stadium barrier stands at sample i on this side (plain road, no wall ride) with
 * the road on the ground under it: there its back stops at the ground's floor and its underside
 * closes it off (addBarrier), and the slab's side ends at that underside.
 */
function barrierStandsOnGround(S: TrackSamples, c: Centerline, i: number, side: -1 | 1): boolean {
  if (S.surface[i] !== SURFACE_CODE.road || !S.grounded[i] || S.uy[i] <= 0.2) return false
  const wall = side < 0 ? c.wallLeft : c.wallRight
  return !(wall[i] > 0)
}

/** A stadium barrier along one edge: inner face, top, the back down to the ground (or past the slab on a bridge), and its underside. */
function addBarrier(bm: MeshBuilder, S: TrackSamples, c: Centerline, side: -1 | 1, H: number): void {
  const count = S.count
  const rows = count + 1
  const rowStart: number[] = []
  const ex = { aLateral: 0, aHalfWidth: 0 }
  const ax: BarrierAxes = { dx: 0, dy: 0, dz: 0, ox: 0, oy: 0, oz: 0 }
  for (let r = 0; r < rows; r++) {
    const i = r % count
    const s = r * S.ds
    const hw = S.halfWidth[i]
    const t = c.thickness[i]
    barrierAxes(S, i, side, ax)
    const { ox, oy, oz, dx: Ux, dy: Uy, dz: Uz } = ax
    // The edge itself sits on the road's own outward line.
    const Ex = S.px[i] + S.rx[i] * side * hw
    const Ey = S.py[i] + S.ry[i] * side * hw
    const Ez = S.pz[i] + S.rz[i] * side * hw
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
    // outer face (the back), down to the ground behind it. Where the road sits on the ground it
    // stops a little way into the level floor there (BARRIER_BACK_FOOT) instead of running on
    // down to the slab's bottom: on a steep bank the high barrier's back slopes as gently as 30
    // degrees, and the ground grid dips where it meets the deck's edge, so a back carried on
    // into the ground met those dips along a stair-stepped line (visual-3 N8). Stopping at the
    // floor, it meets flat ground on a straight line and passes over the dips. On a bridge it
    // still runs down past the slab.
    // (Its up lies between the road's up and straight up, so on ground road Uy > 0.2 too.)
    const onGround = barrierStandsOnGround(S, c, i, side)
    const down = onGround ? Math.max(-0.9 * H, Math.min(t, (BARRIER_BACK_FOOT + oy * Tk) / Uy)) : t
    const Fx = Ex - Ux * down + ox * Tk
    const Fy = Ey - Uy * down + oy * Tk
    const Fz = Ez - Uz * down + oz * Tk
    bm.vertex(Ex + Ux * H + ox * Tk, Ey + Uy * H + oy * Tk, Ez + Uz * H + oz * Tk, ox, oy, oz, H + Tk, s, ex)
    bm.vertex(Fx, Fy, Fz, ox, oy, oz, 2 * H + Tk + down, s, ex)
    // underside: a level plate at the back's foot, from the foot in to the road slab's side, so
    // nothing under the barrier shows below its back (the slab's side and the ground's dips by
    // the edge). On a bridge it folds away to nothing at the foot.
    const w = onGround ? BARRIER_BACK_FOOT / S.uy[i] : 0
    const Gx = onGround ? Ex - S.ux[i] * w : Fx
    const Gy = onGround ? Ey - S.uy[i] * w : Fy
    const Gz = onGround ? Ez - S.uz[i] * w : Fz
    const plate = Math.hypot(Fx - Gx, Fy - Gy, Fz - Gz)
    bm.vertex(Fx, Fy, Fz, 0, -1, 0, 2 * H + Tk + down, s, ex)
    bm.vertex(Gx, Gy, Gz, 0, -1, 0, 2 * H + Tk + down + plate, s, ex)
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
    bm.quad(A + 6, A + 7, B + 7, B + 6)
  }
}

/**
 * How far (degrees) a physics triangle may face away from the real road under it. A
 * stretch of road that twists (rolls about its own direction: a loop rolling over, a
 * bank rolling in, a banked bend on a hill) isn't flat between two samples, and a
 * triangle across it faces the way the road does at its own corners, not in between.
 */
export const DRIVE_TILT_TOL_DEG = 1
/** Strips across the drive surface it may use: each divides ACROSS - 1, so its vertices are look-mesh vertices. */
const DRIVE_STRIPS = [1, 2, 3, 4, 6, 12] as const

/** The drivable top as the physics sees it (see buildDriveSurface). */
export interface DriveSurface {
  positions: Float32Array
  indices: Uint32Array
  /** Per triangle: the sample i of the stretch (sample i to i + 1) it covers. */
  triQuad: Uint32Array
  /** Per vertex: signed metres right of the centre line. */
  lateral: Float32Array
  /** Per quad (sample i to i + 1): how many strips across it uses. */
  strips: Uint8Array
}

/**
 * The drivable top (road and loops, not wall-ride walls) for the colliders: as few
 * triangles as give the real shape.
 *
 * Where the road doesn't twist, the stretch between two samples is a flat four-sided
 * piece, so two triangles across the whole width are exact. Where it twists, two big
 * triangles would each face the way the road faces at its EDGES: on a loop rolling at
 * 2.6 degrees a metre that is 19 degrees off, even in the middle of the road, flipping
 * every half metre (a sawtooth the wheels feel). So each stretch gets just enough
 * strips across that no triangle faces more than DRIVE_TILT_TOL_DEG away from the road
 * under it: a strip w metres wide on road twisting t radians a metre is off by about
 * w x t. Straights and steady bends stay at one strip; loops and bank roll-ins get up
 * to 12 (the look mesh's own triangles).
 *
 * Neighbouring rows can have different numbers of points across. Rather than leave
 * extra points sitting on a long edge (a "T-junction", which physics can catch on), the
 * two rows are zipped together: walk across both, always stepping along the row whose
 * next point comes first, so every triangle shares whole edges with its neighbours.
 */
export function buildDriveSurface(S: TrackSamples): DriveSurface {
  const n = S.count
  const tol = Math.tan((DRIVE_TILT_TOL_DEG * Math.PI) / 180)
  // Strips per stretch, from how fast the road twists there.
  const strips = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const twist = Math.abs(
      ((S.rx[j] - S.rx[i]) * (S.ux[i] + S.ux[j]) + (S.ry[j] - S.ry[i]) * (S.uy[i] + S.uy[j]) + (S.rz[j] - S.rz[i]) * (S.uz[i] + S.uz[j])) / (2 * S.ds),
    )
    const need = (2 * Math.max(S.halfWidth[i], S.halfWidth[j]) * twist) / tol
    let k: number = DRIVE_STRIPS[DRIVE_STRIPS.length - 1]
    for (const c of DRIVE_STRIPS) {
      if (c >= need) {
        k = c
        break
      }
    }
    strips[i] = k
  }
  // Points across each row: enough for both stretches it borders.
  const rowStart = new Int32Array(n + 1)
  const rowK = new Uint8Array(n)
  let nv = 0
  for (let r = 0; r < n; r++) {
    rowK[r] = Math.max(strips[r], strips[(r - 1 + n) % n])
    rowStart[r] = nv
    nv += rowK[r] + 1
  }
  rowStart[n] = nv
  const positions = new Float32Array(nv * 3)
  const lateral = new Float32Array(nv)
  for (let r = 0; r < n; r++) {
    const hw = S.halfWidth[r]
    const k = rowK[r]
    for (let a = 0; a <= k; a++) {
      const l = -hw + (2 * hw * a) / k
      const v = rowStart[r] + a
      positions[v * 3] = S.px[r] + S.rx[r] * l
      positions[v * 3 + 1] = S.py[r] + S.ry[r] * l
      positions[v * 3 + 2] = S.pz[r] + S.rz[r] * l
      lateral[v] = l
    }
  }
  const idx: number[] = []
  const quadOf: number[] = []
  const P = positions
  const tri = (a: number, b: number, c: number, ux: number, uy: number, uz: number, q: number) => {
    // Wind it to face along the road's up (counter-clockwise seen from above the road).
    const e1x = P[b * 3] - P[a * 3]
    const e1y = P[b * 3 + 1] - P[a * 3 + 1]
    const e1z = P[b * 3 + 2] - P[a * 3 + 2]
    const e2x = P[c * 3] - P[a * 3]
    const e2y = P[c * 3 + 1] - P[a * 3 + 1]
    const e2z = P[c * 3 + 2] - P[a * 3 + 2]
    const g = (e1y * e2z - e1z * e2y) * ux + (e1z * e2x - e1x * e2z) * uy + (e1x * e2y - e1y * e2x) * uz
    if (g >= 0) idx.push(a, b, c)
    else idx.push(a, c, b)
    quadOf.push(q)
  }
  for (let q = 0; q < n; q++) {
    const r1 = (q + 1) % n
    const A = rowStart[q]
    const B = rowStart[r1]
    const kA = rowK[q]
    const kB = rowK[r1]
    const ux = S.ux[q] + S.ux[r1]
    const uy = S.uy[q] + S.uy[r1]
    const uz = S.uz[q] + S.uz[r1]
    // Zip the two rows. On a tie, step along the far row first: with equal counts that
    // splits each quad corner-to-corner the same way the look mesh does.
    let a = 0
    let b = 0
    while (a < kA || b < kB) {
      if (b < kB && (a >= kA || (b + 1) / kB <= (a + 1) / kA)) {
        tri(A + a, B + b + 1, B + b, ux, uy, uz, q)
        b++
      } else {
        tri(A + a, A + a + 1, B + b, ux, uy, uz, q)
        a++
      }
    }
  }
  return { positions, indices: Uint32Array.from(idx), triQuad: Uint32Array.from(quadOf), lateral, strips }
}

/** The triangles of a drive surface whose stretch passes `keep`, as a compact mesh (for one collider). */
export function driveSurfacePart(d: DriveSurface, keep: (quad: number) => boolean): { vertices: Float32Array; indices: Uint32Array } {
  const remap = new Int32Array(d.positions.length / 3).fill(-1)
  const verts: number[] = []
  const out: number[] = []
  const P = d.positions
  for (let t = 0; t < d.triQuad.length; t++) {
    if (!keep(d.triQuad[t])) continue
    for (let k = 0; k < 3; k++) {
      const v = d.indices[t * 3 + k]
      if (remap[v] < 0) {
        remap[v] = verts.length / 3
        verts.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2])
      }
      out.push(remap[v])
    }
  }
  return { vertices: Float32Array.from(verts), indices: Uint32Array.from(out) }
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
