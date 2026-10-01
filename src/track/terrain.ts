// ============================================================
//  TERRAIN - the ground the road sits on
// ------------------------------------------------------------
//  Two steps, both driven only by the track file:
//
//  1. NATURAL ground (makeNaturalTerrain): rolling hills from seeded
//     noise ('hills') or a level floor ('flat'), plus the file's
//     features (hill, bowl, mesa, bigAir), plus the world edge: a ring
//     of steep mountains ('ridge') that you can see is the end of the
//     world, or nothing extra for a stadium ('wall', whose wall the
//     colliders add).
//
//  2. FLATTENED ground (flattenToRoad): the natural heights on a grid,
//     then cut and filled to meet the road. Under a grounded road the
//     ground hides 0.3-0.6 m below the surface; past the road edge it
//     blends back to natural over a shoulder with a smooth S-curve.
//     Under a lifted road (a bridge) the ground stays natural, but is
//     cut down if it would come within 5 m of the road's underside, so
//     a car can drive underneath.
//
//  The grid layout is the TerrainGrid contract (types.ts): row-major,
//  heights[iz * (n + 1) + ix], x and z from -half to +half.
// ============================================================

import type { ResolvedTrackFile, TerrainFeature } from './schema'
import { SURFACE_CODE, type TerrainGrid, type TrackSamples } from './types'
import { clamp, fbm, makeNoise2D, smoothstep } from './noise'

type Env = ResolvedTrackFile['environment']

/** The natural (un-flattened) ground, as a function plus the edge geometry. */
export interface NaturalTerrain {
  height: (x: number, z: number) => number
  edge: 'ridge' | 'wall'
  size: number
  half: number
  /** Ridge only: rounded-square "radius" where the mountains start rising (smallest anywhere). */
  ridgeFootMin: number
  /** Ridge only: rounded-square radius of the crest at a compass angle (radians, atan2(z, x)). */
  ridgeCrestAt: (theta: number) => number
  /** Ridge only: how tall the mountains are above the base height (away from the sunset notch). */
  ridgeRise: number
  /** Ridge only: the crest height above the base at a compass bearing (degrees), notch included. */
  ridgeRiseAtBearing: (bearingDeg: number) => number
  /** Ridge only: the sunset notch (where the ridge drops so the sun stays visible). */
  notch: { azimuthDeg: number; halfWidthDeg: number; fadeDeg: number; riseFactor: number }
  /** Wall only: radius of the stadium's outer wall circle. */
  wallRadius: number
}

/** The world edge is a rounded square: |x|^8 + |z|^8 = r^8 (square with soft corners). */
export function roundedRadius(x: number, z: number): number {
  const ax = Math.abs(x)
  const az = Math.abs(z)
  const m = ax > az ? ax : az
  if (m < 1e-6) return 0
  const a = ax / m
  const b = az / m
  const a2 = a * a
  const b2 = b * b
  const a8 = a2 * a2 * a2 * a2
  const b8 = b2 * b2 * b2 * b2
  return m * Math.pow(a8 + b8, 0.125)
}

/** Euclidean distance from the centre to the rounded square of "radius" r at angle theta. */
export function roundedToEuclid(r: number, theta: number): number {
  const c = Math.abs(Math.cos(theta))
  const s = Math.abs(Math.sin(theta))
  const c2 = c * c
  const s2 = s * s
  return r / Math.pow(c2 * c2 * c2 * c2 + s2 * s2 * s2 * s2, 0.125)
}

/** Ridge shape across its width (t 0 = foot, 1 = crest): gentle foothills, then a steep face. */
function ridgeShape(t: number): number {
  return 0.3 * smoothstep(0, 0.55, t) + 0.7 * smoothstep(0.55, 1, t)
}

/** Round bump, flat-ish top, smooth all the way down to zero at d = r. */
function bump(d: number, r: number): number {
  if (d >= r) return 0
  const t = d / r
  const k = 1 - t * t
  return k * k
}

/** Anisotropic bell: u along, v across, su/sv how wide each way. */
function bell(u: number, v: number, su: number, sv: number): number {
  return Math.exp(-((u * u) / (2 * su * su) + (v * v) / (2 * sv * sv)))
}

/** How far a feature reaches (beyond this it adds nothing), for a cheap early-out. */
function featureReach(f: TerrainFeature): number {
  if (f.type === 'bigAir') return 330 * (f.scale ?? 1)
  return f.radius
}

/**
 * Height a terrain feature adds at (x, z).
 * bigAir is v1's proven big-air landform made complete: a big round hill you
 * can climb from any side, then a dip that loads the suspension, then a small
 * mountain whose upslope is the launch, in that order along headingDeg.
 * Broad bell curves only, so it is glass-smooth at collider-grid scale.
 */
function featureHeight(f: TerrainFeature, x: number, z: number): number {
  const dx = x - f.x
  const dz = z - f.z
  if (f.type === 'hill') return f.height * bump(Math.hypot(dx, dz), f.radius)
  if (f.type === 'bowl') return -f.depth * bump(Math.hypot(dx, dz), f.radius)
  if (f.type === 'mesa') {
    const t = Math.hypot(dx, dz) / f.radius
    return f.height * (1 - smoothstep(0.55, 1, t))
  }
  // bigAir: heading 0 = north (-z), 90 = east (+x).
  const k = f.scale ?? 1
  const h = (f.headingDeg * Math.PI) / 180
  const ax = Math.sin(h)
  const az = -Math.cos(h)
  const u = dx * ax + dz * az //  along the run
  const v = -dx * az + dz * ax // across it
  return (
    32 * k * bell(u + 70 * k, v, 42 * k, 42 * k) - //  the big hill (round: climb it from any side)
    6 * k * bell(u - 20 * k, v, 20 * k, 34 * k) + //  the dip that loads the launch
    14 * k * bell(u - 80 * k, v, 22 * k, 34 * k) //   the small mountain you fly off
  )
}

/** Builds the natural ground for a track's environment. */
export function makeNaturalTerrain(env: Env): NaturalTerrain {
  const t = env.terrain
  const size = env.size
  const half = size / 2
  const seed = env.seed >>> 0
  const hills = makeNoise2D(seed ^ 0x9e3779b9)
  const ridgeNoise = makeNoise2D(seed ^ 0x85ebca6b)
  const base = t.height
  const relief = t.kind === 'hills' ? t.relief : 0
  const invScale = 1 / Math.max(1, t.scale)
  const features = t.features
  const reach2 = features.map((f) => featureReach(f) ** 2)

  // ---- the ridge: a ring of mountains following the world's rounded-square edge ----
  const edge = t.edge
  const span = clamp(size * 0.15, 170, 300) //   foothills + face, metres
  const crestBase = half - 30 //                 leave a plateau strip before the grid ends
  const footBase = crestBase - span
  // Tall enough to read as the end of the world, low enough not to hide the sky (art direction:
  // nothing over ~110 m).
  const rise = clamp(span * 0.62, 90, 110)
  // THE SUNSET NOTCH. Toward the sun the ridge drops to NOTCH_RISE of its height so the
  // sun and the megacity on the horizon are visible from the whole valley. It stays a
  // containing face by getting steeper, not taller: there the slope is squeezed into
  // NOTCH_SPAN of the usual width.
  const NOTCH_RISE = 0.4
  const NOTCH_SPAN = 0.35
  const NOTCH_HALF_DEG = 40
  const NOTCH_FADE_DEG = 65
  const sunAz = env.sky?.sunAzimuthDeg ?? 0
  /** 1 inside the notch, fading to 0 by NOTCH_FADE_DEG either side of the sun. theta is atan2(z, x). */
  const notchAt = (theta: number): number => {
    // Compass bearing of this direction (0 = north = -z, 90 = east = +x).
    const bearing = (Math.atan2(Math.cos(theta), -Math.sin(theta)) * 180) / Math.PI
    let d = Math.abs(bearing - sunAz) % 360
    if (d > 180) d = 360 - d
    return 1 - smoothstep(NOTCH_HALF_DEG, NOTCH_FADE_DEG, d)
  }
  const BEARINGS = 256
  const footTable = new Float32Array(BEARINGS)
  const crestTable = new Float32Array(BEARINGS)
  let footMin = Infinity
  for (let i = 0; i < BEARINGS; i++) {
    const th = (i / BEARINGS) * Math.PI * 2
    // Seamless round the loop: sample noise on a circle, not on the angle.
    const n1 = fbm(ridgeNoise, Math.cos(th) * 2.2 + 31.7, Math.sin(th) * 2.2 + 31.7, 3)
    const n2 = fbm(ridgeNoise, Math.cos(th) * 5.1 + 7.3, Math.sin(th) * 5.1 + 7.3, 2)
    const foot = footBase + n1 * 28
    const crest = Math.min(crestBase, Math.max(foot + span * 0.75, foot + span + n2 * 18))
    footTable[i] = foot
    crestTable[i] = crest
    if (foot < footMin) footMin = foot
  }
  const tableAt = (table: Float32Array, theta: number): number => {
    const u = ((((theta / (Math.PI * 2)) % 1) + 1) % 1) * BEARINGS
    const i0 = Math.floor(u) % BEARINGS
    const i1 = (i0 + 1) % BEARINGS
    const f = u - Math.floor(u)
    return table[i0] * (1 - f) + table[i1] * f
  }

  const ridgeAt = (x: number, z: number): number => {
    const r = roundedRadius(x, z)
    if (r < footMin) return 0
    const th = Math.atan2(z, x)
    const crest = tableAt(crestTable, th)
    const notch = notchAt(th)
    const riseHere = rise * (1 - (1 - NOTCH_RISE) * notch)
    const foot = crest - (crest - tableAt(footTable, th)) * (1 - (1 - NOTCH_SPAN) * notch)
    if (r <= foot) return 0
    if (r >= crest) {
      // Plateau behind the crest, with a little roll so the skyline is not a ruler line.
      return riseHere + fbm(ridgeNoise, x * 0.006 + 3.1, z * 0.006 - 8.4, 2) * 8 * (1 - 0.6 * notch) * smoothstep(0, 40, r - crest)
    }
    const tt = (r - foot) / (crest - foot)
    // Gullies and buttresses that fade out at both the foot and the crest.
    const gully = fbm(ridgeNoise, x * 0.012 + 50.2, z * 0.012 - 12.7, 3) * 22 * (1 - 0.6 * notch) * Math.sin(Math.PI * tt)
    return riseHere * ridgeShape(tt) + gully
  }

  const height = (x: number, z: number): number => {
    let h = base
    if (relief > 0) h += relief * 0.8 * fbm(hills, x * invScale + 0.37, z * invScale - 0.71, 4)
    for (let i = 0; i < features.length; i++) {
      const f = features[i]
      const dx = x - f.x
      const dz = z - f.z
      if (dx * dx + dz * dz > reach2[i]) continue
      h += featureHeight(f, x, z)
    }
    if (edge === 'ridge') h += ridgeAt(x, z)
    return h
  }

  return {
    height,
    edge,
    size,
    half,
    ridgeFootMin: edge === 'ridge' ? footMin : Infinity,
    ridgeCrestAt: (theta: number) => tableAt(crestTable, theta),
    ridgeRise: edge === 'ridge' ? rise : 0,
    ridgeRiseAtBearing: (bearingDeg: number) => {
      if (edge !== 'ridge') return 0
      const b = (bearingDeg * Math.PI) / 180
      // Compass bearing -> theta = atan2(z, x) with x = sin b, z = -cos b.
      return rise * (1 - (1 - NOTCH_RISE) * notchAt(Math.atan2(-Math.cos(b), Math.sin(b))))
    },
    notch: { azimuthDeg: sunAz, halfWidthDeg: NOTCH_HALF_DEG, fadeDeg: NOTCH_FADE_DEG, riseFactor: NOTCH_RISE },
    wallRadius: half - 25,
  }
}

/** Average natural height over a ~12 m disc: where a control point without y sits. */
export function averagedHeight(nat: NaturalTerrain, x: number, z: number): number {
  let sum = nat.height(x, z) * 2
  let w = 2
  for (let ring = 1; ring <= 2; ring++) {
    const r = ring * 6
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2 + ring * 0.39
      sum += nat.height(x + Math.cos(a) * r, z + Math.sin(a) * r)
      w++
    }
  }
  return sum / w
}

/** The natural heights sampled on the terrain grid (reused by live rebuilds). */
export interface NaturalGrid {
  n: number
  half: number
  cellSize: number
  heights: Float32Array
}

/** Grid cell size we aim for, metres. 3 m keeps physics accurate and the build quick. */
export const TERRAIN_CELL = 3

export function sampleNaturalGrid(nat: NaturalTerrain): NaturalGrid {
  const n = Math.max(16, Math.round(nat.size / TERRAIN_CELL))
  const cellSize = nat.size / n
  const half = nat.half
  const heights = new Float32Array((n + 1) * (n + 1))
  for (let iz = 0; iz <= n; iz++) {
    const z = -half + iz * cellSize
    const row = iz * (n + 1)
    for (let ix = 0; ix <= n; ix++) heights[row + ix] = nat.height(-half + ix * cellSize, z)
  }
  return { n, half, cellSize, heights }
}

// Under a grounded road the ground hides this far below the surface...
const HIDE_DEPTH = 0.6
// ...rising to this far below for the last EDGE_BAND metres before the edge, so the
// ground beside the road is nearly flush with it: driving back on from the grass is
// smooth, with no kerb to bump over.
const EDGE_DEPTH = 0.05
const EDGE_BAND = 2.5

/**
 * How far below the road surface the ground must stay at `lateral` metres from the
 * centre: 0.15 m across the middle, easing to 0.03 m near the edge (where the ground
 * meets the road nearly flush). The safety pass and the checks use this one rule.
 */
export function requiredClearance(lateral: number, halfWidth: number): number {
  return 0.15 + (0.03 - 0.15) * smoothstep(halfWidth - EDGE_BAND - 2, halfWidth - EDGE_BAND, Math.abs(lateral))
}
/** How far (horizontal metres, more than one grid cell) the bank plane runs on past the road edge. */
const BANK_RUNOUT = 4.5
const SHOULDER_MIN = 12
const SHOULDER_MAX = 36
/** A bridge keeps at least this much air between its underside and the ground. */
export const BRIDGE_CLEARANCE = 5

/** Per-sample road info the flattener needs beyond TrackSamples. */
export interface FlattenInput {
  samples: TrackSamples
  /** Slab thickness under each sample (to find a bridge's underside). */
  thickness: Float32Array
}

/**
 * Cut and fill the natural grid to meet the road. Returns the final heights.
 * Works by "splatting": each road sample visits the grid vertices around it and
 * claims the ones it is closest to; then every claimed vertex is shaped by its
 * closest sample's cross-section.
 */
export function flattenToRoad(grid: NaturalGrid, input: FlattenInput): Float32Array {
  const { n, half, cellSize } = grid
  const nat = grid.heights
  const out = new Float32Array(nat)
  const S = input.samples
  const count = S.count
  const vcount = (n + 1) * (n + 1)

  const bestG = new Int32Array(vcount).fill(-1)
  const bestGd = new Float32Array(vcount).fill(Infinity)
  const bestB = new Int32Array(vcount).fill(-1)
  const bestBd = new Float32Array(vcount).fill(Infinity)

  const inv = 1 / cellSize
  for (let i = 0; i < count; i++) {
    // Loops never shape the ground (they sit on the flattened lanes either side): only road does.
    if (S.surface[i] !== SURFACE_CODE.road) continue
    const cx = S.px[i]
    const cz = S.pz[i]
    const grounded = S.grounded[i] === 1
    const reach = S.halfWidth[i] + (grounded ? SHOULDER_MAX : BRIDGE_CLEARANCE + 4)
    const ix0 = Math.max(0, Math.floor((cx - reach + half) * inv))
    const ix1 = Math.min(n, Math.ceil((cx + reach + half) * inv))
    const iz0 = Math.max(0, Math.floor((cz - reach + half) * inv))
    const iz1 = Math.min(n, Math.ceil((cz + reach + half) * inv))
    const r2 = reach * reach
    const bestIdx = grounded ? bestG : bestB
    const bestD = grounded ? bestGd : bestBd
    for (let iz = iz0; iz <= iz1; iz++) {
      const dz = -half + iz * cellSize - cz
      const dz2 = dz * dz
      if (dz2 > r2) continue
      const row = iz * (n + 1)
      for (let ix = ix0; ix <= ix1; ix++) {
        const dx = -half + ix * cellSize - cx
        const d2 = dx * dx + dz2
        if (d2 > r2) continue
        const v = row + ix
        if (d2 < bestD[v]) {
          bestD[v] = d2
          bestIdx[v] = i
        }
      }
    }
  }

  for (let v = 0; v < vcount; v++) {
    const ig = bestG[v]
    const ib = bestB[v]
    if (ig < 0 && ib < 0) continue
    const ix = v % (n + 1)
    const iz = (v - ix) / (n + 1)
    const x = -half + ix * cellSize
    const z = -half + iz * cellSize
    let h = nat[v]

    if (ig >= 0) {
      // Lateral position across the (possibly banked) road surface.
      const rxh = S.rx[ig]
      const rzh = S.rz[ig]
      const rh2 = rxh * rxh + rzh * rzh
      const dx = x - S.px[ig]
      const dz = z - S.pz[ig]
      const lat = rh2 > 1e-4 ? (dx * rxh + dz * rzh) / rh2 : 0
      const hw = S.halfWidth[ig]
      // The bank plane carries on a little past each edge before the shoulder blends
      // back to natural, so on the LOW side of a steep bank the ground beside the
      // edge is lower than the edge too (a flat shoulder there would rise above the
      // road once a grid triangle straddles the edge).
      // (BANK_RUNOUT is a horizontal distance; on a steep bank that is more metres along the slope.)
      const runout = BANK_RUNOUT / Math.sqrt(Math.max(0.09, rh2))
      const latC = clamp(lat, -hw - runout, hw + runout)
      const surfY = S.py[ig] + S.ry[ig] * latC
      const beyond = Math.abs(lat) - hw
      if (beyond <= 0) {
        // Under the road: hidden, rising to just under the lip over the last metre.
        h = surfY - EDGE_DEPTH - (HIDE_DEPTH - EDGE_DEPTH) * (1 - smoothstep(-EDGE_BAND - 2, -EDGE_BAND, beyond))
      } else {
        const target = surfY - EDGE_DEPTH
        // Deep cuts and tall fills get a wider shoulder, so the slope stays a slope.
        const shoulder = clamp(SHOULDER_MIN + 0.6 * Math.abs(h - target), SHOULDER_MIN, SHOULDER_MAX)
        const w = smoothstep(0, shoulder, beyond)
        h = target + (h - target) * w
      }
    }

    if (ib >= 0) {
      // A bridge overhead: keep clear air under its underside.
      const dx = x - S.px[ib]
      const dz = z - S.pz[ib]
      const rxh = S.rx[ib]
      const rzh = S.rz[ib]
      const rh2 = rxh * rxh + rzh * rzh
      const lat = rh2 > 1e-4 ? (dx * rxh + dz * rzh) / rh2 : 0
      const hw = S.halfWidth[ib]
      if (Math.abs(lat) <= hw + 3) {
        const latC = clamp(lat, -hw, hw)
        const under = S.py[ib] + S.ry[ib] * latC - input.thickness[ib]
        const clip = under - BRIDGE_CLEARANCE
        if (h > clip) h = clip
      }
    }
    out[v] = h
  }
  keepUnderRoad(grid, out, S)
  return out
}

/**
 * Safety pass: walk across the road at every sample and, wherever the ground
 * (as interpolated on the grid's triangles) comes closer to the surface than
 * requiredClearance(), lower that cell's corners until it doesn't. Steep banks on tight
 * curves can otherwise leave a grid triangle poking up at the low edge.
 */
function keepUnderRoad(grid: NaturalGrid, h: Float32Array, S: TrackSamples): void {
  const { n, half, cellSize } = grid
  const g = { n, half, cellSize, heights: h }
  const inv = 1 / cellSize
  for (let pass = 0; pass < 6; pass++) {
    let fixed = 0
    for (let i = 0; i < S.count; i++) {
      if (S.surface[i] !== SURFACE_CODE.road || S.grounded[i] !== 1) continue
      const hw = S.halfWidth[i]
      const steps = Math.ceil((hw * 2) / 0.75)
      for (let k = 0; k <= steps; k++) {
        const l = -hw + (2 * hw * k) / steps
        const x = S.px[i] + S.rx[i] * l
        const y = S.py[i] + S.ry[i] * l
        const z = S.pz[i] + S.rz[i] * l
        const excess = gridHeight(g, x, z) - (y - requiredClearance(l, hw))
        if (excess <= 0) continue
        const ix = Math.min(n - 1, Math.max(0, Math.floor((x + half) * inv)))
        const iz = Math.min(n - 1, Math.max(0, Math.floor((z + half) * inv)))
        const a = iz * (n + 1) + ix
        const drop = excess + 0.02
        // Lower the corners that lie under the road; the ones outside the edge stay put
        // (lowering them would dig a step beside the road). If none is under it, lower all.
        const corners = [a, a + 1, a + n + 1, a + n + 2]
        let lowered = 0
        for (const v of corners) {
          const vx = -half + (v % (n + 1)) * cellSize - S.px[i]
          const vz = -half + Math.floor(v / (n + 1)) * cellSize - S.pz[i]
          const rh2 = S.rx[i] * S.rx[i] + S.rz[i] * S.rz[i]
          const lat = rh2 > 1e-4 ? (vx * S.rx[i] + vz * S.rz[i]) / rh2 : 0
          if (Math.abs(lat) <= hw) {
            h[v] -= drop
            lowered++
          }
        }
        if (lowered === 0) for (const v of corners) h[v] -= drop
        fixed++
      }
    }
    if (fixed === 0) break
  }
}

/**
 * Height on a row-major grid, interpolated across the same two triangles per
 * cell that the physics uses (terrainTiles.ts): each cell is split along the
 * diagonal from (ix + 1, iz) to (ix, iz + 1). Clamps outside the grid.
 */
export function gridHeight(g: { n: number; half: number; cellSize: number; heights: Float32Array }, x: number, z: number): number {
  const n = g.n
  let fx = (x + g.half) / g.cellSize
  let fz = (z + g.half) / g.cellSize
  if (fx < 0) fx = 0
  else if (fx > n) fx = n
  if (fz < 0) fz = 0
  else if (fz > n) fz = n
  let ix = Math.floor(fx)
  let iz = Math.floor(fz)
  if (ix >= n) ix = n - 1
  if (iz >= n) iz = n - 1
  const tx = fx - ix
  const tz = fz - iz
  const h = g.heights
  const a = iz * (n + 1) + ix
  const ha = h[a]
  const hb = h[a + 1]
  const hc = h[a + n + 1]
  if (tx + tz <= 1) return ha + (hb - ha) * tx + (hc - ha) * tz
  const hd = h[a + n + 2]
  return hd + (hc - hd) * (1 - tx) + (hb - hd) * (1 - tz)
}

/** Min and max of a height array. */
export function heightRange(h: Float32Array): { min: number; max: number } {
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i < h.length; i++) {
    const v = h[i]
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  return { min: lo, max: hi }
}

export function makeTerrainGrid(grid: NaturalGrid, heights: Float32Array): TerrainGrid {
  const r = heightRange(heights)
  return { n: grid.n, half: grid.half, cellSize: grid.cellSize, heights, minHeight: r.min, maxHeight: r.max }
}
