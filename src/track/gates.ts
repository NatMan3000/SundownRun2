// ============================================================
//  TRACK GATES - "does this track work?" without any physics
// ------------------------------------------------------------
//  runTrackGates(runtime) runs every check that needs only the
//  built track (no rapier), and returns one row per check:
//
//    line      the Ai racing line is sane and drivable
//    winding   every triangle faces the right way
//    smooth    no kinks in the road
//    banking   leans into corners, rolls gently
//    crest     where the bank rolls, no lane curves away from a car
//              faster than gravity holds it on (bankRolls.ts)
//    bridges   a car fits under every crossing
//    loops     nothing in a car's way on or around a loop
//    surface   the road faces the way its frames say, and the physics
//              triangles follow it (no sawtooth where the road twists)
//    under     no physics ground close under the road at an angle (a
//              car's body catches on it through the road)
//    barriers  stadium barriers stand up as walls on a bank's low edge,
//              with no ditch behind them
//    cutting   the sides of a road dug into the ground are slopes,
//              not cliffs (cuttings.ts)
//    dips      a car stays on over the lip of a dip (cuttings.ts)
//    tunnel    every tunnel piece is a real tunnel: room for a car
//              under its ceiling, a solid roof, no ground inside, its
//              top meeting the ground beside it (tunnelChecks.ts); or,
//              if it couldn't be built, why
//    tracking  "where am I on the road?" never jumps by mistake
//    ground    the ground stays under the road
//    ride      road riding the ground has no hilltop that throws a car
//              off below 200 km/h (a warning: a jump on purpose is fine)
//    + warnings (start grid on a bend, fewer billboards than asked)
//
//  The SAME function feeds `bun run tracks:check` (scripts/
//  check-tracks.ts) and the road editor's checks panel, so the two
//  can never disagree. It is cheap enough to run after each edit
//  (tens of milliseconds; a track with an adjustable bank also
//  rebuilds itself at the slider's ends to check those).
//
//  The physics checks (dropping and sliding test cars in rapier)
//  live in selftest.ts and run only from the command line.
// ============================================================

import type { TrackRuntime, NearestHit } from './types'
import { SURFACE_CODE } from './types'
import { requiredClearance, TUNNEL_WALL_MIN } from './terrain'
import { buildTrack, trackInternals } from './build'
import { colliderDriveSurface } from './colliders'
import { groundHoleAt } from './terrainTiles'
import { barrierAxes, type BarrierAxes } from './ribbon'
import { brakeOnSlope, carFullLockG, LINE_MAX_LAT_G } from './derived'
import { CREST_CHECK_KMH, CREST_LANE_INSET, CREST_LIMIT, CREST_SPAN, LEAN_AHEAD_DEG, LEAN_SPEED_KMH } from './bankRolls'
import { CUT_SLOPE_MAX_DEG, CUT_STEP_MAX, cuttingSides, dipLips } from './cuttings'
import { OVER_EDGE_MAX, OVER_ROOF_SLACK, TUNNEL_CLEARANCE_MIN, TUNNEL_GROUND_BELOW, TUNNEL_LIP_MAX, TUNNEL_ROOF_CHECK, tunnelChecks } from './tunnelChecks'

const G = 9.81
/** The banking gate's limit on leaning ahead of the bend: the builder's own rule plus a degree. */
const LEAN_AHEAD_LIMIT_DEG = LEAN_AHEAD_DEG + 1

/** One gate row. `level` 'warn' never fails a track; 'fail' does (and then ok is false). */
export interface TrackGate {
  name: string
  ok: boolean
  level: 'ok' | 'warn' | 'fail'
  message: string
  /** What to change, when it failed or warned. */
  fix?: string
}

/**
 * A road position for messages: "s=812 (at 7.4)". s is metres along the built road
 * from the start line (loops included); at is the control-point position in the file
 * (point index + fraction), which is what you edit.
 */
export function where(t: TrackRuntime, s: number): string {
  const x = trackInternals(t)
  const sw = t.wrapS(s)
  return x ? `s=${sw.toFixed(0)} (at ${x.atOfS(sw).toFixed(1)})` : `s=${sw.toFixed(0)}`
}

/**
 * Worst gap between the ground and the road surface, measured across every
 * grounded sample (negative = the ground is safely below). No physics needed.
 */
export function groundClearance(t: TrackRuntime): { worst: number; s: number; lateral: number; edgeStep: number } {
  const S = t.samples
  let worst = -Infinity
  let ws = 0
  let wl = 0
  for (let i = 0; i < S.count; i++) {
    if (S.surface[i] !== SURFACE_CODE.road || S.grounded[i] !== 1) continue
    const hw = S.halfWidth[i]
    for (let k = 0; k <= 16; k++) {
      const l = -hw + (2 * hw * k) / 16
      // Positive = the ground is closer to the surface than the rule allows.
      const d = t.terrainHeight(S.px[i] + S.rx[i] * l, S.pz[i] + S.rz[i] * l) - (S.py[i] + S.ry[i] * l) + requiredClearance(l, hw)
      if (d > worst) {
        worst = d
        ws = i * S.ds
        wl = l
      }
    }
  }
  // Edge step: how far the ground sits below the edge just outside it (median over the lap;
  // not beside a tunnel's walls, which stand there instead).
  const steps: number[] = []
  const tunnelSlot = trackInternals(t)?.tunnels.slot
  for (let i = 0; i < S.count; i += 5) {
    if (S.surface[i] !== SURFACE_CODE.road || S.grounded[i] !== 1 || tunnelSlot?.[i]) continue
    for (const side of [-1, 1]) {
      const l = side * (S.halfWidth[i] + 0.5)
      const ey = S.py[i] + S.ry[i] * side * S.halfWidth[i]
      steps.push(ey - t.terrainHeight(S.px[i] + S.rx[i] * l, S.pz[i] + S.rz[i] * l))
    }
  }
  steps.sort((a, b) => a - b)
  return { worst, s: ws, lateral: wl, edgeStep: steps.length ? steps[Math.floor(steps.length / 2)] : 0 }
}

/**
 * How smooth the ribbon is: the sharpest turn of the tangent and of the up vector
 * between neighbouring samples (degrees per metre), and the worst spacing error.
 * A kink here is a bump a car feels (or a step it crashes into).
 */
export function ribbonSmoothness(t: TrackRuntime): { roadTurn: number; loopTurn: number; upTurn: number; spacingErr: number; at: number } {
  const S = t.samples
  const n = S.count
  let roadTurn = 0
  let loopTurn = 0
  let upTurn = 0
  let spacingErr = 0
  let at = 0
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const dt = Math.acos(Math.min(1, S.tx[i] * S.tx[j] + S.ty[i] * S.ty[j] + S.tz[i] * S.tz[j])) * (180 / Math.PI) / S.ds
    const du = Math.acos(Math.min(1, S.ux[i] * S.ux[j] + S.uy[i] * S.uy[j] + S.uz[i] * S.uz[j])) * (180 / Math.PI) / S.ds
    const sp = Math.abs(Math.hypot(S.px[j] - S.px[i], S.py[j] - S.py[i], S.pz[j] - S.pz[i]) - S.ds)
    const onLoop = S.surface[i] === SURFACE_CODE.loop || S.surface[j] === SURFACE_CODE.loop
    if (onLoop) loopTurn = Math.max(loopTurn, dt)
    else {
      if (dt > roadTurn) {
        roadTurn = dt
        at = i * S.ds
      }
      upTurn = Math.max(upTurn, du)
    }
    spacingErr = Math.max(spacingErr, sp)
  }
  return { roadTurn, loopTurn, upTurn, spacingErr, at }
}

/** Where the road passes over itself, the two levels must be at least this far apart (metres: the slab plus a car). */
export const BRIDGE_ROOM = 6.2

/**
 * The height between two bits of road that overlap seen from above (sample a and b),
 * across every lane: a point every half metre across each road, and the other road's
 * surface straight above or below it, where it reaches. Measured between the two
 * surfaces, like the middles: on a banked road the high lane sits higher than the middle
 * (an open road tilts about its LOW edge, so by up to the width x sin(bank)), and a car
 * on it has that much less room under a bridge. Infinity when no lane of one lies under
 * or over the other's slice of road (they only touch at the corners).
 */
function laneGap(S: TrackRuntime['samples'], a: number, b: number): number {
  let gap = Infinity
  for (const [i, j] of [[a, b], [b, a]]) {
    // Road j's surface over a plan spot (x, z): solve p_j + right_j * u + tangent_j * v = (x, z) seen from above.
    const det = S.rx[j] * S.tz[j] - S.rz[j] * S.tx[j]
    if (Math.abs(det) < 1e-6) continue
    const hw = S.halfWidth[i]
    for (let l = -hw; l <= hw + 1e-6; l += 0.5) {
      const dx = S.px[i] + S.rx[i] * l - S.px[j]
      const dz = S.pz[i] + S.rz[i] * l - S.pz[j]
      const u = (dx * S.tz[j] - dz * S.tx[j]) / det
      const v = (S.rx[j] * dz - S.rz[j] * dx) / det
      // Only road j's own slice (half a sample either way) and its width.
      if (Math.abs(u) > S.halfWidth[j] || Math.abs(v) > S.ds / 2) continue
      const yj = S.py[j] + S.ry[j] * u + S.ty[j] * v
      const yi = S.py[i] + S.ry[i] * l
      gap = Math.min(gap, Math.abs(yj - yi))
    }
  }
  return gap
}

/**
 * Where the road passes over itself (a bridge), the smallest height gap between
 * the two levels, measured on the built road: between the middles, and across every
 * lane (laneGap: a banked road's high lane rises toward a bridge above it). null when
 * the road never overlaps itself. Loops are left out (their lanes pass under their own
 * loop by design).
 */
export function crossingClearance(t: TrackRuntime): { gap: number; s1: number; s2: number } | null {
  const S = t.samples
  let best: { gap: number; s1: number; s2: number } | null = null
  for (const p of crossingPairs(t)) if (!best || p.gap < best.gap) best = { gap: p.gap, s1: p.i * S.ds, s2: p.j * S.ds }
  return best
}

/**
 * Every pair of road samples (i < j, at least 80 m apart along the road) that overlap
 * seen from above, with the height between them (the middles' and every lane's, the
 * smaller: see crossingClearance). Loops are left out.
 */
function crossingPairs(t: TrackRuntime): { i: number; j: number; gap: number }[] {
  const memo = pairsMemo.get(t)
  if (memo) return memo
  const S = t.samples
  const n = S.count
  const CELL = 16
  const cells = new Map<number, number[]>()
  const key = (cx: number, cz: number) => cx * 100003 + cz
  for (let i = 0; i < n; i++) {
    if (S.surface[i] === SURFACE_CODE.loop) continue
    const k = key(Math.floor(S.px[i] / CELL), Math.floor(S.pz[i] / CELL))
    const list = cells.get(k)
    if (list) list.push(i)
    else cells.set(k, [i])
  }
  const pairs: { i: number; j: number; gap: number }[] = []
  for (let i = 0; i < n; i++) {
    if (S.surface[i] === SURFACE_CODE.loop) continue
    const cx = Math.floor(S.px[i] / CELL)
    const cz = Math.floor(S.pz[i] / CELL)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (const j of cells.get(key(cx + dx, cz + dz)) ?? []) {
          if (j <= i) continue
          const ds = Math.abs(t.deltaS(i * S.ds, j * S.ds))
          if (ds < 80) continue
          const h = Math.hypot(S.px[i] - S.px[j], S.pz[i] - S.pz[j])
          if (h > S.halfWidth[i] + S.halfWidth[j]) continue
          pairs.push({ i, j, gap: Math.min(Math.abs(S.py[i] - S.py[j]), laneGap(S, i, j)) })
        }
      }
    }
  }
  pairsMemo.set(t, pairs)
  return pairs
}
/** crossingPairs per built track (three checks ask). */
const pairsMemo = new WeakMap<TrackRuntime, { i: number; j: number; gap: number }[]>()

/** How far along the road (metres) from a crossing too low for a car its checks leave to the `bridges` row. */
const LOW_BRIDGE_REACH = 40

/**
 * 1 per sample within LOW_BRIDGE_REACH of a crossing whose levels are less than BRIDGE_ROOM
 * apart (either level). Under a bridge that low the ground is cut away to make what room
 * there is (terrain.ts), and a car can't be there anyway: the `bridges` row fails, and Josh
 * fixes it by raising the bridge or easing the bank under it.
 */
function nearLowBridge(t: TrackRuntime): Uint8Array {
  const S = t.samples
  const out = new Uint8Array(S.count)
  const reach = Math.ceil(LOW_BRIDGE_REACH / S.ds)
  for (const p of crossingPairs(t)) {
    if (p.gap >= BRIDGE_ROOM) continue
    for (const c of [p.i, p.j]) for (let k = -reach; k <= reach; k++) out[(((c + k) % S.count) + S.count) % S.count] = 1
  }
  return out
}

/**
 * "Where am I on the road?" must never jump to another bit of road by mistake. Every
 * car asks nearest() each step with its last s as the hint, so:
 *  - Walk the whole lap (left, middle, right of the road, at car height) a metre at a
 *    time with hints: s must never step more than 2 m (crossings and loops included).
 *  - At every crossing: a car that dropped off the upper road onto (or beside) the
 *    lower one is found on the lower; a car on either level is found on it with a
 *    stale hint from the other or with no hint; a car flying above the lower road
 *    under the bridge, or on the grass beside it, keeps the lower road.
 *    Not at a crossing too low for a car (less than BRIDGE_ROOM between the levels,
 *    over any lane): a car can't be under that bridge, and the `bridges` row fails
 *    there (Josh can fix that; a car under the high lane of a banked road was found on
 *    the bridge a metre and a half above its roof, and this row blamed the game).
 *    `tooLow` counts those.
 */
export function roadTracking(t: TrackRuntime): { crossings: number; tooLow: number; walks: number; maxStep: number; stepAt: number; failures: string[] } {
  const S = t.samples
  const n = S.count
  const hit: NearestHit = { s: 0, index: 0, lateral: 0, height: 0, distance: 0, onRoad: false }
  const failures: string[] = []
  const CAR_Y = 0.55
  // Point on the road at sample i, `lat` metres right and `up` metres above the surface.
  const P = { x: 0, y: 0, z: 0 }
  const at = (i: number, lat: number, up: number) => {
    P.x = S.px[i] + S.rx[i] * lat + S.ux[i] * up
    P.y = S.py[i] + S.ry[i] * lat + S.uy[i] * up
    P.z = S.pz[i] + S.rz[i] * lat + S.uz[i] * up
    return P
  }
  // 1. The whole lap, three lanes.
  let maxStep = 0
  let stepAt = 0
  let walks = 0
  for (const f of [-1, 0, 1]) {
    walks++
    let sh = 0
    for (let k = 0; k <= n; k++) {
      const i = k % n
      const p = at(i, f * Math.max(0, S.halfWidth[i] - 1), CAR_Y)
      t.nearest(p.x, p.y, p.z, hit, sh)
      const step = Math.abs(t.deltaS(sh, hit.s))
      if (step > maxStep) {
        maxStep = step
        stepAt = i * S.ds
      }
      sh = hit.s
    }
  }
  if (maxStep > 2) failures.push(`walking the lap with hints, s jumped ${maxStep.toFixed(0)} m at ${where(t, stepAt)}`)
  // 2. Crossings: road samples far apart along the road but on top of each other.
  // (Bucketed on a 16 m grid in plan view, so only near neighbours are compared.)
  const found: { lo: number; hi: number }[] = []
  const CELL = 16
  const cells = new Map<number, number[]>()
  const key = (cx: number, cz: number) => cx * 100003 + cz
  for (let i = 0; i < n; i += 2) {
    if (S.surface[i] !== SURFACE_CODE.road) continue
    const k = key(Math.floor(S.px[i] / CELL), Math.floor(S.pz[i] / CELL))
    const list = cells.get(k)
    if (list) list.push(i)
    else cells.set(k, [i])
  }
  for (let i = 0; i < n; i += 2) {
    if (S.surface[i] !== SURFACE_CODE.road) continue
    const cx = Math.floor(S.px[i] / CELL)
    const cz = Math.floor(S.pz[i] / CELL)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (const j of cells.get(key(cx + dx, cz + dz)) ?? []) {
          if (j <= i || Math.abs(t.deltaS(i * S.ds, j * S.ds)) < 80) continue
          // One road's centre inside the other's lane, on a different level.
          if (Math.hypot(S.px[i] - S.px[j], S.pz[i] - S.pz[j]) > Math.min(S.halfWidth[i], S.halfWidth[j])) continue
          if (Math.abs(S.py[i] - S.py[j]) < 3) continue
          if (found.some((c) => Math.abs(t.deltaS(c.lo * S.ds, i * S.ds)) < 40 || Math.abs(t.deltaS(c.hi * S.ds, i * S.ds)) < 40)) continue
          found.push(S.py[i] < S.py[j] ? { lo: i, hi: j } : { lo: j, hi: i })
        }
      }
    }
  }
  const expect = (what: string, hint: number | undefined, want: number) => {
    t.nearest(P.x, P.y, P.z, hit, hint === undefined ? undefined : hint * S.ds)
    if (Math.abs(t.deltaS(hit.s, want * S.ds)) > 20) {
      failures.push(`${what}: found at ${where(t, hit.s)}, should be ${where(t, want * S.ds)}`)
    }
  }
  // The least room between the levels at each crossing (crossingClearance's measure, within 40 m of it).
  const pairs = found.length ? crossingPairs(t) : []
  const near = (a: number, b: number) => Math.abs(t.deltaS(a * S.ds, b * S.ds)) <= 40
  let tooLow = 0
  for (const { lo, hi } of found) {
    let room = Infinity
    for (const p of pairs) if ((near(p.i, lo) && near(p.j, hi)) || (near(p.i, hi) && near(p.j, lo))) room = Math.min(room, p.gap)
    if (room < BRIDGE_ROOM) {
      tooLow++
      continue
    }
    const hwL = S.halfWidth[lo]
    const hwH = S.halfWidth[hi]
    for (const f of [-1, 0, 1]) {
      at(lo, f * (hwL - 1), CAR_Y)
      expect(`on the lower road under the bridge, hint on the bridge (fell off it)`, hi, lo)
      expect(`on the lower road under the bridge, no hint`, undefined, lo)
      at(hi, f * (hwH - 1), CAR_Y)
      expect(`on the bridge, hint on the road below (stale)`, lo, hi)
      expect(`on the bridge, no hint`, undefined, hi)
    }
    // In a covered tunnel there is no grass beside the lower road (its walls stand there); a car
    // can be up on the roof beside the road crossing over it instead.
    const inTunnel = !!trackInternals(t)?.tunnels.covered[lo]
    for (const side of [-1, 1]) {
      if (inTunnel) {
        at(hi, side * (hwH + 4), CAR_Y)
        expect(`on the tunnel's roof beside the road over it, hint on that road (slid off its edge)`, hi, hi)
        expect(`on the tunnel's roof beside the road over it, no hint`, undefined, hi)
        continue
      }
      // On the grass beside the lower road, under or beside the bridge.
      const p = at(lo, side * (hwL + 8), 0)
      P.y = t.terrainHeight(p.x, p.z) + CAR_Y
      expect(`on the grass beside the lower road, hint on the bridge (fell off it)`, hi, lo)
      expect(`on the grass beside the lower road, hint on it`, lo, lo)
    }
    // In the air over the lower road, between it and the bridge.
    const gap = S.py[hi] - S.py[lo]
    at(lo, 0, Math.min(6, gap / 2))
    expect(`in the air over the lower road under the bridge, hint on it`, lo, lo)
  }
  return { crossings: found.length, tooLow, walks, maxStep, stepAt, failures }
}

/**
 * Every triangle must face the way its vertex normals say (three.js culls the back
 * of a triangle, so a wrongly wound road is invisible from above). Returns how many
 * triangles disagree, per mesh.
 */
export function windingErrors(t: TrackRuntime): Record<string, { bad: number; total: number }> {
  const out: Record<string, { bad: number; total: number }> = {}
  const meshes = { road: t.meshes.road, skirt: t.meshes.skirt, barriers: t.meshes.barriers, ramps: t.meshes.ramps, 'tunnel inside': t.meshes.tunnels?.inside ?? null, 'tunnel hill': t.meshes.tunnels?.hill ?? null }
  for (const [name, m] of Object.entries(meshes)) {
    if (!m) continue
    const P = m.positions
    const N = m.normals
    const I = m.indices
    let bad = 0
    for (let k = 0; k < I.length; k += 3) {
      const a = I[k] * 3
      const b = I[k + 1] * 3
      const c = I[k + 2] * 3
      const e1x = P[b] - P[a]
      const e1y = P[b + 1] - P[a + 1]
      const e1z = P[b + 2] - P[a + 2]
      const e2x = P[c] - P[a]
      const e2y = P[c + 1] - P[a + 1]
      const e2z = P[c + 2] - P[a + 2]
      const gx = e1y * e2z - e1z * e2y
      const gy = e1z * e2x - e1x * e2z
      const gz = e1x * e2y - e1y * e2x
      if (gx * gx + gy * gy + gz * gz < 1e-12) continue // a zero-area sliver faces nowhere
      const nx = N[a] + N[b] + N[c]
      const ny = N[a + 1] + N[b + 1] + N[c + 1]
      const nz = N[a + 2] + N[b + 2] + N[c + 2]
      if (gx * nx + gy * ny + gz * nz <= 0) bad++
    }
    out[name] = { bad, total: I.length / 3 }
  }
  return out
}

/**
 * Banking sanity. A road should lean INTO the corner it is in, never the other way,
 * and roll in and out gently. Returns the fastest roll change (degrees per metre,
 * including across the start-line seam) and how many metres lean the wrong way by
 * more than 2 degrees out of a clearly curved bit of road (curvature averaged over
 * +/-20 m, radius under 600 m).
 * Where a `bank` override in the file makes the road lean out on purpose (off-camber),
 * those metres are counted separately as overrideOut and not treated as a fault.
 * Also how far the bank leans AHEAD of its bend (leanAhead, degrees): more than the
 * bend wants at the track's design speed (capped at LEAN_SPEED_KMH), which on a
 * straight pulls every car down the slope (bankRolls.ts, LEAN_AHEAD_DEG). A bank the
 * file asks for with an override is the file's choice and not counted.
 */
export function bankCheck(t: TrackRuntime): { maxRate: number; rateAt: number; wrongSign: number; wrongAt: number; overrideOut: number; leanAhead: number; leanAt: number } {
  const over = trackInternals(t)?.overrideWeight
  let overrideOut = 0
  const S = t.samples
  const n = S.count
  const W = Math.max(1, Math.round(20 / S.ds))
  // Running sum for a fast circular average of the curvature.
  let sum = 0
  for (let k = -W; k <= W; k++) sum += S.curvature[(k + n) % n]
  let maxRate = 0
  let rateAt = 0
  let wrongSign = 0
  let wrongAt = -1
  let leanAhead = -Infinity
  let leanAt = 0
  const vLean = Math.min(t.file.road.banking.designSpeedKmh, LEAN_SPEED_KMH) / 3.6
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const rate = (Math.abs(S.bank[j] - S.bank[i]) * 180) / Math.PI / S.ds
    if (rate > maxRate) {
      maxRate = rate
      rateAt = i * S.ds
    }
    const kAvg = sum / (2 * W + 1)
    const bankDeg = (S.bank[i] * 180) / Math.PI
    // + bank = left edge up = leaning into a right-hander (+ curvature).
    if (S.surface[i] === SURFACE_CODE.road && Math.abs(kAvg) > 1 / 600 && Math.abs(bankDeg) > 2 && Math.sign(bankDeg) !== Math.sign(kAvg)) {
      // Leaning out of a corner because the FILE asks for it (a negative bank override,
      // off-camber on purpose) is allowed and counted separately; the builder doing it is a fault.
      if (over && over[i] > 0.5) overrideOut++
      else {
        wrongSign++
        if (wrongAt < 0) wrongAt = i * S.ds
      }
    }
    if (S.surface[i] === SURFACE_CODE.road && !(over && over[i] > 0.5)) {
      const wants = (Math.atan((vLean * vLean * Math.max(0, kAvg * Math.sign(bankDeg))) / G) * 180) / Math.PI
      if (Math.abs(bankDeg) - wants > leanAhead) {
        leanAhead = Math.abs(bankDeg) - wants
        leanAt = i * S.ds
      }
    }
    sum += S.curvature[(i + W + 1) % n] - S.curvature[(i - W + n) % n]
  }
  return { maxRate, rateAt, wrongSign: Math.round(wrongSign * S.ds), wrongAt, overrideOut: Math.round(overrideOut * S.ds), leanAhead: Math.max(0, leanAhead), leanAt }
}

/**
 * Racing line health: how much of the lap sits at the edge limit (and the longest
 * such stretch), the closest it comes to a road edge, the most sideways grip its
 * target speeds ask for (v^2 x curvature / g, less what banking carries), and how
 * many metres of braking ask for more than the brakes have on that slope.
 */
export function racingLineStats(t: TrackRuntime): {
  clampFrac: number
  longestClampM: number
  minEdgeGap: number
  maxLatG: number
  brakeOverM: number
  brakeOverBy: number
  /** The most of the worst car's full-lock turn the line asks for anywhere (1 = full lock). */
  lockShare: number
  lockShareKmh: number
} {
  const S = t.samples
  const n = S.count
  const off = t.racingLine.offset
  const spd = t.racingLine.speed
  let atLimit = 0
  let run = 0
  let longest = 0
  let minGap = Infinity
  // The limit is whatever the builder clamped to; find it per sample as hw - |offset| at its smallest
  // over the lap, then count samples within 5 cm of that.
  for (let i = 0; i < n; i++) {
    if (S.surface[i] !== SURFACE_CODE.road) continue
    minGap = Math.min(minGap, S.halfWidth[i] - Math.abs(off[i]))
  }
  for (let i = 0; i < 2 * n; i++) {
    const k = i % n
    const at = S.surface[k] === SURFACE_CODE.road && S.halfWidth[k] - Math.abs(off[k]) <= minGap + 0.05
    if (i < n && at) atLimit++
    run = at ? run + 1 : 0
    if (run > longest) longest = run
  }
  // Planned sideways acceleration from the line's own curvature, and how much of the
  // worst car's full-lock turn that is at the planned speed.
  let maxLat = 0
  let lockShare = 0
  let lockShareKmh = 0
  const W = Math.max(1, Math.round(4 / S.ds))
  for (let i = 0; i < n; i++) {
    if (S.surface[i] !== SURFACE_CODE.road) continue
    const a = (i - W + n) % n
    const b = (i + W) % n
    const P = (j: number) => {
      const rl = Math.hypot(S.rx[j], S.rz[j]) || 1
      return [S.px[j] + (S.rx[j] / rl) * off[j], S.pz[j] + (S.rz[j] / rl) * off[j]]
    }
    const [ax, az] = P(a)
    const [bx, bz] = P(i)
    const [cx, cz] = P(b)
    const ux = bx - ax
    const uz = bz - az
    const vx = cx - bx
    const vz = cz - bz
    const d = Math.hypot(ux, uz) * Math.hypot(vx, vz) * Math.hypot(cx - ax, cz - az)
    const k = d > 1e-9 ? Math.abs((2 * (ux * vz - uz * vx)) / d) : 0
    // Banking carries part of the load: count only what the tyres must provide.
    const into = S.bank[i] * Math.sign(ux * vz - uz * vx)
    const lat = (spd[i] * spd[i] * k * Math.cos(into) - 9.81 * Math.sin(into)) / 9.81
    maxLat = Math.max(maxLat, lat)
    // The steering turns the car along the road's surface: on a bank the curve is gentler there (cos).
    const share = (spd[i] * spd[i] * k * Math.cos(into)) / 9.81 / carFullLockG(spd[i])
    if (share > lockShare) {
      lockShare = share
      lockShareKmh = spd[i] * 3.6
    }
  }
  // Braking that fits the hill: slowing from speed[i] to speed[i+1] over one sample must
  // need no more than the brakes have there (less downhill, more uphill).
  let brakeOver = 0
  let brakeOverBy = 0
  for (let i = 0; i < n; i++) {
    if (S.surface[i] !== SURFACE_CODE.road) continue
    const j = (i + 1) % n
    const need = (spd[i] * spd[i] - spd[j] * spd[j]) / (2 * S.ds)
    const over = need - brakeOnSlope(S.ty[i])
    if (over > 0.05) brakeOver++
    brakeOverBy = Math.max(brakeOverBy, over)
  }
  return { clampFrac: atLimit / n, longestClampM: Math.min(longest, n) * S.ds, minEdgeGap: minGap, maxLatG: maxLat, brakeOverM: brakeOver * S.ds, brakeOverBy, lockShare, lockShareKmh }
}

/** Room a car needs between a road surface and anything above it, metres (car about 1.3 m tall, plus margin). */
const CAR_ROOM = 2.2
/** A loop bent further than this (metres, along the road) to land on the road has a kink where it lands. */
const LOOP_STRETCH_MAX = 2

/**
 * Around every loop (its run-in, the loop itself, and where it lands): is anything
 * solid within a car's height above the surface? That catches another bit of road
 * passing through the loop (a crossing too close) and a loop bent so far to fit a
 * bend that its legs clash. Returns the worst spot per loop.
 */
export function loopClearance(t: TrackRuntime): { s0: number; room: number; at: number; over: number; stretch: number }[] {
  const x = trackInternals(t)
  if (!x) return []
  const S = t.samples
  const n = S.count
  const thick = x.thickness
  const out: { s0: number; room: number; at: number; over: number; stretch: number }[] = []
  for (const L of x.loops) {
    // The zone: 60 m of road either side of the loop, and the loop.
    const zone: number[] = []
    const span = t.deltaS(L.s0 - 60, L.s1 + 60)
    for (let d = 0; d <= span; d += S.ds) zone.push(Math.round(t.wrapS(L.s0 - 60 + d) / S.ds) % n)
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    let minZ = Infinity
    let maxZ = -Infinity
    for (const i of zone) {
      minX = Math.min(minX, S.px[i])
      maxX = Math.max(maxX, S.px[i])
      minY = Math.min(minY, S.py[i])
      maxY = Math.max(maxY, S.py[i])
      minZ = Math.min(minZ, S.pz[i])
      maxZ = Math.max(maxZ, S.pz[i])
    }
    const pad = 20
    const near: number[] = []
    for (let j = 0; j < n; j++) {
      if (S.px[j] < minX - pad || S.px[j] > maxX + pad || S.pz[j] < minZ - pad || S.pz[j] > maxZ + pad) continue
      if (S.py[j] < minY - pad || S.py[j] > maxY + pad) continue
      near.push(j)
    }
    let room = Infinity
    let at = L.s0
    let over = L.s0
    for (const a of zone) {
      const hwA = S.halfWidth[a]
      for (const b of near) {
        if (Math.abs(t.deltaS(a * S.ds, b * S.ds)) < 25) continue
        // Walk across b's whole width a metre at a time (b's samples are a metre apart
        // along it, so this covers its surface on a 1 m grid), and see whether any of
        // its slab, top to underside, sits over a's lane within a car's height.
        const hwB = S.halfWidth[b]
        const facing = S.ux[a] * S.ux[b] + S.uy[a] * S.uy[b] + S.uz[a] * S.uz[b]
        const drop = thick[b] * facing // how far b's underside sits below its top, in a's up
        for (let l = -hwB; l <= hwB + 1e-6; l += 1) {
          const vx = S.px[b] + S.rx[b] * l - S.px[a]
          const vy = S.py[b] + S.ry[b] * l - S.py[a]
          const vz = S.pz[b] + S.rz[b] * l - S.pz[a]
          if (Math.abs(vx * S.tx[a] + vy * S.ty[a] + vz * S.tz[a]) > 1) continue
          if (Math.abs(vx * S.rx[a] + vy * S.ry[a] + vz * S.rz[a]) > hwA) continue
          const top = vx * S.ux[a] + vy * S.uy[a] + vz * S.uz[a]
          const low = Math.min(top, top - drop)
          const high = Math.max(top, top - drop)
          if (high < 0.05) continue // all of it below a's surface (a is the one on top)
          const r = Math.max(0, low) // slab cutting through a's surface: no room at all
          if (r < room) {
            room = r
            at = a * S.ds
            over = b * S.ds
          }
        }
      }
    }
    out.push({ s0: L.s0, room, at, over, stretch: Math.abs(L.stretch.along) })
  }
  return out
}

/** A loop's lanes may lean along the road at most this far (degrees) from the frame's up: cos = 0.995. */
export const LANE_LEAN_MAX_DEG = 5.73
/** The middle of the road must face the frame's up within this (degrees): cos = 0.995. */
const MIDDLE_TILT_MAX_DEG = 5.73
/** A physics triangle may face at most this far (degrees) from the real road under it. */
const FIT_MAX_DEG = 2

/**
 * A loop radius whose lanes would lean less than LANE_LEAN_MAX_DEG, from the radius and
 * lean it has now. The lean falls a bit faster than 1 / radius^1.7 as a loop grows
 * (measured on a 14 m road, radius 6 to 30), so this errs a little big, plus 5% spare.
 */
function suggestLoopRadius(radius: number, leanDeg: number): number {
  return Math.ceil(radius * Math.pow(leanDeg / (LANE_LEAN_MAX_DEG * 0.95), 1 / 1.7))
}

/**
 * Does the road surface face the way its frames say, everywhere a car can be?
 *
 * Every car, the camera and the Ai trust a sample's frame: "up" is the way the road
 * faces, "right" runs across it. This checks those against the triangles the physics
 * really uses (the road colliders' own mesh, colliderDriveSurface), one triangle at a
 * time, against the frame halfway along its stretch:
 *
 *  middle    triangles over the centre line face the frame's up (and right lies in
 *            the surface). If not, the frames don't describe the road at all.
 *  fit       every triangle faces within FIT_MAX_DEG of the real road under it (the
 *            smooth surface the samples describe). Two big triangles across a road
 *            that twists don't: they form a sawtooth the wheels feel.
 *  lanes     where a car's middle can be (up to a metre from each edge). A road that
 *            twists about its own direction leans along the road away from its middle,
 *            by about atan(lateral x twist). On loops the builder decides how the
 *            corkscrew's roll is spread, so a loop's lanes must stay within
 *            LANE_LEAN_MAX_DEG. On ordinary road the lean comes from the bank rolling
 *            in (the banking gate limits how fast), so it is reported, not judged.
 */
export function surfaceFit(t: TrackRuntime): {
  middleDeg: number
  middleAt: number
  rightOutDeg: number
  fitDeg: number
  fitAt: number
  loops: { s0: number; s1: number; radius: number; leanDeg: number; leanAt: number; rollDeg: number; length: number }[]
  roadLeanDeg: number
  roadLeanAt: number
  triangles: number
} {
  const S = t.samples
  const n = S.count
  const d = colliderDriveSurface(t)
  const P = d.positions
  const L = d.lateral
  const deg = 180 / Math.PI
  const loopRuns = (trackInternals(t)?.loops ?? []).map((l) => ({ s0: l.s0, s1: l.s1, radius: l.radius, leanDeg: 0, leanAt: l.s0, rollDeg: 0, length: t.deltaS(l.s0, l.s1) }))
  const loopOf = (q: number): number => {
    const s = q * S.ds
    for (let k = 0; k < loopRuns.length; k++) if (t.deltaS(loopRuns[k].s0, s) >= 0 && t.deltaS(s, loopRuns[k].s1) > 0) return k
    return -1
  }
  let middle = 0
  let middleAt = 0
  let rightOut = 0
  let fit = 0
  let fitAt = 0
  let roadLean = 0
  let roadLeanAt = 0
  const tris = d.triQuad.length
  for (let k = 0; k < tris; k++) {
    const q = d.triQuad[k]
    const i = q
    const j = (q + 1) % n
    // The frame halfway along this stretch.
    let ux = S.ux[i] + S.ux[j]
    let uy = S.uy[i] + S.uy[j]
    let uz = S.uz[i] + S.uz[j]
    const ul = Math.hypot(ux, uy, uz) || 1
    ux /= ul
    uy /= ul
    uz /= ul
    let rx = S.rx[i] + S.rx[j]
    let ry = S.ry[i] + S.ry[j]
    let rz = S.rz[i] + S.rz[j]
    const rl = Math.hypot(rx, ry, rz) || 1
    rx /= rl
    ry /= rl
    rz /= rl
    // The triangle's own facing (turned to the up side).
    const a = d.indices[k * 3]
    const b = d.indices[k * 3 + 1]
    const c = d.indices[k * 3 + 2]
    const e1x = P[b * 3] - P[a * 3]
    const e1y = P[b * 3 + 1] - P[a * 3 + 1]
    const e1z = P[b * 3 + 2] - P[a * 3 + 2]
    const e2x = P[c * 3] - P[a * 3]
    const e2y = P[c * 3 + 1] - P[a * 3 + 1]
    const e2z = P[c * 3 + 2] - P[a * 3 + 2]
    let nx = e1y * e2z - e1z * e2y
    let ny = e1z * e2x - e1x * e2z
    let nz = e1x * e2y - e1y * e2x
    const nl = Math.hypot(nx, ny, nz)
    if (nl < 1e-9) continue
    const sg = nx * ux + ny * uy + nz * uz >= 0 ? 1 / nl : -1 / nl
    nx *= sg
    ny *= sg
    nz *= sg
    const lean = Math.acos(Math.min(1, nx * ux + ny * uy + nz * uz)) * deg
    const la = L[a]
    const lb = L[b]
    const lc = L[c]
    const lMid = (la + lb + lc) / 3
    // The real road under it: the surface swept by the frame's right, at this lateral.
    // Along the road it runs (P_j - P_i) + lMid (R_j - R_i); across, along right.
    const gx = S.px[j] - S.px[i] + lMid * (S.rx[j] - S.rx[i])
    const gy = S.py[j] - S.py[i] + lMid * (S.ry[j] - S.ry[i])
    const gz = S.pz[j] - S.pz[i] + lMid * (S.rz[j] - S.rz[i])
    let tx = ry * gz - rz * gy
    let ty = rz * gx - rx * gz
    let tz = rx * gy - ry * gx
    const tl = Math.hypot(tx, ty, tz) || 1
    const ts = tx * ux + ty * uy + tz * uz >= 0 ? 1 / tl : -1 / tl
    tx *= ts
    ty *= ts
    tz *= ts
    const off = Math.acos(Math.min(1, nx * tx + ny * ty + nz * tz)) * deg
    if (off > fit) {
      fit = off
      fitAt = q * S.ds
    }
    if (Math.min(la, lb, lc) <= 0 && Math.max(la, lb, lc) >= 0) {
      if (lean > middle) {
        middle = lean
        middleAt = q * S.ds
      }
      rightOut = Math.max(rightOut, Math.asin(Math.min(1, Math.abs(nx * rx + ny * ry + nz * rz))) * deg)
    }
    const hw = Math.max(S.halfWidth[i], S.halfWidth[j])
    if (Math.abs(lMid) <= hw - 1) {
      const li = S.surface[i] === SURFACE_CODE.loop ? loopOf(q) : -1
      if (li >= 0) {
        if (lean > loopRuns[li].leanDeg) {
          loopRuns[li].leanDeg = lean
          loopRuns[li].leanAt = q * S.ds
        }
      } else if (lean > roadLean) {
        roadLean = lean
        roadLeanAt = q * S.ds
      }
    }
  }
  // How far each loop rolls about its own direction on the way round (for the message).
  for (const lr of loopRuns) {
    let roll = 0
    const i0 = Math.round(lr.s0 / S.ds)
    const m = Math.round(lr.length / S.ds)
    for (let k = -1; k <= m; k++) {
      const i = (((i0 + k) % n) + n) % n
      const j = (i + 1) % n
      roll += ((S.rx[j] - S.rx[i]) * (S.ux[i] + S.ux[j]) + (S.ry[j] - S.ry[i]) * (S.uy[i] + S.uy[j]) + (S.rz[j] - S.rz[i]) * (S.uz[i] + S.uz[j])) / 2
    }
    lr.rollDeg = Math.abs(roll) * deg
  }
  return { middleDeg: middle, middleAt, rightOutDeg: rightOut, fitDeg: fit, fitAt, loops: loopRuns, roadLeanDeg: roadLean, roadLeanAt, triangles: tris }
}

/** Ground the physics keeps under the deck closer than this (metres, along the road's up)... */
const UNDER_GAP = 0.5
/** An open road's outer band (metres) where the ground rises to meet the lip (terrain.ts EDGE_BAND + 2). */
const EDGE_BAND_JUDGE = 4.5
/** ...must face the road's own way within this (degrees). */
const UNDER_TILT_DEG = 15
/**
 * On a bank this steep (degrees) or more, the low barrier's face must rise at least
 * BARRIER_FACE_MIN_DEG from flat (else it's a ramp a car drives up) and meet the road at
 * least BARRIER_V_MIN_DEG (else it overhangs the road's low edge and wedges a car).
 */
const UPRIGHT_FROM_DEG = 15
const BARRIER_FACE_MIN_DEG = 55
const BARRIER_V_MIN_DEG = 55
/** Behind a low barrier the ground may sit at most this far (metres) below the road's edge. */
const DITCH_MAX = 0.5

/**
 * The physics ground under the road (see terrainTiles.ts: under the road's closed slab
 * it is mostly left out). Where some is kept close under the deck it must face the way
 * the road does, or a car's body touching it through the road gets shoved sideways
 * (hyper-1 D4: ground facets 0.1 m under a 60 degree deck, tilted 29 degrees, kicked
 * the car). Open roads keep ground just under their edges on purpose (flush, for
 * driving back on from the grass), so they are judged up to a metre from each edge;
 * walled roads up to half a metre. Measured on every grounded sample.
 */
export function underDeck(t: TrackRuntime): {
  clearPct: number
  /** Worst where it is judged: the whole width on a road with barriers, the middle of an open road. */
  worstTilt: number
  worstGap: number
  at: number
  lateral: number
  /** Worst in an open road's edge band, where the ground rises to meet the lip on purpose (reported, not judged). */
  bandTilt: number
  bandAt: number
} {
  const S = t.samples
  const walls = t.file.road.barriers === 'walls'
  let pts = 0
  let clear = 0
  let worstTilt = 0
  let worstGap = Infinity
  let at = 0
  let lateral = 0
  let bandTilt = 0
  let bandAt = 0
  const e = 0.3
  for (let i = 0; i < S.count; i++) {
    if (S.surface[i] !== SURFACE_CODE.road || S.grounded[i] !== 1) continue
    const hw = S.halfWidth[i]
    // An open road's ground rises to meet the lip over its outer EDGE_BAND_JUDGE metres
    // (terrain.ts), so close ground there is by design.
    const middle = walls ? hw - 0.5 : hw - EDGE_BAND_JUDGE
    for (let l = -hw + 0.5; l <= hw - 0.5 + 1e-6; l += 0.5) {
      pts++
      const x = S.px[i] + S.rx[i] * l
      const y = S.py[i] + S.ry[i] * l
      const z = S.pz[i] + S.rz[i] * l
      if (groundHoleAt(t, x, z)) {
        clear++
        continue
      }
      const gap = (y - t.terrainHeight(x, z)) * S.uy[i]
      if (gap >= UNDER_GAP) {
        clear++
        continue
      }
      const hx = t.terrainHeight(x + e, z) - t.terrainHeight(x - e, z)
      const hz = t.terrainHeight(x, z + e) - t.terrainHeight(x, z - e)
      const nl = Math.hypot(hx, 2 * e, hz)
      const tilt = (Math.acos(Math.min(1, (-hx * S.ux[i] + 2 * e * S.uy[i] - hz * S.uz[i]) / nl)) * 180) / Math.PI
      if (Math.abs(l) <= middle) {
        if (tilt > worstTilt) {
          worstTilt = tilt
          worstGap = gap
          at = i * S.ds
          lateral = l
        }
      } else if (tilt > bandTilt) {
        bandTilt = tilt
        bandAt = i * S.ds
      }
    }
  }
  return { clearPct: pts ? (clear / pts) * 100 : 100, worstTilt, worstGap, at, lateral, bandTilt, bandAt }
}

/**
 * Stadium barriers on a bank. On the LOW edge of a steep bank the barrier must be a
 * wall: square to a 60 degree road it leans out at 30 degrees, a ramp cars drive up and
 * over (hyper-1 D3); fully upright it meets the road at only 30 degrees and wedges a car
 * parked by it. So its face must rise steeply AND meet the road at a wide angle. And the
 * ground behind it must not dip below the road's edge (that ditch is where those cars got
 * stuck). Returns the shallowest face and the narrowest angle with the road where the bank
 * is UPRIGHT_FROM_DEG or more, and the deepest ground 1-20 m behind a low edge.
 */
export function barrierStance(t: TrackRuntime): { face: number; faceAt: number; vAngle: number; vAt: number; ditch: number; ditchAt: number } {
  const S = t.samples
  const ax: BarrierAxes = { dx: 0, dy: 0, dz: 0, ox: 0, oy: 0, oz: 0 }
  let face = 90
  let faceAt = 0
  let vAngle = 180
  let vAt = 0
  let ditch = 0
  let ditchAt = 0
  const minDrop = Math.sin((UPRIGHT_FROM_DEG * Math.PI) / 180)
  for (let i = 0; i < S.count; i++) {
    if (S.surface[i] !== SURFACE_CODE.road) continue
    for (const side of [-1, 1] as const) {
      const drop = -side * S.ry[i]
      if (drop < -0.02) continue // the high edge: the ground rightly falls away behind it
      if (drop >= minDrop) {
        barrierAxes(S, i, side, ax)
        const deg = 180 / Math.PI
        // How steeply the face rises from flat, and its angle with the road running in from the edge.
        const f = Math.asin(Math.max(-1, Math.min(1, ax.dy))) * deg
        const v = Math.acos(Math.max(-1, Math.min(1, -side * (S.rx[i] * ax.dx + S.ry[i] * ax.dy + S.rz[i] * ax.dz)))) * deg
        if (f < face) {
          face = f
          faceAt = i * S.ds
        }
        if (v < vAngle) {
          vAngle = v
          vAt = i * S.ds
        }
      }
      if (i % 2) continue
      const hw = S.halfWidth[i]
      const rl = Math.hypot(S.rx[i], S.rz[i]) || 1
      const ex = S.px[i] + S.rx[i] * side * hw
      const ey = S.py[i] + S.ry[i] * side * hw
      const ez = S.pz[i] + S.rz[i] * side * hw
      for (let d = 1; d <= 20; d += 1) {
        const below = ey - t.terrainHeight(ex + (S.rx[i] / rl) * side * d, ez + (S.rz[i] / rl) * side * d)
        if (below > ditch) {
          ditch = below
          ditchAt = i * S.ds
        }
      }
    }
  }
  return { face, faceAt, vAngle, vAt, ditch, ditchAt }
}

/** Banks from this many degrees count for the low-edge ditch check (gentler ones barely tilt). */
const LOW_DITCH_BANK_DEG = 2
/**
 * How far out past an open road's low edge (flat metres) the ground is looked at for a ditch:
 * where a car on the low lane, or just off it, can put a wheel. Further out the ground is the
 * world's own (a hollow in the hills, or the cut under a bridge passing over).
 */
const LOW_DITCH_REACH = 6
/** The deepest a ditch beside an open road's low edge may be (metres below the edge). */
export const LOW_DITCH_MAX = 0.2
/** How far an open road's low edge may sit below where the road would be unbanked (metres). */
export const LOW_SINK_MAX = 0.05

/**
 * An open road's LOW edge on a bank (GitHub #9). The low edge must stay where the road would
 * sit unbanked (on the ground, for a road on the ground) and the ground beside it level with
 * it, so a car on the low lane, or just off it, has nothing to drop into.
 *  - sink: how far the low edge sits below where the road would be unbanked: the middle less
 *    the lift the bank's pivot put there (road.ts). Banked about its middle, it sank by half
 *    the width x sin(bank). The deepest anywhere on road banked LOW_DITCH_BANK_DEG or more.
 *  - ditch: ground that dips below the edge and rises again further out (ground that simply
 *    falls away from a road on a bank of fill is not one): at each spot out to
 *    LOW_DITCH_REACH, the lower of the edge and the highest ground further out, less the
 *    ground there. The deepest, on road on the ground banked LOW_DITCH_BANK_DEG or more.
 *    Not near a crossing too low for a car (nearLowBridge): the cut under that bridge digs
 *    beside the road below it until the bridge is raised (the `bridges` row). `lowBridge`
 *    is how many metres were left out for that.
 * null when no road is banked that much.
 */
export function lowEdgeDitch(t: TrackRuntime): { depth: number; at: number; out: number; bankDeg: number; banked: number; lowBridge: number; sink: number; sinkAt: number; sinkBankDeg: number } | null {
  const S = t.samples
  const minBank = (LOW_DITCH_BANK_DEG * Math.PI) / 180
  const g = new Float64Array(Math.round(LOW_DITCH_REACH * 2))
  const lift = trackInternals(t)?.pivotLift
  let depth = 0
  let at = 0
  let out = 0
  let bankDeg = 0
  let banked = 0
  let lowBridge = 0
  const tooLow = nearLowBridge(t)
  let sink = 0
  let sinkAt = 0
  let sinkBankDeg = 0
  let any = false
  for (let i = 0; i < S.count; i++) {
    if (S.surface[i] !== SURFACE_CODE.road || Math.abs(S.bank[i]) < minBank) continue
    any = true
    const low = S.ry[i] > 0 ? -1 : 1
    // Unbanked: the middle less its lift. The low edge: the middle plus the right vector's drop.
    const below = S.py[i] - (lift ? lift[i] : 0) - (S.py[i] + S.ry[i] * low * S.halfWidth[i])
    if (below > sink) {
      sink = below
      sinkAt = i * S.ds
      sinkBankDeg = (Math.abs(S.bank[i]) * 180) / Math.PI
    }
  }
  // Only road on the ground for LOW_DITCH_REACH metres either way: where a road on its bank of
  // fill lifts off into a bridge, the fill ends in a slope beside it on purpose.
  const reach = Math.ceil(LOW_DITCH_REACH / S.ds)
  const onGround = (i: number) => S.surface[i] === SURFACE_CODE.road && S.grounded[i] === 1
  let off = 0
  for (let k = -reach; k <= reach; k++) if (!onGround((k + S.count) % S.count)) off++
  const tunnels = trackInternals(t)?.tunnels
  for (let i = 0; i < S.count; i++) {
    const clear = off === 0
    off += (onGround((i - reach + S.count) % S.count) ? 0 : -1) + (onGround((i + reach + 1) % S.count) ? 0 : 1)
    if (!clear || Math.abs(S.bank[i]) < minBank) continue
    // Beside a tunnel's wall of ground there is no ground to judge (the tunnel check does).
    if (tunnels && tunnels.slot[i] && (S.ry[i] > 0 ? tunnels.wallL[i] : tunnels.wallR[i]) > TUNNEL_WALL_MIN) continue
    if (tooLow[i]) {
      lowBridge++
      continue
    }
    banked++
    const hw = S.halfWidth[i]
    const low = S.ry[i] > 0 ? -1 : 1
    const rl = Math.hypot(S.rx[i], S.rz[i]) || 1
    const ex = S.px[i] + S.rx[i] * low * hw
    const ey = S.py[i] + S.ry[i] * low * hw
    const ez = S.pz[i] + S.rz[i] * low * hw
    for (let k = 0; k < g.length; k++) {
      const dist = (k + 1) * 0.5
      g[k] = t.terrainHeight(ex + (S.rx[i] / rl) * low * dist, ez + (S.rz[i] / rl) * low * dist)
    }
    let beyond = -Infinity
    for (let k = g.length - 1; k >= 0; k--) {
      beyond = Math.max(beyond, g[k])
      const dip = Math.min(ey, beyond) - g[k]
      if (dip > depth) {
        depth = dip
        at = i * S.ds
        out = (k + 1) * 0.5
        bankDeg = (Math.abs(S.bank[i]) * 180) / Math.PI
      }
    }
  }
  return any ? { depth, at, out, bankDeg, banked: Math.round(banked * S.ds), lowBridge: Math.round(lowBridge * S.ds), sink, sinkAt, sinkBankDeg } : null
}

/** A car can be going this much faster than the racing line plans (a later brake, a boost). */
const CREST_LINE_MARGIN = 1.15

/**
 * Bank-roll crests (see bankRolls.ts). Along the outermost lanes a car's middle can be
 * on (CREST_LANE_INSET from each edge), how much of gravity's pull toward the road the
 * road's curving away asks for, measured on the finished 3D road over CREST_SPAN
 * metres either side. The lane swinging about the middle as the bank rolls counts, and
 * so does the middle's bend under the bank: a corner pressing the car into its bank
 * helps, a wobble the other way under a steep bank lifts it. The middle's own hilltops
 * (crests that unload the car on purpose) are the track's design and are not judged;
 * a dip that presses the car on still helps. The rise and fall an open road's bank puts
 * in its middle (it banks about its low edge) is the roll, not the design: it is judged.
 *
 * Judged at the speed a car can be doing there: the racing line's plan plus 15%, up to
 * CREST_CHECK_KMH. `flat` is the worst at CREST_CHECK_KMH everywhere (reported only).
 * Also returns the roll the worst spot sits in: where it starts and ends and its banks.
 */
export function bankCrests(t: TrackRuntime): {
  worst: number
  at: number
  lateral: number
  kmh: number
  need: number
  hold: number
  flat: number
  roll: { s0: number; s1: number; bank0: number; bank1: number }
} {
  const S = t.samples
  const n = S.count
  const h = Math.max(1, Math.round(CREST_SPAN / S.ds))
  const d = h * S.ds
  const vTop = CREST_CHECK_KMH / 3.6
  const pivotLift = trackInternals(t)?.pivotLift
  let worst = -Infinity
  let wi = 0
  let lateral = 0
  let kmh = 0
  let need = 0
  let hold = 0
  let flat = -Infinity
  for (let i = 0; i < n; i++) {
    const a = (i - h + n) % n
    const b = (i + h) % n
    if (S.surface[a] !== SURFACE_CODE.road || S.surface[i] !== SURFACE_CODE.road || S.surface[b] !== SURFACE_CODE.road) continue
    const nx = S.ux[i]
    const ny = S.uy[i]
    const nz = S.uz[i]
    // Second differences of the middle (C) and of the right vector (R), along the road's up.
    const c2x = (S.px[a] + S.px[b] - 2 * S.px[i]) / (d * d)
    const c2y = (S.py[a] + S.py[b] - 2 * S.py[i]) / (d * d)
    const c2z = (S.pz[a] + S.pz[b] - 2 * S.pz[i]) / (d * d)
    // Split the middle's bend into its part in the upright plane along the road (hills,
    // V) and its sideways part (bends, H = tangent x V), each seen along the road's up.
    const tx = S.tx[i]
    const ty = S.ty[i]
    const tz = S.tz[i]
    let vx = -tx * ty
    let vy = 1 - ty * ty
    let vz = -tz * ty
    const vl = Math.hypot(vx, vy, vz) || 1
    vx /= vl
    vy /= vl
    vz /= vl
    const hill = (c2x * vx + c2y * vy + c2z * vz) * (nx * vx + ny * vy + nz * vz)
    // The part of that hill the bank's pivot made (an open road banks about its low edge,
    // lifting the middle by half the width x sin bank): it is the roll, not the track's
    // design, so it is judged like the lanes swinging, crests and all.
    const pivot = pivotLift ? ((pivotLift[a] + pivotLift[b] - 2 * pivotLift[i]) / (d * d)) * vy * (nx * vx + ny * vy + nz * vz) : 0
    const hx = ty * vz - tz * vy
    const hy = tz * vx - tx * vz
    const hz = tx * vy - ty * vx
    const side = (c2x * hx + c2y * hy + c2z * hz) * (nx * hx + ny * hy + nz * hz)
    const r2 = ((S.rx[a] + S.rx[b] - 2 * S.rx[i]) * nx + (S.ry[a] + S.ry[b] - 2 * S.ry[i]) * ny + (S.rz[a] + S.rz[b] - 2 * S.rz[i]) * nz) / (d * d)
    const c1x = (S.px[b] - S.px[a]) / (2 * d)
    const c1y = (S.py[b] - S.py[a]) / (2 * d)
    const c1z = (S.pz[b] - S.pz[a]) / (2 * d)
    const r1x = (S.rx[b] - S.rx[a]) / (2 * d)
    const r1y = (S.ry[b] - S.ry[a]) / (2 * d)
    const r1z = (S.rz[b] - S.rz[a]) / (2 * d)
    const g = G * ny // gravity's pull toward the road
    if (g <= 0) continue
    const v = Math.min(vTop, t.racingLine.speed[i] * CREST_LINE_MARGIN)
    const lane = S.halfWidth[i] - CREST_LANE_INSET
    for (const l of [-lane, lane]) {
      // The lane's path is C + l R; at speed v it needs v^2 x (its curvature along up) of pull.
      const p2 = (c1x + l * r1x) ** 2 + (c1y + l * r1y) ** 2 + (c1z + l * r1z) ** 2
      // + = curving away from the car (a crest), - = pressing it in.
      const crest = (-l * r2 - side - pivot + Math.min(0, -(hill - pivot))) / p2
      const r = (crest * v * v) / g
      if (r > worst) {
        worst = r
        wi = i
        lateral = l
        kmh = v * 3.6
        need = (crest * v * v) / G
        hold = ny
      }
      flat = Math.max(flat, (crest * vTop * vTop) / g)
    }
  }
  // The roll the worst spot sits in: out to where the bank stops changing (under 0.02 deg/m).
  const still = ((0.02 * Math.PI) / 180) * S.ds
  let i0 = wi
  let i1 = wi
  for (let k = 0; k < n / 2 && Math.abs(S.bank[i0] - S.bank[(i0 - 1 + n) % n]) > still; k++) i0 = (i0 - 1 + n) % n
  for (let k = 0; k < n / 2 && Math.abs(S.bank[(i1 + 1) % n] - S.bank[i1]) > still; k++) i1 = (i1 + 1) % n
  const deg = 180 / Math.PI
  return {
    worst,
    at: wi * S.ds,
    lateral,
    kmh,
    need,
    hold,
    flat,
    roll: { s0: i0 * S.ds, s1: i1 * S.ds, bank0: S.bank[i0] * deg, bank1: S.bank[i1] * deg },
  }
}

/**
 * A road that rides the ground (no `y`, no `lift`) should never throw a car off a crest
 * below this speed. Its points sit on the ground smoothed over about 60 m (averagedHeight,
 * terrain.ts), which keeps every crest on the editor's hilly worlds gentle enough for about
 * 240 km/h and more; sitting on the ground averaged over only 12 m, drawn roads went light
 * over bumps from about 105 km/h.
 */
export const RIDE_KMH = 200

/**
 * The tightest hilltop on road whose height comes from the ground alone: where the four
 * control points the spline uses all have no `y` and no `lift` (a crest made with them is
 * the track's design). Measured on where the road sits unbanked (the bank's pivot lift is
 * taken off), from the change of pitch over 10 m. `radius` is Infinity with no hilltop;
 * `metres` is how much road was judged.
 */
export function groundCrest(t: TrackRuntime): { radius: number; at: number; metres: number } {
  const S = t.samples
  const n = S.count
  const x = trackInternals(t)
  if (!x) return { radius: Infinity, at: 0, metres: 0 }
  const pts = t.file.road.points
  const np = pts.length
  const free = (k: number) => {
    const p = pts[((k % np) + np) % np]
    return typeof p.y !== 'number' && !p.lift
  }
  const judged = new Uint8Array(n)
  let metres = 0
  for (let i = 0; i < n; i++) {
    if (S.surface[i] !== SURFACE_CODE.road) continue
    const k = Math.floor(x.atOfS(i * S.ds))
    if (free(k - 1) && free(k) && free(k + 1) && free(k + 2)) {
      judged[i] = 1
      metres += S.ds
    }
  }
  const h = Math.max(1, Math.round(5 / S.ds))
  const y = (i: number) => S.py[i] - x.pivotLift[i]
  const flat = (a: number, b: number) => Math.hypot(S.px[b] - S.px[a], S.pz[b] - S.pz[a]) || 1e-6
  let worst = 0
  let at = 0
  for (let i = 0; i < n; i++) {
    const a = (i - h + n) % n
    const b = (i + h) % n
    if (!judged[a] || !judged[i] || !judged[b]) continue
    const da = flat(a, i)
    const db = flat(i, b)
    // + = the road tips down more steeply ahead than behind: a hilltop.
    const k = (Math.atan2(y(i) - y(a), da) - Math.atan2(y(b) - y(i), db)) / ((da + db) / 2)
    if (k > worst) {
      worst = k
      at = i * S.ds
    }
  }
  return { radius: worst > 0 ? 1 / worst : Infinity, at, metres }
}

/**
 * Run every non-physics gate on a built track. `t.file` is the resolved track the
 * runtime was built from; tracks with an adjustable bank are rebuilt at the slider's
 * ends (reusing `t`'s ground) so the bank and ground gates hold at every setting.
 */
export function runTrackGates(t: TrackRuntime): TrackGate[] {
  const gates: TrackGate[] = []
  const file = t.file
  const S = t.samples
  const at = (sv: number) => where(t, sv)
  const gate = (name: string, ok: boolean, message: string, fix?: string) => gates.push({ name, ok, level: ok ? 'ok' : 'fail', message, fix: ok ? undefined : fix })
  const warn = (name: string, message: string) => gates.push({ name, ok: true, level: 'warn', message })
  // A track with a bank slider is also checked at other bank angles. Each angle is built
  // once and shared by the gates that need it (t itself already is its own angle).
  const curBank = typeof t.params.bankDeg === 'number' ? t.params.bankDeg : file.road.banking.maxDeg
  const builds = new Map<number, TrackRuntime>()
  const atBank = (b: number | null): TrackRuntime => {
    if (b === null || b === curBank) return t
    let tb = builds.get(b)
    if (!tb) {
      tb = buildTrack(file, { ...t.params, bankDeg: b }, t)
      builds.set(b, tb)
    }
    return tb
  }

  // The racing line must be a real line: not glued to one edge, never closer to an edge
  // than the margin, never planning more sideways grip than the car has, never turning
  // tighter than the least grippy car can steer at that speed, and never braking harder
  // than the brakes can on that bit of hill.
  {
    const margin = file.road.barriers === 'walls' ? 3 : 2.5
    const r = racingLineStats(t)
    const LIM = { clamp: 0.35, run: 150, grip: +(LINE_MAX_LAT_G + 0.05).toFixed(2) }
    const bad: string[] = []
    if (r.clampFrac > LIM.clamp) bad.push(`${(r.clampFrac * 100).toFixed(0)}% at a limit > ${LIM.clamp * 100}%`)
    if (r.longestClampM > LIM.run) bad.push(`longest stretch at a limit ${r.longestClampM.toFixed(0)} m > ${LIM.run} m`)
    if (r.minEdgeGap < margin - 0.05) bad.push(`closest to an edge ${r.minEdgeGap.toFixed(2)} m < ${margin} m`)
    if (r.maxLatG > LIM.grip) bad.push(`planned grip ${r.maxLatG.toFixed(2)} g > limit ${LIM.grip} g`)
    if (r.lockShare > 1) bad.push(`a corner at ${r.lockShareKmh.toFixed(0)} km/h needs ${(r.lockShare * 100).toFixed(0)}% of the least grippy car's full lock`)
    if (r.brakeOverM > 0) bad.push(`${r.brakeOverM.toFixed(0)} m of braking asks ${r.brakeOverBy.toFixed(2)} m/s^2 more than the brakes have on that slope`)
    gate(
      'line',
      bad.length === 0,
      bad.length ? bad.join('; ') : `${(r.clampFrac * 100).toFixed(0)}% of the lap at a limit (longest ${r.longestClampM.toFixed(0)} m), closest ${r.minEdgeGap.toFixed(2)} m to an edge (needs ${margin}), planned grip up to ${r.maxLatG.toFixed(2)} g (limit ${LIM.grip}), at most ${(r.lockShare * 100).toFixed(0)}% of full lock (at ${r.lockShareKmh.toFixed(0)} km/h), braking fits every slope`,
      'the builder plans these itself; a failure means a corner is too tight or too abrupt for it. Ease the corner: spread its points out or add a point so the curve tightens gradually.',
    )
  }
  // Every visible triangle faces outward (agrees with its vertex normals).
  {
    const wind = windingErrors(t)
    const bad = Object.values(wind).reduce((k, w) => k + w.bad, 0)
    gate('winding', bad === 0, `${Object.entries(wind).map(([k, w]) => `${k} ${w.total - w.bad}/${w.total}`).join(', ')} triangles face the way their normals do`, 'this is a builder bug, not your file: report it.')
  }
  // No kinks: a sharp change of direction between neighbouring samples is a bump or a step.
  {
    const sm = ribbonSmoothness(t)
    gate(
      'smooth',
      sm.roadTurn < 4 && sm.upTurn < 4 && sm.loopTurn < 9 && sm.spacingErr < 0.05,
      `sharpest turn ${sm.roadTurn.toFixed(2)} deg/m on the road at ${at(sm.at)} (limit 4), ${sm.loopTurn.toFixed(2)} in loops (limit 9); roll ${sm.upTurn.toFixed(2)} deg/m (limit 4); spacing error ${(sm.spacingErr * 100).toFixed(1)} cm`,
      'a corner tighter than ~15 m radius, or two points almost on top of each other: spread the points near that at.',
    )
  }
  // Banking leans into every corner and rolls gently, including across the start-line seam.
  const adj = file.road.banking.adjustable
  for (const b of adj ? [...new Set([curBank, adj.min, adj.max])] : [null]) {
    const tb = atBank(b)
    const bc = bankCheck(tb)
    const bad: string[] = []
    if (bc.maxRate > 1.5) bad.push(`roll changes ${bc.maxRate.toFixed(2)} deg/m at ${at(bc.rateAt)} > limit 1.5`)
    // Up to 5 m is allowed: rolling smoothly through an S-bend means the lean trails the curve briefly.
    if (bc.wrongSign > 5) bad.push(`${bc.wrongSign} m leaning OUT of a corner (limit 5 m), first at ${at(bc.wrongAt)}`)
    if (bc.leanAhead > LEAN_AHEAD_LIMIT_DEG) bad.push(`the bank leans ${bc.leanAhead.toFixed(0)} deg more than the road's bend wants at ${at(bc.leanAt)} (limit ${LEAN_AHEAD_LIMIT_DEG}): on road that hardly turns it pulls every car down the slope`)
    gate(
      'banking',
      bad.length === 0,
      `${b === null ? '' : `bank ${b} deg: `}${bad.length ? bad.join('; ') : `fastest roll ${bc.maxRate.toFixed(2)} deg/m (limit 1.5), ${bc.wrongSign} m leaning out of a corner (limit 5), leans at most ${bc.leanAhead.toFixed(0)} deg ahead of its bend (limit ${LEAN_AHEAD_LIMIT_DEG})`}${bc.overrideOut ? `; ${bc.overrideOut} m off-camber because of your bank overrides (allowed)` : ''}`,
      bc.leanAhead > LEAN_AHEAD_LIMIT_DEG && bc.maxRate <= 1.5 && bc.wrongSign <= 5
        ? 'this is a builder bug, not your file: report it.'
        : 'the road there changes direction too abruptly for the auto-bank to follow (often a point squeezed between two bends): move the point a little so the bend flows, or set a `bank` override there.',
    )
  }
  // Bank-roll crests: where the road rolls into or out of a bank, no lane curves away
  // from a car faster than gravity can hold it on (at the track's bank and a slider's ends).
  for (const b of adj ? [...new Set([curBank, adj.min, adj.max])] : [null]) {
    const tb = atBank(b)
    const c = bankCrests(tb)
    const bank = b === null ? '' : `bank ${b} deg: `
    const pct = (x: number) => `${Math.max(0, x * 100).toFixed(0)}%`
    const ok = c.worst <= CREST_LIMIT
    const rollLen = tb.wrapS(c.roll.s1 - c.roll.s0)
    const side = c.lateral < 0 ? 'left' : 'right'
    gate(
      'crest',
      ok,
      ok && c.worst < 0.01
        ? `${bank}no bank roll lifts a car on any lane (every lane asks under 1% of gravity's pull)`
        : ok
        ? `${bank}where the bank rolls, every lane keeps the car on the road: the worst asks ${pct(c.worst)} of gravity's pull (limit ${pct(CREST_LIMIT)}) at ${at(c.at)}, ${Math.abs(c.lateral).toFixed(0)} m ${side} of the middle at ${c.kmh.toFixed(0)} km/h, the fastest a car is likely to be there (a car at ${CREST_CHECK_KMH} km/h everywhere would need ${pct(c.flat)})`
        : `${bank}the road rolls from ${Math.abs(c.roll.bank0).toFixed(0)} to ${Math.abs(c.roll.bank1).toFixed(0)} deg of bank${c.roll.bank0 * c.roll.bank1 < 0 ? ' leaning the other way' : ''} in only ${rollLen.toFixed(0)} m (${at(c.roll.s0)} to ${at(c.roll.s1)}), so a car at ${c.kmh.toFixed(0)} km/h ${Math.abs(c.lateral).toFixed(0)} m ${side} of the middle goes light over the top of the roll at ${at(c.at)}: the road falls away from it ${c.need.toFixed(1)} g, and gravity only pulls it down ${c.hold.toFixed(2)} g there (${pct(c.worst)} of it; limit ${pct(CREST_LIMIT)})`,
      'the bank changes too much in too little road. The builder lengthens rolls into the straight beside them by itself, so this one has no room: put more straight road before or after the banked corner (spread its points out), keep the start line and loops further from it, or use less bank there (a smaller `bank` on those points, or a lower banking `maxDeg`).',
    )
  }
  // Bridges: where the road passes over itself, a car must fit underneath.
  const cross = crossingClearance(t)
  const bridgeLow = !!cross && cross.gap < BRIDGE_ROOM
  if (cross) {
    gate(
      'bridges',
      cross.gap >= BRIDGE_ROOM,
      `the road passes over itself with ${cross.gap.toFixed(1)} m between levels at the tightest, over any lane (${at(cross.s1)} over ${at(cross.s2)}; needs ${BRIDGE_ROOM} m: slab plus a car)`,
      'give the upper road more `lift` at the crossing (8 m or more), or make it an underpass: the lower road dips 8 m into the ground there (`lift` -8) and the upper one stays on the ground. A bank on the road underneath lifts its high lane toward the bridge: less bank there helps too.',
    )
  }
  // Loops: room for a car everywhere on and around them, and a clean landing.
  for (const lc of loopClearance(t)) {
    const bad: string[] = []
    if (lc.room < CAR_ROOM) bad.push(`only ${Math.max(0, lc.room).toFixed(1)} m of room at ${at(lc.at)} under the road at ${at(lc.over)} (a car needs ${CAR_ROOM} m)`)
    if (lc.stretch > LOOP_STRETCH_MAX) bad.push(`the loop had to be bent ${lc.stretch.toFixed(1)} m to land on the road (limit ${LOOP_STRETCH_MAX}): it sits on a bend`)
    gate(
      'loops',
      bad.length === 0,
      `loop at ${at(lc.s0)}: ${bad.length ? bad.join('; ') : `room for a car everywhere on and around it (${Number.isFinite(lc.room) ? `least ${lc.room.toFixed(1)} m` : 'nothing overhead'}), lands cleanly (bent ${lc.stretch.toFixed(1)} m)`}`,
      'move the loop onto its own straight: away from where the road crosses itself, with no bend from 80 m before its at to 60 m after.',
    )
  }
  // The road faces the way its frames say: in the middle everywhere, across a loop's
  // lanes, and the physics triangles follow the real road (at every bank a slider allows).
  for (const b of adj ? [...new Set([curBank, adj.max])] : [null]) {
    const tv = atBank(b)
    const f = surfaceFit(tv)
    const bank = b === null ? '' : `bank ${b} deg: `
    const lim = (v: number) => v.toFixed(1)
    const badLoops = f.loops.filter((l) => l.leanDeg > LANE_LEAN_MAX_DEG)
    const bad: string[] = []
    if (f.middleDeg > MIDDLE_TILT_MAX_DEG) bad.push(`the middle of the road faces ${lim(f.middleDeg)} deg away from its frame's up at ${at(f.middleAt)} (limit ${lim(MIDDLE_TILT_MAX_DEG)})`)
    if (f.rightOutDeg > MIDDLE_TILT_MAX_DEG) bad.push(`the frame's right points ${lim(f.rightOutDeg)} deg out of the road surface (limit ${lim(MIDDLE_TILT_MAX_DEG)})`)
    if (f.fitDeg > FIT_MAX_DEG) bad.push(`a physics triangle faces ${lim(f.fitDeg)} deg away from the real road at ${at(f.fitAt)} (limit ${FIT_MAX_DEG})`)
    for (const l of badLoops) {
      bad.push(
        `the loop at ${at(l.s0)} (radius ${l.radius} m) twists too fast: it has to roll ${l.rollDeg.toFixed(0)} deg about its own direction in ${l.length.toFixed(0)} m, so its lanes lean ${lim(l.leanDeg)} deg along the road at ${at(l.leanAt)} (limit ${lim(LANE_LEAN_MAX_DEG)}); a radius of about ${suggestLoopRadius(l.radius, l.leanDeg)} m would fix it`,
      )
    }
    const loopNote = f.loops.length ? `, loop lanes lean at most ${lim(Math.max(...f.loops.map((l) => l.leanDeg)))} deg (limit ${lim(LANE_LEAN_MAX_DEG)})` : ''
    gate(
      'surface',
      bad.length === 0,
      bad.length
        ? bank + bad.join('; ')
        : `${bank}the road faces the way its frames say: the middle within ${lim(f.middleDeg)} deg (limit ${lim(MIDDLE_TILT_MAX_DEG)})${loopNote}, the ${f.triangles} physics triangles within ${lim(f.fitDeg)} deg of the real road (limit ${FIT_MAX_DEG}); lanes on ordinary road lean up to ${lim(f.roadLeanDeg)} deg where the bank rolls in (at ${at(f.roadLeanAt)})`,
      badLoops.length
        ? 'a loop rolls further, over less road, the tighter it is and the wider the road is there. Give the loop a bigger `radius` (the row above says about how big), or make the road narrower at the loop with a `width` on the points either side of it.'
        : 'this is a builder bug, not your file: report it.',
    )
  }
  // Under the road: no physics ground close under the deck at an angle (every bank a slider allows).
  for (const b of adj ? [...new Set([curBank, adj.min, adj.max])] : [null]) {
    const u = underDeck(atBank(b))
    const bank = b === null ? '' : `bank ${b} deg: `
    gate(
      'under',
      u.worstTilt <= UNDER_TILT_DEG,
      u.worstTilt <= UNDER_TILT_DEG
        ? `${bank}no physics ground closer than ${UNDER_GAP} m under the road at an angle (${u.clearPct.toFixed(0)}% of the road has none that close; the rest lies the road's way within ${u.worstTilt.toFixed(0)} deg, limit ${UNDER_TILT_DEG})${u.bandTilt > UNDER_TILT_DEG ? `; in the outer ${EDGE_BAND_JUDGE} m of an open road, where the ground rises to meet the edge on purpose, up to ${u.bandTilt.toFixed(0)} deg (at ${at(u.bandAt)}; not judged)` : ''}`
        : `${bank}physics ground ${u.worstGap.toFixed(2)} m under the road at ${at(u.at)}, lateral ${u.lateral.toFixed(1)}, faces ${u.worstTilt.toFixed(0)} deg away from the road (limit ${UNDER_TILT_DEG} within ${UNDER_GAP} m): a car's body can catch on it through the road`,
      'this is a builder bug, not your file: report it.',
    )
  }
  // Stadium barriers stand up as walls on a bank's low edge, with no ditch behind them.
  if (file.road.barriers === 'walls') {
    for (const b of adj ? [...new Set([curBank, adj.min, adj.max])] : [null]) {
      const st = barrierStance(atBank(b))
      const bank = b === null ? '' : `bank ${b} deg: `
      const bad: string[] = []
      if (st.face < BARRIER_FACE_MIN_DEG) bad.push(`the barrier on the low edge rises only ${st.face.toFixed(0)} deg from flat at ${at(st.faceAt)} (at least ${BARRIER_FACE_MIN_DEG} on banks of ${UPRIGHT_FROM_DEG} deg or more): it's a ramp a car can drive up`)
      if (st.vAngle < BARRIER_V_MIN_DEG) bad.push(`the barrier on the low edge meets the road at only ${st.vAngle.toFixed(0)} deg at ${at(st.vAt)} (at least ${BARRIER_V_MIN_DEG}): it leans over the road's edge and wedges a car parked there`)
      if (st.ditch > DITCH_MAX) bad.push(`the ground behind the low barrier dips ${st.ditch.toFixed(2)} m below the road's edge at ${at(st.ditchAt)} (limit ${DITCH_MAX}): a ditch a car can get stuck in`)
      gate(
        'barriers',
        bad.length === 0,
        bad.length
          ? bank + bad.join('; ')
          : `${bank}the low-edge barriers are walls (faces rise at least ${Math.min(90, st.face).toFixed(0)} deg from flat, limit ${BARRIER_FACE_MIN_DEG}; they meet the road at ${Math.min(180, st.vAngle).toFixed(0)} deg or more, limit ${BARRIER_V_MIN_DEG}) and the ground behind them dips at most ${st.ditch.toFixed(2)} m below the edge (limit ${DITCH_MAX})`,
        'this is a builder bug, not your file: report it.',
      )
    }
  }
  // An open road's bank keeps its low edge on the ground: no ditch beside it.
  if (file.road.barriers !== 'walls') {
    const dd = lowEdgeDitch(t)
    if (dd) {
      const bad: string[] = []
      if (dd.sink > LOW_SINK_MAX) bad.push(`the low edge of the bank at ${at(dd.sinkAt)} (${dd.sinkBankDeg.toFixed(0)} deg) sits ${dd.sink.toFixed(2)} m below where the road would be unbanked (limit ${LOW_SINK_MAX} m): the bank digs the road into the ground`)
      if (dd.depth > LOW_DITCH_MAX) bad.push(`the ground beside the low edge of the bank at ${at(dd.at)} (${dd.bankDeg.toFixed(0)} deg) dips ${dd.depth.toFixed(2)} m below the edge ${dd.out.toFixed(1)} m out and rises again (limit ${LOW_DITCH_MAX} m): a ditch a car on the low lane drops into`)
      gate(
        'lowedge',
        bad.length === 0,
        bad.length
          ? bad.join('; ')
          : `every bank keeps its low edge where the road would sit unbanked (at most ${(dd.sink * 100).toFixed(0)} cm below, limit ${(LOW_SINK_MAX * 100).toFixed(0)}), and beside it (${dd.banked} m of banked road on the ground) the ground stays level with the edge or falls away: no ditch deeper than ${(dd.depth * 100).toFixed(0)} cm (limit ${(LOW_DITCH_MAX * 100).toFixed(0)})${dd.lowBridge ? `; ${dd.lowBridge} m by a bridge too low for a car not judged (the bridges row)` : ''}`,
        'this is a builder bug, not your file: report it.',
      )
    }
  }
  // Road dug into the ground: a cutting's sides are slopes, not cliffs, and a car stays on over the lip of a dip.
  {
    const cs = cuttingSides(t)
    if (cs) {
      const bad: string[] = []
      if (cs.slopeDeg > CUT_SLOPE_MAX_DEG) bad.push(`the side of the cutting at ${at(cs.slopeAt)} is ${cs.slopeDeg.toFixed(0)} deg steep (limit ${CUT_SLOPE_MAX_DEG})`)
      if (cs.step > CUT_STEP_MAX) bad.push(`the side of the cutting at ${at(cs.stepAt)} steps ${cs.step.toFixed(1)} m in one grid cell (limit ${CUT_STEP_MAX} m)`)
      gate(
        'cutting',
        bad.length === 0,
        bad.length
          ? `${bad.join('; ')}: a cliff, not a slope a car can drive down`
          : `beside the ${cs.metres} m of road below the ground, the cutting's sides are slopes: at most ${cs.slopeDeg.toFixed(0)} deg steep (limit ${CUT_SLOPE_MAX_DEG}) and at most ${cs.step.toFixed(1)} m of change per grid cell (limit ${CUT_STEP_MAX})`,
        'this is a builder bug, not your file: report it.',
      )
    }
    const dl = dipLips(t)
    if (dl) {
      const pct = (x: number) => `${Math.max(0, x * 100).toFixed(0)}%`
      gate(
        'dips',
        dl.worst <= CREST_LIMIT,
        dl.worst <= CREST_LIMIT
          ? `${dl.dips} dip${dl.dips === 1 ? '' : 's'} below the ground: over every lip a car stays on (the worst asks ${pct(dl.worst)} of gravity's pull at ${dl.kmh.toFixed(0)} km/h, limit ${pct(CREST_LIMIT)})`
          : `a car at ${dl.kmh.toFixed(0)} km/h takes off over the lip of the dip at ${at(dl.at)}: the road falls away from it there asking ${pct(dl.worst)} of gravity's pull (limit ${pct(CREST_LIMIT)})`,
        'the road tips down into the dip too sharply for the speed cars arrive at. Make the ramp down longer (the dipped stretch longer), or the dip shallower.',
      )
    }
  }
  // Tunnels: room under the ceiling, a solid roof, no ground inside, a road-edge lip round the top.
  for (const tc of tunnelChecks(t)) {
    const name = `tunnel at ${at(tc.s0)}`
    if (tc.problem) {
      gate('tunnel', false, `${name} can't be built: ${tc.problem}`, 'move the tunnel to clear road on the ground (or through a hill), away from loops, ramps, wall rides, the start grid and other road, or make it shorter.')
      continue
    }
    const bad: string[] = []
    if (tc.clearance < TUNNEL_CLEARANCE_MIN) bad.push(`only ${tc.clearance.toFixed(1)} m from the road to the ceiling at ${at(tc.clearanceAt)} (needs ${TUNNEL_CLEARANCE_MIN})`)
    if (tc.roof < TUNNEL_ROOF_CHECK) bad.push(`the roof is only ${tc.roof.toFixed(1)} m thick at ${at(tc.roofAt)} (at least ${TUNNEL_ROOF_CHECK})`)
    if (tc.ground > -TUNNEL_GROUND_BELOW) bad.push(`physics ground ${tc.ground.toFixed(2)} m from the road's edge inside the tunnel at ${at(tc.groundAt)} (it must be a hole or sit ${TUNNEL_GROUND_BELOW} m below)`)
    if (tc.lip > TUNNEL_LIP_MAX || tc.under > 0.02) bad.push(`the top's edge stands ${tc.lip.toFixed(2)} m over the ground beside it at ${at(tc.lipAt)}${tc.under > 0.02 ? ` (and the ground rises ${tc.under.toFixed(2)} m over it somewhere)` : ''} (limit ${TUNNEL_LIP_MAX} m)`)
    if (tc.overRoof < -OVER_ROOF_SLACK) bad.push(`the roof comes up too close under the road over it at ${at(tc.overRoofAt)} (${(-tc.overRoof * 100).toFixed(0)} cm closer than the ground under a road may; limit ${(OVER_ROOF_SLACK * 100).toFixed(0)} cm)`)
    if (tc.overEdge > OVER_EDGE_MAX) bad.push(`beside the road over it the roof is ${(tc.overEdge * 100).toFixed(0)} cm off the road's edge at ${at(tc.overEdgeAt)} (limit ${(OVER_EDGE_MAX * 100).toFixed(0)} cm)`)
    const overWords = tc.overRoads
      ? `; the road over it (${tc.overRoads === 1 ? 'one crossing' : `${tc.overRoads} crossings`}) runs on its roof, which stays under the road like ground (closest ${(-tc.overRoof * 100).toFixed(1)} cm past the allowed clearance, limit ${(OVER_ROOF_SLACK * 100).toFixed(0)}) and meets its edges within ${(tc.overEdge * 100).toFixed(0)} cm (limit ${(OVER_EDGE_MAX * 100).toFixed(0)})`
      : ''
    gate(
      'tunnel',
      bad.length === 0,
      bad.length
        ? `${name}: ${bad.join('; ')}`
        : `${name}, ${tc.length.toFixed(0)} m covered, the road dug ${tc.depth.toFixed(1)} m down on ${(tc.approach / 2).toFixed(0)} m ramps: ${tc.clearance.toFixed(1)} m from the road to the ceiling (at least ${TUNNEL_CLEARANCE_MIN}), a roof ${tc.roof.toFixed(1)} m thick or more, no ground inside (${Number.isFinite(tc.ground) ? `the highest sits ${(-tc.ground * 100).toFixed(0)} cm under the road's edge` : 'it is all left out under the road and the walls'}), the top's edge within ${(tc.lip * 100).toFixed(0)} cm of the ground beside it (limit ${(TUNNEL_LIP_MAX * 100).toFixed(0)})${overWords}`,
      'this is a builder bug, not your file: report it.',
    )
  }
  // Road tracking: nearest() with a hint never jumps to another bit of road by mistake,
  // and a car that dropped off a bridge is found on the road below.
  {
    const r = roadTracking(t)
    gate(
      'tracking',
      r.failures.length === 0,
      r.failures.length
        ? r.failures.slice(0, 3).join('; ')
        : `walked the lap with hints in 3 lanes (biggest step ${r.maxStep.toFixed(1)} m)${r.crossings > r.tooLow ? `; at ${r.crossings - r.tooLow} crossing(s) a car is found on the level it is on, fallen, stale hint or none` : ''}${r.tooLow ? `; ${r.tooLow} crossing(s) too low for a car not tried (the bridges row)` : ''}`,
      'this is a builder bug, not your file: report it.',
    )
  }
  // The ground must stay under the road everywhere (at every bank angle a slider allows).
  const variants = adj ? [adj.min, file.road.banking.maxDeg, adj.max] : [null]
  for (const b of variants) {
    const tv = atBank(b)
    const g = groundClearance(tv)
    // Tolerance 3 cm: right at the lip the rule asks for 3 cm, so this still means "never above the road".
    gate(
      'ground',
      g.worst <= 0.03 && Math.abs(g.edgeStep) <= 0.1,
      `${b === null ? '' : `bank ${b} deg: `}the ground stays under the road everywhere (closest ${(g.worst * 100).toFixed(1)} cm past the allowed clearance at ${at(g.s)}, lateral ${g.lateral.toFixed(1)}; limit 3 cm); just outside the edge it sits ${(g.edgeStep * 100).toFixed(0)} cm below the lip (median, limit 10)`,
      bridgeLow ? 'the bridge above is too low: under a bridge the ground is cut away to make room, which can dig under the road below. Fix the bridges row first.' : 'this is a builder bug, not your file: report it.',
    )
  }
  // A road riding the ground rides its hills, not every bump: no hilltop on it throws a car
  // off below RIDE_KMH. A warning, not a failure: a road drawn over a sharp hill on purpose
  // (a big-air run's kicker) is allowed to jump.
  {
    const r = groundCrest(t)
    const light = Math.sqrt(G * r.radius) * 3.6
    const need = ((RIDE_KMH / 3.6) ** 2 / G).toFixed(0)
    if (r.metres < 1) gates.push({ name: 'ride', ok: true, level: 'ok', message: 'no road rides the ground alone (every stretch has a set height or lift)' })
    else if (light >= RIDE_KMH)
      gates.push({
        name: 'ride',
        ok: true,
        level: 'ok',
        message: `on the ${r.metres.toFixed(0)} m of road that rides the ground, ${Number.isFinite(r.radius) ? `the tightest hilltop (${r.radius.toFixed(0)} m vertical radius, at ${at(r.at)}) keeps a car on the road up to ${light.toFixed(0)} km/h` : 'there is no hilltop at all'} (limit ${RIDE_KMH} km/h: ${need} m)`,
      })
    else
      gates.push({
        name: 'ride',
        ok: true,
        level: 'warn',
        message: `the road rides over a bump in the ground at ${at(r.at)} so sharp (${r.radius.toFixed(0)} m vertical radius) that a car leaves the road above ${light.toFixed(0)} km/h (want ${RIDE_KMH} km/h or more: ${need} m; the road surface is smoothed over ${file.road.surfaceSmoothing} m)`,
        fix: 'smooth the road surface more (a bigger road.surfaceSmoothing: the Road surface slider), route the road round the sharp hill, or give the points there a set `y` (or a `lift`) so the road runs level over it. Jumping it on purpose is fine.',
      })
  }
  // Warnings: it works, but check it.
  {
    // The start grid should sit on straight, level-ish road (12 slots: 47 m behind the line).
    let worstK = 0
    let worstBank = 0
    for (let sv = -50; sv <= 10; sv += 1) {
      const i = Math.round(t.wrapS(sv) / S.ds) % S.count
      worstK = Math.max(worstK, Math.abs(S.curvature[i]))
      worstBank = Math.max(worstBank, Math.abs(S.bank[i]))
    }
    if (!(worstK < 1 / 400 && (worstBank * 180) / Math.PI < 3)) {
      warn('start.at', `the start grid (50 m behind the line to 10 m after it) is on a bend (tightest radius ${(1 / Math.max(worstK, 1e-9)).toFixed(0)} m) or banked (${((worstBank * 180) / Math.PI).toFixed(1)} deg); move start.at onto a straight`)
    }
    const wantBb = file.environment.roadside.billboards
    if (t.roadside.billboards.length < wantBb) {
      warn('environment.roadside.billboards', `asked for ${wantBb}, placed ${t.roadside.billboards.length}: there are only that many clear spots 14-30 m from the road, away from loops, wall rides, ramp and crest landings and big-air runs (fewer is fine; a bigger world or longer road has room for more)`)
    }
  }
  return gates
}
