// ============================================================
//  BODY BUILDER - turns a profile (profiles.ts) into geometry
// ------------------------------------------------------------
//  Each body becomes four geometries, built once per body and
//  cached for the session (cycling the garage is instant):
//
//    paint   the faceted hull + painted wings and fins
//    glass   the canopy
//    trim    dark splitters, diffusers and skirts
//    lights  every glowing part in ONE mesh: livery strips,
//            headlights and tail lights. A per-vertex `aLight`
//            (0 livery, 1 head, 2 tail) picks the colour in the
//            shader (carModel.ts), so the whole set is one draw call.
//
//  The wheel is shared by every car: tyre, aero disc and a glowing
//  rim ring merged into one geometry with an `aGlow` attribute.
//
//  FACETED ON PURPOSE: every triangle gets its own flat normal
//  (non-indexed geometry), so each panel catches its own highlight.
//  Winding is fixed per triangle by checking its normal points away
//  from the car's centre line, so a typo in a profile can never turn
//  a panel inside out.
// ============================================================

import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { PALETTE } from '../../core/palette'
import type { BodyId } from './catalog'
import { PROFILES } from './profiles'
import type { BodyProfile, BoxPart } from './profiles'

export interface BodyGeometry {
  paint: THREE.BufferGeometry
  glass: THREE.BufferGeometry
  trim: THREE.BufferGeometry
  lights: THREE.BufferGeometry
  /** Light anchor points in car space, for fx. */
  tailLights: THREE.Vector3[]
  headLights: THREE.Vector3[]
  /** Underside half extents and height, for the underglow. */
  underglow: { halfWidth: number; halfLength: number; y: number }
}

// ---------------------------------------------------------------- triangle soup

/** A growable list of triangles, each fixed to face outward. */
class Soup {
  pos: number[] = []
  extra: number[] = []

  /**
   * Add triangle a, b, c. `out` is a point the triangle must face away from
   * (the car's centre line at that height), so winding typos can't flip it.
   */
  tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, ox: number, oy: number, oz: number, extra = 0): void {
    _e1.subVectors(b, a)
    _e2.subVectors(c, a)
    _n.crossVectors(_e1, _e2)
    const cx = (a.x + b.x + c.x) / 3 - ox
    const cy = (a.y + b.y + c.y) / 3 - oy
    const cz = (a.z + b.z + c.z) / 3 - oz
    if (_n.lengthSq() < 1e-12) return // degenerate (collapsed cap point)
    const flip = _n.x * cx + _n.y * cy + _n.z * cz < 0
    const p = flip ? [a, c, b] : [a, b, c]
    for (const v of p) this.pos.push(v.x, v.y, v.z)
    this.extra.push(extra, extra, extra)
  }

  quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, ox: number, oy: number, oz: number, extra = 0): void {
    this.tri(a, b, c, ox, oy, oz, extra)
    this.tri(a, c, d, ox, oy, oz, extra)
  }

  geometry(extraName?: string): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    if (extraName) g.setAttribute(extraName, new THREE.Float32BufferAttribute(this.extra, 1))
    g.computeVertexNormals() // non-indexed: one flat normal per triangle
    g.computeBoundingSphere()
    return g
  }
}

const _e1 = new THREE.Vector3()
const _e2 = new THREE.Vector3()
const _n = new THREE.Vector3()

// ---------------------------------------------------------------- lofting

/** Half cross-section of a hull station, bottom centre -> top centre. */
function hullHalf(st: number[]): [number, number][] {
  const [, yBot, wBot, yMid, wMid, ySh, wSh, yTop, wTop, yCrown] = st
  return [
    [0, yBot],
    [wBot, yBot],
    [wMid, yMid],
    [wSh, ySh],
    [wTop, yTop],
    [0, yCrown],
  ]
}

/** Half cross-section of a canopy station (a faceted bubble). */
function canopyHalf(st: number[]): [number, number][] {
  const [, yBase, wBase, yTop, wTop] = st
  const midX = wBase + (wTop - wBase) * 0.4 + 0.02
  const midY = yBase + (yTop - yBase) * 0.62
  return [
    [0, yBase - 0.12],
    [wBase, yBase],
    [midX, midY],
    [wTop, yTop - 0.03],
    [0, yTop],
  ]
}

/** A full ring (both sides) of points at station z. */
function ring(half: [number, number][], z: number): THREE.Vector3[] {
  const out: THREE.Vector3[] = []
  for (let i = 0; i < half.length; i++) out.push(new THREE.Vector3(half[i][0], half[i][1], z))
  for (let i = half.length - 2; i >= 1; i--) out.push(new THREE.Vector3(-half[i][0], half[i][1], z))
  return out
}

/** Join stations into a closed, capped, faceted solid. */
function loft(soup: Soup, stations: number[][], halfOf: (st: number[]) => [number, number][]): void {
  const rings = stations.map((st) => ring(halfOf(st), st[0]))
  const centres = stations.map((st) => {
    const h = halfOf(st)
    return (h[0][1] + h[h.length - 1][1]) / 2
  })
  for (let r = 0; r < rings.length - 1; r++) {
    const A = rings[r]
    const B = rings[r + 1]
    const n = A.length
    const oy = (centres[r] + centres[r + 1]) / 2
    const oz = (A[0].z + B[0].z) / 2
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      soup.quad(A[i], A[j], B[j], B[i], 0, oy, oz)
    }
  }
  // Caps: a fan from each end ring's centre, facing out along z.
  const capEnd = (R: THREE.Vector3[], cy: number, dir: number) => {
    const c = new THREE.Vector3(0, cy, R[0].z)
    for (let i = 0; i < R.length; i++) soup.tri(c, R[i], R[(i + 1) % R.length], 0, cy, R[0].z - dir)
  }
  capEnd(rings[0], centres[0], 1)
  capEnd(rings[rings.length - 1], centres[centres.length - 1], -1)
}

// ---------------------------------------------------------------- boxes

const BOX_CORNERS = [
  [-1, -1, -1],
  [1, -1, -1],
  [1, 1, -1],
  [-1, 1, -1],
  [-1, -1, 1],
  [1, -1, 1],
  [1, 1, 1],
  [-1, 1, 1],
]
const BOX_FACES = [
  [0, 1, 2, 3],
  [4, 5, 6, 7],
  [0, 1, 5, 4],
  [3, 2, 6, 7],
  [0, 3, 7, 4],
  [1, 2, 6, 5],
]

function boxInto(soup: Soup, b: BoxPart, xSign: number, extra = 0): void {
  const e = new THREE.Euler(b.rx ?? 0, 0, 0)
  const c = new THREE.Vector3(b.x * xSign, b.y, b.z)
  const pts = BOX_CORNERS.map(([x, y, z]) => new THREE.Vector3((x * b.w) / 2, (y * b.h) / 2, (z * b.d) / 2).applyEuler(e).add(c))
  for (const f of BOX_FACES) soup.quad(pts[f[0]], pts[f[1]], pts[f[2]], pts[f[3]], c.x, c.y, c.z, extra)
}

function boxes(soup: Soup, parts: BoxPart[], extra = 0): void {
  for (const b of parts) {
    boxInto(soup, b, 1, extra)
    if (b.mirror) boxInto(soup, b, -1, extra)
  }
}

// ---------------------------------------------------------------- lights

const LIGHT_LIVERY = 0
const LIGHT_HEAD = 1
const LIGHT_TAIL = 2
const STRIP_OUT = 0.012 // strips stand proud of the paint so they never z-fight it

/** Interpolate a hull point (index `pi`) at any z between stations. */
function hullPointAt(p: BodyProfile, pi: number, z: number, out: THREE.Vector2): THREE.Vector2 {
  const h = p.hull
  for (let i = 0; i < h.length - 1; i++) {
    const a = h[i]
    const b = h[i + 1]
    if ((z <= a[0] && z >= b[0]) || i === h.length - 2) {
      const t = a[0] === b[0] ? 0 : THREE.MathUtils.clamp((a[0] - z) / (a[0] - b[0]), 0, 1)
      const pa = hullHalf(a)[pi]
      const pb = hullHalf(b)[pi]
      return out.set(pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t)
    }
  }
  return out.set(0, 0)
}

function liveryInto(soup: Soup, p: BodyProfile): void {
  const v = new THREE.Vector2()
  for (const strip of p.livery) {
    const steps = 24
    for (const side of [1, -1]) {
      let prevLo: THREE.Vector3 | null = null
      let prevHi: THREE.Vector3 | null = null
      for (let k = 0; k <= steps; k++) {
        const z = strip.zFrom + ((strip.zTo - strip.zFrom) * k) / steps
        hullPointAt(p, strip.point, z, v)
        const x = (v.x + STRIP_OUT) * side
        const lo = new THREE.Vector3(x, v.y - strip.width / 2, z)
        const hi = new THREE.Vector3(x, v.y + strip.width / 2, z)
        if (prevLo && prevHi) soup.quad(prevLo, lo, hi, prevHi, 0, v.y, z, LIGHT_LIVERY)
        prevLo = lo
        prevHi = hi
      }
    }
  }
}

function lightBarInto(soup: Soup, bar: { z: number; y: number; halfW: number; h: number }, kind: number, facing: number): void {
  boxInto(soup, { w: bar.halfW * 2, h: bar.h, d: 0.04, x: 0, y: bar.y, z: bar.z + facing * 0.005 }, 1, kind)
}

// ---------------------------------------------------------------- the body

function buildBody(id: BodyId): BodyGeometry {
  const p = PROFILES[id]

  const paint = new Soup()
  loft(paint, p.hull, hullHalf)
  boxes(paint, p.paint)

  const glass = new Soup()
  loft(glass, p.canopy, canopyHalf)

  const trim = new Soup()
  boxes(trim, p.trim)
  // A dark belly plate between the wheels hides the hull's underside facets.
  trim.quad(
    new THREE.Vector3(0.5, p.hull[5][1] - 0.006, 0.9),
    new THREE.Vector3(-0.5, p.hull[5][1] - 0.006, 0.9),
    new THREE.Vector3(-0.5, p.hull[5][1] - 0.006, -0.9),
    new THREE.Vector3(0.5, p.hull[5][1] - 0.006, -0.9),
    0,
    0,
    0,
  )

  const lights = new Soup()
  liveryInto(lights, p)
  boxes(lights, p.glow, LIGHT_LIVERY)
  lightBarInto(lights, p.head, LIGHT_HEAD, 1)
  lightBarInto(lights, p.tail, LIGHT_TAIL, -1)

  const front = p.hull[0][0]
  const back = p.hull[p.hull.length - 1][0]
  return {
    paint: paint.geometry(),
    glass: glass.geometry(),
    trim: trim.geometry(),
    lights: lights.geometry('aLight'),
    tailLights: [
      new THREE.Vector3(p.tail.halfW * 0.85, p.tail.y, p.tail.z - 0.03),
      new THREE.Vector3(-p.tail.halfW * 0.85, p.tail.y, p.tail.z - 0.03),
    ],
    headLights: [
      new THREE.Vector3(p.head.halfW * 0.7, p.head.y, p.head.z + 0.03),
      new THREE.Vector3(-p.head.halfW * 0.7, p.head.y, p.head.z + 0.03),
    ],
    underglow: { halfWidth: 0.72, halfLength: (front - back) * 0.42, y: -0.42 },
  }
}

const cache = new Map<BodyId, BodyGeometry>()

/** Geometry for a body, built on first use and kept for the session (never disposed). */
export function bodyGeometry(id: BodyId): BodyGeometry {
  let g = cache.get(id)
  if (!g) {
    g = buildBody(id)
    cache.set(id, g)
  }
  return g
}

// ---------------------------------------------------------------- the wheel

export const WHEEL_VIS = { radius: 0.35, width: 0.28 }

let wheelGeom: THREE.BufferGeometry | null = null

/**
 * Tyre + aero disc + glowing rim ring, axle along X, outer face at +X.
 * Vertex colours from the palette; `aGlow` = 1 on the ring.
 */
export function wheelGeometry(): THREE.BufferGeometry {
  if (wheelGeom) return wheelGeom
  const r = WHEEL_VIS.radius
  const hw = WHEEL_VIS.width / 2
  const v2 = (x: number, y: number) => new THREE.Vector2(x, y)
  const tyre = new THREE.LatheGeometry(
    [v2(0.24, -hw), v2(0.3, -hw - 0.004), v2(r - 0.03, -hw + 0.03), v2(r, -hw + 0.07), v2(r, hw - 0.07), v2(r - 0.03, hw - 0.03), v2(0.3, hw + 0.004), v2(0.24, hw)],
    28,
  )
  tyre.rotateZ(Math.PI / 2)
  const disc = new THREE.CylinderGeometry(0.245, 0.245, WHEEL_VIS.width * 0.9, 28, 1, false)
  disc.rotateZ(Math.PI / 2)
  const hub = new THREE.CylinderGeometry(0.075, 0.09, 0.05, 12)
  hub.rotateZ(Math.PI / 2)
  hub.translate(hw - 0.005, 0, 0)
  const ring = new THREE.TorusGeometry(0.205, 0.016, 6, 36)
  ring.rotateY(Math.PI / 2)
  ring.translate(hw + 0.002, 0, 0)

  const parts: [THREE.BufferGeometry, string, number][] = [
    [tyre, PALETTE.ground, 0],
    [disc, PALETTE.groundSheen, 0],
    [hub, PALETTE.road, 0],
    [ring, PALETTE.laneLine, 1],
  ]
  const col = new THREE.Color()
  const prepared = parts.map(([g, colour, glow]) => {
    // mergeGeometries returns null on mixed indexed/non-indexed input: flatten them all.
    const flat = g.index ? g.toNonIndexed() : g
    flat.deleteAttribute('uv')
    const n = flat.getAttribute('position').count
    col.set(colour)
    const c = new Float32Array(n * 3)
    const a = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      c[i * 3] = col.r
      c[i * 3 + 1] = col.g
      c[i * 3 + 2] = col.b
      a[i] = glow
    }
    flat.setAttribute('color', new THREE.BufferAttribute(c, 3))
    flat.setAttribute('aGlow', new THREE.BufferAttribute(a, 1))
    return flat
  })
  const merged = mergeGeometries(prepared, false)
  if (!merged) throw new Error('[vehicle] wheel geometry merge failed (mixed attributes)')
  merged.computeBoundingSphere()
  wheelGeom = merged
  return merged
}
