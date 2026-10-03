// ============================================================
//  BANK ANGLE - how much the game is tilting a stretch of road
// ------------------------------------------------------------
//  The Bank tool's slider can say "Auto": Josh hasn't set a bank
//  there, so the game banks the road itself from how tight the
//  corner is (src/track/road.ts). This reads the angle it really
//  gave that stretch, from the BUILT road (the live preview), so
//  the panel can say "Auto (8°)" instead of just "Auto".
//
//  It reports the most tilt anywhere in the stretch. A bank rolls in
//  and out smoothly, so every stretch starts and ends nearly flat:
//  a range like "0-8°" would say the same thing every time, while
//  the most tells him how steep the corner itself is.
//
//  Pure: a built track in, numbers out.
// ============================================================

import { trackInternals } from '../track/build'
import { SURFACE_CODE, type TrackRuntime } from '../track/types'

export interface BankAngle {
  /** The most tilt anywhere in the stretch, whole degrees (always 0 or more). */
  most: number
  /** The same tilt in the Bank slider's terms: degrees INTO the corner there (negative = off-camber). */
  into: number
}

/** Is `at` inside the stretch from `from` forward to `to` (it may run past the last point back to the first)? */
function inStretch(at: number, from: number, to: number): boolean {
  return from <= to ? at >= from && at <= to : at >= from || at <= to
}

/**
 * The bank the built road `rt` has on the stretch from `from` to `to` (both
 * `at` values on the draft the road was built from). Loops are left out (they
 * turn with their own frame, not a bank). Null if the build has no record of
 * where its samples are on the draft, or the stretch has no road samples.
 */
export function builtBankAngle(rt: TrackRuntime, from: number, to: number): BankAngle | null {
  const x = trackInternals(rt)
  if (!x) return null
  const S = rt.samples
  let best = -1
  let bestAbs = -1
  for (let i = 0; i < S.count; i++) {
    if (S.surface[i] === SURFACE_CODE.loop) continue
    if (!inStretch(x.atOfS(i * S.ds), from, to)) continue
    const a = Math.abs(S.bank[i])
    if (a > bestAbs) {
      bestAbs = a
      best = i
    }
  }
  if (best < 0) return null
  const deg = (S.bank[best] * 180) / Math.PI
  // The samples' bank is + with the left edge up; "into the corner" is left edge up on a right-hander
  // (curvature +) and on a straight, right edge up on a left-hander (see the file format's `bank`).
  const into = S.curvature[best] < 0 ? -deg : deg
  return { most: Math.round(Math.abs(deg)), into: Math.round(into) }
}
