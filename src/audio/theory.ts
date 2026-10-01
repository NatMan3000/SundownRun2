// ============================================================
//  MUSIC THEORY - keys, scales and chords, in numbers
// ------------------------------------------------------------
//  Notes are MIDI numbers: 60 is middle C, +1 is one semitone up,
//  +12 is one octave up. A scale is a list of semitone steps from
//  the key's root. A chord is built by stacking every other note of
//  the scale (1st, 3rd, 5th, 7th), which keeps everything in key.
//
//  `musicKey` is the key the soundtrack is playing in right now.
//  The music system sets it; sound effects read it, so a pickup
//  chime or a trick stinger always lands in tune with the music.
// ============================================================

/** Semitone steps of the modes synthwave lives in. */
export const SCALES = {
  /** Natural minor: dark, emotional, the classic night-drive sound. */
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  /** Minor with a raised 6th: still moody, but hopeful. Sundown. */
  dorian: [0, 2, 3, 5, 7, 9, 10],
  /** Minor with a flat 2nd: tense and exotic, for the hyper mood. */
  phrygian: [0, 1, 3, 5, 7, 8, 10],
} as const

export type ScaleName = keyof typeof SCALES

/** Five-note scales: every note sounds fine against every chord in the key. */
export const PENTA_MINOR = [0, 3, 5, 7, 10] as const
export const PENTA_MAJOR = [0, 2, 4, 7, 9] as const

/** The key the music is in right now (written by the music system). */
export const musicKey = {
  /** MIDI root, e.g. 57 = A3. */
  root: 57,
  scale: 'aeolian' as ScaleName,
}

/**
 * The MIDI note of scale degree `degree` (0 = root, 7 = root an octave up,
 * negative goes down) in a scale built on `root`.
 */
export function degreeToMidi(root: number, scale: ScaleName, degree: number): number {
  const steps = SCALES[scale]
  const n = steps.length
  const octave = Math.floor(degree / n)
  const idx = degree - octave * n
  return root + octave * 12 + steps[idx]
}

/**
 * The step-th note up the bright pentatonic that fits the current key.
 * For a minor key that is the major pentatonic of its relative major
 * (3 semitones up): the same five notes as the minor pentatonic, but
 * climbing from a happier starting note. Used by pickups and stingers.
 */
export function brightPentaMidi(step: number, octaveUp = 1): number {
  const base = musicKey.root + 3 + 12 * octaveUp
  const n = PENTA_MAJOR.length
  const octave = Math.floor(step / n)
  const idx = step - octave * n
  return base + octave * 12 + PENTA_MAJOR[idx]
}
