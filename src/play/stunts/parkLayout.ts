// ============================================================
//  STUNT PARK LAYOUT - where every ramp, ring and target goes
// ------------------------------------------------------------
//  A pure function of the track (and two of Josh's knobs): the
//  same track always gets the same park, on every machine, so a
//  stunt record means the same thing every time. Nothing here
//  uses Math.random; the dice are seeded from the track's id.
//
//  The park is a handful of ZONES. A zone is a straight "lane" off
//  the road with its stunts in a row, so you can link them: land
//  one, line up, hit the next. Five kinds:
//
//    MEGA RAMP     a launch tower (megaRampHeight tall), a huge gap,
//                  a landing hill, rings on the way, a bullseye for
//                  anyone who overshoots on purpose
//    SKY TABLE     a big tabletop: launch, long deck, landing slope,
//                  two rings in the air, a bullseye past it
//    CANYON RUN    two named gap jumps (launch, empty gap, landing)
//    KICKER ALLEY  three kickers with bullseyes and a ring, ending in
//                  a quarter pipe
//    HALF PIPE     two curved walls facing each other
//
//  Every lane is designed with flight.ts (the speed a car carries,
//  where it lands), then placed: we try seeded spots and headings
//  and keep one only if
//    - nothing of it is on the road or within its run-off,
//    - it stays clear of billboards, crash props, energy cores, the
//      big-air hill's flight path and the other zones,
//    - the ground under every piece is flat enough that the piece
//      sits on it (a fitted plane, within a few centimetres), and
//    - the lane itself is gentle enough to drive (no big hills).
//  More zones go in until the park has about as many stunts as
//  the world is big (15-30).
// ============================================================

import type { TrackRuntime } from '../../track/types'
import { BIGAIR_LAYOUT } from '../../track/terrain'
import { hashString, mulberry32, shuffleInPlace } from '../random'
import { apexIndex, directionAt, flightFrom, KICKER_POP, landingIndex, lipSpeedFor, scoringBand, speedAtLip } from './flight'
import type { FlightPath, FlightTarget } from './flight'
import { ZONE } from './parkGeometry'
import type { ExtrudeSpec, PadSpec, PieceFrame, ProfilePoint } from './parkGeometry'

// ---------------------------------------------------------------- the result

export type ParkItemKind = 'kicker' | 'table' | 'gap' | 'mega' | 'quarter' | 'halfpipe' | 'target' | 'ring'

/** One stunt, for the inspector, the probes and the world map. */
export interface ParkItem {
  id: number
  kind: ParkItemKind
  zone: number
  label: string
  /** Where to start a run at it: a point on the lane's centre line, and the way to drive. */
  runX: number
  runZ: number
  dx: number
  dz: number
  /** How far (metres) from that point to the piece's front (or the ring / target). */
  runIn: number
  /** The speed it was designed around, km/h (0 = any): how fast you reach the foot of the ramp, coasting up it. */
  designKmh: number
  /**
   * A launch's speed sign, km/h (0 = none): the speed to LEAVE its lip at, painted on its face and
   * used by the HUD's speed cue. It is a lip speed (worked out from where the launch and its
   * targets really stand: fitSigns), so it holds however you drive up the ramp: with the throttle
   * down a small kicker speeds you up and the mega ramp's climb slows you, so keep the speedo on
   * this number up the face.
   */
  signKmh: number
  /** A reference point on the piece (its lip, the ring's centre, the target's centre). */
  x: number
  y: number
  z: number
}

export interface ParkRing {
  id: number
  item: number
  zone: number
  x: number
  y: number
  z: number
  /** Unit normal of the ring's plane: the way a car flies through it. */
  nx: number
  ny: number
  nz: number
  radius: number
}

export interface ParkTarget {
  id: number
  item: number
  zone: number
  x: number
  y: number
  z: number
  outer: number
  inner: number
}

/** A box in a piece frame: a0..a1 along it, |l| <= hw across. */
export interface FrameBox {
  frame: PieceFrame
  a0: number
  a1: number
  hw: number
}

/** A named jump: take off from `launch`, touch down in `landing` (upright) and it scores. */
export interface ParkJump {
  id: number
  item: number
  zone: number
  kind: 'gap' | 'mega'
  name: string
  points: number
  launch: FrameBox
  landing: FrameBox
}

export interface ParkZone {
  id: number
  kind: 'mega' | 'table' | 'gaps' | 'kickers' | 'pipes'
  name: string
  /** The lane: where its run-in starts, its heading, length and half width. */
  x: number
  z: number
  dx: number
  dz: number
  length: number
  halfWidth: number
}

export interface ParkLayout {
  trackId: string
  seed: number
  /**
   * The road has barriers on both edges (a stadium like the Hyperdrome), so the park sits in the
   * infield where no car can drive to: Stunt Attack starts there, R inside it returns to a park
   * spot, and the pause menu hops in and out (parkReset.ts).
   */
  enclosed: boolean
  zones: ParkZone[]
  items: ParkItem[]
  /** Solid pieces (each also a physics solid), and the bullseyes (paint on the ground: no physics). */
  solids: (ExtrudeSpec & { item: number })[]
  pads: (PadSpec & { item: number })[]
  rings: ParkRing[]
  targets: ParkTarget[]
  jumps: ParkJump[]
  /** How long the layout took to work out, ms. */
  buildMs: number
  /** Zones tried and not placed (no room), for the inspector. */
  skipped: string[]
}

export interface ParkKnobs {
  /** The mega ramp's height, metres (config.ts megaRampHeight). */
  megaHeight: number
}

// ---------------------------------------------------------------- lane plans (lane coordinates)

/** A solid piece in a lane: its own side view starts at lane distance a0, l0 metres right of the centre line. */
interface PlanSolid {
  kind: ParkItemKind
  label: string
  a0: number
  l0: number
  /** Heading relative to the lane: 0 = along it, 1 = facing right (+l), -1 = facing left. */
  turn: 0 | 1 | -1
  top: ProfilePoint[]
  zones: number[]
  halfWidth: number
  sideRun: number
  drapeFront: number
  drapeBack: number
  lips: number[]
  catches: number[]
  designKmh: number
  /** Its speed sign (km/h to leave the lip at, 0 = none): see ParkItem.signKmh. */
  signKmh: number
  /**
   * The bullseye pad (index into the plan's pads) the sign aims at, -1 = none. Once placed, the
   * pad sits on its own patch of ground, so the sign is worked out again from where it really is.
   */
  signPad: number
  /** Reference point for the item list (lane a, height above the piece's base). */
  refA: number
  refH: number
  /** False for the second half of a pair (a gap's landing): not its own item. */
  item: boolean
}

interface PlanPad {
  a: number
  l: number
  radius: number
  inner: number
  designKmh: number
}

interface PlanRing {
  a: number
  l: number
  /** Height above the base plane of solid `solid`, extended. */
  h: number
  /** Direction of flight in the lane's side view. */
  da: number
  dh: number
  solid: number
  radius: number
  designKmh: number
}

interface PlanJump {
  kind: 'gap' | 'mega'
  name: string
  points: number
  /** Solid indices of the launch and the landing, and the boxes in their own frames. */
  launch: number
  launchA0: number
  launchA1: number
  launchHw: number
  landing: number
  landA0: number
  landA1: number
  landHw: number
}

interface LanePlan {
  kind: ParkZone['kind']
  name: string
  length: number
  halfWidth: number
  /** The first stretch is run-in only (nothing built there): it may come closer to the road. */
  runIn: number
  solids: PlanSolid[]
  pads: PlanPad[]
  rings: PlanRing[]
  jumps: PlanJump[]
  /** Stunts it adds to the count. */
  count: number
}

// ---------------------------------------------------------------- side views

/** A launch curve: grows out of the ground (5 cm under it) and steepens to the lip: h = H (a / L)^p. */
function launchCurve(L: number, H: number, p: number, a0 = 0): ProfilePoint[] {
  const out: ProfilePoint[] = []
  const n = Math.max(6, Math.ceil(L / 1.2))
  for (let i = 0; i <= n; i++) {
    const f = i / n
    out.push({ a: a0 + L * f, h: -0.05 + (H + 0.05) * Math.pow(f, p) })
  }
  return out
}

/** Slope (rise per metre) at the lip of launchCurve. */
function lipSlope(L: number, H: number, p: number): number {
  return (p * (H + 0.05)) / L
}

/**
 * From a flat deck at height H (starting at a0, running `deck` metres), round over a knuckle of
 * radius R and run down at `deg` degrees to the ground (5 cm under it). Returns the points after
 * (a0, H) and the a where the slope reaches the ground.
 */
function deckAndLanding(a0: number, H: number, deck: number, R: number, deg: number, out: ProfilePoint[]): number {
  out.push({ a: a0 + deck, h: H })
  const b = (deg * Math.PI) / 180
  const steps = Math.max(3, Math.ceil(deg / 4))
  for (let i = 1; i <= steps; i++) {
    const t = (b * i) / steps
    out.push({ a: a0 + deck + R * Math.sin(t), h: H - R * (1 - Math.cos(t)) })
  }
  const last = out[out.length - 1]
  const run = (last.h + 0.05) / Math.tan(b)
  const end = last.a + run
  // Cut the straight slope into ~2 m pieces (the builder would anyway; this keeps catches exact).
  const n = Math.max(1, Math.ceil(run / 2))
  for (let i = 1; i <= n; i++) out.push({ a: last.a + (run * i) / n, h: last.h - ((last.h + 0.05) * i) / n })
  return end
}

/** Arc length along a side view up to point index i. */
function arcTo(top: ProfilePoint[], i: number): number {
  let s = 0
  for (let k = 0; k < i; k++) s += Math.hypot(top[k + 1].a - top[k].a, top[k + 1].h - top[k].h)
  return s
}

/** Arc length of a whole side view. */
function arcOf(top: ProfilePoint[]): number {
  return arcTo(top, top.length - 1)
}

/**
 * A quarter pipe's side view: from the ground, a circle of radius R curving up to `lipDeg`, a
 * short straight `ext` metres on at that angle to the coping, a flat deck, then a landing slope
 * down the back. Steep but not vertical on purpose: a car in the air levels itself out (unless
 * you hold the handbrake for tricks), so off a vertical wall it came down level against the wall
 * and caught its body on it (a wipeout from a clean run at 100 km/h). Off a steep lip it flies
 * up and a little forward, over the coping, and lands on the deck or the slope behind.
 */
function pipeWall(R: number, lipDeg: number, ext: number, deck: number, backDeg: number): { top: ProfilePoint[]; zones: number[]; coping: number; length: number; height: number } {
  const top: ProfilePoint[] = [{ a: 0, h: -0.05 }]
  const lip = (lipDeg * Math.PI) / 180
  const steps = Math.ceil(lipDeg / 5)
  for (let i = 1; i <= steps; i++) {
    const t = (lip * i) / steps
    top.push({ a: R * Math.sin(t), h: -0.05 + R * (1 - Math.cos(t)) })
  }
  const end = top[top.length - 1]
  top.push({ a: end.a + ext * Math.cos(lip), h: end.h + ext * Math.sin(lip) })
  const pipeSegs = top.length - 1
  const coping = arcOf(top)
  const H = top[top.length - 1].h
  const deckFrom = top[top.length - 1].a
  const length = deckAndLanding(deckFrom, H, deck, 4, backDeg, top)
  const zones = top.slice(1).map((_, i) => (i < pipeSegs ? ZONE.pipe : i === pipeSegs ? ZONE.deck : ZONE.landing))
  return { top, zones, coping, length, height: H }
}

// ---------------------------------------------------------------- lane templates

function solid(p: Partial<PlanSolid> & Pick<PlanSolid, 'kind' | 'label' | 'a0' | 'top' | 'zones' | 'halfWidth'>): PlanSolid {
  return {
    l0: 0,
    turn: 0,
    sideRun: 0,
    drapeFront: 0,
    drapeBack: 0,
    lips: [],
    catches: [],
    designKmh: 0,
    signKmh: 0,
    signPad: -1,
    refA: p.a0,
    refH: 0,
    item: true,
    ...p,
  }
}

/** A launch's first speed sign: the speed (km/h, whole) a car built for `kmh` at the ramp's foot leaves its `H` metre lip at (fitSigns refines it once placed). */
function signFor(kmh: number, H: number): number {
  return Math.round(speedAtLip(kmh, H) * 3.6)
}

/** Where a flight off a lip at lane a=lipA first meets the flat ground (lane a). */
function flatLanding(f: FlightPath, lipA: number): number {
  const i = landingIndex(f, () => 0)
  return lipA + (i > 0 ? f.a[i] : f.a[f.a.length - 1])
}

/** A ring on a flight path at a fraction of the way to its flat landing. */
function ringOn(f: FlightPath, lipA: number, frac: number, solidIndex: number, radius: number, kmh: number): PlanRing {
  const land = landingIndex(f, () => 0)
  const end = land > 0 ? land : f.a.length - 1
  const i = Math.max(1, Math.min(end - 1, Math.round(end * frac)))
  const [da, dh] = directionAt(f, i)
  // Heights in the plan are above the launch piece's base plane, which runs under the lip too.
  return { a: lipA + f.a[i], l: 0, h: f.h[i], da, dh, solid: solidIndex, radius, designKmh: kmh }
}

function kickerPlan(short: boolean): LanePlan {
  const runIn = 45
  const solids: PlanSolid[] = []
  const pads: PlanPad[] = []
  const rings: PlanRing[] = []
  let a = runIn
  const kick = (L: number, H: number, hw: number, label: string, kmh: number) => {
    const p = 1.6
    const top = launchCurve(L, H, p)
    solids.push(solid({ kind: 'kicker', label, a0: a, top, zones: top.slice(1).map(() => ZONE.launch), halfWidth: hw, sideRun: 1.4, drapeFront: 3, lips: [arcOf(top)], designKmh: kmh, signKmh: signFor(kmh, H), refA: a + L, refH: H }))
    const lipA = a + L
    return { lipA, f: flightFrom(kmh, H, lipSlope(L, H, p)), H }
  }
  // Kicker 1 and its bullseye where a 90 km/h run lands.
  const k1 = kick(8, 1.3, 4, 'KICKER', 90)
  const t1 = flatLanding(k1.f, k1.lipA)
  pads.push({ a: t1, l: 0, radius: 6.5, inner: 2.6, designKmh: 90 })
  solids[solids.length - 1].signPad = pads.length - 1
  a = t1 + 6.5 + 22
  // Kicker 2 with a ring at the top of a 100 km/h flight.
  const k2 = kick(10, 1.8, 4.5, 'KICKER', 100)
  const ap = apexIndex(k2.f)
  const [da, dh] = directionAt(k2.f, ap)
  rings.push({ a: k2.lipA + k2.f.a[ap], l: 0, h: k2.f.h[ap], da, dh, solid: solids.length - 1, radius: 4, designKmh: 100 })
  a = flatLanding(k2.f, k2.lipA) + 25
  let length = a + 30
  let count = 4
  if (!short) {
    // Kicker 3 (the big one) with a bullseye at 110 km/h, then a quarter pipe to turn round on.
    const k3 = kick(11, 2.3, 5, 'BIG KICKER', 110)
    const t3 = flatLanding(k3.f, k3.lipA)
    pads.push({ a: t3, l: 0, radius: 6.5, inner: 2.6, designKmh: 110 })
    solids[solids.length - 1].signPad = pads.length - 1
    a = t3 + 6.5 + 32
    const qp = pipeWall(7, 64, 1.5, 9, 24)
    solids.push(solid({ kind: 'quarter', label: 'QUARTER PIPE', a0: a, top: qp.top, zones: qp.zones, halfWidth: 8, drapeFront: 3, drapeBack: 3, lips: [qp.coping], designKmh: 0, refA: a + 7, refH: qp.height }))
    // Room behind it: a fast run flies over the deck and comes down well past the back.
    length = a + qp.length + 45
    count = 7
  }
  return { kind: 'kickers', name: 'KICKER ALLEY', length, halfWidth: 9, runIn, solids, pads, rings, jumps: [], count }
}

function tablePlan(): LanePlan {
  const runIn = 70
  const L = 16
  const H = 3.8
  const p = 1.7
  const kmhDeck = 95 // the deck catches anything up to about this
  const kmhRings = 115
  const top = launchCurve(L, H, p)
  const lipArc = arcOf(top)
  const fDeck = flightFrom(kmhDeck, H, lipSlope(L, H, p))
  const iDeck = landingIndex(fDeck, (x) => (x > 2 ? H : -Infinity))
  const deck = Math.max(20, (iDeck > 0 ? fDeck.a[iDeck] : 40) - 6)
  const zones: number[] = top.slice(1).map(() => ZONE.launch)
  const n0 = top.length
  const end = deckAndLanding(L, H, deck, 8, 22, top)
  const catchArc = arcTo(top, n0) // the deck's far end, where the landing begins
  for (let i = n0; i < top.length; i++) zones.push(i === n0 ? ZONE.deck : ZONE.landing)
  const solids = [solid({ kind: 'table', label: 'SKY TABLE', a0: runIn, top, zones, halfWidth: 6.5, drapeFront: 3, drapeBack: 3, lips: [lipArc], catches: [catchArc], designKmh: kmhRings, signKmh: signFor(kmhRings, H), refA: runIn + L, refH: H })]
  const f = flightFrom(kmhRings, H, lipSlope(L, H, p))
  const lipA = runIn + L
  const rings = [ringOn(f, lipA, 0.3, 0, 4.2, kmhRings), ringOn(f, lipA, 0.62, 0, 4.2, kmhRings)]
  // A bullseye on the flat beyond the table, where a 140 km/h run lands.
  const pads: PlanPad[] = []
  const fFar = flightFrom(140, H, lipSlope(L, H, p))
  const far = flatLanding(fFar, lipA)
  const tableEnd = runIn + end
  let length = tableEnd + 70
  if (far > tableEnd + 9) {
    pads.push({ a: far, l: 0, radius: 7, inner: 2.8, designKmh: 140 })
    length = Math.max(length, far + 50)
  }
  return { kind: 'table', name: 'SKY TABLE', length, halfWidth: 11, runIn, solids, pads, rings, jumps: [], count: 1 + rings.length + pads.length }
}

function gapsPlan(names: string[]): LanePlan {
  const runIn = 60
  const solids: PlanSolid[] = []
  const rings: PlanRing[] = []
  const jumps: PlanJump[] = []
  let a = runIn
  const gap = (L: number, H: number, gapLen: number, landH: number, name: string, points: number, ring: boolean) => {
    const p = 1.6
    const top = launchCurve(L, H, p)
    // Its sign: the ring's speed when there is one over the gap, else the speed the landing is built for.
    const sign = signFor(ring ? 110 : 100, H)
    solids.push(solid({ kind: 'gap', label: name, a0: a, top, zones: top.slice(1).map(() => ZONE.launch), halfWidth: 5, drapeFront: 3, lips: [arcOf(top)], designKmh: ring ? 110 : 100, signKmh: sign, refA: a + L, refH: H }))
    const launch = solids.length - 1
    const lipA = a + L
    // The landing: its back is a wall facing the gap, then a short deck and the slope down.
    const land: ProfilePoint[] = [{ a: 0, h: landH }]
    const end = deckAndLanding(0, landH, 6, 6, 22, land)
    const landZones = land.slice(1).map((_, i) => (i === 0 ? ZONE.deck : ZONE.landing))
    solids.push(solid({ kind: 'gap', label: name, a0: lipA + gapLen, top: land, zones: landZones, halfWidth: 6.5, drapeBack: 3, catches: [0], item: false, refA: lipA + gapLen, refH: landH }))
    const landing = solids.length - 1
    jumps.push({ kind: 'gap', name, points, launch, launchA0: L - 6, launchA1: L + 9, launchHw: 6, landing, landA0: -0.5, landA1: end + 90, landHw: 9 })
    if (ring) {
      const f = flightFrom(110, H, lipSlope(L, H, p))
      // Over the middle of the gap.
      let i = 1
      while (i < f.a.length - 1 && f.a[i] < gapLen / 2) i++
      const [da, dh] = directionAt(f, i)
      rings.push({ a: lipA + f.a[i], l: 0, h: f.h[i], da, dh, solid: launch, radius: 4.2, designKmh: 110 })
    }
    a = lipA + gapLen + end + 45
  }
  gap(12, 2.8, 18, 2.5, names[0], 500, false)
  gap(14, 3.4, 28, 3.0, names[1], 800, true)
  return { kind: 'gaps', name: 'CANYON RUN', length: a + 25, halfWidth: 10, runIn, solids, pads: [], rings, jumps, count: 2 + rings.length }
}

function megaPlan(height: number, name: string, runIn = 160): LanePlan {
  const H = height
  const L = 3.5 * H
  const p = 1.7
  const kmh = 140
  const top = launchCurve(L, H, p)
  const lipA = runIn + L
  const slope = lipSlope(L, H, p)
  const solids: PlanSolid[] = [solid({ kind: 'mega', label: name, a0: runIn, top, zones: top.slice(1).map(() => ZONE.launch), halfWidth: 7, drapeFront: 4, lips: [arcOf(top)], designKmh: kmh, signKmh: signFor(kmh, H), refA: lipA, refH: H })]
  // The landing hill: a gentle back (so falling short still lands on something you can drive),
  // a deck, a knuckle, and the slope you are meant to land on.
  const LH = 0.5 * H
  const backRun = LH / Math.tan((18 * Math.PI) / 180)
  const land: ProfilePoint[] = [{ a: 0, h: -0.05 }, { a: backRun * 0.5, h: LH * 0.5 - 0.025 }, { a: backRun, h: LH }]
  const n0 = land.length
  const end = deckAndLanding(backRun, LH, 6, 10, 24, land)
  const landZones = land.slice(1).map((_, i) => (i < n0 - 1 ? ZONE.plain : i === n0 - 1 ? ZONE.deck : ZONE.landing))
  const catchArc = arcTo(land, n0)
  // Put the landing so the design flight comes down a third of the way down its slope.
  const f = flightFrom(kmh, H, slope)
  const slopeTop = backRun + 6 + 10 * Math.sin((24 * Math.PI) / 180)
  const slopeH = LH - 10 * (1 - Math.cos((24 * Math.PI) / 180))
  const aimH = slopeH * 0.62
  let i = apexIndex(f)
  while (i < f.a.length - 1 && f.h[i] - 0.55 > aimH) i++
  const aimA = f.a[i] // metres past the lip where the wheels reach aimH
  const aimRun = slopeTop + ((slopeH - aimH) / Math.tan((24 * Math.PI) / 180))
  const landA0 = Math.max(lipA + 20, lipA + aimA - aimRun)
  solids.push(solid({ kind: 'mega', label: name, a0: landA0, top: land, zones: landZones, halfWidth: 10, drapeFront: 4, drapeBack: 4, catches: [catchArc], item: false, refA: landA0 + backRun, refH: LH }))
  const rings = [ringOn(f, lipA, 0.22, 0, 4.6, kmh), ringOn(f, lipA, 0.45, 0, 4.6, kmh), ringOn(f, lipA, 0.66, 0, 4.6, kmh)]
  const jumps: PlanJump[] = [
    { kind: 'mega', name, points: 1500, launch: 0, launchA0: L - 8, launchA1: L + 12, launchHw: 8, landing: 1, landA0: backRun - 1, landA1: end + 160, landHw: 14 },
  ]
  // A bullseye for the brave: where a 165 km/h run comes down, if that is past the landing.
  const pads: PlanPad[] = []
  const fFar = flightFrom(165, H, slope)
  const far = flatLanding(fFar, lipA)
  const landEnd = landA0 + end
  let length = landEnd + 90
  if (far > landEnd + 10) {
    pads.push({ a: far, l: 0, radius: 7.5, inner: 3, designKmh: 165 })
    length = Math.max(length, far + 50)
  }
  return { kind: 'mega', name: 'MEGA RAMP', length, halfWidth: 14, runIn, solids, pads, rings, jumps, count: 1 + rings.length + pads.length }
}

/** A quarter pipe on its own (when a world has no room for the half pipe). */
function quarterPlan(): LanePlan {
  const runIn = 45
  const qp = pipeWall(7, 64, 1.5, 9, 24)
  const solids = [solid({ kind: 'quarter', label: 'QUARTER PIPE', a0: runIn, top: qp.top, zones: qp.zones, halfWidth: 8, drapeFront: 3, drapeBack: 3, lips: [qp.coping], refA: runIn + 7, refH: qp.height })]
  return { kind: 'pipes', name: 'QUARTER PIPE', length: runIn + qp.length + 45, halfWidth: 10, runIn, solids, pads: [], rings: [], jumps: [], count: 1 }
}

function pipesPlan(): LanePlan {
  const runIn = 40
  const channel = 50
  const floor = 13
  const wall = pipeWall(6.5, 64, 1.0, 3.5, 30)
  const solids: PlanSolid[] = []
  for (const side of [-1, 1] as const) {
    solids.push(
      solid({
        kind: 'halfpipe',
        label: 'HALF PIPE',
        a0: runIn + channel / 2,
        l0: (side * floor) / 2,
        turn: side,
        top: wall.top,
        zones: wall.zones,
        halfWidth: channel / 2,
        drapeFront: 3,
        drapeBack: 3,
        lips: [wall.coping],
        item: side < 0,
        refA: runIn + channel / 2,
        refH: wall.height,
      }),
    )
  }
  return { kind: 'pipes', name: 'HALF PIPE', length: runIn + channel + 30, halfWidth: floor / 2 + wall.length + 4, runIn, solids, pads: [], rings: [], jumps: [], count: 1 }
}

// ---------------------------------------------------------------- placing a lane

const GAP_NAMES = ['NEON CANYON GAP', 'SUNSET LEAP', 'STARFALL GAP', 'LASER LEAP', 'HORIZON HOP', 'CHROME CANYON', 'MIDNIGHT GAP', 'VOID HOP', 'GRID JUMP', 'AFTERBURN GAP']
/** The car's middle must pass this far inside a ring's tube to count (metres; the scoring uses it too). */
export const RING_MARGIN = 0.35
/** Clearance from the road's edge: built pieces, and a lane's run-in. */
const CLEAR_ITEMS = 24
const CLEAR_RUNIN = 7
/** How far (metres) a solid's ground may stray from its fitted plane, and a pad's. */
const FLAT_SOLID = 0.3
const FLAT_PAD = 0.12
/** How far (metres) a bullseye's dark disc reaches past its outer ring. */
const PAD_MARGIN = 0.45
/** Steepest base plane, along and across (rise per metre). */
const MAX_SLOPE = 0.08
const CANDIDATES = 260

interface Rect {
  x: number
  z: number
  dx: number
  dz: number
  a0: number
  a1: number
  hw: number
}

/** Is (x, z) inside a lane rectangle grown by `m` metres? */
function inRect(r: Rect, x: number, z: number, m: number): boolean {
  const px = x - r.x
  const pz = z - r.z
  const a = px * r.dx + pz * r.dz
  const l = -px * r.dz + pz * r.dx
  return a >= r.a0 - m && a <= r.a1 + m && Math.abs(l) <= r.hw + m
}

/** Do two lane rectangles come within `m` of each other? (Corner and centre tests both ways.) */
function rectsNear(p: Rect, q: Rect, m: number): boolean {
  const pts = (r: Rect): [number, number][] => {
    const out: [number, number][] = []
    for (const a of [r.a0, (r.a0 + r.a1) / 2, r.a1]) for (const l of [-r.hw, 0, r.hw]) out.push([r.x + r.dx * a - r.dz * l, r.z + r.dz * a + r.dx * l])
    // Along long sides every 20 m too.
    for (let a = r.a0; a <= r.a1; a += 20) for (const l of [-r.hw, r.hw]) out.push([r.x + r.dx * a - r.dz * l, r.z + r.dz * a + r.dx * l])
    return out
  }
  for (const [x, z] of pts(p)) if (inRect(q, x, z, m)) return true
  for (const [x, z] of pts(q)) if (inRect(p, x, z, m)) return true
  return false
}

/** Least-squares plane y = c + sa * a + sl * l through samples (a, l, y). */
function fitPlane(samples: number[]): { c: number; sa: number; sl: number } {
  let n = 0
  let sa = 0
  let sl = 0
  let sy = 0
  let saa = 0
  let sll = 0
  let sal = 0
  let say = 0
  let sly = 0
  for (let i = 0; i < samples.length; i += 3) {
    const a = samples[i]
    const l = samples[i + 1]
    const y = samples[i + 2]
    n++
    sa += a
    sl += l
    sy += y
    saa += a * a
    sll += l * l
    sal += a * l
    say += a * y
    sly += l * y
  }
  // Solve the 3x3 normal equations by Cramer's rule.
  const m = [n, sa, sl, sa, saa, sal, sl, sal, sll]
  const r = [sy, say, sly]
  const det3 = (q: number[]) => q[0] * (q[4] * q[8] - q[5] * q[7]) - q[1] * (q[3] * q[8] - q[5] * q[6]) + q[2] * (q[3] * q[7] - q[4] * q[6])
  const D = det3(m)
  if (Math.abs(D) < 1e-9) return { c: n ? sy / n : 0, sa: 0, sl: 0 }
  const col = (k: number) => m.map((v, i) => (i % 3 === k ? r[Math.floor(i / 3)] : v))
  return { c: det3(col(0)) / D, sa: det3(col(1)) / D, sl: det3(col(2)) / D }
}

interface PlaceContext {
  t: TrackRuntime
  hit: { s: number; index: number; lateral: number; height: number; distance: number; onRoad: boolean }
  placed: Rect[]
  zones: ParkZone[]
  radius: number
  /** Extra no-go test (big-air runs). */
  keepOut: (x: number, z: number) => boolean
  /** On a walled road: true inside the infield (every lane must be). */
  inside: ((x: number, z: number) => boolean) | null
  avoid: { x: number; z: number; r: number }[]
}

/** Metres from (x, z) on the ground to the road's edge (negative = on the road). */
function roadGap(c: PlaceContext, x: number, z: number): number {
  const y = c.t.terrainHeight(x, z)
  c.t.nearest(x, y, z, c.hit)
  const hw = c.t.samples.halfWidth[c.hit.index] ?? 7
  // A road far above or below (a bridge's deck, a road in a cutting) still counts as near.
  return Math.hypot(Math.max(0, Math.abs(c.hit.lateral) - hw), Math.max(0, Math.abs(c.hit.height) - 14))
}

interface PlacedSolid {
  spec: ExtrudeSpec & { item: number }
  plan: PlanSolid
}

/** Try one lane position; returns everything placed, or null if it doesn't fit. */
function tryLane(c: PlaceContext, plan: LanePlan, x: number, z: number, dx: number, dz: number): { solids: PlacedSolid[]; pads: PadSpec[] } | null {
  const t = c.t
  const rect: Rect = { x, z, dx, dz, a0: 0, a1: plan.length, hw: plan.halfWidth }
  const W = (a: number, l: number): [number, number] => [x + dx * a - dz * l, z + dz * a + dx * l]
  // 1. Inside the world (a margin short of the edge).
  for (const [a, l] of [[0, -rect.hw], [0, rect.hw], [rect.a1, -rect.hw], [rect.a1, rect.hw]]) {
    const [px, pz] = W(a, l)
    if (Math.hypot(px, pz) > c.radius) return null
  }
  // 2. Other zones.
  for (const r of c.placed) if (rectsNear(rect, r, 18)) return null
  // 3. A drivable lane: along its centre the ground stays near a straight line and isn't steep.
  // (Ground heights are cheap, so this goes before the road tests.)
  {
    const ys: number[] = []
    for (let a = 0; a <= rect.a1; a += 8) {
      const [px, pz] = W(a, 0)
      ys.push(t.terrainHeight(px, pz))
    }
    const k = (ys[ys.length - 1] - ys[0]) / (8 * (ys.length - 1))
    if (Math.abs(k) > 0.07) return null
    for (let i = 0; i < ys.length; i++) if (Math.abs(ys[i] - (ys[0] + k * 8 * i)) > 3) return null
    for (const a of [0, rect.a1 / 2, rect.a1]) {
      const [lx, lz] = W(a, -rect.hw)
      const [rx2, rz2] = W(a, rect.hw)
      if (Math.abs(t.terrainHeight(rx2, rz2) - t.terrainHeight(lx, lz)) / (2 * rect.hw) > 0.08) return null
    }
  }
  // 4. Road clearance, keep-outs and things beside the road, over the whole lane: a coarse pass
  // first (most spots that fail, fail there), then every 8 m.
  for (const step of [32, 8]) {
    for (let a = 0; a <= rect.a1; a += step) {
      for (const l of [-rect.hw, 0, rect.hw]) {
        const [px, pz] = W(a, l)
        if (c.keepOut(px, pz)) return null
        if (c.inside && !c.inside(px, pz)) return null
        for (const v of c.avoid) if ((px - v.x) ** 2 + (pz - v.z) ** 2 < v.r * v.r) return null
        const gap = roadGap(c, px, pz)
        if (gap < (a < plan.runIn - 4 ? CLEAR_RUNIN : CLEAR_ITEMS)) return null
      }
    }
  }
  // 5. Every piece sits flat on its own patch of ground.
  const solids: PlacedSolid[] = []
  for (const s of plan.solids) {
    // The piece's frame: its origin and heading in the world.
    let fdx = dx
    let fdz = dz
    if (s.turn !== 0) {
      // Facing right (+l) or left (-l) of the lane.
      fdx = -dz * s.turn
      fdz = dx * s.turn
    }
    const [ox, oz] = W(s.a0, s.l0)
    const len = s.top[s.top.length - 1].a
    let maxH = 0
    for (const p of s.top) maxH = Math.max(maxH, p.h)
    const reach = s.halfWidth + s.sideRun * maxH
    const samples: number[] = []
    for (let a = 0; a <= len + 1e-6; a += Math.max(1.5, len / 24)) {
      for (let l = -reach; l <= reach + 1e-6; l += Math.max(1.5, reach / 4)) {
        const px = ox + fdx * a - fdz * l
        const pz = oz + fdz * a + fdx * l
        samples.push(a, l, t.terrainHeight(px, pz))
      }
    }
    const pl = fitPlane(samples)
    if (Math.abs(pl.sa) > MAX_SLOPE || Math.abs(pl.sl) > MAX_SLOPE) return null
    for (let i = 0; i < samples.length; i += 3) {
      if (Math.abs(samples[i + 2] - (pl.c + pl.sa * samples[i] + pl.sl * samples[i + 1])) > FLAT_SOLID) return null
    }
    const frame: PieceFrame = { ox, oz, dx: fdx, dz: fdz, y0: pl.c, sa: pl.sa, sl: pl.sl }
    solids.push({
      plan: s,
      spec: {
        frame,
        top: s.top,
        zones: s.zones,
        halfWidth: s.halfWidth,
        sideRun: s.sideRun,
        sink: Math.max(0.8, FLAT_SOLID + 0.5),
        drapeFront: s.drapeFront,
        drapeBack: s.drapeBack,
        lips: s.lips,
        catches: s.catches,
        signKmh: s.signKmh,
        item: -1,
      },
    })
  }
  const pads: PadSpec[] = []
  for (const p of plan.pads) {
    const [ox, oz] = W(p.a, p.l)
    const R = p.radius + 1.6
    const samples: number[] = []
    for (let a = -R; a <= R + 1e-6; a += R / 4) {
      for (let l = -R; l <= R + 1e-6; l += R / 4) {
        if (a * a + l * l > R * R * 1.05) continue
        samples.push(a, l, t.terrainHeight(ox + dx * a - dz * l, oz + dz * a + dx * l))
      }
    }
    const pl = fitPlane(samples)
    if (Math.abs(pl.sa) > 0.06 || Math.abs(pl.sl) > 0.06) return null
    for (let i = 0; i < samples.length; i += 3) {
      if (Math.abs(samples[i + 2] - (pl.c + pl.sa * samples[i] + pl.sl * samples[i + 1])) > FLAT_PAD) return null
    }
    // The bullseye is paint on this ground (parkGeometry.ts buildPadDecal): a landing on it touches
    // down on the ground itself, so its height is the ground's at the middle.
    pads.push({ frame: { ox, oz, dx, dz, y0: pl.c, sa: pl.sa, sl: pl.sl }, radius: p.radius, inner: p.inner, margin: PAD_MARGIN, centreY: t.terrainHeight(ox, oz) })
  }
  return { solids, pads }
}

/** Inside the road's loop (the infield), from the minimap's centre line: an even-odd ray test. */
function insideRoad(t: TrackRuntime): (x: number, z: number) => boolean {
  const p = t.minimap.path
  const n = p.length / 2
  return (x: number, z: number) => {
    let inside = false
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = p[i * 2]
      const zi = p[i * 2 + 1]
      const xj = p[j * 2]
      const zj = p[j * 2 + 1]
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside
    }
    return inside
  }
}

/** The big-air hill and its flight path, as a no-go test. */
function bigAirKeepOut(t: TrackRuntime): (x: number, z: number) => boolean {
  const runs = t.file.environment.terrain.features.filter((f) => f.type === 'bigAir')
  return (x: number, z: number) => {
    for (const f of runs) {
      if (f.type !== 'bigAir') continue
      const k = f.scale ?? 1
      const hd = (f.headingDeg * Math.PI) / 180
      const ax = Math.sin(hd)
      const az = -Math.cos(hd)
      const u = (x - f.x) * ax + (z - f.z) * az
      const v = -(x - f.x) * az + (z - f.z) * ax
      if (Math.hypot(u - BIGAIR_LAYOUT.bigHillU * k, v) < (BIGAIR_LAYOUT.bigHillRadius + 25) * k) return true
      if (u > (BIGAIR_LAYOUT.kickerFootU - 30) * k && u < (BIGAIR_LAYOUT.kickerCrestU + 320) * k && Math.abs(v) < 70 * k) return true
    }
    return false
  }
}

// ---------------------------------------------------------------- the whole park

/** How many stunts a world this big should get (15 on a small world, up to 30 on a big one). */
export function stuntBudget(t: TrackRuntime): number {
  return Math.round(Math.min(30, Math.max(15, (t.world.size / 1800) * 28)))
}

/** Work out the stunt park for a track. Same track and knobs, same park. */
export function buildParkLayout(t: TrackRuntime, knobs: ParkKnobs): ParkLayout {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now()
  const seed = hashString(`${t.id}:stunt-park`)
  const rng = mulberry32(seed)
  const names = shuffleInPlace(GAP_NAMES.slice(), rng)
  const mega = Math.max(8, Math.min(30, Number.isFinite(knobs.megaHeight) ? knobs.megaHeight : 16))
  const avoid: PlaceContext['avoid'] = []
  for (const b of t.roadside.billboards) avoid.push({ x: b.x, z: b.z, r: 22 })
  for (const p of t.props) avoid.push({ x: p.x, z: p.z, r: 16 })
  for (const k of t.cores) avoid.push({ x: k.x, z: k.z, r: 9 })
  const walled = t.world.edge === 'wall'
  const enclosed = t.file.road.barriers === 'walls'
  const c: PlaceContext = {
    t,
    hit: { s: 0, index: 0, lateral: 0, height: 0, distance: 0, onRoad: false },
    placed: [],
    zones: [],
    // Ridge worlds: keep off the mountains' foothills (the flatness tests reject the slopes anyway).
    radius: walled ? t.world.playRadius - 30 : Math.min(t.world.half * 0.92, t.world.playRadius - 140),
    keepOut: bigAirKeepOut(t),
    avoid,
    inside: enclosed ? insideRoad(t) : null,
  }
  const budget = stuntBudget(t)
  const out: ParkLayout = { trackId: t.id, seed, enclosed, zones: [], items: [], solids: [], pads: [], rings: [], targets: [], jumps: [], buildMs: 0, skipped: [] }
  // The order zones are tried in: the mega ramp first (it needs the most room), then one of each,
  // then more kickers, tables and gaps until the world's budget is spent.
  // A pipe comes second: every park gets a half pipe, or at least a quarter pipe.
  const order: (() => LanePlan)[] = [
    () => megaPlan(mega, 'MEGA RAMP'),
    () => pipesPlan(),
    () => tablePlan(),
    () => gapsPlan(names.splice(0, 2)),
    () => kickerPlan(false),
    () => kickerPlan(true),
    () => gapsPlan(names.splice(0, 2)),
    () => tablePlan(),
    () => kickerPlan(true),
  ]
  let count = 0
  for (let z = 0; z < order.length && count < budget; z++) {
    let plan = order[z]()
    // The mega ramp shrinks until it fits (it's the one every park must have).
    // It looks harder for room, then shrinks (its run-in too) until it fits.
    let placed = placeLane(c, plan, rng, plan.kind === 'mega' ? 3 : 1)
    for (let shrink = 0.85; !placed && plan.kind === 'mega' && shrink >= 0.4; shrink -= 0.15) {
      plan = megaPlan(Math.max(7, mega * shrink), 'MEGA RAMP', Math.max(100, 160 * shrink))
      placed = placeLane(c, plan, rng, 3)
    }
    // No room for the half pipe: a quarter pipe on its own instead.
    if (!placed && plan.kind === 'pipes') {
      plan = quarterPlan()
      placed = placeLane(c, plan, rng, 2)
    }
    // A full kicker alley that won't fit tries its short form.
    if (!placed && plan.kind === 'kickers' && plan.count > 4) {
      plan = kickerPlan(true)
      placed = placeLane(c, plan, rng)
    }
    if (!placed) {
      out.skipped.push(plan.name)
      continue
    }
    emitLane(out, plan, placed)
    c.placed.push(placed.rect)
    count += plan.count
  }
  out.buildMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0
  return out
}

interface PlacedLane {
  rect: Rect
  solids: PlacedSolid[]
  pads: PadSpec[]
}

/** Try seeded spots and headings for a lane; keep the best that fits. */
function placeLane(c: PlaceContext, plan: LanePlan, rng: () => number, tries = 1): PlacedLane | null {
  const t = c.t
  let best: PlacedLane | null = null
  let bestScore = -Infinity
  let found = 0
  const tangent = { s: 0, index: 0, lateral: 0, height: 0, distance: 0, onRoad: false }
  for (let k = 0; k < CANDIDATES * tries && found < 14; k++) {
    // A point somewhere in the world...
    const r = c.radius * Math.sqrt(rng())
    const th = rng() * Math.PI * 2
    const cx = Math.cos(th) * r
    const cz = Math.sin(th) * r
    // ...and a heading: mostly along the nearest road (so you peel off into it), sometimes any.
    let hd: number
    const pick = rng()
    t.nearest(cx, t.terrainHeight(cx, cz), cz, tangent)
    const i = tangent.index
    const tx = t.samples.tx[i]
    const tz = t.samples.tz[i]
    if (pick < 0.65 && Number.isFinite(tx)) hd = Math.atan2(tz, tx) + (rng() < 0.5 ? 0 : Math.PI) + (rng() - 0.5) * 0.5
    else hd = rng() * Math.PI * 2
    const dx = Math.cos(hd)
    const dz = Math.sin(hd)
    // The candidate point is the lane's middle.
    const x = cx - dx * (plan.length / 2)
    const z = cz - dz * (plan.length / 2)
    const got = tryLane(c, plan, x, z, dx, dz)
    if (!got) continue
    found++
    // Score: the run-in starts near the road (easy to find), close to other zones (easy to link).
    const startGap = roadGap(c, x, z)
    let score = -Math.abs(startGap - 30) / 30
    if (c.placed.length) {
      let near = Infinity
      for (const p of c.placed) near = Math.min(near, Math.hypot((p.x + p.dx * p.a1 * 0.5) - cx, (p.z + p.dz * p.a1 * 0.5) - cz))
      score -= Math.max(0, near - 260) / 200
    }
    if (score > bestScore) {
      bestScore = score
      best = { rect: { x, z, dx, dz, a0: 0, a1: plan.length, hw: plan.halfWidth }, ...got }
    }
  }
  return best
}

/** Turn a placed lane into world-space items, solids, pads, rings, targets and jumps. */
function emitLane(out: ParkLayout, plan: LanePlan, placed: PlacedLane): void {
  const zoneId = out.zones.length
  const { x, z, dx, dz } = placed.rect
  out.zones.push({ id: zoneId, kind: plan.kind, name: plan.name, x, z, dx, dz, length: plan.length, halfWidth: plan.halfWidth })
  const W = (a: number, l: number): [number, number] => [x + dx * a - dz * l, z + dz * a + dx * l]
  const solidItem: number[] = []
  // Solids: a launch and its landing share one item.
  for (let i = 0; i < plan.solids.length; i++) {
    const ps = placed.solids[i]
    const s = ps.plan
    let item = -1
    if (s.item) {
      item = out.items.length
      const f = ps.spec.frame
      const refLocal = s.turn === 0 ? s.refA - s.a0 : 0
      const [rxw, rzw] = s.turn === 0 ? [f.ox + f.dx * refLocal, f.oz + f.dz * refLocal] : W(s.refA, 0)
      // A run at it starts on the lane's centre line, 40 m before it (150 m for the mega ramp;
      // the half pipe's channel from the lane's start).
      const runA = s.kind === 'halfpipe' ? 0 : Math.max(0, s.a0 - (s.kind === 'mega' ? 150 : 40))
      const [sx, sz] = W(runA, 0)
      out.items.push({
        id: item,
        kind: s.kind,
        zone: zoneId,
        label: s.label,
        runX: sx,
        runZ: sz,
        dx,
        dz,
        runIn: s.kind === 'halfpipe' ? plan.runIn : s.a0 - runA,
        designKmh: s.designKmh,
        signKmh: s.signKmh,
        x: rxw,
        y: f.y0 + f.sa * refLocal + s.refH,
        z: rzw,
      })
    } else {
      item = solidItem[solidItem.length - 1] ?? -1
    }
    solidItem.push(item)
    ps.spec.item = item
    out.solids.push(ps.spec)
  }
  // Pads (bullseye targets).
  for (let i = 0; i < plan.pads.length; i++) {
    const p = plan.pads[i]
    const spec = placed.pads[i]
    const item = out.items.length
    const [px, pz] = W(p.a, p.l)
    const y = spec.centreY
    out.items.push({ id: item, kind: 'target', zone: zoneId, label: 'BULLSEYE', runX: x, runZ: z, dx, dz, runIn: p.a, designKmh: p.designKmh, signKmh: 0, x: px, y, z: pz })
    out.pads.push({ ...spec, item })
    out.targets.push({ id: out.targets.length, item, zone: zoneId, x: px, y, z: pz, outer: p.radius, inner: p.inner })
  }
  // Rings, in the air above their launch piece's plane.
  const ringStart = out.rings.length
  for (const r of plan.rings) {
    const base = placed.solids[r.solid].spec.frame
    const local = r.a - plan.solids[r.solid].a0
    const [px, pz] = W(r.a, r.l)
    const y = base.y0 + base.sa * local + r.h
    // Flight direction in the world: along the lane (tilted with the launch plane) and up.
    let nx = dx * r.da
    let ny = base.sa * r.da + r.dh
    let nz = dz * r.da
    const L = Math.hypot(nx, ny, nz) || 1
    nx /= L
    ny /= L
    nz /= L
    const item = out.items.length
    out.items.push({ id: item, kind: 'ring', zone: zoneId, label: 'RING', runX: x, runZ: z, dx, dz, runIn: plan.solids[r.solid].a0, designKmh: r.designKmh, signKmh: 0, x: px, y, z: pz })
    out.rings.push({ id: out.rings.length, item, zone: zoneId, x: px, y, z: pz, nx, ny, nz, radius: r.radius })
  }
  // Named jumps.
  for (const j of plan.jumps) {
    const L = placed.solids[j.launch].spec.frame
    const D = placed.solids[j.landing].spec.frame
    out.jumps.push({
      id: out.jumps.length,
      item: solidItem[j.launch],
      zone: zoneId,
      kind: j.kind,
      name: j.name,
      points: j.points,
      launch: { frame: L, a0: j.launchA0, a1: j.launchA1, hw: j.launchHw },
      landing: { frame: D, a0: j.landA0, a1: j.landA1, hw: j.landHw },
    })
  }
  fitSigns(out, plan, placed, solidItem, ringStart)
}

/** Height of a side view at `a` (straight between its points). */
function profileAt(top: ProfilePoint[], a: number): number {
  if (a <= top[0].a) return top[0].h
  for (let i = 0; i < top.length - 1; i++) {
    if (a <= top[i + 1].a) return top[i].h + ((top[i + 1].h - top[i].h) * (a - top[i].a)) / Math.max(1e-6, top[i + 1].a - top[i].a)
  }
  return top[top.length - 1].h
}

/** The fastest speed the sign search looks at (km/h): a range still open there has no middle. */
const SIGN_SCAN_TOP = 220

/**
 * Paint each launch's sign for where it really stands. The plan worked its speeds out on level
 * ground; once placed, a launch can tilt a little and its pad or landing can sit a little higher
 * or lower, which moves the right speed by several km/h. So, from the placed pieces:
 *   - a kicker aimed at a bullseye: the lip speed that lands on the pad's middle
 *   - a launch whose rings and landing all score only inside a range of speeds (the mega ramp,
 *     a sky table): the middle of that range
 *   - anything else (one big ring, a plain gap: a very wide range): the plan's own number
 * Checked against the real car on 2026-10-03 (Afterglow): kicker bullseyes, the sky table's rings
 * and the mega ramp's rings plus landing all score when you leave the lip at the sign.
 */
function fitSigns(out: ParkLayout, plan: LanePlan, placed: PlacedLane, solidItem: number[], ringStart: number): void {
  for (let i = 0; i < plan.solids.length; i++) {
    const s = plan.solids[i]
    if (!s.item || s.signKmh <= 0) continue
    const spec = placed.solids[i].spec
    const f = spec.frame
    const top = s.top
    // The lip: the end of the launch face (a sky table's side view runs on into its deck).
    let n = 0
    while (n < s.zones.length && s.zones[n] === ZONE.launch) n++
    if (n < 1) continue
    const lipA = top[n].a
    const lipX = f.ox + f.dx * lipA
    const lipZ = f.oz + f.dz * lipA
    const lipY = f.y0 + f.sa * lipA + top[n].h
    const fwd = (x: number, z: number) => (x - lipX) * f.dx + (z - lipZ) * f.dz
    // The car leaves along the last stretch of the face; the base plane's tilt adds to it.
    const slope = (top[n].h - top[n - 1].h) / Math.max(1e-6, top[n].a - top[n - 1].a) + f.sa
    let kmh = s.signKmh
    if (s.signPad >= 0) {
      const pad = placed.pads[s.signPad]
      kmh = lipSpeedFor(fwd(pad.frame.ox, pad.frame.oz), slope + KICKER_POP, lipY - pad.centreY) * 3.6
    } else {
      const targets: FlightTarget[] = []
      for (let k = 0; k < plan.rings.length; k++) {
        if (plan.rings[k].solid !== i) continue
        const r = out.rings[ringStart + k]
        targets.push({ kind: 'ring', dist: fwd(r.x, r.z), rise: r.y - lipY, radius: r.radius - RING_MARGIN, na: r.nx * f.dx + r.nz * f.dz, nh: r.ny })
      }
      for (const j of plan.jumps) {
        if (j.launch !== i) continue
        // Its landing's near edge (where the named jump starts to count): clear it.
        const D = placed.solids[j.landing].spec.frame
        const lt = plan.solids[j.landing].top
        const a = Math.max(j.landA0, lt[0].a)
        const y = D.y0 + D.sa * a + profileAt(lt, a)
        targets.push({ kind: 'clear', dist: fwd(D.ox + D.dx * a, D.oz + D.dz * a), rise: y - lipY, radius: 0, na: 1, nh: 0 })
      }
      const band = targets.length > 0 ? scoringBand(slope, targets, 40, SIGN_SCAN_TOP) : null
      // Only a range that closes at both ends has a middle worth aiming at.
      if (band && band[1] < SIGN_SCAN_TOP) kmh = (band[0] + band[1]) / 2
    }
    const v = Math.round(kmh)
    if (!Number.isFinite(v) || v <= 0) continue
    spec.signKmh = v
    const item = out.items[solidItem[i]]
    if (item) item.signKmh = v
  }
}
