// ============================================================
//  SESSION FLOW - starting, pausing and leaving a drive
// ------------------------------------------------------------
//  CONTRACT (orchestrator-owned). Menus call these; gameplay
//  systems react to the store fields they set (phase, mode, round,
//  trackVersion) rather than being called directly.
//
//  Single player pauses the world (physics stops). In multiplayer
//  the world can't stop, so "pause" only opens the menu over a live
//  game and the car's input is released.
// ============================================================

import { useGame, sessionResetFields } from './store'
import type { GameMode } from './store'
import { setInputContext } from './controls'
import { emit } from './events'
import { getTrack, loadTrackById } from '../track/current'

const LAST_TRACK_KEY = 'sr2.lastTrack'

export function lastPlayedTrackId(): string | null {
  try {
    return localStorage.getItem(LAST_TRACK_KEY)
  } catch {
    return null
  }
}

/** Start driving. Loads the track first if it isn't the current one. Returns false if the track failed to load. */
export function startSession(opts: { mode: GameMode; trackId?: string }): boolean {
  const g = useGame.getState()
  const wantId = opts.trackId ?? g.trackId
  if (!getTrack() || getTrack()!.id !== wantId) {
    const r = loadTrackById(wantId)
    if (!r.ok) return false
  }
  const track = getTrack()!
  try {
    localStorage.setItem(LAST_TRACK_KEY, track.id)
  } catch {
    // fine
  }
  useGame.setState((s) => ({
    ...sessionResetFields(),
    mode: opts.mode,
    phase: 'playing',
    round: s.round + 1,
    sessionStartedAt: performance.now(),
  }))
  setInputContext('drive')
  emit('session.start', { trackId: track.id, trackName: track.name, mode: opts.mode, multiplayer: useGame.getState().multiplayer })
  return true
}

export function pauseGame(): void {
  const g = useGame.getState()
  if (g.phase !== 'playing') return
  useGame.setState({ phase: 'paused' })
  setInputContext('menu')
}

export function resumeGame(): void {
  const g = useGame.getState()
  if (g.phase !== 'paused' && g.phase !== 'results') return
  useGame.setState({ phase: 'playing', mapOpen: false })
  setInputContext('drive')
}

/** Show a results screen over the world (race finish, stunt end, hunt complete). */
export function showResults(): void {
  useGame.setState({ phase: 'results' })
  setInputContext('menu')
}

/** Back to the title screen. */
export function endSession(): void {
  const g = useGame.getState()
  if (g.phase === 'playing' || g.phase === 'paused' || g.phase === 'results') {
    emit('session.end', { trackId: g.trackId, mode: g.mode })
  }
  useGame.setState({ ...sessionResetFields(), phase: 'title', mapOpen: false })
  setInputContext('menu')
}

/** Open the road editor. The editor loads its own draft track. */
export function openEditor(): void {
  const g = useGame.getState()
  if (g.phase === 'playing' || g.phase === 'paused') emit('session.end', { trackId: g.trackId, mode: g.mode })
  useGame.setState({ phase: 'editor' })
  setInputContext('editor')
}

/** Open the top-down world map over the paused game (from the pause menu). */
export function openMap(): void {
  const g = useGame.getState()
  if (g.phase !== 'paused') return
  useGame.setState({ mapOpen: true })
  setInputContext('editor')
}

/** Close the world map and return to the pause menu. */
export function closeMap(): void {
  if (!useGame.getState().mapOpen) return
  useGame.setState({ mapOpen: false })
  setInputContext('menu')
}

/** True while the world should simulate (physics running). */
export function worldRunning(): boolean {
  const g = useGame.getState()
  if (g.multiplayer) return g.phase !== 'editor' && g.phase !== 'loading'
  return g.phase === 'playing' || g.phase === 'title' || g.phase === 'results'
}
