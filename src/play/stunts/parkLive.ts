// ============================================================
//  PARK LIVE - the stunt park's shared, per-frame state
// ------------------------------------------------------------
//  A small mutable singleton (no React state per frame): the park
//  component (StuntPark.tsx) publishes the layout it built here,
//  and the scoring (parkScoring.ts), which runs inside the car's
//  physics step, writes back which rings were just flown through,
//  so the component can flash them on the next frame. The maps
//  read the zones from here too (parkZones, through core/api.ts).
// ============================================================

import type { ParkZoneMark } from '../../core/api'
import type { ParkLayout } from './parkLayout'

export const parkLive = {
  /** The park in the world right now (null when there is none: races, time trials). */
  layout: null as ParkLayout | null,
  /** Per ring: set to 1 by the scoring when a car flies through it; the component flashes it and clears it. */
  ringFlash: [] as number[],
}

const NO_ZONES: readonly ParkZoneMark[] = []

/** The park's zones for the minimap and the world map (core/api.ts play.parkZones): the same array until the park changes. */
export function parkZones(): readonly ParkZoneMark[] {
  return parkLive.layout ? parkLive.layout.zones : NO_ZONES
}
