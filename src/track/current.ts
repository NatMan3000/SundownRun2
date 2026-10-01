// ============================================================
//  CURRENT TRACK - the one TrackRuntime the game is using
// ------------------------------------------------------------
//  CONTRACT (orchestrator-owned API).
//
//    setTrackFromFile(file)  validate + build + make current
//    loadTrackById(id)       same, from the registry
//    getTrack()              the runtime, or null before the first load
//    useTrack()              React: re-renders when the track changes
//    setTrackParam(p, v)     live parameter (e.g. bankDeg): rebuilds the
//                            road in place WITHOUT moving the car; bumps
//                            trackParamVersion, not trackVersion. v = null
//                            goes back to the file's default and forgets
//                            the saved value
//
//  trackVersion bumps on a new track: the physics world remounts and
//  everything rebuilds. trackParamVersion bumps on a live param change:
//  road meshes and colliders rebuild, nothing else.
// ============================================================

import { useGame } from '../core/store'
import { getSettings, useSettings } from '../core/settings'
import { emit } from '../core/events'
import type { TrackFile, ValidationResult } from './schema'
import type { TrackParamInfo, TrackRuntime } from './types'
import { validateTrack } from './validate'
import { buildTrack } from './build'
import { getTrackFile } from './registry'

let current: TrackRuntime | null = null
let currentFile: TrackFile | null = null

export function getTrack(): TrackRuntime | null {
  return current
}

export function getCurrentTrackFile(): TrackFile | null {
  return currentFile
}

/** React hook: the current track; re-renders on track change and on live param rebuilds. */
export function useTrack(): TrackRuntime | null {
  useGame((s) => s.trackVersion)
  useGame((s) => s.trackParamVersion)
  return current
}

/** The live parameters a track file exposes (e.g. the Hyperdrome bank slider). */
export function trackParamsFor(file: TrackFile): TrackParamInfo[] {
  const out: TrackParamInfo[] = []
  const adj = file.road.banking?.adjustable
  if (adj) {
    const saved = getSettings().trackParams[file.id]?.bankDeg
    const def = file.road.banking?.maxDeg ?? 10
    const value = typeof saved === 'number' ? Math.min(adj.max, Math.max(adj.min, saved)) : def
    out.push({ id: 'bankDeg', label: adj.label, min: adj.min, max: adj.max, value, default: def })
  }
  return out
}

function paramsRecord(file: TrackFile): Record<string, number> {
  const rec: Record<string, number> = {}
  for (const p of trackParamsFor(file)) rec[p.id] = p.value
  return rec
}

/**
 * Validate, build and switch to a track. Returns the validation result;
 * on errors the current track is left untouched.
 */
export function setTrackFromFile(file: TrackFile): ValidationResult {
  const result = validateTrack(file)
  if (!result.ok || !result.track) {
    console.error('[track] invalid track file', file?.id, result.errors)
    return result
  }
  if (result.warnings.length) console.warn('[track] warnings for', file.id, result.warnings)
  const runtime = buildTrack(result.track, paramsRecord(file))
  current = runtime
  currentFile = file
  useGame.setState((s) => ({ trackId: runtime.id, trackName: runtime.name, trackVersion: s.trackVersion + 1 }))
  return result
}

export function loadTrackById(id: string): ValidationResult {
  const file = getTrackFile(id)
  if (!file) return { ok: false, errors: [{ path: '', message: `No track called "${id}"` }], warnings: [] }
  return setTrackFromFile(file)
}

/** Change a live track parameter (persisted per track; null = back to the file's default, not saved) and rebuild the road in place. */
export function setTrackParam(param: string, value: number | null): void {
  if (!current || !currentFile) return
  useSettings.getState().setTrackParam(currentFile.id, param, value)
  const result = validateTrack(currentFile)
  if (!result.ok || !result.track) return
  current = buildTrack(result.track, paramsRecord(currentFile), current)
  useGame.setState((s) => ({ trackParamVersion: s.trackParamVersion + 1 }))
  emit('track.param', { trackId: currentFile.id, param, value: current.params[param] ?? 0 })
}
