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
import { BARRIER_BELOW, BARRIER_DEPTH, barrierAxes, type BarrierAxes } from './ribbon'

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
  if (f.type === 'bigAir') return BIGAIR_REACH * (f.scale ?? 1)
  return f.radius
}

/**
 * A 1D shape built from its SLOPE, not its height: each segment's slope changes
 * linearly (constant curvature) over its length. Building a crest this way pins its
 * vertical radius exactly, and the vertical radius is what decides whether a car
 * stays on the ground over it (it goes light above sqrt(g x radius)).
 * Returns a height table sampled every TABLE_STEP metres.
 */
const TABLE_STEP = 0.25
function slopeProfile(segments: [length: number, slopeFrom: number, slopeTo: number][]): Float32Array {
  const total = segments.reduce((a, s) => a + s[0], 0)
  const n = Math.ceil(total / TABLE_STEP) + 1
  const out = new Float32Array(n)
  let h = 0
  let seg = 0
  let segStart = 0
  for (let i = 1; i < n; i++) {
    const w = (i - 0.5) * TABLE_STEP
    while (seg < segments.length - 1 && w > segStart + segments[seg][0]) segStart += segments[seg++][0]
    const [len, g0, g1] = segments[seg]
    const f = Math.min(1, Math.max(0, (w - segStart) / len))
    h += (g0 + (g1 - g0) * f) * TABLE_STEP
    out[i] = h
  }
  return out
}
function tableAt(t: Float32Array, w: number): number {
  if (w <= 0) return t[0]
  const f = w / TABLE_STEP
  const i = Math.floor(f)
  if (i >= t.length - 1) return t[t.length - 1]
  return t[i] + (t[i + 1] - t[i]) * (f - i)
}

// ---- the big-air run, at scale 1 (every length and height multiplies by `scale`) ----
//
// Nathan's spec: "a big natural hill you can climb from any side, a dip, then a small
// mountain to launch off". The first version used plain bell curves, and the big
// hill's own crest (a 55 m vertical radius) launched cars at ~100 km/h straight into
// the small mountain's face, skipping the dip and the launch. So each part is now
// shaped by its curvature:
//
//  big hill   round, 32 m tall, 158 m in radius. Its whole top is a dome with a
//             300 m vertical radius: a car crossing its top at up to ~180 km/h stays
//             planted all the way down the dome (it speeds up as it drops, so the
//             dome is wider than the top speed alone would need). Then a steady 0.35
//             slope (19 degrees, climbable) and an 80 m-radius foot.
//  dip        a shallow 3 m hollow between the two, so the car settles.
//  kicker     12 m tall: a concave run-up (60 m radius) steepening to a 0.5 slope,
//             a tight 30 m-radius crest that launches anything over ~62 km/h, and the
//             ground falling away behind it (0.45 slope, easing out over 80 m) into
//             open landing ground.
const BIG_R = 158 //        big hill radius
const BIG_U = -72 //        big hill centre, along the run
const BIG_H = 32
const DIP_U = 104
const KICK_U = 125 //       where the kicker's run-up starts
const KICK_HALF = 20 //     full height across +/- this...
const KICK_FADE = 25 //     ...fading to nothing over this much more
/** Big hill: height drop from its top, by distance from its centre. */
const BIG_DROP = slopeProfile([
  [105, 0, 0.35], // dome: slope grows at 1/300 per metre (300 m vertical radius)
  [24.8, 0.35, 0.35], // steady side
  [28, 0.35, 0], //  foot: 80 m radius
])
/** Kicker: height along the run from the foot of its run-up. */
const KICK = slopeProfile([
  [30, 0, 0.5], //    run-up, 60 m radius
  [1.5, 0.5, 0.5],
  [28.5, 0.5, -0.45], // the launch crest, 30 m radius
  [2, -0.45, -0.45],
  [36, -0.45, 0], //  falling away, then easing out (80 m radius)
])
const KICK_LEN = (KICK.length - 1) * TABLE_STEP
/** Distance from the feature's centre beyond which a bigAir adds nothing (scale 1). */
const BIGAIR_REACH = Math.max(-BIG_U + BIG_R, KICK_U + KICK_LEN) + 10

function bigAirHeight(u: number, v: number, k: number): number {
  let h = 0
  // Big hill (round).
  const r = Math.hypot(u - BIG_U * k, v) / k
  if (r < BIG_R) h += (BIG_H - tableAt(BIG_DROP, r)) * k
  // Dip.
  h -= 3 * k * bell(u - DIP_U * k, v, 15 * k, 35 * k)
  // Kicker (a ridge across the run).
  const w = u / k - KICK_U
  const av = Math.abs(v) / k
  if (w > 0 && w < KICK_LEN && av < KICK_HALF + KICK_FADE) {
    const across = av <= KICK_HALF ? 1 : (1 + Math.cos((Math.PI * (av - KICK_HALF)) / KICK_FADE)) / 2
    h += tableAt(KICK, w) * k * across
  }
  return h
}

/** 0..1: how much a big-air run calms the rolling hills at an offset from its centre. */
function bigAirCalm(f: TerrainFeature & { type: 'bigAir' }, dx: number, dz: number): number {
  const k = f.scale ?? 1
  const h = (f.headingDeg * Math.PI) / 180
  const ax = Math.sin(h)
  const az = -Math.cos(h)
  const u = (dx * ax + dz * az) / k
  const v = (-dx * az + dz * ax) / k
  const FADE = 50
  const hill = 1 - smoothstep(BIG_R, BIG_R + FADE, Math.hypot(u - BIG_U, v))
  // The dip, the kicker and its landing ground.
  const along = Math.max(BIG_U - u, u - (KICK_U + KICK_LEN + 60), 0)
  const across = Math.max(Math.abs(v) - (KICK_HALF + KICK_FADE), 0)
  const lane = u > BIG_U ? 1 - smoothstep(0, FADE, Math.hypot(along, across)) : 0
  return Math.max(hill, lane)
}

/** Height a terrain feature adds at (x, z). */
function featureHeight(f: TerrainFeature, x: number, z: number): number {
  const dx = x - f.x
  const dz = z - f.z
  if (f.type === 'hill') return f.height * bump(Math.hypot(dx, dz), f.radius)
  if (f.type === 'bowl') return -f.depth * bump(Math.hypot(dx, dz), f.radius)
  if (f.type === 'mesa') {
    const t = Math.hypot(dx, dz) / f.radius
    return f.height * (1 - smoothstep(0.55, 1, t))
  }
  // bigAir: heading 0 = north (-z), 90 = east (+x). u runs along the run, v across it.
  const k = f.scale ?? 1
  const h = (f.headingDeg * Math.PI) / 180
  const ax = Math.sin(h)
  const az = -Math.cos(h)
  const u = dx * ax + dz * az
  const v = -dx * az + dz * ax
  return bigAirHeight(u, v, k)
}

/** The big-air run's key points along its heading (scale 1), for tests and docs. */
export const BIGAIR_LAYOUT = {
  bigHillU: BIG_U,
  bigHillRadius: BIG_R,
  bigHillCrestRadius: 300,
  dipU: DIP_U,
  kickerFootU: KICK_U,
  kickerCrestU: KICK_U + 30 + 1.5 + 28.5 * (0.5 / 0.95),
  kickerCrestRadius: 30,
  kickerEndU: KICK_U + KICK_LEN,
  reach: BIGAIR_REACH,
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
    let feat = 0
    // A big-air run is a designed shape: the rolling hills fade out under it, or their
    // own bumps would add crests that launch the car before the kicker.
    let calm = 0
    for (let i = 0; i < features.length; i++) {
      const f = features[i]
      const dx = x - f.x
      const dz = z - f.z
      if (dx * dx + dz * dz > reach2[i]) continue
      feat += featureHeight(f, x, z)
      if (f.type === 'bigAir') calm = Math.max(calm, bigAirCalm(f, dx, dz))
    }
    if (relief > 0) h += relief * 0.8 * fbm(hills, x * invScale + 0.37, z * invScale - 0.71, 4) * (1 - calm)
    h += feat
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
/**
 * ...growing to that over this many metres from where the road leaves the ground, so the
 * embankment tapers in under the bridge's first metres rather than ending in a sheer
 * drop just under the road (a wall of ground right under the deck at the join).
 */
const BRIDGE_TAPER = 10

/** Per-sample road info the flattener needs beyond TrackSamples. */
export interface FlattenInput {
  samples: TrackSamples
  /** Slab thickness under each sample (to find a bridge's underside). */
  thickness: Float32Array
  /** Stadium barriers along both edges (road.barriers = 'walls'), this tall. 0 = none. */
  barrierHeight: number
}

/** The cut-and-filled ground, plus where the physics ground isn't needed. */
export interface FlattenResult {
  heights: Float32Array
  /**
   * Per grid vertex, 1 where it sits inside something solid of the road: under a
   * grounded road's deck, or inside a stadium barrier's box. A ground triangle whose
   * three corners are all covered can't be reached by a car, so the physics leaves it
   * out (terrainTiles.ts): the closed road slab and the barrier boxes contain the car
   * there, and ground a few centimetres under the deck only gives the car's body
   * something to catch on through the road (hyper-1 D4: soft CCD contacts with tilted
   * ground facets under a 60 degree bank).
   */
  covered: Uint8Array
}

/** On a road with barriers, how far (across, flat metres) from an edge the ground under the road comes up to meet it. */
const EDGE_REACH = 4.5
/**
 * Under a road with barriers the ground hides this far below the deck (vertical metres,
 * along the road's up), right to both edges: nobody drives back on from the grass past
 * a barrier, so the ground needn't rise to meet the lip from below.
 */
const WALLED_HIDE = 1.5
/** A vertex this close (metres) to the edge of the deck or of a barrier box doesn't count as covered (curves, rounding). */
const COVER_MARGIN = 0.25

/**
 * Cut and fill the natural grid to meet the road. Returns the final heights.
 * Works by "splatting": each road sample visits the grid vertices around it and
 * claims the ones it is closest to; then every claimed vertex is shaped by its
 * closest sample's cross-section.
 */
export function flattenToRoad(grid: NaturalGrid, input: FlattenInput): FlattenResult {
  const { n, half, cellSize } = grid
  const nat = grid.heights
  const out = new Float32Array(nat)
  const S = input.samples
  const walls = input.barrierHeight > 0
  const cover = new Uint8Array((n + 1) * (n + 1))
  const ax: BarrierAxes = { dx: 0, dy: 0, dz: 0, ox: 0, oy: 0, oz: 0 }
  const count = S.count
  const vcount = (n + 1) * (n + 1)

  const bestG = new Int32Array(vcount).fill(-1)
  const bestGd = new Float32Array(vcount).fill(Infinity)
  const bestB = new Int32Array(vcount).fill(-1)
  const bestBd = new Float32Array(vcount).fill(Infinity)

  // For each raised (not grounded) road sample: metres along the road to the nearest grounded one.
  const toGround = new Float32Array(count).fill(Infinity)
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 0; k < 2 * count; k++) {
      const i = pass === 0 ? k % count : (2 * count - 1 - k) % count
      const prev = pass === 0 ? (i - 1 + count) % count : (i + 1) % count
      if (S.grounded[i] === 1 && S.surface[i] === SURFACE_CODE.road) toGround[i] = 0
      else toGround[i] = Math.min(toGround[i], toGround[prev] + S.ds)
    }
  }

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
    // Under a grounded road's deck (nothing can pass under it, so a bridge's clearance cut must not dig here).
    let underDeck = false

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
      // A road with barriers doesn't: there the runout dug a ditch behind the low
      // barrier (1-2 m deep at 60 degrees, hyper-1 D3). Instead the ground near the low
      // edge, under the road and beyond it, stays level with that edge (below).
      const runout = walls ? 0 : BANK_RUNOUT / Math.sqrt(Math.max(0.09, rh2))
      const latC = clamp(lat, -hw - runout, hw + runout)
      const surfY = S.py[ig] + S.ry[ig] * latC
      const beyond = Math.abs(lat) - hw
      if (beyond <= 0) {
        underDeck = Math.abs(dx * S.tx[ig] + dz * S.tz[ig]) <= S.ds
        if (walls) {
          // Under a road with barriers: well hidden (along the road's up, so a steep
          // bank's deck isn't skimmed by the ground under it)...
          h = surfY - WALLED_HIDE / Math.max(0.3, S.uy[ig])
          // ...except within EDGE_REACH of an edge, where it sits just under the lower of
          // that edge and the deck above it. By the LOW edge of a bank (the deck rises
          // away from it) that is a level floor at the edge's own height, which the
          // ground beyond the edge carries on: no ditch behind the barrier, and no grid
          // triangle reaching from under the deck to beyond the edge can poke up through
          // the road. By the HIGH edge it hugs the deck, which the barrier's face leans over.
          for (const side of [-1, 1]) {
            const fromEdge = (hw - side * lat) * Math.sqrt(rh2)
            if (fromEdge >= EDGE_REACH) continue
            const edgeY = S.py[ig] + S.ry[ig] * side * hw
            h = Math.min(edgeY, S.py[ig] + S.ry[ig] * lat) - EDGE_DEPTH
          }
        } else {
          // Under the road: hidden, rising to just under the lip over the last metre
          // (so driving back on from the grass is smooth).
          h = surfY - EDGE_DEPTH - (HIDE_DEPTH - EDGE_DEPTH) * (1 - smoothstep(-EDGE_BAND - 2, -EDGE_BAND, beyond))
        }
        // Under the deck. (Right to the edge on a road with barriers: their boxes cover beyond it.)
        if (Math.abs(lat) <= hw - (walls ? 0 : COVER_MARGIN) && Math.abs(dx * S.tx[ig] + dz * S.tz[ig]) <= S.ds) cover[v] = 1
      } else {
        const target = surfY - EDGE_DEPTH
        // Deep cuts and tall fills get a wider shoulder, so the slope stays a slope.
        // (On a road with barriers it is measured flat, so a steep bank's cut slope is no
        // steeper than a flat road's, and starts EDGE_REACH metres out: the ground stays level
        // with the edge under the barrier's foot, inside its box.)
        const shoulder = clamp(SHOULDER_MIN + 0.6 * Math.abs(h - target), SHOULDER_MIN, SHOULDER_MAX)
        const w = smoothstep(0, shoulder, walls ? Math.max(0, beyond * Math.sqrt(rh2) - EDGE_REACH) : beyond)
        h = target + (h - target) * w
      }
      if (walls && beyond > 0 && cover[v] === 0) {
        // Inside this side's barrier box? (Same box as colliders.ts builds.)
        const side = lat < 0 ? -1 : 1
        barrierAxes(S, ig, side, ax)
        const ex = x - (S.px[ig] + S.rx[ig] * side * hw)
        const ey = h - (S.py[ig] + S.ry[ig] * side * hw)
        const ez = z - (S.pz[ig] + S.rz[ig] * side * hw)
        const out = ex * ax.ox + ey * ax.oy + ez * ax.oz
        const up = ex * ax.dx + ey * ax.dy + ez * ax.dz
        const along = Math.abs(ex * S.tx[ig] + ey * S.ty[ig] + ez * S.tz[ig])
        // (The box is convex, so a triangle whose corners are all inside it is inside it too; a
        // small margin at its top face is enough, and lets the ground under a leaning low barrier count.)
        if (out <= BARRIER_DEPTH - COVER_MARGIN && up >= -input.thickness[ig] - BARRIER_BELOW + COVER_MARGIN && up <= input.barrierHeight - 0.1 && along <= S.ds) cover[v] = 1
      }
    }

    if (ib >= 0 && !underDeck) {
      // A bridge overhead: keep clear air under its underside. Only under (or just
      // beside) the bridge itself: not under a grounded road's own deck, and not
      // beside the grounded road just before a bridge starts. (Measured only across the
      // road, this cut used to carve a 6 m cliff off the edge of the grounded road
      // where it rises into a bridge, and dig a pit under its deck, whose walls then
      // sat steeply tilted just under the road's edge.)
      const dx = x - S.px[ib]
      const dz = z - S.pz[ib]
      const rxh = S.rx[ib]
      const rzh = S.rz[ib]
      const rh2 = rxh * rxh + rzh * rzh
      const lat = rh2 > 1e-4 ? (dx * rxh + dz * rzh) / rh2 : 0
      const hw = S.halfWidth[ib]
      const along = Math.abs(dx * S.tx[ib] + dz * S.tz[ib])
      if (Math.abs(lat) <= hw + 3 && along <= S.ds) {
        const latC = clamp(lat, -hw, hw)
        const under = S.py[ib] + S.ry[ib] * latC - input.thickness[ib]
        const clip = under - BRIDGE_CLEARANCE * smoothstep(0, BRIDGE_TAPER, toGround[ib])
        if (h > clip) h = clip
      }
    }
    out[v] = h
  }
  keepUnderRoad(grid, out, S)
  return { heights: out, covered: cover }
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
        // Still poking up after a few passes (the road edge cuts the cell awkwardly): lower the whole cell.
        if (lowered === 0 || pass >= 3) for (const v of corners) h[v] -= lowered === 0 ? drop : drop * 0.5
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
