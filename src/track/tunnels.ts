// ============================================================
//  TUNNELS - where a tunnel piece digs the road down and covers it
// ------------------------------------------------------------
//  A `tunnel` piece ({ type: 'tunnel', at, length }) asks for a real
//  covered tunnel on that stretch of road. It is built "cut and
//  cover", the way real shallow tunnels are made:
//
//    1. DIG. The road is lowered until a car, a ceiling and a roof of
//       ground all fit under the natural ground over the covered
//       stretch (planTunnelDigs, on the base samples in road.ts).
//       Through a hill that is a little; on flat ground it is the
//       whole height of the tunnel. The dig eases in and out on a
//       gentle ramp at each end (the approaches), long enough that a
//       car at 250 km/h never takes off over the lip.
//    2. GROUND. The ground grid holds the cutting floor (terrain.ts):
//       hollowed out under the tube, natural beside it. Along the
//       approaches the cutting's sides are walls of ground standing
//       straight up from the road's edges (retaining walls), so the
//       dig doesn't spread a wide slope over the hillside.
//    3. TUBE. A solid puts the hill back on top (tunnelMeshes.ts):
//       walls and a ceiling around the road, a roof that follows the
//       natural ground, faces of hillside over each mouth (portals),
//       and the tops of the retaining walls. The ground beside the
//       roof sits a road-edge lip (5 cm) below it, so a car on the
//       hill drives over the roof like ground.
//
//  This file has the plan (how deep, how long the ramps, and whether
//  a tunnel can go here at all), the per-sample facts the ground,
//  meshes and checks share, and a "is this spot on a tunnel" test
//  for things placed by the road. A tunnel that can't be built is
//  left out and its reason is kept, in plain words, for the `tunnel`
//  check (gates.ts) and the road editor.
//
//  Cross-section (looking along the road; b = metres past an edge):
//
//        roof top (natural ground + lip) ...........................
//      |  solid  |                ceiling                |  solid  |
//      |  wall   |                                       |  wall   |
//      |  b 0..9 |        road (cover 0 -> 1 inside)     |  b 0..9 |
//   ground hollowed out (b < 4.5) under the tube, natural beyond 9 m
// ============================================================

import type { ResolvedTrackFile, TunnelPiece } from './schema'
import { TRACK_DEFAULTS } from './schema'
import { SURFACE_CODE, type TrackSamples, type TunnelInfo } from './types'
import type { NaturalTerrain } from './terrain'
import { clamp, smoothstep } from './noise'

/** Shortest and longest covered stretch, metres. */
export const TUNNEL_MIN_LENGTH = 40
export const TUNNEL_MAX_LENGTH = 1500
/** About how far (metres) a tunnel's ramps reach past its covered stretch (the validator's overlap warning; the builder works out each one). */
export const TUNNEL_RAMP_TYPICAL = 190
/** Metres from the road's higher edge up to the ceiling. */
export const TUNNEL_CEILING = 5.6
/** The thinnest the roof over the ceiling may be, metres. */
export const TUNNEL_ROOF_MIN = 1.2
/** Extra depth the dig adds on top of what it needs, metres (the ground between two of its samples). */
const DIG_MARGIN = 0.4
/**
 * How far (metres, past each road edge) the tube's solid reaches. Every 3 m ground cell
 * (4.2 m across its diagonal) that has a corner beyond it then lies wholly beside the tube,
 * and every cell reaching in to the hollow is wholly under it (see TUNNEL_HOLLOW).
 */
export const TUNNEL_WALL = 9
/**
 * The ground is hollowed out (sunk under the road) this far past each edge, under the walls:
 * further than a ground cell reaches, so no ground triangle reaches up into the tunnel, and
 * the ground anywhere a car or camera can be inside is the hollow floor.
 */
export const TUNNEL_HOLLOW = 4.5
/** The tube's top sits this far above the ground beside it (a road-edge lip). */
export const TUNNEL_LIP = 0.05
/** Inside a portal the cover value grows from 0 to 1 over this many metres (daylight reaches in). */
export const TUNNEL_COVER_IN = 30
/** The retaining walls fade in and out over this many metres at the ends of the approaches. */
const WALL_FADE = 20
/** ...and every change in how much wall stands is eased along the road over about twice this (metres). */
const WALL_EASE = 12
/** Ramps: never shorter or longer than these (metres). */
const RAMP_MIN = 90
const RAMP_MAX = 280
/**
 * A ramp is an even S of depth D over R metres (smootherstep), whose tightest crest has a
 * radius of R^2 / (5.77 D). At 250 km/h, keeping that to 60% of gravity's pull (the crest
 * checks allow 80%, and the road's own hills add to it) needs R^2 >= RAMP_K x D.
 */
const RAMP_K = 4730
/** The deepest a tunnel may dig the road down, metres. */
export const TUNNEL_DIG_MAX = 22
/**
 * Other road must keep this far (metres) beyond the walls of a tunnel's open approaches (over its
 * roof it may cross). The walls' tops follow the ground that road shapes (terrain.ts hillGroundOf),
 * so a road may run right beside them; this is the ground between the wall's edge and its shoulder.
 * (Round C tried 3: a click every 20 m on 23 tracks refused just as often, because the roads that
 * refuse a tunnel touch or cross its ramps, so it stays 8.)
 */
const OTHER_ROAD_GAP = 8
/** So other road keeps this far (metres) past a tunnel road's edge, beside its open approaches, to its own edge (the editor sizes a tunnel at a crossing by it). */
export const TUNNEL_CLEAR_BESIDE = TUNNEL_WALL + OTHER_ROAD_GAP
/**
 * A road crossing over a tunnel's roof: the underside of its slab (TunnelPlanInput.overSlab, a road
 * on the ground's: road.ts SLAB_GROUNDED) keeps at least this much roof (metres) over the ceiling,
 * so the slab never pokes into the tunnel.
 */
const OVER_ROAD_AIR = 0.5
/** Samples of the same road closer than this (metres) along it are the tunnel's own stretch. */
const OWN_STRETCH = 80

/** Something the tunnel's stretch has to keep clear of (base s range, and what it is in Josh's words). */
export interface TunnelKeepClear {
  s0: number
  s1: number
  what: string
  /** What kind of thing it is (for the editor's own words). */
  kind: TunnelThing
}

/** The things a tunnel's stretch (ramps included) must keep clear of. */
export type TunnelThing = 'loop' | 'ramp' | 'wallride' | 'grid' | 'tunnel'

/**
 * Why a tunnel couldn't be built, as data (the editor turns it into Josh's words and a thing to
 * try). `dig` and `ramp` are metres: how deep it would go and how long each ramp would be.
 */
export type TunnelRefusal =
  | { kind: 'barriers' }
  | { kind: 'tooHigh'; dig: number; over: boolean }
  | { kind: 'tooShort'; needs: number; lap: number }
  | { kind: 'inTheWay'; thing: TunnelThing; dig: number; ramp: number; where: TunnelWhere | null }
  | { kind: 'roadNear'; over: boolean; dig: number; ramp: number; where: TunnelWhere | null }
  | { kind: 'underTunnel' }

/** Where on the road something in a tunnel's way is: control-point positions (`at`), from and to. */
export interface TunnelWhere {
  from: number
  to: number
}

/**
 * How far a tunnel digs the road at base s: all of D over the covered stretch [sb0, sb1],
 * easing to nothing over R0 metres before it and R1 after it on an even S whose bend starts and
 * ends at zero (smootherstep: the road curves into the dip and out of it gently, never with a
 * sudden change of curve).
 */
function digAt(s: number, sb0: number, sb1: number, D: number, R0: number, R1: number): number {
  const out = s < sb0 ? (sb0 - s) / R0 : s > sb1 ? (s - sb1) / R1 : 0
  const u = Math.min(1, out)
  return D * (1 - u * u * u * (u * (u * 6 - 15) + 10))
}

/**
 * A car's grip on a bend, as a share of gravity, used to judge how fast it can be at a ramp's lip
 * there (the racing line plans up to about 1.2, and the line check stops it at 1.45).
 */
const BEND_GRIP = 1.45
/** The dips check judges a lip at the racing line's speed plus this much. */
const LIP_MARGIN = 1.15

/** The fastest a car is judged at over a ramp's lip (m/s): the crest checks' own cap, 250 km/h. */
const LIP_SPEED = 250 / 3.6
/** At that speed a ramp's lip may ask this much of gravity's pull (the dips check allows 80%)... */
const LIP_SHARE = 0.68
/** ...measured over this many metres either way (the dips check's own look for a long dip). */
const LIP_LOOK = 20

/**
 * The fastest a car is likely to be over one end's ramp (m/s): on a straight, 250 km/h (the crest
 * checks' cap); on a bend all the way along it, as fast as the bend lets a car go (BEND_GRIP), plus
 * the dips check's margin. `from`..`to` is the stretch (base s) the ramp could cover at full length.
 */
function rampSpeed(curvature: Float32Array | undefined, nb: number, dsb: number, from: number, to: number): number {
  if (!curvature) return LIP_SPEED
  let v = 0
  for (let k = Math.floor(from / dsb); k <= Math.ceil(to / dsb); k++) {
    const kappa = Math.abs(curvature[wrapI(k, nb)])
    v = Math.max(v, kappa > 1e-6 ? LIP_MARGIN * Math.sqrt((BEND_GRIP * 9.81) / kappa) : LIP_SPEED)
    if (v >= LIP_SPEED) return LIP_SPEED
  }
  return Math.min(LIP_SPEED, v)
}

/**
 * How long one end's ramp must be (metres; side -1 the way in, +1 the way out). A ramp needs about
 * sqrt(RAMP_K x D) for a car at 250 km/h, less in proportion where a car can't be that fast (on a
 * bend: rampSpeed). The road it is dug into has its own hills, and where one crests near the top of
 * a ramp the two add up, so longer ramps are tried, a tenth longer each time, until no lip asks
 * more than LIP_SHARE of gravity at that speed (or no more than the road already asked there
 * without the tunnel), up to RAMP_MAX.
 */
function rampLength(by: Float64Array, nb: number, dsb: number, sb0: number, sb1: number, D: number, side: -1 | 1, curvature?: Float32Array): number {
  const W = Math.max(1, Math.round(LIP_LOOK / dsb))
  const at = (k: number) => by[wrapI(k, nb)]
  const full = clamp(Math.sqrt(RAMP_K * Math.max(D, 0.5)), RAMP_MIN, RAMP_MAX)
  const v = side < 0 ? rampSpeed(curvature, nb, dsb, sb0 - full * 1.3 - 30, sb0 + 30) : rampSpeed(curvature, nb, dsb, sb1 - 30, sb1 + full * 1.3 + 30)
  // The share of gravity a car at v needs at base sample k, on the road y(k).
  const share = (y: (k: number) => number, k: number): number => {
    const ga = (y(k) - y(k - 2 * W)) / (2 * W * dsb)
    const gb = (y(k + 2 * W) - y(k)) / (2 * W * dsb)
    const crest = -(gb - ga) / (2 * W * dsb)
    return crest > 0 ? (v * v * crest) / 9.81 : 0
  }
  let R = clamp(full * (v / LIP_SPEED), RAMP_MIN, RAMP_MAX)
  for (;;) {
    const dug = (k: number) => at(k) - digAt(k * dsb, sb0, sb1, D, R, R)
    let worst = 0
    let base = 0
    const [from, to] = side < 0 ? [sb0 - R - 30, sb0 + 30] : [sb1 - 30, sb1 + R + 30]
    for (let k = Math.floor(from / dsb); k <= Math.ceil(to / dsb); k++) {
      worst = Math.max(worst, share(dug, k))
      base = Math.max(base, share(at, k))
    }
    if (worst <= Math.max(LIP_SHARE, base + 0.03) || R >= RAMP_MAX) return R
    R = Math.min(RAMP_MAX, R * 1.1)
  }
}

/** One tunnel piece as planned. */
export interface TunnelPlan {
  /** Index in file.pieces. */
  index: number
  /** Covered stretch, base s (sb1 may pass the lap: it wraps). */
  sb0: number
  sb1: number
  /** Ramp length, metres: the longer of the two (rampIn before the covered stretch, rampOut after it). */
  ramp: number
  rampIn: number
  rampOut: number
  /** Deepest dig, metres. */
  depth: number
  /** Why it can't be built (plain words), or null when it is built. */
  problem: string | null
  /** The same, as data (null when it is built). */
  refusal: TunnelRefusal | null
  /** How many times other road crosses over its roof. */
  crossings: number
}

/** Per base sample: how far the tunnels dig it, and which tunnel's stretch it is in. */
export interface TunnelDigs {
  plans: TunnelPlan[]
  /** Metres each base sample is dug down. */
  dig: Float64Array
  /** Index into plans + 1 for base samples in a built tunnel's stretch (approaches included), else 0. */
  slot: Uint8Array
  /** 1 for base samples in a covered stretch. */
  covered: Uint8Array
  /** 1 for base samples of other road that crosses over a built tunnel's roof (its slab there is a bridge's, road.ts). */
  over: Uint8Array
}

export interface TunnelPlanInput {
  pieces: ResolvedTrackFile['pieces']
  baseSOfAt: (at: number) => number
  nb: number
  dsb: number
  Lb: number
  bx: Float64Array
  by: Float64Array
  bz: Float64Array
  bHalf: Float32Array
  bBank: Float32Array
  nat: NaturalTerrain
  keepClear: TunnelKeepClear[]
  /** A road with barriers (a stadium) can't take a tunnel. */
  walled: boolean
  /** The road's horizontal curvature per base sample (1/m), for how fast a car can be at each ramp's end. */
  curvature?: Float32Array
  /** A base s as a control-point position `at` (for a refusal's `where`). */
  atOfBase?: (sb: number) => number
  /** How far down (metres) a road crossing over a tunnel's roof reaches: its slab (road.ts SLAB_GROUNDED). */
  overSlab: number
}

/** Is s within [s0, s1] on a lap of length L (s1 may pass the lap's end)? */
function onLapWithin(s: number, s0: number, s1: number, L: number): boolean {
  let d = s - s0
  d -= Math.floor(d / L) * L
  return d <= s1 - s0
}

/** How many separate runs of samples (gaps of more than 5 apart) a set holds: the number of times a road crosses. */
function countRuns(set: Set<number>, n: number): number {
  if (!set.size) return 0
  const list = [...set].sort((a, b) => a - b)
  let runs = 1
  for (let q = 1; q < list.length; q++) if (list[q] - list[q - 1] > 5) runs++
  // The first and last runs join across the lap's start.
  if (runs > 1 && list[0] + n - list[list.length - 1] <= 5) runs--
  return runs
}

/** Wrap a (possibly negative or past-the-end) index into [0, n). */
function wrapI(k: number, n: number): number {
  return ((k % n) + n) % n
}

/**
 * Plan every tunnel piece on the base samples (before loops are spliced in): how deep the
 * road must go, how long its ramps are, and whether it fits. Tunnels that fit are dug into
 * `by` by the caller (road.ts). Pieces are planned in file order; a later tunnel can't
 * overlap an earlier one.
 */
export function planTunnelDigs(inp: TunnelPlanInput): TunnelDigs {
  const { nb, dsb, Lb, bx, by, bz, bHalf, bBank, nat } = inp
  const dig = new Float64Array(nb)
  const slot = new Uint8Array(nb)
  const covered = new Uint8Array(nb)
  const overRoof = new Uint8Array(nb)
  const plans: TunnelPlan[] = []
  const tunnels = inp.pieces.map((p, index) => ({ p, index })).filter((x) => x.p.type === 'tunnel') as { p: TunnelPiece; index: number }[]
  if (!tunnels.length) return { plans, dig, slot, covered, over: overRoof }

  // Base samples on a coarse grid, for "is other road near this stretch?".
  const CELL = 32
  const key = (cx: number, cz: number) => cx * 100003 + cz
  const cells = new Map<number, number[]>()
  for (let k = 0; k < nb; k++) {
    const kk = key(Math.floor(bx[k] / CELL), Math.floor(bz[k] / CELL))
    const list = cells.get(kk)
    if (list) list.push(k)
    else cells.set(kk, [k])
  }
  let widest = 0
  for (let k = 0; k < nb; k++) widest = Math.max(widest, bHalf[k])
  const own = Math.round(OWN_STRETCH / dsb)
  const taken: TunnelKeepClear[] = []
  /** Visit every base sample near base sample k (within the coarse cells round it) that isn't in [from, to] on the lap. */
  const forOtherRoad = (k: number, from: number, to: number, visit: (j: number) => void) => {
    const r = Math.ceil((bHalf[k] + TUNNEL_WALL + OTHER_ROAD_GAP + widest) / CELL)
    const cx = Math.floor(bx[k] / CELL)
    const cz = Math.floor(bz[k] / CELL)
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        for (const j of cells.get(key(cx + dx, cz + dz)) ?? []) if (wrapI(j - from, nb) > to - from) visit(j)
      }
    }
  }

  for (const { p, index } of tunnels) {
    const length = p.length ?? TRACK_DEFAULTS.tunnelLength
    const sb0 = inp.baseSOfAt(p.at)
    const sb1 = sb0 + length
    const plan: TunnelPlan = { index, sb0, sb1, ramp: 0, rampIn: 0, rampOut: 0, depth: 0, problem: null, refusal: null, crossings: 0 }
    plans.push(plan)
    if (inp.walled) {
      plan.problem = "a road with barriers can't have a tunnel (its walls would stand where the barriers are)"
      plan.refusal = { kind: 'barriers' }
      continue
    }
    // How far the road must go down at each covered sample: the ceiling over its higher
    // edge plus the thinnest roof has to fit under the lowest natural ground across the tube.
    const k0 = Math.floor(sb0 / dsb)
    const k1 = Math.ceil(sb1 / dsb)
    let D = 0
    for (let kk = k0; kk <= k1; kk++) {
      const k = wrapI(kk, nb)
      const a = wrapI(k - 1, nb)
      const b = wrapI(k + 1, nb)
      let hx = bx[b] - bx[a]
      let hz = bz[b] - bz[a]
      const hl = Math.hypot(hx, hz) || 1
      hx /= hl
      hz /= hl
      // Horizontal right: square to the road's heading.
      const rx = -hz
      const rz = hx
      const hw = bHalf[k]
      const reach = hw + TUNNEL_WALL + 1
      let lowest = Infinity
      const steps = Math.ceil((2 * reach) / 2)
      for (let q = 0; q <= steps; q++) {
        const l = -reach + (2 * reach * q) / steps
        lowest = Math.min(lowest, nat.height(bx[k] + rx * l, bz[k] + rz * l))
      }
      const highEdge = by[k] + hw * Math.abs(Math.sin(bBank[k]))
      const n = Math.max(0, highEdge + TUNNEL_CEILING + TUNNEL_ROOF_MIN + DIG_MARGIN - lowest)
      D = Math.max(D, n)
    }
    // Other road crossing over the covered stretch runs on the roof: the dig goes deep enough
    // for that road's slab to sit over the ceiling with roof to spare.
    const near = (k: number, j: number) => Math.hypot(bx[k] - bx[j], bz[k] - bz[j]) < bHalf[k] + TUNNEL_WALL + OTHER_ROAD_GAP + bHalf[j]
    const ownReach = Math.round((RAMP_MAX + OWN_STRETCH) / dsb)
    const over = new Set<number>()
    let overTunnel: TunnelKeepClear | null = null
    for (let kk = k0; kk <= k1; kk++) {
      const k = wrapI(kk, nb)
      const highEdge = by[k] + bHalf[k] * Math.abs(Math.sin(bBank[k]))
      forOtherRoad(k, k0 - ownReach, k1 + ownReach, (j) => {
        if (!near(k, j)) return
        // A road already in a tunnel of its own can't run over this one.
        const inTunnel = taken.find((c) => onLapWithin(j * dsb, c.s0, c.s1, Lb))
        if (inTunnel) overTunnel = inTunnel
        over.add(j)
        const overLow = by[j] - bHalf[j] * Math.abs(Math.sin(bBank[j]))
        D = Math.max(D, highEdge + TUNNEL_CEILING + inp.overSlab + OVER_ROAD_AIR + DIG_MARGIN - overLow)
      })
    }
    if (overTunnel) {
      plan.problem = `the road that crosses over it is in ${(overTunnel as TunnelKeepClear).what} already, and a tunnel can't go under another tunnel. Move one of them`
      plan.refusal = { kind: 'underTunnel' }
      continue
    }
    plan.crossings = countRuns(over, nb)
    if (D > TUNNEL_DIG_MAX) {
      plan.problem =
        over.size > 0
          ? `the road crossing over it is too high above the ground here: a tunnel under it would have to dig ${D.toFixed(0)} m down (at most ${TUNNEL_DIG_MAX} m). Bring that road down to the ground first, or put the tunnel where the road over it runs on the ground`
          : `the road is too high above the ground here: a tunnel would have to dig it ${D.toFixed(0)} m down (at most ${TUNNEL_DIG_MAX} m). Put it where the road runs on the ground, or through a hill`
      plan.refusal = { kind: 'tooHigh', dig: D, over: over.size > 0 }
      continue
    }
    const R0 = rampLength(by, nb, dsb, sb0, sb1, D, -1, inp.curvature)
    const R1 = rampLength(by, nb, dsb, sb0, sb1, D, 1, inp.curvature)
    const R = Math.max(R0, R1)
    plan.ramp = R
    plan.rampIn = R0
    plan.rampOut = R1
    plan.depth = D
    const f0 = sb0 - R0
    const f1 = sb1 + R1
    if (f1 - f0 > Lb - 150) {
      plan.problem = `the road is too short for a tunnel this long: with its ramps it needs ${(f1 - f0).toFixed(0)} m of road (the whole lap is ${Lb.toFixed(0)} m)`
      plan.refusal = { kind: 'tooShort', needs: f1 - f0, lap: Lb }
      continue
    }
    // Clear road for the whole stretch, ramps included.
    const overlaps = (c: TunnelKeepClear) => {
      // Compare on the lap: shift c so it starts after f0.
      let d = c.s0 - f0
      d -= Math.floor(d / Lb) * Lb
      const cLen = c.s1 - c.s0
      return d < f1 - f0 || d + cLen > Lb
    }
    const clash = [...inp.keepClear, ...taken].find(overlaps)
    if (clash) {
      plan.problem = `there's ${clash.what} in the way. The road dips ${D.toFixed(1)} m into the ground for this tunnel, on ramps ${R.toFixed(0)} m long before and after the covered part, and all of that has to be clear road. Move the tunnel, or make it shorter`
      plan.refusal = { kind: 'inTheWay', thing: clash.kind, dig: D, ramp: R, where: inp.atOfBase ? { from: inp.atOfBase(clash.s0), to: inp.atOfBase(clash.s1) } : null }
      continue
    }
    // No other road close beside the open approaches, or across them: there the road runs in a
    // trench between walls of ground, with nothing over it.
    const kf0 = Math.floor(f0 / dsb)
    const kf1 = Math.ceil(f1 / dsb)
    let open = false
    let openAt = -1
    for (let kk = kf0; kk <= kf1 && !open; kk += 2) {
      if (kk >= k0 && kk <= k1) continue
      const k = wrapI(kk, nb)
      forOtherRoad(k, kf0 - own, kf1 + own, (j) => {
        if (!open && near(k, j)) {
          open = true
          openAt = j
        }
      })
    }
    if (open) {
      plan.problem =
        over.size > 0
          ? "the other road comes too close to this tunnel's open ends, where the road dips down between walls of ground. It can only cross over the covered part. Make the tunnel longer so the other road crosses over its roof, or move it"
          : "another part of the road runs too close beside the open ends of this tunnel, where the road dips down between walls of ground. Move the tunnel, or make it longer so the other road crosses over its roof"
      plan.refusal = { kind: 'roadNear', over: over.size > 0, dig: D, ramp: R, where: inp.atOfBase && openAt >= 0 ? { from: inp.atOfBase(openAt * dsb - 15), to: inp.atOfBase(openAt * dsb + 15) } : null }
      continue
    }
    taken.push({ s0: f0, s1: f1, what: `another tunnel (pieces[${index}])`, kind: 'tunnel' })
    for (const j of over) overRoof[j] = 1

    // The dig: the deepest any covered sample needs, all the way through (so the road under
    // the roof runs exactly as it did, just lower, never with a kink of its own), easing back
    // to nothing over each ramp on an even S whose bend starts and ends at zero (smootherstep:
    // the road curves into the dip and out of it gently, with no sudden change of curve).
    const list = plans.length // slot value (index into plans + 1)
    for (let kk = kf0; kk <= kf1; kk++) {
      const k = wrapI(kk, nb)
      const s = kk * dsb
      dig[k] = Math.max(dig[k], digAt(s, sb0, sb1, D, R0, R1))
      slot[k] = list
      if (s >= sb0 && s <= sb1) covered[k] = 1
    }
  }
  return { plans, dig, slot, covered, over: overRoof }
}

/** Per final sample: everything about the tunnels the ground, the meshes and the checks share. */
export interface TunnelSamples {
  /** Every tunnel piece as planned (built or not). */
  plans: TunnelPlan[]
  /** The built ones, along the final road. */
  list: TunnelInfo[]
  /** Index into list + 1 for samples in a built tunnel's stretch (approaches included), else 0. */
  slot: Uint8Array
  /** 1 for samples under a roof. */
  covered: Uint8Array
  /** Metres the road is dug down here by a tunnel. */
  dig: Float32Array
  /**
   * How much of a straight wall of ground stands beside each edge (0..1): 1 under the roof and
   * along the deep part of an approach, fading to 0 (the usual sloped shoulder) where the road
   * comes back up to the ground. 0 everywhere else.
   */
  wallL: Float32Array
  wallR: Float32Array
  /** Height of the ceiling over each covered sample (NaN elsewhere). */
  ceil: Float32Array
  /** 0..1 how far inside a covered stretch (TUNNEL_COVER_IN from each portal), 0 in the open. */
  cover: Float32Array
}

/**
 * Work out the per-sample tunnel facts on the final road, from the dig and the flags the
 * base samples carried through the splice (road.ts). `slot` here holds plan index + 1.
 */
export function finishTunnels(S: TrackSamples, plans: TunnelPlan[], dig: Float32Array, planSlot: Uint8Array, covered: Uint8Array, nat: NaturalTerrain): TunnelSamples {
  const n = S.count
  const slot = new Uint8Array(n)
  const wallL = new Float32Array(n)
  const wallR = new Float32Array(n)
  const ceil = new Float32Array(n).fill(NaN)
  const cover = new Float32Array(n)
  const list: TunnelInfo[] = []
  for (let p = 0; p < plans.length; p++) {
    if (plans[p].problem) continue
    // This tunnel's samples (never across the start line: the start grid keeps them apart).
    let a = -1
    let b = -1
    let c0 = -1
    let c1 = -1
    for (let i = 0; i < n; i++) {
      if (planSlot[i] !== p + 1 || S.surface[i] !== SURFACE_CODE.road) continue
      if (a < 0) a = i
      b = i
      if (covered[i]) {
        if (c0 < 0) c0 = i
        c1 = i
      }
    }
    if (a < 0 || c0 < 0) continue
    const id = list.length + 1
    let depth = 0
    let clearance = Infinity
    for (let i = a; i <= b; i++) {
      slot[i] = id
      depth = Math.max(depth, dig[i])
      const hw = S.halfWidth[i]
      const ly = S.py[i] - S.ry[i] * hw
      const ry = S.py[i] + S.ry[i] * hw
      const inCover = i >= c0 && i <= c1
      covered[i] = inCover ? 1 : 0
      if (inCover) {
        ceil[i] = Math.max(ly, ry) + TUNNEL_CEILING
        clearance = Math.min(clearance, ceil[i] - Math.max(ly, ry))
        cover[i] = smoothstep(0, TUNNEL_COVER_IN, Math.min(i - c0, c1 - i) * S.ds)
        wallL[i] = 1
        wallR[i] = 1
        continue
      }
      // An approach: a straight wall of ground where the road is well below the ground beside
      // it, easing to the usual sloped shoulder as it comes back up, and fading in and out at
      // the ends of the stretch.
      const rl = Math.hypot(S.rx[i], S.rz[i]) || 1
      const ox = S.rx[i] / rl
      const oz = S.rz[i] / rl
      const fade = smoothstep(0, WALL_FADE, Math.min(i - a, b - i) * S.ds)
      for (const side of [-1, 1] as const) {
        const ex = S.px[i] + S.rx[i] * side * hw
        const ez = S.pz[i] + S.rz[i] * side * hw
        const ey = side < 0 ? ly : ry
        let h = Infinity
        for (let q = 0; q <= 3; q++) {
          const d = (TUNNEL_WALL * q) / 3
          h = Math.min(h, nat.height(ex + ox * side * d, ez + oz * side * d) - ey)
        }
        const w = smoothstep(0.5, 2.5, h) * fade
        if (side < 0) wallL[i] = w
        else wallR[i] = w
      }
    }
    // Ease the walls in and out along the road: they grow from nothing over tens of metres,
    // never in a car's length. (Where that reaches road with the ground beside it below the
    // road, the wall only ever raises the ground: terrain.ts blends up, never down.)
    for (const arr of [wallL, wallR]) {
      const r = Math.max(1, Math.round(WALL_EASE / S.ds))
      const tmp = new Float32Array(b - a + 1)
      for (let pass = 0; pass < 2; pass++) {
        for (let i = a; i <= b; i++) {
          let sum = 0
          let cnt = 0
          for (let k = Math.max(a, i - r); k <= Math.min(b, i + r); k++) {
            sum += arr[k]
            cnt++
          }
          tmp[i - a] = sum / cnt
        }
        for (let i = a; i <= b; i++) arr[i] = i >= c0 && i <= c1 ? 1 : tmp[i - a]
      }
      // The blur lifts the stretch's very ends off nothing (it averages in the wall further in), so a
      // wall would start with a sixth of it already standing, a step over the open shoulder beyond
      // its end cap (up to 28 cm on a hillside). Fade it out at the ends again.
      for (let i = a; i < c0; i++) arr[i] *= smoothstep(0, WALL_FADE, (i - a) * S.ds)
      for (let i = c1 + 1; i <= b; i++) arr[i] *= smoothstep(0, WALL_FADE, (b - i) * S.ds)
    }
    list.push({ index: plans[p].index, s0: c0 * S.ds, s1: (c1 + 1) * S.ds, a0: a * S.ds, a1: (b + 1) * S.ds, depth, clearance })
  }
  // Samples outside a built tunnel carry no dig or cover.
  for (let i = 0; i < n; i++) if (!slot[i]) covered[i] = 0
  return { plans, list, slot, covered, dig, wallL, wallR, ceil, cover }
}

/** A stretch of other road that crosses over a tunnel's roof. */
export interface RoadOverTunnel {
  /** Index into TunnelSamples.list (and TrackRuntime.tunnels). */
  tunnel: number
  /** Its first and last sample over the tube (i1 may be below i0 where it runs over the lap's start). */
  i0: number
  i1: number
}

/**
 * Every stretch of road that crosses over a built tunnel's covered part: samples of other road
 * (not the tunnel's own stretch, nor OWN_STRETCH metres of road either side) whose spot lies over
 * the tube (over its road, or over its walls out to TUNNEL_WALL past the edge).
 */
export function roadOverTunnels(S: TrackSamples, ts: TunnelSamples): RoadOverTunnel[] {
  const out: RoadOverTunnel[] = []
  const n = S.count
  const own = Math.round(OWN_STRETCH / S.ds)
  for (let t = 0; t < ts.list.length; t++) {
    const id = t + 1
    const cov: number[] = []
    let a = -1
    let b = -1
    let minX = Infinity
    let maxX = -Infinity
    let minZ = Infinity
    let maxZ = -Infinity
    for (let i = 0; i < n; i++) {
      if (ts.slot[i] !== id) continue
      if (a < 0) a = i
      b = i
      if (!ts.covered[i]) continue
      cov.push(i)
      minX = Math.min(minX, S.px[i])
      maxX = Math.max(maxX, S.px[i])
      minZ = Math.min(minZ, S.pz[i])
      maxZ = Math.max(maxZ, S.pz[i])
    }
    if (!cov.length) continue
    const pad = TUNNEL_WALL + 20
    const over = (j: number): boolean => {
      if (S.surface[j] !== SURFACE_CODE.road) return false
      if (wrapI(j - (a - own), n) <= b - a + 2 * own) return false
      const x = S.px[j]
      const z = S.pz[j]
      if (x < minX - pad || x > maxX + pad || z < minZ - pad || z > maxZ + pad) return false
      let best = -1
      let bestD = Infinity
      for (const i of cov) {
        const d = (x - S.px[i]) ** 2 + (z - S.pz[i]) ** 2
        if (d < bestD) {
          bestD = d
          best = i
        }
      }
      const dx = x - S.px[best]
      const dz = z - S.pz[best]
      if (Math.abs(dx * S.tx[best] + dz * S.tz[best]) > S.ds) return false
      const rh2 = S.rx[best] * S.rx[best] + S.rz[best] * S.rz[best]
      const lat = rh2 > 1e-4 ? (dx * S.rx[best] + dz * S.rz[best]) / rh2 : 0
      return Math.abs(lat) <= S.halfWidth[best] + TUNNEL_WALL
    }
    // Runs of samples over the tube (joined across the lap's start).
    let start = -1
    for (let k = 0; k <= n; k++) {
      const yes = k < n && over(k)
      if (yes && start < 0) start = k
      if (!yes && start >= 0) {
        out.push({ tunnel: t, i0: start, i1: k - 1 })
        start = -1
      }
    }
    const mine = out.filter((r) => r.tunnel === t)
    if (mine.length > 1 && mine[0].i0 === 0 && mine[mine.length - 1].i1 === n - 1) {
      mine[0].i0 = mine[mine.length - 1].i0
      out.splice(out.indexOf(mine[mine.length - 1]), 1)
    }
  }
  return out
}

/**
 * A test for "is this spot on or inside a tunnel?" (its tube, retaining walls or their
 * tops, plus `margin` metres), for things placed by the road: posts, billboards, crash
 * props and energy cores keep off. Returns the side (-1 left, +1 right) and how far out
 * the solid reaches there, so a caller can move a thing clear; null when the spot is clear.
 */
export function makeTunnelFootprint(S: TrackSamples, ts: TunnelSamples | null): (x: number, z: number, margin: number) => { side: -1 | 1; i: number; lateral: number; outer: number } | null {
  if (!ts || !ts.list.length) return () => null
  // The samples of every tunnel stretch, with a bounding box per tunnel.
  const groups: { idx: number[]; minX: number; maxX: number; minZ: number; maxZ: number }[] = []
  for (let t = 1; t <= ts.list.length; t++) {
    const idx: number[] = []
    let minX = Infinity
    let maxX = -Infinity
    let minZ = Infinity
    let maxZ = -Infinity
    for (let i = 0; i < S.count; i++) {
      if (ts.slot[i] !== t) continue
      idx.push(i)
      minX = Math.min(minX, S.px[i])
      maxX = Math.max(maxX, S.px[i])
      minZ = Math.min(minZ, S.pz[i])
      maxZ = Math.max(maxZ, S.pz[i])
    }
    groups.push({ idx, minX, maxX, minZ, maxZ })
  }
  return (x, z, margin) => {
    let best: { side: -1 | 1; i: number; lateral: number; outer: number } | null = null
    let bestD = Infinity
    for (const g of groups) {
      const pad = 40 + margin
      if (x < g.minX - pad || x > g.maxX + pad || z < g.minZ - pad || z > g.maxZ + pad) continue
      for (let k = 0; k < g.idx.length; k++) {
        const i = g.idx[k]
        const dx = x - S.px[i]
        const dz = z - S.pz[i]
        const d2 = dx * dx + dz * dz
        if (d2 >= bestD) continue
        const rl2 = S.rx[i] * S.rx[i] + S.rz[i] * S.rz[i]
        const lat = rl2 > 1e-6 ? (dx * S.rx[i] + dz * S.rz[i]) / rl2 : 0
        const along = Math.abs(dx * S.tx[i] + dz * S.tz[i])
        const side: -1 | 1 = lat < 0 ? -1 : 1
        const w = ts.covered[i] ? 1 : side < 0 ? ts.wallL[i] : ts.wallR[i]
        // Where no wall stands, only the road itself (and the margin) is kept clear.
        const outer = S.halfWidth[i] + (w > 0.02 ? TUNNEL_WALL : 0)
        if (along <= 2 && Math.abs(lat) <= outer + margin) {
          bestD = d2
          best = { side, i, lateral: lat, outer }
        }
      }
    }
    return best
  }
}
