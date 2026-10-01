// ============================================================
//  MUSIC - a procedural synthwave band that follows the drive
// ------------------------------------------------------------
//  THE CLOCK. Music has to be perfectly in time, and a game frame
//  is not. So a timer runs every 25 ms and schedules the next
//  ~150 ms of notes ahead on the audio clock (a "lookahead
//  scheduler"). The audio hardware then plays them exactly on time
//  however busy the frame loop is.
//
//  THE ARRANGER. Every bar line, it decides which SECTION plays:
//    title      calm: pads, a slow arp, a soft bass note
//    intro      the band coming in, filtered
//    groove     the steady drive
//    build      snare roll, filters opening, a noise riser
//    drop       everything, brightest, with the hook on top
//    breakdown  drums out, pads swell: a breather
//  It chooses from `scene.intensity` (speed, boost, air, race
//  state, worked out by the audio rig every frame), and only ever
//  changes on a bar line, and big changes on a 4-bar phrase line,
//  so it never lurches.
//
//  THE SESSION. Each drive rolls a new seed: a key, a chord
//  progression, patterns and a four-bar hook melody, all picked
//  from the hand-written sets in score.ts. The track's mood sets
//  the tempo and style. Night makes it darker and sparser.
// ============================================================

import type { Phase, RaceState } from '../../core/store'
import { degreeToMidi, musicKey } from '../theory'
import type { ScaleName } from '../theory'
import { clamp01, mulberry32 } from '../synth'
import { Arp, Band, Bass, Crash, Hats, Kick, Lead, Pad, Riser, Snare } from './instruments'
import { MOODS, PROGRESSIONS, TITLE_BPM, writeHook } from './score'
import type { HookNote, Mood, MoodId } from './score'

/** How far ahead the scheduler books notes (seconds). */
export const LOOKAHEAD_S = 0.16
/** How often the live game's timer calls tick() (ms). */
export const TICK_MS = 25

export type Section = 'title' | 'intro' | 'groove' | 'build' | 'drop' | 'breakdown'
export const SECTIONS: readonly Section[] = ['title', 'intro', 'groove', 'build', 'drop', 'breakdown']

/** What the music listens to. The audio rig writes these every frame. */
export interface MusicScene {
  phase: Phase
  raceState: RaceState
  /** On the last lap of a race. */
  finalLap: boolean
  /** 0..1 how "night" it is. */
  night: number
  /** 0..1 how intense the drive is right now (smoothed). */
  intensity: number
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

export class MusicSystem {
  readonly scene: MusicScene = { phase: 'title', raceState: 'idle', finalLap: false, night: 0, intensity: 0 }

  // ---- the band ----
  private readonly band: Band
  private readonly kick: Kick
  private readonly snare: Snare
  private readonly hats: Hats
  private readonly crash: Crash
  private readonly bass: Bass
  private readonly arp: Arp
  private readonly pad: Pad
  private readonly lead: Lead
  private readonly riser: Riser

  // ---- the session ----
  private mood: Mood = MOODS.drive
  private moodBpm = MOODS.drive.bpm
  private rnd: () => number = mulberry32(1)
  private keyRoot = 40
  private scale: ScaleName = 'aeolian'
  private progA: number[] = PROGRESSIONS.aeolian[0]
  private progB: number[] = PROGRESSIONS.aeolian[1]
  private kickPat = ''
  private kickDropPat = ''
  private hatPat = ''
  private hatDropPat = ''
  private bassPat = ''
  private arpPat: number[] = [0]
  private hookByStep: (HookNote | null)[] = new Array(64).fill(null)
  private pending: { mood: MoodId; bpm: number; seed: number } | null = null

  // ---- the clock ----
  private bpm = TITLE_BPM
  private stepDur = 60 / TITLE_BPM / 4
  private nextTime = -1
  private step = 0
  /** Bars since this session's music started (phrase position = bar % 4). */
  private bar = 0

  // ---- the arranger ----
  private section: Section = 'title'
  private barsInSection = 0
  private forcedSection: Section | null = null
  private hookOn = false
  private dropPhrases = 0
  private arpIndex = 0
  private chordDeg = 0
  private wasCountdown = false
  private buildBars = 2

  readonly readout = {
    mood: 'drive' as MoodId,
    section: 'title' as Section,
    bpm: TITLE_BPM,
    key: '',
    progression: '',
    chord: 0,
    bar: 0,
    hook: false,
    notes: 0,
    voices: 0,
    seed: 0,
  }

  constructor(ctx: BaseAudioContext, out: AudioNode, noise: AudioBuffer) {
    this.band = new Band(ctx, out, noise)
    this.kick = new Kick(this.band)
    this.snare = new Snare(this.band)
    this.hats = new Hats(this.band)
    this.crash = new Crash(this.band)
    this.bass = new Bass(this.band)
    this.arp = new Arp(this.band)
    this.pad = new Pad(this.band)
    this.lead = new Lead(this.band)
    this.riser = new Riser(this.band)
    this.applySession('drive', MOODS.drive.bpm, 0x5d0)
    this.readout.voices = this.band.sources.length
  }

  /** Start a new session's music (new seed, mood and key). Takes effect at the next bar line. */
  newSession(mood: MoodId, bpm: number | undefined, seed: number): void {
    const m = MOODS[mood] ?? MOODS.drive
    this.pending = { mood: m.id, bpm: bpm && bpm >= 60 && bpm <= 180 ? bpm : m.bpm, seed: seed >>> 0 }
  }

  /** Dev: hold a section (null = back to automatic). */
  forceSection(s: Section | null): void {
    this.forcedSection = s
  }

  // ---------------------------------------------------------------- the clock

  /** Book every note that starts before now + LOOKAHEAD_S. Called by a timer (live) or the offline renderer. */
  tick(now: number): void {
    if (this.nextTime < 0) this.nextTime = now + 0.05
    // Fell behind (a stalled tab)? Skip ahead rather than blurting out the missed notes.
    if (this.nextTime < now - 0.1) {
      this.nextTime = now + 0.05
      this.step = 0
    }
    const horizon = now + LOOKAHEAD_S
    while (this.nextTime < horizon) {
      if (this.step === 0) this.onBar(this.nextTime)
      this.playStep(this.nextTime, this.step)
      this.nextTime += this.stepDur
      this.step = (this.step + 1) & 15
    }
  }

  private setTempo(bpm: number, t: number): void {
    this.bpm = bpm
    this.stepDur = 60 / bpm / 4
    this.band.setTempo(60 / bpm, t)
    this.readout.bpm = bpm
  }

  // ---------------------------------------------------------------- the session

  private applySession(mood: MoodId, bpm: number, seed: number): void {
    const m = MOODS[mood]
    this.mood = m
    this.moodBpm = bpm
    this.rnd = mulberry32(seed)
    const r = this.rnd
    this.scale = m.scales[Math.floor(r() * m.scales.length)]
    this.keyRoot = m.roots[Math.floor(r() * m.roots.length)]
    const progs = PROGRESSIONS[this.scale]
    const a = Math.floor(r() * progs.length)
    let b = Math.floor(r() * progs.length)
    if (b === a) b = (a + 1) % progs.length
    this.progA = progs[a]
    this.progB = progs[b]
    this.rollPatterns(true)
    this.hookByStep.fill(null)
    for (const n of writeHook(r)) if (n.step < 64) this.hookByStep[n.step] = n
    musicKey.root = this.keyRoot + 12
    musicKey.scale = this.scale
    this.readout.mood = mood
    this.readout.key = `${NOTE_NAMES[this.keyRoot % 12]} ${this.scale}`
    this.readout.progression = this.progA.join('-')
    this.readout.seed = seed
  }

  /** Pick patterns from the mood's sets. all = everything (new session), else a lighter shuffle. */
  private rollPatterns(all: boolean): void {
    const m = this.mood
    const r = this.rnd
    const pick = <T>(list: T[]): T => list[Math.floor(r() * list.length)]
    if (all || r() < 0.5) this.bassPat = pick(m.bass)
    if (all || r() < 0.5) this.arpPat = pick(m.arps)
    if (all || r() < 0.4) this.hatPat = pick(m.hats)
    if (all || r() < 0.4) this.hatDropPat = pick(m.hatsDrop)
    if (all) this.kickPat = pick(m.kick)
    if (all || r() < 0.3) this.kickDropPat = pick(m.kickDrop)
  }

  // ---------------------------------------------------------------- the arranger

  private onBar(t: number): void {
    const sc = this.scene
    if (this.pending) {
      const p = this.pending
      this.pending = null
      this.applySession(p.mood, p.bpm, p.seed)
      this.bar = 0
      this.section = sc.phase === 'playing' ? 'intro' : 'title'
      this.barsInSection = 0
      this.dropPhrases = 0
      this.enterSection(this.section, t)
    } else {
      this.bar++
      this.barsInSection++
    }

    // A race start (countdown over) drops straight in on the next bar, and the phrase restarts there.
    const countdown = sc.raceState === 'countdown'
    if (this.wasCountdown && !countdown && sc.raceState === 'running') {
      this.wasCountdown = false
      this.bar = 0
      this.goTo('drop', t)
    } else {
      this.wasCountdown = countdown
      const next = this.decide()
      if (next !== this.section) this.goTo(next, t)
    }

    const wantBpm = this.section === 'title' ? TITLE_BPM : this.moodBpm
    if (wantBpm !== this.bpm) this.setTempo(wantBpm, t)

    // The chord for this bar. Breakdowns borrow the second progression for colour.
    const pos = this.bar & 3
    const prog = this.section === 'breakdown' ? this.progB : this.progA
    this.chordDeg = prog[pos]
    this.readout.chord = this.chordDeg
    this.readout.bar = this.bar
    this.readout.section = this.section

    // Phrase start: should this phrase carry the hook?
    if (pos === 0) {
      if (this.section === 'drop') {
        this.hookOn = this.dropPhrases % 2 === 0 || sc.finalLap
        this.dropPhrases++
      } else if (this.section === 'breakdown' || this.section === 'title') {
        this.hookOn = this.rnd() < 0.34
      } else {
        this.hookOn = false
      }
      this.readout.hook = this.hookOn
    }

    this.shapeTone(t)
    this.padChord(t)
  }

  /** The section the next bar should be. */
  private decide(): Section {
    const sc = this.scene
    if (this.forcedSection) return this.forcedSection
    if (sc.phase === 'title' || sc.phase === 'editor' || sc.phase === 'loading') return 'title'
    if (sc.phase === 'results') return 'breakdown'
    if (sc.phase === 'paused') return this.section
    const cur = this.section
    const n = this.barsInSection
    const pos = this.bar & 3
    const I = sc.intensity
    if (sc.raceState === 'countdown') return 'build'
    switch (cur) {
      case 'title':
        return 'intro'
      case 'intro':
        if (pos === 0 && (n >= 4 || (n >= 2 && I > 0.3))) return 'groove'
        return 'intro'
      case 'groove':
        if (I > 0.6 && n >= 2 && (pos === 2 || pos === 3)) return 'build'
        if (I < 0.08 && n >= 4 && pos === 0) return 'breakdown'
        return 'groove'
      case 'build':
        return pos === 0 ? 'drop' : 'build'
      case 'drop':
        if (pos !== 0) return 'drop'
        if (n >= 4 && I < 0.12) return 'breakdown'
        if (n >= 8 && I < 0.4) return 'groove'
        if (n >= 16) return 'breakdown' // a breather after a long drop; high intensity builds it back up
        return 'drop'
      case 'breakdown':
        if (I > 0.6 && n >= 2 && (pos === 2 || pos === 3)) return 'build'
        if (pos === 0 && n >= 4 && I > 0.2) return 'groove'
        return 'breakdown'
    }
  }

  private goTo(next: Section, t: number): void {
    this.section = next
    this.barsInSection = 0
    this.enterSection(next, t)
  }

  private enterSection(s: Section, t: number): void {
    const barS = this.stepDur * 16
    if (s === 'build') {
      this.buildBars = 4 - (this.bar & 3) // lands the drop on the next phrase line
      if (this.scene.raceState === 'countdown') this.buildBars = 2
      this.riser.rise(t, barS * this.buildBars, 1)
    } else if (s === 'drop') {
      this.crash.hit(t, 1)
      this.kick.hit(t, 1, this.mood.pump, true)
      this.rollPatterns(false)
      this.dropPhrases = 0
    } else if (s === 'groove' || s === 'breakdown') {
      this.rollPatterns(false)
    }
    if (s === 'drop' || s === 'groove' || s === 'intro') this.arpIndex = 0
  }

  /** Per-bar tone: filters open with intensity and through a build, close and darken at night. */
  private shapeTone(t: number): void {
    const sc = this.scene
    const s = this.section
    let e = clamp01(sc.intensity)
    if (s === 'build') e = Math.max(e, 0.35 + 0.55 * clamp01((this.barsInSection + 1) / this.buildBars))
    if (s === 'drop') e = Math.max(e, 0.75)
    if (s === 'title' || s === 'breakdown') e = Math.min(e, 0.35)
    const dark = 1 - 0.42 * sc.night
    this.arp.cutoff.to((700 + 3400 * e) * dark, t)
    this.arp.echoSend.to(0.35 + 0.25 * sc.night, t)
    this.pad.cutoff.to((650 + 1600 * e) * dark, t)
    this.pad.level.to(s === 'drop' ? 0.42 : 0.55, t)
    this.bass.baseCutoff = (230 + 380 * e) * (1 - 0.25 * sc.night)
    this.bass.envAmount = (450 + 1300 * e) * dark
    // Night pulls the drums back and darkens them, so the pads and echoes carry it.
    this.band.drumLevel.to(0.9 * (1 - 0.32 * sc.night), t)
    this.snare.tone.to(2600 * (1 - 0.4 * sc.night), t)
  }

  private padChord(t: number): void {
    const barS = this.stepDur * 16
    const root = this.keyRoot
    const window = root + 17 // a close voicing in the middle of the keyboard
    for (let i = 0; i < 4; i++) {
      let m = degreeToMidi(root + 12, this.scale, this.chordDeg + i * 2)
      while (m < window) m += 12
      while (m >= window + 12) m -= 12
      this.padNotes[i] = m
    }
    const swell = this.section === 'title' || this.section === 'breakdown' ? Math.max(0.9, this.mood.swell) : this.mood.swell
    this.pad.chord(t, this.padNotes, barS, swell)
  }

  private readonly padNotes = [0, 0, 0, 0]

  // ---------------------------------------------------------------- the players

  private vel(v: number): number {
    return v * (0.9 + 0.1 * this.rnd())
  }

  private playStep(t: number, s: number): void {
    const sc = this.scene
    const sec = this.section
    const m = this.mood
    const night = sc.night
    const barPos = this.bar & 3

    // ---------- drums ----------
    if (sec === 'groove' || sec === 'drop' || sec === 'intro' || sec === 'build') {
      const kp = sec === 'drop' ? this.kickDropPat : this.kickPat
      const kc = sec === 'build' && this.barsInSection === this.buildBars - 1 && s >= 8 ? (s % 2 === 0 ? 'x' : '-') : kp[s]
      if (kc === 'x') this.kick.hit(t, this.vel(sec === 'intro' ? 0.7 : 1), sec === 'intro' ? m.pump * 0.5 : m.pump)
    } else if (sec === 'title' && s === 0 && night < 0.6) {
      this.kick.hit(t, 0.3, 0, true) // a soft heartbeat under the title
    }

    if (sec === 'groove' || sec === 'drop') {
      const sp = sec === 'drop' ? m.snareDrop : m.snare
      const c = sp[s]
      // a little fill at the end of every fourth bar
      const fill = sec === 'groove' && barPos === 3 && s >= 12 && this.rnd() < 0.55
      if (c === 'x' || c === 'c') this.snare.hit(t, this.vel(1), c === 'c', 0.7)
      else if (c === 'g') this.snare.hit(t, this.vel(0.3), false, 0.1)
      else if (fill) this.snare.hit(t, this.vel(0.45 + 0.1 * (s - 12)), false, 0.3)
    } else if (sec === 'build') {
      // the roll: eighths, then sixteenths in the last bar, rising
      const last = this.barsInSection >= this.buildBars - 1
      const progress = clamp01((this.barsInSection + s / 16) / this.buildBars)
      if (last || s % 2 === 0) this.snare.hit(t, 0.25 + 0.6 * progress, false, 0.2 + 0.5 * progress)
    }

    if (sec !== 'breakdown') {
      let hc = '-'
      if (sec === 'drop') hc = this.hatDropPat[s]
      else if (sec === 'groove' || sec === 'intro') hc = this.hatPat[s]
      else if (sec === 'build') hc = s % 2 === 0 ? 'a' : 'x'
      else if (sec === 'title') hc = s % 4 === 2 && night < 0.5 ? 'x' : '-'
      if (hc !== '-') {
        const open = hc === 'o' && night < 0.65
        // night thins the quiet hats out
        const skip = hc === 'x' && night > 0.15 && this.rnd() < 0.5 * night
        if (!skip) {
          const base = (sec === 'title' ? 0.35 : sec === 'intro' ? 0.6 : 1) * (1 - 0.4 * night)
          this.hats.hit(t, this.vel(base * (hc === 'a' || hc === 'o' ? 1 : 0.62)), open)
        }
      }
    } else if (s % 4 === 2 && this.rnd() < 0.5 - 0.4 * night) {
      this.hats.hit(t, 0.3, false)
    }

    // ---------- bass ----------
    this.playBass(t, s)

    // ---------- arp ----------
    const rate = sec === 'drop' ? m.arpRateDrop : sec === 'title' ? 8 : m.arpRate
    const every = rate === 16 ? 1 : 2
    const arpOn = sec !== 'intro' || this.barsInSection >= 1
    if (arpOn && s % every === 0) {
      const rest = this.rnd() < 0.38 * night + (sec === 'title' ? 0.15 : 0)
      const idx = this.arpPat[this.arpIndex % this.arpPat.length]
      this.arpIndex++
      if (!rest) {
        const midi = this.chordTone(this.keyRoot + 24, idx)
        const v = sec === 'title' ? 0.55 : sec === 'intro' || sec === 'breakdown' ? 0.75 : 1
        this.arp.note(t, midi, this.stepDur * every * 0.85, this.vel(v))
        this.readout.notes++
      }
    }

    // ---------- lead hook ----------
    if (this.hookOn) {
      const n = this.hookByStep[barPos * 16 + s]
      if (n) {
        // the hook's degrees ride on the chord of the bar the note starts in
        const midi = degreeToMidi(this.keyRoot + 24, this.scale, this.chordDeg + n.degree)
        const soft = sec !== 'drop'
        this.lead.note(t, midi, n.len * this.stepDur * 0.92, soft ? 0.5 : 0.95, n.len <= 2 && !soft)
        this.readout.notes++
      }
    }
  }

  /** Chord tone `idx` (0 root, 1 third, 2 fifth, 3 seventh, 4 = root an octave up...) from base. */
  private chordTone(base: number, idx: number): number {
    const oct = Math.floor(idx / 4)
    return degreeToMidi(base, this.scale, this.chordDeg + (idx - oct * 4) * 2) + 12 * oct
  }

  private playBass(t: number, s: number): void {
    const sec = this.section
    let pat: string
    if (sec === 'groove' || sec === 'drop' || sec === 'build') pat = this.bassPat
    else if (sec === 'intro') pat = 'r-------r-------'
    else pat = 'r---------------' // title, breakdown: one long note a bar
    const c = pat[s]
    if (c === '-' || c === '.' || c === undefined) return
    let len = 1
    while (s + len < 16 && pat[s + len] === '-') len++
    const root = this.bassRoot()
    let midi = root
    if (c === 'o') midi = root + 12
    else if (c === '5') {
      // the chord's fifth, placed just above the root
      midi = degreeToMidi(this.keyRoot, this.scale, this.chordDeg + 4)
      while (midi <= root) midi += 12
      while (midi > root + 12) midi -= 12
    }
    const v = sec === 'title' ? 0.5 : sec === 'breakdown' || sec === 'intro' ? 0.7 : 1
    this.bass.note(t, midi, len * this.stepDur * 0.95, this.vel(v), this.mood.bassGlide ? 0.04 : 0)
    this.readout.notes++
  }

  /** The bar's chord root, kept low (bass register). */
  private bassRoot(): number {
    const m = degreeToMidi(this.keyRoot, this.scale, this.chordDeg)
    return m > this.keyRoot + 7 ? m - 12 : m
  }

  dispose(): void {
    this.band.dispose()
  }
}
