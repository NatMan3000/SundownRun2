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
//   3b. Drive-through. Frictionless boxes slid along the road into every
//      piece and checkpoint never hit a face; at every loop, boxes driven
//      hands-off down the run-in go into the mouth, and boxes leaving it a
//      little off-line run clear of its legs.
//   4. A drop grid across the whole playable world (12 x 12 points).
//   5. The world edge: boxes fired outward at 90 m/s from 24 bearings
//      stay inside world.playRadius.
//   6. The catch floor catches anything that gets below the ground.
//   7. Every big-air run: at 100 and 150 km/h a car stays planted over the big
//      hill and only flies off the kicker (200 km/h is reported, not judged).
//
//  The checks that need no physics (line, winding, smooth, banking,
//  bridges, loops, tracking, ground) live in gates.ts, shared with the
//  road editor.
// ============================================================

import type { Collider, Rapier, RigidBody } from './rapierTypes'
import type { TrackRuntime, NearestHit, TrackFrame } from './types'
import { SURFACE_CODE } from './types'
import { BIGAIR_LAYOUT } from './terrain'
import { createRoadColliders, createWorldColliders } from './colliders'
import { createTerrainTiles } from './terrainTiles'
import { SIDE_RUN } from './ramps'
import { LOOP_RUN_IN, loopShape } from './road'
import { where } from './gates'
import { surfaceOf } from '../core/physics'
import * as THREE from 'three'

/** Half extents of a car-sized test box, metres (a car is about 1.9 x 1.2 x 4.3). */
const CAR = { hx: 0.95, hy: 0.55, hz: 2.15 }

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

  // Two kinds of anti-tunnelling. Boxes fired AT a surface use rapier's hard CCD (the
  // strictest "never passes through" guarantee). Boxes that SLIDE along a surface use
  // soft CCD instead: rapier 0.19's hard CCD drags a box that slides while touching a
  // triangle mesh to about half its speed (measured: 20 m in 1 s at a reported 40 m/s),
  // which would make sliding tests cover half the ground they claim. Soft CCD slides
  // at full speed and still stops a 150 m/s drop onto the road.
  const SOFT_CCD = 2
  const spawnBox = (x: number, y: number, z: number, q: THREE.Quaternion, vx: number, vy: number, vz: number, sliding = false) => {
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }).setLinvel(vx, vy, vz)
    if (sliding) bodyDesc.setSoftCcdPrediction(SOFT_CCD)
    else bodyDesc.setCcdEnabled(true)
    const body = world.createRigidBody(bodyDesc)
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
        what: `road ${where(t, s)}`,
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
          what: `barrier (${side > 0 ? 'right' : 'left'}) ${where(t, s)}`,
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
  // A frictionless box launched along the road must never hit a face: no step,
  // no end cap, no slab edge across the lane. A hit shows up as a sudden stop
  // (deceleration far beyond what gravity on a slope can do).
  // Most runs steer like a driver. The loop's "hands off" runs don't: a car that
  // aims straight down the run-in, or leaves the loop a little off-line, must go
  // into the mouth or away from the loop, never into its legs.
  {
    // A steered run ends when it reaches `until`. A hands-off run ends after `metres` of
    // travel, or (when `mouthS` is set) as soon as it is riding up the loop past mouthS.
    type HandsOff = { metres: number; mouthS?: number }
    type Run = { what: string; s: number; until: number; v: number; lat?: number; headDeg?: number; handsOff?: HandsOff; why?: string }
    const runs: Run[] = []
    const rampZones: { s0: number; s1: number; off: number; reach: number }[] = []
    const HANDS_OFF = [
      [-2, -3],
      [-2, 3],
      [2, -3],
      [2, 3],
    ] as const
    for (const pc of t.pieces) {
      const span = t.deltaS(pc.s0, pc.s1)
      if (pc.type === 'loop') {
        runs.push({ what: 'loop', s: pc.s0 - 12, until: pc.s0 + 25, v: 30 })
        // Aimed straight down the run-in from its start: it must go up into the mouth, or
        // (if it misses) carry on past where the loop comes down without touching it.
        const landing = loopShape(pc.radius ?? 12).advance
        for (const lat of [-2, 0, 2]) {
          runs.push({
            what: `hands off into a loop (lateral ${lat} m)`,
            s: pc.s0 - LOOP_RUN_IN,
            until: pc.s0,
            v: 40,
            lat,
            handsOff: { metres: LOOP_RUN_IN + landing + 15, mouthS: pc.s0 + 8 },
            why: `a car aiming straight down the run-in must go into the mouth: give the loop a straight ${LOOP_RUN_IN} m run-in before its at`,
          })
        }
        // Leaving it a little off-line: it must run clear of the loop's legs.
        for (const [lat, hd] of HANDS_OFF) {
          runs.push({
            what: `hands off out of a loop (lateral ${lat} m, heading ${hd} deg)`,
            s: pc.s1 - 6,
            until: pc.s1,
            v: 30,
            lat,
            headDeg: hd,
            handsOff: { metres: 66 },
            why: 'a car leaving the loop a little off-line hits something solid: if the loop sits on a bend, give it a straight; on a straight this is a builder bug, not your file',
          })
        }
      } else if (pc.type === 'ramp') {
        // Straight up the ramp, and (for an offset ramp) past it on the centreline, clipping its side slope.
        const src = pc.source as { offset?: number; width?: number; height?: number }
        const off = src.offset ?? 0
        runs.push({ what: 'ramp', s: pc.s0 - 25, until: pc.s1 + 5, v: 30, lat: off })
        // Everything a car box could touch: the ramp, its sloped sides, plus the box's own half width.
        const reach = (src.width ?? 8) / 2 + SIDE_RUN * (src.height ?? 2.4) + CAR.hx + 0.3
        rampZones.push({ s0: pc.s0, s1: pc.s1, off, reach })
        // And past an offset ramp in the clear lane beside it (just outside its sloped side).
        if (Math.abs(off) > 0.5) {
          const lat = off - Math.sign(off) * reach
          t.frameAt(pc.s0, frame)
          if (Math.abs(lat) + CAR.hx < frame.halfWidth) runs.push({ what: 'beside an offset ramp', s: pc.s0 - 25, until: pc.s1 + 5, v: 30, lat })
        }
      }
      else if (pc.type === 'wallride') runs.push({ what: 'wall ride', s: pc.s0 - 20, until: pc.s0 + Math.min(span, 60), v: 30 })
    }
    // Plus a plain run at every checkpoint (straight road joints, bridges, the seam).
    // One that would cross a ramp's footprint runs in the clear lane beside the ramp
    // instead (the ramp's own runs cover the ramp), or is left to them if there is none.
    for (let k = 0; k < t.checkpoints.length; k++) {
      const s0 = t.checkpoints[k] - 10
      const s1 = t.checkpoints[k] + 20
      let lat = 0
      let what = `road at checkpoint ${k}`
      let skip = false
      for (const z of rampZones) {
        const overlaps = t.deltaS(s0, z.s1 + 2) >= 0 && t.deltaS(z.s0 - 2, s1) >= 0
        if (!overlaps || Math.abs(lat - z.off) >= z.reach) continue
        const beside = Math.abs(z.off) > 0.5 ? z.off - Math.sign(z.off) * z.reach : NaN
        t.frameAt(z.s0, frame)
        if (Number.isFinite(beside) && Math.abs(beside) + CAR.hx < frame.halfWidth) {
          lat = beside
          what += ' (beside a ramp)'
        } else skip = true
      }
      if (!skip) runs.push({ what, s: s0, until: s1, v: 45, lat })
    }
    let fails = 0
    const failed: string[] = []
    const hit2: NearestHit = { s: 0, index: 0, lateral: 0, height: 0, distance: 0, onRoad: false }
    const aim = new THREE.Vector3()
    for (const r of runs) {
      t.frameAt(r.s, frame)
      // Heading: along the road, turned headDeg to the right (about the road's up).
      aim.copy(frame.tangent).applyAxisAngle(frame.up, (-(r.headDeg ?? 0) * Math.PI) / 180)
      negRight.crossVectors(frame.up, aim).normalize() // the box's left
      basis.makeBasis(negRight, frame.up, aim)
      quat.setFromRotationMatrix(basis)
      const p0 = frame.position.clone().addScaledVector(frame.right, r.lat ?? 0).addScaledVector(frame.up, CAR.hy + 0.05)
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(p0.x, p0.y, p0.z)
          .setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w })
          .setLinvel(aim.x * r.v, aim.y * r.v, aim.z * r.v)
          .setSoftCcdPrediction(SOFT_CCD),
      )
      const desc = RAPIER.ColliderDesc.cuboid(CAR.hx, CAR.hy, CAR.hz).setDensity(1200 / (8 * CAR.hx * CAR.hy * CAR.hz)).setFriction(0).setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
      desc.setCollisionGroups(((1 << 1) << 16) | (1 << 0))
      world.createCollider(desc, body)
      let prevV = r.v
      let worstDecel = 0
      let sNow = r.s
      let travelled = 0
      const ho = r.handsOff
      const steps = Math.ceil(((ho ? ho.metres : t.deltaS(r.s, r.until) + 5) / r.v) * 60 * 1.6)
      for (let i = 0; i < steps; i++) {
        world.step()
        const lv = body.linvel()
        const v = Math.hypot(lv.x, lv.y, lv.z)
        worstDecel = Math.max(worstDecel, (prevV - v) * 60)
        prevV = v
        const p = body.translation()
        travelled = Math.hypot(p.x - p0.x, p.y - p0.y, p.z - p0.z)
        t.nearest(p.x, p.y, p.z, hit2, sNow)
        sNow = hit2.s
        if (ho) {
          if (travelled >= ho.metres) break
          // Riding up the loop: the whole box on its surface, not just clipping the edge of the mouth.
          const riding =
            t.samples.surface[hit2.index] === SURFACE_CODE.loop && Math.abs(hit2.height) < 1.5 && Math.abs(hit2.lateral) <= t.samples.halfWidth[hit2.index] - CAR.hx
          if (ho.mouthS !== undefined && riding && t.deltaS(ho.mouthS, sNow) >= 0) break
          continue
        }
        if (t.deltaS(r.until, sNow) >= 0) break
        // Steer like a driver: keep the box heading along the road (drop any sideways
        // drift), so it follows bends instead of sliding off the outside of them.
        t.frameAt(sNow, frame)
        const vt = lv.x * frame.tangent.x + lv.y * frame.tangent.y + lv.z * frame.tangent.z
        const vu = lv.x * frame.up.x + lv.y * frame.up.y + lv.z * frame.up.z
        body.setLinvel(
          { x: frame.tangent.x * vt + frame.up.x * vu, y: frame.tangent.y * vt + frame.up.y * vu, z: frame.tangent.z * vt + frame.up.z * vu },
          true,
        )
        const ang = body.angvel()
        if (Math.abs(ang.y) > 0) body.setAngvel({ x: ang.x, y: 0, z: ang.z }, true)
      }
      // Gravity alone on a vertical loop face is ~10 m/s^2; a face across the lane is hundreds.
      if (worstDecel > 40) {
        fails++
        const why = r.why ?? 'Something solid crosses the road there: check for a piece overlapping another, or a loop on a bend or slope'
        if (failed.length < 6) failed.push(`${r.what} (from ${where(t, r.s)} at ${r.v} m/s): ${worstDecel.toFixed(0)} m/s^2 jolt, stopped near ${where(t, sNow)}. ${why}`)
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

  // ---- 7. big-air runs: planted over the big hill, launched by the kicker ----
  for (const f of t.file.environment.terrain.features) {
    if (f.type !== 'bigAir') continue
    const k = f.scale ?? 1
    const hd = (f.headingDeg * Math.PI) / 180
    const ax = Math.sin(hd)
    const az = -Math.cos(hd)
    const crestU = BIGAIR_LAYOUT.kickerCrestU * k
    const results: string[] = []
    let pass = true
    for (const kmh of [100, 150, 200]) {
      const v0 = kmh / 3.6
      const u0 = BIGAIR_LAYOUT.bigHillU * k
      const x0 = f.x + ax * u0
      const z0 = f.z + az * u0
      quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(ax, az))
      const body = spawnBox(x0, t.terrainHeight(x0, z0) + CAR.hy + 0.05, z0, quat, ax * v0, 0, az * v0, true)
      const col = body.collider(0)
      // Low friction so the box keeps its speed like a car under power would.
      col.setFriction(0.02)
      col.setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
      const flights: { from: number; to: number; time: number }[] = []
      let flying = false
      let from = 0
      let tAir = 0
      for (let i = 0; i < 60 * 25; i++) {
        world.step()
        let touching = false
        world.contactPairsWith(col, (other) => {
          world.contactPair(col, other, (m) => {
            if (m.numContacts() > 0) touching = true
          })
        })
        const p = body.translation()
        const u = (p.x - f.x) * ax + (p.z - f.z) * az
        if (!touching && !flying) {
          flying = true
          from = u
          tAir = 0
        } else if (!touching && flying) tAir += 1 / 60
        else if (touching && flying) {
          flying = false
          // A box has no suspension: ignore skips under 0.3 s, count real air.
          if (tAir > 0.3) flights.push({ from, to: u, time: tAir })
          if (from >= crestU - 15 * k) break
        }
        if (u > (BIGAIR_LAYOUT.kickerEndU + 400) * k) break
      }
      world.removeRigidBody(body)
      const early = flights.find((fl) => fl.from < crestU - 15 * k)
      const launch = flights.find((fl) => fl.from >= crestU - 15 * k)
      if (kmh <= 150 && (early || !launch)) pass = false
      const describe = (fl: { from: number; to: number; time: number }) => `${fl.time.toFixed(1)} s from u ${fl.from.toFixed(0)} to ${fl.to.toFixed(0)}`
      results.push(`${kmh} km/h: ${flights.length ? flights.map(describe).join(', ') : 'never left the ground'}`)
    }
    if (!pass) ok = false
    lines.push(`${pass ? 'ok  ' : 'FAIL'} big-air run at (${f.x}, ${f.z}): starting on the big hill's top (u ${(BIGAIR_LAYOUT.bigHillU * k).toFixed(0)}), the kicker crest is at u ${crestU.toFixed(0)}. ${results.join('; ')}`)
  }

  world.free()
  return { ok, lines }
}
