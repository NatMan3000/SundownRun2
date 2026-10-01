// TEMPORARY (world worker's dev scene, removed before the stage report):
// a stand-in TrackRuntime with rolling hills, an edge ridge and a road loop,
// so the sky, sun, lighting and terrain look can be built before the real
// track runtime lands. Only the fields the world reads are filled in.

import type { TrackRuntime } from '../../track/types'

function smoothstep(a: number, b: number, x: number): number {
  const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a)
  return t * t * (3 - 2 * t)
}

function hills(x: number, z: number): number {
  return (
    9 * Math.sin(x / 130 + 0.3) * Math.cos(z / 170) +
    5 * Math.sin((x + z) / 90 + 1.1) +
    3 * Math.cos((x - 2 * z) / 60) +
    18 * Math.exp(-((x - 260) ** 2 + (z + 120) ** 2) / (2 * 70 * 70))
  )
}

const urlRidge = Number(new URLSearchParams(location.search).get('ridge') ?? 149)

export function makeDevTrack(): TrackRuntime {
  const n = 400
  const half = 800
  const cellSize = (half * 2) / n
  const side = n + 1

  // ---- road centreline, resampled to ~1 m ----
  const dense: [number, number][] = []
  const N = 6000
  for (let i = 0; i < N; i++) {
    const th = (i / N) * Math.PI * 2
    const r = 430 + 90 * Math.sin(2 * th + 0.5) + 45 * Math.sin(3 * th + 1.2)
    dense.push([r * Math.sin(th), -r * Math.cos(th)])
  }
  const cum = [0]
  for (let i = 1; i <= N; i++) {
    const a = dense[i - 1]
    const b = dense[i % N]
    cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]))
  }
  const length = cum[N]
  const count = Math.floor(length)
  const ds = length / count
  const px = new Float32Array(count)
  const py = new Float32Array(count)
  const pz = new Float32Array(count)
  const halfWidth = new Float32Array(count).fill(7)
  const grounded = new Uint8Array(count).fill(1)
  let j = 0
  for (let i = 0; i < count; i++) {
    const s = i * ds
    while (cum[j + 1] < s) j++
    const f = (s - cum[j]) / (cum[j + 1] - cum[j])
    const a = dense[j]
    const b = dense[(j + 1) % N]
    px[i] = a[0] + (b[0] - a[0]) * f
    pz[i] = a[1] + (b[1] - a[1]) * f
  }
  // road height: the hills smoothed along the road
  const raw = new Float32Array(count)
  for (let i = 0; i < count; i++) raw[i] = hills(px[i], pz[i])
  const W = 40
  for (let i = 0; i < count; i++) {
    let sum = 0
    for (let k = -W; k <= W; k++) sum += raw[(i + k + count) % count]
    py[i] = sum / (2 * W + 1)
  }

  // ---- terrain: hills + edge ridge, flattened to the road ----
  const heights = new Float32Array(side * side)
  const roadD = new Float32Array(side * side).fill(Infinity)
  const roadY = new Float32Array(side * side)
  for (let i = 0; i < count; i++) {
    const r = 40
    const ix0 = Math.max(0, Math.floor((px[i] - r + half) / cellSize))
    const ix1 = Math.min(n, Math.ceil((px[i] + r + half) / cellSize))
    const iz0 = Math.max(0, Math.floor((pz[i] - r + half) / cellSize))
    const iz1 = Math.min(n, Math.ceil((pz[i] + r + half) / cellSize))
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const d = Math.hypot(-half + ix * cellSize - px[i], -half + iz * cellSize - pz[i])
        const k = iz * side + ix
        if (d < roadD[k]) {
          roadD[k] = d
          roadY[k] = py[i]
        }
      }
    }
  }
  let minH = Infinity
  let maxH = -Infinity
  for (let iz = 0; iz <= n; iz++) {
    for (let ix = 0; ix <= n; ix++) {
      const x = -half + ix * cellSize
      const z = -half + iz * cellSize
      let h = hills(x, z)
      // Same shape as the real ridge recipe in track/terrain.ts (rounded square, foot 530, crest 770, rise 149).
      const ax = Math.abs(x) / Math.max(1e-6, Math.max(Math.abs(x), Math.abs(z)))
      const az = Math.abs(z) / Math.max(1e-6, Math.max(Math.abs(x), Math.abs(z)))
      const r = Math.max(Math.abs(x), Math.abs(z)) * Math.pow(ax ** 8 + az ** 8, 0.125)
      const RIDGE = urlRidge
      const tt = Math.min(1, Math.max(0, (r - 530) / 240))
      h += RIDGE * (0.3 * smoothstep(0, 0.55, tt) + 0.7 * smoothstep(0.55, 1, tt)) + 18 * Math.sin(x / 47 + z / 61) * Math.sin(Math.PI * tt)
      const k = iz * side + ix
      const d = roadD[k]
      if (d < 40) h = h + (roadY[k] - 0.05 - h) * (1 - smoothstep(9, 38, d))
      heights[k] = h
      if (h < minH) minH = h
      if (h > maxH) maxH = h
    }
  }

  const terrainHeight = (x: number, z: number) => {
    const fx = Math.min(n - 1e-3, Math.max(0, (x + half) / cellSize))
    const fz = Math.min(n - 1e-3, Math.max(0, (z + half) / cellSize))
    const ix = Math.floor(fx)
    const iz = Math.floor(fz)
    const tx = fx - ix
    const tz = fz - iz
    const a = heights[iz * side + ix]
    const b = heights[iz * side + ix + 1]
    const c = heights[(iz + 1) * side + ix]
    const d = heights[(iz + 1) * side + ix + 1]
    return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz
  }

  const mock = {
    id: 'world-dev',
    name: 'World dev',
    hash: 'dev',
    key: 'world-dev@dev',
    params: {},
    length,
    samples: { count, ds, px, py, pz, halfWidth, grounded },
    terrain: { n, half, cellSize, heights, minHeight: minH, maxHeight: maxH },
    terrainHeight,
    world: { size: 1600, half: 800, resetY: minH - 30, catchFloorY: minH - 20, edge: 'ridge', playRadius: 780 },
    roadside: { posts: [], billboards: [] },
    file: {
      id: 'world-dev',
      environment: {
        seed: 1337,
        size: 1600,
        terrain: { kind: 'hills' },
        sky: { timeOfDay: 0.12, sunAzimuthDeg: 0, planetAzimuthDeg: 40, planetElevationDeg: 28 },
        palette: { edge: '#ff2bd6', edgeAlt: '#19e3ff', grid: '#6b4dff', haze: '#43175e' },
        city: { azimuthDeg: 0, arcDeg: 120, distance: 3520, density: 0.7 },
        roadside: { posts: false, billboards: 10 },
      },
    },
  }
  return mock as unknown as TrackRuntime
}
