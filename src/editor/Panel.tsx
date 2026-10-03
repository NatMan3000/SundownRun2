// ============================================================
//  EDITOR PANEL - the right-hand side: this track, and what's selected
// ------------------------------------------------------------
//  Top to bottom:
//    the name, whether it is saved (TrackSave.tsx), and a few numbers
//    (length, pieces, bridges)
//    SELECTED  settings for whatever you clicked on the map: a piece,
//              a crash-prop pile, an energy core, a road point, a
//              stretch of road (its height, bank or width: whichever of
//              those three tools picked it), a crossing
//              (which road goes over: the Swap button), or a problem
//              from Checks (what's wrong, and Fix it or Show me)
//    TRACK     width, world, time of day, edge lights, maker, blurb
//    CHECKS    anything the game wants you to look at; click one to select
//              it (and see where it is), or Fix all
//    MAP KEY   what the marks on the map mean (and which ones to click)
//    what Save will do, then Save / Save as new track / Test drive /
//    Library / Exit (TrackSave.tsx)
// ============================================================

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { PALETTE } from '../core/palette'
import { listTracks } from '../track/registry'
import { TRACK_DEFAULTS, type Piece } from '../track/schema'
import { ROAD_SMOOTHING_MAX, ROAD_SMOOTHING_MIN } from '../track/terrain'
import { BASE_WORLDS, isEmptyDraft } from './draftFile'
import {
  type Draft,
  type Selection,
  copyEnvironmentFrom,
  deletePoint,
  deleteSelection,
  sectionPoints,
  setAuthor,
  setBaseWorld,
  setDescription,
  setEdgeColour,
  setName,
  setSectionBank,
  setSectionWidth,
  setSurfaceSmoothing,
  setTimeOfDay,
  setWidth,
  smoothRoad,
  updateCore,
  updatePiece,
  updateProp,
  setTool,
  useEditor,
  applyCornerRadius,
  draftCrossings,
  pointGroundFor,
  swapBridge,
  sendUnder,
  makeBridge,
} from './draft'
import { type FixOffer, canWords, currentProblems, fixAll, fixOffer, fixProblem, fixSearchVersion, goToProblem, lastFixed, raiseSection, selectProblem, subscribeFixSearch } from './fixActions'
import { NO_NOTES, type Problem, problemByKey, problemsOf } from './problems'
import { type HeightLimits, RAISE_FLOOR, liftAt } from './raise'
import { type StretchTool, heightsAboveGround, isStretchTool } from './stretchRuns'
import { groundStretch, growStretch, heightLimitsNow, onHeightLimits, openHeightAtPoint } from './stretchTools'
import { SmoothField } from './SmoothField'
import './fixes.css'
import { BRIDGE_GAP, UNDER_DEPTH, bridgeCount, compassWord, crossingNear } from './bridges'
import { ColourField, Segmented, SelectField, SliderField, TextField } from './fields'
import { issueLocation, roadGeometry } from './mapDraw'
import { checkVerdict } from './checks'
import { pieceLabel, TUNNEL_EDIT_MAX, TUNNEL_EDIT_MIN } from './pieces'
import { setPieceLength } from './draft'
import { liveRuntime } from './fixActions'
import { builtBankAngle } from './bankAngle'
import { startDriveToDraw } from './driveToDraw'
import { metresBetween, roadLength } from './road'
import { cornerAt, roadLine } from './shape'
import { setView, view } from './view'
import { SaveStateLine, TrackActions } from './TrackSave'

/** Edge-strip colours a track can pick (the road's light strips). */
const EDGE_COLOURS = [PALETTE.roadEdge, PALETTE.roadEdgeAlt, PALETTE.boost, PALETTE.chevron, PALETTE.wallRide, PALETTE.aiColors[0]]

export function Panel(props: { onLibrary: () => void; onExit: () => void }) {
  const mode = useEditor((s) => s.mode)
  const draft = useEditor((s) => s.draft)
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
          <Legend editing={false} />
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
          {/* How the live build is doing; whether the track is saved is on its own line under the name. */}
          {(preview === 'pending' || preview === 'failed' || gateFails) && (
            <span className={`sre-state is-${preview === 'pending' ? 'pending' : 'failed'}`}>{preview === 'pending' ? 'building...' : 'needs fixing'}</span>
          )}
        </div>
        <TextField label="Track name" value={draft.name} onCommit={setName} big />
        <SaveStateLine />
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
          <SliderField
            label="Road surface"
            value={draft.roadSettings?.surfaceSmoothing ?? TRACK_DEFAULTS.surfaceSmoothing}
            min={ROAD_SMOOTHING_MIN}
            max={ROAD_SMOOTHING_MAX}
            step={5}
            format={(v) => (v <= 10 ? 'Follows every bump' : v < 30 ? 'A bit bumpy' : v < 40 ? 'Smooth' : v < ROAD_SMOOTHING_MAX ? 'Extra smooth' : 'Super smooth')}
            onCommit={setSurfaceSmoothing}
            help="How the road sits on the ground. Slide left and it follows every little bump; slide right and it irons the bumps out, so it only goes up and down with the hills."
          />
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
        {/* Nothing on an empty map for the key to explain, so it waits for a road. */}
        {!isEmptyDraft(draft) && <Legend editing />}
      </div>

      <TrackActions onLibrary={props.onLibrary} onExit={props.onExit} />
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
  const tool = useEditor((s) => s.tool)
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
        <PointHeightNote index={sel.index} draft={d} />
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
    // A stretch: the control of the tool that picked it (Height, Bank or Width), and the other two a click away.
    const metres = Math.round(metresBetween(rc, sel.from, sel.to))
    title = isStretchTool(tool) ? STRETCH_TITLE[tool] : 'Stretch of road'
    canDelete = false
    body = (
      <>
        <p className="sre-help">
          {metres} m of road. {isStretchTool(tool) ? STRETCH_WHAT[tool] : 'Pick what to change on it.'}
        </p>
        {tool === 'height' && <HeightField from={sel.from} to={sel.to} draft={d} />}
        {tool === 'bank' && <BankField from={sel.from} to={sel.to} draft={d} />}
        {tool === 'width' && <WidthField from={sel.from} to={sel.to} draft={d} />}
        <Segmented
          label="Change this stretch's"
          value={isStretchTool(tool) ? tool : ''}
          options={[
            { value: 'height', label: 'Height' },
            { value: 'bank', label: 'Bank' },
            { value: 'width', label: 'Width' },
          ]}
          onChange={(v) => setTool(v as StretchTool)}
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
 * that GOES OVER in violet and the one that GOES UNDER in cyan), and two
 * buttons: Swap (the other road on top, the same kind of crossing) and the
 * other kind of crossing (a bridge becomes an underpass: the road underneath
 * dips into a cutting and the one on top comes down to the ground; an
 * underpass becomes a bridge). Where the roads meet: make a bridge or an
 * underpass. If a change can't be done, the status line says why and
 * nothing changes.
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
        <p className="sre-help">These two roads meet at the same height here, so cars would crash into each other. Make one of them a bridge over the other, or send one under the other.</p>
        <button type="button" className="sre-btn is-primary" onClick={swap}>
          Make a bridge here
        </button>
        <button type="button" className="sre-btn" onClick={() => sendUnder(p.spot, null)} data-testid="editor-make-underpass">
          Make an underpass here
        </button>
      </>
    )
  }
  const over = c.over
  const under = over === 0 ? 1 : 0
  const low = c.gap < BRIDGE_GAP
  const between = `${Math.round(c.gap * 10) / 10} m between them${low ? ', too low for a car to fit under' : ''}.`
  if (c.kind === 'underpass') {
    return (
      <>
        <p className="sre-help">
          Going over, on the ground: {road(over)}. Going under, in a cutting {metresText(-c.passes[under].lift)} down: {road(under)}. {between}
        </p>
        <button type="button" className="sre-btn is-primary" onClick={() => sendUnder(p.spot, over)} data-testid="editor-swap-bridge">
          Swap: send the other road under
        </button>
        <button type="button" className="sre-btn" onClick={() => makeBridge(p.spot, over)} data-testid="editor-make-bridge">
          Make it a bridge instead
        </button>
        <p className="sre-help">Swap: the road in the cutting comes back up to the ground, and the other one dips under it. A bridge: the road on top goes up over the other on smooth ramps, and the road in the cutting comes back up to the ground. Undo puts either back.</p>
      </>
    )
  }
  return (
    <>
      <p className="sre-help">
        Going over: {road(over)}. Going under: {road(under)}. {between}
      </p>
      <button type="button" className="sre-btn is-primary" onClick={swap} data-testid="editor-swap-bridge">
        Swap: put the other road on top
      </button>
      <button type="button" className="sre-btn" onClick={() => sendUnder(p.spot, under)} data-testid="editor-send-under">
        Send the road heading {compassWord(c.passes[under].heading)} under
      </button>
      <p className="sre-help">Swap: the road on top comes down to the ground, and the other one goes up over it on smooth ramps. Send under: the road underneath dips {UNDER_DEPTH} m into a cutting, and the road on top comes down to the ground and crosses it on a short bridge. Undo puts either back.</p>
    </>
  )
}

/** Without a known world (only before the ground can be worked out), heights are just the lifts. */
const flatGround = () => 0

/** "8 m", "2.5 m": a height in the panel's words. */
function metresText(v: number): string {
  const r = Math.round(v * 10) / 10
  return `${Number.isInteger(r) ? r.toFixed(0) : r.toFixed(1)} m`
}

/** The selected stretch's heading, by the tool that picked it. */
const STRETCH_TITLE: Record<StretchTool, string> = {
  height: 'Height of this stretch',
  bank: 'Bank of this stretch',
  width: 'Width of this stretch',
}

/** What the tool does to the stretch, in one line. */
const STRETCH_WHAT: Record<StretchTool, string> = {
  height: 'Raise it into a hill or a bridge, or dig it down into the ground: the road rises (or dips) smoothly from each end of the stretch to its middle.',
  bank: 'Tilt it into a corner. Auto lets the game bank it from how tight the corner is.',
  width: 'Make the road wider or narrower here.',
}

/**
 * A road point's height above the ground, and the way to change it: the
 * Height tool, on a stretch around this point (the raised stretch it is on,
 * or one sized for a bridge). There is one way to change heights, not two.
 */
function PointHeightNote(p: { index: number; draft: Draft }) {
  const ground = pointGroundFor(p.draft) ?? flatGround
  const h = useMemo(() => liftAt(roadLine(p.draft.points), p.index, ground), [p.draft.points, p.index, ground])
  const words = Math.abs(h) < 0.25 ? 'This point is on the ground.' : h > 0 ? `This point is ${metresText(h)} above the ground.` : `This point is ${metresText(-h)} below the ground around it.`
  return (
    <>
      <p className="sre-help">{words}</p>
      <button type="button" className="sre-btn" onClick={() => openHeightAtPoint(p.index)} data-testid="editor-point-height">
        Change the height here
      </button>
    </>
  )
}

/**
 * The Height slider's ends for a stretch (stretchTools.ts heightLimitsNow):
 * null while they are being worked out (a road build or two, between frames),
 * once the live preview has caught up with the draft.
 */
function useHeightLimits(from: number, to: number): HeightLimits | 'failed' | null {
  const draft = useEditor((s) => s.draft)
  const fresh = useEditor((s) => s.checkedDraft === s.draft && s.preview === 'built')
  const [lim, setLim] = useState<HeightLimits | 'failed' | null>(null)
  useEffect(() => {
    if (!fresh) {
      setLim(null)
      return
    }
    const read = () => setLim(heightLimitsNow(from, to))
    read()
    return onHeightLimits(read)
  }, [draft, from, to, fresh])
  return lim
}

/**
 * The Height tool's one control: how high the MIDDLE of the stretch sits above
 * the ground. It only offers heights that build: every half-metre step on it
 * was built and checked (raise.ts heightLimitSteps), and it grows while that is
 * being done. Under it, one line saying how high this stretch can go and, if it
 * could go higher with more road, how much road that needs, with a button that
 * makes the stretch that long.
 */
function HeightField(p: { from: number; to: number; draft: Draft }) {
  const lim = useHeightLimits(p.from, p.to)
  const [busy, setBusy] = useState(false)
  const roadMetres = useMemo(() => roadLine(p.draft.points).length, [p.draft.points])
  // Is any of this stretch up off the ground (or dug into it)? Then "On the ground" can put it back.
  const raised = useMemo(() => {
    const h = heightsAboveGround(p.draft.points, pointGroundFor(p.draft) ?? flatGround)
    return sectionPoints(p.draft.points.length, p.from, p.to).some((i) => Math.abs(h[i]) >= 0.3)
  }, [p.draft, p.from, p.to])
  if (lim === null || lim === 'failed') {
    return (
      <>
        <SliderField label="Height in the middle" value={0} min={0} max={1} step={0.5} unit="m" disabled onCommit={() => {}} />
        <p className="sre-help" data-testid="editor-height-limit">
          {lim === 'failed' ? "Couldn't work out how high this stretch can go. Try picking a different stretch." : 'Working out how high this stretch can go...'}
        </p>
        <SmoothField from={p.from} to={p.to} draft={p.draft} />
      </>
    )
  }
  const m = Math.round(lim.metres)
  // Below the slider's start (it can't go up just a little here), the thumb waits at the start and the value says where it is now.
  const value = lim.jump ? lim.value : Math.max(lim.lo, Math.min(lim.hi, lim.value))
  const jumpWords = lim.jump
    ? `It can't go up just a little here: lower than ${metresText(lim.lo)} ${/take off/.test(lim.jump.reason) ? 'the road would dip between two bumps a car takes off over' : lim.jump.reason.replace(/\.$/, '')}, so the slider starts at ${metresText(lim.lo)}. `
    : ''
  const next = lim.next
  const nextFits = !!next && next.metres <= roadMetres * 0.45
  const takeOff = lim.why === 'speed' || (lim.why === 'checks' && /take off/.test(lim.reason ?? ''))
  const needWords = next && takeOff ? (nextFits ? ` To go to ${next.height} m it needs about ${next.metres} m of road.` : ` This road isn't long enough here to go to ${next.height} m.`) : ''
  // How high it can go: a height, or (for a stretch dug down that can't come all the way back up) how far below the ground.
  const upTo = lim.hi < -0.25 ? `${metresText(-lim.hi)} below the ground` : metresText(lim.hi)
  // How far down it can be dug (the slider's other end), when that's below the ground.
  const down = lim.lo < -0.25 ? ` It can be dug down to ${metresText(-lim.lo)} below the ground${lim.lo <= RAISE_FLOOR + 1e-6 ? ', the deepest any road goes' : ''}.` : ''
  const line = lim.checking
    ? `Checking each height before the slider offers it: ${metresText(lim.lo)} to ${metresText(lim.hi)} so far...`
    : lim.why === 'short'
      ? `Pick at least 30 m of road to change its height (this is ${m} m).`
      : lim.why === 'stop'
        ? (lim.reason ?? 'Something on this stretch stops it changing height.')
        : lim.why === 'top'
          ? `${jumpWords}This ${m} m stretch can go all the way up to ${metresText(lim.hi)} in the middle.${down}`
          : lim.why === 'speed'
            ? `${jumpWords}This ${m} m stretch can go up to ${upTo} in the middle: any higher and a car at ${lim.kmh} km/h would take off over the top.${needWords}${down}`
            : `${jumpWords}It can go up to ${upTo} here: any higher and ${lim.reason ?? 'one of the game checks says no.'}${needWords}${down}`
  return (
    <>
      <SliderField
        label="Height in the middle"
        value={value}
        min={lim.lo}
        max={Math.max(lim.hi, lim.lo + 0.5)}
        step={0.5}
        disabled={busy || lim.hi <= lim.lo}
        format={(v) => (lim.jump && v < lim.lo ? `${metresText(v)} now` : metresText(v))}
        reset={raised ? { label: 'On the ground', onClick: () => soon(setBusy, () => groundStretch(p.from, p.to)) } : undefined}
        help={`How high the middle of this stretch sits above the ground. The road rises smoothly from each end of the stretch to the middle. Below 0 it dips into the ground, as far as ${metresText(-RAISE_FLOOR)} down.`}
        onCommit={(v) => soon(setBusy, () => raiseSection(p.from, p.to, v))}
      />
      <p className="sre-help" data-testid="editor-height-limit" data-lo={lim.lo} data-hi={lim.hi}>
        {busy ? 'Building it and running the checks...' : line}
      </p>
      {!lim.checking && next && takeOff && nextFits && next.metres > lim.metres + 5 && (
        <button type="button" className="sre-btn" onClick={() => growStretch(p.from, p.to, next.metres)} disabled={busy} data-testid="editor-height-longer">
          Make the stretch {next.metres} m long
        </button>
      )}
      <SmoothField from={p.from} to={p.to} draft={p.draft} />
    </>
  )
}

/**
 * The Bank tool's one control: the tilt in degrees, or Auto (the game banks it
 * from the corner). On Auto it says the tilt the game gives this stretch now,
 * "Auto (8°)", read from the built road once the live preview has caught up
 * with the last change (bankAngle.ts), and the slider's thumb sits there, so
 * dragging it starts from the tilt the road already has.
 */
function BankField(p: { from: number; to: number; draft: Draft }) {
  const idx = sectionPoints(p.draft.points.length, p.from, p.to)
  const mid = p.draft.points[idx[Math.floor((idx.length - 1) / 2)]]
  const set = mid?.bank !== undefined
  const checkedDraft = useEditor((s) => s.checkedDraft)
  const preview = useEditor((s) => s.preview)
  const auto = useMemo(() => {
    if (set) return null
    const live = liveRuntime()
    return live ? builtBankAngle(live, p.from, p.to) : null
    // checkedDraft and preview are here so this runs again when the live preview is rebuilt (liveRuntime reads them from the store).
  }, [set, p.draft, p.from, p.to, checkedDraft, preview])
  const autoValue = auto ? Math.max(-10, Math.min(45, auto.into)) : 0
  return (
    <SliderField
      // A fresh slider when it switches between a set bank and Auto, so it never shows the old number for a frame.
      key={set ? 'set' : 'auto'}
      label="Bank (tilt)"
      value={set ? (mid?.bank ?? 0) : autoValue}
      min={-10}
      max={45}
      step={1}
      format={(v) => (set || v !== autoValue ? `${v}°` : auto ? `Auto (${auto.into}°)` : 'Auto')}
      reset={set ? { label: 'Auto', onClick: () => setSectionBank(p.from, p.to, null) } : undefined}
      onCommit={(v) => setSectionBank(p.from, p.to, v)}
      help="Degrees into the corner. Negative tilts it the wrong way (off-camber). Auto: the game tilts it to suit the corner, and shows how much."
    />
  )
}

/** The Width tool's one control: the road's width here, or the track's own width. */
function WidthField(p: { from: number; to: number; draft: Draft }) {
  const idx = sectionPoints(p.draft.points.length, p.from, p.to)
  const mid = p.draft.points[idx[Math.floor((idx.length - 1) / 2)]]
  const set = mid?.width !== undefined
  return (
    <SliderField
      label="Width here"
      value={mid?.width ?? p.draft.width}
      min={10}
      max={24}
      step={1}
      format={(v) => (set ? `${v} m` : `${p.draft.width} m (track)`)}
      reset={set ? { label: 'Track width', onClick: () => setSectionWidth(p.from, p.to, null) } : undefined}
      onCommit={(v) => setSectionWidth(p.from, p.to, v)}
      help="How wide the road is here, edge to edge."
    />
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
          <SliderField label="Length" value={piece.length ?? TRACK_DEFAULTS.boost.length} min={6} max={24} step={1} unit="m" onCommit={(v) => setPieceLength(index, v)} />
          {sideField(piece.width ?? TRACK_DEFAULTS.boost.width)}
        </>
      )
    case 'ramp':
      return (
        <>
          <SliderField label="Height" value={piece.height ?? TRACK_DEFAULTS.ramp.height} min={1} max={5} step={0.2} unit="m" onCommit={(v) => updatePiece(index, (x) => x.type === 'ramp' && (x.height = v))} help="Taller = more air." />
          <SliderField label="Length" value={piece.length ?? TRACK_DEFAULTS.ramp.length} min={8} max={24} step={1} unit="m" onCommit={(v) => setPieceLength(index, v)} help="Longer = gentler." />
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
          <SliderField label="Length" value={piece.length ?? TRACK_DEFAULTS.wallride.length} min={40} max={300} step={10} unit="m" onCommit={(v) => setPieceLength(index, v)} help="Grows or shrinks from the middle: both ends move, the middle stays put." />
          <SliderField label="Wall height" value={piece.height ?? TRACK_DEFAULTS.wallride.height} min={5} max={14} step={1} unit="m" onCommit={(v) => updatePiece(index, (x) => x.type === 'wallride' && (x.height = v))} />
        </>
      )
    case 'speedtrap':
      return <p className="sre-help">Clocks your speed as you pass. Best on the fastest straight.</p>
    case 'tunnel':
      return (
        <>
          <SliderField
            label="Length"
            value={piece.length ?? TRACK_DEFAULTS.tunnelLength}
            min={TUNNEL_EDIT_MIN}
            max={TUNNEL_EDIT_MAX}
            step={10}
            unit="m"
            onCommit={(v) => setPieceLength(index, v)}
            help="How much of the road is covered. Grows or shrinks from the middle. The road dips into the ground on gentle ramps either side, so it needs clear road there too."
          />
        </>
      )
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
  useSyncExternalStore(subscribeFixSearch, fixSearchVersion)
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
  // Only fixes that have really been found (built and checked on this road) count.
  const fixable = fresh ? items.filter((it) => it.remedy.kind === 'fix' && fixOffer(it.key) === 'found').length : 0
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
                title={offerTitle(it, fresh ? fixOffer(it.key) : 'looking')}
              >
                <span className="sre-issue-text">
                  <span className="sre-issue-title">{it.title}</span>
                  {it.detail && <span className="sre-issue-detail">{it.detail}</span>}
                  {it.fix && <span className="sre-issue-fix">Fix: {it.fix}</span>}
                  <CanMend p={it} offer={fresh ? fixOffer(it.key) : 'looking'} />
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

/** "Fix it can mend this" (a fix was found), "Looking for a fix..." (dim), or nothing (none found). */
function CanMend(p: { p: Problem; offer: FixOffer }) {
  const words = canWords(p.p, p.offer)
  if (!words) return null
  return <span className={`sre-issue-can${p.offer === 'looking' ? ' is-looking' : ''}`}>{words}</span>
}

function offerTitle(p: Problem, offer: FixOffer): string {
  return p.remedy.kind === 'fix' && offer === 'found' ? 'Select it: Fix it can mend it' : 'Select it to see what to do'
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
  useSyncExternalStore(subscribeFixSearch, fixSearchVersion)
  const prob = problemByKey(list, p.problemKey)
  if (!prob) {
    if (pending) return <p className="sre-help">Checking the road again...</p>
    const fixed = lastFixed?.key === p.problemKey ? lastFixed : null
    return <p className="sre-problem-do">{fixed ? `Fixed: ${fixed.did} That problem has gone.` : 'That problem has gone. Pick another one in Checks.'}</p>
  }
  const r = prob.remedy
  const offer = pending ? 'looking' : fixOffer(prob.key)
  return (
    <>
      <p className={`sre-problem is-${prob.tone}`}>{prob.title}</p>
      {prob.detail && <p className="sre-help">{prob.detail}</p>}
      {r.kind === 'fix' && offer === 'found' && (
        <>
          <button type="button" className="sre-btn is-primary" disabled={busy || pending} onClick={() => soon(setBusy, () => fixProblem(prob.key))} data-testid="editor-fix-it">
            {busy ? 'Fixing...' : 'Fix it'}
          </button>
          <p className="sre-help">{r.does} It's been built and checked already, and Undo puts it back.</p>
          {r.go && (
            <button type="button" className="sre-btn" onClick={() => goToProblem(prob.key)}>
              {r.go.button}
            </button>
          )}
        </>
      )}
      {r.kind === 'fix' && offer !== 'found' && (
        <>
          <p className="sre-problem-do" data-testid="editor-fix-hand">
            {offer === 'looking' ? 'Looking for a fix... Meanwhile, by hand: ' : "Fix it couldn't find a safe way to mend this one by itself. By hand: "}
            {r.hand}
          </p>
          {r.go && (
            <button type="button" className="sre-btn is-primary" onClick={() => goToProblem(prob.key)} data-testid="editor-show-me">
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

/** One Map key row: the mark as the map draws it (a fixed column, so every description lines up), then what it means. */
function KeyRow(p: { mark: ReactNode; children: ReactNode }) {
  return (
    <li>
      <span className="k-mark">{p.mark}</span>
      <span>{p.children}</span>
    </li>
  )
}

/**
 * The Map key: every mark the map draws, in Josh's words, and (in the editor)
 * which ones a click changes. A label is shown as the map draws it: the words
 * on a pill.
 */
function Legend(p: { editing: boolean }) {
  const click = (words: string) => (p.editing ? ` ${words}` : '')
  return (
    <section className="sre-section sre-legend" aria-label="Map key" data-testid="editor-map-key">
      <span className="sre-section-title">Map key</span>
      <ul>
        <KeyRow mark={<i className="k-start" />}>Start line</KeyRow>
        <KeyRow mark={<i className="k-arrow" />}>Driving direction</KeyRow>
        <KeyRow mark={<i className="k-point" />}>Road point (zoom in to see them)</KeyRow>
        <KeyRow
          mark={
            <>
              <i className="k-raised" />
              <span className="k-pill is-raised">RAISED</span>
            </>
          }
        >
          Road raised above the ground: a hill or a bridge (DUG: road dug down into the ground).{click('Click it to change its height.')}
        </KeyRow>
        <KeyRow
          mark={
            <>
              <i className="k-bank" />
              <span className="k-pill is-bank">BANK</span>
            </>
          }
        >
          A bank set by hand.{click('Click it to change it, or put it back to Auto.')}
        </KeyRow>
        <KeyRow
          mark={
            <>
              <i className="k-width" />
              <span className="k-pill is-width">WIDTH</span>
            </>
          }
        >
          A width set by hand.{click('Click it to change it.')}
        </KeyRow>
        <KeyRow mark={<span className="k-pill is-bridge">BRIDGE</span>}>Where the road crosses itself.{click('Click it to pick which road goes over.')}</KeyRow>
        <KeyRow mark={<span className="k-pill is-bridge">UNDERPASS</span>}>A crossing where one road dips into the ground under the other.{click('Click it to pick which road goes under.')}</KeyRow>
        <KeyRow mark={<span className="k-pill is-low">LOW BRIDGE</span>}>Too low for a car to fit under (or ROADS MEET: two roads at the same height).{click('Click it to fix it.')}</KeyRow>
        {p.editing && <KeyRow mark={<i className="k-section" />}>The stretch you picked with Height, Bank or Width</KeyRow>}
        <KeyRow mark={<i className="k-boost" />}>Boost pad</KeyRow>
        <KeyRow mark={<i className="k-ramp" />}>Ramp</KeyRow>
        <KeyRow mark={<i className="k-loop" />}>Loop</KeyRow>
        <KeyRow mark={<i className="k-wall" />}>Wall ride</KeyRow>
        <KeyRow mark={<i className="k-prop" />}>Crash props</KeyRow>
        <KeyRow mark={<i className="k-core" />}>Energy core</KeyRow>
        <KeyRow mark={<i className="k-pin" />}>Something to check.{click('Click it to see what to do.')}</KeyRow>
      </ul>
    </section>
  )
}
