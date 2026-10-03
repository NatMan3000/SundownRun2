// ============================================================
//  BILLBOARD KINDS - the five shapes of billboard
// ------------------------------------------------------------
//  Every billboard beside the road is one of these:
//
//    panel   the classic: a wide hologram on one tall pole
//    banner  a tall hologram hanging from a mast
//    sign    a small square hologram on a short post
//    screen  a big double-width screen on two legs, a real dark
//            screen box behind the picture, flipping between
//            two ads
//    cube    a hologram cube spinning slowly on top of a mast,
//            a different ad on each of its four sides
//
//  This file is only numbers (metres), so the builder in
//  Billboards.tsx, the colliders and the planner that picks a
//  kind for each spot (billboardPlan.ts) all agree on sizes.
//
//  The local frame of a billboard: it stands at (0, 0, 0) on the
//  ground, +y up, and the road is in the -z direction (it faces
//  the road). +x runs along the road.
// ============================================================

import type { AdShape } from './ads/adKit'

export type BoardKind = 'panel' | 'banner' | 'sign' | 'screen' | 'cube'

/** A box of the frame (poles, legs, heads, light strips), in the billboard's local frame. */
export interface FrameBox {
  w: number
  h: number
  d: number
  x: number
  y: number
  z: number
  /** 1 = a violet light strip (glow T1), 0 = dark metal. */
  glow: 0 | 1
  /** Solid boxes get a collider: you crash into them. */
  solid: boolean
}

export interface KindSpec {
  kind: BoardKind
  /** The shape of ad it shows. */
  shape: AdShape
  /** How many different ads it shows (a screen flips between 2, a cube has 4 sides). */
  ads: number
  /** The picture's size and the height of its middle, metres. */
  panelW: number
  panelH: number
  panelMidY: number
  /** How far toward the road the picture sits in front of its pole (or, for a cube, how far each side is from the middle). */
  panelForward: number
  /** How the picture is drawn: 0 floating hologram, 1 big screen (lit dots, flips between two ads), 2 spinning cube side. */
  style: 0 | 1 | 2
  /** Brightness of the picture relative to GLOW.T1. Big pictures are a little dimmer so they never out-glow the road. */
  glow: number
  /** Half the width it needs along the road, metres (the planner keeps it clear of the road and the neighbours). */
  halfSpan: number
  frame: FrameBox[]
}

const box = (w: number, h: number, d: number, x: number, y: number, z: number, glow: 0 | 1 = 0, solid = false): FrameBox => ({ w, h, d, x, y, z, glow, solid })

/** A light strip up the road side of a pole. */
const strip = (h: number, y: number, z: number, x = 0): FrameBox => box(0.12, h, 0.08, x, y, z, 1)

const POLE = 0.7
const POLE_H = 10.6

export const KINDS: Record<BoardKind, KindSpec> = {
  panel: {
    kind: 'panel',
    shape: 'wide',
    ads: 1,
    panelW: 13,
    panelH: 6.5,
    panelMidY: 11.4 + 3.25,
    panelForward: 0,
    style: 0,
    glow: 1,
    halfSpan: 6.5,
    frame: [
      box(1.8, 1.8, 1.8, 0, -0.3, 0, 0, true), // plinth, sunk into the ground for slopes
      box(POLE, POLE_H, POLE, 0, POLE_H / 2, 0, 0, true),
      box(1.8, 0.7, 1.2, 0, POLE_H + 0.1, 0, 0, true), // the projector head
      strip(POLE_H - 1.6, POLE_H / 2 + 0.4, -POLE / 2 - 0.03),
      strip(POLE_H - 1.6, POLE_H / 2 + 0.4, POLE / 2 + 0.03),
      box(1.5, 0.08, 0.9, 0, POLE_H + 0.49, 0, 1),
    ],
  },
  banner: {
    kind: 'banner',
    shape: 'tall',
    ads: 1,
    panelW: 6.5,
    panelH: 13,
    panelMidY: 4.6 + 6.5,
    panelForward: 1.1,
    style: 0,
    glow: 1,
    halfSpan: 3.5,
    frame: [
      box(1.6, 1.6, 1.6, 0, -0.3, 0, 0, true),
      box(0.6, 18.4, 0.6, 0, 9.2, 0, 0, true), // the mast
      box(0.35, 0.35, 1.5, 0, 17.9, -0.6, 0, true), // top arm, out over the banner
      box(0.35, 0.35, 1.5, 0, 4.3, -0.6, 0, true), // bottom arm
      box(1.4, 0.12, 0.5, 0, 17.66, -1.1, 1), // the projector strips that "hold" the hologram
      box(1.4, 0.12, 0.5, 0, 4.54, -1.1, 1),
      strip(16.4, 9.4, -0.33),
    ],
  },
  sign: {
    kind: 'sign',
    shape: 'square',
    ads: 1,
    panelW: 5.6,
    panelH: 5.6,
    panelMidY: 3.9 + 2.8,
    panelForward: 0,
    style: 0,
    glow: 1,
    halfSpan: 3,
    frame: [
      box(1.2, 1.2, 1.2, 0, -0.2, 0, 0, true),
      box(0.45, 3.4, 0.45, 0, 1.7, 0, 0, true),
      box(1.3, 0.45, 0.8, 0, 3.55, 0, 0, true),
      strip(2.6, 1.9, -0.26),
      box(1.1, 0.06, 0.6, 0, 3.8, 0, 1),
    ],
  },
  screen: {
    kind: 'screen',
    shape: 'wide',
    ads: 2,
    panelW: 24,
    panelH: 12,
    panelMidY: 12.6 + 6,
    panelForward: 0.1,
    style: 1,
    glow: 0.8,
    halfSpan: 12.6,
    frame: [
      box(1.8, 1.6, 1.8, -7.5, -0.3, 0.45, 0, true),
      box(1.8, 1.6, 1.8, 7.5, -0.3, 0.45, 0, true),
      box(0.9, 12.8, 0.9, -7.5, 6.4, 0.45, 0, true), // the legs
      box(0.9, 12.8, 0.9, 7.5, 6.4, 0.45, 0, true),
      box(24.8, 12.8, 0.7, 0, 12.6 + 6, 0.45, 0, true), // the dark screen box behind the picture
      strip(11.6, 6.4, 0.45 - 0.48, -7.5),
      strip(11.6, 6.4, 0.45 - 0.48, 7.5),
      box(24.8, 0.12, 0.1, 0, 12.6 - 0.36, 0.02, 1), // a light line under the screen
    ],
  },
  cube: {
    kind: 'cube',
    shape: 'square',
    ads: 4,
    panelW: 6.4,
    panelH: 6.4,
    panelMidY: 13.4 + 0.9 + 3.2,
    panelForward: 3.2,
    style: 2,
    glow: 0.9,
    halfSpan: 4.6,
    frame: [
      box(1.8, 1.8, 1.8, 0, -0.3, 0, 0, true),
      box(POLE, 13.4, POLE, 0, 6.7, 0, 0, true),
      box(2.4, 0.5, 2.4, 0, 13.6, 0, 0, true), // the projector dish the cube spins above
      box(2.0, 0.08, 2.0, 0, 13.89, 0, 1),
      strip(11.8, 6.9, -POLE / 2 - 0.03),
      strip(11.8, 6.9, POLE / 2 + 0.03),
    ],
  },
}

/** A spinning cube turns this fast, radians a second (one turn in about 25 s: calm, never a blur). */
export const CUBE_SPIN = 0.25
/** A big screen shows each of its two ads this long, seconds, before it wipes to the other. */
export const SCREEN_HOLD = 7
