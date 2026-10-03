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
//  the tempo and style. Night makes it darker and sparser. A seed
//  is a song: songs.ts names it and keeps the favourites.
//
//  THE TWO BANDS. The arranger plays one of two bands, with exactly
//  the same calls, so a song is the same song in either:
//    the classic band (instruments.ts)  the original synthwave
//        band: every drive, unless config.ts musicStyle is 'house'
//    the house band (houseBand.ts)  80s studio and French house:
//        the title screen always, and everything with 'house'
//  The band only changes on a bar line. The one that stops keeps
//  ringing (its reverb and echo tails) and is unplugged a few
//  seconds later, so only the band in use costs anything.
//
//  THE STYLE. The house band leans French house or synthwave per
//  mood (style.ts): the house chord stabs on the off-beats (the
//  build sweeps their filter open into the drop), the bouncing
//  octave bass, claps on the backbeat, how hard it pumps, how much
//  talkbox, the hook sliding between notes. The classic band plays
//  with all of that off. None of it changes a song's notes, and
//  none of it uses the song's random numbers.
//
//  ANSWERING THE DRIVING. The band also reacts to big moments,
//  always in the song's key and on its beat:
//    answerLanding   a big landing: a cymbal and a chord stab on
//                    the next 16th note
//    answerFanfare   a best lap or a race win: a short fanfare of
//                    stabs (on the next 8th), the band stepping back
//                    under it
//    the final lap   lifts the whole song up a key (FINAL_LAP_LIFT)
//                    at the next phrase line, with a cymbal and a stab
// ============================================================

import type { Phase, RaceState } from '../../core/store'
import { NOTE_NAMES, degreeToMidi, musicKey } from '../theory'
import type { ScaleName } from '../theory'
import { clamp01, mulberry32 } from '../synth'
import type { Knob } from '../synth'
import * as classic from './instruments'
import * as house from './houseBand'
import { CLASSIC_STYLE, STYLES, configStyle, playsIn } from './style'
import type { MusicStyle, Style } from './style'
import { MOODS, PROGRESSIONS, TITLE_BPM, rollKey, writeHook } from './score'
import type { HookNote, Mood, MoodId } from './score'

/** How far ahead the scheduler books notes (seconds). */
export const LOOKAHEAD_S = 0.16
/** How often the live game's timer calls tick() (ms). */
export const TICK_MS = 25

/** Semitones the song climbs on the final lap of a race (2 = a whole step up: the big pop key change). */
export const FINAL_LAP_LIFT = 2

/** Seconds a band keeps ringing after it stops playing (its reverb and echo tails) before it is unplugged. */
const BAND_REST_S = 8

/**
 * The fanfare's chords per scale: two chords climbing to the home chord
 * (scale degrees, 0 = home). Each scale has its own, because a chord that
 * is bright and major in one scale is dark or broken in another:
 *   aeolian   VI  VII  i    (the classic heroic minor ending)
 *   dorian    III IV   i
 *   phrygian  VI  II   i    (the tense, exotic flat two)
 */
const FANFARE_CHORDS: Record<ScaleName, [number, number]> = {
  aeolian: [5, 6],
  dorian: [2, 3],
  phrygian: [5, 1],
}

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

/**
 * One band's players. Both bands fill this in (each with its own
 * instruments), so the arranger plays either with exactly the same calls.
 */
interface Players {
  readonly name: MusicStyle
  /** The band's way out. Plugged into the music bus only while the band plays or still rings. */
  readonly out: GainNode
  plugged: boolean
  /** Audio time the band last stopped being the one in use. */
  restingSince: number
  readonly band: {
    setTempo(beatS: number, t: number): void
    dipBed(t: number, level: number, dur: number): void
    readonly drumLevel: Knob
    readonly sources: readonly AudioScheduledSourceNode[]
    dispose(): void
  }
  readonly kick: { hit(t: number, vel: number, pumpDepth: number, long?: boolean): void }
  readonly snare: { hit(t: number, vel: number, clap: boolean, gatedSend: number): void; readonly tone: Knob }
  readonly hats: classic.Hats
  readonly crash: classic.Crash
  readonly bass: { note(t: number, midi: number, dur: number, vel: number, glide?: number, pop?: number): void; baseCutoff: number; envAmount: number }
  readonly arp: { note(t: number, midi: number, dur: number, vel: number): void; readonly cutoff: Knob; readonly echoSend: Knob }
  readonly pad: { chord(t: number, midis: readonly number[], dur: number, swell: number): void; readonly cutoff: Knob; readonly level: Knob }
  readonly lead: { note(t: number, midi: number, dur: number, vel: number, glide: boolean, glideS?: number): void }
  readonly riser: classic.Riser
  readonly stab: { play(t: number, midis: readonly number[], len: number, bright: number, vel: number, bass: number): void }
  /** How far above the key's root the answer stab's chord starts (semitones): the classic band's sits lower and warmer. */
  readonly stabFloor: number
}

/** The classic band (instruments.ts), built ready to plug in. */
function buildClassic(ctx: BaseAudioContext, noise: AudioBuffer): Players {
  const out = ctx.createGain()
  const b = new classic.Band(ctx, out, noise)
  return {
    name: 'classic',
    out,
    plugged: false,
    restingSince: -1,
    band: b,
    kick: new classic.Kick(b),
    snare: new classic.Snare(b),
    hats: new classic.Hats(b),
    crash: new classic.Crash(b),
    bass: new classic.Bass(b),
    arp: new classic.Arp(b),
    pad: new classic.Pad(b),
    lead: new classic.Lead(b),
    riser: new classic.Riser(b),
    stab: new classic.Stab(b),
    stabFloor: 12,
  }
}

/** The house band's own extras, which only the house styles use. */
interface HouseParts {
  band: house.Band
  lead: house.Lead
  houseStab: house.HouseStab
}

/** The house band (houseBand.ts), built ready to plug in. */
function buildHouse(ctx: BaseAudioContext, noise: AudioBuffer): { players: Players; parts: HouseParts } {
  const out = ctx.createGain()
  const b = new house.Band(ctx, out, noise)
  const lead = new house.Lead(b)
  const players: Players = {
    name: 'house',
    out,
    plugged: false,
    restingSince: -1,
    band: b,
    kick: new house.Kick(b),
    snare: new house.Snare(b),
    hats: new classic.Hats(b),
    crash: new classic.Crash(b),
    bass: new house.Bass(b),
    arp: new house.Arp(b),
    pad: new house.Pad(b),
    lead,
    riser: new classic.Riser(b),
    stab: new house.Stab(b),
    stabFloor: 19,
  }
  return { players, parts: { band: b, lead, houseStab: new house.HouseStab(b) } }
}

export class MusicSystem {
  readonly scene: MusicScene = { phase: 'title', raceState: 'idle', finalLap: false, night: 0, intensity: 0 }

  // ---- the bands ----
  /** The music bus both bands plug into. */
  private readonly out: AudioNode
  private readonly classicBand: Players
  private readonly houseBand: Players
  private readonly houseParts: HouseParts
  /** The band playing now. */
  private p: Players
  /** Dev / render: play this style whatever config.ts says (null = follow config.ts). */
  private styleOverride: MusicStyle | null = null

  // ---- the session ----
  private mood: Mood = MOODS.drive
  /** How the band in use plays (CLASSIC_STYLE for the classic band). */
  private style: Style = STYLES.drive
  /** How the house band plays this mood (style.ts). */
  private houseStyle: Style = STYLES.drive
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
  /** Semitones the whole song is lifted right now (the final-lap key change). */
  private lift = 0
  /** Audio time of the last answer, so a pile of events can't stack stabs. */
  private lastAnswerAt = -10
  /** Dev: lift the key at the next phrase line even without a final lap. */
  private liftAsked = false
  /** Where the last hook note ended (step in the 4-bar phrase) and its degree, for the lead's portamento. */
  private hookEnd = -1
  private hookDeg = 0

  readonly readout = {
    mood: 'drive' as MoodId,
    section: 'title' as Section,
    /** The band playing now (the title screen is always the house band). */
    band: 'house' as MusicStyle,
    /** The style the drive gets: config.ts musicStyle, or the dev override. */
    style: 'classic' as MusicStyle,
    bpm: TITLE_BPM,
    key: '',
    progression: '',
    chord: 0,
    bar: 0,
    hook: false,
    notes: 0,
    /** Oscillators and noise loops running in the plugged-in bands. */
    voices: 0,
    seed: 0,
    /** Semitones lifted for the final lap (0 or FINAL_LAP_LIFT). */
    lift: 0,
    /** Times the band answered since sound started: landings, fanfares, key lifts. */
    answers: { landing: 0, fanfare: 0, lift: 0 },
    stabs: 0,
  }

  constructor(ctx: BaseAudioContext, out: AudioNode, noise: AudioBuffer) {
    this.out = out
    this.classicBand = buildClassic(ctx, noise)
    const h = buildHouse(ctx, noise)
    this.houseBand = h.players
    this.houseParts = h.parts
    // The title's band. Nothing is plugged in until the first bar decides what plays.
    this.p = this.houseBand
    this.applySession('drive', MOODS.drive.bpm, 0x5d0)
    this.applyStyle(0)
  }

  /** Start a new session's music (new seed, mood and key). Takes effect at the next bar line. */
  newSession(mood: MoodId, bpm: number | undefined, seed: number): void {
    const m = MOODS[mood] ?? MOODS.drive
    this.pending = { mood: m.id, bpm: bpm && bpm >= 60 && bpm <= 180 ? bpm : m.bpm, seed: seed >>> 0 }
  }

  /** Dev / render: play this style from the next bar whatever config.ts says (null = back to config.ts). */
  setStyle(style: MusicStyle | null): void {
    this.styleOverride = style
    this.readout.style = this.musicStyle()
  }

  /** Dev: lift the song a key at the next phrase line, as the final lap does. */
  forceLift(): void {
    this.liftAsked = true
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
    this.unplugResting(this.classicBand, now)
    this.unplugResting(this.houseBand, now)
  }

  private setTempo(bpm: number, t: number): void {
    this.bpm = bpm
    this.stepDur = 60 / bpm / 4
    // both bands, so a band coming back in is already at the right tempo
    this.classicBand.band.setTempo(60 / bpm, t)
    this.houseBand.band.setTempo(60 / bpm, t)
    this.readout.bpm = bpm
  }

  // ---------------------------------------------------------------- the bands

  /** The style the drive gets right now. */
  private musicStyle(): MusicStyle {
    return this.styleOverride ?? configStyle()
  }

  /** The band a section needs: the house band for the title, else the one musicStyle picks. */
  private bandFor(section: Section): Players {
    return section === 'title' || this.musicStyle() === 'house' ? this.houseBand : this.classicBand
  }

  /** Make `p` the band that plays, from bar time t. The band it replaces rings on, then is unplugged. */
  private useBand(p: Players, t: number): void {
    if (!p.plugged) {
      p.out.connect(this.out)
      p.plugged = true
      this.countVoices()
    }
    if (p === this.p) return
    // the band that stops: its notes end by themselves within the bar; a build's riser would sweep on, so fade it
    this.p.riser.release(t)
    this.p.restingSince = t
    this.p = p
    this.style = p === this.houseBand ? this.houseStyle : CLASSIC_STYLE
    if (p === this.houseBand) this.applyStyle(t)
    this.readout.band = p.name
  }

  /** Unplug a band that has stopped playing once its tails have died away (then it costs nothing). */
  private unplugResting(p: Players, now: number): void {
    if (p === this.p || !p.plugged || now - p.restingSince < BAND_REST_S) return
    p.out.disconnect()
    p.plugged = false
    this.countVoices()
  }

  private countVoices(): void {
    const c = this.classicBand
    const h = this.houseBand
    this.readout.voices = (c.plugged ? c.band.sources.length : 0) + (h.plugged ? h.band.sources.length : 0)
  }

  /** Move to section s at bar time t (with the band it needs). */
  private setSection(s: Section, t: number): void {
    this.section = s
    this.useBand(this.bandFor(s), t)
  }

  // ---------------------------------------------------------------- the session

  private applySession(mood: MoodId, bpm: number, seed: number): void {
    const m = MOODS[mood]
    this.mood = m
    this.houseStyle = STYLES[mood]
    if (this.p === this.houseBand) this.style = this.houseStyle
    this.moodBpm = bpm
    this.rnd = mulberry32(seed)
    const r = this.rnd
    // the key first: songs.ts reads a song's key with this same roll
    const key = rollKey(m, r)
    this.scale = key.scale
    this.keyRoot = key.root
    this.lift = 0
    this.readout.lift = 0
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

  /** Set the house band up for this mood's style (style.ts) from time t: loudness trim, room size, talkbox, stab filter. */
  private applyStyle(t: number): void {
    const st = this.houseStyle
    this.trimNow = -1 // a new style always sets its trim and room
    this.styleTrim(t)
    this.houseParts.lead.setTalkbox(st.talkbox, t)
    this.houseParts.houseStab.setCutoff(st.stabClosedHz, t, 0.05)
  }

  /**
   * The house band's loudness trim, except on the title screen: the house
   * parts never play there, so the calm title music keeps its own level.
   */
  private styleTrim(t: number): void {
    const trim = this.section === 'title' ? 1 : this.houseStyle.trim
    if (trim === this.trimNow) return
    this.trimNow = trim
    this.houseParts.band.setStyle(t, trim, this.houseStyle.room)
  }

  private trimNow = -1

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
    this.readout.style = this.musicStyle()
    if (this.pending) {
      const p = this.pending
      this.pending = null
      this.applySession(p.mood, p.bpm, p.seed)
      if (this.p === this.houseBand) this.applyStyle(t)
      this.bar = 0
      this.setSection(sc.phase === 'playing' ? 'intro' : 'title', t)
      this.barsInSection = 0
      this.dropPhrases = 0
      this.enterSection(this.section, t)
    } else {
      this.bar++
      this.barsInSection++
      // a change to musicStyle (config.ts, or the dev command) lands here, on a bar line
      this.useBand(this.bandFor(this.section), t)
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

    if (this.p === this.houseBand) this.styleTrim(t)
    const wantBpm = this.section === 'title' ? TITLE_BPM : this.moodBpm
    if (wantBpm !== this.bpm) this.setTempo(wantBpm, t)

    // The chord for this bar. Breakdowns borrow the second progression for colour.
    const pos = this.bar & 3
    const prog = this.section === 'breakdown' ? this.progB : this.progA
    this.chordDeg = prog[pos]
    this.readout.chord = this.chordDeg
    this.readout.bar = this.bar
    this.readout.section = this.section

    // The final lap lifts the song up a key, on a phrase line, with a cymbal and a stab.
    if (pos === 0 && this.lift === 0 && ((sc.finalLap && sc.phase === 'playing') || this.liftAsked)) this.liftKey(t)

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
    this.setSection(next, t)
    this.barsInSection = 0
    this.enterSection(next, t)
  }

  private enterSection(s: Section, t: number): void {
    const p = this.p
    const barS = this.stepDur * 16
    if (s === 'build') {
      this.buildBars = 4 - (this.bar & 3) // lands the drop on the next phrase line
      if (this.scene.raceState === 'countdown') this.buildBars = 2
      p.riser.rise(t, barS * this.buildBars, 1)
      // filter house: the stabs' low-pass opens all the way through the build, into the drop
      if (playsIn(this.style.stabs, 'build')) this.houseParts.houseStab.sweep(t, this.style.stabOpenHz * this.darkness(), barS * this.buildBars)
    } else if (s === 'drop') {
      p.crash.hit(t, 1)
      p.kick.hit(t, 1, this.mood.pump * this.style.pump, true)
      this.rollPatterns(false)
      this.dropPhrases = 0
    } else if (s === 'groove' || s === 'breakdown') {
      this.rollPatterns(false)
    }
    if (s === 'drop' || s === 'groove' || s === 'intro') this.arpIndex = 0
  }

  /** Per-bar tone: filters open with intensity and through a build, close and darken at night. */
  private shapeTone(t: number): void {
    const p = this.p
    const sc = this.scene
    const s = this.section
    let e = clamp01(sc.intensity)
    if (s === 'build') e = Math.max(e, 0.35 + 0.55 * clamp01((this.barsInSection + 1) / this.buildBars))
    if (s === 'drop') e = Math.max(e, 0.75)
    if (s === 'title' || s === 'breakdown') e = Math.min(e, 0.35)
    const dark = 1 - 0.42 * sc.night
    p.arp.cutoff.to((700 + 3400 * e) * dark, t)
    p.arp.echoSend.to(0.35 + 0.25 * sc.night, t)
    p.pad.cutoff.to((650 + 1600 * e) * dark, t)
    p.pad.level.to(s === 'drop' ? 0.42 : 0.55, t)
    p.bass.baseCutoff = (230 + 380 * e) * (1 - 0.25 * sc.night)
    p.bass.envAmount = (450 + 1300 * e) * dark
    // Night pulls the drums back and darkens them, so the pads and echoes carry it.
    p.band.drumLevel.to(0.9 * (1 - 0.32 * sc.night), t)
    p.snare.tone.to(2600 * (1 - 0.4 * sc.night), t)
    // The house stabs: muffled in the groove, open in the drop (the build sweeps between, see enterSection).
    if (p === this.houseBand && s !== 'build') {
      const st = this.style
      this.houseParts.houseStab.setCutoff((s === 'drop' ? st.stabOpenHz : st.stabClosedHz) * this.darkness(), t, s === 'drop' ? 0.03 : 0.6)
    }
  }

  /** How much night darkens the filters (1 = sundown, 0.58 = full night). */
  private darkness(): number {
    return 1 - 0.42 * this.scene.night
  }

  private padChord(t: number): void {
    const barS = this.stepDur * 16
    const root = this.root
    const window = root + 17 // a close voicing in the middle of the keyboard
    for (let i = 0; i < 4; i++) {
      let m = degreeToMidi(root + 12, this.scale, this.chordDeg + i * 2)
      while (m < window) m += 12
      while (m >= window + 12) m -= 12
      this.padNotes[i] = m
    }
    const swell = this.section === 'title' || this.section === 'breakdown' ? Math.max(0.9, this.mood.swell) : this.mood.swell
    this.p.pad.chord(t, this.padNotes, barS, swell)
  }

  private readonly padNotes = [0, 0, 0, 0]

  // ---------------------------------------------------------------- the players

  private vel(v: number): number {
    return v * (0.9 + 0.1 * this.rnd())
  }

  private playStep(t: number, s: number): void {
    const p = this.p
    const sc = this.scene
    const sec = this.section
    const m = this.mood
    const night = sc.night
    const barPos = this.bar & 3

    // ---------- drums ----------
    if (sec === 'groove' || sec === 'drop' || sec === 'intro' || sec === 'build') {
      const kp = sec === 'drop' ? this.kickDropPat : this.kickPat
      const kc = sec === 'build' && this.barsInSection === this.buildBars - 1 && s >= 8 ? (s % 2 === 0 ? 'x' : '-') : kp[s]
      if (kc === 'x') p.kick.hit(t, this.vel(sec === 'intro' ? 0.7 : 1), (sec === 'intro' ? m.pump * 0.5 : m.pump) * this.style.pump)
    } else if (sec === 'title' && s === 0 && night < 0.6) {
      p.kick.hit(t, 0.3, 0, true) // a soft heartbeat under the title
    }

    if (sec === 'groove' || sec === 'drop') {
      const sp = sec === 'drop' ? m.snareDrop : m.snare
      const c = sp[s]
      // a little fill at the end of every fourth bar
      const fill = sec === 'groove' && barPos === 3 && s >= 12 && this.rnd() < 0.55
      // a 'c' is a clap; a house style claps on every backbeat
      if (c === 'x' || c === 'c') p.snare.hit(t, this.vel(1), c === 'c' || this.style.clapBackbeat, 0.7)
      else if (c === 'g') p.snare.hit(t, this.vel(0.3), false, 0.1)
      else if (fill) p.snare.hit(t, this.vel(0.45 + 0.1 * (s - 12)), false, 0.3)
    } else if (sec === 'build') {
      // the roll: eighths, then sixteenths in the last bar, rising
      const last = this.barsInSection >= this.buildBars - 1
      const progress = clamp01((this.barsInSection + s / 16) / this.buildBars)
      if (last || s % 2 === 0) p.snare.hit(t, 0.25 + 0.6 * progress, false, 0.2 + 0.5 * progress)
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
          p.hats.hit(t, this.vel(base * (hc === 'a' || hc === 'o' ? 1 : 0.62)), open)
        }
      }
    } else if (s % 4 === 2 && this.rnd() < 0.5 - 0.4 * night) {
      p.hats.hit(t, 0.3, false)
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
        const midi = this.chordTone(this.root + 24, idx)
        const v = sec === 'title' ? 0.55 : sec === 'intro' || sec === 'breakdown' ? 0.75 : 1
        p.arp.note(t, midi, this.stepDur * every * 0.85, this.vel(v))
        this.readout.notes++
      }
    }

    // ---------- house stabs: the chord on every off-beat (no random numbers here: the song stays the same) ----------
    if ((s & 3) === 2 && playsIn(this.style.stabs, sec)) {
      const accent = s === 14 ? 1 : 0.85
      const v = this.style.stabLevel * accent * (1 - 0.3 * night) * (sec === 'groove' ? 0.85 : 1)
      this.houseParts.houseStab.play(t, this.stabChord(this.chordDeg, this.houseNotes, this.houseBand.stabFloor), this.stepDur * 1.3, v)
      this.readout.notes++
    }

    // ---------- lead hook ----------
    if (this.hookOn) {
      const idx = barPos * 16 + s
      const n = this.hookByStep[idx]
      if (n) {
        // the hook's degrees ride on the chord of the bar the note starts in
        const midi = degreeToMidi(this.root + 24, this.scale, this.chordDeg + n.degree)
        const soft = sec !== 'drop'
        // portamento (house styles): a note straight after the last one, a step or two away, slides up or down to it
        const slide = this.style.portamento && idx === this.hookEnd && n.degree !== this.hookDeg && Math.abs(n.degree - this.hookDeg) <= 2
        const glide = slide || (n.len <= 2 && !soft)
        p.lead.note(t, midi, n.len * this.stepDur * 0.92, soft ? 0.5 : 0.95, glide, slide ? 0.055 : 0.035)
        this.hookEnd = idx + n.len
        this.hookDeg = n.degree
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
    const root = this.bassNote(this.chordDeg)
    let midi = root
    let pop = 0
    if (c === 'o') midi = root + 12
    else if (c === 'r' && (s & 3) === 2 && playsIn(this.style.octaveBass, sec)) {
      // octave bass: the off-beat root jumps up an octave with a slap, so the line bounces
      midi = root + 12
      pop = 0.8
    } else if (c === '5') {
      // the chord's fifth, placed just above the root
      midi = degreeToMidi(this.root, this.scale, this.chordDeg + 4)
      while (midi <= root) midi += 12
      while (midi > root + 12) midi -= 12
    }
    const v = sec === 'title' ? 0.5 : sec === 'breakdown' || sec === 'intro' ? 0.7 : 1
    this.p.bass.note(t, midi, len * this.stepDur * 0.95, this.vel(v), this.mood.bassGlide ? 0.04 : 0, pop)
    this.readout.notes++
  }

  /** Chord `degree`'s root, kept low (the bass register). */
  private bassNote(degree: number): number {
    const root = this.root
    const m = degreeToMidi(root, this.scale, degree)
    return m > root + 7 ? m - 12 : m
  }

  /** The key's root as played right now: the song's key plus the final-lap lift. */
  private get root(): number {
    return this.keyRoot + this.lift
  }

  // ---------------------------------------------------------------- answering the driving

  /**
   * The first 16th-note line at or after `t` on the music's own grid
   * (every = 2 for 8th notes). The grid is where the scheduler's steps
   * fall, so an answer lands exactly in time with the drums.
   */
  private gridAfter(t: number, every: 1 | 2 = 1): number {
    if (this.nextTime < 0) return t
    const d = this.stepDur
    // steps already booked sit at nextTime - k * d, with step index (step - k) & 15
    let k = Math.floor((this.nextTime - t) / d)
    if (k < 0) k = 0
    let at = this.nextTime - k * d
    if (every === 2 && ((this.step - k) & 1) === 1) at += d
    return at
  }

  /**
   * Chord `degree` (0 = home) as four notes for a stab: root, third and
   * fifth close together, plus the root an octave up on top. The root
   * sits `floor` to `floor + 11` semitones above the key's root. The
   * third and fifth come from the scale, so the chord is always in key.
   */
  private stabChord(degree: number, out: number[], floor: number): number[] {
    const root = this.root
    const lo = root + floor
    let r = degreeToMidi(root, this.scale, degree)
    while (r < lo) r += 12
    while (r >= lo + 12) r -= 12
    out[0] = r
    for (let i = 1; i < 3; i++) {
      let m = degreeToMidi(root, this.scale, degree + i * 2)
      while (m <= r) m += 12
      while (m > r + 12) m -= 12
      out[i] = m
    }
    out[3] = r + 12
    return out
  }

  /** Play the band's answer stab: chord `degree` with its root in the bass under it. */
  private stabAt(t: number, degree: number, len: number, bright: number, vel: number): void {
    const p = this.p
    p.stab.play(t, this.stabChord(degree, this.stabNotes, p.stabFloor), len, bright, vel, this.bassNote(degree))
    this.readout.stabs++
  }

  private readonly stabNotes = [0, 0, 0, 0]
  private readonly houseNotes = [0, 0, 0, 0]

  /**
   * The chord playing at time t: this bar's, or the next bar's when t is
   * past the next bar line (which the scheduler hasn't reached yet).
   */
  private chordAt(t: number): number {
    if (this.nextTime < 0) return this.chordDeg
    const nextBar = this.nextTime + ((16 - this.step) & 15) * this.stepDur
    if (t < nextBar - 0.0001) return this.chordDeg
    const prog = this.section === 'breakdown' ? this.progB : this.progA
    return prog[(this.bar + 1) & 3]
  }

  /**
   * A big landing: a cymbal and a chord stab on the bar's chord, on the
   * next 16th. size 0..1 (bigger = brighter and louder). Returns true if
   * the band has it (also when an answer is already playing: this moment
   * joins it), false when it isn't playing a driving section.
   */
  answerLanding(now: number, size: number): boolean {
    if (!this.canAnswer()) return false
    if (this.busyAnswering(now)) return true
    const s = clamp01(size)
    const t = this.gridAfter(now + 0.012)
    this.p.crash.hit(t, 0.55 + 0.45 * s)
    this.stabAt(t, this.chordAt(t), this.stepDur * (1.6 + s), 0.55 + 0.45 * s, 0.75 + 0.25 * s)
    this.lastAnswerAt = t
    this.readout.answers.landing++
    return true
  }

  /**
   * A best lap or a race win: two climbing stabs and a held home chord
   * with a cymbal (scale-aware chords, FANFARE_CHORDS), starting on the
   * next 8th, while the pads, bass, arp and lead step back. size 0..1.
   */
  answerFanfare(now: number, size: number): boolean {
    if (!this.canAnswer()) return false
    // A second fanfare on top of one still playing (a best final lap that also wins the race) joins it.
    if (now < this.fanfareUntil) return true
    const s = clamp01(size)
    const d = this.stepDur
    const t = this.gridAfter(now + 0.012, 2)
    const [a, b] = FANFARE_CHORDS[this.scale]
    const bright = 0.7 + 0.3 * s
    this.stabAt(t, a, d * 1.5, bright, 0.85)
    this.stabAt(t + 2 * d, b, d * 1.5, bright, 0.9)
    this.stabAt(t + 4 * d, 0, d * (4 + 2 * s), 1, 1)
    this.p.crash.hit(t + 4 * d, 0.8 + 0.2 * s)
    this.p.band.dipBed(t, 0.5, 10 * d)
    this.lastAnswerAt = t + 4 * d
    this.fanfareUntil = t + 10 * d
    this.readout.answers.fanfare++
    return true
  }

  /** The final-lap key change, at bar time t (a phrase line). */
  private liftKey(t: number): void {
    this.liftAsked = false
    this.lift = FINAL_LAP_LIFT
    musicKey.root = this.keyRoot + this.lift + 12
    this.readout.lift = this.lift
    this.readout.key = `${NOTE_NAMES[(this.keyRoot + this.lift) % 12]} ${this.scale}`
    this.readout.answers.lift++
    // a drop that starts on this bar already crashed; otherwise mark the lift with one
    if (!(this.section === 'drop' && this.barsInSection === 0)) this.p.crash.hit(t, 0.9)
    // the stab, unless a fanfare's last chord is still to come (the key still lifts; the fanfare marks it)
    if (t >= this.lastAnswerAt) {
      this.stabAt(t, 0, this.stepDur * 3, 0.9, 0.9)
      this.lastAnswerAt = t
    }
  }

  /** The band answers only while a drive is on (not the title, results or a pause). */
  private canAnswer(): boolean {
    return this.scene.phase === 'playing' && this.section !== 'title'
  }

  /** True while an answer is still sounding (two moments at once share one answer instead of stacking). */
  private busyAnswering(now: number): boolean {
    return now - this.lastAnswerAt < 0.35 || now < this.fanfareUntil
  }

  /** When the fanfare playing now ends (audio time). */
  private fanfareUntil = -10

  dispose(): void {
    for (const p of [this.classicBand, this.houseBand]) {
      p.band.dispose()
      p.out.disconnect()
    }
  }
}
