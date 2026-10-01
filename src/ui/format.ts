// ============================================================
//  FORMAT - how numbers look on screen
// ------------------------------------------------------------
//  One place for every number format, so a lap time looks the
//  same in the HUD, the results and the track select.
// ============================================================

import type { TrackRuntime } from '../track/types'

/** m:ss.ttt - the only lap-time format in the game. */
export function formatLap(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '-:--.---'
  const clamped = Math.max(0, ms)
  const m = Math.floor(clamped / 60000)
  const s = Math.floor((clamped % 60000) / 1000)
  const t = Math.floor(clamped % 1000)
  return `${m}:${s < 10 ? '0' : ''}${s}.${t < 100 ? (t < 10 ? '00' : '0') : ''}${t}`
}

/** 0.85 -> "85%". */
export function formatPct(v: number): string {
  return `${Math.round(v * 100)}%`
}

/** A handling multiplier: 1 -> "100%", 1.35 -> "135%". */
export function formatMult(v: number): string {
  return `${Math.round(v * 100)}%`
}

/** Time of day 0..1 in words, with the number for anyone tuning it. */
export function formatTimeOfDay(v: number): string {
  const word = v < 0.15 ? 'Sundown' : v < 0.35 ? 'Dusk' : v < 0.6 ? 'Twilight' : v < 0.85 ? 'Nightfall' : 'Night'
  return `${word} ${v.toFixed(2)}`
}

/** Ai difficulty 0..1 in words. */
export function formatDifficulty(v: number): string {
  const word = v < 0.2 ? 'Sunday drivers' : v < 0.45 ? 'Relaxed' : v < 0.7 ? 'Racy' : v < 0.9 ? 'Fierce' : 'Ruthless'
  return `${word} ${Math.round(v * 100)}`
}

/** Score with thin grouping: 12500 -> "12,500". */
export function formatScore(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '-'
  return Math.round(n).toLocaleString('en-AU')
}

/** Seconds left on a clock: 75.2 -> "1:15". */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${r < 10 ? '0' : ''}${r}`
}

/** Race position as "P2". */
export function formatPosition(p: number): string {
  return `P${p}`
}

/**
 * The bank angle a track's records belong to, as "30°", or null when the
 * track has no bank slider. Records key on the road's shape, and on the
 * Hyperdrome a steeper bank is a different road, so each angle keeps its own
 * top speed. Showing the angle next to a best tells the player which one.
 */
export function recordAngle(track: TrackRuntime | null | undefined): string | null {
  if (!track || !track.file.road.banking.adjustable) return null
  const b = track.params.bankDeg
  return typeof b === 'number' && Number.isFinite(b) ? `${Math.round(b)}°` : null
}

/** A top speed, with the bank angle it was set at when that matters: "224 km/h at 30°". */
export function formatTopSpeed(kmh: number, angle: string | null): string {
  return angle ? `${Math.round(kmh)} km/h at ${angle}` : `${Math.round(kmh)} km/h`
}
