// ============================================================
//  SKY MODEL - turns the time of day into colours and directions
// ------------------------------------------------------------
//  One function, updateSky(), runs at the start of every frame.
//  It reads the world clock (clock.ts) and works out:
//
//    - the sky colours (zenith, mid, horizon on the sun side and on
//      the side away from the sun), blended from the sundown palette
//      to the night palette;
//    - where the sun is (it sinks below the horizon by time 0.45)
//      and how strong its afterglow still is;
//    - the key light (warm sun at sundown turning into cool
//      planet-light at night) and the hemisphere fill light;
//    - how far night has come (stars, planet, windows, headlights).
//
//  It writes the shared `environment` object (core/telemetry.ts) for
//  the other systems, and the shared shader uniforms below, which
//  every world shader (sky dome, terrain haze, ridges, city) points
//  at - so they all agree on the colour of the sky they fade into.
//
//  All colours come from core/palette.ts. Mixing two palette colours
//  is fine; inventing a new hex code is not.
// ============================================================

import * as THREE from 'three'
import { PALETTE } from '../core/palette'
import { environment } from '../core/telemetry'
import type { TrackRuntime } from '../track/types'
import { worldClock } from './clock'

const DEG = Math.PI / 180

/** The synthwave sun's angular radius, degrees. Big on purpose: it is the hero of the sky. */
export const SUN_RADIUS_DEG = 12
/** By this time of day the whole disc has sunk below the horizon. */
const SUN_GONE_AT = 0.45

function smoothstep(a: number, b: number, x: number): number {
  const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a)
  return t * t * (3 - 2 * t)
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

// ---------------------------------------------------------------- palette (linear colours)

const C = {
  zenithDusk: new THREE.Color(PALETTE.skyZenithDusk),
  midDusk: new THREE.Color(PALETTE.skyMidDusk),
  horizonDusk: new THREE.Color(PALETTE.skyHorizonDusk),
  sunGlow: new THREE.Color(PALETTE.skySunGlow),
  zenithNight: new THREE.Color(PALETTE.skyZenithNight),
  midNight: new THREE.Color(PALETTE.skyMidNight),
  horizonNight: new THREE.Color(PALETTE.skyHorizonNight),
  sunTop: new THREE.Color(PALETTE.sunTop),
  sunMid: new THREE.Color(PALETTE.sunMid),
  sunBottom: new THREE.Color(PALETTE.sunBottom),
  planetRing: new THREE.Color(PALETTE.planetRing),
  ground: new THREE.Color(PALETTE.ground),
  groundSheen: new THREE.Color(PALETTE.groundSheen),
  haze: new THREE.Color(PALETTE.haze),
  windowWarm: new THREE.Color(PALETTE.cityWindowWarm),
}

/**
 * The side of the sky facing away from the sun stays violet (constitution:
 * warm only near the sun). At sundown it is the mid-sky violet lifted a
 * little toward the horizon pink; at night it is the night horizon.
 */
const ANTI_DUSK = C.midDusk.clone().lerp(C.horizonDusk, 0.22)

// ---------------------------------------------------------------- shared shader uniforms

/**
 * Uniforms every world shader shares. Materials reference these exact
 * objects, so updating them once per frame updates every shader.
 */
export const skyUniforms = {
  uSunDir: { value: new THREE.Vector3(0, 0, -1) },
  uSkyZenith: { value: new THREE.Color() },
  uSkyMid: { value: new THREE.Color() },
  uSkyHorizon: { value: new THREE.Color() },
  uSkyHorizonAnti: { value: new THREE.Color() },
  /** Warm glow around the sun, already scaled by how much afterglow is left. */
  uSkySunGlow: { value: new THREE.Color() },
  uSkyHaze: { value: new THREE.Color() },
  /** The pink band opposite the sunset, the world's shadow under it, and how strong both are. */
  uSkyBelt: { value: new THREE.Color() },
  uSkyEarthShadow: { value: new THREE.Color() },
  uSkyBeltAmt: { value: 1 },
  /** Direction (xz) and half-width (cosine) of the city's glow on the horizon at night. */
  uCityDir: { value: new THREE.Vector2(0, -1) },
  uCityCos: { value: 0.5 },
  uCityGlow: { value: new THREE.Color() },
  /** Cloud streak colours: backlit (sun side) and shadowed. */
  uCloudLit: { value: new THREE.Color() },
  uCloudDark: { value: new THREE.Color() },
  /** 1 while the sun disc is above the horizon, fading as the last of it sinks. */
  uSunVisible: { value: 1 },
  /** Seconds since the world mounted (animation). */
  uTime: { value: 0 },
}

// ---------------------------------------------------------------- per-frame state

/** Everything the world's parts need about the sky this frame. Mutated in place. */
export const sky = {
  time: 0.12,
  /** Sun centre elevation above the horizon, degrees (negative once it sinks). */
  sunElevationDeg: 0,
  /** 1 while any of the disc is above the horizon, fading to 0 as the last of it goes. */
  sunVisible: 1,
  /** 0..1 how much warm afterglow is left on the sun side (gone by 0.7). */
  afterglow: 1,
  night: 0,
  headlights: 0,
  /** 0..1 stars and planet (fade in from 0.3). */
  nightSky: 0,
  /** 0..1 how far the city windows have come on (0.2 -> 0.9). */
  windows: 0,
  /** 0..1 shadow strength (the sun casts shadows only while it is up). */
  shadow: 1,

  sunDir: new THREE.Vector3(0, 0, -1),
  /** Horizontal right and up axes of the sun disc (for drawing it). */
  sunRight: new THREE.Vector3(1, 0, 0),
  sunUp: new THREE.Vector3(0, 1, 0),

  keyDir: new THREE.Vector3(0, 0.3, -1),
  keyColor: new THREE.Color(),
  keyIntensity: 3,
  hemiSky: new THREE.Color(),
  hemiGround: new THREE.Color(),
  hemiIntensity: 0.6,
  fogColor: new THREE.Color(),

  /**
   * How high the skyline stands in the sun's direction, degrees, as seen from
   * the middle of the world. The sun sits ON the skyline at sundown (its lower
   * half hidden behind it), so ridges at the world's edge never swallow it.
   */
  skylineDeg: 0,
  /** Track-fixed directions (radians), set by configureSky(). */
  sunAzimuth: 0,
  planetAzimuth: 40 * DEG,
  planetElevation: 28 * DEG,
  cityAzimuth: 0,
  cityArc: 120 * DEG,
  hasCity: true,
  /** The track's haze accent (palette override). */
  haze: C.haze.clone(),
}

/** Unit vector for a compass azimuth (0 = north / -z, 90 = east / +x) and elevation, radians. */
export function dirFromAzEl(az: number, el: number, out: THREE.Vector3): THREE.Vector3 {
  const c = Math.cos(el)
  return out.set(c * Math.sin(az), Math.sin(el), -c * Math.cos(az))
}

/** Read the track's sky settings (sun and planet placement, city, haze accent). */
export function configureSky(track: TrackRuntime): void {
  const env = track.file.environment
  sky.sunAzimuth = (env.sky.sunAzimuthDeg ?? 0) * DEG
  sky.planetAzimuth = (env.sky.planetAzimuthDeg ?? (env.sky.sunAzimuthDeg ?? 0) + 40) * DEG
  sky.planetElevation = (env.sky.planetElevationDeg ?? 28) * DEG
  const city = env.city
  sky.hasCity = !!city
  sky.cityAzimuth = city ? (city.azimuthDeg ?? env.sky.sunAzimuthDeg ?? 0) * DEG : sky.sunAzimuth
  sky.cityArc = city ? (city.arcDeg ?? 120) * DEG : 0
  const hazeHex = env.palette?.haze
  sky.haze.set(typeof hazeHex === 'string' && hazeHex.length > 0 ? hazeHex : PALETTE.haze)
  sky.skylineDeg = skylineElevationDeg(track, sky.sunAzimuth)
}

/**
 * The skyline's height toward an azimuth: the steepest angle up to the
 * terrain, looked at from eye height in the middle of the world. Averaged
 * over the width of the sun so one spiky peak does not decide it.
 */
function skylineElevationDeg(track: TrackRuntime, azimuth: number): number {
  const half = track.terrain.half
  const step = Math.max(2, track.terrain.cellSize)
  const eye = track.terrainHeight(0, 0) + 3
  let total = 0
  const offsets = [-8, -4, 0, 4, 8]
  for (const o of offsets) {
    const az = azimuth + o * DEG
    const sx = Math.sin(az)
    const sz = -Math.cos(az)
    let best = 0
    for (let d = 40; d < half * 1.42; d += step) {
      const x = sx * d
      const z = sz * d
      if (Math.abs(x) > half || Math.abs(z) > half) break
      const el = Math.atan2(track.terrainHeight(x, z) - eye, d)
      if (el > best) best = el
    }
    total += best
  }
  const deg = total / offsets.length / DEG
  return Math.min(16, Math.max(0, deg))
}

// scratch (module-level: no allocation per frame)
const _a = new THREE.Vector3()
const _b = new THREE.Vector3()
const _up = new THREE.Vector3(0, 1, 0)
const _col = new THREE.Color()
const _warmKey = new THREE.Color()

/** Work out this frame's sky from the clock and publish it. Call once per frame, first. */
export function updateSky(elapsed: number): void {
  const t = worldClock.time
  sky.time = t

  // ---- the sun: centre on the skyline at 0, the whole disc gone by SUN_GONE_AT ----
  const sinkDeg = SUN_RADIUS_DEG + sky.skylineDeg + 1.5
  sky.sunElevationDeg = sky.skylineDeg - (t / SUN_GONE_AT) * sinkDeg
  sky.sunVisible = 1 - smoothstep(SUN_GONE_AT - 0.04, SUN_GONE_AT, t)
  sky.afterglow = 1 - smoothstep(0.3, 0.7, t)
  dirFromAzEl(sky.sunAzimuth, sky.sunElevationDeg * DEG, sky.sunDir)
  sky.sunRight.crossVectors(sky.sunDir, _up).normalize()
  sky.sunUp.crossVectors(sky.sunRight, sky.sunDir).normalize()

  // ---- how far night has come ----
  sky.night = smoothstep(0.25, 0.85, t)
  sky.headlights = smoothstep(0.35, 0.6, t)
  sky.nightSky = smoothstep(0.3, 0.7, t)
  sky.windows = smoothstep(0.2, 0.9, t)
  sky.shadow = 1 - smoothstep(0.25, 0.42, t)

  // ---- sky colours ----
  const b = smoothstep(0.06, 0.82, t)
  const u = skyUniforms
  u.uSkyZenith.value.copy(C.zenithDusk).lerp(C.zenithNight, b)
  u.uSkyMid.value.copy(C.midDusk).lerp(C.midNight, b)
  // The sun-side horizon holds its pink a little longer than the rest of the sky.
  u.uSkyHorizon.value.copy(C.horizonDusk).lerp(C.horizonNight, smoothstep(0.1, 0.78, t))
  u.uSkyHorizonAnti.value.copy(ANTI_DUSK).lerp(C.horizonNight, b)
  u.uSkySunGlow.value.copy(C.sunGlow).multiplyScalar(sky.afterglow)
  // The haze band: the track's haze accent, lifted toward the horizon colour at sundown.
  _col.copy(u.uSkyHorizon.value).lerp(u.uSkyHorizonAnti.value, 0.5)
  u.uSkyHaze.value.copy(sky.haze).lerp(_col, 0.55 * (1 - b) + 0.25)
  u.uSunDir.value.copy(sky.sunDir)
  u.uTime.value = elapsed
  u.uSunVisible.value = sky.sunVisible

  // ---- the Belt of Venus (opposite the sun), fading with the afterglow ----
  u.uSkyBelt.value.copy(C.horizonDusk).lerp(C.midDusk, 0.42)
  u.uSkyEarthShadow.value.copy(C.midDusk).lerp(C.zenithDusk, 0.65)
  u.uSkyBeltAmt.value = sky.afterglow

  // ---- the city's glow lifting the night horizon ----
  u.uCityDir.value.set(Math.sin(sky.cityAzimuth), -Math.cos(sky.cityAzimuth))
  u.uCityCos.value = Math.cos(Math.min(Math.PI * 0.95, sky.cityArc * 0.5 + 10 * DEG))
  u.uCityGlow.value.copy(C.horizonDusk).lerp(C.windowWarm, 0.25).multiplyScalar(sky.hasCity ? sky.windows * 0.07 : 0)

  // ---- cloud streaks: backlit pink-orange while the sun is up, dusky after ----
  u.uCloudLit.value.copy(C.horizonDusk).lerp(C.sunGlow, 0.45).multiplyScalar(0.03 + 0.97 * sky.afterglow * sky.afterglow)
  u.uCloudDark.value.copy(C.midDusk).lerp(C.zenithDusk, 0.55).lerp(C.midNight, b)

  // ---- fog: the average horizon, pulled toward the haze accent ----
  sky.fogColor.copy(u.uSkyHorizonAnti.value).lerp(u.uSkyHorizon.value, 0.35).lerp(sky.haze, 0.3)

  // ---- key light: warm sun, then cool planet-light ----
  // At sundown the real sun sits ON the horizon, which would light nothing but
  // walls. The key light rides a little higher so slopes facing the sun catch it.
  const toPlanet = smoothstep(0.32, 0.62, t)
  const sunKeyEl = lerp(14, 5, smoothstep(0, 0.4, t)) * DEG
  dirFromAzEl(sky.sunAzimuth, sunKeyEl, _a)
  dirFromAzEl(sky.planetAzimuth, Math.min(sky.planetElevation, 40 * DEG), _b)
  sky.keyDir.copy(_a).lerp(_b, toPlanet).normalize()
  _warmKey.copy(C.sunGlow).lerp(C.sunTop, 0.3)
  sky.keyColor.copy(_warmKey).lerp(C.planetRing, toPlanet)
  const sunPart = 3.4 * (1 - smoothstep(0.22, 0.5, t))
  const planetPart = 0.6 * smoothstep(0.35, 0.75, t)
  sky.keyIntensity = Math.max(0.45, sunPart + planetPart)

  // ---- hemisphere fill: sky above, dark glass below ----
  sky.hemiSky.copy(u.uSkyMid.value).lerp(u.uSkyHorizonAnti.value, 0.35)
  sky.hemiGround.copy(C.groundSheen).lerp(C.ground, 0.4)
  sky.hemiIntensity = lerp(0.9, 0.5, b)

  // ---- publish to the rest of the game ----
  environment.timeOfDay = t
  environment.night = sky.night
  environment.headlights = sky.headlights
  environment.sunDirection.copy(sky.sunDir)
  environment.keyLightDirection.copy(sky.keyDir)
  environment.horizon.copy(sky.fogColor)
  environment.zenith.copy(u.uSkyZenith.value)
}
