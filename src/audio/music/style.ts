// ============================================================
//  STYLE - which band plays, and how the house band leans
// ------------------------------------------------------------
//  config.ts musicStyle picks the band for the drive:
//
//    'classic'  (the default) the original synthwave band
//               (instruments.ts), exactly as it always sounded
//    'house'    the house band (houseBand.ts): 80s studio
//               synthwave crossed with French house (Daft Punk)
//
//  The title screen always gets the house band's calm sound, in
//  either style. A change to musicStyle takes effect at the next
//  bar line, no reload needed.
//
//  The songs themselves (the chords, patterns and hook, score.ts)
//  never change here. A style only decides how a band PLAYS a
//  mood: which extra house parts join in, how hard everything
//  pumps, how much the lead sounds like a talkbox, how big the
//  snare's room is. The classic band plays with every extra off
//  (CLASSIC_STYLE). The house band leans per mood (STYLES):
//
//    cruise  synthwave, dreamy: big gated snare, lush supersaw
//            pads, a mostly plain lead, a gentle pump
//    drive   synthwave with a French house drop: the chord stabs
//            and the bouncing octave bass come in for the drop
//            (the build sweeps the stabs open into it)
//    race    French house (Daft Punk's Discovery and Alive): chord
//            stabs on every off-beat from the groove, filtered and
//            swept open by the build; octave bass; claps on every
//            backbeat; a hard pump; the full talkbox; a drier room
//    hyper   Tron Legacy: dark synthwave with a big room and wide
//            pads; darker stabs and octave bass only in the drop
//
//  Josh: try moving a mood's numbers. stabs and octaveBass list
//  the sections where those parts play ('groove', 'build', 'drop');
//  an empty list turns the part off for that mood.
// ============================================================

import { CONFIG } from '../../core/config'
import type { MoodId } from './score'

/** The two bands musicStyle can pick. */
export type MusicStyle = 'classic' | 'house'
export const MUSIC_STYLES: readonly MusicStyle[] = ['classic', 'house']

/** The sections a style part can play in. */
export type StyleSection = 'groove' | 'build' | 'drop'

export interface Style {
  /** Sections where the house chord stabs play, on every off-beat. */
  stabs: readonly StyleSection[]
  /** How loud the stabs are (0..1). */
  stabLevel: number
  /** Where the stabs' low-pass filter sits: closed in the groove, open in the drop (Hz). */
  stabClosedHz: number
  stabOpenHz: number
  /** Sections where the bass bounces between the root and the octave on the off-beats. */
  octaveBass: readonly StyleSection[]
  /** Claps on every backbeat (groove too), not only where the pattern asks for one. */
  clapBackbeat: boolean
  /** How hard the kick pumps everything, times the mood's own pump. */
  pump: number
  /** 0 = the plain synth lead, 1 = the full talkbox. */
  talkbox: number
  /** The hook's notes slide into each other when they follow straight on (portamento). */
  portamento: boolean
  /** The snare's gated room, times its normal size. */
  room: number
  /**
   * Loudness trim for the whole band in this mood, so it measures the same
   * as the classic band (the music's level against the engine stays where
   * it was).
   */
  trim: number
}

/** The classic band: no extra parts at all, every instrument as it always was. */
export const CLASSIC_STYLE: Style = {
  stabs: [],
  stabLevel: 0,
  stabClosedHz: 700,
  stabOpenHz: 700,
  octaveBass: [],
  clapBackbeat: false,
  pump: 1,
  talkbox: 0,
  portamento: false,
  room: 1,
  trim: 1,
}

/** The house band, per mood. */
export const STYLES: Record<MoodId, Style> = {
  cruise: {
    stabs: [],
    stabLevel: 0,
    stabClosedHz: 700,
    stabOpenHz: 2400,
    octaveBass: [],
    clapBackbeat: false,
    pump: 1.1,
    talkbox: 0.35,
    portamento: true,
    room: 1,
    trim: 0.977,
  },
  drive: {
    stabs: ['build', 'drop'],
    stabLevel: 0.75,
    stabClosedHz: 650,
    stabOpenHz: 3200,
    octaveBass: ['drop'],
    clapBackbeat: false,
    pump: 1.2,
    talkbox: 0.75,
    portamento: true,
    room: 0.85,
    trim: 0.966,
  },
  race: {
    stabs: ['groove', 'build', 'drop'],
    stabLevel: 0.85,
    stabClosedHz: 600,
    stabOpenHz: 3800,
    octaveBass: ['groove', 'drop'],
    clapBackbeat: true,
    pump: 1.35,
    talkbox: 1,
    portamento: true,
    room: 0.6,
    trim: 0.955,
  },
  hyper: {
    stabs: ['build', 'drop'],
    stabLevel: 0.7,
    stabClosedHz: 550,
    stabOpenHz: 2600,
    octaveBass: ['drop'],
    clapBackbeat: false,
    pump: 1.2,
    talkbox: 0.5,
    portamento: true,
    room: 1,
    trim: 0.966,
  },
}

/** True if `section` is one of the style part's sections. */
export function playsIn(list: readonly StyleSection[], section: string): boolean {
  for (let i = 0; i < list.length; i++) if (list[i] === section) return true
  return false
}

/** The value we already warned about, so a typo is reported once, not every bar. */
let warnedAbout = ''

/** The band config.ts asks for. Anything that isn't a style plays the classic band (with one warning). */
export function configStyle(): MusicStyle {
  const s = CONFIG.musicStyle
  if (s === 'house' || s === 'classic') return s
  if (s !== warnedAbout) {
    warnedAbout = s
    console.warn(`[music] config.ts musicStyle "${s}" isn't a style (${MUSIC_STYLES.join(' or ')}): playing the classic band`)
  }
  return 'classic'
}
