// ============================================================
//  MULTIPLAYER PROTOCOL - the wire format, shared by both ends
// ------------------------------------------------------------
//  Two kinds of traffic travel over one WebSocket:
//
//  BINARY - pose packets, the 60 times a second firehose. A client
//    sends a bare Float32Array of POSE_FLOATS numbers (see POSE below);
//    the relay glues a 4-byte sender id on the front and passes it to
//    everyone else. No timestamps cross the wire: clocks on two
//    machines never agree, so the receiver stamps each packet with its
//    OWN arrival time and draws the car 80 ms in the past (net/poses.ts).
//
//  JSON - everything that changes slowly: who I am (hello), how I'm
//    doing (stats, twice a second, which also keeps the line alive),
//    the host's track, race starts, tag rounds, prop bursts. The relay
//    stamps a `from` id onto everything it forwards.
//
//  server/relay.ts imports this file too, and Bun runs it directly,
//  so it must not import anything at runtime (type imports are fine:
//  they vanish when the code runs).
// ============================================================

import type { TrackFile } from '../track/schema'

/** Bump when the wire format changes, so old and new tabs refuse each other politely. */
export const PROTOCOL_VERSION = 5

/** The relay's port. A page can point somewhere else with ?relay=<port> (tests, checker previews). */
export const RELAY_PORT = 5202

/** The game's dev server port (the links `bun run mp` prints). */
export const GAME_PORT = 5201

/** The path the online game's relay answers on (cloud/worker.ts). */
export const CLOUD_RELAY_PATH = '/relay'

/**
 * Where a page finds its relay.
 *  - ?relay=<port>: that port on the page's own host (tests, checker previews), wss on an https page.
 *  - an https page (the online game on Cloudflare): the same address, path /relay, over wss.
 *  - otherwise (LAN play from `bun run mp`): ws://<the page's host>:5202.
 */
export function relayUrlFor(page: { protocol: string; host: string; hostname: string }, relayParam: string | null): string {
  const n = Number(relayParam)
  const port = relayParam !== null && relayParam !== '' && Number.isInteger(n) && n > 0 && n < 65536 ? n : null
  const secure = page.protocol === 'https:'
  if (port !== null) return `${secure ? 'wss' : 'ws'}://${page.hostname}:${port}`
  if (secure) return `wss://${page.host}${CLOUD_RELAY_PATH}`
  return `ws://${page.hostname}:${RELAY_PORT}`
}

/** Where each number sits inside a pose packet. */
export const POSE = {
  px: 0,
  py: 1,
  pz: 2,
  qx: 3,
  qy: 4,
  qz: 5,
  qw: 6,
  speedKmh: 7,
  /** 0..1 boost envelope (their FOV kick and trail flare). */
  boost: 8,
  /** 0..1 tyre slip (their light trail and skid look). */
  slip: 9,
  /** Bit flags, see POSE_FLAG. Stored as a float, read back with `| 0`. */
  flags: 10,
  /**
   * Race progress from the sender's OWN lap tracker (laps + fraction, slightly
   * negative on the grid behind the line). Everyone ranks racers by these same
   * numbers, never by their own guess from the drawn car.
   */
  progress: 11,
} as const

export const POSE_FLOATS = 12
export const POSE_BYTES = POSE_FLOATS * 4
/** relay -> client: uint32 sender id + the pose. */
export const TAGGED_POSE_BYTES = 4 + POSE_BYTES

export const POSE_FLAG = {
  airborne: 1,
  /** Frozen on the grid (countdown) - handy for the inspector, nothing else. */
  frozen: 2,
} as const

/** Biggest message the relay accepts (a big drawn track is well under this). */
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024

// ---------------------------------------------------------------- client -> everyone

/** Who I am and what I drive. Re-sent whenever any of it changes. */
export interface HelloMsg {
  t: 'hello'
  v: number
  name: string
  body: string
  paint: string
  glow: string
  trail: string
}

/** Twice a second: how I'm doing. Doubles as the keepalive. */
export interface StatsMsg {
  t: 'stats'
  /** The track I'm actually on (`TrackRuntime.key`), so cars on another track stay hidden. */
  trackKey: string | null
  /** Driving (true) or sitting in a menu / the editor (false). */
  driving: boolean
  lap: number
  lastLapMs: number | null
  bestLapMs: number | null
  /** My round-trip time to the relay, ms (the inspector shows it). */
  rttMs: number
  /** My Laps setting. The host's decides every multiplayer race (D2, 2 Nov 2026). Missing from older copies. */
  raceLaps?: number
}

/** The host's current track. Sent on connect, on every track change, and on a live param change. */
export interface TrackMsg {
  t: 'track'
  file: TrackFile
  /** Live parameters in effect on the host (e.g. { bankDeg: 32 }). */
  params: Record<string, number>
}

/** Latency check: the relay answers the sender alone with a pong carrying the same `c`. */
export interface PingMsg {
  t: 'ping'
  c: number
}

/**
 * Hunt Turns rules for one round, from the presser's knobs (config.ts / Settings), so every
 * computer plays by the same numbers.
 */
export interface TurnsRules {
  /** A catch by getting this close (metres between car centres), no contact needed. */
  catchReachM: number
  /** The tag pulse: how far it reaches (metres), how wide (degrees, whole cone), how often (ms). */
  pulseRangeM: number
  pulseConeDeg: number
  pulseCooldownMs: number
  /** A caught runner is thrown at least this far from the hunter (metres). */
  throwAwayM: number
  /** After a catch the hunter can't catch anyone for this long (ms). */
  noCatchMs: number
  /** Points a catch is worth to the hunter, and how far back (ms) a catch takes the runner's points. */
  catchPoints: number
  catchWipeMs: number
  /** Between two turns: settle + the turn card + the countdown (ms). */
  breakMs: number
}

/** G / X pressed somewhere: everyone lines up and counts down. */
export interface StartMsg {
  t: 'start'
  kind: 'race' | 'tag' | 'turns'
  /** Random id for this race or round; every later message about it carries it. */
  raceId: number
  /** Shared crash-prop layout for this race (propsSignal.round). */
  round: number
  laps: number
  /** Tag: round length in seconds (Hunt Turns: one turn's), and the relay id who starts as "it" (Hunt Turns: who hunts first). */
  seconds: number
  itId: number
  /** Hunt Turns only: the round's rules. */
  turns?: TurnsRules
  /** Relay ids on the grid, in slot order (sender's view; everyone uses it so grids match). */
  grid: number[]
}

/** "I crossed the line" - the first one of these per raceId wins; later ones still place. */
export interface FinishMsg {
  t: 'finish'
  raceId: number
  ms: number
  bestLapMs: number | null
}

/** Tag: the "it" player bumped someone, who is now "it". Sent by the old "it". */
export interface TagMsg {
  t: 'tag'
  raceId: number
  /** Relay id of the new "it". */
  itId: number
  /** How many hand-overs have happened this round (orders messages; stale ones are ignored). */
  seq: number
  /** The old "it" player's own total seconds as "it" (so everyone's table converges). */
  itSeconds: number
}

/** Tag: my own running total of seconds as "it", sent when I stop being "it" and at the end. */
export interface TagTimeMsg {
  t: 'tagTime'
  raceId: number
  seconds: number
}

/**
 * Hunt Turns: the hunter caught a runner. Only the hunter's computer decides (it saw the contact,
 * got close enough, its pulse hit, or the runner says "I touched you"), and sends this. The
 * runner's own computer throws its car far away. seq orders catches (an old one can't count twice).
 */
export interface CatchMsg {
  t: 'catch'
  raceId: number
  /** Turn of the round, 0-based. */
  turn: number
  seq: number
  /** Relay id of the runner caught. */
  runnerId: number
  how: 'touch' | 'reach' | 'pulse'
}

/** Hunt Turns: the hunter fired the tag pulse here, nose along (dx, dz): everyone sees the burst. */
export interface PulseMsg {
  t: 'pulse'
  raceId: number
  x: number
  y: number
  z: number
  dx: number
  dz: number
}

/**
 * Hunt Turns points: my own running points (what I scored as a runner, a catch's wipe already
 * taken off). Each computer owns its own: nobody else can work it out. A catch's points are not in
 * it: everyone adds catchPoints per catch themselves, from the catches they all count.
 */
export interface ScoreMsg {
  t: 'score'
  raceId: number
  run: number
}

/** A crash-prop cluster burst on the sender's machine. */
export interface PropMsg {
  t: 'prop'
  round: number
  cluster: number
  vx: number
  vy: number
  vz: number
}

/**
 * A ram, sent by the car that did the ramming. Each computer only simulates
 * its own car and sees everyone else as an immovable (kinematic) body, so the
 * rammer's own physics stops it dead and nothing would ever push the victim.
 * Instead the rammer works out the push (a velocity change, m/s) and sends
 * it; the victim adds it to its own car on its next physics step.
 */
export interface BumpMsg {
  t: 'bump'
  /** Relay id of the car that was hit. Everyone else ignores the message. */
  to: number
  dvx: number
  dvy: number
  dvz: number
}

/**
 * "I was player `oldId` in this race; my connection dropped and I'm back as a
 * new id." Everyone (and the relay's memory of the round) swaps the old id
 * for the sender's new one, so the racer keeps their grid place and result.
 */
export interface RejoinMsg {
  t: 'rejoin'
  raceId: number
  oldId: number
}

/**
 * Tag: "I touched you, and you're it." Sent by a player who rams the "it" car
 * (Hunt Turns: a runner who touched the hunter, so the hunter's computer can count the catch).
 * The bump shoves "it" away before its own screen sees the contact, so the
 * "it" player's computer (still the only one that decides) takes this claim
 * instead and passes "it" on if the no-tag-back time is over.
 */
export interface TagTouchMsg {
  t: 'tagTouch'
  raceId: number
  /** Relay id of the "it" player. */
  to: number
}

/**
 * Race order, published by ONE player (the lowest relay id still on the grid),
 * so every screen shows the same P1, P2... even when two cars are wheel to
 * wheel. Sent when the order changes and twice a second anyway.
 */
export interface PlacesMsg {
  t: 'places'
  raceId: number
  /** Relay ids, 1st first. */
  order: number[]
}

/**
 * "I've left this round" (changed mode or track, or went to the title or the
 * editor): everyone stops waiting for me in it (D3, 2 Nov 2026).
 */
export interface QuitMsg {
  t: 'quit'
  raceId: number
}

export type ClientMsg = HelloMsg | StatsMsg | TrackMsg | PingMsg | StartMsg | FinishMsg | TagMsg | TagTimeMsg | PropMsg | BumpMsg | RejoinMsg | TagTouchMsg | PlacesMsg | QuitMsg | CatchMsg | PulseMsg | ScoreMsg

// ---------------------------------------------------------------- relay -> client

/** Sent by the relay the moment a client connects. */
export interface WelcomeMsg {
  t: 'welcome'
  v: number
  id: number
  /** Relay id of the host (the machine running `bun run mp`). Can be this client. */
  hostId: number
  /** Everyone already connected. hello is null until that peer introduces itself. */
  peers: { id: number; hello: HelloMsg | null }[]
  /** The host's latest track, if the host has sent one. */
  track: TrackMsg | null
  /** The race or tag round in progress, if any (late joiners spectate it). */
  live: (StartMsg & { from: number; startedAgoMs: number }) | null
}

export interface JoinMsg {
  t: 'join'
  id: number
}

export interface LeaveMsg {
  t: 'leave'
  id: number
}

/** The host changed (the host left, or the real host came back). */
export interface HostMsg {
  t: 'host'
  id: number
}

export interface PongMsg {
  t: 'pong'
  c: number
}

export type RelayMsg = WelcomeMsg | JoinMsg | LeaveMsg | HostMsg | PongMsg | (Exclude<ClientMsg, PingMsg> & { from: number })

// ---------------------------------------------------------------- pose packing

/** Write a pose into `out` (reused every send - no allocation). */
export function encodePose(
  out: Float32Array,
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
  progress: number,
): Float32Array {
  out[POSE.px] = px
  out[POSE.py] = py
  out[POSE.pz] = pz
  out[POSE.qx] = qx
  out[POSE.qy] = qy
  out[POSE.qz] = qz
  out[POSE.qw] = qw
  out[POSE.speedKmh] = speedKmh
  out[POSE.boost] = boost
  out[POSE.slip] = slip
  out[POSE.flags] = flags
  out[POSE.progress] = progress
  return out
}

/**
 * NaN firewall for incoming poses: every number finite, a sane position
 * (inside 100 km) and a quaternion that is roughly unit length. A packet
 * that fails is dropped before it can reach rapier.
 */
export function poseIsSane(p: Float32Array): boolean {
  for (let i = 0; i < POSE_FLOATS; i++) if (!Number.isFinite(p[i])) return false
  if (Math.abs(p[POSE.px]) > 1e5 || Math.abs(p[POSE.py]) > 1e5 || Math.abs(p[POSE.pz]) > 1e5) return false
  const q2 = p[POSE.qx] * p[POSE.qx] + p[POSE.qy] * p[POSE.qy] + p[POSE.qz] * p[POSE.qz] + p[POSE.qw] * p[POSE.qw]
  return q2 > 0.8 && q2 < 1.2
}
