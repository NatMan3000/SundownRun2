// ============================================================
//  EDITOR ICONS - small line drawings for the tool buttons
// ------------------------------------------------------------
//  Inline SVG, drawn in code like everything else in the game, so
//  there are no image files to load. They take the button's text
//  colour (currentColor), so an active tool glows the accent colour.
// ============================================================

import type { CSSProperties, ReactNode } from 'react'

function Svg(p: { children: ReactNode; style?: CSSProperties }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={p.style}>
      {p.children}
    </svg>
  )
}

export const PencilIcon = () => (
  <Svg>
    <path d="M4 20l4-1 11-11-3-3L5 16l-1 4z" />
    <path d="M14 7l3 3" />
  </Svg>
)
/**
 * Bend: one spot of a straight road (dashed, where it was) grabbed and pulled,
 * the road either side following it. The hand is the dot, the arrow the pull.
 */
export const BendIcon = () => (
  <Svg>
    <path d="M2 20h20" strokeDasharray="1.5 2.5" opacity="0.6" />
    <path d="M2 20c5 0 6-9 10-9s5 9 10 9" />
    <circle cx="12" cy="11" r="2.2" fill="currentColor" stroke="none" />
    <path d="M12 7.5V2.5M9.8 4.7L12 2.5l2.2 2.2" />
  </Svg>
)
/** Two spots joined by a dead straight line: Straight. */
export const StraightIcon = () => (
  <Svg>
    <circle cx="5" cy="18.5" r="2" />
    <circle cx="19" cy="5.5" r="2" />
    <path d="M6.5 17.1L17.5 6.9" />
  </Svg>
)
/** Curve: a start and an end (the two rings) joined by one even arc, like a piece of a circle. */
export const CurveIcon = () => (
  <Svg>
    <circle cx="4.5" cy="17.5" r="2" />
    <circle cx="19.5" cy="17.5" r="2" />
    <path d="M5.6 15.8A8.6 8.6 0 0 1 18.4 15.8" />
    <path d="M12 12.5v-3" strokeDasharray="1.2 1.8" opacity="0.7" />
  </Svg>
)
export const SelectIcon = () => (
  <Svg>
    <path d="M5 3l13 8-6 1.5L9 19z" />
  </Svg>
)
/** Height: road seen from the side, up a ramp onto a raised deck and down again, with an arrow lifting it. */
export const HeightIcon = () => (
  <Svg>
    <path d="M2 20.5h20" opacity="0.6" />
    <path d="M2 20.5l5-8h10l5 8" />
    <path d="M12 18.5v-4.5M9.9 16l2.1-2.1 2.1 2.1" />
    <path d="M12 9V3M9.9 5.1L12 3l2.1 2.1" />
  </Svg>
)
/** Bank: the road seen end-on, tipped up at one side, with an arrow showing the tilt. */
export const BankIcon = () => (
  <Svg>
    <path d="M2.5 20.5h19" opacity="0.6" />
    <path d="M4 18l16-7" strokeWidth="2.6" />
    <path d="M7.5 8.5a8 8 0 0 1 9-3.2" />
    <path d="M14.4 3.6l2.1 1.7-1.6 2.2" />
  </Svg>
)
/** Width: the road from above (its two edges), with arrows pushing the edges out. */
export const WidthIcon = () => (
  <Svg>
    <path d="M8.5 3v18M15.5 3v18" />
    <path d="M12 4v2.5M12 10.75v2.5M12 17.5V20" opacity="0.6" />
    <path d="M6 12H1.5M3.5 10l-2 2 2 2M18 12h4.5M20.5 10l2 2-2 2" />
  </Svg>
)
/**
 * Place pieces: a road running away from you (like a road sign), with a
 * boost pad's chevrons on it and a plus beside it, so it reads "put things
 * on the road".
 */
export const PiecesIcon = () => (
  <Svg>
    <path d="M3 21.5L8.8 4.5M18 21.5L12.2 4.5" />
    <path d="M7.6 16.6l2.9-2.6 2.9 2.6M7.9 20.3l2.6-2.4 2.6 2.4" />
    <path d="M19.5 2.5v6M16.5 5.5h6" />
  </Svg>
)
/** A dice showing five: Random track. */
export const DiceIcon = () => (
  <Svg>
    <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
    <g fill="currentColor" stroke="none">
      <circle cx="8.4" cy="8.4" r="1.5" />
      <circle cx="15.6" cy="8.4" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="8.4" cy="15.6" r="1.5" />
      <circle cx="15.6" cy="15.6" r="1.5" />
    </g>
  </Svg>
)
export const UndoIcon = (p: { flip?: boolean }) => (
  <Svg style={p.flip ? { transform: 'scaleX(-1)' } : undefined}>
    <path d="M9 14L4 9l5-5" />
    <path d="M4 9h10a6 6 0 010 12h-3" />
  </Svg>
)
/** An eraser rubbing out a line: Clear all. */
export const ClearIcon = () => (
  <Svg>
    <path d="M8.5 19.5L4 15a1.6 1.6 0 010-2.3l8.7-8.7a1.6 1.6 0 012.3 0l5 5a1.6 1.6 0 010 2.3l-8 8.2" />
    <path d="M8.5 9.2l6.3 6.3" />
    <path d="M8.5 19.5H20" />
  </Svg>
)
/** Fit track: a loop of road with the screen's corners closing in round it. */
export const FitIcon = () => (
  <Svg>
    <path d="M3 8V3h5M21 8V3h-5M3 16v5h5M21 16v5h-5" />
    <ellipse cx="12" cy="12" rx="5" ry="3.5" />
  </Svg>
)
export const GlobeIcon = () => (
  <Svg>
    <circle cx="12" cy="12" r="8" />
    <path d="M4 12h16M12 4c2.5 2.5 2.5 13.5 0 16M12 4c-2.5 2.5-2.5 13.5 0 16" />
  </Svg>
)
export const LibraryIcon = () => (
  <Svg>
    <path d="M5 4h4v16H5zM10 4h4v16h-4zM15.5 5l3.5-1 3 15-3.5 1z" />
  </Svg>
)
/** Zoom in: a magnifying glass with a plus. */
export const PlusIcon = () => (
  <Svg>
    <circle cx="10" cy="10" r="6.5" />
    <path d="M15 15l6 6M10 7v6M7 10h6" />
  </Svg>
)
/** Zoom out: a magnifying glass with a minus. */
export const MinusIcon = () => (
  <Svg>
    <circle cx="10" cy="10" r="6.5" />
    <path d="M15 15l6 6M7 10h6" />
  </Svg>
)
