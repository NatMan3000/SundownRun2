// ============================================================
//  SEEDED RANDOM - the same dice roll every time for a given seed
// ------------------------------------------------------------
//  Crash props, energy cores and the Ai roster are "random", but a
//  round has to look exactly the same on every machine that plays it
//  (multiplayer shares prop rounds) and every time a checker reloads
//  it. So nothing in play uses Math.random: everything rolls from a
//  seed built out of the track key and the round number.
// ============================================================

/** mulberry32: a tiny, fast, good-enough random generator. Returns numbers in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Turn a string (a track key) into a 32-bit number (FNV-1a). */
export function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * The seed for one thing (props, cores, roster) on one track in one round.
 * `salt` keeps the different things from rolling the same numbers.
 */
export function roundSeed(trackKey: string, round: number, salt: number): number {
  return (hashString(trackKey) ^ Math.imul(round + 1, 2654435761) ^ Math.imul(salt, 0x27d4eb2d)) >>> 0
}

/** Shuffle an array in place with a seeded generator (Fisher-Yates). */
export function shuffleInPlace<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const t = arr[i]
    arr[i] = arr[j]
    arr[j] = t
  }
  return arr
}
