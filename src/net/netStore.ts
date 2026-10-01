// ============================================================
//  NET STORE - multiplayer state that changes rarely
// ------------------------------------------------------------
//  Same split as core/store.ts versus core/telemetry.ts: things
//  that change a few times a minute (connected or not, who is here,
//  who hosts) live in this zustand store so menus and the HUD can
//  re-render on them. The fast stuff never comes here:
//    - poses (60 a second)          -> net/poses.ts ring buffers
//    - per-peer stats (2 a second)  -> `peerLive` below, a plain Map
//
//  UI reads:
//    useNet((s) => s.isHost)      grey out track select on joiners
//    useNet((s) => s.status)      'online' / 'connecting' badge
//    useNet((s) => s.peers)       the player list
// ============================================================

import { create } from 'zustand'

export type NetStatus =
  | 'off' //             not a multiplayer page (no ?mp=1)
  | 'connecting' //      looking for the relay (retries forever)
  | 'online' //          connected
  | 'version-mismatch' // the relay or the other tabs run a different build

export interface PeerInfo {
  /** Relay id (a number the relay hands out; a reload gets a new one). */
  id: number
  /** Car id in core/telemetry `cars`: 'net-<id>'. */
  carId: string
  name: string
  body: string
  paint: string
  glow: string
  trail: string
}

/** Per-peer numbers that update twice a second. Mutated in place; never React state. */
export interface PeerLive {
  trackKey: string | null
  driving: boolean
  lap: number
  lastLapMs: number | null
  bestLapMs: number | null
  /** Their round trip to the relay, ms. */
  rttMs: number
  /** performance.now() of their last stats message. */
  statsAt: number
}

export interface NetState {
  status: NetStatus
  /** Our relay id (0 until welcomed). */
  myId: number
  /** The host's relay id (0 = nobody yet). */
  hostId: number
  /** True when this browser is the host: it picks the track, everyone else follows. */
  isHost: boolean
  relayUrl: string
  /** Our smoothed round trip to the relay, ms. */
  rttMs: number
  /** Peers that have introduced themselves (said hello), by relay id. Only these get a car. */
  peers: Record<number, PeerInfo>
  /** The last track the host sent us (joiners), for the menu: "Track: <name> (from the host)". */
  hostTrack: { id: string; name: string } | null
  /** Set when the host's track could not be built here (shown in the menu). */
  trackError: string | null
}

export const useNet = create<NetState>(() => ({
  status: 'off',
  myId: 0,
  hostId: 0,
  isHost: false,
  relayUrl: '',
  rttMs: 0,
  peers: {},
  hostTrack: null,
  trackError: null,
}))

export function getNet(): NetState {
  return useNet.getState()
}

/** Twice-a-second peer numbers, by relay id. */
export const peerLive = new Map<number, PeerLive>()

export function liveFor(id: number): PeerLive {
  let l = peerLive.get(id)
  if (!l) {
    l = { trackKey: null, driving: false, lap: 0, lastLapMs: null, bestLapMs: null, rttMs: 0, statsAt: 0 }
    peerLive.set(id, l)
  }
  return l
}

export function carIdFor(relayId: number): string {
  return `net-${relayId}`
}

/** Relay id from a car id ('net-7' -> 7), or 0 if it isn't a remote car. */
export function relayIdOf(carId: string): number {
  return carId.startsWith('net-') ? Number(carId.slice(4)) || 0 : 0
}

