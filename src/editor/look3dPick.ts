// ============================================================
//  3D PICKING - which bit of road (or ground) is under the mouse
// ------------------------------------------------------------
//  On the flat map a screen spot IS a world spot (view.ts). In the
//  3D view it isn't: the mouse sits over a line of sight from the
//  camera into the world, and the thing it points at is the first
//  surface that line hits. This file answers that for the editor's
//  tools, using the real built road (the one you can see):
//
//    pick()       the road under the mouse: the first road surface the
//                 line of sight hits (so at a crossing you get the road
//                 you're looking at, the bridge or the road under it),
//                 or, just off the road, the road within 12 pixels of
//                 the mouse, the same reach as on the map. A road
//                 behind a hill is never picked through the hill.
//                 Also the ground the line hits (for drawing).
//    surfaceY()   how high the road is at a spot (the right road at a
//                 crossing, picked by which way it heads), else the
//                 ground: the 3D view draws the map's marks there.
//    project()    a world spot to a screen spot.
//
//  It is plain maths on a camera and a built track (no editor state),
//  so the editor's self-test (selfTest3dPick.ts) runs it in Bun. No
//  allocation per call: every number is kept in scratch fields.
// ============================================================

import * as THREE from 'three'
import { buildSampleHash, type SampleHash } from '../track/query'
import { SURFACE_CODE, type TrackRuntime } from '../track/types'

/** The road the mouse points at. */
export interface RoadPick {
  /** The road sample it is on (the segment from sample i to i + 1), and how far along that segment (0..1). */
  i: number
  f: number
  /** The spot on the road (on its surface, at the mouse or as near the mouse as the road comes). */
  x: number
  y: number
  z: number
  /** Metres right (+) or left (-) of the road's middle. */
  lateral: number
  /** Which way the road heads there, flat (a unit vector in x, z). */
  dirX: number
  dirZ: number
  /** True when the line of sight hits the road itself; false when the road is just beside the mouse. */
  direct: boolean
  /** Pixels from the mouse to the road's edge (0 when it is on the road). */
  px: number
}

/** A spot in the world. */
export interface Spot3 {
  x: number
  y: number
  z: number
}

/** How a pick reaches: the map's reach is the road's edge plus 12 pixels, and never less than 4 m. */
export const PICK_REACH = { px: 12, metres: 4 }
/** Samples per chunk for the quick "could the line of sight come near this bit of road?" test. */
const CHUNK = 32
/** A road this far (along the line of sight) behind the ground it would be seen through is hidden by it. */
const HIDDEN_BY_GROUND = 1.0
/** The furthest the line of sight is followed, metres (past the most zoomed-out 3D camera's view). */
const MAX_T = 12000

// scratch (no allocation per call)
const _o = new THREE.Vector3()
const _d = new THREE.Vector3()
const _v = new THREE.Vector3()
const _hit: RoadPick = { i: -1, f: 0, x: 0, y: 0, z: 0, lateral: 0, dirX: 1, dirZ: 0, direct: false, px: 0 }
const _ground: Spot3 = { x: 0, y: 0, z: 0 }
const _scr = { sx: 0, sy: 0, depth: 0 }
/** The best few "just beside the mouse" candidates, nearest first: sample, fraction, pixels, distance. */
const NEAR_KEEP = 6
const nearI = new Int32Array(NEAR_KEEP)
const nearF = new Float64Array(NEAR_KEEP)
const nearPx = new Float64Array(NEAR_KEEP)
const nearT = new Float64Array(NEAR_KEEP)

/**
 * Picking for one built track. Make one per track (TrackRuntime); it
 * precomputes a grid of samples and the chunks' bounding spheres.
 */
export class RoadPicker {
  readonly track: TrackRuntime
  private readonly hash: SampleHash
  private readonly chunkX: Float32Array
  private readonly chunkY: Float32Array
  private readonly chunkZ: Float32Array
  private readonly chunkR: Float32Array
  private readonly maxHalf: number
  /** The sample the last surfaceY() matched (the next spot along a line is looked for near it first). */
  private lastIdx = -1
  /**
   * Heights already worked out, by spot (10 cm), heading (one of 32 ways, or none) and reach: they
   * only change when the track does (a new picker), so turning the camera never looks them up again.
   */
  private readonly heights = new Map<number, number>()

  constructor(track: TrackRuntime) {
    this.track = track
    const S = track.samples
    this.hash = buildSampleHash(S, 8)
    const chunks = Math.max(1, Math.ceil(S.count / CHUNK))
    this.chunkX = new Float32Array(chunks)
    this.chunkY = new Float32Array(chunks)
    this.chunkZ = new Float32Array(chunks)
    this.chunkR = new Float32Array(chunks)
    let maxHalf = 0
    for (let i = 0; i < S.count; i++) maxHalf = Math.max(maxHalf, S.halfWidth[i])
    this.maxHalf = maxHalf
    for (let c = 0; c < chunks; c++) {
      const a = c * CHUNK
      const b = Math.min(S.count, a + CHUNK + 1)
      let x = 0
      let y = 0
      let z = 0
      let n = 0
      for (let k = a; k < b; k++) {
        const i = k % S.count
        x += S.px[i]
        y += S.py[i]
        z += S.pz[i]
        n++
      }
      x /= n
      y /= n
      z /= n
      let r = 0
      for (let k = a; k < b; k++) {
        const i = k % S.count
        r = Math.max(r, Math.hypot(S.px[i] - x, S.py[i] - y, S.pz[i] - z) + S.halfWidth[i])
      }
      this.chunkX[c] = x
      this.chunkY[c] = y
      this.chunkZ[c] = z
      this.chunkR[c] = r + 1
    }
  }

  /** The ground height at x, z (clamped to the world, like the 3D camera's ground). */
  ground(x: number, z: number): number {
    const t = this.track
    const half = t.world.half
    const h = t.terrainHeight(Math.min(half, Math.max(-half, x)), Math.min(half, Math.max(-half, z)))
    return Number.isFinite(h) ? h : 0
  }

  // ---------------------------------------------------------------- the line of sight

  /** Point the line of sight through screen spot (sx, sy) on a screen w x h pixels. False if it can't be made. */
  aim(camera: THREE.Camera, sx: number, sy: number, w: number, h: number): boolean {
    if (!(w > 0 && h > 0) || !Number.isFinite(sx) || !Number.isFinite(sy)) return false
    _o.setFromMatrixPosition(camera.matrixWorld)
    _d.set((sx / w) * 2 - 1, -(sy / h) * 2 + 1, 0.5).unproject(camera).sub(_o)
    const len = _d.length()
    if (!(len > 1e-9)) return false
    _d.divideScalar(len)
    return Number.isFinite(_d.x + _d.y + _d.z + _o.x + _o.y + _o.z)
  }

  /** Where the line of sight (set by aim) first meets the ground, as a distance along it, or Infinity. */
  groundT(maxT = MAX_T): number {
    let t = 0
    let prev = 0
    for (let k = 0; k < 600 && t <= maxT; k++) {
      const x = _o.x + _d.x * t
      const y = _o.y + _d.y * t
      const z = _o.z + _d.z * t
      const gap = y - this.ground(x, z)
      if (gap <= 0) {
        if (k === 0) return 0
        // Halve the step until the crossing is found to a few centimetres.
        let lo = prev
        let hi = t
        for (let b = 0; b < 14; b++) {
          const m = (lo + hi) / 2
          if (_o.y + _d.y * m - this.ground(_o.x + _d.x * m, _o.z + _d.z * m) <= 0) hi = m
          else lo = m
        }
        return hi
      }
      prev = t
      // A step no longer than 40% of the height above the ground can't jump through a slope up to about 1 in 1.
      t += Math.min(60, Math.max(0.25, gap * 0.4, t * 0.001))
    }
    return Infinity
  }

  /** The ground under screen spot (sx, sy), or null when the line of sight meets none (the sky). */
  groundAt(camera: THREE.Camera, sx: number, sy: number, w: number, h: number): Spot3 | null {
    if (!this.aim(camera, sx, sy, w, h)) return null
    const t = this.groundT()
    if (!Number.isFinite(t)) return null
    _ground.x = _o.x + _d.x * t
    _ground.y = _o.y + _d.y * t
    _ground.z = _o.z + _d.z * t
    return _ground
  }

  /** The first road surface the line of sight hits (distance along it), filling _hit; Infinity if none. */
  private roadT(): number {
    const S = this.track.samples
    const n = S.count
    let best = Infinity
    for (let c = 0; c < this.chunkX.length; c++) {
      // Could the line come within the chunk's sphere at all?
      const vx = this.chunkX[c] - _o.x
      const vy = this.chunkY[c] - _o.y
      const vz = this.chunkZ[c] - _o.z
      const tc = vx * _d.x + vy * _d.y + vz * _d.z
      const r = this.chunkR[c]
      if (tc < -r || tc - r > best) continue
      const d2 = vx * vx + vy * vy + vz * vz - tc * tc
      if (d2 > r * r) continue
      const a = c * CHUNK
      const b = Math.min(n, a + CHUNK)
      for (let i = a; i < b; i++) {
        const j = i + 1 >= n ? 0 : i + 1
        const hi = S.halfWidth[i]
        const hj = S.halfWidth[j]
        // The segment's four corners: left and right edge at sample i and at sample j.
        const lix = S.px[i] - S.rx[i] * hi
        const liy = S.py[i] - S.ry[i] * hi
        const liz = S.pz[i] - S.rz[i] * hi
        const rix = S.px[i] + S.rx[i] * hi
        const riy = S.py[i] + S.ry[i] * hi
        const riz = S.pz[i] + S.rz[i] * hi
        const ljx = S.px[j] - S.rx[j] * hj
        const ljy = S.py[j] - S.ry[j] * hj
        const ljz = S.pz[j] - S.rz[j] * hj
        const rjx = S.px[j] + S.rx[j] * hj
        const rjy = S.py[j] + S.ry[j] * hj
        const rjz = S.pz[j] + S.rz[j] * hj
        let t = tri(lix, liy, liz, rix, riy, riz, rjx, rjy, rjz)
        if (!(t < best)) t = tri(lix, liy, liz, rjx, rjy, rjz, ljx, ljy, ljz)
        if (t < best) {
          best = t
          _hit.i = i
        }
      }
    }
    if (best < Infinity) this.fillHit(_hit.i, _o.x + _d.x * best, _o.y + _d.y * best, _o.z + _d.z * best, true, 0)
    return best
  }

  /** Fill _hit for a spot (x, y, z) on segment i's road. */
  private fillHit(i: number, x: number, y: number, z: number, direct: boolean, px: number): void {
    const S = this.track.samples
    const j = i + 1 >= S.count ? 0 : i + 1
    const ex = S.px[j] - S.px[i]
    const ey = S.py[j] - S.py[i]
    const ez = S.pz[j] - S.pz[i]
    const l2 = ex * ex + ey * ey + ez * ez
    const f = l2 > 0 ? Math.min(1, Math.max(0, ((x - S.px[i]) * ex + (y - S.py[i]) * ey + (z - S.pz[i]) * ez) / l2)) : 0
    const tl = Math.hypot(S.tx[i], S.tz[i]) || 1
    _hit.i = i
    _hit.f = f
    _hit.x = x
    _hit.y = y
    _hit.z = z
    _hit.lateral = (x - S.px[i] - ex * f) * S.rx[i] + (y - S.py[i] - ey * f) * S.ry[i] + (z - S.pz[i] - ez * f) * S.rz[i]
    _hit.dirX = S.tx[i] / tl
    _hit.dirZ = S.tz[i] / tl
    _hit.direct = direct
    _hit.px = px
  }

  /** True when nothing on the ground hides world spot (x, y, z) from the camera (set by aim). */
  private seen(x: number, y: number, z: number): boolean {
    const dx = x - _o.x
    const dy = y - _o.y
    const dz = z - _o.z
    const len = Math.hypot(dx, dy, dz)
    if (!(len > 0)) return true
    const sx = _d.x
    const sy = _d.y
    const sz = _d.z
    _d.set(dx / len, dy / len, dz / len)
    const g = this.groundT(len)
    _d.set(sx, sy, sz)
    return !(g < len - HIDDEN_BY_GROUND)
  }

  /**
   * The road under screen spot (sx, sy), as you see it: the first road surface the line of sight
   * hits, unless the ground hides it; else the nearest road whose edge is within `reachPx` pixels
   * (and at least `reachMetres`) of the mouse, and not behind a hill. Null when there is none.
   * The result is shared scratch: copy what you keep before the next call.
   */
  pick(camera: THREE.Camera, sx: number, sy: number, w: number, h: number, reachPx = PICK_REACH.px, reachMetres = PICK_REACH.metres): RoadPick | null {
    if (!this.aim(camera, sx, sy, w, h)) return null
    const tg = this.groundT()
    const tr = this.roadT()
    if (tr < Infinity && tr <= tg + HIDDEN_BY_GROUND) return _hit
    return this.near(camera, sx, sy, w, h, reachPx, reachMetres)
  }

  /** Just beside the mouse: the nearest road edge within reach on screen, that the ground doesn't hide. */
  private near(camera: THREE.Camera, sx: number, sy: number, w: number, h: number, reachPx: number, reachMetres: number): RoadPick | null {
    const S = this.track.samples
    const n = S.count
    const cam = camera as THREE.PerspectiveCamera
    const fovTan = Math.tan(((cam.fov ?? 50) * Math.PI) / 360)
    /** Metres one pixel covers at distance t along the line of sight. */
    const mpp = (t: number) => (2 * Math.max(1e-3, t) * fovTan) / (cam.zoom ?? 1) / h
    let kept = 0
    for (let c = 0; c < this.chunkX.length; c++) {
      const vx = this.chunkX[c] - _o.x
      const vy = this.chunkY[c] - _o.y
      const vz = this.chunkZ[c] - _o.z
      const tc = vx * _d.x + vy * _d.y + vz * _d.z
      const r = this.chunkR[c] + Math.max(reachMetres, reachPx * mpp(tc + this.chunkR[c])) * 1.5
      if (tc < -r) continue
      if (vx * vx + vy * vy + vz * vz - tc * tc > r * r) continue
      const a = c * CHUNK
      const b = Math.min(n, a + CHUNK)
      for (let i = a; i < b; i++) {
        const j = i + 1 >= n ? 0 : i + 1
        if (!project(camera, S.px[i], S.py[i], S.pz[i], w, h, _scr)) continue
        const ax = _scr.sx
        const ay = _scr.sy
        const depth = _scr.depth
        if (!project(camera, S.px[j], S.py[j], S.pz[j], w, h, _scr)) continue
        const bx = _scr.sx
        const by = _scr.sy
        // How wide the road looks here: its right edge on screen, measured straight across the road's middle line.
        const hw = S.halfWidth[i]
        if (!project(camera, S.px[i] + S.rx[i] * hw, S.py[i] + S.ry[i] * hw, S.pz[i] + S.rz[i] * hw, w, h, _scr)) continue
        const ex = bx - ax
        const ey = by - ay
        const l2 = ex * ex + ey * ey
        const el = Math.sqrt(l2)
        const halfPx = el > 1e-6 ? Math.abs((_scr.sx - ax) * ey - (_scr.sy - ay) * ex) / el : Math.hypot(_scr.sx - ax, _scr.sy - ay)
        const f = l2 > 0 ? Math.min(1, Math.max(0, ((sx - ax) * ex + (sy - ay) * ey) / l2)) : 0
        const edgePx = Math.max(0, Math.hypot(sx - ax - ex * f, sy - ay - ey * f) - halfPx)
        const reach = Math.max(reachPx, reachMetres / mpp(depth))
        if (edgePx > reach) continue
        // Keep the best few, nearest the mouse first (then nearest the camera).
        const last = NEAR_KEEP - 1
        if (kept === NEAR_KEEP && (edgePx > nearPx[last] || (edgePx === nearPx[last] && depth >= nearT[last]))) continue
        let k = kept < NEAR_KEEP ? kept++ : last
        while (k > 0 && (nearPx[k - 1] > edgePx || (nearPx[k - 1] === edgePx && nearT[k - 1] > depth))) {
          nearI[k] = nearI[k - 1]
          nearF[k] = nearF[k - 1]
          nearPx[k] = nearPx[k - 1]
          nearT[k] = nearT[k - 1]
          k--
        }
        nearI[k] = i
        nearF[k] = f
        nearPx[k] = edgePx
        nearT[k] = depth
      }
    }
    for (let k = 0; k < kept; k++) {
      const i = nearI[k]
      const j = i + 1 >= n ? 0 : i + 1
      const f = nearF[k]
      const x = S.px[i] + (S.px[j] - S.px[i]) * f
      const y = S.py[i] + (S.py[j] - S.py[i]) * f
      const z = S.pz[i] + (S.pz[j] - S.pz[i]) * f
      if (!this.seen(x, y, z)) continue
      // The road's spot nearest the mouse: its middle here, moved out to the edge on the mouse's side.
      const side = this.sideOfMouse(camera, i, x, y, z, sx, sy, w, h)
      const hw = S.halfWidth[i]
      this.fillHit(i, x + S.rx[i] * hw * side, y + S.ry[i] * hw * side, z + S.rz[i] * hw * side, false, nearPx[k])
      return _hit
    }
    return null
  }

  /** +1 when the mouse is on the road's right of spot (x, y, z) on segment i, as seen on screen, else -1. */
  private sideOfMouse(camera: THREE.Camera, i: number, x: number, y: number, z: number, sx: number, sy: number, w: number, h: number): number {
    const S = this.track.samples
    if (!project(camera, x, y, z, w, h, _scr)) return 1
    const cx = _scr.sx
    const cy = _scr.sy
    if (!project(camera, x + S.rx[i], y + S.ry[i], z + S.rz[i], w, h, _scr)) return 1
    return (sx - cx) * (_scr.sx - cx) + (sy - cy) * (_scr.sy - cy) >= 0 ? 1 : -1
  }

  // ---------------------------------------------------------------- heights for drawing

  /**
   * How high the road's surface is at x, z, on the road heading (dirX, dirZ) (any way it
   * heads is fine when both are 0: then the highest road there wins, the bridge over a
   * crossing). Spots up to `beyond` metres past the road's edge get the edge's height, so
   * marks just off the road stay with it. Off every road: the ground. Loops are left out
   * (the map draws them flat, by their mouth).
   */
  surfaceY(x: number, z: number, dirX = 0, dirZ = 0, beyond = 1): number {
    const wantDir = dirX !== 0 || dirZ !== 0
    // The key: x and z in 10 cm steps (the world is within +-2000 m), the heading in 32 ways (0 = none), the reach.
    const qx = Math.round(x * 10) + 20000
    const qz = Math.round(z * 10) + 20000
    const sector = wantDir ? 1 + (Math.round(((Math.atan2(dirZ, dirX) / (Math.PI * 2)) * 32 + 32)) % 32) : 0
    const key = (((qx * 40001 + qz) * 33 + sector) * 2 + (beyond > 1 ? 1 : 0))
    const known = this.heights.get(key)
    if (known !== undefined) return known
    const y = this.findSurfaceY(x, z, dirX, dirZ, beyond)
    // A cap, so a long session can't grow it for ever (it fills again as needed).
    if (this.heights.size > 250000) this.heights.clear()
    this.heights.set(key, y)
    return y
  }

  private findSurfaceY(x: number, z: number, dirX: number, dirZ: number, beyond: number): number {
    const S = this.track.samples
    const n = S.count
    const wantDir = dirX !== 0 || dirZ !== 0
    // Along a line the next spot is almost always next to the last one: look there first.
    if (this.lastIdx >= 0 && wantDir) {
      let best = -1
      let bestScore = Infinity
      for (let k = -24; k <= 24; k++) {
        const i = (this.lastIdx + k + n) % n
        const sc = this.score(i, x, z, dirX, dirZ, beyond)
        if (sc < bestScore) {
          bestScore = sc
          best = i
        }
      }
      if (best >= 0 && bestScore <= S.ds * 0.75) return this.heightOn(best, x, z, beyond)
    }
    const hash = this.hash
    const reach = this.maxHalf + beyond + 2
    const gx0 = Math.floor((x - reach - hash.minX) / hash.cell)
    const gx1 = Math.floor((x + reach - hash.minX) / hash.cell)
    const gz0 = Math.floor((z - reach - hash.minZ) / hash.cell)
    const gz1 = Math.floor((z + reach - hash.minZ) / hash.cell)
    let best = -1
    let bestScore = Infinity
    for (let gz = Math.max(0, gz0); gz <= Math.min(hash.nz - 1, gz1); gz++) {
      for (let gx = Math.max(0, gx0); gx <= Math.min(hash.nx - 1, gx1); gx++) {
        const c = gz * hash.nx + gx
        for (let k = hash.start[c], e = hash.start[c + 1]; k < e; k++) {
          const i = hash.items[k]
          let sc = this.score(i, x, z, dirX, dirZ, beyond)
          if (sc === Infinity) continue
          // No heading given: the top road wins (a metre higher beats any slice distance).
          if (!wantDir) sc -= S.py[i] * 10
          if (sc < bestScore) {
            bestScore = sc
            best = i
          }
        }
      }
    }
    if (best < 0) {
      this.lastIdx = -1
      return this.ground(x, z)
    }
    this.lastIdx = best
    return this.heightOn(best, x, z, beyond)
  }

  /**
   * How well sample i matches spot x, z: how far along the road the spot is from the sample
   * (small = this sample's slice), or Infinity when the spot is off its road or it heads the
   * wrong way. Heading the other way counts as the same road (a line can be drawn either way).
   */
  private score(i: number, x: number, z: number, dirX: number, dirZ: number, beyond: number): number {
    const S = this.track.samples
    if (S.surface[i] === SURFACE_CODE.loop) return Infinity
    const tl = Math.hypot(S.tx[i], S.tz[i])
    if (tl < 0.3) return Infinity
    const tx = S.tx[i] / tl
    const tz = S.tz[i] / tl
    const dx = x - S.px[i]
    const dz = z - S.pz[i]
    const along = Math.abs(dx * tx + dz * tz)
    if (along > S.ds * 1.5) return Infinity
    const lateral = Math.abs(dx * -tz + dz * tx)
    if (lateral > S.halfWidth[i] + beyond) return Infinity
    if (dirX !== 0 || dirZ !== 0) {
      const dl = Math.hypot(dirX, dirZ)
      if (Math.abs((tx * dirX + tz * dirZ) / dl) < 0.8) return Infinity
    }
    return along
  }

  /** The road's surface height at x, z on sample i's slice (banked: higher on the high side). */
  private heightOn(i: number, x: number, z: number, beyond: number): number {
    const S = this.track.samples
    const rh = Math.hypot(S.rx[i], S.rz[i]) || 1
    const across = ((x - S.px[i]) * S.rx[i] + (z - S.pz[i]) * S.rz[i]) / rh
    const lim = S.halfWidth[i] + Math.min(beyond, 1)
    const w = Math.max(-lim, Math.min(lim, across)) / rh
    return S.py[i] + S.ry[i] * w
  }
}

/**
 * World spot (x, y, z) to a screen spot on a screen w x h pixels, written into `out`
 * (`depth`: metres in front of the camera). False when it is behind the camera.
 */
export function project(camera: THREE.Camera, x: number, y: number, z: number, w: number, h: number, out: { sx: number; sy: number; depth: number }): boolean {
  _v.set(x, y, z).applyMatrix4(camera.matrixWorldInverse)
  const depth = -_v.z
  if (!(depth > 0.05)) return false
  _v.applyMatrix4(camera.projectionMatrix)
  out.sx = (_v.x * 0.5 + 0.5) * w
  out.sy = (-_v.y * 0.5 + 0.5) * h
  out.depth = depth
  return Number.isFinite(out.sx) && Number.isFinite(out.sy)
}

/** Where the line of sight set by the last aim() starts and which way it goes (for the drag plane). */
export function lastRay(): { ox: number; oy: number; oz: number; dx: number; dy: number; dz: number } {
  return { ox: _o.x, oy: _o.y, oz: _o.z, dx: _d.x, dy: _d.y, dz: _d.z }
}

/** How far past a triangle's edge (as a share of the triangle) still counts as on it. */
const EDGE_SLACK = 1e-4

/** Distance along the line of sight (from _o along _d) to triangle a b c, either face, or Infinity (Moller-Trumbore). */
function tri(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): number {
  const e1x = bx - ax
  const e1y = by - ay
  const e1z = bz - az
  const e2x = cx - ax
  const e2y = cy - ay
  const e2z = cz - az
  const px = _d.y * e2z - _d.z * e2y
  const py = _d.z * e2x - _d.x * e2z
  const pz = _d.x * e2y - _d.y * e2x
  const det = e1x * px + e1y * py + e1z * pz
  if (det > -1e-12 && det < 1e-12) return Infinity
  const inv = 1 / det
  const sx = _o.x - ax
  const sy = _o.y - ay
  const sz = _o.z - az
  // A hair of slack on the edges: a line of sight through the seam between two road segments
  // must hit one of them, not slip between them on a rounding error.
  const u = (sx * px + sy * py + sz * pz) * inv
  if (u < -EDGE_SLACK || u > 1 + EDGE_SLACK) return Infinity
  const qx = sy * e1z - sz * e1y
  const qy = sz * e1x - sx * e1z
  const qz = sx * e1y - sy * e1x
  const v = (_d.x * qx + _d.y * qy + _d.z * qz) * inv
  if (v < -EDGE_SLACK || u + v > 1 + EDGE_SLACK) return Infinity
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv
  return t > 0 ? t : Infinity
}
