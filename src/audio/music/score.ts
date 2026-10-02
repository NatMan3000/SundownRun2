// ============================================================
//  THE SCORE - hand-written patterns the music is built from
// ------------------------------------------------------------
//  Each track picks a mood (its file says environment.music.mood).
//  A mood is a tempo, the scales it likes, its keys, and its drum,
//  bass and arpeggio patterns. Every session the music rolls a seed
//  and picks from these lists (a key, a chord progression, patterns,
//  a hook), so it's never quite the same twice, but everything comes
//  from small hand-written sets, so it is always musical.
//
//  Pattern strings: one character per 16th note, 16 per bar.
//    drums:  x hit   a accent   o open hat   c clap   g ghost   - rest
//    bass:   r root  o octave up  5 fifth  - hold the last note  . rest
//
//  Chord progressions are scale degrees, one per bar (0 = the key's
//  home chord). They live per scale, because a chord that sounds
//  great in one scale can sound wrong in another.
// ============================================================

import type { ScaleName } from '../theory'

export type MoodId = 'cruise' | 'drive' | 'race' | 'hyper'

export interface Mood {
  id: MoodId
  bpm: number
  scales: ScaleName[]
  /** Bass roots (MIDI, around octave 2) the key can sit on. */
  roots: number[]
  /** Kick, snare and hat patterns for the groove and for the drop. */
  kick: string[]
  kickDrop: string[]
  snare: string
  snareDrop: string
  hats: string[]
  hatsDrop: string[]
  bass: string[]
  /** Arp speed: notes per bar (8 = eighths, 16 = sixteenths). */
  arpRate: 8 | 16
  arpRateDrop: 8 | 16
  /** Arp patterns: indexes into the chord tones (0 root, 1 third, 2 fifth, 3 seventh, 4 root up an octave...). */
  arps: number[][]
  /** Seconds the pad takes to swell into each chord. */
  swell: number
  /** Bass glides between notes (smooth and dreamy) instead of jumping. */
  bassGlide: boolean
  /** How hard the kick pumps the bass and pads (0..1). */
  pump: number
}

export const MOODS: Record<MoodId, Mood> = {
  // ~92 bpm, dreamy: half-time drums, long gliding bass, slow arps, big pads.
  cruise: {
    id: 'cruise',
    bpm: 92,
    scales: ['dorian', 'aeolian'],
    roots: [38, 40, 41, 43],
    kick: ['x-------x-------', 'x-------x-x-----'],
    kickDrop: ['x-----x-x-------', 'x-------x--x----'],
    snare: '--------x-------',
    snareDrop: '--------c-----g-',
    hats: ['x-x-x-x-x-x-x-x-', '--x---x---x---x-'],
    hatsDrop: ['x-a-x-a-x-a-x-a-', 'xxa-xxa-xxa-xxa-'],
    bass: ['r-------------o-', 'r-----r-r-------', 'r---------5-----'],
    arpRate: 8,
    arpRateDrop: 16,
    arps: [
      [0, 1, 2, 3, 4, 3, 2, 1],
      [0, 2, 1, 3, 2, 4, 3, 1],
      [0, 2, 4, 2],
    ],
    swell: 0.7,
    bassGlide: true,
    pump: 0.35,
  },
  // ~108 bpm, the classic night drive: four on the floor, pulsing eighth bass.
  drive: {
    id: 'drive',
    bpm: 108,
    scales: ['aeolian', 'dorian'],
    roots: [40, 41, 42, 45],
    kick: ['x---x---x---x---'],
    kickDrop: ['x---x---x---x---', 'x---x---x---x-x-'],
    snare: '----x-------x---',
    snareDrop: '----c-------c---',
    hats: ['--x---x---x---x-', 'x-x-x-x-x-x-x-x-'],
    hatsDrop: ['xxaxxxaxxxaxxxax', 'x-o-x-o-x-o-x-o-'],
    bass: ['r-r-r-r-r-r-o-r-', 'r-r-r-r-o-r-r-r-', 'r-r-r-r-r-r-r-5-'],
    arpRate: 16,
    arpRateDrop: 16,
    arps: [
      [0, 1, 2, 3],
      [0, 2, 4, 2],
      [0, 1, 2, 4, 3, 2, 1, 2],
    ],
    swell: 0.3,
    bassGlide: false,
    pump: 0.5,
  },
  // ~124 bpm, racing: rolling sixteenth bass, open hats on the off-beat in the drop.
  race: {
    id: 'race',
    bpm: 124,
    scales: ['aeolian'],
    roots: [40, 42, 43, 45],
    kick: ['x---x---x---x---'],
    kickDrop: ['x---x---x---x---', 'x---x---x---x-x-'],
    snare: '----x-------x---',
    snareDrop: '----c-------c--g',
    hats: ['x-a-x-a-x-a-x-a-', 'xxa-xxa-xxa-xxa-'],
    hatsDrop: ['xxoxxxoxxxoxxxox'],
    bass: ['rrorrrorrrorrror', 'r.rrr.rrr.rrr.rr', 'rrrorrrorrrorrr5'],
    arpRate: 16,
    arpRateDrop: 16,
    arps: [
      [0, 1, 2, 1],
      [0, 2, 4, 5, 4, 2],
      [4, 2, 1, 0],
      [0, 1, 2, 4],
    ],
    swell: 0.18,
    bassGlide: false,
    pump: 0.6,
  },
  // ~132 bpm, hyper: darker scale, driving bass, octave-jumping arps.
  hyper: {
    id: 'hyper',
    bpm: 132,
    scales: ['phrygian', 'aeolian'],
    roots: [40, 41, 43],
    kick: ['x---x---x---x---'],
    kickDrop: ['x---x---x---x-x-', 'x---x---x--xx---'],
    snare: '----x-------x---',
    snareDrop: '----c-------c-g-',
    hats: ['xxaxxxaxxxaxxxax'],
    hatsDrop: ['xxoxxxoxxxoxxxox', 'xaoaxaoaxaoaxaoa'],
    bass: ['rrrorrrorrrorr5o', 'r.or.or.or.or.o.', 'rrrrrrrrrrrrrrro'],
    arpRate: 16,
    arpRateDrop: 16,
    arps: [
      [0, 4, 2, 5],
      [0, 1, 2, 3, 4, 5, 4, 3, 2, 1, 2, 3],
      [0, 4, 1, 5, 2, 6],
    ],
    swell: 0.12,
    bassGlide: false,
    pump: 0.6,
  },
}

/** The calm title-screen tempo (any mood). */
export const TITLE_BPM = 84

/**
 * A song's key from its seed: the scale first, then the root. These are
 * the first two numbers a session's seed gives (music/index.ts rolls them
 * in exactly this order), so songs.ts can say a song's key without
 * building the band.
 */
export function rollKey(m: Mood, rnd: () => number): { scale: ScaleName; root: number } {
  const scale = m.scales[Math.floor(rnd() * m.scales.length)]
  const root = m.roots[Math.floor(rnd() * m.roots.length)]
  return { scale, root }
}

/** Four-bar chord progressions (scale degrees per bar), by scale. */
export const PROGRESSIONS: Record<ScaleName, number[][]> = {
  aeolian: [
    [0, 5, 2, 6], // i  VI  III VII  - the synthwave anthem
    [0, 6, 5, 6], // i  VII VI  VII
    [0, 3, 5, 4], // i  iv  VI  v
    [5, 6, 0, 0], // VI VII i   i
    [0, 5, 3, 6], // i  VI  iv  VII
    [0, 2, 6, 5], // i  III VII VI
  ],
  dorian: [
    [0, 3, 0, 3], // i  IV  i   IV  - the dorian lift
    [0, 6, 3, 0], // i  VII IV  i
    [0, 2, 3, 3], // i  III IV  IV
    [0, 4, 6, 3], // i  v   VII IV
    [0, 3, 6, 0], // i  IV  VII i
  ],
  phrygian: [
    [0, 1, 0, 1], // i  II  i   II  - tense
    [0, 5, 1, 0], // i  VI  II  i
    [0, 1, 5, 1], // i  II  VI  II
    [0, 3, 1, 0], // i  iv  II  i
  ],
}

/**
 * Hook rhythms: two bars of 32 sixteenths as [start step, length in steps].
 * The music picks one per session and writes a melody onto it.
 */
export const HOOK_RHYTHMS: [number, number][][] = [
  [[0, 3], [3, 3], [6, 2], [8, 4], [12, 4], [16, 3], [19, 3], [22, 2], [24, 8]],
  [[0, 2], [2, 2], [4, 4], [10, 2], [12, 4], [16, 2], [18, 2], [20, 6], [28, 4]],
  [[0, 6], [6, 2], [8, 6], [14, 2], [16, 4], [20, 4], [24, 8]],
  [[2, 2], [4, 2], [6, 4], [10, 2], [12, 4], [18, 2], [20, 2], [22, 4], [26, 6]],
  [[0, 4], [4, 4], [8, 2], [10, 2], [12, 4], [16, 8], [24, 4], [28, 4]],
]

/** One note of a hook: when, how long (steps), and which scale step above the bar's chord root. */
export interface HookNote {
  step: number
  len: number
  degree: number
}

/**
 * Write a hook melody: four bars, a two-bar "call" and a two-bar
 * "answer" that comes home to the chord root. Strong beats land on
 * chord tones (0, 2, 4 = root, third, fifth); in between it moves by
 * step, the way a singer would.
 */
export function writeHook(rnd: () => number): HookNote[] {
  const rhythm = HOOK_RHYTHMS[Math.floor(rnd() * HOOK_RHYTHMS.length)]
  const chordTones = [0, 2, 4, 7]
  const call: HookNote[] = []
  let deg = chordTones[1 + Math.floor(rnd() * 2)] // start on the third or fifth
  for (let i = 0; i < rhythm.length; i++) {
    const [step, len] = rhythm[i]
    const strong = step % 4 === 0
    if (i > 0) {
      const move = rnd() < 0.65 ? (rnd() < 0.5 ? -1 : 1) : rnd() < 0.5 ? -2 : 2
      deg += move
      if (strong) {
        // snap to the nearest chord tone on the beat
        let best = chordTones[0]
        for (const c of chordTones) if (Math.abs(c - deg) < Math.abs(best - deg)) best = c
        deg = best
      }
      deg = Math.max(-2, Math.min(9, deg))
    }
    call.push({ step, len, degree: deg })
  }
  // The answer: same rhythm two bars later, same shape, last two notes walking home.
  const answer: HookNote[] = call.map((n) => ({ step: n.step + 32, len: n.len, degree: n.degree }))
  if (answer.length >= 2) {
    answer[answer.length - 2].degree = rnd() < 0.5 ? 1 : 2
    answer[answer.length - 1].degree = 0
  }
  return call.concat(answer)
}
