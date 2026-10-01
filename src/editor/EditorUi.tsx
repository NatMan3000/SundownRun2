// ============================================================
//  EDITOR UI - the DOM layer of the road editor
// ------------------------------------------------------------
//  The 3D half is the top-down camera; this is everything on top,
//  laid out like a drawing app:
//
//    the map     Overlay.tsx (pencil, selecting, dragging, placing)
//    left        the tool rail, and the piece palette when placing
//    right       Panel.tsx (this track, the selected thing, checks)
//    bottom      one status line in plain words
//    dialog      Library.tsx (open, new, copy, import, export)
//
//  Esc (or the pad's Menu button): first clears a selection, then
//  leaves the editor. Work is never lost: the draft is kept.
// ============================================================

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { FONTS, PALETTE } from '../core/palette'
import { controlSignals } from '../core/controls'
import { endSession } from '../core/session'
import { audio } from '../core/api'
import { type EditorTool, redo, say, setTool, undo, useEditor } from './draft'
import { Overlay, fitToDraft, pencilHint } from './Overlay'
import { Panel } from './Panel'
import { Library } from './Library'
import { PLACE_TOOLS, type PlaceKind } from './pieces'
import { setView, view, zoomAt } from './view'
import { FitIcon, GlobeIcon, HandIcon, LibraryIcon, MinusIcon, PencilIcon, PlaceIcon, PlusIcon, SectionIcon, SelectIcon, UndoIcon } from './icons'
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
  pencil: 'Pencil: draw a loop for a new road, or draw from the road back to the road to redraw that stretch.',
  select: 'Select: click a piece or road point, drag to move it, Delete removes it. Double-click the road to add a point.',
  section: 'Bank and width: drag along the road to pick a stretch, then set it in the panel.',
  place: 'Place: pick a piece, then click where it goes.',
  pan: 'Pan: drag to move the map.',
}

export function EditorUi() {
  const mode = useEditor((s) => s.mode)
  const [library, setLibrary] = useState(false)

  // Esc / the pad's Menu button: close the library, then clear the selection, then leave.
  useEffect(() => {
    let seen = controlSignals.pause
    let raf = 0
    const tick = () => {
      if (controlSignals.pause !== seen) {
        seen = controlSignals.pause
        if (library) setLibrary(false)
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
      <Toolbar onLibrary={() => setLibrary(true)} />
      <Palette />
      <Panel onLibrary={() => setLibrary(true)} onExit={leaveEditor} />
      <StatusLine />
      {library && <Library onClose={() => setLibrary(false)} />}
    </div>
  )
}

export function leaveEditor(): void {
  audio.ui('back')
  endSession()
}

function pickTool(tool: EditorTool, kind?: PlaceKind): void {
  const before = useEditor.getState().tool
  setTool(tool, kind)
  if (before !== tool) say(TOOL_TIPS[tool], 'info')
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
          <ToolButton label="Pencil" keyHint="P" active={tool === 'pencil'} onClick={() => pickTool('pencil')} icon={<PencilIcon />} />
          <ToolButton label="Select and move" keyHint="V" active={tool === 'select'} onClick={() => pickTool('select')} icon={<SelectIcon />} />
          <ToolButton label="Place pieces" keyHint="1-0" active={tool === 'place'} onClick={() => pickTool('place')} icon={<PlaceIcon />} />
          <ToolButton label="Bank and width" keyHint="B" active={tool === 'section'} onClick={() => pickTool('section')} icon={<SectionIcon />} />
          <ToolButton label="Pan" keyHint="H or Space" active={tool === 'pan'} onClick={() => pickTool('pan')} icon={<HandIcon />} />
          <div className="sre-tools-gap" />
          <ToolButton label="Undo" keyHint="Ctrl+Z" disabled={!canUndo} onClick={undo} icon={<UndoIcon />} />
          <ToolButton label="Redo" keyHint="Ctrl+Shift+Z" disabled={!canRedo} onClick={redo} icon={<UndoIcon flip />} />
          <div className="sre-tools-gap" />
        </>
      )}
      <ToolButton label="Fit track" keyHint="F" onClick={fitToDraft} icon={<FitIcon />} />
      <ToolButton label="Zoom in" keyHint="+" onClick={() => zoomAt(view.width / 2, view.height / 2, 1 / 1.4)} icon={<PlusIcon />} />
      <ToolButton label="Zoom out" keyHint="-" onClick={() => zoomAt(view.width / 2, view.height / 2, 1.4)} icon={<MinusIcon />} />
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
