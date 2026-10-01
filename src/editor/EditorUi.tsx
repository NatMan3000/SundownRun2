// ============================================================
//  EDITOR UI - the toolbar, the side panel and the track library
// ------------------------------------------------------------
//  The DOM half of the road editor (the 3D half is the top-down
//  camera). Laid out like a drawing app:
//
//    left    tools: pencil, pan, undo, redo, fit, zoom
//    right   this track: name, width, world, time of day, colour,
//            anything the game wants to tell you, Save, Test drive
//    bottom  one status line in plain words
//
//  The library dialog opens saved tracks, starts new ones, copies
//  a built-in track, and imports / exports track files.
// ============================================================

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { FONTS, PALETTE } from '../core/palette'
import { controlSignals, setInputContext } from '../core/controls'
import { endSession } from '../core/session'
import { audio } from '../core/api'
import { deleteDrawnTrack, downloadTrack, importTrackJson, listTracks } from '../track/registry'
import type { TrackFile } from '../track/schema'
import { BASE_WORLDS } from './draftFile'
import {
  type Draft,
  draftFromFile,
  fileFromDraft,
  newDraft,
  redo,
  replaceDraft,
  saveDraft,
  say,
  setAuthor,
  setBaseWorld,
  setEdgeColour,
  setName,
  setTimeOfDay,
  setWidth,
  testDrive,
  undo,
  useEditor,
} from './draft'
import { Overlay, fitToDraft, issueLocation, pencilHint } from './Overlay'
import { setView, view, zoomAt } from './view'
import { polylineLength } from './geom'
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
  '--font-body': FONTS.body,
  '--font-display': FONTS.display,
  '--font-mono': FONTS.mono,
} as CSSProperties

/** Edge-strip colours a track can pick (the road's light strips). */
const EDGE_COLOURS = [PALETTE.roadEdge, PALETTE.roadEdgeAlt, PALETTE.boost, PALETTE.chevron, PALETTE.wallRide, PALETTE.aiColors[0]]

export function EditorUi() {
  const mode = useEditor((s) => s.mode)
  const [library, setLibrary] = useState(false)

  // Esc (or the pad's Menu button) leaves the editor. The working copy is kept.
  useEffect(() => {
    let seen = controlSignals.pause
    let raf = 0
    const tick = () => {
      if (controlSignals.pause !== seen) {
        seen = controlSignals.pause
        if (library) setLibrary(false)
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
      <Panel onLibrary={() => setLibrary(true)} />
      <StatusLine />
      {library && <Library onClose={() => setLibrary(false)} />}
    </div>
  )
}

export function leaveEditor(): void {
  audio.ui('back')
  endSession()
}

// ---------------------------------------------------------------- toolbar

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
          <ToolButton label="Pencil" keyHint="P" active={tool === 'pencil'} onClick={() => useEditor.setState({ tool: 'pencil' })} icon={<PencilIcon />} />
          <ToolButton label="Pan" keyHint="H or Space" active={tool === 'pan'} onClick={() => useEditor.setState({ tool: 'pan' })} icon={<HandIcon />} />
          <div className="sre-tools-gap" />
          <ToolButton label="Undo" keyHint="Ctrl+Z" disabled={!canUndo} onClick={undo} icon={<UndoIcon />} />
          <ToolButton label="Redo" keyHint="Ctrl+Shift+Z" disabled={!canRedo} onClick={redo} icon={<UndoIcon flip />} />
          <div className="sre-tools-gap" />
        </>
      )}
      <ToolButton label="Fit track" keyHint="F" onClick={fitToDraft} icon={<FitIcon />} />
      <ToolButton label="Zoom in" keyHint="+" onClick={() => zoomAt(view.width / 2, view.height / 2, 1 / 1.4)} icon={<span className="sre-glyph">+</span>} />
      <ToolButton label="Zoom out" keyHint="-" onClick={() => zoomAt(view.width / 2, view.height / 2, 1.4)} icon={<span className="sre-glyph">-</span>} />
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

function ToolButton(p: { label: string; keyHint?: string; active?: boolean; disabled?: boolean; onClick: () => void; icon: React.ReactNode }) {
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

// ---------------------------------------------------------------- side panel

function Panel(props: { onLibrary: () => void }) {
  const mode = useEditor((s) => s.mode)
  const draft = useEditor((s) => s.draft)
  const dirty = useEditor((s) => s.dirty)
  const savedId = useEditor((s) => s.savedId)
  const preview = useEditor((s) => s.preview)
  const length = useMemo(() => polylineLength(draft.points, true), [draft.points])

  if (mode === 'map') {
    return (
      <aside className="sre-panel" aria-label="World map">
        <header className="sre-head">
          <div className="sre-kicker">World map</div>
          <h1 className="sre-title">{draft.name}</h1>
        </header>
        <Legend />
        <div className="sre-actions">
          <button type="button" className="sre-btn is-primary" onClick={leaveEditor}>
            Back
          </button>
        </div>
      </aside>
    )
  }

  return (
    <aside className="sre-panel" aria-label="This track">
      <header className="sre-head">
        <div className="sre-kicker">
          Road editor
          <span className={`sre-state is-${preview}`}>{preview === 'pending' ? 'building...' : preview === 'failed' ? 'needs fixing' : dirty ? 'not saved' : savedId ? 'saved' : 'new'}</span>
        </div>
        <TextField label="Track name" value={draft.name} onCommit={setName} big />
        <div className="sre-stats">
          <Stat label="Length" value={`${(length / 1000).toFixed(2)} km`} />
          <Stat label="Points" value={String(draft.points.length)} />
          <Stat label="Bridges" value={String(countBridges(draft))} />
        </div>
      </header>

      <section className="sre-section">
        <SliderField label="Road width" value={draft.width} min={10} max={24} step={1} unit="m" onCommit={setWidth} help="How wide the road is, edge to edge." />
        <SelectField
          label="World"
          value={draft.baseWorld}
          options={[...BASE_WORLDS.map((b) => ({ value: b.id, label: b.name })), ...(draft.baseWorld === 'custom' ? [{ value: 'custom', label: 'From the original track' }] : [])]}
          onChange={setBaseWorld}
          help={BASE_WORLDS.find((b) => b.id === draft.baseWorld)?.blurb ?? 'The ground, sky and city this track came with.'}
        />
        <SliderField
          label="Time of day"
          value={draft.environment.sky?.timeOfDay ?? 0.12}
          min={0}
          max={1}
          step={0.05}
          format={(v) => (v < 0.2 ? 'Sundown' : v < 0.5 ? 'Dusk' : v < 0.8 ? 'Night falling' : 'Night')}
          onCommit={setTimeOfDay}
          help="The light this track starts in (players can still change it in Settings)."
        />
        <ColourField label="Edge lights" value={draft.environment.palette?.edge ?? PALETTE.roadEdge} options={EDGE_COLOURS} onChange={setEdgeColour} />
        <TextField label="Made by" value={draft.author} onCommit={setAuthor} placeholder="Your name" />
      </section>

      <Problems />
      <Legend />

      <div className="sre-actions">
        <button type="button" className="sre-btn" onClick={() => saveDraft() && audio.ui('select')}>
          Save
        </button>
        <button type="button" className="sre-btn" onClick={props.onLibrary}>
          Library
        </button>
        <button type="button" className="sre-btn is-primary" onClick={testDrive} data-testid="editor-test-drive">
          Test drive
        </button>
        <button type="button" className="sre-btn is-quiet" onClick={leaveEditor}>
          Exit
        </button>
      </div>
    </aside>
  )
}

function countBridges(d: Draft): number {
  let n = 0
  for (let i = 0; i < d.points.length; i++) {
    const lift = d.points[i].lift ?? 0
    const prev = d.points[(i - 1 + d.points.length) % d.points.length].lift ?? 0
    if (lift >= 6 && prev < 6) n++
  }
  return n
}

function Stat(p: { label: string; value: string }) {
  return (
    <div className="sre-stat">
      <span className="sre-stat-value">{p.value}</span>
      <span className="sre-stat-label">{p.label}</span>
    </div>
  )
}

/** Text input that only changes the draft when you finish typing (Enter or click away): one undo step per edit. */
function TextField(p: { label: string; value: string; onCommit: (v: string) => void; placeholder?: string; big?: boolean }) {
  const [text, setText] = useState(p.value)
  useEffect(() => setText(p.value), [p.value])
  const done = () => {
    setInputContext('editor')
    if (text !== p.value) p.onCommit(text)
  }
  return (
    <label className={`sre-field${p.big ? ' is-big' : ''}`}>
      <span className="sre-label">{p.label}</span>
      <input
        className="sre-input"
        value={text}
        placeholder={p.placeholder}
        maxLength={40}
        onChange={(e) => setText(e.target.value)}
        onFocus={() => setInputContext('text')}
        onBlur={done}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') {
            setText(p.value)
            ;(e.target as HTMLInputElement).blur()
          }
          e.stopPropagation()
        }}
      />
    </label>
  )
}

/** Slider that previews while dragging and commits one undo step on release. */
function SliderField(p: { label: string; value: number; min: number; max: number; step: number; unit?: string; format?: (v: number) => string; onCommit: (v: number) => void; help?: string }) {
  const [v, setV] = useState(p.value)
  const dragging = useRef(false)
  useEffect(() => {
    if (!dragging.current) setV(p.value)
  }, [p.value])
  const commitNow = () => {
    dragging.current = false
    if (v !== p.value) {
      audio.ui('slide')
      p.onCommit(v)
    }
  }
  return (
    <label className="sre-field" title={p.help}>
      <span className="sre-label">
        {p.label}
        <span className="sre-value">{p.format ? p.format(v) : `${v}${p.unit ? ` ${p.unit}` : ''}`}</span>
      </span>
      <input
        type="range"
        className="sre-range"
        min={p.min}
        max={p.max}
        step={p.step}
        value={v}
        onPointerDown={() => (dragging.current = true)}
        onChange={(e) => setV(Number(e.target.value))}
        onPointerUp={commitNow}
        onKeyUp={commitNow}
        onBlur={() => dragging.current && commitNow()}
      />
    </label>
  )
}

function SelectField(p: { label: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void; help?: string }) {
  return (
    <label className="sre-field">
      <span className="sre-label">{p.label}</span>
      <select
        className="sre-input"
        value={p.value}
        onChange={(e) => {
          audio.ui('toggle')
          p.onChange(e.target.value)
        }}
      >
        {p.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {p.help && <span className="sre-help">{p.help}</span>}
    </label>
  )
}

function ColourField(p: { label: string; value: string; options: readonly string[]; onChange: (v: string) => void }) {
  return (
    <div className="sre-field">
      <span className="sre-label">{p.label}</span>
      <div className="sre-swatches" role="radiogroup" aria-label={p.label}>
        {p.options.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={c.toLowerCase() === p.value.toLowerCase()}
            className={`sre-swatch${c.toLowerCase() === p.value.toLowerCase() ? ' is-on' : ''}`}
            style={{ '--swatch': c } as CSSProperties}
            onClick={() => {
              audio.ui('toggle')
              p.onChange(c)
            }}
            aria-label={c}
          />
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- problems

/** Everything the game wants to tell you, in plain words; click one to see where it is. */
function Problems() {
  const errors = useEditor((s) => s.errors)
  const warnings = useEditor((s) => s.warnings)
  const notes = useEditor((s) => s.notes)
  const points = useEditor((s) => s.draft.points)
  const items = [
    ...errors.map((e) => ({ tone: 'bad' as const, text: plainIssue(e.path, e.message), at: issueLocation(e.path, points) })),
    ...warnings.filter((w) => !(/crosses itself/.test(w.message) && points.some((p) => (p.lift ?? 0) >= 6))).map((w) => ({ tone: 'warn' as const, text: plainIssue(w.path, w.message), at: issueLocation(w.path, points) })),
    ...(notes?.issues ?? []).map((i) => ({ tone: i.level === 'error' ? ('bad' as const) : i.level === 'warning' ? ('warn' as const) : ('note' as const), text: i.message, at: i.at ?? null })),
  ]
  if (!items.length) {
    return (
      <section className="sre-section sre-problems is-clear">
        <span className="sre-label">Checks</span>
        <p className="sre-ok">All good: this track builds and drives.</p>
      </section>
    )
  }
  return (
    <section className="sre-section sre-problems">
      <span className="sre-label">Checks</span>
      <ul>
        {items.slice(0, 8).map((it, i) => (
          <li key={i}>
            <button
              type="button"
              className={`sre-issue is-${it.tone}`}
              disabled={!it.at}
              onClick={() => it.at && setView(it.at.x, it.at.z, Math.min(view.mpp, 0.9))}
            >
              {it.text}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** The validator talks about "road.points[3]"; Josh doesn't need the path. */
function plainIssue(path: string, message: string): string {
  const text = message.charAt(0).toUpperCase() + message.slice(1)
  return path && !path.startsWith('road.points') && !path.startsWith('pieces') ? `${path}: ${text}` : text
}

function Legend() {
  return (
    <section className="sre-section sre-legend" aria-label="Map key">
      <span className="sre-label">Map key</span>
      <ul>
        <li>
          <i className="k-start" /> Start line
        </li>
        <li>
          <i className="k-arrow" /> Driving direction
        </li>
        <li>
          <i className="k-point" /> Road point
        </li>
        <li>
          <i className="k-bridge" /> Bridge (raised road)
        </li>
        <li>
          <i className="k-warn" /> Something to check
        </li>
      </ul>
    </section>
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

// ---------------------------------------------------------------- library

function Library(props: { onClose: () => void }) {
  const [version, setVersion] = useState(0)
  const tracks = useMemo(() => listTracks(), [version])
  const fileInput = useRef<HTMLInputElement>(null)
  const [newWorld, setNewWorld] = useState(BASE_WORLDS[0].id)
  const dirty = useEditor((s) => s.dirty)

  const open = (file: TrackFile, asCopy: boolean) => {
    if (dirty && !window.confirm('Your changes to this track are not saved. Open another one anyway?')) return
    audio.ui('select')
    replaceDraft(draftFromFile(file, asCopy), asCopy ? null : file.id)
    requestAnimationFrame(fitToDraft)
    say(asCopy ? `Editing a copy of "${file.name}". Save it to keep it.` : `Opened "${file.name}".`, 'good')
    props.onClose()
  }
  const startNew = () => {
    if (dirty && !window.confirm('Your changes to this track are not saved. Start a new one anyway?')) return
    audio.ui('select')
    replaceDraft(newDraft(newWorld), null)
    requestAnimationFrame(fitToDraft)
    pencilHint()
    props.onClose()
  }
  const onImport = async (file: File | undefined) => {
    if (!file) return
    const text = await file.text()
    const result = importTrackJson(text)
    if (!result.ok) {
      audio.ui('error')
      say(`That file isn't a track this game can load: ${result.errors[0]?.message ?? 'unknown problem'}.`, 'bad')
      return
    }
    setVersion((v) => v + 1)
    say(`Imported "${result.track?.name ?? file.name}". It's in your tracks now.`, 'good')
    audio.ui('select')
  }

  return (
    <div className="sre-modal" role="dialog" aria-modal="true" aria-label="Track library" onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="sre-library">
        <header className="sre-lib-head">
          <h2>Track library</h2>
          <button type="button" className="sre-btn is-quiet" onClick={props.onClose}>
            Close
          </button>
        </header>

        <div className="sre-lib-new">
          <div>
            <span className="sre-label">New track</span>
            <select className="sre-input" value={newWorld} onChange={(e) => setNewWorld(e.target.value)} aria-label="World for the new track">
              {BASE_WORLDS.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
            <span className="sre-help">{BASE_WORLDS.find((b) => b.id === newWorld)?.blurb}</span>
          </div>
          <button type="button" className="sre-btn is-primary" onClick={startNew}>
            Start drawing
          </button>
        </div>

        <ul className="sre-lib-list">
          {tracks.map((t) => (
            <li key={`${t.source}:${t.id}`} className="sre-lib-row">
              <div className="sre-lib-name">
                <strong>{t.name}</strong>
                <span>{t.source === 'builtin' ? 'Built-in' : t.source === 'shared' ? 'From the host' : `Yours${t.author ? `, by ${t.author}` : ''}`}</span>
              </div>
              <div className="sre-lib-acts">
                {t.source === 'drawn' ? (
                  <>
                    <button type="button" className="sre-btn" onClick={() => open(t.file, false)}>
                      Open
                    </button>
                    <button type="button" className="sre-btn is-quiet" onClick={() => downloadTrack(t.file)}>
                      Export
                    </button>
                    <button
                      type="button"
                      className="sre-btn is-danger"
                      onClick={() => {
                        if (!window.confirm(`Delete "${t.name}" from this browser? Export it first if you want to keep a copy.`)) return
                        deleteDrawnTrack(t.id)
                        if (useEditor.getState().savedId === t.id) useEditor.setState({ savedId: null, dirty: true, draft: { ...useEditor.getState().draft, id: '' } })
                        setVersion((v) => v + 1)
                        say(`Deleted "${t.name}".`, 'info')
                      }}
                    >
                      Delete
                    </button>
                  </>
                ) : (
                  <button type="button" className="sre-btn" onClick={() => open(t.file, true)}>
                    Copy and edit
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>

        <footer className="sre-lib-foot">
          <button type="button" className="sre-btn" onClick={() => fileInput.current?.click()}>
            Import a track file
          </button>
          <button type="button" className="sre-btn is-quiet" onClick={() => downloadTrack(fileFromDraft(useEditor.getState().draft, useEditor.getState().savedId ?? undefined))}>
            Export this track
          </button>
          <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={(e) => void onImport(e.target.files?.[0])} />
        </footer>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- icons (inline SVG, no files to load)

function Svg(p: { children: React.ReactNode; style?: CSSProperties }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={p.style}>
      {p.children}
    </svg>
  )
}
const PencilIcon = () => (
  <Svg>
    <path d="M4 20l4-1 11-11-3-3L5 16l-1 4z" />
    <path d="M14 7l3 3" />
  </Svg>
)
const HandIcon = () => (
  <Svg>
    <path d="M8 12V6a1.5 1.5 0 013 0v5M11 11V4.5a1.5 1.5 0 013 0V11M14 11V6a1.5 1.5 0 013 0v7c0 4-2.5 7-6 7-2.5 0-4-1.3-5.5-3.5L3.8 13a1.5 1.5 0 012.4-1.8L8 13.5" />
  </Svg>
)
const UndoIcon = (p: { flip?: boolean }) => (
  <Svg style={p.flip ? { transform: 'scaleX(-1)' } : undefined}>
    <path d="M9 14L4 9l5-5" />
    <path d="M4 9h10a6 6 0 010 12h-3" />
  </Svg>
)
const FitIcon = () => (
  <Svg>
    <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
  </Svg>
)
const GlobeIcon = () => (
  <Svg>
    <circle cx="12" cy="12" r="8" />
    <path d="M4 12h16M12 4c2.5 2.5 2.5 13.5 0 16M12 4c-2.5 2.5-2.5 13.5 0 16" />
  </Svg>
)
const LibraryIcon = () => (
  <Svg>
    <path d="M5 4h4v16H5zM10 4h4v16h-4zM15.5 5l3.5-1 3 15-3.5 1z" />
  </Svg>
)
