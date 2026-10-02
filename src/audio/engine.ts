// ============================================================
//  ENGINE VOICE - the car you hear the whole time
// ------------------------------------------------------------
//  Built once when sound starts, then only nudged every frame.
//  No nodes are made per frame: every layer below exists from
//  the start and update() just moves its pitch, tone and volume.
//
//    THE MOTOR (follows telemetry.rpm, so it free-revs in the air
//    because the car's rpm does):
//      a string of thumps, one per cylinder firing, through exhaust
//      pipes and a muffler (motorDsp.ts, on the audio thread). Which
//      engine it is - V8, rally turbo, hover-jet - is the voicing
//      (engineVoicings.ts). On pages where the browser won't run an
//      AudioWorklet (a LAN guest on plain http) the same voicing is
//      built from ordinary nodes instead (motorNodes.ts).
//      → shift cut (dips on a gear change) → motor level → out
//
//    THE LAYERS AROUND IT:
//      turbo spool     a soft whoosh-tone that builds with boost and load
//      intake whoosh   air rushing in under load
//      blow-off        the "pssh" (or "stu-tu-tu") when you lift off a spooled turbo
//      jet turbine     the hover-jet's smooth tone, a fifth above the motor
//      boost jet       a rushing surge while a boost pad's kick lasts
//      wind            noise through a band that climbs with speed
//      road hiss       smooth wet-glass hiss on the road
//      terrain rumble  low, lumpy noise off-road
//      mag hum         a deep electric thrum while magnetic grip holds you
//      tyres           a broad, rough scrub of rubber that grows with slip,
//                      plus a short bark when grip breaks or catches
//
//  Everything high and thin was taken out on purpose: the old engine's
//  turbine whine (a thin sine at 1.6-2.5 kHz with a wobble) is what made
//  it sound like a mosquito, and the old tyre squeal (a narrow band and a
//  wobbling tone at 1-1.8 kHz) sounded like a whistle. Nothing here holds
//  a loud note above about 1.2 kHz; the bright sounds (blow-off, the tyre
//  bark) only come and go.
// ============================================================

import { Knob, clamp01, holdParam, smoothstep } from './synth'
import { firingHz } from './engineVoicings'
import type { EngineSoundId, EngineVoicing } from './engineVoicings'
import { createMotorNode } from './motorDsp'
import type { MotorLoad } from './motorDsp'
import { NodeMotor } from './motorNodes'

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

// ---------- levels (tuned by ear and by loudness meter) ----------

/** Overall motor loudness (each voicing's own `level` evens them out against each other). */
const MOTOR_GAIN = 0.42
/** Speed where the wind reaches full level (km/h). Boost goes past it. */
const FULL_SPEED_KMH = 260
/** How quickly the turbo builds (seconds) and lets go when you lift. */
const SPOOL_UP_S = 0.6
const SPOOL_DOWN_S = 0.3
/** Overrun pops keep coming for this long after you lift off (seconds). */
const CRACKLE_S = 1.6
/** Shortest gap between two blow-offs (seconds). */
const BLOWOFF_GAP_S = 0.8

/**
 * The tyres. All noise, never a note: a note up high is what made the old
 * squeal sound like a whistle. scrubHz and scrubQ are [small slide, full drift].
 */
const TYRE = {
  /** Loudness of the scrub (a wide band of noise) in a full slide. */
  scrub: 0.112,
  /** Loudness of the low "body" that joins in on a big, fast drift. */
  body: 0.12,
  /** Middle of the scrub's band, Hz. Lower = deeper. */
  scrubHz: [900, 600],
  /** How narrow the scrub's band is. Lower = wider. Kept under 1: a narrow band starts to sing. */
  scrubQ: [0.8, 0.5],
  /** How many times a second the tread grabs and lets go: crawling, and at 150 km/h. */
  grainHz: [60, 140],
  /** How much that grabbing shakes the volume (0 = a smooth hiss, 1 = chopped up). */
  roughness: 0.85,
  /** The bark when grip breaks (the catch is quieter): loudness, and the Hz its pitch falls from and to. */
  bark: 0.11,
  barkHz: [850, 500],
  /** Shortest gap between two barks (seconds). */
  barkGapS: 0.5,
} as const

/** Where the motor is running: on the audio thread, built from nodes, or still loading. */
export type MotorKind = 'loading' | 'worklet' | 'nodes'

export interface EngineReadout {
  voicing: EngineSoundId
  /** Firing note, Hz (thumps per second). */
  hz: number
  level: number
  spool: number
  crackle: number
  jetHz: number
  wind: number
  road: number
  rumble: number
  /** How hard the tyres are scrubbing, 0..1. */
  tyres: number
  mag: number
  boostJet: number
  shifts: number
  blowOffs: number
  /** Tyre barks so far (grip breaking or catching). */
  tyreBarks: number
}

/** A fixed seed per voicing, so a render of the same drive always sounds the same. */
const MOTOR_SEED: Record<EngineSoundId, number> = { muscle: 0x5eed01, rally: 0x5eed02, hover: 0x5eed03 }

export class EngineVoice {
  readonly readout: EngineReadout
  /** Where the motor runs (inspector). */
  motorKind: MotorKind = 'loading'
  /** Why it runs there ('worklet', 'no-audioworklet', or the load error). */
  motorReason = ''

  private voicing: EngineVoicing
  private readonly sources: AudioScheduledSourceNode[] = []
  private readonly nodes: AudioNode[] = []
  /** The motor (whichever kind) plugs in here. */
  private readonly motorBus: GainNode
  private readonly shiftCut: GainNode
  private worklet: AudioWorkletNode | null = null
  private workletKnobs: { fireHz: Knob; throttle: Knob; crackle: Knob; cut: AudioParam } | null = null
  private nodeMotor: NodeMotor | null = null
  private disposed = false

  private lastGear = 1
  private lastT = -1
  private spool = 0
  /** The highest throttle in the last moment (falls off quickly): a lift is a drop from a high one. */
  private recentThrottle = 0
  private lifted = true
  private liftAt = -100
  private lastBlowOff = -100
  private readonly blowGain: GainNode
  private readonly blowBand: BiquadFilterNode
  /** The tyres: are they sliding, the biggest slide since grip broke, the last bark. */
  private sliding = false
  private slidePeak = 0
  private lastBark = -100
  private readonly barkGain: GainNode
  private readonly barkBand: BiquadFilterNode

  // knobs moved every frame
  private readonly k: {
    motor: Knob
    spoolHz: Knob
    spool: Knob
    whooshHz: Knob
    whoosh: Knob
    jetHz: Knob
    jet: Knob
    boostHz: Knob
    boost: Knob
    windHz: Knob
    wind: Knob
    road: Knob
    rumble: Knob
    scrubHz: Knob
    scrubQ: Knob
    scrub: Knob
    body: Knob
    grain: Knob
    magHz: Knob
    magBHz: Knob
    mag: Knob
  }

  constructor(
    private readonly ctx: BaseAudioContext,
    out: AudioNode,
    private readonly noise: AudioBuffer,
    voicing: EngineVoicing,
  ) {
    this.voicing = voicing
    this.readout = {
      voicing: voicing.id,
      hz: 0,
      level: 0,
      spool: 0,
      crackle: 0,
      jetHz: 0,
      wind: 0,
      road: 0,
      rumble: 0,
      tyres: 0,
      mag: 0,
      boostJet: 0,
      shifts: 0,
      blowOffs: 0,
      tyreBarks: 0,
    }
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

    // ================= the motor slot =================
    // The motor itself arrives in attachMotor(), once the browser has said whether
    // the audio-thread version can load. Until then this is silent (a few ms).
    this.motorBus = gain(1)
    this.shiftCut = gain(1)
    const motor = gain(0)
    this.motorBus.connect(this.shiftCut)
    this.shiftCut.connect(motor)
    motor.connect(out)

    // ================= turbo spool: a low whoosh-tone, never a whistle =================
    const spoolBand = filter('bandpass', 400, 5)
    const spool = gain(0)
    noiseLoop(0.19).connect(spoolBand)
    spoolBand.connect(spool)
    spool.connect(out)

    // ================= intake whoosh: air rushing in under load =================
    const whooshLp = filter('lowpass', 400, 0.8)
    const whoosh = gain(0)
    noiseLoop(0.41).connect(whooshLp)
    whooshLp.connect(whoosh)
    whoosh.connect(out)

    // ================= blow-off: silent until you lift off a spooled turbo =================
    this.blowBand = filter('bandpass', 1100, 1.3)
    this.blowGain = gain(0)
    noiseLoop(0.67).connect(this.blowBand)
    this.blowBand.connect(this.blowGain)
    this.blowGain.connect(out)

    // ================= jet turbine (hover): two soft tones, a hair apart, so they shimmer slowly =================
    const jetBus = src(ctx.createConstantSource())
    jetBus.offset.value = 200
    jetBus.start(t0)
    const jetLp = filter('lowpass', 900, 0.5)
    const jet = gain(0)
    for (const ratio of [1, 1.0015]) {
      const o = src(ctx.createOscillator())
      o.type = 'triangle'
      o.frequency.value = 0
      const r = gain(ratio)
      jetBus.connect(r)
      r.connect(o.frequency)
      o.connect(jetLp)
      o.start(t0)
    }
    jetLp.connect(jet)
    jet.connect(out)

    // ================= boost jet: a rushing surge while a boost pad's kick lasts =================
    const boostBand = filter('bandpass', 600, 1.2)
    const boost = gain(0)
    noiseLoop(0.11).connect(boostBand)
    boostBand.connect(boost)
    boost.connect(out)

    // ================= wind: a broad band climbing with speed, wobbled slowly so it gusts =================
    const windBp = filter('bandpass', 400, 0.55)
    const windWobble = lfo(0.31)
    const windWobbleDepth = gain(90)
    windWobble.connect(windWobbleDepth)
    windWobbleDepth.connect(windBp.frequency)
    // A soft top filter after the band, so fast driving sounds like rushing air, not hiss.
    const windTop = filter('lowpass', 1400, 0.7)
    const wind = gain(0)
    noiseLoop(0.53).connect(windBp)
    windBp.connect(windTop)
    windTop.connect(wind)
    wind.connect(out)

    // ================= road: smooth, wet hiss =================
    // Centred at 2 kHz (it was 2.6): still the hiss of wet glass, a little less fizz.
    const roadBp = filter('bandpass', 2000, 0.6)
    const road = gain(0)
    noiseLoop(0.97).connect(roadBp)
    roadBp.connect(road)
    road.connect(out)

    // ================= terrain: low lumpy rumble (two slow sines make the bumps irregular) =================
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

    // ================= tyres: rubber scrubbing sideways across a wet road =================
    // Noise only, never a note. A wide band (the scrub) and a low band (the body of a
    // big drift) are both made rough by a fast, random shake in their volume: the tread
    // grabbing the road and letting go, many times a second. That roughness is what
    // makes it sound like rubber instead of wind.
    const tyreNoise = noiseLoop(1.71)
    const scrubBp = filter('bandpass', TYRE.scrubHz[0], TYRE.scrubQ[0])
    // A soft top at 2 kHz (Q -3 means no bump at the corner): rubber, not hiss.
    const scrubLp = filter('lowpass', 2000, -3)
    const scrub = gain(0)
    tyreNoise.connect(scrubBp)
    scrubBp.connect(scrubLp)
    scrubLp.connect(scrub)
    const bodyLp = filter('lowpass', 360, 0.7)
    const body = gain(0)
    tyreNoise.connect(bodyLp)
    bodyLp.connect(body)
    // The shake: white noise played back very slowly turns into a random wobble
    // (a new random value grainHz times a second), and the wobble moves the volume.
    const grain = src(ctx.createBufferSource())
    grain.buffer = noise
    grain.loop = true
    grain.playbackRate.value = TYRE.grainHz[0] / noise.sampleRate
    grain.start(t0, 0.29)
    const rough = gain(1)
    const roughDepth = gain(TYRE.roughness)
    grain.connect(roughDepth)
    roughDepth.connect(rough.gain)
    scrub.connect(rough)
    body.connect(rough)
    const tyreHp = filter('highpass', 90, 0.7)
    rough.connect(tyreHp)
    tyreHp.connect(out)
    // The bark: silent until grip breaks (or catches), then a short "khh" falling in pitch.
    // (A soft top at 1.6 kHz keeps the fizz of the band's edges out of it.)
    this.barkBand = filter('bandpass', TYRE.barkHz[0], 1.8)
    const barkTop = filter('lowpass', 1600, -3)
    this.barkGain = gain(0)
    noiseLoop(0.83).connect(this.barkBand)
    this.barkBand.connect(barkTop)
    barkTop.connect(this.barkGain)
    this.barkGain.connect(out)

    // ================= mag hum: a deep, round electric thrum =================
    // Soft wave shapes (a triangle and a sine) under a gentle filter: a hum you feel,
    // not the buzz of a cheap speaker.
    const magA = src(ctx.createOscillator())
    magA.type = 'triangle'
    magA.frequency.value = 55
    const magB = src(ctx.createOscillator())
    magB.type = 'sine'
    magB.frequency.value = 110.6 // a hair off the octave: it beats slowly, like a big coil
    const magLp = filter('lowpass', 420, 0.8)
    const magTrem = gain(0.8)
    const tremLfo = lfo(7)
    const tremDepth = gain(0.2)
    tremLfo.connect(tremDepth)
    tremDepth.connect(magTrem.gain)
    const mag = gain(0)
    const magBLevel = gain(0.5)
    magA.connect(magLp)
    magB.connect(magBLevel)
    magBLevel.connect(magLp)
    magLp.connect(magTrem)
    magTrem.connect(mag)
    mag.connect(out)
    magA.start(t0)
    magB.start(t0)

    this.k = {
      motor: new Knob(motor.gain, 0.05, 0.001),
      spoolHz: new Knob(spoolBand.frequency, 0.08, 3),
      spool: new Knob(spool.gain, 0.06, 0.0003),
      whooshHz: new Knob(whooshLp.frequency, 0.08, 4),
      whoosh: new Knob(whoosh.gain, 0.06, 0.0003),
      jetHz: new Knob(jetBus.offset, 0.25, 0.5), // slow on purpose: a turbine lags the motor
      jet: new Knob(jet.gain, 0.08, 0.0003),
      boostHz: new Knob(boostBand.frequency, 0.08, 5),
      boost: new Knob(boost.gain, 0.06, 0.0005),
      windHz: new Knob(windBp.frequency, 0.15, 3),
      wind: new Knob(wind.gain, 0.12, 0.0005),
      road: new Knob(road.gain, 0.08, 0.0005),
      rumble: new Knob(rumble.gain, 0.06, 0.0005),
      scrubHz: new Knob(scrubBp.frequency, 0.1, 4),
      scrubQ: new Knob(scrubBp.Q, 0.1, 0.01),
      scrub: new Knob(scrub.gain, 0.06, 0.0003),
      body: new Knob(body.gain, 0.08, 0.0003),
      grain: new Knob(grain.playbackRate, 0.2, 0.5 / noise.sampleRate),
      magHz: new Knob(magA.frequency, 0.2, 0.3),
      magBHz: new Knob(magB.frequency, 0.2, 0.3),
      mag: new Knob(mag.gain, 0.1, 0.0005),
    }
  }

  /** Which voicing is playing. */
  get voicingId(): EngineSoundId {
    return this.voicing.id
  }

  /**
   * Plug the motor in, once loadMotorWorklet() has answered: the audio-thread
   * motor if it loaded, otherwise the node motor. Called once.
   */
  attachMotor(load: MotorLoad): void {
    if (this.disposed || this.motorKind !== 'loading') return
    this.motorReason = load.reason
    if (load.ok) {
      try {
        const w = createMotorNode(this.ctx, this.voicing.motor, MOTOR_SEED[this.voicing.id])
        const p = (name: string): AudioParam => {
          const param = w.parameters.get(name)
          if (!param) throw new Error(`motor has no "${name}" dial`)
          return param
        }
        this.workletKnobs = {
          fireHz: new Knob(p('fireHz'), 0.03, 0.1),
          throttle: new Knob(p('throttle'), 0.05, 0.005),
          crackle: new Knob(p('crackle'), 0.05, 0.005),
          cut: p('cut'),
        }
        w.connect(this.motorBus)
        this.worklet = w
        this.motorKind = 'worklet'
        return
      } catch (err) {
        this.motorReason = String(err)
      }
    }
    this.nodeMotor = new NodeMotor(this.ctx, this.motorBus, this.voicing.motor, this.noise)
    this.motorKind = 'nodes'
  }

  /** Swap to another voicing while running (a smooth fade on the audio thread, no click). */
  setVoicing(v: EngineVoicing): void {
    if (v.id === this.voicing.id) return
    this.voicing = v
    this.readout.voicing = v.id
    if (this.worklet) this.worklet.port.postMessage({ motor: v.motor })
    if (this.nodeMotor) this.nodeMotor.setVoicing(v.motor)
  }

  /** Called once per rendered frame. Reads the input, moves the knobs. No allocation. */
  update(e: EngineInput, t: number): void {
    const r = this.readout
    const k = this.k
    const v = this.voicing
    const L = v.layers
    const dt = this.lastT >= 0 ? Math.min(0.1, Math.max(0, t - this.lastT)) : 0
    this.lastT = t
    const grounded = !e.airborne
    const speed = e.speedKmh < 0 ? -e.speedKmh : e.speedKmh
    const speedN = Math.min(speed / FULL_SPEED_KMH, 1.4) // boost can carry you past "full"
    const rpm = clamp01(e.rpm)
    const throttle = clamp01(e.throttle)
    const boostNow = clamp01(e.boost)

    // ---------- lift-off: a quick drop from a high throttle ----------
    this.recentThrottle = Math.max(throttle, this.recentThrottle - dt * 2.5)
    let liftNow = false
    if (throttle > 0.45) this.lifted = false
    else if (!this.lifted && throttle < 0.25 && this.recentThrottle > 0.55) {
      this.lifted = true
      this.liftAt = t
      liftNow = true
    }

    // ---------- the motor: pitch honest to rpm, tone from the throttle ----------
    const hz = firingHz(v.motor, rpm)
    const sinceLift = t - this.liftAt
    const crackle =
      v.motor.crackle > 0 && this.lifted ? (1 - throttle) * smoothstep(0.45, 0.85, rpm) * clamp01(1 - sinceLift / CRACKLE_S) : 0
    const wk = this.workletKnobs
    if (wk) {
      wk.fireHz.to(hz, t)
      wk.throttle.to(throttle, t)
      wk.crackle.to(crackle, t)
    } else if (this.nodeMotor) {
      this.nodeMotor.update(hz, throttle, t)
    }

    // ---------- motor level: idle is quiet but never silent, full throttle is big ----------
    const level = 0.035 + 0.25 * throttle + 0.125 * rpm + 0.04 * Math.min(speedN, 1)
    k.motor.to(level * MOTOR_GAIN, t)

    // ---------- gear shifts ----------
    if (e.gear !== this.lastGear) {
      if (grounded && e.gear > this.lastGear && e.gear > 1 && throttle > 0.2) this.shift(t, 0.45, 0.075, 0.85)
      else if (grounded && e.gear < this.lastGear && e.gear >= 1) this.shift(t, 0.7, 0.05, 0.4)
      this.lastGear = e.gear
    }

    // ---------- turbo: builds with load (and boost pads), lets go when you lift ----------
    const spoolTarget = Math.max(throttle * smoothstep(0.3, 0.85, rpm), boostNow)
    const tau = spoolTarget > this.spool ? SPOOL_UP_S : SPOOL_DOWN_S
    if (dt > 0) this.spool += (spoolTarget - this.spool) * (1 - Math.exp(-dt / tau))
    if (liftNow && L.blowOff > 0 && this.spool > 0.45 && t - this.lastBlowOff > BLOWOFF_GAP_S) {
      this.blowOff(t, this.spool)
      this.spool *= 0.35 // the valve dumps the pressure
    }
    const sp = this.spool
    k.spoolHz.to(L.spoolHz[0] + (L.spoolHz[1] - L.spoolHz[0]) * sp, t)
    // (Filtered noise is far quieter than a tone at the same gain: a narrow band of it
    // keeps only a sliver of the noise, hence the big numbers.)
    k.spool.to(1.1 * L.spool * sp * sp * (0.4 + 0.6 * throttle), t)
    k.whooshHz.to(280 + 650 * sp + 250 * throttle, t)
    k.whoosh.to(0.5 * L.whoosh * (0.3 * throttle + 0.7 * sp) * (0.35 + 0.65 * rpm), t)

    // ---------- jet turbine (hover): a fifth above the motor, lagging behind it ----------
    const jetHz = hz * L.jetRatio
    k.jetHz.to(jetHz, t)
    k.jet.to(0.045 * L.jet * (0.45 + 0.55 * throttle) * (0.3 + 0.7 * rpm), t)

    // ---------- boost pad surge ----------
    k.boostHz.to(600 + 1000 * boostNow, t)
    k.boost.to(0.14 * boostNow * boostNow, t)

    // ---------- wind: rises with the square of speed, a bit more in the air ----------
    // The band stays low (about 670 Hz at 190 km/h): a rush of air, not a hiss.
    const wind = 0.15 * speedN * speedN * (grounded ? 1 : 1.35)
    k.windHz.to(220 + 620 * Math.min(speedN, 1.3), t)
    k.wind.to(wind, t)

    // ---------- surface ----------
    const contact = grounded ? 1 : 0
    const roadLevel = e.offRoad ? 0 : contact * 0.032 * smoothstep(0, 140, speed)
    const rumbleLevel = e.offRoad ? contact * 0.2 * smoothstep(2, 90, speed) : 0
    k.road.to(roadLevel, t)
    k.rumble.to(rumbleLevel, t)

    // ---------- tyres: a rough scrub from slip, never a whistle ----------
    // Only on the ground and moving. A bigger slide is louder, and a drift (the back
    // stepping out) also gets deeper and wider; a small slide or the front tyres
    // pushing wide is a lighter scrub. Quieter on grass and dirt.
    const slipAmt = grounded && speed > 12 ? smoothstep(0.18, 0.8, e.slip) * Math.min(1, speed / 45) : 0
    const depth = e.drifting ? slipAmt : 0.3 * slipAmt
    const fast = smoothstep(30, 130, speed)
    const surface = (e.offRoad ? 0.3 : 1) * L.tyres
    k.scrubHz.to(TYRE.scrubHz[0] + (TYRE.scrubHz[1] - TYRE.scrubHz[0]) * depth, t)
    k.scrubQ.to(TYRE.scrubQ[0] + (TYRE.scrubQ[1] - TYRE.scrubQ[0]) * depth, t)
    k.scrub.to(TYRE.scrub * slipAmt * (0.8 + 0.2 * fast) * surface, t)
    k.body.to(TYRE.body * depth * depth * (0.35 + 0.65 * fast) * surface, t)
    k.grain.to((TYRE.grainHz[0] + (TYRE.grainHz[1] - TYRE.grainHz[0]) * Math.min(speed / 150, 1)) / this.noise.sampleRate, t)
    this.watchGrip(t, slipAmt, speed, grounded && !e.offRoad)

    // ---------- mag hum ----------
    const mag = clamp01(e.magStrength)
    k.magHz.to(52 + speed * 0.06, t)
    k.magBHz.to(104.6 + speed * 0.12, t)
    k.mag.to(0.09 * mag, t)

    r.hz = hz
    r.level = level
    r.spool = sp
    r.crackle = crackle
    r.jetHz = L.jet > 0 ? jetHz : 0
    r.wind = wind
    r.road = roadLevel
    r.rumble = rumbleLevel
    r.tyres = slipAmt
    r.mag = mag
    r.boostJet = boostNow
  }

  /**
   * Ignition cut on a gear change: the motor dips for a moment then comes back.
   * On the audio-thread motor most firings in that moment are skipped too,
   * which is the "brap" of a real gear change.
   */
  private shift(t: number, dipTo: number, holdS: number, cut: number): void {
    const p = this.shiftCut.gain
    p.cancelScheduledValues(t)
    p.setValueAtTime(p.value, t)
    p.linearRampToValueAtTime(dipTo, t + 0.012)
    p.setValueAtTime(dipTo, t + holdS)
    p.linearRampToValueAtTime(1, t + holdS + 0.06)
    const c = this.workletKnobs?.cut
    if (c) {
      c.cancelScheduledValues(t)
      c.setValueAtTime(cut, t)
      c.setValueAtTime(0, t + holdS)
    }
    this.readout.shifts++
  }

  /** The blow-off valve: a short hiss as you lift, or a stutter ("stu-tu-tu") on a flutter valve. */
  private blowOff(t: number, amount: number): void {
    const L = this.voicing.layers
    const g = this.blowGain.gain
    const f = this.blowBand.frequency
    const peak = 0.7 * L.blowOff * amount
    holdParam(g, t)
    holdParam(f, t)
    f.setValueAtTime(1300, t)
    f.exponentialRampToValueAtTime(520, t + 0.45)
    if (L.flutter) {
      for (let i = 0; i < 4; i++) {
        const at = t + 0.02 + i * 0.065
        const pk = peak * (1 - i * 0.2)
        g.setTargetAtTime(pk, at, 0.006)
        g.setTargetAtTime(pk * 0.15, at + 0.03, 0.012)
      }
      g.setTargetAtTime(0, t + 0.3, 0.06)
    } else {
      g.setTargetAtTime(peak, t, 0.01)
      g.setTargetAtTime(0, t + 0.05, 0.12)
    }
    this.lastBlowOff = t
    this.readout.blowOffs++
  }

  /**
   * Grip breaking and catching. Hysteresis (a slide starts above 0.45 and ends below
   * 0.15) stops a wobbling slip from barking again and again. barkable is false in
   * the air (the slide "ending" on take-off is not grip coming back) and off-road.
   */
  private watchGrip(t: number, amt: number, speed: number, barkable: boolean): void {
    const canBark = barkable && speed > 25 && t - this.lastBark > TYRE.barkGapS
    const strength = Math.min(1, speed / 70)
    if (!this.sliding) {
      if (amt > 0.45) {
        this.sliding = true
        this.slidePeak = amt
        if (canBark) this.bark(t, strength)
      }
    } else {
      if (amt > this.slidePeak) this.slidePeak = amt
      if (amt < 0.15) {
        this.sliding = false
        if (canBark && this.slidePeak > 0.7) this.bark(t, 0.55 * strength)
      }
    }
  }

  /** A short, low "khh" from the tyres, its pitch falling. Not a note: filtered noise. */
  private bark(t: number, amount: number): void {
    const g = this.barkGain.gain
    const f = this.barkBand.frequency
    holdParam(g, t)
    holdParam(f, t)
    f.setValueAtTime(TYRE.barkHz[0], t)
    f.exponentialRampToValueAtTime(TYRE.barkHz[1], t + 0.14)
    g.setTargetAtTime(TYRE.bark * this.voicing.layers.tyres * amount, t, 0.006)
    g.setTargetAtTime(0, t + 0.03, 0.045)
    this.lastBark = t
    this.readout.tyreBarks++
  }

  dispose(): void {
    this.disposed = true
    if (this.worklet) {
      this.worklet.port.postMessage({ stop: true })
      this.worklet.disconnect()
      this.worklet = null
    }
    this.nodeMotor?.dispose()
    this.nodeMotor = null
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
