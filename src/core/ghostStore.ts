// ============================================================
//  GHOST STORAGE - which saved ghost laps this browser keeps
// ------------------------------------------------------------
//  A best lap is stored under `sr2.ghost.<trackKey>` (src/vehicle/ghost.ts), and a
//  track key is `<track id>@<hash of the road>` (src/track/build.ts), so every road
//  edit makes a new key. One ghost per track id is kept: saving a new one drops the
//  old ones of that track. When storage is full, ghosts are what gives way first
//  (a drawing or a saved track matters more than a replay).
// ============================================================

export const GHOST_PREFIX = 'sr2.ghost.'

function ghostKeys(): string[] {
  const out: string[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith(GHOST_PREFIX)) out.push(k)
    }
  } catch {
    // storage unavailable: nothing to drop
  }
  return out
}

/** The track id inside a track key (`id@hash`; the hash is hex, so the last @ splits it). */
function idOfKey(trackKey: string): string {
  const at = trackKey.lastIndexOf('@')
  return at < 0 ? trackKey : trackKey.slice(0, at)
}

function drop(keys: string[]): number {
  for (const k of keys) {
    try {
      localStorage.removeItem(k)
    } catch (err) {
      console.warn('[ghost] could not drop an old ghost lap', err)
    }
  }
  return keys.length
}

/** Drop every stored ghost of this track id except the one for `trackKey`. */
export function dropOtherGhostsOfTrack(trackKey: string): number {
  const keep = GHOST_PREFIX + trackKey
  const id = idOfKey(trackKey)
  return drop(ghostKeys().filter((k) => k !== keep && idOfKey(k.slice(GHOST_PREFIX.length)) === id))
}

/** Drop every stored ghost (storage is full and something more important needs room). */
export function dropAllGhosts(): number {
  return drop(ghostKeys())
}
