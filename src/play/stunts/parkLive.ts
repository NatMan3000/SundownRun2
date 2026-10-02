// ============================================================
//  PARK LIVE - the stunt park's shared, per-frame state
// ------------------------------------------------------------
//  A small mutable singleton (no React state per frame): the park
//  component (StuntPark.tsx) publishes the layout it built here,
//  and the scoring (parkScoring.ts), which runs inside the car's
//  physics step, writes back which rings were just flown through,
//  so the component can flash them on the next frame.
// ============================================================

import type { ParkLayout } from './parkLayout'

export const parkLive = {
  /** The park in the world right now (null when there is none: races, time trials). */
  layout: null as ParkLayout | null,
  /** Per ring: set to 1 by the scoring when a car flies through it; the component flashes it and clears it. */
  ringFlash: [] as number[],
}
