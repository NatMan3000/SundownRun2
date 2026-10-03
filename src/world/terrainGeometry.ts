// ============================================================
//  TERRAIN GEOMETRY - the track's height grid as meshes
// ------------------------------------------------------------
//  The track builder hands us `track.terrain`: a square grid of
//  heights (the same numbers the physics collider uses). This file
//  turns it into meshes for drawing.
//
//  CHUNKS. The grid is cut into CHUNKS x CHUNKS squares. three.js
//  skips the ones behind the camera (frustum culling), and each one
//  can be drawn at its own level of detail.
//
//  LEVELS OF DETAIL. Every chunk is built three times: near (full
//  detail), mid and far (every 2nd / 4th height, so 4x / 16x fewer
//  triangles). Terrain.tsx shows each chunk at the level its
//  distance from the camera calls for. Far away a 12 m triangle
//  looks exactly like a 3 m one, and the triangle budget
//  (constitution section 2) is spent where you can see it. The
//  lower quality presets use coarser levels.
//
//  SKIRTS. Where a detailed chunk meets a coarse one their edges do
//  not quite line up, which would leave hairline cracks you could
//  see the sky through. Every chunk hangs a short "skirt" down from
//  its edges to cover them (a standard terrain trick).
//
//  THE ROAD TUCK. Under the road the terrain is flattened to just
//  below the road's own height. We push the DRAWN terrain a little
//  further down there (the physics terrain is not touched), so the
//  two surfaces can never flicker through each other ("z-fighting").
//  The road slab's sides hide the step. On coarse levels, near the
//  road we use the lowest height we skipped, so a big triangle can
//  never poke up through the asphalt.
//
//  TUNNELS. Over a tunnel the ground grid holds the cutting floor,
//  and the tube's own top (the roof, the walls of ground and their
//  tops: track/tunnelMeshes.ts) is the hill you see. The drawn ground
//  tucks itself under that top the same way it does under the road,
//  and its shading (relief and normals) is worked out as though the
//  hill were whole, so the top, drawn here in the ground's own
//  material (buildTunnelHill), matches the ground round it. Chunks a
//  tunnel touches always use their most detailed level: a coarse
//  triangle there would reach from the hill down into the dig.
//
//  RELIEF. Every vertex also carries `aRelief`: how many metres it
//  stands above (or sits below) the average ground around it, about
//  80 m each way. Crests are positive, valley floors negative. The
//  terrain material uses it to shade hills (valleys catch less sky,
//  crests more), so a hillside shows its shape and not one flat
//  tone. Worked out once at load, from a blurred copy of the grid.
// ============================================================

import * as THREE from 'three'
import type { QualityLevel } from '../core/settings'
import type { TrackRuntime } from '../track/types'
import { trackInternals } from '../track/build'

/** Chunks per side: 6 x 6 = 36 meshes, usually under half of them in view. */
const CHUNKS = 6
/** How far the drawn terrain sinks under the road, metres. */
const TUCK = 0.3
/** The tuck eases out over this many metres past the road edge. */
const TUCK_FADE = 2

/** Target triangle edge length (metres) for the near / mid / far levels, per preset. */
const LEVEL_CELL: Record<QualityLevel, [number, number, number]> = {
  high: [3, 6, 12],
  medium: [6, 6, 12],
  low: [6, 12, 24],
}

/** Half-width of each of the two box blurs that find the "average ground" for relief, metres. */
const RELIEF_RADIUS = 40

/** Camera distance (metres, to the chunk's edge) where mid and far detail take over. */
export const LEVEL_DISTANCE: [number, number] = [230, 720]

function smoothstep(a: number, b: number, x: number): number {
  const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a)
  return t * t * (3 - 2 * t)
}

/**
 * For every grid vertex: metres outside the nearest grounded road edge
 * (negative = under the road). Infinity far from the road.
 */
function roadEdgeDistance(track: TrackRuntime): Float32Array {
  const { n, half, cellSize } = track.terrain
  const side = n + 1
  const out = new Float32Array(side * side).fill(Infinity)
  const s = track.samples
  const reach = TUCK_FADE + 26 // far enough for the coarsest level's "lowest height" search
  for (let i = 0; i < s.count; i++) {
    if (!s.grounded[i]) continue
    const px = s.px[i]
    const pz = s.pz[i]
    const hw = s.halfWidth[i]
    const r = hw + reach
    const ix0 = Math.max(0, Math.floor((px - r + half) / cellSize))
    const ix1 = Math.min(n, Math.ceil((px + r + half) / cellSize))
    const iz0 = Math.max(0, Math.floor((pz - r + half) / cellSize))
    const iz1 = Math.min(n, Math.ceil((pz + r + half) / cellSize))
    for (let iz = iz0; iz <= iz1; iz++) {
      const z = -half + iz * cellSize
      for (let ix = ix0; ix <= ix1; ix++) {
        const x = -half + ix * cellSize
        const d = Math.hypot(x - px, z - pz) - hw
        const k = iz * side + ix
        if (d < out[k]) out[k] = d
      }
    }
  }
  return out
}

/** Grid step (in cells) whose triangles are about `metres` long: 1, 2, 4, 8 ... */
function strideForCell(cellSize: number, metres: number): number {
  const ratio = metres / cellSize
  if (ratio <= 1.4) return 1
  return Math.min(16, 2 ** Math.round(Math.log2(ratio)))
}

export interface TerrainChunk {
  /** Geometry per level of detail: [near, mid, far]. */
  levels: THREE.BufferGeometry[]
  /** A tunnel reaches into this chunk: always draw its near level. */
  pinNear: boolean
  triangles: number[]
  /** The chunk's square in x/z, for distance checks. */
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

export interface TerrainBuild {
  chunks: TerrainChunk[]
  strides: number[]
  /** Per grid vertex: the relief and the lightly smoothed heights the shading uses (for buildTunnelHill). */
  relief: Float32Array
  shade: Float32Array
}

/** Build every chunk at every level of detail for a track and preset. */
export function buildTerrain(track: TrackRuntime, quality: QualityLevel): TerrainBuild {
  const { n, half, cellSize, heights } = track.terrain
  const side = n + 1
  const edge = roadEdgeDistance(track)

  // Under a tunnel's solid: the height of its top, and how far inside its outer edge (track/terrain.ts).
  const extras = trackInternals(track)
  const tunnelTop = extras?.tunnelTop ?? null
  const tunnelIn = extras?.tunnelIn ?? null

  // Full-detail heights as drawn: tucked under the road (and under a tunnel's top).
  const drawn = new Float32Array(side * side)
  // ...and as the shading sees them: the hill whole where a tunnel's top covers the dig.
  const whole = new Float32Array(side * side)
  for (let k = 0; k < drawn.length; k++) {
    let h = heights[k]
    const d = edge[k]
    // Only UNDER the road: at the edge the ground already meets the slab's lip,
    // so tucking past it would leave a visible trough beside the road.
    let tuck = d < 0 ? TUCK * smoothstep(0, TUCK_FADE, -d) : 0
    const top = tunnelTop ? tunnelTop[k] : NaN
    if (tunnelIn && !Number.isNaN(top)) tuck = Math.max(tuck, TUCK * smoothstep(0, TUCK_FADE, tunnelIn[k]))
    h -= tuck
    drawn[k] = h
    whole[k] = Number.isNaN(top) ? h : top
  }

  const relief = localRelief(whole, side, Math.max(1, Math.round(RELIEF_RADIUS / cellSize)))
  // Shading normals come from a lightly smoothed copy (one 3 x 3 average), so
  // a stepped cut slope shades as one surface instead of a row of facets.
  // Positions stay exact (the drawn ground is still the ground the wheels touch).
  const shade = boxBlur(whole, side, 1, 1)

  const strides = LEVEL_CELL[quality].map((m) => strideForCell(cellSize, m))
  const per = Math.ceil(n / CHUNKS)
  const chunks: TerrainChunk[] = []

  for (let cz = 0; cz < CHUNKS; cz++) {
    for (let cx = 0; cx < CHUNKS; cx++) {
      const x0 = cx * per
      const z0 = cz * per
      const x1 = Math.min(n, x0 + per)
      const z1 = Math.min(n, z0 + per)
      if (x1 <= x0 || z1 <= z0) continue
      const levels: THREE.BufferGeometry[] = []
      const triangles: number[] = []
      for (const stride of strides) {
        const g = buildChunk(drawn, shade, edge, relief, n, half, cellSize, x0, x1, z0, z1, stride)
        levels.push(g)
        triangles.push((g.index ? g.index.count : 0) / 3)
      }
      let pinNear = false
      if (tunnelTop) {
        for (let iz = Math.max(0, z0 - 1); iz <= Math.min(n, z1 + 1) && !pinNear; iz++) {
          for (let ix = Math.max(0, x0 - 1); ix <= Math.min(n, x1 + 1); ix++) {
            if (!Number.isNaN(tunnelTop[iz * side + ix])) {
              pinNear = true
              break
            }
          }
        }
      }
      chunks.push({
        levels,
        pinNear,
        triangles,
        minX: -half + x0 * cellSize,
        maxX: -half + x1 * cellSize,
        minZ: -half + z0 * cellSize,
        maxZ: -half + z1 * cellSize,
      })
    }
  }
  return { chunks, strides, relief, shade }
}

/** Bilinear value of a per-vertex grid array at (x, z). */
function gridSample(a: Float32Array, n: number, half: number, cellSize: number, x: number, z: number): number {
  const fx = Math.min(n, Math.max(0, (x + half) / cellSize))
  const fz = Math.min(n, Math.max(0, (z + half) / cellSize))
  const ix = Math.min(n - 1, Math.floor(fx))
  const iz = Math.min(n - 1, Math.floor(fz))
  const tx = fx - ix
  const tz = fz - iz
  const s = n + 1
  const k = iz * s + ix
  return (a[k] * (1 - tx) + a[k + 1] * tx) * (1 - tz) + (a[k + s] * (1 - tx) + a[k + s + 1] * tx) * tz
}

/**
 * The hill over every tunnel (TrackRuntime.meshes.tunnels.hill) as a geometry for the ground's
 * own material: relief from the ground round it, and on its tops the same smooth shading
 * normals as the ground (so the roof and the hill beside it shade as one surface). Its
 * upright faces (the walls of ground, the portals) keep their own normals. null without tunnels.
 */
export function buildTunnelHill(track: TrackRuntime, build: TerrainBuild): THREE.BufferGeometry | null {
  const hill = track.meshes.tunnels?.hill
  if (!hill || !hill.indices.length) return null
  const { n, half, cellSize } = track.terrain
  const P = hill.positions
  const count = P.length / 3
  const normal = new Float32Array(hill.normals)
  const relief = new Float32Array(count)
  const e = cellSize
  for (let v = 0; v < count; v++) {
    const x = P[v * 3]
    const z = P[v * 3 + 2]
    relief[v] = gridSample(build.relief, n, half, cellSize, x, z)
    if (normal[v * 3 + 1] > 0.5) {
      const dhdx = (gridSample(build.shade, n, half, cellSize, x + e, z) - gridSample(build.shade, n, half, cellSize, x - e, z)) / (2 * e)
      const dhdz = (gridSample(build.shade, n, half, cellSize, x, z + e) - gridSample(build.shade, n, half, cellSize, x, z - e)) / (2 * e)
      const inv = 1 / Math.sqrt(dhdx * dhdx + 1 + dhdz * dhdz)
      normal[v * 3] = -dhdx * inv
      normal[v * 3 + 1] = inv
      normal[v * 3 + 2] = -dhdz * inv
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(P, 3))
  g.setAttribute('normal', new THREE.BufferAttribute(normal, 3))
  g.setAttribute('aRelief', new THREE.BufferAttribute(relief, 1))
  g.setIndex(new THREE.BufferAttribute(hill.indices, 1))
  g.computeBoundingBox()
  g.computeBoundingSphere()
  return g
}

/**
 * Height above the local average ground, per grid vertex: the heights minus a
 * blurred copy of them (two box blurs of half-width r cells, each run along the
 * rows and then the columns with a running sum, so it costs the same for any r).
 */
function localRelief(heights: Float32Array, side: number, r: number): Float32Array {
  const blurred = boxBlur(heights, side, r, 2)
  const relief = new Float32Array(heights.length)
  for (let k = 0; k < heights.length; k++) relief[k] = heights[k] - blurred[k]
  return relief
}

/** The height grid averaged over (2r + 1) x (2r + 1) cells, `passes` times over. */
function boxBlur(heights: Float32Array, side: number, r: number, passes: number): Float32Array {
  const a = Float32Array.from(heights)
  const b = new Float32Array(heights.length)
  const blurLine = (src: Float32Array, dst: Float32Array, start: number, step: number) => {
    // Running sum over [i - r, i + r], clamped at the grid edge.
    let sum = 0
    let count = 0
    for (let i = 0; i <= Math.min(r, side - 1); i++) {
      sum += src[start + i * step]
      count++
    }
    for (let i = 0; i < side; i++) {
      dst[start + i * step] = sum / count
      const add = i + r + 1
      const drop = i - r
      if (add < side) {
        sum += src[start + add * step]
        count++
      }
      if (drop >= 0) {
        sum -= src[start + drop * step]
        count--
      }
    }
  }
  for (let pass = 0; pass < passes; pass++) {
    for (let z = 0; z < side; z++) blurLine(a, b, z * side, 1)
    for (let x = 0; x < side; x++) blurLine(b, a, x, side)
  }
  return a
}

/** The lattice positions along one axis of a chunk at a stride (always includes both ends). */
function axisLattice(a0: number, a1: number, stride: number): number[] {
  const out: number[] = []
  for (let a = a0; a < a1; a += stride) out.push(a)
  out.push(a1)
  return out
}

function buildChunk(
  drawn: Float32Array,
  shade: Float32Array,
  edge: Float32Array,
  relief: Float32Array,
  n: number,
  half: number,
  cellSize: number,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  stride: number,
): THREE.BufferGeometry {
  const side = n + 1
  const xs = axisLattice(x0, x1, stride)
  const zs = axisLattice(z0, z1, stride)
  const w = xs.length
  const h = zs.length

  // Height at a lattice vertex: on coarse levels near the road, never above any skipped height.
  const heightAt = (ix: number, iz: number): number => {
    const k = iz * side + ix
    let y = drawn[k]
    if (stride > 1 && edge[k] < stride * cellSize) {
      const r = stride >> 1
      for (let dz = -r; dz <= r; dz++) {
        const z2 = iz + dz
        if (z2 < 0 || z2 > n) continue
        for (let dx = -r; dx <= r; dx++) {
          const x2 = ix + dx
          if (x2 < 0 || x2 > n) continue
          const y2 = drawn[z2 * side + x2]
          if (y2 < y) y = y2
        }
      }
    }
    return y
  }

  // Smooth normal from the (lightly smoothed) full-detail heights, measured across the stride.
  const normalAt = (ix: number, iz: number, out: number[], o: number): void => {
    const xa = Math.max(0, ix - stride)
    const xb = Math.min(n, ix + stride)
    const za = Math.max(0, iz - stride)
    const zb = Math.min(n, iz + stride)
    const dhdx = (shade[iz * side + xb] - shade[iz * side + xa]) / ((xb - xa) * cellSize)
    const dhdz = (shade[zb * side + ix] - shade[za * side + ix]) / ((zb - za) * cellSize)
    const inv = 1 / Math.sqrt(dhdx * dhdx + 1 + dhdz * dhdz)
    out[o] = -dhdx * inv
    out[o + 1] = inv
    out[o + 2] = -dhdz * inv
  }

  const border = 2 * (w + h) - 4
  const vCount = w * h + border
  const position = new Float32Array(vCount * 3)
  const normal = new Float32Array(vCount * 3)
  const reliefAttr = new Float32Array(vCount)
  const tmp = [0, 0, 0]

  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const v = j * w + i
      const ix = xs[i]
      const iz = zs[j]
      position[v * 3] = -half + ix * cellSize
      position[v * 3 + 1] = heightAt(ix, iz)
      position[v * 3 + 2] = -half + iz * cellSize
      normalAt(ix, iz, tmp, 0)
      normal[v * 3] = tmp[0]
      normal[v * 3 + 1] = tmp[1]
      normal[v * 3 + 2] = tmp[2]
      reliefAttr[v] = relief[iz * side + ix]
    }
  }

  const index: number[] = []
  for (let j = 0; j < h - 1; j++) {
    for (let i = 0; i < w - 1; i++) {
      const a = j * w + i
      const b = a + 1
      const c = a + w
      const d = c + 1
      // The same diagonal as the physics ground (track/terrainTiles.ts: from
      // (ix + 1, iz) to (ix, iz + 1)), so on the near level the drawn ground
      // is exactly the ground the wheels touch.
      index.push(a, c, b, b, c, d)
    }
  }

  // The skirt: walk the border once, hang a copy of each edge vertex below it.
  const ring: number[] = []
  for (let i = 0; i < w; i++) ring.push(i)
  for (let j = 1; j < h; j++) ring.push(j * w + (w - 1))
  for (let i = w - 2; i >= 0; i--) ring.push((h - 1) * w + i)
  for (let j = h - 2; j >= 1; j--) ring.push(j * w)
  const depth = 1.5 + stride * cellSize * 0.4
  const first = w * h
  for (let r = 0; r < ring.length; r++) {
    const src = ring[r]
    const v = first + r
    position[v * 3] = position[src * 3]
    position[v * 3 + 1] = position[src * 3 + 1] - depth
    position[v * 3 + 2] = position[src * 3 + 2]
    normal[v * 3] = normal[src * 3]
    normal[v * 3 + 1] = normal[src * 3 + 1]
    normal[v * 3 + 2] = normal[src * 3 + 2]
    reliefAttr[v] = reliefAttr[src]
  }
  for (let r = 0; r < ring.length; r++) {
    const a = ring[r]
    const b = ring[(r + 1) % ring.length]
    const a2 = first + r
    const b2 = first + ((r + 1) % ring.length)
    // Both windings, so the skirt covers a crack seen from either side.
    index.push(a, b, b2, a, b2, a2, a, b2, b, a, a2, b2)
  }

  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(position, 3))
  g.setAttribute('normal', new THREE.BufferAttribute(normal, 3))
  g.setAttribute('aRelief', new THREE.BufferAttribute(reliefAttr, 1))
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(index), 1))
  g.computeBoundingBox()
  g.computeBoundingSphere()
  return g
}
