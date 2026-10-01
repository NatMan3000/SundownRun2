// ============================================================
//  NET CLIENT - the one WebSocket to the relay
// ------------------------------------------------------------
//  Lives in a module, not a React component, on purpose: <NetLayer />
//  sits inside <Physics>, which is rebuilt on every track change. The
//  connection must survive that, so components only USE it.
//
//  Where it connects: ws://<the page's own host>:5202. The computer
//  that serves the game page also runs the relay, so the page's own
//  address is always right, on every machine, with zero setup.
//
//  What it does:
//    - connects, and reconnects forever with a gentle backoff
//      (0.5 s, 1 s, 2 s ... capped at 5 s), so a relay restart or a
//      napping laptop heals without anyone touching anything
//    - keeps the pose ring buffers fed (binary packets)
//    - sends hello whenever our car or colours change
//    - sends stats twice a second (doubles as the keepalive: hidden
//      tabs stop drawing frames, but timers still tick)
//    - pings every 2 s to measure the round trip
//    - hands every other message to whoever registered for it
//      (trackSync, race, tag, props) through onMessage()
// ============================================================

import { getGame, useGame } from '../core/store'
import { getSettings, useSettings } from '../core/settings'
import { emit } from '../core/events'
import { getTrack } from '../track/current'
import { playerName, relayPort } from './identity'
import { carIdFor, liveFor, peerLive, useNet } from './netStore'
import type { PeerInfo } from './netStore'
import { peerPoses, poseBufferFor } from './poses'
import { POSE_FLOATS, PROTOCOL_VERSION, TAGGED_POSE_BYTES, encodePose, poseIsSane } from './protocol'
import type { ClientMsg, HelloMsg, RelayMsg, StatsMsg, WelcomeMsg } from './protocol'

// ---------------------------------------------------------------- message handlers

type Handler = (msg: RelayMsg) => void
const handlers = new Map<string, Set<Handler>>()

/**
 * Listen for one kind of relay message ('track', 'start', 'welcome'...).
 * Returns an unsubscribe function.
 */
export function onMessage<T extends RelayMsg['t']>(type: T, fn: (msg: Extract<RelayMsg, { t: T }>) => void): () => void {
  let set = handlers.get(type)
  if (!set) {
    set = new Set()
    handlers.set(type, set)
  }
  set.add(fn as Handler)
  return () => {
    set.delete(fn as Handler)
  }
}

function dispatch(msg: RelayMsg): void {
  const set = handlers.get(msg.t)
  if (!set) return
  for (const fn of set) {
    try {
      fn(msg)
    } catch (err) {
      console.error(`[net] handler for "${msg.t}" failed`, err)
    }
  }
}

// ---------------------------------------------------------------- connection

let ws: WebSocket | null = null
let started = false
let retryTimer: ReturnType<typeof setTimeout> | null = null
let retryDelay = 500
let pingTimer: ReturnType<typeof setInterval> | null = null
let statsTimer: ReturnType<typeof setInterval> | null = null
let unsubs: (() => void)[] = []
let warnedBadPose = false
/** Wall-clock moment we last (re)connected, for the inspector. */
let connectedAt = 0
let reconnects = 0

export function isOpen(): boolean {
  return ws !== null && ws.readyState === WebSocket.OPEN
}

/** Send a JSON message to everyone (via the relay). Quietly dropped while offline. */
export function send(msg: ClientMsg): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false
  ws.send(JSON.stringify(msg))
  return true
}

/** Start multiplayer (idempotent - safe to call from every NetLayer mount). */
export function startNet(): void {
  if (started) return
  started = true
  const url = `ws://${window.location.hostname}:${relayPort()}`
  useNet.setState({ status: 'connecting', relayUrl: url })
  open()

  pingTimer = setInterval(() => send({ t: 'ping', c: performance.now() }), 2000)
  statsTimer = setInterval(sendStats, 500)

  // Re-introduce ourselves when the car or its colours change (garage).
  unsubs.push(
    useSettings.subscribe((s, prev) => {
      if (s.carBody !== prev.carBody || s.paint !== prev.paint || s.glow !== prev.glow || s.trail !== prev.trail) sendHello()
    }),
  )
  // Send stats straight away when the phase changes: a joiner leaving the
  // editor (or the title screen) shows up for everyone without a wait.
  unsubs.push(
    useGame.subscribe((s, prev) => {
      if (s.phase !== prev.phase) sendStats()
    }),
  )
  // A reload or tab close can abandon the socket without a goodbye; say it properly.
  window.addEventListener('pagehide', closeForGood)
}

/** Stop everything (HMR, page leaving). */
export function stopNet(): void {
  closeForGood()
  window.removeEventListener('pagehide', closeForGood)
}

function closeForGood(): void {
  started = false
  if (retryTimer) clearTimeout(retryTimer)
  if (pingTimer) clearInterval(pingTimer)
  if (statsTimer) clearInterval(statsTimer)
  retryTimer = pingTimer = statsTimer = null
  for (const u of unsubs) u()
  unsubs = []
  const sock = ws
  ws = null
  sock?.close()
  forgetPeers()
  useNet.setState({ status: 'off', myId: 0, hostId: 0, isHost: false })
}

/** Dev: drop the connection as if the wifi blinked (it reconnects by itself). */
export function dropConnection(): void {
  ws?.close()
}

/** Dev: reconnect right now instead of waiting for the backoff. */
export function reconnectNow(): void {
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
  retryDelay = 500
  if (ws) ws.close()
  else open()
}

function open(): void {
  if (!started) return
  if (ws && ws.readyState <= WebSocket.OPEN) return
  const url = useNet.getState().relayUrl
  let sock: WebSocket
  try {
    sock = new WebSocket(url)
  } catch (err) {
    console.warn('[net] could not open', url, err)
    scheduleRetry()
    return
  }
  sock.binaryType = 'arraybuffer'
  ws = sock

  sock.onopen = () => {
    retryDelay = 500
    connectedAt = performance.now()
    sendHello()
  }
  sock.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) {
      receivePose(ev.data)
      return
    }
    let msg: RelayMsg
    try {
      msg = JSON.parse(String(ev.data)) as RelayMsg
    } catch {
      return
    }
    receive(msg)
  }
  // onerror always comes before onclose; the close handler owns recovery.
  sock.onclose = () => {
    if (ws !== sock) return
    ws = null
    forgetPeers()
    if (!started) return
    useNet.setState({ status: 'connecting', myId: 0, isHost: false })
    reconnects++
    scheduleRetry()
  }
}

function scheduleRetry(): void {
  if (!started || retryTimer) return
  retryTimer = setTimeout(() => {
    retryTimer = null
    open()
  }, retryDelay)
  retryDelay = Math.min(5000, retryDelay * 2)
}

/** Everyone vanishes from our world when the connection drops; they come back with the welcome. */
function forgetPeers(): void {
  const peers = useNet.getState().peers
  for (const id of Object.keys(peers)) peerPoses.delete(Number(id))
  peerPoses.clear()
  peerLive.clear()
  useNet.setState({ peers: {} })
}

// ---------------------------------------------------------------- receive

const _incoming = new Float32Array(POSE_FLOATS)

function receivePose(buf: ArrayBuffer): void {
  if (buf.byteLength !== TAGGED_POSE_BYTES) return
  const id = new DataView(buf).getUint32(0, true)
  const floats = new Float32Array(buf, 4, POSE_FLOATS)
  _incoming.set(floats)
  // NaN firewall: a broken packet never reaches the buffers (or rapier).
  if (!poseIsSane(_incoming)) {
    if (!warnedBadPose) {
      warnedBadPose = true
      console.warn(`[net] dropped a broken pose packet from player ${id} (further ones dropped quietly)`)
    }
    return
  }
  poseBufferFor(id).push(performance.now(), _incoming)
}

function peerFromHello(id: number, h: HelloMsg): PeerInfo {
  return { id, carId: carIdFor(id), name: h.name, body: h.body, paint: h.paint, glow: h.glow, trail: h.trail }
}

function upsertPeer(id: number, h: HelloMsg, announce: boolean): void {
  if (h.v !== PROTOCOL_VERSION) return
  const peers = useNet.getState().peers
  const isNew = !peers[id]
  useNet.setState({ peers: { ...peers, [id]: peerFromHello(id, h) } })
  if (announce && isNew) emit('mp.join', { name: h.name, id: carIdFor(id) })
}

function removePeer(id: number): void {
  const peers = useNet.getState().peers
  const p = peers[id]
  peerPoses.delete(id)
  peerLive.delete(id)
  if (!p) return
  const next = { ...peers }
  delete next[id]
  useNet.setState({ peers: next })
  emit('mp.leave', { name: p.name, id: p.carId })
}

function setHost(hostId: number): void {
  const myId = useNet.getState().myId
  useNet.setState({ hostId, isHost: hostId !== 0 && hostId === myId })
}

function receive(msg: RelayMsg): void {
  switch (msg.t) {
    case 'welcome':
      onWelcome(msg)
      break
    case 'join':
      // A connection, not yet a car: the peer appears when its hello lands.
      break
    case 'leave':
      removePeer(msg.id)
      break
    case 'host':
      setHost(msg.id)
      break
    case 'pong': {
      const rtt = performance.now() - msg.c
      if (Number.isFinite(rtt) && rtt >= 0) {
        const prev = useNet.getState().rttMs
        useNet.setState({ rttMs: Math.round(prev === 0 ? rtt : prev * 0.7 + rtt * 0.3) })
      }
      break
    }
    case 'hello':
      upsertPeer(msg.from, msg, true)
      break
    case 'stats': {
      const l = liveFor(msg.from)
      l.trackKey = msg.trackKey
      l.driving = msg.driving
      l.lap = msg.lap
      l.lastLapMs = msg.lastLapMs
      l.bestLapMs = msg.bestLapMs
      l.rttMs = msg.rttMs
      l.statsAt = performance.now()
      break
    }
  }
  dispatch(msg)
}

function onWelcome(msg: WelcomeMsg): void {
  if (msg.v !== PROTOCOL_VERSION) {
    console.error(`[net] the relay speaks protocol ${msg.v}, this page speaks ${PROTOCOL_VERSION}. Reload every tab and restart bun run mp.`)
    useNet.setState({ status: 'version-mismatch' })
    started = false
    ws?.close()
    return
  }
  useNet.setState({ status: 'online', myId: msg.id, rttMs: 0 })
  setHost(msg.hostId)
  // People who were already here: no join fanfare.
  for (const p of msg.peers) if (p.hello) upsertPeer(p.id, p.hello, false)
}

// ---------------------------------------------------------------- send

export function sendHello(): void {
  const s = getSettings()
  send({ t: 'hello', v: PROTOCOL_VERSION, name: playerName(), body: s.carBody, paint: s.paint, glow: s.glow, trail: s.trail })
}

const DRIVING_PHASES = new Set(['playing', 'paused', 'results'])

/** True while our car is out on the track (poses are worth sending). */
export function weAreDriving(): boolean {
  return DRIVING_PHASES.has(getGame().phase)
}

/** Extra stats other net modules add (race lap). Kept tiny on purpose. */
export const statsExtra = { lap: -1 }

function sendStats(): void {
  const g = getGame()
  const msg: StatsMsg = {
    t: 'stats',
    trackKey: getTrack()?.key ?? null,
    driving: weAreDriving(),
    lap: statsExtra.lap >= 0 ? statsExtra.lap : g.lapCount,
    lastLapMs: g.lastLapMs,
    bestLapMs: g.bestLapMs,
    rttMs: useNet.getState().rttMs,
  }
  send(msg)
}

const _poseOut = new Float32Array(POSE_FLOATS)

/** One pose packet. Called by NetLayer's frame loop (60 a second). No allocation. */
export function sendPose(
  px: number,
  py: number,
  pz: number,
  qx: number,
  qy: number,
  qz: number,
  qw: number,
  speedKmh: number,
  boost: number,
  slip: number,
  flags: number,
): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  encodePose(_poseOut, px, py, pz, qx, qy, qz, qw, speedKmh, boost, slip, flags)
  // Never send a broken pose: everyone else would just drop it anyway.
  if (!poseIsSane(_poseOut)) return
  ws.send(_poseOut)
}

/** Inspector numbers. */
export function connectionInfo() {
  return {
    open: isOpen(),
    connectedForS: isOpen() ? Math.round((performance.now() - connectedAt) / 1000) : 0,
    reconnects,
    retryInMs: retryTimer ? retryDelay : 0,
  }
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => stopNet())
}
