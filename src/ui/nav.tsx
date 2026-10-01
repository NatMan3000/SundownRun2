// ============================================================
//  NAVIGATION - one focus model for every menu
// ------------------------------------------------------------
//  Every menu works the same way with a controller, a keyboard
//  or a mouse:
//
//   - Each thing you can pick is a "nav item": a button, a slider
//     row, a track card, a colour swatch. Components register with
//     useNavItem(id, handlers) inside a <NavScreen>.
//   - The input system (src/core/controls.ts) turns d-pad, stick,
//     arrows, Enter, Esc, LB/RB into menuBus actions. We listen to
//     menuBus here and nowhere else, so menus never read the raw
//     keyboard (and arrow keys never leak into the car).
//   - up/down/left/right move focus to the nearest item in that
//     direction on screen ("spatial navigation"), so any layout -
//     a list, a grid of cards, a row of swatches - just works.
//   - A slider eats left/right to change its value instead of
//     moving focus. Holding the button speeds it up.
//   - The mouse focuses what it hovers and clicks what it clicks.
//
//  Focus is our own state (useUi.focus), not the browser's focus,
//  so a mouse click never leaves a button "focused" that Enter
//  would then press a second time.
// ============================================================

import { createContext, useContext, useEffect, useLayoutEffect, useRef } from 'react'
import type { ReactNode, RefObject, PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from 'react'
import { menuBus } from '../core/controls'
import type { InputDevice, MenuAction } from '../core/controls'
import { audio } from '../core/api'
import type { UiSound } from '../core/api'
import { activeScreen, setFocus, useUi } from './uiStore'
import type { ScreenId } from './uiStore'

export interface NavHandlers {
  /** A / Enter / click. */
  onAccept?: () => void
  /**
   * Left / right on this item. Return true when the item used the press
   * (a slider changed value); return false or nothing to move focus instead.
   * `streak` counts quick repeats of the same press (hold-to-accelerate).
   */
  onLeft?: (streak: number) => boolean | void
  onRight?: (streak: number) => boolean | void
  /** Mouse click, when it should differ from accept (a slider sets its value by position). */
  onClick?: (e: ReactMouseEvent) => void
  /** Sound for accept: default 'select'; null when the handler plays its own. */
  acceptSound?: UiSound | null
  /** What accept does here, for the button hint bar ("Reset to default"). */
  acceptHint?: string
  /** What left/right does here ("Adjust"). */
  sideHint?: string
  /** One line describing the focused item, shown in the screen's help line. */
  help?: string
  /** Greyed out: focus skips it and accept does nothing. */
  disabled?: boolean
  /**
   * Items that share a group (the tab row, a swatch row). Moving INTO a
   * group from outside lands on its `entry` item (the active tab, the
   * chosen swatch) rather than whichever is geometrically closest.
   */
  group?: string
  entry?: boolean
}

interface Item {
  id: string
  el: HTMLElement | null
  h: { current: NavHandlers }
}

interface ScreenReg {
  items: Map<string, Item>
  onBack: (() => void) | undefined
  onTab: ((dir: -1 | 1) => void) | undefined
  initial: string | undefined
}

const registry = new Map<ScreenId, ScreenReg>()

function regFor(screen: ScreenId): ScreenReg {
  let r = registry.get(screen)
  if (!r) {
    r = { items: new Map(), onBack: undefined, onTab: undefined, initial: undefined }
    registry.set(screen, r)
  }
  return r
}

const NavCtx = createContext<ScreenId>('title')

/** The screen that the items inside belong to. */
export function NavScreen(props: {
  id: ScreenId
  /** Back / B / Esc. Leave out on a screen where back does nothing. */
  onBack?: () => void
  /** LB / RB (Q / E). */
  onTab?: (dir: -1 | 1) => void
  /** Item focused the first time the screen opens. */
  initial?: string
  children: ReactNode
}) {
  const { id, onBack, onTab, initial } = props
  useLayoutEffect(() => {
    const r = regFor(id)
    r.onBack = onBack
    r.onTab = onTab
    r.initial = initial
  })
  useEffect(() => {
    ensureFocus(id)
  }, [id])
  return <NavCtx.Provider value={id}>{props.children}</NavCtx.Provider>
}

/** The screen id of the surrounding <NavScreen>. */
export function useNavScreen(): ScreenId {
  return useContext(NavCtx)
}

let ensureQueued = false
function queueEnsure(screen: ScreenId): void {
  if (ensureQueued) return
  ensureQueued = true
  queueMicrotask(() => {
    ensureQueued = false
    ensureFocus(screen)
  })
}

function usable(it: Item | undefined): it is Item {
  return !!it && !!it.el && it.el.isConnected && !it.h.current.disabled
}

/** Make sure the screen's focus points at a real, enabled item. */
export function ensureFocus(screen: ScreenId): void {
  const r = registry.get(screen)
  if (!r) return
  const cur = useUi.getState().focus[screen]
  if (cur && usable(r.items.get(cur))) return
  if (r.initial && usable(r.items.get(r.initial))) {
    setFocus(screen, r.initial)
    return
  }
  // First usable item in page order.
  let first: Item | null = null
  for (const it of r.items.values()) {
    if (!usable(it)) continue
    if (!first || (first.el!.compareDocumentPosition(it.el!) & Node.DOCUMENT_POSITION_PRECEDING) !== 0) first = it
  }
  if (first) setFocus(screen, first.id)
}

/** Move focus straight to an item (e.g. after a screen opens with a choice pre-selected). */
export function focusItem(screen: ScreenId, id: string): void {
  const it = registry.get(screen)?.items.get(id)
  if (!usable(it)) {
    // Never leave focus on something that isn't on screen.
    ensureFocus(screen)
    return
  }
  setFocus(screen, id)
  scrollIntoNavView(it.el)
}

/** The DOM element that currently has menu focus (for the focus ring). */
export function focusedElement(): HTMLElement | null {
  const screen = activeScreen()
  if (!screen) return null
  const id = useUi.getState().focus[screen]
  if (!id) return null
  const it = registry.get(screen)?.items.get(id)
  return it && it.el && it.el.isConnected ? it.el : null
}

/** Handlers of the focused item (the hint bar reads what accept does). */
export function focusedHandlers(): NavHandlers | null {
  const screen = activeScreen()
  if (!screen) return null
  const id = useUi.getState().focus[screen]
  if (!id) return null
  return registry.get(screen)?.items.get(id)?.h.current ?? null
}

// ---------------------------------------------------------------- items

export interface NavItemBinding<T extends HTMLElement> {
  ref: RefObject<T | null>
  focused: boolean
  /** Spread onto the element. */
  props: {
    'data-nav': string
    onPointerMove: (e: ReactPointerEvent) => void
    onClick: (e: ReactMouseEvent) => void
  }
}

/** Register a pickable thing. Spread `props` on the element and attach `ref`. */
export function useNavItem<T extends HTMLElement = HTMLElement>(id: string, handlers: NavHandlers): NavItemBinding<T> {
  const screen = useContext(NavCtx)
  const ref = useRef<T | null>(null)
  const h = useRef<NavHandlers>(handlers)
  useLayoutEffect(() => {
    const before = h.current
    h.current = handlers
    // The hint bar and help line show the focused item's hints; tell them when those change.
    if (
      (before.acceptHint !== handlers.acceptHint || before.sideHint !== handlers.sideHint || before.help !== handlers.help) &&
      useUi.getState().focus[screen] === id
    ) {
      useUi.setState((s) => ({ hintNonce: s.hintNonce + 1 }))
    }
  })
  useLayoutEffect(() => {
    const r = regFor(screen)
    const item: Item = { id, el: ref.current, h }
    r.items.set(id, item)
    queueEnsure(screen)
    return () => {
      if (r.items.get(id) === item) r.items.delete(id)
      queueEnsure(screen)
    }
  }, [screen, id])
  const focused = useUi((s) => s.focus[screen] === id)
  return {
    ref,
    focused,
    props: {
      'data-nav': id,
      onPointerMove: (e) => {
        if (e.pointerType !== 'mouse' || (e.movementX === 0 && e.movementY === 0)) return
        if (h.current.disabled || useUi.getState().focus[screen] === id) return
        if (activeScreen() !== screen) return
        setFocus(screen, id)
        audio.ui('move')
      },
      onClick: (e) => {
        if (activeScreen() !== screen || h.current.disabled) return
        audio.unlock()
        setFocus(screen, id)
        if (h.current.onClick) {
          h.current.onClick(e)
          return
        }
        if (h.current.onAccept) {
          const snd = h.current.acceptSound === undefined ? 'select' : h.current.acceptSound
          if (snd) audio.ui(snd)
          h.current.onAccept()
        }
      },
    },
  }
}

// ---------------------------------------------------------------- spatial movement

type Dir = 'up' | 'down' | 'left' | 'right'

/** Pick the nearest usable item from `from` in direction `dir`. */
function pickInDirection(r: ScreenReg, fromId: string, dir: Dir): Item | null {
  const fromItem = r.items.get(fromId)
  if (!fromItem?.el) return null
  const a = fromItem.el.getBoundingClientRect()
  const acx = a.left + a.width / 2
  const acy = a.top + a.height / 2
  let best: Item | null = null
  let bestScore = Infinity
  const scores = new Map<Item, number>()
  for (const it of r.items.values()) {
    if (it === fromItem || !usable(it)) continue
    const b = it.el!.getBoundingClientRect()
    if (b.width === 0 && b.height === 0) continue
    const bcx = b.left + b.width / 2
    const bcy = b.top + b.height / 2
    let primary: number
    let gap: number // distance between the two boxes on the other axis (0 when they overlap)
    let off: number
    if (dir === 'down' || dir === 'up') {
      primary = dir === 'down' ? bcy - acy : acy - bcy
      if (primary <= 2) continue
      // must actually be below / above, not just a taller neighbour
      if (dir === 'down' ? b.top < a.top + 2 : b.bottom > a.bottom - 2) continue
      gap = Math.max(0, b.left - a.right, a.left - b.right)
      off = Math.abs(bcx - acx)
    } else {
      primary = dir === 'right' ? bcx - acx : acx - bcx
      if (primary <= 2) continue
      if (dir === 'right' ? b.left < a.left + 2 : b.right > a.right - 2) continue
      gap = Math.max(0, b.top - a.bottom, a.top - b.bottom)
      off = Math.abs(bcy - acy)
    }
    const score = primary + gap * 4 + off * 0.15
    scores.set(it, score)
    if (score < bestScore) {
      bestScore = score
      best = it
    }
  }
  // Entering a group (tab row, swatch row) from outside lands on its entry item.
  const g = best?.h.current.group
  if (best && g && g !== fromItem.h.current.group) {
    for (const it of r.items.values()) {
      if (it.h.current.group === g && it.h.current.entry && scores.has(it)) return it
    }
  }
  return best
}

/** Smoothly scroll a focused item into view inside its `.nav-scroll` container. */
function scrollIntoNavView(el: HTMLElement | null): void {
  if (!el) return
  const box = el.closest('.nav-scroll') as HTMLElement | null
  if (!box) return
  const er = el.getBoundingClientRect()
  const br = box.getBoundingClientRect()
  const pad = Math.min(48, br.height * 0.15)
  let target = box.scrollTop
  if (er.top < br.top + pad) target += er.top - (br.top + pad)
  else if (er.bottom > br.bottom - pad) target += er.bottom - (br.bottom - pad)
  if (target !== box.scrollTop) box.scrollTo({ top: target, behavior: 'smooth' })
}

function moveFocus(screen: ScreenId, dir: Dir): boolean {
  const r = registry.get(screen)
  if (!r) return false
  const cur = useUi.getState().focus[screen]
  if (!cur || !usable(r.items.get(cur))) {
    ensureFocus(screen)
    return false
  }
  const next = pickInDirection(r, cur, dir)
  if (!next) return false
  setFocus(screen, next.id)
  scrollIntoNavView(next.el)
  return true
}

// ---------------------------------------------------------------- the menuBus listener

/** Quick repeats of the same press within this window count as a hold. */
const STREAK_MS = 260
let lastAction: MenuAction | null = null
let lastActionAt = 0
let streak = 0

/** Last time a menu action arrived (the pause watcher uses it to avoid double handling). */
export const navTiming = { lastBackAt: 0 }

/** The last few menu actions received, for the `ui` inspector (checkers read this). */
export const navLog: string[] = []

/** Handle one menu action. The menuBus calls this; dev tools can too (window.__dev.uiNav). */
export function handleMenuAction(action: MenuAction, device: InputDevice): void {
  const screen = activeScreen()
  navLog.push(`${Math.round(performance.now())} ${device} ${action} @${screen ?? '-'}:${screen ? useUi.getState().focus[screen] ?? '-' : '-'}`)
  if (navLog.length > 24) navLog.shift()
  if (!screen) return
  if (useUi.getState().loading) return
  const now = performance.now()
  streak = action === lastAction && now - lastActionAt < STREAK_MS ? streak + 1 : 0
  lastAction = action
  lastActionAt = now
  audio.unlock()

  const r = registry.get(screen)
  if (!r) return
  const focusId = useUi.getState().focus[screen]
  const item = focusId ? r.items.get(focusId) : undefined
  const h = usable(item) ? item.h.current : null

  switch (action) {
    case 'accept': {
      if (!h) {
        ensureFocus(screen)
        return
      }
      if (!h.onAccept) return
      const snd = h.acceptSound === undefined ? 'select' : h.acceptSound
      if (snd) audio.ui(snd)
      h.onAccept()
      return
    }
    case 'back':
      navTiming.lastBackAt = now
      if (r.onBack) {
        audio.ui('back')
        r.onBack()
      }
      return
    case 'tabPrev':
    case 'tabNext':
      if (r.onTab) {
        audio.ui('move')
        r.onTab(action === 'tabPrev' ? -1 : 1)
      }
      return
    case 'left':
    case 'right': {
      const fn = action === 'left' ? h?.onLeft : h?.onRight
      if (fn && fn(streak) === true) return
      if (moveFocus(screen, action)) audio.ui('move')
      return
    }
    case 'up':
    case 'down':
      if (moveFocus(screen, action)) audio.ui('move')
      return
  }
}

/** Mount once (UiRoot): routes menuBus actions to the open screen. */
export function useMenuBus(): void {
  useEffect(() => menuBus.on(handleMenuAction), [])
}

/** Step multiplier for a held slider: 1, then faster the longer it is held. */
export function holdMultiplier(s: number): number {
  if (s < 4) return 1
  if (s < 10) return 2
  if (s < 18) return 4
  return 8
}
