// ============================================================
//  ONE-SHOT VOICES - the instruments sound effects are made of
// ------------------------------------------------------------
//  Each function here plays ONE short sound, scheduled at an exact
//  time on the audio clock, and cleans itself up when it ends.
//  Effects (effects.ts) combine them: a crash is a thump plus a
//  noise burst; a pickup chime is a bell plus a shimmer.
//
//    tone      a plain oscillator with a quick attack and a fade
//    bell      FM bell: one sine wobbling another's pitch, so the
//              attack is bright and metallic and the tail is pure
//    thump     a sine diving in pitch: the body of every hit
//    noiseHit  filtered noise with an envelope: whooshes, crunches,
//              shatters (the filter can sweep while it plays)
//    sweep     an oscillator gliding between two pitches (risers,
//              down-sweeps, the boost spool)
//
//  These make a few nodes per call. That is fine for effects (they
//  come from events, a few per second at most) and never happens per
//  frame. `kit.active` counts live voices so a pile-up can be capped.
// ============================================================

import { SILENT, makeNoiseBuffer } from './synth'

/** Above this many live one-shot voices, new optional sounds are skipped. */
export const MAX_VOICES = 72

export interface VoiceKit {
  ctx: BaseAudioContext
  /** Where voices plug in by default. */
  out: AudioNode
  noise: AudioBuffer
  /** Live voices right now. */
  active: number
  /** Voices started since the kit was made. */
  started: number
  /** Rotates noise start points so two bursts never sound identical. */
  noiseCursor: number
}

export function makeKit(ctx: BaseAudioContext, out: AudioNode, noise?: AudioBuffer): VoiceKit {
  return { ctx, out, noise: noise ?? makeNoiseBuffer(ctx), active: 0, started: 0, noiseCursor: 0 }
}

/** True when there is room for another voice. */
export function hasRoom(kit: VoiceKit): boolean {
  return kit.active < MAX_VOICES
}

/** Optional stereo position (-1 left .. 1 right) and destination for a voice. */
export interface VoiceOpts {
  pan?: number
  dest?: AudioNode
}

function finish(kit: VoiceKit, src: AudioScheduledSourceNode, nodes: AudioNode[]): void {
  kit.active++
  kit.started++
  src.onended = () => {
    kit.active--
    src.disconnect()
    for (let i = 0; i < nodes.length; i++) nodes[i].disconnect()
  }
}

/** Route `from` to the voice's destination, through a panner if asked. Returns extra nodes made. */
function route(kit: VoiceKit, from: AudioNode, o: VoiceOpts | undefined, made: AudioNode[]): void {
  const dest = o?.dest ?? kit.out
  if (o?.pan) {
    const p = kit.ctx.createStereoPanner()
    p.pan.value = o.pan
    from.connect(p)
    p.connect(dest)
    made.push(p)
  } else {
    from.connect(dest)
  }
}

/** Attack then exponential decay on a gain node, starting and ending silent (no clicks). */
export function envelope(g: GainNode, at: number, peak: number, attack: number, decay: number): void {
  g.gain.setValueAtTime(SILENT, at)
  g.gain.exponentialRampToValueAtTime(Math.max(peak, SILENT * 2), at + attack)
  g.gain.exponentialRampToValueAtTime(SILENT, at + attack + decay)
}

export function tone(
  kit: VoiceKit,
  type: OscillatorType,
  hz: number,
  at: number,
  peak: number,
  attack: number,
  decay: number,
  o?: VoiceOpts,
): void {
  const ctx = kit.ctx
  const osc = ctx.createOscillator()
  osc.type = type
  osc.frequency.value = hz
  const amp = ctx.createGain()
  envelope(amp, at, peak, attack, decay)
  osc.connect(amp)
  const made: AudioNode[] = [amp]
  route(kit, amp, o, made)
  finish(kit, osc, made)
  osc.start(at)
  osc.stop(at + attack + decay + 0.05)
}

/**
 * FM bell. `ratio` sets the character: 3 = glassy chime, 1.4 = clangy
 * metal, 3.5 = bright glass. `brightness` is how hard the modulator hits
 * at the start (it fades over ~0.2 s, leaving a clean sine tail).
 */
export function bell(
  kit: VoiceKit,
  hz: number,
  at: number,
  peak: number,
  decay: number,
  brightness = 2.2,
  ratio = 3,
  o?: VoiceOpts,
): void {
  const ctx = kit.ctx
  const car = ctx.createOscillator()
  car.type = 'sine'
  car.frequency.value = hz
  const mod = ctx.createOscillator()
  mod.type = 'sine'
  mod.frequency.value = hz * ratio
  const modG = ctx.createGain()
  modG.gain.setValueAtTime(hz * brightness, at)
  modG.gain.exponentialRampToValueAtTime(Math.max(1, hz * 0.02), at + Math.min(decay, 0.22))
  mod.connect(modG)
  modG.connect(car.frequency)
  const amp = ctx.createGain()
  envelope(amp, at, peak, 0.004, decay)
  car.connect(amp)
  const made: AudioNode[] = [amp, modG, mod]
  route(kit, amp, o, made)
  finish(kit, car, made)
  car.start(at)
  mod.start(at)
  const end = at + decay + 0.06
  car.stop(end)
  mod.stop(end)
}

/** A sine diving from fromHz to toHz: kicks, thuds, landings. */
export function thump(kit: VoiceKit, at: number, peak: number, fromHz: number, toHz: number, decay: number, o?: VoiceOpts): void {
  const ctx = kit.ctx
  const osc = ctx.createOscillator()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(fromHz, at)
  osc.frequency.exponentialRampToValueAtTime(toHz, at + decay * 0.7)
  const amp = ctx.createGain()
  envelope(amp, at, peak, 0.003, decay)
  osc.connect(amp)
  const made: AudioNode[] = [amp]
  route(kit, amp, o, made)
  finish(kit, osc, made)
  osc.start(at)
  osc.stop(at + decay + 0.05)
}

/**
 * Filtered noise burst. If sweepToHz is given the filter glides there over
 * the burst (a rising whoosh, a falling crunch).
 */
export function noiseHit(
  kit: VoiceKit,
  at: number,
  peak: number,
  type: BiquadFilterType,
  hz: number,
  q: number,
  attack: number,
  decay: number,
  sweepToHz?: number,
  o?: VoiceOpts,
): void {
  const ctx = kit.ctx
  const src = ctx.createBufferSource()
  src.buffer = kit.noise
  const f = ctx.createBiquadFilter()
  f.type = type
  f.frequency.setValueAtTime(hz, at)
  if (sweepToHz !== undefined) f.frequency.exponentialRampToValueAtTime(sweepToHz, at + attack + decay)
  f.Q.value = q
  const amp = ctx.createGain()
  envelope(amp, at, peak, attack, decay)
  src.connect(f)
  f.connect(amp)
  const made: AudioNode[] = [f, amp]
  route(kit, amp, o, made)
  finish(kit, src, made)
  kit.noiseCursor = (kit.noiseCursor + 0.377) % 1.5
  src.start(at, kit.noiseCursor)
  src.stop(at + attack + decay + 0.05)
}

/** An oscillator gliding between two pitches through an optional lowpass. */
export function sweep(
  kit: VoiceKit,
  type: OscillatorType,
  fromHz: number,
  toHz: number,
  at: number,
  dur: number,
  peak: number,
  attack: number,
  lowpassHz = 0,
  o?: VoiceOpts,
): void {
  const ctx = kit.ctx
  const osc = ctx.createOscillator()
  osc.type = type
  osc.frequency.setValueAtTime(fromHz, at)
  osc.frequency.exponentialRampToValueAtTime(toHz, at + dur)
  const amp = ctx.createGain()
  envelope(amp, at, peak, attack, Math.max(0.01, dur - attack))
  const made: AudioNode[] = [amp]
  if (lowpassHz > 0) {
    const f = ctx.createBiquadFilter()
    f.type = 'lowpass'
    f.frequency.value = lowpassHz
    f.Q.value = 2
    osc.connect(f)
    f.connect(amp)
    made.push(f)
  } else {
    osc.connect(amp)
  }
  route(kit, amp, o, made)
  finish(kit, osc, made)
  osc.start(at)
  osc.stop(at + dur + 0.05)
}
