// ============================================================
//  SOUND EFFECTS - one-shots for game moments and menus
// ------------------------------------------------------------
//  Every gameplay sound starts from an event in src/core/events.ts
//  (a crash, a pickup, a lap). handleEvent() below is the one big
//  switch that turns each event into a sound. Menu sounds come in
//  through ui(kind), which the menus call via audio.ui().
//
//  Musical sounds (chimes, stingers, fanfares) are built from the
//  key the soundtrack is in right now (theory.ts musicKey), so they
//  always land in tune with the music playing under them.
//
//  Loudness guide (peak gain): menu ticks ~0.05, pickups ~0.2,
//  big crashes up to ~0.6. The limiter in mixer.ts catches pile-ups.
//
//  Rewind (rewindStart / rewindStop) is low and short on purpose: a
//  swoop, a reversed whoosh and a flutter that dies away, then a soft
//  clunk on letting go. The mixer muffles the music while it is held.
// ============================================================

import type { AnyGameEvent } from '../core/events'
import { getCar } from '../core/telemetry'
import { getGame } from '../core/store'
import type { UiSound } from '../core/api'
import { brightPentaMidi, musicKey } from './theory'
import { SILENT, clamp01, holdParam, midiToHz, mulberry32 } from './synth'
import { bell, hasRoom, noiseHit, sweep, thump, tone } from './voices'
import type { VoiceKit } from './voices'

/** Called when a crash is big enough that the music should get out of the way. */
export type DuckFn = (depth: number, holdS: number) => void

/** A short gap on the audio clock between parts of one sound (seconds). */
const LEAD_IN = 0.004
/** How long the rewind's low flutter lasts before it has died away (seconds). */
const REWIND_FLUTTER_S = 1.4

export class Effects {
  /** How many times each sound has played since sound started (inspector: proves a sound fired). */
  readonly counts: Record<string, number> = {}
  private readonly rnd = mulberry32(0x5eed5)
  private readonly lastAt: Record<string, number> = {}
  // the race countdown (see watchCountdown)
  /** store.raceGoAt of the countdown already booked (-1 = booked from an event with no store time). */
  private bookedGoAtMs = 0
  /** Audio-clock time of the booked GO. */
  private goAt = -1
  /** The booked beeps play through this, so an aborted countdown can be silenced. */
  private countdownBus: GainNode | null = null
  /** The last aborted countdown's bus, kept only so the inspector can show it went silent. */
  private abortedBus: GainNode | null = null
  /** The rewind flutter while it is still sounding (null when it isn't): its sources and its level. */
  private rewindVoice: { noise: AudioBufferSourceNode; flutter: OscillatorNode; amp: GainNode; nodes: AudioNode[] } | null = null

  constructor(
    private readonly fx: VoiceKit,
    private readonly uiKit: VoiceKit,
    private readonly duck: DuckFn,
  ) {}

  private get now(): number {
    return this.fx.ctx.currentTime + LEAD_IN
  }

  private count(kind: string): void {
    this.counts[kind] = (this.counts[kind] ?? 0) + 1
  }

  /** True if `kind` played less than `gapS` ago (then skip it). Marks it as played otherwise. */
  private tooSoon(kind: string, gapS: number): boolean {
    const t = this.fx.ctx.currentTime
    const last = this.lastAt[kind]
    if (last !== undefined && t - last < gapS) return true
    this.lastAt[kind] = t
    return false
  }

  private pick(lo: number, hi: number): number {
    return lo + (hi - lo) * this.rnd()
  }

  // ================================================================ menus

  ui(kind: UiSound): void {
    const k = this.uiKit
    const t = k.ctx.currentTime + LEAD_IN
    const root = musicKey.root
    switch (kind) {
      case 'move':
        if (this.tooSoon('ui.move', 0.03)) return
        bell(k, midiToHz(root + 31), t, 0.045, 0.06, 0.5, 2)
        break
      case 'slide':
        if (this.tooSoon('ui.slide', 0.035)) return
        tone(k, 'sine', midiToHz(root + 36), t, 0.03, 0.002, 0.03)
        break
      case 'select':
        bell(k, midiToHz(brightPentaMidi(2, 1)), t, 0.08, 0.12, 1.4)
        bell(k, midiToHz(brightPentaMidi(4, 1)), t + 0.055, 0.08, 0.2, 1.4)
        break
      case 'back':
        tone(k, 'triangle', midiToHz(brightPentaMidi(4, 1)), t, 0.06, 0.004, 0.08)
        tone(k, 'triangle', midiToHz(brightPentaMidi(1, 1)), t + 0.06, 0.06, 0.004, 0.14)
        break
      case 'toggle':
        noiseHit(k, t, 0.05, 'highpass', 4500, 0.7, 0.001, 0.014)
        sweep(k, 'sine', midiToHz(root + 24), midiToHz(root + 31), t, 0.07, 0.06, 0.004)
        break
      case 'start':
        this.startSwell(k, t)
        break
      case 'error':
        tone(k, 'triangle', midiToHz(root - 2), t, 0.09, 0.004, 0.09)
        tone(k, 'triangle', midiToHz(root - 2), t + 0.12, 0.09, 0.004, 0.14)
        noiseHit(k, t, 0.025, 'lowpass', 700, 0.8, 0.002, 0.08)
        break
      case 'countdown':
      case 'go':
        // The race countdown belongs to the event (booked on the audio clock).
        // While one is booked, a menu call for the same sound is ignored.
        if (this.countdownLive()) return
        this.beep(k, t, kind === 'go')
        break
    }
    this.count(`ui.${kind}`)
  }

  /** The race-start beep in the current key. */
  private beep(k: VoiceKit, t: number, go: boolean): void {
    this.beepAt(k, t, go, musicKey.root)
  }

  /** The race-start beep on `root`. GO is an octave up, longer, with a fifth and a low punch. */
  private beepAt(k: VoiceKit, t: number, go: boolean, root: number, dest?: AudioNode): void {
    const hz = midiToHz(root + (go ? 36 : 24))
    const o = dest ? { dest } : undefined
    if (go) {
      tone(k, 'triangle', hz, t, 0.16, 0.004, 0.7, o)
      tone(k, 'sine', hz * 1.5, t, 0.08, 0.004, 0.6, o)
      tone(k, 'square', hz / 2, t, 0.025, 0.004, 0.35, o)
      thump(k, t, 0.22, 140, 45, 0.3, o)
    } else {
      tone(k, 'triangle', hz, t, 0.14, 0.003, 0.16, o)
      tone(k, 'sine', hz * 2, t, 0.03, 0.003, 0.08, o)
    }
  }

  /** Start-game swell: a filtered saw rising into a bright chord, with a whoosh. */
  private startSwell(k: VoiceKit, t: number): void {
    sweep(k, 'sawtooth', midiToHz(musicKey.root - 12), midiToHz(musicKey.root + 12), t, 0.45, 0.06, 0.05, 1800)
    noiseHit(k, t, 0.06, 'bandpass', 500, 0.9, 0.3, 0.2, 5000)
    for (let i = 0; i < 3; i++) bell(k, midiToHz(brightPentaMidi(i * 2, 1)), t + 0.32 + i * 0.05, 0.08, 0.6, 1.6)
  }

  // ================================================================ game events

  handleEvent(e: AnyGameEvent): void {
    const k = this.fx
    const t = this.now
    switch (e.type) {
      case 'crash':
        this.crash(k, t, e.what, clamp01(e.intensity))
        break
      case 'prop.burst':
        this.shatter(k, t, e.remote ? 0.35 : 1, clamp01(e.points / 500))
        break
      case 'smash':
        this.smash(k, t, clamp01(e.speedKmh / 160))
        break
      case 'core.pickup':
        this.chime(k, t, e.found, e.total)
        break
      case 'hunt.complete':
        this.fanfare(k, t, e.best ? 1 : 0.6)
        break
      case 'trick.land':
        if (e.points > 0) this.stinger(k, t, e.points, e.combo)
        break
      case 'trick.wipeout':
        this.wipeout(k, t)
        break
      case 'drift.end':
        if (e.points > 0) this.sparkle(k, t, clamp01(e.points / 600))
        break
      case 'lap.complete':
        if (e.dirty) this.mutedLap(k, t)
        else if (e.best) this.fanfare(k, t, 0.85)
        else this.lapTriad(k, t)
        break
      case 'lap.void':
        this.shrug(k, t)
        break
      case 'lap.dirty':
        tone(k, 'triangle', midiToHz(musicKey.root + 7), t, 0.04, 0.004, 0.1)
        tone(k, 'triangle', midiToHz(musicKey.root + 5), t + 0.09, 0.04, 0.004, 0.16)
        break
      case 'lap.sector':
        // Very subtle: a glassy tick, you feel it more than hear it.
        bell(k, midiToHz(brightPentaMidi(4 + (e.sector % 3), 2)), t, 0.03, 0.14, 0.6)
        break
      case 'race.countdown':
        this.onCountdownEvent(e.seconds)
        return // counted when booked
      case 'race.start':
        // GO was booked with the countdown: don't play it again.
        if (this.countdownLive() || (this.goAt > 0 && Math.abs(this.goAt - k.ctx.currentTime) < 0.5)) break
        this.beep(k, t, true)
        break
      case 'race.position':
        if (getGame().raceState !== 'running' || this.tooSoon('race.position', 0.8)) return
        if (e.to < e.from) {
          tone(k, 'triangle', midiToHz(brightPentaMidi(2, 1)), t, 0.05, 0.004, 0.08)
          tone(k, 'triangle', midiToHz(brightPentaMidi(4, 1)), t + 0.07, 0.05, 0.004, 0.12)
        } else {
          tone(k, 'triangle', midiToHz(brightPentaMidi(3, 1)), t, 0.035, 0.004, 0.08)
          tone(k, 'triangle', midiToHz(brightPentaMidi(1, 1)), t + 0.07, 0.035, 0.004, 0.12)
        }
        break
      case 'race.finish':
        if (e.position === 1) this.fanfare(k, t, 1)
        else if (e.position <= 3) this.lapTriad(k, t, true)
        else this.cadence(k, t)
        break
      case 'stunt.start':
        this.beep(k, t, true)
        break
      case 'stunt.end':
        if (e.best) this.fanfare(k, t, 0.9)
        else this.lapTriad(k, t, true)
        break
      case 'boost':
        this.boostKick(k, t, Math.max(0.4, Math.min(1.6, e.strength)))
        break
      case 'speedtrap':
        this.ping(k, t, e.best)
        break
      case 'tag.it': {
        const car = getCar(e.id)
        if (e.id === 'player' || car?.kind === 'player') this.youreIt(k, t)
        else bell(k, midiToHz(brightPentaMidi(3, 1)), t, 0.05, 0.25, 1.2)
        break
      }
      case 'mp.join':
        bell(k, midiToHz(brightPentaMidi(0, 1)), t, 0.05, 0.2, 1)
        bell(k, midiToHz(brightPentaMidi(2, 1)), t + 0.08, 0.05, 0.3, 1)
        break
      case 'mp.leave':
        bell(k, midiToHz(brightPentaMidi(2, 1)), t, 0.04, 0.2, 1)
        bell(k, midiToHz(brightPentaMidi(0, 1)), t + 0.08, 0.04, 0.3, 1)
        break
      case 'mag.on':
        sweep(k, 'sine', 260, 820, t, 0.13, 0.07, 0.006)
        noiseHit(k, t, 0.04, 'highpass', 3000, 0.7, 0.001, 0.03)
        break
      case 'mag.off':
        if (e.fell) sweep(k, 'sine', 700, 140, t, 0.3, 0.07, 0.01)
        break
      case 'reset':
        sweep(k, 'triangle', 380, 1500, t, 0.28, 0.06, 0.02)
        noiseHit(k, t, 0.05, 'highpass', 2500, 0.8, 0.12, 0.2, 7000)
        break
      case 'rewind.start':
        this.rewindStart(k, t)
        break
      case 'rewind.end':
        this.rewindStop(k, t)
        break
      default:
        return
    }
    this.count(e.type)
  }

  // ================================================================ rewind

  /**
   * Time running backwards, kept low and short (no whine, no hiss): a low swoop gliding down as
   * the "tape" reverses, a reversed whoosh that swells and cuts off, and a low fluttering rumble
   * underneath that dies away within about a second and a half. A long hold is then carried by
   * the muffled music and the engine replaying backwards (mixer.ts, system.ts).
   */
  private rewindStart(k: VoiceKit, t: number): void {
    if (this.rewindVoice) this.stopRewindVoice(t)
    // the reels reversing: a low glide, lowpassed so it is felt more than heard
    sweep(k, 'triangle', 210, 68, t, 0.42, 0.11, 0.012, 380)
    // a reversed whoosh: swells over a quarter second, then cuts, its filter closing as it goes
    noiseHit(k, t, 0.045, 'lowpass', 1000, 0.7, 0.24, 0.12, 240)
    // the low flutter under it: rumble below 300 Hz, wobbling 6 times a second, fading out
    const ctx = k.ctx
    const noise = ctx.createBufferSource()
    noise.buffer = k.noise
    noise.loop = true
    const low = ctx.createBiquadFilter()
    low.type = 'lowpass'
    low.frequency.value = 300
    low.Q.value = 0.8
    const wobble = ctx.createGain()
    wobble.gain.value = 0.6
    const flutter = ctx.createOscillator()
    flutter.frequency.value = 6
    const depth = ctx.createGain()
    depth.gain.value = 0.4 // wobble = 0.6 +- 0.4
    flutter.connect(depth)
    depth.connect(wobble.gain)
    const amp = ctx.createGain()
    amp.gain.setValueAtTime(SILENT, t)
    amp.gain.exponentialRampToValueAtTime(0.09, t + 0.1)
    amp.gain.exponentialRampToValueAtTime(SILENT, t + REWIND_FLUTTER_S)
    noise.connect(low)
    low.connect(wobble)
    wobble.connect(amp)
    amp.connect(k.out)
    k.noiseCursor = (k.noiseCursor + 0.377) % 1.5
    noise.start(t, k.noiseCursor)
    flutter.start(t)
    const end = t + REWIND_FLUTTER_S + 0.05
    noise.stop(end)
    flutter.stop(end)
    const v = { noise, flutter, amp, nodes: [low, wobble, depth, amp] as AudioNode[] }
    flutter.onended = () => {
      noise.disconnect()
      flutter.disconnect()
      for (let i = 0; i < v.nodes.length; i++) v.nodes[i].disconnect()
      if (this.rewindVoice === v) this.rewindVoice = null
    }
    this.rewindVoice = v
  }

  /** Cut the flutter short (a quick tap of rewind lets go before it has died away). */
  private stopRewindVoice(t: number): void {
    const v = this.rewindVoice
    this.rewindVoice = null
    if (!v) return
    holdParam(v.amp.gain, t)
    v.amp.gain.exponentialRampToValueAtTime(SILENT, t + 0.06)
    v.noise.stop(t + 0.08)
    v.flutter.stop(t + 0.08)
  }

  /** Let go: anything still fluttering stops, and the transport catches with a soft low clunk. */
  private rewindStop(k: VoiceKit, t: number): void {
    this.stopRewindVoice(t)
    thump(k, t + 0.01, 0.15, 130, 58, 0.12)
    noiseHit(k, t + 0.01, 0.035, 'lowpass', 520, 0.7, 0.002, 0.05)
  }

  /** The car came down from a jump. airS = seconds in the air. Driven by the telemetry edge, not an event. */
  landing(airS: number): void {
    const k = this.fx
    const t = this.now
    const i = clamp01((airS - 0.2) / 1.4)
    thump(k, t, 0.12 + 0.3 * i, 110, 38, 0.22 + 0.15 * i)
    noiseHit(k, t, 0.05 + 0.1 * i, 'lowpass', 1100, 0.9, 0.002, 0.08 + 0.08 * i)
    this.count('landing')
  }

  // ================================================================ the sounds

  private crash(k: VoiceKit, t: number, what: string, i: number): void {
    if (this.tooSoon('crash', 0.09)) return
    thump(k, t, 0.14 + 0.46 * i, 120 + 70 * i, 36, 0.2 + 0.35 * i)
    noiseHit(k, t, 0.1 + 0.28 * i, 'lowpass', 1600 + 1200 * i, 0.8, 0.002, 0.1 + 0.25 * i, 260)
    noiseHit(k, t, 0.04 + 0.12 * i, 'bandpass', 3200, 0.8, 0.001, 0.05 + 0.04 * i)
    if (what === 'wall' || what === 'barrier') {
      // a metallic clang: an inharmonic FM bell (ratio 1.41 is deliberately "wrong")
      bell(k, 170 + 40 * this.rnd(), t + 0.005, 0.05 + 0.1 * i, 0.45 + 0.3 * i, 4, 1.41)
    } else if (what === 'car') {
      thump(k, t + 0.055, 0.08 + 0.2 * i, 160, 50, 0.16)
    } else if (what === 'terrain') {
      noiseHit(k, t + 0.01, 0.06 + 0.12 * i, 'lowpass', 320, 1, 0.01, 0.3 + 0.2 * i)
    }
    if (i > 0.45) this.duck(0.3 + 0.45 * i, 0.12 + 0.3 * i)
  }

  /** Crash-prop burst: glassy shatter plus a bright chime. size 0..1 = how big the burst was. */
  private shatter(k: VoiceKit, t: number, level: number, size: number): void {
    if (!hasRoom(k)) return
    const pieces = 5 + Math.round(size * 4)
    for (let n = 0; n < pieces; n++) {
      const at = t + n * this.pick(0.008, 0.026)
      noiseHit(k, at, level * this.pick(0.04, 0.09), 'bandpass', this.pick(3000, 8500), this.pick(4, 9), 0.001, this.pick(0.04, 0.16), undefined, {
        pan: this.pick(-0.6, 0.6),
      })
    }
    for (let n = 0; n < 3; n++) {
      bell(k, this.pick(2200, 4200), t + n * 0.02, level * 0.035, this.pick(0.15, 0.3), 3, 3.53, { pan: this.pick(-0.5, 0.5) })
    }
    const step = 3 + Math.floor(this.rnd() * 4)
    bell(k, midiToHz(brightPentaMidi(step, 2)), t + 0.03, level * (0.11 + 0.06 * size), 0.55, 1.8)
    thump(k, t, level * 0.08, 200, 70, 0.1)
  }

  /** Roadside smash: crunchier than a prop, with weight from the speed. */
  private smash(k: VoiceKit, t: number, i: number): void {
    thump(k, t, 0.12 + 0.2 * i, 150, 45, 0.22)
    noiseHit(k, t, 0.1 + 0.15 * i, 'bandpass', 1800, 1.2, 0.001, 0.14, 700)
    for (let n = 0; n < 6; n++) {
      noiseHit(k, t + n * this.pick(0.01, 0.03), this.pick(0.03, 0.07), 'bandpass', this.pick(1500, 5500), this.pick(3, 7), 0.001, this.pick(0.05, 0.14), undefined, {
        pan: this.pick(-0.7, 0.7),
      })
    }
  }

  /** Energy core: a chime that climbs one note up the scale with every core found. */
  private chime(k: VoiceKit, t: number, found: number, total: number): void {
    const step = Math.max(0, found - 1)
    const hz = midiToHz(brightPentaMidi(step, 1))
    bell(k, hz, t, 0.26, 0.75, 2.2)
    tone(k, 'triangle', hz * 2, t, 0.06, 0.004, 0.3)
    tone(k, 'sine', midiToHz(musicKey.root - 12), t, 0.05, 0.01, 0.4)
    noiseHit(k, t, 0.03, 'highpass', 5000, 0.7, 0.05, 0.2)
    if (found === total) bell(k, hz * 2, t + 0.12, 0.08, 0.9, 1.4)
  }

  /** Trick landed: an ascending run, longer and fuller for bigger points, pitched up by the combo. */
  private stinger(k: VoiceKit, t: number, points: number, combo: number): void {
    const big = clamp01(points / 600)
    if (big > 0.3) this.duck(0.2 + 0.15 * big, 0.25)
    const notes = 2 + Math.round(big * 4)
    const lift = Math.min(4, Math.max(0, combo - 1))
    for (let n = 0; n < notes; n++) {
      const at = t + n * 0.055
      const hz = midiToHz(brightPentaMidi(n + lift, 1))
      bell(k, hz, at, 0.17 + 0.1 * big, 0.32, 2)
      tone(k, 'triangle', hz * 2, at, 0.03 + 0.03 * big, 0.004, 0.16)
    }
    if (big > 0.55) {
      tone(k, 'sine', midiToHz(musicKey.root - 12), t, 0.1, 0.01, 0.8)
      noiseHit(k, t + notes * 0.055, 0.04, 'highpass', 6000, 0.7, 0.05, 0.4)
    }
  }

  /** Wipeout: everything falls. A down-sweep and a thud. */
  private wipeout(k: VoiceKit, t: number): void {
    sweep(k, 'sawtooth', 560, 70, t, 0.75, 0.09, 0.01, 1300)
    sweep(k, 'sawtooth', 373, 47, t + 0.04, 0.75, 0.06, 0.01, 900)
    thump(k, t + 0.5, 0.12, 90, 35, 0.3)
  }

  /** A small sparkle for a scored drift. */
  private sparkle(k: VoiceKit, t: number, size: number): void {
    const notes = 2 + Math.round(size * 2)
    for (let n = 0; n < notes; n++) bell(k, midiToHz(brightPentaMidi(n * 2, 2)), t + n * 0.045, 0.045 + 0.03 * size, 0.25, 1.2)
  }

  /** A clean lap: a quick bright triad. resolved = a touch longer, for finishes. */
  private lapTriad(k: VoiceKit, t: number, resolved = false): void {
    const steps = resolved ? [0, 2, 4, 5] : [0, 2, 4]
    this.duck(0.25, 0.3)
    for (let n = 0; n < steps.length; n++) {
      const hz = midiToHz(brightPentaMidi(steps[n], 1))
      bell(k, hz, t + n * 0.09, 0.2, 0.45, 1.8)
      tone(k, 'triangle', hz, t + n * 0.09, 0.05, 0.004, 0.25)
    }
  }

  /** Best lap, hunt complete, race win: a short fanfare. size 0..1 scales how much. */
  private fanfare(k: VoiceKit, t: number, size: number): void {
    const run = [0, 2, 4, 5, 7]
    const n = size >= 0.85 ? 5 : 4
    // A moment worth hearing: the music steps back for it, then swells in again.
    this.duck(0.3 + 0.15 * size, 0.6)
    for (let i = 0; i < n; i++) {
      const hz = midiToHz(brightPentaMidi(run[i], 1))
      bell(k, hz, t + i * 0.085, 0.24, 0.5, 2)
      tone(k, 'sawtooth', hz, t + i * 0.085, 0.035, 0.006, 0.18)
    }
    // the held chord under the last note: relative-major root, third, fifth
    const chordAt = t + n * 0.085
    const base = musicKey.root + 3
    const chord = [0, 4, 7, 12]
    for (let i = 0; i < chord.length; i++) tone(k, 'triangle', midiToHz(base + 12 + chord[i]), chordAt, 0.07 * size, 0.03, 1.1, { pan: (i - 1.5) * 0.3 })
    tone(k, 'sine', midiToHz(base - 12), chordAt, 0.14 * size, 0.02, 1.2)
    if (size >= 0.85) {
      noiseHit(k, t, 0.05, 'highpass', 4000, 0.7, 0.35, 0.6)
      tone(k, 'sine', midiToHz(base + 36), chordAt + 0.15, 0.04, 0.05, 1.2)
    }
  }

  /** A dirty lap: no flourish, just a soft muted note so you know it counted but didn't score. */
  private mutedLap(k: VoiceKit, t: number): void {
    tone(k, 'triangle', midiToHz(musicKey.root + 12), t, 0.06, 0.006, 0.25)
  }

  /** Lap voided: two flat notes falling a minor third. A shrug, not a telling-off. */
  private shrug(k: VoiceKit, t: number): void {
    tone(k, 'triangle', midiToHz(musicKey.root + 10), t, 0.12, 0.004, 0.13)
    tone(k, 'triangle', midiToHz(musicKey.root + 7), t + 0.11, 0.12, 0.004, 0.28)
    noiseHit(k, t, 0.03, 'lowpass', 650, 0.7, 0.002, 0.08)
  }

  /** Finished out of the top three: a gentle minor cadence (iv to i). */
  private cadence(k: VoiceKit, t: number): void {
    const r = musicKey.root
    const iv = [5, 8, 12]
    const i = [0, 3, 7]
    for (let n = 0; n < 3; n++) tone(k, 'triangle', midiToHz(r + 12 + iv[n]), t, 0.05, 0.02, 0.5)
    for (let n = 0; n < 3; n++) tone(k, 'triangle', midiToHz(r + 12 + i[n]), t + 0.45, 0.05, 0.02, 1)
    tone(k, 'sine', midiToHz(r - 12), t + 0.45, 0.1, 0.02, 1)
  }

  /** Boost pad: a spool-up whine, a whoosh and a low kick. */
  private boostKick(k: VoiceKit, t: number, s: number): void {
    sweep(k, 'sine', 180, 1500, t, 0.36, 0.07 * s, 0.03)
    sweep(k, 'triangle', 270, 2250, t + 0.02, 0.34, 0.03 * s, 0.03)
    noiseHit(k, t, 0.15 * s, 'bandpass', 450, 1.1, 0.12, 0.38, 4200)
    thump(k, t, 0.18 * s, 95, 40, 0.25)
  }

  /** Speed trap: a radar ping with two echoes. A best gets a second ping a fifth up. */
  private ping(k: VoiceKit, t: number, best: boolean): void {
    const hz = midiToHz(brightPentaMidi(5, 2))
    for (let n = 0; n < 3; n++) bell(k, hz, t + n * 0.17, 0.15 / (1 + n * 1.8), 0.55, 1.2, 3, { pan: n === 0 ? 0 : n === 1 ? -0.4 : 0.4 })
    if (best) {
      bell(k, hz * 1.5, t + 0.09, 0.12, 0.7, 1.4)
      noiseHit(k, t + 0.09, 0.03, 'highpass', 6000, 0.7, 0.05, 0.35)
    }
  }

  /** Tag: you're it. A two-tone synth siren, three times. Urgent but not harsh. */
  private youreIt(k: VoiceKit, t: number): void {
    const a = midiToHz(musicKey.root + 19)
    const b = midiToHz(musicKey.root + 24)
    for (let n = 0; n < 6; n++) tone(k, 'square', n % 2 ? b : a, t + n * 0.11, 0.035, 0.005, 0.1)
    for (let n = 0; n < 6; n++) tone(k, 'sine', n % 2 ? b : a, t + n * 0.11, 0.06, 0.005, 0.1)
    thump(k, t, 0.15, 120, 45, 0.25)
  }

  // ================================================================ countdown

  /**
   * The race countdown, booked ONCE per countdown on the audio clock: a beep
   * on each whole second before GO, then GO. Booking it all at once keeps the
   * beats perfectly even whatever the frame rate does.
   *
   * It is keyed on store.raceGoAt (the exact GO time), so a repeated event, or
   * the per-frame watch finding the same countdown, never books it twice. The
   * key the beeps are in is frozen at booking time (the music may change key
   * during the countdown; the beeps must not). The beeps play through their
   * own gain, so an aborted countdown (raceState leaves 'countdown' before GO)
   * silences what is still waiting.
   */
  watchCountdown(raceState: string, goAtMs: number): void {
    const now = this.uiKit.ctx.currentTime
    if (raceState === 'countdown' && goAtMs > 0 && goAtMs !== this.bookedGoAtMs) {
      this.abortCountdown()
      this.abortedBus = null
      this.bookCountdown(goAtMs, (goAtMs - performance.now()) / 1000)
      return
    }
    const bus = this.countdownBus
    if (!bus) return
    // Aborted: no longer counting down, not racing, and GO hasn't happened yet.
    if (raceState !== 'countdown' && raceState !== 'running' && now < this.goAt - 0.02) this.abortCountdown()
    // Well after GO: the beeps have finished, let the bus go.
    else if (now > this.goAt + 1.5) {
      bus.disconnect()
      this.countdownBus = null
    }
  }

  /** A race.countdown event: book from the store's GO time if it has one, else from the event's seconds. */
  private onCountdownEvent(seconds: number): void {
    const goAtMs = getGame().raceGoAt
    if (goAtMs > 0) {
      if (goAtMs !== this.bookedGoAtMs) {
        this.abortCountdown()
        this.bookCountdown(goAtMs, (goAtMs - performance.now()) / 1000)
      }
      return
    }
    // No GO time in the store yet: book from the event, once while it is live.
    if (this.countdownLive()) return
    this.bookCountdown(-1, seconds)
  }

  private bookCountdown(goAtMs: number, goIn: number): void {
    const k = this.uiKit
    const ctx = k.ctx
    const now = ctx.currentTime
    if (!(goIn > -0.05) || goIn > 30) return
    const go = now + LEAD_IN + Math.max(0, goIn)
    const bus = ctx.createGain()
    bus.connect(k.out)
    const root = musicKey.root // frozen for the whole countdown
    for (let n = Math.floor(goIn + 0.1); n >= 1; n--) {
      // The first beep is usually due "right now" (or a few ms ago): play it now, don't drop it.
      const at = go - n
      if (at < now - 0.1) continue
      this.beepAt(k, Math.max(at, now + LEAD_IN), false, root, bus)
    }
    this.beepAt(k, go, true, root, bus)
    this.countdownBus = bus
    this.bookedGoAtMs = goAtMs
    this.goAt = go
    this.count('countdown')
  }

  /** Silence any countdown beeps still waiting to play. */
  private abortCountdown(): void {
    const bus = this.countdownBus
    if (!bus) return
    const t = this.uiKit.ctx.currentTime
    if (t < this.goAt + 0.05) {
      bus.gain.cancelScheduledValues(t)
      bus.gain.setValueAtTime(bus.gain.value, t)
      bus.gain.linearRampToValueAtTime(0, t + 0.015)
      this.counts['countdown.aborted'] = (this.counts['countdown.aborted'] ?? 0) + 1
      // the voices reap themselves; drop the bus once the last booked beep would have ended
      setTimeout(() => bus.disconnect(), Math.max(0, (this.goAt - t + 1) * 1000))
      this.abortedBus = bus
    } else {
      bus.disconnect()
    }
    this.countdownBus = null
    this.goAt = -1
  }

  /** Inspector view of the booked countdown. */
  countdownState(): { live: boolean; aborted: boolean; goAt: number; busGain: number } | null {
    const r = (v: number) => Math.round(v * 1000) / 1000
    const bus = this.countdownBus
    if (bus) return { live: this.countdownLive(), aborted: false, goAt: r(this.goAt), busGain: r(bus.gain.value) }
    if (this.abortedBus) return { live: false, aborted: true, goAt: -1, busGain: r(this.abortedBus.gain.value) }
    return null
  }

  /** True from booking until just after GO. */
  private countdownLive(): boolean {
    return this.countdownBus !== null && this.uiKit.ctx.currentTime < this.goAt + 0.5
  }
}
