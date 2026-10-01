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
//    bridges   a car fits under every crossing
//    loops     nothing in a car's way on or around a loop
//    tracking  "where am I on the road?" never jumps by mistake
//    ground    the ground stays under the road
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
import { requiredClearance } from './terrain'
import { buildTrack, trackInternals } from './build'
import { brakeOnSlope, carFullLockG, LINE_MAX_LAT_G } from './derived'

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
  // Edge step: how far the ground sits below the edge just outside it (median over the lap).
  const steps: number[] = []
  for (let i = 0; i < S.count; i += 5) {
    if (S.surface[i] !== SURFACE_CODE.road || S.grounded[i] !== 1) continue
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

/**
 * Where the road passes over itself (a bridge), the smallest height gap between
 * the two levels, measured on the built road. null when the road never overlaps
 * itself. Loops are left out (their lanes pass under their own loop by design).
 */
export function crossingClearance(t: TrackRuntime): { gap: number; s1: number; s2: number } | null {
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
  let best: { gap: number; s1: number; s2: number } | null = null
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
          const gap = Math.abs(S.py[i] - S.py[j])
          if (!best || gap < best.gap) best = { gap, s1: i * S.ds, s2: j * S.ds }
        }
      }
    }
  }
  return best
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
 */
export function roadTracking(t: TrackRuntime): { crossings: number; walks: number; maxStep: number; stepAt: number; failures: string[] } {
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
  for (const { lo, hi } of found) {
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
    for (const side of [-1, 1]) {
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
  return { crossings: found.length, walks, maxStep, stepAt, failures }
}

/**
 * Every triangle must face the way its vertex normals say (three.js culls the back
 * of a triangle, so a wrongly wound road is invisible from above). Returns how many
 * triangles disagree, per mesh.
 */
export function windingErrors(t: TrackRuntime): Record<string, { bad: number; total: number }> {
  const out: Record<string, { bad: number; total: number }> = {}
  const meshes = { road: t.meshes.road, skirt: t.meshes.skirt, barriers: t.meshes.barriers, ramps: t.meshes.ramps }
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
 */
export function bankCheck(t: TrackRuntime): { maxRate: number; rateAt: number; wrongSign: number; wrongAt: number; overrideOut: number } {
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
    sum += S.curvature[(i + W + 1) % n] - S.curvature[(i - W + n) % n]
  }
  return { maxRate, rateAt, wrongSign: Math.round(wrongSign * S.ds), wrongAt, overrideOut: Math.round(overrideOut * S.ds) }
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
    const share = (spd[i] * spd[i] * k) / 9.81 / carFullLockG(spd[i])
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
  for (const b of adj ? [adj.max] : [null]) {
    const tb = b === null ? t : buildTrack(file, { ...t.params, bankDeg: b }, t)
    const bc = bankCheck(tb)
    const bad: string[] = []
    if (bc.maxRate > 1.5) bad.push(`roll changes ${bc.maxRate.toFixed(2)} deg/m at ${at(bc.rateAt)} > limit 1.5`)
    // Up to 5 m is allowed: rolling smoothly through an S-bend means the lean trails the curve briefly.
    if (bc.wrongSign > 5) bad.push(`${bc.wrongSign} m leaning OUT of a corner (limit 5 m), first at ${at(bc.wrongAt)}`)
    gate(
      'banking',
      bad.length === 0,
      `${b === null ? '' : `bank ${b} deg: `}${bad.length ? bad.join('; ') : `fastest roll ${bc.maxRate.toFixed(2)} deg/m (limit 1.5), ${bc.wrongSign} m leaning out of a corner (limit 5)`}${bc.overrideOut ? `; ${bc.overrideOut} m off-camber because of your bank overrides (allowed)` : ''}`,
      'the road there changes direction too abruptly for the auto-bank to follow (often a point squeezed between two bends): move the point a little so the bend flows, or set a `bank` override there.',
    )
  }
  // Bridges: where the road passes over itself, a car must fit underneath.
  const cross = crossingClearance(t)
  const bridgeLow = !!cross && cross.gap < 6.2
  if (cross) {
    gate(
      'bridges',
      cross.gap >= 6.2,
      `the road passes over itself with ${cross.gap.toFixed(1)} m between levels at the tightest (${at(cross.s1)} over ${at(cross.s2)}; needs 6.2 m: slab plus a car)`,
      'give the upper road more `lift` at the crossing (8 m or more).',
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
  // Road tracking: nearest() with a hint never jumps to another bit of road by mistake,
  // and a car that dropped off a bridge is found on the road below.
  {
    const r = roadTracking(t)
    gate(
      'tracking',
      r.failures.length === 0,
      r.failures.length
        ? r.failures.slice(0, 3).join('; ')
        : `walked the lap with hints in 3 lanes (biggest step ${r.maxStep.toFixed(1)} m)${r.crossings ? `; at ${r.crossings} crossing(s) a car is found on the level it is on, fallen, stale hint or none` : ''}`,
      'this is a builder bug, not your file: report it.',
    )
  }
  // The ground must stay under the road everywhere (at every bank angle a slider allows).
  const variants = adj ? [adj.min, file.road.banking.maxDeg, adj.max] : [null]
  for (const b of variants) {
    const tv = b === null ? t : buildTrack(file, { ...t.params, bankDeg: b }, t)
    const g = groundClearance(tv)
    // Tolerance 3 cm: right at the lip the rule asks for 3 cm, so this still means "never above the road".
    gate(
      'ground',
      g.worst <= 0.03 && Math.abs(g.edgeStep) <= 0.1,
      `${b === null ? '' : `bank ${b} deg: `}the ground stays under the road everywhere (closest ${(g.worst * 100).toFixed(1)} cm past the allowed clearance at ${at(g.s)}, lateral ${g.lateral.toFixed(1)}; limit 3 cm); just outside the edge it sits ${(g.edgeStep * 100).toFixed(0)} cm below the lip (median, limit 10)`,
      bridgeLow ? 'the bridge above is too low: under a bridge the ground is cut away to make room, which can dig under the road below. Fix the bridges row first.' : 'this is a builder bug, not your file: report it.',
    )
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
