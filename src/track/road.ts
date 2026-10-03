// ============================================================
//  ROAD CENTRELINE - from control points to the sampled ribbon
// ------------------------------------------------------------
//  This is where a list of dots in the track file becomes a road:
//
//   1. Each control point gets a height: its own y, or the natural
//      ground smoothed over ~60 m (averagedHeight in terrain.ts) plus
//      its lift. That is where the road sits unbanked: it rides the
//      hills, but not every little bump on them.
//   2. A smooth closed spline runs through the points (spline.ts).
//   3. It is re-sampled every ~1 m, starting at the start line, so
//      s = 0 is the line by construction.
//   4. Corners get banked from their curvature (the faster the design
//      speed and the tighter the corner, the steeper, up to a cap),
//      with per-point overrides, smoothed so corners roll in and out.
//      A roll too quick for a car on the outer lanes at 250 km/h is
//      made longer (bankRolls.ts). An open road banks about its LOW
//      edge, which stays at the height step 1 gave (on the ground for
//      a road on the ground) while the high side rises; a road with
//      barriers banks about its middle.
//   5. Loops are spliced in: the road runs dead straight into the loop's
//      mouth, goes up and over a teardrop-shaped loop while drifting
//      across (a corkscrew, so the way in and the way out run side by
//      side), then eases back onto the original line over a long, gentle
//      S (LOOP_EXIT_EASE metres).
//   6. The result is re-sampled once more at an exact spacing, and each
//      sample gets its frame: tangent, up (the surface normal) and right.
//      Through a loop the frame's roll is spread evenly from mouth to
//      landing (spreadLoopRoll), so the road never twists hard.
//
//  Wall rides do not change the centreline: they add a curved wall on
//  the edge, recorded here as a sweep angle per sample (ribbon.ts
//  builds the wall itself).
// ============================================================

import type { ResolvedTrackFile, LoopPiece, WallRidePiece } from './schema'
import { SURFACE_CODE, type TrackSamples } from './types'
import { averagedHeight, shoulderHeight, type NaturalTerrain } from './terrain'
import { arcLengthAtParam, nodeAtLength, sampleClosedSpline } from './spline'
import { clamp, smoothstep } from './noise'
import { shapeBankRolls } from './bankRolls'
import { finishTunnels, planTunnelDigs, type TunnelKeepClear, type TunnelSamples } from './tunnels'

const G = 9.81
/** Target spacing of the final samples, metres. */
export const SAMPLE_SPACING = 1
/** A road this far (or less) above the natural ground is "grounded": the ground is filled up to it. */
export const FILL_MAX = 6
/**
 * Metres over which the road eases back onto its original line after a loop.
 * The loop comes down (width + 1) metres to one side of where it went up; the
 * exit then slides back across on a curve whose bend starts and ends at zero
 * (no sudden steering), peaking at about a 340 m radius for a 14 m road.
 * There is no slide BEFORE the loop: the road runs dead straight into the
 * mouth, so a car that simply aims down the straight goes in (a slide before
 * the mouth used to send straight-line cars into the underside of the loop's
 * way-out leg).
 */
export const LOOP_EXIT_EASE = 180
/** Straight road a loop needs before its mouth so cars arrive lined up (pins and checks use it). */
export const LOOP_RUN_IN = 80
/** Metres of clear air between a loop's way in and its way out, beside each other. */
const LOOP_LANE_GAP = 1
/** A bend's bank rolls out to flat over this many metres before a loop's run-in (and back in after it lands). */
const LOOP_BANK_EASE = 40
/**
 * A wall ride's wall grows in and fades out over this many metres at each end (an even S
 * from nothing to full height). Over 15 m the wall stood up in about half a car's length a
 * second at speed, so a car drifting toward it there met its rising end instead of riding up
 * onto it (Nathan: "you end up hitting the edge of them"): driven at it at 120-200 km/h with
 * the nose turned 6 degrees toward it, cars that reached the edge in the wall's first metres
 * crashed into it (body hits up to 14 kN s); over 40 m every one of those rides up it.
 */
export const WALL_RAMP = 40
/**
 * The wall stays at full height where it always did, from this far after a wall ride's `at` to
 * this far before its end (the ramps used to be 15 m and sit inside the piece), so the longer
 * ramps reach out WALL_RAMP - WALL_FULL_INSET metres before `at` and past the end.
 */
export const WALL_FULL_INSET = 15
/** How far a wall ride's wall reaches beyond the stretch its file gives (`at` to `at + length`), at each end. */
export const WALL_REACH = WALL_RAMP - WALL_FULL_INSET
/** How far round a wall ride's wall curls at full height (degrees past flat). */
export const WALL_SWEEP_DEG = 100
/**
 * A level start grid stays level: a bank roll never grows into the road from this many
 * metres behind the start line to this many after it (the grid is 12 slots, ~47 m long).
 */
const GRID_KEEP_BEHIND = 55
const GRID_KEEP_AHEAD = 15
/** A bend must turn at least this many degrees over 80 m to get any auto-bank, and this many for full bank. */
const BANK_TURN_MIN = 4
const BANK_TURN_FULL = 12
/** Curvature (1/m) below which a bend counts as straight for auto-banking. */
const BANK_DEADBAND = 1 / 3000
/** Slab thickness: a lifted road is this thick... */
export const SLAB_THICKNESS = 1.2
/** ...and a grounded road's sides reach this far down into the fill. */
export const SLAB_GROUNDED = 2.5
/**
 * An underpass: where another stretch of road passes at least this far (metres) below a
 * road on the ground, through its cutting, the road on top is a short bridge over the
 * cutting (markOverCuttings). The same room the `bridges` gate asks for: a slab plus a car.
 */
export const UNDERPASS_GAP = 6.2
/**
 * A road sitting at least this far (metres) below the natural ground is in a cutting dug
 * for it (an underpass). Shallower, it follows a dip in the ground (Afterglow's road through
 * its hills sits up to 2 m down), and a road on the ground beside it fills its bank as usual.
 */
const CUTTING_MIN_DEPTH = 3
/** A dip under another road is dug through that road's shoulders from where it is this far (metres) below the ground. */
const DIP_EDGE = 0.25
/** Two samples closer than this along the road are the same stretch, never an underpass. */
export const SAME_STRETCH = 80

export interface LoopInfo {
  pieceIndex: number
  s0: number
  s1: number
  radius: number
  /** Loop centre at its mid point (for visuals). */
  center: { x: number; y: number; z: number }
  /** Which way the corkscrew drifts: +1 = it comes down to the right of the way in, -1 = left. */
  side: 1 | -1
  /** How far the loop had to be bent to land on the road (non-zero when it sits on a bend or slope). */
  stretch: LoopStretch
}

/**
 * A loop is built as a perfect shape on a straight, then bent so its way out lands
 * exactly on the road. On a straight, level road these are all about 0. On a bend or
 * a slope they grow: `across` < 0 swings the way-out leg back toward the way in (the
 * two legs only have LOOP_LANE_GAP metres between them), `along` stretches or squashes
 * it, `up` tilts it. Metres; the loop gate in runTrackGates judges them.
 */
export interface LoopStretch {
  /** Sideways, + = further from the way in. */
  across: number
  /** Along the road, + = lands further on. */
  along: number
  /** Up, + = lands higher. */
  up: number
}

export interface WallInfo {
  pieceIndex: number
  s0: number
  s1: number
  side: 'left' | 'right' | 'both'
  radius: number
}

export interface Centerline {
  samples: TrackSamples
  length: number
  /** Slab thickness under each sample. */
  thickness: Float32Array
  /** Wall sweep angle (radians) on each edge per sample; 0 = no wall. */
  wallLeft: Float32Array
  wallRight: Float32Array
  /** Wall radius per sample (metres). */
  wallRadius: Float32Array
  loops: LoopInfo[]
  walls: WallInfo[]
  /** Final s of a control-point position `at` (wraps). */
  sOfAt: (at: number) => number
  /** The control-point position `at` nearest to a final s (for messages: "s=812 (at 7.4)"). */
  atOfS: (s: number) => number
  /** 0..1 per sample: how much of the bank comes from a `bank` override in the file. */
  overrideWeight: Float32Array
  /**
   * Metres the bank's pivot lifted the middle of the road per sample (half the width x
   * sin bank on an open road, so its low edge stays put; 0 with barriers and on loops).
   * The middle minus this is where the road would sit unbanked.
   */
  pivotLift: Float32Array
  /** Per sample, 1 where the road is a short bridge over another stretch's cutting (an underpass: markOverCuttings). */
  overCut: Uint8Array
  /**
   * Per sample, 1 along a sunken stretch that passes under a road on the ground (its whole dip,
   * from where it leaves the ground to where it comes back): that road's cutting is dug through
   * the other road's shoulders (terrain.ts flattenToRoad).
   */
  underCut: Uint8Array
  /** The tunnels (tunnels.ts): which samples they dig, cover and wall in. */
  tunnels: TunnelSamples
}

/** Shortest signed distance from a to b on a loop of length L. */
function wrapDelta(a: number, b: number, L: number): number {
  let d = b - a
  d -= Math.round(d / L) * L
  return d
}

/** Circular box blur, `radius` samples each side, `passes` times (2 passes ~ a soft bell). */
export function circularSmooth(a: Float32Array, radius: number, passes: number): void {
  const n = a.length
  if (radius < 1 || n < 3) return
  const r = Math.min(radius, Math.floor((n - 1) / 2))
  const tmp = new Float32Array(n)
  const inv = 1 / (2 * r + 1)
  for (let p = 0; p < passes; p++) {
    let sum = 0
    for (let k = -r; k <= r; k++) sum += a[(k + n) % n]
    for (let i = 0; i < n; i++) {
      tmp[i] = sum * inv
      sum += a[(i + r + 1) % n] - a[(i - r + n) % n]
    }
    a.set(tmp)
  }
}

/** Signed horizontal curvature (+ = turning right) of a closed sampled path. */
export function horizontalCurvature(px: ArrayLike<number>, pz: ArrayLike<number>, count: number, ds: number, out: Float32Array): void {
  const W = 4
  for (let i = 0; i < count; i++) {
    const a = (i - W + count) % count
    const b = (i + W) % count
    const a0 = (a - 1 + count) % count
    const b1 = (b + 1) % count
    // Headings at a and b (clockwise from north, so a right turn increases them).
    const ha = Math.atan2(px[(a + 1) % count] - px[a0], -(pz[(a + 1) % count] - pz[a0]))
    const hb = Math.atan2(px[b1] - px[(b - 1 + count) % count], -(pz[b1] - pz[(b - 1 + count) % count]))
    let d = hb - ha
    if (d > Math.PI) d -= Math.PI * 2
    if (d < -Math.PI) d += Math.PI * 2
    out[i] = d / (2 * W * ds)
  }
}

/** Point attribute at a control-point position: smooth (cosine) blend between neighbours. */
function pointBlend(at: number, n: number): { i: number; j: number; w: number } {
  const a = ((at % n) + n) % n
  const i = Math.floor(a) % n
  const f = a - Math.floor(a)
  return { i, j: (i + 1) % n, w: (1 - Math.cos(Math.PI * f)) / 2 }
}

/**
 * Build the sampled road for a validated track file.
 * `bankMaxDeg` is the auto-bank cap in effect (the file's, or the live slider's).
 */
export function buildCenterline(file: ResolvedTrackFile, bankMaxDeg: number, nat: NaturalTerrain): Centerline {
  const road = file.road
  const pts = road.points
  const np = pts.length
  /** Open roads bank about their low edge, roads with barriers about their middle (see "the bank's pivot"). */
  const pivotLow = road.barriers !== 'walls'

  // ---- 1. control point heights ----
  const ctrl = pts.map((p) => ({
    x: p.x,
    z: p.z,
    y: typeof p.y === 'number' ? p.y : averagedHeight(nat, p.x, p.z, road.surfaceSmoothing) + (p.lift ?? 0),
  }))

  // ---- 2. the spline ----
  const dense = sampleClosedSpline(ctrl, 0.25)
  const Lb = dense.length

  // ---- 3. base samples every ~1 m, starting at the start line ----
  const nb = Math.max(32, Math.round(Lb / SAMPLE_SPACING))
  const dsb = Lb / nb
  const sStart = arcLengthAtParam(dense, file.start.at)
  const bx = new Float64Array(nb)
  const by = new Float64Array(nb)
  const bz = new Float64Array(nb)
  const bat = new Float64Array(nb)
  for (let k = 0; k < nb; k++) {
    const sd = (sStart + k * dsb) % Lb
    const j = Math.min(nodeAtLength(dense, sd), dense.count - 2)
    const seg = dense.cum[j + 1] - dense.cum[j]
    const f = seg > 0 ? (sd - dense.cum[j]) / seg : 0
    bx[k] = dense.x[j] + (dense.x[j + 1] - dense.x[j]) * f
    by[k] = dense.y[j] + (dense.y[j + 1] - dense.y[j]) * f
    bz[k] = dense.z[j] + (dense.z[j + 1] - dense.z[j]) * f
    bat[k] = (dense.at[j] + (dense.at[j + 1] - dense.at[j]) * f) % np
  }
  /** Base s (before loops are spliced in) of a control-point position. */
  const baseSOfAt = (at: number): number => {
    const s = arcLengthAtParam(dense, at) - sStart
    return ((s % Lb) + Lb) % Lb
  }

  // ---- per-point attributes: width and bank overrides ----
  const bHalf = new Float32Array(nb)
  const bOverW = new Float32Array(nb)
  const bOverV = new Float32Array(nb)
  for (let k = 0; k < nb; k++) {
    const { i, j, w } = pointBlend(bat[k], np)
    const wi = pts[i].width ?? road.width
    const wj = pts[j].width ?? road.width
    bHalf[k] = (wi + (wj - wi) * w) / 2
    const hi = typeof pts[i].bank === 'number' ? 1 : 0
    const hj = typeof pts[j].bank === 'number' ? 1 : 0
    bOverW[k] = hi + (hj - hi) * w
    bOverV[k] = hi * (pts[i].bank ?? 0) + (hj * (pts[j].bank ?? 0) - hi * (pts[i].bank ?? 0)) * w
  }

  // ---- 4. curvature and banking ----
  const bCurv = new Float32Array(nb)
  horizontalCurvature(bx, bz, nb, dsb, bCurv)
  circularSmooth(bCurv, Math.round(6 / dsb), 2)
  const bCurvWide = new Float32Array(bCurv)
  circularSmooth(bCurvWide, Math.round(30 / dsb), 2)

  // Bank from a broader view of the curvature: a spline's small wobble where a bend
  // meets a straight would otherwise bank the road the wrong way for a few metres
  // (at a 320 km/h design speed even a 1 km radius asks for the full bank).
  // Curves gentler than BANK_DEADBAND (radius > 3 km) count as straight.
  const bCurvBank = new Float32Array(bCurv)
  circularSmooth(bCurvBank, Math.round(25 / dsb), 2)
  // A real corner also TURNS: a gentle wobble that changes direction by only a few
  // degrees gets no bank at all, however fast the design speed. turnDeg is how far
  // the road turns over the 80 m around each sample.
  const turnDeg = new Float32Array(nb)
  {
    const W = Math.max(1, Math.round(40 / dsb))
    let sum = 0
    for (let k = -W; k <= W; k++) sum += bCurv[(k + nb) % nb]
    for (let k = 0; k < nb; k++) {
      turnDeg[k] = (Math.abs(sum) * dsb * 180) / Math.PI
      sum += bCurv[(k + W + 1) % nb] - bCurv[(k - W + nb) % nb]
    }
  }
  // ---- loops: where they sit (needed now: the road is flattened for them) ----
  const pieces = file.pieces
  const loopSpecs: { pieceIndex: number; sb: number; radius: number; shape: LoopShape; side: 1 | -1; stretch: LoopStretch }[] = []
  pieces.forEach((p, idx) => {
    if (p.type !== 'loop') return
    const radius = (p as LoopPiece).radius ?? 12
    const sb = baseSOfAt(p.at)
    const shape = loopShape(radius)
    // Which way the corkscrew drifts:
    //  - If the road itself curves under the loop (a loop placed on a bend), drift to
    //    the inside of that curve. The loop is bent to land where the road really is,
    //    and on the inside that bend pulls the way out further from the way in;
    //    drifting the other way would swing the way-out leg back over the way in.
    //  - Otherwise drift toward the side the road bends to next, so the ease back
    //    finishes turning the same way as that bend and flows into it. A road that
    //    carries on straight drifts right.
    const sumTurn = (fromS: number, metres: number): number => {
      let turn = 0
      const k0 = Math.round(fromS / dsb)
      const kn = Math.round(metres / dsb)
      for (let k = 0; k < kn; k++) turn += bCurv[(((k0 + k) % nb) + nb) % nb] * dsb
      return turn
    }
    const underLoop = sumTurn(sb, shape.advance + 20)
    const nextBend = sumTurn(sb + shape.advance, LOOP_EXIT_EASE + 150)
    const deg = Math.PI / 180
    const side: 1 | -1 = Math.abs(underLoop) > deg ? (underLoop < 0 ? -1 : 1) : nextBend < -3 * deg ? -1 : 1
    loopSpecs.push({ pieceIndex: idx, sb, radius, shape, side, stretch: { across: 0, along: 0, up: 0 } })
  })
  loopSpecs.sort((a, b) => a.sb - b.sb)

  const vDesign = road.banking.designSpeedKmh / 3.6
  const bankTarget = new Float32Array(nb)
  for (let k = 0; k < nb; k++) {
    const kk = Math.sign(bCurvBank[k]) * Math.max(0, Math.abs(bCurvBank[k]) - BANK_DEADBAND)
    let auto = 0
    if (road.banking.auto) {
      const into = (Math.atan((vDesign * vDesign * Math.abs(kk)) / G) * 180) / Math.PI
      auto = Math.min(bankMaxDeg, into) * Math.sign(kk) * smoothstep(BANK_TURN_MIN, BANK_TURN_FULL, turnDeg[k])
    }
    // Overrides are "into the corner": right-handers and straights lift the left edge.
    const sgn = bCurvWide[k] >= -1 / 1500 ? 1 : -1
    bankTarget[k] = auto * (1 - bOverW[k]) + bOverV[k] * sgn
  }
  // A loop enters and lands level: no bank from the start of its run-in to 20 m past where
  // it comes down, rolling out of (and back into) any bend's bank over LOOP_BANK_EASE metres
  // either side. (A loop dropped on a banked bend used to snap from the bend's bank to
  // flat at its mouth: a roll the car can't follow.)
  for (const L of loopSpecs) {
    const flat0 = L.sb - LOOP_RUN_IN
    const flat1 = L.sb + L.shape.advance + 20
    for (let k = 0; k < nb; k++) {
      const before = wrapDelta(k * dsb, flat0, Lb) // > 0: sample k is before the flat stretch
      const after = wrapDelta(flat1, k * dsb, Lb) // > 0: sample k is after it
      let w = 1
      if (before <= 0 && after <= 0) w = 0
      else if (before > 0 && before < LOOP_BANK_EASE) w = smoothstep(0, LOOP_BANK_EASE, before)
      else if (after > 0 && after < LOOP_BANK_EASE) w = smoothstep(0, LOOP_BANK_EASE, after)
      bankTarget[k] *= w
    }
  }
  circularSmooth(bankTarget, Math.round(20 / dsb), 2)
  const bBank = new Float32Array(nb)
  for (let k = 0; k < nb; k++) bBank[k] = (clamp(bankTarget[k], -85, 85) * Math.PI) / 180
  // Rolls into and out of a bank: long enough that a car on any lane stays on the road
  // (bankRolls.ts), grown into the straight beside them. They never grow into the start
  // grid or a loop's stretch (its run-in, the loop, and the S back after it).
  {
    const keepLevel = new Uint8Array(nb)
    for (const L of loopSpecs) {
      // From the run-in to the end of the S that brings the road back after the loop.
      const flat0 = L.sb - LOOP_RUN_IN
      const flat1 = L.sb + L.shape.advance + LOOP_EXIT_EASE
      for (let k = 0; k < nb; k++) if (wrapDelta(k * dsb, flat0, Lb) <= 0 && wrapDelta(flat1, k * dsb, Lb) <= 0) keepLevel[k] = 1
    }
    // (A grid the file itself puts on a bank, 3 degrees or more, is left to the bank.)
    let gridLevel = true
    for (let sv = -GRID_KEEP_BEHIND; sv <= GRID_KEEP_AHEAD; sv++) if (Math.abs(bBank[((Math.round(sv / dsb) % nb) + nb) % nb]) >= (3 * Math.PI) / 180) gridLevel = false
    if (gridLevel) for (let sv = -GRID_KEEP_BEHIND; sv <= GRID_KEEP_AHEAD; sv++) keepLevel[((Math.round(sv / dsb) % nb) + nb) % nb] = 1
    const bCurvRaw = new Float32Array(nb)
    horizontalCurvature(bx, bz, nb, dsb, bCurvRaw)
    shapeBankRolls(bBank, bHalf, bCurv, bCurvRaw, keepLevel, dsb, road.banking.designSpeedKmh)
  }

  // ---- the bank's pivot: an open road keeps its LOW edge where it would sit unbanked ----
  // The bank tilts the road about its middle (below), so lift the middle by half the width
  // x sin(bank): the low edge stays at the height the points give (on the ground for a road
  // on the ground) and the high side rises, the ground filling up under it. (Tilted about
  // its middle, the low edge sank into the ground and the ground beside it with it: a ditch
  // a car on the low lane dropped into, GitHub #9.) A road with barriers keeps tilting about
  // its middle: its barrier stands on the low edge with level ground behind it, so it has no
  // ditch, and the Hyperdrome's live bank slider would otherwise raise and lower its road.
  // The lift is rounded off where it starts and stops growing (PIVOT_CREST_RADIUS,
  // PIVOT_DIP_RADIUS), so the lanes ride the rolls as gently as tilting about the middle.
  const bLift = new Float64Array(nb)
  if (pivotLow) {
    for (let k = 0; k < nb; k++) bLift[k] = bHalf[k] * Math.abs(Math.sin(bBank[k]))
    // Over a ramp and the road it throws you onto, and round a loop, the lift is held level
    // (at the most it reaches there), so the jump and the loop sit exactly as they would on
    // a road banked about its middle, just a little higher: a lift growing under a ramp's
    // lip tipped the launch, and one growing where you land moved the landing (Afterglow's
    // demo car landed off line and slid off the high edge).
    const held: [number, number][] = []
    for (const p of file.pieces) {
      if (p.type !== 'ramp') continue
      const sb = baseSOfAt(p.at)
      const len = (p as { length?: number }).length ?? 12
      held.push([Math.floor((sb - len / 2 - RAMP_HOLD_BEFORE) / dsb), Math.ceil((sb + len / 2 + RAMP_HOLD_AFTER) / dsb)])
    }
    for (const L of loopSpecs) held.push([Math.floor((L.sb - LOOP_RUN_IN) / dsb), Math.ceil((L.sb + L.shape.advance + LOOP_BANK_EASE) / dsb)])
    shapePivotLift(bLift, dsb, held)
    for (let k = 0; k < nb; k++) by[k] += bLift[k]
  }

  // ---- tunnels: the road dips into the ground wherever a tunnel piece covers it ----
  // (tunnels.ts: deep enough for a car, a ceiling and a roof under the natural ground, on
  // ramps gentle enough to drive flat out.) Its stretch, ramps included, must be clear road.
  const keepClear: TunnelKeepClear[] = []
  for (const L of loopSpecs) keepClear.push({ s0: L.sb - LOOP_RUN_IN, s1: L.sb + L.shape.advance + LOOP_EXIT_EASE, what: `a loop (pieces[${L.pieceIndex}])`, kind: 'loop' })
  pieces.forEach((p, idx) => {
    const sb = baseSOfAt(p.at)
    if (p.type === 'ramp') {
      const len = (p as { length?: number }).length ?? 12
      keepClear.push({ s0: sb - len / 2 - RAMP_HOLD_BEFORE, s1: sb + len / 2 + RAMP_HOLD_AFTER, what: `a ramp (pieces[${idx}]) and the road it throws you onto`, kind: 'ramp' })
    } else if (p.type === 'wallride') {
      keepClear.push({ s0: sb - WALL_REACH, s1: sb + ((p as WallRidePiece).length ?? 120) + WALL_REACH, what: `a wall ride (pieces[${idx}])`, kind: 'wallride' })
    }
  })
  keepClear.push({ s0: -GRID_KEEP_BEHIND - 10, s1: GRID_KEEP_AHEAD + 10, what: 'the start grid', kind: 'grid' })
  // (A base s as an `at`, for where a refusal's obstacle is: the same mapping atOfS uses below.)
  const atOfBase = (sb: number): number => {
    const sd = (((sb + sStart) % Lb) + Lb) % Lb
    const j = Math.min(nodeAtLength(dense, sd), dense.count - 2)
    const seg = dense.cum[j + 1] - dense.cum[j]
    const f = seg > 0 ? (sd - dense.cum[j]) / seg : 0
    return (dense.at[j] + (dense.at[j + 1] - dense.at[j]) * f) % np
  }
  const tunnelDigs = planTunnelDigs({ pieces, baseSOfAt, nb, dsb, Lb, bx, by, bz, bHalf, bBank, nat, keepClear, walled: !pivotLow, overSlab: SLAB_THICKNESS, curvature: bCurv, atOfBase })
  for (let k = 0; k < nb; k++) by[k] -= tunnelDigs.dig[k]

  // ---- base tangents (3D) ----
  const btx = new Float64Array(nb)
  const bty = new Float64Array(nb)
  const btz = new Float64Array(nb)
  for (let k = 0; k < nb; k++) {
    const a = (k - 1 + nb) % nb
    const b = (k + 1) % nb
    const tx = bx[b] - bx[a]
    const ty = by[b] - by[a]
    const tz = bz[b] - bz[a]
    const l = Math.hypot(tx, ty, tz) || 1
    btx[k] = tx / l
    bty[k] = ty / l
    btz[k] = tz / l
  }

  // ---- 5. loops: splice each loop in, then ease the road back after it ----

  // The loop comes down `advance` metres further along than it went up, so the
  // base road it lands on starts there; the base samples in between are skipped.
  // From there the road eases from `side * d` back to 0 over LOOP_EXIT_EASE metres.
  const shift = new Float64Array(nb)
  const skip = new Uint8Array(nb)
  for (const L of loopSpecs) {
    const k0 = Math.floor(L.sb / dsb) % nb
    const d = bHalf[k0] * 2 + LOOP_LANE_GAP
    const adv = L.shape.advance
    for (let k = 0; k < nb; k++) {
      const delta = wrapDelta(L.sb, k * dsb, Lb)
      if (delta >= 0 && delta < adv) skip[k] = 1
      else if (delta >= adv && delta <= adv + LOOP_EXIT_EASE) shift[k] += L.side * d * (1 - easeCycloid((delta - adv) / LOOP_EXIT_EASE))
    }
  }

  // Node list (the road before the final, exact re-sample).
  const nx: number[] = []
  const ny: number[] = []
  const nz: number[] = []
  const nhw: number[] = []
  const nbank: number[] = []
  const nlift: number[] = []
  const nover: number[] = []
  const nux: number[] = []
  const nuy: number[] = []
  const nuz: number[] = []
  const nsurf: number[] = []
  const nbs: number[] = []
  const ndig: number[] = []
  const nslot: number[] = []
  const ncov: number[] = []
  const novr: number[] = []
  const pushBase = (k: number) => {
    // Horizontal right (for the loop shift) and the banked up vector.
    const hl = Math.hypot(btx[k], btz[k]) || 1
    const rxh = -btz[k] / hl
    const rzh = btx[k] / hl
    nx.push(bx[k] + rxh * shift[k])
    ny.push(by[k])
    nz.push(bz[k] + rzh * shift[k])
    nhw.push(bHalf[k])
    nbank.push(bBank[k])
    nlift.push(bLift[k])
    nover.push(bOverW[k])
    // up0 = world up made perpendicular to the tangent; roll it by the bank.
    const T0 = btx[k]
    const T1 = bty[k]
    const T2 = btz[k]
    let u0x = -T0 * T1
    let u0y = 1 - T1 * T1
    let u0z = -T2 * T1
    const ul = Math.hypot(u0x, u0y, u0z) || 1
    u0x /= ul
    u0y /= ul
    u0z /= ul
    // right0 = T x up0
    const r0x = T1 * u0z - T2 * u0y
    const r0y = T2 * u0x - T0 * u0z
    const r0z = T0 * u0y - T1 * u0x
    const c = Math.cos(bBank[k])
    const s = Math.sin(bBank[k])
    nux.push(u0x * c + r0x * s)
    nuy.push(u0y * c + r0y * s)
    nuz.push(u0z * c + r0z * s)
    nsurf.push(SURFACE_CODE.road)
    nbs.push(k * dsb)
    ndig.push(tunnelDigs.dig[k])
    nslot.push(tunnelDigs.slot[k])
    ncov.push(tunnelDigs.covered[k])
    novr.push(tunnelDigs.over[k])
  }

  let li = 0
  for (let k = 0; k < nb; k++) {
    if (!skip[k]) pushBase(k)
    const sNext = (k + 1) * dsb
    while (li < loopSpecs.length && loopSpecs[li].sb >= k * dsb && loopSpecs[li].sb < sNext) {
      const L = loopSpecs[li]
      // Loop entry point: the base road at L.sb (between sample k and k+1).
      const f = (L.sb - k * dsb) / dsb
      const k1 = (k + 1) % nb
      const Px = bx[k] + (bx[k1] - bx[k]) * f
      const Py = by[k] + (by[k1] - by[k]) * f
      const Pz = bz[k] + (bz[k1] - bz[k]) * f
      const hl = Math.hypot(btx[k], btz[k]) || 1
      const Tx = btx[k] / hl
      const Tz = btz[k] / hl
      const Rx = -Tz
      const Rz = Tx
      const hw = bHalf[k]
      // The way out lands this far to the side of the way in (a full road width plus a gap).
      const d = (hw * 2 + LOOP_LANE_GAP) * L.side
      const sh = L.shape
      // Where the base road really is when the loop comes down (it may have climbed or
      // curved a little since the entry): bend the loop gently so it lands exactly there.
      const m = sh.fwd.length - 1
      const se = (L.sb + sh.advance) / dsb
      const e0 = Math.floor(se) % nb
      const e1 = (e0 + 1) % nb
      const ef = se - Math.floor(se)
      const ehl = Math.hypot(btx[e0], btz[e0]) || 1
      const Ex = bx[e0] + (bx[e1] - bx[e0]) * ef + (-btz[e0] / ehl) * d
      const Ey = by[e0] + (by[e1] - by[e0]) * ef
      const Ez = bz[e0] + (bz[e1] - bz[e0]) * ef + (btx[e0] / ehl) * d
      const Mx = Ex - (Px + Rx * d + Tx * sh.advance)
      const My = Ey - Py
      const Mz = Ez - (Pz + Rz * d + Tz * sh.advance)
      // Record how far the loop had to be bent to land (see LoopStretch).
      L.stretch.across = (Mx * Rx + Mz * Rz) * L.side
      L.stretch.along = Mx * Tx + Mz * Tz
      L.stretch.up = My
      for (let q = 0; q <= m; q++) {
        const ph = sh.phi[q]
        // Corkscrew drift across by d, with zero drift rate at the bottom (in and out),
        // starting from the line of the straight it came down.
        const lat = (d * (ph - Math.sin(ph))) / (Math.PI * 2)
        const w = (1 - Math.cos((Math.PI * q) / m)) / 2
        nx.push(Px + Rx * lat + Tx * sh.fwd[q] + Mx * w)
        ny.push(Py + sh.up[q] + My * w)
        nz.push(Pz + Rz * lat + Tz * sh.fwd[q] + Mz * w)
        nhw.push(hw)
        nbank.push(0)
        nlift.push(0)
        nover.push(0)
        // Up is the surface normal: perpendicular to the direction of travel, toward the inside.
        nux.push(-Tx * Math.sin(ph))
        nuy.push(Math.cos(ph))
        nuz.push(-Tz * Math.sin(ph))
        nsurf.push(SURFACE_CODE.loop)
        nbs.push(L.sb)
        ndig.push(0)
        nslot.push(0)
        ncov.push(0)
        novr.push(0)
      }
      li++
    }
  }

  // ---- 6. final exact re-sample ----
  const nn = nx.length
  const ncum = new Float64Array(nn + 1)
  for (let i = 1; i <= nn; i++) {
    const a = i - 1
    const b = i % nn
    ncum[i] = ncum[a] + Math.hypot(nx[b] - nx[a], ny[b] - ny[a], nz[b] - nz[a])
  }
  const length = ncum[nn]
  const count = Math.max(32, Math.round(length / SAMPLE_SPACING))
  const ds = length / count
  const S: TrackSamples = {
    count,
    ds,
    px: new Float32Array(count),
    py: new Float32Array(count),
    pz: new Float32Array(count),
    tx: new Float32Array(count),
    ty: new Float32Array(count),
    tz: new Float32Array(count),
    ux: new Float32Array(count),
    uy: new Float32Array(count),
    uz: new Float32Array(count),
    rx: new Float32Array(count),
    ry: new Float32Array(count),
    rz: new Float32Array(count),
    halfWidth: new Float32Array(count),
    bank: new Float32Array(count),
    curvature: new Float32Array(count),
    surface: new Uint8Array(count),
    grounded: new Uint8Array(count),
  }
  const baseS = new Float64Array(count)
  const overrideWeight = new Float32Array(count)
  const pivotLift = new Float32Array(count)
  const tDig = new Float32Array(count)
  const tSlot = new Uint8Array(count)
  const tCov = new Uint8Array(count)
  const tOver = new Uint8Array(count)
  let j = 0
  // Positions are kept in float64 until the end so long tracks don't wobble.
  const fx = new Float64Array(count)
  const fy = new Float64Array(count)
  const fz = new Float64Array(count)
  const hux = new Float64Array(count)
  const huy = new Float64Array(count)
  const huz = new Float64Array(count)
  for (let i = 0; i < count; i++) {
    const s = i * ds
    while (j < nn - 1 && ncum[j + 1] <= s) j++
    const a = j
    const b = (j + 1) % nn
    const seg = ncum[j + 1] - ncum[j]
    const f = seg > 0 ? (s - ncum[j]) / seg : 0
    fx[i] = nx[a] + (nx[b] - nx[a]) * f
    fy[i] = ny[a] + (ny[b] - ny[a]) * f
    fz[i] = nz[a] + (nz[b] - nz[a]) * f
    S.halfWidth[i] = nhw[a] + (nhw[b] - nhw[a]) * f
    S.bank[i] = nbank[a] + (nbank[b] - nbank[a]) * f
    overrideWeight[i] = nover[a] + (nover[b] - nover[a]) * f
    pivotLift[i] = nlift[a] + (nlift[b] - nlift[a]) * f
    hux[i] = nux[a] + (nux[b] - nux[a]) * f
    huy[i] = nuy[a] + (nuy[b] - nuy[a]) * f
    huz[i] = nuz[a] + (nuz[b] - nuz[a]) * f
    S.surface[i] = f < 0.5 ? nsurf[a] : nsurf[b]
    tDig[i] = ndig[a] + (ndig[b] - ndig[a]) * f
    tSlot[i] = f < 0.5 ? nslot[a] : nslot[b]
    tCov[i] = f < 0.5 ? ncov[a] : ncov[b]
    tOver[i] = f < 0.5 ? novr[a] : novr[b]
    // Base s for mapping `at` -> final s (wraps cleanly: the last node pairs with node 0).
    const bsA = nbs[a]
    let bsB = nbs[b]
    if (b === 0) bsB = Lb
    baseS[i] = bsA + (bsB - bsA) * f
  }

  // Frames: tangent from neighbours, up made perpendicular to it, right = tangent x up.
  for (let i = 0; i < count; i++) {
    const a = (i - 1 + count) % count
    const b = (i + 1) % count
    let tx = fx[b] - fx[a]
    let ty = fy[b] - fy[a]
    let tz = fz[b] - fz[a]
    const tl = Math.hypot(tx, ty, tz) || 1
    tx /= tl
    ty /= tl
    tz /= tl
    let ux = hux[i]
    let uy = huy[i]
    let uz = huz[i]
    const d = ux * tx + uy * ty + uz * tz
    ux -= tx * d
    uy -= ty * d
    uz -= tz * d
    const ul = Math.hypot(ux, uy, uz) || 1
    ux /= ul
    uy /= ul
    uz /= ul
    S.px[i] = fx[i]
    S.py[i] = fy[i]
    S.pz[i] = fz[i]
    S.tx[i] = tx
    S.ty[i] = ty
    S.tz[i] = tz
    S.ux[i] = ux
    S.uy[i] = uy
    S.uz[i] = uz
    S.rx[i] = ty * uz - tz * uy
    S.ry[i] = tz * ux - tx * uz
    S.rz[i] = tx * uy - ty * ux
  }

  horizontalCurvature(fx, fz, count, ds, S.curvature)
  circularSmooth(S.curvature, Math.round(5 / ds), 2)
  for (let i = 0; i < count; i++) if (S.surface[i] === SURFACE_CODE.loop) S.curvature[i] = 0

  // ---- grounded: is the road close enough to the ground to fill up to it? ----
  // (Measured from where the road would sit unbanked, its low edge's height: a bank's
  // pivot lift raises the high side, it doesn't turn the road into a bridge.)
  for (let i = 0; i < count; i++) {
    if (S.surface[i] !== SURFACE_CODE.road) continue
    const gap = S.py[i] - pivotLift[i] - nat.height(S.px[i], S.pz[i])
    S.grounded[i] = gap <= FILL_MAX ? 1 : 0
  }
  // The tunnels on the final road: their stretches, walls of ground, ceilings and cover.
  const tunnels = finishTunnels(S, tunnelDigs.plans, tDig, tSlot, tCov, nat)
  // A road on the ground over another stretch's cutting is a bridge there (an underpass).
  const { overCut, underCut } = markOverCuttings(S, pivotLift, nat, tunnels.slot)
  for (let i = 0; i < count; i++) if (overCut[i]) S.grounded[i] = 0
  denoiseRuns(S.grounded, S.surface, Math.round(10 / ds))

  const thickness = new Float32Array(count)
  // (Over a tunnel's roof a road on the ground has a bridge's slab: the roof is under it, and the
  // tunnel needn't dig deeper for a grounded slab's sides to clear its ceiling.)
  for (let i = 0; i < count; i++) thickness[i] = S.grounded[i] && !tOver[i] ? SLAB_GROUNDED : SLAB_THICKNESS
  circularSmooth(thickness, Math.round(4 / ds), 1)

  // ---- mapping from `at` to final s ----
  const sOfBase = (sb: number): number => {
    // baseS is non-decreasing from 0 to ~Lb; binary search it.
    let lo = 0
    let hi = count - 1
    if (sb <= baseS[0]) return 0
    if (sb >= baseS[count - 1]) {
      const f = (sb - baseS[count - 1]) / Math.max(1e-6, Lb - baseS[count - 1])
      return (count - 1 + clamp(f, 0, 1)) * ds
    }
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (baseS[mid] <= sb) lo = mid
      else hi = mid
    }
    const span = baseS[hi] - baseS[lo]
    const f = span > 0 ? (sb - baseS[lo]) / span : 0
    return (lo + f) * ds
  }
  const sOfAt = (at: number): number => sOfBase(baseSOfAt(at)) % length
  const atOfS = (sIn: number): number => {
    const i = ((Math.round(sIn / ds) % count) + count) % count
    const sd = (baseS[i] + sStart) % Lb
    const j = Math.min(nodeAtLength(dense, sd), dense.count - 2)
    const seg = dense.cum[j + 1] - dense.cum[j]
    const f = seg > 0 ? (sd - dense.cum[j]) / seg : 0
    return (dense.at[j] + (dense.at[j + 1] - dense.at[j]) * f) % np
  }

  // ---- loops as found on the final road ----
  const loops: LoopInfo[] = []
  for (const L of loopSpecs) {
    // The loop's samples: surface 'loop' and the base s of this loop's entry.
    let i0 = -1
    let i1 = -1
    for (let i = 0; i < count; i++) {
      if (S.surface[i] === SURFACE_CODE.loop && Math.abs(baseS[i] - L.sb) < 1e-3) {
        if (i0 < 0) i0 = i
        i1 = i
      }
    }
    if (i0 < 0) continue
    const mid = Math.floor((i0 + i1) / 2)
    loops.push({
      pieceIndex: L.pieceIndex,
      s0: i0 * ds,
      s1: (i1 + 1) * ds,
      radius: L.radius,
      // The centre of the loop's own circle: straight "in" from the top (the up the loop
      // was drawn with, before spreadLoopRoll rolls it), so it sits in the loop's plane.
      center: {
        x: S.px[mid] + S.ux[mid] * L.radius,
        y: S.py[mid] + S.uy[mid] * L.radius,
        z: S.pz[mid] + S.uz[mid] * L.radius,
      },
      side: L.side,
      stretch: { ...L.stretch },
    })
    spreadLoopRoll(S, fx, fy, fz, i0, i1)
  }

  // ---- wall rides: a sweep angle per sample on each edge ----
  const wallLeft = new Float32Array(count)
  const wallRight = new Float32Array(count)
  const wallRadius = new Float32Array(count)
  const walls: WallInfo[] = []
  pieces.forEach((p, idx) => {
    if (p.type !== 'wallride') return
    const w = p as WallRidePiece
    // The wall reaches WALL_REACH metres past both ends of the file's stretch, so its longer
    // ramps leave the full-height part where it was (see WALL_FULL_INSET).
    const len = (w.length ?? 120) + 2 * WALL_REACH
    const radius = w.height ?? 9
    const s0 = sOfAt(w.at) - WALL_REACH
    walls.push({ pieceIndex: idx, s0, s1: s0 + len, side: w.side, radius })
    const maxSweep = (WALL_SWEEP_DEG * Math.PI) / 180
    const i0 = Math.floor(s0 / ds)
    const i1 = Math.ceil((s0 + len) / ds)
    for (let ii = i0; ii <= i1; ii++) {
      const i = ((ii % count) + count) % count
      if (S.surface[i] !== SURFACE_CODE.road) continue
      const into = ii * ds - s0
      const sweep = maxSweep * smoothstep(0, WALL_RAMP, Math.min(into, len - into))
      if (sweep <= 0) continue
      if (w.side !== 'right' && sweep > wallLeft[i]) wallLeft[i] = sweep
      if (w.side !== 'left' && sweep > wallRight[i]) wallRight[i] = sweep
      wallRadius[i] = Math.max(wallRadius[i], radius)
    }
  })

  return { samples: S, length, thickness, wallLeft, wallRight, wallRadius, loops, walls, sOfAt, atOfS, overrideWeight, pivotLift, overCut, underCut, tunnels }
}

/**
 * Over a cutting (an underpass). Where a road sunk into the ground (negative lift) passes
 * under a road on the ground, the ground is dug out into a cutting with sloped sides for
 * the road below. If the road on top stayed "grounded" there, the ground would be filled
 * up under it (that's what grounded means), building a dam across the cutting with only
 * a slot for the road below. So a road sample counts as a bridge wherever another
 * stretch passes UNDERPASS_GAP metres or more below it, and the cutting's ground under its
 * deck would sit lower than its slab (2.5 m under a grounded road): the cutting runs on
 * under it and it crosses on its own short bridge. Returns 1 per sample where that is so
 * (`overCut`), and 1 along every dip that passes under one (`underCut`). Tracks with no
 * road below the ground get all zeros (and the same road as before).
 */
function markOverCuttings(S: TrackSamples, pivotLift: Float32Array, nat: NaturalTerrain, tunnelSlot: Uint8Array): { overCut: Uint8Array; underCut: Uint8Array } {
  const n = S.count
  const out = new Uint8Array(n)
  const under = new Uint8Array(n)
  // Road samples in a cutting: where they would sit unbanked, and the natural ground there.
  const sunk: number[] = []
  const floorY = new Float32Array(n)
  const natY = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    if (S.surface[i] !== SURFACE_CODE.road) continue
    floorY[i] = S.py[i] - pivotLift[i]
    natY[i] = nat.height(S.px[i], S.pz[i])
    // (A tunnel's road is walled in, not in a sloped cutting: no road crosses over it.)
    if (natY[i] - floorY[i] >= CUTTING_MIN_DEPTH && !tunnelSlot[i]) sunk.push(i)
  }
  if (!sunk.length) return { overCut: out, underCut: under }
  // Bucket the sunken samples on a coarse grid, so each road sample only looks at its neighbours.
  const CELL = 32
  const key = (cx: number, cz: number) => cx * 100003 + cz
  const cells = new Map<number, number[]>()
  let widest = 0
  for (const j of sunk) {
    const k = key(Math.floor(S.px[j] / CELL), Math.floor(S.pz[j] / CELL))
    const list = cells.get(k)
    if (list) list.push(j)
    else cells.set(k, [j])
    widest = Math.max(widest, S.halfWidth[j])
  }
  const same = Math.round(SAME_STRETCH / S.ds)
  for (let i = 0; i < n; i++) {
    if (S.surface[i] !== SURFACE_CODE.road || S.grounded[i] !== 1) continue
    const top = floorY[i]
    // A cutting reaches at most the widest road plus the widest shoulder (36 m) from its middle.
    const reach = S.halfWidth[i] + widest + 36
    const r = Math.ceil(reach / CELL)
    const cx = Math.floor(S.px[i] / CELL)
    const cz = Math.floor(S.pz[i] / CELL)
    search: for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        for (const j of cells.get(key(cx + dx, cz + dz)) ?? []) {
          const apart = Math.abs(i - j)
          if (Math.min(apart, n - apart) < same) continue
          if (S.py[i] - S.py[j] < UNDERPASS_GAP) continue
          // How far the near edge of this deck is from the edge of the road below, and how low its cutting is there.
          const beyond = Math.hypot(S.px[i] - S.px[j], S.pz[i] - S.pz[j]) - S.halfWidth[i] - S.halfWidth[j]
          const cut = beyond <= 0 ? floorY[j] : shoulderHeight(floorY[j], natY[i], beyond)
          if (cut < top - SLAB_GROUNDED) {
            out[i] = 1
            under[j] = 1
            break search
          }
        }
      }
    }
  }
  // Spread each passing-under mark over its whole dip: every sample below the ground either side.
  for (let i = 0; i < n; i++) {
    if (under[i] !== 1) continue
    for (const dir of [-1, 1]) {
      for (let k = 1; k < n; k++) {
        const j = (((i + dir * k) % n) + n) % n
        if (S.surface[j] !== SURFACE_CODE.road || natY[j] - floorY[j] < DIP_EDGE || under[j] === 1) break
        under[j] = 2
      }
    }
  }
  for (let i = 0; i < n; i++) if (under[i]) under[i] = 1
  return { overCut: out, underCut: under }
}

/**
 * A loop's side profile. Not a circle: a circle switches from straight road to its
 * full curvature in one step, which at 110 km/h slams a car with ~8 g and bottoms
 * the suspension into the road (measured: the car stopped dead at the entry).
 * Real loops use a "teardrop": the curvature grows smoothly from gentle at the
 * bottom (about a 60 m radius) to tight at the top, so entry is ~1.5 g at 30 m/s
 * and the top is still tight enough to hold you upside down.
 *
 * The shape is the curvature profile k(u) = base + (1 - base) * sin^2(pi u / L),
 * scaled so the heading turns a full 360 degrees and the top is 2 x radius high.
 * Because the top sits ahead of the entry, the loop comes down `advance` metres
 * further along the road than it went up.
 */
export interface LoopShape {
  /** Metres forward (along the road) and up, and the heading angle, per node. */
  fwd: Float64Array
  up: Float64Array
  phi: Float64Array
  /** Where it comes down, metres ahead of where it went up. */
  advance: number
  /** Length of the loop's road, metres. */
  length: number
}

const LOOP_BASE = 0.15

/**
 * 0 -> 1 as t goes 0 -> 1, with zero slope AND zero bend at both ends (the same
 * cycloid curve the corkscrew drifts on). Used as a sideways offset, the road's
 * curvature grows from nothing, peaks at a quarter and three quarters of the way,
 * and fades to nothing again, so a car is never asked to snap its steering.
 */
export function easeCycloid(t: number): number {
  const u = clamp(t, 0, 1)
  return u - Math.sin(Math.PI * 2 * u) / (Math.PI * 2)
}

export function loopShape(radius: number): LoopShape {
  // Integrate a unit-length loop finely, then scale it to the requested height.
  const N = 2000
  const du = 1 / N
  const shapeK = new Float64Array(N)
  let area = 0
  for (let i = 0; i < N; i++) {
    const sn = Math.sin(Math.PI * (i + 0.5) * du)
    shapeK[i] = LOOP_BASE + (1 - LOOP_BASE) * sn * sn
    area += shapeK[i] * du
  }
  const fx = new Float64Array(N + 1)
  const fy = new Float64Array(N + 1)
  const fp = new Float64Array(N + 1)
  let h = 0
  let x = 0
  let y = 0
  let ymax = 0
  for (let i = 0; i < N; i++) {
    const k = (Math.PI * 2 * shapeK[i]) / area
    h += (k * du) / 2
    x += Math.cos(h) * du
    y += Math.sin(h) * du
    h += (k * du) / 2
    fx[i + 1] = x
    fy[i + 1] = y
    fp[i + 1] = h
    if (y > ymax) ymax = y
  }
  const L = (2 * radius) / ymax
  // Resample at ~0.4 m.
  const m = Math.max(64, Math.ceil(L / 0.4))
  const fwd = new Float64Array(m + 1)
  const up = new Float64Array(m + 1)
  const phi = new Float64Array(m + 1)
  for (let q = 0; q <= m; q++) {
    const j = Math.round((q / m) * N)
    fwd[q] = fx[j] * L
    up[q] = fy[j] * L
    phi[q] = fp[j]
  }
  // Land exactly level (removes the integration's last few millimetres of error).
  up[m] = 0
  phi[m] = Math.PI * 2
  return { fwd, up, phi, advance: fwd[m], length: L }
}

/**
 * Metres at each end of a loop over which its roll eases in and out (see spreadLoopRoll).
 * Short, because every metre of easing makes the roll in the middle a little faster:
 * 6 m keeps the loop's lanes leaning less than 5.7 degrees along the road (the gate's
 * limit) on a 14 m road with a 13 m radius loop.
 */
const LOOP_ROLL_EASE = 6

/**
 * Spread a loop's roll evenly from its mouth to where it lands.
 *
 * A corkscrew has to roll. The road goes in flat and comes down flat, but because it
 * drifts sideways over the top, a road that never turned about its own direction
 * would come down tipped over (by 79 degrees for a 13 m loop on a 14 m road: that is
 * the corkscrew's "holonomy"). So the road must roll that much on the way round.
 *
 * Where it rolls matters. The loop is drawn with its up pointing at the centre of its
 * own circle, which keeps the road flat until the drift starts and then makes the
 * whole roll in the top 40 m (2.6 degrees a metre). A road that rolls that fast is
 * twisted like a propeller blade: away from the middle, its surface leans along the
 * road (up to 20 degrees at the lane edges), so the frame's up only matches the
 * surface on the centre line. Spread evenly (here: about 0.8 degrees a metre), the
 * lanes lean under 6 degrees, the camera rolls smoothly instead of snapping over the
 * top, and the road faces much closer to where a car's own path through the corkscrew
 * wants it to face (less sideways grip needed to follow the middle).
 *
 * How: carry the up from the road before the mouth along the loop without any roll
 * (parallel transport, by the "double reflection" method), measure how far it comes
 * out tipped against the road after the landing, and roll each sample by its share of
 * that, easing in and out over LOOP_ROLL_EASE metres. The centre line does not move;
 * only the way the road's cross-section turns about it.
 *
 * `i0`..`i1` are the loop's samples; `fx`, `fy`, `fz` the final positions (float64).
 */
function spreadLoopRoll(S: TrackSamples, fx: Float64Array, fy: Float64Array, fz: Float64Array, i0: number, i1: number): void {
  const n = S.count
  const m = i1 - i0 + 2 // steps from the sample before the mouth to the one after the landing
  if (m < 4 || m >= n) return
  const at = (k: number) => (((i0 - 1 + k) % n) + n) % n // k = 0: before the mouth, k = m: after the landing
  // 1. Carry the up along without rolling it.
  const ux = new Float64Array(m + 1)
  const uy = new Float64Array(m + 1)
  const uz = new Float64Array(m + 1)
  let a = at(0)
  ux[0] = S.ux[a]
  uy[0] = S.uy[a]
  uz[0] = S.uz[a]
  for (let k = 1; k <= m; k++) {
    const b = at(k)
    // Reflect the up and the tangent in the plane halfway between the two samples...
    const v1x = fx[b] - fx[a]
    const v1y = fy[b] - fy[a]
    const v1z = fz[b] - fz[a]
    const c1 = v1x * v1x + v1y * v1y + v1z * v1z || 1
    const du = (2 / c1) * (v1x * ux[k - 1] + v1y * uy[k - 1] + v1z * uz[k - 1])
    const rux = ux[k - 1] - du * v1x
    const ruy = uy[k - 1] - du * v1y
    const ruz = uz[k - 1] - du * v1z
    const dt = (2 / c1) * (v1x * S.tx[a] + v1y * S.ty[a] + v1z * S.tz[a])
    // ...then in the plane that takes the reflected tangent onto the new tangent.
    const v2x = S.tx[b] - (S.tx[a] - dt * v1x)
    const v2y = S.ty[b] - (S.ty[a] - dt * v1y)
    const v2z = S.tz[b] - (S.tz[a] - dt * v1z)
    const c2 = v2x * v2x + v2y * v2y + v2z * v2z
    const d2 = c2 > 1e-20 ? (2 / c2) * (v2x * rux + v2y * ruy + v2z * ruz) : 0
    ux[k] = rux - d2 * v2x
    uy[k] = ruy - d2 * v2y
    uz[k] = ruz - d2 * v2z
    a = b
  }
  // 2. How far it came out tipped, about the tangent after the landing (signed, radians).
  const e = at(m)
  const cx = uy[m] * S.uz[e] - uz[m] * S.uy[e]
  const cy = uz[m] * S.ux[e] - ux[m] * S.uz[e]
  const cz = ux[m] * S.uy[e] - uy[m] * S.ux[e]
  const tipped = Math.atan2(cx * S.tx[e] + cy * S.ty[e] + cz * S.tz[e], ux[m] * S.ux[e] + uy[m] * S.uy[e] + uz[m] * S.uz[e])
  // 3. Roll each sample by its share: an even rate, eased in and out at the ends.
  const ease = Math.max(1, Math.round(LOOP_ROLL_EASE / S.ds))
  const share = new Float64Array(m + 1)
  for (let k = 1; k <= m; k++) {
    const fromEnd = Math.min(k - 0.5, m - k + 0.5)
    share[k] = share[k - 1] + (fromEnd >= ease ? 1 : (1 - Math.cos((Math.PI * fromEnd) / ease)) / 2)
  }
  for (let k = 1; k < m; k++) {
    const i = at(k)
    const roll = (tipped * share[k]) / share[m]
    const tx = S.tx[i]
    const ty = S.ty[i]
    const tz = S.tz[i]
    // Make the carried up square to this tangent, then turn it about the tangent by `roll`.
    const d = ux[k] * tx + uy[k] * ty + uz[k] * tz
    let px = ux[k] - tx * d
    let py = uy[k] - ty * d
    let pz = uz[k] - tz * d
    const pl = Math.hypot(px, py, pz) || 1
    px /= pl
    py /= pl
    pz /= pl
    const c = Math.cos(roll)
    const s = Math.sin(roll)
    const nx = px * c + (ty * pz - tz * py) * s
    const ny = py * c + (tz * px - tx * pz) * s
    const nz = pz * c + (tx * py - ty * px) * s
    S.ux[i] = nx
    S.uy[i] = ny
    S.uz[i] = nz
    S.rx[i] = ty * nz - tz * ny
    S.ry[i] = tz * nx - tx * nz
    S.rz[i] = tx * ny - ty * nx
  }
}

/**
 * The tightest dip (vertical radius, metres) the pivot lift may put in the middle of the road.
 * Where an S-bend's lean changes side, the low edge swaps sides too, so the middle's lift
 * (half the width x sin bank) comes down to nothing and straight back up: a sharp V the car
 * would thump through. 300 m adds about 1.6 g of press at 250 km/h, and fills the V by a
 * few tens of centimetres (both edges sit a little above where the road would be unbanked).
 */
export const PIVOT_DIP_RADIUS = 300

/**
 * The tightest hilltop (vertical radius, metres) the pivot lift may put in the middle of the
 * road. Tilting about the low edge swings the far lane twice as far as tilting about the
 * middle, so where a roll eases into its full bank (the lift stops growing) the outer lane
 * crests twice as hard: a car run wide onto it went light and slid off the high edge
 * (Afterglow's demo laps). Rounding the lift off this gently instead (the road rises over
 * the last 100-200 m into a banked corner, its low edge a little above where it would sit)
 * leaves every lane cresting no harder than tilting about the middle did, plus a car's
 * weight x 0.1 at 250 km/h. Where the bank holds steady, the low edge sits exactly where the
 * road would be unbanked.
 */
export const PIVOT_CREST_RADIUS = 5000

/** The pivot lift is held level from this many metres before a ramp to this many after it (where its jump lands). */
const RAMP_HOLD_BEFORE = 25
const RAMP_HOLD_AFTER = 150

/**
 * Shape the pivot lift (metres per sample, `ds` apart round a closed lap): never below what
 * it was (so the low edge never sinks below where the road would sit unbanked), level over
 * each `held` stretch (sample ranges, may run past the lap's end), with no hilltop tighter
 * than PIVOT_CREST_RADIUS and no dip tighter than PIVOT_DIP_RADIUS.
 */
export function shapePivotLift(lift: Float64Array, ds: number, held: [number, number][] = []): void {
  const n = lift.length
  // Round the lift's hilltops off, then raise each held stretch to the most the rounded lift
  // reaches in it, and round off again from the raised lift: holding a stretch can only
  // raise it, so this settles (the rounding always starts from the unrounded lift: rounding
  // a rounded lift again would round it more each time).
  const base = Float64Array.from(lift)
  const out = new Float64Array(n)
  for (let round = 0; round < 12; round++) {
    out.set(base)
    limitPivotCrest(out, ds)
    let moved = false
    for (const [k0, k1] of held) {
      let top = 0
      for (let k = k0; k <= k1; k++) top = Math.max(top, out[((k % n) + n) % n])
      for (let k = k0; k <= k1; k++) {
        const i = ((k % n) + n) % n
        if (base[i] < top - 1e-6) {
          base[i] = top
          moved = true
        }
      }
    }
    if (!moved) break
  }
  lift.set(out)
  limitPivotDip(lift, ds)
}

/**
 * Raise the pivot lift round any hilltop tighter than PIVOT_CREST_RADIUS: every spot gets at
 * least the height of a parabola of that radius hung from each spot nearby (the hilltop's
 * flanks are filled out until it is that round). Only the flanks of tighter hilltops change.
 */
export function limitPivotCrest(lift: Float64Array, ds: number): void {
  const n = lift.length
  if (n < 3) return
  const c = 1 / PIVOT_CREST_RADIUS
  let top = 0
  for (let k = 0; k < n; k++) top = Math.max(top, lift[k])
  if (top <= 0) return
  // A parabola from the highest lift falls to nothing this many samples away.
  const reach = Math.min(Math.floor((n - 1) / 2), Math.ceil(Math.sqrt((2 * top) / c) / ds))
  const src = Float64Array.from(lift)
  for (let k = 0; k < n; k++) {
    let best = src[k]
    for (let j = 1; j <= reach; j++) {
      const drop = (c * (j * ds) * (j * ds)) / 2
      if (drop >= top) break
      const a = src[(k - j + n) % n] - drop
      const b = src[(k + j) % n] - drop
      if (a > best) best = a
      if (b > best) best = b
    }
    lift[k] = best
  }
}

/**
 * Raise the pivot lift (per sample, `ds` metres apart round a closed lap) as little as
 * possible so it never dips tighter than PIVOT_DIP_RADIUS: the smallest curve at or above
 * it whose upward bend is at most 1 / radius anywhere. That is an exact construction:
 * take away a parabola that bends up by that much, wrap what is left in its upper concave
 * hull (a taut string laid over the top), and add the parabola back. Only spots that bent
 * up faster change; everything else stays exactly as it was.
 */
export function limitPivotDip(lift: Float64Array, ds: number): void {
  const n = lift.length
  if (n < 3) return
  const c = 1 / PIVOT_DIP_RADIUS
  // Start the lap at its highest lift: a banked corner's plateau, never inside a dip.
  let k0 = 0
  for (let k = 1; k < n; k++) if (lift[k] > lift[k0]) k0 = k
  if (lift[k0] <= 0) return
  // Points (s, lift - c s^2 / 2) over one lap from k0 (and back to it), then their upper hull.
  const m = n + 1
  const g = new Float64Array(m)
  for (let j = 0; j < m; j++) {
    const s = j * ds
    g[j] = lift[(k0 + j) % n] - (c * s * s) / 2
  }
  const hull: number[] = []
  for (let j = 0; j < m; j++) {
    // Drop the last hull point while it sits on or under the line from the one before it to j.
    while (hull.length >= 2) {
      const a = hull[hull.length - 2]
      const b = hull[hull.length - 1]
      if ((g[b] - g[a]) * (j - a) <= (g[j] - g[a]) * (b - a)) hull.pop()
      else break
    }
    hull.push(j)
  }
  for (let h = 0; h + 1 < hull.length; h++) {
    const a = hull[h]
    const b = hull[h + 1]
    for (let j = a + 1; j < b; j++) {
      const s = j * ds
      const on = g[a] + ((g[b] - g[a]) * (j - a)) / (b - a)
      lift[(k0 + j) % n] = on + (c * s * s) / 2
    }
  }
}

/** Flip short runs of grounded / not-grounded so the ground doesn't flicker along the road. */
function denoiseRuns(flags: Uint8Array, surface: Uint8Array, minRun: number): void {
  const n = flags.length
  // Find a run boundary to start from so wrap-around runs are handled whole.
  let start = 0
  while (start < n && flags[start] === flags[(start - 1 + n) % n]) start++
  if (start >= n) return
  let i = 0
  while (i < n) {
    const a = (start + i) % n
    const v = flags[a]
    let len = 1
    while (len < n && flags[(a + len) % n] === v) len++
    if (len < minRun && v === 1) {
      for (let k = 0; k < len; k++) flags[(a + k) % n] = 0
    } else if (len < minRun && v === 0) {
      let allRoad = true
      for (let k = 0; k < len; k++) if (surface[(a + k) % n] !== SURFACE_CODE.road) allRoad = false
      if (allRoad) for (let k = 0; k < len; k++) flags[(a + k) % n] = 1
    }
    i += len
  }
}
