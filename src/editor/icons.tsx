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
/** A stretch of road pulled up into a smooth bump: Bend. */
export const BendIcon = () => (
  <Svg>
    <path d="M2 19c4.5 0 5.5-8 10-8s5.5 8 10 8" />
    <circle cx="12" cy="11" r="1.6" />
    <path d="M12 7.5V3M9.8 5.2L12 3l2.2 2.2" />
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
/** Two spots joined by one smooth arc, its middle pulled out: Curve. */
export const CurveIcon = () => (
  <Svg>
    <circle cx="4" cy="18.5" r="2" />
    <circle cx="20" cy="18.5" r="2" />
    <path d="M5 16.8C6.5 9.5 9 6.5 12 6.5s5.5 3 7 10.3" />
    <path d="M12 6.5V2.5" strokeDasharray="1.2 2" />
  </Svg>
)
export const SelectIcon = () => (
  <Svg>
    <path d="M5 3l13 8-6 1.5L9 19z" />
  </Svg>
)
export const SectionIcon = () => (
  <Svg>
    <path d="M3 17c4-8 14-8 18 0" />
    <path d="M7 10.5l-1.5-3M17 10.5l1.5-3" />
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
export const FitIcon = () => (
  <Svg>
    <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
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
export const PlusIcon = () => (
  <Svg>
    <path d="M12 5v14M5 12h14" />
  </Svg>
)
export const MinusIcon = () => (
  <Svg>
    <path d="M5 12h14" />
  </Svg>
)
