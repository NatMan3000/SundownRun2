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
import { circularSmooth, horizontalCurvature, type Centerline } from './road'
import type { SampleHash } from './query'
import { mulberry32, clamp } from './noise'

const G = 9.81

// ---------------------------------------------------------------- checkpoints

/** 8-16 sector lines spaced evenly, the first on the start line. */
export function makeCheckpoints(length: number): Float32Array {
  const n = clamp(Math.round(length / 200), 8, 16)
  const out = new Float32Array(n)
  for (let k = 0; k < n; k++) out[k] = (k * length) / n
  return out
}

// ---------------------------------------------------------------- racing line

export interface RacingLineInput {
  samples: TrackSamples
  length: number
  /** [s0, s1] ranges where the line must hold the centre (loops, ramps). */
  pinned: { s0: number; s1: number }[]
  /** [s0, s1] ranges that need speed for magnetic grip (loops, wall rides). */
  fast: { s0: number; s1: number }[]
  /** Ramp positions: slow a little before one that launches into a corner. */
  ramps: number[]
}

/** Relax a set of lateral offsets toward the straightest line within bounds (Gauss-Seidel). */
function relax(
  cx: Float64Array,
  cz: Float64Array,
  rx: Float64Array,
  rz: Float64Array,
  lim: Float64Array,
  off: Float64Array,
  iterations: number,
): void {
  const M = off.length
  for (let it = 0; it < iterations; it++) {
    for (let m = 0; m < M; m++) {
      const a = m === 0 ? M - 1 : m - 1
      const b = m === M - 1 ? 0 : m + 1
      const tx = (cx[a] + rx[a] * off[a] + cx[b] + rx[b] * off[b]) * 0.5
      const tz = (cz[a] + rz[a] * off[a] + cz[b] + rz[b] * off[b]) * 0.5
      let o = (tx - cx[m]) * rx[m] + (tz - cz[m]) * rz[m]
      const L = lim[m]
      if (o > L) o = L
      else if (o < -L) o = -L
      off[m] = o
    }
  }
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
 * The Ai's racing line: a smooth apex-cutting offset within +/-(halfWidth - 2 m),
 * found by repeatedly pulling every point toward the midpoint of its neighbours
 * (a stretched string finds the straightest path through the corners). Then a
 * target speed per sample from the line's curvature and banking, with a braking
 * pass backward and an acceleration pass forward so speeds are reachable.
 */
export function makeRacingLine(inp: RacingLineInput): { offset: Float32Array; speed: Float32Array } {
  const S = inp.samples
  const count = S.count
  const ds = S.ds
  const L = inp.length

  // Coarse-to-fine: solve at 16 m spacing, then refine at 4 m.
  let prevOff: Float64Array | null = null
  let prevStride = 0
  for (const strideM of [16, 4]) {
    const stride = Math.max(1, Math.round(strideM / ds))
    const M = Math.floor(count / stride)
    const cx = new Float64Array(M)
    const cz = new Float64Array(M)
    const rx = new Float64Array(M)
    const rz = new Float64Array(M)
    const lim = new Float64Array(M)
    const off = new Float64Array(M)
    for (let m = 0; m < M; m++) {
      const i = m * stride
      cx[m] = S.px[i]
      cz[m] = S.pz[i]
      const rl = Math.hypot(S.rx[i], S.rz[i]) || 1
      rx[m] = S.rx[i] / rl
      rz[m] = S.rz[i] / rl
      const pinned = S.surface[i] !== SURFACE_CODE.road || inRanges(i * ds, inp.pinned, L)
      lim[m] = pinned ? 0 : Math.max(0, S.halfWidth[i] - 2)
      if (prevOff) {
        // Start from the coarse solution.
        const fpos = (i / prevStride) % prevOff.length
        const a = Math.floor(fpos)
        const b = (a + 1) % prevOff.length
        const f = fpos - a
        off[m] = clamp(prevOff[a] + (prevOff[b] - prevOff[a]) * f, -lim[m], lim[m])
      }
    }
    relax(cx, cz, rx, rz, lim, off, strideM === 16 ? 1500 : 600)
    prevOff = off
    prevStride = stride
  }

  const offset = new Float32Array(count)
  const po = prevOff!
  for (let i = 0; i < count; i++) {
    const fpos = i / prevStride
    const a = Math.floor(fpos) % po.length
    const b = (a + 1) % po.length
    const f = fpos - Math.floor(fpos)
    offset[i] = po[a] + (po[b] - po[a]) * f
  }
  circularSmooth(offset, Math.round(3 / ds), 2)
  for (let i = 0; i < count; i++) {
    const pinned = S.surface[i] !== SURFACE_CODE.road || inRanges(i * ds, inp.pinned, L)
    const lim = pinned ? 0 : Math.max(0, S.halfWidth[i] - 2)
    offset[i] = clamp(offset[i], -lim, lim)
  }

  // ---- speeds from the line's curvature ----
  const lx = new Float64Array(count)
  const lz = new Float64Array(count)
  for (let i = 0; i < count; i++) {
    const rl = Math.hypot(S.rx[i], S.rz[i]) || 1
    lx[i] = S.px[i] + (S.rx[i] / rl) * offset[i]
    lz[i] = S.pz[i] + (S.rz[i] / rl) * offset[i]
  }
  const k = new Float32Array(count)
  horizontalCurvature(lx, lz, count, ds, k)
  circularSmooth(k, Math.round(4 / ds), 2)

  const MU = 1.5
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
    const den = c - MU * sn
    const num = sn + MU * c
    const v2 = den <= 0.05 ? VMAX * VMAX : (G / kk) * (num / den)
    speed[i] = Math.min(VMAX, Math.sqrt(Math.max(0, v2)))
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
  // Backward: brake in time (~9 m/s^2). Forward: accelerate realistically (~5 m/s^2). Two laps each so the wrap settles.
  const BRAKE = 9
  const ACCEL = 5
  for (let pass = 0; pass < 2; pass++) {
    for (let n = count * 2 - 1; n >= 0; n--) {
      const i = n % count
      const j = (i + 1) % count
      const lim = Math.sqrt(speed[j] * speed[j] + 2 * BRAKE * ds)
      if (speed[i] > lim) speed[i] = lim
    }
    for (let n = 0; n < count * 2; n++) {
      const i = n % count
      const j = (i + 1) % count
      const lim = Math.sqrt(speed[i] * speed[i] + 2 * ACCEL * ds)
      if (speed[j] > lim) speed[j] = lim
    }
  }
  floorFast()
  return { offset, speed }
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
  seed: number
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
      if (!inp.insideWorld(x, z, 10)) continue
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

/** Billboard spots: set back 25-45 m on the outside of bends, facing the road. */
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

  const minGapS = L / (want * 1.6)
  const taken: number[] = []
  const tryAt = (i: number, side: number): boolean => {
    for (const t of taken) {
      const d = ((((i - t) * S.ds) % L) + L) % L
      if (Math.min(d, L - d) < minGapS) return false
    }
    const rl = Math.hypot(S.rx[i], S.rz[i]) || 1
    const rxh = S.rx[i] / rl
    const rzh = S.rz[i] / rl
    const back = S.halfWidth[i] + 25 + rand() * 20
    const x = S.px[i] + rxh * back * side
    const z = S.pz[i] + rzh * back * side
    if (!inp.insideWorld(x, z, 30)) return false
    if (edgeClearance(S, inp.hash, x, z, 40) < 22) return false
    for (const b of out) if (Math.hypot(b.x - x, b.z - z) < 60) return false
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
  // Then straights, alternating sides, until we have enough.
  let side = 1
  for (let pass = 0; pass < 3 && out.length < want; pass++) {
    for (let k = 0; k < cand.length && out.length < want; k += 1) {
      const i = cand[(k * 7 + pass * 3) % cand.length]
      if (tryAt(i, side)) side = -side
    }
  }
  return out
}
