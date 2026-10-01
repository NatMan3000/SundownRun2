// ============================================================
//  STADIUM LAYOUT - where the grandstands stand
// ------------------------------------------------------------
//  Shared by the stadium (to build it), the sky (so the sun sits
//  on top of the stands at sundown, not behind them) and the city
//  (so the skyline rises above the stands). Pure numbers, no
//  scene objects.
// ============================================================

import type { TrackRuntime } from '../track/types'

/** Gap from the road edge to the stand front: the apron where billboards stand, metres. */
export const APRON = 52
/** Height of the front wall (the first tier), metres. */
export const FRONT_H = 3
/** How far the seating slope reaches back, metres. */
export const DEPTH = 42
/** Spacing of the stand sections along the road, metres. */
export const SECTION = 4
/** The canopy's highest point above the top tier, metres. */
export const CANOPY_RISE = 9

export interface StandLine {
  /** Stand front positions (ground) and outward directions, one per section. */
  fx: Float32Array
  fz: Float32Array
  ox: Float32Array
  oz: Float32Array
  ground: Float32Array
  count: number
  height: number
}

/** Where the stands go: one section every SECTION metres, on the outside of the loop. */
export function standLine(track: TrackRuntime): StandLine {
  const S = track.samples
  const step = Math.max(1, Math.round(SECTION / S.ds))
  const count = Math.floor(S.count / step)
  // The middle of the loop, to tell outside from inside.
  let cx = 0
  let cz = 0
  for (let i = 0; i < S.count; i++) {
    cx += S.px[i]
    cz += S.pz[i]
  }
  cx /= S.count
  cz /= S.count
  const fx = new Float32Array(count)
  const fz = new Float32Array(count)
  const ox = new Float32Array(count)
  const oz = new Float32Array(count)
  const ground = new Float32Array(count)
  for (let k = 0; k < count; k++) {
    const i = k * step
    const rl = Math.hypot(S.rx[i], S.rz[i]) || 1
    let rx = S.rx[i] / rl
    let rz = S.rz[i] / rl
    if (rx * (S.px[i] - cx) + rz * (S.pz[i] - cz) < 0) {
      rx = -rx
      rz = -rz
    }
    const d = S.halfWidth[i] + APRON
    fx[k] = S.px[i] + rx * d
    fz[k] = S.pz[i] + rz * d
    ox[k] = rx
    oz[k] = rz
    ground[k] = track.terrainHeight(fx[k], fz[k])
  }
  const spec = track.file.environment.stadium
  const height = Math.max(8, spec?.standsHeight ?? 28)
  return { fx, fz, ox, oz, ground, count, height }
}

const DEG = Math.PI / 180
const skylineCache = new WeakMap<TrackRuntime, Float32Array>()

/**
 * How high the stands (canopy included) stand above eye level in the middle of
 * the world, per compass degree (0..359), degrees. All zero without a stadium.
 */
export function standsSkyline(track: TrackRuntime): Float32Array {
  const cached = skylineCache.get(track)
  if (cached) return cached
  const bins = new Float32Array(360)
  if (track.file.environment.stadium) {
    const line = standLine(track)
    const eye = track.terrainHeight(0, 0) + 3
    for (let k = 0; k < line.count; k++) {
      const x = line.fx[k] + line.ox[k] * DEPTH
      const z = line.fz[k] + line.oz[k] * DEPTH
      const d = Math.hypot(x, z)
      if (d < 1) continue
      const el = Math.atan2(line.ground[k] + line.height + CANOPY_RISE - eye, d) / DEG
      const az = Math.atan2(x, -z) / DEG
      // Spread each point over the degrees it covers.
      for (let o = -1; o <= 1; o++) {
        const b = ((Math.round(az) + o) % 360 + 360) % 360
        if (el > bins[b]) bins[b] = el
      }
    }
  }
  skylineCache.set(track, bins)
  return bins
}

/** The stands' skyline toward an azimuth (radians), degrees. */
export function standsSkylineAt(track: TrackRuntime, azimuth: number): number {
  const bins = standsSkyline(track)
  const b = ((Math.round(azimuth / DEG) % 360) + 360) % 360
  return bins[b]
}
