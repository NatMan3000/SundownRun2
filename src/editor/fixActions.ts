// ============================================================
//  FIX AND RAISE ACTIONS - the buttons, wired to the editor's store
// ------------------------------------------------------------
//  raise.ts and fixes.ts are pure maths (drafts in, drafts out). This
//  file is what the panel's buttons and the map's pins call:
//
//    raiseSection   the Stretch tool's Height slider
//    raisePoint     a road point's "Height above the ground" slider
//                   (the same smooth bump, centred on the point)
//    selectProblem  click a row in Checks, or its pin on the map
//    goToProblem    "Show me": the right tool, the right bit of road
//    fixProblem     Fix it
//    fixAll         Fix all (every problem that has a Fix it)
//
//  Every change is ONE commit (one Undo step), built and checked
//  before it lands. Then the live preview rebuilds as after any edit,
//  the checks run again, and the status line says what changed.
// ============================================================

import { audio } from '../core/api'
import { getTrack } from '../track/current'
import type { TrackRuntime } from '../track/types'
import { type Draft, carryAlongside, commit, draftId, pointGroundFor, say, setTool, shapeWorld, useEditor } from './draft'
import { type Judged, judgeDraft } from './judge'
import { NO_NOTES, type Problem, problemByKey, problemsOf } from './problems'
import { runFix, runFixAll } from './fixes'
import { pointStretch, raiseDraft } from './raise'
import { atOf, roadLine, sOf, wrapS } from './shape'
import { setView, view } from './view'

/** The live preview's built track, if it is THIS draft, built since the last change. */
export function liveRuntime(): TrackRuntime | null {
  const s = useEditor.getState()
  const t = getTrack()
  const id = s.savedId ?? draftId(s.draft)
  return s.checkedDraft === s.draft && s.preview === 'built' && t && t.id === id ? t : null
}

/** The draft as it is now, built and checked: the live preview's when it is fresh, else built now. */
function judgedNow(): { judged: Judged; id: string; params: Record<string, number> } {
  const s = useEditor.getState()
  const id = s.savedId ?? draftId(s.draft)
  const t = getTrack()
  const params = t && t.id === id ? { ...t.params } : {}
  const live = liveRuntime()
  if (live && s.gates) return { judged: { runtime: live, gates: s.gates, errors: s.errors, warnings: s.warnings }, id, params }
  return { judged: judgeDraft(s.draft, id, params, t), id, params }
}

/** The Checks list as the panel shows it right now. */
export function currentProblems(): Problem[] {
  const s = useEditor.getState()
  const fresh = s.checkedDraft === s.draft && s.preview !== 'pending'
  return problemsOf({ draft: s.draft, gates: fresh ? s.gates : null, errors: s.errors, warnings: s.warnings, notes: s.notes?.issues ?? NO_NOTES })
}

/** "Every check passes now." / "2 problems still to fix.": the checks after a change, in a few words. */
function checksNow(after: Judged): string {
  const bad = after.errors.length + after.gates.filter((g) => g.level === 'fail').length
  return bad === 0 ? 'Every check passes now.' : `${bad} problem${bad === 1 ? '' : 's'} still to fix.`
}

// ---------------------------------------------------------------- raising road

/**
 * The Stretch tool's Height: the middle of the stretch from `from` to `to`
 * goes to `height` metres above the ground, on smooth ramps (raise.ts). The
 * stretch stays selected on the new road.
 */
export function raiseSection(from: number, to: number, height: number): boolean {
  const s = useEditor.getState()
  if (s.mode !== 'edit') return false
  const { judged, id, params } = judgedNow()
  const res = raiseDraft(s.draft, from, to, height, { id, pointGround: pointGroundFor(s.draft), params, before: { runtime: judged.runtime, gates: judged.gates } })
  if (!res.ok || !res.draft) {
    say(res.reason ?? "Can't change the height there.", 'warn')
    audio.ui('error')
    return false
  }
  landRaise(res.draft)
  if (res.from !== undefined && res.to !== undefined) useEditor.setState({ selection: { kind: 'section', from: res.from, to: res.to } })
  say(res.done ?? 'Done.', res.limited ? 'warn' : 'good')
  audio.ui('select')
  return true
}

/**
 * A road point's "Height above the ground": the road eases up to it and back
 * down over as much road either side as a car needs to stay on (raise.ts
 * pointStretch), not a spike at one point. The same point stays selected.
 */
export function raisePoint(index: number, height: number): boolean {
  const s = useEditor.getState()
  if (s.mode !== 'edit') return false
  const ground = pointGroundFor(s.draft)
  const { judged, id, params } = judgedNow()
  const st = pointStretch(s.draft.points, index, height, judged.runtime, ground)
  const res = raiseDraft(s.draft, st.from, st.to, height, { id, pointGround: ground, params, before: { runtime: judged.runtime, gates: judged.gates } })
  if (!res.ok || !res.draft || res.from === undefined || res.to === undefined) {
    say(res.reason ?? "Can't change the height there.", 'warn')
    audio.ui('error')
    return false
  }
  const next = res.draft
  landRaise(next)
  // The point in the middle of the new stretch is the one he had selected.
  const line = roadLine(next.points)
  const s0 = sOf(line, res.from)
  const mid = atOf(line, s0 + wrapS(sOf(line, res.to) - s0, line.length) / 2)
  useEditor.setState({ selection: { kind: 'point', index: Math.round(mid) % next.points.length } })
  const each = Math.round(st.metres / 2)
  say(
    res.limited
      ? res.done ?? 'Done.'
      : `The road here is ${Math.round((res.height ?? height) * 10) / 10} m up now, easing up and back down over ${each} m either side so cars stay on it. Undo puts it back.`,
    res.limited ? 'warn' : 'good',
  )
  audio.ui('select')
  return true
}

/** A raised road becomes the draft: one Undo step. */
function landRaise(next: Draft): void {
  commit((x) => {
    x.points = next.points
    x.pieces = next.pieces
    x.startAt = next.startAt
  })
}

// ---------------------------------------------------------------- problems

/** The last problem Fix it mended (the panel says "Fixed" when its row has gone). */
export let lastFixed: { key: string; did: string } | null = null

/** Select a problem (a row in Checks, or its pin on the map) and show where it is. */
export function selectProblem(key: string, look = true): boolean {
  const p = problemByKey(currentProblems(), key)
  if (!p) return false
  useEditor.setState({ selection: { kind: 'problem', key } })
  if (look && p.at) setView(p.at.x, p.at.z, Math.min(view.mpp, 0.6))
  audio.ui('select')
  return true
}

/** "Show me": the tool that fixes it by hand, with the right bit of road selected. */
export function goToProblem(key: string): boolean {
  const p = problemByKey(currentProblems(), key)
  const go = p ? (p.remedy.kind === 'go' ? p.remedy.go : p.remedy.kind === 'fix' ? p.remedy.go : undefined) : undefined
  if (!go) return false
  setTool(go.tool, go.place)
  useEditor.setState({ selection: go.selection })
  if (go.spot) setView(go.spot.x, go.spot.z, Math.min(view.mpp, 0.6))
  audio.ui('select')
  return true
}

/** The context the pure fixes need, for the draft as it is now. */
function fixContext() {
  const s = useEditor.getState()
  const { judged, id, params } = judgedNow()
  return { id, params, world: shapeWorld(s.draft), before: judged, carry: carryAlongside }
}

/**
 * Fix it: mend the problem with this key (fixes.ts). One Undo step. If no
 * way of mending it passes the game's checks without breaking another one,
 * nothing changes and the status line says why and how to do it by hand.
 */
export function fixProblem(key: string): boolean {
  const s = useEditor.getState()
  if (s.mode !== 'edit') return false
  const p = problemByKey(currentProblems(), key)
  if (!p) {
    say('That problem has gone already.', 'info')
    return false
  }
  const ctx = fixContext()
  const res = runFix(p, s.draft, ctx)
  if (!res.ok || !res.draft || !res.after) {
    const go = p.remedy.kind === 'fix' ? p.remedy.go : undefined
    say(`Fix it couldn't mend this one by itself: ${res.reason}. Nothing changed.${go ? ` Try it by hand: press "${go.button}".` : ''}`, 'warn')
    audio.ui('error')
    return false
  }
  const next = res.draft
  commit((x) => Object.assign(x, next))
  lastFixed = { key, did: res.did ?? '' }
  say(`Fixed: ${res.did} ${checksNow(res.after)} Undo puts it back.`, 'good')
  audio.ui('select')
  return true
}

/** Fix all: every problem with a Fix it, one after another, as ONE Undo step. */
export function fixAll(): boolean {
  const s = useEditor.getState()
  if (s.mode !== 'edit') return false
  const ctx = fixContext()
  const res = runFixAll(s.draft, ctx, s.notes?.issues ?? [])
  if (!res.did.length) {
    say(res.couldNot.length ? `Fix all couldn't mend any of them by itself (${res.couldNot.length} tried). Nothing changed: pick one in Checks to see how to fix it by hand.` : 'Nothing for Fix all to do.', 'warn')
    audio.ui('error')
    return false
  }
  const next = res.draft
  commit((x) => Object.assign(x, next))
  useEditor.setState({ selection: null })
  const left = res.couldNot.length ? ` It couldn't mend ${res.couldNot.length} more by itself: pick ${res.couldNot.length === 1 ? 'it' : 'them'} in Checks.` : ''
  const did = res.did.map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join(' ')
  say(`Fix all: ${did} ${checksNow(res.after)}${left} One Undo puts it all back.`, 'good')
  audio.ui('select')
  return true
}
