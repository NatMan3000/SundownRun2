// ============================================================
//  MUSIC INSTRUMENTS - the synth band
// ------------------------------------------------------------
//  Every instrument here is built ONCE and then "played" by
//  scheduling envelopes on its knobs: a note is a volume rise and
//  fall, a pitch change and a filter sweep at an exact time on the
//  audio clock. So the music makes no new audio nodes per note at
//  all, which keeps it cheap enough to never cost a frame.
//
//    Kick        sine with a fast pitch drop + a click; also "pumps"
//                the bass, pads and arp (sidechain feel)
//    Snare       a tone + a burst of noise, into a gated reverb
//                (the huge 80s snare that stops dead)
//    Hats        bright noise; short = closed, long = open
//    Crash       long bright noise for the start of a drop
//    Bass        saw + pulse + sub, filter envelope per note
//    Arp         plucky pulse wave into a ping-pong echo
//    Pad         four voices of two detuned saws, slow filter,
//                chorus and reverb: the warm wash under everything
//    Lead        singing saw with vibrato and glide, for the hook
//    Riser       noise sweeping up through a build
//
//  Env is the trick that makes retriggering clean: it remembers its
//  own last note so it can always say what level it is at RIGHT NOW,
//  and a new note starts exactly from there (no clicks).
// ============================================================

import { Knob, SILENT, makePulseWave, makeReverbImpulse, midiToHz } from '../synth'

// ---------------------------------------------------------------- Env

/**
 * An envelope on one AudioParam: attack to `peak`, decay toward
 * `sustain`, and (if the note has a length) release back to `base`.
 * Notes must be scheduled in time order (the sequencer does).
 */
export class Env {
  private t0 = -1
  private v0 = 0
  private peak = 0
  private attack = 0.001
  private decayTau = 0.1
  private sustain = 0
  private tOff = Number.POSITIVE_INFINITY
  private relTau = 0.1
  private vOff = 0

  constructor(
    readonly p: AudioParam,
    readonly base = 0,
  ) {
    p.value = base
  }

  /** Where this envelope is at time t (worked out from the last note). */
  valueAt(t: number): number {
    if (this.t0 < 0) return this.base
    if (t <= this.t0) return this.v0
    const ta = this.t0 + this.attack
    if (t < ta) return this.v0 + (this.peak - this.v0) * ((t - this.t0) / this.attack)
    if (t < this.tOff) return this.sustain + (this.peak - this.sustain) * Math.exp(-(t - ta) / this.decayTau)
    return this.base + (this.vOff - this.base) * Math.exp(-(t - this.tOff) / this.relTau)
  }

  /**
   * Play a note starting at t. decayTau is how fast it settles to
   * `sustain`; if dur is given, at t + dur it releases to `base` with relTau.
   */
  note(t: number, peak: number, attack: number, decayTau: number, sustain = this.base, dur = Number.POSITIVE_INFINITY, relTau = decayTau): void {
    const p = this.p
    const v = this.valueAt(t)
    p.cancelScheduledValues(t)
    p.setValueAtTime(v, t)
    p.linearRampToValueAtTime(peak, t + attack)
    p.setTargetAtTime(sustain, t + attack, decayTau)
    this.t0 = t
    this.v0 = v
    this.peak = peak
    this.attack = attack
    this.decayTau = decayTau
    this.sustain = sustain
    this.relTau = relTau
    if (Number.isFinite(dur)) {
      const off = Math.max(t + attack, t + dur)
      p.setTargetAtTime(this.base, off, relTau)
      this.tOff = off
      this.vOff = sustain + (peak - sustain) * Math.exp(-(off - t - attack) / decayTau)
    } else {
      this.tOff = Number.POSITIVE_INFINITY
    }
  }
}

// ---------------------------------------------------------------- shared music buses

/** The rooms and wires every instrument plugs into. */
export class Band {
  readonly ctx: BaseAudioContext
  readonly noise: AudioBuffer
  /** Drums go here. */
  readonly drums: GainNode
  /** Bass, pads and arp go here: this bus "pumps" with the kick. */
  readonly pumped: GainNode
  /** Lead and fx go here (not pumped). */
  readonly direct: GainNode
  /** Sends: big hall reverb, gated snare reverb, ping-pong echo. */
  readonly reverb: GainNode
  readonly gated: GainNode
  readonly echo: GainNode
  readonly pump: Env
  /** Every oscillator / noise loop this band started (for dispose and the voice count). */
  readonly sources: AudioScheduledSourceNode[] = []
  private readonly nodes: AudioNode[] = []
  private readonly echoL: DelayNode
  private readonly echoR: DelayNode

  constructor(ctx: BaseAudioContext, out: AudioNode, noise: AudioBuffer) {
    this.ctx = ctx
    this.noise = noise
    this.drums = this.gain(0.9)
    this.pumped = this.gain(1)
    this.direct = this.gain(1)
    this.drums.connect(out)
    this.pumped.connect(out)
    this.direct.connect(out)
    this.pump = new Env(this.pumped.gain, 1)

    // hall reverb: a 2.8 s smooth tail
    this.reverb = this.gain(1)
    const hall = this.node(ctx.createConvolver())
    hall.buffer = makeReverbImpulse(ctx, 2.8, 3.2, false, 0xa11)
    const hallOut = this.gain(0.32)
    const hallHp = this.filter('highpass', 220, 0.7)
    this.reverb.connect(hallHp)
    hallHp.connect(hall)
    hall.connect(hallOut)
    hallOut.connect(out)

    // gated reverb: big, then stops dead
    this.gated = this.gain(1)
    const gate = this.node(ctx.createConvolver())
    gate.buffer = makeReverbImpulse(ctx, 0.32, 1, true, 0x6a7ed)
    const gateOut = this.gain(0.4)
    this.gated.connect(gate)
    gate.connect(gateOut)
    gateOut.connect(this.drums)

    // ping-pong echo: left, then right, then left... darker each repeat
    this.echo = this.gain(1)
    this.echoL = this.node(ctx.createDelay(2))
    this.echoR = this.node(ctx.createDelay(2))
    const fb = this.gain(0.38)
    const tone = this.filter('lowpass', 2600, 0.5)
    const panL = this.node(ctx.createStereoPanner())
    panL.pan.value = -0.75
    const panR = this.node(ctx.createStereoPanner())
    panR.pan.value = 0.75
    const echoOut = this.gain(0.42)
    this.echo.connect(this.echoL)
    this.echoL.connect(this.echoR)
    this.echoR.connect(tone)
    tone.connect(fb)
    fb.connect(this.echoL)
    this.echoL.connect(panL)
    this.echoR.connect(panR)
    panL.connect(echoOut)
    panR.connect(echoOut)
    echoOut.connect(out)
  }

  /** Echo time follows the tempo: a dotted eighth, the classic synthwave echo. */
  setTempo(beatS: number, t: number): void {
    const d = beatS * 0.75
    this.echoL.delayTime.setTargetAtTime(d, t, 0.05)
    this.echoR.delayTime.setTargetAtTime(d, t, 0.05)
  }

  // small helpers every instrument uses
  gain(v: number): GainNode {
    const g = this.node(this.ctx.createGain())
    g.gain.value = v
    return g
  }
  filter(type: BiquadFilterType, hz: number, q: number): BiquadFilterNode {
    const f = this.node(this.ctx.createBiquadFilter())
    f.type = type
    f.frequency.value = hz
    f.Q.value = q
    return f
  }
  osc(type: OscillatorType | PeriodicWave, hz: number, detune = 0): OscillatorNode {
    const o = this.ctx.createOscillator()
    if (type instanceof PeriodicWave) o.setPeriodicWave(type)
    else o.type = type
    o.frequency.value = hz
    o.detune.value = detune
    o.start(0)
    this.sources.push(o)
    return o
  }
  noiseLoop(offset: number): AudioBufferSourceNode {
    const n = this.ctx.createBufferSource()
    n.buffer = this.noise
    n.loop = true
    n.start(0, offset)
    this.sources.push(n)
    return n
  }
  pan(v: number): StereoPannerNode {
    const p = this.node(this.ctx.createStereoPanner())
    p.pan.value = v
    return p
  }
  node<T extends AudioNode>(n: T): T {
    this.nodes.push(n)
    return n
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

// ---------------------------------------------------------------- drums

export class Kick {
  private readonly pitch: AudioParam
  private readonly amp: Env
  private readonly click: Env

  constructor(private readonly b: Band) {
    const o = b.osc('sine', 50)
    this.pitch = o.frequency
    const g = b.gain(0)
    this.amp = new Env(g.gain)
    const shaper = b.node(b.ctx.createWaveShaper())
    shaper.curve = kickCurve()
    o.connect(g)
    g.connect(shaper)
    shaper.connect(b.drums)
    const n = b.noiseLoop(0.2)
    const hp = b.filter('highpass', 2800, 0.7)
    const cg = b.gain(0)
    this.click = new Env(cg.gain)
    n.connect(hp)
    hp.connect(cg)
    cg.connect(b.drums)
  }

  /** vel 0..1; long = boomier (title, breakdown impacts); pumpDepth = how hard the sidechain dips. */
  hit(t: number, vel: number, pumpDepth: number, long = false): void {
    this.pitch.cancelScheduledValues(t)
    this.pitch.setValueAtTime(long ? 120 : 155, t)
    this.pitch.setTargetAtTime(long ? 38 : 46, t + 0.002, long ? 0.06 : 0.032)
    this.amp.note(t, 0.68 * vel, 0.002, long ? 0.32 : 0.12)
    this.click.note(t, 0.2 * vel, 0.0005, 0.005)
    if (pumpDepth > 0) this.b.pump.note(t, 1 - pumpDepth, 0.006, 0.1, 1)
  }
}

/** A gentle soft-clip that gives the kick a rounder punch. */
function kickCurve(): Float32Array<ArrayBuffer> {
  const n = 1024
  const c = new Float32Array(new ArrayBuffer(n * 4))
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1
    c[i] = Math.tanh(1.6 * x) / Math.tanh(1.6)
  }
  return c
}

export class Snare {
  private readonly body: Env
  private readonly bodyPitch: AudioParam
  private readonly noise: Env
  private readonly send: Env

  constructor(b: Band) {
    const o = b.osc('triangle', 190)
    this.bodyPitch = o.frequency
    const bg = b.gain(0)
    this.body = new Env(bg.gain)
    o.connect(bg)
    bg.connect(b.drums)
    const n = b.noiseLoop(0.7)
    const bp = b.filter('bandpass', 2600, 0.55)
    const hp = b.filter('highpass', 700, 0.7)
    const ng = b.gain(0)
    this.noise = new Env(ng.gain)
    n.connect(bp)
    bp.connect(hp)
    hp.connect(ng)
    ng.connect(b.drums)
    const sg = b.gain(0)
    this.send = new Env(sg.gain)
    ng.connect(sg)
    sg.connect(b.gated)
  }

  /** clap = three fast slaps then the tail (the 80s clap). gatedSend 0..1 = how much big room. */
  hit(t: number, vel: number, clap: boolean, gatedSend: number): void {
    this.bodyPitch.cancelScheduledValues(t)
    this.bodyPitch.setValueAtTime(210, t)
    this.bodyPitch.setTargetAtTime(165, t, 0.03)
    this.body.note(t, 0.34 * vel, 0.001, 0.045)
    if (clap) {
      this.noise.note(t, 0.45 * vel, 0.001, 0.006)
      this.noise.note(t + 0.011, 0.45 * vel, 0.001, 0.006)
      this.noise.note(t + 0.022, 0.62 * vel, 0.001, 0.075)
    } else {
      this.noise.note(t, 0.62 * vel, 0.001, 0.08)
    }
    this.send.note(t, gatedSend, 0.001, 0.12, 0, 0.16, 0.03)
  }
}

export class Hats {
  private readonly amp: Env
  private readonly tone: AudioParam

  constructor(b: Band) {
    const n = b.noiseLoop(1.1)
    const hp = b.filter('highpass', 7200, 0.8)
    const pk = b.filter('peaking', 10500, 1.2)
    pk.gain.value = 5
    this.tone = hp.frequency
    const g = b.gain(0)
    this.amp = new Env(g.gain)
    const p = b.pan(0.22)
    n.connect(hp)
    hp.connect(pk)
    pk.connect(g)
    g.connect(p)
    p.connect(b.drums)
  }

  hit(t: number, vel: number, open: boolean): void {
    this.amp.note(t, (open ? 0.2 : 0.19) * vel, 0.001, open ? 0.16 : 0.024)
    this.tone.setValueAtTime(open ? 6400 : 7600, t)
  }
}

export class Crash {
  private readonly amp: Env

  constructor(b: Band) {
    const n = b.noiseLoop(1.6)
    const hp = b.filter('highpass', 4200, 0.6)
    const g = b.gain(0)
    this.amp = new Env(g.gain)
    n.connect(hp)
    hp.connect(g)
    g.connect(b.drums)
    const send = b.gain(0.25)
    g.connect(send)
    send.connect(b.reverb)
  }

  hit(t: number, vel: number): void {
    this.amp.note(t, 0.17 * vel, 0.002, 0.7)
  }
}

// ---------------------------------------------------------------- bass

export class Bass {
  private readonly freqs: AudioParam[] = []
  private readonly amp: Env
  private readonly cut: Env
  /** Base filter cutoff (Hz) the note envelope opens up from. Set by the arranger. */
  baseCutoff = 380
  /** How far each note's filter envelope opens (Hz). */
  envAmount = 900

  constructor(b: Band) {
    const saw = b.osc('sawtooth', 55)
    const pulse = b.osc(makePulseWave(b.ctx, 0.3), 55, 6)
    const sub = b.osc('sine', 27.5)
    this.freqs.push(saw.frequency, pulse.frequency)
    this.subFreq = sub.frequency
    const mix = b.gain(1)
    const sg = b.gain(0.32)
    const pg = b.gain(0.22)
    const subg = b.gain(0.3)
    saw.connect(sg)
    pulse.connect(pg)
    sub.connect(subg)
    sg.connect(mix)
    pg.connect(mix)
    const lp = b.filter('lowpass', 400, 4)
    this.cut = new Env(lp.frequency, 400)
    mix.connect(lp)
    const amp = b.gain(0)
    this.amp = new Env(amp.gain)
    lp.connect(amp)
    subg.connect(amp)
    const level = b.gain(0.55)
    amp.connect(level)
    level.connect(b.pumped)
  }

  private readonly subFreq: AudioParam

  /** Play `midi` for `dur` seconds. glide > 0 slides into the note (legato). */
  note(t: number, midi: number, dur: number, vel: number, glide = 0): void {
    const hz = midiToHz(midi)
    for (const f of this.freqs) {
      if (glide > 0) f.setTargetAtTime(hz, t, glide)
      else f.setValueAtTime(hz, t)
    }
    if (glide > 0) this.subFreq.setTargetAtTime(hz / 2, t, glide)
    else this.subFreq.setValueAtTime(hz / 2, t)
    this.amp.note(t, 0.5 * vel, 0.004, Math.max(0.08, dur * 0.7), 0.32 * vel, dur, 0.03)
    this.cut.note(t, this.baseCutoff + this.envAmount * vel, 0.004, Math.max(0.05, dur * 0.35), this.baseCutoff, dur, 0.06)
  }
}

// ---------------------------------------------------------------- arp

export class Arp {
  private readonly freqA: AudioParam
  private readonly freqB: AudioParam
  private readonly amp: Env
  readonly cutoff: Knob
  readonly echoSend: Knob

  constructor(b: Band) {
    const a = b.osc(makePulseWave(b.ctx, 0.25), 440)
    const s = b.osc('sawtooth', 440, -9)
    this.freqA = a.frequency
    this.freqB = s.frequency
    const ag = b.gain(0.5)
    const sg = b.gain(0.28)
    a.connect(ag)
    s.connect(sg)
    const lp = b.filter('lowpass', 2200, 3)
    ag.connect(lp)
    sg.connect(lp)
    const amp = b.gain(0)
    this.amp = new Env(amp.gain)
    lp.connect(amp)
    const level = b.gain(0.46)
    amp.connect(level)
    level.connect(b.pumped)
    const echo = b.gain(0.4)
    amp.connect(echo)
    echo.connect(b.echo)
    const verb = b.gain(0.25)
    amp.connect(verb)
    verb.connect(b.reverb)
    this.cutoff = new Knob(lp.frequency, 0.4, 5)
    this.echoSend = new Knob(echo.gain, 0.5, 0.01)
  }

  note(t: number, midi: number, dur: number, vel: number): void {
    const hz = midiToHz(midi)
    this.freqA.setValueAtTime(hz, t)
    this.freqB.setValueAtTime(hz, t)
    this.amp.note(t, 0.5 * vel, 0.003, Math.max(0.04, dur * 0.45), 0, dur, 0.02)
  }
}

// ---------------------------------------------------------------- pad

export class Pad {
  private readonly voices: { a: AudioParam; b: AudioParam }[] = []
  private readonly amp: Env
  readonly cutoff: Knob
  readonly level: Knob

  constructor(b: Band) {
    const sum = b.gain(1)
    for (let i = 0; i < 4; i++) {
      const a = b.osc('sawtooth', 220, -8)
      const c = b.osc('sawtooth', 220, 8)
      const g = b.gain(0.11)
      const p = b.pan(i % 2 === 0 ? -0.45 : 0.45)
      a.connect(g)
      c.connect(g)
      g.connect(p)
      p.connect(sum)
      this.voices.push({ a: a.frequency, b: c.frequency })
    }
    // slow filter: a gentle LFO breathing on the cutoff
    const lp = b.filter('lowpass', 1400, 0.9)
    const lfo = b.osc('sine', 0.07)
    const lfoDepth = b.gain(260)
    lfo.connect(lfoDepth)
    lfoDepth.connect(lp.frequency)
    sum.connect(lp)
    const amp = b.gain(0)
    this.amp = new Env(amp.gain)
    lp.connect(amp)
    // chorus: two short wobbling delays spread left and right
    const out = b.gain(0.8)
    amp.connect(out)
    for (let i = 0; i < 2; i++) {
      const d = b.node(b.ctx.createDelay(0.05))
      d.delayTime.value = i === 0 ? 0.012 : 0.017
      const wob = b.osc('sine', i === 0 ? 0.27 : 0.41)
      const depth = b.gain(i === 0 ? 0.0022 : 0.0028)
      wob.connect(depth)
      depth.connect(d.delayTime)
      const p = b.pan(i === 0 ? -0.7 : 0.7)
      const g = b.gain(0.5)
      amp.connect(d)
      d.connect(g)
      g.connect(p)
      p.connect(out)
    }
    out.connect(b.pumped)
    const verb = b.gain(0.5)
    amp.connect(verb)
    verb.connect(b.reverb)
    this.cutoff = new Knob(lp.frequency, 0.8, 5)
    this.level = new Knob(out.gain, 0.6, 0.005)
  }

  /** Change to a chord (4 MIDI notes) at t, swelling in. */
  chord(t: number, midis: readonly number[], dur: number, swell: number): void {
    for (let i = 0; i < this.voices.length; i++) {
      const hz = midiToHz(midis[i % midis.length])
      this.voices[i].a.setTargetAtTime(hz, t, 0.012)
      this.voices[i].b.setTargetAtTime(hz, t, 0.012)
    }
    this.amp.note(t, 0.62, swell, 0.9, 0.5, dur, 0.5)
  }

  /** Fade the pad out (sections with no pad). */
  release(t: number): void {
    this.amp.note(t, Math.max(SILENT, this.amp.valueAt(t)), 0.01, 0.6, 0, 0.02, 0.6)
  }
}

// ---------------------------------------------------------------- lead

export class Lead {
  private readonly freqA: AudioParam
  private readonly freqB: AudioParam
  private readonly amp: Env

  constructor(b: Band) {
    const a = b.osc('sawtooth', 440, 4)
    const s = b.osc('square', 880, -4)
    this.freqA = a.frequency
    this.freqB = s.frequency
    const vib = b.osc('sine', 5.4)
    const vibDepth = b.gain(7) // cents
    vib.connect(vibDepth)
    vibDepth.connect(a.detune)
    vibDepth.connect(s.detune)
    const ag = b.gain(0.5)
    const sg = b.gain(0.14)
    a.connect(ag)
    s.connect(sg)
    const lp = b.filter('lowpass', 2800, 1.6)
    ag.connect(lp)
    sg.connect(lp)
    const amp = b.gain(0)
    this.amp = new Env(amp.gain)
    lp.connect(amp)
    const level = b.gain(0.3)
    amp.connect(level)
    level.connect(b.direct)
    const echo = b.gain(0.35)
    amp.connect(echo)
    echo.connect(b.echo)
    const verb = b.gain(0.35)
    amp.connect(verb)
    verb.connect(b.reverb)
  }

  note(t: number, midi: number, dur: number, vel: number, glide: boolean): void {
    const hz = midiToHz(midi)
    if (glide) {
      this.freqA.setTargetAtTime(hz, t, 0.035)
      this.freqB.setTargetAtTime(hz * 2, t, 0.035)
    } else {
      this.freqA.setValueAtTime(hz, t)
      this.freqB.setValueAtTime(hz * 2, t)
    }
    this.amp.note(t, 0.5 * vel, glide ? 0.02 : 0.012, 0.25, 0.36 * vel, dur, 0.09)
  }
}

// ---------------------------------------------------------------- riser

export class Riser {
  private readonly amp: Env
  private readonly band: AudioParam

  constructor(b: Band) {
    const n = b.noiseLoop(0.33)
    const bp = b.filter('bandpass', 400, 1.8)
    this.band = bp.frequency
    const g = b.gain(0)
    this.amp = new Env(g.gain)
    n.connect(bp)
    bp.connect(g)
    g.connect(b.direct)
    const send = b.gain(0.4)
    g.connect(send)
    send.connect(b.reverb)
  }

  /** Sweep up over `dur` seconds, then cut dead at the end (the drop). */
  rise(t: number, dur: number, level: number): void {
    this.band.cancelScheduledValues(t)
    this.band.setValueAtTime(350, t)
    this.band.exponentialRampToValueAtTime(7000, t + dur)
    this.amp.note(t, 0.09 * level, dur, 10, 0.09 * level, dur, 0.015)
  }
}
