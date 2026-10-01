// ============================================================
//  TRACK COLLIDERS - the track as rapier physics
// ------------------------------------------------------------
//  Plain functions (no React) so the game and the headless self-test
//  (selftest.ts, run by `bun run tracks:check --physics`) build the
//  exact same colliders.
//
//  Two sets, each on its own fixed rigid body:
//
//   road set (rebuilt in place when a live parameter like the bank
//   angle changes; the car keeps driving):
//     road / loop / wall   the drivable top, one trimesh per surface
//                          kind so a wheel ray knows what it touched
//     skirt                the slab's sides and underside
//     barrier              stadium edge walls (a chain of thick boxes:
//                          a box can't be tunnelled the way a thin
//                          wall of triangles can)
//     ramp                 one convex hull per kicker
//
//   terrain tiles (terrainTiles.ts): the ground as a grid of trimesh
//   tiles. Only tiles whose heights changed are rebuilt on a live
//   parameter change.
//
//   world set (built once per track):
//     floor                a huge slab under everything (the ground is a
//                          paper-thin surface; this catches anything that
//                          slips through, and touching it resets the car)
//     barrier              the world edge: a tall ring on top of the
//                          ridge crest, or the stadium's outer wall
//
//  Every collider is in GROUPS.world and tagged with its SurfaceKind.
// ============================================================

import { GROUPS, tagSurface, untagSurface, type SurfaceKind } from '../core/physics'
import { SURFACE_CODE, type TrackRuntime } from './types'
import { splitBy } from './ribbon'
import { trackInternals } from './build'
import { roundedToEuclid } from './terrain'

import type { ColliderDesc, Rapier, RigidBody, World } from './rapierTypes'

export interface ColliderSet {
  body: RigidBody
  handles: number[]
}

const FRICTION: Record<SurfaceKind, number> = {
  road: 1.0,
  loop: 1.0,
  wall: 1.0,
  ramp: 0.9,
  barrier: 0.25,
  skirt: 0.6,
  terrain: 1.0,
  floor: 1.2,
}

export function add(world: World, R: Rapier, set: ColliderSet, desc: ColliderDesc | null, kind: SurfaceKind): void {
  if (!desc) {
    console.error(`[track] could not build a ${kind} collider (rapier returned null)`)
    return
  }
  desc.setCollisionGroups(GROUPS.world).setSolverGroups(GROUPS.world).setFriction(FRICTION[kind]).setRestitution(kind === 'barrier' ? 0.1 : 0.02)
  if (kind === 'barrier' || kind === 'floor') desc.setFrictionCombineRule(R.CoefficientCombineRule.Min)
  const c = world.createCollider(desc, set.body)
  tagSurface(c.handle, kind)
  set.handles.push(c.handle)
}

/** The road set: drivable surfaces, skirt, barriers and ramps. */
export function createRoadColliders(world: World, R: Rapier, t: TrackRuntime): ColliderSet {
  const set: ColliderSet = { body: world.createRigidBody(R.RigidBodyDesc.fixed()), handles: [] }
  // The drivable top is flat across every sample (a banked plane), so the collider
  // needs only the two edges per sample: 2 triangles a metre instead of the look
  // mesh's 24. Same surface, a tenth of the build time on a live rebuild.
  const S = t.samples
  for (const [kind, code] of [
    ['road', SURFACE_CODE.road],
    ['loop', SURFACE_CODE.loop],
  ] as const) {
    const part = edgeStrip(t, (i) => S.surface[i] === code)
    if (part.indices.length) add(world, R, set, R.ColliderDesc.trimesh(part.vertices, part.indices), kind)
  }
  // Wall-ride walls are curved: use the look mesh's own wall triangles.
  const road = t.meshes.road
  const kindAttr = road.attributes.aKind.array
  const idx = road.indices
  const walls = splitBy(road, (tri) => kindAttr[idx[tri * 3]] === SURFACE_CODE.wall)
  if (walls.indices.length) add(world, R, set, R.ColliderDesc.trimesh(walls.vertices, walls.indices), 'wall')
  const skirt = splitBy(t.meshes.skirt, () => true)
  if (skirt.indices.length) add(world, R, set, R.ColliderDesc.trimesh(skirt.vertices, skirt.indices), 'skirt')

  if (t.meshes.barriers) addBarrierBoxes(world, R, set, t)

  const extras = trackInternals(t)
  for (const hull of extras?.rampHulls ?? []) add(world, R, set, R.ColliderDesc.convexHull(hull), 'ramp')

  return set
}

/** The road top as one strip between its two edges, for samples where `keep(i)` (and the next sample). */
function edgeStrip(t: TrackRuntime, keep: (i: number) => boolean): { vertices: Float32Array; indices: Uint32Array } {
  const S = t.samples
  const n = S.count
  const verts = new Float32Array(n * 6)
  for (let i = 0; i < n; i++) {
    const hw = S.halfWidth[i]
    verts[i * 6] = S.px[i] - S.rx[i] * hw
    verts[i * 6 + 1] = S.py[i] - S.ry[i] * hw
    verts[i * 6 + 2] = S.pz[i] - S.rz[i] * hw
    verts[i * 6 + 3] = S.px[i] + S.rx[i] * hw
    verts[i * 6 + 4] = S.py[i] + S.ry[i] * hw
    verts[i * 6 + 5] = S.pz[i] + S.rz[i] * hw
  }
  const idx: number[] = []
  for (let i = 0; i < n; i++) {
    if (!keep(i)) continue
    const j = (i + 1) % n
    const a = i * 2 //     left, this sample
    const b = i * 2 + 1 // right, this sample
    const c = j * 2 + 1 // right, next sample
    const d = j * 2 //     left, next sample
    // Counter-clockwise seen from above the road, so the face points along its up.
    idx.push(a, b, d, b, c, d)
  }
  return { vertices: verts, indices: Uint32Array.from(idx) }
}

/** Stadium edge barriers as a chain of thick boxes following the road edge. */
function addBarrierBoxes(world: World, R: Rapier, set: ColliderSet, t: TrackRuntime): void {
  const S = t.samples
  const H = t.file.road.barrierHeight
  const thick = trackInternals(t)?.thickness
  const step = Math.max(1, Math.round(8 / S.ds))
  const DEPTH = 3 // metres of box beyond the edge: far thicker than the visible 0.7 m wall
  for (const side of [-1, 1]) {
    for (let i0 = 0; i0 < S.count; i0 += step) {
      const i1 = Math.min(S.count, i0 + step)
      const im = Math.floor((i0 + i1) / 2) % S.count
      if (S.surface[i0 % S.count] !== SURFACE_CODE.road || S.surface[i1 % S.count] !== SURFACE_CODE.road) continue
      const hw = S.halfWidth[im]
      const t0 = thick ? thick[im] : 1.2
      // Basis: x along the road, y up, z outward on this side.
      const tx = S.tx[im]
      const ty = S.ty[im]
      const tz = S.tz[im]
      const ux = S.ux[im]
      const uy = S.uy[im]
      const uz = S.uz[im]
      const ox = S.rx[im] * side
      const oy = S.ry[im] * side
      const oz = S.rz[im] * side
      // Edge point at the segment middle, then the box centre.
      const ex = S.px[im] + ox * hw
      const ey = S.py[im] + oy * hw
      const ez = S.pz[im] + oz * hw
      const hy = (H + t0) / 2
      const cx = ex + ox * (DEPTH / 2) + ux * (hy - t0)
      const cy = ey + oy * (DEPTH / 2) + uy * (hy - t0)
      const cz = ez + oz * (DEPTH / 2) + uz * (hy - t0)
      const halfLen = ((i1 - i0) * S.ds) / 2 + 0.4
      const q = quatFromBasis(tx, ty, tz, ux, uy, uz)
      const desc = R.ColliderDesc.cuboid(halfLen, hy, DEPTH / 2).setTranslation(cx, cy, cz).setRotation(q)
      add(world, R, set, desc, 'barrier')
    }
  }
}

/**
 * Quaternion for the rotation that turns local x into X and local y into Y
 * (local z becomes X x Y, so the frame is always right-handed).
 */
function quatFromBasis(
  m00: number, m10: number, m20: number,
  m01: number, m11: number, m21: number,
): { x: number; y: number; z: number; w: number } {
  const m02 = m10 * m21 - m20 * m11
  const m12 = m20 * m01 - m00 * m21
  const m22 = m00 * m11 - m10 * m01
  const tr = m00 + m11 + m22
  let x: number, y: number, z: number, w: number
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1)
    w = 0.25 / s
    x = (m21 - m12) * s
    y = (m02 - m20) * s
    z = (m10 - m01) * s
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22)
    w = (m21 - m12) / s
    x = 0.25 * s
    y = (m01 + m10) / s
    z = (m02 + m20) / s
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22)
    w = (m02 - m20) / s
    x = (m01 + m10) / s
    y = 0.25 * s
    z = (m12 + m21) / s
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11)
    w = (m10 - m01) / s
    x = (m02 + m20) / s
    y = (m12 + m21) / s
    z = 0.25 * s
  }
  const l = Math.hypot(x, y, z, w) || 1
  return { x: x / l, y: y / l, z: z / l, w: w / l }
}

/** The world set: catch floor plus the world-edge boundary. */
export function createWorldColliders(world: World, R: Rapier, t: TrackRuntime): ColliderSet {
  const set: ColliderSet = { body: world.createRigidBody(R.RigidBodyDesc.fixed()), handles: [] }
  const W = t.world
  const FLOOR_HALF_Y = 50
  add(
    world,
    R,
    set,
    R.ColliderDesc.cuboid(W.size * 1.5, FLOOR_HALF_Y, W.size * 1.5).setTranslation(0, W.catchFloorY - FLOOR_HALF_Y, 0),
    'floor',
  )
  const extras = trackInternals(t)
  const bottom = W.catchFloorY - 20
  if (W.edge === 'ridge' && extras) {
    // A tall ring just inside the crest: you can only touch it standing on top of a mountain.
    const SEG = 160
    const top = t.terrain.maxHeight + 400
    const hy = (top - bottom) / 2
    const HALF_T = 12
    for (let k = 0; k < SEG; k++) {
      const a0 = (k / SEG) * Math.PI * 2
      const a1 = ((k + 1) / SEG) * Math.PI * 2
      const r0 = roundedToEuclid(extras.nat.ridgeCrestAt(a0) - 6, a0)
      const r1 = roundedToEuclid(extras.nat.ridgeCrestAt(a1) - 6, a1)
      const x0 = Math.cos(a0) * r0
      const z0 = Math.sin(a0) * r0
      const x1 = Math.cos(a1) * r1
      const z1 = Math.sin(a1) * r1
      addWallSegment(world, R, set, x0, z0, x1, z1, bottom, hy, HALF_T)
    }
  } else {
    // The stadium's outer wall: a circle at playRadius.
    const SEG = 128
    const r = W.playRadius
    const top = t.terrain.maxHeight + 40
    const hy = (top - bottom) / 2
    for (let k = 0; k < SEG; k++) {
      const a0 = (k / SEG) * Math.PI * 2
      const a1 = ((k + 1) / SEG) * Math.PI * 2
      addWallSegment(world, R, set, Math.cos(a0) * r, Math.sin(a0) * r, Math.cos(a1) * r, Math.sin(a1) * r, bottom, hy, 3)
    }
  }
  return set
}

/** A boundary box whose inner face runs from (x0, z0) to (x1, z1), thickness 2*halfT outward. */
function addWallSegment(world: World, R: Rapier, set: ColliderSet, x0: number, z0: number, x1: number, z1: number, bottom: number, hy: number, halfT: number): void {
  const dx = x1 - x0
  const dz = z1 - z0
  const len = Math.hypot(dx, dz) || 1
  // Outward normal (away from the centre).
  let nx = dz / len
  let nz = -dx / len
  const mx = (x0 + x1) / 2
  const mz = (z0 + z1) / 2
  if (nx * mx + nz * mz < 0) {
    nx = -nx
    nz = -nz
  }
  const yaw = Math.atan2(-dz, dx) // rotate local x onto the segment
  const desc = R.ColliderDesc.cuboid(len / 2 + 1.5, hy, halfT)
    .setTranslation(mx + nx * halfT, bottom + hy, mz + nz * halfT)
    .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) })
  add(world, R, set, desc, 'barrier')
}

/** Remove a set (safe after the physics world itself has been torn down). */
export function removeColliderSet(world: World, set: ColliderSet): void {
  for (const h of set.handles) untagSurface(h)
  set.handles.length = 0
  // react-three-rapier replaces a freed world with a fresh one; only remove from the world that owns it.
  if (world.getRigidBody(set.body.handle) === set.body) world.removeRigidBody(set.body)
}
