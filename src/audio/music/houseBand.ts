// ============================================================
//  THE HOUSE BAND - 80s studio synthwave crossed with French house
// ------------------------------------------------------------
//  The second of the game's two bands (the classic band is in
//  instruments.ts; the arranger in music/index.ts plays both the
//  same way, so a song is the same song in either). This one:
//
//    - always plays the calm title-screen music;
//    - plays EVERYTHING when config.ts musicStyle is 'house': the
//      Daft Punk sound, with how far each mood leans French house
//      set in style.ts.
//
//  Like the classic band, every instrument is built ONCE and then
//  played by scheduling envelopes on its knobs, so a note makes no
//  new audio nodes. (Stab, the answer to your driving, is the one
//  exception: it plays a few times a lap, so it makes its
//  oscillators when it plays and they tidy themselves up after.)
//
//  The sound is 80s synthwave crossed with French house: drum
//  machine drums, a pumping sidechain, and the studio effects in
//  studio.ts (tape, chorus, phaser, the gated room).
//
//    Kick        a 909-style kick: a sine diving fast from about
//                235 Hz to 52 Hz, plus a click; it also "pumps" the
//                bass, pads, arp and the echoes (the sidechain)
//    Snare       a tone + a burst of noise into the gated room: the
//                huge 80s snare that stops dead
//    Clap        a 909 clap (four quick slaps of noise and a tail),
//                layered on the snare in the drop
//    Bass        saw + pulse + sub, a plucky filter envelope per
//                note (the funky disco bass)
//    Arp         pulse + saw with a resonant "zap" on every note
//                (the Tron arp), into a ping-pong echo and the chorus
//    Pad         four voices of FIVE detuned saws each (a
//                "supersaw"), spread across the stereo field, slow
//                filter, phaser, chorus and reverb: the warm wash
//    Lead        saw + square through a talkbox: three vowel
//                filters that open from "oo" to "ah" on each note,
//                the robot voice of Daft Punk, plus the chorus
//    HouseStab   filter house: the bar's chord on every off-beat,
//                through a low-pass the build sweeps open into the
//                drop (style.ts says which moods use it)
//    Stab        a filtered supersaw chord hit: the band's answers
//                to a big landing, a fanfare, the key lift
//
//  The hats, crash and riser are the classic band's own (shared from
//  instruments.ts), and so are Env and the node helpers (BandBase).
// ============================================================

import { Knob, SILENT, holdParam, makePulseWave, makeReverbImpulse, midiToHz } from '../synth'
import { BandBase, Env } from './instruments'
import type { Wiring } from './instruments'
import { buildChorus, buildPhaser, buildTape, controlRate, makeRoomImpulse } from './studio'

// ---------------------------------------------------------------- the mix inside the band

/**
 * Loudness trim on the whole band, after the studio. Set so the band
 * measures the same loudness as before the 80s / French house pass
 * (the music's level against the engine is not this file's to change).
 */
const BAND_TRIM = 0.94
/** The deepest the pump ever dips (0.78 = down to about a fifth of the level). How hard each mood pumps is in style.ts. */
const PUMP_MAX = 0.78
/** Echoes and reverb pump a little less than the notes, so the tails still breathe. */
const RETURNS_PUMP = 0.7
/** Level of the gated room under the snare and clap (style.ts scales it per mood). */
const ROOM_LEVEL = 1.3
/** How wet the shared chorus on the lead and arp is. */
const CHORUS_LEVEL = 0.55

// ---------------------------------------------------------------- shared music buses

/**
 * The rooms and wires every instrument plugs into.
 *
 *   drums (+ gated room) ─────────────────────────────┐
 *   pumped (bass, pads, arp) ─┐                        ├─ tape ─ trim ─ out
 *   direct (lead, riser) ─────┴─ bed (dips for a fanfare)
 *   returns (hall, echo, chorus: pump a little) ──────┤
 *   answers (chord stabs) ────────────────────────────┘
 */
export class Band extends BandBase implements Wiring {
  /** Drums go here. */
  readonly drums: GainNode
  /** Bass, pads and arp go here: this bus "pumps" with the kick. */
  readonly pumped: GainNode
  /** Lead and fx go here (not pumped). */
  readonly direct: GainNode
  /** Chord stabs that answer the driving go here (never dipped, never pumped). */
  readonly answers: GainNode
  /** Sends: big hall reverb, gated snare room, ping-pong echo, the shimmer chorus. */
  readonly reverb: GainNode
  readonly gated: GainNode
  readonly echo: GainNode
  readonly chorus: GainNode
  /** The gate on the snare room: opened by every snare and clap hit. */
  readonly roomGate: Env
  /** Drum bus level (night pulls the drums back). */
  readonly drumLevel: Knob
  /** One beat in seconds (the snare room's gate time follows it). */
  beatS = 0.5
  private readonly echoL: DelayNode
  private readonly echoR: DelayNode
  private readonly pumpNotes: Env
  private readonly pumpReturns: Env
  private readonly bedDipEnv: Env
  private readonly trimGain: GainNode
  private readonly roomOut: GainNode

  constructor(ctx: BaseAudioContext, out: AudioNode, noise: AudioBuffer) {
    super(ctx, noise)

    // ---- the end of the chain: tape machine, then the loudness trim ----
    const trim = this.gain(BAND_TRIM)
    trim.connect(out)
    this.trimGain = trim
    const tape = buildTape(this, trim)

    this.drums = this.gain(0.9)
    this.pumped = this.gain(1)
    this.direct = this.gain(1)
    this.answers = this.gain(1)
    const returns = this.gain(1)
    const bed = this.gain(1)
    this.drums.connect(tape.drums)
    this.pumped.connect(bed)
    this.direct.connect(bed)
    bed.connect(tape.notes)
    returns.connect(tape.notes)
    this.answers.connect(tape.notes)
    this.pumpNotes = new Env(this.pumped.gain, 1)
    this.pumpReturns = new Env(returns.gain, 1)
    this.bedDipEnv = new Env(bed.gain, 1)
    this.drumLevel = new Knob(this.drums.gain, 1.5, 0.005)

    // hall reverb: a 2.8 s smooth tail (it pumps with the kick)
    this.reverb = this.gain(1)
    const hall = this.node(ctx.createConvolver())
    hall.buffer = makeReverbImpulse(ctx, 2.8, 3.2, false, 0xa11)
    const hallOut = this.gain(0.32)
    const hallHp = this.filter('highpass', 220, 0.7)
    this.reverb.connect(hallHp)
    hallHp.connect(hall)
    hall.connect(hallOut)
    hallOut.connect(returns)

    // the gated room: a big bright room whose tail stays loud (the room is made that way, the
    // way an 80s engineer squashed it with a compressor), then a gate slams it shut
    this.gated = this.gain(1)
    const room = this.node(ctx.createConvolver())
    // our own level, not the browser's (see makeRoomImpulse); set BEFORE the buffer
    room.normalize = false
    // 0.45 s of room is plenty: the gate shuts it within 0.3 s
    room.buffer = makeRoomImpulse(ctx, 0.45, 0x6a7ed)
    const gate = this.gain(0)
    this.roomGate = new Env(gate.gain)
    const roomTone = this.filter('lowpass', 6500, 0.6)
    const roomOut = this.gain(ROOM_LEVEL)
    this.roomOut = roomOut
    this.gated.connect(room)
    room.connect(gate)
    gate.connect(roomTone)
    roomTone.connect(roomOut)
    roomOut.connect(this.drums)

    // ping-pong echo: left, then right, then left... darker each repeat (it pumps too)
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
    echoOut.connect(returns)

    // the shimmer chorus the lead and arp send into
    this.chorus = buildChorus(this, returns, CHORUS_LEVEL)
  }

  /** Echo time follows the tempo: a dotted eighth, the classic synthwave echo. */
  setTempo(beatS: number, t: number): void {
    this.beatS = beatS
    const d = beatS * 0.75
    this.echoL.delayTime.setTargetAtTime(d, t, 0.05)
    this.echoR.delayTime.setTargetAtTime(d, t, 0.05)
  }

  /** A mood's style (style.ts): the band's loudness trim and the snare room's size, gliding there from t. */
  setStyle(t: number, trim: number, room: number): void {
    this.trimGain.gain.setTargetAtTime(BAND_TRIM * trim, t, 0.05)
    this.roomOut.gain.setTargetAtTime(ROOM_LEVEL * room, t, 0.05)
  }

  /** The sidechain pump: duck the notes (and a little of the echoes) on a kick, then swell back. */
  pumpAt(t: number, depth: number): void {
    const d = Math.min(PUMP_MAX, depth)
    this.pumpNotes.note(t, 1 - d, 0.006, 0.13, 1)
    this.pumpReturns.note(t, 1 - d * RETURNS_PUMP, 0.006, 0.13, 1)
  }

  /** Step the band back (pads, bass, arp, lead) under a fanfare: down to `level` for `dur` seconds. */
  dipBed(t: number, level: number, dur: number): void {
    this.bedDipEnv.note(t, level, 0.03, 10, level, dur, 0.35)
  }
}

// ---------------------------------------------------------------- drums

/** A 909-style kick. */
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
    const hp = b.filter('highpass', 3000, 0.7)
    const cg = b.gain(0)
    this.click = new Env(cg.gain)
    n.connect(hp)
    hp.connect(cg)
    cg.connect(b.drums)
  }

  /** vel 0..1; long = boomier (title, breakdown impacts); pumpDepth = how hard the sidechain dips. */
  hit(t: number, vel: number, pumpDepth: number, long = false): void {
    this.pitch.cancelScheduledValues(t)
    // the 909 dive: high and fast to the low note, which then rings
    this.pitch.setValueAtTime(long ? 140 : 235, t)
    this.pitch.setTargetAtTime(long ? 38 : 52, t + 0.002, long ? 0.06 : 0.024)
    this.amp.note(t, 0.58 * vel, 0.0015, long ? 0.32 : 0.15)
    this.click.note(t, 0.2 * vel, 0.0005, 0.004)
    if (pumpDepth > 0) this.b.pumpAt(t, pumpDepth)
  }
}

/** A gentle soft-clip that gives the kick a rounder punch. */
function kickCurve(): Float32Array<ArrayBuffer> {
  const n = 1024
  const c = new Float32Array(new ArrayBuffer(n * 4))
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1
    c[i] = Math.tanh(1.8 * x) / Math.tanh(1.8)
  }
  return c
}

/** The 80s snare and, layered on it in the drop, the 909 clap. */
export class Snare {
  private readonly body: Env
  private readonly bodyPitch: AudioParam
  private readonly ring: Env
  private readonly noise: Env
  private readonly clap: Env
  private readonly send: Env
  /** Snare brightness (night darkens it). */
  readonly tone: Knob

  constructor(private readonly b: Band) {
    // the drum's body: a falling tone plus a higher ring
    const o = b.osc('triangle', 190)
    this.bodyPitch = o.frequency
    const bg = b.gain(0)
    this.body = new Env(bg.gain)
    o.connect(bg)
    bg.connect(b.drums)
    const r = b.osc('sine', 335)
    const rg = b.gain(0)
    this.ring = new Env(rg.gain)
    r.connect(rg)
    rg.connect(b.drums)
    // the snare wires: bright noise
    const n = b.noiseLoop(0.7)
    const bp = b.filter('bandpass', 2600, 0.55)
    this.tone = new Knob(bp.frequency, 1.5, 10)
    const hp = b.filter('highpass', 700, 0.7)
    const ng = b.gain(0)
    this.noise = new Env(ng.gain)
    n.connect(bp)
    bp.connect(hp)
    hp.connect(ng)
    ng.connect(b.drums)
    // the clap: its own noise, lower and narrower (the 909 clap lives around 1.2 kHz)
    const cn = b.noiseLoop(1.3)
    const cbp = b.filter('bandpass', 1250, 1.3)
    const chp = b.filter('highpass', 520, 0.7)
    const cg = b.gain(0)
    this.clap = new Env(cg.gain)
    cn.connect(cbp)
    cbp.connect(chp)
    chp.connect(cg)
    cg.connect(b.drums)
    // everything into the gated room
    const sg = b.gain(0)
    this.send = new Env(sg.gain)
    ng.connect(sg)
    cg.connect(sg)
    bg.connect(sg)
    sg.connect(b.gated)
  }

  /** clap = the 909 clap on top (the drop). gatedSend 0..1 = how much big room. */
  hit(t: number, vel: number, clap: boolean, gatedSend: number): void {
    this.bodyPitch.cancelScheduledValues(t)
    this.bodyPitch.setValueAtTime(215, t)
    this.bodyPitch.setTargetAtTime(168, t, 0.03)
    this.body.note(t, (clap ? 0.22 : 0.34) * vel, 0.001, 0.05)
    this.ring.note(t, (clap ? 0.05 : 0.08) * vel, 0.001, 0.035)
    if (clap) {
      // four slaps 9-10 ms apart, then the tail: hands that don't quite clap together
      this.noise.note(t, 0.3 * vel, 0.001, 0.06)
      this.clap.note(t, 0.82 * vel, 0.0008, 0.0045)
      this.clap.note(t + 0.009, 0.82 * vel, 0.0008, 0.0045)
      this.clap.note(t + 0.019, 0.92 * vel, 0.0008, 0.0045)
      this.clap.note(t + 0.028, 1.15 * vel, 0.0008, 0.085)
    } else {
      this.noise.note(t, 0.62 * vel, 0.001, 0.08)
    }
    if (gatedSend > 0) {
      this.send.note(t, gatedSend, 0.001, 0.12, 0, 0.14, 0.04)
      // the gate: open on the hit, hold about half a beat, then slam shut
      const hold = Math.min(0.3, Math.max(0.18, this.b.beatS * 0.5))
      const open = Math.min(1, 0.35 + gatedSend)
      this.b.roomGate.note(t, open, 0.001, 10, open, hold, 0.012)
    }
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

  /**
   * Play `midi` for `dur` seconds. glide > 0 slides into the note (legato).
   * pop 0..1 snaps the filter open harder for a moment: the slap on the
   * octave notes of a disco bass.
   */
  note(t: number, midi: number, dur: number, vel: number, glide = 0, pop = 0): void {
    const hz = midiToHz(midi)
    for (const f of this.freqs) {
      if (glide > 0) f.setTargetAtTime(hz, t, glide)
      else f.setValueAtTime(hz, t)
    }
    if (glide > 0) this.subFreq.setTargetAtTime(hz / 2, t, glide)
    else this.subFreq.setValueAtTime(hz / 2, t)
    // funky: a quick snap at the start of every note, then it settles lower
    this.amp.note(t, 0.52 * vel, 0.003, Math.max(0.06, dur * 0.5), 0.27 * vel, dur, 0.025)
    const snap = this.envAmount * (1.15 + 0.7 * pop) * vel
    this.cut.note(t, this.baseCutoff + snap, 0.003, Math.max(0.035, Math.min(0.12, dur * (0.3 - 0.1 * pop))), this.baseCutoff, dur, 0.05)
  }
}

// ---------------------------------------------------------------- arp

export class Arp {
  private readonly freqA: AudioParam
  private readonly freqB: AudioParam
  private readonly amp: Env
  private readonly zap: Env
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
    // the Tron zap: a second, resonant filter that flicks open on every note and falls back
    const zap = b.filter('lowpass', ARP_ZAP.restHz, ARP_ZAP.q)
    this.zap = new Env(zap.frequency, ARP_ZAP.restHz)
    lp.connect(zap)
    const amp = b.gain(0)
    this.amp = new Env(amp.gain)
    zap.connect(amp)
    const level = b.gain(0.4)
    amp.connect(level)
    level.connect(b.pumped)
    const echo = b.gain(0.4)
    amp.connect(echo)
    echo.connect(b.echo)
    const verb = b.gain(0.25)
    amp.connect(verb)
    verb.connect(b.reverb)
    const chorus = b.gain(0.38)
    amp.connect(chorus)
    chorus.connect(b.chorus)
    this.cutoff = new Knob(lp.frequency, 0.4, 5)
    this.echoSend = new Knob(echo.gain, 0.5, 0.01)
  }

  note(t: number, midi: number, dur: number, vel: number): void {
    const hz = midiToHz(midi)
    this.freqA.setValueAtTime(hz, t)
    this.freqB.setValueAtTime(hz, t)
    this.amp.note(t, 0.5 * vel, 0.003, Math.max(0.04, dur * 0.45), 0, dur, 0.02)
    this.zap.note(t, ARP_ZAP.peakHz, 0.002, ARP_ZAP.fallS, ARP_ZAP.restHz, dur, 0.03)
  }
}

/** The arp's zap filter: where it flicks to, how fast it falls back, where it rests, how sharp. */
const ARP_ZAP = { peakHz: 5200, fallS: 0.045, restHz: 2400, q: 2.2 } as const

// ---------------------------------------------------------------- pad

/** The supersaw: five saws per note, spread in pitch (cents) and across the speakers. */
const SUPERSAW = {
  detune: [-21, -10, 0, 10, 21],
  pan: [-0.85, -0.45, 0, 0.45, 0.85],
  level: [0.076, 0.084, 0.098, 0.084, 0.076],
} as const

export class Pad {
  private readonly voices: AudioParam[][] = []
  private readonly amp: Env
  readonly cutoff: Knob
  readonly level: Knob

  constructor(b: Band) {
    const sum = b.gain(1)
    // one "lane" per saw position: every voice's saw at that detune joins it
    const lanes: GainNode[] = []
    for (let k = 0; k < SUPERSAW.detune.length; k++) {
      const g = b.gain(SUPERSAW.level[k])
      const p = b.pan(SUPERSAW.pan[k])
      g.connect(p)
      p.connect(sum)
      lanes.push(g)
    }
    for (let i = 0; i < 4; i++) {
      const freqs: AudioParam[] = []
      for (let k = 0; k < SUPERSAW.detune.length; k++) {
        // each voice a hair apart too, so no two saws ever lock together
        const o = b.osc('sawtooth', 220, SUPERSAW.detune[k] + (i - 1.5) * 1.3)
        o.connect(lanes[k])
        freqs.push(o.frequency)
      }
      this.voices.push(freqs)
    }
    // slow filter: a gentle LFO breathing on the cutoff (it moves slowly, so once per 128 samples is plenty)
    const lp = controlRate(b.filter('lowpass', 1400, 0.9))
    const lfo = b.osc('sine', 0.07)
    const lfoDepth = b.gain(260)
    lfo.connect(lfoDepth)
    lfoDepth.connect(lp.frequency)
    sum.connect(lp)
    const amp = b.gain(0)
    this.amp = new Env(amp.gain)
    lp.connect(amp)
    // the phaser: a slow swoosh moving through the chord
    const [phIn, phOut] = buildPhaser(b, 0.11, 0.6)
    amp.connect(phIn)
    // chorus: two short wobbling delays spread left and right
    const out = b.gain(0.8)
    phOut.connect(out)
    for (let i = 0; i < 2; i++) {
      const d = b.node(b.ctx.createDelay(0.05))
      d.delayTime.value = i === 0 ? 0.012 : 0.017
      const wob = b.osc('sine', i === 0 ? 0.27 : 0.41)
      const depth = b.gain(i === 0 ? 0.0022 : 0.0028)
      wob.connect(depth)
      depth.connect(d.delayTime)
      const p = b.pan(i === 0 ? -0.7 : 0.7)
      const g = b.gain(0.5)
      phOut.connect(d)
      d.connect(g)
      g.connect(p)
      p.connect(out)
    }
    out.connect(b.pumped)
    const verb = b.gain(0.5)
    phOut.connect(verb)
    verb.connect(b.reverb)
    this.cutoff = new Knob(lp.frequency, 0.8, 5)
    this.level = new Knob(out.gain, 0.6, 0.005)
  }

  /** Change to a chord (4 MIDI notes) at t, swelling in. */
  chord(t: number, midis: readonly number[], dur: number, swell: number): void {
    for (let i = 0; i < this.voices.length; i++) {
      const hz = midiToHz(midis[i % midis.length])
      const v = this.voices[i]
      for (let k = 0; k < v.length; k++) v[k].setTargetAtTime(hz, t, 0.012)
    }
    this.amp.note(t, 0.62, swell, 0.9, 0.5, dur, 0.5)
  }

  /** Fade the pad out (sections with no pad). */
  release(t: number): void {
    this.amp.note(t, Math.max(SILENT, this.amp.valueAt(t)), 0.01, 0.6, 0, 0.02, 0.6)
  }
}

// ---------------------------------------------------------------- lead

/**
 * The talkbox: on every note the "mouth" opens from an "oo" to an "ah"
 * and settles on an "aa". A vowel is just where a voice's resonances sit
 * (its formants); these are rough adult-voice values, in Hz.
 */
const TALKBOX = {
  /** First formant: low = "oo", high = "ah". */
  f1: { rest: 380, open: 760, settle: 620 },
  /** Second formant. */
  f2: { rest: 880, open: 1240, settle: 1120 },
  /** Third formant: the buzz on top, fixed. */
  f3: 2500,
  /** How fast the mouth opens (s), and how slowly it settles. */
  openS: 0.05,
  settleTau: 0.2,
  /** Mix: the vowel filters, and a little of the plain synth so the melody stays clear. */
  vowel: 1.25,
  plain: 0.17,
} as const

export class Lead {
  private readonly freqA: AudioParam
  private readonly freqB: AudioParam
  private readonly amp: Env
  private readonly f1: Env
  private readonly f2: Env
  private readonly vowelGain: GainNode
  private readonly plainGain: GainNode

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
    const src = b.gain(1)
    const ag = b.gain(0.5)
    const sg = b.gain(0.14)
    a.connect(ag)
    s.connect(sg)
    ag.connect(src)
    sg.connect(src)
    // the mouth: three vowel filters side by side
    // the mouth moves over tens of milliseconds, so once per 128 samples is plenty (controlRate)
    const f1 = controlRate(b.filter('bandpass', TALKBOX.f1.rest, 5))
    const f2 = controlRate(b.filter('bandpass', TALKBOX.f2.rest, 7))
    const f3 = b.filter('bandpass', TALKBOX.f3, 9)
    this.f1 = new Env(f1.frequency, TALKBOX.f1.rest)
    this.f2 = new Env(f2.frequency, TALKBOX.f2.rest)
    const vowel = b.gain(TALKBOX.vowel)
    this.vowelGain = vowel
    const f3g = b.gain(0.5)
    src.connect(f1)
    src.connect(f2)
    src.connect(f3)
    f1.connect(vowel)
    f2.connect(vowel)
    f3.connect(f3g)
    f3g.connect(vowel)
    // the plain synth underneath, as before
    const lp = b.filter('lowpass', 2800, 1.6)
    const plain = b.gain(TALKBOX.plain)
    this.plainGain = plain
    src.connect(lp)
    lp.connect(plain)
    const amp = b.gain(0)
    this.amp = new Env(amp.gain)
    vowel.connect(amp)
    plain.connect(amp)
    const level = b.gain(0.3)
    amp.connect(level)
    level.connect(b.direct)
    const echo = b.gain(0.35)
    amp.connect(echo)
    echo.connect(b.echo)
    const verb = b.gain(0.35)
    amp.connect(verb)
    verb.connect(b.reverb)
    const chorus = b.gain(0.6)
    amp.connect(chorus)
    chorus.connect(b.chorus)
  }

  /**
   * How much talkbox (0 = the plain synth lead it used to be, 1 = the full
   * robot voice), from t. The plain part makes up the level as the vowels
   * fade, so the hook stays as loud either way.
   */
  setTalkbox(amount: number, t: number): void {
    const a = Math.min(1, Math.max(0, amount))
    this.vowelGain.gain.setTargetAtTime(TALKBOX.vowel * a, t, 0.05)
    this.plainGain.gain.setTargetAtTime(TALKBOX.plain * a + (1 - a), t, 0.05)
  }

  /** glide = slide into this note from the last (glideS = how long the slide takes, about). */
  note(t: number, midi: number, dur: number, vel: number, glide: boolean, glideS = 0.035): void {
    const hz = midiToHz(midi)
    if (glide) {
      this.freqA.setTargetAtTime(hz, t, glideS)
      this.freqB.setTargetAtTime(hz * 2, t, glideS)
    } else {
      this.freqA.setValueAtTime(hz, t)
      this.freqB.setValueAtTime(hz * 2, t)
    }
    this.amp.note(t, 0.5 * vel, glide ? 0.02 : 0.012, 0.25, 0.36 * vel, dur, 0.09)
    const T = TALKBOX
    this.f1.note(t, T.f1.open, T.openS, T.settleTau, T.f1.settle, dur, 0.08)
    this.f2.note(t, T.f2.open, T.openS, T.settleTau, T.f2.settle, dur, 0.08)
  }
}

// ---------------------------------------------------------------- house stab

/** The house stab's saws: two per note, a little apart and spread left and right. */
const HOUSE_SAWS = { detune: [-9, 9], pan: [-0.5, 0.5], level: 0.5 } as const

/**
 * Filter house: the bar's chord, short, on every off-beat, through a
 * resonant low-pass that sits closed (muffled) in the groove, sweeps open
 * through the build and is wide open in the drop. Built once (eight saws
 * that are always running, silent between stabs) and played by
 * envelopes, like the rest of the band. It goes through the pumped bus, so
 * it ducks with the kick: the French house sound.
 */
export class HouseStab {
  private readonly voices: AudioParam[][] = []
  private readonly amp: Env
  private readonly lpFreq: AudioParam
  /** The cutoff last asked for (Hz), so an unchanged one isn't sent again. */
  private lastHz = 700

  constructor(b: Band) {
    const lanes: GainNode[] = []
    const sum = b.gain(1)
    for (let k = 0; k < HOUSE_SAWS.pan.length; k++) {
      const g = b.gain(HOUSE_SAWS.level)
      const p = b.pan(HOUSE_SAWS.pan[k])
      g.connect(p)
      p.connect(sum)
      lanes.push(g)
    }
    for (let i = 0; i < 4; i++) {
      const freqs: AudioParam[] = []
      for (let k = 0; k < HOUSE_SAWS.detune.length; k++) {
        const o = b.osc('sawtooth', 220, HOUSE_SAWS.detune[k] + (i - 1.5))
        o.connect(lanes[k])
        freqs.push(o.frequency)
      }
      this.voices.push(freqs)
    }
    // the filter only moves with the sections, so once per 128 samples is plenty
    const lp = controlRate(b.filter('lowpass', 700, 2.4))
    this.lpFreq = lp.frequency
    const amp = b.gain(0)
    this.amp = new Env(amp.gain)
    sum.connect(lp)
    lp.connect(amp)
    const level = b.gain(1)
    amp.connect(level)
    level.connect(b.pumped)
    const verb = b.gain(0.2)
    amp.connect(verb)
    verb.connect(b.reverb)
    const echo = b.gain(0.15)
    amp.connect(echo)
    echo.connect(b.echo)
  }

  /** One stab: these four notes, for dur seconds, at vel (0..1). */
  play(t: number, midis: readonly number[], dur: number, vel: number): void {
    for (let i = 0; i < this.voices.length; i++) {
      const hz = midiToHz(midis[i % midis.length])
      const v = this.voices[i]
      for (let k = 0; k < v.length; k++) v[k].setValueAtTime(hz, t)
    }
    this.amp.note(t, 0.5 * vel, 0.003, Math.max(0.05, dur * 0.6), 0.22 * vel, dur, 0.035)
  }

  /** Glide the filter to hz from t (tau = how quickly). Whatever was planned after t is dropped. */
  setCutoff(hz: number, t: number, tau: number): void {
    if (!Number.isFinite(hz) || Math.abs(hz - this.lastHz) <= 5) return
    this.lastHz = hz
    holdParam(this.lpFreq, t)
    this.lpFreq.setTargetAtTime(Math.max(40, hz), t, tau)
  }

  /** The build's sweep: the filter opens to `toHz` over dur seconds from t, from wherever it is. */
  sweep(t: number, toHz: number, dur: number): void {
    holdParam(this.lpFreq, t)
    this.lpFreq.exponentialRampToValueAtTime(Math.max(40, toHz), t + Math.max(0.05, dur))
    this.lastHz = toHz
  }
}

// ---------------------------------------------------------------- stab

/** The chord stab's supersaw: three saws per note, left, centre and right. */
const STAB_SAWS = { detune: [-14, 0, 14], pan: [-0.7, 0, 0.7], level: [0.06, 0.075, 0.06] } as const

/** One stab still sounding: its three level faders and its oscillators. */
interface LiveStab {
  gains: GainNode[]
  oscs: OscillatorNode[]
  /** When its oscillators are booked to stop. */
  end: number
}

/**
 * A filtered supersaw chord hit: the French house stab. A resonant
 * low-pass flicks open on the hit and closes again. It plays when the
 * music answers the driving (music/index.ts), a few times a lap at most, so
 * it makes its oscillators when it plays and they stop and disconnect
 * themselves when it ends. A new stab fades the last one out first.
 */
export class Stab {
  private readonly cut: Env
  private readonly lanes: StereoPannerNode[] = []
  private live: LiveStab | null = null

  constructor(private readonly b: Band) {
    const sum = b.gain(1)
    for (let k = 0; k < STAB_SAWS.pan.length; k++) {
      const p = b.pan(STAB_SAWS.pan[k])
      p.connect(sum)
      this.lanes.push(p)
    }
    const lp = b.filter('lowpass', 600, 3.5)
    this.cut = new Env(lp.frequency, 600)
    sum.connect(lp)
    lp.connect(b.answers)
    const verb = b.gain(0.45)
    lp.connect(verb)
    verb.connect(b.reverb)
    const echo = b.gain(0.22)
    lp.connect(echo)
    echo.connect(b.echo)
  }

  /** Play a chord (MIDI notes) at t for len seconds. bright 0..1 = how far the filter flicks open. */
  play(t: number, midis: readonly number[], len: number, bright: number, vel: number): void {
    const ctx = this.b.ctx
    this.fadeOut(t)
    const gains: GainNode[] = []
    for (let k = 0; k < this.lanes.length; k++) {
      const g = ctx.createGain()
      g.gain.setValueAtTime(SILENT, t)
      g.gain.linearRampToValueAtTime(STAB_SAWS.level[k] * vel, t + 0.004)
      g.gain.setTargetAtTime(STAB_SAWS.level[k] * vel * 0.7, t + 0.004, 0.2)
      g.gain.setTargetAtTime(0, t + len, 0.06)
      g.connect(this.lanes[k])
      gains.push(g)
    }
    const end = t + len + 0.4
    const oscs: OscillatorNode[] = []
    for (const midi of midis) {
      const hz = midiToHz(midi)
      for (let k = 0; k < this.lanes.length; k++) {
        const o = ctx.createOscillator()
        o.type = 'sawtooth'
        o.frequency.value = hz
        o.detune.value = STAB_SAWS.detune[k]
        o.connect(gains[k])
        o.start(t)
        o.stop(end)
        oscs.push(o)
      }
    }
    const stab: LiveStab = { gains, oscs, end }
    // the last oscillator to end tidies the stab away
    oscs[oscs.length - 1].onended = () => {
      for (const o of stab.oscs) o.disconnect()
      for (const g of stab.gains) g.disconnect()
      if (this.live === stab) this.live = null
    }
    this.live = stab
    this.cut.note(t, 900 + 4300 * bright, 0.004, 0.08 + 0.1 * bright, 700 + 1000 * bright, len, 0.08)
  }

  /** Fade the stab still sounding (if any) out quickly from t, and stop it soon after. */
  private fadeOut(t: number): void {
    const s = this.live
    if (!s) return
    for (const g of s.gains) {
      holdParam(g.gain, t)
      g.gain.setTargetAtTime(0, t, 0.006)
    }
    // stop() again replaces the booked stop time, so only ever bring it earlier
    if (t + 0.05 < s.end) {
      for (const o of s.oscs) o.stop(t + 0.05)
      s.end = t + 0.05
    }
  }
}
