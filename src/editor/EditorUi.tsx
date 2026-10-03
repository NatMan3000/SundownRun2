// ============================================================
//  EDITOR UI - the DOM layer of the road editor
// ------------------------------------------------------------
//  The 3D half is the top-down camera; this is everything on top,
//  laid out like a drawing app:
//
//    the map     Overlay.tsx (pencil, selecting, dragging, placing);
//                on an empty map, a note at the top says what to do
//    left        the tool rail, and the piece palette when placing
//    right       Panel.tsx (this track, the selected thing, checks)
//    bottom      one status line in plain words
//    dialog      Library.tsx (open, new, copy, import, export), and
//                ClearAll.tsx ("Clear the whole track?" and "Make a
//                random track?")
//
//  The rail, top to bottom: the tools in the order Josh reaches for
//  them (Select, Pencil, Straight, Curve, Bend, Stretch, Place
//  pieces), then the whole-road buttons (Undo, Redo, Clear all, Random
//  track), then the view (Zoom in, Zoom out, Fit track, Whole world),
//  then the Library. There is no hand tool: the right mouse button
//  drags the map with every tool (so do the middle button and Space).
//
//  Esc (or the pad's Menu button): first closes a dialog, then stops a
//  bend or a half-made Straight or Curve, then clears a selection, then
//  leaves the editor. Work is never lost: the draft is kept.
//
//  Beside the rail, the chosen tool's own settings (ToolOptions): the
//  pencil's steady hand, Bend's reach, the steps of Straight and Curve.
// ============================================================

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { FONTS, PALETTE } from '../core/palette'
import { controlSignals } from '../core/controls'
import { endSession } from '../core/session'
import { audio } from '../core/api'
import { type EditorTool, EMPTY_MAP_HINT, cancelBend, cancelPendingPreview, cancelShaping, redo, say, setBendReach, setSteady, setTool, undo, useEditor } from './draft'
import { Overlay, fitToDraft, pencilHint } from './Overlay'
import { Panel } from './Panel'
import { Library } from './Library'
import { closeWorldMap } from './worldMap'
import { PLACE_TOOLS, type PlaceKind } from './pieces'
import { setView, view, zoomAt } from './view'
import { ClearAllDialog, askClearAll, askRandomTrack, clearAllTakesPause, setClearAllBlocked } from './ClearAll'
import { BendIcon, ClearIcon, CurveIcon, DiceIcon, FitIcon, GlobeIcon, LibraryIcon, MinusIcon, PencilIcon, PiecesIcon, PlusIcon, SectionIcon, SelectIcon, StraightIcon, UndoIcon } from './icons'
import { getTrackFile } from '../track/registry'
import { loadTrackById } from '../track/current'
import { lastPlayedTrackId } from '../core/session'
import { isEmptyDraft } from './draftFile'
import { startDriveToDraw } from './driveToDraw'
import { SliderField } from './fields'
import { BEND_REACH, STEADY_NAMES, STEADY_STRING } from './shape'
import './editor.css'

/** CSS custom properties from the palette, so the stylesheet never holds a colour of its own. */
const cssVars = {
  '--panel': PALETTE.uiPanel,
  '--panel-solid': PALETTE.uiPanelSolid,
  '--line': PALETTE.uiLine,
  '--text': PALETTE.uiText,
  '--dim': PALETTE.uiDim,
  '--accent': PALETTE.uiAccent,
  '--accent2': PALETTE.uiAccent2,
  '--warn': PALETTE.uiWarn,
  '--good': PALETTE.uiGood,
  '--bad': PALETTE.uiBad,
  '--bridge': PALETTE.wallRide,
  '--boost': PALETTE.boost,
  '--ramp': PALETTE.ramp,
  '--loop': PALETTE.loopRing,
  '--prop': PALETTE.propCrate,
  '--core': PALETTE.core,
  '--chevron': PALETTE.chevron,
  '--font-body': FONTS.body,
  '--font-display': FONTS.display,
  '--font-mono': FONTS.mono,
} as CSSProperties

/** What each tool does, said once when you pick it. */
const TOOL_TIPS: Record<EditorTool, string> = {
  pencil: 'Pencil: start on the road and end back on the road to redraw the bit in between. On an empty map, draw a loop.',
  bend: 'Bend: grab the road and pull it. The mouse wheel (or [ and ]) changes how much road comes with it.',
  straight: 'Straight: click the road where the straight starts, then click where it ends.',
  curve: 'Curve: click the road where the curve starts, then where it ends, then pull the middle out and click.',
  select: 'Select: click a piece or road point, drag to move it, Delete removes it. Double-click the road to add a point.',
  section: 'Stretch: drag along the road to pick a stretch, then set its height, bank or width in the panel.',
  place: 'Place pieces: pick a piece, then click where it goes.',
}

/** The tools that only work on a road (all but the pencil): on an empty map they say so instead. */
function needsRoad(tool: EditorTool): boolean {
  return tool !== 'pencil'
}

export function EditorUi() {
  const mode = useEditor((s) => s.mode)
  const [library, setLibrary] = useState(false)

  // Esc / the pad's Menu button: close a dialog, then clear the selection, then leave.
  useEffect(() => {
    setClearAllBlocked(library)
    let seen = controlSignals.pause
    let raf = 0
    const tick = () => {
      if (controlSignals.pause !== seen) {
        seen = controlSignals.pause
        if (clearAllTakesPause(seen)) {
          // The "Clear the whole track?" box used this press to close.
        } else if (library) setLibrary(false)
        else if (cancelBend() || cancelShaping()) {
          // Esc stopped a bend or a half-made Straight or Curve.
        }
        else if (useEditor.getState().selection) useEditor.setState({ selection: null })
        else leaveEditor()
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [library])

  useEffect(() => {
    if (useEditor.getState().past.length === 0 && !useEditor.getState().dirty && mode === 'edit') pencilHint()
  }, [mode])

  return (
    <div className="sre" style={cssVars} data-testid="editor-ui">
      <Overlay />
      <EmptyMapNote />
      <Toolbar onLibrary={() => setLibrary(true)} />
      <Palette />
      <ToolOptions />
      <Panel onLibrary={() => setLibrary(true)} onExit={leaveEditor} />
      <StatusLine />
      {library && <Library onClose={() => setLibrary(false)} />}
      <ClearAllDialog />
    </div>
  )
}

/** Leave: the world map goes back to the paused game; the editor goes to the title screen (the draft is kept). */
export function leaveEditor(): void {
  if (useEditor.getState().mode === 'map') {
    closeWorldMap()
    return
  }
  audio.ui('back')
  // A rebuild still waiting from the last edit would land behind the title screen: drop it.
  cancelPendingPreview()
  restoreRealTrack()
  endSession()
}

/**
 * On an empty map the game is showing the empty world's hidden stand-in road
 * (draftFile.ts emptyWorldFile). Before the title screen, put back a real
 * track to sit behind it: the last one played, or Afterglow.
 */
function restoreRealTrack(): void {
  if (!isEmptyDraft(useEditor.getState().draft)) return
  const id = [lastPlayedTrackId(), 'afterglow'].find((t): t is string => !!t && !!getTrackFile(t))
  if (id) loadTrackById(id)
}

function pickTool(tool: EditorTool, kind?: PlaceKind): void {
  const before = useEditor.getState().tool
  setTool(tool, kind)
  if (before === tool) return
  say(needsRoad(tool) && isEmptyDraft(useEditor.getState().draft) ? `${TOOL_TIPS[tool]} ${EMPTY_MAP_HINT}` : TOOL_TIPS[tool], 'info')
}

/**
 * The empty map's note, across the top of the map: there is no road yet,
 * and the two ways to get one (or three: Drive to draw lays one with the car).
 * Drive to draw lives here, on the empty map only, because it always makes
 * a whole new road: on a map with a road it would replace it, the very
 * surprise the pencil no longer springs.
 */
function EmptyMapNote() {
  const empty = useEditor((s) => s.mode === 'edit' && isEmptyDraft(s.draft))
  if (!empty) return null
  return (
    <div className="sre-empty" role="note" data-testid="editor-empty-note">
      <span className="sre-empty-kicker">Empty map</span>
      <span className="sre-empty-text">Draw a loop with the pencil, or press Random track.</span>
      <button type="button" className="sre-btn is-primary" onClick={() => askRandomTrack()} data-testid="editor-empty-random">
        <DiceIcon />
        Random track
      </button>
      <button type="button" className="sre-btn" onClick={() => startDriveToDraw()} title="Drive anywhere in this world: the car lays a road behind it.">
        Drive to draw
      </button>
    </div>
  )
}

// ---------------------------------------------------------------- tool rail

function Toolbar(props: { onLibrary: () => void }) {
  const tool = useEditor((s) => s.tool)
  const canUndo = useEditor((s) => s.past.length > 0)
  const canRedo = useEditor((s) => s.future.length > 0)
  const mode = useEditor((s) => s.mode)
  const editing = mode === 'edit'
  return (
    <nav className="sre-tools" aria-label="Editor tools">
      {editing && (
        <>
          <ToolButton label="Select and move" keyHint="V" active={tool === 'select'} onClick={() => pickTool('select')} icon={<SelectIcon />} />
          <ToolButton label="Pencil" keyHint="P" active={tool === 'pencil'} onClick={() => pickTool('pencil')} icon={<PencilIcon />} />
          <ToolButton label="Straight: make a stretch dead straight" keyHint="L" active={tool === 'straight'} onClick={() => pickTool('straight')} icon={<StraightIcon />} />
          <ToolButton label="Curve: make a stretch one smooth curve" keyHint="C" active={tool === 'curve'} onClick={() => pickTool('curve')} icon={<CurveIcon />} />
          <ToolButton label="Bend: grab the road and pull" keyHint="G" active={tool === 'bend'} onClick={() => pickTool('bend')} icon={<BendIcon />} />
          <ToolButton label="Stretch" keyHint="B" active={tool === 'section'} onClick={() => pickTool('section')} icon={<SectionIcon />} />
          <ToolButton label="Place pieces: boosts, ramps, loops and more" keyHint="1-0" active={tool === 'place'} onClick={() => pickTool('place')} icon={<PiecesIcon />} />
          <div className="sre-tools-gap" />
          <ToolButton label="Undo" keyHint="Ctrl+Z" disabled={!canUndo} onClick={undo} icon={<UndoIcon />} />
          <ToolButton label="Redo" keyHint="Ctrl+Shift+Z" disabled={!canRedo} onClick={redo} icon={<UndoIcon flip />} />
          <ToolButton label="Clear all" keyHint="controller B" onClick={askClearAll} icon={<ClearIcon />} />
          <ToolButton label="Random track" onClick={() => askRandomTrack()} icon={<DiceIcon />} />
          <div className="sre-tools-gap" />
        </>
      )}
      <ToolButton label="Zoom in" keyHint="+" onClick={() => zoomAt(view.width / 2, view.height / 2, 1 / 1.4)} icon={<PlusIcon />} />
      <ToolButton label="Zoom out" keyHint="-" onClick={() => zoomAt(view.width / 2, view.height / 2, 1.4)} icon={<MinusIcon />} />
      <ToolButton label="Fit track" keyHint="F" onClick={fitToDraft} icon={<FitIcon />} />
      <ToolButton label="Whole world" onClick={() => setView(0, 0, 1700 / Math.max(300, view.height - 120))} icon={<GlobeIcon />} />
      {editing && (
        <>
          <div className="sre-tools-gap" />
          <ToolButton label="Track library" onClick={props.onLibrary} icon={<LibraryIcon />} />
        </>
      )}
    </nav>
  )
}

function ToolButton(p: { label: string; keyHint?: string; active?: boolean; disabled?: boolean; onClick: () => void; icon: ReactNode }) {
  return (
    <button
      type="button"
      className={`sre-tool${p.active ? ' is-active' : ''}`}
      disabled={p.disabled}
      onClick={() => {
        audio.ui('move')
        p.onClick()
      }}
      title={p.keyHint ? `${p.label} (${p.keyHint})` : p.label}
      aria-label={p.label}
      aria-pressed={p.active}
    >
      {p.icon}
    </button>
  )
}

/** The piece palette: shown beside the rail while the place tool is on. */
function Palette() {
  const tool = useEditor((s) => s.tool)
  const kind = useEditor((s) => s.placeKind)
  const mode = useEditor((s) => s.mode)
  if (tool !== 'place' || mode !== 'edit') return null
  return (
    <div className="sre-palette" role="radiogroup" aria-label="Pieces">
      {PLACE_TOOLS.map((t) => (
        <button
          key={t.kind}
          type="button"
          role="radio"
          aria-checked={t.kind === kind}
          className={`sre-piece${t.kind === kind ? ' is-on' : ''}`}
          style={{ '--piece': t.colour } as CSSProperties}
          title={t.blurb}
          onClick={() => {
            audio.ui('toggle')
            setTool('place', t.kind)
            say(`${t.label}: ${t.blurb}`, 'info')
          }}
        >
          <i aria-hidden />
          <span>{t.label}</span>
          <kbd>{t.key}</kbd>
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- the chosen tool's settings

/** The steps of a Straight and a Curve, in the words the box shows. */
const SHAPE_STEPS: Record<'straight' | 'curve', string[]> = {
  straight: ['Click the road where the straight starts.', 'Click where it ends.'],
  curve: ['Click the road where the curve starts.', 'Click where it ends.', 'Pull the middle out, then click.'],
}

/**
 * A small box beside the rail with the chosen tool's own settings, the way
 * the piece palette sits beside it for Place: the pencil's steady hand,
 * Bend's reach, and the steps of a Straight or Curve with the one you are
 * on lit up.
 */
function ToolOptions() {
  const tool = useEditor((s) => s.tool)
  const mode = useEditor((s) => s.mode)
  const steady = useEditor((s) => s.steady)
  const reach = useEditor((s) => s.bendReach)
  const shaping = useEditor((s) => s.shaping)
  if (mode !== 'edit') return null
  if (tool === 'pencil') {
    return (
      <div className="sre-options" role="group" aria-label="Pencil settings" data-testid="editor-tool-options">
        <span className="sre-options-title">Pencil</span>
        <SliderField
          label="Steady hand"
          value={steady}
          min={0}
          max={STEADY_STRING.length - 1}
          step={1}
          format={(v) => STEADY_NAMES[v] ?? ''}
          onCommit={setSteady}
          help="The line trails a little behind the mouse on a string, so wobbles never reach it."
        />
        <p className="sre-help">Your line trails a little behind the mouse, so a shaky hand still draws a smooth road. Turn it up for smoother, down for more control.</p>
        <p className="sre-help">To change the road: start on the road, draw the new bit, and end back on the road. The bit that goes lights up amber before you let go.</p>
      </div>
    )
  }
  if (tool === 'bend') {
    return (
      <div className="sre-options" role="group" aria-label="Bend settings" data-testid="editor-tool-options">
        <span className="sre-options-title">Bend</span>
        <SliderField
          label="Reach"
          value={reach}
          min={BEND_REACH.min}
          max={BEND_REACH.max}
          step={10}
          format={(v) => `${v} m each way`}
          onCommit={setBendReach}
          help="How much road comes with your hand."
        />
        <p className="sre-help">How much road comes with your hand. Short for a small nudge, long for a big sweeping bend. While you drag: mouse wheel, or [ and ].</p>
      </div>
    )
  }
  if (tool === 'straight' || tool === 'curve') {
    const steps = SHAPE_STEPS[tool]
    const now = shaping?.tool === tool ? (shaping.b !== null ? 2 : 1) : 0
    return (
      <div className="sre-options" role="group" aria-label={tool === 'straight' ? 'Straight steps' : 'Curve steps'} data-testid="editor-tool-options">
        <span className="sre-options-title">{tool === 'straight' ? 'Straight' : 'Curve'}</span>
        <ol className="sre-steps">
          {steps.map((text, i) => (
            <li key={text} className={i === now ? 'is-now' : i < now ? 'is-done' : undefined}>
              <span className="sre-step-num">{i + 1}</span>
              {text}
            </li>
          ))}
        </ol>
        <p className="sre-help">{tool === 'straight' ? 'The ends ease into the road so there is no kink.' : 'The curve joins the road at both ends with no kink.'} Red means too tight for a car. Esc starts again.</p>
      </div>
    )
  }
  return null
}

// ---------------------------------------------------------------- status line

function StatusLine() {
  const message = useEditor((s) => s.message)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (!message) return
    setVisible(true)
    const t = setTimeout(() => setVisible(false), message.tone === 'bad' || message.tone === 'warn' ? 7000 : 4500)
    return () => clearTimeout(t)
  }, [message])
  if (!message) return null
  return (
    <div className={`sre-status is-${message.tone}${visible ? ' is-on' : ''}`} role="status" aria-live="polite">
      {message.text}
    </div>
  )
}
