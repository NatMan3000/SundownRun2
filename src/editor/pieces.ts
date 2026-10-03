// ============================================================
//  PIECES - the things Josh can drop onto his track
// ------------------------------------------------------------
//  Road pieces (boost pads, ramps, loops, wall rides, speed traps,
//  tunnels) live ON the road: they are stored by `at` (how far along) and
//  `offset` (how far right of the centre). Crash props and energy
//  cores go anywhere on the ground: they are stored by x and z.
//  The start line is a road "piece" too, stored as start.at.
//
//  This module is the catalogue (names, colours, defaults) and the
//  rules for turning a click into a piece. Pure: no React, no game.
//
//  Wall rides are stored by where they START (`at`) and run `length`
//  metres forward, but Josh places and resizes them by their MIDDLE:
//  a click puts the middle under the mouse, a drag along the road
//  covers what he dragged, and a new Length grows or shrinks both
//  ends equally (wallRideStartFor, wallRideFromDrag). Tunnels work the
//  same way (tunnelStartFor, tunnelFromDrag). Boost pads and ramps are
//  already stored by their middle, so they need nothing.
// ============================================================

import { PALETTE } from '../core/palette'
import { TRACK_DEFAULTS, type CoreSpot, type Piece, type PropSpot } from '../track/schema'
import type { P } from './geom'
import { type RoadCurve, type RoadHit, advanceAt, frameAt, metresBetween } from './road'

export type PlaceKind = 'boost' | 'ramp' | 'loop' | 'wallride-left' | 'wallride-right' | 'wallride-both' | 'speedtrap' | 'tunnel' | 'start' | 'props' | 'cores'

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
  { kind: 'wallride-left', label: 'Wall ride (left)', blurb: 'A curved wall up the left side. Best round the outside of a bend. Click: its middle goes there. Or drag along the road to draw how long it is.', colour: PALETTE.wallRide, onRoad: true, key: '4' },
  { kind: 'wallride-right', label: 'Wall ride (right)', blurb: 'A curved wall up the right side. Best round the outside of a bend. Click: its middle goes there. Or drag along the road to draw how long it is.', colour: PALETTE.wallRide, onRoad: true, key: '5' },
  { kind: 'wallride-both', label: 'Half-pipe', blurb: 'Curved walls on both sides. Click: its middle goes there. Or drag along the road to draw how long it is.', colour: PALETTE.wallRide, onRoad: true, key: '6' },
  { kind: 'speedtrap', label: 'Speed trap', blurb: 'Clocks how fast you go through it. Put it on a fast straight.', colour: PALETTE.speedTrap, onRoad: true, key: '7' },
  {
    kind: 'tunnel',
    label: 'Tunnel',
    blurb: "A real tunnel: the road dips into the ground and the hill goes back over it. It needs a long stretch of plain road: a ramp down at each end (90-280 m) as well as the covered part, with nothing on it but boost pads and speed traps, and no other road right beside it. The map shows it all before you click (amber where it won't fit, and why). Click: it goes there, or to the nearest spot that fits. Or drag along the road to draw how long it is.",
    colour: PALETTE.grid,
    onRoad: true,
    key: '',
  },
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
    case 'tunnel':
      return 'Tunnel'
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
    case 'tunnel':
      // A tunnel is part of the ground: the ground grid's violet.
      return PALETTE.grid
  }
}

const r3 = (v: number) => Math.round(v * 1000) / 1000
const r2 = (v: number) => Math.round(v * 100) / 100
const r1 = (v: number) => Math.round(v * 10) / 10

// ---------------------------------------------------------------- wall rides, by their middle

/** The shortest and longest wall ride, metres (the panel's Length slider has the same ends). */
export const WALLRIDE_MIN = 40
export const WALLRIDE_MAX = 300

/** Which side a wall ride place tool builds, or null for every other tool. */
export function wallRideSide(kind: PlaceKind): 'left' | 'right' | 'both' | null {
  return kind === 'wallride-left' ? 'left' : kind === 'wallride-right' ? 'right' : kind === 'wallride-both' ? 'both' : null
}

/**
 * Where a wall ride `length` metres long must start so its middle is at
 * `middle`. Rounded finely: on a road with points 200 m apart, 0.001 of `at`
 * is still only 0.2 m.
 */
export function wallRideStartFor(rc: RoadCurve, middle: number, length: number): number {
  return r3(advanceAt(rc, middle, -length / 2))
}

/** Where a wall ride's middle is (`length / 2` metres along the road from its start). */
export function wallRideMiddle(rc: RoadCurve, at: number, length: number | undefined): number {
  return advanceAt(rc, at, (length ?? TRACK_DEFAULTS.wallride.length) / 2)
}

/** A wall ride made by dragging along the road, and whether it had to be cut to fit. */
export interface WallRideSpan {
  at: number
  length: number
  /** The stretch dragged, in driving order (the shorter way round between the two ends). */
  from: number
  to: number
  /** 'short': the drag was under WALLRIDE_MIN; 'long': over WALLRIDE_MAX (either way it sits on the drag's middle). */
  cut: 'short' | 'long' | null
}

/**
 * The wall ride a drag from `a` to `b` along the road makes: it covers the
 * stretch dragged (the shorter way round, so dragging backwards works too).
 * Too short or too long a drag gets the nearest allowed length, centred on
 * the middle of what was dragged.
 */
export function wallRideFromDrag(rc: RoadCurve, a: number, b: number): WallRideSpan {
  const forward = metresBetween(rc, a, b)
  const backward = metresBetween(rc, b, a)
  const from = forward <= backward ? a : b
  const metres = Math.min(forward, backward)
  const length = Math.round(metres)
  const to = from === a ? b : a
  if (length >= WALLRIDE_MIN && length <= WALLRIDE_MAX) return { at: r3(from), length, from, to, cut: null }
  const fit = length < WALLRIDE_MIN ? WALLRIDE_MIN : WALLRIDE_MAX
  const middle = advanceAt(rc, from, metres / 2)
  return { at: wallRideStartFor(rc, middle, fit), length: fit, from, to, cut: length < WALLRIDE_MIN ? 'short' : 'long' }
}

/**
 * A wall ride's new length with its middle kept where it is: both ends move
 * by the same amount. Returns its new `at`.
 */
export function wallRideResized(rc: RoadCurve, at: number, oldLength: number | undefined, newLength: number): number {
  return wallRideStartFor(rc, wallRideMiddle(rc, at, oldLength), newLength)
}

// ---------------------------------------------------------------- tunnels, by their middle

/** The shortest and longest tunnel the editor makes, metres (the panel's Length slider has the same ends). */
export const TUNNEL_EDIT_MIN = 40
export const TUNNEL_EDIT_MAX = 600

/** Where a tunnel `length` metres long must start so its middle is at `middle`. */
export function tunnelStartFor(rc: RoadCurve, middle: number, length: number): number {
  return r3(advanceAt(rc, middle, -length / 2))
}

/** Where a tunnel's middle is. */
export function tunnelMiddle(rc: RoadCurve, at: number, length: number | undefined): number {
  return advanceAt(rc, at, (length ?? TRACK_DEFAULTS.tunnelLength) / 2)
}

/** A tunnel made by dragging along the road from `a` to `b`: it covers the stretch dragged, kept within the editor's lengths. */
export function tunnelFromDrag(rc: RoadCurve, a: number, b: number): WallRideSpan {
  const forward = metresBetween(rc, a, b)
  const backward = metresBetween(rc, b, a)
  const from = forward <= backward ? a : b
  const metres = Math.min(forward, backward)
  const length = Math.round(metres / 10) * 10
  const to = from === a ? b : a
  if (length >= TUNNEL_EDIT_MIN && length <= TUNNEL_EDIT_MAX) return { at: tunnelStartFor(rc, advanceAt(rc, from, metres / 2), length), length, from, to, cut: null }
  const fit = length < TUNNEL_EDIT_MIN ? TUNNEL_EDIT_MIN : TUNNEL_EDIT_MAX
  return { at: tunnelStartFor(rc, advanceAt(rc, from, metres / 2), fit), length: fit, from, to, cut: length < TUNNEL_EDIT_MIN ? 'short' : 'long' }
}

// ---------------------------------------------------------------- a click becomes a piece

/**
 * A road piece from a click on the road. Pads and ramps go on the side of
 * the road you clicked (kept fully on the road); a click near the middle
 * snaps to the middle. A wall ride's middle goes where you clicked (it needs
 * the road, `rc`, to find where it starts).
 */
export function makeRoadPiece(kind: PlaceKind, hit: RoadHit, halfWidth: number, rc: RoadCurve): Piece | null {
  const at = r2(hit.at)
  const side = wallRideSide(kind)
  if (side) return { type: 'wallride', at: wallRideStartFor(rc, hit.at, TRACK_DEFAULTS.wallride.length), side }
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
    case 'speedtrap':
      return { type: 'speedtrap', at }
    case 'tunnel':
      // Its middle where you clicked.
      return { type: 'tunnel', at: tunnelStartFor(rc, hit.at, TRACK_DEFAULTS.tunnelLength) }
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
  const at = p.type === 'wallride' ? wallRideMiddle(rc, p.at, p.length) : p.type === 'tunnel' ? tunnelMiddle(rc, p.at, p.length) : p.at
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
    case 'tunnel':
      return { length: p.length ?? TRACK_DEFAULTS.tunnelLength, width: roadWidth + 18 }
  }
}
