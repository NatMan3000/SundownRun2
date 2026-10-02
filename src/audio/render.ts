// ============================================================
//  OFFLINE RENDER - record the game's sound to a .wav file
// ------------------------------------------------------------
//  An OfflineAudioContext runs the exact same mixer, engine and
//  effects code as the live game, but as fast as the computer can
//  instead of in real time, and hands back the recording. Nobody
//  has to sit and listen with a microphone: a checker can render
//  a reel, look at it (spectrogram, peak levels) and play it back.
//
//    renderEngineSweep()   the scripted test drive through the engine
//                          (or the tyre test drive: long drifts and slides)
//    renderEffectsReel()   every sound effect, one after another
//    renderMusic(mood)     a mood's soundtrack driven through a scripted
//                          drive (intro, groove, build, drop, breakdown),
//                          or the calm title arrangement
//    renderMix(stem)       everything together on a 32 s scripted drive
//                          (engine, race music, effects), or one stem of it,
//                          for checking the balance between them
//    renderRewind(stem)    a cruise with rewind held from 2 s to 5 s: the
//                          rewind sound, the music muffle and the engine dip
//                          (rewindNumbers() measures it: levels, how much is
//                          high, how long it lasts)
//
//  encodeWav() turns a recording into a 16-bit .wav file, and
//  toBase64() makes it a string the probe can carry out of the page.
// ============================================================

import type { AnyGameEvent, GameEventType } from '../core/events'
import type { UiSound } from '../core/api'
import { REWIND_ENGINE_LEVEL, buildMix, duck, updateMix } from './mixer'
import type { MixTargets } from './mixer'
import { EngineVoice, makeEngineInput } from './engine'
import { DEFAULT_ENGINE_SOUND, ENGINE_VOICINGS } from './engineVoicings'
import type { EngineSoundId } from './engineVoicings'
import { loadMotorWorklet } from './motorDsp'
import type { MotorLoad } from './motorDsp'
import { Effects } from './effects'
import { makeKit } from './voices'
import { hashString, makeNoiseBuffer } from './synth'
import { SWEEP_SECONDS, TEST_DRIVES, sweepInput } from './sweep'
import type { TestDriveId } from './sweep'
import { MusicSystem, LOOKAHEAD_S } from './music'
import { MOODS, TITLE_BPM } from './music/score'
import type { MoodId } from './music/score'

const RATE = 48000

function fullMix(): MixTargets {
  return { musicVolume: 0.7, sfxVolume: 0.85, musicMuted: false, engineLevel: 1, paused: false, silent: false, engineLoad: 0, rewinding: false }
}

/**
 * Run an offline render, pausing every `stepS` seconds to call onStep(t)
 * (the same way the live game's timers and frames would). Lets code that
 * schedules "from now" (effects, the music scheduler) run unchanged.
 */
export function stepRender(ctx: OfflineAudioContext, stepS: number, onStep: (t: number) => void): Promise<AudioBuffer> {
  const end = ctx.length / ctx.sampleRate
  for (let t = stepS; t < end - stepS; t += stepS) {
    const at = t
    ctx
      .suspend(at)
      .then(() => {
        onStep(at)
        return ctx.resume()
      })
      .catch((err) => console.error('[audio render] step failed at', at, err))
  }
  onStep(0)
  return ctx.startRendering()
}

/** Which motor an engine render uses: the audio-thread one (as the game), or the node one (a LAN guest's). */
export type MotorChoice = 'worklet' | 'nodes'

/** Build an engine voice on an offline context with its motor already plugged in. */
async function offlineEngine(ctx: OfflineAudioContext, out: AudioNode, noise: AudioBuffer, id: EngineSoundId, motor: MotorChoice): Promise<{ engine: EngineVoice; load: MotorLoad }> {
  const engine = new EngineVoice(ctx, out, noise, ENGINE_VOICINGS[id])
  const load: MotorLoad = motor === 'nodes' ? { ok: false, reason: 'forced (render)' } : await loadMotorWorklet(ctx)
  engine.attachMotor(load)
  return { engine, load }
}

/** What happened during an engine render: proof the gear-change cuts, blow-offs and pops were asked for. */
export interface EngineRenderLog {
  engine: EngineSoundId
  /** 'worklet' or 'nodes', and why. */
  motor: string
  motorReason: string
  shifts: number
  blowOffs: number
  /** Highest overrun-pop chance asked of the motor (0..1). */
  maxCrackle: number
  /** Highest turbo spool reached (0..1). */
  maxSpool: number
  /** Tyre barks (grip breaking or catching). */
  tyreBarks: number
}

/**
 * The engine test drive (idle, revs, gears, cruise, lift-off, jump with free-rev,
 * landing, drift, boost, off-road, mag grip), for one engine voicing.
 * drive 'drift' records the tyre test drive instead (see driftInput in sweep.ts).
 */
export async function renderEngineSweep(
  id: EngineSoundId = DEFAULT_ENGINE_SOUND,
  motor: MotorChoice = 'worklet',
  drive: TestDriveId = 'sweep',
): Promise<{ buf: AudioBuffer; log: EngineRenderLog }> {
  const run = TEST_DRIVES[drive]
  const ctx = new OfflineAudioContext(2, Math.ceil(RATE * run.seconds), RATE)
  const mix = buildMix(ctx)
  const noise = makeNoiseBuffer(ctx)
  const { engine } = await offlineEngine(ctx, mix.engine, noise, id, motor)
  const fxKit = makeKit(ctx, mix.fx, noise)
  const effects = new Effects(fxKit, makeKit(ctx, mix.ui, noise), (d, h) => duck(mix, d, h, ctx.currentTime))
  const input = makeEngineInput()
  updateMix(mix, fullMix(), 0)
  // The engine only schedules smooth parameter moves, so the whole drive can
  // be laid out up front at 60 updates a second, like 60 fps.
  let wasAir = false
  let airStart = 0
  let maxCrackle = 0
  let maxSpool = 0
  for (let f = 0; f <= run.seconds * 60; f++) {
    const t = f / 60
    run.input(t, input)
    engine.update(input, t)
    maxCrackle = Math.max(maxCrackle, engine.readout.crackle)
    maxSpool = Math.max(maxSpool, engine.readout.spool)
    if (input.airborne && !wasAir) airStart = t
    if (!input.airborne && wasAir) {
      const at = t
      const air = t - airStart
      ctx.suspend(Math.max(0.01, at)).then(() => {
        effects.landing(air)
        return ctx.resume()
      })
    }
    wasAir = input.airborne
  }
  const log: EngineRenderLog = {
    engine: id,
    motor: engine.motorKind,
    motorReason: engine.motorReason,
    shifts: engine.readout.shifts,
    blowOffs: engine.readout.blowOffs,
    maxCrackle: Math.round(maxCrackle * 1000) / 1000,
    maxSpool: Math.round(maxSpool * 1000) / 1000,
    tyreBarks: engine.readout.tyreBarks,
  }
  const buf = await ctx.startRendering()
  engine.dispose()
  return { buf, log }
}

type ReelItem = [number, 'ui', UiSound] | [number, GameEventType, Record<string, unknown>] | [number, 'landing', number]

/** Every sound effect in turn, with gaps, so each can be heard (and seen) on its own. */
const REEL: ReelItem[] = [
  [0.3, 'ui', 'move'],
  [0.55, 'ui', 'move'],
  [0.8, 'ui', 'move'],
  [1.1, 'ui', 'select'],
  [1.6, 'ui', 'back'],
  [2.1, 'ui', 'toggle'],
  [2.5, 'ui', 'slide'],
  [2.6, 'ui', 'slide'],
  [2.7, 'ui', 'slide'],
  [3.1, 'ui', 'error'],
  [3.7, 'ui', 'start'],
  [5.0, 'race.countdown', { seconds: 3, racers: 4 }],
  [9.2, 'boost', { strength: 1 }],
  [10.4, 'core.pickup', { index: 0, found: 1, total: 8 }],
  [10.8, 'core.pickup', { index: 1, found: 2, total: 8 }],
  [11.2, 'core.pickup', { index: 2, found: 3, total: 8 }],
  [12.2, 'crash', { what: 'wall', intensity: 0.3, speedKmh: 60 }],
  [13.0, 'crash', { what: 'wall', intensity: 0.95, speedKmh: 200 }],
  [14.4, 'crash', { what: 'car', intensity: 0.6, speedKmh: 120 }],
  [15.4, 'crash', { what: 'terrain', intensity: 0.7, speedKmh: 140 }],
  [16.6, 'prop.burst', { kind: 'crates', points: 250, remote: false }],
  [17.8, 'smash', { kind: 'post', speedKmh: 110 }],
  [19.0, 'landing', 1.2],
  [19.8, 'trick.land', { tricks: [], airTimeS: 1, combo: 1, points: 150, clean: true }],
  [20.9, 'trick.land', { tricks: [], airTimeS: 2.4, combo: 3, points: 900, clean: true }],
  [22.3, 'trick.wipeout', { lostPoints: 400 }],
  [23.6, 'drift.end', { seconds: 3, points: 400, maxAngleDeg: 30 }],
  [24.4, 'lap.sector', { sector: 1, sectors: 10, splitMs: 9000 }],
  [24.9, 'lap.sector', { sector: 2, sectors: 10, splitMs: 18000 }],
  [25.6, 'lap.complete', { lap: 1, ms: 61000, dirty: false, best: false, previousBestMs: 60000 }],
  [26.8, 'lap.complete', { lap: 2, ms: 59000, dirty: false, best: true, previousBestMs: 60000 }],
  [28.6, 'lap.complete', { lap: 3, ms: 70000, dirty: true, best: false, previousBestMs: 59000 }],
  [29.3, 'lap.void', { reason: 'skipped-sector' }],
  [30.2, 'lap.dirty', {}],
  [30.9, 'speedtrap', { kmh: 240, best: true, previousBestKmh: 220 }],
  [32.3, 'race.position', { from: 3, to: 2, of: 4 }],
  [33.0, 'race.finish', { position: 1, of: 4, ms: 180000, results: [] }],
  [35.0, 'race.finish', { position: 5, of: 6, ms: 190000, results: [] }],
  [36.9, 'tag.it', { id: 'player', name: 'You', byId: null }],
  [38.2, 'mag.on', { surface: 'loop', speedKmh: 120 }],
  [38.8, 'mag.off', { surface: 'loop', speedKmh: 50, fell: true }],
  [39.6, 'reset', { kind: 'road' }],
  [40.5, 'hunt.complete', { ms: 90000, best: true, previousBestMs: 95000 }],
  [42.2, 'mp.join', { name: 'Josh', id: 'net-2' }],
  [42.9, 'mp.leave', { name: 'Josh', id: 'net-2' }],
]

export const REEL_SECONDS = 44.5

/** Every effect, one after another (see REEL above for the timeline). */
export async function renderEffectsReel(): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, Math.ceil(RATE * REEL_SECONDS), RATE)
  const mix = buildMix(ctx)
  const noise = makeNoiseBuffer(ctx)
  const effects = new Effects(makeKit(ctx, mix.fx, noise), makeKit(ctx, mix.ui, noise), (d, h) => duck(mix, d, h, ctx.currentTime))
  updateMix(mix, fullMix(), 0)
  for (const item of REEL) {
    const [at, kind, arg] = item
    ctx.suspend(at).then(() => {
      if (kind === 'ui') effects.ui(arg as UiSound)
      else if (kind === 'landing') effects.landing(arg as number)
      else effects.handleEvent({ type: kind, t: 0, ...(arg as Record<string, unknown>) } as unknown as AnyGameEvent)
      return ctx.resume()
    })
  }
  return ctx.startRendering()
}

/**
 * Intensity by bar for the scripted drive: easy start, cruising, flat out
 * (it builds and drops), then stopped (breakdown), then rolling again.
 */
function scriptedIntensity(bar: number): number {
  if (bar < 4) return 0.2
  if (bar < 8) return 0.45
  if (bar < 14) return 0.92
  if (bar < 20) return 0.05
  return 0.35
}

export interface MusicRenderLog {
  /** [seconds, section, bar] each time the section changed. */
  sections: [number, string, number][]
  key: string
  progression: string
  bpm: number
}

/**
 * Render a mood through the scripted drive (24 bars), or the title
 * arrangement (mood 'title', 10 bars). night 0..1 darkens it.
 */
export async function renderMusic(mood: MoodId | 'title', night = 0, seed = hashString(mood)): Promise<{ buf: AudioBuffer; log: MusicRenderLog }> {
  const title = mood === 'title'
  const m = title ? MOODS.drive : MOODS[mood]
  const bars = title ? 10 : 24
  const bpm = title ? TITLE_BPM : m.bpm
  const seconds = (bars * 240) / bpm + 1.5
  const ctx = new OfflineAudioContext(2, Math.ceil(RATE * seconds), RATE)
  const mix = buildMix(ctx)
  const music = new MusicSystem(ctx, mix.music, makeNoiseBuffer(ctx))
  updateMix(mix, fullMix(), 0)
  music.scene.phase = title ? 'title' : 'playing'
  music.scene.night = night
  music.newSession(m.id, undefined, seed)
  const log: MusicRenderLog = { sections: [], key: '', progression: '', bpm }
  let last = ''
  const buf = await stepRender(ctx, LOOKAHEAD_S / 3, (t) => {
    music.scene.intensity = title ? 0 : scriptedIntensity(music.readout.bar)
    music.tick(t)
    if (music.readout.section !== last) {
      last = music.readout.section
      log.sections.push([Math.round(t * 100) / 100, last, music.readout.bar])
    }
  })
  log.key = music.readout.key
  log.progression = music.readout.progression
  music.dispose()
  return { buf, log }
}

// ---------------------------------------------------------------- rewind

/** The rewind render: 8 s of cruising with the race music, rewind held from 2 s to 5 s. */
export const REWIND_RENDER_SECONDS = 8
const REWIND_FROM_S = 2
const REWIND_TO_S = 5

/**
 * A cruise at 140 km/h with the race music playing, rewind held from 2 s to 5 s, exactly as the
 * game plays it: rewind.start and rewind.end through the effects, the music muffled and the
 * engine stepped back by the mixer while held. stem 'fx' is the rewind sound on its own.
 */
export async function renderRewind(stem: 'all' | 'fx'): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, Math.ceil(RATE * REWIND_RENDER_SECONDS), RATE)
  const mix = buildMix(ctx)
  const noise = makeNoiseBuffer(ctx)
  const { engine } = await offlineEngine(ctx, mix.engine, noise, DEFAULT_ENGINE_SOUND, 'worklet')
  const effects = new Effects(makeKit(ctx, mix.fx, noise), makeKit(ctx, mix.ui, noise), (d, h) => duck(mix, d, h, ctx.currentTime))
  const music = new MusicSystem(ctx, mix.music, noise)
  music.scene.phase = 'playing'
  music.newSession('race', undefined, hashString('rewind'))
  const targets = fullMix()
  if (stem === 'fx') targets.musicMuted = true
  const input = makeEngineInput()
  input.rpm = 0.55
  input.throttle = 0.5
  input.speedKmh = 140
  input.gear = 4
  let started = false
  let ended = false
  const buf = await stepRender(ctx, 1 / 60, (t) => {
    const held = t >= REWIND_FROM_S && t < REWIND_TO_S
    if (!started && held) {
      started = true
      effects.handleEvent({ type: 'rewind.start', t: 0, stored: 10 } as unknown as AnyGameEvent)
    }
    if (!ended && t >= REWIND_TO_S) {
      ended = true
      effects.handleEvent({ type: 'rewind.end', t: 0, seconds: 3, heldSeconds: 3 } as unknown as AnyGameEvent)
    }
    targets.rewinding = held
    targets.engineLevel = stem === 'fx' ? 0 : held ? REWIND_ENGINE_LEVEL : 1
    engine.update(input, t)
    updateMix(mix, targets, t)
    music.scene.intensity = 0.5
    music.tick(t)
  })
  engine.dispose()
  music.dispose()
  return buf
}

/** Energy of a stretch of a recording at or above `hz` (two passes of a 12 dB/octave highpass). */
function energyAbove(d: Float32Array, from: number, to: number, hz: number, rate: number): number {
  const w0 = (2 * Math.PI * hz) / rate
  const cw = Math.cos(w0)
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2)
  const a0 = 1 + alpha
  const b0 = (1 + cw) / 2 / a0
  const b1 = -(1 + cw) / a0
  const b2 = b0
  const a1 = (-2 * cw) / a0
  const a2 = (1 - alpha) / a0
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0, u1 = 0, u2 = 0, z1 = 0, z2 = 0
  let sum = 0
  for (let i = Math.max(0, from - 2000); i < to; i++) {
    const x = d[i]
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
    x2 = x1
    x1 = x
    y2 = y1
    y1 = y
    const z = b0 * y + b1 * u1 + b2 * u2 - a1 * z1 - a2 * z2
    u2 = u1
    u1 = y
    z2 = z1
    z1 = z
    if (i >= from) sum += z * z
  }
  return sum
}

/**
 * The rewind render in numbers: the whole mix before, during and after the hold (dBFS), and the
 * rewind sound on its own: how loud, how much of it is above 1 kHz and 4 kHz (it should be
 * almost none: no whine, no hiss), and how long it lasts before it is quieter than -50 dBFS.
 */
export function rewindNumbers(all: AudioBuffer, fx: AudioBuffer): Record<string, unknown> {
  const rate = all.sampleRate
  const db = (x: number) => (x > 0 ? Math.round(10 * Math.log10(x) * 10) / 10 : -100)
  const rms = (b: AudioBuffer, a: number, z: number) => {
    const d = b.getChannelData(0)
    let s = 0
    for (let i = Math.floor(a * rate); i < Math.floor(z * rate); i++) s += d[i] * d[i]
    return s / Math.max(1, (z - a) * rate)
  }
  const share = (b: AudioBuffer, a: number, z: number, hz: number) => {
    const d = b.getChannelData(0)
    const from = Math.floor(a * rate)
    const to = Math.floor(z * rate)
    let tot = 0
    for (let i = from; i < to; i++) tot += d[i] * d[i]
    return tot > 0 ? Math.round((energyAbove(d, from, to, hz, rate) / tot) * 1000) / 10 : 0
  }
  // how long the rewind sound lasts: the last 50 ms window after the start still louder than -50 dBFS
  let lastLoud = REWIND_FROM_S
  for (let t = REWIND_FROM_S; t < REWIND_TO_S - 0.05; t += 0.05) if (rms(fx, t, t + 0.05) > 1e-5) lastLoud = t + 0.05
  return {
    mixRmsDb: { before: db(rms(all, 0.8, 1.95)), held: db(rms(all, 2.6, 4.9)), after: db(rms(all, 5.6, 7.6)) },
    mixAbove1kHzPct: { before: share(all, 0.8, 1.95, 1000), held: share(all, 2.6, 4.9, 1000), after: share(all, 5.6, 7.6, 1000) },
    rewindSound: {
      startRmsDb: db(rms(fx, REWIND_FROM_S, REWIND_FROM_S + 0.6)),
      startAbove1kHzPct: share(fx, REWIND_FROM_S, REWIND_FROM_S + 1.5, 1000),
      startAbove4kHzPct: share(fx, REWIND_FROM_S, REWIND_FROM_S + 1.5, 4000),
      lastsS: Math.round((lastLoud - REWIND_FROM_S) * 100) / 100,
      heldTailRmsDb: db(rms(fx, 3.8, 4.9)),
      clunkRmsDb: db(rms(fx, REWIND_TO_S, REWIND_TO_S + 0.15)),
      clunkAbove1kHzPct: share(fx, REWIND_TO_S, REWIND_TO_S + 0.2, 1000),
    },
  }
}

export type MixStem = 'all' | 'engine' | 'music' | 'fx'

/** Effects fired during the mix drive: [seconds, event type, payload]. */
const MIX_EVENTS: [number, GameEventType, Record<string, unknown>][] = [
  [5.2, 'core.pickup', { index: 0, found: 1, total: 8 }],
  [8.1, 'trick.land', { tricks: [], airTimeS: 1.4, combo: 2, points: 450, clean: true }],
  [9.5, 'boost', { strength: 1 }],
  [14.5, 'crash', { what: 'wall', intensity: 0.85, speedKmh: 170 }],
  [17.2, 'core.pickup', { index: 1, found: 2, total: 8 }],
  [20.3, 'lap.complete', { lap: 1, ms: 59000, dirty: false, best: true, previousBestMs: 61000 }],
  [24.0, 'speedtrap', { kmh: 231, best: false, previousBestKmh: 240 }],
  [27.5, 'prop.burst', { kind: 'crates', points: 300, remote: false }],
]

export const MIX_SECONDS = 32

/**
 * The full mix (or one stem) on a scripted drive: the engine test drive
 * twice over, race music following the speed, and effects on top, all at
 * the default volume settings. Stems are the same render with the other
 * groups muted, so their levels can be compared directly.
 */
export async function renderMix(stem: MixStem, id: EngineSoundId = DEFAULT_ENGINE_SOUND): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, Math.ceil(RATE * MIX_SECONDS), RATE)
  const mix = buildMix(ctx)
  const noise = makeNoiseBuffer(ctx)
  const { engine } = await offlineEngine(ctx, mix.engine, noise, id, 'worklet')
  const effects = new Effects(makeKit(ctx, mix.fx, noise), makeKit(ctx, mix.ui, noise), (d, h) => duck(mix, d, h, ctx.currentTime))
  const music = new MusicSystem(ctx, mix.music, noise)
  music.scene.phase = 'playing'
  music.newSession('race', undefined, hashString('mix'))
  const targets = fullMix()
  if (stem === 'engine' || stem === 'fx') targets.musicMuted = true
  if (stem === 'music' || stem === 'fx') targets.engineLevel = 0
  if (stem === 'engine' || stem === 'music') mix.fx.gain.value = 0
  const input = makeEngineInput()
  let nextEvent = 0
  return stepRender(ctx, 1 / 60, (t) => {
    // Effects fire from the step callback (a second suspend at the same moment is not allowed).
    while (nextEvent < MIX_EVENTS.length && MIX_EVENTS[nextEvent][0] <= t) {
      const [, type, payload] = MIX_EVENTS[nextEvent++]
      effects.handleEvent({ type, t: 0, ...payload } as unknown as AnyGameEvent)
    }
    sweepInput(t % SWEEP_SECONDS, input)
    engine.update(input, t)
    targets.engineLoad = input.throttle
    updateMix(mix, targets, t)
    music.scene.intensity = Math.min(1, input.speedKmh / 230 + input.boost * 0.3)
    music.tick(t)
  })
}

// ---------------------------------------------------------------- file output

/** A recording as a 16-bit PCM .wav file. */
export function encodeWav(buf: AudioBuffer): ArrayBuffer {
  const ch = buf.numberOfChannels
  const n = buf.length
  const bytes = 44 + n * ch * 2
  const out = new ArrayBuffer(bytes)
  const v = new DataView(out)
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i))
  }
  str(0, 'RIFF')
  v.setUint32(4, bytes - 8, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, ch, true)
  v.setUint32(24, buf.sampleRate, true)
  v.setUint32(28, buf.sampleRate * ch * 2, true)
  v.setUint16(32, ch * 2, true)
  v.setUint16(34, 16, true)
  str(36, 'data')
  v.setUint32(40, n * ch * 2, true)
  const data: Float32Array[] = []
  for (let c = 0; c < ch; c++) data.push(buf.getChannelData(c))
  let o = 44
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, data[c][i]))
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true)
      o += 2
    }
  }
  return out
}

/** Bytes to a base64 string (in chunks, so a long file doesn't overflow the call stack). */
export function toBase64(ab: ArrayBuffer): string {
  const u8 = new Uint8Array(ab)
  let s = ''
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + 0x8000)))
  return btoa(s)
}

/** Peak and RMS level of a recording, in dBFS, for a quick numeric check. */
export function measure(buf: AudioBuffer): { peakDb: number; rmsDb: number; seconds: number } {
  let peak = 0
  let sum = 0
  let count = 0
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c)
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i])
      if (a > peak) peak = a
      sum += d[i] * d[i]
      count++
    }
  }
  const db = (x: number) => (x > 0 ? Math.round(20 * Math.log10(x) * 10) / 10 : -100)
  return { peakDb: db(peak), rmsDb: db(Math.sqrt(sum / Math.max(1, count))), seconds: buf.duration }
}
