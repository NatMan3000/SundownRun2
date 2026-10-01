// ============================================================
//  UI STORE - which menu screen is open, and what is focused
// ------------------------------------------------------------
//  The menus are a STACK of screens. The bottom of the stack is
//  decided by the game phase (title screen, pause menu, results);
//  everything above it is somewhere the player navigated to
//  (Play -> mode -> track, or Settings). "Back" pops one screen.
//
//  While driving the stack is empty: no menu, just the HUD.
//
//  Each screen remembers which item had focus, so coming back to
//  a screen puts you where you were.
//
//  This store changes a few times a second at most (menu moves),
//  never per frame, so React can re-render on it freely.
// ============================================================

import { create } from 'zustand'
import type { GameMode } from '../core/store'

export type ScreenId = 'title' | 'mode' | 'track' | 'garage' | 'settings' | 'pause' | 'results'

export const SCREEN_IDS: readonly ScreenId[] = ['title', 'mode', 'track', 'garage', 'settings', 'pause', 'results']

/** The settings menu tabs, in LB/RB order. */
export const SETTINGS_TABS = [
  'car',
  'handling',
  'camera',
  'audio',
  'world',
  'racing',
  'track',
  'graphics',
  'fun',
  'multiplayer',
] as const
export type SettingsTab = (typeof SETTINGS_TABS)[number]

export interface MenuNotice {
  id: number
  text: string
  kind: 'info' | 'error'
}

interface UiState {
  /** Open screens, bottom first. Empty = driving (HUD only). */
  stack: ScreenId[]
  /** Last focused item id per screen. */
  focus: Partial<Record<ScreenId, string>>
  /** The mode picked on the mode screen, used by the track screen's Go. */
  pendingMode: GameMode
  settingsTab: SettingsTab
  /** Name of the track being built while the loading veil is up, else null. */
  loading: string | null
  /** A short message over the menus (a track that would not load, etc). */
  notice: MenuNotice | null
  /** Bumped when the focused item's hints change (a slider moved off its default). */
  hintNonce: number
}

export const useUi = create<UiState>(() => ({
  stack: [],
  focus: {},
  pendingMode: 'free',
  settingsTab: 'car',
  loading: null,
  notice: null,
  hintNonce: 0,
}))

/** The screen on top of the stack, or null while driving. */
export function activeScreen(): ScreenId | null {
  const s = useUi.getState().stack
  return s.length ? s[s.length - 1] : null
}

/** React: the screen on top of the stack. */
export function useActiveScreen(): ScreenId | null {
  return useUi((s) => (s.stack.length ? s.stack[s.stack.length - 1] : null))
}

/** Push a screen on top (Play -> mode, Title -> Settings ...). */
export function openScreen(id: ScreenId): void {
  useUi.setState((s) => (s.stack[s.stack.length - 1] === id ? s : { stack: [...s.stack, id] }))
}

/** Pop the top screen. Returns false if it was the root (nothing to go back to). */
export function closeScreen(): boolean {
  const s = useUi.getState().stack
  if (s.length <= 1) return false
  useUi.setState({ stack: s.slice(0, -1) })
  return true
}

/** Replace the whole stack (the phase changed: title, pause, results, driving). */
export function resetStack(root: ScreenId | null): void {
  useUi.setState({ stack: root ? [root] : [] })
}

export function setFocus(screen: ScreenId, item: string): void {
  if (useUi.getState().focus[screen] === item) return
  useUi.setState((s) => ({ focus: { ...s.focus, [screen]: item } }))
}

let noticeSeq = 0
let noticeTimer: ReturnType<typeof setTimeout> | null = null

/** Show a short message over the menus for a few seconds. */
export function showNotice(text: string, kind: MenuNotice['kind'] = 'info'): void {
  if (noticeTimer) clearTimeout(noticeTimer)
  useUi.setState({ notice: { id: ++noticeSeq, text, kind } })
  noticeTimer = setTimeout(() => {
    noticeTimer = null
    useUi.setState({ notice: null })
  }, 4200)
}
