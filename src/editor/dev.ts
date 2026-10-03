// ============================================================
//  EDITOR DEV HOOKS - drive the editor from the console or a probe
// ------------------------------------------------------------
//  A checker can't draw with a mouse, so everything the pencil does
//  is reachable as a command:
//
//    __dev.editor('help')                  list the commands
//    __dev.editor('stroke', [[x,z], ...])  draw a road from points, clean it up,
//                                          make it the draft; returns the result
//    __dev.editor('shape', 'eight')        draw a ready-made shape:
//                                          circle | eight | square | hairpin | kidney
//    __dev.editor('file')                  the draft as a track file
//    __dev.editor('save')                  save it; returns the track id
//    __dev.editor('testDrive')             save, then drive it
//    __dev.editor('new', 'grid-flats')     start a new track in a base world
//    __dev.editor('open', id)              open a saved drawn track
//    __dev.editor('undo') / ('redo')
//    __dev.editor('clear')                 ask "Clear the whole track?" (the rail's
//                                          eraser); answer with ('clearYes') / ('clearNo')
//    __dev.editor('clearNow')              clear all without asking (one undo step): an empty map
//    __dev.editor('random', seed?)         Random track without asking (one undo step); the same
//                                          seed makes the same track. Returns tries, ms and the shape
//    __dev.editor('askRandom')             press the rail's dice (asks first if there is a road;
//                                          answer with ('clearYes') / ('clearNo'))
//    __dev.editor('pencilPlan', [[x,z]...]) what letting go of that pencil line would do (road.ts
//                                          planRedraw): redraw (and how much road goes) or nothing (why)
//    __dev.editor('fit')                   frame the track
//    __dev.editor('view', [cx, cz, mpp])   look somewhere (or pass a road point index)
//    __dev.editor('selftest')              run the clean-up self-test
//    __dev.editor('checks')                the Checks panel's verdict and the game's
//                                          track gates on the built draft (the same
//                                          rows `bun run tracks:check` prints)
//
//  The shaping tools, for checkers without a mouse:
//    __dev.editor('smooth')                press Smooth once; returns the wobble before and after
//    __dev.editor('roughness')             how wobbly the road is (shape.ts roadRoughness), and the
//                                          same measure on the built preview's samples
//    __dev.editor('bend', [at, dx, dz, reach])   grab the road at `at` and pull it by (dx, dz) metres
//    __dev.editor('straight', [fromAt, toAt])    make that stretch straight
//    __dev.editor('curve', [fromAt, toAt, x, z]) make it one curve through (x, z)
//    __dev.editor('corners')               the corners, tightest first: at, radius, where
//    __dev.editor('corner', [i, radius])   the corner road point i sits in: read it, or set its radius
//    __dev.editor('screen', at | [x, z])   where a road spot (or a world point) is on screen,
//                                          so a probe can click it with the real mouse
//    __dev.editor('tool', name)            pick a tool: select pencil straight curve bend height bank width place
//    __dev.editor('steady', 0..3)          the pencil's steady hand (0 = off)
//
//  Bridges (which road goes over where the road crosses itself):
//    __dev.editor('crossings')             every crossing: where, which pass is on top, the
//                                          height between them, each pass's heading and `at`,
//                                          and where its marker and BRIDGE label are on screen
//    __dev.editor('selectCrossing', i)     select crossing i (as a click on its BRIDGE label does)
//    __dev.editor('swap', i | [x, z])      press Swap on crossing i (or the one at a map spot);
//                                          returns ok, the status line and the crossings after
//
//  Height and problems (editor8):
//    __dev.editor('stretch', [from, to, tool])  select a stretch of road with the Height, Bank or Width
//                                          tool (Height if none), as a drag does
//    __dev.editor('pickStretch', [tool, at])  a click on the road with that tool: the change already
//                                          there, or a sensible stretch around it (editor9)
//    __dev.editor('limits')                the Height slider's ends for the selected stretch, worked
//                                          out straight away (lo, hi, why, the stretch a higher one needs)
//    __dev.editor('marks')                 the RAISED, BANK and WIDTH labels on screen (to click them)
//    __dev.editor('raise', [from, to, h])  set the middle of that stretch to h metres above the ground
//                                          (the Height tool's slider); returns ok and the status line
//    __dev.editor('raisePoint', [i, h])    the same smooth hump centred on road point i (editor8's point slider)
//    __dev.editor('problems')              the Checks list: each row's key, title, remedy, offer
//    __dev.editor('findFixes')             finish looking for fixes now (no waiting), then the list
//                                          (fix / go / game / none), its button and where it is
//    __dev.editor('selectProblem', key | i)   select a problem (as a click on its row or pin does)
//    __dev.editor('fix', key | i)          press Fix it on that problem; returns ok and the status line
//    __dev.editor('fixAll')                press Fix all
//    __dev.editor('pins')                  where each problem's pin and tag are on screen (to click them)
//
//  Inspector: __game.get('editor') - a summary of the draft.
//  URL switch: ?editor=1 opens the editor straight away.
// ============================================================

import { registerDev, registerInspector, urlParam } from '../core/devHandles'
import { openEditor } from '../core/session'
import { useGame } from '../core/store'
import { getTrackFile } from '../track/registry'
import { getTrack } from '../track/current'
import type { P } from './geom'
import {
  type EditorTool,
  applyCornerRadius,
  applyCurve,
  applyStraight,
  applyStroke,
  beginBend,
  clearAll,
  draftCrossings,
  randomRoad,
  draftFromFile,
  selectCrossing,
  swapBridge,
  draftId,
  endBend,
  fileFromDraft,
  moveBend,
  newDraft,
  pointGroundFor,
  previewNow,
  redo,
  replaceDraft,
  saveDraft,
  setBendReach,
  setSteady,
  setTool,
  smoothRoad,
  testDrive,
  undo,
  useEditor,
} from './draft'
import { fitToDraft } from './Overlay'
import { crossingScreens, markScreens, pinScreens } from './mapDraw'
import { heightLimits } from './raise'
import { type StretchTool, isStretchTool } from './stretchRuns'
import { pickStretchAt } from './stretchTools'
import { currentProblems, findFixesNow, fixAll, fixOffer, fixProblem, raisePoint, raiseSection, selectProblem } from './fixActions'
import { runEditorSelfTest } from './selfTest'
import { checkVerdict } from './checks'
import { cancelDriveToDraw, clearLaidRoad, driveRecorder, finishDriveToDraw, startDriveToDraw } from './driveToDraw'
import { answerClearAll, askClearAll, askRandomTrack, useClearAsk } from './ClearAll'
import { isEmptyDraft } from './draftFile'
import { closeWorldMap, isMapOpen, openWorldMap } from './worldMap'
import { setView, view, worldToScreen } from './view'
import { frameAt, planRedraw, roadCurve } from './road'
import { atOf, cornerAt, posOf, roadLine, roadRoughness, tightestOnRoad } from './shape'
import { circumradius } from './geom'

const TAU = Math.PI * 2

/** Ready-made drawings, a bit shaky like a real hand, for checkers and demos. */
function shape(name: string): P[] {
  let wobble = 0
  const wob = (i: number) => {
    wobble = Math.sin(i * 0.37) * 1.2 + Math.sin(i * 1.3) * 0.6
    return wobble
  }
  const sample = (f: (t: number) => P, count: number, t0 = 0, t1 = 1): P[] =>
    Array.from({ length: count + 1 }, (_, i) => {
      const p = f(t0 + ((t1 - t0) * i) / count)
      return { x: p.x + wob(i), z: p.z + wob(i + 50) }
    })
  switch (name) {
    case 'circle':
      return sample((t) => ({ x: 200 * Math.cos(t * TAU), z: 200 * Math.sin(t * TAU) }), 400, 0, 1.03)
    case 'eight':
      return sample((t) => ({ x: 300 * Math.sin(t * TAU), z: 150 * Math.sin(2 * t * TAU) }), 600, 0.1, 1.1)
    case 'square':
      return sample((t) => {
        const side = Math.floor(t * 4) % 4
        const f = t * 4 - Math.floor(t * 4)
        const c = [
          { x: -180, z: -180 },
          { x: 180, z: -180 },
          { x: 180, z: 180 },
          { x: -180, z: 180 },
        ]
        const a = c[side]
        const b = c[(side + 1) % 4]
        return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f }
      }, 400, 0, 1.01)
    case 'hairpin':
      return sample((t) => {
        // A long loop with a tight hairpin poking north.
        const a = t * TAU
        const r = 220 + 160 * Math.max(0, Math.cos(a - Math.PI / 2)) ** 12
        return { x: r * Math.cos(a) * (1 - 0.6 * Math.max(0, Math.cos(a - Math.PI / 2)) ** 12), z: -r * Math.sin(a) * 0.8 }
      }, 500, 0, 1.02)
    case 'kidney':
    default:
      return sample((t) => {
        const a = t * TAU
        const r = 240 + 70 * Math.sin(2 * a) + 40 * Math.cos(3 * a)
        return { x: r * Math.cos(a), z: r * Math.sin(a) * 0.85 }
      }, 500, 0, 1.02)
  }
}

function toPoints(input: unknown): P[] {
  if (!Array.isArray(input)) return []
  return input
    .map((p) => (Array.isArray(p) ? { x: Number(p[0]), z: Number(p[1]) } : { x: Number((p as P).x), z: Number((p as P).z) }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.z))
}

function strokeResult(raw: P[]) {
  const res = applyStroke(raw, 1.8)
  const preview = previewNow()
  const s = useEditor.getState()
  return {
    ok: res.ok && !!preview?.ok,
    id: s.savedId ?? draftId(s.draft),
    points: res.points.length,
    lengthM: Math.round(res.length),
    tightestRadiusM: Math.round(res.tightestRadius * 10) / 10,
    crossings: res.crossings.map((c) => ({ x: Math.round(c.at.x), z: Math.round(c.at.z), angleDeg: Math.round(c.angleDeg), bridged: c.over !== null })),
    issues: res.issues.map((i) => `${i.level}: ${i.message}`),
    validatorErrors: preview?.errors.map((e) => `${e.path}: ${e.message}`) ?? [],
    validatorWarnings: preview?.warnings.map((w) => `${w.path}: ${w.message}`) ?? [],
  }
}

/** Every crossing of the draft's road, rounded for reading, with where its marker and BRIDGE label are on screen. */
function crossingsSummary() {
  const screens = crossingScreens()
  return draftCrossings().map((c) => ({
    screen: screens.find((t) => Math.hypot(t.x - c.at.x, t.z - c.at.z) < 1) ?? null,
    x: Math.round(c.at.x * 10) / 10,
    z: Math.round(c.at.z * 10) / 10,
    over: c.over,
    gap: Math.round(c.gap * 100) / 100,
    angle: Math.round(c.angleDeg),
    passes: c.passes.map((p) => ({ at: Math.round(p.at * 100) / 100, heading: Math.round(p.heading), height: Math.round(p.height * 100) / 100 })),
  }))
}

function editorCommand(cmd: string, arg?: unknown): unknown {
  switch (cmd) {
    case 'help':
      return 'stroke [[x,z]...] | shape circle|eight|square|hairpin|kidney | file | save | testDrive | new [baseWorld] | open id | undo | redo | clear | clearYes | clearNo | clearNow | random [seed] | askRandom | pencilPlan [[x,z]...] | fit | view [cx,cz,mpp] or pointIndex | drive | driveFeed [[x,z]...] | driveFinish | driveCancel | driveClear | map | mapClose | selftest | checks | state | smooth | roughness | bend [at,dx,dz,reach] | straight [from,to] | curve [from,to,x,z] | corners | corner [i] or [i,radius] | screen at|[x,z] | tool name | steady 0..3 | crossings | selectCrossing i | swap i|[x,z] | stretch [from,to,tool] | pickStretch [tool,at] | limits | marks | raise [from,to,h] | raisePoint [i,h] | problems | findFixes | selectProblem key|i | fix key|i | fixAll | pins'
    case 'stroke':
      return strokeResult(toPoints(arg))
    case 'shape':
      return strokeResult(shape(String(arg ?? 'kidney')))
    case 'file': {
      const s = useEditor.getState()
      return fileFromDraft(s.draft, s.savedId ?? undefined)
    }
    case 'save':
      return saveDraft()
    case 'testDrive':
      return testDrive()
    case 'new':
      replaceDraft(newDraft(typeof arg === 'string' ? arg : undefined), null)
      return useEditor.getState().draft.baseWorld
    case 'open': {
      const file = getTrackFile(String(arg))
      if (!file) return `no track called ${String(arg)}`
      replaceDraft(draftFromFile(file, false), file.id)
      return file.id
    }
    case 'undo':
      undo()
      return useEditor.getState().past.length
    case 'redo':
      redo()
      return useEditor.getState().future.length
    case 'clear':
      return askClearAll()
    case 'clearYes':
    case 'clearNo':
      answerClearAll(cmd === 'clearYes')
      return { undoSteps: useEditor.getState().past.length, points: useEditor.getState().draft.points.length }
    case 'clearNow':
      return clearAll()
    case 'random': {
      const seed = Number(arg)
      const r = Number.isFinite(seed) && arg !== undefined ? randomRoad(seed >>> 0) : randomRoad()
      if (r) fitToDraft()
      return r ? { ...r, ms: Math.round(r.ms), message: useEditor.getState().message?.text ?? '', points: useEditor.getState().draft.points.length, undoSteps: useEditor.getState().past.length } : null
    }
    case 'askRandom':
      return askRandomTrack()
    case 'pencilPlan': {
      const d = useEditor.getState().draft
      const plan = planRedraw(toPoints(arg), d.points, d.width)
      return plan.kind === 'redraw' ? { kind: 'redraw', replacedPoints: plan.replaced.length } : plan
    }
    case 'view': {
      // [cx, cz, metresPerPixel], or a road point index to look at closely.
      if (Array.isArray(arg)) setView(Number(arg[0]), Number(arg[1]), Number(arg[2] ?? view.mpp))
      else if (typeof arg === 'number') {
        const p = useEditor.getState().draft.points[arg]
        if (p) setView(p.x, p.z, 0.25)
      }
      // width/height: the map's size in CSS pixels, so a checker can turn world points into clicks.
      return { cx: view.cx, cz: view.cz, mpp: view.mpp, width: view.width, height: view.height }
    }
    case 'fit':
      fitToDraft()
      return { cx: view.cx, cz: view.cz, mpp: view.mpp }
    case 'drive':
      // Start drive to draw (needs <EditorDrive /> mounted by App to record a real car).
      return startDriveToDraw()
    case 'driveFeed': {
      // Add recorded points as if the car had driven there: [[x, z], ...] (y = ground).
      for (const p of toPoints(arg)) driveRecorder.add(p.x, 0, p.z)
      return { active: driveRecorder.active, points: driveRecorder.count, metres: driveRecorder.metres }
    }
    case 'driveFinish':
      return finishDriveToDraw()
    case 'driveCancel':
      cancelDriveToDraw()
      return true
    case 'driveClear':
      // The drive bar's Clear, already confirmed: wipe the road laid so far and keep driving.
      clearLaidRoad()
      return { active: driveRecorder.active, points: driveRecorder.count, metres: driveRecorder.metres }
    case 'map':
      openWorldMap()
      return isMapOpen()
    case 'mapClose':
      closeWorldMap()
      return isMapOpen()
    case 'selftest':
      return runEditorSelfTest()
    case 'crossings':
      return crossingsSummary()
    case 'selectCrossing': {
      const c = draftCrossings()[Number(arg)]
      return c ? selectCrossing(c.at) : `no crossing ${String(arg)}`
    }
    case 'swap': {
      const spot = Array.isArray(arg) ? { x: Number(arg[0]), z: Number(arg[1]) } : draftCrossings()[Number(arg ?? 0)]?.at
      if (!spot) return `no crossing ${String(arg)}`
      const ok = swapBridge(spot)
      return { ok, message: useEditor.getState().message?.text ?? '', crossings: crossingsSummary() }
    }
    case 'checks':
      return checksSummary()
    case 'stretch': {
      const [a, b] = Array.isArray(arg) ? arg.slice(0, 2).map(Number) : []
      if (![a, b].every(Number.isFinite)) return 'stretch needs [fromAt, toAt] (and optionally height, bank or width)'
      const tool = Array.isArray(arg) && isStretchTool(String(arg[2])) ? (String(arg[2]) as StretchTool) : 'height'
      setTool(tool)
      useEditor.setState({ selection: { kind: 'section', from: a, to: b } })
      return useEditor.getState().selection
    }
    case 'raise': {
      const [a, b, h] = Array.isArray(arg) ? arg.map(Number) : []
      if (![a, b, h].every(Number.isFinite)) return 'raise needs [fromAt, toAt, metres]'
      return { ok: raiseSection(a, b, h), message: useEditor.getState().message?.text ?? '', selection: useEditor.getState().selection }
    }
    case 'pickStretch': {
      const [tool, at] = Array.isArray(arg) ? [String(arg[0]), Number(arg[1])] : ['', NaN]
      if (!isStretchTool(tool) || !Number.isFinite(at)) return 'pickStretch needs [height|bank|width, at]'
      pickStretchAt(tool, at)
      return { tool: useEditor.getState().tool, selection: useEditor.getState().selection, message: useEditor.getState().message?.text ?? '' }
    }
    case 'limits': {
      const s = useEditor.getState()
      const sel = s.selection
      if (sel?.kind !== 'section') return 'select a stretch first'
      const id = s.savedId ?? draftId(s.draft)
      const t = getTrack()
      return heightLimits(s.draft, sel.from, sel.to, { id, pointGround: pointGroundFor(s.draft), params: t && t.id === id ? { ...t.params } : {} })
    }
    case 'marks':
      return markScreens()
    case 'raisePoint': {
      const [i, h] = Array.isArray(arg) ? arg.map(Number) : []
      if (![i, h].every(Number.isFinite)) return 'raisePoint needs [pointIndex, metres]'
      return { ok: raisePoint(i, h), message: useEditor.getState().message?.text ?? '', selection: useEditor.getState().selection }
    }
    case 'problems':
      return problemsSummary()
    case 'findFixes':
      findFixesNow()
      return problemsSummary()
    case 'selectProblem':
      return selectProblem(problemKey(arg))
    case 'fix':
      return { ok: fixProblem(problemKey(arg)), message: useEditor.getState().message?.text ?? '', problems: problemsSummary() }
    case 'fixAll':
      return { ok: fixAll(), message: useEditor.getState().message?.text ?? '', problems: problemsSummary() }
    case 'pins':
      return pinScreens()
    case 'smooth':
      return smoothRoad()
    case 'roughness':
      return roughnessNow()
    case 'bend': {
      const [at, dx, dz, reach] = Array.isArray(arg) ? arg.map(Number) : []
      if (![at, dx, dz].every(Number.isFinite)) return 'bend needs [at, dx, dz] (and optionally reach in metres)'
      if (Number.isFinite(reach)) setBendReach(reach)
      const d = useEditor.getState().draft
      const grab = frameAt(roadCurve(d.points), at).p
      beginBend(at, grab)
      const view0 = moveBend({ x: grab.x + dx, z: grab.z + dz })
      endBend()
      return { tightDuringDrag: view0?.tight ? Math.round(view0.tightRadius * 10) / 10 : null, ...shapeSummary() }
    }
    case 'straight': {
      const [a, b] = Array.isArray(arg) ? arg.map(Number) : []
      if (![a, b].every(Number.isFinite)) return 'straight needs [fromAt, toAt]'
      return { ok: applyStraight(a, b), ...shapeSummary() }
    }
    case 'curve': {
      const [a, b, x, z] = Array.isArray(arg) ? arg.map(Number) : []
      if (![a, b, x, z].every(Number.isFinite)) return 'curve needs [fromAt, toAt, x, z]'
      return { ok: applyCurve(a, b, { x, z }), ...shapeSummary() }
    }
    case 'corners':
      return cornerList()
    case 'corner': {
      // [pointIndex] reads the corner a road point sits in; [pointIndex, radius] sets its radius.
      const [index, radius] = Array.isArray(arg) ? arg.map(Number) : [Number(arg), NaN]
      const d = useEditor.getState().draft
      if (!Number.isInteger(index) || !d.points[index]) return 'corner needs [pointIndex] or [pointIndex, radius]'
      if (Number.isFinite(radius)) return { ok: applyCornerRadius(index, radius), ...shapeSummary() }
      const c = cornerAt(d.points, index)
      if (typeof c === 'string') return c
      return { radiusM: Math.round(c.radius), minM: Math.floor(c.min), maxM: Math.ceil(c.max), turnDeg: Math.round((c.turn * 180) / Math.PI) }
    }
    case 'screen': {
      const d = useEditor.getState().draft
      if (!Array.isArray(arg) && isEmptyDraft(d)) return 'the map is empty: pass [x, z] for a world point'
      const w = Array.isArray(arg) ? { x: Number(arg[0]), z: Number(arg[1]) } : frameAt(roadCurve(d.points), Number(arg)).p
      const s = worldToScreen(w.x, w.z)
      return { sx: Math.round(s.sx * 10) / 10, sy: Math.round(s.sy * 10) / 10, x: Math.round(w.x * 10) / 10, z: Math.round(w.z * 10) / 10 }
    }
    case 'tool': {
      const tools = ['select', 'pencil', 'straight', 'curve', 'bend', 'height', 'bank', 'width', 'place']
      if (!tools.includes(String(arg))) return `tool must be one of ${tools.join(' ')}`
      setTool(String(arg) as EditorTool)
      return useEditor.getState().tool
    }
    case 'steady':
      setSteady(Number(arg))
      return useEditor.getState().steady
    case 'state':
      return summary()
    default:
      return `unknown editor command "${cmd}" - try __dev.editor('help')`
  }
}

/** The Checks list in short: key, how bad, title, what can be done, and where. */
function problemsSummary() {
  return currentProblems().map((p) => ({
    key: p.key,
    tone: p.tone,
    title: p.title,
    remedy: p.remedy.kind,
    // editor10: whether Fix it has a fix to offer yet (looking / found / none), and the by-hand button.
    offer: p.remedy.kind === 'fix' ? fixOffer(p.key) : null,
    button: p.remedy.kind === 'fix' ? (fixOffer(p.key) === 'found' ? 'Fix it' : p.remedy.go?.button ?? null) : p.remedy.kind === 'go' ? p.remedy.go.button : null,
    at: p.at ? { x: Math.round(p.at.x), z: Math.round(p.at.z) } : null,
    roadAt: p.roadAt === null ? null : Math.round(p.roadAt * 100) / 100,
  }))
}

/** A problem by its key, or by its place in the Checks list. */
function problemKey(arg: unknown): string {
  if (typeof arg === 'number') return currentProblems()[arg]?.key ?? ''
  return String(arg ?? '')
}

/** How wobbly the draft is: shape.ts's measure, and the same on the built preview's own samples. */
function roughnessNow() {
  const s = useEditor.getState()
  const t = getTrack()
  let built: number | null = null
  if (t && s.checkedDraft === s.draft && s.preview === 'built') {
    const S = t.samples
    let rough = 0
    for (let i = 0; i < S.count; i++) rough += Math.abs(S.curvature[(i + 1) % S.count] - S.curvature[i])
    built = Math.round((rough / (S.count * S.ds)) * 1e6)
  }
  return {
    editor: Math.round(roadRoughness(s.draft.points)),
    built,
    tightestM: Math.round(tightestOnRoad(s.draft.points).radius * 10) / 10,
    points: s.draft.points.length,
  }
}

/** After a shaping command: what the status line said and the draft's shape. */
function shapeSummary() {
  const s = useEditor.getState()
  return {
    message: s.message?.text ?? null,
    points: s.draft.points.length,
    pieces: s.draft.pieces.map((p) => ({ type: p.type, at: p.at })),
    startAt: s.draft.startAt,
    undoSteps: s.past.length,
    roughness: Math.round(roadRoughness(s.draft.points)),
    tightestM: Math.round(tightestOnRoad(s.draft.points).radius * 10) / 10,
  }
}

/** The road's corners, tightest first (a probe picks one to bend). */
function cornerList() {
  const d = useEditor.getState().draft
  const line = roadLine(d.points)
  const step = 2
  const n = Math.floor(line.length / step)
  const r = new Float64Array(n)
  for (let i = 0; i < n; i++) r[i] = circumradius(posOf(line, i * step - 6), posOf(line, i * step), posOf(line, i * step + 6))
  const peaks: { s: number; radius: number }[] = []
  for (let i = 0; i < n; i++) {
    const here = r[i]
    if (here > 400) continue
    let isPeak = true
    for (let k = -10; k <= 10 && isPeak; k++) if (k && r[(i + k + n) % n] < here) isPeak = false
    if (isPeak) peaks.push({ s: i * step, radius: here })
  }
  peaks.sort((a, b) => a.radius - b.radius)
  return peaks.slice(0, 12).map((p) => {
    const at = atOf(line, p.s)
    const w = posOf(line, p.s)
    return { at: Math.round(at * 1000) / 1000, radiusM: Math.round(p.radius * 10) / 10, x: Math.round(w.x), z: Math.round(w.z) }
  })
}

/** What the Checks panel is showing, and the raw gate rows behind it. */
function checksSummary() {
  const s = useEditor.getState()
  const fresh = s.checkedDraft === s.draft && s.preview !== 'pending'
  const cleanupErrors = (s.notes?.issues ?? []).filter((i) => i.level === 'error').length
  const t = getTrack()
  return {
    verdict: isEmptyDraft(s.draft) ? 'empty' : checkVerdict({ fresh, errors: s.errors, gates: s.gates, cleanupErrors }),
    panel: document.querySelector('.sre-verdict')?.textContent ?? null,
    trackKey: t?.key ?? null,
    gatesMs: Math.round(s.gatesMs),
    gates: (s.gates ?? []).map((g) => ({ name: g.name, level: g.level, message: g.message, fix: g.fix })),
    validatorErrors: s.errors.map((e) => `${e.path}: ${e.message}`),
    validatorWarnings: s.warnings.map((w) => `${w.path}: ${w.message}`),
  }
}

function summary() {
  const s = useEditor.getState()
  return {
    phase: useGame.getState().phase,
    mode: s.mode,
    id: s.savedId ?? draftId(s.draft),
    name: s.draft.name,
    points: s.draft.points.length,
    width: s.draft.width,
    baseWorld: s.draft.baseWorld,
    dirty: s.dirty,
    savedId: s.savedId,
    tool: s.tool,
    bendReach: s.bendReach,
    steady: s.steady,
    shaping: s.shaping,
    selection: s.selection,
    clearAsk: useClearAsk.getState().open,
    pieces: s.draft.pieces.length,
    props: s.draft.props.length,
    cores: s.draft.cores.length,
    startAt: s.draft.startAt,
    roadSettings: s.draft.roadSettings ?? null,
    laps: s.draft.laps ?? null,
    hunt: s.draft.hunt ?? null,
    undoSteps: s.past.length,
    redoSteps: s.future.length,
    preview: s.preview,
    errors: s.errors.length,
    warnings: s.warnings.map((w) => w.message),
    empty: isEmptyDraft(s.draft),
    verdict: isEmptyDraft(s.draft) ? 'empty' : checkVerdict({ fresh: s.checkedDraft === s.draft && s.preview !== 'pending', errors: s.errors, gates: s.gates, cleanupErrors: (s.notes?.issues ?? []).filter((i) => i.level === 'error').length }),
    gatesFailing: (s.gates ?? []).filter((g) => g.level === 'fail').map((g) => g.name),
    gatesWarning: (s.gates ?? []).filter((g) => g.level === 'warn').map((g) => g.name),
    view: { cx: Math.round(view.cx), cz: Math.round(view.cz), mpp: Math.round(view.mpp * 100) / 100 },
  }
}

registerDev('editor', editorCommand as (...args: never[]) => unknown, "road editor: __dev.editor('help')")
registerInspector('editor', summary)
registerInspector('editorSel', () => useEditor.getState().selection)
registerInspector('editorMsg', () => useEditor.getState().message?.text ?? null)

// ?editor=1 opens the editor once the game has booted.
if (typeof window !== 'undefined' && urlParam('editor') === '1') {
  setTimeout(() => {
    if (useGame.getState().phase === 'title') openEditor()
  }, 0)
}
