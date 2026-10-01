// ============================================================
//  GHOST LAP - record your best lap, race a replay of it
// ------------------------------------------------------------
//  RECORD: while a lap is being timed, the player's car hands its
//  physics pose in here every step; every second step (30 Hz) lands
//  in preallocated Float32Arrays - no allocation while driving.
//  When a CLEAN lap completes AND beats the best, the buffer becomes
//  the ghost and is saved in localStorage under
//  `sr2.ghost.<trackKey>` (one ghost per track version). A void,
//  dirty or reset lap is thrown away and the buffer reused.
//
//  REPLAY: GhostCar.tsx reads the trace, time-synced to the player's
//  live lap clock (physics steps, so it is exact), and interpolates
//  between samples: linear position, slerped rotation.
//
//  STORAGE: positions and rotations as raw Float32 bytes, base64. A
//  two-minute lap is about 135 KB.
// ============================================================

import type * as THREE from 'three'
import { useGame } from '../core/store'
import { DT } from './tuning'

/** Samples per second. Physics is 60 Hz, so record every second step. */
export const GHOST_HZ = 30
const STEP_EVERY = Math.round(1 / (DT * GHOST_HZ))
const MAX_SECONDS = 360
const MAX_SAMPLES = GHOST_HZ * MAX_SECONDS
const FLOATS = 7 // x y z qx qy qz qw
const TRACE_VERSION = 1

export interface GhostTrace {
  lapMs: number
  /** The body that drove the lap; the ghost wears it. */
  body: string
  hz: number
  count: number
  /** FLOATS per sample: x, y, z, qx, qy, qz, qw. */
  data: Float32Array
}

function storageKey(trackKey: string): string {
  return `sr2.ghost.${trackKey}`
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[])
  return btoa(s)
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

// ---------------------------------------------------------------- the loaded ghost

let current: GhostTrace | null = null
let currentKey = ''

/** The ghost for the current track, or null. */
export function getGhost(): GhostTrace | null {
  return current
}

/** Load the stored ghost for a track (once per track key). */
export function loadGhost(trackKey: string): GhostTrace | null {
  if (trackKey === currentKey) return current
  currentKey = trackKey
  current = null
  try {
    const raw = localStorage.getItem(storageKey(trackKey))
    if (raw) {
      const o = JSON.parse(raw)
      if (o && o.v === TRACE_VERSION && typeof o.d === 'string' && Number.isFinite(o.n) && o.n >= 2 && Number.isFinite(o.lapMs)) {
        const bytes = fromBase64(o.d)
        if (bytes.byteLength >= o.n * FLOATS * 4) {
          const data = new Float32Array(bytes.buffer, 0, o.n * FLOATS)
          let ok = true
          for (let i = 0; i < data.length && ok; i++) ok = Number.isFinite(data[i])
          if (ok) current = { lapMs: o.lapMs, body: typeof o.body === 'string' ? o.body : 'dart', hz: o.hz || GHOST_HZ, count: o.n, data }
        }
      }
    }
  } catch (err) {
    console.warn('[ghost] stored ghost unreadable, ignoring it', err)
  }
  useGame.setState((s) => ({ ghostAvailable: current !== null, ghostVersion: s.ghostVersion + 1 }))
  return current
}

function saveGhost(trackKey: string, trace: GhostTrace): void {
  try {
    const bytes = new Uint8Array(trace.data.buffer, trace.data.byteOffset, trace.count * FLOATS * 4)
    localStorage.setItem(
      storageKey(trackKey),
      JSON.stringify({ v: TRACE_VERSION, lapMs: trace.lapMs, body: trace.body, hz: trace.hz, n: trace.count, d: toBase64(bytes) }),
    )
  } catch (err) {
    // Storage full or unavailable: the ghost still works this session, it just won't survive a reload.
    console.warn('[ghost] could not save the ghost lap', err)
  }
}

// ---------------------------------------------------------------- the recorder

class GhostRecorder {
  private readonly buf = new Float32Array(MAX_SAMPLES * FLOATS)
  private count = 0
  private phase = 0
  private active = false
  private body = 'dart'

  /** A timed lap began: record from sample 0. */
  start(body: string): void {
    this.active = true
    this.count = 0
    this.phase = 0
    this.body = body
  }

  /** The lap died (void, dirty, reset): stop and forget. */
  discard(): void {
    this.active = false
    this.count = 0
  }

  /** Every physics step while timing. A boolean when idle; seven writes every other step. */
  sample(p: THREE.Vector3, q: THREE.Quaternion): void {
    if (!this.active) return
    if (this.phase === 0) {
      if (this.count >= MAX_SAMPLES) {
        this.active = false // a lap this long is not going to be a best
        return
      }
      const o = this.count * FLOATS
      this.buf[o] = p.x
      this.buf[o + 1] = p.y
      this.buf[o + 2] = p.z
      this.buf[o + 3] = q.x
      this.buf[o + 4] = q.y
      this.buf[o + 5] = q.z
      this.buf[o + 6] = q.w
      this.count++
    }
    this.phase = (this.phase + 1) % STEP_EVERY
  }

  /** The lap was a new clean best: make it the ghost and save it. */
  commit(trackKey: string, lapMs: number): boolean {
    const n = this.count
    this.active = false
    if (n < 2) return false
    const data = new Float32Array(n * FLOATS)
    data.set(this.buf.subarray(0, n * FLOATS))
    current = { lapMs, body: this.body, hz: GHOST_HZ, count: n, data }
    currentKey = trackKey
    saveGhost(trackKey, current)
    useGame.setState((s) => ({ ghostAvailable: true, ghostVersion: s.ghostVersion + 1 }))
    return true
  }
}

export const ghostRecorder = new GhostRecorder()

/** Interpolated ghost pose `t` seconds into its lap. Returns false past the end. */
export function sampleGhost(trace: GhostTrace, t: number, outPos: THREE.Vector3, outQuat: THREE.Quaternion, qa: THREE.Quaternion, qb: THREE.Quaternion): boolean {
  const f = t * trace.hz
  if (f < 0 || !Number.isFinite(f)) return false
  const i = Math.floor(f)
  if (i >= trace.count - 1) return false
  const a = f - i
  const d = trace.data
  const o0 = i * FLOATS
  const o1 = o0 + FLOATS
  outPos.set(d[o0] + (d[o1] - d[o0]) * a, d[o0 + 1] + (d[o1 + 1] - d[o0 + 1]) * a, d[o0 + 2] + (d[o1 + 2] - d[o0 + 2]) * a)
  qa.set(d[o0 + 3], d[o0 + 4], d[o0 + 5], d[o0 + 6])
  qb.set(d[o1 + 3], d[o1 + 4], d[o1 + 5], d[o1 + 6])
  outQuat.slerpQuaternions(qa, qb, a)
  return true
}
