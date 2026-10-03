// ============================================================
//  FIX AND RAISE ACTIONS - the buttons, wired to the editor's store
// ------------------------------------------------------------
//  raise.ts and fixes.ts are pure maths (drafts in, drafts out). This
//  file is what the panel's buttons and the map's pins call:
//
//    raiseSection   the Height tool's slider
//    raisePoint     a road point's "Height above the ground" slider
//                   (the same smooth bump, centred on the point)
//    selectProblem  click a row in Checks, or its pin on the map
//    goToProblem    "Show me": the right tool, the right bit of road
//    fixProblem     Fix it
//    fixAll         Fix all (every problem that has a Fix it)
//    fixOffer       whether a problem's Fix it has a fix to offer: the
//                   editor looks for one in the background as soon as a
//                   problem shows (one build every few frames), so the
//                   panel only promises what it has found
//
//  Every change is ONE commit (one Undo step), built and checked
//  before it lands. Then the live preview rebuilds as after any edit,
//  the checks run again, and the status line says what changed.
// ============================================================

import { audio } from '../core/api'
import { getTrack } from '../track/current'
import type { TrackGate } from '../track/gates'
import type { TrackRuntime } from '../track/types'
import { type Draft, carryAlongside, commit, draftId, pointGroundFor, say, setTool, shapeWorld, useEditor } from './draft'
import { type Judged, judgeDraft } from './judge'
import { NO_NOTES, type Problem, problemByKey, problemsOf } from './problems'
import { type FixResult, FixSearch, runFix, runFixAll } from './fixes'
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
 * The Height tool's slider: the middle of the stretch from `from` to `to`
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

// ---------------------------------------------------------------- looking for fixes in the background

/**
 * What the Checks list may say about a problem's Fix it:
 *   looking  a fix is still being looked for (the row shows how to do it by hand meanwhile)
 *   found    one was found, built and checked: Fix it and "Fix it can mend this" show
 *   none     no fix was found for this road: only the by-hand words and button show
 * Never "found" until a fix really was (Nathan pressed Fix all on a promise once and
 * nothing changed).
 */
export type FixOffer = 'looking' | 'found' | 'none'

/** The background search for the draft whose checks the panel shows now. */
interface Finder {
  draft: Draft
  gates: readonly TrackGate[]
  /** One search per problem with a Fix it remedy, in the panel's order. */
  searches: Map<string, FixSearch>
  timer: ReturnType<typeof setTimeout> | null
}

let finder: Finder | null = null
let finderVersion = 0
const finderListeners = new Set<() => void>()

function finderChanged(): void {
  finderVersion++
  for (const l of finderListeners) l()
}

/** For React (useSyncExternalStore): re-render when a search finishes or starts again. */
export function subscribeFixSearch(listener: () => void): () => void {
  finderListeners.add(listener)
  return () => finderListeners.delete(listener)
}
export function fixSearchVersion(): number {
  return finderVersion
}

/** Milliseconds between two builds of the background search, so the editor stays responsive. */
const FIND_GAP_MS = 40

/**
 * Start looking for fixes for the draft as it is now, if its checks are fresh and
 * this hasn't been started for them already; stop looking if the draft changed.
 * `auto` schedules the steps on timers (the game); without it the caller runs them
 * (findFixesNow).
 */
export function refreshFixSearch(auto = true): Finder | null {
  const s = useEditor.getState()
  const fresh = s.mode === 'edit' && s.checkedDraft === s.draft && s.preview === 'built' && !!s.gates
  if (!fresh || !s.gates) {
    if (finder) {
      if (finder.timer) clearTimeout(finder.timer)
      finder = null
      finderChanged()
    }
    return null
  }
  if (finder && finder.draft === s.draft && finder.gates === s.gates) return finder
  if (finder?.timer) clearTimeout(finder.timer)
  const ctx = fixContext()
  const searches = new Map<string, FixSearch>()
  for (const p of currentProblems()) if (p.remedy.kind === 'fix') searches.set(p.key, new FixSearch(p, s.draft, ctx))
  finder = { draft: s.draft, gates: s.gates, searches, timer: null }
  finderChanged()
  if (auto) scheduleFind(finder)
  return finder
}

function scheduleFind(f: Finder): void {
  if (f.timer || ![...f.searches.values()].some((x) => !x.result)) return
  f.timer = setTimeout(() => {
    f.timer = null
    if (finder !== f) return
    const next = [...f.searches.values()].find((x) => !x.result)
    if (!next) return
    if (next.step()) finderChanged()
    scheduleFind(f)
  }, FIND_GAP_MS)
}

/** Run the search for the draft as it is now to the end, straight away (the self-test, the dev command). */
export function findFixesNow(): void {
  const f = refreshFixSearch(false)
  if (!f) return
  for (const x of f.searches.values()) while (!x.step()) {
    // one build and check per step
  }
  finderChanged()
}

/** What the Checks list may offer for the problem with this key (see FixOffer). */
export function fixOffer(key: string): FixOffer {
  const s = useEditor.getState()
  const x = finder && finder.draft === s.draft ? finder.searches.get(key) : undefined
  if (!x) return finder && finder.draft === s.draft ? 'none' : 'looking'
  if (!x.result) return 'looking'
  return x.result.ok ? 'found' : 'none'
}

/**
 * What a row in Checks says about Fix it: only "Fix it can mend this" once a fix has
 * really been found for this road; "Looking for a fix..." while the editor looks;
 * nothing when none was found (the row's Fix line and its Selected box say how to do
 * it by hand). (Panel.tsx; the self-test checks it.)
 */
export function canWords(p: Problem, offer: FixOffer): string | null {
  if (p.remedy.kind !== 'fix') return null
  return offer === 'found' ? 'Fix it can mend this' : offer === 'looking' ? 'Looking for a fix...' : null
}

/** The fixes found so far for the draft as it is now (Fix all starts from them). */
function foundFixes(): Map<string, FixResult> {
  const out = new Map<string, FixResult>()
  const s = useEditor.getState()
  if (!finder || finder.draft !== s.draft) return out
  for (const [key, x] of finder.searches) if (x.result) out.set(key, x.result)
  return out
}

// Keep looking as the editor changes (only in the game: the self-test drives it by hand).
if (typeof window !== 'undefined') useEditor.subscribe(() => refreshFixSearch())

/**
 * Fix it: mend the problem with this key (fixes.ts). One Undo step. If no
 * way of mending it passes the game's checks without breaking another one,
 * nothing changes and the status line says why and how to do it by hand.
 * When the background search has already found the fix, that one lands
 * (it was built and checked on this very draft).
 */
export function fixProblem(key: string): boolean {
  const s = useEditor.getState()
  if (s.mode !== 'edit') return false
  const p = problemByKey(currentProblems(), key)
  if (!p) {
    say('That problem has gone already.', 'info')
    return false
  }
  const known = foundFixes().get(key)
  const res = known ?? runFix(p, s.draft, fixContext())
  if (!res.ok || !res.draft || !res.after) {
    const go = p.remedy.kind === 'fix' ? p.remedy.go : undefined
    const hand = p.remedy.kind === 'fix' ? ` ${p.remedy.hand}` : ''
    say(`Fix it couldn't mend this one by itself: ${res.reason}. Nothing changed.${hand}${go ? ` Press "${go.button}" to start.` : ''}`, 'warn')
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
  const res = runFixAll(s.draft, ctx, s.notes?.issues ?? [], foundFixes())
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
