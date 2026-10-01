// ============================================================
//  WORLD CLOCK - what time of day it is
// ------------------------------------------------------------
//  Time of day is one number: 0 is sundown (the sun's lower half
//  sitting on the horizon) and 1 is full night. Everything in the
//  world - the sky colours, the sun, the stars, the city windows,
//  the headlights - reads it through sky.ts.
//
//  How the clock moves:
//    - When a drive starts, it starts at the player's Time of day
//      setting, or at the track's own default if the player never
//      touched that setting.
//    - While you drive, it creeps toward night so that it reaches 1
//      after `sunsetMinutes` minutes (0 = time stands still), then
//      holds at night.
//    - If the setting changes mid-drive, the sky glides to the new
//      time over about a second instead of jumping.
//    - ?time=0.5 in the URL, or window.__dev.setTime(0.5), pins the
//      clock at that time (handy for screenshots).
//
//  Nothing here allocates: it runs every frame.
// ============================================================

import { getSettings, getDefaults } from '../core/settings'
import { getGame } from '../core/store'
import { urlParam } from '../core/devHandles'
import type { TrackRuntime } from '../track/types'

export const worldClock = {
  /** The time of day the world is drawn at right now, 0..1. */
  time: 0.12,
  /** Where this drive started (the night arrives sunsetMinutes after it). */
  start: 0.12,
  /** Pinned by ?time= or __dev.setTime: the clock does not move. */
  frozen: false,
  /** A glide in progress toward this time (-1 = no glide). */
  glideTo: -1,
  /** True once the clock has been placed for the current track. */
  placed: false,
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** Read ?time= once. Returns null when absent or not a number. */
function urlTime(): number | null {
  const raw = urlParam('time')
  if (raw === null || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? clamp01(n) : null
}

const URL_TIME = urlTime()
if (URL_TIME !== null) {
  worldClock.time = URL_TIME
  worldClock.start = URL_TIME
  worldClock.frozen = true
}

/**
 * The time a drive starts at: the player's setting if they changed it
 * from the config default, otherwise the track's own sky default.
 */
export function startTimeFor(track: TrackRuntime | null): number {
  const s = getSettings().timeOfDay
  const playerChanged = s !== getDefaults().timeOfDay
  if (playerChanged || !track) return clamp01(s)
  return clamp01(track.file.environment.sky.timeOfDay)
}

/** Put the clock at the start of a drive. `glide` eases there instead of jumping. */
export function resetClock(track: TrackRuntime | null, glide: boolean): void {
  if (worldClock.frozen) return
  const t = startTimeFor(track)
  worldClock.start = t
  if (glide && worldClock.placed) {
    worldClock.glideTo = t
  } else {
    worldClock.time = t
    worldClock.glideTo = -1
  }
  worldClock.placed = true
}

/** The player moved the Time of day slider: glide there, and count the sunset from there. */
export function settingChanged(value: number): void {
  if (worldClock.frozen) return
  worldClock.start = clamp01(value)
  worldClock.glideTo = clamp01(value)
}

/** Pin the clock (dev and checkers). Pass null to let it run again. */
export function setTimeOverride(t: number | null): void {
  if (t === null || !Number.isFinite(t)) {
    worldClock.frozen = false
    worldClock.start = worldClock.time
    return
  }
  worldClock.frozen = true
  worldClock.glideTo = -1
  worldClock.time = clamp01(t)
}

/** Seconds a glide takes to get most of the way (exponential ease). */
const GLIDE_SECONDS = 0.45

/** Advance the clock by dt seconds. Called once per frame by the world. */
export function tickClock(dt: number): void {
  if (worldClock.frozen) return
  // A long hitch (tab in the background) should not fast-forward the sky.
  const step = dt > 0.1 ? 0.1 : dt < 0 ? 0 : dt

  if (worldClock.glideTo >= 0) {
    const k = 1 - Math.exp(-step / GLIDE_SECONDS)
    worldClock.time += (worldClock.glideTo - worldClock.time) * k
    if (Math.abs(worldClock.glideTo - worldClock.time) < 0.0005) {
      worldClock.time = worldClock.glideTo
      worldClock.glideTo = -1
    }
    return
  }

  const g = getGame()
  const driving = g.phase === 'playing' || (g.multiplayer && g.phase === 'paused')
  if (!driving) return
  const minutes = getSettings().sunsetMinutes
  if (minutes <= 0 || worldClock.time >= 1) return
  // The remaining way from the start to night takes `minutes`.
  const span = Math.max(0.02, 1 - worldClock.start)
  worldClock.time = Math.min(1, worldClock.time + (step * span) / (minutes * 60))
}
