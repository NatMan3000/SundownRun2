// ============================================================
//  PROBLEMS - every row of the Checks list, and what to do about it
// ------------------------------------------------------------
//  The Checks panel lists everything the game wants Josh to look at:
//  the game's own track checks (checks.ts, from src/track/gates.ts),
//  the track validator's words, and the pencil clean-up's notes. This
//  file turns all of them into one list of Problems, in the order the
//  panel shows them, each with:
//    key     a name that stays the same while the problem is there,
//            so it can be selected (a click on its row or its map pin)
//    at      where on the map it is (the pin), and on the road
//    remedy  what Josh can do about it:
//              fix   the Fix it button can mend it by itself (fixes.ts
//                    builds the change and checks it before it lands)
//              go    no safe automatic fix: a button takes him to the
//                    right tool with the right bit of road selected
//              game  the game's own fault (a builder bug): nothing for
//                    him to fix, and it says so
//              none  nothing to fix (a note, or a warning that is fine)
//
//  The decisions for every check are in REMEDIES below (and in the
//  editor8 report), one row per check in checks.ts GATE_WORDS.
// ============================================================

import type { TrackGate } from '../track/gates'
import type { TrackIssue } from '../track/schema'
import type { StrokeIssue } from './cleanup'
import { type CheckItem, gateAt, gateItems, plainWords } from './checks'
import type { Draft, EditorTool, Selection } from './draft'
import type { P } from './geom'
import { issueLocation } from './mapDraw'
import type { PlaceKind } from './pieces'
import { type RoadCurve, advanceAt, frameAt, nearestOnRoad, roadCurve, wrapAt } from './road'
import { nearestStraightStart, roadLine, sOf, sOfPoint, wrapS } from './shape'

/** Where a "take me there" button goes: a tool, what it selects, and where the map looks. */
export interface GoTo {
  tool: EditorTool
  place?: PlaceKind
  selection: Selection | null
  spot: P | null
  /** The button's words ("Show me the loop"). */
  button: string
}

export type Remedy =
  /** Fix it can mend it; `does` says how, in Josh's words. `go` is the way to do it by hand. */
  | { kind: 'fix'; does: string; go?: GoTo }
  /** No safe automatic fix: what to do, and the button that takes him there. */
  | { kind: 'go'; does: string; go: GoTo }
  /** The game's own fault: nothing for him to do. */
  | { kind: 'game'; does: string }
  /** Nothing needs fixing. */
  | { kind: 'none'; does: string }

/** One row of the Checks list. */
export interface Problem extends CheckItem {
  key: string
  source: 'gate' | 'validator' | 'cleanup'
  gate?: TrackGate
  issue?: TrackIssue
  note?: StrokeIssue
  /** Where on the road it is, as an `at` on the draft (when it's about one spot of road). */
  roadAt: number | null
  remedy: Remedy
}

/** What the list is made from: the editor's state (draft.ts EditorState), or a judged draft. */
export interface ProblemSource {
  draft: Draft
  /** The game's checks on this draft (null or stale: none listed). */
  gates: readonly TrackGate[] | null
  errors: readonly TrackIssue[]
  warnings: readonly TrackIssue[]
  notes: readonly StrokeIssue[]
}

/** No clean-up notes (one shared empty list, so the list below is only worked out again when something changed). */
export const NO_NOTES: readonly StrokeIssue[] = []

const GAME_WORDS = "This one is the game's fault, not your track, so there's nothing here for you to fix. If it showed up straight after a change, Undo takes the change back."

// ---------------------------------------------------------------- helpers

/** The road point nearest `at` (for "select this point"). */
function nearestPoint(d: Draft, at: number): number {
  return Math.round(wrapAt(at, d.points.length)) % d.points.length
}

/** A stretch of road `before` metres back to `after` metres on from `at`, as a section selection. */
function stretchAround(rc: RoadCurve, at: number, before: number, after = before): Selection {
  return { kind: 'section', from: advanceAt(rc, at, -before), to: advanceAt(rc, at, after) }
}

/** The control-point positions a gate message names, in order ("(at 7.4)"). */
export function gateAts(g: TrackGate): number[] {
  return [...g.message.matchAll(/\(at (-?\d+(?:\.\d+)?)\)/g)].map((m) => Number(m[1])).filter(Number.isFinite)
}

/** The loop a gate message is about: the loop piece nearest its first position, or -1. */
function loopNear(d: Draft, at: number | null): number {
  if (at === null) return -1
  let best = -1
  let bestD = Infinity
  d.pieces.forEach((p, i) => {
    if (p.type !== 'loop') return
    const dd = Math.min(wrapAt(p.at - at, d.points.length), wrapAt(at - p.at, d.points.length))
    if (dd < bestD) {
      bestD = dd
      best = i
    }
  })
  return best
}

/** A validator message with its numbers taken out (so its key survives small changes). */
function shapeOf(message: string): string {
  return message.replace(/-?\d+(?:\.\d+)?/g, '#')
}

/** "road.points[3]" -> ['road.points', 3]. */
function pathIndex(path: string): [string, number] | null {
  const m = /^(road\.points|pieces|props|cores)\[(\d+)\]/.exec(path)
  return m ? [m[1], Number(m[2])] : null
}

/** Is there a bank set by hand (a `bank` on a road point) within `metres` of `at`? */
function bankSetNear(d: Draft, at: number, metres: number): boolean {
  const line = roadLine(d.points)
  const s0 = sOf(line, at)
  return d.points.some((p, k) => p.bank !== undefined && Math.abs(wrapS(sOfPoint(line, k) - s0 + line.length / 2, line.length) - line.length / 2) <= metres)
}

// ---------------------------------------------------------------- remedies: the game's checks

/** What to do about a failing or warning gate row. One branch per check in checks.ts GATE_WORDS. */
function gateRemedy(g: TrackGate, d: Draft, rc: RoadCurve, at: number | null): Remedy {
  const spot = at === null || !rc.curve.length ? null : frameAt(rc, at).p
  const point = (button: string): GoTo | undefined => (at === null ? undefined : { tool: 'select', selection: { kind: 'point', index: nearestPoint(d, at) }, spot, button })
  switch (g.name) {
    case 'line':
      return { kind: 'fix', does: 'Fix it smooths the road around the tightest corner, so the Ai racers can plan a way round it.', go: point('Show me the corner') }
    case 'smooth':
      return { kind: 'fix', does: 'Fix it smooths the road there (sideways, and up and down) until the kink is gone.', go: point('Show me the kink') }
    case 'banking':
      // The gate calls a bank leaning ahead of its bend a builder bug, but next to a bank Josh set by hand it is his setting: that can be eased.
      if (/builder bug/.test(g.fix ?? '') && !(at !== null && bankSetNear(d, at, 150))) return { kind: 'game', does: GAME_WORDS }
      return {
        kind: 'fix',
        does: 'Fix it eases the tilt in and out over a longer stretch of road.',
        go: at === null ? undefined : { tool: 'section', selection: stretchAround(rc, at, 60), spot, button: 'Show me, with the Stretch tool' },
      }
    case 'crest': {
      const ats = gateAts(g)
      const a0 = ats[0] ?? at
      const a1 = ats[1] ?? at
      return {
        kind: 'fix',
        does: 'Fix it gives the tilt there more room: it eases the bank in and out over a longer stretch, with less bank if that is what it takes.',
        go: a0 === null || a1 === null ? undefined : { tool: 'section', selection: { kind: 'section', from: advanceAt(rc, a0, -30), to: advanceAt(rc, a1, 30) }, spot, button: 'Show me, with the Stretch tool' },
      }
    }
    case 'bridges':
      return { kind: 'fix', does: 'Fix it lifts the upper road there onto a proper 8 m bridge with smooth ramps.', go: spot ? { tool: 'select', selection: null, spot, button: 'Show me the bridge' } : undefined }
    case 'ground':
      // When a bridge above is too low, the ground under it is dug away: fixing the bridge fixes this.
      if (/bridge above is too low/.test(g.fix ?? '')) return { kind: 'fix', does: 'This comes from the low bridge: Fix it lifts the upper road there onto a proper 8 m bridge.' }
      return { kind: 'game', does: GAME_WORDS }
    case 'loops': {
      const loop = loopNear(d, at)
      return {
        kind: 'fix',
        does: 'Fix it moves the loop to the nearest straight where nothing is in its way.',
        go: loop < 0 ? undefined : { tool: 'select', selection: { kind: 'piece', index: loop }, spot, button: 'Show me the loop' },
      }
    }
    case 'surface': {
      if (/twists too fast/.test(g.message)) {
        const loop = loopNear(d, at)
        return {
          kind: 'fix',
          does: "Fix it makes the loop bigger, as big as the game says it needs.",
          go: loop < 0 ? undefined : { tool: 'select', selection: { kind: 'piece', index: loop }, spot, button: 'Show me the loop' },
        }
      }
      return { kind: 'game', does: GAME_WORDS }
    }
    case 'start.at': {
      const pick: GoTo = { tool: 'place', place: 'start', selection: null, spot, button: 'Pick the Start line tool' }
      if (nearestStraightStart(d.points, d.startAt, d.pieces) === null) {
        return { kind: 'go', does: "There's no straight on this road long enough for the start grid (about 60 m). Make one with the Straight tool, then put the start line on it.", go: { tool: 'straight', selection: null, spot, button: 'Pick the Straight tool' } }
      }
      return { kind: 'fix', does: 'Fix it moves the start line to the nearest straight.', go: pick }
    }
    case 'environment.roadside.billboards':
      return { kind: 'none', does: 'Nothing to fix: the game puts up as many billboards as fit, and fewer is fine.' }
    case 'checks':
      return { kind: 'none', does: "There's nothing to fix by hand: try Undo. If it keeps happening, it's a bug in the game, not your track." }
    case 'winding':
    case 'tracking':
    case 'under':
      return { kind: 'game', does: GAME_WORDS }
    default:
      if (/builder bug/.test(g.fix ?? '')) return { kind: 'game', does: GAME_WORDS }
      return { kind: 'none', does: g.fix ? plainWords(g.fix) : 'Nothing to fix.' }
  }
}

// ---------------------------------------------------------------- remedies: the track validator

/** What to do about one of the track validator's messages. */
function issueRemedy(issue: TrackIssue, d: Draft, rc: RoadCurve, spot: P | null): { remedy: Remedy; roadAt: number | null } {
  const pi = pathIndex(issue.path)
  const m = issue.message
  const roadAtOf = (p: P | null) => (p && rc.curve.length ? nearestOnRoad(rc, p).at : null)
  const select = (button: string): GoTo | null => {
    if (!pi) return null
    const [kind, index] = pi
    const sel: Selection = kind === 'road.points' ? { kind: 'point', index } : kind === 'pieces' ? { kind: 'piece', index } : kind === 'props' ? { kind: 'prop', index } : { kind: 'core', index }
    return { tool: 'select', selection: sel, spot, button }
  }
  // Road points.
  if (/is within 2 m of point/.test(m)) return { remedy: { kind: 'fix', does: 'Fix it takes out this road point: it sits on top of the one before it.', go: select('Show me the point') ?? undefined }, roadAt: roadAtOf(spot) }
  if (/is outside the/.test(m)) return { remedy: { kind: 'fix', does: 'Fix it pulls it back inside the world.', go: select('Show me') ?? undefined }, roadAt: roadAtOf(spot) }
  if (/m from the world edge/.test(m)) {
    const go = select('Show me the point')
    return { remedy: go ? { kind: 'go', does: 'Drag this road point (and the road near it) further from the edge with Select and move, or bend that bit of road inward.', go } : { kind: 'none', does: plainWords(m) }, roadAt: roadAtOf(spot) }
  }
  const nearPoint = /near point (-?\d+(?:\.\d+)?)/.exec(m)
  if (issue.path === 'road.points' && nearPoint) {
    const at = Number(nearPoint[1])
    const p = frameAt(rc, at).p
    if (/crosses itself/.test(m)) {
      return { remedy: { kind: 'fix', does: 'Fix it lifts one of the two roads onto a proper 8 m bridge with smooth ramps.', go: { tool: 'select', selection: null, spot: p, button: 'Show me the crossing' } }, roadAt: at }
    }
    if (/radius/.test(m)) {
      return { remedy: { kind: 'fix', does: 'Fix it smooths the road around that corner until it is gentle enough.', go: { tool: 'select', selection: { kind: 'point', index: nearestPoint(d, at) }, spot: p, button: 'Show me the corner' } }, roadAt: at }
    }
  }
  // Pieces.
  if (pi?.[0] === 'pieces') {
    const piece = d.pieces[pi[1]]
    const go = select('Show me')
    const at = piece ? piece.at : null
    if (/on or next to the start grid/.test(m)) return { remedy: { kind: 'fix', does: 'Fix it moves it along the road, off the start grid.', go: go ?? undefined }, roadAt: at }
    if (piece?.type === 'loop') return { remedy: { kind: 'fix', does: 'Fix it moves the loop to the nearest straight, level stretch where it fits.', go: go ?? undefined }, roadAt: at }
    if (/sticks out past the road edge/.test(m)) return { remedy: { kind: 'fix', does: 'Fix it slides the ramp back onto the road.', go: go ?? undefined }, roadAt: at }
    if (/overlaps/.test(m)) return { remedy: { kind: 'fix', does: 'Fix it moves it along the road, clear of the other one.', go: go ?? undefined }, roadAt: at }
    if (go) return { remedy: { kind: 'go', does: piece?.type === 'wallride' ? 'Drag the wall ride round the outside of a long bend.' : 'Drag it somewhere that suits it better.', go }, roadAt: at }
  }
  if (pi && (pi[0] === 'props' || pi[0] === 'cores')) {
    const go = select('Show me')
    if (go) return { remedy: { kind: 'go', does: 'Drag it somewhere else with Select and move.', go }, roadAt: null }
  }
  if (issue.path === 'hunt.count') return { remedy: { kind: 'none', does: 'Nothing to fix by hand: put more energy cores on the map (Place pieces) if you want the hunt to use them all.' }, roadAt: null }
  return { remedy: { kind: 'none', does: 'There is no button for this one. Read what it says above and change the track to match.' }, roadAt: roadAtOf(spot) }
}

// ---------------------------------------------------------------- remedies: the pencil clean-up's notes

function noteRemedy(note: StrokeIssue, rc: RoadCurve): { remedy: Remedy; roadAt: number | null } {
  const spot = note.at ?? null
  const roadAt = spot && rc.curve.length ? nearestOnRoad(rc, spot).at : null
  switch (note.code) {
    case 'tight-corner':
      return { remedy: { kind: 'fix', does: 'Fix it smooths the road around that corner until a car can take it.', go: { tool: 'bend', selection: null, spot, button: 'Pick the Bend tool' } }, roadAt }
    case 'shallow-crossing':
      return { remedy: { kind: 'go', does: 'Redraw one of the two roads with the pencil so they cross more squarely (a stroke that starts and ends on the road redraws just that bit).', go: { tool: 'pencil', selection: null, spot, button: 'Pick the pencil' } }, roadAt }
    case 'bridge-flipped':
      return { remedy: { kind: 'go', does: 'Click the crossing to pick which road goes over (the Swap button).', go: { tool: 'select', selection: spot ? { kind: 'crossing', x: spot.x, z: spot.z } : null, spot, button: 'Show me the crossing' } }, roadAt }
    case 'bridge-conflict':
    case 'too-close':
      return { remedy: { kind: 'go', does: 'Pull the two bits of road further apart with the Bend tool.', go: { tool: 'bend', selection: null, spot, button: 'Pick the Bend tool' } }, roadAt }
    default:
      return { remedy: { kind: 'none', does: 'Just so you know: nothing to fix.' }, roadAt }
  }
}

/**
 * The validator talks about "road.points[3]" or "pieces[2]"; Josh doesn't need the path.
 * Its messages are "what; what to do", so the first part is the title and the rest the
 * detail (the same shape as the gate rows), in the same plain words.
 */
export function plainIssue(path: string, message: string): { title: string; detail?: string } {
  const cut = message.indexOf('; ')
  const title = plainWords(cut > 0 ? message.slice(0, cut) : message)
  const detail = cut > 0 ? plainWords(message.slice(cut + 2)) : undefined
  if (/^(road\.points|pieces|props|cores)/.test(path) || !path) return { title, detail }
  return { title: `${path}: ${title}`, detail }
}

// ---------------------------------------------------------------- the list

const listMemo = new WeakMap<Draft, { key: ProblemSource; list: Problem[] }>()

/**
 * Every row of the Checks list, worst first (the panel's order): validator
 * errors, failing checks, clean-up errors, then warnings, then notes.
 */
export function problemsOf(src: ProblemSource): Problem[] {
  const memo = listMemo.get(src.draft)
  if (memo && memo.key.gates === src.gates && memo.key.errors === src.errors && memo.key.warnings === src.warnings && memo.key.notes === src.notes) return memo.list
  const list = buildList(src)
  listMemo.set(src.draft, { key: { ...src }, list })
  return list
}

function buildList(src: ProblemSource): Problem[] {
  const d = src.draft
  const rc = roadCurve(d.points)
  const gateRows: Problem[] = []
  if (src.gates) {
    const items = gateItems(src.gates, d, rc)
    // gateItems lists failing rows first, then warnings, in gate order: walk the gates the same way.
    const ordered = [...src.gates.filter((g) => g.level === 'fail'), ...src.gates.filter((g) => g.level === 'warn')]
    const seen = new Map<string, number>()
    ordered.forEach((g, i) => {
      const item = items[i]
      if (!item) return
      const n = seen.get(g.name) ?? 0
      seen.set(g.name, n + 1)
      const at = gateAt(g, d)
      gateRows.push({ ...item, key: `gate:${g.name}:${n}`, source: 'gate', gate: g, roadAt: at, remedy: gateRemedy(g, d, rc, at) })
    })
  }
  const fromIssues = (list: readonly TrackIssue[], tone: 'bad' | 'warn'): Problem[] =>
    list.map((issue) => {
      const { title, detail } = plainIssue(issue.path, issue.message)
      const at = issueLocation(issue.path, d, rc)
      const r = issueRemedy(issue, d, rc, at)
      return {
        tone,
        title,
        detail,
        at: at ?? (r.roadAt !== null && rc.curve.length ? frameAt(rc, r.roadAt).p : null),
        key: `${tone === 'bad' ? 'err' : 'warn'}:${issue.path.replace(/\[\d+\]/, '[]')}:${shapeOf(issue.message)}:${issue.path}`,
        source: 'validator' as const,
        issue,
        roadAt: r.roadAt,
        remedy: r.remedy,
      }
    })
  const fromNotes = (level: StrokeIssue['level'], tone: CheckItem['tone']): Problem[] =>
    src.notes
      .map((note, i) => ({ note, i }))
      // A new bridge already has its BRIDGE label on the map: no row for it.
      .filter(({ note }) => note.level === level && note.code !== 'bridged')
      .map(({ note, i }) => {
        const r = noteRemedy(note, rc)
        return { tone, title: note.message, at: note.at ?? null, key: `note:${note.code}:${i}`, source: 'cleanup' as const, note, roadAt: r.roadAt, remedy: r.remedy }
      })
  return [
    ...fromIssues(src.errors, 'bad'),
    ...gateRows.filter((p) => p.tone === 'bad'),
    ...fromNotes('error', 'bad'),
    ...gateRows.filter((p) => p.tone === 'warn'),
    ...fromIssues(src.warnings, 'warn'),
    ...fromNotes('warning', 'warn'),
    ...fromNotes('note', 'note'),
  ]
}

/** The problem with this key in a list, if it is still there. */
export function problemByKey(list: readonly Problem[], key: string): Problem | null {
  return list.find((p) => p.key === key) ?? null
}
