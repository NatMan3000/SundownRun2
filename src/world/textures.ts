// ============================================================
//  WORLD TEXTURES - made in code, never downloaded
// ------------------------------------------------------------
//  The constitution says every texture is procedural (made by a
//  program) and at most 1024 px. These are the world's.
//
//  makeNoiseTexture: a seamless (tiling) cloudy noise, a different
//  pattern in each of the four colour channels so one texture
//  lookup gives the terrain shader four kinds of variation:
//    R  big soft blotches      (sampled very large: 0.5 km)
//    G  medium mottling        (sampled ~100 m)
//    B  fine grain             (sampled ~10 m)
//    A  "plates": flat cells with soft seams, like tiles of glass
// ============================================================

import * as THREE from 'three'

/** A tiny seeded random generator (mulberry32): same seed, same world. */
export function makeRandom(seed: number): () => number {
  let a = seed >>> 0 || 0x9e3779b9
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Tiling value noise on a `period` x `period` lattice, sampled at (x, y) in lattice units. */
function tilingValueNoise(lattice: Float32Array, period: number, x: number, y: number): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0
  const sx = fx * fx * (3 - 2 * fx)
  const sy = fy * fy * (3 - 2 * fy)
  const ix0 = ((x0 % period) + period) % period
  const iy0 = ((y0 % period) + period) % period
  const ix1 = (ix0 + 1) % period
  const iy1 = (iy0 + 1) % period
  const a = lattice[iy0 * period + ix0]
  const b = lattice[iy0 * period + ix1]
  const c = lattice[iy1 * period + ix0]
  const d = lattice[iy1 * period + ix1]
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy
}

function fbm(lattices: Float32Array[], basePeriod: number, u: number, v: number, octaves: number): number {
  let sum = 0
  let amp = 0.5
  let norm = 0
  for (let o = 0; o < octaves; o++) {
    const p = basePeriod << o
    sum += amp * tilingValueNoise(lattices[o], p, u * p, v * p)
    norm += amp
    amp *= 0.5
  }
  return sum / norm
}

/** Four-channel tiling noise, size x size (default 256). */
export function makeNoiseTexture(seed: number, size = 256): THREE.DataTexture {
  const rand = makeRandom(seed)
  const makeLattices = (base: number, octaves: number) => {
    const out: Float32Array[] = []
    for (let o = 0; o < octaves; o++) {
      const p = base << o
      const l = new Float32Array(p * p)
      for (let i = 0; i < l.length; i++) l[i] = rand()
      out.push(l)
    }
    return out
  }
  const big = makeLattices(3, 4)
  const mid = makeLattices(6, 4)
  const fine = makeLattices(24, 3)

  // Plates: jittered cell centres on a tiling 8 x 8 lattice (Worley distance).
  const P = 8
  const cx = new Float32Array(P * P)
  const cy = new Float32Array(P * P)
  const ctone = new Float32Array(P * P)
  for (let i = 0; i < P * P; i++) {
    cx[i] = 0.15 + rand() * 0.7
    cy[i] = 0.15 + rand() * 0.7
    ctone[i] = rand()
  }

  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    const v = y / size
    for (let x = 0; x < size; x++) {
      const u = x / size
      const r = fbm(big, 3, u, v, 4)
      const g = fbm(mid, 6, u, v, 4)
      const b = fbm(fine, 24, u, v, 3)

      // Worley: nearest and second-nearest cell centre -> flat plates with seams.
      const gx = u * P
      const gy = v * P
      const ix = Math.floor(gx)
      const iy = Math.floor(gy)
      let d1 = 9
      let d2 = 9
      let tone = 0
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const kx = ix + ox
          const ky = iy + oy
          const wx = ((kx % P) + P) % P
          const wy = ((ky % P) + P) % P
          const k = wy * P + wx
          const px = kx + cx[k]
          const py = ky + cy[k]
          const d = Math.hypot(px - gx, py - gy)
          if (d < d1) {
            d2 = d1
            d1 = d
            tone = ctone[k]
          } else if (d < d2) {
            d2 = d
          }
        }
      }
      const seam = Math.min(1, (d2 - d1) / 0.08)
      const plate = tone * 0.8 * seam + 0.1

      const i = (y * size + x) * 4
      data[i] = Math.round(Math.min(1, Math.max(0, r)) * 255)
      data[i + 1] = Math.round(Math.min(1, Math.max(0, g)) * 255)
      data[i + 2] = Math.round(Math.min(1, Math.max(0, b)) * 255)
      data[i + 3] = Math.round(Math.min(1, Math.max(0, plate)) * 255)
    }
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.anisotropy = 4
  tex.colorSpace = THREE.NoColorSpace
  tex.needsUpdate = true
  return tex
}
