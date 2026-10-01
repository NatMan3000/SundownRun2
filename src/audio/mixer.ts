// ============================================================
//  MIXER - the buses every sound flows through
// ------------------------------------------------------------
//  Think of a mixing desk. Each sound plugs into a channel, the
//  channels feed two group faders (music and effects), and those
//  feed the master fader and a safety limiter before the speakers.
//
//    music ─ carve ─ musicTone (lowpass, closes on pause) ─ duck ─ musicVol ─┐
//    engine ─ engineVol (quiet on the title screen, off on pause) ─┐ │
//    fx (crashes, pickups, tricks) ───────────────────────────────┤ │
//    ui (menu clicks) ────────────────────────────────────────────┴ sfxVol
//                                                                    │
//                     master (fades for hidden tabs) ─ glue ─ limiter ─ speakers
//
//  musicVolume / sfxVolume come from the Settings menu (live).
//  carve dips the music's low-mids (where the engine's note lives)
//  as the throttle opens, so the bass line never buries the engine.
//  duck() pulls the music down under a big crash and lets it swell
//  back, so the hit lands. The same mixer is built inside the
//  offline renderer, so a render sounds like the game.
// ============================================================

import { Knob, SILENT, clamp01, holdParam } from './synth'

/** Overall loudness of each group at full slider, before the player's volume. */
const MUSIC_LEVEL = 0.62
const SFX_LEVEL = 1.0
const MASTER_LEVEL = 0.9

/** How loud the engine sits in each game phase (it idles quietly behind the title screen). */
export const ENGINE_PHASE_LEVEL = {
  title: 0.32,
  loading: 0,
  playing: 1,
  paused: 0,
  results: 0.55,
  editor: 0,
} as const

export interface Mix {
  ctx: BaseAudioContext
  /** Plug music instruments in here. */
  music: GainNode
  /** Plug the engine voice in here. */
  engine: GainNode
  /** Plug one-shot effects in here. */
  fx: GainNode
  /** Plug menu sounds in here. */
  ui: GainNode
  master: GainNode
  /** Reads the final output level (inspector only). */
  analyser: AnalyserNode
  // faders the update loop moves
  musicCarve: BiquadFilterNode
  musicTone: BiquadFilterNode
  musicDuck: GainNode
  musicVol: GainNode
  engineVol: GainNode
  sfxVol: GainNode
  knobs: {
    musicVol: Knob
    sfxVol: Knob
    engineVol: Knob
    musicTone: Knob
    musicCarve: Knob
    master: Knob
  }
}

/** How far the music's low-mids dip at full throttle (dB, negative). */
const CARVE_DB = -5

export function buildMix(ctx: BaseAudioContext): Mix {
  // Glue: a gentle compressor that holds the mix together.
  const glue = ctx.createDynamicsCompressor()
  glue.threshold.value = -18
  glue.knee.value = 12
  glue.ratio.value = 2.5
  glue.attack.value = 0.01
  glue.release.value = 0.22

  // Limiter: a fast, hard compressor right at the top, a safety net so a
  // fanfare on top of a redlining engine never clips the speakers.
  const limiter = ctx.createDynamicsCompressor()
  limiter.threshold.value = -4
  limiter.knee.value = 2
  limiter.ratio.value = 20
  limiter.attack.value = 0.002
  limiter.release.value = 0.12

  const master = ctx.createGain()
  master.gain.value = 0 // fades in on start, so the first sound never clicks
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 2048

  master.connect(glue)
  glue.connect(limiter)
  limiter.connect(ctx.destination)
  limiter.connect(analyser)

  // ---- music group ----
  const music = ctx.createGain()
  const musicCarve = ctx.createBiquadFilter()
  musicCarve.type = 'peaking'
  musicCarve.frequency.value = 240
  musicCarve.Q.value = 0.9
  musicCarve.gain.value = 0
  const musicTone = ctx.createBiquadFilter()
  musicTone.type = 'lowpass'
  musicTone.frequency.value = 20000
  musicTone.Q.value = 0.5
  const musicDuck = ctx.createGain()
  const musicVol = ctx.createGain()
  musicVol.gain.value = 0
  music.connect(musicCarve)
  musicCarve.connect(musicTone)
  musicTone.connect(musicDuck)
  musicDuck.connect(musicVol)
  musicVol.connect(master)

  // ---- effects group ----
  const sfxVol = ctx.createGain()
  sfxVol.gain.value = 0
  sfxVol.connect(master)
  const engine = ctx.createGain()
  const engineVol = ctx.createGain()
  engineVol.gain.value = 0
  engine.connect(engineVol)
  engineVol.connect(sfxVol)
  const fx = ctx.createGain()
  fx.connect(sfxVol)
  const ui = ctx.createGain()
  ui.gain.value = 0.8
  ui.connect(sfxVol)

  return {
    ctx,
    music,
    engine,
    fx,
    ui,
    master,
    analyser,
    musicCarve,
    musicTone,
    musicDuck,
    musicVol,
    engineVol,
    sfxVol,
    knobs: {
      musicVol: new Knob(musicVol.gain, 0.08, 0.0005),
      sfxVol: new Knob(sfxVol.gain, 0.08, 0.0005),
      engineVol: new Knob(engineVol.gain, 0.18, 0.0005),
      musicTone: new Knob(musicTone.frequency, 0.25, 5),
      musicCarve: new Knob(musicCarve.gain, 0.15, 0.05),
      master: new Knob(master.gain, 0.09, 0.0005),
    },
  }
}

/**
 * A slider value (0..1) to a gain. Squared, because ears hear loudness on
 * a curve: half way up the slider then sounds about half as loud.
 */
export function sliderToGain(v: number): number {
  const c = clamp01(v)
  return c * c
}

export interface MixTargets {
  musicVolume: number
  sfxVolume: number
  musicMuted: boolean
  /** Engine level for the current phase (ENGINE_PHASE_LEVEL). */
  engineLevel: number
  /** True while the pause menu is up: the music goes muffled, as if heard through a wall. */
  paused: boolean
  /** True while the tab is hidden or the system is stopping: master fades to silence. */
  silent: boolean
  /** 0..1 how hard the engine is working (throttle): carves room for it in the music. */
  engineLoad: number
}

/** Called every frame with where the faders should be. Cheap: Knob skips unchanged values. */
export function updateMix(mix: Mix, m: MixTargets, t: number): void {
  mix.knobs.musicVol.to(m.musicMuted ? 0 : sliderToGain(m.musicVolume) * MUSIC_LEVEL, t)
  mix.knobs.sfxVol.to(sliderToGain(m.sfxVolume) * SFX_LEVEL, t)
  mix.knobs.engineVol.to(m.engineLevel, t)
  mix.knobs.musicTone.to(m.paused ? 650 : 20000, t)
  mix.knobs.musicCarve.to(CARVE_DB * clamp01(m.engineLoad) * clamp01(m.engineLevel), t)
  mix.knobs.master.to(m.silent ? 0 : MASTER_LEVEL, t, m.silent ? 0.04 : 0.09)
}

/**
 * Duck the music: dip it by `depth` (0..1) almost instantly, hold, then
 * let it swell back over about a second. A newer, deeper duck replaces
 * a shallower one in progress.
 */
export function duck(mix: Mix, depth: number, holdS: number, t: number): void {
  const p = mix.musicDuck.gain
  const floor = Math.max(SILENT, 1 - clamp01(depth))
  holdParam(p, t)
  p.setTargetAtTime(floor, t, 0.012)
  p.setTargetAtTime(1, t + 0.04 + holdS, 0.38)
}

/** Read the current output level in dBFS (about -100 = silence, 0 = full scale). Inspector only. */
export function readLevelDb(mix: Mix, scratch: Float32Array<ArrayBuffer>): number {
  mix.analyser.getFloatTimeDomainData(scratch)
  let sum = 0
  for (let i = 0; i < scratch.length; i++) sum += scratch[i] * scratch[i]
  const rms = Math.sqrt(sum / scratch.length)
  return rms > 0 ? Math.round(20 * Math.log10(rms) * 10) / 10 : -100
}
