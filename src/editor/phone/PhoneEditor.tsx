// ============================================================
//  THE ROAD EDITOR ON A PHONE - layout C, One tool button
// ------------------------------------------------------------
//  What EditorUi.tsx draws instead of the rail and the panel while
//  touch is the device (spec/phone-landscape-standard.md P5, P7;
//  spec/phone-editor/). The map stays as big as it can:
//
//    bottom left   Undo and Redo, always; the tool button under them,
//                  showing the tool in your hand. Tap it for the tray:
//                  all nine tools, in the computer's order, and View
//    beside it     a chip with the tool's setting, opens the card
//    down the right  compass, Menu, 3D, Checks, Save, Test drive
//    on the right  the card, over the stack: the chosen tool's settings,
//                  the Checks list, or whatever is picked on the map
//    full screen   PhoneMenu.tsx: the whole track's settings, Map key,
//                  Library, New track, Random track, Exit
//
//  No part is forked: the card holds the panel's own Inspector, Problems
//  and the rail's Palette and ToolOptions. The status line and the
//  question boxes stay EditorUi.tsx's; phone.css places them. One finger
//  on the map stays the tool and two the map (mapGestures.ts), with any of
//  this open; only the Menu covers the map.
// ============================================================

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { audio } from '../../core/api'
import { type EditorTool, type Selection, SAVE_STATE_WORDS, cancelBend, cancelShaping, hasUnsavedWork, redo, saveDraft, saveState, say, sectionPoints, testDrive, undo, useEditor } from '../draft'
import { isEmptyDraft } from '../draftFile'
import { Palette, RAIL, ToolOptions, pickTool } from '../EditorUi'
import { BankIcon, BendIcon, CurveIcon, FitIcon, GlobeIcon, HeightIcon, MinusIcon, PencilIcon, PiecesIcon, PlusIcon, SelectIcon, StraightIcon, UndoIcon, WidthIcon } from '../icons'
import { currentProblems } from '../fixActions'
import { closeLook3d, toggleLook3d, useLook3d } from '../look3d'
import { in3d, zoomViewAt } from '../look3dSpace'
import { Compass, CubeIcon, MapIcon } from '../Look3dUi'
import { issueLocation, roadGeometry } from '../mapDraw'
import { gestureStats } from '../mapGestures'
import { cancelPointerGesture, fitToDraft } from '../Overlay'
import { Inspector, Problems, useProblems } from '../Panel'
import { PLACE_TOOLS } from '../pieces'
import { problemByKey } from '../problems'
import { STEADY_NAMES } from '../shape'
import { ZOOM, ZOOM_MAX_PHONE, panBy, setView, view, worldToScreen } from '../view'
import { fitWorldInto, freeMapBox } from './freeMap'
import { PhoneMenu } from './PhoneMenu'
import { guardMapWhileTrayOpen } from './trayGuard'
import './phone.css'

/** The tray, in the computer's order. Every tool keeps its name in words (the rail's rulings, inventory.md). */
const TOOLS: { id: EditorTool; icon: ReactNode }[] = [
  { id: 'select', icon: <SelectIcon /> },
  { id: 'pencil', icon: <PencilIcon /> },
  { id: 'straight', icon: <StraightIcon /> },
  { id: 'curve', icon: <CurveIcon /> },
  { id: 'bend', icon: <BendIcon /> },
  { id: 'bank', icon: <BankIcon /> },
  { id: 'height', icon: <HeightIcon /> },
  { id: 'width', icon: <WidthIcon /> },
  { id: 'place', icon: <PiecesIcon /> },
]

/** A tray cell is too narrow for "Place pieces"; the card still says it in full. */
const toolName = (tool: EditorTool) => (tool === 'place' ? 'Pieces' : RAIL[tool].name)

/** A finger working the tool this long, milliseconds, is more than a slow tap: the card steps aside and Undo offers Cancel. */
const WORKING_MS = 150

/** The chips' and the tray's own little chevron: there is more behind this. */
const Chevron = () => (
  <svg viewBox="0 0 10 16" width="8" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M2 2l6 6-6 6" />
  </svg>
)

/** Is the tool's finger on the map? 'start' for a moment, then 'working'. Read once a frame, and it only re-renders when it changes. */
function useToolFinger(): 'none' | 'start' | 'working' {
  const [state, setState] = useState<'none' | 'start' | 'working'>('none')
  useEffect(() => {
    let raf = 0
    let since = 0
    let shown: 'none' | 'start' | 'working' = 'none'
    const tick = (t: number) => {
      let now: typeof shown = 'none'
      if (gestureStats.phase === 'tool') {
        if (shown === 'none') since = t
        now = t - since >= WORKING_MS ? 'working' : 'start'
      }
      if (now !== shown) {
        shown = now
        setState(now)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])
  return state
}

/** Where a picked thing is on the map, to keep it in the free part when a card opens. */
function spotOf(sel: Selection): { x: number; z: number } | null {
  const d = useEditor.getState().draft
  if (sel.kind === 'crossing') return sel
  if (sel.kind === 'problem') return problemByKey(currentProblems(), sel.key)?.at ?? null
  if (sel.kind === 'section') {
    const ids = sectionPoints(d.points.length, sel.from, sel.to)
    return d.points[ids[Math.floor((ids.length - 1) / 2)]] ?? null
  }
  const list = sel.kind === 'point' ? 'road.points' : sel.kind === 'piece' ? 'pieces' : sel.kind === 'prop' ? 'props' : 'cores'
  return issueLocation(`${list}[${sel.index}]`, d, roadGeometry(d.points, d.width).rc)
}

/**
 * A card has opened over the map: slide the map just enough that the picked
 * thing is still in the free part. Never a re-fit, so nothing else jumps.
 */
function keepInFreeMap(spot: { x: number; z: number }): void {
  const free = freeMapBox()
  if (!free || in3d()) return
  const at = worldToScreen(spot.x, spot.z)
  const room = 36
  const dx = Math.min(0, free.right - room - at.sx)
  const dy = Math.min(0, free.bottom - room - at.sy)
  if (!dx && !dy) return
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    panBy(dx, dy)
    return
  }
  const start = performance.now()
  let done = 0
  const step = (t: number) => {
    const k = Math.min(1, (t - start) / 180)
    const eased = 1 - (1 - k) * (1 - k)
    panBy(dx * (eased - done), dy * (eased - done))
    done = eased
    if (k < 1 && gestureStats.phase === 'idle') requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

export function PhoneEditor(p: { onLibrary: () => void; onExit: () => void }) {
  // The tray ('tools', or its View page), the card with nothing picked, the Menu.
  const [tray, setTray] = useState<null | 'tools' | 'view'>(null)
  const [card, setCard] = useState<null | 'tool' | 'checks'>(null)
  const [menu, setMenu] = useState(false)
  const tool = useEditor((s) => s.tool)
  const selection = useEditor((s) => s.selection)
  const finger = useToolFinger()

  // A card asked for is held back while a finger is working the tool ("the map only" while you draw or drag),
  // and one already up steps aside once that is more than a slow tap.
  const wantCard = !!selection || !!card
  const [cardUp, setCardUp] = useState(wantCard)
  useEffect(() => {
    if (!wantCard) setCardUp(false)
    else if (finger === 'none') setCardUp(true)
    else if (finger === 'working') setCardUp(false)
  }, [wantCard, finger])

  // Place opens on its palette, whichever way it was picked; any other tool folds a tool card.
  useEffect(() => {
    setCard((c) => (tool === 'place' ? 'tool' : c === 'tool' ? null : c))
  }, [tool])
  // Something picked takes the card from the tool's settings. (Checks stays under it, for Done to come back to.)
  useEffect(() => {
    if (selection) setCard((c) => (c === 'tool' ? null : c))
  }, [selection])

  // Keep what was picked in the free map once its card is up.
  const pickedKey = useMemo(() => (selection ? JSON.stringify(selection) : ''), [selection])
  useEffect(() => {
    if (!cardUp || !pickedKey) return
    const sel = useEditor.getState().selection
    const spot = sel && spotOf(sel)
    if (spot) keepInFreeMap(spot)
  }, [cardUp, pickedKey])

  // A phone's short window needs more zoom-out than a computer's; a mode change puts it back.
  useLayoutEffect(() => {
    const before = ZOOM.max
    ZOOM.max = ZOOM_MAX_PHONE
    return () => {
      ZOOM.max = before
      setView(view.cx, view.cz, view.mpp)
    }
  }, [])

  // The scale bar sits in the free map: to the right of the chip, along the bottom. Read after every render (the chip's words change its width).
  useLayoutEffect(() => {
    const left = document.querySelector('.phone-left')?.getBoundingClientRect()
    if (!left) return
    const chips = document.querySelector('.phone-chips')?.getBoundingClientRect()
    const free = freeMapBox()
    // The bar and its words reach about 245 px. Too narrow beside the chip (a phone stood up): above it.
    const besideChip = !chips || !free || chips.right + 12 + 245 <= free.right
    const x = (besideChip && chips ? chips.right : left.right) + 12
    const up = window.innerHeight - (besideChip ? left.bottom : chips.top) + 6
    if (x !== view.scaleX || up !== view.scaleUp) {
      view.scaleX = x
      view.scaleUp = up
      view.version++
    }
  })
  useEffect(
    () => () => {
      view.scaleX = 96
      view.scaleUp = 28
      view.version++
    },
    [],
  )

  // The tray closes on a tap anywhere else; a tap on the map does nothing more than that (trayGuard.ts).
  const trayOpen = !!tray
  useEffect(() => (trayOpen ? guardMapWhileTrayOpen(() => setTray(null)) : undefined), [trayOpen])

  return (
    <>
      <div className="phone-left">
        <UndoRedo cancelling={finger === 'working'} />
        <button
          type="button"
          className="phone-tool"
          aria-haspopup="true"
          aria-expanded={trayOpen}
          data-testid="phone-tool"
          onClick={() => {
            audio.ui('move')
            setTray(trayOpen ? null : 'tools')
          }}
        >
          <span className="phone-tool-more" aria-hidden />
          {TOOLS.find((t) => t.id === tool)?.icon}
          <span className="phone-tool-name">{toolName(tool)}</span>
        </button>
      </div>

      {!trayOpen && !cardUp && <ToolChips onOpen={() => setCard('tool')} />}
      {tray === 'tools' && (
        <ToolTray
          onPick={(t) => {
            audio.ui('move')
            setTray(null)
            setCard((c) => (t === 'place' ? 'tool' : c === 'tool' ? null : c))
            pickTool(t)
          }}
          onView={() => {
            audio.ui('move')
            setTray('view')
          }}
        />
      )}
      {tray === 'view' && <ViewTray onBack={() => setTray('tools')} onDone={() => setTray(null)} />}

      <RightStack hidden={wantCard} onMenu={() => setMenu(true)} onChecks={() => setCard('checks')} />

      {wantCard && (
        <div className="phone-card-slot" hidden={!cardUp}>
          {selection ? (
            <PickedCard selection={selection} />
          ) : card === 'checks' ? (
            <CardFrame title="Checks" kind="checks" onDone={() => setCard(null)}>
              <Problems noTitle />
            </CardFrame>
          ) : (
            <ToolCard tool={tool} onDone={() => setCard(null)} />
          )}
        </div>
      )}

      {menu && <PhoneMenu onClose={() => setMenu(false)} onLibrary={p.onLibrary} onExit={p.onExit} />}
    </>
  )
}

// ---------------------------------------------------------------- bottom left

/**
 * Undo and Redo, always beside the tool button. While a finger is working the
 * tool, Undo offers Cancel to the other thumb (the computer's Esc). It acts on
 * the press: Chrome sends no click for a second finger.
 */
function UndoRedo(p: { cancelling: boolean }) {
  const canUndo = useEditor((s) => s.past.length > 0)
  const canRedo = useEditor((s) => s.future.length > 0)
  const press = (can: boolean, act: () => void, none: string) => {
    if (!can) {
      say(none, 'info')
      audio.ui('error')
      return
    }
    audio.ui('move')
    act()
  }
  return (
    <div className="phone-undo">
      {p.cancelling ? (
        <button type="button" className="is-cancel" data-testid="phone-cancel" onPointerDown={() => cancelBend() || cancelShaping() || cancelPointerGesture()}>
          <UndoIcon />
          <span>Cancel</span>
        </button>
      ) : (
        <button type="button" aria-disabled={!canUndo} data-rail="undo" onClick={() => press(canUndo, undo, 'Nothing to undo yet.')}>
          <UndoIcon />
          <span>{RAIL.undo.name}</span>
        </button>
      )}
      <button type="button" aria-disabled={!canRedo} data-rail="redo" onClick={() => press(canRedo, redo, 'Nothing to redo.')}>
        <UndoIcon flip />
        <span>{RAIL.redo.name}</span>
      </button>
    </div>
  )
}

/** Beside the tool button: the tool's setting, one tap from the card. A half-made Straight or Curve can start again here. */
function ToolChips(p: { onOpen: () => void }) {
  const tool = useEditor((s) => s.tool)
  const steady = useEditor((s) => s.steady)
  const reach = useEditor((s) => s.bendReach)
  const placeKind = useEditor((s) => s.placeKind)
  const shaping = useEditor((s) => s.shaping)
  const halfMade = shaping?.tool === tool
  let words: ReactNode = null
  if (tool === 'pencil') {
    words = (
      <>
        <span>Steady hand:</span> <b>{STEADY_NAMES[steady] ?? ''}</b>
      </>
    )
  } else if (tool === 'bend') {
    words = (
      <>
        <span>Reach:</span> <b>{reach} m</b>
      </>
    )
  } else if (tool === 'straight' || tool === 'curve') {
    const step = shaping?.tool === tool ? (shaping.b !== null ? 3 : 2) : 1
    words = (
      <>
        <span>Step</span> <b>{step} of {tool === 'straight' ? 2 : 3}</b>
      </>
    )
  } else if (tool === 'height' || tool === 'bank' || tool === 'width') {
    words = <span>Pick a stretch</span>
  } else if (tool === 'place') {
    const piece = PLACE_TOOLS.find((t) => t.kind === placeKind) ?? PLACE_TOOLS[0]
    words = (
      <>
        <i className="phone-chip-swatch" style={{ background: piece.colour }} aria-hidden />
        <b>{piece.label}</b>
      </>
    )
  }
  if (!words) return null
  return (
    <div className="phone-chips">
      <button
        type="button"
        className="phone-chip"
        data-testid="phone-chip"
        onClick={() => {
          audio.ui('move')
          p.onOpen()
        }}
      >
        {words}
        <Chevron />
      </button>
      {halfMade && (
        <button type="button" className="phone-chip" data-testid="phone-start-again" onClick={() => cancelShaping()}>
          Start again
        </button>
      )}
    </div>
  )
}

/** All nine tools, in the computer's order, and the way to View. */
function ToolTray(p: { onPick: (tool: EditorTool) => void; onView: () => void }) {
  const tool = useEditor((s) => s.tool)
  return (
    <nav className="phone-tray" aria-label="Tools" data-testid="phone-tray">
      {TOOLS.map((t) => (
        <button key={t.id} type="button" className={`phone-cell${t.id === tool ? ' is-on' : ''}`} aria-pressed={t.id === tool} data-rail={t.id} onClick={() => p.onPick(t.id)}>
          {t.icon}
          <span>{toolName(t.id)}</span>
        </button>
      ))}
      <button type="button" className="phone-tray-row" data-testid="phone-tray-view" onClick={p.onView}>
        <FitIcon />
        <span>View: zoom, Fit track, Whole world</span>
        <Chevron />
      </button>
    </nav>
  )
}

/** The tray's View page. Zoom stays open for another tap; Fit track and Whole world are done, so the map gets the screen back. */
function ViewTray(p: { onBack: () => void; onDone: () => void }) {
  const zoom = (factor: number) => {
    audio.ui('move')
    const free = freeMapBox()
    zoomViewAt(free ? (free.left + free.right) / 2 : view.width / 2, free ? (free.top + free.bottom) / 2 : view.height / 2, factor)
  }
  return (
    <nav className="phone-tray is-view" aria-label="View" data-testid="phone-tray">
      <button type="button" className="phone-cell" data-rail="zoomIn" onClick={() => zoom(1 / 1.4)}>
        <PlusIcon />
        <span>{RAIL.zoomIn.name}</span>
      </button>
      <button type="button" className="phone-cell" data-rail="zoomOut" onClick={() => zoom(1.4)}>
        <MinusIcon />
        <span>{RAIL.zoomOut.name}</span>
      </button>
      <button
        type="button"
        className="phone-cell"
        data-rail="fit"
        onClick={() => {
          audio.ui('select')
          fitToDraft()
          p.onDone()
        }}
      >
        <FitIcon />
        <span>{RAIL.fit.name}</span>
      </button>
      <button
        type="button"
        className="phone-cell"
        data-rail="world"
        onClick={() => {
          audio.ui('select')
          const free = freeMapBox()
          if (free) fitWorldInto(free)
          p.onDone()
        }}
      >
        <GlobeIcon />
        <span>{RAIL.world.name}</span>
      </button>
      <button type="button" className="phone-tray-row" data-testid="phone-tray-back" onClick={p.onBack}>
        <span className="phone-chevron-back" aria-hidden>
          <Chevron />
        </span>
        <span>Back to the tools</span>
      </button>
    </nav>
  )
}

// ---------------------------------------------------------------- down the right

function RightStack(p: { hidden: boolean; onMenu: () => void; onChecks: () => void }) {
  const empty = useEditor((s) => isEmptyDraft(s.draft))
  const state = useEditor((s) => saveState(s))
  const unsaved = useEditor((s) => hasUnsavedWork(s))
  const look = useLook3d((s) => s.mode)
  const on3d = look === 'opening' || look === '3d'
  return (
    <div className="phone-stack" hidden={p.hidden}>
      <Compass />
      <button
        type="button"
        className="phone-side"
        data-testid="phone-menu-open"
        onClick={() => {
          audio.ui('move')
          p.onMenu()
        }}
      >
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
        <span>Menu</span>
      </button>
      <button
        type="button"
        className="phone-side"
        aria-pressed={on3d}
        aria-label={on3d ? 'Back to the map' : 'See it in 3D'}
        data-testid="editor-3d-button"
        onClick={() => {
          audio.ui('move')
          if (on3d) closeLook3d()
          else toggleLook3d()
        }}
      >
        {on3d ? <MapIcon /> : <CubeIcon />}
        <span>{on3d ? 'Map' : '3D'}</span>
      </button>
      <ChecksButton empty={empty} onOpen={p.onChecks} />
      <button
        type="button"
        className="phone-side"
        aria-disabled={empty}
        aria-label={`Save: ${SAVE_STATE_WORDS[state]}`}
        data-testid="phone-save"
        onClick={() => saveDraft() && audio.ui('select')}
      >
        {unsaved && <i className={`phone-dot is-${state}`} aria-hidden />}
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M5 4h11l3 3v13H5z" />
          <path d="M8 4v5h7V4M8 20v-6h8v6" />
        </svg>
        <span>Save</span>
      </button>
      <button type="button" className="phone-side is-primary" aria-disabled={empty} data-testid="editor-test-drive" onClick={testDrive}>
        <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden>
          <path d="M7 4.5v15l13-7.5z" />
        </svg>
        <span>Test drive</span>
      </button>
    </div>
  )
}

/** Checks: how many problems, and it says at once when the road is building or needs fixing. */
function ChecksButton(p: { empty: boolean; onOpen: () => void }) {
  const preview = useEditor((s) => s.preview)
  const gateFails = useEditor((s) => s.checkedDraft === s.draft && !!s.gates?.some((g) => g.level === 'fail'))
  const items = useProblems()
  const problems = items.filter((it) => it.tone === 'bad' || it.tone === 'warn')
  const bad = problems.some((it) => it.tone === 'bad')
  const building = !p.empty && preview === 'pending'
  const failing = !p.empty && !building && (preview === 'failed' || gateFails)
  return (
    <button
      type="button"
      className={`phone-side${failing ? ' is-failing' : ''}`}
      aria-disabled={p.empty}
      data-testid="phone-checks"
      onClick={() => {
        if (p.empty) {
          say('No road yet, so nothing to check. Draw a loop with your finger, or tap Random track.', 'info')
          audio.ui('error')
          return
        }
        audio.ui('move')
        p.onOpen()
      }}
    >
      {problems.length > 0 && !p.empty && <i className={`phone-badge${bad ? ' is-bad' : ''}`}>{problems.length}</i>}
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M5 12.5l4.5 4.5L19 7.5" />
      </svg>
      <span>{building ? 'Building...' : failing ? 'Needs fixing' : 'Checks'}</span>
    </button>
  )
}

// ---------------------------------------------------------------- the card

/** The card: a title and Done that stay put, and what is under them scrolls by itself. */
function CardFrame(p: { title: string; kind: string; tone?: string | null; onTitle?: () => void; onDone: () => void; children: ReactNode }) {
  const body = useRef<HTMLDivElement>(null)
  // A fade along the bottom edge while there is more below, so the long words read as "keep going".
  const showMore = () => {
    const e = body.current
    // (More than the body's own bottom padding.)
    if (e) e.dataset.more = e.scrollTop + e.clientHeight < e.scrollHeight - 14 ? '1' : '0'
  }
  useEffect(showMore)
  const titleClass = `phone-card-title${p.tone ? ` is-${p.tone}` : ''}`
  return (
    <aside className="phone-card" aria-label={p.title} data-testid="phone-card" data-kind={p.kind}>
      <header className="phone-card-head">
        {p.onTitle ? (
          <button type="button" className={titleClass} onClick={p.onTitle} aria-label={`${p.title}: show it on the map`}>
            {p.title}
          </button>
        ) : (
          <h2 className={titleClass}>{p.title}</h2>
        )}
        <button
          type="button"
          className="phone-done"
          data-testid="phone-done"
          onClick={() => {
            audio.ui('back')
            p.onDone()
          }}
        >
          Done
        </button>
      </header>
      <div className="phone-card-body" ref={body} onScroll={showMore} key={p.kind}>
        {p.children}
      </div>
    </aside>
  )
}

/** Whatever is picked on the map: the panel's own Inspector, in the card. */
function PickedCard(p: { selection: Selection }) {
  const draft = useEditor((s) => s.draft)
  return (
    <Inspector
      selection={p.selection}
      draft={draft}
      frame={(parts) => (
        <CardFrame title={parts.title} kind={p.selection.kind} tone={parts.tone} onTitle={parts.onTitle} onDone={() => useEditor.setState({ selection: null })}>
          {parts.body}
          {parts.del}
        </CardFrame>
      )}
    />
  )
}

/** The tool's own settings: the rail's ToolOptions, or the piece palette, which folds to the chip once a piece is picked. */
function ToolCard(p: { tool: EditorTool; onDone: () => void }) {
  if (p.tool === 'place') {
    return (
      <CardFrame title={RAIL.place.name} kind="place" onDone={p.onDone}>
        <div
          className="phone-palette"
          onClick={(e) => {
            if ((e.target as Element).closest('.sre-piece')) p.onDone()
          }}
        >
          <Palette />
        </div>
        <p className="sre-help">Pick one, then tap the road. Slide your finger to move it before you let go.</p>
      </CardFrame>
    )
  }
  return (
    <CardFrame title={RAIL[p.tool].name} kind="tool" onDone={p.onDone}>
      <ToolOptions />
    </CardFrame>
  )
}
