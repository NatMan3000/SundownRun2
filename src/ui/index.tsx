// ============================================================
//  UI ROOT - every screen and the HUD, as a DOM overlay
// ------------------------------------------------------------
//  <UiRoot /> sits on top of the 3D canvas (App.tsx mounts it).
//  The world keeps rendering underneath, so the UI frames the
//  game rather than covering it.
//
//  What lives here:
//    - the palette as CSS variables (ui.css reads only these, so
//      every colour comes from src/core/palette.ts)
//    - which screen is open, kept in step with the game phase
//      (title screen, pause menu, results, or the HUD while driving)
//    - the pause button watcher (Esc / Menu)
//    - the loading veil, menu notices and the focus ring
//    - dev handles: window.__dev.ui('settings'), __dev.uiNav('down'),
//      window.__game.get('ui')
//
//  Folder map:
//    nav.tsx        the focus model (controller, keyboard, mouse)
//    widgets.tsx    buttons, sliders, toggles, colour pickers
//    hints.tsx      device-aware button glyphs
//    screens/       title, mode, track, garage, settings, pause, results
//    hud/           the driving HUD and minimap
// ============================================================

import { useEffect, useRef } from 'react'
import type { CSSProperties, JSX, RefObject } from 'react'
import './ui.css'
import { FONTS, PALETTE } from '../core/palette'
import { getGame, useGame } from '../core/store'
import type { Phase } from '../core/store'
import { controlSignals, inputState, setInputContext } from '../core/controls'
import type { InputDevice, MenuAction } from '../core/controls'
import { endSession, pauseGame, resumeGame, showResults, startSession } from '../core/session'
import { audio } from '../core/api'
import { registerDev, registerInspector } from '../core/devHandles'
import { handleMenuAction, navLog, navTiming, useMenuBus, focusedElement } from './nav'
import { SCREEN_IDS, SETTINGS_TABS, openScreen, resetStack, useActiveScreen, useUi } from './uiStore'
import type { ScreenId, SettingsTab } from './uiStore'
import { FocusRing } from './FocusRing'
import { HUD_DEMO_HELP, hudDemo } from './hud/demo'
import { Hud } from './hud/Hud'
import { TitleScreen } from './screens/Title'
import { ModeSelectScreen } from './screens/ModeSelect'
import { TrackSelectScreen } from './screens/TrackSelect'
import { SettingsScreen } from './screens/Settings'
import { PauseScreen } from './screens/Pause'
import { GarageScreen } from './screens/Garage'
import { ResultsScreen } from './screens/Results'

// ---------------------------------------------------------------- palette -> CSS variables

const CSS_VARS: CSSProperties = {
  ['--panel' as string]: PALETTE.uiPanel,
  ['--panel-solid' as string]: PALETTE.uiPanelSolid,
  ['--line' as string]: PALETTE.uiLine,
  ['--text' as string]: PALETTE.uiText,
  ['--dim' as string]: PALETTE.uiDim,
  ['--accent' as string]: PALETTE.uiAccent,
  ['--accent2' as string]: PALETTE.uiAccent2,
  ['--warn' as string]: PALETTE.uiWarn,
  ['--good' as string]: PALETTE.uiGood,
  ['--bad' as string]: PALETTE.uiBad,
  ['--sun-top' as string]: PALETTE.sunTop,
  ['--sun-mid' as string]: PALETTE.sunMid,
  ['--sun-bottom' as string]: PALETTE.sunBottom,
  ['--sky-zenith' as string]: PALETTE.skyZenithDusk,
  ['--sky-mid' as string]: PALETTE.skyMidDusk,
  ['--ink' as string]: PALETTE.ground,
  ['--boost-c' as string]: PALETTE.boost,
  ['--ghost' as string]: PALETTE.ghost,
  ['--core' as string]: PALETTE.core,
  ['--tag-it' as string]: PALETTE.tagIt,
  ['--font-display' as string]: FONTS.display,
  ['--font-body' as string]: FONTS.body,
  ['--font-mono' as string]: FONTS.mono,
}

// ---------------------------------------------------------------- phase -> screens

function rootFor(phase: Phase): ScreenId | null | undefined {
  switch (phase) {
    case 'title':
      return 'title'
    case 'paused':
      return 'pause'
    case 'results':
      return 'results'
    case 'playing':
    case 'editor':
      return null
    case 'loading':
      return undefined // keep whatever is open
  }
}

function syncPhase(phase: Phase): void {
  const root = rootFor(phase)
  if (root === undefined) return
  // A new phase starts every menu fresh: the pause menu always opens on
  // Resume, the title on Play. (Within a phase, Back still returns you to
  // the item you came from.)
  useUi.setState({ focus: {} })
  resetStack(root)
}

// ---------------------------------------------------------------- pause button

/** Esc on the keyboard is also menu "back"; ignore a pause press that arrives this soon after a back. */
const BACK_SHADOW_MS = 250

function onPausePressed(): void {
  if (performance.now() - navTiming.lastBackAt < BACK_SHADOW_MS) return
  const g = getGame()
  // The world map (editor-owned) handles its own Back / Esc -> closeMap().
  if (g.mapOpen) return
  if (g.phase === 'playing') {
    audio.ui('toggle')
    pauseGame()
  } else if (g.phase === 'paused') {
    audio.ui('back')
    resumeGame()
  }
}

function usePauseWatcher(): void {
  useEffect(() => {
    let last = controlSignals.pause
    let raf = 0
    // One press, one consumer. The world map handles its own Back / Menu, and
    // the editor may read that same press before this loop does; when the map
    // opens or closes, swallow whatever press is pending so it can't also
    // resume the game.
    const offMap = useGame.subscribe((s, prev) => {
      if (s.mapOpen !== prev.mapOpen) last = controlSignals.pause
    })
    const tick = () => {
      raf = requestAnimationFrame(tick)
      if (controlSignals.pause !== last) {
        last = controlSignals.pause
        onPausePressed()
      }
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      offMap()
    }
  }, [])
}

// ---------------------------------------------------------------- dev handles

/** Open any screen directly (for screenshots and checkers). */
function devOpen(screen: string, arg?: string): string {
  const g = getGame()
  const ensureDriving = () => {
    if (getGame().phase === 'playing') return true
    if (getGame().phase === 'paused' || getGame().phase === 'results') {
      resumeGame()
      return true
    }
    return startSession({ mode: g.mode, trackId: g.trackId })
  }
  switch (screen) {
    case 'title':
      if (g.phase !== 'title') endSession()
      resetStack('title')
      return 'title'
    case 'mode':
    case 'track':
    case 'garage':
    case 'settings': {
      if (g.phase === 'playing') pauseGame()
      const now = getGame().phase
      if (now !== 'title' && now !== 'paused' && now !== 'results') {
        endSession()
      }
      resetStack(rootFor(getGame().phase) ?? 'title')
      if (screen === 'track') openScreen('mode')
      if (screen === 'settings' && arg && (SETTINGS_TABS as readonly string[]).includes(arg)) {
        useUi.setState({ settingsTab: arg as SettingsTab })
      }
      openScreen(screen)
      return `${screen}${screen === 'settings' ? `:${useUi.getState().settingsTab}` : ''}`
    }
    case 'pause':
      if (!ensureDriving()) return 'no track loaded'
      pauseGame()
      return 'pause'
    case 'results':
      if (!ensureDriving()) return 'no track loaded'
      showResults()
      return 'results'
    case 'hud':
      if (!ensureDriving()) return 'no track loaded'
      return 'hud'
    default:
      return `unknown screen "${screen}". Try: title, mode, track, garage, settings [tab], pause, results, hud`
  }
}

function useDevHandles(): void {
  useEffect(() => {
    const offs = [
      registerDev(
        'ui',
        ((screen: string, arg?: string) => devOpen(screen, arg)) as never,
        "ui(screen, tab?) - open a screen: title, mode, track, garage, settings ['car'|'handling'|...], pause, results, hud",
      ),
      registerDev(
        'uiNav',
        ((action: MenuAction, device: InputDevice = 'gamepad') => {
          handleMenuAction(action, device)
          const el = focusedElement()
          return el?.dataset.nav ?? null
        }) as never,
        'uiNav(action, device?) - press a menu button: up/down/left/right/accept/back/tabPrev/tabNext; returns the focused item',
      ),
      registerDev('uiPause', (() => onPausePressed()) as never, 'uiPause() - press the pause button (Esc / Menu)'),
      registerDev('uiHudDemo', ((scene: string) => hudDemo(scene)) as never, HUD_DEMO_HELP),
      registerInspector('ui', () => {
        const s = useUi.getState()
        const screen = s.stack.length ? s.stack[s.stack.length - 1] : null
        const el = focusedElement()
        return {
          stack: s.stack,
          screen,
          focused: screen ? s.focus[screen] ?? null : null,
          focusedText: el ? (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) : null,
          settingsTab: s.settingsTab,
          pendingMode: s.pendingMode,
          loading: s.loading,
          notice: s.notice?.text ?? null,
          inputContext: inputState.context,
          recentActions: navLog.slice(-8),
          screens: SCREEN_IDS,
        }
      }),
    ]
    return () => offs.forEach((off) => off())
  }, [])
}

// ---------------------------------------------------------------- input context

/** Menus open -> 'menu'; a text field focused -> 'text' (and back again on blur). */
function useInputContext(root: RefObject<HTMLDivElement | null>): void {
  const stackLen = useUi((s) => s.stack.length)
  const phase = useGame((s) => s.phase)
  const mapOpen = useGame((s) => s.mapOpen)
  useEffect(() => {
    if (phase === 'editor' || mapOpen) return // the editor owns input there
    if (stackLen > 0 && inputState.context !== 'text') setInputContext('menu')
  }, [stackLen, phase, mapOpen])
  useEffect(() => {
    // Listen on the document (our root unmounts while the editor is open) and
    // only react to text fields inside our own overlay.
    let before: typeof inputState.context | null = null
    const isText = (t: EventTarget | null) => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || (t instanceof HTMLElement && t.isContentEditable)
    const ours = (t: EventTarget | null) => t instanceof Node && !!root.current?.contains(t)
    const onIn = (e: FocusEvent) => {
      if (!isText(e.target) || !ours(e.target)) return
      before = inputState.context
      setInputContext('text')
    }
    const onOut = (e: FocusEvent) => {
      if (!isText(e.target) || before === null) return
      setInputContext(before)
      before = null
    }
    document.addEventListener('focusin', onIn)
    document.addEventListener('focusout', onOut)
    return () => {
      document.removeEventListener('focusin', onIn)
      document.removeEventListener('focusout', onOut)
    }
  }, [root])
}

// ---------------------------------------------------------------- overlays

function LoadingVeil() {
  const loading = useUi((s) => s.loading)
  return (
    <div className={`veil${loading ? ' is-on' : ''}`} aria-hidden={!loading} role="status">
      {loading && (
        <div className="veil__inner">
          <span className="eyebrow">Building the track</span>
          <span className="veil__name">{loading}</span>
          <span className="veil__bar" />
        </div>
      )}
    </div>
  )
}

function Notice() {
  const notice = useUi((s) => s.notice)
  if (!notice) return null
  return (
    <div key={notice.id} className={`notice notice--${notice.kind}`} role="alert">
      {notice.text}
    </div>
  )
}

const SCREENS: Record<ScreenId, () => JSX.Element> = {
  title: TitleScreen,
  mode: ModeSelectScreen,
  track: TrackSelectScreen,
  garage: GarageScreen,
  settings: SettingsScreen,
  pause: PauseScreen,
  results: ResultsScreen,
}

export function UiRoot() {
  const phase = useGame((s) => s.phase)
  const mapOpen = useGame((s) => s.mapOpen)
  // The quality actually in use (look's quality manager): Low drops the glass blur (see ui.css).
  const quality = useGame((s) => s.qualityLevel)
  const screen = useActiveScreen()
  const root = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    syncPhase(getGame().phase)
    return useGame.subscribe((s, prev) => {
      if (s.phase !== prev.phase) syncPhase(s.phase)
    })
  }, [])
  useMenuBus()
  usePauseWatcher()
  useDevHandles()
  useInputContext(root)

  // The road editor draws its own UI; ours steps aside completely.
  if (phase === 'editor') return null

  // While the world map is open over the pause menu, the menu steps aside
  // (unmounting it also hides the focus ring); closing the map brings it back
  // with focus on the Map button.
  const Screen = screen && !mapOpen ? SCREENS[screen] : null
  return (
    <div
      ref={root}
      className="sr-ui"
      data-quality={quality}
      style={CSS_VARS}
      // Clicks never leave a browser focus behind (our focus model is our own),
      // except in text fields, which need it.
      onMouseDown={(e) => {
        const t = e.target as HTMLElement
        if (!(t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement)) e.preventDefault()
      }}
    >
      <Hud />
      {Screen && (
        <div className="screen-host" key={screen}>
          <Screen />
        </div>
      )}
      <FocusRing />
      <Notice />
      <LoadingVeil />
    </div>
  )
}
