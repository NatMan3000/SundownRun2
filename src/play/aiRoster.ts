// ============================================================
//  AI ROSTER - who you are racing against
// ------------------------------------------------------------
//  Every Ai racer has a name, a colour, a car body and a
//  personality. The personality is a handful of small numbers that
//  make each racer drive a little differently, so a race looks like
//  five drivers instead of five copies of one robot:
//
//    pace        how hard they push (a few percent either way)
//    lane        where on the road they like to sit (metres, + = right)
//    lookahead   how far up the road they aim (bigger = smoother, wider)
//    aggression  how keen they are to overtake, and how late they brake
//    wander      a slow, small weave, like a human not holding a perfect line
//
//  Josh: add a name to DRIVERS and it can turn up in your races.
// ============================================================

import { PALETTE } from '../core/palette'
import { vehicle } from '../core/api'
import { mulberry32, roundSeed, shuffleInPlace } from './random'
import * as THREE from 'three'

export interface Personality {
  pace: number
  lane: number
  lookahead: number
  aggression: number
  wander: number
}

interface DriverDef {
  name: string
  personality: Personality
}

/** The pool of racers. A race picks a few of these at random (seeded by the round). */
const DRIVERS: readonly DriverDef[] = [
  { name: 'VOLT', personality: { pace: 1.01, lane: -0.6, lookahead: 0.95, aggression: 0.8, wander: 0.2 } },
  { name: 'NOVA', personality: { pace: 1.0, lane: 0.5, lookahead: 1.05, aggression: 0.5, wander: 0.3 } },
  { name: 'RAZOR', personality: { pace: 1.015, lane: 0.0, lookahead: 0.9, aggression: 1.0, wander: 0.15 } },
  { name: 'AURA', personality: { pace: 0.995, lane: 0.9, lookahead: 1.12, aggression: 0.3, wander: 0.1 } },
  { name: 'KAIJU', personality: { pace: 1.005, lane: -1.0, lookahead: 0.92, aggression: 1.0, wander: 0.45 } },
  { name: 'HEXA', personality: { pace: 0.99, lane: 0.3, lookahead: 1.0, aggression: 0.6, wander: 0.25 } },
  { name: 'LUMEN', personality: { pace: 0.995, lane: -0.3, lookahead: 1.08, aggression: 0.4, wander: 0.2 } },
  { name: 'VECTOR', personality: { pace: 1.01, lane: 0.7, lookahead: 0.97, aggression: 0.7, wander: 0.1 } },
  { name: 'PULSAR', personality: { pace: 1.0, lane: -0.8, lookahead: 1.0, aggression: 0.9, wander: 0.35 } },
  { name: 'ECHO', personality: { pace: 0.985, lane: 0.2, lookahead: 1.1, aggression: 0.35, wander: 0.3 } },
]

export interface RacerSpec {
  /** Car id in the registry: 'ai-1' .. 'ai-5'. */
  id: string
  name: string
  body: string
  paint: string
  glow: string
  trail: string
  /** Start grid slot (0 = pole). The player always takes the slot behind the last Ai. */
  gridSlot: number
  personality: Personality
}

const _paint = new THREE.Color()
const _tint = new THREE.Color()

/** A dark body paint carrying a hint of the racer's colour (derived from palette tokens, no new hex). */
function darkPaint(glow: string): string {
  _paint.set(PALETTE.paintDefault)
  _tint.set(glow)
  return '#' + _paint.lerp(_tint, 0.22).getHexString()
}

/**
 * Build the roster for a race: `count` racers, seeded by track and round so
 * a restart deals a fresh line-up but a reload of the same round does not.
 * The player's own glow colour is never handed to an Ai.
 */
export function buildRoster(count: number, trackKey: string, round: number, playerGlow: string): RacerSpec[] {
  const rng = mulberry32(roundSeed(trackKey, round, 7))
  const pool = shuffleInPlace(DRIVERS.slice(), rng)

  const player = playerGlow.toLowerCase()
  const colours = PALETTE.aiColors.filter((c) => c.toLowerCase() !== player)
  // Only five Ai colours exist; if the player took one, amber steps in.
  if (colours.length < 5) colours.push(PALETTE.chevron)

  const bodies = vehicle.bodies().map((b) => b.id)
  const bodyOffset = Math.floor(rng() * Math.max(1, bodies.length))

  const out: RacerSpec[] = []
  for (let i = 0; i < count; i++) {
    const d = pool[i % pool.length]
    const glow = colours[i % colours.length]
    out.push({
      id: `ai-${i + 1}`,
      name: d.name,
      body: bodies.length ? bodies[(i + bodyOffset) % bodies.length] : 'dart',
      paint: darkPaint(glow),
      glow,
      trail: glow,
      gridSlot: i,
      personality: d.personality,
    })
  }
  return out
}
