// ============================================================
//  CROSS-MODULE APIS
// ------------------------------------------------------------
//  CONTRACT (orchestrator-owned).
//
//  A few systems need to call into each other: gameplay asks the fx
//  system for a shard burst, menus ask audio for a click, the garage
//  asks the vehicle module what cars exist. Instead of importing each
//  other directly (which tangles the modules and their ownership),
//  each system INSTALLS its implementation into the registry below
//  when it mounts. Callers just call.
//
//  Until a system installs itself, calls are quiet no-ops, so modules
//  can be built and tested in any order. In the finished game every
//  slot is installed (checked by window.__game.apiInstalled()).
// ============================================================

import type * as THREE from 'three'

// ---------------------------------------------------------------- fx (owner: look)

export interface BurstOptions {
  position: { x: number; y: number; z: number }
  /** Average outward velocity (m/s) to bias the burst, e.g. the car's velocity. */
  velocity?: { x: number; y: number; z: number }
  color: string
  /** Pieces in the burst (pooled; the fx system caps it). */
  count: number
  /** Spread speed, m/s. */
  speed: number
  /** Piece size in metres (default 0.25). */
  size?: number
  /** Seconds the pieces live (default 1.6). */
  life?: number
}

export interface FxApi {
  /** Glowing shards bursting out (crash props, smashables, energy cubes). Pooled, instanced. */
  shards: (o: BurstOptions) => void
  /** Hot sparks from a scrape or impact at a point. */
  sparks: (position: { x: number; y: number; z: number }, normal: { x: number; y: number; z: number }, intensity: number) => void
  /** A ring/flash pulse (pickups, boost kick, finish line). */
  pulse: (position: { x: number; y: number; z: number }, color: string, radius: number) => void
}

// ---------------------------------------------------------------- audio (owner: audio)

export type UiSound = 'move' | 'select' | 'back' | 'toggle' | 'slide' | 'start' | 'error' | 'countdown' | 'go'

export interface AudioApi {
  /** Menu sounds. */
  ui: (kind: UiSound) => void
  /** Try to start/resume the AudioContext (call from any user gesture handler). */
  unlock: () => void
  /** True once sound is actually running. */
  isRunning: () => boolean
}

// ---------------------------------------------------------------- vehicle catalog (owner: vehicle)

export interface CarBodyInfo {
  id: string
  name: string
  /** One line for the garage. */
  blurb: string
  /** 0..1 bars for the garage (display only; real handling comes from the body's tuning). */
  stats: { speed: number; grip: number; weight: number }
}

export interface VehicleApi {
  bodies: () => readonly CarBodyInfo[]
  /**
   * Build a display copy of a car body (garage preview, editor marker).
   * The returned group is owned by the caller (dispose with disposeModel).
   */
  buildModel: (bodyId: string, paint: string, glow: string) => THREE.Group
  disposeModel: (model: THREE.Group) => void
}

// ---------------------------------------------------------------- simulated cars (owner: vehicle)
//
// The player's car and every Ai racer run the SAME raycast-car physics.
// src/vehicle/index.tsx exports `SimCar` (props below). The play worker
// mounts one <SimCar> per Ai racer inside <Physics> and drives it with a
// Driver. The vehicle worker owns the sim; play owns the driving brain.

/** Writes a car's controls once per physics step. */
export interface Driver {
  throttle: number //  0..1
  brake: number //     0..1 (reverse when stopped)
  steer: number //     -1..1, left negative
  handbrake: boolean
  /** Engine power multiplier this step (Ai difficulty and catch-up). Treat undefined as 1. */
  powerScale?: number
  /** Called at the start of every physics step, before forces. Read the car, write the controls. */
  update: (car: import('./telemetry').CarState, dt: number) => void
}

export interface SimCarProps {
  id: string //       'ai-1' ...
  name: string
  body: string
  paint: string
  glow: string
  trail: string
  /** Start grid slot (track.gridSlot) - the car spawns there. */
  gridSlot: number
  driver: Driver
}

// ---------------------------------------------------------------- play (owner: play)

export interface PlayApi {
  /** Start a fresh round of the current mode (re-scatter props/cores, reset clocks). */
  newRound: () => void
  /** Restart the current session from the countdown/start (results screen "Again"). */
  restartSession: () => void
}

// ---------------------------------------------------------------- registry

const noop = () => {}

export const fx: FxApi = { shards: noop, sparks: noop, pulse: noop }
export const audio: AudioApi = { ui: noop, unlock: noop, isRunning: () => false }
export const vehicle: VehicleApi = {
  bodies: () => [],
  buildModel: () => {
    throw new Error('vehicle API not installed yet')
  },
  disposeModel: noop,
}
export const play: PlayApi = { newRound: noop, restartSession: noop }

const installed = { fx: false, audio: false, vehicle: false, play: false }

export function installFx(impl: FxApi): void {
  Object.assign(fx, impl)
  installed.fx = true
}
export function installAudio(impl: AudioApi): void {
  Object.assign(audio, impl)
  installed.audio = true
}
export function installVehicle(impl: VehicleApi): void {
  Object.assign(vehicle, impl)
  installed.vehicle = true
}
export function installPlay(impl: PlayApi): void {
  Object.assign(play, impl)
  installed.play = true
}

export function apiInstalled(): Readonly<typeof installed> {
  return installed
}
