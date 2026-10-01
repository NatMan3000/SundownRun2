// ============================================================
//  NOISE + RANDOM - seeded, dependency-free
// ------------------------------------------------------------
//  The track builder needs "random" things that come out the same
//  every time for the same track file: rolling hills, ridge
//  buttresses, billboard picks. Everything here is driven by a seed
//  number, so a track looks identical on every machine and every
//  multiplayer client.
//
//    mulberry32(seed)       a tiny, fast random number generator
//    makeNoise2D(seed)      smooth 2D gradient noise, about -1..1
//    fbm(noise, x, z, n)    noise layered n times (big hills + small bumps)
//    hashString(text)       a stable 32-bit hash of some text
// ============================================================

/** A small seeded random generator: returns a function giving 0..1 numbers. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** FNV-1a: turns any text into a stable 32-bit number. Same text, same number, everywhere. */
export function hashString(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export type Noise2D = (x: number, z: number) => number

/**
 * Smooth 2D gradient noise (the same idea as Perlin noise). Returns roughly
 * -1..1, changes smoothly, and repeats only every 256 units, which is far
 * bigger than any hill we ask for once the input is scaled down.
 */
export function makeNoise2D(seed: number): Noise2D {
  const rand = mulberry32(seed)
  // A shuffled table of 0..255, doubled so we never have to wrap an index.
  const perm = new Uint8Array(512)
  const p = new Uint8Array(256)
  for (let i = 0; i < 256; i++) p[i] = i
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const t = p[i]
    p[i] = p[j]
    p[j] = t
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255]
  // 8 gradient directions round the compass, picked per lattice corner.
  const GX = [1, -1, 1, -1, Math.SQRT1_2 * 2, -Math.SQRT1_2 * 2, 0, 0]
  const GZ = [0, 0, 1, 1, Math.SQRT1_2 * 2, Math.SQRT1_2 * 2, 1, -1]
  for (let i = 0; i < 8; i++) {
    const l = Math.hypot(GX[i], GZ[i])
    GX[i] /= l
    GZ[i] /= l
  }

  return (x: number, z: number): number => {
    const xf = Math.floor(x)
    const zf = Math.floor(z)
    const fx = x - xf
    const fz = z - zf
    const xi = xf & 255
    const zi = zf & 255
    // Quintic fade: smooth slope AND smooth curvature at cell edges (no grid creases).
    const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10)
    const v = fz * fz * fz * (fz * (fz * 6 - 15) + 10)
    const g00 = perm[perm[xi] + zi] & 7
    const g10 = perm[perm[xi + 1] + zi] & 7
    const g01 = perm[perm[xi] + zi + 1] & 7
    const g11 = perm[perm[xi + 1] + zi + 1] & 7
    const n00 = GX[g00] * fx + GZ[g00] * fz
    const n10 = GX[g10] * (fx - 1) + GZ[g10] * fz
    const n01 = GX[g01] * fx + GZ[g01] * (fz - 1)
    const n11 = GX[g11] * (fx - 1) + GZ[g11] * (fz - 1)
    const a = n00 + (n10 - n00) * u
    const b = n01 + (n11 - n01) * u
    // Raw gradient noise peaks near +/-0.7; scale it to about +/-1.
    return (a + (b - a) * v) * 1.41
  }
}

/**
 * Fractal noise: `octaves` layers of noise, each twice as detailed and half as
 * strong as the last. Big rolling shapes with smaller bumps on top. About -1..1.
 */
export function fbm(noise: Noise2D, x: number, z: number, octaves: number): number {
  let sum = 0
  let amp = 1
  let freq = 1
  let norm = 0
  for (let o = 0; o < octaves; o++) {
    sum += noise(x * freq + o * 17.31, z * freq - o * 9.73) * amp
    norm += amp
    amp *= 0.5
    freq *= 2.03
  }
  return sum / norm
}

/** 0 below edge0, 1 above edge1, a smooth S-curve between. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = edge1 === edge0 ? (x < edge0 ? 0 : 1) : (x - edge0) / (edge1 - edge0)
  if (t <= 0) return 0
  if (t >= 1) return 1
  return t * t * (3 - 2 * t)
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}
