// ============================================================
//  REWIND HUD - what time running backwards looks like
// ------------------------------------------------------------
//  Hold Backspace (or LB) and the world runs backwards (the
//  recorder is src/vehicle/rewind.ts). Three pieces of HUD:
//
//    RewindMeter    under the speedometer: how much rewind is
//                   stored, a cyan bar that fills as you drive
//                   (up to the rewindSeconds knob), and the button
//    RewindScreen   while it is held: the whole view goes cool and
//                   washed out, with rolling scan lines like an old
//                   tape, and a REWIND tag counting the seconds you
//                   can still go back. Cyan, because cyan is "you"
//                   (CONSTITUTION section 1 colour semantics)
//    RewindRefused  "Rewind is off in multiplayer", while it's held
//                   in a multiplayer game
//
//  None of these re-render per frame: the HUD's one animation loop
//  (Hud.tsx, writeRewind below) flips their classes and writes the
//  numbers into their data-hud slots.
// ============================================================

import { audio } from '../../core/api'
import { rewind } from '../../core/telemetry'
import { useGame } from '../../core/store'
import { ActionGlyphs } from '../hints'

/** The double triangle of a tape deck's rewind button. */
function RewindIcon(props: { className: string }) {
  return (
    <svg className={props.className} viewBox="0 0 24 14" aria-hidden="true">
      <path d="M11 1 L1 7 L11 13 Z M23 1 L13 7 L23 13 Z" />
    </svg>
  )
}

export function RewindMeter() {
  const mp = useGame((s) => s.multiplayer)
  if (mp) return null
  return (
    <div className="hud-rewind" data-hud="rewindMeter" aria-label="Rewind stored">
      <ActionGlyphs action="rewind" />
      <RewindIcon className="hud-rewind__icon" />
      <span className="hud-rewind__bar">
        <i data-hud="rewindFill" />
      </span>
      <span className="hud-rewind__secs" data-hud="rewindSecs">
        0.0 s
      </span>
    </div>
  )
}

export function RewindScreen() {
  return (
    <div className="hud-rewindfx" data-hud="rewindFx" aria-hidden="true">
      <div className="hud-rewindfx__wash" />
      <div className="hud-rewindfx__tint" />
      <div className="hud-rewindfx__lines" />
      <div className="hud-rewindfx__band" />
      <div className="hud-rewindtag">
        <RewindIcon className="hud-rewindtag__icon" />
        <span className="hud-rewindtag__word">Rewind</span>
        <span className="hud-rewindtag__left" data-hud="rewindLeft">
          0.0 s
        </span>
      </div>
    </div>
  )
}

export function RewindRefused() {
  return (
    <div className="hud-rewindno" data-hud="rewindNo" role="status">
      <RewindIcon className="hud-rewindno__icon" />
      Rewind is off in multiplayer
    </div>
  )
}

// ---------------------------------------------------------------- the loop's part

/** "0.0 s" ... "30.0 s", made once so the loop never builds a string. */
const SECS: string[] = []
for (let i = 0; i <= 300; i++) SECS.push(`${(i / 10).toFixed(1)} s`)
/** Bar fill 0..1 in 1 % steps, as CSS numbers. */
const FILL: string[] = []
for (let i = 0; i <= 100; i++) FILL.push((i / 100).toFixed(2))

function secs(v: number): string {
  const i = Math.round((Number.isFinite(v) ? v : 0) * 10)
  return SECS[i < 0 ? 0 : i > 300 ? 300 : i]
}

export interface RewindRefs {
  rewindFx: HTMLElement | null
  rewindLeft: HTMLElement | null
  rewindFill: HTMLElement | null
  rewindSecs: HTMLElement | null
  rewindNo: HTMLElement | null
}

/** What the loop last wrote, so it only touches the DOM when something changed. */
const shown = { on: false, refused: false, fill: -1, secs: '', left: '' }

/** Called by the HUD loop every frame while driving. */
export function writeRewind(refs: RewindRefs, text: boolean): void {
  if (rewind.active !== shown.on) {
    shown.on = rewind.active
    refs.rewindFx?.classList.toggle('is-on', shown.on)
  }
  const refused = rewind.refused === 'multiplayer'
  if (refused !== shown.refused) {
    shown.refused = refused
    refs.rewindNo?.classList.toggle('is-on', refused)
    if (refused) audio.ui('error')
  }
  const cap = rewind.capacity > 0 ? rewind.capacity : 1
  const f = Math.round(Math.min(1, Math.max(0, rewind.stored / cap)) * 100)
  if (refs.rewindFill && f !== shown.fill) {
    shown.fill = f
    refs.rewindFill.style.setProperty('--fill', FILL[f])
  }
  if (!text) return
  const s = secs(rewind.stored)
  if (refs.rewindSecs && s !== shown.secs) {
    shown.secs = s
    refs.rewindSecs.textContent = s
  }
  if (shown.on && refs.rewindLeft && s !== shown.left) {
    shown.left = s
    refs.rewindLeft.textContent = s
  }
}

/** The HUD re-mounted: write everything again on the next frame. */
export function resetRewindShown(): void {
  shown.on = false
  shown.refused = false
  shown.fill = -1
  shown.secs = ''
  shown.left = ''
}
