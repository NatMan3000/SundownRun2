// ============================================================
//  STUNT PARK GEOMETRY - ramps, tables and pipes as solids, bullseyes as paint
// ------------------------------------------------------------
//  Every drivable thing in the stunt park is built here from a
//  few numbers, as plain arrays (no three.js), so the game and a
//  headless test build exactly the same shapes.
//
//  Most pieces are one idea: draw the piece's SIDE VIEW as a line
//  (its "profile": how high the top is, metre by metre along it),
//  then stretch that line sideways to the piece's width and close
//  it into a solid block down into the ground. A kicker, a big
//  table, a gap's landing and a quarter pipe are all just different
//  side views. The bullseye targets are a different idea: they are
//  paint on the ground (a disc laid over the ground's real shape,
//  with no solid of their own), so driving over one is driving on
//  the ground.
//
//  Each solid comes out twice:
//    - into the park's ONE shared render mesh (top, sides and end
//      faces; the bottom is never seen), with the numbers the park's
//      shader draws its neon lines from (stuntMaterial.ts)
//    - as its own closed triangle mesh for the physics (every face,
//      shared corners welded), wound outward, cut into car-sized
//      triangles. Long thin triangles are a trap: a car's look-ahead
//      meets the tip of one as a wall (CLAUDE.md, soft CCD).
//
//  Height: a piece stands on a flat plane fitted to the ground under
//  it (parkLayout.ts picks only spots where the ground is within a
//  few centimetres of that plane). Where a top surface starts or
//  ends on the ground, its first or last metres are blended onto the
//  REAL ground under each corner ("draping"), so you drive onto it
//  without a bump; its block reaches below the ground everywhere,
//  so nothing floats.
// ============================================================

import { gridHeight } from '../../track/terrain'
import type { TerrainGrid } from '../../track/types'

/** One point of a piece's side view: `a` metres along its axis, `h` metres above its base plane. */
export interface ProfilePoint {
  a: number
  h: number
}

/**
 * What a stretch of top surface is, for the shader (a number per profile segment):
 *   0 plain, 1 launch face (amber arrows up it), 2 landing face (cyan arrows down it),
 *   3 flat deck, 4 pipe wall (bands of light round its curve).
 */
export const ZONE = { plain: 0, launch: 1, landing: 2, deck: 3, pipe: 4 } as const

/** Which faces a vertex belongs to, for the shader. */
export const ROLE = { top: 0, side: 1, end: 2, pad: 4 } as const

/** Where a piece stands and how its base plane sits: y = y0 + sa * a + sl * l. */
export interface PieceFrame {
  /** Origin on the ground: profile a = 0, on the axis. */
  ox: number
  oz: number
  /** Unit heading (the way you drive onto it), in the ground plane. */
  dx: number
  dz: number
  y0: number
  /** Base plane slope along the axis and across it (metres per metre). */
  sa: number
  sl: number
}

export interface ExtrudeSpec {
  frame: PieceFrame
  /** The top's side view, front to back. `a` never decreases; two points with the same `a` are a vertical face. */
  top: ProfilePoint[]
  /** Zone of each segment (top.length - 1 numbers). */
  zones: number[]
  /** Half the width of the top, metres. */
  halfWidth: number
  /** Sloped sides: metres out per metre of height (0 = straight down). */
  sideRun: number
  /** The bottom sits this far under the base plane (always below the ground). */
  sink: number
  /** Blend the first / last metres of the top onto the real ground (0 = no). */
  drapeFront: number
  drapeBack: number
  /** Arc lengths along the top (metres from its front) where an amber lip line is drawn. */
  lips: number[]
  /** Arc lengths where a cyan "land here" line is drawn (the top of a landing). */
  catches: number[]
  /** A launch's speed sign (km/h to leave its lip at; 0 or missing = none), painted on its face before the first lip. */
  signKmh?: number
}

export interface PadSpec {
  /** Where the bullseye's middle is (ox, oz) and which way its lane runs (the plane it was fitted with). */
  frame: PieceFrame
  /** Radius of the outer x2 ring's edge. */
  radius: number
  /** Radius of the inner x3 ring. */
  inner: number
  /** How far (metres) the dark disc reaches past the outer ring. */
  margin: number
  /** The ground's height at the middle (where a landing on it touches down). */
  centreY: number
}

/** A closed solid for the physics: welded corners, every face wound outward. */
export interface SolidMesh {
  vertices: Float32Array
  indices: Uint32Array
}

/** Ground height at x, z (the track's terrainHeight). */
export type GroundFn = (x: number, z: number) => number

/** Longest edge of a physics triangle along a surface, metres (about a car's length). */
const MAX_STEP = 2.0
/** Longest edge across a surface or down a side, metres. */
const MAX_ACROSS = 2.5
/** Segments meeting at a sharper angle than this keep their own normals (a crease, like a lip). */
const CREASE_COS = Math.cos((28 * Math.PI) / 180)

// ---------------------------------------------------------------- the shared render mesh

/**
 * The park's render mesh, grown piece by piece. Attributes:
 *   aPark  (4)  role, metres to the nearest side edge (walls: metres down from their top; pads: radius), arc metres
 *               along the top (end faces: metres across), metres to the nearest lip line
 *   aPark2 (2)  zone, metres to the nearest catch line
 *   aPark3 (4)  a launch face's speed sign: metres right of the centre line, the number (0 = none),
 *               the digits' height and how far before the lip they end (metres along the face)
 */
export class ParkMeshBuilder {
  pos: number[] = []
  nrm: number[] = []
  park: number[] = []
  park2: number[] = []
  park3: number[] = []
  idx: number[] = []

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, role: number, edge: number, arc: number, lip: number, zone: number, katch: number, lateral = 0, sign = 0, signH = 0, signGap = 0): number {
    this.pos.push(x, y, z)
    this.nrm.push(nx, ny, nz)
    this.park.push(role, edge, arc, lip)
    this.park2.push(zone, katch)
    this.park3.push(lateral, sign, signH, signGap)
    return this.pos.length / 3 - 1
  }

  /** A quad a-b-c-d, wound so its face points along (ox, oy, oz). */
  quad(a: number, b: number, c: number, d: number, ox: number, oy: number, oz: number): void {
    if (facing(this.pos, a, b, c, ox, oy, oz) >= 0) this.idx.push(a, b, c, a, c, d)
    else this.idx.push(a, c, b, a, d, c)
  }

  /** A triangle, wound so its face points along (ox, oy, oz); a sliver with no area is skipped. */
  tri(a: number, b: number, c: number, ox: number, oy: number, oz: number): void {
    const f = facing(this.pos, a, b, c, ox, oy, oz)
    if (Math.abs(f) < 1e-9) return
    if (f > 0) this.idx.push(a, b, c)
    else this.idx.push(a, c, b)
  }

  get vertexCount(): number {
    return this.pos.length / 3
  }

  build(): {
    positions: Float32Array
    normals: Float32Array
    park: Float32Array
    park2: Float32Array
    park3: Float32Array
    indices: Uint32Array
  } {
    return {
      positions: Float32Array.from(this.pos),
      normals: Float32Array.from(this.nrm),
      park: Float32Array.from(this.park),
      park2: Float32Array.from(this.park2),
      park3: Float32Array.from(this.park3),
      indices: Uint32Array.from(this.idx),
    }
  }
}

/** Sign of the triangle a-b-c's face against a direction (+ = facing it). */
function facing(p: number[] | Float32Array, a: number, b: number, c: number, ox: number, oy: number, oz: number): number {
  const ux = p[b * 3] - p[a * 3]
  const uy = p[b * 3 + 1] - p[a * 3 + 1]
  const uz = p[b * 3 + 2] - p[a * 3 + 2]
  const vx = p[c * 3] - p[a * 3]
  const vy = p[c * 3 + 1] - p[a * 3 + 1]
  const vz = p[c * 3 + 2] - p[a * 3 + 2]
  return (uy * vz - uz * vy) * ox + (uz * vx - ux * vz) * oy + (ux * vy - uy * vx) * oz
}

// ---------------------------------------------------------------- the physics mesh

/** Collects a solid's faces for the physics, welding corners that sit on the same spot. */
class SolidBuilder {
  private v: number[] = []
  private i: number[] = []
  private key = new Map<string, number>()

  point(x: number, y: number, z: number): number {
    const k = `${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`
    const hit = this.key.get(k)
    if (hit !== undefined) return hit
    const n = this.v.length / 3
    this.v.push(x, y, z)
    this.key.set(k, n)
    return n
  }

  /** A quad, wound to face along (ox, oy, oz); degenerate halves are skipped. */
  quad(a: number, b: number, c: number, d: number, ox: number, oy: number, oz: number): void {
    this.tri(a, b, c, ox, oy, oz)
    this.tri(a, c, d, ox, oy, oz)
  }

  tri(a: number, b: number, c: number, ox: number, oy: number, oz: number): void {
    if (a === b || b === c || a === c) return
    const f = facing(this.v, a, b, c, ox, oy, oz)
    if (Math.abs(f) < 1e-9) return
    if (f > 0) this.i.push(a, b, c)
    else this.i.push(a, c, b)
  }

  build(): SolidMesh {
    return { vertices: Float32Array.from(this.v), indices: Uint32Array.from(this.i) }
  }
}

// ---------------------------------------------------------------- frame helpers

/** World position of (a along, l right, y) in a piece frame. Right = heading turned clockwise seen from above. */
function wx(f: PieceFrame, a: number, l: number): number {
  return f.ox + f.dx * a - f.dz * l
}
function wz(f: PieceFrame, a: number, l: number): number {
  return f.oz + f.dz * a + f.dx * l
}
/** Base plane height at (a, l). */
export function baseY(f: PieceFrame, a: number, l: number): number {
  return f.y0 + f.sa * a + f.sl * l
}
/** World x, z of a point in a frame (exported for the layout and the scoring). */
export function frameX(f: PieceFrame, a: number, l: number): number {
  return wx(f, a, l)
}
export function frameZ(f: PieceFrame, a: number, l: number): number {
  return wz(f, a, l)
}

function smooth01(x: number): number {
  const t = x < 0 ? 0 : x > 1 ? 1 : x
  return t * t * (3 - 2 * t)
}

// ---------------------------------------------------------------- extruded pieces

interface Row {
  a: number
  h: number
  /** Arc metres from the front of the top. */
  arc: number
  /** 2D normal in the side view (along, up). */
  na: number
  nh: number
  /** Segment (index into spec.zones) this row's strip belongs to. */
  seg: number
}

/**
 * The top cut into rows no more than MAX_STEP apart, as strips: one list of rows per profile
 * segment, the joints duplicated so each segment keeps its own zone, normals smoothed across
 * gentle joints and kept sharp at creases.
 */
function topStrips(top: ProfilePoint[]): Row[][] {
  const n = top.length
  // Each segment's own normal (perpendicular to it, pointing up-ish: the side the car is on).
  const segNa: number[] = []
  const segNh: number[] = []
  const segLen: number[] = []
  for (let i = 0; i < n - 1; i++) {
    const da = top[i + 1].a - top[i].a
    const dh = top[i + 1].h - top[i].h
    const L = Math.hypot(da, dh) || 1
    segLen.push(L)
    // Rotate the direction (da, dh) a quarter turn anticlockwise: (-dh, da).
    segNa.push(-dh / L)
    segNh.push(da / L)
  }
  // Normal at each joint: averaged when the turn there is gentle.
  const jointNormal = (i: number, seg: number): [number, number] => {
    const a = i - 1 // segment before point i
    const b = i //     segment after point i
    if (a < 0 || b >= n - 1) return [segNa[seg], segNh[seg]]
    const dot = segNa[a] * segNa[b] + segNh[a] * segNh[b]
    if (dot < CREASE_COS) return [segNa[seg], segNh[seg]]
    const x = segNa[a] + segNa[b]
    const y = segNh[a] + segNh[b]
    const L = Math.hypot(x, y) || 1
    return [x / L, y / L]
  }
  const strips: Row[][] = []
  let arc = 0
  for (let s = 0; s < n - 1; s++) {
    const p0 = top[s]
    const p1 = top[s + 1]
    const L = segLen[s]
    const k = Math.max(1, Math.ceil(L / MAX_STEP))
    const [n0a, n0h] = jointNormal(s, s)
    const [n1a, n1h] = jointNormal(s + 1, s)
    const rows: Row[] = []
    for (let j = 0; j <= k; j++) {
      const t = j / k
      let na = n0a + (n1a - n0a) * t
      let nh = n0h + (n1h - n0h) * t
      const nl = Math.hypot(na, nh) || 1
      na /= nl
      nh /= nl
      rows.push({ a: p0.a + (p1.a - p0.a) * t, h: p0.h + (p1.h - p0.h) * t, arc: arc + L * t, na, nh, seg: s })
    }
    arc += L
    strips.push(rows)
  }
  return strips
}

/** Distance from `arc` to the nearest entry of `marks` (Infinity when there are none). */
function nearestMark(arc: number, marks: number[]): number {
  let best = 1e4
  for (const m of marks) best = Math.min(best, Math.abs(arc - m))
  return best
}

/**
 * Build one extruded piece into the render mesh and return its physics solid.
 * See the header: the side view `top`, stretched across `halfWidth` each way.
 */
export function buildExtruded(spec: ExtrudeSpec, ground: GroundFn, mesh: ParkMeshBuilder): SolidMesh {
  const f = spec.frame
  const hw = spec.halfWidth
  const top = spec.top
  const a0 = top[0].a
  const a1 = top[top.length - 1].a
  const strips = topStrips(top)
  const nAcross = Math.max(1, Math.ceil((hw * 2) / MAX_ACROSS))
  const rx = -f.dz // right vector
  const rz = f.dx
  // Draping offsets per across-row (how far the real ground at the front / back edge is off the plane).
  const offF: number[] = []
  const offB: number[] = []
  for (let k = 0; k <= nAcross; k++) {
    const l = -hw + (2 * hw * k) / nAcross
    offF.push(spec.drapeFront > 0 ? ground(wx(f, a0, l), wz(f, a0, l)) - baseY(f, a0, l) : 0)
    offB.push(spec.drapeBack > 0 ? ground(wx(f, a1, l), wz(f, a1, l)) - baseY(f, a1, l) : 0)
  }
  // Offsets at the two side edges (the sides use their own top edge).
  const drape = (a: number, k: number): number => {
    let d = 0
    if (spec.drapeFront > 0) d += offF[k] * (1 - smooth01((a - a0) / spec.drapeFront))
    if (spec.drapeBack > 0) d += offB[k] * (1 - smooth01((a1 - a) / spec.drapeBack))
    return d
  }
  const topY = (a: number, l: number, h: number, k: number): number => baseY(f, a, l) + h + drape(a, k)
  const botY = (a: number, l: number): number => baseY(f, a, l) - spec.sink
  // The side's outward reach at the bottom (sloped sides lean out with height).
  const reach = (h: number): number => hw + spec.sideRun * Math.max(0, h)
  // 3D normal from the side view's 2D normal (along and up), tilted with the base plane.
  const n3 = (na: number, nh: number, out: number[]): number[] => {
    // along-axis world vector (dx, sa, dz); across-axis world vector (rx, sl, rz); up = (0,1,0).
    // A side-view normal (na, nh) means: na of "along" plus nh of "up", then the plane tilt:
    // the plane's own up is (-sa*dx - sl*rx, 1, -sa*dz - sl*rz) normalised.
    const ux = -f.sa * f.dx - f.sl * rx
    const uz = -f.sa * f.dz - f.sl * rz
    const x = f.dx * na + ux * nh
    const y = f.sa * na + nh
    const z = f.dz * na + uz * nh
    const L = Math.hypot(x, y, z) || 1
    out[0] = x / L
    out[1] = y / L
    out[2] = z / L
    return out
  }
  const nv = [0, 0, 0]
  const solid = new SolidBuilder()
  // The speed sign: digits signH metres tall (along the face), ending signGap metres before the lip.
  const sign = spec.signKmh && spec.signKmh > 0 && spec.lips.length > 0 ? spec.signKmh : 0
  const faceArc = spec.lips[0] ?? 0
  const signH = Math.min(13, Math.max(2.6, faceArc * 0.42))
  const signGap = Math.max(1.2, faceArc * 0.1)

  // ---- top: per strip, rows x across ----
  for (const rows of strips) {
    const zone = spec.zones[rows[0].seg] ?? ZONE.plain
    const base = mesh.vertexCount
    for (const r of rows) {
      n3(r.na, r.nh, nv)
      const lip = nearestMark(r.arc, spec.lips)
      const katch = nearestMark(r.arc, spec.catches)
      for (let k = 0; k <= nAcross; k++) {
        const l = -hw + (2 * hw * k) / nAcross
        const edge = hw - Math.abs(l)
        mesh.vertex(wx(f, r.a, l), topY(r.a, l, r.h, k), wz(f, r.a, l), nv[0], nv[1], nv[2], ROLE.top, edge, r.arc, lip, zone, katch, l, sign, signH, signGap)
      }
    }
    for (let j = 0; j < rows.length - 1; j++) {
      // Outward = this strip's mean normal.
      n3((rows[j].na + rows[j + 1].na) / 2, (rows[j].nh + rows[j + 1].nh) / 2, nv)
      for (let k = 0; k < nAcross; k++) {
        const A = base + j * (nAcross + 1) + k
        const B = A + 1
        const C = A + nAcross + 2
        const D = A + nAcross + 1
        mesh.quad(A, B, C, D, nv[0], nv[1], nv[2])
      }
    }
    // Physics top.
    for (let j = 0; j < rows.length - 1; j++) {
      n3((rows[j].na + rows[j + 1].na) / 2, (rows[j].nh + rows[j + 1].nh) / 2, nv)
      for (let k = 0; k < nAcross; k++) {
        const l0 = -hw + (2 * hw * k) / nAcross
        const l1 = -hw + (2 * hw * (k + 1)) / nAcross
        const r0 = rows[j]
        const r1 = rows[j + 1]
        const A = solid.point(wx(f, r0.a, l0), topY(r0.a, l0, r0.h, k), wz(f, r0.a, l0))
        const B = solid.point(wx(f, r0.a, l1), topY(r0.a, l1, r0.h, k + 1), wz(f, r0.a, l1))
        const C = solid.point(wx(f, r1.a, l1), topY(r1.a, l1, r1.h, k + 1), wz(f, r1.a, l1))
        const D = solid.point(wx(f, r1.a, l0), topY(r1.a, l0, r1.h, k), wz(f, r1.a, l0))
        solid.quad(A, B, C, D, nv[0], nv[1], nv[2])
      }
    }
  }

  // All rows in order (joints once), for the sides, ends and bottom.
  // (A strip's first row is the previous strip's last row again: keep it once.)
  const all: Row[] = []
  for (const rows of strips) for (const r of rows) if (all.length === 0 || r !== rows[0]) all.push(r)

  // ---- sides and end faces ----
  // Both are walls standing under an edge of the top. Each is built from vertical COLUMNS of
  // points (the top edge, then bands no taller than MAX_ACROSS down to the bottom) and the strip
  // between two neighbouring columns is "zipped" into triangles, so columns with different
  // numbers of points still share every corner (no cracks for the physics to catch on). A
  // vertical stretch of the top (a quarter pipe's lip) is one column holding all its points.
  if (spec.sideRun > 0) {
    for (let j = 1; j < all.length; j++) {
      if (all[j].a - all[j - 1].a < 1e-4) throw new Error('[stunts] a piece with sloped sides cannot have a vertical face in its top')
    }
  }
  const bandsDown = (top: P3, bottom: P3, out: P3[]): void => {
    const n = Math.max(1, Math.ceil((top[1] - bottom[1]) / MAX_ACROSS))
    for (let b = 1; b <= n; b++) {
      const t = b / n
      out.push([top[0] + (bottom[0] - top[0]) * t, top[1] + (bottom[1] - top[1]) * t, top[2] + (bottom[2] - top[2]) * t])
    }
  }
  for (const side of [-1, 1] as const) {
    const kEdge = side < 0 ? 0 : nAcross
    const ox = rx * side
    const oz = rz * side
    const lean = Math.hypot(1, spec.sideRun)
    const nx = ox / lean
    const ny = spec.sideRun / lean
    const nz = oz / lean
    // Columns: every distinct a along the top, its top-edge point(s), then the bands below.
    const cols: { pts: P3[]; tops: number; arc: number; entry: number; exit: number; a: number; hLow: number }[] = []
    for (let j = 0; j < all.length; j++) {
      const r = all[j]
      const lt = side * hw
      const top: P3 = [wx(f, r.a, lt), topY(r.a, lt, r.h, kEdge), wz(f, r.a, lt)]
      const prev = cols[cols.length - 1]
      if (prev && r.a - all[j - 1].a < 1e-4) {
        prev.pts.push(top) // same a as the last row: a vertical stretch, one column
        prev.tops++
        prev.hLow = Math.min(prev.hLow, r.h)
        continue
      }
      cols.push({ pts: [top], tops: 1, arc: r.arc, entry: 0, exit: 0, a: r.a, hLow: r.h })
    }
    for (let c = 0; c < cols.length; c++) {
      const col = cols[c]
      // Order the column's top points high to low; remember which one each neighbour joins at.
      const entryPt = col.pts[0]
      const exitPt = col.pts[col.tops - 1]
      col.pts.sort((p, q) => q[1] - p[1])
      col.entry = col.pts.indexOf(entryPt)
      col.exit = col.pts.indexOf(exitPt)
      const low = col.pts[col.pts.length - 1]
      // The bottom under it (sloped sides lean out with the height there).
      const lb = side * reach(col.hLow)
      bandsDown(low, [wx(f, col.a, lb), botY(col.a, lb), wz(f, col.a, lb)], col.pts)
    }
    for (let c = 0; c < cols.length - 1; c++) {
      const L = cols[c].pts.slice(cols[c].exit)
      const R = cols[c + 1].pts.slice(cols[c + 1].entry)
      zipWall(L, R, cols[c].arc, cols[c + 1].arc, nx, ny, nz, ox, 0, oz, ROLE.side, mesh, solid)
    }
  }
  for (const end of [0, 1] as const) {
    const r = end === 0 ? all[0] : all[all.length - 1]
    const ox = end === 0 ? -f.dx : f.dx
    const oz = end === 0 ? -f.dz : f.dz
    if (r.h + spec.sink < 0.02) continue
    const cols: P3[][] = []
    for (let k = 0; k <= nAcross; k++) {
      const lt = -hw + (2 * hw * k) / nAcross
      const lb = (lt / hw) * reach(r.h)
      const col: P3[] = [[wx(f, r.a, lt), topY(r.a, lt, r.h, k), wz(f, r.a, lt)]]
      bandsDown(col[0], [wx(f, r.a, lb), botY(r.a, lb), wz(f, r.a, lb)], col)
      cols.push(col)
    }
    // An end face's "arc" for the shader is its distance across (metres right of the centre), for its panel seams.
    for (let k = 0; k < nAcross; k++) {
      const l0 = -hw + (2 * hw * k) / nAcross
      const l1 = -hw + (2 * hw * (k + 1)) / nAcross
      zipWall(cols[k], cols[k + 1], l0, l1, ox, 0, oz, ox, 0, oz, ROLE.end, mesh, solid, end === 1)
    }
  }

  // ---- bottom (physics only: never seen) ----
  for (let j = 0; j < all.length - 1; j++) {
    if (all[j + 1].a - all[j].a < 1e-4) continue
    for (let k = 0; k < nAcross; k++) {
      const t0 = -1 + (2 * k) / nAcross
      const t1 = -1 + (2 * (k + 1)) / nAcross
      const r0 = all[j]
      const r1 = all[j + 1]
      const P = (r: Row, t: number) => {
        const l = t * reach(r.h)
        return solid.point(wx(f, r.a, l), botY(r.a, l), wz(f, r.a, l))
      }
      solid.quad(P(r0, t0), P(r0, t1), P(r1, t1), P(r1, t0), 0, -1, 0)
    }
  }
  return solid.build()
}

type P3 = [number, number, number]

/**
 * Triangulate the wall strip between two columns of points (each listed top to bottom), walking
 * down both at once and always stepping the side that is further behind. Every point of both
 * columns is a corner of the strip, so neighbouring strips share their corners exactly.
 * Render vertices get the wall's flat normal (nx, ny, nz); `down` is metres below the column's
 * top (the shader's outline). `lipLine`: this is a launch's lip face (the lip line runs along its top).
 */
function zipWall(L: P3[], R: P3[], arcL: number, arcR: number, nx: number, ny: number, nz: number, ox: number, oy: number, oz: number, role: number, mesh: ParkMeshBuilder, solid: SolidBuilder, lipLine = false): void {
  if (L.length < 1 || R.length < 1) return
  const base = mesh.vertexCount
  const topL = L[0][1]
  const topR = R[0][1]
  for (const p of L) mesh.vertex(p[0], p[1], p[2], nx, ny, nz, role, topL - p[1], arcL, lipLine ? topL - p[1] : 1e4, 0, 1e4)
  for (const p of R) mesh.vertex(p[0], p[1], p[2], nx, ny, nz, role, topR - p[1], arcR, lipLine ? topR - p[1] : 1e4, 0, 1e4)
  const sl = L.map((p) => solid.point(p[0], p[1], p[2]))
  const sr = R.map((p) => solid.point(p[0], p[1], p[2]))
  const fracL = (i: number) => (L.length < 2 ? 1 : (topL - L[i][1]) / Math.max(1e-6, topL - L[L.length - 1][1]))
  const fracR = (j: number) => (R.length < 2 ? 1 : (topR - R[j][1]) / Math.max(1e-6, topR - R[R.length - 1][1]))
  let i = 0
  let j = 0
  while (i < L.length - 1 || j < R.length - 1) {
    const stepL = j >= R.length - 1 || (i < L.length - 1 && fracL(i + 1) <= fracR(j + 1))
    if (stepL) {
      mesh.tri(base + i, base + L.length + j, base + i + 1, ox, oy, oz)
      solid.tri(sl[i], sr[j], sl[i + 1], ox, oy, oz)
      i++
    } else {
      mesh.tri(base + i, base + L.length + j, base + L.length + j + 1, ox, oy, oz)
      solid.tri(sl[i], sr[j], sr[j + 1], ox, oy, oz)
      j++
    }
  }
}

// ---------------------------------------------------------------- bullseye targets

/** Spokes round a bullseye's disc (5 degrees apart: about 0.7 m between them at its edge). */
const PAD_SPOKES = 72
/** Furthest apart (metres) two rings of a bullseye's vertices are, from its middle outward. */
const PAD_RING_STEP = 0.75

/**
 * Height of the ground at x, z as the terrain's middle level of detail draws it: every 2nd height
 * of the grid, cut into the same two triangles per cell as the full grid (src/world/
 * terrainGeometry.ts). Which heights are "every 2nd" depends on where each terrain chunk starts,
 * so `ox` and `oz` (0 or 1) pick one of the four ways that coarser grid can line up.
 */
function latticeHeight(g: TerrainGrid, x: number, z: number, ox: number, oz: number): number {
  const n = g.n
  const fx = Math.max(0, Math.min(n, (x + g.half) / g.cellSize))
  const fz = Math.max(0, Math.min(n, (z + g.half) / g.cellSize))
  const ix = Math.max(0, Math.min(n - 2, ox + Math.floor((fx - ox) / 2) * 2))
  const iz = Math.max(0, Math.min(n - 2, oz + Math.floor((fz - oz) / 2) * 2))
  const tx = Math.max(0, Math.min(1, (fx - ix) / 2))
  const tz = Math.max(0, Math.min(1, (fz - iz) / 2))
  const h = g.heights
  const row = n + 1
  const ha = h[iz * row + ix]
  const hb = h[iz * row + ix + 2]
  const hc = h[(iz + 2) * row + ix]
  if (tx + tz <= 1) return ha + (hb - ha) * tx + (hc - ha) * tz
  const hd = h[(iz + 2) * row + ix + 2]
  return hd + (hc - hd) * (1 - tx) + (hb - hd) * (1 - tz)
}

/**
 * The height a bullseye's paint sits at, at x, z: the ground the wheels touch (the full grid), or
 * the terrain's coarser drawing of it where that stands higher (by a few centimetres at most, on
 * the near-flat spots bullseyes are placed on), so the paint is never under ground you can see.
 * Further away, where the terrain is drawn coarser still, the park's shader lifts the paint a
 * little more (stuntMaterial.ts).
 */
export function padSurfaceY(g: TerrainGrid, x: number, z: number): number {
  let y = gridHeight(g, x, z)
  for (let k = 0; k < 4; k++) y = Math.max(y, latticeHeight(g, x, z, k & 1, k >> 1))
  return y
}

/**
 * A bullseye: paint on the ground, not a thing standing on it. A round disc of the park's dark
 * wet surface with the cyan target drawn on it (stuntMaterial.ts), laid over the ground's real
 * shape vertex by vertex, and nothing for the physics at all: you drive over it on the ground
 * itself, at any speed, and a landing is judged by where you touch down (parkScoring.ts), not by
 * hitting a solid. The disc reaches `margin` metres past the outer ring, so the ring has dark on
 * both sides.
 *
 * Rings of vertices run from the middle outward, no more than PAD_RING_STEP apart, so the paint
 * follows the ground's creases closely. Each vertex carries its distance from the middle (exact
 * along a spoke), and the shader draws the rings from it.
 */
export function buildPadDecal(spec: PadSpec, g: TerrainGrid, mesh: ParkMeshBuilder): void {
  const f = spec.frame
  const radii: number[] = [0]
  let r0 = 0
  for (const stop of [spec.inner, spec.radius, spec.radius + spec.margin]) {
    const k = Math.max(1, Math.ceil((stop - r0) / PAD_RING_STEP))
    for (let j = 1; j <= k; j++) radii.push(r0 + ((stop - r0) * j) / k)
    r0 = stop
  }
  const base = mesh.vertexCount
  const e = 1.5 // metres each way for the ground's slope (half a grid cell)
  for (let i = 0; i < radii.length; i++) {
    const r = radii[i]
    // The middle is one vertex; every other ring has one per spoke (the last repeats the first).
    const count = i === 0 ? 1 : PAD_SPOKES + 1
    for (let s = 0; s < count; s++) {
      const ang = (s / PAD_SPOKES) * Math.PI * 2
      const x = wx(f, Math.cos(ang) * r, Math.sin(ang) * r)
      const z = wz(f, Math.cos(ang) * r, Math.sin(ang) * r)
      // A smooth normal from the ground's slope here, so the paint is lit like the ground under it.
      const dhdx = (gridHeight(g, x + e, z) - gridHeight(g, x - e, z)) / (2 * e)
      const dhdz = (gridHeight(g, x, z + e) - gridHeight(g, x, z - e)) / (2 * e)
      const inv = 1 / Math.sqrt(dhdx * dhdx + 1 + dhdz * dhdz)
      mesh.vertex(x, padSurfaceY(g, x, z), z, -dhdx * inv, inv, -dhdz * inv, ROLE.pad, r, spec.radius, spec.inner, 0, 1e4)
    }
  }
  // The middle fan, then a band of quads between each pair of rings, all facing up.
  for (let s = 0; s < PAD_SPOKES; s++) mesh.tri(base, base + 1 + s, base + 2 + s, 0, 1, 0)
  for (let i = 1; i < radii.length - 1; i++) {
    const inner = base + 1 + (i - 1) * (PAD_SPOKES + 1)
    const outer = inner + PAD_SPOKES + 1
    for (let s = 0; s < PAD_SPOKES; s++) mesh.quad(inner + s, inner + s + 1, outer + s + 1, outer + s, 0, 1, 0)
  }
}
