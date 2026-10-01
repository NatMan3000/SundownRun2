// ============================================================
//  SPAWN - every player starts on their own spot
// ------------------------------------------------------------
//  The vehicle spawns the player's car on grid slot 0 (the pole).
//  That's right when you're alone, but in multiplayer EVERY player's
//  car would appear on the same spot and they'd land in each other
//  (a checker once saw the host sit on the joiner's roof for 23 s).
//
//  So in multiplayer, each player gets their own grid slot: their
//  place in the sorted list of everyone connected (relay ids). Net
//  writes it to store.playerGridSlot and the vehicle spawns and
//  restarts the car there directly; net also moves the car itself
//  (teleport) if it ever finds it somewhere else. Every computer works that list out the same way, so
//  nobody shares a slot, with no messages needed. It happens:
//    - when a drive starts (session.start)
//    - when the track changes (the host picked another one)
//    - when we first join while driving (not on a reconnect)
//    - after Shift+R (restart at the line)
//  but never in the middle of a synced race or tag round (rounds.ts
//  lines everyone up itself).
//
//  Until our car is on its slot, NetLayer sends no poses, so no other
//  screen ever draws it inside someone else's car.
//
//  Belt and braces: for SPAWN_GRACE_MS after we spawn, other cars are
//  see-through (RemoteCars reads spawnGraceActive()), so even a car
//  that hasn't moved yet can't launch us.
// ============================================================

import * as THREE from 'three'
import { getGame, useGame } from '../core/store'
import { getCar } from '../core/telemetry'
import { on } from '../core/events'
import { getTrack } from '../track/current'
import { getNet, useNet } from './netStore'
import { previousId, weAreDriving } from './client'
import { currentRound } from './rounds'

/** Other cars are see-through this long after we spawn, ms. */
export const SPAWN_GRACE_MS = 1500

let pending = false
let graceUntil = 0
/** Counters for the inspector. */
export const spawnStats = { spawns: 0, lastSlot: -1 }

/** True while other cars should not collide with us (just spawned). */
export function spawnGraceActive(now: number): boolean {
  return now < graceUntil
}

/** Our grid slot: our place among everyone connected, by relay id. */
export function mySlot(): number {
  const net = getNet()
  if (!net.myId) return 0
  let rank = 0
  for (const key of Object.keys(net.peers)) if (Number(key) < net.myId) rank++
  return rank
}

/** True while our car may still be sitting on someone else's slot (poses are held back). */
export function spawnPending(): boolean {
  return pending
}

/** Keep store.playerGridSlot = our slot, so the vehicle spawns and restarts us there directly. */
function publishSlot(): void {
  if (!getGame().multiplayer) return
  const slot = getNet().myId ? mySlot() : 0
  if (getGame().playerGridSlot !== slot) useGame.setState({ playerGridSlot: slot })
}

/** Ask for our car to be moved to our slot as soon as it exists. */
export function requestSpawn(): void {
  if (!getGame().multiplayer) return
  pending = true
  graceUntil = performance.now() + SPAWN_GRACE_MS
}

const _pos = new THREE.Vector3()
const _quat = new THREE.Quaternion()

/** Every frame (NetLayer): do a pending spawn once our car and track are ready. */
export function spawnTick(): void {
  if (!pending) return
  const net = getNet()
  if (net.status !== 'online' || !net.myId || !weAreDriving()) return
  const r = currentRound()
  if (r && !r.ended && r.inGrid) {
    // A synced round already put us on the grid.
    pending = false
    return
  }
  const track = getTrack()
  const player = getCar('player')
  if (!track || !player?.api) return
  const slot = mySlot()
  track.gridSlot(slot, _pos, _quat)
  // The vehicle spawns us on store.playerGridSlot already; only move the car
  // if it isn't there (joined while driving, or an older vehicle build).
  if (player.position.distanceToSquared(_pos) > 1) player.api.teleport(_pos, _quat)
  pending = false
  graceUntil = performance.now() + SPAWN_GRACE_MS
  spawnStats.spawns++
  spawnStats.lastSlot = slot
}

let wired = false
let unsubs: (() => void)[] = []

export function startSpawns(): void {
  if (wired) return
  wired = true
  unsubs.push(
    on('session.start', () => requestSpawn()),
    // Shift+R puts the car back on slot 0: move it to ours.
    on('reset', (e) => {
      if (e.kind === 'start') requestSpawn()
    }),
    // A new track rebuilds the physics world and the car respawns on slot 0.
    useGame.subscribe((s, prev) => {
      if (s.trackVersion !== prev.trackVersion) requestSpawn()
    }),
    // Joined while already driving: we may be on someone's spot. (Not on a
    // reconnect: everyone's copy of our car is already where we are.)
    useNet.subscribe((s, prev) => {
      if (s.myId && s.myId !== prev.myId && previousId() === 0) requestSpawn()
      if (s.myId !== prev.myId || s.peers !== prev.peers) publishSlot()
    }),
  )
}

export function stopSpawns(): void {
  for (const u of unsubs) u()
  unsubs = []
  wired = false
  pending = false
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => stopSpawns())
}
