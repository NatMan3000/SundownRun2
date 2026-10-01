// ============================================================
//  OUTER GROUND - the land beyond the edge of the world
// ------------------------------------------------------------
//  The track's height grid ends at the world's square edge (on
//  most tracks, just behind the crest of the ridge that holds you
//  in). Beyond it there was nothing, so from any high place - the
//  aerial camera, the top of a jump - the city and the far ridges
//  stood on empty haze.
//
//  This builds the ground out there: radial strips that start
//  exactly on the grid's border heights, roll down the outside of
//  the ridge to the base height, then run on flat to the horizon.
//  It uses the same dark-glass material as the terrain, so the
//  grid and the haze carry straight on across the seam.
//
//  It is scenery only: no collider (the edge ridge or wall keeps
//  the car inside, constitution section 5).
// ============================================================

import * as THREE from 'three'
import type { TrackRuntime } from '../track/types'

/** Distances beyond the world edge (metres) of each ring of vertices. */
const RINGS = [0, 10, 30, 60, 110, 180, 280, 420, 620, 900, 1300, 1900, 2700, 3800, 5400]
/** How far out the ridge's outer slope reaches before the ground is flat. */
const ROLL_OFF = 520

function smoothstep(a: number, b: number, x: number): number {
  const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a)
  return t * t * (3 - 2 * t)
}

/** The outer ground for a track (one indexed mesh, ~17k triangles). */
export function buildOuterGround(track: TrackRuntime): THREE.BufferGeometry {
  const { n, half, cellSize, heights } = track.terrain
  const side = n + 1
  const base = track.file.environment.terrain.height ?? 0
  const step = Math.max(1, Math.round(12 / cellSize))

  // Walk the square border once (corners included), every `step` cells.
  const border: [number, number][] = []
  for (let ix = 0; ix < n; ix += step) border.push([ix, 0])
  for (let iz = 0; iz < n; iz += step) border.push([n, iz])
  for (let ix = n; ix > 0; ix -= step) border.push([ix, n])
  for (let iz = n; iz > 0; iz -= step) border.push([0, iz])

  const cols = border.length
  const rows = RINGS.length
  const position = new Float32Array(cols * rows * 3)
  for (let c = 0; c < cols; c++) {
    const [ix, iz] = border[c]
    const x0 = -half + ix * cellSize
    const z0 = -half + iz * cellSize
    const h0 = heights[iz * side + ix]
    // Straight out from the middle of the world through this border point.
    const len = Math.hypot(x0, z0) || 1
    const dx = x0 / len
    const dz = z0 / len
    for (let r = 0; r < rows; r++) {
      const d = RINGS[r]
      const v = (c * rows + r) * 3
      position[v] = x0 + dx * d
      position[v + 1] = base + (h0 - base) * (1 - smoothstep(0, ROLL_OFF, d))
      position[v + 2] = z0 + dz * d
    }
  }

  const index: number[] = []
  for (let c = 0; c < cols; c++) {
    const c2 = (c + 1) % cols
    for (let r = 0; r < rows - 1; r++) {
      const a = c * rows + r
      const b = c2 * rows + r
      const a1 = a + 1
      const b1 = b + 1
      // Facing up whichever way the border is walked.
      index.push(a, a1, b, b, a1, b1)
    }
  }

  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(position, 3))
  // Same material as the terrain, which shades hills by relief: out here it is level.
  g.setAttribute('aRelief', new THREE.BufferAttribute(new Float32Array(position.length / 3), 1))
  g.setIndex(index)
  g.computeVertexNormals()
  // computeVertexNormals follows the winding: make sure "up" is up.
  const nrm = g.getAttribute('normal') as THREE.BufferAttribute
  let sumY = 0
  for (let i = 0; i < nrm.count; i++) sumY += nrm.getY(i)
  if (sumY < 0) {
    const idx = g.getIndex()!
    for (let i = 0; i < idx.count; i += 3) {
      const t = idx.getX(i + 1)
      idx.setX(i + 1, idx.getX(i + 2))
      idx.setX(i + 2, t)
    }
    g.computeVertexNormals()
  }
  g.computeBoundingSphere()
  return g
}
