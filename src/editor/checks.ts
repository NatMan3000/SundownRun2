// ============================================================
//  CHECKS - the editor's verdict, from the game's own track gates
// ------------------------------------------------------------
//  After every edit the live preview builds the draft into a real
//  track (src/track/current.ts). Straight after, checkBuiltTrack()
//  runs runTrackGates() from src/track/gates.ts on that built track:
//  the SAME checks `bun run tracks:check` prints, row for row. So
//  the editor can only say "All good" when the command line would
//  say OK too.
//
//  This file turns the gate rows into what the Checks panel and the
//  map show for each one that failed or warned:
//    title   one short line in plain words ("Cars will crash into
//            this loop.")
//    detail  the gate's own words, with road positions written as
//            "the 557 m mark" (metres after the start line)
//    fix     the gate's fix, plus how to do it with the editor's tools
//    at      where on the road it is: the map pins it, and clicking
//            the row in the panel goes there
//
//  Only a gate at level 'fail' fails a track (the same rule as the
//  command line). A 'warn' is worth a look; the track still works.
//  The track validator's own warnings are shown as their own rows
//  (Panel.tsx), never merged with these.
// ============================================================

import { runTrackGates, type TrackGate } from '../track/gates'
import type { TrackIssue } from '../track/schema'
import type { TrackRuntime } from '../track/types'
import type { Draft } from './draft'
import type { P } from './geom'
import { frameAt, type RoadCurve } from './road'

/** One row in the Checks panel (and maybe a pin on the map). */
export interface CheckItem {
  tone: 'bad' | 'warn' | 'note'
  /** What is wrong, in plain words. */
  title: string
  /** More detail (the gate's own message), if there is any. */
  detail?: string
  /** What to do about it. */
  fix?: string
  /** Where on the map it is, when it is about one place. */
  at: P | null
  /** A short tag for the map pin (failing gates only). */
  label?: string
}

/** What the Checks panel says at the top. */
export type Verdict = 'checking' | 'fail' | 'pass'

/** Plain words for each gate (by its name in gates.ts), and how to fix it with the editor's tools. */
const GATE_WORDS: Record<string, { title: string; label: string; how?: string }> = {
  line: {
    title: "The Ai racers can't plan a safe way round this road.",
    label: 'RACING LINE',
    how: 'Find the tightest corner and ease it: press Smooth the road, select a point in it and slide Corner to gentler, or drag its points further apart with Select and move.',
  },
  winding: { title: 'Part of the road is built inside out.', label: 'GAME BUG' },
  smooth: { title: 'The road has a kink here.', label: 'KINK', how: 'Press Smooth the road, reshape it with Bend, or drag the points here further apart with Select and move.' },
  banking: { title: 'The road tips over too suddenly here.', label: 'SUDDEN TILT', how: 'Press Smooth the road (more than once if it needs it), Bend this stretch with a longer reach (mouse wheel while you drag), or set the bank by hand with the Bank tool.' },
  bridges: { title: 'A bridge is too low for a car to fit underneath.', label: 'LOW BRIDGE', how: 'Select the upper road with the Height tool and raise it (or the lower road and dig it down), or click the crossing and swap which road goes over.' },
  cutting: { title: 'The side of a cutting is a cliff here.', label: 'GAME BUG' },
  dips: {
    title: 'A car takes off over the lip of this dip.',
    label: 'CAR TAKES OFF',
    how: 'Select the dipped stretch with the Height tool and make it longer, or less deep.',
  },
  loops: { title: 'Cars will crash into this loop.', label: 'LOOP BLOCKED', how: 'Drag it to another straight with Select and move, or select it and press Delete.' },
  tunnel: { title: "A tunnel can't be built here, or isn't built right.", label: 'TUNNEL', how: 'Select the tunnel and make it shorter, drag it to clear road with Select and move, or press Delete.' },
  tracking: { title: 'The game loses track of where cars are on this road.', label: 'GAME BUG' },
  ground: { title: 'The ground pokes up into the road.', label: 'GROUND IN THE WAY' },
  under: { title: 'The ground pokes up just under the road here, where a car could catch on it.', label: 'GAME BUG' },
  surface: { title: "The road's surface doesn't match its shape here.", label: 'GAME BUG' },
  crest: {
    title: 'A car goes light where the road tips here.',
    label: 'CAR GOES LIGHT',
    how: 'Spread the points out beside the banked corner with Select and move, or set less bank there with the Bank tool.',
  },
  ride: { title: 'The road is so bumpy here that a fast car takes off.', label: 'BUMPY ROAD', how: 'Slide Road surface (in the Track section) toward smooth.' },
  'start.at': { title: 'The start grid sits on a bend.', label: 'START ON A BEND', how: 'Pick Start line in Place pieces, then click a straight bit of road.' },
  'environment.roadside.billboards': { title: 'Fewer billboards fit beside this road than the world asks for.', label: 'BILLBOARDS' },
  checks: { title: "The game couldn't finish checking this track.", label: 'NOT CHECKED' },
}

/**
 * Run the game's gates on the built draft. Never throws: if the checks themselves
 * crash, that comes back as a failing row, so the editor can never say "All good"
 * about a track it did not manage to check.
 */
export function checkBuiltTrack(t: TrackRuntime | null): { gates: TrackGate[]; ms: number } {
  const t0 = performance.now()
  if (!t) return { gates: [notChecked('There is no built track to check.')], ms: 0 }
  try {
    return { gates: runTrackGates(t), ms: performance.now() - t0 }
  } catch (err) {
    console.error('[editor] the track checks threw on the draft', err)
    return { gates: [notChecked(`The checks stopped with an error: ${(err as Error).message}`)], ms: performance.now() - t0 }
  }
}

function notChecked(message: string): TrackGate {
  return { name: 'checks', ok: false, level: 'fail', message, fix: 'Try Undo. If it keeps happening, it is a bug in the game, not your track.' }
}

/**
 * The verdict. "pass" (All good) needs a fresh build of THIS draft with no validator
 * error, no failing gate and no clean-up error; warnings never stop it.
 */
export function checkVerdict(p: { fresh: boolean; errors: readonly TrackIssue[]; gates: readonly TrackGate[] | null; cleanupErrors: number }): Verdict {
  if (p.errors.length || p.cleanupErrors) return 'fail'
  if (!p.fresh || !p.gates) return 'checking'
  return p.gates.some((g) => g.level === 'fail') ? 'fail' : 'pass'
}

/** The rows of the gates that failed or warned, worst first, in plain words. */
export function gateItems(gates: readonly TrackGate[], d: Draft, rc: RoadCurve): CheckItem[] {
  const out: CheckItem[] = []
  for (const level of ['fail', 'warn'] as const) {
    for (const g of gates) {
      if (g.level !== level) continue
      const words = GATE_WORDS[g.name]
      const at = gateAt(g, d)
      const fix = [g.fix ? plainWords(g.fix) : '', words?.how ?? ''].filter(Boolean).join(' ')
      out.push({
        tone: level === 'fail' ? 'bad' : 'warn',
        title: words?.title ?? (level === 'fail' ? `The ${g.name} check failed.` : `The ${g.name} check has a warning.`),
        detail: plainWords(g.message),
        fix: fix || undefined,
        at: at === null || rc.curve.length === 0 ? null : frameAt(rc, at).p,
        label: level === 'fail' ? (words?.label ?? g.name.toUpperCase()) : undefined,
      })
    }
  }
  return out
}

/**
 * Where on the road a gate row is about, as an `at` (control point index + fraction).
 * gates.ts writes positions as "s=557 (at 20.6)" (its where() helper); the first one
 * in the message is the thing itself (the loop, the kink, the bridge).
 */
export function gateAt(g: TrackGate, d: Draft): number | null {
  if (g.name === 'start.at') return d.startAt
  const m = /\(at (-?\d+(?:\.\d+)?)\)/.exec(g.message)
  if (!m) return null
  const at = Number(m[1])
  return Number.isFinite(at) && d.points.length ? at : null
}

/**
 * The gates speak track-file ("s=557 (at 20.6)", "`lift`", "start.at"); Josh edits on a
 * map. Positions become "the 557 m mark" (metres after the start line) and file words
 * lose their code quotes.
 */
export function plainWords(text: string): string {
  const t = text
    .replace(/s=(-?\d+)(?: \(at -?\d+(?:\.\d+)?\))?/g, 'the $1 m mark')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\bstart\.at\b/g, 'the start line')
    .replace(/\bits at\b/g, 'it')
    .replace(/\bdeg\/m\b/g, 'degrees per metre')
    .replace(/\bdeg\b/g, 'degrees')
    .trim()
  const capped = t.charAt(0).toUpperCase() + t.slice(1)
  return /[.!?]$/.test(capped) ? capped : `${capped}.`
}
