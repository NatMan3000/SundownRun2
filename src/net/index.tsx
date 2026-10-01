// ============================================================
//  NET LAYER - LAN multiplayer, mounted inside <Physics>
// ------------------------------------------------------------
//  Does nothing at all unless the page was opened with ?mp=1
//  (store.multiplayer, set by boot from the URL).
//
//  How the pieces fit:
//    protocol.ts    the wire format (shared with server/relay.ts)
//    identity.ts    your name and colour, from the link
//    client.ts      the one WebSocket (survives track changes)
//    poses.ts       other players' recent poses, interpolated
//    netStore.ts    who's here, who hosts (React state for the UI)
//    trackSync.ts   the host's track file goes to everyone
//    RemoteCars.tsx other players' cars: solid, smooth, name-tagged
//    this file      starts it all and streams OUR pose 60x a second
//
//  This component is rebuilt on every track change (it lives inside
//  the keyed <Physics>), so it only USES the connection; it never
//  opens or closes it.
//
//  Dev: window.__game.get('net') shows the connection and every
//  peer; window.__dev.net('help') lists commands.
// ============================================================

import { useEffect, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { useGame } from '../core/store'
import { getCar, telemetry } from '../core/telemetry'
import { registerDev, registerInspector } from '../core/devHandles'
import { driveOverride } from '../core/controls'
import { useSettings } from '../core/settings'
import { resumeGame } from '../core/session'
import { propsSignal } from '../core/propsSignal'
import { getCurrentTrackFile, getTrack, loadTrackById, setTrackFromFile } from '../track/current'
import { getTrackSource, saveDrawnTrack } from '../track/registry'
import { applyUrlColor, mpEnabled, playerName } from './identity'
import { connectionInfo, dropConnection, reconnectNow, sendPose, startNet, weAreDriving } from './client'
import { getNet, peerLive } from './netStore'
import { STALE_MS, peerPoses } from './poses'
import { POSE_FLAG } from './protocol'
import { sendTrackIfHost, startTrackSync } from './trackSync'
import { RemoteCars } from './RemoteCars'
import { BumpApplier, startBumps, stats as bumpStats } from './bump'
import { mySlot, spawnStats, spawnTick, startSpawns } from './spawn'
import { canTag, currentRound, requestStart, roundsTick, startRounds } from './rounds'

export { useNet } from './netStore'
/**
 * For ui: the results screen's "Again" in multiplayer, or any start button.
 * Same as pressing G / X: a race, or a tag round in tag mode, for everyone.
 * Returns false if it couldn't start (offline, a round is on, not driving,
 * or tag with fewer than two players).
 */
export { requestStart as startMultiplayerRound } from './rounds'
export type { NetState, NetStatus, PeerInfo } from './netStore'

// ?color= goes onto our own car before anything builds it (this module loads
// before boot and before the first render).
if (mpEnabled()) applyUrlColor()

/** Pose packets per second. */
const SEND_HZ = 60
const SEND_MS = 1000 / SEND_HZ

/** Streams the local car's pose. Reads core/telemetry, so the vehicle code needs no changes. */
function PoseSender() {
  const nextSend = useRef(0)
  useFrame(() => {
    const now = performance.now()
    if (now < nextSend.current) return
    // Keep a steady 60 a second at any refresh rate (165 Hz, 144 Hz, 60 Hz).
    nextSend.current = Math.max(nextSend.current + SEND_MS, now - SEND_MS)
    if (!weAreDriving() || !getCar('player')) return
    const p = telemetry.carPosition
    const q = telemetry.carQuaternion
    sendPose(p.x, p.y, p.z, q.x, q.y, q.z, q.w, telemetry.speedKmh, telemetry.boost, telemetry.slip, telemetry.airborne ? POSE_FLAG.airborne : 0)
  })
  return null
}

/** Runs the race / tag clock, watches G / X, and puts our car on its own spawn slot. */
function RoundsTicker() {
  useFrame((_, dt) => {
    roundsTick(Math.min(dt, 0.1))
    spawnTick()
  })
  return null
}

export function NetLayer() {
  const multiplayer = useGame((s) => s.multiplayer)
  useEffect(() => {
    if (!multiplayer) return
    startNet()
    startTrackSync()
    startRounds()
    startBumps()
    startSpawns()
    registerNetDev()
  }, [multiplayer])
  if (!multiplayer) return null
  return (
    <>
      <PoseSender />
      <RoundsTicker />
      <BumpApplier />
      <RemoteCars />
    </>
  )
}

// ---------------------------------------------------------------- dev handles

let devRegistered = false

/** What window.__game.get('net') returns. */
function inspect() {
  const net = getNet()
  const now = performance.now()
  const track = getTrack()
  return {
    status: net.status,
    relay: net.relayUrl,
    name: playerName(),
    id: net.myId,
    hostId: net.hostId,
    isHost: net.isHost,
    rttMs: net.rttMs,
    hostTrack: net.hostTrack,
    trackError: net.trackError,
    myTrackKey: track?.key ?? null,
    ...connectionInfo(),
    round: roundSummary(),
    bumps: { ...bumpStats },
    spawn: { slot: mySlot(), ...spawnStats },
    peers: Object.values(net.peers).map((p) => {
      const buf = peerPoses.get(p.id)
      const live = peerLive.get(p.id)
      const ageMs = buf && buf.lastRecv ? Math.round(now - buf.lastRecv) : null
      return {
        id: p.id,
        carId: p.carId,
        name: p.name,
        body: p.body,
        glow: p.glow,
        // Their latency to us is roughly half their round trip plus half ours.
        latencyMs: Math.round(((live?.rttMs ?? 0) + net.rttMs) / 2),
        rttMs: live?.rttMs ?? null,
        driving: live?.driving ?? false,
        sameTrack: !!track && live?.trackKey === track.key,
        lap: live?.lap ?? 0,
        packets: buf?.received ?? 0,
        lastPacketAgoMs: ageMs,
        fresh: ageMs !== null && ageMs < STALE_MS,
        inCars: !!getCar(p.carId),
      }
    }),
  }
}

function roundSummary() {
  const r = currentRound()
  if (!r) return null
  return {
    kind: r.kind,
    raceId: r.raceId,
    grid: r.grid,
    inGrid: r.inGrid,
    started: r.started,
    ended: r.ended,
    goInMs: Math.round(r.goAt - performance.now()),
    laps: r.laps,
    finishes: [...r.finishes.entries()].map(([id, f]) => ({ id, ms: f.ms })),
    itId: r.itId,
    tagSeq: r.seq,
    itSeconds: Object.fromEntries([...r.seconds.entries()].map(([id, sec]) => [id, Math.round(sec * 10) / 10])),
    endsInMs: r.kind === 'tag' ? Math.round(r.endsAt - performance.now()) : null,
  }
}

const NET_HELP = `net(cmd): 'status' (same as __game.get('net')), 'start' (same as pressing G: a race, or a tag round in tag mode), 'drop' (cut the connection; it heals by itself), 'reconnect' (reconnect now), 'resendTrack' (host: send the track again)`

function netCommand(cmd: string = 'status'): unknown {
  switch (cmd) {
    case 'status':
      return inspect()
    case 'start':
      return requestStart() ? 'started' : 'not started (offline, a round is on, not driving, or tag with fewer than two players)'
    case 'drop':
      dropConnection()
      return 'dropped - reconnecting with backoff'
    case 'reconnect':
      reconnectNow()
      return 'reconnecting'
    case 'resendTrack':
      sendTrackIfHost(true)
      return getNet().isHost ? 'sent' : 'not the host'
    case 'help':
      return NET_HELP
    default:
      return `unknown command "${cmd}". ${NET_HELP}`
  }
}

/**
 * The test kit: handles the two-client check (server/mp-check*.ts) drives the
 * game with. Reached through the dev-handle registry, so it works in a built
 * preview too (checkers verify builds, where /src modules don't exist).
 * Everything here is an existing contract API; nothing new is exposed.
 */
const netKit = {
  driveOverride,
  getTrack,
  getCurrentTrackFile,
  setTrackFromFile,
  loadTrackById,
  saveDrawnTrack,
  getTrackSource,
  useSettings,
  useGame,
  resumeGame,
  propsSignal,
  telemetry,
  getCar,
  net: { getNet, peerPoses, sendPose, dropConnection, reconnectNow },
  rounds: { requestStart, currentRound, canTag },
}

function registerNetDev(): void {
  if (devRegistered) return
  devRegistered = true
  registerInspector('net', inspect)
  registerInspector('netKit', () => netKit)
  registerDev('net', netCommand as (...args: never[]) => unknown, NET_HELP)
}
