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
export const PROTOCOL_VERSION = 2

/** The relay's port. A page can point somewhere else with ?relay=<port> (tests, checker previews). */
export const RELAY_PORT = 5202

/** The game's dev server port (the links `bun run mp` prints). */
export const GAME_PORT = 5201

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
} as const

export const POSE_FLOATS = 11
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

/** G / X pressed somewhere: everyone lines up and counts down. */
export interface StartMsg {
  t: 'start'
  kind: 'race' | 'tag'
  /** Random id for this race or round; every later message about it carries it. */
  raceId: number
  /** Shared crash-prop layout for this race (propsSignal.round). */
  round: number
  laps: number
  /** Tag only: round length in seconds, and the relay id who starts as "it". */
  seconds: number
  itId: number
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

export type ClientMsg = HelloMsg | StatsMsg | TrackMsg | PingMsg | StartMsg | FinishMsg | TagMsg | TagTimeMsg | PropMsg | BumpMsg | RejoinMsg

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
