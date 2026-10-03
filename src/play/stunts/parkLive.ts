// ============================================================
//  PARK LIVE - the stunt park's shared, per-frame state
// ------------------------------------------------------------
//  A small mutable singleton (no React state per frame): the park
//  component (StuntPark.tsx) publishes the layout it built here
//  for the scoring (parkScoring.ts), which runs inside the car's
//  physics step. The maps read the zones from here too (parkZones,
//  through core/api.ts). The rings' countdowns and explosions have
//  their own singleton (ringComeback.ts).
// ============================================================

import type { ParkZoneMark } from '../../core/api'
import type { ParkLayout } from './parkLayout'

export const parkLive = {
  /** The park in the world right now (null when there is none: races, time trials). */
  layout: null as ParkLayout | null,
}

const NO_ZONES: readonly ParkZoneMark[] = []

/** The park's zones for the minimap and the world map (core/api.ts play.parkZones): the same array until the park changes. */
export function parkZones(): readonly ParkZoneMark[] {
  return parkLive.layout ? parkLive.layout.zones : NO_ZONES
}
