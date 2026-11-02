// ============================================================
//  HUNT TURNS - take turns hunting (used by rounds.ts)
// ------------------------------------------------------------
//  You take turns being the hunter. In a turn one player hunts and
//  everyone else runs; everyone hunts once a round. Only catching
//  scores: each catch is a point to the hunter, running scores
//  nothing. Most catches wins; equal is a draw.
//
//  Catching is easier than hitting a car: contact counts, so does
//  getting within catchReachM, and the hunter has a tag pulse (F, or
//  click the right stick) that catches anyone in a cone in front of
//  it, then cools down. A caught runner is thrown far away (their own
//  computer moves their car to an arena spot at least throwAwayM
//  from the hunter) and the hunter can't catch again for a moment, so every
//  catch starts a fresh chase. Every turn starts with the players
//  spread round the arena, not side by side on a grid.
//
//  How it stays in step with no server deciding anything:
//    - The round is ONE `start` (kind 'turns') carrying its rules (the
//      presser's knobs). The hunting order is the grid turned round by
//      the raceId, and every turn's times come from the first GO, so
//      every computer moves on together without another message.
//    - Only the HUNTER's computer decides a catch (it saw the contact,
//      a runner got within reach, its pulse hit, or a runner said "I
//      touched you"), and announces it (`catch`) with a sequence
//      number. Everyone counts the same catches, so the results agree.
//    - Start spots come from play.arenaSpots(), a pure function of the
//      track, so every computer agrees which spot is whose.
//
//  Writes: store.turns (a few times a second at most, and at every
//  catch), and through rounds.ts the race fields for each turn's
//  countdown.
// ============================================================

import * as THREE from 'three'
import { useGame } from '../core/store'
import type { RaceResult, TurnsView } from '../core/store'
import { getSettings } from '../core/settings'
import { emit } from '../core/events'
import { showResults } from '../core/session'
import { urlParam } from '../core/devHandles'
import { play } from '../core/api'
import type { ArenaSpot } from '../core/api'
import { cars, getCar, telemetry } from '../core/telemetry'
import { getTrack } from '../track/current'
import type { TrackFrame } from '../track/types'
import { send } from './client'
import { relayIdOf } from './netStore'
import type { CatchMsg, PulseMsg, StartMsg, TurnsRules } from './protocol'
import type { Round } from './rounds'

/** After a turn's bell, wait this long for a catch still on the wire. */
export const TURNS_SETTLE_MS = 1200
/** How long the between-turns card ("Your turn to hunt") shows. */
export const TURNS_CARD_MS = 3000
/** The countdown before every turn (as a race's). */
const COUNT_MS = 3000
/** A car's middle sits this far above the ground when it's placed on a spot. */
const SPOT_LIFT = 0.65

/** What rounds.ts lends us (so the two files don't import each other at run time). */
export interface TurnsCtx {
  myId(): number
  carIdOn(relayId: number): string
  nameOf(relayId: number): string
  inRound(r: Round, id: number): boolean
  /** Freeze our car where it is and count down to `goAt` (store race fields). */
  countDown(r: Round, goAt: number): void
  /** Unfreeze and go (store race fields, race.start). */
  go(r: Round): void
}

export interface TurnsState {
  rules: TurnsRules
  turnMs: number
  /** Who hunts in each turn (relay ids), in order. */
  order: number[]
  /** The turn being played (0-based). */
  index: number
  phase: 'count' | 'play' | 'settle' | 'card' | 'done'
  /** Catches this round, by hunter (relay id). */
  catches: Map<number, number>
  /** Catches in the turn being played. */
  turnCatches: number
  /** Finished turns. */
  history: { hunter: number; catches: number }[]
  /** Highest catch number seen this round (an older one can't count twice). */
  seq: number
  /** performance.now() the hunter may catch again. */
  noCatchUntil: number
  /** performance.now() OUR pulse is ready again. */
  pulseReadyAt: number
  publishedAt: number
}

/** The rules from OUR knobs (the presser's go into the start message). */
export function turnsRulesNow(): TurnsRules {
  const s = getSettings()
  return {
    catchReachM: s.catchReachMetres,
    pulseRangeM: s.pulseRangeMetres,
    pulseConeDeg: s.pulseConeDegrees,
    pulseCooldownMs: Math.round(s.pulseCooldownSeconds * 1000),
    throwAwayM: s.throwAwayMetres,
    noCatchMs: Math.round(s.noCatchAfterCatchSeconds * 1000),
    breakMs: TURNS_SETTLE_MS + TURNS_CARD_MS + COUNT_MS,
  }
}

/** One turn's length, seconds: the knob, or ?turnSeconds=25 for checks. */
export function turnSeconds(): number {
  const n = Number(urlParam('turnSeconds'))
  return Number.isFinite(n) && n >= 10 && n <= 600 ? n : getSettings().huntTurnSeconds
}

/** A number from a message, made safe (a broken one never reaches the rules). */
function num(v: unknown, lo: number, hi: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback
}

export function newTurnsState(msg: StartMsg): TurnsState {
  const t = msg.turns
  const rules: TurnsRules = {
    catchReachM: num(t?.catchReachM, 1, 50, 6),
    pulseRangeM: num(t?.pulseRangeM, 0, 100, 15),
    pulseConeDeg: num(t?.pulseConeDeg, 1, 360, 70),
    pulseCooldownMs: num(t?.pulseCooldownMs, 200, 60000, 4000),
    throwAwayM: num(t?.throwAwayM, 0, 1000, 100),
    noCatchMs: num(t?.noCatchMs, 0, 30000, 2000),
    breakMs: num(t?.breakMs, TURNS_SETTLE_MS + COUNT_MS, 30000, TURNS_SETTLE_MS + TURNS_CARD_MS + COUNT_MS),
  }
  // The hunting order: the grid, turned round by the raceId (the first is msg.itId, picked the same way).
  const n = msg.grid.length
  const first = Math.max(0, msg.grid.indexOf(msg.itId))
  const order: number[] = []
  for (let i = 0; i < n; i++) order.push(msg.grid[(first + i) % n])
  return {
    rules,
    turnMs: num(msg.seconds, 10, 600, 60) * 1000,
    order,
    index: 0,
    phase: 'count',
    catches: new Map(msg.grid.map((id) => [id, 0])),
    turnCatches: 0,
    history: [],
    seq: 0,
    noCatchUntil: 0,
    pulseReadyAt: 0,
    publishedAt: 0,
  }
}

/** performance.now() turn i's chase starts (GO) on this computer. */
export function turnGoAt(r: Round, t: TurnsState, i: number): number {
  return r.goAt + i * (t.turnMs + t.rules.breakMs)
}

function turnEndsAt(r: Round, t: TurnsState, i: number): number {
  return turnGoAt(r, t, i) + t.turnMs
}

/** A turn is being played: catches and pulses count. */
export function turnsLive(r: Round): boolean {
  return !!r.turns && r.turns.phase === 'play'
}

/** The round is as good as over for us (a new start may replace it). */
export function turnsWrappingUp(r: Round): boolean {
  const t = r.turns
  return !t || t.phase === 'done' || (t.phase === 'settle' && t.index >= t.order.length - 1)
}

/** We hunt, a turn is on, and the no-catch time after the last catch is over. */
export function canCatch(r: Round, ctx: TurnsCtx): boolean {
  const t = r.turns
  return !!t && t.phase === 'play' && r.inGrid && r.itId === ctx.myId() && performance.now() >= t.noCatchUntil
}

// ---------------------------------------------------------------- start spots

/** Road points tried when a track has no arena spots to throw a runner to. */
const ROAD_PROBES = 64
const _frame: TrackFrame = { s: 0, position: new THREE.Vector3(), tangent: new THREE.Vector3(), up: new THREE.Vector3(), right: new THREE.Vector3(), halfWidth: 0, bank: 0, curvature: 0, surface: 'road' }
const _pos = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _up = new THREE.Vector3(0, 1, 0)

/**
 * Where each player starts a turn: a different arena spot each, spread evenly round the list
 * (two players: opposite sides), the whole pattern turned by the raceId and the turn, so every
 * computer puts everyone in the same places. False if the track has too few spots (then the
 * caller uses the start grid).
 */
function spotFor(r: Round, turn: number, relayId: number, out: THREE.Vector3, quat: THREE.Quaternion): boolean {
  const spots = play.arenaSpots()
  const n = spots.length
  const m = r.grid.length
  const i = r.grid.indexOf(relayId)
  if (i < 0 || n < m || n < 2) return false
  const offset = (r.raceId + turn * 3) % n
  const s = spots[(offset + Math.floor((i * n) / m)) % n]
  out.set(s.x, s.y + SPOT_LIFT, s.z)
  quat.setFromAxisAngle(_up, s.yaw)
  return true
}

/** Our car to our own start spot for turn `turn` (the start grid on a track without spots). */
export function placeForTurn(r: Round, turn: number, ctx: TurnsCtx): void {
  const player = getCar('player')
  if (!player?.api) return
  if (!spotFor(r, turn, ctx.myId(), _pos, _quat)) {
    const track = getTrack()
    if (!track) return
    track.gridSlot(r.grid.indexOf(ctx.myId()), _pos, _quat)
  }
  player.api.teleport(_pos, _quat)
}

/**
 * Where a caught runner goes: the nearest arena spot that is still at least `minM` from the
 * hunter at (x, z) (so Josh's throwAwayMetres knob decides how far), or the farthest spot if none
 * is that far. Null if the track has no spots.
 */
function throwSpot(x: number, z: number, minM: number): ArenaSpot | null {
  let near: ArenaSpot | null = null
  let nearD = Infinity
  let far: ArenaSpot | null = null
  let farD = -1
  for (const s of play.arenaSpots()) {
    const d = Math.hypot(s.x - x, s.z - z)
    if (d >= minM && d < nearD) {
      nearD = d
      near = s
    }
    if (d > farD) {
      farD = d
      far = s
    }
  }
  return near ?? far
}

// ---------------------------------------------------------------- catches

/**
 * We hunt and caught runner `runnerId`: count it and tell everyone. The caller has checked
 * canCatch (a pulse catching several runners checks once, then calls this for each).
 */
export function announceCatch(r: Round, ctx: TurnsCtx, runnerId: number, how: CatchMsg['how']): void {
  const t = r.turns
  if (!t || runnerId === ctx.myId() || !r.grid.includes(runnerId)) return
  const msg: CatchMsg = { t: 'catch', raceId: r.raceId, turn: t.index, seq: t.seq + 1, runnerId, how }
  send(msg)
  applyCatch(r, ctx, msg, ctx.myId())
}

/** A catch (ours, or the hunter's message): count it; if it's us, we're thrown far away. */
export function applyCatch(r: Round, ctx: TurnsCtx, m: CatchMsg, from: number): void {
  const t = r.turns
  if (!t || r.raceId !== m.raceId || m.turn !== t.index || m.seq <= t.seq) return
  // Only that turn's hunter catches anyone.
  if (from !== t.order[m.turn] || !r.grid.includes(m.runnerId) || m.runnerId === from) return
  if (t.phase !== 'play' && t.phase !== 'settle') return
  t.seq = m.seq
  t.catches.set(from, (t.catches.get(from) ?? 0) + 1)
  t.turnCatches++
  t.noCatchUntil = performance.now() + t.rules.noCatchMs
  emit('turns.catch', {
    hunterId: ctx.carIdOn(from),
    hunterName: ctx.nameOf(from),
    runnerId: ctx.carIdOn(m.runnerId),
    runnerName: ctx.nameOf(m.runnerId),
    how: m.how,
    catches: t.catches.get(from) ?? 0,
  })
  if (m.runnerId === ctx.myId() && r.inGrid) throwAway(t, ctx, from)
  publish(r, ctx, true)
}

/** We were caught: our car goes to an arena spot at least throwAwayM from the hunter (throwSpot). */
function throwAway(t: TurnsState, ctx: TurnsCtx, hunter: number): void {
  const me = getCar('player')
  if (!me?.api) return
  const h = hunter === ctx.myId() ? null : getCar(ctx.carIdOn(hunter))
  const hx = h ? h.position.x : me.position.x
  const hz = h ? h.position.z : me.position.z
  const spot = throwSpot(hx, hz, t.rules.throwAwayM)
  const fromX = me.position.x
  const fromZ = me.position.z
  if (spot) {
    _pos.set(spot.x, spot.y + SPOT_LIFT, spot.z)
    _quat.setFromAxisAngle(_up, spot.yaw)
  } else {
    // No spots (a walled road, or no room): the point of the road farthest from the hunter, facing along it.
    const track = getTrack()
    if (!track) return
    let bestS = 0
    let bestD = -1
    for (let i = 0; i < ROAD_PROBES; i++) {
      const s = (track.length * i) / ROAD_PROBES
      track.frameAt(s, _frame)
      const d = (_frame.position.x - hx) ** 2 + (_frame.position.z - hz) ** 2
      if (d > bestD) {
        bestD = d
        bestS = s
      }
    }
    track.frameAt(bestS, _frame)
    _pos.copy(_frame.position).addScaledVector(_frame.up, SPOT_LIFT + 0.4)
    _quat.setFromAxisAngle(_up, Math.atan2(_frame.tangent.x, _frame.tangent.z))
  }
  me.api.teleport(_pos, _quat)
  emit('turns.thrown', { fromX, fromZ, x: _pos.x, y: _pos.y, z: _pos.z })
}

/** Every frame while we hunt: anyone within reach is caught (no contact needed). */
function reachCheck(r: Round, t: TurnsState, ctx: TurnsCtx): void {
  if (!canCatch(r, ctx)) return
  const p = telemetry.carPosition
  const reach2 = t.rules.catchReachM * t.rules.catchReachM
  for (let i = 0; i < cars.length; i++) {
    const c = cars[i]
    if (c.kind !== 'remote') continue
    const id = relayIdOf(c.id)
    if (!r.grid.includes(id) || !ctx.inRound(r, id)) continue
    if (c.position.distanceToSquared(p) <= reach2) {
      announceCatch(r, ctx, id, 'reach')
      return
    }
  }
}

/** The pulse can fire now (we hunt, a turn is on, it has cooled down and catching is open). */
export function pulseReady(r: Round, ctx: TurnsCtx): boolean {
  const t = r.turns
  return !!t && canCatch(r, ctx) && performance.now() >= t.pulseReadyAt
}

/**
 * We fire the tag pulse: everyone sees the burst (`pulse`), and every runner within range and
 * inside the cone in front of our nose is caught. Returns how many it caught, or -1 if it
 * couldn't fire (not hunting, cooling down, or right after a catch).
 */
export function firePulse(r: Round, ctx: TurnsCtx): number {
  const t = r.turns
  if (!t || !pulseReady(r, ctx)) return -1
  const p = telemetry.carPosition
  const f = telemetry.carForward
  let fx = f.x
  let fz = f.z
  const fl = Math.hypot(fx, fz)
  if (!(fl > 1e-3) || !Number.isFinite(p.x + p.y + p.z)) return -1
  fx /= fl
  fz /= fl
  t.pulseReadyAt = performance.now() + t.rules.pulseCooldownMs
  const msg: PulseMsg = { t: 'pulse', raceId: r.raceId, x: p.x, y: p.y, z: p.z, dx: fx, dz: fz }
  send(msg)
  emit('turns.pulse', { id: 'player', x: p.x, y: p.y, z: p.z, dx: fx, dz: fz, range: t.rules.pulseRangeM, coneDeg: t.rules.pulseConeDeg })
  // Everyone in the cone: found first, then announced (each catch opens the no-catch window).
  const cosHalf = Math.cos((t.rules.pulseConeDeg * Math.PI) / 360)
  const caught: number[] = []
  for (let i = 0; i < cars.length; i++) {
    const c = cars[i]
    if (c.kind !== 'remote') continue
    const id = relayIdOf(c.id)
    if (!r.grid.includes(id) || !ctx.inRound(r, id)) continue
    const dx = c.position.x - p.x
    const dz = c.position.z - p.z
    const d = Math.hypot(dx, dz)
    if (d > t.rules.pulseRangeM || Math.abs(c.position.y - p.y) > t.rules.pulseRangeM) continue
    // Right on top of us counts; otherwise it must be inside the cone.
    if (d > 0.5 && (dx * fx + dz * fz) / d < cosHalf) continue
    caught.push(id)
  }
  for (const id of caught) announceCatch(r, ctx, id, 'pulse')
  publish(r, ctx, true)
  return caught.length
}

/** Someone else's pulse: just the burst (the hunter's computer already decided who it caught). */
export function pulseFrom(r: Round, ctx: TurnsCtx, m: PulseMsg & { from: number }): void {
  const t = r.turns
  if (!t || r.raceId !== m.raceId || m.from === ctx.myId() || m.from !== r.itId) return
  if (!Number.isFinite(m.x + m.y + m.z + m.dx + m.dz)) return
  emit('turns.pulse', { id: ctx.carIdOn(m.from), x: m.x, y: m.y, z: m.z, dx: m.dx, dz: m.dz, range: t.rules.pulseRangeM, coneDeg: t.rules.pulseConeDeg })
}

// ---------------------------------------------------------------- the clock (every frame, from rounds.ts)

export function tickTurns(r: Round, ctx: TurnsCtx, now: number, end: (r: Round) => void): void {
  const t = r.turns
  if (!t) return
  // Several steps can be due at once (a hitch, or back from a short drop): take them in order.
  for (let guard = 0; guard < 8; guard++) {
    if (t.phase === 'count') {
      const go = turnGoAt(r, t, t.index)
      if (now < go) break
      t.phase = 'play'
      if (t.index > 0 && r.inGrid) ctx.go(r)
      continue
    }
    if (t.phase === 'play') {
      if (now < turnEndsAt(r, t, t.index)) break
      t.phase = 'settle'
      publish(r, ctx, true)
      continue
    }
    if (t.phase === 'settle') {
      if (now < turnEndsAt(r, t, t.index) + TURNS_SETTLE_MS) break
      t.history.push({ hunter: t.order[t.index], catches: t.turnCatches })
      if (t.index + 1 >= t.order.length) {
        t.phase = 'done'
        end(r)
        return
      }
      // The card: whose turn is next. Nobody hunts until its countdown.
      t.index++
      t.turnCatches = 0
      t.phase = 'card'
      r.itId = t.order[t.index]
      publish(r, ctx, true)
      continue
    }
    if (t.phase === 'card') {
      const go = turnGoAt(r, t, t.index)
      if (now < go - COUNT_MS) break
      // The next turn lines up: spread round the arena again, 3-2-1.
      t.phase = 'count'
      t.noCatchUntil = 0
      t.pulseReadyAt = 0
      r.endsAt = turnEndsAt(r, t, t.index)
      if (r.inGrid) {
        placeForTurn(r, t.index, ctx)
        ctx.countDown(r, go)
      }
      announceTurn(r, ctx)
      publish(r, ctx, true)
      continue
    }
    break
  }
  if (t.phase === 'play' && r.itId === ctx.myId()) reachCheck(r, t, ctx)
  publish(r, ctx, false)
}

/** Tell everyone (the HUD, audio) whose turn it is. */
export function announceTurn(r: Round, ctx: TurnsCtx): void {
  const t = r.turns
  if (!t) return
  const h = t.order[t.index]
  emit('turns.turn', { turn: t.index + 1, turns: t.order.length, hunterId: ctx.carIdOn(h), name: ctx.nameOf(h) })
}

/** The round is over (everyone has hunted, or too few players are left): the results. */
export function endTurns(r: Round, ctx: TurnsCtx): void {
  const t = r.turns
  r.ended = true
  if (!t) return
  // A turn cut short (someone left) still counts as played.
  if (t.phase === 'play' || t.phase === 'settle') t.history.push({ hunter: t.order[t.index], catches: t.turnCatches })
  t.phase = 'done'
  const order = r.grid.slice().sort((a, b) => (t.catches.get(b) ?? 0) - (t.catches.get(a) ?? 0) || r.grid.indexOf(a) - r.grid.indexOf(b))
  const results: RaceResult[] = []
  let pos = 0
  let prev = -1
  order.forEach((id, i) => {
    const n = t.catches.get(id) ?? 0
    // Equal catches share a place.
    if (n !== prev) {
      pos = i + 1
      prev = n
    }
    // Hunt Turns results reuse RaceResult: ms = catches (most wins).
    results.push({ carId: ctx.carIdOn(id), name: ctx.nameOf(id), position: pos, ms: n, bestLapMs: null, isPlayer: id === ctx.myId() })
  })
  const draw = order.length >= 2 && (t.catches.get(order[0]) ?? 0) === (t.catches.get(order[1]) ?? 0)
  r.itId = 0
  publish(r, ctx, true)
  useGame.setState({ raceState: 'finished', raceResults: results })
  if (r.inGrid) {
    emit('turns.end', { results: order.map((id) => ({ name: ctx.nameOf(id), catches: t.catches.get(id) ?? 0 })), draw })
    showResults()
  }
}

/** A player's relay id changed (a reconnect): carry their catches and their turn over. */
export function remapTurns(t: TurnsState, oldId: number, newId: number): void {
  const v = t.catches.get(oldId)
  if (v !== undefined) {
    t.catches.delete(oldId)
    t.catches.set(newId, v)
  }
  t.order = t.order.map((id) => (id === oldId ? newId : id))
  for (const h of t.history) if (h.hunter === oldId) h.hunter = newId
}

// ---------------------------------------------------------------- the store

/** Write the round into the store: now (force) or at most four times a second. */
export function publish(r: Round, ctx: TurnsCtx, force: boolean): void {
  const t = r.turns
  if (!t || !r.inGrid) return
  const now = performance.now()
  if (!force && now - t.publishedAt < 250) return
  t.publishedAt = now
  const catches: Record<string, number> = {}
  const names: Record<string, string> = {}
  for (const id of r.grid) {
    catches[ctx.carIdOn(id)] = t.catches.get(id) ?? 0
    names[ctx.carIdOn(id)] = ctx.nameOf(id)
  }
  const hunting = t.phase === 'count' || t.phase === 'play'
  const view: TurnsView = {
    raceId: r.raceId,
    hunterId: hunting && r.itId ? ctx.carIdOn(r.itId) : null,
    nextHunterId: t.phase === 'card' && r.itId ? ctx.carIdOn(r.itId) : null,
    turn: Math.min(t.order.length, t.index + 1),
    turns: t.order.length,
    goAt: turnGoAt(r, t, t.index),
    endsAt: turnEndsAt(r, t, t.index),
    cardUntil: t.phase === 'card' ? turnGoAt(r, t, t.index) - COUNT_MS : 0,
    catches,
    history: t.history.map((h) => ({ hunterId: ctx.carIdOn(h.hunter), catches: h.catches })),
    names,
    noCatchUntil: t.noCatchUntil,
    pulseReadyAt: t.pulseReadyAt,
    done: t.phase === 'done',
  }
  useGame.setState({ turns: view })
}
