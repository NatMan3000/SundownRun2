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
export const PlaceIcon = () => (
  <Svg>
    <rect x="4" y="9" width="12" height="6" rx="1.5" />
    <path d="M7 10.5l2.5 1.5L7 13.5M11 10.5l2.5 1.5L11 13.5" />
    <path d="M19 4v6M16 7h6" />
  </Svg>
)
export const HandIcon = () => (
  <Svg>
    <path d="M8 12V6a1.5 1.5 0 013 0v5M11 11V4.5a1.5 1.5 0 013 0V11M14 11V6a1.5 1.5 0 013 0v7c0 4-2.5 7-6 7-2.5 0-4-1.3-5.5-3.5L3.8 13a1.5 1.5 0 012.4-1.8L8 13.5" />
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
