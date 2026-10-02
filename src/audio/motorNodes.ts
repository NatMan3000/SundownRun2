// ============================================================
//  THE NODE MOTOR - the same engine, built from plain Web Audio parts
// ------------------------------------------------------------
//  The real motor (motorDsp.ts) runs as an AudioWorklet, and browsers
//  only allow those on secure pages (https, or localhost). A friend
//  who joins a LAN game opens the host's game over plain http, so on
//  their computer the worklet is not allowed. This file is their
//  engine: the same voicing, built from ordinary Web Audio nodes.
//
//  The trick: one engine cycle (two crank turns, every cylinder
//  firing once) is drawn as a single wave shape, thumps and all, and
//  an oscillator plays that shape over and over at the cycle rate.
//  A V8's two banks get one oscillator each, so each pipe still gets
//  its own uneven beat (the burble). Then the same pipes, growl and
//  muffler as the worklet, made of DelayNodes and filters.
//
//  What it can't do (only the worklet can): a different random wobble
//  on every single firing, skipped firings on a gear change, and the
//  overrun pops. A slow random pitch drift stands in for the wobble.
// ============================================================

import { Knob, makeSoftClipCurve } from './synth'
import type { MotorSpec } from './engineVoicings'

/** Points used to draw one engine cycle before turning it into harmonics. */
const DRAW_POINTS = 4096
/** Harmonics of the cycle kept (cycle rate x 256 reaches past the muffler even at idle). */
const HARMONICS = 256
/** Keeps the pipes' sum well inside the growl stage, so it rounds the sound instead of chopping it. */
const PIPE_TRIM = 0.3
/** Brings the node motor up to the worklet's loudness, after the growl stage. */
const OUT_TRIM = 3
/**
 * The drawn wave repeats exactly, so its rasp has to come from the noise alone
 * (the worklet also gets it from every firing landing a little differently).
 */
const GRIT_BOOST = 1.5

/**
 * One engine cycle for the firings that go down `pipe`, as a PeriodicWave.
 * Each firing is a thump: a sharp front and a slower fall, like the worklet's.
 * `crest` is the drawn wave's peak over its loudness: the browser scales
 * every wave to the same peak, so a spiky one (a few narrow thumps) comes
 * out quieter, and the pipe level makes up for it.
 */
function cycleWave(ctx: BaseAudioContext, m: MotorSpec, pipe: number): { wave: PeriodicWave; crest: number } | null {
  const n = Math.min(m.cylinders, m.fireAt.length)
  const shape = new Float32Array(DRAW_POINTS)
  const slot = 1 / n
  const fall = Math.max(0.002, m.thumpLength * slot) // in cycles
  const rise = Math.max(0.0005, fall * 0.06)
  let any = false
  for (let i = 0; i < n; i++) {
    if ((m.pipeOf[i] === 1 ? 1 : 0) !== pipe) continue
    any = true
    const at = m.fireAt[i]
    const a = m.punch[i] ?? 1
    for (let k = 0; k < DRAW_POINTS; k++) {
      let d = k / DRAW_POINTS - at
      if (d < 0) d += 1
      shape[k] += a * (Math.exp(-d / fall) - Math.exp(-d / rise))
    }
  }
  if (!any) return null
  let mean = 0
  for (let k = 0; k < DRAW_POINTS; k++) mean += shape[k]
  mean /= DRAW_POINTS
  let peak = 0
  let power = 0
  for (let k = 0; k < DRAW_POINTS; k++) {
    const v = shape[k] - mean
    if (Math.abs(v) > peak) peak = Math.abs(v)
    power += v * v
  }
  const crest = peak / Math.max(1e-9, Math.sqrt(power / DRAW_POINTS))
  const real = new Float32Array(HARMONICS + 1)
  const imag = new Float32Array(HARMONICS + 1)
  for (let h = 1; h <= HARMONICS; h++) {
    let re = 0
    let im = 0
    const w = (2 * Math.PI * h) / DRAW_POINTS
    for (let k = 0; k < DRAW_POINTS; k++) {
      re += shape[k] * Math.cos(w * k)
      im += shape[k] * Math.sin(w * k)
    }
    real[h] = (2 * re) / DRAW_POINTS
    imag[h] = (2 * im) / DRAW_POINTS
  }
  return { wave: ctx.createPeriodicWave(real, imag), crest }
}

interface Pipe {
  osc: OscillatorNode
  input: GainNode
  delay: DelayNode
  damp: BiquadFilterNode
  ring: GainNode
  level: GainNode
  grit: GainNode
}

export class NodeMotor {
  private readonly sources: AudioScheduledSourceNode[] = []
  private readonly nodes: AudioNode[] = []
  private readonly pipes: Pipe[] = []
  private readonly formants: { f: BiquadFilterNode; g: GainNode }[] = []
  private readonly directGain: GainNode
  private readonly driveIn: GainNode
  private readonly driveOut: GainNode
  private readonly shaper: WaveShaperNode
  private readonly mufflerA: BiquadFilterNode
  private readonly mufflerB: BiquadFilterNode
  private readonly out: GainNode
  private readonly k: { cycleHz: Knob; mufflerA: Knob; mufflerB: Knob; driveIn: Knob; driveOut: Knob }
  private motor: MotorSpec

  constructor(
    private readonly ctx: BaseAudioContext,
    dest: AudioNode,
    motor: MotorSpec,
    noise: AudioBuffer,
  ) {
    this.motor = motor
    const t0 = ctx.currentTime
    const node = <T extends AudioNode>(n: T): T => {
      this.nodes.push(n)
      return n
    }
    const gain = (v: number) => {
      const g = node(ctx.createGain())
      g.gain.value = v
      return g
    }
    const filter = (type: BiquadFilterType, hz: number, q: number) => {
      const f = node(ctx.createBiquadFilter())
      f.type = type
      f.frequency.value = hz
      f.Q.value = q
      return f
    }

    // The cycle clock: every oscillator's frequency comes from this one number.
    const cycleBus = ctx.createConstantSource()
    cycleBus.offset.value = 6
    cycleBus.start(t0)
    this.sources.push(cycleBus)

    // A slow random drift in pitch, so it is never a perfect machine.
    const wanderNoise = ctx.createBufferSource()
    wanderNoise.buffer = noise
    wanderNoise.loop = true
    wanderNoise.start(t0, 0.29)
    this.sources.push(wanderNoise)
    const wanderLp = filter('lowpass', 3, 0.7)
    const wanderCents = gain(1600)
    wanderNoise.connect(wanderLp)
    wanderLp.connect(wanderCents)

    const gritNoise = ctx.createBufferSource()
    gritNoise.buffer = noise
    gritNoise.loop = true
    gritNoise.start(t0, 0.83)
    this.sources.push(gritNoise)

    const mix = gain(1)
    for (let p = 0; p < 2; p++) {
      const osc = ctx.createOscillator()
      osc.frequency.value = 0
      this.sources.push(osc)
      cycleBus.connect(osc.frequency)
      wanderCents.connect(osc.detune)
      const input = gain(1)
      osc.connect(input)
      // Grit: noise whose loudness follows the thumps (the oscillator drives its gain).
      const grit = gain(0)
      const gritDepth = gain(motor.grit * GRIT_BOOST)
      osc.connect(gritDepth)
      gritDepth.connect(grit.gain)
      gritNoise.connect(grit)
      grit.connect(input)
      // The pipe: an echo of itself, upside down and duller each time round.
      const delay = node(ctx.createDelay(0.1))
      const damp = filter('lowpass', 2400, 0.5)
      const ring = gain(-motor.pipeRing)
      input.connect(delay)
      delay.connect(damp)
      damp.connect(ring)
      ring.connect(input)
      const level = gain(0)
      input.connect(level)
      level.connect(mix)
      osc.start(t0)
      this.pipes.push({ osc, input, delay, damp, ring, level, grit: gritDepth })
    }

    // Growl, then the muffler: box resonances in parallel with the direct sound, then the soft top filter.
    this.driveIn = gain(1)
    this.shaper = node(ctx.createWaveShaper())
    this.shaper.curve = makeSoftClipCurve(1)
    this.driveOut = gain(1)
    mix.connect(this.driveIn)
    this.driveIn.connect(this.shaper)
    this.shaper.connect(this.driveOut)
    const body = gain(1)
    this.directGain = gain(motor.direct)
    this.driveOut.connect(this.directGain)
    this.directGain.connect(body)
    for (let i = 0; i < 3; i++) {
      const f = filter('bandpass', 200, 1)
      const g = gain(0)
      this.driveOut.connect(f)
      f.connect(g)
      g.connect(body)
      this.formants.push({ f, g })
    }
    this.mufflerA = filter('lowpass', motor.mufflerHz, 0.5412)
    this.mufflerB = filter('lowpass', motor.mufflerHz, 1.3066)
    const dc = filter('highpass', 22, 0.7)
    this.out = gain(motor.level * (motor.nodeLevel ?? 1) * OUT_TRIM)
    body.connect(this.mufflerA)
    this.mufflerA.connect(this.mufflerB)
    this.mufflerB.connect(dc)
    dc.connect(this.out)
    this.out.connect(dest)

    this.k = {
      cycleHz: new Knob(cycleBus.offset, 0.03, 0.02),
      mufflerA: new Knob(this.mufflerA.frequency, 0.05, 2),
      mufflerB: new Knob(this.mufflerB.frequency, 0.05, 2),
      driveIn: new Knob(this.driveIn.gain, 0.05, 0.01),
      driveOut: new Knob(this.driveOut.gain, 0.05, 0.01),
    }
    this.setVoicing(motor)
  }

  /** Redraw the cycle and retune the pipes and muffler for a voicing (not per frame). */
  setVoicing(m: MotorSpec): void {
    this.motor = m
    const sr = this.ctx.sampleRate
    for (let p = 0; p < 2; p++) {
      const pipe = this.pipes[p]
      const drawn = cycleWave(this.ctx, m, p)
      const lvl = drawn ? (m.pipeLevel[p] ?? 0) * (drawn.crest / 4) : 0
      if (drawn) pipe.osc.setPeriodicWave(drawn.wave)
      pipe.level.gain.value = lvl * PIPE_TRIM
      const hz = m.pipeHz[p] ?? m.pipeHz[0] ?? 50
      // A DelayNode inside a loop can't be shorter than one 128-sample block.
      pipe.delay.delayTime.value = Math.max(128 / sr, 1 / (2 * hz))
      pipe.ring.gain.value = -Math.max(0, Math.min(0.9, m.pipeRing))
      pipe.grit.gain.value = m.grit * GRIT_BOOST
    }
    for (let i = 0; i < 3; i++) {
      const f = m.formants[i]
      this.formants[i].f.frequency.value = f ? f.hz : 200
      this.formants[i].f.Q.value = f ? f.q : 1
      this.formants[i].g.gain.value = f ? f.level : 0
    }
    this.directGain.gain.value = m.direct
    this.out.gain.value = m.level * (m.nodeLevel ?? 1) * OUT_TRIM
    this.k.mufflerA.reset()
    this.k.mufflerB.reset()
  }

  /** Per frame: the firing rate and the throttle. Allocation-free. */
  update(fireHz: number, throttle: number, t: number): void {
    const m = this.motor
    this.k.cycleHz.to(fireHz / Math.max(1, m.cylinders), t)
    const muffler = m.mufflerHz + m.mufflerOpenHz * throttle
    this.k.mufflerA.to(muffler, t)
    this.k.mufflerB.to(muffler, t)
    const drive = 1 + (m.drive - 1) * throttle
    this.k.driveIn.to(drive, t)
    this.k.driveOut.to(1 / drive, t)
  }

  dispose(): void {
    for (const s of this.sources) {
      try {
        s.stop()
      } catch {
        // already stopped
      }
      s.disconnect()
    }
    for (const n of this.nodes) n.disconnect()
    this.sources.length = 0
    this.nodes.length = 0
  }
}
