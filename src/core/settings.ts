// ============================================================
//  SETTINGS - the live, persisted version of config.ts
// ------------------------------------------------------------
//  CONTRACT (orchestrator-owned).
//
//  config.ts holds the defaults; this store holds what the player
//  is actually using right now. The Settings menu writes here, and
//  gameplay reads from here - never from CONFIG directly (the only
//  importer of config.ts is this file, so a config edit hot-reloads
//  through one place).
//
//  Persistence rule (the "Josh's edit wins" rule): a menu change is
//  saved together with the config default it replaced. If config.ts
//  later holds a different default for that key, the old menu choice
//  is dropped, because the newer edit in config.ts is what Josh meant.
//
//  When a setting's scale changes (Brakes, 2026-10-03), the save
//  records which scale it is in (SAVE_VERSION) and an older save is
//  rescaled once as it loads, so nobody's car changes under them.
//
//  Per-frame code reads `getSettings()` (a plain object, no allocation).
//  React code uses `useSettings(selector)`.
// ============================================================

import { create } from 'zustand'
import { CONFIG } from './config'

export type CameraMode = 'chase' | 'close' | 'bonnet'
export type QualityChoice = 'auto' | 'low' | 'medium' | 'high'
export type QualityLevel = 'low' | 'medium' | 'high'

/** Every value the player can change. Keys mirror config.ts. */
export interface Settings {
  carBody: string
  paint: string
  glow: string
  trail: string
  grip: number
  steering: number
  stability: number
  power: number
  brakes: number
  topSpeedKmh: number
  camera: CameraMode
  cameraDistance: number
  cameraHeight: number
  fov: number
  fovBoost: number
  timeOfDay: number
  sunsetMinutes: number
  musicVolume: number
  sfxVolume: number
  /** Engine voicing: 'muscle' | 'rally' | 'hover' (audio/engineVoicings.ts). */
  engineSound: string
  aiRacers: number
  aiDifficulty: number
  catchUp: boolean
  raceLaps: number
  tricks: boolean
  ghost: boolean
  boostStrength: number
  smashKmh: number
  magGripKmh: number
  /** How far back rewind can go, seconds (vehicle/rewind.ts). */
  rewindSeconds: number
  quality: QualityChoice
  showFps: boolean
  multiplayerRam: boolean
  /** Live per-track road parameters (e.g. the Hyperdrome's bank angle), keyed by track id. */
  trackParams: Record<string, Record<string, number>>
}

/** Slider ranges the Settings menu uses. Values outside are clamped on load and on set. */
export const SETTING_RANGES: Partial<Record<keyof Settings, { min: number; max: number; step: number }>> = {
  grip: { min: 0.6, max: 1.5, step: 0.05 },
  steering: { min: 0.5, max: 1.6, step: 0.05 },
  stability: { min: 0.5, max: 1.7, step: 0.05 },
  power: { min: 0.5, max: 1.7, step: 0.05 },
  // Brakes since the version 2 rescale (SAVE_VERSION): 100% is the old 150%. 0.3 keeps every old save
  // (old 50% -> 33%); past 1.15 the tyres can't grip any harder, so a higher top would do nothing.
  brakes: { min: 0.3, max: 1.15, step: 0.05 },
  topSpeedKmh: { min: 120, max: 400, step: 10 },
  cameraDistance: { min: 4, max: 12, step: 0.5 },
  cameraHeight: { min: 1.2, max: 5, step: 0.1 },
  fov: { min: 50, max: 80, step: 1 },
  fovBoost: { min: 0, max: 30, step: 1 },
  timeOfDay: { min: 0, max: 1, step: 0.01 },
  sunsetMinutes: { min: 0, max: 30, step: 1 },
  musicVolume: { min: 0, max: 1, step: 0.05 },
  sfxVolume: { min: 0, max: 1, step: 0.05 },
  aiRacers: { min: 0, max: 5, step: 1 },
  aiDifficulty: { min: 0, max: 1, step: 0.05 },
  raceLaps: { min: 1, max: 10, step: 1 },
  boostStrength: { min: 0, max: 2.5, step: 0.1 },
  smashKmh: { min: 10, max: 150, step: 5 },
  magGripKmh: { min: 20, max: 160, step: 5 },
  rewindSeconds: { min: 2, max: 20, step: 1 },
}

const STORAGE_KEY = 'sr2.settings.v1'

/**
 *  Which scale the saved numbers are written in. A save with an older `version` (or none)
 *  is brought up to date once, as it loads (migrate, below), and saved back.
 *
 *  2 (2026-10-03): the Brakes setting was rescaled. Nathan: "whatever 150% is currently,
 *  make that the new 100%", so the new 100% brakes as hard as the old 150% did. A saved
 *  Brakes choice from before is divided by BRAKES_RESCALE_V2 so the car brakes exactly as it
 *  did (150% -> 100%, 100% -> 67%). A player with no saved Brakes choice was on the default,
 *  so they get the new, stronger default.
 */
const SAVE_VERSION = 2
/** The old-to-new Brakes scale of version 2. Fixed for good: it describes old saves, whatever the brakes become later. */
const BRAKES_RESCALE_V2 = 1.5

type SettingKey = Exclude<keyof Settings, 'trackParams'>
type Saved = Partial<Record<SettingKey, { v: unknown; d: unknown }>> & {
  trackParams?: Settings['trackParams']
  /** The scale the numbers are written in (SAVE_VERSION). Missing = version 1. */
  version?: number
}

function defaultsFrom(cfg: typeof CONFIG): Settings {
  return {
    carBody: cfg.carBody,
    paint: cfg.paint,
    glow: cfg.glow,
    trail: cfg.trail,
    grip: cfg.grip,
    steering: cfg.steering,
    stability: cfg.stability,
    power: cfg.power,
    brakes: cfg.brakes,
    topSpeedKmh: cfg.topSpeedKmh,
    camera: cfg.camera,
    cameraDistance: cfg.cameraDistance,
    cameraHeight: cfg.cameraHeight,
    fov: cfg.fov,
    fovBoost: cfg.fovBoost,
    timeOfDay: cfg.timeOfDay,
    sunsetMinutes: cfg.sunsetMinutes,
    musicVolume: cfg.musicVolume,
    sfxVolume: cfg.sfxVolume,
    engineSound: cfg.engineSound,
    aiRacers: cfg.aiRacers,
    aiDifficulty: cfg.aiDifficulty,
    catchUp: cfg.catchUp,
    raceLaps: cfg.raceLaps,
    tricks: cfg.tricks,
    ghost: cfg.ghost,
    boostStrength: cfg.boostStrength,
    smashKmh: cfg.smashKmh,
    magGripKmh: cfg.magGripKmh,
    rewindSeconds: cfg.rewindSeconds,
    quality: cfg.quality,
    showFps: cfg.showFps,
    multiplayerRam: cfg.multiplayerRam,
    trackParams: {},
  }
}

function clampKey<K extends keyof Settings>(key: K, value: Settings[K]): Settings[K] {
  const r = SETTING_RANGES[key]
  if (r && typeof value === 'number') {
    const n = Number.isFinite(value) ? value : r.min
    return Math.min(r.max, Math.max(r.min, n)) as Settings[K]
  }
  return value
}

function readSaved(): Saved {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { version: SAVE_VERSION }
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { version: SAVE_VERSION }
    const s = parsed as Saved
    if (migrate(s)) writeSaved(s)
    return s
  } catch {
    return { version: SAVE_VERSION }
  }
}

/**
 *  Bring an older save up to SAVE_VERSION in place. Returns true if it changed, so the
 *  caller saves it straight back (and it is never rescaled twice). Only a number is
 *  rescaled; anything else is left for resolve() to throw away as junk.
 */
function migrate(s: Saved): boolean {
  const from = typeof s.version === 'number' && Number.isFinite(s.version) ? s.version : 1
  if (from >= SAVE_VERSION) return false
  if (from < 2) {
    // Brakes: old 150% is the new 100%. `d` (what config.ts said when it was picked) is
    // left alone: config.ts still says 1.0, so the choice is kept, not thrown away as stale.
    const b = s.brakes
    if (b && typeof b === 'object' && typeof b.v === 'number' && Number.isFinite(b.v)) b.v = b.v / BRAKES_RESCALE_V2
  }
  s.version = SAVE_VERSION
  return true
}

function writeSaved(saved: Saved): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved))
  } catch {
    // Storage unavailable (private window): settings still work, they just won't survive a reload.
  }
}

let saved: Saved = readSaved()

/** Merge config defaults with saved menu choices, applying the "Josh's edit wins" rule. */
function resolve(defaults: Settings): Settings {
  const out: Settings = { ...defaults, trackParams: { ...(saved.trackParams ?? {}) } }
  let pruned = false
  for (const key of Object.keys(defaults) as (keyof Settings)[]) {
    if (key === 'trackParams') continue
    const entry = saved[key]
    if (!entry) continue
    if (entry.d !== defaults[key] || typeof entry.v !== typeof defaults[key]) {
      delete saved[key] // config.ts changed since this was chosen: the edit wins
      pruned = true
      continue
    }
    ;(out as unknown as Record<string, unknown>)[key] = clampKey(key, entry.v as Settings[typeof key])
  }
  if (pruned) writeSaved(saved)
  return out
}

let defaults = defaultsFrom(CONFIG)

interface SettingsStore extends Settings {
  set: <K extends SettingKey>(key: K, value: Settings[K]) => void
  /** Save a live track parameter; null forgets the saved value (back to the track file's default). */
  setTrackParam: (trackId: string, param: string, value: number | null) => void
  resetAll: () => void
}

export const useSettings = create<SettingsStore>((set) => ({
  ...resolve(defaults),
  set: (key, value) => {
    const v = clampKey(key, value)
    if (v === defaults[key]) delete saved[key]
    else saved[key] = { v, d: defaults[key] }
    writeSaved(saved)
    set({ [key]: v } as Partial<SettingsStore>)
  },
  setTrackParam: (trackId, param, value) => {
    const tp = { ...(saved.trackParams ?? {}) }
    const forTrack = { ...(tp[trackId] ?? {}) }
    if (value === null) delete forTrack[param]
    else forTrack[param] = Number.isFinite(value) ? value : 0
    if (Object.keys(forTrack).length) tp[trackId] = forTrack
    else delete tp[trackId]
    saved.trackParams = tp
    writeSaved(saved)
    set({ trackParams: tp })
  },
  resetAll: () => {
    saved = { version: SAVE_VERSION }
    writeSaved(saved)
    set({ ...defaults, trackParams: {} })
  },
}))

/** Per-frame read: the live settings object. Do not mutate it. */
export function getSettings(): Settings {
  return useSettings.getState()
}

/** The defaults currently coming from config.ts (for "reset to default" buttons). */
export function getDefaults(): Readonly<Settings> {
  return defaults
}

// config.ts hot-reload: re-resolve against the new defaults without
// recreating the store, so every subscriber sees the edit live.
if (import.meta.hot) {
  import.meta.hot.accept('./config', (mod) => {
    if (!mod) return
    defaults = defaultsFrom((mod as unknown as { CONFIG: typeof CONFIG }).CONFIG)
    useSettings.setState(resolve(defaults))
  })
}
