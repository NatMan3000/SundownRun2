// ============================================================
//  PIECES - the things Josh can drop onto his track
// ------------------------------------------------------------
//  Road pieces (boost pads, ramps, loops, wall rides, speed traps)
//  live ON the road: they are stored by `at` (how far along) and
//  `offset` (how far right of the centre). Crash props and energy
//  cores go anywhere on the ground: they are stored by x and z.
//  The start line is a road "piece" too, stored as start.at.
//
//  This module is the catalogue (names, colours, defaults) and the
//  rules for turning a click into a piece. Pure: no React, no game.
// ============================================================

import { PALETTE } from '../core/palette'
import { TRACK_DEFAULTS, type CoreSpot, type Piece, type PropSpot } from '../track/schema'
import type { P } from './geom'
import { type RoadCurve, type RoadHit, advanceAt, frameAt } from './road'

export type PlaceKind = 'boost' | 'ramp' | 'loop' | 'wallride-left' | 'wallride-right' | 'wallride-both' | 'speedtrap' | 'start' | 'props' | 'cores'

export interface PlaceTool {
  kind: PlaceKind
  label: string
  /** One line for the palette tooltip. */
  blurb: string
  colour: string
  /** Snaps to the road (true) or goes anywhere on the ground (false). */
  onRoad: boolean
  /** Keyboard shortcut (a digit). */
  key: string
}

export const PLACE_TOOLS: readonly PlaceTool[] = [
  { kind: 'boost', label: 'Boost pad', blurb: 'Drive over it for a kick of speed.', colour: PALETTE.boost, onRoad: true, key: '1' },
  { kind: 'ramp', label: 'Ramp', blurb: 'A kicker for big air. Click the side of the road you want it on.', colour: PALETTE.ramp, onRoad: true, key: '2' },
  { kind: 'loop', label: 'Loop', blurb: 'A full loop of light. Needs a long straight, level stretch.', colour: PALETTE.loopRing, onRoad: true, key: '3' },
  { kind: 'wallride-left', label: 'Wall ride (left)', blurb: 'A curved wall up the left side. Best round the outside of a bend.', colour: PALETTE.wallRide, onRoad: true, key: '4' },
  { kind: 'wallride-right', label: 'Wall ride (right)', blurb: 'A curved wall up the right side. Best round the outside of a bend.', colour: PALETTE.wallRide, onRoad: true, key: '5' },
  { kind: 'wallride-both', label: 'Half-pipe', blurb: 'Curved walls on both sides.', colour: PALETTE.wallRide, onRoad: true, key: '6' },
  { kind: 'speedtrap', label: 'Speed trap', blurb: 'Clocks how fast you go through it. Put it on a fast straight.', colour: PALETTE.speedTrap, onRoad: true, key: '7' },
  { kind: 'start', label: 'Start line', blurb: 'Where the race starts and every lap ends. Needs a straight behind it for the grid.', colour: PALETTE.uiText, onRoad: true, key: '8' },
  { kind: 'props', label: 'Crash props', blurb: 'A pile of neon crates and cubes to smash for points. Anywhere.', colour: PALETTE.propCrate, onRoad: false, key: '9' },
  { kind: 'cores', label: 'Energy core', blurb: 'A collectible for the core hunt. Hide them all over the world.', colour: PALETTE.core, onRoad: false, key: '0' },
]

export function toolFor(kind: PlaceKind): PlaceTool {
  return PLACE_TOOLS.find((t) => t.kind === kind) ?? PLACE_TOOLS[0]
}

/** What a piece is called, for the panel. */
export function pieceLabel(p: Piece): string {
  switch (p.type) {
    case 'boost':
      return 'Boost pad'
    case 'ramp':
      return 'Ramp'
    case 'loop':
      return 'Loop'
    case 'wallride':
      return p.side === 'both' ? 'Half-pipe' : `Wall ride (${p.side})`
    case 'speedtrap':
      return 'Speed trap'
  }
}

export function pieceColour(p: Piece): string {
  switch (p.type) {
    case 'boost':
      return PALETTE.boost
    case 'ramp':
      return PALETTE.ramp
    case 'loop':
      return PALETTE.loopRing
    case 'wallride':
      return PALETTE.wallRide
    case 'speedtrap':
      return PALETTE.speedTrap
  }
}

const r2 = (v: number) => Math.round(v * 100) / 100
const r1 = (v: number) => Math.round(v * 10) / 10

/**
 * A road piece from a click on the road. Pads and ramps go on the side of
 * the road you clicked (kept fully on the road); a click near the middle
 * snaps to the middle.
 */
export function makeRoadPiece(kind: PlaceKind, hit: RoadHit, halfWidth: number): Piece | null {
  const at = r2(hit.at)
  const sideOffset = (pieceWidth: number) => {
    if (Math.abs(hit.lateral) < 1.5) return 0
    const room = Math.max(0, halfWidth - pieceWidth / 2 - 0.3)
    return r1(Math.max(-room, Math.min(room, hit.lateral)))
  }
  switch (kind) {
    case 'boost': {
      const offset = sideOffset(TRACK_DEFAULTS.boost.width)
      return offset ? { type: 'boost', at, offset } : { type: 'boost', at }
    }
    case 'ramp': {
      const offset = sideOffset(TRACK_DEFAULTS.ramp.width)
      return offset ? { type: 'ramp', at, offset } : { type: 'ramp', at }
    }
    case 'loop':
      return { type: 'loop', at }
    case 'wallride-left':
      return { type: 'wallride', at, side: 'left' }
    case 'wallride-right':
      return { type: 'wallride', at, side: 'right' }
    case 'wallride-both':
      return { type: 'wallride', at, side: 'both' }
    case 'speedtrap':
      return { type: 'speedtrap', at }
    default:
      return null
  }
}

export function makeProp(q: P): PropSpot {
  return { x: r1(q.x), z: r1(q.z), kind: 'mixed', size: 'medium' }
}

export function makeCore(q: P): CoreSpot {
  return { x: r1(q.x), z: r1(q.z) }
}

/** Where a road piece sits on the map (its centre), and the road direction there. */
export function piecePlace(rc: RoadCurve, p: Piece): { p: P; dir: P; right: P } {
  let at = p.at
  if (p.type === 'wallride') at = advanceAt(rc, p.at, (p.length ?? TRACK_DEFAULTS.wallride.length) / 2)
  const f = frameAt(rc, at)
  const offset = p.type === 'boost' || p.type === 'ramp' ? (p.offset ?? 0) : 0
  return { p: { x: f.p.x + f.right.x * offset, z: f.p.z + f.right.z * offset }, dir: f.dir, right: f.right }
}

/** Sizes in metres for drawing a piece from above. */
export function pieceFootprint(p: Piece, roadWidth: number): { length: number; width: number } {
  switch (p.type) {
    case 'boost':
      return { length: p.length ?? TRACK_DEFAULTS.boost.length, width: p.width ?? TRACK_DEFAULTS.boost.width }
    case 'ramp':
      return { length: p.length ?? TRACK_DEFAULTS.ramp.length, width: p.width ?? TRACK_DEFAULTS.ramp.width }
    case 'loop':
      return { length: 2 * (p.radius ?? TRACK_DEFAULTS.loopRadius), width: roadWidth }
    case 'wallride':
      return { length: p.length ?? TRACK_DEFAULTS.wallride.length, width: roadWidth }
    case 'speedtrap':
      return { length: 2, width: roadWidth + 2 }
  }
}
