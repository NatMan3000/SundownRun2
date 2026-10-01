// ============================================================
//  ROUNDS - synced races and tag rounds, plus shared crash props
// ------------------------------------------------------------
//  Anyone presses G (or X on the controller):
//    - in Tag mode, a 3-minute tag round starts for everyone
//    - otherwise, a race starts for everyone
//
//  How everyone stays in step with no server deciding anything:
//    1. The presser sends ONE `start` message holding everything that
//       must match: a random raceId, a fresh crash-prop round, the lap
//       count, who starts as "it", and the GRID (relay ids in slot
//       order). Every computer lines up from that same list, so the
//       grids match without any back-and-forth.
//    2. Everyone teleports their OWN car to its slot (track.gridSlot),
//       freezes it, counts down 3 seconds and lets go. LAN delay is a
//       few milliseconds, far quicker than anyone's reactions.
//    3. Race: crossing the line for the last lap sends `finish` with
//       your race time. Everyone collects the same finishes, so every
//       screen shows the same results. Messages carry the raceId, so
//       a late message from an old race can never crown a winner.
//    4. Tag: only the player who is "it" decides when they bumped
//       someone (their computer sees the contact with the other car's
//       body), and announces it. Each hand-over carries a sequence
//       number so an old message can't undo a newer one. The new "it"
//       can't tag anyone for 2 seconds (no tag-backs). Everyone counts
//       how long each player has been "it"; least time wins.
//
//  Two people pressing G at the same moment: both starts arrive
//  everywhere, and everyone keeps the one with the lower raceId, so
//  every screen ends up in the same race.
//
//  Writes (agreed with the orchestrator): store race fields
//  (raceState, raceGoAt, raceLaps, racePosition, raceRacers,
//  raceResults) in multiplayer, the tag fields, store.mode on a synced
//  start, CarState.isIt, and propsSignal while multiplayer is on.
// ============================================================

import * as THREE from 'three'
import { getGame, useGame } from '../core/store'
import type { RaceResult } from '../core/store'
import { cars, getCar, telemetry } from '../core/telemetry'
import { getSettings } from '../core/settings'
import { controlSignals } from '../core/controls'
import { emit } from '../core/events'
import { propsSignal } from '../core/propsSignal'
import { resumeGame, showResults } from '../core/session'
import { getTrack } from '../track/current'
import { playerName } from './identity'
import { onMessage, send, statsExtra, weAreDriving } from './client'
import { carIdFor, getNet, peerLive, relayIdOf, useNet } from './netStore'
import type { FinishMsg, StartMsg, TagMsg, TagTimeMsg } from './protocol'

/** Countdown length, ms (3, 2, 1, GO). */
export const COUNTDOWN_MS = 3000
/** Tag round length, seconds. */
export const TAG_SECONDS = 180
/** After a hand-over, the new "it" can't tag anyone for this long. */
export const NO_TAG_BACK_MS = 2000
/** Once someone finishes a race, everyone else has this long before they're marked as not finished. */
const FINISH_GRACE_MS = 45000
/** Tag: after the clock runs out, wait this long for everyone's final times. */
const TAG_SETTLE_MS = 1200
/** Ram turned off: tag by getting this close instead (metres between car centres). */
const TAG_REACH_NO_RAM_M = 3.2

interface Round {
  kind: 'race' | 'tag'
  raceId: number
  /** Relay ids in grid order. */
  grid: number[]
  /** Names for everyone on the grid, captured at the start (they may leave later). */
  names: Map<number, string>
  inGrid: boolean
  goAt: number
  started: boolean
  ended: boolean
  // ---- race ----
  laps: number
  lapBase: number
  lastLaps: number
  finishes: Map<number, { ms: number; bestLapMs: number | null }>
  firstFinishAt: number
  // ---- tag ----
  endsAt: number
  itId: number
  seq: number
  noTagUntil: number
  seconds: Map<number, number>
  settleAt: number
  /** performance.now() of the last store sync (a few times a second at most). */
  syncedAt: number
}

let round: Round | null = null

/** Read-only view for the inspector and checks. */
export function currentRound(): Readonly<Round> | null {
  return round
}

function myId(): number {
  return getNet().myId
}

/** The car id a relay id has on THIS computer ('player' for us). */
function carIdOn(relayId: number): string {
  return relayId === myId() ? 'player' : carIdFor(relayId)
}

function nameOf(relayId: number): string {
  if (relayId === myId()) return playerName()
  return round?.names.get(relayId) ?? getNet().peers[relayId]?.name ?? `PLAYER ${relayId}`
}

/** Players who could race right now: us, plus peers driving on our track. Sorted relay ids. */
function driversNow(): number[] {
  const track = getTrack()
  const ids = [myId()]
  for (const key of Object.keys(getNet().peers)) {
    const id = Number(key)
    const live = peerLive.get(id)
    if (live && live.driving && track && live.trackKey === track.key) ids.push(id)
  }
  return ids.sort((a, b) => a - b)
}

// ---------------------------------------------------------------- starting

/** G / X pressed here: propose a race or tag round to everyone. */
export function requestStart(): boolean {
  const net = getNet()
  if (net.status !== 'online' || !net.myId) return false
  if (round && !round.ended) return false
  if (getGame().phase === 'editor' || getGame().phase === 'title' || getGame().phase === 'loading') return false
  const track = getTrack()
  if (!track) return false
  const kind: 'race' | 'tag' = getGame().mode === 'tag' ? 'tag' : 'race'
  const grid = driversNow()
  if (kind === 'tag' && grid.length < 2) {
    console.info('[net] tag needs at least two players on the same track')
    return false
  }
  const raceId = 1 + Math.floor(Math.random() * 0x7ffffffe)
  const msg: StartMsg = {
    t: 'start',
    kind,
    raceId,
    round: 1 + Math.floor(Math.random() * 0x7ffffffe),
    laps: track.file.laps ?? getSettings().raceLaps,
    seconds: TAG_SECONDS,
    // Who starts as "it": picked from the raceId, so it is random but the same everywhere.
    itId: grid[raceId % grid.length],
    grid,
  }
  send(msg)
  applyStart(msg, 0)
  return true
}

const _slotPos = new THREE.Vector3()
const _slotQuat = new THREE.Quaternion()

function applyStart(msg: StartMsg, agoMs: number): void {
  if (round && !round.ended) {
    if (round.raceId === msg.raceId) return
    // Two starts crossed: the lower raceId wins everywhere. A running round is never interrupted.
    if (round.started || msg.raceId > round.raceId) return
  }
  const now = performance.now()
  const me = myId()
  const names = new Map<number, string>()
  for (const id of msg.grid) names.set(id, id === me ? playerName() : getNet().peers[id]?.name ?? `PLAYER ${id}`)
  const r: Round = {
    kind: msg.kind,
    raceId: msg.raceId,
    grid: msg.grid.slice(),
    names,
    inGrid: msg.grid.includes(me),
    goAt: now + COUNTDOWN_MS - agoMs,
    started: false,
    ended: false,
    laps: Math.max(1, Math.round(msg.laps)),
    lapBase: getGame().lapCount,
    lastLaps: 0,
    finishes: new Map(),
    firstFinishAt: 0,
    endsAt: now + COUNTDOWN_MS - agoMs + msg.seconds * 1000,
    itId: msg.itId,
    seq: 0,
    noTagUntil: 0,
    seconds: new Map(msg.grid.map((id) => [id, 0])),
    settleAt: 0,
    syncedAt: 0,
  }
  round = r

  // A fresh shared deal of the crash props, for everyone.
  propsSignal.shared = true
  propsSignal.round = msg.round
  propsSignal.pending.length = 0
  propsSignal.nonce++

  if (!r.inGrid) return // we were in a menu when it started: watch this one, join the next

  const g = getGame()
  if (g.phase === 'paused' || g.phase === 'results') resumeGame()
  useGame.setState({
    mode: r.kind === 'tag' ? 'tag' : 'race',
    raceState: 'countdown',
    raceGoAt: r.goAt,
    raceLaps: r.laps,
    racePosition: r.grid.indexOf(me) + 1,
    raceRacers: r.grid.length,
    raceResults: [],
    tagItId: r.kind === 'tag' ? carIdOn(r.itId) : null,
    tagSeconds: r.kind === 'tag' ? secondsRecord(r) : {},
    tagEndsAt: r.kind === 'tag' ? r.endsAt : 0,
  })
  statsExtra.lap = 0

  // Line up: our own car to our own slot, frozen until GO.
  const track = getTrack()
  const player = getCar('player')
  if (track && player?.api) {
    track.gridSlot(r.grid.indexOf(me), _slotPos, _slotQuat)
    player.api.teleport(_slotPos, _slotQuat)
    player.api.setFrozen(true)
  }
  emit('race.countdown', { seconds: Math.round(COUNTDOWN_MS / 1000), racers: r.grid.length })
  if (r.kind === 'tag') emit('tag.it', { id: carIdOn(r.itId), name: nameOf(r.itId), byId: null })
}

function secondsRecord(r: Round): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [id, s] of r.seconds) out[carIdOn(id)] = Math.round(s * 10) / 10
  return out
}

// ---------------------------------------------------------------- race

function raceLapsDone(r: Round): number {
  return Math.max(0, getGame().lapCount - r.lapBase)
}

function sendFinish(r: Round): void {
  const ms = Math.round(performance.now() - r.goAt)
  const bestLapMs = getGame().lastLapMs
  r.finishes.set(myId(), { ms, bestLapMs })
  if (!r.firstFinishAt) r.firstFinishAt = performance.now()
  const msg: FinishMsg = { t: 'finish', raceId: r.raceId, ms, bestLapMs }
  send(msg)
}

/** Places: finishers by race time, then everyone else by how far round they got. */
function racePlaces(r: Round): number[] {
  const progress = (id: number): number => {
    if (id === myId()) {
      const track = getTrack()
      return raceLapsDone(r) + (track ? telemetry.trackS / track.length : 0)
    }
    return getCar(carIdFor(id))?.progress ?? -1
  }
  return r.grid.slice().sort((a, b) => {
    const fa = r.finishes.get(a)
    const fb = r.finishes.get(b)
    if (fa && fb) return fa.ms - fb.ms
    if (fa) return -1
    if (fb) return 1
    return progress(b) - progress(a)
  })
}

function endRace(r: Round): void {
  r.ended = true
  const places = racePlaces(r)
  const results: RaceResult[] = places.map((id, i) => {
    const f = r.finishes.get(id)
    return { carId: carIdOn(id), name: nameOf(id), position: i + 1, ms: f?.ms ?? null, bestLapMs: f?.bestLapMs ?? null, isPlayer: id === myId() }
  })
  statsExtra.lap = -1
  useGame.setState({ raceState: 'finished', raceResults: results })
  const mine = results.find((x) => x.isPlayer)
  if (r.inGrid && mine) {
    emit('race.finish', {
      position: mine.position,
      of: results.length,
      ms: mine.ms ?? 0,
      results: results.map((x) => ({ name: x.name, ms: x.ms, position: x.position })),
    })
    showResults()
  }
}

// ---------------------------------------------------------------- tag

/** We are "it", the round is on, and the no-tag-back time is over. */
export function canTag(): boolean {
  const r = round
  return !!r && r.kind === 'tag' && r.started && !r.ended && r.inGrid && r.itId === myId() && performance.now() >= r.noTagUntil
}

/** Our car touched this remote player while we were "it": they are "it" now. */
export function tagged(relayId: number): void {
  const r = round
  if (!r || !canTag() || !r.grid.includes(relayId) || relayId === myId()) return
  const msg: TagMsg = { t: 'tag', raceId: r.raceId, itId: relayId, seq: r.seq + 1, itSeconds: r.seconds.get(myId()) ?? 0 }
  send(msg)
  applyTag(msg, myId())
}

function applyTag(msg: TagMsg, from: number): void {
  const r = round
  if (!r || r.kind !== 'tag' || r.raceId !== msg.raceId || msg.seq <= r.seq || r.ended) return
  r.seq = msg.seq
  // The old "it" knows its own time best.
  r.seconds.set(from, msg.itSeconds)
  r.itId = msg.itId
  r.noTagUntil = performance.now() + NO_TAG_BACK_MS
  useGame.setState({ tagItId: carIdOn(r.itId), tagSeconds: secondsRecord(r) })
  emit('tag.it', { id: carIdOn(r.itId), name: nameOf(r.itId), byId: carIdOn(from) })
}

function endTag(r: Round): void {
  r.ended = true
  const order = r.grid.slice().sort((a, b) => (r.seconds.get(a) ?? 0) - (r.seconds.get(b) ?? 0))
  const results: RaceResult[] = order.map((id, i) => ({
    carId: carIdOn(id),
    name: nameOf(id),
    position: i + 1,
    // Tag results reuse RaceResult: ms = time spent as "it" (least wins).
    ms: Math.round((r.seconds.get(id) ?? 0) * 1000),
    bestLapMs: null,
    isPlayer: id === myId(),
  }))
  useGame.setState({ raceState: 'finished', raceResults: results, tagItId: null, tagSeconds: secondsRecord(r), tagEndsAt: 0 })
  for (const c of cars) c.isIt = false
  if (r.inGrid) {
    emit('tag.end', { results: order.map((id) => ({ name: nameOf(id), itSeconds: Math.round((r.seconds.get(id) ?? 0) * 10) / 10 })) })
    showResults()
  }
}

// ---------------------------------------------------------------- every frame

let lastRaceNonce = -1

/** Called every render frame by NetLayer. Cheap; no allocation on the hot path. */
export function roundsTick(dt: number): void {
  // G / X: propose a round (edge-triggered nonce).
  if (lastRaceNonce < 0) lastRaceNonce = controlSignals.race
  if (controlSignals.race !== lastRaceNonce) {
    lastRaceNonce = controlSignals.race
    if (weAreDriving()) requestStart()
  }

  const r = round
  if (!r || r.ended) return
  const now = performance.now()

  if (!r.started) {
    if (now < r.goAt) return
    r.started = true
    if (r.inGrid) {
      // Count race laps from here: the grid teleport (applied on a physics
      // step during the countdown) has reset the lap tracker by now.
      r.lapBase = getGame().lapCount
      getCar('player')?.api?.setFrozen(false)
      useGame.setState({ raceState: 'running' })
      emit('race.start', { racers: r.grid.length, laps: r.kind === 'race' ? r.laps : 0 })
    }
  }

  if (r.kind === 'race') tickRace(r, now)
  else tickTag(r, now, dt)
}

function tickRace(r: Round, now: number): void {
  if (r.inGrid && !r.finishes.has(myId())) {
    const laps = raceLapsDone(r)
    statsExtra.lap = laps
    if (laps !== r.lastLaps) {
      r.lastLaps = laps
      if (laps >= r.laps) sendFinish(r)
      else emit('race.lap', { lap: laps, laps: r.laps, position: getGame().racePosition })
    }
  }
  // Positions for the HUD, a few times a second.
  if (r.inGrid && now - r.syncedAt > 250) {
    r.syncedAt = now
    const pos = racePlaces(r).indexOf(myId()) + 1
    const prev = getGame().racePosition
    if (pos > 0 && pos !== prev) {
      useGame.setState({ racePosition: pos })
      emit('race.position', { from: prev, to: pos, of: r.grid.length })
    }
  }
  // Done when every racer still here has finished, or the grace time after the first finish ran out.
  const present = r.grid.filter((id) => id === myId() || !!getNet().peers[id])
  const allIn = present.every((id) => r.finishes.has(id))
  if (allIn || (r.firstFinishAt && now - r.firstFinishAt > FINISH_GRACE_MS)) endRace(r)
}

function tickTag(r: Round, now: number, dt: number): void {
  if (!r.settleAt) {
    // The clock runs for whoever is "it" (everyone counts; the "it" player's own count wins at hand-over).
    r.seconds.set(r.itId, (r.seconds.get(r.itId) ?? 0) + dt)
    if (now >= r.endsAt) {
      r.settleAt = now + TAG_SETTLE_MS
      const msg: TagTimeMsg = { t: 'tagTime', raceId: r.raceId, seconds: r.seconds.get(myId()) ?? 0 }
      if (r.inGrid) send(msg)
    }
  } else if (now >= r.settleAt) {
    endTag(r)
    return
  }

  // Whoever is "it" glows (look draws the aura from CarState.isIt).
  for (let i = 0; i < cars.length; i++) {
    const c = cars[i]
    if (c.kind === 'player') c.isIt = r.itId === myId()
    else if (c.kind === 'remote') c.isIt = relayIdOf(c.id) === r.itId
  }

  // Ramming off: no contacts happen, so "touching" means getting very close.
  if (!getSettings().multiplayerRam && canTag()) {
    const p = telemetry.carPosition
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i]
      if (c.kind === 'remote' && c.position.distanceToSquared(p) < TAG_REACH_NO_RAM_M * TAG_REACH_NO_RAM_M) {
        tagged(relayIdOf(c.id))
        break
      }
    }
  }

  if (now - r.syncedAt > 250) {
    r.syncedAt = now
    useGame.setState({ tagSeconds: secondsRecord(r) })
  }
}

// ---------------------------------------------------------------- wiring

let wired = false
let unsubs: (() => void)[] = []

/** Hook rounds and shared props into the client (idempotent). */
export function startRounds(): void {
  if (wired) return
  wired = true

  // Crash props: everyone plays the same deal; bursts are shared both ways.
  propsSignal.shared = true
  propsSignal.onLocalPop = (pop) => {
    send({ t: 'prop', round: propsSignal.round, cluster: pop.cluster, vx: pop.vx, vy: pop.vy, vz: pop.vz })
  }

  unsubs.push(
    onMessage('welcome', (m) => {
      if (!m.live) return
      // A round is already on: deal the same props, and watch until the next one.
      propsSignal.round = m.live.round
      propsSignal.pending.length = 0
      propsSignal.nonce++
      if (!round || round.raceId !== m.live.raceId) applyStart(m.live, m.live.startedAgoMs)
    }),
    onMessage('start', (m) => applyStart(m, 0)),
    onMessage('finish', (m) => {
      const r = round
      if (!r || r.kind !== 'race' || r.raceId !== m.raceId || r.ended) return
      if (!r.finishes.has(m.from)) r.finishes.set(m.from, { ms: m.ms, bestLapMs: m.bestLapMs })
      if (!r.firstFinishAt) r.firstFinishAt = performance.now()
    }),
    onMessage('tag', (m) => applyTag(m, m.from)),
    onMessage('tagTime', (m) => {
      const r = round
      if (r && r.kind === 'tag' && r.raceId === m.raceId) r.seconds.set(m.from, m.seconds)
    }),
    onMessage('prop', (m) => {
      // Only bursts from the same deal: a message that straddles a race start refers to a layout that's gone.
      if (m.round === propsSignal.round) propsSignal.pending.push({ cluster: m.cluster, vx: m.vx, vy: m.vy, vz: m.vz })
    }),
    onMessage('leave', (m) => {
      const r = round
      // "It" walked off: hand it on deterministically (lowest relay id left on the grid).
      if (r && r.kind === 'tag' && !r.ended && r.itId === m.id) {
        const left = r.grid.filter((id) => id !== m.id && (id === myId() || !!getNet().peers[id]))
        if (left.length) {
          r.itId = Math.min(...left)
          r.noTagUntil = performance.now() + NO_TAG_BACK_MS
          useGame.setState({ tagItId: carIdOn(r.itId) })
          emit('tag.it', { id: carIdOn(r.itId), name: nameOf(r.itId), byId: null })
        }
      }
    }),
    // Lost the connection mid-round: the round is over for us.
    useNet.subscribe((s, prev) => {
      if (prev.status === 'online' && s.status !== 'online' && round && !round.ended) {
        round.ended = true
        statsExtra.lap = -1
        getCar('player')?.api?.setFrozen(false)
        useGame.setState({ raceState: 'idle', tagItId: null, tagEndsAt: 0 })
        for (const c of cars) c.isIt = false
      }
    }),
  )
}

export function stopRounds(): void {
  for (const u of unsubs) u()
  unsubs = []
  wired = false
  propsSignal.shared = false
  propsSignal.onLocalPop = null
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => stopRounds())
}
