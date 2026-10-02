// ============================================================
//  GAME-EVENT FEED - the one place gameplay moments are announced
// ------------------------------------------------------------
//  CONTRACT (orchestrator-owned).
//
//  Anything a player would talk about - a trick, a lap, a crash, a
//  pickup, a race result - is emitted here, once, by the system that
//  knows it happened. Audio, the HUD trick feed, toasts and (later)
//  an Ai radio commentator all subscribe here instead of reaching
//  into gameplay code.
//
//  Rules:
//   - Emit facts, not presentation ("lap.complete", not "show toast").
//   - Events are rare (a few per second at most); allocation is fine.
//     Never emit per frame.
//   - Payloads are plain JSON (no three.js objects), so they can be
//     logged, replayed, or sent over the network as-is.
//   - Add a new event type by adding it to GameEventMap with a doc
//     comment. Never change an existing payload's meaning.
//
//  Inspect live: window.__events.recent (last 200) in dev builds.
// ============================================================

export type TrickName = 'air' | 'bigAir' | 'hugeAir' | 'spin' | 'flip' | 'roll' | 'drift' | 'wallRide' | 'loop' | 'nearMiss'

export interface GameEventMap {
  /** A driving session began (after the countdown in race modes). */
  'session.start': { trackId: string; trackName: string; mode: string; multiplayer: boolean }
  /** The player left the session (menu, track change). */
  'session.end': { trackId: string; mode: string }

  /** The player crossed a sector checkpoint in order. */
  'lap.sector': { sector: number; sectors: number; splitMs: number }
  /** The player completed a lap. dirty = too long off-road, can't set a record. */
  'lap.complete': { lap: number; ms: number; dirty: boolean; best: boolean; previousBestMs: number | null }
  /** A line crossing was rejected (skipped sectors) or the lap was voided by a reset. */
  'lap.void': { reason: 'skipped-sector' | 'reset' | 'restart' }
  /** The lap in progress just went dirty (off-road grace spent). */
  'lap.dirty': Record<string, never>

  /** The car left the ground (all four wheels). */
  'air.start': { speedKmh: number }
  /** The car landed. Tricks are scored here, never mid-air. */
  'trick.land': {
    tricks: { name: TrickName; label: string; points: number }[]
    airTimeS: number
    /** Combo multiplier applied to this landing. */
    combo: number
    /** Points banked by this landing (after combo). */
    points: number
    /** True if all four wheels touched down cleanly (no two-wheel save). */
    clean: boolean
  }
  /** Landed on the roof or crashed mid-combo: the pending combo is lost. */
  'trick.wipeout': { lostPoints: number }
  /** A drift ended and scored. */
  'drift.end': { seconds: number; points: number; maxAngleDeg: number }

  /** A hard hit. what = what we hit (road = the road, a ramp or a loop surface; terrain = the ground off it). intensity 0..1. */
  crash: { what: 'wall' | 'terrain' | 'road' | 'prop' | 'car' | 'smashable' | 'barrier'; intensity: number; speedKmh: number; otherCarId?: string }
  /** A crash-prop cluster burst. */
  'prop.burst': { kind: string; points: number; remote: boolean }
  /** A roadside piece was smashed (hit above the smash speed). */
  smash: { kind: string; speedKmh: number }

  /** Energy core collected. */
  'core.pickup': { index: number; found: number; total: number }
  /** All cores collected this round. */
  'hunt.complete': { ms: number; best: boolean; previousBestMs: number | null }

  /** Hit a boost pad. */
  boost: { strength: number }
  /** Grabbed / lost a magnetic surface. */
  'mag.on': { surface: 'loop' | 'wall'; speedKmh: number }
  'mag.off': { surface: 'loop' | 'wall'; speedKmh: number; fell: boolean }
  /** Passed through a speed trap. */
  speedtrap: { kmh: number; best: boolean; previousBestKmh: number | null }

  /** R (road) or Shift+R (start line). */
  reset: { kind: 'road' | 'start' | 'auto'; reason?: string }

  /** Race flow. race.countdown is emitted ONCE when a countdown starts (seconds = whole seconds to GO; store.raceGoAt has the exact time). */
  'race.countdown': { seconds: number; racers: number }
  'race.start': { racers: number; laps: number }
  /** Player's race position changed (1 = leading). */
  'race.position': { from: number; to: number; of: number }
  'race.lap': { lap: number; laps: number; position: number }
  'race.finish': { position: number; of: number; ms: number; results: { name: string; ms: number | null; position: number }[] }

  /** Stunt score attack. */
  'stunt.start': { seconds: number }
  'stunt.end': { score: number; best: boolean; previousBest: number | null }

  /** Multiplayer. */
  'mp.join': { name: string; id: string }
  'mp.leave': { name: string; id: string }
  'mp.track': { trackId: string; trackName: string; fromHost: boolean }
  /** Tag: someone became "it". */
  'tag.it': { id: string; name: string; byId: string | null }
  'tag.end': { results: { name: string; itSeconds: number }[] }

  /** Settings / track parameter changed live (e.g. Hyperdrome bank angle). */
  'track.param': { trackId: string; param: string; value: number }

  /** Rewind (hold Backspace / LB): the world started running backwards. stored = seconds it can go back. */
  'rewind.start': { stored: number }
  /** Rewind let go: everything carries on from here. seconds = game time taken back; heldSeconds = how long it was held (clocks that rewind with the world slide forward by both). */
  'rewind.end': { seconds: number; heldSeconds: number }
}

export type GameEventType = keyof GameEventMap
export type GameEvent<K extends GameEventType = GameEventType> = { type: K; t: number } & GameEventMap[K]
export type AnyGameEvent = { [K in GameEventType]: GameEvent<K> }[GameEventType]

type Listener = (e: AnyGameEvent) => void

const listeners = new Set<Listener>()
const RECENT_MAX = 200
const recent: AnyGameEvent[] = []

/** Announce a gameplay moment. */
export function emit<K extends GameEventType>(type: K, payload: GameEventMap[K]): void {
  const e = { type, t: performance.now(), ...payload } as unknown as AnyGameEvent
  recent.push(e)
  if (recent.length > RECENT_MAX) recent.shift()
  for (const fn of listeners) {
    try {
      fn(e)
    } catch (err) {
      console.error('[events] listener failed for', type, err)
    }
  }
}

/** Listen to every event. Returns an unsubscribe function. */
export function subscribe(fn: Listener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Listen to one event type. Returns an unsubscribe function. */
export function on<K extends GameEventType>(type: K, fn: (e: GameEvent<K>) => void): () => void {
  const wrapped: Listener = (e) => {
    if (e.type === type) fn(e as unknown as GameEvent<K>)
  }
  listeners.add(wrapped)
  return () => {
    listeners.delete(wrapped)
  }
}

/** The last 200 events, oldest first (read-only view). */
export function recentEvents(): readonly AnyGameEvent[] {
  return recent
}

if (typeof window !== 'undefined') {
  ;(window as unknown as { __events: unknown }).__events = {
    get recent() {
      return recent
    },
    subscribe,
  }
}
