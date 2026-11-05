// ============================================================
//  FREE MAP - the part of a phone's map no button sits on
// ------------------------------------------------------------
//  Between the tool button's column on the left and the right stack
//  (or the card, when one is open), read from the page as it is now,
//  so it follows whatever the window and the layout did. Null on a
//  computer and on the world map, which frame themselves as they
//  always have.
// ============================================================

import { fitBoxInto } from '../view'

export interface ScreenBox {
  left: number
  top: number
  right: number
  bottom: number
}

/** How far the whole world reaches from its middle, metres (the same world the computer's Whole world button shows). */
const WORLD_HALF = 850

export function freeMapBox(): ScreenBox | null {
  if (typeof document === 'undefined') return null
  const root = document.querySelector('.sre[data-touch]')
  if (!root) return null
  const left = root.querySelector('.phone-left')?.getBoundingClientRect()
  const side = (root.querySelector('.phone-card') ?? root.querySelector('.phone-stack'))?.getBoundingClientRect()
  if (!left || !side) return null
  // (A stack with no size is hidden: a card is coming, and the card's box will be there when it matters.)
  const shown = side.width > 0
  // Stood up, the buttons and the card sit under the map, not beside it.
  if (window.innerHeight > window.innerWidth) return { left: 6, top: 50, right: window.innerWidth - 6, bottom: Math.min(left.top, shown ? side.top : left.top) }
  return { left: left.right, top: 6, right: shown ? side.left : window.innerWidth, bottom: left.bottom }
}

/** The whole world, edge to edge, in a box of the screen. */
export function fitWorldInto(box: ScreenBox): void {
  fitBoxInto(-WORLD_HALF, -WORLD_HALF, WORLD_HALF, WORLD_HALF, box, 4)
}
