// ============================================================
//  TERRAIN TILES - the ground as physics, in pieces
// ------------------------------------------------------------
//  Why not a rapier heightfield (the obvious choice)? Measured on
//  this build's rapier: a heightfield ignores continuous collision
//  detection, so a car-sized box falling faster than ~40 m/s passes
//  straight through it. A triangle mesh with CCD on the car holds
//  even at 100 m/s. So the ground is triangle meshes.
//
//  One giant mesh would take ~110 ms to build, and the Hyperdrome's
//  bank slider changes the ground near the road. So the grid is cut
//  into square tiles (TILE cells a side) and a live rebuild only
//  replaces the tiles whose heights actually changed.
//
//  Triangulation: every grid cell is split along the diagonal from
//  (ix + 1, iz) to (ix, iz + 1). terrain.ts gridHeight() interpolates
//  the same way, so terrainHeight() is exactly what the car touches.
// ============================================================

import { untagSurface } from '../core/physics'
import type { TrackRuntime } from './types'
import { add, type ColliderSet } from './colliders'

import type { Rapier, RigidBody, World } from './rapierTypes'

/** Cells per tile side. 800 triangles a tile: a live rebuild only redoes the ground near the road. */
export const TILE = 20

export interface TerrainTiles {
  body: RigidBody
  /** Tiles per side. */
  tn: number
  n: number
  /**
   * Collider handle per tile (-1 = none). A Float64Array on purpose: rapier's handles
   * are 64-bit numbers that pack an index and a generation, so an Int32Array mangles
   * them (every handle came back as 0, a live rebuild removed the wrong collider, and
   * the old ground stayed solid under the new road).
   */
  handles: Float64Array
  /** The heights the tiles were built from (to spot changed tiles on a rebuild). */
  heights: Float32Array
  half: number
  cellSize: number
}

function tileMesh(t: TrackRuntime, tx: number, tz: number): { vertices: Float32Array; indices: Uint32Array } {
  const { n, half, cellSize, heights } = t.terrain
  const x0 = tx * TILE
  const z0 = tz * TILE
  const x1 = Math.min(n, x0 + TILE)
  const z1 = Math.min(n, z0 + TILE)
  const w = x1 - x0 + 1
  const vertices = new Float32Array(w * (z1 - z0 + 1) * 3)
  let q = 0
  for (let iz = z0; iz <= z1; iz++) {
    const row = iz * (n + 1)
    for (let ix = x0; ix <= x1; ix++) {
      vertices[q++] = -half + ix * cellSize
      vertices[q++] = heights[row + ix]
      vertices[q++] = -half + iz * cellSize
    }
  }
  const indices = new Uint32Array((x1 - x0) * (z1 - z0) * 6)
  q = 0
  for (let iz = 0; iz < z1 - z0; iz++) {
    for (let ix = 0; ix < x1 - x0; ix++) {
      const a = iz * w + ix //   (ix, iz)
      const b = a + 1 //         (ix + 1, iz)
      const c = a + w //         (ix, iz + 1)
      const d = c + 1 //         (ix + 1, iz + 1)
      // Counter-clockwise seen from above (+y), split along b-c.
      indices[q++] = a
      indices[q++] = c
      indices[q++] = b
      indices[q++] = b
      indices[q++] = c
      indices[q++] = d
    }
  }
  return { vertices, indices }
}

function buildTile(world: World, R: Rapier, tiles: TerrainTiles, t: TrackRuntime, tx: number, tz: number): void {
  const k = tz * tiles.tn + tx
  const old = tiles.handles[k]
  if (old >= 0) {
    const c = world.getCollider(old)
    untagSurface(old)
    if (c) world.removeCollider(c, false)
  }
  const m = tileMesh(t, tx, tz)
  const set: ColliderSet = { body: tiles.body, handles: [] }
  add(world, R, set, R.ColliderDesc.trimesh(m.vertices, m.indices, R.TriMeshFlags.FIX_INTERNAL_EDGES), 'terrain')
  tiles.handles[k] = set.handles[0] ?? -1
}

/** Build every tile for a track. */
export function createTerrainTiles(world: World, R: Rapier, t: TrackRuntime): TerrainTiles {
  const n = t.terrain.n
  const tn = Math.ceil(n / TILE)
  const tiles: TerrainTiles = {
    body: world.createRigidBody(R.RigidBodyDesc.fixed()),
    tn,
    n,
    handles: new Float64Array(tn * tn).fill(-1),
    heights: new Float32Array(t.terrain.heights),
    half: t.terrain.half,
    cellSize: t.terrain.cellSize,
  }
  for (let tz = 0; tz < tn; tz++) for (let tx = 0; tx < tn; tx++) buildTile(world, R, tiles, t, tx, tz)
  return tiles
}

/**
 * Bring the tiles in line with a rebuilt track (same grid). Only tiles with a
 * changed height are replaced. Returns how many were rebuilt. If the grid itself
 * changed shape, rebuilds everything.
 */
export function updateTerrainTiles(world: World, R: Rapier, tiles: TerrainTiles, t: TrackRuntime): number {
  const g = t.terrain
  if (g.n !== tiles.n || g.half !== tiles.half || g.cellSize !== tiles.cellSize) {
    for (let tz = 0; tz < tiles.tn; tz++) for (let tx = 0; tx < tiles.tn; tx++) buildTile(world, R, tiles, t, tx, tz)
    tiles.heights = new Float32Array(g.heights)
    return tiles.tn * tiles.tn
  }
  const n = g.n
  let rebuilt = 0
  for (let tz = 0; tz < tiles.tn; tz++) {
    for (let tx = 0; tx < tiles.tn; tx++) {
      const x0 = tx * TILE
      const z0 = tz * TILE
      const x1 = Math.min(n, x0 + TILE)
      const z1 = Math.min(n, z0 + TILE)
      let changed = false
      for (let iz = z0; iz <= z1 && !changed; iz++) {
        const row = iz * (n + 1)
        for (let ix = x0; ix <= x1; ix++) {
          if (g.heights[row + ix] !== tiles.heights[row + ix]) {
            changed = true
            break
          }
        }
      }
      if (changed) {
        buildTile(world, R, tiles, t, tx, tz)
        rebuilt++
      }
    }
  }
  tiles.heights.set(g.heights)
  return rebuilt
}

/** Remove all tiles (safe after the physics world has been torn down). */
export function removeTerrainTiles(world: World, tiles: TerrainTiles): void {
  for (let k = 0; k < tiles.handles.length; k++) if (tiles.handles[k] >= 0) untagSurface(tiles.handles[k])
  tiles.handles.fill(-1)
  if (world.getRigidBody(tiles.body.handle) === tiles.body) world.removeRigidBody(tiles.body)
}
