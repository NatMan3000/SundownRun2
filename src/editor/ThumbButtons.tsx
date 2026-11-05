// ============================================================
//  THUMB BUTTONS - what the other thumb does while one finger works the map
// ------------------------------------------------------------
//  Two jobs a computer gives to keys, for a phone held on its side:
//    Pencil   "Straight line"  (a computer's Shift): the line from here on is dead straight
//             to your finger; tap again and it carries on freehand.
//    Bend     "less" and "more" reach  (a computer's wheel and [ ]): how much road comes
//             along with your hand, the same 1.25 times a step as the keys.
//
//  This file holds the state and the buttons, and nothing else: Overlay.tsx reads
//  `useThumb` and registers `thumbHands`. The buttons are one small component so the
//  phone layout can move them wherever they belong (they are placed by `.sre-thumb`
//  in editor.css, a marked block at its end). Shown on a phone only.
// ============================================================

import { create } from 'zustand'
import { useGame } from '../core/store'
import { useEditor } from './draft'

/** The thumb's state: read by Overlay.tsx, written by the buttons. */
export const useThumb = create<{ straightLine: boolean }>(() => ({ straightLine: false }))

/** What the buttons ask of the map. Overlay.tsx fills it in while it is mounted. */
export const thumbHands: { bendReach: (more: boolean) => void } = { bendReach: () => {} }

/**
 * A button that acts the moment the thumb lands, not when it lifts (a tap on the map would be answered late), and still works from a keyboard.
 * (A real click right after a pointerdown has `detail` 1 or more; a key press has 0.)
 */
function thumbPress(act: () => void) {
  return {
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault()
      act()
    },
    onClick: (e: React.MouseEvent) => {
      if (e.detail === 0) act()
    },
  }
}

export function ThumbButtons() {
  const touch = useGame((s) => s.inputDevice === 'touch' && !s.mapOpen)
  const tool = useEditor((s) => (s.mode === 'edit' ? s.tool : null))
  const straight = useThumb((s) => s.straightLine)
  const reach = useEditor((s) => s.bendReach)
  if (!touch) return null
  if (tool === 'pencil') {
    return (
      <div className="sre-thumb" data-testid="thumb-buttons">
        <button type="button" className={straight ? 'sre-thumb-btn is-on' : 'sre-thumb-btn'} aria-pressed={straight} data-testid="thumb-straight" {...thumbPress(() => useThumb.setState({ straightLine: !useThumb.getState().straightLine }))}>
          Straight line
        </button>
      </div>
    )
  }
  if (tool === 'bend') {
    return (
      <div className="sre-thumb" data-testid="thumb-buttons">
        <button type="button" className="sre-thumb-btn" aria-label="Less road comes along" data-testid="thumb-less" {...thumbPress(() => thumbHands.bendReach(false))}>
          -
        </button>
        <span className="sre-thumb-label">Reach {reach} m</span>
        <button type="button" className="sre-thumb-btn" aria-label="More road comes along" data-testid="thumb-more" {...thumbPress(() => thumbHands.bendReach(true))}>
          +
        </button>
      </div>
    )
  }
  return null
}
