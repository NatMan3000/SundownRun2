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
//                          (road and loop from buildDriveSurface: more
//                          triangles across only where the road twists)
//     skirt                the slab's sides and underside
//     barrier              stadium edge walls: one smooth closed solid
//                          per side, so a car slides along them (see
//                          addBarrierSolids)
//     ramp                 one closed triangle mesh per kicker
//     tunnels              per tunnel: its walls and ceiling as one
//                          'barrier' mesh (cars slide along), and the hill
//                          on top as a 'terrain' mesh (tunnelMeshes.ts)
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
//  Triangle meshes are built with FIX_INTERNAL_EDGES: without it a box
//  sliding over the seam between two flat triangles can catch on the
//  shared edge and stop dead (measured: a car box at 30 m/s on a
//  straight road lost 20 m/s in one step).
// ============================================================

import { GROUPS, tagSurface, untagSurface, type SurfaceKind } from '../core/physics'
import { SURFACE_CODE, type TrackRuntime } from './types'
import { BARRIER_BELOW, BARRIER_DEPTH, barrierAxes, buildDriveSurface, driveSurfacePart, splitBy, type BarrierAxes, type DriveSurface } from './ribbon'
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
  liveHandles.add(c.handle)
  set.handles.push(c.handle)
}

/**
 * Every collider handle tagged by add() and not yet forgotten. A handle is only a number, and a
 * new physics world numbers its colliders from the start again, so a tag left behind by a world
 * that was thrown away lands on whatever collider the next world gives that number: the ground
 * read as a tunnel's roof, say. Whoever removes colliders must forget them (removeColliderSet,
 * forgetCollider), and this count says whether everything was.
 */
const liveHandles = new Set<number>()

/** Forget one collider's tags (its surface kind, and whether it is part of a tunnel). Call it when the collider goes. */
export function forgetCollider(handle: number): void {
  untagSurface(handle)
  tunnelHandles.delete(handle)
  liveHandles.delete(handle)
}

/**
 * How many tags are still held: colliders made by add() and not forgotten, plus marks in the tunnel
 * list (the physics self-test checks this ends where it started).
 */
export function liveColliderCount(): number {
  return liveHandles.size + tunnelHandles.size
}

/**
 * The drivable top (road and loops) exactly as the road colliders are built from it.
 * The surface gate (gates.ts) checks this same mesh, so the two can't drift apart.
 */
export function colliderDriveSurface(t: TrackRuntime): DriveSurface {
  return buildDriveSurface(t.samples)
}

/** The road set: drivable surfaces, skirt, barriers and ramps. */
export function createRoadColliders(world: World, R: Rapier, t: TrackRuntime): ColliderSet {
  const set: ColliderSet = { body: world.createRigidBody(R.RigidBodyDesc.fixed()), handles: [] }
  // The drivable top: two triangles a metre where the road is flat across and doesn't
  // twist (most of it), more across where it twists so no triangle faces away from the
  // real road (buildDriveSurface). Far fewer triangles than the look mesh's 24 a metre,
  // so a live rebuild stays quick, but the same shape to within a degree.
  const S = t.samples
  const drive = colliderDriveSurface(t)
  for (const [kind, code] of [
    ['road', SURFACE_CODE.road],
    ['loop', SURFACE_CODE.loop],
  ] as const) {
    const part = driveSurfacePart(drive, (i) => S.surface[i] === code)
    if (part.indices.length) add(world, R, set, R.ColliderDesc.trimesh(part.vertices, part.indices, R.TriMeshFlags.FIX_INTERNAL_EDGES), kind)
  }
  // Wall-ride walls are curved: use the look mesh's own wall triangles.
  const road = t.meshes.road
  const kindAttr = road.attributes.aKind.array
  const idx = road.indices
  const walls = splitBy(road, (tri) => kindAttr[idx[tri * 3]] === SURFACE_CODE.wall)
  if (walls.indices.length) add(world, R, set, R.ColliderDesc.trimesh(walls.vertices, walls.indices, R.TriMeshFlags.FIX_INTERNAL_EDGES), 'wall')
  const skirt = splitBy(t.meshes.skirt, () => true)
  if (skirt.indices.length) add(world, R, set, R.ColliderDesc.trimesh(skirt.vertices, skirt.indices, R.TriMeshFlags.FIX_INTERNAL_EDGES), 'skirt')

  if (t.meshes.barriers) addBarrierSolids(world, R, set, t)

  const extras = trackInternals(t)
  for (const r of extras?.rampSolids ?? []) add(world, R, set, R.ColliderDesc.trimesh(r.vertices, r.indices, R.TriMeshFlags.FIX_INTERNAL_EDGES), 'ramp')

  // Tunnels: the walls and ceiling cars slide along, and the hill over them. Both are kept in
  // tunnelHandles so the camera can treat them as solid (it never sits inside the hill).
  for (const tn of extras?.tunnelSolids ?? []) {
    for (const [m, kind] of [
      [tn.walls, 'barrier'],
      [tn.top, 'terrain'],
    ] as const) {
      if (!m.indices.length) continue
      const before = set.handles.length
      add(world, R, set, R.ColliderDesc.trimesh(m.vertices, m.indices, R.TriMeshFlags.FIX_INTERNAL_EDGES), kind)
      for (let k = before; k < set.handles.length; k++) tunnelHandles.add(set.handles[k])
    }
  }

  return set
}

/** Collider handles of every tunnel's walls, ceiling and hill (see isTunnelCollider). */
const tunnelHandles = new Set<number>()

/** True for a tunnel's walls, ceiling or the hill over it: solid ground the camera keeps out of. */
export function isTunnelCollider(handle: number): boolean {
  return tunnelHandles.has(handle)
}

/**
 * How far (metres) the physics barrier's face may stray from the visible barrier between two
 * of its rows. Rows are dropped where the barrier runs straight (the straights: one row every
 * BARRIER_ROW_MAX metres), kept about every 5 m round a bend and every metre or two where it
 * rolls with the bank. Far under anything a car feels or an eye sees.
 */
const BARRIER_ROW_TOL = 0.02
/** The longest stretch (metres) one row of the physics barrier spans. */
const BARRIER_ROW_MAX = 24

/**
 * Stadium edge barriers: on each side one closed solid that follows the road edge, built as a
 * tube of triangles (inner face, top, back, bottom) with the cross-section barrierAxes gives:
 * the face from BARRIER_BELOW under the slab's bottom up to the barrier's top, BARRIER_DEPTH
 * deep, the same block the barrier always was.
 *
 * It used to be a chain of 8 m boxes. But a car looks a whole physics step ahead (its soft
 * CCD: 1.4 m at 300 km/h), and sliding along a wall that look-ahead met the next box's
 * square end as a wall across the road, so the car stopped dead at a joint, on a straight as
 * much as on a bend (hyper-2: the full-throttle line pinned in 5 of 6 runs). One continuous
 * mesh has no ends to meet. It still holds a car driven straight at it at 320 km/h: the same
 * look-ahead stops the car at the face before it can pass through.
 */
function addBarrierSolids(world: World, R: Rapier, set: ColliderSet, t: TrackRuntime): void {
  const m = barrierSolidMesh(t)
  if (m.indices.length) add(world, R, set, R.ColliderDesc.trimesh(m.vertices, m.indices, R.TriMeshFlags.FIX_INTERNAL_EDGES), 'barrier')
}

/**
 * The barrier's cross-section, going round it: where each corner sits up the barrier's face
 * (metres above the road edge, BOTTOM = from under the slab) and out from the road (metres).
 * The inner face, the one cars touch, is cut into strips at the road's edge and half way up,
 * so its triangles are about car-sized: a full-height sliver 7 m tall caught a car sliding
 * past at 300 km/h in a bank roll-in (its look-ahead met the sliver's tip as a wall across
 * the road), where strips don't.
 */
const BOTTOM = -1
function profileCorners(H: number): { up: number; out: number }[] {
  return [
    { up: BOTTOM, out: 0 },
    { up: 0, out: 0 },
    { up: H / 2, out: 0 },
    { up: H, out: 0 },
    { up: H, out: BARRIER_DEPTH },
    { up: BOTTOM, out: BARRIER_DEPTH },
  ]
}

/**
 * How far (metres) the inner face of the barrier (its first `strips` faces round the
 * cross-section) is from flat between profiles a and b: the largest distance of one corner of
 * a strip from the plane of its other three. Only the face cars touch has to be this true; the
 * top, back and bottom only have to be there.
 */
function twist(prof: Float64Array, K: number, strips: number, a: number, b: number): number {
  let worst = 0
  for (let k = 0; k < strips; k++) {
    const k2 = (k + 1) % K
    const A0 = (a * K + k) * 3
    const A1 = (a * K + k2) * 3
    const B0 = (b * K + k) * 3
    const B1 = (b * K + k2) * 3
    const ux = prof[A1] - prof[A0]
    const uy = prof[A1 + 1] - prof[A0 + 1]
    const uz = prof[A1 + 2] - prof[A0 + 2]
    const vx = prof[B0] - prof[A0]
    const vy = prof[B0 + 1] - prof[A0 + 1]
    const vz = prof[B0 + 2] - prof[A0 + 2]
    const nx = uy * vz - uz * vy
    const ny = uz * vx - ux * vz
    const nz = ux * vy - uy * vx
    const nl = Math.hypot(nx, ny, nz) || 1
    const d = ((prof[B1] - prof[A0]) * nx + (prof[B1 + 1] - prof[A0 + 1]) * ny + (prof[B1 + 2] - prof[A0 + 2]) * nz) / nl
    worst = Math.max(worst, Math.abs(d))
  }
  return worst
}

/** The barrier solids as one triangle mesh (both sides), every face facing out of the solid. */
export function barrierSolidMesh(t: TrackRuntime): { vertices: Float32Array; indices: Uint32Array } {
  const S = t.samples
  const n = S.count
  const H = t.file.road.barrierHeight
  const thick = trackInternals(t)?.thickness
  const ax: BarrierAxes = { dx: 0, dy: 0, dz: 0, ox: 0, oy: 0, oz: 0 }
  // The barrier runs from sample i to i + 1 where the road is plain road at both.
  const runsFrom = (i: number) => S.surface[i % n] === SURFACE_CODE.road && S.surface[(i + 1) % n] === SURFACE_CODE.road
  // Profile of sample i on one side: K corners round the cross-section (profileCorners), xyz
  // each; then how sharply it bends there (the largest second difference of its corners along
  // the road, metres per sample squared).
  const corners = profileCorners(H)
  const K = corners.length
  // The inner face's strips: the faces between its corners (the ones standing at out = 0).
  const strips = corners.filter((c) => c.out === 0).length - 1
  const prof = new Float64Array(n * K * 3)
  const bend = new Float64Array(n)
  const sides: { rows: number[]; closed: boolean[]; runs: [number, number][]; prof: Float64Array }[] = []
  let vCount = 0
  let tCount = 0
  const maxSpan = Math.max(1, Math.round(BARRIER_ROW_MAX / S.ds))
  for (const side of [-1, 1] as const) {
    for (let i = 0; i < n; i++) {
      barrierAxes(S, i, side, ax)
      const hw = S.halfWidth[i]
      const ex = S.px[i] + S.rx[i] * side * hw
      const ey = S.py[i] + S.ry[i] * side * hw
      const ez = S.pz[i] + S.rz[i] * side * hw
      const below = (thick ? thick[i] : 1.2) + BARRIER_BELOW
      const o = i * K * 3
      for (let k = 0; k < K; k++) {
        const up = corners[k].up === BOTTOM ? -below : corners[k].up
        const out = corners[k].out
        prof[o + k * 3] = ex + ax.dx * up + ax.ox * out
        prof[o + k * 3 + 1] = ey + ax.dy * up + ax.oy * out
        prof[o + k * 3 + 2] = ez + ax.dz * up + ax.oz * out
      }
    }
    for (let i = 0; i < n; i++) {
      const a = ((i + n - 1) % n) * K * 3
      const b = i * K * 3
      const c = ((i + 1) % n) * K * 3
      let m = 0
      for (let k = 0; k < K * 3; k += 3) {
        const x = prof[a + k] - 2 * prof[b + k] + prof[c + k]
        const y = prof[a + k + 1] - 2 * prof[b + k + 1] + prof[c + k + 1]
        const z = prof[a + k + 2] - 2 * prof[b + k + 2] + prof[c + k + 2]
        m = Math.max(m, x * x + y * y + z * z)
      }
      bend[i] = Math.sqrt(m)
    }
    // Contiguous runs of barrier, as [first sample, last sample] (the last may pass n: it wraps).
    const runs: [number, number][] = []
    let z = 0
    while (z < n && runsFrom(z)) z++
    if (z >= n) runs.push([0, n])
    else {
      for (let k = 1; k <= n; k++) {
        if (!runsFrom((z + k) % n)) continue
        const a = z + k
        let b = a
        while (b - a < n && runsFrom(b % n)) b++
        runs.push([a, b])
        k += b - a
      }
    }
    // Rows: from each kept row reach on while a straight line between the two rows stays within
    // BARRIER_ROW_TOL of the barrier in between (a chord's sag is span^2 / 8 x the bend).
    const rows: number[] = []
    const closed: boolean[] = []
    for (const [a, b] of runs) {
      rows.push(a)
      let r0 = a
      while (r0 < b) {
        let r1 = r0 + 1
        let worst = 0
        while (r1 < b && r1 - r0 < maxSpan) {
          const w = Math.max(worst, bend[r1 % n])
          const span = r1 + 1 - r0
          if ((span * span * w) / 8 > BARRIER_ROW_TOL) break
          // ...and while each face between the two rows stays flat enough for two triangles:
          // where the barrier rolls with the bank its face twists along the road.
          if (twist(prof, K, strips, r0 % n, (r1 + 1) % n) > 4 * BARRIER_ROW_TOL) break
          worst = w
          r1++
        }
        rows.push(r1)
        r0 = r1
      }
      rows.push(-1) // end of this run
      const isClosed = b - a >= n
      closed.push(isClosed)
      const nRows = rows.length - 1 - rows.lastIndexOf(-1, rows.length - 2) - 1
      vCount += (isClosed ? nRows - 1 : nRows) * K
      tCount += (nRows - 1) * K * 2 + (isClosed ? 0 : 2 * (K - 2))
    }
    sides.push({ rows, closed, runs, prof: prof.slice() })
  }
  const vertices = new Float32Array(vCount * 3)
  const indices = new Uint32Array(tCount * 3)
  let vp = 0
  let ip = 0
  for (const sd of sides) {
    const P = sd.prof
    let start = 0
    for (let run = 0; run < sd.runs.length; run++) {
      const end = sd.rows.indexOf(-1, start)
      const rows = sd.rows.slice(start, end)
      start = end + 1
      const isClosed = sd.closed[run]
      const nv = isClosed ? rows.length - 1 : rows.length // a closed ring's last row is its first
      const base = vp / 3
      for (let q = 0; q < nv; q++) {
        const o = (rows[q] % n) * K * 3
        for (let c = 0; c < K * 3; c++) vertices[vp++] = P[o + c]
      }
      const vi = (q: number, k: number) => base + (q % nv) * K + k
      // Each face wound to face out of the solid: checked against the solid's middle there.
      const quad = (A: number, B: number, C: number, D: number, cx: number, cy: number, cz: number) => {
        const ux = vertices[B * 3] - vertices[A * 3]
        const uy = vertices[B * 3 + 1] - vertices[A * 3 + 1]
        const uz = vertices[B * 3 + 2] - vertices[A * 3 + 2]
        const wx = vertices[C * 3] - vertices[A * 3]
        const wy = vertices[C * 3 + 1] - vertices[A * 3 + 1]
        const wz = vertices[C * 3 + 2] - vertices[A * 3 + 2]
        const mx = (vertices[A * 3] + vertices[C * 3]) / 2 - cx
        const my = (vertices[A * 3 + 1] + vertices[C * 3 + 1]) / 2 - cy
        const mz = (vertices[A * 3 + 2] + vertices[C * 3 + 2]) / 2 - cz
        const out = (uy * wz - uz * wy) * mx + (uz * wx - ux * wz) * my + (ux * wy - uy * wx) * mz
        if (out >= 0) {
          indices[ip++] = A; indices[ip++] = B; indices[ip++] = C
          indices[ip++] = A; indices[ip++] = C; indices[ip++] = D
        } else {
          indices[ip++] = A; indices[ip++] = C; indices[ip++] = B
          indices[ip++] = A; indices[ip++] = D; indices[ip++] = C
        }
      }
      const tri = (A: number, B: number, C: number, cx: number, cy: number, cz: number) => {
        const ux = vertices[B * 3] - vertices[A * 3]
        const uy = vertices[B * 3 + 1] - vertices[A * 3 + 1]
        const uz = vertices[B * 3 + 2] - vertices[A * 3 + 2]
        const wx = vertices[C * 3] - vertices[A * 3]
        const wy = vertices[C * 3 + 1] - vertices[A * 3 + 1]
        const wz = vertices[C * 3 + 2] - vertices[A * 3 + 2]
        const mx = (vertices[A * 3] + vertices[B * 3] + vertices[C * 3]) / 3 - cx
        const my = (vertices[A * 3 + 1] + vertices[B * 3 + 1] + vertices[C * 3 + 1]) / 3 - cy
        const mz = (vertices[A * 3 + 2] + vertices[B * 3 + 2] + vertices[C * 3 + 2]) / 3 - cz
        const out = (uy * wz - uz * wy) * mx + (uz * wx - ux * wz) * my + (ux * wy - uy * wx) * mz
        indices[ip++] = A
        indices[ip++] = out >= 0 ? B : C
        indices[ip++] = out >= 0 ? C : B
      }
      // The middle of a profile: halfway between its inner face's foot and its outer top corner
      // (inside the solid, as the cross-section is convex).
      const mid = (q: number, c: number) => (vertices[vi(q, 0) * 3 + c] + vertices[vi(q, K - 2) * 3 + c]) / 2
      for (let q = 0; q < rows.length - 1; q++) {
        const cx = (mid(q, 0) + mid(q + 1, 0)) / 2
        const cy = (mid(q, 1) + mid(q + 1, 1)) / 2
        const cz = (mid(q, 2) + mid(q + 1, 2)) / 2
        for (let k = 0; k < K; k++) quad(vi(q, k), vi(q, (k + 1) % K), vi(q + 1, (k + 1) % K), vi(q + 1, k), cx, cy, cz)
      }
      if (!isClosed) {
        // End caps (a fan over the cross-section), facing away from the run.
        const last = rows.length - 1
        for (const [q, nb] of [[0, 1], [last, last - 1]]) {
          for (let k = 1; k < K - 1; k++) tri(vi(q, 0), vi(q, k), vi(q, k + 1), mid(nb, 0), mid(nb, 1), mid(nb, 2))
        }
      }
    }
  }
  return { vertices, indices }
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
  for (const h of set.handles) forgetCollider(h)
  set.handles.length = 0
  // react-three-rapier replaces a freed world with a fresh one; only remove from the world that owns it.
  if (world.getRigidBody(set.body.handle) === set.body) world.removeRigidBody(set.body)
}
