// ============================================================
//  MENU FLOW - what the big buttons actually do
// ------------------------------------------------------------
//  Small helpers shared by several screens: start a drive (with a
//  loading veil while a new track builds), restart, quit. They only
//  call the session contract (core/session.ts) and the play API;
//  the game systems react to the store changes those make.
// ============================================================

import { getGame } from '../core/store'
import type { GameMode } from '../core/store'
import { endSession, resumeGame, startSession } from '../core/session'
import { apiInstalled, audio, play } from '../core/api'
import { getTrack } from '../track/current'
import { getTrackFile } from '../track/registry'
import { showNotice, useUi } from './uiStore'

/**
 * Start driving `trackId` in `mode`. If that track isn't built yet, a
 * loading veil goes up first (building a track takes a moment), so the
 * menu never looks frozen.
 */
export function beginSession(mode: GameMode, trackId: string): void {
  const file = getTrackFile(trackId)
  const name = file?.name ?? trackId
  const go = () => {
    let ok = false
    try {
      ok = startSession({ mode, trackId })
    } catch (err) {
      console.error('[ui] startSession threw', err)
    }
    useUi.setState({ loading: null })
    if (!ok) {
      audio.ui('error')
      showNotice(`${name} would not load. Try another track.`, 'error')
    }
  }
  audio.ui('start')
  if (getTrack()?.id === trackId) {
    go()
    return
  }
  useUi.setState({ loading: name })
  // Two frames: the first paints the veil, the second builds behind it.
  requestAnimationFrame(() => requestAnimationFrame(go))
}

/** Restart the current session from the start (pause menu, results "Again"). */
export function restartSession(): void {
  const g = getGame()
  if (apiInstalled().play) play.restartSession()
  else startSession({ mode: g.mode, trackId: g.trackId })
  // The play system decides the new phase; if it left us in a menu, drive.
  const after = getGame().phase
  if (after === 'paused' || after === 'results') resumeGame()
}

export function quitToTitle(): void {
  endSession()
}
