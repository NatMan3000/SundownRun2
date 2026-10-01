// ============================================================
//  RACE BOOK - who is where in the race, and who has finished
// ------------------------------------------------------------
//  The race's scorekeeper. Laps are NOT counted here: the vehicle's
//  lap tracker owns that, and it only counts a lap when every sector
//  was passed in order (a course cut never counts). Each car's entry
//  in the registry carries:
//
//    car.lap       validated laps completed since the car was put on
//                  the grid (the HUD shows the same number)
//    car.progress  lap + how far round the current lap, slightly
//                  negative on the grid behind the line
//
//  This book reads those once per rendered frame and turns them into
//  race positions (sorted by progress), lap events, the finish
//  (car.lap >= laps) and the results table. It also keeps each car's
//  spot on the road (s, lateral, speed) for the Ai overtaking logic.
//
//  A mutable singleton. No allocation while a race runs.
// ============================================================

import type { NearestHit, TrackRuntime } from '../track/types'
import type { CarState } from '../core/telemetry'
import { getCar } from '../core/telemetry'
import type { RaceResult } from '../core/store'

export interface Racer {
  id: string
  name: string
  isPlayer: boolean
  /** Last known distance along the road (0..length). */
  s: number
  /** Signed metres right of the centreline. */
  lateral: number
  /** car.progress x track length: metres round the race (negative on the grid). */
  dist: number
  /** Validated laps completed (car.lap). */
  lapsDone: number
  /** performance.now() when the current lap began (GO for lap 1). */
  lapStartAt: number
  bestLapMs: number | null
  finished: boolean
  /** ms from GO to the finish line. */
  finishMs: number
  /** 1 = leading. */
  position: number
  /** Off-road time in the lap in progress, ms (Ai dirty-lap rule). */
  offRoadMs: number
  /** Player only: the dirty flag from the vehicle's own lap.complete event, waiting for the lap to land here. */
  pendingDirty: boolean | null
  /** Player only: the exact lap time from the same event (physics-step accurate). */
  pendingMs: number | null
  /** Speed along the road, m/s (smoothed), for overtaking and projections. */
  speed: number
  hit: NearestHit
}

function makeRacer(id: string, name: string, isPlayer: boolean): Racer {
  return {
    id,
    name,
    isPlayer,
    s: 0,
    lateral: 0,
    dist: 0,
    lapsDone: 0,
    lapStartAt: 0,
    bestLapMs: null,
    finished: false,
    finishMs: 0,
    position: 1,
    speed: 0,
    offRoadMs: 0,
    pendingDirty: null,
    pendingMs: null,
    hit: { s: 0, index: 0, lateral: 0, height: 0, distance: 0, onRoad: true },
  }
}

export const raceBook = {
  /** True from the moment the grid is staged until the next round. */
  active: false,
  laps: 3,
  length: 1,
  racers: [] as Racer[],
  /** Indices into racers, best position first. */
  order: [] as number[],
}

/** Set up the book for a new race (call when the grid is staged). */
export function resetRaceBook(entries: { id: string; name: string; isPlayer: boolean }[], laps: number, length: number): void {
  raceBook.active = true
  raceBook.laps = laps
  raceBook.length = length
  raceBook.racers = entries.map((e) => makeRacer(e.id, e.name, e.isPlayer))
  raceBook.order = entries.map((_, i) => i)
}

export function clearRaceBook(): void {
  raceBook.active = false
  raceBook.racers = []
  raceBook.order = []
}

export function racerById(id: string): Racer | null {
  const list = raceBook.racers
  for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i]
  return null
}

/** At GO: everyone starts from where they sit on the grid (the teleport reset their lap trackers). */
export function armRaceBook(track: TrackRuntime, now: number): void {
  for (const r of raceBook.racers) {
    const car = getCar(r.id)
    if (car) track.nearest(car.position.x, car.position.y, car.position.z, r.hit)
    r.s = r.hit.s
    r.lateral = r.hit.lateral
    r.dist = car ? car.progress * raceBook.length : 0
    r.lapsDone = car ? car.lap : 0
    r.lapStartAt = now
    r.bestLapMs = null
    r.finished = false
    r.finishMs = 0
    r.speed = 0
    r.offRoadMs = 0
    r.pendingDirty = null
    r.pendingMs = null
  }
}

/**
 * The dirty-lap rule (vehicle's lap tracker): more than this much off-road time
 * in a lap and it still counts, but can never be a best lap.
 */
const DIRTY_GRACE_MS = 3000

/**
 * On the road for lap purposes: within the road's width (as track.nearest
 * says), or up on a wall ride beside it (a wall ride is road, not a shortcut).
 */
function onRoadForLaps(track: TrackRuntime, r: Racer): boolean {
  if (r.hit.onRoad) return true
  const pieces = track.pieces
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i]
    if (p.type !== 'wallride' && p.type !== 'loop') continue
    if (track.deltaS(p.s0, r.s) >= 0 && track.deltaS(r.s, p.s1) >= 0) {
      const half = track.samples.halfWidth[r.hit.index] ?? 7
      return Math.abs(r.hit.lateral) < half + (p.height ?? p.radius ?? 9) + 1
    }
  }
  return false
}

/** Callbacks the mode controller passes in so this file never emits events itself. */
export interface RaceBookHooks {
  onLap: (r: Racer, lapMs: number) => void
  onFinish: (r: Racer) => void
}

/**
 * Read every racer's lap count and progress from the car registry,
 * spot new laps and finishes, and refresh their place on the road.
 */
export function updateRaceBook(track: TrackRuntime, now: number, goAt: number, dt: number, hooks: RaceBookHooks): void {
  const length = raceBook.length
  for (const r of raceBook.racers) {
    const car: CarState | undefined = getCar(r.id)
    if (!car) continue
    track.nearest(car.position.x, car.position.y, car.position.z, r.hit, r.s)
    const ds = track.deltaS(r.s, r.hit.s)
    r.s = r.hit.s
    r.lateral = r.hit.lateral
    // speed along the road (smoothed); a big jump is a reset, not speed
    if (dt > 0 && Math.abs(ds) < 40) r.speed += (ds / dt - r.speed) * Math.min(1, dt * 4)
    if (r.finished) continue
    if (Number.isFinite(car.progress)) r.dist = car.progress * length
    if (!onRoadForLaps(track, r)) r.offRoadMs += dt * 1000

    if (car.lap > r.lapsDone) {
      r.lapsDone = car.lap
      // Only a clean lap can be a best lap (same rule as records). The car's own
      // lap tracker writes the verdict and the exact time onto its CarState
      // (lastLapDirty / lastLapMs): one source of truth for every car. Until a
      // tracker writes them (lastLapMs still null), fall back to the event / rule.
      const fromCar = car.lastLapMs !== null
      const lapMs = fromCar ? car.lastLapMs! : r.isPlayer && r.pendingMs !== null ? r.pendingMs : now - r.lapStartAt
      r.lapStartAt = now
      const dirty = fromCar
        ? car.lastLapDirty
        : r.isPlayer
          ? (r.pendingDirty ?? r.offRoadMs > DIRTY_GRACE_MS)
          : r.offRoadMs > DIRTY_GRACE_MS
      r.offRoadMs = 0
      r.pendingDirty = null
      r.pendingMs = null
      if (!dirty && (r.bestLapMs === null || lapMs < r.bestLapMs)) r.bestLapMs = lapMs
      if (r.lapsDone >= raceBook.laps) {
        r.finished = true
        r.finishMs = now - goAt
        car.finished = true
        car.finishMs = r.finishMs
        hooks.onFinish(r)
      } else {
        hooks.onLap(r, lapMs)
      }
    }
  }
}

/** Positions: finishers first by time, then everyone else by distance. Returns the player's position. */
export function sortRaceBook(): number {
  const order = raceBook.order
  const list = raceBook.racers
  // insertion sort - six cars at most, no allocation
  for (let i = 1; i < order.length; i++) {
    const k = order[i]
    let j = i - 1
    while (j >= 0 && ahead(list[k], list[order[j]])) {
      order[j + 1] = order[j]
      j--
    }
    order[j + 1] = k
  }
  let playerPos = 1
  for (let i = 0; i < order.length; i++) {
    const r = list[order[i]]
    r.position = i + 1
    if (r.isPlayer) playerPos = i + 1
  }
  return playerPos
}

function ahead(a: Racer, b: Racer): boolean {
  if (a.finished !== b.finished) return a.finished
  if (a.finished) return a.finishMs < b.finishMs
  return a.dist > b.dist
}

/**
 * The results table. Cars still racing get a projected time: the time so
 * far plus the distance left at their average race speed. A car that has
 * barely moved gets null (did not finish).
 */
export function buildResults(now: number, goAt: number): RaceResult[] {
  sortRaceBook()
  const elapsed = Math.max(1, now - goAt)
  const finishDist = raceBook.laps * raceBook.length
  const rows = raceBook.racers.map((r) => {
    let ms: number | null = r.finished ? r.finishMs : null
    if (!r.finished && r.dist > raceBook.length * 0.05) {
      const avg = r.dist / elapsed // metres per ms
      ms = elapsed + (finishDist - r.dist) / avg
    }
    return { r, ms }
  })
  // Finishers keep their places; projected cars are ordered by projected time.
  rows.sort((a, b) => {
    if (a.r.finished !== b.r.finished) return a.r.finished ? -1 : 1
    if (a.ms === null) return b.ms === null ? b.r.dist - a.r.dist : 1
    if (b.ms === null) return -1
    return a.ms - b.ms
  })
  return rows.map((row, i) => ({
    carId: row.r.id,
    name: row.r.name,
    position: i + 1,
    ms: row.ms === null ? null : Math.round(row.ms),
    bestLapMs: row.r.bestLapMs === null ? null : Math.round(row.r.bestLapMs),
    isPlayer: row.r.isPlayer,
  }))
}
