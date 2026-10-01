// ============================================================
//  FEEL PAD - a dev-only test track for measuring how the car feels
// ------------------------------------------------------------
//  A huge, flat, open oval: 1.4 km straights, a 30 m wide road and
//  open flat ground either side, so a handbrake tap at 100 km/h or a
//  skidpad circle never runs out of room or into a wall. It is a
//  normal track file (the same format as tracks/*.json), loaded live:
//
//    window.__dev.feelPad()
//
//  Not in tracks/ on purpose: it is a measuring instrument, not a
//  track anyone should pick from the menu.
// ============================================================

import { registerDev } from '../core/devHandles'
import type { TrackFile } from '../track/schema'
import { setTrackFromFile } from '../track/current'

export const FEEL_PAD: TrackFile = {
  format: 'sundown-run-track',
  version: 1,
  id: 'feel-pad',
  name: 'Feel Pad (dev)',
  description: 'Flat, wide, open test oval for feel measurements.',
  road: {
    width: 30,
    banking: { auto: false, maxDeg: 0 },
    points: [
      { x: -700, z: 250 },
      { x: -350, z: 250 },
      { x: 0, z: 250 },
      { x: 350, z: 250 },
      { x: 700, z: 250 },
      { x: 900, z: 150 },
      { x: 950, z: 0 },
      { x: 900, z: -150 },
      { x: 700, z: -250 },
      { x: 350, z: -250 },
      { x: 0, z: -250 },
      { x: -350, z: -250 },
      { x: -700, z: -250 },
      { x: -900, z: -150 },
      { x: -950, z: 0 },
      { x: -900, z: 150 },
    ],
  },
  environment: {
    size: 2800,
    terrain: { kind: 'flat', edge: 'wall' },
    city: false,
    roadside: { posts: false, billboards: 0 },
  },
}

registerDev(
  'feelPad',
  (() => {
    const r = setTrackFromFile(FEEL_PAD)
    return r.ok ? 'feel pad loaded' : r.errors
  }) as never,
  'feelPad(): load the flat, wide, open feel-test oval (dev only)',
)
