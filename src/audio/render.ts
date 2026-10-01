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
//    renderEffectsReel()   every sound effect, one after another
//    renderMusic(mood)     a mood's soundtrack driven through a scripted
//                          drive (intro, groove, build, drop, breakdown),
//                          or the calm title arrangement
//
//  encodeWav() turns a recording into a 16-bit .wav file, and
//  toBase64() makes it a string the probe can carry out of the page.
// ============================================================

import type { AnyGameEvent, GameEventType } from '../core/events'
import type { UiSound } from '../core/api'
import { buildMix, duck, updateMix } from './mixer'
import type { MixTargets } from './mixer'
import { EngineVoice, makeEngineInput } from './engine'
import { Effects } from './effects'
import { makeKit } from './voices'
import { makeNoiseBuffer } from './synth'
import { SWEEP_SECONDS, sweepInput } from './sweep'
import { MusicSystem, LOOKAHEAD_S } from './music'
import { MOODS, TITLE_BPM } from './music/score'
import type { MoodId } from './music/score'

const RATE = 48000

function fullMix(): MixTargets {
  return { musicVolume: 0.7, sfxVolume: 0.85, musicMuted: false, engineLevel: 1, paused: false, silent: false }
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

/** The engine test drive (idle, gears, jump with free-rev, landing, drift, boost, off-road, mag grip). */
export async function renderEngineSweep(): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, Math.ceil(RATE * SWEEP_SECONDS), RATE)
  const mix = buildMix(ctx)
  const noise = makeNoiseBuffer(ctx)
  const engine = new EngineVoice(ctx, mix.engine, noise)
  const fxKit = makeKit(ctx, mix.fx, noise)
  const effects = new Effects(fxKit, makeKit(ctx, mix.ui, noise), (d, h) => duck(mix, d, h, ctx.currentTime))
  const input = makeEngineInput()
  updateMix(mix, fullMix(), 0)
  // The engine only schedules smooth parameter moves, so the whole drive can
  // be laid out up front at 60 updates a second, like 60 fps.
  let wasAir = false
  let airStart = 0
  for (let f = 0; f <= SWEEP_SECONDS * 60; f++) {
    const t = f / 60
    sweepInput(t, input)
    engine.update(input, t)
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
  return ctx.startRendering()
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
export async function renderMusic(mood: MoodId | 'title', night = 0, seed = 0x51ed): Promise<{ buf: AudioBuffer; log: MusicRenderLog }> {
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
