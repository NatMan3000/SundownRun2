// ============================================================
//  MODE CONTROLLER - runs the game mode you picked
// ------------------------------------------------------------
//  Watches the game store (phase, mode, round, track) and, every
//  time a new round starts, sets the world up for that mode:
//
//    free roam    props, smashables and the core hunt are live
//    time trial   a clean track; laps against your ghost
//    race         Ai racers on the grid, you at the back, everyone
//                 frozen through 3-2-1-GO, positions a few times a
//                 second, a finish line, a results table
//    stunt        3-2-1-GO, then 90 seconds to bank the biggest
//                 trick score you can (prop bursts count too)
//
//  Every clock here (race timer, stunt clock, hunt clock) is a
//  performance.now() timestamp in the store. Pausing slides them all
//  forward by the paused time, so a pause never costs you a second.
//  A rewind (vehicle/rewind.ts) slides the race clock by the time it
//  was held plus the time it took back, because every car went back
//  too; the stunt and hunt clocks keep running (a rewind costs time
//  there, so it can't be farmed for a record), and a race you
//  rewound in can't set a race record.
//
//  Multiplayer: the net layer owns races and tag there, so this file
//  stays out of race flow completely and only keeps the props,
//  smashables, cores and speed traps rolling.
// ============================================================

import { useEffect } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { useGame, getGame } from '../core/store'
import type { GameState } from '../core/store'
import { getSettings, getDefaults } from '../core/settings'
import { getCar } from '../core/telemetry'
import { emit, on } from '../core/events'
import { getRecord, offerRecord } from '../core/records'
import { showResults, startSession } from '../core/session'
import { propsSignal } from '../core/propsSignal'
import { urlParam } from '../core/devHandles'
import { getTrack } from '../track/current'
import type { TrackRuntime } from '../track/types'
import { featuresFor, playFlags } from './modes'
import { buildRoster } from './aiRoster'
import {
  armRaceBook,
  buildResults,
  clearRaceBook,
  loadRaceBook,
  RACE_BOOK_REWIND_FLOATS,
  raceBook,
  racerById,
  resetRaceBook,
  saveRaceBook,
  sortRaceBook,
  updateRaceBook,
} from './raceBook'
import { addRewindPart } from '../vehicle'
import type { RaceBookHooks, Racer } from './raceBook'
import { COUNTDOWN_S, SETTLE_MS, STAGING_TIMEOUT_MS, STUNT_SECONDS, drivers, flow, useRoster } from './flow'

const _pos = new THREE.Vector3()
const _quat = new THREE.Quaternion()

/** The player's grid slot this round (behind the last Ai in a race, pole otherwise). */
let playerSlot = 0
/** __dev.race(n) sets this; null = use ?ai= or the settings slider. */
let aiOverride: number | null = null

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(v)))
}

/** How many Ai racers this race gets: __dev.race(n) > ?ai=<n> > the settings slider. */
export function aiCountWanted(): number {
  if (aiOverride !== null) return clampInt(aiOverride, 0, 5)
  const url = urlParam('ai')
  if (url !== null && url !== '' && Number.isFinite(Number(url))) return clampInt(Number(url), 0, 5)
  return clampInt(getSettings().aiRacers, 0, 5)
}

export function setAiOverride(n: number | null): void {
  aiOverride = n
}

/** Laps for a race on this track: the track file wins, else the player's setting. */
function raceLapsFor(track: TrackRuntime): number {
  return clampInt(track.file.laps ?? getSettings().raceLaps, 1, 20)
}

/** Copy this track's stored records into the store so the HUD can show them. */
function mirrorRecords(track: TrackRuntime): void {
  useGame.setState({
    huntBestMs: getRecord(track.key, 'huntBestMs'),
    stuntBest: getRecord(track.key, 'stuntBest'),
    trapBestKmh: getRecord(track.key, 'trapBestKmh'),
  })
}

/** Put a car on a grid slot (the one sanctioned snap). */
function placeOnGrid(track: TrackRuntime, carId: string, slot: number, freeze: boolean): boolean {
  const car = getCar(carId)
  if (!car?.api) return false
  track.gridSlot(slot, _pos, _quat)
  car.api.teleport(_pos, _quat)
  car.api.setFrozen(freeze)
  return true
}

function unfreezeAll(): void {
  getCar('player')?.api?.setFrozen(false)
  for (const r of useRoster.getState().racers) getCar(r.id)?.api?.setFrozen(false)
}

/**
 * Stop whatever race or stunt run was going, take the Ai cars away.
 * `unmounting`: the physics world is being torn down with the track, so
 * don't call into any car (their bodies may already be freed).
 */
function teardownFlow(unmounting = false): void {
  if (flow.kind !== 'none' && !unmounting) unfreezeAll()
  if (useRoster.getState().racers.length > 0 || flow.kind !== 'none') {
    flow.version++
    useRoster.setState({ racers: [], version: flow.version })
  }
  clearRaceBook()
  flow.kind = 'none'
  flow.stage = 'idle'
  flow.pausedAt = 0
}

// ---------------------------------------------------------------- round setup

function startRound(g: GameState): void {
  const track = getTrack()
  if (!track) return
  Object.assign(playFlags, featuresFor(g.mode))
  playFlags.layoutRound = propsSignal.shared ? propsSignal.round : g.round
  teardownFlow()
  mirrorRecords(track)

  const toGrid = flow.restartToGrid
  flow.restartToGrid = false

  // Multiplayer: net owns race flow. Only honour an explicit restart.
  if (g.multiplayer) {
    if (toGrid) placeOnGrid(track, 'player', 0, false)
    return
  }

  if (g.mode === 'race') setupRace(track, g)
  else if (g.mode === 'stunt') setupStunt()
  else if (toGrid) placeOnGrid(track, 'player', 0, false)
}

function setupRace(track: TrackRuntime, g: GameState): void {
  const n = aiCountWanted()
  const laps = raceLapsFor(track)
  const roster = buildRoster(n, track.key, g.round, getSettings().glow)
  playerSlot = n
  flow.kind = 'race'
  flow.stage = 'staging'
  flow.rewound = false
  flow.version++
  flow.stagingSince = performance.now()
  useRoster.setState({ racers: roster, version: flow.version })
  resetRaceBook(
    [...roster.map((r) => ({ id: r.id, name: r.name, isPlayer: false })), { id: 'player', name: 'YOU', isPlayer: true }],
    laps,
    track.length,
  )
  useGame.setState({
    raceState: 'idle',
    raceGoAt: 0,
    raceLaps: laps,
    raceRacers: n + 1,
    racePosition: n + 1,
    raceResults: [],
  })
}

function setupStunt(): void {
  playerSlot = 0
  flow.kind = 'stunt'
  flow.stage = 'staging'
  flow.version++
  flow.stagingSince = performance.now()
  useRoster.setState({ racers: [], version: flow.version })
  useGame.setState({ raceState: 'idle', raceGoAt: 0, stuntEndsAt: 0, stuntScore: 0, raceRacers: 1, racePosition: 1 })
}

/** Once every car exists: line them up, freeze them, start the countdown. */
function tryStage(track: TrackRuntime, now: number): void {
  const roster = useRoster.getState()
  const timedOut = now - flow.stagingSince > STAGING_TIMEOUT_MS
  const player = getCar('player')
  let aiReady = roster.committed === flow.version
  if (aiReady) for (const r of roster.racers) if (!getCar(r.id)?.api) aiReady = false
  if ((!player?.api || !aiReady) && !timedOut) return

  if (!player?.api) {
    console.error('[play] no player car to start the', flow.kind, 'with; giving up on this round')
    teardownFlow()
    return
  }

  placeOnGrid(track, 'player', playerSlot, true)
  for (const r of roster.racers) {
    if (placeOnGrid(track, r.id, r.gridSlot, true)) {
      drivers.get(r.id)?.resetBrain()
    } else {
      console.error('[play] Ai racer', r.id, 'never appeared; racing without it')
      raceBook.racers = raceBook.racers.filter((x) => x.id !== r.id)
      raceBook.order = raceBook.racers.map((_, i) => i)
    }
  }
  if (flow.kind === 'race') useGame.setState({ raceRacers: raceBook.racers.length, racePosition: raceBook.racers.length })

  // Cars sit frozen on the grid for a short settle first. The countdown is
  // announced (once) and shown only when the visible 3 begins, so it reads 3-2-1-GO.
  flow.stage = 'countdown'
  flow.goAt = now + SETTLE_MS + COUNTDOWN_S * 1000
  flow.lastCount = 0
}

function go(track: TrackRuntime, now: number): void {
  unfreezeAll()
  flow.stage = 'running'
  if (flow.kind === 'race') {
    armRaceBook(track, now)
    useGame.setState({ raceState: 'running' })
    emit('race.start', { racers: raceBook.racers.length, laps: raceBook.laps })
  } else {
    const g = getGame()
    flow.trickBase = g.trickScore
    flow.propBase = g.propScore
    useGame.setState({ raceState: 'running', stuntEndsAt: now + STUNT_SECONDS * 1000, stuntScore: 0 })
    emit('stunt.start', { seconds: STUNT_SECONDS })
  }
}

// ---------------------------------------------------------------- race running

const hooks: RaceBookHooks = {
  onLap(r: Racer) {
    if (!r.isPlayer) return
    const pos = sortRaceBook()
    emit('race.lap', { lap: r.lapsDone + 1, laps: raceBook.laps, position: pos })
  },
  onFinish(r: Racer) {
    if (r.isPlayer) finishRace(performance.now())
    // An Ai crossing the line after you: swap its projected time for the real one.
    else if (flow.stage === 'finished') useGame.setState({ raceResults: buildResults(performance.now(), flow.goAt) })
  },
}

function finishRace(now: number): void {
  const track = getTrack()
  if (!track || flow.kind !== 'race' || flow.stage !== 'running') return
  flow.stage = 'finished'
  const results = buildResults(now, flow.goAt)
  const me = results.find((r) => r.isPlayer)
  const player = racerById('player')
  const ms = player?.finished ? Math.round(player.finishMs) : (me?.ms ?? 0)
  useGame.setState({ raceState: 'finished', raceResults: results, racePosition: me?.position ?? 1 })
  // A race record only means something at the track's standard distance.
  const standardLaps = track.file.laps ?? getDefaults().raceLaps
  if (player?.finished && raceBook.laps === standardLaps && !flow.rewound) offerRecord(track.key, 'raceBestMs', ms)
  emit('race.finish', {
    position: me?.position ?? 1,
    of: results.length,
    ms,
    results: results.map((r) => ({ name: r.name, ms: r.ms, position: r.position })),
  })
  showResults()
}

function endStunt(): void {
  const track = getTrack()
  if (!track || flow.kind !== 'stunt' || flow.stage !== 'running') return
  flow.stage = 'finished'
  const g = getGame()
  const score = Math.max(0, Math.round(g.trickScore - flow.trickBase + (g.propScore - flow.propBase)))
  const { best, previous } = offerRecord(track.key, 'stuntBest', score)
  useGame.setState({
    raceState: 'finished',
    stuntEndsAt: 0,
    stuntScore: score,
    stuntBest: best ? score : previous,
  })
  emit('stunt.end', { score, best, previousBest: previous })
  showResults()
}

/**
 * Rewind support: the race went back in time, so its clock does too. Only the race's clocks:
 * the stunt and hunt clocks keep running through a rewind.
 */
function slideRaceClocks(ms: number): void {
  if (!(ms > 0) || flow.kind !== 'race') return
  flow.goAt += ms
  for (const r of raceBook.racers) r.lapStartAt += ms
  const g = getGame()
  if (g.raceGoAt > 0) useGame.setState({ raceGoAt: g.raceGoAt + ms })
}

/** Pause support: slide every running clock forward by the time spent paused. */
function slideClocks(ms: number): void {
  flow.goAt += ms
  flow.stagingSince += ms
  for (const r of raceBook.racers) r.lapStartAt += ms
  const g = getGame()
  useGame.setState({
    raceGoAt: g.raceGoAt > 0 ? g.raceGoAt + ms : 0,
    stuntEndsAt: g.stuntEndsAt > 0 ? g.stuntEndsAt + ms : 0,
    huntStartedAt: g.huntStartedAt > 0 ? g.huntStartedAt + ms : 0,
  })
}

// ---------------------------------------------------------------- public commands

/** Start a fresh round of the current mode (re-scatter props and cores, reset clocks). */
export function newRound(): void {
  useGame.setState((s) => ({ round: s.round + 1 }))
}

/** Restart the current session from the start line / countdown (results "Again"). */
export function restartSession(): void {
  const g = getGame()
  flow.restartToGrid = true
  startSession({ mode: g.mode, trackId: g.trackId })
}

/** Dev: start a race now with n Ai racers. */
export function devRace(n: number): void {
  setAiOverride(Number.isFinite(n) ? n : null)
  const g = getGame()
  startSession({ mode: 'race', trackId: g.trackId })
}

/** Dev: end the race (or stunt run) right now, as if the player crossed the line. */
export function devFinish(): string {
  const now = performance.now()
  if (flow.kind === 'stunt') {
    endStunt()
    return 'stunt ended'
  }
  if (flow.kind !== 'race' || flow.stage !== 'running') return `no race running (stage ${flow.stage})`
  const p = racerById('player')
  const car = getCar('player')
  if (p) {
    p.finished = true
    p.finishMs = now - flow.goAt
  }
  if (car && p) {
    car.finished = true
    car.finishMs = p.finishMs
  }
  finishRace(now)
  return 'race finished'
}

// ---------------------------------------------------------------- the component

const ACTIVE = new Set(['playing', 'paused', 'results'])

function roundKey(s: GameState): string {
  return ACTIVE.has(s.phase) ? `${s.trackVersion}:${s.round}:${s.mode}:${s.multiplayer ? 1 : 0}` : ''
}

export function ModeController() {
  // React to round / mode / track changes (low frequency).
  useEffect(() => {
    let lastKey = ''
    let lastParam = getGame().trackParamVersion
    const check = (s: GameState) => {
      const key = roundKey(s)
      if (key !== lastKey) {
        lastKey = key
        if (key) startRound(s)
        else teardownFlow()
      }
      if (s.trackParamVersion !== lastParam) {
        lastParam = s.trackParamVersion
        const t = getTrack()
        if (t) mirrorRecords(t) // a live bank change can change the track key
      }
    }
    check(getGame())
    const unsub = useGame.subscribe(check)
    return () => {
      unsub()
      teardownFlow(true)
    }
  }, [])

  // Rewind: the race book goes back with the cars; the race clock slides by the time held plus
  // the time taken back; and a race the player rewound in can't be a record.
  useEffect(() => {
    const offPart = addRewindPart({ size: RACE_BOOK_REWIND_FLOATS, save: saveRaceBook, load: loadRaceBook })
    const offEnd = on('rewind.end', (e) => {
      if (flow.kind !== 'race' || flow.stage !== 'running') return
      flow.rewound = true
      slideRaceClocks((e.seconds + e.heldSeconds) * 1000)
    })
    return () => {
      offPart()
      offEnd()
    }
  }, [])

  useFrame((_, delta) => {
    let g = getGame()
    playFlags.layoutRound = propsSignal.shared ? propsSignal.round : g.round
    if (g.multiplayer) return // the world never pauses in multiplayer, and net owns race flow
    const now = performance.now()

    // ---- pause: hold every clock still (race, stunt and the free-roam hunt) ----
    if (g.phase === 'paused') {
      if (flow.pausedAt === 0) flow.pausedAt = now
      return
    }
    if (flow.pausedAt > 0) {
      slideClocks(now - flow.pausedAt)
      flow.pausedAt = 0
      g = getGame() // the slide moved stuntEndsAt / raceGoAt: never compare against the old ones
    }

    if (flow.kind === 'none') return
    const track = getTrack()
    if (!track) return
    const dt = Math.min(delta, 0.1)

    switch (flow.stage) {
      case 'staging':
        tryStage(track, now)
        break
      case 'countdown': {
        // Announce once, when the 3 starts (contract: one race.countdown per countdown;
        // store.raceGoAt holds GO's exact time, and the HUD and audio count from it).
        if (flow.lastCount === 0 && now >= flow.goAt - COUNTDOWN_S * 1000) {
          flow.lastCount = COUNTDOWN_S
          useGame.setState({ raceState: 'countdown', raceGoAt: flow.goAt })
          emit('race.countdown', { seconds: COUNTDOWN_S, racers: flow.kind === 'race' ? raceBook.racers.length : 1 })
        }
        if (now >= flow.goAt) go(track, now)
        break
      }
      case 'running':
      case 'finished':
        if (flow.kind === 'race') {
          updateRaceBook(track, now, flow.goAt, dt, hooks)
          if (flow.stage === 'running') {
            flow.positionTimer -= dt
            if (flow.positionTimer <= 0) {
              flow.positionTimer = 0.25
              const pos = sortRaceBook()
              if (pos !== g.racePosition) {
                emit('race.position', { from: g.racePosition, to: pos, of: raceBook.racers.length })
                useGame.setState({ racePosition: pos })
              }
            }
          }
        } else if (flow.stage === 'running') {
          const score = Math.max(0, Math.round(g.trickScore - flow.trickBase + (g.propScore - flow.propBase)))
          if (score !== g.stuntScore) useGame.setState({ stuntScore: score })
          if (g.stuntEndsAt > 0 && now >= g.stuntEndsAt) endStunt()
        }
        break
    }
  })

  return null
}
