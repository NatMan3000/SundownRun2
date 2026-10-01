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
//      kind of surface (road, terrain, loop, wall ride, ramp) end up
//      on top of it, never through it.
// ============================================================

import type { Collider, Rapier, RigidBody } from './rapierTypes'
import type { TrackRuntime, NearestHit, TrackFrame } from './types'
import { SURFACE_CODE } from './types'
import { createRoadColliders, createWorldColliders } from './colliders'
import { createTerrainTiles } from './terrainTiles'
import { surfaceOf } from '../core/physics'
import * as THREE from 'three'

/** Half extents of a car-sized test box, metres (a car is about 1.9 x 1.2 x 4.3). */
const CAR = { hx: 0.95, hy: 0.55, hz: 2.15 }

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

  world.free()
  return { ok, lines }
}
