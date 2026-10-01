// ============================================================
//  RECORDS - best laps, high scores and top speeds, persisted
// ------------------------------------------------------------
//  CONTRACT (orchestrator-owned).
//
//  Records are keyed by TRACK KEY = `${track.id}@${track.hash}`.
//  The hash comes from the track's geometry (track runtime), so
//  editing a drawn track starts its records fresh instead of
//  keeping a best lap from a different road.
//
//  Ghost traces are stored by the vehicle worker under
//  `sr2.ghost.<trackKey>` (same keying), not here.
// ============================================================

export interface TrackRecords {
  bestLapMs?: number
  huntBestMs?: number
  stuntBest?: number
  trapBestKmh?: number
  /** Best race finish time (ms) for the default lap count. */
  raceBestMs?: number
}

export type RecordKind = keyof TrackRecords

/** For each record kind, is a smaller number better? */
const LOWER_IS_BETTER: Record<RecordKind, boolean> = {
  bestLapMs: true,
  huntBestMs: true,
  raceBestMs: true,
  stuntBest: false,
  trapBestKmh: false,
}

const KEY = 'sr2.records.v1'

let cache: Record<string, TrackRecords> | null = null

function load(): Record<string, TrackRecords> {
  if (cache) return cache
  try {
    const raw = localStorage.getItem(KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    cache = parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    cache = {}
  }
  return cache!
}

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(load()))
  } catch {
    // storage unavailable - records last until reload
  }
}

export function trackKey(id: string, hash: string): string {
  return `${id}@${hash}`
}

export function getRecords(key: string): TrackRecords {
  return load()[key] ?? {}
}

export function getRecord(key: string, kind: RecordKind): number | null {
  const v = load()[key]?.[kind]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * Offer a new result. Saves it if it beats the stored record.
 * Returns { best, previous } so callers can emit the right event.
 */
export function offerRecord(key: string, kind: RecordKind, value: number): { best: boolean; previous: number | null } {
  const previous = getRecord(key, kind)
  if (!Number.isFinite(value)) return { best: false, previous }
  const better = previous === null || (LOWER_IS_BETTER[kind] ? value < previous : value > previous)
  if (better) {
    const all = load()
    all[key] = { ...(all[key] ?? {}), [kind]: value }
    save()
  }
  return { best: better, previous }
}

export function clearRecords(key: string): void {
  const all = load()
  delete all[key]
  save()
}
