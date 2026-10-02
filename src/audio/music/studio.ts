// ============================================================
//  THE STUDIO - the effects that make the band sound like a record
// ------------------------------------------------------------
//  Real synthwave and French house (Daft Punk) get their sound as
//  much from the studio as from the synths. These are those
//  studio boxes, each built ONCE when the band is built and
//  shared, never per note:
//
//    Tape      the whole band goes through a tape machine: a soft
//              saturation (louder notes get rounder and warmer, it
//              adds gentle harmonics), a softly rolled-off top end,
//              and a very slight "wow" (the pitch drifting a few
//              hundredths of a semitone as the tape wobbles) on the
//              notes, not the drums
//    Chorus    two short delays whose length wobbles slowly, one
//              left, one right: the shimmery, wide 80s sound on the
//              lead and the arp
//    Phaser    four "all-pass" filters swept by a slow wobble: a
//              moving swoosh through the pads (Daft Punk loves it)
//    Room      the gated reverb room for the snare and clap: a big
//              bright room whose tail stays loud (the way an 80s
//              engineer squashed a room mic with a compressor), then
//              a gate slams it shut (the Snare in instruments.ts
//              opens the gate on every hit)
//
//  Everything here takes a BaseAudioContext, so the offline
//  renderer builds exactly the same studio as the live game.
// ============================================================

import { mulberry32 } from '../synth'

/** Something that can make and remember nodes (the Band). */
export interface NodeMaker {
  readonly ctx: BaseAudioContext
  gain(v: number): GainNode
  filter(type: BiquadFilterType, hz: number, q: number): BiquadFilterNode
  osc(type: OscillatorType | PeriodicWave, hz: number, detune?: number): OscillatorNode
  pan(v: number): StereoPannerNode
  node<T extends AudioNode>(n: T): T
}

/**
 * Make a filter work out its settings once per 128 samples instead of
 * every sample. Right for filters swept by a slow wobble (a phaser, a
 * breathing pad): at 48 kHz that is 375 updates a second, far smoother
 * than the ear can follow, and it halves what a swept filter costs.
 */
export function controlRate(f: BiquadFilterNode): BiquadFilterNode {
  f.frequency.automationRate = 'k-rate'
  f.Q.automationRate = 'k-rate'
  f.detune.automationRate = 'k-rate'
  f.gain.automationRate = 'k-rate'
  return f
}

// ---------------------------------------------------------------- tape

/** Tape settings. Gentle on purpose: you should feel it, not hear an effect. */
export const TAPE = {
  /** Level into the saturator. The band peaks at about 1.4, so this keeps it inside the curve. */
  into: 0.5,
  /** How hard the curve bends (1 = barely, 3 = crunchy). */
  drive: 1.35,
  /** A little lopsided, like real tape: that adds the warm even harmonics. */
  tilt: 0.08,
  /** The top end rolls off softly from about here (Hz). */
  topHz: 11500,
  /** Wow: how far and how fast the notes' pitch drifts (seconds of delay swing, Hz). */
  wowDepthS: 0.00032,
  wowHz: 0.55,
  /** A second, slower drift so the wobble never repeats exactly. */
  wow2DepthS: 0.00022,
  wow2Hz: 0.21,
} as const

/** The tape saturation curve: tanh, slightly lopsided, then centred so silence stays silent. */
export function tapeCurve(drive: number, tilt: number, n = 2048): Float32Array<ArrayBuffer> {
  const c = new Float32Array(new ArrayBuffer(n * 4))
  const zero = Math.tanh(drive * tilt)
  // normalise so a small signal passes at exactly the same level (slope 1 at zero)
  const slope = drive * (1 - zero * zero)
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1
    c[i] = (Math.tanh(drive * (x + tilt)) - zero) / slope
  }
  return c
}

/**
 * The tape machine. `notes` (bass, pads, arp, lead, stabs) gets the wow;
 * `drums` skip it (a wobble on a drum is just smear). Both then go
 * through the saturator and the soft top end into `out`.
 */
export function buildTape(b: NodeMaker, out: AudioNode): { notes: GainNode; drums: GainNode } {
  const notes = b.gain(1)
  const drums = b.gain(1)
  // wow: a short delay whose length drifts with two slow wobbles
  const wow = b.node(b.ctx.createDelay(0.05))
  wow.delayTime.value = 0.004
  const lfo1 = b.osc('sine', TAPE.wowHz)
  const d1 = b.gain(TAPE.wowDepthS)
  lfo1.connect(d1)
  d1.connect(wow.delayTime)
  const lfo2 = b.osc('sine', TAPE.wow2Hz)
  const d2 = b.gain(TAPE.wow2DepthS)
  lfo2.connect(d2)
  d2.connect(wow.delayTime)
  notes.connect(wow)

  const into = b.gain(TAPE.into)
  wow.connect(into)
  drums.connect(into)
  const shaper = b.node(b.ctx.createWaveShaper())
  shaper.curve = tapeCurve(TAPE.drive, TAPE.tilt)
  shaper.oversample = '2x'
  // the lopsided curve can leave a tiny offset; this removes it (and any rumble below hearing)
  const dc = b.filter('highpass', 22, 0.7)
  const top = b.filter('lowpass', TAPE.topHz, 0.55)
  const back = b.gain(1 / TAPE.into)
  into.connect(shaper)
  shaper.connect(dc)
  dc.connect(top)
  top.connect(back)
  back.connect(out)
  return { notes, drums }
}

// ---------------------------------------------------------------- chorus

/**
 * A stereo chorus: two delays of about 10-14 ms, each wobbling slowly, one
 * panned left and one right. Returns the input to send into (wet only:
 * the instrument's own dry sound carries on as before).
 */
export function buildChorus(b: NodeMaker, out: AudioNode, level: number): GainNode {
  const input = b.gain(1)
  const wet = b.gain(level)
  const voices: [number, number, number, number][] = [
    // [base delay s, wobble Hz, wobble depth s, pan]
    [0.0105, 0.61, 0.0019, -0.8],
    [0.0137, 0.83, 0.0023, 0.8],
  ]
  for (const [base, hz, depth, pan] of voices) {
    const d = b.node(b.ctx.createDelay(0.05))
    d.delayTime.value = base
    const lfo = b.osc('sine', hz)
    const amt = b.gain(depth)
    lfo.connect(amt)
    amt.connect(d.delayTime)
    const p = b.pan(pan)
    input.connect(d)
    d.connect(p)
    p.connect(wet)
  }
  wet.connect(out)
  return input
}

// ---------------------------------------------------------------- phaser

/**
 * A phaser as an insert: the signal plus a copy through four all-pass
 * filters whose frequencies sweep slowly. Where the copy is out of step
 * with the original they cancel, and those notches sweep up and down.
 * Returns [input, output].
 */
export function buildPhaser(b: NodeMaker, rateHz: number, mix: number): [GainNode, GainNode] {
  const input = b.gain(1)
  const output = b.gain(1)
  const dry = b.gain(1 - mix * 0.5)
  const wet = b.gain(mix)
  input.connect(dry)
  dry.connect(output)
  const lfo = b.osc('sine', rateHz)
  let prev: AudioNode = input
  // each stage centred higher; each swings by 70% of its centre
  for (const hz of [320, 720, 1400, 2300]) {
    const ap = controlRate(b.filter('allpass', hz, 0.6))
    const depth = b.gain(hz * 0.7)
    lfo.connect(depth)
    depth.connect(ap.frequency)
    prev.connect(ap)
    prev = ap
  }
  prev.connect(wet)
  wet.connect(output)
  return [input, output]
}

// ---------------------------------------------------------------- the gated room

/**
 * The room the snare and clap ring in: a big, bright room (dense noise
 * fading only slowly over `seconds`, as if squashed by a compressor, so
 * the tail is still loud when the gate shuts), with a few early echoes off
 * the walls, each side a little different so it is wide. Softened by a
 * gentle low-pass as it is made, so the room is never a hiss. The gate in
 * instruments.ts chops it short; this is the room before the chop.
 *
 * It is scaled so the room passes on exactly as much energy as goes in
 * (its samples' squares add up to 1), and its ConvolverNode must have
 * `normalize = false`: the browser's own normalising makes a short room
 * like this one about 15 dB quieter, which is why the snare's room used
 * to be all but silent.
 */
export function makeRoomImpulse(ctx: BaseAudioContext, seconds: number, seed: number): AudioBuffer {
  const rate = ctx.sampleRate
  const n = Math.floor(rate * seconds)
  const buf = ctx.createBuffer(2, n, rate)
  const rnd = mulberry32(seed)
  // early reflections: [time s, level], shared shape, nudged per side
  const early: [number, number][] = [
    [0.0071, 0.75],
    [0.0113, 0.6],
    [0.0172, 0.55],
    [0.0239, 0.45],
    [0.0317, 0.38],
  ]
  // one-pole low-pass on the noise: about 7 kHz at 48 kHz
  const a = Math.exp((-2 * Math.PI * 7000) / rate)
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch)
    let lp = 0
    for (let i = 0; i < n; i++) {
      const t = i / rate
      // the dense tail grows in over the first 15 ms, then fades only slowly (-9 dB at the end)
      const grow = Math.min(1, t / 0.015)
      const env = grow * Math.pow(10, (-9 * (t / seconds)) / 20)
      lp = (1 - a) * (rnd() * 2 - 1) + a * lp
      d[i] = lp * env * 0.55
    }
    for (const [t, level] of early) {
      const at = Math.floor((t + (ch === 0 ? 0 : 0.0013)) * rate)
      if (at < n) d[at] += level * (ch === 0 ? 1 : 0.9)
    }
    // unity energy: the sum of the squares of this side's samples is 1
    let e = 0
    for (let i = 0; i < n; i++) e += d[i] * d[i]
    const k = e > 0 ? 1 / Math.sqrt(e) : 0
    for (let i = 0; i < n; i++) d[i] *= k
  }
  return buf
}
