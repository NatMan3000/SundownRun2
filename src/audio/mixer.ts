// ============================================================
//  MIXER - the buses every sound flows through
// ------------------------------------------------------------
//  Think of a mixing desk. Each sound plugs into a channel, the
//  channels feed two group faders (music and effects), and those
//  feed the master fader and a safety limiter before the speakers.
//
//    music ─ carve ─ musicTone (lowpass, closes on pause) ─ duck ─ musicVol ─┐
//    engine ─ engineVol (only while driving; off in menus) ───────┐ │
//    fx (crashes, pickups, tricks) ───────────────────────────────┤ │
//    ui (menu clicks) ────────────────────────────────────────────┴ sfxVol
//    engineVol + fx ─ echo send (in a tunnel) ─ tunnel echo ─────────┘ │
//                                                                    │
//                     master (fades for hidden tabs) ─ glue ─ limiter ─ speakers
//
//  The tunnel echo: inside a tunnel (telemetry.tunnel) the engine and
//  the effects come back off the walls: a slap-back a car's width and
//  a wall away, a short flutter between the walls, and a little
//  reverb, all darker than the sound itself. It is the sound's own
//  echo, never a new sound, and it's silent in the open.
//
//  musicVolume / sfxVolume come from the Settings menu (live).
//  carve dips the music's low-mids (where the engine's note lives)
//  as the throttle opens, so the bass line never buries the engine.
//  duck() pulls the music down under a big crash and lets it swell
//  back, so the hit lands. While rewind is held the music goes
//  muffled and quieter, like a tape heard through the deck, and the
//  engine steps back a little so the rewind whir is heard. The same
//  mixer is built inside the offline renderer, so a render sounds
//  like the game.
// ============================================================

import { Knob, SILENT, clamp01, holdParam } from './synth'

/** Overall loudness of each group at full slider, before the player's volume. */
const MUSIC_LEVEL = 0.45
const SFX_LEVEL = 1.0
const MASTER_LEVEL = 0.9

/**
 * How loud the engine sits in each game phase. Menus are quiet: a parked
 * engine's idle note is a steady buzz, so behind the title screen and the
 * results it fades out and only the music and menu clicks play.
 */
export const ENGINE_PHASE_LEVEL = {
  title: 0,
  loading: 0,
  playing: 1,
  paused: 0,
  results: 0,
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
  /** Into the tunnel echo (0 in the open). */
  echoSend: GainNode
  knobs: {
    musicVol: Knob
    sfxVol: Knob
    engineVol: Knob
    musicTone: Knob
    musicCarve: Knob
    master: Knob
    echo: Knob
  }
}

/** How far the music's low-mids dip at full throttle (dB, negative). */
const CARVE_DB = -5
/** While rewinding: the music's level (0.5 = -6 dB) and its muffle (lowpass, Hz). */
const REWIND_MUSIC = 0.5
const REWIND_MUSIC_HZ = 1100
/** While rewinding the engine steps back to this much of its level, so the rewind is heard (system.ts, render.ts). */
export const REWIND_ENGINE_LEVEL = 0.6

/**
 * The tunnel echo (see the top). `send`: how much of the engine and effects goes into it at
 * full cover. The slap-back off the near wall and ceiling (seconds, level), a flutter between
 * the two walls (its delay, how much of it comes round again, its level), a short reverb
 * (seconds to die away, level), and the band the echo keeps (concrete swallows the lowest
 * rumble and the fizz). Tuned so it reads as a tunnel without making the car any louder.
 */
export const TUNNEL_ECHO = {
  send: 0.7,
  slapS: 0.052,
  slap: 0.4,
  flutterS: 0.029,
  flutterBack: 0.3,
  flutter: 0.2,
  reverbS: 1.1,
  reverb: 0.28,
  lowHz: 170,
  highHz: 3300,
}

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

  // ---- tunnel echo (the engine after its fader, and the effects; never music or menus) ----
  const E = TUNNEL_ECHO
  const echoSend = ctx.createGain()
  echoSend.gain.value = 0
  engineVol.connect(echoSend)
  fx.connect(echoSend)
  const echoLow = ctx.createBiquadFilter()
  echoLow.type = 'highpass'
  echoLow.frequency.value = E.lowHz
  const echoHigh = ctx.createBiquadFilter()
  echoHigh.type = 'lowpass'
  echoHigh.frequency.value = E.highHz
  echoSend.connect(echoLow)
  echoLow.connect(echoHigh)
  // the slap-back
  const slap = ctx.createDelay(0.2)
  slap.delayTime.value = E.slapS
  const slapLevel = ctx.createGain()
  slapLevel.gain.value = E.slap
  echoHigh.connect(slap)
  slap.connect(slapLevel)
  slapLevel.connect(sfxVol)
  // the flutter: the slap bouncing between the walls, a little less each time round
  const flutter = ctx.createDelay(0.2)
  flutter.delayTime.value = E.flutterS
  const flutterBack = ctx.createGain()
  flutterBack.gain.value = E.flutterBack
  const flutterLevel = ctx.createGain()
  flutterLevel.gain.value = E.flutter
  slap.connect(flutter)
  flutter.connect(flutterBack)
  flutterBack.connect(flutter)
  flutter.connect(flutterLevel)
  flutterLevel.connect(sfxVol)
  // the reverb
  const reverb = ctx.createConvolver()
  reverb.buffer = tunnelImpulse(ctx, E.reverbS)
  const reverbLevel = ctx.createGain()
  reverbLevel.gain.value = E.reverb
  echoHigh.connect(reverb)
  reverb.connect(reverbLevel)
  reverbLevel.connect(sfxVol)

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
    echoSend,
    knobs: {
      musicVol: new Knob(musicVol.gain, 0.08, 0.0005),
      sfxVol: new Knob(sfxVol.gain, 0.08, 0.0005),
      engineVol: new Knob(engineVol.gain, 0.18, 0.0005),
      musicTone: new Knob(musicTone.frequency, 0.25, 5),
      musicCarve: new Knob(musicCarve.gain, 0.15, 0.05),
      master: new Knob(master.gain, 0.09, 0.0005),
      echo: new Knob(echoSend.gain, 0.15, 0.001),
    },
  }
}

/**
 * A short concrete reverb, made in code: noise dying away by 60 dB over `seconds`, after a few
 * milliseconds of nothing, a little different in each ear. Seeded, so every render is the same.
 */
function tunnelImpulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const rate = ctx.sampleRate
  const n = Math.max(1, Math.round(rate * seconds))
  const buf = ctx.createBuffer(2, n, rate)
  let seed = 0x5eed7
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 4294967296
  }
  const pre = Math.round(rate * 0.008)
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c)
    for (let i = pre; i < n; i++) d[i] = (rand() * 2 - 1) * Math.exp((-6.9 * (i - pre)) / (n - pre))
  }
  return buf
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
  /** True while rewind is held: the music goes muffled and quieter. */
  rewinding: boolean
  /** 0..1 how far inside a tunnel the player's car is (telemetry.tunnel): the engine and effects echo. */
  tunnel: number
}

/** Called every frame with where the faders should be. Cheap: Knob skips unchanged values. */
export function updateMix(mix: Mix, m: MixTargets, t: number): void {
  mix.knobs.musicVol.to(m.musicMuted ? 0 : sliderToGain(m.musicVolume) * MUSIC_LEVEL * (m.rewinding ? REWIND_MUSIC : 1), t)
  mix.knobs.sfxVol.to(sliderToGain(m.sfxVolume) * SFX_LEVEL, t)
  mix.knobs.engineVol.to(m.engineLevel, t)
  mix.knobs.musicTone.to(m.paused ? 650 : m.rewinding ? REWIND_MUSIC_HZ : 20000, t)
  mix.knobs.musicCarve.to(CARVE_DB * clamp01(m.engineLoad) * clamp01(m.engineLevel), t)
  mix.knobs.master.to(m.silent ? 0 : MASTER_LEVEL, t, m.silent ? 0.04 : 0.09)
  mix.knobs.echo.to(TUNNEL_ECHO.send * clamp01(Number.isFinite(m.tunnel) ? m.tunnel : 0), t)
}

/**
 * Duck the music: dip it by `depth` (0..1) almost instantly, hold, then
 * let it swell back over about a second. A newer, deeper duck replaces
 * a shallower one in progress.
 */
export function duck(mix: Mix, depth: number, holdS: number, t: number): void {
  const p = mix.musicDuck.gain
  const floor = Math.max(SILENT, 1 - clamp01(depth))
  if (p.value < floor - 0.02) return // a deeper duck is already happening: let it finish
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
