// ============================================================
//  ROAD QUERIES - "where am I on the road?" without allocating
// ------------------------------------------------------------
//  frameAt(s)  the road's frame at a distance along it (interpolated
//              between the 1 m samples).
//  nearest(p)  the closest road point to a world position.
//
//  Both are called every physics step by every car (player, Ai,
//  ghost, lap tracker), so they never create objects: callers pass
//  an `out` they own, and the scratch values live at module level.
//
//  nearest() has two modes:
//   - with a hint (the caller's s from last step): search a small
//     window around it. A car on a bridge stays on the bridge, a car
//     in a loop stays in the loop, even where another bit of road is
//     closer in a straight line.
//   - without one: an XZ grid of samples (the "spatial hash") finds
//     candidates near (x, z); the closest in 3D wins, which prefers
//     the level of a crossing you're actually on.
// ============================================================

import * as THREE from 'three'
import { SURFACE_FROM_CODE, type NearestHit, type TrackFrame, type TrackSamples } from './types'

/** XZ grid of sample indices (compressed-row layout: one start offset per cell). */
export interface SampleHash {
  cell: number
  minX: number
  minZ: number
  nx: number
  nz: number
  start: Int32Array
  items: Int32Array
}

export function buildSampleHash(S: TrackSamples, cell = 12): SampleHash {
  let minX = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxZ = -Infinity
  for (let i = 0; i < S.count; i++) {
    if (S.px[i] < minX) minX = S.px[i]
    if (S.px[i] > maxX) maxX = S.px[i]
    if (S.pz[i] < minZ) minZ = S.pz[i]
    if (S.pz[i] > maxZ) maxZ = S.pz[i]
  }
  minX -= cell
  minZ -= cell
  const nx = Math.max(1, Math.ceil((maxX - minX) / cell) + 2)
  const nz = Math.max(1, Math.ceil((maxZ - minZ) / cell) + 2)
  const counts = new Int32Array(nx * nz)
  const cellOf = (i: number) => {
    const cx = Math.floor((S.px[i] - minX) / cell)
    const cz = Math.floor((S.pz[i] - minZ) / cell)
    return cz * nx + cx
  }
  for (let i = 0; i < S.count; i++) counts[cellOf(i)]++
  const start = new Int32Array(nx * nz + 1)
  for (let c = 0; c < nx * nz; c++) start[c + 1] = start[c] + counts[c]
  const cursor = start.slice(0, nx * nz)
  const items = new Int32Array(S.count)
  for (let i = 0; i < S.count; i++) items[cursor[cellOf(i)]++] = i
  return { cell, minX, minZ, nx, nz, start, items }
}

/** How far either side of the hint a hinted search looks, metres. */
const HINT_WINDOW = 40
/** If the hinted search's best is further than this, the hint was stale: search globally. */
const HINT_GIVE_UP = 30

export interface RoadQueries {
  frameAt: (s: number, out: TrackFrame) => TrackFrame
  nearest: (x: number, y: number, z: number, out: NearestHit, hintS?: number) => NearestHit
  wrapS: (s: number) => number
  deltaS: (a: number, b: number) => number
  /** Allowed lateral reach on the right (+) / left (-) at sample i (wider on wall rides). */
  sampleOnRoad: (i: number, lateral: number, height: number) => boolean
}

export interface WallReach {
  wallLeft: Float32Array
  wallRight: Float32Array
  wallRadius: Float32Array
}

export function makeRoadQueries(S: TrackSamples, length: number, hash: SampleHash, walls: WallReach): RoadQueries {
  const count = S.count
  const ds = S.ds
  const invDs = 1 / ds

  const wrapS = (s: number): number => {
    let r = s % length
    if (r < 0) r += length
    return r
  }
  const deltaS = (a: number, b: number): number => {
    let d = (b - a) % length
    if (d > length / 2) d -= length
    else if (d <= -length / 2) d += length
    return d
  }

  const frameAt = (sIn: number, out: TrackFrame): TrackFrame => {
    const s = wrapS(sIn)
    const fi = s * invDs
    let i = Math.floor(fi)
    if (i >= count) i = count - 1
    const f = fi - i
    const j = i + 1 >= count ? 0 : i + 1
    out.s = s
    out.position.set(
      S.px[i] + (S.px[j] - S.px[i]) * f,
      S.py[i] + (S.py[j] - S.py[i]) * f,
      S.pz[i] + (S.pz[j] - S.pz[i]) * f,
    )
    let tx = S.tx[i] + (S.tx[j] - S.tx[i]) * f
    let ty = S.ty[i] + (S.ty[j] - S.ty[i]) * f
    let tz = S.tz[i] + (S.tz[j] - S.tz[i]) * f
    const tl = Math.hypot(tx, ty, tz) || 1
    tx /= tl
    ty /= tl
    tz /= tl
    let ux = S.ux[i] + (S.ux[j] - S.ux[i]) * f
    let uy = S.uy[i] + (S.uy[j] - S.uy[i]) * f
    let uz = S.uz[i] + (S.uz[j] - S.uz[i]) * f
    const d = ux * tx + uy * ty + uz * tz
    ux -= tx * d
    uy -= ty * d
    uz -= tz * d
    const ul = Math.hypot(ux, uy, uz) || 1
    ux /= ul
    uy /= ul
    uz /= ul
    out.tangent.set(tx, ty, tz)
    out.up.set(ux, uy, uz)
    out.right.set(ty * uz - tz * uy, tz * ux - tx * uz, tx * uy - ty * ux)
    out.halfWidth = S.halfWidth[i] + (S.halfWidth[j] - S.halfWidth[i]) * f
    out.bank = S.bank[i] + (S.bank[j] - S.bank[i]) * f
    out.curvature = S.curvature[i] + (S.curvature[j] - S.curvature[i]) * f
    out.surface = SURFACE_FROM_CODE[f < 0.5 ? S.surface[i] : S.surface[j]]
    return out
  }

  /** On the road at sample i? Wall rides widen the reach onto the curved wall. */
  const sampleOnRoad = (i: number, lateral: number, height: number): boolean => {
    const hw = S.halfWidth[i]
    const al = Math.abs(lateral)
    if (al <= hw + 0.6 && height > -1.5 && height <= 3) return true
    const sweep = lateral > 0 ? walls.wallRight[i] : walls.wallLeft[i]
    if (sweep <= 0) return false
    // On the wall: distance from the wall curve's centre is about its radius.
    const R = walls.wallRadius[i]
    const dl = al - hw
    const dh = height - R
    const r = Math.hypot(dl, dh)
    return dl > -0.6 && r > R - 3 && r < R + 1.5
  }

  // Scratch for nearest() (module-level in spirit: one per runtime, never per call).
  let segS = 0
  const segDist2 = (i: number, x: number, y: number, z: number): number => {
    // Closest point on the segment from sample i to i+1; writes segS.
    const j = i + 1 >= count ? 0 : i + 1
    const ax = S.px[i]
    const ay = S.py[i]
    const az = S.pz[i]
    const ex = S.px[j] - ax
    const ey = S.py[j] - ay
    const ez = S.pz[j] - az
    const l2 = ex * ex + ey * ey + ez * ez
    let t = l2 > 0 ? ((x - ax) * ex + (y - ay) * ey + (z - az) * ez) / l2 : 0
    t = t < 0 ? 0 : t > 1 ? 1 : t
    segS = (i + t) * ds
    const qx = ax + ex * t - x
    const qy = ay + ey * t - y
    const qz = az + ez * t - z
    return qx * qx + qy * qy + qz * qz
  }

  /** Scan one hash cell, keeping the closest sample in 3D. */
  let gBest = -1
  let gBestD2 = Infinity
  const scanCell = (gx: number, gz: number, x: number, y: number, z: number): void => {
    if (gx < 0 || gz < 0 || gx >= hash.nx || gz >= hash.nz) return
    const c = gz * hash.nx + gx
    for (let k = hash.start[c], e = hash.start[c + 1]; k < e; k++) {
      const i = hash.items[k]
      const dx = S.px[i] - x
      const dy = S.py[i] - y
      const dz = S.pz[i] - z
      const d2 = dx * dx + dy * dy + dz * dz
      if (d2 < gBestD2) {
        gBestD2 = d2
        gBest = i
      }
    }
  }

  /** Closest sample in 3D, searching outward ring by ring from (x, z)'s cell. */
  const globalBest = (x: number, y: number, z: number): number => {
    const cx = Math.floor((x - hash.minX) / hash.cell)
    const cz = Math.floor((z - hash.minZ) / hash.cell)
    gBest = -1
    gBestD2 = Infinity
    // Rings beyond this cover the whole grid from anywhere.
    const far = Math.max(Math.abs(cx), Math.abs(cz), Math.abs(cx - hash.nx), Math.abs(cz - hash.nz)) + 1
    for (let ring = 0; ring <= far; ring++) {
      // Every cell in this ring is at least (ring - 1) cells away horizontally.
      const minH = (ring - 1) * hash.cell
      if (gBest >= 0 && minH > 0 && minH * minH > gBestD2) break
      if (ring === 0) {
        scanCell(cx, cz, x, y, z)
        continue
      }
      for (let gx = cx - ring; gx <= cx + ring; gx++) {
        scanCell(gx, cz - ring, x, y, z)
        scanCell(gx, cz + ring, x, y, z)
      }
      for (let gz = cz - ring + 1; gz <= cz + ring - 1; gz++) {
        scanCell(cx - ring, gz, x, y, z)
        scanCell(cx + ring, gz, x, y, z)
      }
    }
    return gBest < 0 ? 0 : gBest
  }

  const tmpFrame: TrackFrame = {
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

  const nearest = (x: number, y: number, z: number, out: NearestHit, hintS?: number): NearestHit => {
    let best = -1
    let bestD2 = Infinity
    if (hintS !== undefined && Number.isFinite(hintS)) {
      const h = Math.round(wrapS(hintS) * invDs)
      const w = Math.ceil(HINT_WINDOW * invDs)
      for (let k = -w; k <= w; k++) {
        const i = (((h + k) % count) + count) % count
        const dx = S.px[i] - x
        const dy = S.py[i] - y
        const dz = S.pz[i] - z
        const d2 = dx * dx + dy * dy + dz * dz
        if (d2 < bestD2) {
          bestD2 = d2
          best = i
        }
      }
      if (bestD2 > HINT_GIVE_UP * HINT_GIVE_UP) best = -1
    }
    if (best < 0) best = globalBest(x, y, z)

    // Refine onto the two segments either side of the best sample.
    const prev = best - 1 < 0 ? count - 1 : best - 1
    const dA = segDist2(prev, x, y, z)
    const sA = segS
    const dB = segDist2(best, x, y, z)
    const sB = segS
    const s = wrapS(dA < dB ? sA : sB)
    const fr = frameAt(s, tmpFrame)
    const p = fr.position
    const r = fr.right
    const u = fr.up
    const dx = x - p.x
    const dy = y - p.y
    const dz = z - p.z
    out.s = s
    out.index = Math.min(count - 1, Math.round(s * invDs) % count)
    out.lateral = dx * r.x + dy * r.y + dz * r.z
    out.height = dx * u.x + dy * u.y + dz * u.z
    out.distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
    out.onRoad = sampleOnRoad(out.index, out.lateral, out.height)
    return out
  }

  return { frameAt, nearest, wrapS, deltaS, sampleOnRoad }
}
