// ============================================================
//  NOW PLAYING - the song's name, for a few seconds, top-left
// ------------------------------------------------------------
//  Every song the music plays has a name made from its seed
//  (src/audio/music/songs.ts), like "Midnight Overdrive" in
//  A minor. When a new song starts (a new drive, Next song with N
//  or B on the pad, or the pause menu), its name slides in at the
//  bottom of the top-left stack for a few seconds, then fades. It
//  is the last thing in that stack, so nothing else moves.
//
//  It asks audio.song() four times a second (cheap), never per
//  frame, and only re-renders when the song changes.
// ============================================================

import { useEffect, useState } from 'react'
import { audio } from '../../core/api'
import type { SongInfo } from '../../core/api'

const POLL_MS = 250
/** How long the name stays up (the fade-out in ui.css starts 400 ms before this). */
const SHOW_MS = 4500

/** The last song shown, kept across pauses so resuming doesn't show the same name again. */
let shownId = -1

/** A small eighth note, drawn (no icon font). */
function NoteIcon() {
  return (
    <svg className="hud-song__note" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6 2.2v8.1a2.6 2.6 0 1 0 1.6 2.4V5.6l5.2-1.4V2z" />
    </svg>
  )
}

export function NowPlaying() {
  const [song, setSong] = useState<SongInfo | null>(null)
  useEffect(() => {
    let hideTimer: ReturnType<typeof setTimeout> | null = null
    let current: SongInfo | null = null
    const check = () => {
      const s = audio.song()
      if (!s) return
      if (s.id !== shownId) {
        shownId = s.id
        current = s
        setSong(s)
        if (hideTimer !== null) clearTimeout(hideTimer)
        hideTimer = setTimeout(() => {
          hideTimer = null
          current = null
          setSong(null)
        }, SHOW_MS)
      } else if (current && current.id === s.id && current.favourite !== s.favourite) {
        current = s
        setSong(s)
      }
    }
    check()
    const poll = setInterval(check, POLL_MS)
    return () => {
      clearInterval(poll)
      if (hideTimer !== null) clearTimeout(hideTimer)
    }
  }, [])
  if (!song) return null
  return (
    <div className="hud-panel hud-song" key={song.id} role="status" aria-live="polite">
      <span className="hud-song__eyebrow">
        <NoteIcon />
        Now playing
      </span>
      <span className="hud-song__name">{song.name}</span>
      <span className="hud-song__key">
        {song.key}
        {song.favourite ? ' · saved' : ''}
      </span>
    </div>
  )
}
