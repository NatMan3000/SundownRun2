// ============================================================
//  SMOOTH FIELD - the Height tool's "Smooth the bumps here" button
// ------------------------------------------------------------
//  Under the Height slider (Panel.tsx HeightField). One press lays
//  the picked stretch's road on a smooth line through the ground
//  under it (smooth.ts, wired up in stretchTools.ts smoothStretch):
//  it keeps the big rises and falls and irons out the small bumps.
//  It is built and checked before it lands, like every Height
//  change, and it is one Undo step.
//
//  Under the button, one line: what it will do, or, once pressed,
//  what it did ("Smoothed 420 m: the biggest bump was 1.8 m.") or
//  why it changed nothing ("already smooth").
// ============================================================

import { useState } from 'react'
import type { Draft } from './draft'
import { type SmoothSaid, smoothStretch } from './stretchTools'

/** The same stretch (its `at` values to a hair). */
const same = (a: number, b: number) => Math.abs(a - b) < 1e-6

/**
 * What the last press said. Kept outside the component: the panel redraws the
 * Height field while the changed road is rebuilt, and the words must survive that.
 */
let lastSaid: SmoothSaid | null = null

export function SmoothField(p: { from: number; to: number; draft: Draft }) {
  const [busy, setBusy] = useState(false)
  const [, redraw] = useState(0)
  // What it said is only shown while it is still about this road and this stretch (an edit or Undo clears it).
  const said = lastSaid
  const showing = said && said.draft === p.draft && same(said.from, p.from) && same(said.to, p.to) ? said : null
  const press = () => {
    setBusy(true)
    // A moment for the button to say it's busy: building and checking the road takes a few tenths of a second.
    setTimeout(() => {
      try {
        lastSaid = smoothStretch(p.from, p.to)
      } finally {
        setBusy(false)
        redraw((n) => n + 1)
      }
    }, 30)
  }
  return (
    <>
      <button type="button" className="sre-btn" onClick={press} disabled={busy} data-testid="editor-smooth-bumps">
        Smooth the bumps here
      </button>
      <p className={`sre-help${showing ? ` is-${showing.tone}` : ''}`} data-testid="editor-smooth-said" role="status">
        {busy
          ? 'Smoothing it, then building it and running the checks...'
          : showing
            ? showing.text
            : 'Irons the small bumps out of this stretch, so it still goes up and down with the hills but drives smoothly.'}
      </p>
    </>
  )
}
