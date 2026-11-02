// ============================================================
//  HUNTER BOOST - Tag: "it" gets a faster car, more when far behind
// ------------------------------------------------------------
//  In a multiplayer tag round every car is the same, so a runner who
//  floors it can never be caught. While you are "it" (CarState.isIt,
//  set by net) your top speed goes up by Josh's tagHunterBoost knob
//  (percent): a quarter of it right up close, all of it once the
//  nearest player is HUNTER_FAR_M away. A higher top speed also gives
//  more pull (the engine's power is sized from the top speed), so you
//  accelerate harder too. (D4, 2 Nov 2026.)
// ============================================================

import { cars, getCar } from '../core/telemetry'
import { getSettings } from '../core/settings'

/** Up to this close (metres), "it" gets a quarter of the boost. */
export const HUNTER_NEAR_M = 15
/** From this far (metres), "it" gets all of it. */
export const HUNTER_FAR_M = 150

/** Straight-line metres to the nearest other player, or -1 if there is none. */
export function nearestPlayerM(): number {
  const me = getCar('player')
  if (!me) return -1
  let best = -1
  for (let i = 0; i < cars.length; i++) {
    const c = cars[i]
    if (c.kind !== 'remote') continue
    const d = c.position.distanceTo(me.position)
    if (best < 0 || d < best) best = d
  }
  return best
}

/** Top-speed multiplier for our car this step: 1 unless we're "it" in tag. */
export function hunterMultiplier(): number {
  const me = getCar('player')
  const pct = getSettings().tagHunterBoost
  if (!me || !me.isIt || !(pct > 0)) return 1
  const d = nearestPlayerM()
  if (d < 0) return 1
  const t = Math.min(1, Math.max(0, (d - HUNTER_NEAR_M) / (HUNTER_FAR_M - HUNTER_NEAR_M)))
  const share = 0.25 + 0.75 * t * t * (3 - 2 * t)
  return 1 + (pct / 100) * share
}
