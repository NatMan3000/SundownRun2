// ============================================================
//  BUTTON HINTS - "A Select   B Back", drawn for your device
// ------------------------------------------------------------
//  The input system remembers which device was touched last
//  (store.inputDevice). Hints show Xbox buttons when you're on
//  the controller and keyboard keys when you're on the keyboard,
//  and swap the moment you pick up the other one.
//
//  The Xbox glyphs are drawn in CSS (coloured rings with a
//  letter), so there are no image files.
// ============================================================

import { useGame } from '../core/store'
import { useUi } from './uiStore'
import { focusedHandlers } from './nav'

/** Something a hint can name. */
export type HintAction = 'accept' | 'back' | 'tabs' | 'move' | 'adjust' | 'pause' | 'reset' | 'camera' | 'restart'

const PAD: Record<HintAction, string[]> = {
  accept: ['A'],
  back: ['B'],
  tabs: ['LB', 'RB'],
  move: ['DPAD'],
  adjust: ['LEFTRIGHT'],
  pause: ['MENU'],
  reset: ['Y'],
  camera: ['RB'],
  restart: ['VIEW'],
}

const KEYS: Record<HintAction, string[]> = {
  accept: ['Enter'],
  back: ['Esc'],
  tabs: ['Q', 'E'],
  move: ['ARROWS'],
  adjust: ['LEFTRIGHT'],
  pause: ['Esc'],
  reset: ['R'],
  camera: ['C'],
  restart: ['Shift+R'],
}

/** One glyph: an Xbox button or a keyboard key. */
export function Glyph(props: { name: string; pad: boolean }) {
  const { name, pad } = props
  if (name === 'DPAD') {
    return (
      <span className="glyph glyph--dpad" aria-label="d-pad">
        <i />
        <i />
      </span>
    )
  }
  if (name === 'ARROWS') {
    return (
      <span className="glyph glyph--key glyph--arrows" aria-label="arrow keys">
        <span className="glyph__arrow glyph__arrow--up" />
        <span className="glyph__arrow glyph__arrow--down" />
      </span>
    )
  }
  if (name === 'LEFTRIGHT') {
    return pad ? (
      <span className="glyph glyph--dpad glyph--dpad-h" aria-label="d-pad left and right">
        <i />
        <i />
      </span>
    ) : (
      <span className="glyph glyph--key glyph--arrows" aria-label="left and right arrow keys">
        <span className="glyph__arrow glyph__arrow--left" />
        <span className="glyph__arrow glyph__arrow--right" />
      </span>
    )
  }
  if (!pad) return <span className="glyph glyph--key">{name}</span>
  if (name === 'A' || name === 'B' || name === 'X' || name === 'Y') {
    return <span className={`glyph glyph--face glyph--${name.toLowerCase()}`}>{name}</span>
  }
  if (name === 'LS' || name === 'RS') {
    return <span className="glyph glyph--stick">{name}</span>
  }
  if (name === 'MENU') {
    return (
      <span className="glyph glyph--round glyph--menu" aria-label="menu button">
        <i />
        <i />
        <i />
      </span>
    )
  }
  if (name === 'VIEW') {
    return (
      <span className="glyph glyph--round glyph--view" aria-label="view button">
        <i />
        <i />
      </span>
    )
  }
  return <span className="glyph glyph--bumper">{name}</span>
}

/** The glyphs for an action on the current device. */
export function ActionGlyphs(props: { action: HintAction }) {
  const pad = useGame((s) => s.inputDevice) === 'gamepad'
  const names = (pad ? PAD : KEYS)[props.action]
  return (
    <span className="glyphs">
      {names.map((n) => (
        <Glyph key={n} name={n} pad={pad} />
      ))}
    </span>
  )
}

export interface HintItem {
  action: HintAction
  label: string
}

/**
 * The hint bar along the bottom of a menu. `items` are fixed hints;
 * the focused item's own hints (what accept does on it, whether
 * left/right adjusts it) are added in front automatically.
 */
export function HintBar(props: { items: HintItem[]; contextual?: boolean }) {
  // Re-render when focus moves, so the contextual hint follows it.
  useUi((s) => s.focus)
  useUi((s) => s.stack)
  useUi((s) => s.hintNonce)
  const h = props.contextual === false ? null : focusedHandlers()
  const extra: HintItem[] = []
  if (h?.sideHint) extra.push({ action: 'adjust', label: h.sideHint })
  if (h?.acceptHint) extra.push({ action: 'accept', label: h.acceptHint })
  const all = [...extra, ...props.items.filter((i) => !(i.action === 'accept' && h?.acceptHint))]
  return (
    <div className="hintbar">
      {all.map((i) => (
        <span className="hint" key={`${i.action}:${i.label}`}>
          <ActionGlyphs action={i.action} />
          <span className="hint__label">{i.label}</span>
        </span>
      ))}
    </div>
  )
}
