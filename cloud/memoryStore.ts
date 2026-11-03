// ============================================================
//  ROOM MEMORY ON DISK - what the internet relay saves
// ------------------------------------------------------------
//  The cloud relay (room.ts) keeps its players' connections open
//  through hibernation, but anything in its memory is wiped when
//  Cloudflare puts it to sleep or moves it. The players' own details
//  ride on their sockets; the room's memory (the next player id, the
//  host's track, the round in progress) is saved here, in the room's
//  own small database, so a wake-up mid-game carries on where it was.
//
//  A drawn track can be bigger than one stored value may be (2 MB),
//  so the track is saved in pieces.
//
//  No Cloudflare imports: the tests run this with a pretend store.
// ============================================================

import type { LiveRound, RoomMemory } from '../server/relayCore'
import type { TrackMsg } from '../src/net/protocol'

/** The bits of Durable Object storage this file uses. */
export interface KvStore {
  get<T = unknown>(key: string): Promise<T | undefined>
  get<T = unknown>(keys: string[]): Promise<Map<string, T>>
  put(entries: Record<string, unknown>, options?: { allowUnconfirmed?: boolean }): Promise<void>
  delete(keys: string[], options?: { allowUnconfirmed?: boolean }): Promise<number>
}

/** Characters per stored piece of the track: well under 2 MB however the text is encoded. */
export const TRACK_PIECE_CHARS = 256 * 1024

/** Writes never hold up a pose: losing one save in a crash costs less than a stutter. */
const QUICK = { allowUnconfirmed: true }

/** What is saved under 'room' (the track is saved beside it, in pieces). */
interface Head {
  nextId: number
  hostId: number
  live: LiveRound | null
  trackPieces: number
}

/** The saved room, and how many track pieces are stored (the next save needs it). */
export async function loadMemory(store: KvStore): Promise<{ memory: RoomMemory | null; pieces: number }> {
  const head = await store.get<Head>('room')
  if (!head) return { memory: null, pieces: 0 }
  let hostTrack: TrackMsg | null = null
  if (head.trackPieces > 0) {
    const keys = Array.from({ length: head.trackPieces }, (_, i) => `track.${i}`)
    const parts = await store.get<string>(keys)
    try {
      hostTrack = JSON.parse(keys.map((k) => parts.get(k) ?? '').join('')) as TrackMsg
    } catch {
      // A piece is missing (a save cut short): the host sends its track again when it next changes.
      hostTrack = null
    }
  }
  return { memory: { nextId: head.nextId, hostId: head.hostId ?? 0, live: head.live, hostTrack }, pieces: head.trackPieces }
}

/**
 * Save the room. `withTrack` false leaves the stored track as it is (it is the
 * big part, and only changes when the host changes it). Returns the number of
 * track pieces now stored straight away, before the write lands, so a second
 * save started meanwhile never writes an out-of-date count.
 */
export function saveMemory(store: KvStore, memory: RoomMemory, withTrack: boolean, previousPieces: number): { pieces: number; done: Promise<void> } {
  let pieces = previousPieces
  const entries: Record<string, unknown> = {}
  if (withTrack) {
    const text = memory.hostTrack ? JSON.stringify(memory.hostTrack) : ''
    pieces = Math.ceil(text.length / TRACK_PIECE_CHARS)
    for (let i = 0; i < pieces; i++) entries[`track.${i}`] = text.slice(i * TRACK_PIECE_CHARS, (i + 1) * TRACK_PIECE_CHARS)
  }
  const head: Head = { nextId: memory.nextId, hostId: memory.hostId, live: memory.live, trackPieces: pieces }
  entries.room = head
  const stale = withTrack && previousPieces > pieces ? Array.from({ length: previousPieces - pieces }, (_, i) => `track.${pieces + i}`) : []
  // One put holds at most 128 entries; the biggest message (4 MB) is 16 pieces, so this never splits.
  const done = store.put(entries, QUICK).then(async () => {
    if (stale.length) await store.delete(stale, QUICK)
  })
  return { pieces, done }
}
