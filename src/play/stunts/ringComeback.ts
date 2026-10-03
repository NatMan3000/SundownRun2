// ============================================================
//  RING COMEBACK - a ring you fly through explodes, counts down
//  and comes back
// ------------------------------------------------------------
//  Nathan's ask: a ring "would explode when you go through it, so
//  that you can see the big effect as you're driving through it,
//  and then it's disappeared, and in its place is a countdown timer
//  before it regenerates back again".
//
//  This file is the rings' clock, nothing visual:
//
//    ringLive(i)      can ring i score right now?
//    explodeRing(...) the scoring (parkScoring.ts) calls this the
//                     moment you fly through a ring: it starts the
//                     countdown and queues the explosion for the
//                     picture (ringFx.ts) to draw on the next frame
//    tickRings()      once per physics step: every countdown goes
//                     down by one step; at 0 the ring is back and
//                     the event feed hears 'stunt.ringBack'
//
//  How long it waits is Josh's ringComebackSeconds knob in
//  src/core/config.ts (45 s). The clock runs on physics steps, so
//  pausing the game pauses it too, and a rewind puts it back the
//  way it was (saveRings / loadRings are part of the park's rewind
//  snapshot in StuntPark.tsx): rewind to before a pass and the ring
//  is whole again.
//
//  Rings are each player's own: only YOUR car's trick detector
//  feeds the scoring, so another player's car flying through a
//  ring in multiplayer never explodes yours.
//
//  Nothing here allocates once the park is built.
// ============================================================

import { CONFIG } from '../../core/config'
import { emit } from '../../core/events'
import { DT } from '../../vehicle/tuning'

/** Most explosions waiting to be drawn at once (a jump passes at most a few rings a frame). */
export const BURST_QUEUE = 8
/** Numbers per queued explosion: ring index, the car's velocity (x, y, z), the points it added. */
export const BURST_FLOATS = 5

/** Seconds a ring waits after it explodes, from Josh's knob (kept sensible if it is mistyped). */
export function comebackSeconds(): number {
  const s = Number(CONFIG.ringComebackSeconds)
  return Number.isFinite(s) ? Math.min(600, Math.max(1, s)) : 45
}

export const rings = {
  /** Per ring: seconds left before it comes back (0 = whole and scoring). */
  wait: new Float64Array(0),
  /** Explosions the physics step queued for the next frame to draw. */
  bursts: new Float64Array(BURST_QUEUE * BURST_FLOATS),
  burstCount: 0,
  /** How many times each ring has exploded and come back (dev inspector). */
  explodedTotal: 0,
  backTotal: 0,
}

/** A new park (or a new round): every ring whole, nothing queued. */
export function resetRings(count: number): void {
  if (rings.wait.length !== count) rings.wait = new Float64Array(count)
  else rings.wait.fill(0)
  rings.burstCount = 0
}

/** Can ring i score right now? */
export function ringLive(i: number): boolean {
  return i >= 0 && i < rings.wait.length && rings.wait[i] <= 0
}

/** You flew through ring i: it explodes now and counts down. vx/vy/vz = the car's velocity (m/s). */
export function explodeRing(i: number, vx: number, vy: number, vz: number, points: number): void {
  if (i < 0 || i >= rings.wait.length) return
  rings.wait[i] = comebackSeconds()
  rings.explodedTotal++
  if (rings.burstCount >= BURST_QUEUE) return // the picture is behind: the clock still starts
  const at = rings.burstCount * BURST_FLOATS
  const ok = Number.isFinite(vx + vy + vz)
  rings.bursts[at] = i
  rings.bursts[at + 1] = ok ? vx : 0
  rings.bursts[at + 2] = ok ? vy : 0
  rings.bursts[at + 3] = ok ? vz : 0
  rings.bursts[at + 4] = points
  rings.burstCount++
}

/** One physics step of every countdown. `running` = false while the world is rewinding (the clock holds). */
export function tickRings(running: boolean): void {
  if (!running) return
  const w = rings.wait
  for (let i = 0; i < w.length; i++) {
    if (w[i] <= 0) continue
    w[i] -= DT
    if (w[i] <= 0) {
      w[i] = 0
      rings.backTotal++
      emit('stunt.ringBack', { ring: i })
    }
  }
}

// ---------------------------------------------------------------- rewind

/** Rewind: save every ring's countdown (one number per ring). */
export function saveRings(out: Float64Array, at: number, count: number): void {
  const w = rings.wait
  for (let i = 0; i < count; i++) out[at + i] = i < w.length ? w[i] : 0
}

/** Rewind: put every ring's countdown back. A broken number leaves that ring whole. */
export function loadRings(src: Float64Array, at: number, count: number): void {
  const w = rings.wait
  const most = comebackSeconds()
  for (let i = 0; i < count && i < w.length; i++) {
    const v = src[at + i]
    w[i] = Number.isFinite(v) ? Math.min(most, Math.max(0, v)) : 0
  }
}

/** Dev: the countdowns, rounded (window.__game.get('play').stunts.ringWait). */
export function ringWaitDebug(): number[] {
  const out: number[] = []
  for (let i = 0; i < rings.wait.length; i++) out.push(Math.round(rings.wait[i] * 10) / 10)
  return out
}
