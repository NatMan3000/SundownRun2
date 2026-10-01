// ============================================================
//  BOOT - runs once before React mounts
// ------------------------------------------------------------
//  Picks the first track (URL ?track= > last played > Afterglow),
//  builds it, and decides where we start: the title screen, or
//  straight into a drive when the URL asks (?track=, ?demo=1).
// ============================================================

import './core/devHandles'
import { useGame } from './core/store'
import type { GameMode } from './core/store'
import { urlParam } from './core/devHandles'
import { lastPlayedTrackId, startSession } from './core/session'
import { loadTrackById } from './track/current'
import { getTrackFile } from './track/registry'

const MODES: GameMode[] = ['free', 'timetrial', 'race', 'stunt', 'tag']

export function boot(): void {
  const urlTrack = urlParam('track')
  const demo = urlParam('demo') === '1'
  const mp = urlParam('mp') === '1'
  const modeParam = urlParam('mode') as GameMode | null
  const mode: GameMode = modeParam && MODES.includes(modeParam) ? modeParam : 'free'

  const candidates = [urlTrack, lastPlayedTrackId(), 'afterglow'].filter((id): id is string => !!id && !!getTrackFile(id))
  const first = candidates[0] ?? 'afterglow'
  useGame.setState({ trackId: first, multiplayer: mp })

  try {
    const r = loadTrackById(first)
    if (!r.ok) {
      console.error('[boot] track failed to load', first, r.errors)
      return
    }
  } catch (err) {
    console.error('[boot] track build threw', err)
    return
  }

  if (urlTrack || demo) startSession({ mode, trackId: first })
}
