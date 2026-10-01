// ============================================================
//  PHYSICS SELF-TEST - drop things on a track and see if it holds
// ------------------------------------------------------------
//  Run by `bun run tracks:check --physics`. Builds the track's real
//  colliders (colliders.ts, the same code the game uses) in a
//  headless rapier world and checks:
//
//   1. The ground collider matches terrainHeight(). We raycast
//      straight down onto the ground tiles at spots across the world
//      and compare: a wrong vertex order or triangulation would put
//      hills in the wrong place, which this catches.
//   2. Resting. A car-sized box dropped just above the road, at a
//      dozen places round the lap, settles ON the road surface.
//   3. Containment. Car-sized boxes fired down at 60 m/s onto every
//      kind of surface (road, terrain, loop, wall ride, ramp, barrier)
//      end up on top of it, never through it.
//   4. A drop grid across the whole playable world (12 x 12 points).
//   5. The world edge: boxes fired outward at 90 m/s from 24 bearings
//      stay inside world.playRadius.
//   6. The catch floor catches anything that gets below the ground.
// ============================================================

import type { Collider, Rapier, RigidBody } from './rapierTypes'
import type { TrackRuntime, NearestHit, TrackFrame } from './types'
import { SURFACE_CODE } from './types'
import { requiredClearance } from './terrain'
import { createRoadColliders, createWorldColliders } from './colliders'
import { createTerrainTiles } from './terrainTiles'
import { surfaceOf } from '../core/physics'
import * as THREE from 'three'

/** Half extents of a car-sized test box, metres (a car is about 1.9 x 1.2 x 4.3). */
const CAR = { hx: 0.95, hy: 0.55, hz: 2.15 }

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
 * Bank overrides in the file can lean on purpose (off-camber), so those are reported
 * by the caller, not judged here.
 */
export function bankCheck(t: TrackRuntime): { maxRate: number; rateAt: number; wrongSign: number; wrongAt: number } {
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
      wrongSign++
      if (wrongAt < 0) wrongAt = i * S.ds
    }
    sum += S.curvature[(i + W + 1) % n] - S.curvature[(i - W + n) % n]
  }
  return { maxRate, rateAt, wrongSign: Math.round(wrongSign * S.ds), wrongAt }
}

/**
 * Racing line health: how much of the lap sits at the edge limit (and the longest
 * such stretch), the closest it comes to a road edge, and the most sideways grip
 * its target speeds ask for (v^2 x curvature / g, ignoring banking).
 */
export function racingLineStats(t: TrackRuntime): { clampFrac: number; longestClampM: number; minEdgeGap: number; maxLatG: number } {
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
  // Planned sideways acceleration from the line's own curvature.
  let maxLat = 0
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
  }
  return { clampFrac: atLimit / n, longestClampM: Math.min(longest, n) * S.ds, minEdgeGap: minGap, maxLatG: maxLat }
}

/** Timings for the README and the checker: query costs in microseconds. */
export function benchQueries(t: TrackRuntime): { frameAtUs: number; nearestHintUs: number; nearestColdUs: number; terrainUs: number } {
  const frame: TrackFrame = {
    s: 0,
    position: new THREE.Vector3(),
    tangent: new THREE.Vector3(),
    up: new THREE.Vector3(),
    right: new THREE.Vector3(),
    halfWidth: 0,
    bank: 0,
    curvature: 0,
    surface: 'road',
  }
  const hit: NearestHit = { s: 0, index: 0, lateral: 0, height: 0, distance: 0, onRoad: false }
  const N = 20000
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
  // Points near the road (what cars ask about), from frames with a sideways and upward offset.
  const pts = new Float64Array(N * 4)
  for (let i = 0; i < N; i++) {
    const s = (i * 7.31) % t.length
    t.frameAt(s, frame)
    pts[i * 4] = frame.position.x + frame.right.x * ((i % 11) - 5)
    pts[i * 4 + 1] = frame.position.y + 0.8
    pts[i * 4 + 2] = frame.position.z + frame.right.z * ((i % 11) - 5)
    pts[i * 4 + 3] = s
  }
  let sink = 0
  let t0 = now()
  for (let i = 0; i < N; i++) sink += t.frameAt(i * 0.37, frame).halfWidth
  const frameAtUs = ((now() - t0) * 1000) / N
  t0 = now()
  for (let i = 0; i < N; i++) sink += t.nearest(pts[i * 4], pts[i * 4 + 1], pts[i * 4 + 2], hit, pts[i * 4 + 3] + 2).s
  const nearestHintUs = ((now() - t0) * 1000) / N
  t0 = now()
  for (let i = 0; i < N; i++) sink += t.nearest(pts[i * 4], pts[i * 4 + 1], pts[i * 4 + 2], hit).s
  const nearestColdUs = ((now() - t0) * 1000) / N
  t0 = now()
  for (let i = 0; i < N; i++) sink += t.terrainHeight(pts[i * 4], pts[i * 4 + 2])
  const terrainUs = ((now() - t0) * 1000) / N
  if (!Number.isFinite(sink)) throw new Error('bench produced a non-finite value')
  return { frameAtUs, nearestHintUs, nearestColdUs, terrainUs }
}

export interface SelfTestResult {
  ok: boolean
  lines: string[]
}

/**
 * Run the checks. `RAPIER` is the initialised rapier module the game uses
 * (scripts/check-tracks.ts loads react-three-rapier's own copy and passes it in).
 */
export function runPhysicsSelfTest(t: TrackRuntime, RAPIER: Rapier): SelfTestResult {
  const lines: string[] = []
  let ok = true
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
  createWorldColliders(world, RAPIER, t)
  createRoadColliders(world, RAPIER, t)
  createTerrainTiles(world, RAPIER, t)
  world.step() // builds the query structures

  // ---- 1. the ground collider matches terrainHeight() ----
  {
    const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 })
    const onlyTerrain = (c: Collider) => surfaceOf(c.handle) === 'terrain'
    let maxErr = 0
    let n = 0
    const { half } = t.terrain
    for (let a = -0.93; a <= 0.93; a += 0.0731) {
      for (let b = -0.93; b <= 0.93; b += 0.0687) {
        const x = a * half
        const z = b * half
        ray.origin = { x, y: t.terrain.maxHeight + 50, z }
        const h = world.castRay(ray, 10000, true, undefined, undefined, undefined, undefined, onlyTerrain)
        if (!h) continue
        const y = t.terrain.maxHeight + 50 - h.timeOfImpact
        maxErr = Math.max(maxErr, Math.abs(y - t.terrainHeight(x, z)))
        n++
      }
    }
    const pass = n > 500 && maxErr < 0.01
    if (!pass) ok = false
    lines.push(`${pass ? 'ok  ' : 'FAIL'} ground collider vs terrainHeight(): ${n} raycasts, max difference ${(maxErr * 100).toFixed(2)} cm`)
  }

  // ---- helpers ----
  const frame: TrackFrame = {
    s: 0,
    position: new THREE.Vector3(),
    tangent: new THREE.Vector3(),
    up: new THREE.Vector3(),
    right: new THREE.Vector3(),
    halfWidth: 0,
    bank: 0,
    curvature: 0,
    surface: 'road',
  }
  const hit: NearestHit = { s: 0, index: 0, lateral: 0, height: 0, distance: 0, onRoad: false }
  const basis = new THREE.Matrix4()
  const quat = new THREE.Quaternion()
  const negRight = new THREE.Vector3()

  const spawnBox = (x: number, y: number, z: number, q: THREE.Quaternion, vx: number, vy: number, vz: number) => {
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }).setLinvel(vx, vy, vz).setCcdEnabled(true),
    )
    // A car: dense enough for ~1200 kg; member of the CAR group so it collides with the world.
    const desc = RAPIER.ColliderDesc.cuboid(CAR.hx, CAR.hy, CAR.hz).setDensity(1200 / (8 * CAR.hx * CAR.hy * CAR.hz)).setFriction(0.8)
    desc.setCollisionGroups(((1 << 1) << 16) | (1 << 0))
    world.createCollider(desc, body)
    return body
  }
  const run = (seconds: number) => {
    const steps = Math.round(seconds * 60)
    for (let i = 0; i < steps; i++) world.step()
  }

  // ---- 2. resting on the road ----
  {
    const N = 12
    const bodies: { body: RigidBody; s: number }[] = []
    for (let k = 0; k < N; k++) {
      // Skip loops and walls for the resting test (a box can't rest upside down).
      let s = ((k + 0.37) / N) * t.length
      for (let tries = 0; tries < 50; tries++) {
        const i = Math.round(s / t.samples.ds) % t.samples.count
        if (t.samples.surface[i] === SURFACE_CODE.road && t.samples.uy[i] > 0.7) break
        s += 7
      }
      t.frameAt(s, frame)
      negRight.copy(frame.right).negate()
      basis.makeBasis(negRight, frame.up, frame.tangent)
      quat.setFromRotationMatrix(basis)
      const p = frame.position.clone().addScaledVector(frame.up, 2)
      bodies.push({ body: spawnBox(p.x, p.y, p.z, quat, 0, 0, 0), s })
    }
    run(3)
    let worst = 0
    let fails = 0
    for (const b of bodies) {
      const p = b.body.translation()
      t.nearest(p.x, p.y, p.z, hit, b.s)
      // Resting on its belly: centre ~half a box height above the surface.
      const off = hit.height - CAR.hy
      worst = Math.max(worst, Math.abs(off))
      if (Math.abs(off) > 0.25 || Math.abs(hit.lateral) > t.samples.halfWidth[hit.index] + 2) fails++
      world.removeRigidBody(b.body)
    }
    if (fails) ok = false
    lines.push(`${fails ? 'FAIL' : 'ok  '} resting: ${N - fails}/${N} car boxes came to rest on the road (worst ${worst.toFixed(3)} m from the surface)`)
  }

  // ---- 3. containment at 60 m/s ----
  {
    const shots: { what: string; x: number; y: number; z: number; vx: number; vy: number; vz: number; check: (p: { x: number; y: number; z: number }) => boolean }[] = []
    const V = 60
    // Road: straight down onto the road at several places.
    for (let k = 0; k < 6; k++) {
      let s = ((k + 0.71) / 6) * t.length
      for (let tries = 0; tries < 60; tries++) {
        const i = Math.round(s / t.samples.ds) % t.samples.count
        if (t.samples.surface[i] === SURFACE_CODE.road && t.samples.uy[i] > 0.7) break
        s += 9
      }
      t.frameAt(s, frame)
      const sx = frame.position.x
      const sy = frame.position.y
      const sz = frame.position.z
      const ss = s
      shots.push({
        what: `road s=${s.toFixed(0)}`,
        x: sx,
        y: sy + 4,
        z: sz,
        vx: 0,
        vy: -V,
        vz: 0,
        check: (p) => {
          t.nearest(p.x, p.y, p.z, hit, ss)
          return hit.height > -0.2
        },
      })
    }
    // Terrain: off-road spots.
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2 + 0.4
      const x = Math.cos(a) * t.world.half * 0.45
      const z = Math.sin(a) * t.world.half * 0.45
      const y = t.terrainHeight(x, z)
      shots.push({ what: `terrain (${x.toFixed(0)}, ${z.toFixed(0)})`, x, y: y + 4, z, vx: 0, vy: -V, vz: 0, check: (p) => p.y > t.terrainHeight(p.x, p.z) - 0.2 })
    }
    // Barriers: fired sideways at the edge walls, both sides.
    if (t.meshes.barriers) {
      for (let k = 0; k < 4; k++) {
        const s = ((k + 0.23) / 4) * t.length
        t.frameAt(s, frame)
        const side = k % 2 === 0 ? 1 : -1
        const o = frame.right.clone().multiplyScalar(side)
        const base = frame.position.clone()
        const hw = frame.halfWidth
        const start = base.clone().addScaledVector(o, hw - 3).addScaledVector(frame.up, 1)
        shots.push({
          what: `barrier (${side > 0 ? 'right' : 'left'}) s=${s.toFixed(0)}`,
          x: start.x,
          y: start.y,
          z: start.z,
          vx: o.x * V,
          vy: o.y * V,
          vz: o.z * V,
          check: (p) => (p.x - base.x) * o.x + (p.y - base.y) * o.y + (p.z - base.z) * o.z < hw + 0.3,
        })
      }
    }
    // Loops: from the loop's centre, fired at the top of the loop (from inside).
    for (const pc of t.pieces) {
      if (pc.type === 'loop' && pc.loopCenter) {
        const c = pc.loopCenter
        shots.push({
          what: 'loop top (from inside)',
          x: c.x,
          y: c.y,
          z: c.z,
          vx: 0,
          vy: V,
          vz: 0,
          check: (p) => p.y < c.y + (pc.radius ?? 12) + 0.2,
        })
      }
      if (pc.type === 'wallride') {
        const sm = pc.s0 + t.deltaS(pc.s0, pc.s1) / 2
        t.frameAt(sm, frame)
        const side = pc.side === 'left' ? -1 : 1
        const R = pc.height ?? 9
        // Fire sideways into the vertical part of the wall from the road.
        const o = frame.right.clone().multiplyScalar(side)
        const base = frame.position.clone()
        const hw = frame.halfWidth
        const start = base.clone().addScaledVector(o, hw - 1).addScaledVector(frame.up, R)
        shots.push({
          what: `wall ride (${pc.side})`,
          x: start.x,
          y: start.y,
          z: start.z,
          vx: o.x * V,
          vy: o.y * V,
          vz: o.z * V,
          check: (p) => {
            // Still on the road side of the wall (the box's centre short of the wall's face).
            const d = (p.x - base.x) * o.x + (p.y - base.y) * o.y + (p.z - base.z) * o.z
            return d < hw + R - 0.3
          },
        })
      }
      if (pc.type === 'ramp') {
        const c = pc.center
        t.frameAt(pc.s0 + t.deltaS(pc.s0, pc.s1) * 0.85, frame)
        const top = frame.position.clone()
        shots.push({
          what: 'ramp',
          x: c.x,
          y: top.y + 8,
          z: c.z,
          vx: 0,
          vy: -V,
          vz: 0,
          check: (p) => {
            t.nearest(p.x, p.y, p.z, hit, pc.s0)
            return hit.height > -0.2
          },
        })
      }
    }
    let fails = 0
    const failed: string[] = []
    for (const shot of shots) {
      quat.identity()
      const body = spawnBox(shot.x, shot.y, shot.z, quat, shot.vx, shot.vy, shot.vz)
      run(1.5)
      const p = body.translation()
      if (!shot.check(p)) {
        fails++
        failed.push(`${shot.what} -> ended at (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})`)
      }
      world.removeRigidBody(body)
    }
    if (fails) ok = false
    lines.push(`${fails ? 'FAIL' : 'ok  '} containment: ${shots.length - fails}/${shots.length} car boxes fired at ${V} m/s stayed on the surface they hit`)
    for (const f of failed) lines.push(`     fell through: ${f}`)
  }

  // ---- 3b. drive-through: slide a car box along the road into every piece ----
  // A frictionless box launched along the centreline must never hit a face: no step,
  // no end cap, no slab edge across the lane. A hit shows up as a sudden stop
  // (deceleration far beyond what gravity on a slope can do).
  {
    const runs: { what: string; s: number; until: number; v: number; lat?: number }[] = []
    for (const pc of t.pieces) {
      const span = t.deltaS(pc.s0, pc.s1)
      if (pc.type === 'loop') runs.push({ what: 'loop', s: pc.s0 - 12, until: pc.s0 + 25, v: 30 })
      else if (pc.type === 'ramp') {
        // Straight up the ramp, and (for an offset ramp) past it on the centreline, clipping its side slope.
        const off = (pc.source as { offset?: number }).offset ?? 0
        runs.push({ what: 'ramp', s: pc.s0 - 25, until: pc.s1 + 5, v: 30, lat: off })
        if (Math.abs(off) > 0.5) runs.push({ what: 'beside an offset ramp', s: pc.s0 - 25, until: pc.s1 + 5, v: 30, lat: 0 })
      }
      else if (pc.type === 'wallride') runs.push({ what: 'wall ride', s: pc.s0 - 20, until: pc.s0 + Math.min(span, 60), v: 30 })
    }
    // Plus a plain run at every checkpoint (straight road joints, bridges, the seam).
    for (let k = 0; k < t.checkpoints.length; k++) runs.push({ what: `road at checkpoint ${k}`, s: t.checkpoints[k] - 10, until: t.checkpoints[k] + 20, v: 45 })
    let fails = 0
    const failed: string[] = []
    const hit2: NearestHit = { s: 0, index: 0, lateral: 0, height: 0, distance: 0, onRoad: false }
    for (const r of runs) {
      t.frameAt(r.s, frame)
      negRight.copy(frame.right).negate()
      basis.makeBasis(negRight, frame.up, frame.tangent)
      quat.setFromRotationMatrix(basis)
      const p0 = frame.position.clone().addScaledVector(frame.right, r.lat ?? 0).addScaledVector(frame.up, CAR.hy + 0.05)
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(p0.x, p0.y, p0.z)
          .setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w })
          .setLinvel(frame.tangent.x * r.v, frame.tangent.y * r.v, frame.tangent.z * r.v)
          .setCcdEnabled(true),
      )
      const desc = RAPIER.ColliderDesc.cuboid(CAR.hx, CAR.hy, CAR.hz).setDensity(1200 / (8 * CAR.hx * CAR.hy * CAR.hz)).setFriction(0).setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
      desc.setCollisionGroups(((1 << 1) << 16) | (1 << 0))
      world.createCollider(desc, body)
      let prevV = r.v
      let worstDecel = 0
      let sNow = r.s
      const steps = Math.ceil(((t.deltaS(r.s, r.until) + 5) / r.v) * 60 * 1.6)
      for (let i = 0; i < steps; i++) {
        world.step()
        const lv = body.linvel()
        const v = Math.hypot(lv.x, lv.y, lv.z)
        worstDecel = Math.max(worstDecel, (prevV - v) * 60)
        prevV = v
        const p = body.translation()
        t.nearest(p.x, p.y, p.z, hit2, sNow)
        sNow = hit2.s
        if (t.deltaS(r.until, sNow) >= 0) break
      }
      // Gravity alone on a vertical loop face is ~10 m/s^2; a face across the lane is hundreds.
      if (worstDecel > 40) {
        fails++
        if (failed.length < 6) failed.push(`${r.what} (from s=${r.s.toFixed(0)} at ${r.v} m/s): ${worstDecel.toFixed(0)} m/s^2 jolt, stopped near s=${sNow.toFixed(0)}`)
      }
      world.removeRigidBody(body)
    }
    if (fails) ok = false
    lines.push(`${fails ? 'FAIL' : 'ok  '} drive-through: ${runs.length - fails}/${runs.length} frictionless car boxes slid along the road into every piece and joint without hitting a face`)
    for (const f of failed) lines.push(`     hit: ${f}`)
  }

  // ---- 4. everywhere reachable: a drop grid over the whole playable world ----
  {
    const V = 60
    const inner = t.world.edge === 'ridge' ? t.world.half * 0.62 : t.world.playRadius * 0.92
    const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 })
    const topY = t.terrain.maxHeight + 80
    let n = 0
    let fails = 0
    const failed: string[] = []
    for (let a = -1; a <= 1.0001; a += 2 / 11) {
      for (let b = -1; b <= 1.0001; b += 2 / 11) {
        const x = a * inner + 0.7
        const z = b * inner - 0.3
        if (t.world.edge === 'wall' && Math.hypot(x, z) > inner) continue
        // The highest surface here (road, ramp, loop or ground), straight down.
        ray.origin = { x, y: topY, z }
        const first = world.castRay(ray, topY - t.world.catchFloorY + 10, true)
        if (!first) continue
        const surfaceY = topY - first.timeOfImpact
        quat.identity()
        const body = spawnBox(x, surfaceY + 4, z, quat, 0, -V, 0)
        run(1.2)
        const p = body.translation()
        n++
        // It may have slid down a slope or a bank: judge it against the surface where it ended up.
        ray.origin = { x: p.x, y: topY, z: p.z }
        const under = world.castRay(ray, topY - t.world.catchFloorY + 10, true, undefined, undefined, undefined, body)
        const endSurface = under ? topY - under.timeOfImpact : -Infinity
        if (p.y < endSurface - 0.2) {
          fails++
          if (failed.length < 5) failed.push(`(${x.toFixed(0)}, ${z.toFixed(0)}) surface ${surfaceY.toFixed(1)} -> ended at y ${p.y.toFixed(1)}, under a surface at ${endSurface.toFixed(1)}`)
        }
        world.removeRigidBody(body)
      }
    }
    if (fails) ok = false
    lines.push(`${fails ? 'FAIL' : 'ok  '} drop grid: ${n - fails}/${n} car boxes dropped at ${V} m/s across the whole world stayed on top of whatever they hit`)
    for (const f of failed) lines.push(`     fell through: ${f}`)
  }

  // ---- 5. the world edge holds: fire boxes flat out at it from every direction ----
  {
    const V = 90
    const BEARINGS = 24
    const start = t.world.edge === 'ridge' ? t.world.half * 0.55 : t.world.playRadius - 40
    let escaped = 0
    const failed: string[] = []
    let worstR = 0
    // Every 15 degrees, plus extra shots straight into the low sunset notch (ridge tracks).
    const dirs: number[] = []
    for (let k = 0; k < BEARINGS; k++) dirs.push((k / BEARINGS) * Math.PI * 2 + 0.05)
    if (t.world.edge === 'ridge') {
      const sun = t.file.environment.sky.sunAzimuthDeg
      for (const off of [-30, -15, 0, 15, 30]) {
        const b = ((sun + off) * Math.PI) / 180
        dirs.push(Math.atan2(-Math.cos(b), Math.sin(b)))
      }
    }
    for (const th of dirs) {
      const dx = Math.cos(th)
      const dz = Math.sin(th)
      const x = dx * start
      const z = dz * start
      const y = t.terrainHeight(x, z) + 2
      quat.identity()
      const body = spawnBox(x, y, z, quat, dx * V, 8, dz * V)
      run(5)
      const p = body.translation()
      const r = Math.hypot(p.x, p.z)
      worstR = Math.max(worstR, r)
      if (r > t.world.playRadius || p.y < t.world.catchFloorY - 2) {
        escaped++
        if (failed.length < 5) failed.push(`bearing ${((th * 180) / Math.PI).toFixed(0)} deg -> ended at r ${r.toFixed(0)} m, y ${p.y.toFixed(0)}`)
      }
      world.removeRigidBody(body)
    }
    if (escaped) ok = false
    lines.push(
      `${escaped ? 'FAIL' : 'ok  '} world edge (${t.world.edge}): ${dirs.length - escaped}/${dirs.length} car boxes fired outward at ${V} m/s stayed inside (furthest r ${worstR.toFixed(0)} m, play radius ${t.world.playRadius.toFixed(0)} m)`,
    )
    for (const f of failed) lines.push(`     escaped: ${f}`)
  }

  // ---- 6. the catch floor: anything that does get under the ground lands on it ----
  {
    quat.identity()
    const body = spawnBox(13, t.world.resetY - 1, -7, quat, 0, -60, 0)
    run(2)
    const p = body.translation()
    const pass = p.y > t.world.catchFloorY - 0.5 && p.y < t.world.resetY
    if (!pass) ok = false
    lines.push(`${pass ? 'ok  ' : 'FAIL'} catch floor: a box below the reset height landed at y ${p.y.toFixed(1)} (floor top ${t.world.catchFloorY.toFixed(1)}, reset below ${t.world.resetY.toFixed(1)})`)
    world.removeRigidBody(body)
  }

  world.free()
  return { ok, lines }
}
