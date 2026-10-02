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
//    __dev.editor('clearNow')              clear all without asking (one undo step)
//    __dev.editor('fit')                   frame the track
//    __dev.editor('view', [cx, cz, mpp])   look somewhere (or pass a road point index)
//    __dev.editor('selftest')              run the clean-up self-test
//    __dev.editor('checks')                the Checks panel's verdict and the game's
//                                          track gates on the built draft (the same
//                                          rows `bun run tracks:check` prints)
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
  applyStroke,
  clearAll,
  draftFromFile,
  draftId,
  fileFromDraft,
  newDraft,
  previewNow,
  redo,
  replaceDraft,
  saveDraft,
  testDrive,
  undo,
  useEditor,
} from './draft'
import { fitToDraft } from './Overlay'
import { runEditorSelfTest } from './selfTest'
import { checkVerdict } from './checks'
import { cancelDriveToDraw, clearLaidRoad, driveRecorder, finishDriveToDraw, startDriveToDraw } from './driveToDraw'
import { answerClearAll, askClearAll, useClearAsk } from './ClearAll'
import { closeWorldMap, isMapOpen, openWorldMap } from './worldMap'
import { setView, view } from './view'

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

function editorCommand(cmd: string, arg?: unknown): unknown {
  switch (cmd) {
    case 'help':
      return 'stroke [[x,z]...] | shape circle|eight|square|hairpin|kidney | file | save | testDrive | new [baseWorld] | open id | undo | redo | clear | clearYes | clearNo | clearNow | fit | view [cx,cz,mpp] or pointIndex | drive | driveFeed [[x,z]...] | driveFinish | driveCancel | driveClear | map | mapClose | selftest | checks | state'
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
    case 'checks':
      return checksSummary()
    case 'state':
      return summary()
    default:
      return `unknown editor command "${cmd}" - try __dev.editor('help')`
  }
}

/** What the Checks panel is showing, and the raw gate rows behind it. */
function checksSummary() {
  const s = useEditor.getState()
  const fresh = s.checkedDraft === s.draft && s.preview !== 'pending'
  const cleanupErrors = (s.notes?.issues ?? []).filter((i) => i.level === 'error').length
  const t = getTrack()
  return {
    verdict: checkVerdict({ fresh, errors: s.errors, gates: s.gates, cleanupErrors }),
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
    clearAsk: useClearAsk.getState().open,
    pieces: s.draft.pieces.length,
    props: s.draft.props.length,
    cores: s.draft.cores.length,
    startAt: s.draft.startAt,
    undoSteps: s.past.length,
    redoSteps: s.future.length,
    preview: s.preview,
    errors: s.errors.length,
    warnings: s.warnings.map((w) => w.message),
    verdict: checkVerdict({ fresh: s.checkedDraft === s.draft && s.preview !== 'pending', errors: s.errors, gates: s.gates, cleanupErrors: (s.notes?.issues ?? []).filter((i) => i.level === 'error').length }),
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
