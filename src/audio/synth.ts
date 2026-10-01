// ============================================================
//  SYNTH TOOLKIT - the small building blocks every sound uses
// ------------------------------------------------------------
//  Nothing in here knows about the game. It is maths (clamp,
//  smoothstep), a seeded random number generator, a few buffers
//  and curves made once per AudioContext (white noise, a soft
//  clipper, a pulse wave), and `Knob`, the helper the engine and
//  the mixer use to move a sound parameter smoothly.
//
//  Everything takes a BaseAudioContext, so the same code runs in
//  the live game and in an OfflineAudioContext (the music render).
// ============================================================

// ---------------------------------------------------------------- maths

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Smooth 0 -> 1 ramp between edge0 and edge1 (Hermite curve, no corners). */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

/** MIDI note number to frequency in Hz (69 = A4 = 440 Hz). */
export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12)
}

/** A frequency moved by some semitones (12 = one octave up). */
export function semis(hz: number, semitones: number): number {
  return hz * Math.pow(2, semitones / 12)
}

/** Decibels to a gain multiplier (-6 dB is about half). */
export function dbToGain(db: number): number {
  return Math.pow(10, db / 20)
}

// ---------------------------------------------------------------- seeded random

/**
 * mulberry32: a tiny, fast random number generator that gives the SAME
 * sequence every time for the same seed. The music uses it so a session
 * is varied (new seed each session) but a render can be repeated exactly.
 * Returns numbers in [0, 1).
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Turn a string (a track id) into a 32-bit seed. */
export function hashString(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

// ---------------------------------------------------------------- buffers and curves

/**
 * Two seconds of white noise, made once and shared by every hiss, whoosh,
 * hi-hat and crash. Seeded, so it is the same noise every run. Two seconds
 * is long enough that the loop point is never heard under a filter.
 */
export function makeNoiseBuffer(ctx: BaseAudioContext, seconds = 2): AudioBuffer {
  const n = Math.floor(ctx.sampleRate * seconds)
  const buf = ctx.createBuffer(1, n, ctx.sampleRate)
  const data = buf.getChannelData(0)
  const rnd = mulberry32(0x5c0de1)
  for (let i = 0; i < n; i++) data[i] = rnd() * 2 - 1
  return buf
}

/**
 * Soft-clip curve for a WaveShaperNode. Loud input gets its edges rounded
 * and grows extra harmonics, which is what makes the engine sound gritty
 * under load. Higher drive = dirtier.
 */
export function makeSoftClipCurve(drive: number, n = 2048): Float32Array<ArrayBuffer> {
  // An explicit ArrayBuffer: WaveShaperNode.curve refuses a SharedArrayBuffer-backed array.
  const curve = new Float32Array(new ArrayBuffer(n * 4))
  const norm = Math.tanh(drive)
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1
    curve[i] = Math.tanh(drive * x) / norm
  }
  return curve
}

/**
 * A pulse wave (a square wave whose "on" part is `duty` of the cycle).
 * Thin pulses (0.2-0.3) sound nasal and buzzy, the classic synth engine
 * and bass tone. Built from its harmonics so WebAudio can play it as an
 * oscillator shape.
 */
export function makePulseWave(ctx: BaseAudioContext, duty: number, harmonics = 48): PeriodicWave {
  const real = new Float32Array(harmonics + 1)
  const imag = new Float32Array(harmonics + 1)
  for (let n = 1; n <= harmonics; n++) {
    real[n] = Math.sin(2 * Math.PI * n * duty) / (Math.PI * n)
    imag[n] = (1 - Math.cos(2 * Math.PI * n * duty)) / (Math.PI * n)
  }
  return ctx.createPeriodicWave(real, imag)
}

/**
 * A short reverb "room" made of decaying noise, for a ConvolverNode.
 * gated = true gives the famous 1980s gated-reverb snare: the tail stays
 * big and then stops dead instead of fading.
 */
export function makeReverbImpulse(ctx: BaseAudioContext, seconds: number, decay: number, gated: boolean, seed: number): AudioBuffer {
  const n = Math.floor(ctx.sampleRate * seconds)
  const buf = ctx.createBuffer(2, n, ctx.sampleRate)
  const rnd = mulberry32(seed)
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch)
    for (let i = 0; i < n; i++) {
      const x = i / n
      // Gated: flat then a quick fall at the end. Normal: a smooth fade.
      const shape = gated ? (x < 0.82 ? 1 - x * 0.35 : (1 - x) / 0.18 * 0.71) : Math.pow(1 - x, decay)
      d[i] = (rnd() * 2 - 1) * shape
    }
  }
  return buf
}

// ---------------------------------------------------------------- Knob

/**
 * Moves one AudioParam smoothly toward a target, and skips the call when
 * the target has hardly changed. The engine sets about twenty of these
 * every frame; skipping the tiny changes keeps the audio thread's
 * automation list short. setTargetAtTime glides (no zipper noise).
 */
export class Knob {
  private last = Number.NaN

  constructor(
    readonly param: AudioParam,
    /** Glide time constant in seconds (63% of the way there after this long). */
    readonly tau: number,
    /** Ignore target changes smaller than this. */
    readonly eps: number,
  ) {}

  to(value: number, t: number, tau = this.tau): void {
    if (!Number.isFinite(value)) return
    if (Math.abs(value - this.last) <= this.eps) return
    this.last = value
    this.param.setTargetAtTime(value, t, tau)
  }

  /** Forget the last target so the next to() always lands (after something else moved the param). */
  reset(): void {
    this.last = Number.NaN
  }
}

/** Exponential ramps cannot reach zero; this is the "silent" floor envelopes fall to. */
export const SILENT = 0.0001

/**
 * Stop a param where it is right now and clear what was scheduled after,
 * so a new envelope starts from the current level (no click). Uses
 * cancelAndHoldAtTime where the browser has it.
 */
export function holdParam(p: AudioParam, t: number): void {
  const withHold = p as AudioParam & { cancelAndHoldAtTime?: (t: number) => AudioParam }
  if (typeof withHold.cancelAndHoldAtTime === 'function') {
    withHold.cancelAndHoldAtTime(t)
  } else {
    const v = p.value
    p.cancelScheduledValues(t)
    p.setValueAtTime(v, t)
  }
}
