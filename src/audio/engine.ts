// ============================================================
//  ENGINE VOICE - the car you hear the whole time
// ------------------------------------------------------------
//  Built once when sound starts, then only nudged every frame.
//  No nodes are made per frame: every layer below exists from
//  the start and update() just moves its pitch, tone and volume.
//
//    THE MOTOR (follows telemetry.rpm, so it free-revs in the air
//    because the car's rpm does):
//      freqBus ─┬─ x0.5 → sub sine           the weight you feel
//               ├─ x1   → saw                the body of the note
//               ├─ x1   → thin pulse +9c     buzzy synth edge, beats with the saw
//               ├─ x2   → saw -7c            opens up under load
//               └─ x0.25 → lope LFO          the lumpy idle (fades as revs rise)
//      → drive (soft clip, harder under load) → lowpass (throttle opens it)
//      → shift cut (dips on a gear change) → out
//
//    THE NEON LAYERS (follow speed, not rpm):
//      turbine whine   two sines a fifth apart, rising with speed
//      boost jet       resonant noise + an octave of whine while boosting
//      wind            noise through a band that climbs with speed
//      road hiss       smooth wet-glass hiss on the road
//      terrain rumble  low, lumpy noise off-road
//      mag hum         electric buzz while magnetic grip holds you
//      tyre squeal     a narrow singing band + a wobbling tone from slip
//
//  A single ConstantSourceNode ("freqBus") feeds every motor
//  oscillator's frequency through a fixed ratio, so moving one number
//  moves the whole motor and the layers never drift out of tune.
// ============================================================

import { Knob, clamp01, makePulseWave, makeSoftClipCurve, smoothstep } from './synth'

/** What the engine listens to. Normally copied from telemetry each frame (see system.ts). */
export interface EngineInput {
  rpm: number //       0..1
  throttle: number //  0..1
  speedKmh: number
  gear: number
  slip: number //      0..1
  drifting: boolean
  airborne: boolean
  onRoad: boolean
  /** True when the surface under the car is terrain (off-road rumble). */
  offRoad: boolean
  magStrength: number // 0..1
  boost: number //     0..1
}

export function makeEngineInput(): EngineInput {
  return {
    rpm: 0,
    throttle: 0,
    speedKmh: 0,
    gear: 1,
    slip: 0,
    drifting: false,
    airborne: false,
    onRoad: true,
    offRoad: false,
    magStrength: 0,
    boost: 0,
  }
}

// ---------- voicing (tuned by ear) ----------

/** Motor fundamental: a low burble at rpm 0 up to a snarl at the limiter. */
const IDLE_HZ = 64
const REDLINE_HZ = 360
/** Overall motor loudness (the noise layers have their own levels below). */
const MOTOR_GAIN = 0.42
/** Speed where the wind and whine reach full level (km/h). Boost goes past it. */
const FULL_SPEED_KMH = 260

export interface EngineReadout {
  hz: number
  cutoff: number
  level: number
  whineHz: number
  wind: number
  road: number
  rumble: number
  squeal: number
  mag: number
  boostJet: number
  shifts: number
}

export class EngineVoice {
  readonly readout: EngineReadout = {
    hz: IDLE_HZ,
    cutoff: 0,
    level: 0,
    whineHz: 0,
    wind: 0,
    road: 0,
    rumble: 0,
    squeal: 0,
    mag: 0,
    boostJet: 0,
    shifts: 0,
  }

  private readonly sources: AudioScheduledSourceNode[] = []
  private readonly nodes: AudioNode[] = []
  private readonly shiftCut: GainNode
  private lastGear = 1

  // knobs moved every frame
  private readonly k: {
    hz: Knob
    cutoff: Knob
    q: Knob
    drive: Knob
    octave: Knob
    lopeDepth: Knob
    motor: Knob
    whineHz: Knob
    whine: Knob
    whineOct: Knob
    jetHz: Knob
    jet: Knob
    windHz: Knob
    wind: Knob
    road: Knob
    rumble: Knob
    squealHz: Knob
    squealTone: Knob
    squealNoise: Knob
    magHz: Knob
    mag: Knob
  }

  constructor(ctx: BaseAudioContext, out: AudioNode, noise: AudioBuffer) {
    const t0 = ctx.currentTime
    const src = <T extends AudioScheduledSourceNode>(n: T): T => {
      this.sources.push(n)
      return n
    }
    const node = <T extends AudioNode>(n: T): T => {
      this.nodes.push(n)
      return n
    }
    const gain = (v: number): GainNode => {
      const g = node(ctx.createGain())
      g.gain.value = v
      return g
    }
    const filter = (type: BiquadFilterType, hz: number, q: number): BiquadFilterNode => {
      const f = node(ctx.createBiquadFilter())
      f.type = type
      f.frequency.value = hz
      f.Q.value = q
      return f
    }
    const noiseLoop = (offset: number): AudioBufferSourceNode => {
      const n = src(ctx.createBufferSource())
      n.buffer = noise
      n.loop = true
      n.start(t0, offset)
      return n
    }
    const lfo = (hz: number, type: OscillatorType = 'sine'): OscillatorNode => {
      const o = src(ctx.createOscillator())
      o.type = type
      o.frequency.value = hz
      o.start(t0)
      return o
    }

    // ================= the motor =================
    const freqBus = src(ctx.createConstantSource())
    freqBus.offset.value = IDLE_HZ
    freqBus.start(t0)

    const motorMix = gain(1)
    const wire = (param: AudioParam, ratio: number) => {
      const g = gain(ratio)
      freqBus.connect(g)
      g.connect(param)
    }
    const layer = (type: OscillatorType | PeriodicWave, ratio: number, level: number, detune = 0): GainNode => {
      const o = src(ctx.createOscillator())
      if (type instanceof PeriodicWave) o.setPeriodicWave(type)
      else o.type = type
      o.frequency.value = 0 // the bus supplies all of it
      o.detune.value = detune
      wire(o.frequency, ratio)
      const g = gain(level)
      o.connect(g)
      g.connect(motorMix)
      o.start(t0)
      return g
    }
    layer('sine', 0.5, 0.42)
    layer('sawtooth', 1, 0.3)
    layer(makePulseWave(ctx, 0.22), 1, 0.2, 9)
    const octave = layer('sawtooth', 2, 0.04, -7)

    // The lope: at idle a real engine's note wobbles in volume a few times
    // per rev. A sine at a quarter of the note pumps the motor's volume.
    const lopeOsc = src(ctx.createOscillator())
    lopeOsc.type = 'sine'
    lopeOsc.frequency.value = 0
    wire(lopeOsc.frequency, 0.25)
    lopeOsc.start(t0)
    const lopeDepth = gain(0.3)
    const lopeAmp = gain(0.7) // base level; the LFO swings it up and down
    lopeOsc.connect(lopeDepth)
    lopeDepth.connect(lopeAmp.gain)
    motorMix.connect(lopeAmp)

    // Drive into a soft clipper: more input = more grit.
    const drive = gain(0.9)
    const shaper = node(ctx.createWaveShaper())
    shaper.curve = makeSoftClipCurve(2.2)
    shaper.oversample = '2x'
    const lp = filter('lowpass', 500, 1.2)
    this.shiftCut = gain(1)
    const motor = gain(0)
    lopeAmp.connect(drive)
    drive.connect(shaper)
    shaper.connect(lp)
    lp.connect(this.shiftCut)
    this.shiftCut.connect(motor)
    motor.connect(out)

    // ================= turbine whine =================
    const whineBus = src(ctx.createConstantSource())
    whineBus.offset.value = 300
    whineBus.start(t0)
    const whine = gain(0)
    const whineOctGain = gain(0)
    const vibrato = lfo(5.3)
    const vibDepth = gain(4) // Hz of wobble
    vibrato.connect(vibDepth)
    const whineOsc = (ratio: number, level: number, to: GainNode) => {
      const o = src(ctx.createOscillator())
      o.type = 'sine'
      o.frequency.value = 0
      const r = gain(ratio)
      whineBus.connect(r)
      r.connect(o.frequency)
      vibDepth.connect(o.frequency)
      const g = gain(level)
      o.connect(g)
      g.connect(to)
      o.start(t0)
    }
    whineOsc(1, 1, whine)
    whineOsc(1.5, 0.45, whine) //  a perfect fifth: makes it a synth chord, not a dentist drill
    whineOsc(2, 1, whineOctGain) // the extra octave that sings while boosting
    const whineHp = filter('highpass', 220, 0.7)
    whine.connect(whineHp)
    whineOctGain.connect(whineHp)
    whineHp.connect(out)

    // ================= noise layers =================
    // boost jet: a resonant band sweeping up with the boost
    const jetBp = filter('bandpass', 900, 1.4)
    const jet = gain(0)
    noiseLoop(0.11).connect(jetBp)
    jetBp.connect(jet)
    jet.connect(out)

    // wind: a broad band climbing with speed, wobbled slowly so it gusts
    const windBp = filter('bandpass', 400, 0.55)
    const windWobble = lfo(0.31)
    const windWobbleDepth = gain(90)
    windWobble.connect(windWobbleDepth)
    windWobbleDepth.connect(windBp.frequency)
    const wind = gain(0)
    noiseLoop(0.53).connect(windBp)
    windBp.connect(wind)
    wind.connect(out)

    // road: smooth, high, wet hiss
    const roadBp = filter('bandpass', 2600, 0.6)
    const road = gain(0)
    noiseLoop(0.97).connect(roadBp)
    roadBp.connect(road)
    road.connect(out)

    // terrain: low lumpy rumble (two slow sines make the bumps irregular)
    const rumbleLp = filter('lowpass', 170, 1.1)
    const rumbleAmp = gain(0.6)
    const bumpA = lfo(7.1)
    const bumpB = lfo(11.7)
    const bumpDepth = gain(0.35)
    bumpA.connect(bumpDepth)
    bumpB.connect(bumpDepth)
    bumpDepth.connect(rumbleAmp.gain)
    const crunchBp = filter('bandpass', 520, 1.3)
    const crunch = gain(0.35)
    const rumble = gain(0)
    const rumbleNoise = noiseLoop(1.37)
    rumbleNoise.connect(rumbleLp)
    rumbleNoise.connect(crunchBp)
    rumbleLp.connect(rumbleAmp)
    crunchBp.connect(crunch)
    crunch.connect(rumbleAmp)
    rumbleAmp.connect(rumble)
    rumble.connect(out)

    // tyre squeal: a narrow singing noise band plus a wobbling triangle
    const squealBp = filter('bandpass', 1200, 9)
    const squealNoise = gain(0)
    noiseLoop(1.71).connect(squealBp)
    squealBp.connect(squealNoise)
    const squealOsc = src(ctx.createOscillator())
    squealOsc.type = 'triangle'
    squealOsc.frequency.value = 1200
    const squealWobble = lfo(6.7)
    const squealWobbleDepth = gain(22)
    squealWobble.connect(squealWobbleDepth)
    squealWobbleDepth.connect(squealOsc.frequency)
    squealOsc.start(t0)
    const squealTone = gain(0)
    squealOsc.connect(squealTone)
    const squealHp = filter('highpass', 600, 0.7)
    squealNoise.connect(squealHp)
    squealTone.connect(squealHp)
    squealHp.connect(out)

    // ================= mag hum =================
    const magA = src(ctx.createOscillator())
    magA.type = 'sawtooth'
    magA.frequency.value = 55
    const magB = src(ctx.createOscillator())
    magB.type = 'square'
    magB.frequency.value = 110.6 // a hair off the octave: it beats, like mains hum through a big coil
    const magLp = filter('lowpass', 750, 2.5)
    const magTrem = gain(0.7)
    const tremLfo = lfo(12)
    const tremDepth = gain(0.3)
    tremLfo.connect(tremDepth)
    tremDepth.connect(magTrem.gain)
    const mag = gain(0)
    const magBLevel = gain(0.35)
    magA.connect(magLp)
    magB.connect(magBLevel)
    magBLevel.connect(magLp)
    magLp.connect(magTrem)
    magTrem.connect(mag)
    mag.connect(out)
    magA.start(t0)
    magB.start(t0)

    this.k = {
      hz: new Knob(freqBus.offset, 0.03, 0.15),
      cutoff: new Knob(lp.frequency, 0.05, 4),
      q: new Knob(lp.Q, 0.1, 0.02),
      drive: new Knob(drive.gain, 0.06, 0.005),
      octave: new Knob(octave.gain, 0.06, 0.001),
      lopeDepth: new Knob(lopeDepth.gain, 0.1, 0.005),
      motor: new Knob(motor.gain, 0.05, 0.001),
      whineHz: new Knob(whineBus.offset, 0.06, 1),
      whine: new Knob(whine.gain, 0.08, 0.0005),
      whineOct: new Knob(whineOctGain.gain, 0.08, 0.0005),
      jetHz: new Knob(jetBp.frequency, 0.08, 5),
      jet: new Knob(jet.gain, 0.06, 0.0005),
      windHz: new Knob(windBp.frequency, 0.15, 3),
      wind: new Knob(wind.gain, 0.12, 0.0005),
      road: new Knob(road.gain, 0.08, 0.0005),
      rumble: new Knob(rumble.gain, 0.06, 0.0005),
      squealHz: new Knob(squealBp.frequency, 0.08, 4),
      squealTone: new Knob(squealTone.gain, 0.05, 0.0003),
      squealNoise: new Knob(squealNoise.gain, 0.05, 0.0003),
      magHz: new Knob(magA.frequency, 0.2, 0.3),
      mag: new Knob(mag.gain, 0.1, 0.0005),
    }
    // the squeal tone follows the band (set in update via its own knob)
    this.squealOscFreq = new Knob(squealOsc.frequency, 0.08, 4)
    this.magBFreq = new Knob(magB.frequency, 0.2, 0.3)
  }

  private readonly squealOscFreq: Knob
  private readonly magBFreq: Knob

  /** Called once per rendered frame. Reads the input, moves the knobs. No allocation. */
  update(e: EngineInput, t: number): void {
    const r = this.readout
    const k = this.k
    const grounded = !e.airborne
    const speed = e.speedKmh < 0 ? -e.speedKmh : e.speedKmh
    const speedN = Math.min(speed / FULL_SPEED_KMH, 1.4) // boost can carry you past "full"
    const rpm = clamp01(e.rpm)
    const throttle = clamp01(e.throttle)

    // ---------- motor pitch: honest to rpm ----------
    // A real engine's note is proportional to its rpm. The 0.92 power leans
    // on the low end a touch so pulling away feels torquey.
    const hz = IDLE_HZ + (REDLINE_HZ - IDLE_HZ) * Math.pow(rpm, 0.92)
    k.hz.to(hz, t)

    // ---------- motor tone: the filter IS the throttle ----------
    // Closed = a soft burble, open = a snarl. The cutoff also tracks the note,
    // so the tone keeps its harmonics as the pitch climbs.
    const load = Math.max(throttle, rpm * 0.35)
    const cutoff = 240 + 2300 * load * load + hz * 2.2
    k.cutoff.to(cutoff, t)
    k.q.to(1 + 2.2 * throttle, t) // a little resonance on the gas = synth character
    k.drive.to(0.75 + 1.0 * load, t)
    k.octave.to(0.03 + 0.12 * load, t)
    k.lopeDepth.to(0.32 * (1 - smoothstep(0.05, 0.4, rpm)), t)

    // ---------- motor level: idle is quiet but never silent ----------
    const level = 0.1 + 0.2 * throttle + 0.11 * rpm + 0.04 * Math.min(speedN, 1)
    k.motor.to(level * MOTOR_GAIN, t)

    // ---------- gear shifts ----------
    if (e.gear !== this.lastGear) {
      if (grounded && e.gear > this.lastGear && e.gear > 1 && throttle > 0.2) this.shift(t, 0.3, 0.075)
      else if (grounded && e.gear < this.lastGear && e.gear >= 1) this.shift(t, 0.6, 0.05)
      this.lastGear = e.gear
    }

    // ---------- turbine whine: rises with speed, sings on boost ----------
    const whineHz = 260 + speed * 5.6
    k.whineHz.to(whineHz, t)
    k.whine.to(0.009 + 0.028 * smoothstep(0.02, 1, speedN) * (0.6 + 0.4 * throttle), t)
    k.whineOct.to(0.035 * e.boost, t)

    // ---------- boost jet ----------
    k.jetHz.to(700 + 2100 * e.boost, t)
    k.jet.to(0.13 * e.boost * e.boost, t)

    // ---------- wind: rises with the square of speed, a bit more in the air ----------
    const wind = 0.15 * speedN * speedN * (grounded ? 1 : 1.35)
    k.windHz.to(260 + 900 * Math.min(speedN, 1.3), t)
    k.wind.to(wind, t)

    // ---------- surface ----------
    const contact = grounded ? 1 : 0
    const roadLevel = e.offRoad ? 0 : contact * 0.04 * smoothstep(0, 140, speed)
    const rumbleLevel = e.offRoad ? contact * 0.2 * smoothstep(2, 90, speed) : 0
    k.road.to(roadLevel, t)
    k.rumble.to(rumbleLevel, t)

    // ---------- tyre squeal from slip ----------
    // Only on the ground and moving. A held drift sits lower and steadier.
    const slipAmt = grounded && speed > 12 ? smoothstep(0.18, 0.8, e.slip) * Math.min(1, speed / 45) : 0
    const squealHz = (e.drifting ? 950 : 1150) + 600 * e.slip
    k.squealHz.to(squealHz, t)
    this.squealOscFreq.to(squealHz, t)
    k.squealNoise.to(slipAmt * 0.07 * (e.offRoad ? 0.3 : 1), t)
    k.squealTone.to(slipAmt * 0.018 * (e.offRoad ? 0 : 1), t)

    // ---------- mag hum ----------
    const mag = clamp01(e.magStrength)
    k.magHz.to(52 + speed * 0.06, t)
    this.magBFreq.to(104.6 + speed * 0.12, t)
    k.mag.to(0.085 * mag, t)

    r.hz = hz
    r.cutoff = cutoff
    r.level = level
    r.whineHz = whineHz
    r.wind = wind
    r.road = roadLevel
    r.rumble = rumbleLevel
    r.squeal = slipAmt
    r.mag = mag
    r.boostJet = e.boost
  }

  /** Ignition cut on a gear change: the motor dips for a moment then comes back. */
  private shift(t: number, dipTo: number, holdS: number): void {
    const p = this.shiftCut.gain
    p.cancelScheduledValues(t)
    p.setValueAtTime(p.value, t)
    p.linearRampToValueAtTime(dipTo, t + 0.012)
    p.setValueAtTime(dipTo, t + holdS)
    p.linearRampToValueAtTime(1, t + holdS + 0.06)
    this.readout.shifts++
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
