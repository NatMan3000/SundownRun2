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
//   8. Live bank rebuilds (tracks with a bank slider): the physics ground is
//      updated in place the way the game does it, through the slider's
//      ends and back, and must match the rebuilt ground every time.
//   9. Steep banks with barriers: a car box parked by, driven along or thrown
//      at the low barrier stays on the road.
//  10. Barriers are smooth to slide along: a car body pressed into each barrier
//      at 200 and 300 km/h is never pushed back along the road or stopped.
//  11. Tunnels: a car body pressed into each wall (under the roof and along the
//      approaches) at 250 and 300 km/h slides along it, never pushed back or
//      stopped; cars fired at the walls at 60 m/s stay inside; cars dropped on
//      the roof at 40 and 100 m/s stay on top of it (never inside the tunnel);
//      and frictionless boxes slide through every tunnel without hitting a face
//      (the drive-through, 3b). Where a road crosses over a tunnel's roof, cars
//      dropped on it and on the roof beside it stay on top, and boxes slide
//      along it over the roof without hitting a face (3b again).
//
//  The checks that need no physics (line, winding, smooth, banking,
//  bridges, loops, tracking, ground) live in gates.ts, shared with the
//  road editor.
// ============================================================

import type { Collider, Rapier, RigidBody } from './rapierTypes'
import type { TrackRuntime, NearestHit, TrackFrame } from './types'
import { SURFACE_CODE } from './types'
import { BIGAIR_LAYOUT } from './terrain'
import { createRoadColliders, createWorldColliders, isTunnelCollider } from './colliders'
import { createTerrainTiles, groundHoleAt, removeTerrainTiles, updateTerrainTiles } from './terrainTiles'
import { buildTrack, trackInternals } from './build'
import { SIDE_RUN } from './ramps'
import { LOOP_RUN_IN, loopShape } from './road'
import { roadOverTunnels } from './tunnels'
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
    // (The ground tiles only: a tunnel's roof is ground too, but it stands over its own hole.)
    const onlyTerrain = (c: Collider) => surfaceOf(c.handle) === 'terrain' && !isTunnelCollider(c.handle)
    let maxErr = 0
    let n = 0
    let holes = 0
    let wrong = 0
    const { half } = t.terrain
    for (let a = -0.93; a <= 0.93; a += 0.0731) {
      for (let b = -0.93; b <= 0.93; b += 0.0687) {
        const x = a * half
        const z = b * half
        ray.origin = { x, y: t.terrain.maxHeight + 50, z }
        const h = world.castRay(ray, 10000, true, undefined, undefined, undefined, undefined, onlyTerrain)
        // Under the road's slab (and inside barrier boxes) the physics ground is left out
        // on purpose (terrainTiles.ts): a ray there must find nothing, anywhere else the ground.
        if (groundHoleAt(t, x, z)) {
          holes++
          if (h) wrong++
          continue
        }
        if (!h) {
          wrong++
          continue
        }
        const y = t.terrain.maxHeight + 50 - h.timeOfImpact
        maxErr = Math.max(maxErr, Math.abs(y - t.terrainHeight(x, z)))
        n++
      }
    }
    const pass = n > 500 && maxErr < 0.01 && wrong === 0
    if (!pass) ok = false
    lines.push(`${pass ? 'ok  ' : 'FAIL'} ground collider vs terrainHeight(): ${n} raycasts, max difference ${(maxErr * 100).toFixed(2)} cm; ${holes} fell where the ground is left out under the road, ${wrong} found ground where there should be none or none where there should be some`)
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
    type Run = { what: string; s: number; until: number; v: number; lat?: number; headDeg?: number; handsOff?: HandsOff; why?: string; turn?: boolean }
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
    // Right through every tunnel, down one approach and up the other, in the middle and in both
    // outer lanes (a car's width from the walls), in 60 m legs. These boxes turn with the road
    // like a car does: between walls standing right at the road's edges, a box that kept its
    // heading round a bend would swing its corners into them.
    for (const tn of t.tunnels) {
      for (let s = tn.a0 - 20; s < tn.a1 + 20; s += 50) {
        t.frameAt(s, frame)
        for (const lat of [0, -(frame.halfWidth - CAR.hx - 0.6), frame.halfWidth - CAR.hx - 0.6]) runs.push({ what: `through a tunnel (lateral ${lat.toFixed(1)} m)`, s, until: s + 60, v: 45, lat, turn: true })
      }
    }
    // Over every tunnel's roof, on the road crossing it: from 40 m before the tube to 40 m past it.
    const tsIn = trackInternals(t)?.tunnels
    for (const r of tsIn ? roadOverTunnels(t.samples, tsIn) : []) {
      const s0 = r.i0 * t.samples.ds - 40
      const len = ((r.i1 - r.i0 + t.samples.count) % t.samples.count) * t.samples.ds + 80
      t.frameAt(s0, frame)
      // (At 45 m/s, and flat out: a car's soft CCD looks further ahead the faster it goes.)
      for (const v of [45, 70]) for (const lat of [0, -(frame.halfWidth - CAR.hx - 0.6), frame.halfWidth - CAR.hx - 0.6]) runs.push({ what: `over a tunnel's roof at ${v} m/s (lateral ${lat.toFixed(1)} m)`, s: s0, until: s0 + len, v, lat, turn: true })
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
        if (r.turn) {
          negRight.crossVectors(frame.up, frame.tangent).normalize()
          basis.makeBasis(negRight, frame.up, frame.tangent)
          quat.setFromRotationMatrix(basis)
          body.setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w }, true)
        }
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
        // (Inside a covered tunnel, the surface under its ceiling: one dropped on the road at a
        // portal can tumble in under the roof, and the roof over it isn't what it fell through.)
        const fromY = insideTunnelCeiling(t, p.x, p.y, p.z) ?? topY
        ray.origin = { x: p.x, y: fromY, z: p.z }
        const under = world.castRay(ray, fromY - t.world.catchFloorY + 10, true, undefined, undefined, undefined, body)
        const endSurface = under ? fromY - under.timeOfImpact : -Infinity
        if (p.y < endSurface - 0.2) {
          fails++
          if (failed.length < 5) failed.push(`(${x.toFixed(0)}, ${z.toFixed(0)}) surface ${surfaceY.toFixed(1)} -> ended at (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}), under a surface at ${endSurface.toFixed(1)}`)
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

  // ---- 8. live bank rebuilds: the physics ground follows the road every time ----
  const adj = t.file.road.banking.adjustable
  if (adj) {
    const w2 = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
    const tiles = createTerrainTiles(w2, RAPIER, t)
    const seq = [adj.max, adj.min, t.params.bankDeg ?? t.file.road.banking.maxDeg]
    const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 })
    const onlyTerrain = (c: Collider) => surfaceOf(c.handle) === 'terrain'
    let prev = t
    let worst = 0
    let worstAt = ''
    let rebuilt = 0
    for (const b of seq) {
      const tb = buildTrack(t.file, { ...t.params, bankDeg: b }, prev)
      rebuilt += updateTerrainTiles(w2, RAPIER, tiles, tb)
      w2.step()
      const S = tb.samples
      const top = tb.terrain.maxHeight + 50
      for (let i = 0; i < S.count; i += 3) {
        for (let l = -S.halfWidth[i] - 4; l <= S.halfWidth[i] + 4; l += 2) {
          const x = S.px[i] + S.rx[i] * l
          const z = S.pz[i] + S.rz[i] * l
          ray.origin = { x, y: top, z }
          const h = w2.castRay(ray, 10000, true, undefined, undefined, undefined, undefined, onlyTerrain)
          // Ground left out under the rebuilt road must be gone, and nowhere else.
          const hole = groundHoleAt(tb, x, z)
          if (hole || !h) {
            if (hole !== !h && (worst < 1 || !worstAt.includes('hole'))) {
              worst = Math.max(worst, 1)
              worstAt = `bank ${b} deg, ${where(tb, i * S.ds)}, lateral ${l.toFixed(0)} (${hole ? 'ground where the rebuilt road leaves a hole' : 'a hole where the rebuilt road has ground'})`
            }
            continue
          }
          const err = Math.abs(top - h.timeOfImpact - tb.terrainHeight(x, z))
          if (err > worst) {
            worst = err
            worstAt = `bank ${b} deg, ${where(tb, i * S.ds)}`
          }
        }
      }
      prev = tb
    }
    removeTerrainTiles(w2, tiles)
    w2.free()
    const pass = worst < 0.01
    if (!pass) ok = false
    lines.push(
      `${pass ? 'ok  ' : 'FAIL'} live bank rebuilds ${seq.join(' -> ')} deg (${rebuilt} ground tiles rebuilt in place): the physics ground matches the rebuilt ground along the road, worst ${(worst * 100).toFixed(2)} cm${pass ? '' : ` at ${worstAt} (a builder bug, not your file)`}`,
    )
  }


  // ---- 9. steep banks with barriers: the low edge holds a car (hyper-1 D3) ----
  // At every bank the slider allows (and two between), on the steepest bit of each end:
  // a car parked a metre from the LOW edge, one driven along that edge, and one thrown
  // at the low barrier must all stay on the road: never on top of the barrier, never past
  // it, never sunk into it. (Square to a 60 degree bank, the old barrier was a 30 degree
  // ramp: cars drove up it into a ditch behind.)
  if (adj && t.file.road.barriers === 'walls') {
    const banks = [...new Set([adj.min, Math.round((adj.min + adj.max) / 2), t.file.road.banking.maxDeg, Math.round(adj.min + (adj.max - adj.min) * 0.75), adj.max])].sort((a, b) => a - b)
    const results: string[] = []
    let fails = 0
    let runs = 0
    let worstTxt = ''
    for (const b of banks) {
      const tb = buildTrack(t.file, { ...t.params, bankDeg: b }, t)
      const S = tb.samples
      const w3 = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
      createWorldColliders(w3, RAPIER, tb)
      createRoadColliders(w3, RAPIER, tb)
      createTerrainTiles(w3, RAPIER, tb)
      w3.step()
      // The steepest sample of each banked end (two ends, far apart), or two flat spots on a flat road.
      const spots: number[] = []
      for (let k = 0; k < 2; k++) {
        let best = -1
        for (let i = 0; i < S.count; i++) {
          if (S.surface[i] !== SURFACE_CODE.road) continue
          if (spots.some((j) => Math.abs(tb.deltaS(i * S.ds, j * S.ds)) < tb.length / 4)) continue
          if (best < 0 || Math.abs(S.bank[i]) > Math.abs(S.bank[best]) + 1e-4) best = i
        }
        if (best >= 0) spots.push(best)
      }
      const hitB: NearestHit = { s: 0, index: 0, lateral: 0, height: 0, distance: 0, onRoad: false }
      const fr: TrackFrame = { ...frame, position: new THREE.Vector3(), tangent: new THREE.Vector3(), up: new THREE.Vector3(), right: new THREE.Vector3() }
      for (const i of spots) {
        const sAt = i * S.ds
        tb.frameAt(sAt, fr)
        const hw = fr.halfWidth
        // The low edge's side (-1 left, +1 right); either on a flat road.
        const low = S.ry[i] > 0 ? -1 : 1
        negRight.copy(fr.right).negate()
        basis.makeBasis(negRight, fr.up, fr.tangent)
        quat.setFromRotationMatrix(basis)
        const cases: { what: string; lat: number; v: THREE.Vector3; secs: number }[] = [
          { what: 'parked 1 m from the low edge', lat: low * (hw - 1), v: new THREE.Vector3(), secs: 4 },
          { what: 'driven along the low edge at 15 m/s', lat: low * (hw - 1.5), v: fr.tangent.clone().multiplyScalar(15), secs: 3 },
          { what: 'thrown at the low barrier at 25 m/s', lat: low * (hw - 4), v: fr.right.clone().multiplyScalar(low * 25).addScaledVector(fr.tangent, 20), secs: 2 },
        ]
        for (const c of cases) {
          runs++
          const p = fr.position.clone().addScaledVector(fr.right, c.lat).addScaledVector(fr.up, CAR.hy + 0.3)
          const bd = RAPIER.RigidBodyDesc.dynamic().setTranslation(p.x, p.y, p.z).setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w }).setLinvel(c.v.x, c.v.y, c.v.z).setSoftCcdPrediction(SOFT_CCD)
          const body = w3.createRigidBody(bd)
          const cd = RAPIER.ColliderDesc.cuboid(CAR.hx, CAR.hy, CAR.hz).setDensity(1200 / (8 * CAR.hx * CAR.hy * CAR.hz)).setFriction(0.8)
          cd.setCollisionGroups(((1 << 1) << 16) | (1 << 0))
          w3.createCollider(cd, body)
          let bad = ''
          let sh = sAt
          for (let k = 0; k < Math.round(c.secs * 60) && !bad; k++) {
            w3.step()
            const q = body.translation()
            tb.nearest(q.x, q.y, q.z, hitB, sh)
            sh = hitB.s
            const past = Math.abs(hitB.lateral) - tb.samples.halfWidth[hitB.index]
            // Its centre may lean out over the edge a little (a tilted box), never past the barrier's face.
            if (past > 0.6) bad = `went ${past.toFixed(1)} m past the edge`
            else if (hitB.height > 2.4) bad = `climbed ${hitB.height.toFixed(1)} m off the road (onto the barrier)`
            else if (hitB.height < -0.3) bad = `sank ${(-hitB.height).toFixed(1)} m into the road`
          }
          if (bad) {
            fails++
            if (!worstTxt) worstTxt = `bank ${b} deg, ${where(tb, sAt)}: ${c.what} ${bad}`
          }
          w3.removeRigidBody(body)
        }
      }
      results.push(`${b}`)
      w3.free()
    }
    if (fails) ok = false
    lines.push(
      `${fails ? 'FAIL' : 'ok  '} low edge on a steep bank, at bank ${results.join(' / ')} deg: ${runs - fails}/${runs} car boxes parked, driven along or thrown at the low barrier stayed on the road${fails ? ` (first: ${worstTxt}; a builder bug, not your file)` : ''}`,
    )
  }
  // ---- 10. sliding along stadium barriers (hyper-2: the full-throttle line pinned on them) ----
  // A car body, rounded like the real one and with its one-step look-ahead (soft CCD), slides
  // along each barrier pressed into it at half a g, at 200 and 300 km/h, from a start every
  // 130 m round the lap, at the slider's ends and the track's own bank. It is held at ride
  // height and steered round the bend the way its wheels and tyres would. The barrier has to be smooth
  // along its length: no barrier contact may push the car back along the road, and no run may
  // stop. (The old chain of 8 m boxes stopped a car dead at its joints, straights included: the
  // look-ahead met the next box's square end as a wall across the road.)
  if (t.file.road.barriers === 'walls') {
    const banks = adj ? [...new Set([adj.min, t.file.road.banking.maxDeg, adj.max])].sort((a, b) => a - b) : [NaN]
    const PRESS_G = 0.5
    const RIDE = 0.7 // body centre over the road: its underside rides 0.3 m up, as the real car's does
    const ROUND = 0.25
    const fr: TrackFrame = { ...frame, position: new THREE.Vector3(), tangent: new THREE.Vector3(), up: new THREE.Vector3(), right: new THREE.Vector3() }
    const fr2: TrackFrame = { ...frame, position: new THREE.Vector3(), tangent: new THREE.Vector3(), up: new THREE.Vector3(), right: new THREE.Vector3() }
    const hitS: NearestHit = { s: 0, index: 0, lateral: 0, height: 0, distance: 0, onRoad: false }
    const fw = new THREE.Vector3()
    const left = new THREE.Vector3()
    const acc = new THREE.Vector3()
    let runs = 0
    let snagRuns = 0
    let stops = 0
    let worstTxt = ''
    let worstDrop = 0
    const results: string[] = []
    for (const b of banks) {
      const tb = Number.isFinite(b) ? buildTrack(t.file, { ...t.params, bankDeg: b }, t) : t
      const w4 = new RAPIER.World({ x: 0, y: 0, z: 0 })
      createRoadColliders(w4, RAPIER, tb)
      w4.step()
      for (const kmh of [200, 300]) {
        for (const side of [-1, 1] as const) {
          for (let s0 = 0; s0 < tb.length; s0 += 130) {
            tb.frameAt(s0, fr)
            if (fr.surface !== 'road') continue
            runs++
            const p = fr.position.clone().addScaledVector(fr.right, side * (fr.halfWidth - CAR.hx - 0.02)).addScaledVector(fr.up, RIDE)
            const v0 = fr.tangent.clone().multiplyScalar(kmh / 3.6)
            const body = w4.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(p.x, p.y, p.z).setLinvel(v0.x, v0.y, v0.z).setSoftCcdPrediction(SOFT_CCD).setCanSleep(false))
            const cd = RAPIER.ColliderDesc.roundCuboid(CAR.hx - ROUND, CAR.hy - ROUND, CAR.hz - ROUND, ROUND).setMass(1200).setFriction(0.1).setRestitution(0.08)
            cd.setCollisionGroups(((1 << 1) << 16) | (1 << 0))
            const col = w4.createCollider(cd, body)
            let sh = s0
            let snag = ''
            let stopped = false
            for (let k = 0; k < 180 && !snag && !stopped; k++) {
              const q = body.translation()
              tb.nearest(q.x, q.y, q.z, hitS, sh)
              sh = hitS.s
              tb.frameAt(hitS.s, fr)
              tb.frameAt(hitS.s + 1, fr2)
              // Face along the road, square to it (tyres steering it round the bend).
              fw.copy(fr.tangent)
              left.crossVectors(fr.up, fw).normalize()
              basis.makeBasis(left, fr.up, fw)
              quat.setFromRotationMatrix(basis)
              body.setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w }, true)
              body.setAngvel({ x: 0, y: 0, z: 0 }, true)
              // On its wheels: its speed along the road's up is whatever holds the ride height.
              const lv = body.linvel()
              const vu = lv.x * fr.up.x + lv.y * fr.up.y + lv.z * fr.up.z
              const want = Math.max(-30, Math.min(30, 40 * (RIDE - hitS.height)))
              body.setLinvel({ x: lv.x + fr.up.x * (want - vu), y: lv.y + fr.up.y * (want - vu), z: lv.z + fr.up.z * (want - vu) }, true)
              const vt = lv.x * fr.tangent.x + lv.y * fr.tangent.y + lv.z * fr.tangent.z
              // The bend's turn at this speed and the push into the barrier.
              acc.copy(fr2.tangent).sub(fr.tangent).multiplyScalar((vt * vt) / Math.max(1e-6, tb.deltaS(hitS.s, hitS.s + 1)))
              acc.addScaledVector(fr.right, side * PRESS_G * 9.81)
              const m = body.mass() / 60
              body.applyImpulse({ x: acc.x * m, y: acc.y * m, z: acc.z * m }, true)
              const lb = body.linvel()
              const before = Math.hypot(lb.x, lb.y, lb.z)
              w4.step()
              w4.contactPairsWith(col, (o) => {
                if (snag || surfaceOf(o.handle) !== 'barrier') return
                w4.contactPair(col, o, (mm) => {
                  let imp = 0
                  for (let c = 0; c < mm.numContacts(); c++) imp += mm.contactImpulse(c)
                  const n = mm.normal()
                  const along = Math.abs(n.x * fr.tangent.x + n.y * fr.tangent.y + n.z * fr.tangent.z)
                  if (imp > 50 && along > 0.3 && !snag) snag = `pushed back along the road (${Math.round(along * 100)}% of the contact, ${Math.round(imp)} N s) at ${where(tb, hitS.s)}`
                })
              })
              const nv = body.linvel()
              const after = Math.hypot(nv.x, nv.y, nv.z)
              worstDrop = Math.max(worstDrop, (before - after) * 3.6)
              if (after < 5 / 3.6) stopped = true
            }
            if (snag || stopped) {
              if (snag) snagRuns++
              if (stopped) stops++
              if (!worstTxt) worstTxt = `bank ${Number.isFinite(b) ? b : tb.params.bankDeg ?? 0} deg, ${kmh} km/h along the ${side < 0 ? 'left' : 'right'} barrier: ${snag || `stopped at ${where(tb, sh)}`}`
            }
            w4.removeRigidBody(body)
          }
        }
      }
      results.push(Number.isFinite(b) ? `${b}` : 'its own')
      w4.free()
    }
    const bad = snagRuns + stops
    if (bad) ok = false
    lines.push(
      `${bad ? 'FAIL' : 'ok  '} barriers smooth to slide along, at bank ${results.join(' / ')} deg: ${runs} car bodies pressed into a barrier at 200 and 300 km/h, ${snagRuns} pushed back along the road, ${stops} stopped (the most speed any lost in one step: ${worstDrop.toFixed(1)} km/h)${worstTxt ? ` (first: ${worstTxt}; a builder bug, not your file)` : ''}`,
    )
  }
  // ---- 11. tunnels: walls to slide along, a roof to drive on, nothing to fall through ----
  if (t.tunnels.length) {
    const tt = tunnelPhysics(t, RAPIER, world, spawnBox, run, SOFT_CCD)
    if (!tt.ok) ok = false
    lines.push(...tt.lines)
  }
  world.free()
  return { ok, lines }
}

/** If (x, y, z) is inside a covered tunnel (under its ceiling, between its walls), a height just under that ceiling; else null. */
function insideTunnelCeiling(t: TrackRuntime, x: number, y: number, z: number): number | null {
  const ts = trackInternals(t)?.tunnels
  if (!ts || !t.tunnels.length) return null
  const hit: NearestHit = { s: 0, index: 0, lateral: 0, height: 0, distance: 0, onRoad: false }
  t.nearest(x, y, z, hit)
  const i = hit.index
  return ts.covered[i] === 1 && y < ts.ceil[i] && Math.abs(hit.lateral) < t.samples.halfWidth[i] + 0.5 ? ts.ceil[i] - 0.05 : null
}

/**
 * The tunnel cases (11): every built tunnel's walls are smooth to slide along at speed and
 * hold a car fired at them, and its roof holds cars dropped on it. `world` already has the
 * track's colliders; `spawnBox` and `run` are the self-test's own helpers.
 */
function tunnelPhysics(
  t: TrackRuntime,
  RAPIER: Rapier,
  world: InstanceType<Rapier['World']>,
  spawnBox: (x: number, y: number, z: number, q: THREE.Quaternion, vx: number, vy: number, vz: number, sliding?: boolean) => RigidBody,
  run: (seconds: number) => void,
  SOFT_CCD: number,
): { ok: boolean; lines: string[] } {
  const lines: string[] = []
  let ok = true
  const ts = trackInternals(t)?.tunnels
  if (!ts) return { ok, lines }
  const S = t.samples
  const fr: TrackFrame = { s: 0, position: new THREE.Vector3(), tangent: new THREE.Vector3(), up: new THREE.Vector3(), right: new THREE.Vector3(), halfWidth: 0, bank: 0, curvature: 0, surface: 'road' }
  const fr2: TrackFrame = { s: 0, position: new THREE.Vector3(), tangent: new THREE.Vector3(), up: new THREE.Vector3(), right: new THREE.Vector3(), halfWidth: 0, bank: 0, curvature: 0, surface: 'road' }
  const hit: NearestHit = { s: 0, index: 0, lateral: 0, height: 0, distance: 0, onRoad: false }
  const quat = new THREE.Quaternion()
  const basis = new THREE.Matrix4()
  const fw = new THREE.Vector3()
  const left = new THREE.Vector3()
  const acc = new THREE.Vector3()
  // Where along a tunnel a full wall stands on a side (under the roof, or a deep approach).
  const fullWall = (s: number, side: -1 | 1): boolean => {
    const i = ((Math.round(s / S.ds) % S.count) + S.count) % S.count
    return !!ts.slot[i] && (ts.covered[i] === 1 || (side < 0 ? ts.wallL[i] : ts.wallR[i]) > 0.95)
  }

  for (const tn of t.tunnels) {
    const name = `tunnel at ${where(t, tn.s0)}`
    // ---- a car body sliding along each wall, pressed into it at half a g ----
    {
      const PRESS_G = 0.5
      const RIDE = 0.7
      const ROUND = 0.25
      let runs = 0
      let snags = 0
      let stops = 0
      let first = ''
      let worstDrop = 0
      for (const kmh of [250, 300]) {
        for (const side of [-1, 1] as const) {
          for (let s0 = tn.a0 + 10; s0 < tn.a1 - 60; s0 += 35) {
            if (!fullWall(s0, side)) continue
            t.frameAt(s0, fr)
            runs++
            const p = fr.position.clone().addScaledVector(fr.right, side * (fr.halfWidth - CAR.hx - 0.02)).addScaledVector(fr.up, RIDE)
            const v0 = fr.tangent.clone().multiplyScalar(kmh / 3.6)
            const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(p.x, p.y, p.z).setLinvel(v0.x, v0.y, v0.z).setSoftCcdPrediction(SOFT_CCD).setCanSleep(false).setGravityScale(0))
            const cd = RAPIER.ColliderDesc.roundCuboid(CAR.hx - ROUND, CAR.hy - ROUND, CAR.hz - ROUND, ROUND).setMass(1200).setFriction(0.1).setRestitution(0.08)
            cd.setCollisionGroups(((1 << 1) << 16) | (1 << 0))
            const col = world.createCollider(cd, body)
            let sh = s0
            let snag = ''
            let stopped = false
            // Until it runs out of wall (or 2 s).
            for (let k = 0; k < 120 && !snag && !stopped; k++) {
              const q = body.translation()
              t.nearest(q.x, q.y, q.z, hit, sh)
              sh = hit.s
              if (!fullWall(sh + 6, side) || t.deltaS(tn.a1, sh) > -20) break
              t.frameAt(hit.s, fr)
              t.frameAt(hit.s + 1, fr2)
              fw.copy(fr.tangent)
              left.crossVectors(fr.up, fw).normalize()
              basis.makeBasis(left, fr.up, fw)
              quat.setFromRotationMatrix(basis)
              body.setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w }, true)
              body.setAngvel({ x: 0, y: 0, z: 0 }, true)
              const lv = body.linvel()
              const vu = lv.x * fr.up.x + lv.y * fr.up.y + lv.z * fr.up.z
              const want = Math.max(-30, Math.min(30, 40 * (RIDE - hit.height)))
              body.setLinvel({ x: lv.x + fr.up.x * (want - vu), y: lv.y + fr.up.y * (want - vu), z: lv.z + fr.up.z * (want - vu) }, true)
              const vt = lv.x * fr.tangent.x + lv.y * fr.tangent.y + lv.z * fr.tangent.z
              acc.copy(fr2.tangent).sub(fr.tangent).multiplyScalar((vt * vt) / Math.max(1e-6, t.deltaS(hit.s, hit.s + 1)))
              acc.addScaledVector(fr.right, side * PRESS_G * 9.81)
              const m = body.mass() / 60
              body.applyImpulse({ x: acc.x * m, y: acc.y * m, z: acc.z * m }, true)
              const lb = body.linvel()
              const before = Math.hypot(lb.x, lb.y, lb.z)
              world.step()
              world.contactPairsWith(col, (o) => {
                if (snag || !isTunnelCollider(o.handle)) return
                world.contactPair(col, o, (mm) => {
                  let imp = 0
                  for (let c = 0; c < mm.numContacts(); c++) imp += mm.contactImpulse(c)
                  const n = mm.normal()
                  const along = Math.abs(n.x * fr.tangent.x + n.y * fr.tangent.y + n.z * fr.tangent.z)
                  if (imp > 50 && along > 0.3 && !snag) snag = `pushed back along the road (${Math.round(along * 100)}% of the contact, ${Math.round(imp)} N s) at ${where(t, hit.s)}`
                })
              })
              const nv = body.linvel()
              const after = Math.hypot(nv.x, nv.y, nv.z)
              worstDrop = Math.max(worstDrop, (before - after) * 3.6)
              if (after < 5 / 3.6) stopped = true
            }
            if (snag || stopped) {
              if (snag) snags++
              if (stopped) stops++
              if (!first) first = `${kmh} km/h along the ${side < 0 ? 'left' : 'right'} wall from ${where(t, s0)}: ${snag || `stopped at ${where(t, sh)}`}`
            }
            world.removeRigidBody(body)
          }
        }
      }
      const bad = snags + stops
      if (bad || !runs) ok = false
      lines.push(
        `${bad || !runs ? 'FAIL' : 'ok  '} ${name}: walls smooth to slide along: ${runs} car bodies pressed into a wall at 250 and 300 km/h, ${snags} pushed back along the road, ${stops} stopped (the most speed any lost in one step: ${worstDrop.toFixed(1)} km/h)${first ? ` (first: ${first}; a builder bug, not your file)` : ''}`,
      )
    }
    // ---- cars fired at the walls at 60 m/s stay inside ----
    {
      const V = 60
      let shots = 0
      let out = 0
      const failed: string[] = []
      for (let s = tn.a0 + 20; s < tn.a1 - 20; s += 25) {
        for (const side of [-1, 1] as const) {
          if (!fullWall(s, side)) continue
          t.frameAt(s, fr)
          const o = fr.right.clone().multiplyScalar(side)
          const base = fr.position.clone()
          const hw = fr.halfWidth
          const start = base.clone().addScaledVector(o, hw - 3).addScaledVector(fr.up, 1)
          quat.identity()
          const body = spawnBox(start.x, start.y, start.z, quat, o.x * V, o.y * V, o.z * V)
          run(1)
          const p = body.translation()
          shots++
          if ((p.x - base.x) * o.x + (p.z - base.z) * o.z > hw + 0.3) {
            out++
            if (failed.length < 4) failed.push(`went through the ${side < 0 ? 'left' : 'right'} wall at ${where(t, s)}`)
          }
          world.removeRigidBody(body)
        }
      }
      const pass = out === 0 && shots > 0
      if (!pass) ok = false
      lines.push(`${pass ? 'ok  ' : 'FAIL'} ${name}: walls hold: ${shots - out}/${shots} car boxes fired at them at ${V} m/s stayed inside`)
      for (const f of failed) lines.push(`     ${f}`)
    }
    // ---- cars dropped on the roof at 40 and 100 m/s stay on top of it ----
    {
      let drops = 0
      let fell = 0
      const failed: string[] = []
      const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 })
      for (const V of [40, 100]) {
        for (let s = tn.s0 + 8; s < tn.s1 - 4; s += Math.max(12, (tn.s1 - tn.s0) / 6)) {
          t.frameAt(s, fr)
          for (const lat of [0, -(fr.halfWidth + 3), fr.halfWidth + 3, fr.halfWidth * 0.6]) {
            const x = fr.position.x + fr.right.x * lat
            const z = fr.position.z + fr.right.z * lat
            // The roof here: the first thing straight down from high above.
            ray.origin = { x, y: t.terrain.maxHeight + 60, z }
            const h = world.castRay(ray, 1000, true)
            if (!h) continue
            const roofY = t.terrain.maxHeight + 60 - h.timeOfImpact
            quat.identity()
            const body = spawnBox(x, roofY + 4, z, quat, 0, -V, 0)
            run(1.2)
            const p = body.translation()
            drops++
            // It may roll off the roof's edge onto the ground beside it, but never into the
            // tunnel: it ends above the ceiling (or outside the walls).
            t.nearest(p.x, p.y, p.z, hit, s)
            const i = hit.index
            const inside = ts.covered[i] === 1 && Math.abs(hit.lateral) < S.halfWidth[i] + 0.5 && p.y < ts.ceil[i]
            if (inside || p.y < roofY - 2.5) {
              fell++
              if (failed.length < 4) failed.push(`${V} m/s at ${where(t, s)}, ${lat.toFixed(0)} m across: ended at y ${p.y.toFixed(1)} (roof ${roofY.toFixed(1)}, ceiling ${ts.ceil[i].toFixed(1)})`)
            }
            world.removeRigidBody(body)
          }
        }
      }
      const pass = fell === 0 && drops > 0
      if (!pass) ok = false
      lines.push(`${pass ? 'ok  ' : 'FAIL'} ${name}: roof holds: ${drops - fell}/${drops} car boxes dropped on it at 40 and 100 m/s stayed on top`)
      for (const f of failed) lines.push(`     fell in: ${f}`)
    }
    // ---- a road crossing over the roof: cars dropped on it, and on the roof just beside it ----
    const overs = roadOverTunnels(S, ts).filter((r) => r.tunnel === t.tunnels.indexOf(tn))
    if (overs.length) {
      let drops = 0
      let fell = 0
      const failed: string[] = []
      const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 })
      for (const r of overs) {
        const len = ((r.i1 - r.i0 + S.count) % S.count) + 1
        for (const V of [40, 100]) {
          for (const f of [0.15, 0.5, 0.85]) {
            const i = (r.i0 + Math.round(f * (len - 1))) % S.count
            const hw = S.halfWidth[i]
            for (const lat of [0, -(hw - 2), hw - 2, -(hw + 2), hw + 2]) {
              const x = S.px[i] + S.rx[i] * lat
              const z = S.pz[i] + S.rz[i] * lat
              ray.origin = { x, y: t.terrain.maxHeight + 60, z }
              const h = world.castRay(ray, 1000, true)
              if (!h) continue
              const topY = t.terrain.maxHeight + 60 - h.timeOfImpact
              quat.identity()
              const body = spawnBox(x, topY + 4, z, quat, 0, -V, 0)
              run(1.2)
              const p = body.translation()
              drops++
              // Never into the tunnel under it: it ends over the road it was dropped on (or the roof).
              if (p.y < topY - 1.5) {
                fell++
                if (failed.length < 4) failed.push(`${V} m/s on the road over it at ${where(t, i * S.ds)}, ${lat.toFixed(0)} m across: ended at y ${p.y.toFixed(1)} (landed on ${topY.toFixed(1)})`)
              }
              world.removeRigidBody(body)
            }
          }
        }
      }
      const pass = fell === 0 && drops > 0
      if (!pass) ok = false
      lines.push(`${pass ? 'ok  ' : 'FAIL'} ${name}: the road over it holds: ${drops - fell}/${drops} car boxes dropped on it and on the roof beside it at 40 and 100 m/s stayed on top`)
      for (const f of failed) lines.push(`     fell in: ${f}`)
    }
  }
  return { ok, lines }
}

