// ============================================================
//  REWIND - hold Backspace (or LB) and time runs backwards
// ------------------------------------------------------------
//  Josh's idea (GitHub issue #6). While you hold the button your
//  car slides back along the path it drove, at real speed, up to
//  the rewindSeconds knob in config.ts (10 s). Let go and you
//  drive on from that moment with the speed and spin you had
//  then. In a race every Ai car goes back with you, so it stays
//  fair. R and Shift+R are unchanged: rewind is the gentle undo.
//
//  HOW IT REMEMBERS: a tape loop. Every physics step (60 a second)
//  each car writes a SNAPSHOT of itself into a ring of preallocated
//  Float64Arrays: the body's pose and motion plus everything the
//  sim remembers between steps (carSim.ts saveRewindState), and
//  its lap tracker. When the ring is full the oldest step is
//  written over. Nothing is allocated while you drive.
//
//  Things that are not cars can come along too: they register a
//  RewindPart (an Ai brain, the race book, your trick in progress
//  and your trick score) and get their own ring.
//
//  ONE STEP AT A TIME, in a fixed order:
//
//    record   each car saves its snapshot as it steps
//    play     the button is held: each car is put at an older
//             snapshot every step (one step further back each
//             time, so it is real speed), held still, with no
//             gravity and its body's collider switched off so it
//             can't knock anything while it slides back
//    release  the button is let go: every car (and part) is put
//             back exactly as it was at the snapshot on screen,
//             motion included, and the world carries on from
//             there. The snapshots after it are forgotten.
//
//  Which of those the NEXT step does is decided once, after the
//  physics world has stepped (rewindAfterStep), so every car sees
//  the same answer for the whole step.
//
//  Rules by mode: free roam, time trial, stunt and race all
//  rewind. Any lap you rewound in is dirty (it can't be a record
//  or a ghost). Trick points earned in the rewound time are taken
//  back; the stunt and core-hunt clocks keep running (so a rewind
//  can't be farmed for a record). Off in multiplayer (the HUD says
//  so) and during the 3-2-1 countdown.
// ============================================================

import type { RapierCollider, RapierRigidBody } from '@react-three/rapier'
import { driveInput } from '../core/controls'
import { emit } from '../core/events'
import { getSettings } from '../core/settings'
import { getGame } from '../core/store'
import type { GameState } from '../core/store'
import { rewind } from '../core/telemetry'
import type { CarState } from '../core/telemetry'
import { CarSim } from './carSim'
import { LapTracker } from './lapTracker'
import { DT } from './tuning'

/** You and five Ai racers. */
const MAX_CARS = 6
/** Numbers in one car's snapshot: its sim, then its lap tracker. */
const CAR_FLOATS = CarSim.REWIND_FLOATS + LapTracker.REWIND_FLOATS
/** A zero vector for rapier (made once). */
const STILL = { x: 0, y: 0, z: 0 }
/** The rewindSeconds knob is kept inside this range. */
const MIN_SECONDS = 2
const MAX_SECONDS = 20

/** Something besides a car's physics that has to go back in time with it. */
export interface RewindPart {
  /** Numbers it saves per step. Fixed for as long as it is registered. */
  readonly size: number
  /** Save how things are right now: the start of the coming physics step. */
  save(out: Float64Array, at: number): void
  /** Put things back to a saved moment: the world is about to carry on from there. */
  load(src: Float64Array, at: number): void
}

/** What a car hands the recorder when it joins (SimulatedCar does this for every car). */
export interface RewindCar {
  id: string
  sim: CarSim
  lap: LapTracker
  car: CarState
  body: () => RapierRigidBody | null
  collider: () => RapierCollider | null
  /** After this car was put back on letting go (the player's car fixes its lap and HUD here). */
  onResume?: () => void
}

interface CarSlot extends RewindCar {
  data: Float64Array
  /** The body's gravity scale before a rewind turned it off. */
  gravity: number
}

interface PartSlot {
  part: RewindPart
  data: Float64Array
}

type Mode = 'idle' | 'record' | 'play'

/** The recorder's state. Read by SimulatedCar inside every step; written only here. */
const tape = {
  /** Steps the ring holds (the rewindSeconds knob x 60). */
  capacity: 0,
  /** What THIS physics step does. */
  mode: 'idle' as Mode,
  /** The snapshot number the next recording step writes. Counts up forever. */
  frame: 0,
  /** The newest complete snapshot (-1 = none). */
  latest: -1,
  /** Nothing older than this may be shown (raised when the round, track or cars change). */
  floor: 0,
  /** While playing: the snapshot on screen this step. */
  playhead: 0,
  /** latest when this hold began. */
  startLatest: 0,
  /** Steps this hold has lasted. */
  holdSteps: 0,
  /** Rewinds this round (dev inspector). */
  count: 0,
  /** Seconds taken back by the last hold (dev inspector). */
  lastSeconds: 0,
  /** Where each car was put back on the last release, and how fast (dev inspector; made on a release, which is rare). */
  lastRestore: [] as { id: string; x: number; y: number; z: number; kmh: number; frame: number }[],
}

const slots: CarSlot[] = []
const parts: PartSlot[] = []

/** Dev / tests: steps left of a scripted hold (rewindHoldFor). */
const devHold = { steps: 0 }

/** What the recorder last saw of the game, to notice a new round, track or race state. */
const seen = { round: -1, trackVersion: -1, trackParamVersion: -1, raceState: '', mode: '', phase: '', multiplayer: false }

// ---------------------------------------------------------------- sizes

function wantedCapacity(): number {
  const s = getSettings().rewindSeconds
  const secs = Number.isFinite(s) ? Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, s)) : 10
  return Math.round(secs / DT)
}

/** The ring slot of a snapshot number. */
function ring(frame: number): number {
  const c = tape.capacity
  return ((frame % c) + c) % c
}

/** The oldest snapshot that can be shown right now. */
function oldest(): number {
  return Math.max(tape.floor, tape.latest - tape.capacity + 1)
}

/** Forget every snapshot: rewinding can't go back past this moment. */
function clearHistory(): void {
  tape.floor = tape.frame
  tape.latest = tape.frame - 1
}

/** (Re)make every ring at the current capacity. Only when the knob changes or something joins. */
function allocate(): void {
  for (const s of slots) if (s.data.length !== tape.capacity * CAR_FLOATS) s.data = new Float64Array(tape.capacity * CAR_FLOATS)
  for (const p of parts) if (p.data.length !== tape.capacity * p.part.size) p.data = new Float64Array(tape.capacity * p.part.size)
}

// ---------------------------------------------------------------- joining

/** A car joins the recorder (SimulatedCar, on mount). Returns its leave function. */
export function addRewindCar(c: RewindCar): () => void {
  if (tape.capacity === 0) tape.capacity = wantedCapacity()
  if (slots.length >= MAX_CARS) console.warn(`[rewind] more than ${MAX_CARS} cars: ${c.id} will not rewind`)
  if (tape.mode === 'play') abandon() // a newcomer has no past: stop rewinding where we are
  const slot: CarSlot = { ...c, data: new Float64Array(tape.capacity * CAR_FLOATS), gravity: 1 }
  if (slots.length < MAX_CARS) slots.push(slot)
  clearHistory() // it has no past to go back to
  return () => {
    const i = slots.indexOf(slot)
    if (i < 0) return
    if (tape.mode === 'play') leavePlayback(slot)
    slots.splice(i, 1)
    clearHistory()
  }
}

/** Something that is not a car joins (an Ai brain, the race book, the trick score). Returns its leave function. */
export function addRewindPart(part: RewindPart): () => void {
  if (tape.capacity === 0) tape.capacity = wantedCapacity()
  if (tape.mode === 'play') abandon()
  const p: PartSlot = { part, data: new Float64Array(tape.capacity * part.size) }
  parts.push(p)
  clearHistory()
  // A part that joins between steps saves "now" straight away, so the next step's snapshot is whole.
  if (tape.mode === 'record') part.save(p.data, ring(tape.frame) * part.size)
  return () => {
    const i = parts.indexOf(p)
    if (i >= 0) parts.splice(i, 1)
    clearHistory()
  }
}

// ---------------------------------------------------------------- inside each car's step (SimulatedCar)

/** True while this step is a rewind step: the car is shown, not simulated. */
export function rewindPlaying(): boolean {
  return tape.mode === 'play'
}

function slotOf(sim: CarSim): CarSlot | null {
  for (let i = 0; i < slots.length; i++) if (slots[i].sim === sim) return slots[i]
  return null
}

/** Just before a car steps: save the start of this step (the sim's memory and its lap). */
export function rewindBeforeCarStep(sim: CarSim): void {
  if (tape.mode !== 'record') return
  const s = slotOf(sim)
  if (!s) return
  const at = ring(tape.frame) * CAR_FLOATS
  s.sim.saveRewindState(s.data, at)
  s.lap.saveRewind(s.data, at + CarSim.REWIND_FLOATS)
}

/** Just after a car stepped: save its pose and motion at the start of this step. */
export function rewindAfterCarStep(sim: CarSim): void {
  if (tape.mode !== 'record') return
  const s = slotOf(sim)
  if (!s) return
  const at = ring(tape.frame) * CAR_FLOATS
  // A teleport or reset this step moved the car before it moved at all: the snapshot is the
  // moment AFTER the move (its memory was just cleared by the move, so save that too).
  if (sim.news.teleported) {
    s.sim.saveRewindState(s.data, at)
    s.lap.saveRewind(s.data, at + CarSim.REWIND_FLOATS)
  }
  s.sim.saveRewindPose(s.data, at)
}

/**
 * A rewind step: put the car where it was at the snapshot on screen, still, looking exactly as
 * it did then. Its registry entry follows (track position, lap, speed for the HUD); its velocity
 * there reads zero, so trails fade and nothing treats it as driving.
 */
export function rewindShowCar(sim: CarSim, car: CarState, body: RapierRigidBody, chassis: RapierCollider | null): void {
  const s = slotOf(sim)
  if (!s) return
  const at = ring(tape.playhead) * CAR_FLOATS
  if (!sim.loadRewind(s.data, at, body, chassis, false)) return
  s.lap.loadRewind(s.data, at + CarSim.REWIND_FLOATS)
  car.trackS = sim.trackS
  car.lap = s.lap.lap
  car.lastLapMs = s.lap.lastLapMs
  car.lastLapDirty = s.lap.lastLapDirty
  car.speedKmh = sim.speedKmh
  car.boost = sim.boost
  car.slip = sim.slip
  car.airborne = sim.airborne
  car.velocity.set(0, 0, 0)
}

// ---------------------------------------------------------------- playback on / off

/**
 * Start sliding a car back: still (each step then puts it at a snapshot), no gravity, no
 * collisions, no forces left over from its last step. Still matters: if a snapshot is ever refused
 * (the NaN firewall), the car must wait where it is, not drift on through walls it can't touch.
 */
function enterPlayback(s: CarSlot): void {
  const b = s.body()
  if (!b) return
  s.gravity = b.gravityScale()
  b.setGravityScale(0, true)
  b.setLinvel(STILL, true)
  b.setAngvel(STILL, true)
  b.resetForces(true)
  b.resetTorques(true)
  s.collider()?.setEnabled(false)
}

function leavePlayback(s: CarSlot): void {
  const b = s.body()
  if (b) b.setGravityScale(Number.isFinite(s.gravity) ? s.gravity : 1, true)
  s.collider()?.setEnabled(true)
}

// ---------------------------------------------------------------- after every physics step

/** Is rewind allowed at all right now (recording or rewinding)? */
function recordable(g: GameState): boolean {
  return g.phase === 'playing' && !g.multiplayer && slots.length > 0
}

/** Did the round, track, race state or game mode change since the last step? Then the past is gone. */
function worldChanged(g: GameState): boolean {
  const changed =
    g.round !== seen.round ||
    g.trackVersion !== seen.trackVersion ||
    g.trackParamVersion !== seen.trackParamVersion ||
    g.raceState !== seen.raceState ||
    g.mode !== seen.mode ||
    g.multiplayer !== seen.multiplayer ||
    // pausing and coming back keeps the tape; anything else (title, results, editor) doesn't
    (g.phase !== seen.phase && !(g.phase === 'playing' && seen.phase === 'paused') && !(g.phase === 'paused' && seen.phase === 'playing'))
  seen.round = g.round
  seen.trackVersion = g.trackVersion
  seen.trackParamVersion = g.trackParamVersion
  seen.raceState = g.raceState
  seen.mode = g.mode
  seen.multiplayer = g.multiplayer
  seen.phase = g.phase
  return changed
}

function saveParts(frame: number): void {
  const r = ring(frame)
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    p.part.save(p.data, r * p.part.size)
  }
}

/** Let go: put every car and part back as it was at the snapshot on screen, and carry on. */
function release(): void {
  const p = tape.playhead
  const r = ring(p)
  tape.lastRestore = []
  for (let i = 0; i < parts.length; i++) parts[i].part.load(parts[i].data, r * parts[i].part.size)
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i]
    const body = s.body()
    leavePlayback(s)
    if (!body) continue
    const at = r * CAR_FLOATS
    if (!s.sim.loadRewind(s.data, at, body, s.collider(), true)) {
      // A broken snapshot never reaches rapier: back to the road instead, like R.
      s.sim.requestReset('auto', 'nan')
      continue
    }
    s.lap.loadRewind(s.data, at + CarSim.REWIND_FLOATS)
    s.car.trackS = s.sim.trackS
    s.car.lap = s.lap.lap
    s.car.lastLapMs = s.lap.lastLapMs
    s.car.lastLapDirty = s.lap.lastLapDirty
    s.car.velocity.copy(s.sim.linvel)
    tape.lastRestore.push({ id: s.id, x: s.sim.pos.x, y: s.sim.pos.y, z: s.sim.pos.z, kmh: s.sim.linvel.length() * 3.6, frame: p })
  }
  // The tape carries on from here: snapshot p is recorded again by the next step, the ones
  // after it are gone.
  tape.latest = p - 1
  tape.frame = p
  const seconds = (tape.startLatest + 1 - p) * DT
  tape.lastSeconds = seconds
  tape.count++
  tape.mode = 'record'
  rewind.active = false
  rewind.rewound = 0
  rewind.lapMs = -1
  // Announced before the cars' own follow-ups, so a lap that goes dirty because of this rewind
  // is heard after it (the HUD says "rewound", not "off road").
  emit('rewind.end', { seconds: Math.round(seconds * 100) / 100, heldSeconds: Math.round(tape.holdSteps * DT * 100) / 100 })
  for (let i = 0; i < slots.length; i++) slots[i].onResume?.()
}

/**
 * Stop rewinding without putting anything back (the round or track changed under the hold).
 * Still announced as an end (nothing was taken back), so the whir stops and the HUD clears.
 */
function abandon(): void {
  for (let i = 0; i < slots.length; i++) leavePlayback(slots[i])
  tape.mode = 'idle'
  rewind.active = false
  rewind.rewound = 0
  rewind.lapMs = -1
  emit('rewind.end', { seconds: 0, heldSeconds: Math.round(tape.holdSteps * DT * 100) / 100 })
}

/**
 * Once per physics step, after the world has stepped (VehicleLayer registers it): close this
 * step's snapshot, then decide what the next step does.
 */
export function rewindAfterStep(): void {
  const g = getGame()
  const want = wantedCapacity()
  const allowed = recordable(g)
  const countdown = g.raceState === 'countdown'
  const scripted = devHold.steps > 0
  if (scripted) devHold.steps--
  const held = (driveInput.rewind || scripted) && g.phase === 'playing'
  rewind.refused = held && g.multiplayer ? 'multiplayer' : held && countdown ? 'countdown' : ''

  // The past is gone when the world changes under it, or the knob changes the ring's size.
  if (worldChanged(g) || want !== tape.capacity) {
    if (tape.mode === 'play') abandon()
    if (want !== tape.capacity) {
      tape.capacity = want
      allocate()
    }
    if (tape.mode === 'record') tape.frame++ // this step's snapshot belongs to the old world
    clearHistory()
    if (tape.mode !== 'idle') tape.mode = 'idle'
  }

  if (tape.mode === 'record') {
    tape.latest = tape.frame
    tape.frame++
  } else if (tape.mode === 'play') {
    if (held && allowed && !countdown) {
      tape.holdSteps++
      if (tape.playhead > oldest()) tape.playhead--
    } else {
      release()
    }
  }

  // ---- what the next step does ----
  if (tape.mode === 'play') {
    // still holding: keep going
  } else if (!allowed) {
    tape.mode = 'idle'
  } else if (held && !countdown && tape.latest >= oldest()) {
    tape.mode = 'play'
    tape.playhead = tape.latest
    tape.startLatest = tape.latest
    tape.holdSteps = 0
    for (let i = 0; i < slots.length; i++) enterPlayback(slots[i])
    rewind.active = true
    emit('rewind.start', { stored: Math.round((tape.latest + 1 - oldest()) * DT * 100) / 100 })
  } else {
    if (tape.mode === 'idle') clearHistory() // starting to record: nothing before this moment
    tape.mode = 'record'
    saveParts(tape.frame)
  }

  // ---- what the HUD reads ----
  rewind.capacity = tape.capacity * DT
  if (tape.mode === 'play') {
    rewind.stored = Math.max(0, (tape.playhead - oldest()) * DT)
    rewind.rewound = (tape.startLatest + 1 - tape.playhead) * DT
  } else {
    rewind.stored = tape.mode === 'record' ? Math.max(0, (tape.latest + 1 - oldest()) * DT) : 0
  }
}

// ---------------------------------------------------------------- dev

/** For the dev inspector (window.__game.get('rewind')). */
export function rewindDebug(): Record<string, unknown> {
  return {
    mode: tape.mode,
    capacitySteps: tape.capacity,
    frame: tape.frame,
    latest: tape.latest,
    oldest: oldest(),
    floor: tape.floor,
    playhead: tape.playhead,
    holdSteps: tape.holdSteps,
    rewinds: tape.count,
    lastSeconds: +tape.lastSeconds.toFixed(3),
    lastRestore: tape.lastRestore,
    cars: slots.map((s) => s.id),
    parts: parts.length,
    floatsPerCar: CAR_FLOATS,
    ...rewind,
  }
}

/**
 * The snapshot a car will go back to if rewind is held for `seconds` and let go (tests check
 * the car lands there): position, speed and lap count, read straight from the tape.
 */
export function rewindPeek(carId: string, seconds: number): { x: number; y: number; z: number; kmh: number; lap: number; frame: number } | null {
  const s = slots.find((c) => c.id === carId)
  if (!s || tape.latest < oldest()) return null
  const steps = Math.round(Math.max(0, seconds) / DT)
  const f = Math.max(oldest(), tape.latest + 1 - steps)
  const at = ring(f) * CAR_FLOATS
  const d = s.data
  const kmh = Math.hypot(d[at + 7], d[at + 8], d[at + 9]) * 3.6
  return { x: d[at], y: d[at + 1], z: d[at + 2], kmh, lap: d[at + CarSim.REWIND_FLOATS], frame: f }
}

/**
 * Dev / tests: the snapshots of one car for snapshot numbers from..to (those still on the tape):
 * snapshot number, position, speed and lap. Tests compare a car's path before and after a rewind.
 */
export function rewindFrames(carId: string, from: number, to: number): { f: number; x: number; y: number; z: number; kmh: number; lap: number }[] {
  const s = slots.find((c) => c.id === carId)
  const out: { f: number; x: number; y: number; z: number; kmh: number; lap: number }[] = []
  if (!s) return out
  const lo = Math.max(oldest(), Math.floor(from))
  const hi = Math.min(tape.latest, Math.floor(to))
  for (let f = lo; f <= hi; f++) {
    const at = ring(f) * CAR_FLOATS
    const d = s.data
    out.push({ f, x: d[at], y: d[at + 1], z: d[at + 2], kmh: Math.hypot(d[at + 7], d[at + 8], d[at + 9]) * 3.6, lap: d[at + CarSim.REWIND_FLOATS] })
  }
  return out
}

/**
 * Dev / tests (the NaN firewall check): break a car's tape on purpose, every snapshot's pose set to
 * NaN. A rewind must then refuse to hand any of it to rapier: the car stays put while held and goes
 * back to the road on letting go, exactly like a NaN anywhere else.
 */
export function rewindPoison(carId: string): string {
  const s = slots.find((c) => c.id === carId)
  if (!s) return `no car ${carId}`
  for (let f = 0; f < tape.capacity; f++) s.data[f * CAR_FLOATS] = NaN
  return `${carId}: every snapshot's position is now NaN`
}

/** Dev / tests: hold rewind for this many seconds (as if the button were held), then let go. */
export function rewindHoldFor(seconds: number): string {
  const steps = Math.round(Math.max(0, Number(seconds) || 0) / DT)
  devHold.steps = steps
  return `holding rewind for ${steps} steps`
}
