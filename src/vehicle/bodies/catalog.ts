// ============================================================
//  CAR CATALOG - the five bodies in the garage
// ------------------------------------------------------------
//  What the garage shows (name, one-line blurb, stat bars) and the
//  small, honest handling differences each body really has. The
//  shapes themselves are recipes in bodies/profiles.ts.
//
//  Handling multipliers are deliberately gentle (within about 15%):
//  every car must be fun, the differences are flavour, not a trap.
//    mass   heavier = more planted, slower to change direction
//    power  engine force and power
//    grip   tyre grip
// ============================================================

import type { CarBodyInfo } from '../../core/api'

export type BodyId = 'dart' | 'blade' | 'brick' | 'manta' | 'pulse'

export interface BodyTuning {
  mass: number
  power: number
  grip: number
}

export interface BodyEntry extends CarBodyInfo {
  id: BodyId
  tuning: BodyTuning
}

export const BODIES: readonly BodyEntry[] = [
  {
    id: 'dart',
    name: 'Dart',
    blurb: 'Big wing, one big rocket. Balanced and forgiving - the one to learn on.',
    stats: { speed: 0.7, grip: 0.7, weight: 0.5 },
    tuning: { mass: 1.0, power: 1.0, grip: 1.0 },
  },
  {
    id: 'blade',
    name: 'Blade',
    blurb: 'A sharp wedge with twin fins. The most power in the garage, a little less grip.',
    stats: { speed: 0.9, grip: 0.6, weight: 0.45 },
    tuning: { mass: 0.95, power: 1.1, grip: 0.95 },
  },
  {
    id: 'brick',
    name: 'Brick',
    blurb: 'An armoured truck with a bull bar. Heavy and planted - it shoves cars around.',
    stats: { speed: 0.65, grip: 0.75, weight: 0.95 },
    tuning: { mass: 1.25, power: 1.12, grip: 1.04 },
  },
  {
    id: 'manta',
    name: 'Manta',
    blurb: 'Wide and flat like a ray, with a T-tail. Sticks to corners like nothing else.',
    stats: { speed: 0.7, grip: 0.9, weight: 0.55 },
    tuning: { mass: 1.0, power: 0.98, grip: 1.08 },
  },
  {
    id: 'pulse',
    name: 'Pulse',
    blurb: 'A tiny bubble pod with one big rocket. Light, flicky and great in the air.',
    stats: { speed: 0.6, grip: 0.7, weight: 0.3 },
    tuning: { mass: 0.85, power: 0.94, grip: 1.0 },
  },
]

const byId = new Map<string, BodyEntry>(BODIES.map((b) => [b.id, b]))

/** The body for an id, falling back to the Dart for anything unknown (old saves, typos in config.ts). */
export function bodyEntry(id: string): BodyEntry {
  return byId.get(id) ?? BODIES[0]
}
