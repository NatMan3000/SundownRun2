// ============================================================
//  ENGINE VOICINGS - what kind of motor your car has
// ------------------------------------------------------------
//  Every car's engine is the same machine underneath (motorDsp.ts):
//  a string of thumps, one per cylinder firing, pushed through an
//  exhaust pipe and a muffler. A "voicing" is just the numbers that
//  machine runs with: how many cylinders, how fast it revs, how long
//  and wide the pipes are, how much grit and turbo it has.
//
//    muscle   a deep V8 muscle car: lumpy idle, big low growl
//    rally    a turbo five-cylinder rally car: raspy, revs high,
//             turbo whoosh and a "pssh" when you lift off or
//             change up a gear
//    hover    a futuristic hover-jet: a smooth deep motor with a
//             jet turbine humming on top
//
//  Pick one in src/core/config.ts (engineSound), or try one for a
//  single run with ?engine=muscle (or rally, hover) in the address.
//
//  Want to invent your own? Copy a voicing, give it a new name and
//  change the numbers. The comments say what each one does.
// ============================================================

export type EngineSoundId = 'muscle' | 'rally' | 'hover'

/** The motor half of a voicing. Plain numbers, because it is posted to the audio thread. */
export interface MotorSpec {
  /** Cylinders. Each one fires once every two turns of the crank (a four-stroke engine). */
  cylinders: number
  /**
   * When each firing happens, as a fraction of one full engine cycle (two crank turns),
   * in firing order. Evenly spaced = a smooth engine; bunched up = a lumpy one.
   */
  fireAt: number[]
  /** Which exhaust pipe (0 or 1) each firing goes down. A V8 has two banks, so two pipes. */
  pipeOf: number[]
  /** How hard each cylinder hits. No engine is perfectly even, and that is its character. */
  punch: number[]
  /** Engine speed at idle and at the redline, revolutions per minute. */
  idleRpm: number
  redlineRpm: number
  /** Below 1 lifts the low revs (the note climbs fast off idle, then eases toward the redline). */
  rpmCurve: number
  /** Random wobble in WHEN each cylinder fires (fraction of the gap between firings). */
  timingJitter: number
  /** Random wobble in how hard each cylinder fires (0.1 = plus or minus 10%). */
  punchJitter: number
  /** Extra unevenness at idle (a big cam's lope). Fades away as the revs rise. */
  lope: number
  /** How long each thump rings, as a fraction of the gap to the next one. Longer = rounder. */
  thumpLength: number
  /** How sharp the front of each thump is, in milliseconds. Smaller = punchier. */
  attackMs: number
  /** Rasp: how much hiss rides inside each thump. 0 = clean ... 0.6 = gravelly. */
  grit: number
  /** Each pipe's lowest ring, Hz (a longer pipe rings lower). Fixed: it never moves with the revs. */
  pipeHz: number[]
  /** How loud each pipe is. Two different pipes is where a V8's burble comes from. */
  pipeLevel: number[]
  /** How strongly sound bounces back down the pipe (0 = no ring ... 0.7 = a big honk). */
  pipeRing: number
  /** Exhaust "body" resonances: the hollow, boomy notes of the muffler box. They never move. */
  formants: { hz: number; q: number; level: number }[]
  /** How much of the sound skips the muffler boxes (the rest is coloured by them). */
  direct: number
  /** Muffler: everything above this is softened (Hz), opening by mufflerOpenHz at full throttle. */
  mufflerHz: number
  mufflerOpenHz: number
  /** Growl: how hard the exhaust is pushed into soft distortion at full throttle. 1 = clean. */
  drive: number
  /** Pops and crackles when you lift off at high revs. 0 = none ... 1 = lots. */
  crackle: number
  /** Overall loudness of this motor (matched so every voicing is about as loud as the others). */
  level: number
  /**
   * Loudness of the backup motor a LAN friend's computer uses (motorNodes.ts), matched
   * to this one by loudness meter. Leave it out to use 1.
   */
  nodeLevel?: number
}

/** The layers around the motor: turbo, intake, jet, and how loud the tyres are next to it. */
export interface LayerSpec {
  /** Turbo spool: a soft rising whoosh-tone as boost builds (0 = no turbo). */
  spool: number
  /** Where the spool sits: Hz when it starts to build, Hz when it is fully spooled. Kept low on purpose. */
  spoolHz: [number, number]
  /** Intake and air rush under load (0 = none). */
  whoosh: number
  /** The "pssh" when you lift off a spooled turbo, and on every upshift (0 = none). */
  blowOff: number
  /** The blow-off stutters ("stu-tu-tu") instead of one hiss. */
  flutter: boolean
  /**
   * How long the driver comes off the throttle for an upshift, seconds (0 = keeps it pinned).
   * While off, the motor goes quiet like a lift-off, so the turbo's blow-off is heard clearly.
   */
  shiftLiftS: number
  /** Hover jet turbine: a smooth tone that follows the motor (0 = none). */
  jet: number
  /** Turbine pitch, as a multiple of the motor's firing note (1.5 = a fifth above, so it blends in). */
  jetRatio: number
  /**
   * How loud the tyre scrub is next to this motor (1 = standard). A louder, raspier
   * motor covers up more of the scrub, so it needs more to be heard sliding.
   */
  tyres: number
}

export interface EngineVoicing {
  id: EngineSoundId
  /** What it sounds like, in a few words (shown in the inspector). */
  label: string
  motor: MotorSpec
  layers: LayerSpec
}

// Firing slots for an even-firing engine: N firings spread evenly over the cycle.
function even(n: number): number[] {
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(i / n)
  return out
}

/**
 * MUSCLE: a cross-plane V8. Its firing order sends two pulses in a row down
 * the same bank now and then (left, right, left, right, RIGHT, left, right,
 * LEFT...), and the two banks have their own pipes. That uneven beat on each
 * pipe is the famous V8 burble.
 */
const MUSCLE: EngineVoicing = {
  id: 'muscle',
  label: 'deep V8 muscle car',
  motor: {
    cylinders: 8,
    fireAt: even(8),
    pipeOf: [0, 1, 0, 1, 1, 0, 1, 0],
    punch: [1.0, 0.84, 1.1, 0.92, 1.14, 0.88, 1.03, 0.95],
    idleRpm: 720,
    redlineRpm: 6400,
    rpmCurve: 0.62,
    timingJitter: 0.035,
    punchJitter: 0.14,
    lope: 0.45,
    thumpLength: 0.22,
    attackMs: 0.35,
    grit: 0.22,
    pipeHz: [41, 48],
    pipeLevel: [1.0, 0.8],
    pipeRing: 0.35,
    formants: [
      { hz: 92, q: 1.6, level: 0.9 },
      { hz: 185, q: 2.2, level: 0.6 },
      { hz: 410, q: 2.6, level: 0.3 },
    ],
    direct: 0.6,
    mufflerHz: 650,
    mufflerOpenHz: 750,
    drive: 1.7,
    crackle: 0.45,
    level: 1.88,
  },
  // No turbo and no intake hiss: a muscle V8 breathes on its own, and the hiss
  // (rising with the revs) was the "high pitch wind" Nathan heard. All growl.
  layers: {
    spool: 0,
    spoolHz: [300, 650],
    whoosh: 0,
    blowOff: 0,
    flutter: false,
    shiftLiftS: 0,
    jet: 0,
    jetRatio: 1.5,
    tyres: 1,
  },
}

/**
 * RALLY: a turbo five-cylinder. Five cylinders fire two and a half times
 * per crank turn, which gives the warbly, raspy note of a rally car.
 * Brighter muffler, more grit, a big turbo and pops on the overrun.
 */
const RALLY: EngineVoicing = {
  id: 'rally',
  label: 'turbo five-cylinder rally car',
  motor: {
    cylinders: 5,
    fireAt: even(5),
    pipeOf: [0, 0, 0, 0, 0],
    punch: [1.0, 0.88, 1.08, 0.93, 1.04],
    idleRpm: 950,
    redlineRpm: 8600,
    rpmCurve: 0.66,
    timingJitter: 0.045,
    punchJitter: 0.15,
    lope: 0.2,
    thumpLength: 0.18,
    attackMs: 0.25,
    grit: 0.7,
    pipeHz: [58],
    pipeLevel: [1.0],
    pipeRing: 0.3,
    formants: [
      { hz: 150, q: 1.8, level: 0.7 },
      { hz: 330, q: 2.4, level: 0.55 },
      { hz: 720, q: 2.8, level: 0.3 },
    ],
    direct: 0.65,
    mufflerHz: 850,
    mufflerOpenHz: 900,
    drive: 2.0,
    crackle: 0.9,
    level: 1.04,
    nodeLevel: 1.6,
  },
  layers: {
    spool: 1,
    spoolHz: [340, 800],
    whoosh: 0.45,
    blowOff: 1,
    flutter: true,
    shiftLiftS: 0.25,
    jet: 0,
    jetRatio: 1.5,
    tyres: 1.8,
  },
}

/**
 * HOVER: a smooth six-cylinder "power core" with a jet turbine on top.
 * Even firing, very little wobble, round thumps and a muffler tuned to
 * a musical fifth, so it hums like a starship instead of rattling.
 */
const HOVER: EngineVoicing = {
  id: 'hover',
  label: 'futuristic hover-jet',
  motor: {
    cylinders: 6,
    fireAt: even(6),
    pipeOf: [0, 1, 0, 1, 0, 1],
    punch: [1.0, 0.97, 1.02, 0.98, 1.01, 0.99],
    idleRpm: 1100,
    redlineRpm: 7600,
    rpmCurve: 0.62,
    timingJitter: 0.01,
    punchJitter: 0.05,
    lope: 0.05,
    thumpLength: 0.34,
    attackMs: 0.6,
    grit: 0.08,
    pipeHz: [55, 68],
    pipeLevel: [1.0, 1.0],
    pipeRing: 0.22,
    formants: [
      { hz: 110, q: 1.6, level: 0.8 },
      { hz: 165, q: 1.8, level: 0.55 },
      { hz: 330, q: 2, level: 0.3 },
    ],
    direct: 0.7,
    mufflerHz: 560,
    mufflerOpenHz: 500,
    drive: 1.3,
    crackle: 0,
    level: 1.7,
    nodeLevel: 0.9,
  },
  layers: {
    spool: 0.35,
    spoolHz: [300, 650],
    whoosh: 0.4,
    blowOff: 0,
    flutter: false,
    shiftLiftS: 0,
    jet: 1,
    jetRatio: 1.5,
    tyres: 1.25,
  },
}

export const ENGINE_VOICINGS: Record<EngineSoundId, EngineVoicing> = {
  muscle: MUSCLE,
  rally: RALLY,
  hover: HOVER,
}

export const ENGINE_SOUND_IDS = Object.keys(ENGINE_VOICINGS) as EngineSoundId[]

/** Used when a name is missing or misspelled. */
export const DEFAULT_ENGINE_SOUND: EngineSoundId = 'muscle'

/** A name (from the URL or config.ts) to a voicing id, falling back to the default. */
export function resolveEngineSound(name: string | null | undefined): EngineSoundId {
  return name && name in ENGINE_VOICINGS ? (name as EngineSoundId) : DEFAULT_ENGINE_SOUND
}

/** True when the name is one of the voicings (so a typo can be reported, not silently swapped). */
export function isEngineSound(name: string | null | undefined): name is EngineSoundId {
  return !!name && name in ENGINE_VOICINGS
}

/** Firing note (Hz) at a normalised game rpm (0..1, idle at 0.1). Pitch is honest to the rpm. */
export function firingHz(m: MotorSpec, rpm: number): number {
  // telemetry.rpm sits at 0.1 at idle and climbs to ~1 at the redline.
  const x = rpm <= 0.1 ? 0 : Math.min(1, (rpm - 0.1) / 0.9)
  const below = rpm < 0.1 ? 0.75 + 2.5 * Math.max(0, rpm) : 1 // a stalled-ish sag under idle
  const engineRpm = (m.idleRpm + (m.redlineRpm - m.idleRpm) * Math.pow(x, m.rpmCurve)) * below
  // Four-stroke: each cylinder fires once every two crank turns.
  return (engineRpm / 120) * m.cylinders
}
