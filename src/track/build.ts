// Track worker replaces this file: buildTrack(resolved, params, previous?) -> TrackRuntime (src/track/types.ts).
import type { ResolvedTrackFile } from './schema'
import type { TrackRuntime } from './types'

export function buildTrack(file: ResolvedTrackFile, params: Record<string, number>, previous?: TrackRuntime | null): TrackRuntime {
  void file
  void params
  void previous
  throw new Error('track builder not built yet')
}
