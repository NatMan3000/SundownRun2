// ============================================================
//  PARK CUE - "hit it at 98": the speed cue for the launch ahead
// ------------------------------------------------------------
//  Every launch in the stunt park has its speed painted on its
//  face (parkLayout.ts signKmh): the speed to leave its lip at, so
//  you fly through its rings or land on its bullseye. This works
//  out which launch the player is lined up on and how their speed
//  compares, and announces it on the event feed as 'stunt.lineup'
//  ONLY when that changes (a few times a run): the HUD turns it
//  into a small panel by the speedo (src/ui/hud/ParkCue.tsx):
//
//    slow   under the sign by more than a few km/h: go faster
//    on     within ON_BAND km/h of it: hold it there up the ramp
//    fast   over it: ease off
//    none   no launch ahead (the panel goes away)
//
//  "Lined up" means: on the ground, inside the lane's corridor,
//  facing up it, anywhere from LOOK_AHEAD metres before the ramp's
//  foot (or the lane's start, if that's further) to just past its
//  lip; the nearest launch ahead wins. The speed counts all the way up the face,
//  because the lip speed is what decides where you come down.
//
//  Runs from the park's frame loop; allocates nothing unless it
//  announces something.
// ============================================================

import { emit } from '../../core/events'
import { telemetry } from '../../core/telemetry'
import type { ParkLayout } from './parkLayout'

/** Within this many km/h of the sign counts as on speed (a ring is about +-6 wide, a bullseye's x2 ring +-4). */
const ON_BAND = 4
/** Once on speed, you stay on until you're this much further out, so the panel doesn't flicker at the edge. */
const HYSTERESIS = 1.5
/** How far before a ramp's foot the cue starts, metres (the mega ramp: its whole run-in). */
const LOOK_AHEAD = 90
/** How far outside a lane's corridor (metres either side) still counts as lined up. */
const SIDE_SLACK = 2
/** Facing up the lane within about 35 degrees. */
const HEADING_COS = Math.cos((35 * Math.PI) / 180)
/** A hop off a bump isn't "in the air" for the cue until it lasts this long (seconds). */
const AIR_GRACE = 0.25
/** The ramp you're on keeps the cue this far past its lip (metres): the car's middle passes the lip before its back wheels leave it. */
const PAST_LIP = 4

export type CueBand = 'slow' | 'on' | 'fast' | 'none'

/** One launch with a sign, ready for the per-frame test. */
export interface CueLaunch {
  item: number
  label: string
  kmh: number
  /** The ramp's foot on the lane's centre line, and the lane's heading. */
  toeX: number
  toeZ: number
  dx: number
  dz: number
  /** Metres from the foot to the lip, and how far before the foot the cue starts. */
  face: number
  ahead: number
  /** The corridor's half width, metres. */
  halfWidth: number
}

/** The launches of a layout that have a speed sign. */
export function cueLaunches(layout: ParkLayout): CueLaunch[] {
  const out: CueLaunch[] = []
  for (const it of layout.items) {
    if (it.signKmh <= 0) continue
    const toeX = it.runX + it.dx * it.runIn
    const toeZ = it.runZ + it.dz * it.runIn
    const zone = layout.zones[it.zone]
    // From the lane's very start too (the Hyperdrome's Stunt Attack starts there, 160 m out from the mega ramp).
    const fromLaneStart = zone ? (toeX - zone.x) * it.dx + (toeZ - zone.z) * it.dz + 10 : 0
    out.push({
      item: it.id,
      label: it.label,
      kmh: it.signKmh,
      toeX,
      toeZ,
      dx: it.dx,
      dz: it.dz,
      // The item's reference point is its lip.
      face: Math.max(1, (it.x - toeX) * it.dx + (it.z - toeZ) * it.dz),
      ahead: Math.max(LOOK_AHEAD, it.runIn, fromLaneStart),
      halfWidth: (zone ? zone.halfWidth : 8) + SIDE_SLACK,
    })
  }
  return out
}

/** What the HUD was last told (read by the park's inspector). */
const shown = { item: -1, band: 'none' as CueBand }
export function parkCueShown(): Readonly<typeof shown> {
  return shown
}

/** Which launch the player is lined up on right now (-1 = none). */
function linedUp(launches: CueLaunch[]): number {
  if (telemetry.airborne && telemetry.airTime > AIR_GRACE) return -1
  const px = telemetry.carPosition.x
  const pz = telemetry.carPosition.z
  const fx = telemetry.carForward.x
  const fz = telemetry.carForward.z
  const fl = Math.hypot(fx, fz) || 1
  let best = -1
  let bestGap = Infinity
  for (let i = 0; i < launches.length; i++) {
    const L = launches[i]
    if ((fx * L.dx + fz * L.dz) / fl < HEADING_COS) continue
    const rx = px - L.toeX
    const rz = pz - L.toeZ
    const a = rx * L.dx + rz * L.dz
    if (a < -L.ahead || a > L.face + PAST_LIP) continue
    const l = -rx * L.dz + rz * L.dx
    if (Math.abs(l) > L.halfWidth) continue
    // The nearest launch ahead wins (on the ramp itself counts as 0 away).
    const gap = a < 0 ? -a : 0
    if (gap < bestGap) {
      bestGap = gap
      best = i
    }
  }
  return best
}

/** Per frame: work out the cue and announce it if it changed. */
export function stepParkCue(launches: CueLaunch[]): void {
  const i = linedUp(launches)
  if (i < 0) {
    clearParkCue()
    return
  }
  const L = launches[i]
  const off = telemetry.speedKmh - L.kmh
  const sameRamp = shown.item === L.item
  const wasOn = sameRamp && shown.band === 'on'
  const band: CueBand = Math.abs(off) <= ON_BAND + (wasOn ? HYSTERESIS : 0) ? 'on' : off < 0 ? 'slow' : 'fast'
  if (sameRamp && band === shown.band) return
  shown.item = L.item
  shown.band = band
  emit('stunt.lineup', { label: L.label, kmh: L.kmh, band })
}

/** No launch ahead (or the park went away): tell the HUD once. */
export function clearParkCue(): void {
  if (shown.band === 'none') return
  shown.item = -1
  shown.band = 'none'
  emit('stunt.lineup', { label: '', kmh: 0, band: 'none' })
}
