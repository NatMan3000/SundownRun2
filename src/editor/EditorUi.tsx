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
//                AskFirstBox.tsx ("Save it first?" before leaving a track
//                with changes not saved, and "Make a random track?")
//
//  The rail, top to bottom: the tools in the order Josh reaches for
//  them (Select, Pencil, Straight, Curve, Bend, Bank, Height, Width,
//  Place pieces), then the whole-road buttons (Undo, Redo, New track,
//  Random track), then the view (Zoom in, Zoom out, Fit track, Whole
//  world), then the Library. Every button shows its name in words, and
//  hovering one shows straight away what it does and its key (RAIL).
//  There is no hand tool: the right mouse button drags the map with
//  every tool (so do the middle button and Space).
//
//  Esc (or the pad's Menu button): first closes a dialog, then goes back
//  from the 3D view to the map, then stops a bend or a half-made Straight
//  or Curve, then clears a selection, then leaves the editor (asking
//  "Save it first?" if the track has changes not saved; askFirst.ts).
//  Work is never lost: the draft is kept.
//
//  Top right of the map: the compass and the 3D button (Look3dUi.tsx).
//  In 3D the rail waits, dimmed, until you go back to the map.
//
//  Beside the rail, the chosen tool's own settings (ToolOptions): the
//  pencil's steady hand, Bend's reach, the steps of Straight and Curve,
//  and how to pick a stretch for Height, Bank and Width.
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
import { AskFirstDialog } from './AskFirstBox'
import { askBeforeLeavingTrack, askNewTrack, askRandomTrack, askTakesPause, setAskBlocked } from './askFirst'
import { Look3dUi } from './Look3dUi'
import { closeLook3d, useLook3d } from './look3d'
import { BankIcon, BendIcon, CurveIcon, DiceIcon, FitIcon, GlobeIcon, HeightIcon, LibraryIcon, MinusIcon, PencilIcon, PiecesIcon, NewTrackIcon, PlusIcon, SelectIcon, StraightIcon, UndoIcon, WidthIcon } from './icons'
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

/**
 * Every button on the rail: its name (shown on the rail), what it does in one
 * line (shown the moment the mouse is over it), and its key. The tools say a
 * longer line on the status line when picked (TOOL_TIPS).
 */
const RAIL = {
  select: { name: 'Select', tip: 'Click a piece or a road point to pick it, then drag to move it.', key: 'V' },
  pencil: { name: 'Pencil', tip: 'Draw a new bit of road: start on the road and end back on it. Hold Shift for a straight line.', key: 'P' },
  straight: { name: 'Straight', tip: 'Click two spots on the road: the road between them goes dead straight.', key: 'L' },
  curve: { name: 'Curve', tip: 'Click where a bend starts and where it ends, then pull: the road between becomes one even curve.', key: 'C' },
  bend: { name: 'Bend', tip: 'Grab one spot on the road and pull it: the road around it follows. Mouse wheel: how much.', key: 'G' },
  bank: { name: 'Bank', tip: 'Pick a stretch of road and tilt it, like a banked corner.', key: 'B' },
  height: { name: 'Height', tip: 'Pick a stretch of road and raise it into a hill or a bridge, bring it down, or put it in a tunnel.', key: 'H' },
  width: { name: 'Width', tip: 'Pick a stretch of road and make it wider or narrower.', key: 'N' },
  place: { name: 'Place pieces', tip: 'Boost pads, ramps, loops, the start line and more: pick one, then click the road.', key: '1-0' },
  undo: { name: 'Undo', tip: 'Take back the last change.', key: 'Ctrl+Z' },
  redo: { name: 'Redo', tip: 'Put back what Undo took away.', key: 'Ctrl+Shift+Z' },
  newTrack: { name: 'New track', tip: 'Start a brand new track on an empty map. The track you were on stays in your Library (it asks first if it has changes not saved).', key: 'pad B' },
  random: { name: 'Random track', tip: 'Roll the dice for a whole new road that passes every check. On a saved track it makes a new track, so the saved one stays.', key: '' },
  zoomIn: { name: 'Zoom in', tip: 'See the map closer up. The mouse wheel zooms too.', key: '+' },
  zoomOut: { name: 'Zoom out', tip: 'See more of the map.', key: '-' },
  fit: { name: 'Fit track', tip: 'Fit the whole track on the screen.', key: 'F' },
  world: { name: 'Whole world', tip: 'Show the whole world, edge to edge.', key: '' },
  library: { name: 'Library', tip: 'Open, copy, import or export your tracks.', key: '' },
} as const

/** What each tool does, said once on the status line when you pick it. */
const TOOL_TIPS: Record<EditorTool, string> = {
  pencil: 'Pencil: start on the road and end back on the road to redraw the bit in between. Hold Shift while you draw for a straight line. On an empty map, draw a loop.',
  bend: 'Bend: grab one spot on the road and pull it, and the road around it follows. The mouse wheel (or [ and ]) changes how much road comes with it.',
  straight: 'Straight: click the road where the straight starts, then click where it ends.',
  curve: 'Curve: click the road where the curve starts, then where it ends, then pull the middle out and click. The road between becomes one even curve.',
  select: 'Select: click a piece or road point, drag to move it, Delete removes it. Double-click the road to add a point.',
  height: "Height: drag along the road to pick a stretch (or click the road), then set how high its middle goes in the panel, or press Make it a tunnel to put it underground. A tunnel needs a long stretch of plain road: a ramp down at each end as well as the covered part, with no loop, jump, wall ride, start line or other road on it.",
  bank: 'Bank: drag along the road to pick a stretch (or click a corner, or a BANK label), then set its tilt in the panel.',
  width: 'Width: drag along the road to pick a stretch (or click the road), then set how wide it is in the panel.',
  place: 'Place pieces: pick a piece, then click where it goes.',
}

/** The tools that only work on a road (all but the pencil): on an empty map they say so instead. */
function needsRoad(tool: EditorTool): boolean {
  return tool !== 'pencil'
}

export function EditorUi() {
  const mode = useEditor((s) => s.mode)
  const [library, setLibrary] = useState(false)
  // In the 3D view the map's drawing and tools wait (look3d.css dims them).
  const look3d = useLook3d((s) => s.mode !== 'map')

  // Esc / the pad's Menu button: close a dialog, then clear the selection, then leave.
  useEffect(() => {
    setAskBlocked(library)
    let seen = controlSignals.pause
    let raf = 0
    const tick = () => {
      if (controlSignals.pause !== seen) {
        seen = controlSignals.pause
        if (askTakesPause(seen)) {
          // The "Save it first?" box used this press to close.
        } else if (library) setLibrary(false)
        else if (closeLook3d()) {
          // Esc went back from the 3D view to the map.
        } else if (cancelBend() || cancelShaping()) {
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
    <div className={look3d ? 'sre is-3d' : 'sre'} style={cssVars} data-testid="editor-ui">
      <Overlay />
      <Look3dUi />
      <EmptyMapNote />
      <Toolbar onLibrary={() => setLibrary(true)} />
      <Palette />
      <ToolOptions />
      <Panel onLibrary={() => setLibrary(true)} onExit={leaveEditor} />
      <StatusLine />
      {library && <Library onClose={() => setLibrary(false)} />}
      <AskFirstDialog />
    </div>
  )
}

/**
 * Leave: the world map goes back to the paused game; the editor goes to the
 * title screen (the draft is kept), after asking "Save it first?" if the
 * track has changes not saved.
 */
export function leaveEditor(): void {
  if (useEditor.getState().mode === 'map') {
    closeWorldMap()
    return
  }
  askBeforeLeavingTrack('exit', goToTitle)
}

/** Leave the editor for the title screen, now. */
function goToTitle(): void {
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
          <ToolButton id="select" active={tool === 'select'} onClick={() => pickTool('select')} icon={<SelectIcon />} />
          <ToolButton id="pencil" active={tool === 'pencil'} onClick={() => pickTool('pencil')} icon={<PencilIcon />} />
          <ToolButton id="straight" active={tool === 'straight'} onClick={() => pickTool('straight')} icon={<StraightIcon />} />
          <ToolButton id="curve" active={tool === 'curve'} onClick={() => pickTool('curve')} icon={<CurveIcon />} />
          <ToolButton id="bend" active={tool === 'bend'} onClick={() => pickTool('bend')} icon={<BendIcon />} />
          <ToolButton id="bank" active={tool === 'bank'} onClick={() => pickTool('bank')} icon={<BankIcon />} />
          <ToolButton id="height" active={tool === 'height'} onClick={() => pickTool('height')} icon={<HeightIcon />} />
          <ToolButton id="width" active={tool === 'width'} onClick={() => pickTool('width')} icon={<WidthIcon />} />
          <ToolButton id="place" active={tool === 'place'} onClick={() => pickTool('place')} icon={<PiecesIcon />} />
          <div className="sre-tools-gap" />
          <ToolButton id="undo" disabled={!canUndo} onClick={undo} icon={<UndoIcon />} />
          <ToolButton id="redo" disabled={!canRedo} onClick={redo} icon={<UndoIcon flip />} />
          <ToolButton id="newTrack" onClick={() => askNewTrack()} icon={<NewTrackIcon />} />
          <ToolButton id="random" onClick={() => askRandomTrack()} icon={<DiceIcon />} />
          <div className="sre-tools-gap" />
        </>
      )}
      <ToolButton id="zoomIn" onClick={() => zoomAt(view.width / 2, view.height / 2, 1 / 1.4)} icon={<PlusIcon />} />
      <ToolButton id="zoomOut" onClick={() => zoomAt(view.width / 2, view.height / 2, 1.4)} icon={<MinusIcon />} />
      <ToolButton id="fit" onClick={fitToDraft} icon={<FitIcon />} />
      <ToolButton id="world" onClick={() => setView(0, 0, 1700 / Math.max(300, view.height - 120))} icon={<GlobeIcon />} />
      {editing && (
        <>
          <div className="sre-tools-gap" />
          <ToolButton id="library" onClick={props.onLibrary} icon={<LibraryIcon />} />
        </>
      )}
    </nav>
  )
}

/**
 * One rail button: its icon and its name in words, and a tip beside it that
 * shows the moment the mouse is over it (or it has keyboard focus): what it
 * does and its key. Drawn by the page, not the browser's slow `title` tooltip.
 */
function ToolButton(p: { id: keyof typeof RAIL; active?: boolean; disabled?: boolean; onClick: () => void; icon: ReactNode }) {
  const r = RAIL[p.id]
  const tipId = `sre-tip-${p.id}`
  return (
    <button
      type="button"
      className={`sre-tool${p.active ? ' is-active' : ''}`}
      disabled={p.disabled}
      onClick={() => {
        audio.ui('move')
        p.onClick()
      }}
      aria-pressed={p.active}
      aria-describedby={tipId}
      data-rail={p.id}
    >
      {p.icon}
      <span className="sre-tool-name">{r.name}</span>
      <span className="sre-tip" role="tooltip" id={tipId}>
        <span className="sre-tip-text">{r.tip}</span>
        {r.key && <kbd>{r.key}</kbd>}
      </span>
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
          {t.key && <kbd>{t.key}</kbd>}
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
        <p className="sre-help">Hold Shift while you draw for a dead straight line. Let go of Shift to carry on freehand.</p>
      </div>
    )
  }
  if (tool === 'bend') {
    return (
      <div className="sre-options" role="group" aria-label="Bend settings" data-testid="editor-tool-options">
        <span className="sre-options-title">Bend</span>
        <p className="sre-help">Grab one spot on the road and pull it: the road around it follows. (To make a stretch one even curve between two spots, use Curve.)</p>
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
        <p className="sre-help">{tool === 'straight' ? 'The ends ease into the road so there is no kink.' : 'The curve joins the road at both ends with no kink. (To pull one spot and let the road follow, use Bend.)'} Red means too tight for a car. Esc starts again.</p>
      </div>
    )
  }
  if (tool === 'height' || tool === 'bank' || tool === 'width') return <StretchSteps tool={tool} />
  return null
}

/** What to say beside the rail for Height, Bank and Width: where the setting is, and how to change one again. */
const STRETCH_STEPS: Record<'height' | 'bank' | 'width', { set: string; again: string }> = {
  height: {
    set: 'Set how high its middle goes, or press Make it a tunnel, in the panel on the right.',
    again: 'Violet dots on the road mean it is raised: click them to change that stretch again. Higher hills need longer stretches, and the panel says how much. A violet band is a tunnel: click it to change its length or take its roof off.',
  },
  bank: {
    set: 'Set its tilt, in the panel on the right.',
    again: 'An amber line with a BANK label is a bank you set: click it to change it, or press Auto in the panel to let the game bank it again.',
  },
  width: {
    set: 'Set how wide it is, in the panel on the right.',
    again: 'A WIDTH label is a width you set: click it to change it, or press Track width in the panel to put it back.',
  },
}

/** The Height, Bank or Width tool's box: two steps (the one you are on lit up), and how to change one again. */
function StretchSteps(p: { tool: 'height' | 'bank' | 'width' }) {
  const picked = useEditor((s) => s.selection?.kind === 'section')
  const words = STRETCH_STEPS[p.tool]
  const steps = ['Drag along the road to pick a stretch, or click the road.', words.set]
  const now = picked ? 1 : 0
  return (
    <div className="sre-options" role="group" aria-label={`${RAIL[p.tool].name} steps`} data-testid="editor-tool-options">
      <span className="sre-options-title">{RAIL[p.tool].name}</span>
      <ol className="sre-steps">
        {steps.map((text, i) => (
          <li key={text} className={i === now ? 'is-now' : i < now ? 'is-done' : undefined}>
            <span className="sre-step-num">{i + 1}</span>
            {text}
          </li>
        ))}
      </ol>
      <p className="sre-help">{words.again}</p>
    </div>
  )
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
