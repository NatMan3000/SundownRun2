// ============================================================
//  GAME STORE - low-frequency, React-reactive game state
// ------------------------------------------------------------
//  CONTRACT (orchestrator-owned). Field names and meanings are
//  frozen; ask the orchestrator to add one.
//
//  Rules:
//   - Nothing in here changes every frame. Per-frame values live in
//     core/telemetry.ts (telemetry, cars). A field that changes at a
//     few Hz at most (race position, stunt score) is fine.
//   - Each field has ONE writer, named in its comment. Writers call
//     useGame.setState({...}) for their own fields; everyone else reads.
//   - Persisted records live in core/records.ts, not here. This store
//     mirrors the current track's records for the HUD.
// ============================================================

import { create } from 'zustand'

export type Phase =
  | 'title' //    title screen / garage / track + mode select
  | 'loading' //  building the track
  | 'playing' //  driving
  | 'paused' //   pause menu over the frozen world (single player)
  | 'results' //  race / stunt / hunt results over the world
  | 'editor' //   road editor (top-down)

export type GameMode =
  | 'free' //      free roam: tricks, props, the core hunt
  | 'timetrial' // laps against your ghost
  | 'race' //      against 0-5 Ai racers (solo) or other players (multiplayer)
  | 'stunt' //     timed run for the biggest trick score
  | 'tag' //       multiplayer only: one player is "it"

export type RaceState = 'idle' | 'countdown' | 'running' | 'finished'

export interface RaceResult {
  carId: string
  name: string
  position: number
  ms: number | null // null = did not finish
  bestLapMs: number | null
  isPlayer: boolean
}

export interface GameState {
  // ---- flow (writer: ui for phase changes from menus; play for results) ----
  phase: Phase
  mode: GameMode
  /** True when the page was opened with ?mp=1 (writer: net). */
  multiplayer: boolean
  /** Current track id (writer: whoever calls track/current.setTrack). */
  trackId: string
  trackName: string
  /** Bumped every time the current track runtime is replaced or rebuilt (writer: track/current). */
  trackVersion: number
  /** Bumped on track rebuild that keeps the car in place (live params like bank angle). */
  trackParamVersion: number
  /** Bumped when a new session/round starts: props and cores re-scatter (writer: play). */
  round: number
  /** performance.now() when the current session started. */
  sessionStartedAt: number

  // ---- input (writer: core/input) ----
  inputDevice: 'keyboard' | 'gamepad'

  // ---- player laps (writer: vehicle's lap tracker) ----
  lapCount: number
  lastLapMs: number | null
  lastLapDirty: boolean
  /** Best clean lap on the current track (mirrors records). */
  bestLapMs: number | null
  /** performance.now() when the lap in progress started; 0 = not armed (after a reset, until the line). */
  lapStartedAt: number
  currentLapDirty: boolean
  sectorsPassed: number
  sectorCount: number
  /** Bumped when a lap is voided (HUD toast). */
  lapVoidNonce: number

  // ---- ghost (writer: vehicle ghost) ----
  /** Bumped when a new best-lap trace is saved, so the ghost reloads. */
  ghostVersion: number
  ghostAvailable: boolean

  // ---- race (writer: play) ----
  raceState: RaceState
  /** performance.now() when the countdown hits GO. */
  raceGoAt: number
  raceLaps: number
  /** Player's position, 1 = leading. Updated at most a few times a second. */
  racePosition: number
  raceRacers: number
  raceResults: RaceResult[]

  // ---- stunt score attack (writer: play) ----
  stuntEndsAt: number //  performance.now(); 0 = not running
  stuntScore: number
  stuntBest: number | null

  // ---- trick score (writer: vehicle trick detector) ----
  /** Points banked this session (all modes). */
  trickScore: number
  /** Live combo multiplier while airborne/chaining (shown on HUD). */
  comboCount: number

  // ---- props (writer: play) ----
  propScore: number

  // ---- core hunt (writer: play) ----
  coresFound: number
  coresTotal: number
  /** performance.now() of the first pickup this round; 0 = clock not running. */
  huntStartedAt: number
  huntLastMs: number | null
  huntBestMs: number | null

  // ---- speed trap (writer: play) ----
  trapLastKmh: number | null
  trapBestKmh: number | null

  // ---- tag (writer: net) ----
  tagItId: string | null
  /** Seconds each player has been "it", by car id. */
  tagSeconds: Record<string, number>
  tagEndsAt: number

  // ---- world map (writer: core/session openMap/closeMap) ----
  /** The editor's top-down world map is open over the PAUSED game (Physics and the car stay mounted). */
  mapOpen: boolean

  // ---- graphics (writer: look quality manager) ----
  /** The preset actually in use (auto resolves to one of these). */
  qualityLevel: 'low' | 'medium' | 'high'
}

const initial: GameState = {
  phase: 'title',
  mode: 'free',
  multiplayer: false,
  trackId: 'afterglow',
  trackName: '',
  trackVersion: 0,
  trackParamVersion: 0,
  round: 0,
  sessionStartedAt: 0,

  inputDevice: 'keyboard',

  lapCount: 0,
  lastLapMs: null,
  lastLapDirty: false,
  bestLapMs: null,
  lapStartedAt: 0,
  currentLapDirty: false,
  sectorsPassed: 0,
  sectorCount: 0,
  lapVoidNonce: 0,

  ghostVersion: 0,
  ghostAvailable: false,

  raceState: 'idle',
  raceGoAt: 0,
  raceLaps: 3,
  racePosition: 1,
  raceRacers: 1,
  raceResults: [],

  stuntEndsAt: 0,
  stuntScore: 0,
  stuntBest: null,

  trickScore: 0,
  comboCount: 0,

  propScore: 0,

  coresFound: 0,
  coresTotal: 0,
  huntStartedAt: 0,
  huntLastMs: null,
  huntBestMs: null,

  trapLastKmh: null,
  trapBestKmh: null,

  tagItId: null,
  tagSeconds: {},
  tagEndsAt: 0,

  mapOpen: false,

  qualityLevel: 'high',
}

export const useGame = create<GameState>(() => ({ ...initial }))

/** Per-frame read without subscribing (no allocation). */
export function getGame(): GameState {
  return useGame.getState()
}

/** Fields that reset when a new session starts on a track (laps, scores, race, hunt progress). */
export function sessionResetFields(): Partial<GameState> {
  return {
    lapCount: 0,
    lastLapMs: null,
    lastLapDirty: false,
    lapStartedAt: 0,
    currentLapDirty: false,
    sectorsPassed: 0,
    raceState: 'idle',
    raceGoAt: 0,
    racePosition: 1,
    raceResults: [],
    stuntEndsAt: 0,
    stuntScore: 0,
    trickScore: 0,
    comboCount: 0,
    propScore: 0,
    coresFound: 0,
    huntStartedAt: 0,
    huntLastMs: null,
    trapLastKmh: null,
    tagItId: null,
    tagSeconds: {},
    tagEndsAt: 0,
  }
}
