// ============================================================
//  TUNNEL PLACE - may this tunnel go here? Ask the real builder.
// ------------------------------------------------------------
//  Josh places a Tunnel (Place pieces) on a stretch of road, or
//  changes its Length. Whether it fits isn't something the editor
//  can guess: the game digs the road down for it on ramps about
//  190 m long, and that whole stretch must be clear road (no loop,
//  kicker, wall ride, start grid or other road). So the draft is
//  built with the tunnel by the real track builder (judge.ts), and
//  the change only lands if:
//
//    - the builder could build it (src/track/tunnels.ts says why
//      not, in plain words, if it couldn't), and
//    - no check that passed before fails now (the dip's lips, ...)
//
//  Otherwise it is refused, in plain words, and nothing changes.
//  Pure: no editor state. draft.ts calls it; selfTestTunnel.ts too.
// ============================================================

import type { TrackRuntime } from '../track/types'
import { trackInternals } from '../track/build'
import type { Draft } from './draft'
import { gateTitle, judgeDraft, newFailures, type Judged } from './judge'

export type TunnelVerdict =
  | { ok: true; judged: Judged; depth: number; ramp: number; length: number }
  | { ok: false; message: string }

/**
 * Judge `next` (the draft with the tunnel at piece `index` added or changed) against `before`.
 * `id` and `params` are the draft's; `previous` a track built in the same world (its ground is
 * reused). `before` may be passed already judged (the live preview's checks).
 */
export function judgeTunnel(before: Draft | Judged, next: Draft, index: number, id: string, params: Record<string, number>, previous?: TrackRuntime | null): TunnelVerdict {
  const after = judgeDraft(next, id, params, previous)
  if (!after.runtime) return { ok: false, message: `Can't put a tunnel here: ${after.error ?? 'the track has a problem'}.` }
  const x = trackInternals(after.runtime)
  const plan = x?.tunnels.plans.find((p) => p.index === index)
  if (!plan) return { ok: false, message: "Can't put a tunnel here: the game couldn't plan it (a bug in the game, not your track)." }
  if (plan.problem) return { ok: false, message: `Can't put a tunnel here: ${plan.problem}.` }
  const was = 'gates' in before ? before : judgeDraft(before, id, params, previous ?? after.runtime)
  const broke = newFailures(was.gates, after.gates)
  if (broke.length) return { ok: false, message: `Can't put a tunnel here: with it, ${lowerFirst(gateTitle(broke[0], next))} Try it somewhere else, or make it shorter.` }
  return { ok: true, judged: after, depth: plan.depth, ramp: plan.ramp, length: plan.sb1 - plan.sb0 }
}

/** "The road has a kink." -> "the road has a kink." (for the middle of a sentence). */
function lowerFirst(text: string): string {
  return text.length ? text[0].toLowerCase() + text.slice(1) : text
}

/** What a placed tunnel does, in Josh's words. */
export function tunnelWords(v: { depth: number; ramp: number; length: number }): string {
  return `the road dips ${v.depth.toFixed(1)} m into the ground on ${Math.round(v.ramp)} m ramps either side, and the hill goes back over ${Math.round(v.length)} m of it`
}
