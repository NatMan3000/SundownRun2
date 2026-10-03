// ============================================================
//  AUDIO RIG - owns the AudioContext and wires everything up
// ------------------------------------------------------------
//  One AudioRig exists while <AudioSystem /> is mounted. It:
//
//   - creates the AudioContext lazily, the first time the browser
//     allows sound (a key, a click, a tap, or later a gamepad press);
//   - builds the mixer, the engine voice, the effects and the music;
//   - every frame copies telemetry into the engine, spots landings,
//     works out the music's intensity, and moves the mixer faders
//     (volumes, pause, title screen);
//   - runs the music's lookahead timer (music/index.ts), and picks
//     its songs through the song book (music/songs.ts): Next song
//     (N / pad B, or the pause menu), favourites, song names;
//   - lets the band answer big moments (a landing, a best lap, a
//     race win) through the effects' MusicAnswers hook;
//   - turns game events into sound effects (rewind's whir included:
//     rewind.start / rewind.end, with the music muffled while held);
//   - fades out and parks the context when the tab is hidden;
//   - closes everything on unmount and on a hot reload (Vite HMR
//     would otherwise leave the old context playing underneath).
//
//  WHY THE POLLING: browsers only allow sound after a "user gesture".
//  A gamepad button is NOT a gesture, so a player who only touches
//  the pad would never hear anything. But once any real gesture has
//  happened on the page (navigator.userActivation.hasBeenActive is
//  sticky), the browser lets us start sound from anywhere. So we
//  check that flag a few times a second and start the moment it flips.
// ============================================================

import type { AnyGameEvent } from '../core/events'
import { subscribe } from '../core/events'
import { controlSignals } from '../core/controls'
import type { FavouriteSong, SongInfo, SongList } from '../core/api'
import { environment, rewind, telemetry } from '../core/telemetry'
import { getGame } from '../core/store'
import { getSettings } from '../core/settings'
import type { UiSound } from '../core/api'
import { urlParam } from '../core/devHandles'
import { ENGINE_PHASE_LEVEL, REWIND_ENGINE_LEVEL, buildMix, duck, readLevelDb, updateMix } from './mixer'
import type { Mix } from './mixer'
import { EngineVoice, makeEngineInput } from './engine'
import type { EngineInput } from './engine'
import { ENGINE_SOUND_IDS, ENGINE_VOICINGS, isEngineSound, resolveEngineSound } from './engineVoicings'
import type { EngineSoundId } from './engineVoicings'
import { loadMotorWorklet } from './motorDsp'
import { Effects } from './effects'
import { makeKit } from './voices'
import type { VoiceKit } from './voices'
import { hashString, makeNoiseBuffer } from './synth'
import { TEST_DRIVES } from './sweep'
import type { TestDriveId } from './sweep'
import { MusicSystem, SECTIONS, TICK_MS } from './music'
import type { Section } from './music'
import { MOODS } from './music/score'
import type { MoodId } from './music/score'
import { SongBook } from './music/songs'
import { MUSIC_STYLES } from './music/style'
import type { MusicStyle } from './music/style'
import { Intensity } from './intensity'
import { getTrack } from '../track/current'

/** How often to check whether the browser now allows sound (ms). */
const ACTIVATION_POLL_MS = 250
/** Shortest jump that makes a landing thump (seconds in the air). */
const LANDING_MIN_AIR_S = 0.25
/** Below this music volume the band is too quiet to carry a fanfare, so the bell one plays instead. */
const ANSWER_MIN_MUSIC_VOLUME = 0.2

interface Graph {
  ctx: AudioContext
  mix: Mix
  engine: EngineVoice
  effects: Effects
  fxKit: VoiceKit
  uiKit: VoiceKit
  /** Null when the music is muted with ?nomusic=1 (then it is never built at all). */
  music: MusicSystem | null
}

/** A new seed each session, mixed with the track id, so no two drives sound the same. */
function sessionSeed(trackId: string): number {
  return (hashString(trackId) ^ Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0
}

/** The current track's mood and tempo (falls back to 'drive'). */
function trackMusic(): { mood: MoodId; bpm: number | undefined } {
  const spec = getTrack()?.file.environment.music
  const mood = spec?.mood && spec.mood in MOODS ? spec.mood : 'drive'
  return { mood, bpm: spec?.bpm }
}

function hasStickyActivation(): boolean {
  const ua = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation
  return ua ? ua.hasBeenActive : false
}

/**
 * May we try to start sound right now? Only once the page has had a real
 * gesture: before that the browser refuses (a gamepad press doesn't count)
 * and every attempt just logs an "AudioContext was not allowed to start"
 * warning. Browsers without the userActivation API get to try.
 */
function mayStartSound(): boolean {
  const ua = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation
  return ua ? ua.hasBeenActive : true
}

export class AudioRig {
  private g: Graph | null = null
  private hidden = typeof document !== 'undefined' ? document.hidden : false
  private suspendTimer: ReturnType<typeof setTimeout> | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private unsubscribe: (() => void) | null = null
  private disposed = false
  private readonly musicMuted = urlParam('nomusic') === '1'
  /** ?engine=muscle|rally|hover picks the engine for this page load (beats config.ts). */
  private readonly urlEngine = urlParam('engine')
  /** ?motor=nodes forces the node motor (what a LAN guest on plain http hears). */
  private readonly forceNodeMotor = urlParam('motor') === 'nodes'
  /** Dev override from __dev.audio('engine-sound', id); null = follow the URL / config. */
  private devEngine: EngineSoundId | null = null

  // engine input: a copy of telemetry, or the dev override
  private readonly input: EngineInput = makeEngineInput()
  private readonly override: EngineInput = makeEngineInput()
  private overrideActive = false
  private sweepStart = -1
  /** Which scripted drive startSweep() is playing. */
  private sweepDrive: TestDriveId = 'sweep'

  // landing detector
  private wasAirborne = false
  private airMax = 0

  // music
  private readonly intensity = new Intensity()
  /** Which song plays, the favourites, and the names. */
  private readonly songs = new SongBook()
  /** The last controlSignals.nextSong seen (N / pad B while driving). */
  private seenNextSong = controlSignals.nextSong
  private musicTimer: ReturnType<typeof setInterval> | null = null
  private lastFrameT = -1
  private trackVersion = -1

  // main-thread cost, smoothed (inspector: proves audio doesn't cost frames)
  private frameMs = 0
  private tickMs = 0

  private readonly levelScratch = new Float32Array(new ArrayBuffer(2048 * 4))

  constructor() {
    const opts: AddEventListenerOptions = { passive: true, capture: true }
    window.addEventListener('keydown', this.onGesture, opts)
    window.addEventListener('pointerdown', this.onGesture, opts)
    window.addEventListener('touchstart', this.onGesture, opts)
    // pointerup / touchend are the events that actually grant activation on touch screens
    window.addEventListener('pointerup', this.onGesture, opts)
    window.addEventListener('touchend', this.onGesture, opts)
    document.addEventListener('visibilitychange', this.onVisibility)
    this.pollTimer = setInterval(this.pollActivation, ACTIVATION_POLL_MS)
    this.musicTimer = setInterval(this.tickMusic, TICK_MS)
    this.unsubscribe = subscribe(this.onEvent)
  }

  /** The music's lookahead timer: books the next notes on the audio clock. */
  private readonly tickMusic = (): void => {
    const g = this.g
    if (!g || !g.music || g.ctx.state !== 'running') return
    const c0 = performance.now()
    g.music.tick(g.ctx.currentTime)
    this.tickMs += (performance.now() - c0 - this.tickMs) * 0.05
  }

  // ---------------------------------------------------------------- lifecycle

  private readonly onGesture = (): void => {
    this.unlock()
  }

  private readonly pollActivation = (): void => {
    if (this.hidden || this.disposed) return
    if (this.g && this.g.ctx.state === 'running') return
    if (hasStickyActivation()) this.unlock()
  }

  private readonly onVisibility = (): void => {
    this.hidden = document.hidden
    const g = this.g
    if (!g) return
    if (this.suspendTimer !== null) {
      clearTimeout(this.suspendTimer)
      this.suspendTimer = null
    }
    if (this.hidden) {
      // Fade to silence first, then stop the clock (a hidden tab must not scream).
      updateMix(g.mix, this.mixTargets(true), g.ctx.currentTime)
      this.suspendTimer = setTimeout(() => {
        this.suspendTimer = null
        if (this.hidden && this.g && this.g.ctx.state === 'running') void this.g.ctx.suspend()
      }, 260)
    } else if (g.ctx.state !== 'running' && g.ctx.state !== 'closed') {
      void g.ctx.resume()
    }
  }

  /** Start or resume sound. Safe to call any time; from a user gesture it always works. */
  unlock = (): void => {
    if (this.disposed || this.hidden || !mayStartSound()) return
    if (!this.g) {
      try {
        this.g = this.build()
      } catch (err) {
        console.warn('[audio] could not start sound:', err)
        return
      }
    }
    const ctx = this.g.ctx
    if (ctx.state !== 'running' && ctx.state !== 'closed') {
      ctx.resume().catch(() => {
        // Not allowed yet (no gesture so far). The next gesture or poll tries again.
      })
    }
  }

  isRunning = (): boolean => {
    return !!this.g && this.g.ctx.state === 'running'
  }

  private build(): Graph {
    const Ctor: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ctx = new Ctor({ latencyHint: 'interactive' })
    const mix = buildMix(ctx)
    const noise = makeNoiseBuffer(ctx)
    const engine = new EngineVoice(ctx, mix.engine, noise, ENGINE_VOICINGS[this.wantedEngine()])
    // The motor loads onto the audio thread in the background (a few ms) and plugs in when ready.
    void loadMotorWorklet(ctx).then((load) => {
      if (this.g?.engine !== engine) return
      engine.attachMotor(this.forceNodeMotor ? { ok: false, reason: 'forced by ?motor=nodes' } : load)
    })
    const fxKit = makeKit(ctx, mix.fx, noise)
    const uiKit = makeKit(ctx, mix.ui, noise)
    const effects = new Effects(fxKit, uiKit, (depth, holdS) => duck(mix, depth, holdS, ctx.currentTime))
    let music: MusicSystem | null = null
    if (!this.musicMuted) {
      const m = new MusicSystem(ctx, mix.music, noise)
      music = m
      const tm = trackMusic()
      this.startSong(m, tm.mood, tm.bpm, sessionSeed(getGame().trackId))
      this.trackVersion = getGame().trackVersion
      effects.answers = {
        landing: (size) => this.bandCanAnswer() && m.answerLanding(ctx.currentTime, size),
        fanfare: (size) => this.bandCanAnswer() && m.answerFanfare(ctx.currentTime, size),
      }
    }
    return { ctx, mix, engine, effects, fxKit, uiKit, music }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const opts: EventListenerOptions = { capture: true }
    window.removeEventListener('keydown', this.onGesture, opts)
    window.removeEventListener('pointerdown', this.onGesture, opts)
    window.removeEventListener('touchstart', this.onGesture, opts)
    window.removeEventListener('pointerup', this.onGesture, opts)
    window.removeEventListener('touchend', this.onGesture, opts)
    document.removeEventListener('visibilitychange', this.onVisibility)
    if (this.pollTimer !== null) clearInterval(this.pollTimer)
    if (this.musicTimer !== null) clearInterval(this.musicTimer)
    if (this.suspendTimer !== null) clearTimeout(this.suspendTimer)
    this.unsubscribe?.()
    const g = this.g
    this.g = null
    if (g) {
      g.engine.dispose()
      g.music?.dispose()
      void g.ctx.close().catch(() => {
        // already closed
      })
    }
  }

  // ---------------------------------------------------------------- per frame

  /** Called once per rendered frame from useFrame. No allocation. */
  frame(): void {
    const g = this.g
    if (!g || g.ctx.state !== 'running') return
    const c0 = performance.now()
    const t = g.ctx.currentTime
    const e = this.readInput(t)
    this.lastInput = e

    // Josh changed engineSound in config.ts (or a dev switch): swap the voicing live.
    const wanted = this.wantedEngine()
    if (wanted !== g.engine.voicingId) g.engine.setVoicing(ENGINE_VOICINGS[wanted])
    g.engine.update(e, t)

    // Landing: the frame the car goes from airborne to grounded. Never while rewinding: going
    // back through a jump passes the take-off, and that is not a landing.
    if (rewind.active) {
      this.airMax = 0
    } else if (e.airborne) {
      if (telemetry.airTime > this.airMax) this.airMax = telemetry.airTime
    } else if (this.wasAirborne) {
      if (this.airMax >= LANDING_MIN_AIR_S) g.effects.landing(this.airMax)
      this.airMax = 0
    }
    this.wasAirborne = e.airborne

    // Race countdown: booked once per store.raceGoAt, silenced if the countdown is aborted.
    const gs = getGame()
    g.effects.watchCountdown(gs.raceState, gs.raceGoAt)

    // Music: intensity from the drive, plus what the arranger needs to know.
    const dt = this.lastFrameT >= 0 ? Math.min(0.1, Math.max(0, t - this.lastFrameT)) : 0
    this.lastFrameT = t
    const level = this.intensity.update(e, dt)
    const music = g.music
    if (music) {
      const game = getGame()
      const sc = music.scene
      sc.phase = game.phase
      sc.raceState = game.raceState
      sc.finalLap = this.intensity.finalLap
      sc.night = environment.night
      sc.intensity = level
      // Browsing tracks on the title screen re-keys the title music to that track's mood
      // (unless favourites are playing: then the favourite carries on).
      if (game.trackVersion !== this.trackVersion) {
        this.trackVersion = game.trackVersion
        if (game.phase === 'title' && !this.songs.playingFavourites) {
          const tm = trackMusic()
          this.startSong(music, tm.mood, tm.bpm, sessionSeed(game.trackId))
        }
      }
    }
    // N / pad B while driving: skip to another song.
    if (controlSignals.nextSong !== this.seenNextSong) {
      this.seenNextSong = controlSignals.nextSong
      this.nextSong()
    }

    updateMix(g.mix, this.mixTargets(false), t)
    this.frameMs += (performance.now() - c0 - this.frameMs) * 0.05
  }

  /** Which engine to play: the dev switch, then ?engine=, then config.ts (via settings). */
  private wantedEngine(): EngineSoundId {
    if (this.devEngine) return this.devEngine
    if (isEngineSound(this.urlEngine)) return this.urlEngine
    return resolveEngineSound(getSettings().engineSound)
  }

  /** Where the engine choice came from (inspector). */
  private engineSource(): string {
    if (this.devEngine) return 'dev'
    if (isEngineSound(this.urlEngine)) return 'url'
    return isEngineSound(getSettings().engineSound) ? 'config' : 'default'
  }

  private mixTargets(silent: boolean) {
    const s = getSettings()
    const phase = getGame().phase
    this.mixScratch.musicVolume = s.musicVolume
    this.mixScratch.sfxVolume = s.sfxVolume
    this.mixScratch.musicMuted = this.musicMuted
    this.mixScratch.engineLevel = (ENGINE_PHASE_LEVEL[phase] ?? 0) * (rewind.active ? REWIND_ENGINE_LEVEL : 1)
    this.mixScratch.paused = phase === 'paused'
    this.mixScratch.silent = silent || this.hidden
    this.mixScratch.engineLoad = this.lastInput ? this.lastInput.throttle : 0
    this.mixScratch.rewinding = rewind.active
    // (In a tunnel the engine and effects echo; only while driving.)
    this.mixScratch.tunnel = phase === 'playing' ? telemetry.tunnel : 0
    return this.mixScratch
  }

  private readonly mixScratch = {
    tunnel: 0,
    musicVolume: 0,
    sfxVolume: 0,
    musicMuted: false,
    engineLevel: 0,
    paused: false,
    silent: false,
    engineLoad: 0,
    rewinding: false,
  }
  private lastInput: EngineInput | null = null

  /** Fill the engine input from telemetry (or the dev override / test sweep). */
  private readInput(t: number): EngineInput {
    if (this.sweepStart >= 0) {
      const s = t - this.sweepStart
      const run = TEST_DRIVES[this.sweepDrive]
      if (s > run.seconds) {
        this.sweepStart = -1
        this.overrideActive = false
      } else {
        run.input(s, this.override)
        return this.override
      }
    }
    if (this.overrideActive) return this.override
    const e = this.input
    e.rpm = telemetry.rpm
    e.throttle = telemetry.throttle
    e.speedKmh = telemetry.speedKmh
    e.gear = telemetry.gear
    e.slip = telemetry.slip
    e.drifting = telemetry.drifting
    e.airborne = telemetry.airborne
    e.onRoad = telemetry.onRoad
    e.offRoad = !telemetry.onRoad
    e.magStrength = telemetry.magGrip ? Math.max(telemetry.magStrength, 0.35) : telemetry.magStrength
    e.boost = telemetry.boost
    return e
  }

  // ---------------------------------------------------------------- events and menus

  private readonly onEvent = (e: AnyGameEvent): void => {
    const g = this.g
    // A sound that cannot play right now is dropped, never queued for later.
    if (!g || g.ctx.state !== 'running' || this.hidden) return
    if (e.type === 'session.start' && g.music) {
      const tm = trackMusic()
      this.startSong(g.music, tm.mood, tm.bpm, sessionSeed(e.trackId))
    }
    g.effects.handleEvent(e)
  }

  ui = (kind: UiSound): void => {
    // Menus are driven by gestures, so this is a good moment to unlock.
    if (!this.g || this.g.ctx.state !== 'running') this.unlock()
    const g = this.g
    if (!g || this.hidden) return
    g.effects.ui(kind)
  }

  // ---------------------------------------------------------------- songs

  /** Pick a song (a fresh seed, or the next favourite) and start it at the next bar. */
  private startSong(music: MusicSystem, mood: MoodId, bpm: number | undefined, freshSeed: number, fresh = false): void {
    const s = this.songs.pick(mood, bpm, freshSeed, fresh)
    music.newSession(s.mood, s.bpm, s.seed)
  }

  /** May the band play a fanfare or a landing stab right now? Only if it can be heard. */
  private bandCanAnswer(): boolean {
    if (this.musicMuted || this.hidden || rewind.active) return false
    return getSettings().musicVolume >= ANSWER_MIN_MUSIC_VOLUME
  }

  /** The song playing (or starting at the next bar), or null while there is no music. */
  song = (): SongInfo | null => {
    return this.g?.music ? this.songs.info() : null
  }

  /** Skip to another song: same mood (a fresh seed), or the next favourite. Starts at the next bar. */
  nextSong = (): void => {
    const music = this.g?.music
    if (!music) return
    const tm = trackMusic()
    this.startSong(music, tm.mood, tm.bpm, sessionSeed(getGame().trackId))
  }

  /** Save the song playing as a favourite, or take it out. Returns true if it is saved now. */
  toggleFavourite = (): boolean => {
    if (!this.g?.music) return false
    return this.songs.toggleFavourite()
  }

  songList = (): { list: SongList; favourites: number } => {
    return { list: this.songs.list, favourites: this.songs.favourites.length }
  }

  /** All songs or Favourites. Choosing Favourites while a non-favourite plays starts the first favourite. */
  setSongList = (list: SongList): void => {
    this.songs.setList(list)
    if (list === 'favourites' && this.songs.playingFavourites && !this.songs.isFavourite(this.songs.song)) this.nextSong()
  }

  /** The saved songs, as the Favourite songs list shows them. Works while no music plays. */
  favourites = (): FavouriteSong[] => {
    return this.songs.describeFavourites()
  }

  /** Play favourite number `index` from the next bar (like nextSong). False if there is no such favourite or no music. */
  playFavourite = (index: number): boolean => {
    const music = this.g?.music
    if (!music) return false
    const s = this.songs.pickFavourite(index)
    if (!s) return false
    music.newSession(s.mood, s.bpm, s.seed)
    return true
  }

  /** Take favourite number `index` out of the list (the music carries on). Returns the song taken out, or null. */
  removeFavourite = (index: number): FavouriteSong | null => {
    const s = this.songs.removeFavourite(index)
    return s ? this.songs.describe(s) : null
  }

  /** Put the last favourite taken out back where it was. */
  undoRemoveFavourite = (): boolean => {
    return this.songs.undoRemove()
  }

  // ---------------------------------------------------------------- dev

  /** Play an effect directly (dev testing), without putting a fake event on the shared feed. */
  testEvent(e: AnyGameEvent): boolean {
    const g = this.g
    if (!g || g.ctx.state !== 'running') return false
    g.effects.handleEvent(e)
    return true
  }

  /** Drive the engine from values instead of telemetry. Pass null to go back to live telemetry. */
  setOverride(values: Partial<EngineInput> | null): void {
    this.sweepStart = -1
    if (!values) {
      this.overrideActive = false
      return
    }
    Object.assign(this.override, values)
    this.overrideActive = true
  }

  /**
   * Run a scripted test drive: 'sweep' (idle, gears, jump, drift, boost, off-road, mag)
   * 'drift' (the tyres: long drifts, a small slide, off-road), 'speed' (every gear to
   * 250 km/h, held, a boost pad, a lift) 'shifts' (gear changes: the turbo's pssh on
   * each upshift), 'liftoff' (full load, then a lift) or 'highrevs' (held near the rev
   * limiter). Returns its length in seconds.
   */
  startSweep(drive: TestDriveId = 'sweep'): number {
    const g = this.g
    if (!g) return 0
    this.sweepDrive = drive
    this.sweepStart = g.ctx.currentTime
    this.overrideActive = true
    return TEST_DRIVES[drive].seconds
  }

  /** Dev: play another engine voicing now ('auto' = back to the URL / config.ts choice). */
  setEngineSound(id: string): string {
    if (id === 'auto') {
      this.devEngine = null
      return `engine from ${this.engineSource()}: ${this.wantedEngine()}`
    }
    if (!isEngineSound(id)) return `unknown engine "${id}" (${ENGINE_SOUND_IDS.join(' | ')} | auto)`
    this.devEngine = id
    return `engine ${id}`
  }

  /** Dev: switch the music to a mood (a fresh seed), from the next bar. */
  setMood(mood: string): string {
    const music = this.g?.music
    if (!music) return this.musicMuted ? 'music is muted (?nomusic=1)' : 'sound not started'
    if (!(mood in MOODS)) return `unknown mood "${mood}" (${Object.keys(MOODS).join(' | ')})`
    this.startSong(music, mood as MoodId, undefined, sessionSeed(mood), true)
    return `mood ${mood} from the next bar`
  }

  /** Dev: lift the song a key at the next phrase line (the final-lap key change). */
  liftKey(): string {
    const music = this.g?.music
    if (!music) return this.musicMuted ? 'music is muted (?nomusic=1)' : 'sound not started'
    music.forceLift()
    return 'key lift at the next phrase line'
  }

  /** Dev: which band plays the drive, from the next bar ('auto' = back to config.ts musicStyle; no arg = show it). */
  setMusicStyle(style?: string): string {
    const music = this.g?.music
    if (!music) return this.musicMuted ? 'music is muted (?nomusic=1)' : 'sound not started'
    if (style === undefined) return `${music.readout.style} (the band playing now: ${music.readout.band})`
    if (style === 'auto') {
      music.setStyle(null)
      return `back to config.ts musicStyle (${music.readout.style}) from the next bar`
    }
    if (!(MUSIC_STYLES as readonly string[]).includes(style)) return `unknown style "${style}" (${MUSIC_STYLES.join(' | ')} | auto)`
    music.setStyle(style as MusicStyle)
    return `${style} from the next bar`
  }

  /** Dev: hold a music section ('auto' = let the arranger choose). */
  setSection(section: string): string {
    const music = this.g?.music
    if (!music) return this.musicMuted ? 'music is muted (?nomusic=1)' : 'sound not started'
    if (section === 'auto') {
      music.forceSection(null)
      return 'sections automatic'
    }
    if (!SECTIONS.includes(section as Section)) return `unknown section "${section}" (${SECTIONS.join(' | ')} | auto)`
    music.forceSection(section as Section)
    return `section ${section} from the next bar`
  }

  inspect(): Record<string, unknown> {
    const g = this.g
    const e = this.overrideActive || this.sweepStart >= 0 ? this.override : this.input
    return {
      state: g ? g.ctx.state : 'not started',
      running: this.isRunning(),
      hidden: this.hidden,
      stickyActivation: hasStickyActivation(),
      time: g ? Math.round(g.ctx.currentTime * 1000) / 1000 : 0,
      sampleRate: g ? g.ctx.sampleRate : 0,
      outputDb: g ? readLevelDb(g.mix, this.levelScratch) : -100,
      /** How much of the engine and effects is going into the tunnel echo right now (mixer.ts TUNNEL_ECHO; 0 in the open). */
      tunnelEcho: g ? round3(g.mix.echoSend.gain.value) : 0,
      musicMuted: this.musicMuted,
      cpuMs: { perFrame: round3(this.frameMs), perMusicTick: round3(this.tickMs) },
      voices: g ? g.fxKit.active + g.uiKit.active : 0,
      voicesStarted: g ? g.fxKit.started + g.uiKit.started : 0,
      music: g?.music
        ? {
            ...g.music.readout,
            song: this.songs.info(),
            songList: this.songList(),
            intensity: round3(this.intensity.value),
            intensityTarget: round3(this.intensity.target),
            closeRacing: round3(this.intensity.closeRacing),
            night: round3(g.music.scene.night),
          }
        : this.musicMuted
          ? 'muted (?nomusic=1)'
          : null,
      engineSource: this.sweepStart >= 0 ? this.sweepDrive : this.overrideActive ? 'override' : 'telemetry',
      engineSound: g
        ? {
            voicing: g.engine.voicingId,
            label: ENGINE_VOICINGS[g.engine.voicingId].label,
            from: this.engineSource(),
            motor: g.engine.motorKind,
            motorReason: g.engine.motorReason,
          }
        : null,
      input: {
        rpm: round3(e.rpm),
        throttle: round3(e.throttle),
        speedKmh: round3(e.speedKmh),
        gear: e.gear,
        slip: round3(e.slip),
        airborne: e.airborne,
        offRoad: e.offRoad,
        mag: round3(e.magStrength),
        boost: round3(e.boost),
      },
      engine: g ? roundAll(g.engine.readout) : null,
      counts: g ? { ...g.effects.counts } : {},
      countdown: g ? g.effects.countdownState() : null,
      faders: g
        ? {
            master: round3(g.mix.master.gain.value),
            music: round3(g.mix.musicVol.gain.value),
            musicDuck: round3(g.mix.musicDuck.gain.value),
            sfx: round3(g.mix.sfxVol.gain.value),
            engine: round3(g.mix.engineVol.gain.value),
            musicLowpassHz: Math.round(g.mix.musicTone.frequency.value),
            musicCarveDb: round3(g.mix.musicCarve.gain.value),
          }
        : null,
    }
  }
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000
}

function roundAll<T extends object>(o: T): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(o)) out[k] = typeof v === 'number' ? round3(v) : v
  return out
}

// ---------------------------------------------------------------- hot reload

let liveRig: AudioRig | null = null

/** The one live rig (index.tsx creates it on mount). */
export function createRig(): AudioRig {
  liveRig?.dispose()
  liveRig = new AudioRig()
  return liveRig
}

export function destroyRig(rig: AudioRig): void {
  rig.dispose()
  if (liveRig === rig) liveRig = null
}

// Vite hot reload re-runs this file; close the old context so it doesn't keep playing underneath.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    liveRig?.dispose()
    liveRig = null
  })
}
