// ============================================================
//  SOUND HINT - "Press any key or click for sound"
// ------------------------------------------------------------
//  Browsers keep all sound off until the player presses a key or
//  clicks. A gamepad press doesn't count (Chrome's rule), so a
//  player who only uses the controller would never hear anything
//  without this hint. It shows on the title screen, the pause menu
//  and as a small chip in the HUD, and disappears the moment the
//  sound is actually running.
//
//  It checks audio.isRunning() four times a second (cheap), never
//  per frame, and only re-renders when the answer changes.
//  Clicking the hint itself also starts the sound.
// ============================================================

import { useEffect, useState } from 'react'
import { audio } from '../core/api'

const POLL_MS = 250

/** True until the sound is running. */
export function useSoundLocked(): boolean {
  const [locked, setLocked] = useState(() => !audio.isRunning())
  useEffect(() => {
    if (!locked) return
    const t = setInterval(() => {
      if (audio.isRunning()) setLocked(false)
    }, POLL_MS)
    return () => clearInterval(t)
  }, [locked])
  return locked
}

/** A speaker with a slash through it, drawn with CSS boxes (no icon font, no image). */
function MutedSpeaker() {
  return (
    <span className="spk" aria-hidden="true">
      <i className="spk__body" />
      <i className="spk__cone" />
      <i className="spk__slash" />
    </span>
  )
}

export function SoundHint(props: { variant: 'menu' | 'chip' }) {
  const locked = useSoundLocked()
  if (!locked) return null
  return (
    <button
      type="button"
      tabIndex={-1}
      className={`sound-hint sound-hint--${props.variant}`}
      onClick={() => audio.unlock()}
      role="status"
    >
      <MutedSpeaker />
      <span className="sound-hint__text">Press any key or click for sound</span>
    </button>
  )
}
