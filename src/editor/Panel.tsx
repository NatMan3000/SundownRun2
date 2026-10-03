// ============================================================
//  EDITOR PANEL - the right-hand side: this track, and what's selected
// ------------------------------------------------------------
//  Top to bottom:
//    the name and a few numbers (length, pieces, bridges)
//    SELECTED  settings for whatever you clicked on the map: a piece,
//              a crash-prop pile, an energy core, a road point, a
//              stretch of road (its height, bank and width), a crossing
//              (which road goes over: the Swap button), or a problem
//              from Checks (what's wrong, and Fix it or Show me)
//    TRACK     width, world, time of day, edge lights, maker, blurb
//    CHECKS    anything the game wants you to look at; click one to select
//              it (and see where it is), or Fix all
//    MAP KEY   what the marks on the map mean
//    Save / Library / Test drive / Exit
// ============================================================

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { PALETTE } from '../core/palette'
import { audio } from '../core/api'
import { listTracks } from '../track/registry'
import { TRACK_DEFAULTS, type Piece } from '../track/schema'
import { BASE_WORLDS, isEmptyDraft } from './draftFile'
import {
  type Draft,
  type Selection,
  copyEnvironmentFrom,
  deletePoint,
  deleteSelection,
  saveDraft,
  sectionPoints,
  setAuthor,
  setBaseWorld,
  setDescription,
  setEdgeColour,
  setName,
  setSectionBank,
  setSectionWidth,
  setTimeOfDay,
  setWidth,
  smoothRoad,
  testDrive,
  updateCore,
  updatePiece,
  updateProp,
  useEditor,
  applyCornerRadius,
  draftCrossings,
  pointGroundFor,
  swapBridge,
} from './draft'
import { currentProblems, fixAll, fixProblem, goToProblem, lastFixed, liveRuntime, raisePoint, raiseSection, selectProblem } from './fixActions'
import { NO_NOTES, type Problem, problemByKey, problemsOf } from './problems'
import { RAISE_MAX, heightRange, liftAt, stretchNow, stretchSpeed } from './raise'
import './fixes.css'
import { BRIDGE_GAP, bridgeCount, compassWord, crossingNear } from './bridges'
import { ColourField, Segmented, SelectField, SliderField, TextField } from './fields'
import { issueLocation, roadGeometry } from './mapDraw'
import { checkVerdict } from './checks'
import { pieceLabel } from './pieces'
import { startDriveToDraw } from './driveToDraw'
import { metresBetween, roadLength } from './road'
import { cornerAt, roadLine } from './shape'
import { setView, view } from './view'

/** Edge-strip colours a track can pick (the road's light strips). */
const EDGE_COLOURS = [PALETTE.roadEdge, PALETTE.roadEdgeAlt, PALETTE.boost, PALETTE.chevron, PALETTE.wallRide, PALETTE.aiColors[0]]

export function Panel(props: { onLibrary: () => void; onExit: () => void }) {
  const mode = useEditor((s) => s.mode)
  const draft = useEditor((s) => s.draft)
  const dirty = useEditor((s) => s.dirty)
  const savedId = useEditor((s) => s.savedId)
  const preview = useEditor((s) => s.preview)
  const gateFails = useEditor((s) => s.checkedDraft === s.draft && !!s.gates?.some((g) => g.level === 'fail'))
  const selection = useEditor((s) => s.selection)
  const length = useMemo(() => roadLength(roadGeometry(draft.points, draft.width).rc), [draft.points, draft.width])

  if (mode === 'map') {
    return (
      <aside className="sre-panel" aria-label="World map">
        <header className="sre-head">
          <div className="sre-kicker">World map</div>
          <h1 className="sre-title">{draft.name}</h1>
          <div className="sre-stats">
            <Stat label="Length" value={`${(length / 1000).toFixed(2)} km`} />
            <Stat label="Pieces" value={String(draft.pieces.length)} />
            <Stat label="Cores" value={String(draft.cores.length)} />
          </div>
        </header>
        <div className="sre-body">
          <Legend />
        </div>
        <div className="sre-actions">
          <button type="button" className="sre-btn is-primary" onClick={props.onExit}>
            Back to the game
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
          <span className={`sre-state is-${gateFails && preview === 'built' ? 'failed' : preview}`}>{preview === 'pending' ? 'building...' : preview === 'failed' || gateFails ? 'needs fixing' : dirty ? 'not saved' : savedId ? 'saved' : 'new'}</span>
        </div>
        <TextField label="Track name" value={draft.name} onCommit={setName} big />
        <div className="sre-stats">
          <Stat label="Length" value={`${(length / 1000).toFixed(2)} km`} />
          <Stat label="Pieces" value={String(draft.pieces.length + draft.props.length + draft.cores.length)} />
          <Stat label="Bridges" value={String(bridgeCount(draft.points, draftCrossings(draft)))} />
        </div>
      </header>

      <div className="sre-body">
        {selection && <Inspector selection={selection} draft={draft} />}

        <section className="sre-section" aria-label="Track">
          <span className="sre-section-title">Track</span>
          <SliderField label="Road width" value={draft.width} min={10} max={24} step={1} unit="m" onCommit={setWidth} help="How wide the road is, edge to edge." />
          <WorldField draft={draft} />
          <SliderField
            label="Time of day"
            value={draft.environment.sky?.timeOfDay ?? TRACK_DEFAULTS.timeOfDay}
            min={0}
            max={1}
            step={0.05}
            format={(v) => (v < 0.2 ? 'Sundown' : v < 0.5 ? 'Dusk' : v < 0.8 ? 'Night falling' : 'Night')}
            onCommit={setTimeOfDay}
            help="The light this track starts in (players can still change it in Settings)."
          />
          <ColourField label="Edge lights" value={draft.environment.palette?.edge ?? PALETTE.roadEdge} options={EDGE_COLOURS} onChange={setEdgeColour} />
          <TextField label="Made by" value={draft.author} onCommit={setAuthor} placeholder="Your name" />
          <TextField label="About this track" value={draft.description} onCommit={setDescription} placeholder="One line for the track list" multiline max={200} />
          <div className="sre-row">
            {/* Drive to draw makes a whole new road, so it is offered on the empty map only (driveToDraw.tsx). */}
            {isEmptyDraft(draft) ? (
              <button type="button" className="sre-btn" onClick={() => startDriveToDraw()} title="Drive anywhere in this world: the car lays a road behind it, and it opens here when you finish.">
                Drive to draw
              </button>
            ) : (
              <button type="button" className="sre-btn" onClick={() => smoothRoad()} title="Irons the wobbles and kinks out of the whole road. Press again for smoother still; Undo if you don't like it.">
                Smooth the road
              </button>
            )}
          </div>
        </section>

        <Problems />
        <Legend />
      </div>

      <div className="sre-actions">
        {isEmptyDraft(draft) && <p className="sre-help sre-actions-why">Draw a road first, then you can save it and test drive it.</p>}
        <button type="button" className="sre-btn" onClick={() => saveDraft() && audio.ui('select')} disabled={isEmptyDraft(draft)}>
          Save
        </button>
        <button type="button" className="sre-btn" onClick={props.onLibrary}>
          Library
        </button>
        <button type="button" className="sre-btn is-primary" onClick={testDrive} disabled={isEmptyDraft(draft)} data-testid="editor-test-drive">
          Test drive
        </button>
        <button type="button" className="sre-btn is-quiet" onClick={props.onExit}>
          Exit
        </button>
      </div>
    </aside>
  )
}

function Stat(p: { label: string; value: string }) {
  return (
    <div className="sre-stat">
      <span className="sre-stat-value">{p.value}</span>
      <span className="sre-stat-label">{p.label}</span>
    </div>
  )
}

/** The base world picker, plus "use the world from" any built-in track. */
function WorldField(p: { draft: Draft }) {
  const builtins = useMemo(() => listTracks().filter((t) => t.source === 'builtin'), [])
  const options = [
    ...BASE_WORLDS.map((b) => ({ value: b.id, label: b.name })),
    ...builtins.map((t) => ({ value: `copy:${t.id}`, label: `World from ${t.name}` })),
    ...(p.draft.baseWorld === 'custom' ? [{ value: 'custom', label: 'From the original track' }] : []),
  ]
  const help = BASE_WORLDS.find((b) => b.id === p.draft.baseWorld)?.blurb ?? 'The ground, sky, city and music of another track.'
  return (
    <SelectField
      label="World"
      value={p.draft.baseWorld}
      options={options}
      help={help}
      onChange={(v) => {
        if (v.startsWith('copy:')) {
          const t = builtins.find((b) => `copy:${b.id}` === v)
          if (t) copyEnvironmentFrom(t.file)
        } else setBaseWorld(v)
      }}
    />
  )
}

// ---------------------------------------------------------------- selected thing

function Inspector(p: { selection: Selection; draft: Draft }) {
  const sel = p.selection
  // A problem picked from Checks (lower down) or a map pin: bring this box into view.
  const box = useRef<HTMLElement>(null)
  const problemKey = sel.kind === 'problem' ? sel.key : null
  useEffect(() => {
    if (problemKey) box.current?.scrollIntoView({ block: 'nearest' })
  }, [problemKey])
  const d = p.draft
  const rc = roadGeometry(d.points, d.width).rc
  let title = ''
  let body: ReactNode = null
  let canDelete = true

  if (sel.kind === 'piece') {
    const piece = d.pieces[sel.index]
    if (!piece) return null
    title = pieceLabel(piece)
    body = <PieceFields piece={piece} index={sel.index} roadWidth={d.width} />
    const from = Math.round(metresBetween(rc, d.startAt, piece.at))
    body = (
      <>
        <p className="sre-help">{from} m after the start line.</p>
        {body}
      </>
    )
  } else if (sel.kind === 'prop') {
    const prop = d.props[sel.index]
    if (!prop) return null
    title = 'Crash props'
    body = (
      <>
        <Segmented
          label="What's in the pile"
          value={prop.kind ?? 'mixed'}
          options={[
            { value: 'mixed', label: 'Mixed' },
            { value: 'crates', label: 'Crates' },
            { value: 'cubes', label: 'Cubes' },
            { value: 'tower', label: 'Tower' },
          ]}
          onChange={(v) => updateProp(sel.index, (x) => (x.kind = v))}
        />
        <Segmented
          label="How many"
          value={prop.size ?? 'medium'}
          options={[
            { value: 'small', label: 'Few' },
            { value: 'medium', label: 'Some' },
            { value: 'large', label: 'Loads' },
          ]}
          onChange={(v) => updateProp(sel.index, (x) => (x.size = v))}
        />
      </>
    )
  } else if (sel.kind === 'core') {
    const core = d.cores[sel.index]
    if (!core) return null
    title = 'Energy core'
    body = (
      <SliderField
        label="Height above the ground"
        value={core.y ?? TRACK_DEFAULTS.coreHeight}
        min={0.8}
        max={30}
        step={0.2}
        unit="m"
        help="Put some up high as a challenge (jump to them)."
        onCommit={(v) => updateCore(sel.index, (x) => (x.y = v))}
      />
    )
  } else if (sel.kind === 'point') {
    const point = d.points[sel.index]
    if (!point) return null
    title = `Road point ${sel.index + 1} of ${d.points.length}`
    body = (
      <>
        <p className="sre-help">Drag it on the map to reshape the road. Double-click the road to add a point.</p>
        <CornerField index={sel.index} draft={d} />
        <PointHeight index={sel.index} draft={d} />
      </>
    )
  } else if (sel.kind === 'crossing') {
    title = 'Where the road crosses itself'
    canDelete = false
    body = <CrossingFields spot={sel} draft={d} />
  } else if (sel.kind === 'problem') {
    const tone = problemByKey(currentProblems(), sel.key)?.tone
    title = tone === 'warn' ? 'Worth a look' : tone === 'note' ? 'Note' : 'Problem'
    canDelete = false
    body = <ProblemFields problemKey={sel.key} />
  } else {
    title = 'Stretch of road'
    canDelete = false
    const idx = sectionPoints(d.points.length, sel.from, sel.to)
    const first = d.points[idx[0]]
    const metres = Math.round(metresBetween(rc, sel.from, sel.to))
    body = (
      <>
        <p className="sre-help">
          {metres} m of road, {idx.length} point{idx.length === 1 ? '' : 's'}. Banking tilts the road into the corner; auto banks it from how tight the corner is.
        </p>
        <StretchHeight from={sel.from} to={sel.to} draft={d} />
        <SliderField
          label="Bank"
          value={first?.bank ?? 0}
          min={-10}
          max={45}
          step={1}
          format={(v) => (first?.bank === undefined ? 'Auto' : `${v}°`)}
          reset={first?.bank !== undefined ? { label: 'Auto', onClick: () => setSectionBank(sel.from, sel.to, null) } : undefined}
          onCommit={(v) => setSectionBank(sel.from, sel.to, v)}
          help="Degrees into the corner. Negative tilts it the wrong way (off-camber)."
        />
        <SliderField
          label="Width here"
          value={first?.width ?? d.width}
          min={10}
          max={24}
          step={1}
          format={(v) => (first?.width === undefined ? `${d.width} m (track)` : `${v} m`)}
          reset={first?.width !== undefined ? { label: 'Track width', onClick: () => setSectionWidth(sel.from, sel.to, null) } : undefined}
          onCommit={(v) => setSectionWidth(sel.from, sel.to, v)}
        />
      </>
    )
  }

  const goTo = () => {
    if (sel.kind === 'crossing') {
      setView(sel.x, sel.z, Math.min(view.mpp, 0.6))
      return
    }
    if (sel.kind === 'problem') {
      const p = problemByKey(currentProblems(), sel.key)
      if (p?.at) setView(p.at.x, p.at.z, Math.min(view.mpp, 0.6))
      return
    }
    const at =
      sel.kind === 'section'
        ? issueLocation(`road.points[${sectionPoints(d.points.length, sel.from, sel.to)[0]}]`, d, rc)
        : issueLocation(`${sel.kind === 'point' ? 'road.points' : sel.kind === 'piece' ? 'pieces' : sel.kind === 'prop' ? 'props' : 'cores'}[${sel.index}]`, d, rc)
    if (at) setView(at.x, at.z, Math.min(view.mpp, 0.6))
  }

  return (
    <section ref={box} className="sre-section sre-inspector" aria-label="Selected">
      <span className="sre-section-title">
        Selected
        <button type="button" className="sre-link" onClick={() => useEditor.setState({ selection: null })}>
          Done
        </button>
      </span>
      <button type="button" className="sre-inspector-title" onClick={goTo} title="Show it on the map">
        {title}
      </button>
      {body}
      {canDelete && (
        <button type="button" className="sre-btn is-danger" onClick={() => (sel.kind === 'point' ? deletePoint(sel.index) : deleteSelection())}>
          Delete
        </button>
      )}
    </section>
  )
}

/**
 * A crossing: which road goes over, in plain words (the map lights the one
 * that GOES OVER in violet and the one that GOES UNDER in cyan), and the
 * button that swaps them (draft.ts swapBridge). If the swap can't be done,
 * the status line says why and nothing changes.
 */
function CrossingFields(p: { spot: { x: number; z: number }; draft: Draft }) {
  const d = p.draft
  const hit = crossingNear(draftCrossings(d), p.spot, 2)
  if (!hit) return <p className="sre-help">The road doesn't cross itself here any more.</p>
  const c = hit.crossing
  const rc = roadGeometry(d.points, d.width).rc
  /** "the road heading north-east (the 420 m mark)": which road, in words and by where it is after the start line. */
  const road = (k: 0 | 1) => {
    const metres = Math.round(metresBetween(rc, d.startAt, c.passes[k].at))
    const mark = metres >= 1000 ? `${(metres / 1000).toFixed(2)} km` : `${metres} m`
    return `the road heading ${compassWord(c.passes[k].heading)} (the ${mark} mark)`
  }
  const swap = () => swapBridge(p.spot)
  if (c.over === null) {
    return (
      <>
        <p className="sre-help">These two roads meet at the same height here, so cars would crash into each other. Make one of them a bridge over the other.</p>
        <button type="button" className="sre-btn is-primary" onClick={swap}>
          Make a bridge here
        </button>
      </>
    )
  }
  const under = c.over === 0 ? 1 : 0
  const low = c.gap < BRIDGE_GAP
  return (
    <>
      <p className="sre-help">
        Going over: {road(c.over)}. Going under: {road(under)}. {Math.round(c.gap * 10) / 10} m between them{low ? ', too low for a car to fit under' : ''}.
      </p>
      <button type="button" className="sre-btn is-primary" onClick={swap} data-testid="editor-swap-bridge">
        Swap: put the other road on top
      </button>
      <p className="sre-help">The road on top comes down to the ground here, and the other one goes up over it on smooth ramps. Undo puts it back.</p>
    </>
  )
}

/** Heights the panel shows: to the half metre, from the ground up to RAISE_MAX. */
function sliderHeight(v: number): number {
  return Math.max(0, Math.min(RAISE_MAX, Math.round(v * 2) / 2))
}

/** Without a known world (only before the ground can be worked out), heights are just the lifts. */
const flatGround = () => 0

/**
 * A road point's height above the ground. The road eases up to it and back
 * down over as much road either side as a car needs to stay on (fixActions.ts
 * raisePoint): a smooth hump, never a spike.
 */
function PointHeight(p: { index: number; draft: Draft }) {
  const ground = pointGroundFor(p.draft) ?? flatGround
  const height = useMemo(() => liftAt(roadLine(p.draft.points), p.index, ground), [p.draft.points, p.index, ground])
  const [, setBusy] = useState(false)
  return (
    <SliderField
      label="Height above the ground"
      value={sliderHeight(height)}
      min={0}
      max={RAISE_MAX}
      step={0.5}
      unit="m"
      help="Raise the road here for a hump or a bridge. It eases up and back down over the road either side, so cars stay on it. 8 m or more clears a road underneath."
      onCommit={(v) => soon(setBusy, () => raisePoint(p.index, v))}
    />
  )
}

/**
 * The Stretch tool's Height: how high the MIDDLE of the stretch sits above the
 * ground. The road rises smoothly from each end of the stretch to the middle
 * (raise.ts). Below it, how high this stretch can go before a car at the speed
 * cars go there would take off over the top.
 */
function StretchHeight(p: { from: number; to: number; draft: Draft }) {
  const ground = pointGroundFor(p.draft) ?? flatGround
  const fresh = useEditor((s) => s.checkedDraft === s.draft && s.preview === 'built')
  const info = useMemo(() => {
    const now = stretchNow(p.draft.points, p.from, p.to, ground)
    const v = stretchSpeed(fresh ? liveRuntime() : null, p.draft.points, p.from, p.to)
    return { now, v, range: heightRange(now, v) }
  }, [p.draft.points, p.from, p.to, ground, fresh])
  const [, setBusy] = useState(false)
  const metres = Math.round(info.now.metres)
  const most = Math.floor(info.range.hi * 2) / 2
  const kmh = Math.round((info.v * 3.6) / 10) * 10
  return (
    <>
      <SliderField
        label="Height"
        value={sliderHeight(info.now.middle)}
        min={0}
        max={RAISE_MAX}
        step={0.5}
        unit="m"
        help="How high the middle of this stretch sits above the ground. The road rises smoothly from each end of the stretch to the middle."
        onCommit={(v) => soon(setBusy, () => raiseSection(p.from, p.to, v))}
      />
      <p className="sre-help" data-testid="editor-stretch-most">
        {metres < 30
          ? 'Pick at least 30 m of road to raise it.'
          : most >= RAISE_MAX
            ? `This stretch is ${metres} m long: long enough to go all the way up to ${RAISE_MAX} m in the middle.`
            : `This stretch is ${metres} m long: its middle can go up to about ${most} m before a car at ${kmh} km/h would take off over the top. Pick a longer stretch to go higher.`}
      </p>
    </>
  )
}

/**
 * Corner: when the selected point sits in a corner, one slider makes that
 * whole corner gentler (a bigger radius) or tighter, keeping the road either
 * side where it is (shape.ts cornerRadius).
 */
function CornerField(p: { index: number; draft: Draft }) {
  const corner = useMemo(() => cornerAt(p.draft.points, p.index), [p.draft.points, p.index])
  if (typeof corner === 'string') return <p className="sre-help">Corner: {corner}</p>
  const min = Math.floor(corner.min)
  const max = Math.ceil(corner.max)
  return (
    <>
      <SliderField
        label="Corner"
        value={Math.min(max, Math.max(min, Math.round(corner.radius)))}
        min={min}
        max={max}
        step={1}
        format={(v) => `${v} m round`}
        onCommit={(v) => applyCornerRadius(p.index, v)}
        help="Left makes the corner tighter, right makes it gentler. The road either side stays where it is."
      />
      <p className="sre-help">Left: tighter. Right: gentler. The road either side stays where it is.</p>
    </>
  )
}

function PieceFields(p: { piece: Piece; index: number; roadWidth: number }) {
  const { piece, index } = p
  const half = p.roadWidth / 2
  const sideField = (pieceWidth: number) => {
    const room = Math.max(0, half - pieceWidth / 2 - 0.3)
    return (
      <SliderField
        label="Across the road"
        value={piece.type === 'boost' || piece.type === 'ramp' ? (piece.offset ?? 0) : 0}
        min={-Math.floor(room * 2) / 2}
        max={Math.floor(room * 2) / 2}
        step={0.5}
        format={(v) => (v === 0 ? 'Middle' : v < 0 ? `${-v} m left` : `${v} m right`)}
        onCommit={(v) =>
          updatePiece(index, (x) => {
            if (x.type !== 'boost' && x.type !== 'ramp') return
            if (v) x.offset = v
            else delete x.offset
          })
        }
      />
    )
  }
  switch (piece.type) {
    case 'boost':
      return (
        <>
          <SliderField
            label="Kick"
            value={piece.strength ?? TRACK_DEFAULTS.boost.strength}
            min={0.5}
            max={2}
            step={0.1}
            format={(v) => `${v.toFixed(1)}x`}
            onCommit={(v) => updatePiece(index, (x) => x.type === 'boost' && (x.strength = v))}
          />
          <SliderField label="Length" value={piece.length ?? TRACK_DEFAULTS.boost.length} min={6} max={24} step={1} unit="m" onCommit={(v) => updatePiece(index, (x) => x.type === 'boost' && (x.length = v))} />
          {sideField(piece.width ?? TRACK_DEFAULTS.boost.width)}
        </>
      )
    case 'ramp':
      return (
        <>
          <SliderField label="Height" value={piece.height ?? TRACK_DEFAULTS.ramp.height} min={1} max={5} step={0.2} unit="m" onCommit={(v) => updatePiece(index, (x) => x.type === 'ramp' && (x.height = v))} help="Taller = more air." />
          <SliderField label="Length" value={piece.length ?? TRACK_DEFAULTS.ramp.length} min={8} max={24} step={1} unit="m" onCommit={(v) => updatePiece(index, (x) => x.type === 'ramp' && (x.length = v))} help="Longer = gentler." />
          {sideField(piece.width ?? TRACK_DEFAULTS.ramp.width)}
        </>
      )
    case 'loop':
      return (
        <SliderField label="Size (radius)" value={piece.radius ?? TRACK_DEFAULTS.loopRadius} min={8} max={20} step={1} unit="m" onCommit={(v) => updatePiece(index, (x) => x.type === 'loop' && (x.radius = v))} help="Bigger loops need more speed." />
      )
    case 'wallride':
      return (
        <>
          <Segmented
            label="Which side"
            value={piece.side}
            options={[
              { value: 'left', label: 'Left' },
              { value: 'both', label: 'Both' },
              { value: 'right', label: 'Right' },
            ]}
            onChange={(v) => updatePiece(index, (x) => x.type === 'wallride' && (x.side = v))}
          />
          <SliderField label="Length" value={piece.length ?? TRACK_DEFAULTS.wallride.length} min={40} max={300} step={10} unit="m" onCommit={(v) => updatePiece(index, (x) => x.type === 'wallride' && (x.length = v))} />
          <SliderField label="Wall height" value={piece.height ?? TRACK_DEFAULTS.wallride.height} min={5} max={14} step={1} unit="m" onCommit={(v) => updatePiece(index, (x) => x.type === 'wallride' && (x.height = v))} />
        </>
      )
    case 'speedtrap':
      return <p className="sre-help">Clocks your speed as you pass. Best on the fastest straight.</p>
  }
}

// ---------------------------------------------------------------- checks

/** How many rows the Checks list shows before "and N more". */
const CHECKS_SHOWN = 10

/**
 * Everything the game wants to tell you, in plain words, worst first; click one to see
 * where it is. The verdict at the top comes from the game's own track gates (checks.ts),
 * the same ones `bun run tracks:check` runs, so "All good" here means OK there.
 */
function Problems() {
  const errors = useEditor((s) => s.errors)
  const gates = useEditor((s) => s.gates)
  const checkedDraft = useEditor((s) => s.checkedDraft)
  const preview = useEditor((s) => s.preview)
  const notes = useEditor((s) => s.notes)
  const draft = useEditor((s) => s.draft)
  const selected = useEditor((s) => (s.selection?.kind === 'problem' ? s.selection.key : null))
  const items = useProblems()
  const fresh = checkedDraft === draft && preview !== 'pending'
  const cleanup = notes?.issues ?? []
  const verdict = checkVerdict({ fresh, errors, gates, cleanupErrors: cleanup.filter((i) => i.level === 'error').length })
  const [busy, setBusy] = useState(false)
  if (isEmptyDraft(draft)) {
    // Nothing to check until there is a road.
    return (
      <section className="sre-section sre-problems" aria-label="Checks" data-verdict="empty">
        <span className="sre-section-title">Checks</span>
        <p className="sre-verdict is-checking" role="status">
          No road yet, so nothing to check. Draw a loop with the pencil, or press Random track.
        </p>
      </section>
    )
  }
  const bad = items.filter((it) => it.tone === 'bad').length
  const fixable = fresh ? items.filter((it) => it.remedy.kind === 'fix').length : 0
  const headline =
    verdict === 'pass'
      ? 'All good: this track builds and drives.'
      : verdict === 'fail'
        ? `Not ready yet: ${bad === 1 ? 'one problem stops' : `${bad} problems stop`} this track working. Fix the red ${bad === 1 ? 'one' : 'ones'} first: click one to see how.`
        : 'Checking the road...'
  return (
    <section className="sre-section sre-problems" aria-label="Checks" data-verdict={verdict}>
      <span className="sre-section-title">
        Checks
        {fixable > 0 && (
          <button
            type="button"
            className="sre-link"
            disabled={busy}
            onClick={() => soon(setBusy, fixAll)}
            title="Mends every problem that has a Fix it button, one after another, each built and checked first. One Undo puts them all back."
            data-testid="editor-fix-all"
          >
            {busy ? 'Fixing...' : `Fix all (${fixable})`}
          </button>
        )}
      </span>
      <p className={`sre-verdict is-${verdict}`} role="status">
        {headline}
        {verdict === 'pass' && items.some((it) => it.tone === 'warn') ? ' A few things are worth a look:' : ''}
      </p>
      {items.length > 0 && (
        <ul>
          {items.slice(0, CHECKS_SHOWN).map((it) => (
            <li key={it.key}>
              <button
                type="button"
                className={`sre-issue is-${it.tone}${it.key === selected ? ' is-selected' : ''}`}
                aria-pressed={it.key === selected}
                onClick={() => selectProblem(it.key)}
                title={it.remedy.kind === 'fix' ? 'Select it: Fix it can mend it' : 'Select it to see what to do'}
              >
                <span className="sre-issue-text">
                  <span className="sre-issue-title">{it.title}</span>
                  {it.detail && <span className="sre-issue-detail">{it.detail}</span>}
                  {it.fix && <span className="sre-issue-fix">Fix: {it.fix}</span>}
                  {it.remedy.kind === 'fix' && <span className="sre-issue-can">Fix it can mend this</span>}
                </span>
              </button>
            </li>
          ))}
          {items.length > CHECKS_SHOWN && <li className="sre-help">and {items.length - CHECKS_SHOWN} more: fix the ones above and they will show here.</li>}
        </ul>
      )}
    </section>
  )
}

/** The Checks list as the panel shows it (problems.ts), kept up to date with the editor. */
function useProblems(): Problem[] {
  const errors = useEditor((s) => s.errors)
  const warnings = useEditor((s) => s.warnings)
  const gates = useEditor((s) => s.gates)
  const checkedDraft = useEditor((s) => s.checkedDraft)
  const preview = useEditor((s) => s.preview)
  const notes = useEditor((s) => s.notes)
  const draft = useEditor((s) => s.draft)
  const fresh = checkedDraft === draft && preview !== 'pending'
  return problemsOf({ draft, gates: fresh ? gates : null, errors, warnings, notes: notes?.issues ?? NO_NOTES })
}

/**
 * Run a change that builds and checks the road (a few tenths of a second, or
 * more on a big track) after the button has had a chance to say it's busy.
 */
function soon(setBusy: (b: boolean) => void, work: () => unknown): void {
  setBusy(true)
  setTimeout(() => {
    try {
      work()
    } finally {
      setBusy(false)
    }
  }, 30)
}

/**
 * A problem picked from Checks or the map: what's wrong, then what to do.
 * Fix it (when the editor can mend it by itself), "Show me" (the right tool,
 * with the right bit of road selected), or, for the game's own bugs, says so.
 */
function ProblemFields(p: { problemKey: string }) {
  const list = useProblems()
  const pending = useEditor((s) => s.preview === 'pending' || s.checkedDraft !== s.draft)
  const [busy, setBusy] = useState(false)
  const prob = problemByKey(list, p.problemKey)
  if (!prob) {
    if (pending) return <p className="sre-help">Checking the road again...</p>
    const fixed = lastFixed?.key === p.problemKey ? lastFixed : null
    return <p className="sre-problem-do">{fixed ? `Fixed: ${fixed.did} That problem has gone.` : 'That problem has gone. Pick another one in Checks.'}</p>
  }
  const r = prob.remedy
  return (
    <>
      <p className={`sre-problem is-${prob.tone}`}>{prob.title}</p>
      {prob.detail && <p className="sre-help">{prob.detail}</p>}
      {r.kind === 'fix' && (
        <>
          <button type="button" className="sre-btn is-primary" disabled={busy || pending} onClick={() => soon(setBusy, () => fixProblem(prob.key))} data-testid="editor-fix-it">
            {busy ? 'Fixing...' : 'Fix it'}
          </button>
          <p className="sre-help">{r.does} It's built and checked before it lands, and Undo puts it back.</p>
          {r.go && (
            <button type="button" className="sre-btn" onClick={() => goToProblem(prob.key)}>
              {r.go.button}
            </button>
          )}
        </>
      )}
      {r.kind === 'go' && (
        <>
          <p className="sre-problem-do">{r.does}</p>
          <button type="button" className="sre-btn is-primary" onClick={() => goToProblem(prob.key)} data-testid="editor-show-me">
            {r.go.button}
          </button>
        </>
      )}
      {(r.kind === 'game' || r.kind === 'none') && <p className="sre-problem-do">{r.does}</p>}
    </>
  )
}

function Legend() {
  return (
    <section className="sre-section sre-legend" aria-label="Map key">
      <span className="sre-section-title">Map key</span>
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
          <i className="k-bridge" /> Bridge (click its label to pick which road goes over)
        </li>
        <li>
          <i className="k-boost" /> Boost pad
        </li>
        <li>
          <i className="k-ramp" /> Ramp
        </li>
        <li>
          <i className="k-loop" /> Loop
        </li>
        <li>
          <i className="k-wall" /> Wall ride
        </li>
        <li>
          <i className="k-prop" /> Crash props
        </li>
        <li>
          <i className="k-core" /> Energy core
        </li>
        <li>
          <i className="k-bank" /> Bank set by hand
        </li>
        <li>
          <i className="k-warn" /> Something to check
        </li>
      </ul>
    </section>
  )
}
