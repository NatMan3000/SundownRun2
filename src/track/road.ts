// ============================================================
//  ROAD CENTRELINE - from control points to the sampled ribbon
// ------------------------------------------------------------
//  This is where a list of dots in the track file becomes a road:
//
//   1. Each control point gets a height: its own y, or the natural
//      ground averaged over ~12 m plus its lift.
//   2. A smooth closed spline runs through the points (spline.ts).
//   3. It is re-sampled every ~1 m, starting at the start line, so
//      s = 0 is the line by construction.
//   4. Corners get banked from their curvature (the faster the design
//      speed and the tighter the corner, the steeper, up to a cap),
//      with per-point overrides, smoothed so corners roll in and out.
//   5. Loops are spliced in: the road shifts sideways before the loop,
//      goes up and over a teardrop-shaped loop while drifting across (a
//      corkscrew, so the way in and the way out run side by side), then
//      shifts back.
//   6. The result is re-sampled once more at an exact spacing, and each
//      sample gets its frame: tangent, up (the surface normal) and right.
//
//  Wall rides do not change the centreline: they add a curved wall on
//  the edge, recorded here as a sweep angle per sample (ribbon.ts
//  builds the wall itself).
// ============================================================

import type { ResolvedTrackFile, LoopPiece, WallRidePiece } from './schema'
import { SURFACE_CODE, type TrackSamples } from './types'
import { averagedHeight, type NaturalTerrain } from './terrain'
import { arcLengthAtParam, nodeAtLength, sampleClosedSpline } from './spline'
import { clamp, smoothstep } from './noise'

const G = 9.81
/** Target spacing of the final samples, metres. */
export const SAMPLE_SPACING = 1
/** A road this far (or less) above the natural ground is "grounded": the ground is filled up to it. */
export const FILL_MAX = 6
/** Metres over which the road shifts sideways before and after a loop. */
export const LOOP_SHIFT = 80
/** A wall ride ramps its wall in and out over this many metres at each end. */
export const WALL_RAMP = 15
/** How far round a wall ride's wall curls at full height (degrees past flat). */
export const WALL_SWEEP_DEG = 100
/** A bend must turn at least this many degrees over 80 m to get any auto-bank, and this many for full bank. */
const BANK_TURN_MIN = 4
const BANK_TURN_FULL = 12
/** Curvature (1/m) below which a bend counts as straight for auto-banking. */
const BANK_DEADBAND = 1 / 3000
/** Slab thickness: a lifted road is this thick... */
export const SLAB_THICKNESS = 1.2
/** ...and a grounded road's sides reach this far down into the fill. */
export const SLAB_GROUNDED = 2.5

export interface LoopInfo {
  pieceIndex: number
  s0: number
  s1: number
  radius: number
  /** Loop centre at its mid point (for visuals). */
  center: { x: number; y: number; z: number }
}

export interface WallInfo {
  pieceIndex: number
  s0: number
  s1: number
  side: 'left' | 'right' | 'both'
  radius: number
}

export interface Centerline {
  samples: TrackSamples
  length: number
  /** Slab thickness under each sample. */
  thickness: Float32Array
  /** Wall sweep angle (radians) on each edge per sample; 0 = no wall. */
  wallLeft: Float32Array
  wallRight: Float32Array
  /** Wall radius per sample (metres). */
  wallRadius: Float32Array
  loops: LoopInfo[]
  walls: WallInfo[]
  /** Final s of a control-point position `at` (wraps). */
  sOfAt: (at: number) => number
}

/** Shortest signed distance from a to b on a loop of length L. */
function wrapDelta(a: number, b: number, L: number): number {
  let d = b - a
  d -= Math.round(d / L) * L
  return d
}

/** Circular box blur, `radius` samples each side, `passes` times (2 passes ~ a soft bell). */
export function circularSmooth(a: Float32Array, radius: number, passes: number): void {
  const n = a.length
  if (radius < 1 || n < 3) return
  const r = Math.min(radius, Math.floor((n - 1) / 2))
  const tmp = new Float32Array(n)
  const inv = 1 / (2 * r + 1)
  for (let p = 0; p < passes; p++) {
    let sum = 0
    for (let k = -r; k <= r; k++) sum += a[(k + n) % n]
    for (let i = 0; i < n; i++) {
      tmp[i] = sum * inv
      sum += a[(i + r + 1) % n] - a[(i - r + n) % n]
    }
    a.set(tmp)
  }
}

/** Signed horizontal curvature (+ = turning right) of a closed sampled path. */
export function horizontalCurvature(px: ArrayLike<number>, pz: ArrayLike<number>, count: number, ds: number, out: Float32Array): void {
  const W = 4
  for (let i = 0; i < count; i++) {
    const a = (i - W + count) % count
    const b = (i + W) % count
    const a0 = (a - 1 + count) % count
    const b1 = (b + 1) % count
    // Headings at a and b (clockwise from north, so a right turn increases them).
    const ha = Math.atan2(px[(a + 1) % count] - px[a0], -(pz[(a + 1) % count] - pz[a0]))
    const hb = Math.atan2(px[b1] - px[(b - 1 + count) % count], -(pz[b1] - pz[(b - 1 + count) % count]))
    let d = hb - ha
    if (d > Math.PI) d -= Math.PI * 2
    if (d < -Math.PI) d += Math.PI * 2
    out[i] = d / (2 * W * ds)
  }
}

/** Point attribute at a control-point position: smooth (cosine) blend between neighbours. */
function pointBlend(at: number, n: number): { i: number; j: number; w: number } {
  const a = ((at % n) + n) % n
  const i = Math.floor(a) % n
  const f = a - Math.floor(a)
  return { i, j: (i + 1) % n, w: (1 - Math.cos(Math.PI * f)) / 2 }
}

/**
 * Build the sampled road for a validated track file.
 * `bankMaxDeg` is the auto-bank cap in effect (the file's, or the live slider's).
 */
export function buildCenterline(file: ResolvedTrackFile, bankMaxDeg: number, nat: NaturalTerrain): Centerline {
  const road = file.road
  const pts = road.points
  const np = pts.length

  // ---- 1. control point heights ----
  const ctrl = pts.map((p) => ({
    x: p.x,
    z: p.z,
    y: typeof p.y === 'number' ? p.y : averagedHeight(nat, p.x, p.z) + (p.lift ?? 0),
  }))

  // ---- 2. the spline ----
  const dense = sampleClosedSpline(ctrl, 0.25)
  const Lb = dense.length

  // ---- 3. base samples every ~1 m, starting at the start line ----
  const nb = Math.max(32, Math.round(Lb / SAMPLE_SPACING))
  const dsb = Lb / nb
  const sStart = arcLengthAtParam(dense, file.start.at)
  const bx = new Float64Array(nb)
  const by = new Float64Array(nb)
  const bz = new Float64Array(nb)
  const bat = new Float64Array(nb)
  for (let k = 0; k < nb; k++) {
    const sd = (sStart + k * dsb) % Lb
    const j = Math.min(nodeAtLength(dense, sd), dense.count - 2)
    const seg = dense.cum[j + 1] - dense.cum[j]
    const f = seg > 0 ? (sd - dense.cum[j]) / seg : 0
    bx[k] = dense.x[j] + (dense.x[j + 1] - dense.x[j]) * f
    by[k] = dense.y[j] + (dense.y[j + 1] - dense.y[j]) * f
    bz[k] = dense.z[j] + (dense.z[j + 1] - dense.z[j]) * f
    bat[k] = (dense.at[j] + (dense.at[j + 1] - dense.at[j]) * f) % np
  }
  /** Base s (before loops are spliced in) of a control-point position. */
  const baseSOfAt = (at: number): number => {
    const s = arcLengthAtParam(dense, at) - sStart
    return ((s % Lb) + Lb) % Lb
  }

  // ---- per-point attributes: width and bank overrides ----
  const bHalf = new Float32Array(nb)
  const bOverW = new Float32Array(nb)
  const bOverV = new Float32Array(nb)
  for (let k = 0; k < nb; k++) {
    const { i, j, w } = pointBlend(bat[k], np)
    const wi = pts[i].width ?? road.width
    const wj = pts[j].width ?? road.width
    bHalf[k] = (wi + (wj - wi) * w) / 2
    const hi = typeof pts[i].bank === 'number' ? 1 : 0
    const hj = typeof pts[j].bank === 'number' ? 1 : 0
    bOverW[k] = hi + (hj - hi) * w
    bOverV[k] = hi * (pts[i].bank ?? 0) + (hj * (pts[j].bank ?? 0) - hi * (pts[i].bank ?? 0)) * w
  }

  // ---- 4. curvature and banking ----
  const bCurv = new Float32Array(nb)
  horizontalCurvature(bx, bz, nb, dsb, bCurv)
  circularSmooth(bCurv, Math.round(6 / dsb), 2)
  const bCurvWide = new Float32Array(bCurv)
  circularSmooth(bCurvWide, Math.round(30 / dsb), 2)

  // Bank from a broader view of the curvature: a spline's small wobble where a bend
  // meets a straight would otherwise bank the road the wrong way for a few metres
  // (at a 320 km/h design speed even a 1 km radius asks for the full bank).
  // Curves gentler than BANK_DEADBAND (radius > 3 km) count as straight.
  const bCurvBank = new Float32Array(bCurv)
  circularSmooth(bCurvBank, Math.round(25 / dsb), 2)
  // A real corner also TURNS: a gentle wobble that changes direction by only a few
  // degrees gets no bank at all, however fast the design speed. turnDeg is how far
  // the road turns over the 80 m around each sample.
  const turnDeg = new Float32Array(nb)
  {
    const W = Math.max(1, Math.round(40 / dsb))
    let sum = 0
    for (let k = -W; k <= W; k++) sum += bCurv[(k + nb) % nb]
    for (let k = 0; k < nb; k++) {
      turnDeg[k] = (Math.abs(sum) * dsb * 180) / Math.PI
      sum += bCurv[(k + W + 1) % nb] - bCurv[(k - W + nb) % nb]
    }
  }
  const vDesign = road.banking.designSpeedKmh / 3.6
  const bankTarget = new Float32Array(nb)
  for (let k = 0; k < nb; k++) {
    const kk = Math.sign(bCurvBank[k]) * Math.max(0, Math.abs(bCurvBank[k]) - BANK_DEADBAND)
    let auto = 0
    if (road.banking.auto) {
      const into = (Math.atan((vDesign * vDesign * Math.abs(kk)) / G) * 180) / Math.PI
      auto = Math.min(bankMaxDeg, into) * Math.sign(kk) * smoothstep(BANK_TURN_MIN, BANK_TURN_FULL, turnDeg[k])
    }
    // Overrides are "into the corner": right-handers and straights lift the left edge.
    const sgn = bCurvWide[k] >= -1 / 1500 ? 1 : -1
    bankTarget[k] = auto * (1 - bOverW[k]) + bOverV[k] * sgn
  }
  circularSmooth(bankTarget, Math.round(20 / dsb), 2)
  const bBank = new Float32Array(nb)
  for (let k = 0; k < nb; k++) bBank[k] = (clamp(bankTarget[k], -85, 85) * Math.PI) / 180

  // ---- base tangents (3D) ----
  const btx = new Float64Array(nb)
  const bty = new Float64Array(nb)
  const btz = new Float64Array(nb)
  for (let k = 0; k < nb; k++) {
    const a = (k - 1 + nb) % nb
    const b = (k + 1) % nb
    const tx = bx[b] - bx[a]
    const ty = by[b] - by[a]
    const tz = bz[b] - bz[a]
    const l = Math.hypot(tx, ty, tz) || 1
    btx[k] = tx / l
    bty[k] = ty / l
    btz[k] = tz / l
  }

  // ---- 5. loops: sideways shift either side, then splice the loop in ----
  const pieces = file.pieces
  const loopSpecs: { pieceIndex: number; sb: number; radius: number; shape: LoopShape }[] = []
  pieces.forEach((p, idx) => {
    if (p.type !== 'loop') return
    const radius = (p as LoopPiece).radius ?? 12
    loopSpecs.push({ pieceIndex: idx, sb: baseSOfAt(p.at), radius, shape: loopShape(radius) })
  })
  loopSpecs.sort((a, b) => a.sb - b.sb)

  // The loop comes down `advance` metres further along than it went up, so the
  // base road it lands on starts there; the base samples in between are skipped.
  const shift = new Float64Array(nb)
  const skip = new Uint8Array(nb)
  for (const L of loopSpecs) {
    const k0 = Math.floor(L.sb / dsb) % nb
    const d = bHalf[k0] * 2 + 1
    const adv = L.shape.advance
    for (let k = 0; k < nb; k++) {
      const delta = wrapDelta(L.sb, k * dsb, Lb)
      if (delta >= -LOOP_SHIFT && delta < 0) shift[k] += (-d / 2) * ((1 - Math.cos((Math.PI * (delta + LOOP_SHIFT)) / LOOP_SHIFT)) / 2)
      else if (delta >= 0 && delta < adv) skip[k] = 1
      else if (delta >= adv && delta <= adv + LOOP_SHIFT) shift[k] += (d / 2) * (1 - (1 - Math.cos((Math.PI * (delta - adv)) / LOOP_SHIFT)) / 2)
    }
  }

  // Node list (the road before the final, exact re-sample).
  const nx: number[] = []
  const ny: number[] = []
  const nz: number[] = []
  const nhw: number[] = []
  const nbank: number[] = []
  const nux: number[] = []
  const nuy: number[] = []
  const nuz: number[] = []
  const nsurf: number[] = []
  const nbs: number[] = []
  const pushBase = (k: number) => {
    // Horizontal right (for the loop shift) and the banked up vector.
    const hl = Math.hypot(btx[k], btz[k]) || 1
    const rxh = -btz[k] / hl
    const rzh = btx[k] / hl
    nx.push(bx[k] + rxh * shift[k])
    ny.push(by[k])
    nz.push(bz[k] + rzh * shift[k])
    nhw.push(bHalf[k])
    nbank.push(bBank[k])
    // up0 = world up made perpendicular to the tangent; roll it by the bank.
    const T0 = btx[k]
    const T1 = bty[k]
    const T2 = btz[k]
    let u0x = -T0 * T1
    let u0y = 1 - T1 * T1
    let u0z = -T2 * T1
    const ul = Math.hypot(u0x, u0y, u0z) || 1
    u0x /= ul
    u0y /= ul
    u0z /= ul
    // right0 = T x up0
    const r0x = T1 * u0z - T2 * u0y
    const r0y = T2 * u0x - T0 * u0z
    const r0z = T0 * u0y - T1 * u0x
    const c = Math.cos(bBank[k])
    const s = Math.sin(bBank[k])
    nux.push(u0x * c + r0x * s)
    nuy.push(u0y * c + r0y * s)
    nuz.push(u0z * c + r0z * s)
    nsurf.push(SURFACE_CODE.road)
    nbs.push(k * dsb)
  }

  let li = 0
  for (let k = 0; k < nb; k++) {
    if (!skip[k]) pushBase(k)
    const sNext = (k + 1) * dsb
    while (li < loopSpecs.length && loopSpecs[li].sb >= k * dsb && loopSpecs[li].sb < sNext) {
      const L = loopSpecs[li]
      // Loop entry point: the base road at L.sb (between sample k and k+1).
      const f = (L.sb - k * dsb) / dsb
      const k1 = (k + 1) % nb
      const Px = bx[k] + (bx[k1] - bx[k]) * f
      const Py = by[k] + (by[k1] - by[k]) * f
      const Pz = bz[k] + (bz[k1] - bz[k]) * f
      const hl = Math.hypot(btx[k], btz[k]) || 1
      const Tx = btx[k] / hl
      const Tz = btz[k] / hl
      const Rx = -Tz
      const Rz = Tx
      const hw = bHalf[k]
      const d = hw * 2 + 1
      const sh = L.shape
      // Where the base road really is when the loop comes down (it may have climbed or
      // curved a little since the entry): bend the loop gently so it lands exactly there.
      const m = sh.fwd.length - 1
      const se = (L.sb + sh.advance) / dsb
      const e0 = Math.floor(se) % nb
      const e1 = (e0 + 1) % nb
      const ef = se - Math.floor(se)
      const ehl = Math.hypot(btx[e0], btz[e0]) || 1
      const Ex = bx[e0] + (bx[e1] - bx[e0]) * ef + (-btz[e0] / ehl) * (d / 2)
      const Ey = by[e0] + (by[e1] - by[e0]) * ef
      const Ez = bz[e0] + (bz[e1] - bz[e0]) * ef + (btx[e0] / ehl) * (d / 2)
      const Mx = Ex - (Px + Rx * (d / 2) + Tx * sh.advance)
      const My = Ey - Py
      const Mz = Ez - (Pz + Rz * (d / 2) + Tz * sh.advance)
      for (let q = 0; q <= m; q++) {
        const ph = sh.phi[q]
        // Corkscrew drift across by d, with zero drift rate at the bottom (in and out).
        const lat = -d / 2 + (d * (ph - Math.sin(ph))) / (Math.PI * 2)
        const w = (1 - Math.cos((Math.PI * q) / m)) / 2
        nx.push(Px + Rx * lat + Tx * sh.fwd[q] + Mx * w)
        ny.push(Py + sh.up[q] + My * w)
        nz.push(Pz + Rz * lat + Tz * sh.fwd[q] + Mz * w)
        nhw.push(hw)
        nbank.push(0)
        // Up is the surface normal: perpendicular to the direction of travel, toward the inside.
        nux.push(-Tx * Math.sin(ph))
        nuy.push(Math.cos(ph))
        nuz.push(-Tz * Math.sin(ph))
        nsurf.push(SURFACE_CODE.loop)
        nbs.push(L.sb)
      }
      li++
    }
  }

  // ---- 6. final exact re-sample ----
  const nn = nx.length
  const ncum = new Float64Array(nn + 1)
  for (let i = 1; i <= nn; i++) {
    const a = i - 1
    const b = i % nn
    ncum[i] = ncum[a] + Math.hypot(nx[b] - nx[a], ny[b] - ny[a], nz[b] - nz[a])
  }
  const length = ncum[nn]
  const count = Math.max(32, Math.round(length / SAMPLE_SPACING))
  const ds = length / count
  const S: TrackSamples = {
    count,
    ds,
    px: new Float32Array(count),
    py: new Float32Array(count),
    pz: new Float32Array(count),
    tx: new Float32Array(count),
    ty: new Float32Array(count),
    tz: new Float32Array(count),
    ux: new Float32Array(count),
    uy: new Float32Array(count),
    uz: new Float32Array(count),
    rx: new Float32Array(count),
    ry: new Float32Array(count),
    rz: new Float32Array(count),
    halfWidth: new Float32Array(count),
    bank: new Float32Array(count),
    curvature: new Float32Array(count),
    surface: new Uint8Array(count),
    grounded: new Uint8Array(count),
  }
  const baseS = new Float64Array(count)
  let j = 0
  // Positions are kept in float64 until the end so long tracks don't wobble.
  const fx = new Float64Array(count)
  const fy = new Float64Array(count)
  const fz = new Float64Array(count)
  const hux = new Float64Array(count)
  const huy = new Float64Array(count)
  const huz = new Float64Array(count)
  for (let i = 0; i < count; i++) {
    const s = i * ds
    while (j < nn - 1 && ncum[j + 1] <= s) j++
    const a = j
    const b = (j + 1) % nn
    const seg = ncum[j + 1] - ncum[j]
    const f = seg > 0 ? (s - ncum[j]) / seg : 0
    fx[i] = nx[a] + (nx[b] - nx[a]) * f
    fy[i] = ny[a] + (ny[b] - ny[a]) * f
    fz[i] = nz[a] + (nz[b] - nz[a]) * f
    S.halfWidth[i] = nhw[a] + (nhw[b] - nhw[a]) * f
    S.bank[i] = nbank[a] + (nbank[b] - nbank[a]) * f
    hux[i] = nux[a] + (nux[b] - nux[a]) * f
    huy[i] = nuy[a] + (nuy[b] - nuy[a]) * f
    huz[i] = nuz[a] + (nuz[b] - nuz[a]) * f
    S.surface[i] = f < 0.5 ? nsurf[a] : nsurf[b]
    // Base s for mapping `at` -> final s (wraps cleanly: the last node pairs with node 0).
    const bsA = nbs[a]
    let bsB = nbs[b]
    if (b === 0) bsB = Lb
    baseS[i] = bsA + (bsB - bsA) * f
  }

  // Frames: tangent from neighbours, up made perpendicular to it, right = tangent x up.
  for (let i = 0; i < count; i++) {
    const a = (i - 1 + count) % count
    const b = (i + 1) % count
    let tx = fx[b] - fx[a]
    let ty = fy[b] - fy[a]
    let tz = fz[b] - fz[a]
    const tl = Math.hypot(tx, ty, tz) || 1
    tx /= tl
    ty /= tl
    tz /= tl
    let ux = hux[i]
    let uy = huy[i]
    let uz = huz[i]
    const d = ux * tx + uy * ty + uz * tz
    ux -= tx * d
    uy -= ty * d
    uz -= tz * d
    const ul = Math.hypot(ux, uy, uz) || 1
    ux /= ul
    uy /= ul
    uz /= ul
    S.px[i] = fx[i]
    S.py[i] = fy[i]
    S.pz[i] = fz[i]
    S.tx[i] = tx
    S.ty[i] = ty
    S.tz[i] = tz
    S.ux[i] = ux
    S.uy[i] = uy
    S.uz[i] = uz
    S.rx[i] = ty * uz - tz * uy
    S.ry[i] = tz * ux - tx * uz
    S.rz[i] = tx * uy - ty * ux
  }

  horizontalCurvature(fx, fz, count, ds, S.curvature)
  circularSmooth(S.curvature, Math.round(5 / ds), 2)
  for (let i = 0; i < count; i++) if (S.surface[i] === SURFACE_CODE.loop) S.curvature[i] = 0

  // ---- grounded: is the road close enough to the ground to fill up to it? ----
  for (let i = 0; i < count; i++) {
    if (S.surface[i] !== SURFACE_CODE.road) continue
    const gap = S.py[i] - nat.height(S.px[i], S.pz[i])
    S.grounded[i] = gap <= FILL_MAX ? 1 : 0
  }
  denoiseRuns(S.grounded, S.surface, Math.round(10 / ds))

  const thickness = new Float32Array(count)
  for (let i = 0; i < count; i++) thickness[i] = S.grounded[i] ? SLAB_GROUNDED : SLAB_THICKNESS
  circularSmooth(thickness, Math.round(4 / ds), 1)

  // ---- mapping from `at` to final s ----
  const sOfBase = (sb: number): number => {
    // baseS is non-decreasing from 0 to ~Lb; binary search it.
    let lo = 0
    let hi = count - 1
    if (sb <= baseS[0]) return 0
    if (sb >= baseS[count - 1]) {
      const f = (sb - baseS[count - 1]) / Math.max(1e-6, Lb - baseS[count - 1])
      return (count - 1 + clamp(f, 0, 1)) * ds
    }
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (baseS[mid] <= sb) lo = mid
      else hi = mid
    }
    const span = baseS[hi] - baseS[lo]
    const f = span > 0 ? (sb - baseS[lo]) / span : 0
    return (lo + f) * ds
  }
  const sOfAt = (at: number): number => sOfBase(baseSOfAt(at)) % length

  // ---- loops as found on the final road ----
  const loops: LoopInfo[] = []
  for (const L of loopSpecs) {
    // The loop's samples: surface 'loop' and the base s of this loop's entry.
    let i0 = -1
    let i1 = -1
    for (let i = 0; i < count; i++) {
      if (S.surface[i] === SURFACE_CODE.loop && Math.abs(baseS[i] - L.sb) < 1e-3) {
        if (i0 < 0) i0 = i
        i1 = i
      }
    }
    if (i0 < 0) continue
    const mid = Math.floor((i0 + i1) / 2)
    loops.push({
      pieceIndex: L.pieceIndex,
      s0: i0 * ds,
      s1: (i1 + 1) * ds,
      radius: L.radius,
      center: {
        x: S.px[mid] + S.ux[mid] * L.radius,
        y: S.py[mid] + S.uy[mid] * L.radius,
        z: S.pz[mid] + S.uz[mid] * L.radius,
      },
    })
  }

  // ---- wall rides: a sweep angle per sample on each edge ----
  const wallLeft = new Float32Array(count)
  const wallRight = new Float32Array(count)
  const wallRadius = new Float32Array(count)
  const walls: WallInfo[] = []
  pieces.forEach((p, idx) => {
    if (p.type !== 'wallride') return
    const w = p as WallRidePiece
    const len = w.length ?? 120
    const radius = w.height ?? 9
    const s0 = sOfAt(w.at)
    walls.push({ pieceIndex: idx, s0, s1: s0 + len, side: w.side, radius })
    const maxSweep = (WALL_SWEEP_DEG * Math.PI) / 180
    const i0 = Math.floor(s0 / ds)
    const i1 = Math.ceil((s0 + len) / ds)
    for (let ii = i0; ii <= i1; ii++) {
      const i = ((ii % count) + count) % count
      if (S.surface[i] !== SURFACE_CODE.road) continue
      const into = ii * ds - s0
      const sweep = maxSweep * smoothstep(0, WALL_RAMP, Math.min(into, len - into))
      if (sweep <= 0) continue
      if (w.side !== 'right' && sweep > wallLeft[i]) wallLeft[i] = sweep
      if (w.side !== 'left' && sweep > wallRight[i]) wallRight[i] = sweep
      wallRadius[i] = Math.max(wallRadius[i], radius)
    }
  })

  return { samples: S, length, thickness, wallLeft, wallRight, wallRadius, loops, walls, sOfAt }
}

/**
 * A loop's side profile. Not a circle: a circle switches from straight road to its
 * full curvature in one step, which at 110 km/h slams a car with ~8 g and bottoms
 * the suspension into the road (measured: the car stopped dead at the entry).
 * Real loops use a "teardrop": the curvature grows smoothly from gentle at the
 * bottom (about a 60 m radius) to tight at the top, so entry is ~1.5 g at 30 m/s
 * and the top is still tight enough to hold you upside down.
 *
 * The shape is the curvature profile k(u) = base + (1 - base) * sin^2(pi u / L),
 * scaled so the heading turns a full 360 degrees and the top is 2 x radius high.
 * Because the top sits ahead of the entry, the loop comes down `advance` metres
 * further along the road than it went up.
 */
export interface LoopShape {
  /** Metres forward (along the road) and up, and the heading angle, per node. */
  fwd: Float64Array
  up: Float64Array
  phi: Float64Array
  /** Where it comes down, metres ahead of where it went up. */
  advance: number
  /** Length of the loop's road, metres. */
  length: number
}

const LOOP_BASE = 0.15

export function loopShape(radius: number): LoopShape {
  // Integrate a unit-length loop finely, then scale it to the requested height.
  const N = 2000
  const du = 1 / N
  const shapeK = new Float64Array(N)
  let area = 0
  for (let i = 0; i < N; i++) {
    const sn = Math.sin(Math.PI * (i + 0.5) * du)
    shapeK[i] = LOOP_BASE + (1 - LOOP_BASE) * sn * sn
    area += shapeK[i] * du
  }
  const fx = new Float64Array(N + 1)
  const fy = new Float64Array(N + 1)
  const fp = new Float64Array(N + 1)
  let h = 0
  let x = 0
  let y = 0
  let ymax = 0
  for (let i = 0; i < N; i++) {
    const k = (Math.PI * 2 * shapeK[i]) / area
    h += (k * du) / 2
    x += Math.cos(h) * du
    y += Math.sin(h) * du
    h += (k * du) / 2
    fx[i + 1] = x
    fy[i + 1] = y
    fp[i + 1] = h
    if (y > ymax) ymax = y
  }
  const L = (2 * radius) / ymax
  // Resample at ~0.4 m.
  const m = Math.max(64, Math.ceil(L / 0.4))
  const fwd = new Float64Array(m + 1)
  const up = new Float64Array(m + 1)
  const phi = new Float64Array(m + 1)
  for (let q = 0; q <= m; q++) {
    const j = Math.round((q / m) * N)
    fwd[q] = fx[j] * L
    up[q] = fy[j] * L
    phi[q] = fp[j]
  }
  // Land exactly level (removes the integration's last few millimetres of error).
  up[m] = 0
  phi[m] = Math.PI * 2
  return { fwd, up, phi, advance: fwd[m], length: L }
}

/** Flip short runs of grounded / not-grounded so the ground doesn't flicker along the road. */
function denoiseRuns(flags: Uint8Array, surface: Uint8Array, minRun: number): void {
  const n = flags.length
  // Find a run boundary to start from so wrap-around runs are handled whole.
  let start = 0
  while (start < n && flags[start] === flags[(start - 1 + n) % n]) start++
  if (start >= n) return
  let i = 0
  while (i < n) {
    const a = (start + i) % n
    const v = flags[a]
    let len = 1
    while (len < n && flags[(a + len) % n] === v) len++
    if (len < minRun && v === 1) {
      for (let k = 0; k < len; k++) flags[(a + k) % n] = 0
    } else if (len < minRun && v === 0) {
      let allRoad = true
      for (let k = 0; k < len; k++) if (surface[(a + k) % n] !== SURFACE_CODE.road) allRoad = false
      if (allRoad) for (let k = 0; k < len; k++) flags[(a + k) % n] = 1
    }
    i += len
  }
}
