// ============================================================
//  THE MOTOR - a real engine's sound, built one thump at a time
// ------------------------------------------------------------
//  A real engine does not hum like a synth. Each time a cylinder
//  fires, a blast of hot gas punches into the exhaust pipe: THUMP.
//  Thousands of thumps a minute, through pipes and a muffler, is
//  the growl you hear. So that is exactly what this code builds:
//
//    1. FIRING   a clock turns the crank. Each time a cylinder's
//                turn comes, it fires a thump (a sharp hit that dies
//                away), a little early or late and a little harder or
//                softer each time, because no engine is perfect.
//    2. PIPES    each thump rings down an exhaust pipe (a delay line
//                that echoes back on itself). A V8 has two pipes, one
//                per bank of cylinders: that is where its burble lives.
//    3. GROWL    push hard on the throttle and the sound gets squashed
//                into gentle distortion, like a straining exhaust.
//    4. MUFFLER  hollow box resonances that never move with the revs,
//                then a soft filter that takes the fizz off the top.
//
//  It runs on the AUDIO THREAD as an AudioWorklet, so it never costs
//  the game a frame. The whole of motorModule() below is turned into
//  text and loaded from a Blob URL (no file is fetched), so it must
//  not use anything from outside itself except built-ins like Math.
//  The same text runs in the offline renderer, so a render of the
//  engine sounds exactly like the game.
//
//  The car (engine.ts) moves four dials on it every frame:
//    fireHz    how many thumps per second (from the rpm)
//    throttle  0..1: how hard each thump hits and how open the muffler is
//    cut       0..1: chance a firing is skipped (the gear-change "brap")
//    crackle   0..1: chance of an overrun pop (lifting off at high revs)
// ============================================================

import type { MotorSpec } from './engineVoicings'

/** The name the motor registers under on the audio thread. */
export const MOTOR_PROCESSOR = 'sr2-motor'

/** What the motor looks like from outside (the offline tests and the worklet both use it). */
export interface MotorDsp {
  /** Fill `out` with `n` samples of engine sound. */
  process(out: Float32Array, n: number, fireHz: number, throttle: number, cut: number, crackle: number): void
  /** Change voicing now (resets the pipes; only safe before sound starts). */
  setVoicing(m: MotorSpec): void
  /** Change voicing smoothly: fade out, swap, fade back in. */
  queueVoicing(m: MotorSpec): void
}

export type MotorDspClass = new (sampleRate: number, motor: MotorSpec, seed: number) => MotorDsp

/**
 * The motor, as one self-contained function. Called on the audio thread it
 * also registers the AudioWorklet processor; called anywhere else it just
 * hands back the class (used to test the motor without a browser).
 */
export function motorModule(processorName: string): MotorDspClass {
  /** Delay-line length per pipe (a power of two, so wrapping is a cheap bit-mask). */
  const DELAY = 4096
  const MASK = DELAY - 1
  /** Most firing slots any voicing can have (a V16 would fit). */
  const MAX_SLOTS = 16
  const TWO_PI = Math.PI * 2
  /** Brings the raw exhaust up to a healthy level before the final soft limit. */
  const MAKEUP = 7
  /**
   * The tailpipe's soft limit: loud peaks are rounded off smoothly (a thump train is
   * very peaky, and the mixer's limiter would otherwise duck the whole game on every one).
   */
  const SOFT_LIMIT = 2.2
  const INV_SOFT_LIMIT = 1 / SOFT_LIMIT

  class Motor implements MotorDsp {
    private readonly sr: number
    // ---- the voicing, unpacked into flat arrays ----
    private slots = 0
    private readonly gap = new Float32Array(MAX_SLOTS) //      cycles from this firing to the next
    private readonly pipeOf = new Uint8Array(MAX_SLOTS)
    private readonly punch = new Float32Array(MAX_SLOTS)
    private readonly lopePunch = new Float32Array(MAX_SLOTS) // fixed extra unevenness at idle
    private readonly lopeTime = new Float32Array(MAX_SLOTS)
    private idleFire = 50
    private redFire = 400
    private timingJitter = 0
    private punchJitter = 0
    private lope = 0
    private thumpLength = 0.2
    private attackCoef = 0
    private grit = 0
    private readonly pipeDelay = new Int32Array(2)
    private readonly pipeLevel = new Float32Array(2)
    private ring = 0
    private dampCoef = 0
    private readonly fB0 = new Float32Array(3)
    private readonly fA1 = new Float32Array(3)
    private readonly fA2 = new Float32Array(3)
    private readonly fLevel = new Float32Array(3)
    private direct = 1
    private mufflerHz = 600
    private mufflerOpenHz = 400
    private drive = 1
    private crackle = 0
    private level = 1
    // ---- running state ----
    private rng: number
    private wait = 0
    private slot = 0
    private readonly hit = new Float64Array(2) //    thump: slow-decaying part, per pipe
    private readonly edge = new Float64Array(2) //   thump: fast part (subtracted, makes the sharp front)
    private readonly pop = new Float64Array(2) //    overrun pop, per pipe
    private readonly popEdge = new Float64Array(2)
    private readonly delay0 = new Float32Array(DELAY)
    private readonly delay1 = new Float32Array(DELAY)
    private readonly pipeLp = new Float64Array(2)
    private w = 0
    private readonly fz1 = new Float64Array(3)
    private readonly fz2 = new Float64Array(3)
    private readonly mz = new Float64Array(4) //     muffler filter memory (two stages)
    private readonly mc = new Float64Array(10) //    muffler coefficients (two stages x b0 b1 b2 a1 a2)
    private mufflerAt = -1
    private readonly hz = new Float64Array(2) //    sub-rumble filter memory
    private readonly hc = new Float64Array(5) //    sub-rumble filter coefficients
    // ---- smooth voicing swaps ----
    private fade = 1
    private fadeTarget = 1
    private readonly fadeCoef: number
    private pending: MotorSpec | null = null

    constructor(sampleRate: number, motor: MotorSpec, seed: number) {
      this.sr = sampleRate
      this.rng = (seed | 0) || 0x2545f491
      // A gentle high-pass at 30 Hz: below that is pressure you can't hear, only a speaker
      // pumping, and it would eat the headroom the real growl needs.
      {
        const w0 = (TWO_PI * 30) / sampleRate
        const cos = Math.cos(w0)
        const alpha = Math.sin(w0) / (2 * 0.7071)
        const a0 = 1 + alpha
        this.hc[0] = (1 + cos) / 2 / a0
        this.hc[1] = -(1 + cos) / a0
        this.hc[2] = (1 + cos) / 2 / a0
        this.hc[3] = (-2 * cos) / a0
        this.hc[4] = (1 - alpha) / a0
      }
      this.fadeCoef = 1 - Math.exp(-1 / (0.012 * sampleRate))
      this.setVoicing(motor)
    }

    /** A random number 0..1 (xorshift: fast, and the same every run for the same seed). */
    private rand(): number {
      let r = this.rng
      r ^= r << 13
      r ^= r >>> 17
      r ^= r << 5
      this.rng = r
      return (r >>> 0) / 4294967296
    }

    setVoicing(m: MotorSpec): void {
      const sr = this.sr
      const n = Math.max(1, Math.min(MAX_SLOTS, m.cylinders | 0, m.fireAt.length))
      this.slots = n
      for (let i = 0; i < n; i++) {
        const here = m.fireAt[i]
        const next = i + 1 < n ? m.fireAt[i + 1] : m.fireAt[0] + 1
        this.gap[i] = Math.max(0.001, next - here)
        this.pipeOf[i] = m.pipeOf[i] === 1 ? 1 : 0
        this.punch[i] = m.punch[i] ?? 1
        // The lope is a fixed per-cylinder fingerprint (from the seed), not new randomness each time.
        this.lopePunch[i] = this.rand() * 2 - 1
        this.lopeTime[i] = (this.rand() * 2 - 1) * 0.06
      }
      this.idleFire = (m.idleRpm / 120) * m.cylinders
      this.redFire = Math.max(this.idleFire + 1, (m.redlineRpm / 120) * m.cylinders)
      this.timingJitter = m.timingJitter
      this.punchJitter = m.punchJitter
      this.lope = m.lope
      this.thumpLength = m.thumpLength
      this.attackCoef = Math.exp(-1 / (Math.max(0.05, m.attackMs) * 0.001 * sr))
      this.grit = m.grit
      for (let p = 0; p < 2; p++) {
        const hz = m.pipeHz[p] ?? m.pipeHz[0] ?? 50
        this.pipeDelay[p] = Math.max(2, Math.min(MASK, Math.round(sr / (2 * hz))))
        this.pipeLevel[p] = m.pipeLevel[p] ?? 0
      }
      this.ring = -Math.max(0, Math.min(0.9, m.pipeRing)) // an open pipe end reflects upside down
      this.dampCoef = 1 - Math.exp((-TWO_PI * 2400) / sr) // the pipe swallows its own highs
      for (let i = 0; i < 3; i++) {
        const f = m.formants[i]
        if (!f) {
          this.fLevel[i] = 0
          continue
        }
        // Band-pass (peak gain 1): b1 is zero and b2 = -b0, so only three numbers are needed.
        const w0 = (TWO_PI * Math.min(f.hz, sr * 0.45)) / sr
        const alpha = Math.sin(w0) / (2 * Math.max(0.1, f.q))
        const a0 = 1 + alpha
        this.fB0[i] = alpha / a0
        this.fA1[i] = (-2 * Math.cos(w0)) / a0
        this.fA2[i] = (1 - alpha) / a0
        this.fLevel[i] = f.level
      }
      this.direct = m.direct
      this.mufflerHz = m.mufflerHz
      this.mufflerOpenHz = m.mufflerOpenHz
      this.drive = Math.max(1, m.drive)
      this.crackle = m.crackle
      this.level = m.level
      this.mufflerAt = -1
      // Start clean: empty pipes, no thumps in flight.
      this.hit.fill(0)
      this.edge.fill(0)
      this.pop.fill(0)
      this.popEdge.fill(0)
      this.delay0.fill(0)
      this.delay1.fill(0)
      this.pipeLp.fill(0)
      this.fz1.fill(0)
      this.fz2.fill(0)
      this.mz.fill(0)
      this.hz.fill(0)
      this.slot = 0
      this.wait = 0
    }

    queueVoicing(m: MotorSpec): void {
      this.pending = m
      this.fadeTarget = 0
    }

    /** Two-stage low-pass (a smooth 24 dB per octave slope) at `hz`. */
    private setMuffler(hz: number): void {
      const c = this.mc
      const w0 = (TWO_PI * Math.min(hz, this.sr * 0.45)) / this.sr
      const cos = Math.cos(w0)
      const sin = Math.sin(w0)
      // Two Q values that together make a Butterworth (flat, no bump) four-pole filter.
      for (let s = 0; s < 2; s++) {
        const q = s === 0 ? 0.5412 : 1.3066
        const alpha = sin / (2 * q)
        const a0 = 1 + alpha
        const b1 = (1 - cos) / a0
        c[s * 5] = b1 / 2
        c[s * 5 + 1] = b1
        c[s * 5 + 2] = b1 / 2
        c[s * 5 + 3] = (-2 * cos) / a0
        c[s * 5 + 4] = (1 - alpha) / a0
      }
      this.mufflerAt = hz
    }

    process(out: Float32Array, n: number, fireHzIn: number, throttleIn: number, cutIn: number, crackleIn: number): void {
      // Never trust a number from outside: a NaN would poison every filter for good.
      const fireHz = fireHzIn > 4 ? (fireHzIn < 2000 ? fireHzIn : 2000) : 4
      const throttle = throttleIn > 0 ? (throttleIn < 1 ? throttleIn : 1) : 0
      const cut = cutIn > 0 ? (cutIn < 1 ? cutIn : 1) : 0
      const crackleAsk = crackleIn > 0 ? (crackleIn < 1 ? crackleIn : 1) : 0
      const sr = this.sr

      // ---- per block (every 128 samples): work out this block's settings ----
      const inc = fireHz / this.slots / sr // engine cycles per sample
      const revs = Math.min(1, Math.max(0, (fireHz - this.idleFire) / (this.redFire - this.idleFire)))
      const lopeNow = this.lope * (1 - Math.min(1, revs / 0.35)) // lumpy at idle, smooth when revving
      // A thump rings for a share of the gap to the next one; a hard-working engine hits sharper.
      const tau = Math.max(0.0005, (this.thumpLength / fireHz) * (1 - 0.3 * throttle))
      const hitDecay = Math.exp(-1 / (tau * sr))
      const popDecay = Math.exp(-1 / (0.0016 * sr))
      const edgeDecay = this.attackCoef
      const punchNow = 0.6 + 0.4 * throttle
      const drive = 1 + (this.drive - 1) * throttle
      const muffler = this.mufflerHz + this.mufflerOpenHz * throttle
      if (Math.abs(muffler - this.mufflerAt) > 1) this.setMuffler(muffler)
      const popChance = crackleAsk * this.crackle * 0.3

      // ---- copy everything the sample loop touches into locals (fast) ----
      const gap = this.gap
      const pipeOf = this.pipeOf
      const punch = this.punch
      const lopePunch = this.lopePunch
      const lopeTime = this.lopeTime
      const hit = this.hit
      const edge = this.edge
      const pop = this.pop
      const popEdge = this.popEdge
      const d0 = this.delay0
      const d1 = this.delay1
      const len0 = this.pipeDelay[0]
      const len1 = this.pipeDelay[1]
      const lvl0 = this.pipeLevel[0]
      const lvl1 = this.pipeLevel[1]
      const ring = this.ring
      const damp = this.dampCoef
      let lp0 = this.pipeLp[0]
      let lp1 = this.pipeLp[1]
      const grit = this.grit
      const fB0 = this.fB0
      const fA1 = this.fA1
      const fA2 = this.fA2
      const fLevel = this.fLevel
      const fz1 = this.fz1
      const fz2 = this.fz2
      const direct = this.direct
      const mc = this.mc
      const mz = this.mz
      const hc = this.hc
      const hz = this.hz
      let w = this.w
      let wait = this.wait
      let slot = this.slot
      let rng = this.rng
      const slots = this.slots
      const level = this.level
      const fadeCoef = this.fadeCoef
      let fade = this.fade
      const invDrive = 1 / drive

      for (let i = 0; i < n; i++) {
        // ---- 1. FIRING ----
        wait -= inc
        if (wait <= 0) {
          this.rng = rng
          let a = (punch[slot] + lopeNow * lopePunch[slot]) * punchNow
          a *= 1 + this.punchJitter * (this.rand() * 2 - 1)
          if (cut > 0 && this.rand() < cut) a *= 0.12 // ignition cut: this cylinder hardly fires
          const p = pipeOf[slot]
          hit[p] += a
          edge[p] += a
          if (popChance > 0 && this.rand() < popChance) {
            const bang = 0.55 + 0.5 * this.rand()
            pop[p] += bang
            popEdge[p] += bang
          }
          const next = slot + 1 === slots ? 0 : slot + 1
          const g = gap[slot]
          wait += g + lopeNow * (lopeTime[next] - lopeTime[slot]) + this.timingJitter * g * (this.rand() * 2 - 1)
          if (wait < 0.2 * g) wait = 0.2 * g // never two firings in one breath
          slot = next
          rng = this.rng
        }

        // ---- the thumps in flight (sharp front, slower fall) with grit riding inside ----
        rng ^= rng << 13
        rng ^= rng >>> 17
        rng ^= rng << 5
        const nz0 = (rng >>> 0) / 2147483648 - 1
        rng ^= rng << 13
        rng ^= rng >>> 17
        rng ^= rng << 5
        const nz1 = (rng >>> 0) / 2147483648 - 1
        hit[0] *= hitDecay
        edge[0] *= edgeDecay
        hit[1] *= hitDecay
        edge[1] *= edgeDecay
        pop[0] *= popDecay
        popEdge[0] *= edgeDecay
        pop[1] *= popDecay
        popEdge[1] *= edgeDecay
        const x0 = (hit[0] - edge[0]) * (1 + grit * nz0) + (pop[0] - popEdge[0]) * (1 + 0.8 * nz0)
        const x1 = (hit[1] - edge[1]) * (1 + grit * nz1) + (pop[1] - popEdge[1]) * (1 + 0.8 * nz1)

        // ---- 2. PIPES: each pipe echoes back on itself, upside down, a little duller each time ----
        lp0 += damp * (d0[(w - len0) & MASK] - lp0)
        lp1 += damp * (d1[(w - len1) & MASK] - lp1)
        const y0 = x0 + ring * lp0
        const y1 = x1 + ring * lp1
        d0[w] = y0
        d1[w] = y1
        w = (w + 1) & MASK
        let m = y0 * lvl0 + y1 * lvl1

        // ---- 3. GROWL: soft distortion that grows with the throttle ----
        m = Math.tanh(m * drive) * invDrive

        // ---- 4. MUFFLER: fixed box resonances, then the soft top filter ----
        let f = m * direct
        for (let k = 0; k < 3; k++) {
          const y = fB0[k] * m + fz1[k]
          fz1[k] = -fA1[k] * y + fz2[k]
          fz2[k] = -fB0[k] * m - fA2[k] * y
          f += fLevel[k] * y
        }
        let y = mc[0] * f + mz[0]
        mz[0] = mc[1] * f - mc[3] * y + mz[1]
        mz[1] = mc[2] * f - mc[4] * y
        const s2 = y
        y = mc[5] * s2 + mz[2]
        mz[2] = mc[6] * s2 - mc[8] * y + mz[3]
        mz[3] = mc[7] * s2 - mc[9] * y

        // Take out the slow push you can't hear (a pressure wave's steady part).
        const s3 = y
        y = hc[0] * s3 + hz[0]
        hz[0] = hc[1] * s3 - hc[3] * y + hz[1]
        hz[1] = hc[2] * s3 - hc[4] * y

        fade += (this.fadeTarget - fade) * fadeCoef
        out[i] = SOFT_LIMIT * Math.tanh(y * MAKEUP * INV_SOFT_LIMIT) * level * fade
      }

      this.pipeLp[0] = Math.abs(lp0) < 1e-20 ? 0 : lp0
      this.pipeLp[1] = Math.abs(lp1) < 1e-20 ? 0 : lp1
      this.w = w
      this.wait = wait
      this.slot = slot
      this.rng = rng
      this.fade = fade
      // A queued voicing swaps in once the old one has faded to silence.
      if (this.pending && fade < 0.001) {
        const next = this.pending
        this.pending = null
        this.setVoicing(next)
        this.fadeTarget = 1
      }
    }
  }

  // ---- on the audio thread: register the processor that wraps the motor ----
  const scope = globalThis as unknown as {
    registerProcessor?: (name: string, ctor: unknown) => void
    AudioWorkletProcessor?: new (options?: unknown) => { readonly port: MessagePort }
    sampleRate?: number
  }
  const Base = scope.AudioWorkletProcessor
  if (typeof scope.registerProcessor === 'function' && Base) {
    class MotorProcessor extends Base {
      private readonly motor: Motor
      private alive = true
      constructor(options: { processorOptions?: { motor: MotorSpec; seed?: number } }) {
        super(options)
        const o = options.processorOptions
        this.motor = new Motor(scope.sampleRate ?? 48000, o ? o.motor : ({} as MotorSpec), o && o.seed ? o.seed : 1)
        this.port.onmessage = (e: MessageEvent) => {
          const d = e.data as { motor?: MotorSpec; stop?: boolean } | null
          if (d && d.motor) this.motor.queueVoicing(d.motor)
          if (d && d.stop) this.alive = false
        }
      }
      static get parameterDescriptors() {
        return [
          { name: 'fireHz', defaultValue: 50, minValue: 0, maxValue: 2000, automationRate: 'k-rate' },
          { name: 'throttle', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
          { name: 'cut', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
          { name: 'crackle', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
        ]
      }
      process(_inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>): boolean {
        const out = outputs[0]
        const ch = out && out[0]
        if (ch) {
          this.motor.process(ch, ch.length, params.fireHz[0], params.throttle[0], params.cut[0], params.crackle[0])
          for (let c = 1; c < out.length; c++) out[c].set(ch)
        }
        return this.alive
      }
    }
    scope.registerProcessor(processorName, MotorProcessor)
  }
  return Motor
}

// ---------------------------------------------------------------- loading it on the audio thread

/** The motor as text: the function above, called with the processor's name. */
const MOTOR_SOURCE = `(${motorModule.toString()})(${JSON.stringify(MOTOR_PROCESSOR)});`

/** Why the motor is (or is not) running on the audio thread, for the inspector. */
export interface MotorLoad {
  ok: boolean
  /** 'worklet', or why not: 'no-audioworklet' (an insecure http:// page, e.g. a LAN guest) or the error. */
  reason: string
}

const loads = new WeakMap<BaseAudioContext, Promise<MotorLoad>>()

/**
 * Load the motor onto a context's audio thread (once per context). Resolves
 * ok: false instead of throwing when the browser can't: AudioWorklet only
 * exists on secure pages (https or localhost), so a friend joining a LAN
 * game over plain http gets the node motor instead (motorNodes.ts).
 */
export function loadMotorWorklet(ctx: BaseAudioContext): Promise<MotorLoad> {
  const known = loads.get(ctx)
  if (known) return known
  const p = (async (): Promise<MotorLoad> => {
    const worklet = (ctx as BaseAudioContext & { audioWorklet?: AudioWorklet }).audioWorklet
    if (!worklet || typeof AudioWorkletNode === 'undefined') return { ok: false, reason: 'no-audioworklet' }
    const url = URL.createObjectURL(new Blob([MOTOR_SOURCE], { type: 'text/javascript' }))
    try {
      await worklet.addModule(url)
      return { ok: true, reason: 'worklet' }
    } catch (err) {
      // A real failure (not just an old browser): say so once, then use the node motor.
      console.info('[audio] engine worklet could not load, using the node motor:', err)
      return { ok: false, reason: String(err) }
    } finally {
      URL.revokeObjectURL(url)
    }
  })()
  loads.set(ctx, p)
  return p
}

/** Make the motor node (after loadMotorWorklet resolved ok). One per engine, made once. */
export function createMotorNode(ctx: BaseAudioContext, motor: MotorSpec, seed: number): AudioWorkletNode {
  return new AudioWorkletNode(ctx, MOTOR_PROCESSOR, {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { motor, seed },
  })
}
