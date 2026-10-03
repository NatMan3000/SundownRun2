// ============================================================
//  JUDGE - build a draft for real and ask the game's own checks
// ------------------------------------------------------------
//  Raising a stretch of road (raise.ts) and the Checks panel's Fix
//  buttons (fixes.ts) both change the road FOR Josh, so before a
//  change lands it is built with the real track builder and judged
//  by the same checks `bun run tracks:check` runs (src/track/gates.ts).
//  A change is only allowed if it doesn't make any check fail that
//  passed before. This file is that test, shared by both.
//
//  Pure: no editor state. selfTest.ts uses it directly.
// ============================================================

import type { TrackIssue } from '../track/schema'
import { validateTrack } from '../track/validate'
import { buildTrack } from '../track/build'
import { runTrackGates, type TrackGate } from '../track/gates'
import type { TrackRuntime } from '../track/types'
import type { Draft } from './draft'
import { fileOfDraft } from './draftFile'
import { gateItems } from './checks'
import { roadCurve } from './road'

/** A draft built and checked: the game's gate rows and the track validator's words. */
export interface Judged {
  /** The built track (null if it didn't validate or the builder threw). */
  runtime: TrackRuntime | null
  gates: TrackGate[]
  errors: TrackIssue[]
  warnings: TrackIssue[]
  /** Why it didn't build, in the game's words. */
  error?: string
}

/**
 * Build a draft with the real builder and run the game's checks on it (the
 * same rows as `bun run tracks:check`). `previous` (a track built in the same
 * world) lends its ground so the hills aren't worked out again.
 */
export function judgeDraft(d: Draft, id: string, params: Record<string, number> = {}, previous?: TrackRuntime | null): Judged {
  const v = validateTrack(fileOfDraft(d, id))
  if (!v.ok || !v.track) return { runtime: null, gates: [], errors: v.errors, warnings: v.warnings, error: v.errors[0]?.message ?? 'the track has a problem' }
  try {
    const runtime = buildTrack(v.track, params, previous ?? undefined)
    return { runtime, gates: runTrackGates(runtime), errors: [], warnings: v.warnings }
  } catch (err) {
    return { runtime: null, gates: [], errors: [], warnings: v.warnings, error: (err as Error).message }
  }
}

/** The names of the checks that fail. */
export function failingNames(gates: readonly TrackGate[]): Set<string> {
  return new Set(gates.filter((g) => g.level === 'fail').map((g) => g.name))
}

/** Checks that fail after a change but passed before it. */
export function newFailures(before: readonly TrackGate[], after: readonly TrackGate[]): TrackGate[] {
  const was = failingNames(before)
  return after.filter((g) => g.level === 'fail' && !was.has(g.name))
}

/**
 * A check whose failure is the game's own fault, never the track's: its fix
 * line says "builder bug" (gates.ts), or the checks themselves couldn't run.
 */
export function isGameBug(g: TrackGate): boolean {
  return g.name === 'checks' || /builder bug/.test(g.fix ?? '')
}

/** A failing check's title in Josh's words ("The road has a kink here."). */
export function gateTitle(g: TrackGate, d: Draft): string {
  return gateItems([g], d, roadCurve(d.points)).find((it) => it.tone === 'bad' || it.tone === 'warn')?.title ?? `The ${g.name} check fails.`
}
