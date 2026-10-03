// ============================================================
//  DERIVED TRACK DATA - everything worked out from the file
// ------------------------------------------------------------
//  A track file never lists checkpoints, a racing line, a start
//  grid or where the roadside posts go. They are all worked out
//  here from the road itself, so a brand new track (or one Josh
//  draws in the editor) gets them for free.
//
//    checkpoints   sector lines every ~150-250 m for lap validity
//    racingLine    where the Ai drives and how fast (racingLine below)
//    minimap       a decimated outline for the HUD
//    roadside      smashable posts along both edges, billboard spots
//                  on the outside of bends
// ============================================================

import type { ResolvedTrackFile } from './schema'
import { SURFACE_CODE, type GroundPose, type TrackSamples } from './types'
import { circularSmooth, type Centerline } from './road'
import type { SampleHash } from './query'
import { mulberry32, clamp } from './noise'
import { FULL_LOCK_GRIP, fullLockG } from '../core/gripTable'

const G = 9.81

// ---------------------------------------------------------------- checkpoints

/**
 * 8-16 sector lines spaced evenly, the first on the start line. A line that would
 * fall inside a loop moves back to 10 m before the loop's entry (a lap checker or a
 * respawn should never have to stand on a loop).
 */
export function makeCheckpoints(length: number, avoid: { s0: number; s1: number }[] = []): Float32Array {
  const n = clamp(Math.round(length / 200), 8, 16)
  const out = new Float32Array(n)
  for (let k = 0; k < n; k++) {
    let s = (k * length) / n
    for (const a of avoid) {
      const d = (((s - a.s0) % length) + length) % length
      const span = (((a.s1 - a.s0) % length) + length) % length
      if (k > 0 && d <= span) s = (((a.s0 - 10) % length) + length) % length
    }
    out[k] = s
  }
  return out
}

// ---------------------------------------------------------------- racing line

export interface RacingLineInput {
  samples: TrackSamples
  length: number
  /** [s0, s1] ranges where the line must hold the centre (loops, ramps). */
  /** [s0, s1] ranges where the line must hold an offset (loops at 0, a ramp at its own offset). */
  pinned: { s0: number; s1: number; value?: number }[]
  /** [s0, s1] ranges that need speed for magnetic grip (loops; wall rides are driven on their flat floor). */
  fast: { s0: number; s1: number }[]
  /** Ramp positions: slow a little before one that launches into a corner. */
  ramps: number[]
  /** Keep the line at least this far inside the road edges (more where there are walls). */
  edgeMargin: number
  /** The line from a previous build of the same road shape (a live bank change): reused as is. */
  reuseOffset?: Float32Array
}

/** Signed curvature of the circle through three points (x, z), + = turning right. */
function menger(ax: number, az: number, bx: number, bz: number, cx: number, cz: number): number {
  const ux = bx - ax
  const uz = bz - az
  const vx = cx - bx
  const vz = cz - bz
  const cross = ux * vz - uz * vx
  const d = Math.hypot(ux, uz) * Math.hypot(vx, vz) * Math.hypot(cx - ax, cz - az)
  return d > 1e-9 ? (2 * cross) / d : 0
}

/**
 * Shape the line so its curvature changes as smoothly as possible (the K1999 method
 * from the TORCS racing sim): each point moves sideways until its curvature is the
 * average of its neighbours'. Corners get spread over the whole width, which gives
 * the classic outside-apex-outside line, and long bends are taken wide rather than
 * hugging the inside (hugging the inside is the shortest way round, not the fastest).
 */
function relaxCurvature(
  cx: Float64Array,
  cz: Float64Array,
  rx: Float64Array,
  rz: Float64Array,
  lo: Float64Array,
  hi: Float64Array,
  off: Float64Array,
  iterations: number,
): void {
  const M = off.length
  const X = (m: number) => cx[(m + M) % M] + rx[(m + M) % M] * off[(m + M) % M]
  const Z = (m: number) => cz[(m + M) % M] + rz[(m + M) % M] * off[(m + M) % M]
  const DELTA = 0.1
  for (let it = 0; it < iterations; it++) {
    for (let m = 0; m < M; m++) {
      const ax = X(m - 1)
      const az = Z(m - 1)
      const bx = X(m + 1)
      const bz = Z(m + 1)
      const px = X(m)
      const pz = Z(m)
      const target = (menger(X(m - 2), Z(m - 2), ax, az, px, pz) + menger(px, pz, bx, bz, X(m + 2), Z(m + 2))) / 2
      const k0 = menger(ax, az, px, pz, bx, bz)
      const k1 = menger(ax, az, px + rx[m] * DELTA, pz + rz[m] * DELTA, bx, bz)
      const dk = (k1 - k0) / DELTA
      if (Math.abs(dk) < 1e-9) continue
      let o = off[m] + 0.7 * ((target - k0) / dk)
      if (o > hi[m]) o = hi[m]
      else if (o < lo[m]) o = lo[m]
      off[m] = o
    }
  }
}

/** The pinned offset at s, or null if s is not in a pinned range. */
function pinAt(s: number, ranges: { s0: number; s1: number; value?: number }[], length: number): number | null {
  for (const r of ranges) {
    let d = s - r.s0
    d = ((d % length) + length) % length
    const span = (((r.s1 - r.s0) % length) + length) % length
    if (d <= span) return r.value ?? 0
  }
  return null
}

function inRanges(s: number, ranges: { s0: number; s1: number }[], length: number): boolean {
  for (const r of ranges) {
    let d = s - r.s0
    d = ((d % length) + length) % length
    const span = (((r.s1 - r.s0) % length) + length) % length
    if (d <= span) return true
  }
  return false
}

/**
 * The Ai's racing line: a smooth outside-apex-outside offset within the road
 * (edgeMargin metres inside each edge), shaped by relaxCurvature(). Then a
 * target speed per sample from the line's curvature and banking, with a braking
 * pass backward and an acceleration pass forward so speeds are reachable.
 */
export function makeRacingLine(inp: RacingLineInput): { offset: Float32Array; speed: Float32Array } {
  const S = inp.samples
  const count = S.count
  const ds = S.ds
  const L = inp.length

  // ---- where the line may go: per-sample bounds ----
  // Inside the edges by edgeMargin; held at a fixed offset on pinned stretches (loops at
  // 0, a ramp at its own offset); and eased into each pinned stretch
  // sideways along a gentle curve (PIN_EASE_R radius), so the line never kinks to meet a pin.
  const PIN_EASE_R = 400
  const loB = new Float64Array(count)
  const hiB = new Float64Array(count)
  const pinVal = new Float64Array(count).fill(NaN)
  for (let i = 0; i < count; i++) {
    const lim = Math.max(0, S.halfWidth[i] - inp.edgeMargin)
    loB[i] = -lim
    hiB[i] = lim
    if (S.surface[i] !== SURFACE_CODE.road) pinVal[i] = 0
    else {
      const pin = pinAt(i * ds, inp.pinned, L)
      if (pin !== null) pinVal[i] = pin
    }
  }
  // Distance to (and value of) the nearest pin, both directions round the lap.
  const dist = new Float64Array(count).fill(Infinity)
  const near = new Float64Array(count)
  for (let pass = 0; pass < 2; pass++) {
    for (let n = 0; n < count * 2; n++) {
      const i = pass === 0 ? n % count : (count * 2 - 1 - n) % count
      if (!Number.isNaN(pinVal[i])) {
        dist[i] = 0
        near[i] = pinVal[i]
        continue
      }
      const j = pass === 0 ? (i - 1 + count) % count : (i + 1) % count
      if (dist[j] + ds < dist[i]) {
        dist[i] = dist[j] + ds
        near[i] = near[j]
      }
    }
  }
  for (let i = 0; i < count; i++) {
    if (!Number.isFinite(dist[i])) continue
    const dev = (dist[i] * dist[i]) / (2 * PIN_EASE_R)
    const lo = Math.max(loB[i], near[i] - dev)
    const hi = Math.min(hiB[i], near[i] + dev)
    if (lo <= hi) {
      loB[i] = lo
      hiB[i] = hi
    } else {
      const v = clamp(near[i], loB[i], hiB[i])
      loB[i] = v
      hiB[i] = v
    }
  }

  const offset = new Float32Array(count)
  if (inp.reuseOffset && inp.reuseOffset.length === count) offset.set(inp.reuseOffset)
  else solveOffsets(S, loB, hiB, offset)
  for (let i = 0; i < count; i++) offset[i] = clamp(offset[i], loB[i], hiB[i])

  return { offset, speed: makeSpeeds(inp, offset) }
}

/** The line itself: coarse-to-fine curvature relaxation inside the bounds. */
function solveOffsets(S: TrackSamples, loB: Float64Array, hiB: Float64Array, offset: Float32Array): void {
  const count = S.count
  const ds = S.ds
  // Coarse-to-fine: solve at 12 m spacing, then refine at 4 m.
  let prevOff: Float64Array | null = null
  let prevStride = 0
  for (const strideM of [12, 4]) {
    const stride = Math.max(1, Math.round(strideM / ds))
    const M = Math.floor(count / stride)
    const cx = new Float64Array(M)
    const cz = new Float64Array(M)
    const rx = new Float64Array(M)
    const rz = new Float64Array(M)
    const lo = new Float64Array(M)
    const hi = new Float64Array(M)
    const off = new Float64Array(M)
    for (let m = 0; m < M; m++) {
      const i = m * stride
      cx[m] = S.px[i]
      cz[m] = S.pz[i]
      const rl = Math.hypot(S.rx[i], S.rz[i]) || 1
      rx[m] = S.rx[i] / rl
      rz[m] = S.rz[i] / rl
      lo[m] = loB[i]
      hi[m] = hiB[i]
      if (prevOff) {
        // Start from the coarse solution.
        const fpos = (i / prevStride) % prevOff.length
        const a = Math.floor(fpos)
        const b = (a + 1) % prevOff.length
        const f = fpos - a
        off[m] = clamp(prevOff[a] + (prevOff[b] - prevOff[a]) * f, lo[m], hi[m])
      } else off[m] = clamp(0, lo[m], hi[m])
    }
    relaxCurvature(cx, cz, rx, rz, lo, hi, off, strideM === 12 ? 400 : 150)
    prevOff = off
    prevStride = stride
  }

  const po = prevOff!
  for (let i = 0; i < count; i++) {
    const fpos = i / prevStride
    const a = Math.floor(fpos) % po.length
    const b = (a + 1) % po.length
    const f = fpos - Math.floor(fpos)
    offset[i] = po[a] + (po[b] - po[a]) * f
  }
  circularSmooth(offset, Math.round(3 / ds), 2)
}

/**
 * THE racing line's cornering grip, in g. Every corner speed on every track comes
 * from these two numbers, so this is the one place to change how hard the Ai is
 * asked to corner. LINE_GRIP_G is what the tyres give on flat road (kept under the
 * car's real grip so the Ai has margin: vehicle measured a 1.48 g skidpad);
 * a bank into the corner adds to it, but never past LINE_MAX_LAT_G, nor past what the
 * worst car can steer at that speed (lineLatCapG below). The line gate in tracks:check
 * allows LINE_MAX_LAT_G + 0.05 of tyre grip and checks the steering reach.
 */
export const LINE_GRIP_G = 1.25
export const LINE_MAX_LAT_G = 1.4

/** The line plans at most this share of the worst car's full lock, so the Ai always has steering left to correct with. */
const FULL_LOCK_SHARE = 0.95

/**
 * The most sideways acceleration (g) the least grippy car can reach at full lock at
 * speed v (m/s). The numbers are the vehicle worker's measurements in
 * src/core/gripTable.ts (the one place they live).
 */
export function carFullLockG(v: number): number {
  return fullLockG(v * 3.6, FULL_LOCK_GRIP.leastBodyGrip)
}

/**
 * The line's cornering cap at speed v (m/s), in g of turn ALONG THE ROAD (v^2 x the
 * curve's curvature x cos(bank)): never more than LINE_MAX_LAT_G, and never more than
 * FULL_LOCK_SHARE of the worst car's full lock. The steering only has to turn the car
 * along the road's own surface, and on a bank a horizontal curve is gentler seen from
 * the road (cos(bank) of its curvature: half on a 60 deg bank), so a steeper bank lets
 * the line go faster through the same corner. Grip is planned separately (the tyres
 * plus what the bank carries, makeSpeeds).
 */
export function lineLatCapG(v: number): number {
  return Math.min(LINE_MAX_LAT_G, FULL_LOCK_SHARE * carFullLockG(v))
}

/** Braking and acceleration the line plans on flat road, m/s^2 (with margin under the car's real figures). */
const BRAKE = 7
const ACCEL = 5
/** However steep the hill, the line plans at least this much braking and acceleration (m/s^2)... */
const BRAKE_MIN = 2
const ACCEL_MIN = 1
/** ...and never more than this (a steep climb doesn't give the brakes superpowers). */
const BRAKE_MAX = 10
const ACCEL_MAX = 8

/**
 * Braking the line can count on where the road's slope is `ty` (tangent.y, which is
 * sin(slope): + climbing, - descending). Downhill, gravity pulls the car along the
 * road and eats into the brakes; uphill it helps. The line gate checks every braking
 * zone against this same figure.
 */
export function brakeOnSlope(ty: number): number {
  return clamp(BRAKE + G * ty, BRAKE_MIN, BRAKE_MAX)
}

/** Target speed per sample for a given line. */
function makeSpeeds(inp: RacingLineInput, offset: Float32Array): Float32Array {
  const S = inp.samples
  const count = S.count
  const ds = S.ds
  const L = inp.length
  // ---- speeds from the line's curvature ----
  const lx = new Float64Array(count)
  const lz = new Float64Array(count)
  for (let i = 0; i < count; i++) {
    const rl = Math.hypot(S.rx[i], S.rz[i]) || 1
    lx[i] = S.px[i] + (S.rx[i] / rl) * offset[i]
    lz[i] = S.pz[i] + (S.rz[i] / rl) * offset[i]
  }
  // Curvature of the line itself (circle through points 4 m either side), then the
  // TIGHTEST value within +/-5 m: plan for the sharpest part of each bend, never an average.
  const kRaw = new Float32Array(count)
  const W4 = Math.max(1, Math.round(4 / ds))
  for (let i = 0; i < count; i++) {
    const a = (i - W4 + count) % count
    const b = (i + W4) % count
    kRaw[i] = menger(lx[a], lz[a], lx[i], lz[i], lx[b], lz[b])
  }
  const k = new Float32Array(count)
  const W5 = Math.max(1, Math.round(5 / ds))
  for (let i = 0; i < count; i++) {
    let best = kRaw[i]
    for (let d = -W5; d <= W5; d++) {
      const v = kRaw[(i + d + count) % count]
      if (Math.abs(v) > Math.abs(best)) best = v
    }
    k[i] = best
  }

  const VMAX = 75
  const MAG_MIN = 27
  const LOOP_SPEED = 34
  const speed = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    const kk = Math.abs(k[i])
    if (S.surface[i] === SURFACE_CODE.loop) {
      // Fast enough to stick upside down, not so fast the entry slams the suspension.
      speed[i] = LOOP_SPEED
      continue
    }
    if (S.surface[i] !== SURFACE_CODE.road || kk < 1e-5) {
      speed[i] = VMAX
      continue
    }
    // Banking into the corner lets you go faster: v^2 = gR (sin + mu cos) / (cos - mu sin).
    const into = S.bank[i] * Math.sign(k[i])
    const c = Math.cos(into)
    const sn = Math.sin(into)
    const den = c - LINE_GRIP_G * sn
    const num = sn + LINE_GRIP_G * c
    const v2 = den <= 0.05 ? VMAX * VMAX : (G / kk) * (num / den)
    // Grip says v; the steering cap depends on speed too, so settle it: each pass can
    // only lower v, and the cap falls with v, so a few passes land on the speed where
    // v^2 x curvature is exactly the cap (it changes slowly, so this converges fast).
    // The steering's cap is on the turn along the road's surface: the curve's curvature
    // x cos(bank) (see lineLatCapG).
    const kRoad = kk * Math.max(0.1, c)
    let v = Math.min(VMAX, Math.sqrt(Math.max(0, v2)))
    for (let it = 0; it < 6; it++) v = Math.min(v, Math.sqrt((lineLatCapG(v) * G) / kRoad))
    speed[i] = v
  }

  // Crests: above sqrt(g R) the car goes light and leaves the road. Let the Ai float
  // a little (x CREST_FLOAT) but not launch off a crest flat out into the next bend.
  const CREST_FLOAT = 1.35
  const W = Math.max(1, Math.round(6 / ds))
  for (let i = 0; i < count; i++) {
    if (S.surface[i] !== SURFACE_CODE.road) continue
    const a = (i - W + count) % count
    const b = (i + W) % count
    const ga = S.ty[a] / (Math.hypot(S.tx[a], S.tz[a]) || 1)
    const gb = S.ty[b] / (Math.hypot(S.tx[b], S.tz[b]) || 1)
    const kv = (gb - ga) / (2 * W * ds)
    if (kv < -1e-4) speed[i] = Math.min(speed[i], CREST_FLOAT * Math.sqrt(G / -kv))
  }

  // Ramps that launch into a corner: arrive a bit slower.
  for (const rs of inp.ramps) {
    const i0 = Math.round(rs / ds)
    let vCorner = VMAX
    for (let d = 0; d < Math.round(160 / ds); d++) vCorner = Math.min(vCorner, speed[(i0 + d) % count])
    if (vCorner < VMAX * 0.7) {
      const cap = vCorner * 1.2
      for (let d = -Math.round(10 / ds); d <= Math.round(4 / ds); d++) {
        const i = (((i0 + d) % count) + count) % count
        speed[i] = Math.min(speed[i], cap)
      }
    }
  }

  const floorFast = () => {
    for (let i = 0; i < count; i++) {
      if (S.surface[i] !== SURFACE_CODE.road || inRanges(i * ds, inp.fast, L)) speed[i] = Math.max(speed[i], MAG_MIN)
    }
  }
  floorFast()
  // Backward: brake in time (~7 m/s^2 on the flat, with margin). Forward: accelerate
  // realistically (~5 m/s^2 on the flat). Two laps each so the wrap settles.
  // Both feel the hill: going downhill, gravity pulls the car along the road with
  // g x sin(slope), which eats into the brakes (and adds to the engine); uphill it's
  // the other way round. tangent.y IS sin(slope) (+ climbing, - descending), so the
  // brakes have BRAKE + g x ty to work with. Loops keep their own fixed speed.
  const slopeOf = (i: number) => (S.surface[i] === SURFACE_CODE.road ? S.ty[i] : 0)
  for (let pass = 0; pass < 2; pass++) {
    for (let n = count * 2 - 1; n >= 0; n--) {
      const i = n % count
      const j = (i + 1) % count
      const lim = Math.sqrt(speed[j] * speed[j] + 2 * brakeOnSlope(slopeOf(i)) * ds)
      if (speed[i] > lim) speed[i] = lim
    }
    for (let n = 0; n < count * 2; n++) {
      const i = n % count
      const j = (i + 1) % count
      const accel = clamp(ACCEL - G * slopeOf(i), ACCEL_MIN, ACCEL_MAX)
      const lim = Math.sqrt(speed[i] * speed[i] + 2 * accel * ds)
      if (speed[j] > lim) speed[j] = lim
    }
  }
  floorFast()
  return speed
}

// ---------------------------------------------------------------- minimap

export function makeMinimap(S: TrackSamples): { path: Float32Array; minX: number; minZ: number; maxX: number; maxZ: number } {
  const step = Math.max(1, Math.round(4 / S.ds))
  const n = Math.ceil(S.count / step)
  const path = new Float32Array(n * 2)
  let minX = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxZ = -Infinity
  for (let k = 0; k < n; k++) {
    const i = Math.min(S.count - 1, k * step)
    path[k * 2] = S.px[i]
    path[k * 2 + 1] = S.pz[i]
  }
  for (let i = 0; i < S.count; i++) {
    const hw = S.halfWidth[i]
    if (S.px[i] - hw < minX) minX = S.px[i] - hw
    if (S.px[i] + hw > maxX) maxX = S.px[i] + hw
    if (S.pz[i] - hw < minZ) minZ = S.pz[i] - hw
    if (S.pz[i] + hw > maxZ) maxZ = S.pz[i] + hw
  }
  return { path, minX, minZ, maxX, maxZ }
}

// ---------------------------------------------------------------- roadside

/** Heading (rotation about +y) that turns an object's front (local -z) to face direction (dx, dz). */
export function headingToward(dx: number, dz: number): number {
  return Math.atan2(-dx, -dz)
}

/** Is any road sample within `r` metres horizontally of (x, z)? */
export function roadWithin(S: TrackSamples, hash: SampleHash, x: number, z: number, r: number): boolean {
  const c0x = Math.floor((x - r - hash.minX) / hash.cell)
  const c1x = Math.floor((x + r - hash.minX) / hash.cell)
  const c0z = Math.floor((z - r - hash.minZ) / hash.cell)
  const c1z = Math.floor((z + r - hash.minZ) / hash.cell)
  const r2 = r * r
  for (let gz = Math.max(0, c0z); gz <= Math.min(hash.nz - 1, c1z); gz++) {
    for (let gx = Math.max(0, c0x); gx <= Math.min(hash.nx - 1, c1x); gx++) {
      const c = gz * hash.nx + gx
      for (let k = hash.start[c], e = hash.start[c + 1]; k < e; k++) {
        const i = hash.items[k]
        const dx = S.px[i] - x
        const dz = S.pz[i] - z
        if (dx * dx + dz * dz < r2) return true
      }
    }
  }
  return false
}

/** Closest horizontal distance from (x, z) to the edge of any road sample nearby (Infinity if none within r). */
function edgeClearance(S: TrackSamples, hash: SampleHash, x: number, z: number, r: number): number {
  const c0x = Math.floor((x - r - hash.minX) / hash.cell)
  const c1x = Math.floor((x + r - hash.minX) / hash.cell)
  const c0z = Math.floor((z - r - hash.minZ) / hash.cell)
  const c1z = Math.floor((z + r - hash.minZ) / hash.cell)
  let best = Infinity
  for (let gz = Math.max(0, c0z); gz <= Math.min(hash.nz - 1, c1z); gz++) {
    for (let gx = Math.max(0, c0x); gx <= Math.min(hash.nx - 1, c1x); gx++) {
      const c = gz * hash.nx + gx
      for (let k = hash.start[c], e = hash.start[c + 1]; k < e; k++) {
        const i = hash.items[k]
        const d = Math.hypot(S.px[i] - x, S.pz[i] - z) - S.halfWidth[i]
        if (d < best) best = d
      }
    }
  }
  return best
}

export interface RoadsideInput {
  file: ResolvedTrackFile
  c: Centerline
  hash: SampleHash
  terrainHeight: (x: number, z: number) => number
  /** True if (x, z) is inside the drivable world (clear of the edge mountains / wall). */
  insideWorld: (x: number, z: number, margin: number) => boolean
  /** s ranges where posts must not go (ramps, a margin round loops and wall rides). */
  noPosts: { s0: number; s1: number }[]
  /**
   * s ranges where cars fly or crowd (round loops and wall rides, ramps and their
   * landings, crests that throw you): no billboard beside any road in them.
   */
  noBillboards: { s0: number; s1: number }[]
  /** True where a billboard must not stand off the road (a big-air run's flight path, a tunnel). */
  keepOut: (x: number, z: number) => boolean
  /** True where nothing placed by the road may stand (on or in a tunnel's solid). */
  keepOff: (x: number, z: number) => boolean
  seed: number
}

/** Is any road sample within `r` metres of (x, z) in one of the s ranges? */
function nearRanges(S: TrackSamples, hash: SampleHash, x: number, z: number, r: number, ranges: { s0: number; s1: number }[], L: number): boolean {
  if (!ranges.length) return false
  const c0x = Math.floor((x - r - hash.minX) / hash.cell)
  const c1x = Math.floor((x + r - hash.minX) / hash.cell)
  const c0z = Math.floor((z - r - hash.minZ) / hash.cell)
  const c1z = Math.floor((z + r - hash.minZ) / hash.cell)
  const r2 = r * r
  for (let gz = Math.max(0, c0z); gz <= Math.min(hash.nz - 1, c1z); gz++) {
    for (let gx = Math.max(0, c0x); gx <= Math.min(hash.nx - 1, c1x); gx++) {
      const c = gz * hash.nx + gx
      for (let k = hash.start[c], e = hash.start[c + 1]; k < e; k++) {
        const i = hash.items[k]
        const dx = S.px[i] - x
        const dz = S.pz[i] - z
        if (dx * dx + dz * dz < r2 && inRanges(i * S.ds, ranges, L)) return true
      }
    }
  }
  return false
}

/** Smashable posts along both edges, every `spacing` metres, ~3.5 m outside the edge. */
export function makePosts(inp: RoadsideInput): GroundPose[] {
  const out: GroundPose[] = []
  const f = inp.file
  const posts = f.environment.roadside.posts
  if (!posts || f.road.barriers === 'walls') return out
  const S = inp.c.samples
  const L = inp.c.length
  const spacing = Math.max(8, posts.spacing)
  const n = Math.floor(L / spacing)
  for (let k = 0; k < n; k++) {
    const s = k * spacing + spacing * 0.5
    const i = Math.round(s / S.ds) % S.count
    if (S.surface[i] !== SURFACE_CODE.road || S.grounded[i] !== 1) continue
    if (inRanges(s, inp.noPosts, L)) continue
    const rl = Math.hypot(S.rx[i], S.rz[i]) || 1
    const rxh = S.rx[i] / rl
    const rzh = S.rz[i] / rl
    for (const side of [-1, 1]) {
      const wall = side < 0 ? inp.c.wallLeft[i] : inp.c.wallRight[i]
      if (wall > 0) continue
      const lat = S.halfWidth[i] + 3.5
      const x = S.px[i] + rxh * lat * side
      const z = S.pz[i] + rzh * lat * side
      if (!inp.insideWorld(x, z, 10) || inp.keepOff(x, z)) continue
      // Not on (or right next to) another bit of road.
      if (edgeClearance(S, inp.hash, x, z, 30) < 2.5) continue
      const y = inp.terrainHeight(x, z)
      const edgeY = S.py[i] + S.ry[i] * S.halfWidth[i] * side
      // Steep shoulder (deep cut or tall fill): a post would hang or be buried.
      if (Math.abs(y - edgeY) > 1.6) continue
      const slope = Math.abs(inp.terrainHeight(x + rxh * side, z + rzh * side) - inp.terrainHeight(x - rxh * side, z - rzh * side)) / 2
      if (slope > 0.45) continue
      out.push({ x, y, z, heading: headingToward(-rxh * side, -rzh * side) })
    }
  }
  return out
}

/** Closest two billboard spots may be, metres (the widest kind, a big screen, is about 25 m across). */
const BILLBOARD_MIN_APART = 36

/**
 * Billboard spots: set back 14-30 m from the edge on the outside of bends, facing the
 * road, close enough to line the run. They're solid poles, so never where cars fly or
 * crowd (see RoadsideInput.noBillboards and keepOut).
 */
export function makeBillboards(inp: RoadsideInput): GroundPose[] {
  const want = inp.file.environment.roadside.billboards
  const out: GroundPose[] = []
  if (want <= 0) return out
  const S = inp.c.samples
  const L = inp.c.length
  const rand = mulberry32(inp.seed ^ 0x51ab0a7d)
  const kWide = new Float32Array(S.curvature)
  circularSmooth(kWide, Math.round(25 / S.ds), 2)

  // Candidates every 10 m, best (tightest bend) first.
  const step = Math.max(1, Math.round(10 / S.ds))
  const cand: number[] = []
  for (let i = 0; i < S.count; i += step) if (S.surface[i] === SURFACE_CODE.road) cand.push(i)
  cand.sort((a, b) => Math.abs(kWide[b]) - Math.abs(kWide[a]))

  // Even spacing along the road to start with; relaxed below if that leaves us short.
  const evenGapS = L / (want * 1.6)
  let minGapS = evenGapS
  const taken: number[] = []
  const tryAt = (i: number, side: number): boolean => {
    for (const t of taken) {
      const d = ((((i - t) * S.ds) % L) + L) % L
      if (Math.min(d, L - d) < minGapS) return false
    }
    const rl = Math.hypot(S.rx[i], S.rz[i]) || 1
    const rxh = S.rx[i] / rl
    const rzh = S.rz[i] / rl
    const back = S.halfWidth[i] + 14 + rand() * 16
    const x = S.px[i] + rxh * back * side
    const z = S.pz[i] + rzh * back * side
    if (!inp.insideWorld(x, z, 30)) return false
    if (edgeClearance(S, inp.hash, x, z, 40) < 12) return false
    for (const b of out) if (Math.hypot(b.x - x, b.z - z) < BILLBOARD_MIN_APART) return false
    if (inp.keepOut(x, z) || nearRanges(S, inp.hash, x, z, 40, inp.noBillboards, L)) return false
    const y = inp.terrainHeight(x, z)
    const gx = inp.terrainHeight(x + 2, z) - inp.terrainHeight(x - 2, z)
    const gz = inp.terrainHeight(x, z + 2) - inp.terrainHeight(x, z - 2)
    if (Math.hypot(gx, gz) / 4 > 0.4) return false
    out.push({ x, y, z, heading: headingToward(S.px[i] - x, S.pz[i] - z) })
    taken.push(i)
    return true
  }
  // Outside of bends first (outside = left of a right-hander).
  for (const i of cand) {
    if (out.length >= want) break
    if (Math.abs(kWide[i]) < 1 / 600) break
    tryAt(i, kWide[i] > 0 ? -1 : 1)
  }
  // Then anywhere left (straights, and the inside of bends whose outside is blocked by
  // the edge mountains on a small world), alternating sides, until we have enough.
  // Stretches where nothing may stand (loops, ramps, crests) eat into the even spacing,
  // so if we're still short, close the spacing along the road a little and look again;
  // billboards always stay BILLBOARD_MIN_APART metres apart however tight it gets.
  let side = 1
  for (const relax of [1, 0.75, 0.55]) {
    minGapS = evenGapS * relax
    for (let pass = 0; pass < 3 && out.length < want; pass++) {
      for (let k = 0; k < cand.length && out.length < want; k += 1) {
        const i = cand[(k * 7 + pass * 3) % cand.length]
        if (tryAt(i, side) || tryAt(i, -side)) side = -side
      }
    }
  }
  return out
}
