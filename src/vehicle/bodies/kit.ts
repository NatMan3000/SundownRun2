// ============================================================
//  BODY KIT - the shape-making tools every car is built from
// ------------------------------------------------------------
//  A car body is a handful of chunky parts glued together, the
//  way a toy car is: a main tub, four fender pods over the wheels,
//  a glass canopy, wings, fins, rocket nozzles, lamps. This file
//  holds the tools that make those parts; bodies/designs.ts says
//  what each car is made of, and bodies/build.ts puts it together.
//
//  The tools:
//    loft       join a row of cross-sections into a closed solid
//               (tubs, fenders, canopies, wings - most of a car)
//    lathe      spin a profile round an axis (nozzles, lamps, tyres)
//    plate      cut a flat shape and give it thickness (fins, lamps)
//    rbox       a rounded box (bumpers, blocks, bars)
//    mirrorX    the same part on the car's other side
//    PartList   collects parts and merges them into ONE geometry,
//               so a whole set (all the paint, all the lights) is a
//               single draw call. Each part can carry a number per
//               vertex (which colour, which light) for the shaders.
//
//  Every solid is made to face outward by checking its volume: if
//  the triangles came out inside-out, they are flipped. A typo in
//  a design can make an ugly part, never an invisible one.
//
//  CAR SPACE (metres): +Z forward (nose), +Y up, +X the car's LEFT.
// ============================================================

import * as THREE from 'three'
import { mergeGeometries, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'

export type V2 = [number, number]

/** Wheel centre height (car space) and the wheel centres' z: shared by every car, never move. */
export const HUB_Y = -0.2
export const AXLE_Z = 1.42

// ---------------------------------------------------------------- small maths

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t
export const smooth = (t: number) => {
  const c = clamp01(t)
  return c * c * (3 - 2 * c)
}

/**
 * A smooth curve through keyframes [x, value]: value at any x, eased between
 * keys (no overshoot, so a fender never bulges past what the design says).
 */
export function curve(keys: V2[], x: number): number {
  if (x <= keys[0][0]) return keys[0][1]
  for (let i = 0; i < keys.length - 1; i++) {
    const [x0, v0] = keys[i]
    const [x1, v1] = keys[i + 1]
    if (x <= x1) return lerp(v0, v1, smooth((x - x0) / (x1 - x0 || 1)))
  }
  return keys[keys.length - 1][1]
}

/** n+1 evenly spaced values from a to b. */
export function steps(a: number, b: number, n: number): number[] {
  const out: number[] = []
  for (let i = 0; i <= n; i++) out.push(a + ((b - a) * i) / n)
  return out
}

// ---------------------------------------------------------------- triangle soup -> geometry

/** Make a non-indexed geometry from a flat list of triangle corners. */
function fromTriangles(pos: number[]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  return g
}

/** Signed volume of a closed triangle soup (positive when it faces outward). */
function signedVolume(pos: ArrayLike<number>): number {
  let v = 0
  for (let i = 0; i < pos.length; i += 9) {
    const ax = pos[i], ay = pos[i + 1], az = pos[i + 2]
    const bx = pos[i + 3], by = pos[i + 4], bz = pos[i + 5]
    const cx = pos[i + 6], cy = pos[i + 7], cz = pos[i + 8]
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)
  }
  return v / 6
}

/** Swap the 2nd and 3rd corner of every triangle (turns a part inside-out, or back). */
function flipWinding(g: THREE.BufferGeometry): void {
  for (const name of Object.keys(g.attributes)) {
    const a = g.getAttribute(name) as THREE.BufferAttribute
    const n = a.itemSize
    const arr = a.array as Float32Array
    for (let t = 0; t < a.count; t += 3) {
      for (let k = 0; k < n; k++) {
        const i1 = (t + 1) * n + k
        const i2 = (t + 2) * n + k
        const tmp = arr[i1]
        arr[i1] = arr[i2]
        arr[i2] = tmp
      }
    }
    a.needsUpdate = true
  }
}

/** Make a closed solid face outward (fix its winding if the volume came out negative). */
function faceOutward(g: THREE.BufferGeometry): THREE.BufferGeometry {
  if (signedVolume(g.getAttribute('position').array) < 0) flipWinding(g)
  return g
}

// ---------------------------------------------------------------- loft

/**
 * Join rings of points (each ring one cross-section, all with the same number
 * of points, going round the same way) into a closed solid. The two end rings
 * are capped with a fan from their middle.
 */
export function loft(rings: THREE.Vector3[][], caps = true): THREE.BufferGeometry {
  const pos: number[] = []
  const push = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => {
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z)
  }
  for (let r = 0; r < rings.length - 1; r++) {
    const A = rings[r]
    const B = rings[r + 1]
    const n = A.length
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      push(A[i], A[j], B[j])
      push(A[i], B[j], B[i])
    }
  }
  if (caps) {
    const cap = (R: THREE.Vector3[], flip: boolean) => {
      const c = new THREE.Vector3()
      for (const p of R) c.add(p)
      c.divideScalar(R.length)
      for (let i = 0; i < R.length; i++) {
        const a = R[i]
        const b = R[(i + 1) % R.length]
        if (flip) push(c, b, a)
        else push(c, a, b)
      }
    }
    cap(rings[0], true)
    cap(rings[rings.length - 1], false)
  }
  // drop degenerate triangles (collapsed points at a pointed nose or tip)
  const clean: number[] = []
  const e1 = new THREE.Vector3()
  const e2 = new THREE.Vector3()
  for (let i = 0; i < pos.length; i += 9) {
    e1.set(pos[i + 3] - pos[i], pos[i + 4] - pos[i + 1], pos[i + 5] - pos[i + 2])
    e2.set(pos[i + 6] - pos[i], pos[i + 7] - pos[i + 1], pos[i + 8] - pos[i + 2])
    if (e1.cross(e2).lengthSq() > 1e-14) for (let k = 0; k < 9; k++) clean.push(pos[i + k])
  }
  return faceOutward(fromTriangles(clean))
}

/** A full ring from a half cross-section (x >= 0, bottom centre -> top centre), mirrored to the other side. */
export function mirroredRing(half: V2[], z: number): THREE.Vector3[] {
  const out: THREE.Vector3[] = []
  for (let i = 0; i < half.length; i++) out.push(new THREE.Vector3(half[i][0], half[i][1], z))
  for (let i = half.length - 2; i >= 1; i--) out.push(new THREE.Vector3(-half[i][0], half[i][1], z))
  return out
}

/** A ring from a closed outline in x/y at depth z. */
export function ringXY(pts: V2[], z: number): THREE.Vector3[] {
  return pts.map(([x, y]) => new THREE.Vector3(x, y, z))
}

/**
 * Round a half cross-section: a point is added in the middle of each panel,
 * pushed outward by `bulge` x the panel's length (away from the centre at
 * height `cy`). The first panel (the flat underside) is left flat.
 */
export function roundHalf(half: V2[], bulge: number, cy: number): V2[] {
  const out: V2[] = [half[0]]
  for (let i = 0; i < half.length - 1; i++) {
    const [x0, y0] = half[i]
    const [x1, y1] = half[i + 1]
    if (i > 0 && bulge !== 0) {
      const mx = (x0 + x1) / 2
      const my = (y0 + y1) / 2
      let nx = y1 - y0
      let ny = -(x1 - x0)
      const len = Math.hypot(nx, ny)
      if (len > 1e-6) {
        nx /= len
        ny /= len
        if (nx * mx + ny * (my - cy) < 0) {
          nx = -nx
          ny = -ny
        }
        out.push([Math.max(0, mx + nx * bulge * len), my + ny * bulge * len])
      } else out.push([mx, my])
    } else if (i > 0) out.push([(x0 + x1) / 2, (y0 + y1) / 2])
    out.push(half[i + 1])
  }
  return out
}

/** Catmull-Rom through four values. */
function cr(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t
  const t3 = t2 * t
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
}

/**
 * Densify a table of stations (rows of numbers, first column = position along
 * the part): a smooth curve through them, `sub` steps per gap. Columns listed
 * in `linear` go in straight lines instead (never overshooting into a tyre).
 */
export function densify(stations: number[][], sub: number, linear: readonly number[] = [0]): number[][] {
  const n = stations.length
  const out: number[][] = []
  for (let i = 0; i < n - 1; i++) {
    const a = stations[Math.max(0, i - 1)]
    const b = stations[i]
    const c = stations[i + 1]
    const d = stations[Math.min(n - 1, i + 2)]
    for (let k = 0; k < sub; k++) {
      const t = k / sub
      const row: number[] = []
      for (let j = 0; j < b.length; j++) row.push(linear.includes(j) ? b[j] + (c[j] - b[j]) * t : cr(a[j], b[j], c[j], d[j], t))
      out.push(row)
    }
  }
  out.push(stations[n - 1].slice())
  return out
}

// ---------------------------------------------------------------- lathe, plate, rbox

/**
 * Spin a profile round an axis pointing BACKWARD (-z) from `at`: each point is
 * [radius, distance back]. Nozzles, exhaust tips, round lamps, tyres.
 * `segments` round the axis; `scaleY` squashes it into an oval.
 */
export function lathe(profile: V2[], segments: number, at: THREE.Vector3Like, scaleY = 1): THREE.BufferGeometry {
  const g = new THREE.LatheGeometry(
    profile.map(([r, a]) => new THREE.Vector2(Math.max(0, r), a)),
    segments,
  )
  g.rotateX(-Math.PI / 2) // lathe axis +y -> car -z
  g.scale(1, scaleY, 1)
  g.translate(at.x, at.y, at.z)
  return g
}

/**
 * A flat outline in the car's side view ([z, y] points) given thickness
 * across the car: fins, endplates, wing tips. Centred on x = `x`.
 */
export function plateSide(outline: V2[], thickness: number, x: number, bevel = 0.008): THREE.BufferGeometry {
  const shape = new THREE.Shape(outline.map(([z, y]) => new THREE.Vector2(z, y)))
  const depth = Math.max(0.001, thickness - 2 * bevel)
  const g = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: -bevel,
    bevelSegments: 1,
    curveSegments: 6,
  })
  g.rotateY(-Math.PI / 2) // shape x -> car z, extrude axis -> car -x
  g.translate(x + depth / 2, 0, 0)
  return g
}

/**
 * A flat outline seen from the front or back ([x, y] points) given depth
 * along the car: lamps, grilles, badges. Its face is at z = `z`, extending
 * `depth` backward (into the body) for a front face, forward for a back face.
 */
export function plateFront(outline: V2[], depth: number, z: number, facing: 1 | -1, rx = 0): THREE.BufferGeometry {
  const shape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)))
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 8 })
  // extrude goes +z: for a front face, slide it back so its face sits at z
  if (facing === 1) g.translate(0, 0, -depth)
  if (rx) {
    // rake: tilt about the outline's own centre line
    const c = outline.reduce((s, p) => s + p[1], 0) / outline.length
    g.translate(0, -c, 0)
    g.rotateX(rx)
    g.translate(0, c, 0)
  }
  g.translate(0, 0, z)
  return g
}

/** A rounded box centred at (x, y, z), tilted `rx` about the car's x axis. */
export function rbox(w: number, h: number, d: number, x: number, y: number, z: number, radius = 0.03, rx = 0): THREE.BufferGeometry {
  const r = Math.min(radius, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4)
  const g = r > 0.002 ? new RoundedBoxGeometry(w, h, d, 1, r) : new THREE.BoxGeometry(w, h, d)
  if (rx) g.rotateX(rx)
  g.translate(x, y, z)
  return g
}

/** A plain box between two points along its length (bars, struts, rails), `w` x `h` thick. */
export function bar(from: THREE.Vector3Like, to: THREE.Vector3Like, w: number, h: number): THREE.BufferGeometry {
  const a = new THREE.Vector3(from.x, from.y, from.z)
  const b = new THREE.Vector3(to.x, to.y, to.z)
  const len = a.distanceTo(b)
  const g = new THREE.BoxGeometry(w, h, len)
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), b.clone().sub(a).normalize())
  g.applyQuaternion(q)
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2)
  return g
}

/** A round tube between two points (bull bars, roll hoops, antennas). */
export function tube(from: THREE.Vector3Like, to: THREE.Vector3Like, radius: number, segments = 8): THREE.BufferGeometry {
  const a = new THREE.Vector3(from.x, from.y, from.z)
  const b = new THREE.Vector3(to.x, to.y, to.z)
  const g = new THREE.CylinderGeometry(radius, radius, a.distanceTo(b), segments, 1, false)
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize())
  g.applyQuaternion(q)
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2)
  return g
}

/**
 * A thin glowing ribbon along a path, `width` tall, standing `out` metres
 * proud along `normal` so it never z-fights the panel under it. For neon
 * strips that follow a curve the loft can't name.
 */
export function ribbon(path: THREE.Vector3[], width: number, up: THREE.Vector3Like, normal: THREE.Vector3Like, out = 0.008, thick = 0.012): THREE.BufferGeometry {
  const u = new THREE.Vector3(up.x, up.y, up.z).normalize().multiplyScalar(width / 2)
  const n = new THREE.Vector3(normal.x, normal.y, normal.z).normalize()
  const rings = path.map((p) => {
    const c = p.clone().addScaledVector(n, out)
    const back = n.clone().multiplyScalar(-thick)
    return [c.clone().add(u), c.clone().sub(u), c.clone().sub(u).add(back), c.clone().add(u).add(back)]
  })
  return loft(rings)
}

// ---------------------------------------------------------------- mirroring

/** The same part on the car's other side (x -> -x), still facing outward. */
export function mirrorX(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const m = (g.index ? g.toNonIndexed() : g.clone()) as THREE.BufferGeometry
  m.scale(-1, 1, 1)
  flipWinding(m)
  return m
}

// ---------------------------------------------------------------- part lists

/** How a part's normals are made: flat facets, smooth across gentle angles only, or kept as built. */
export type Shading = 'flat' | 'keep' | number

export interface PartOptions {
  /** Per-part values for the list's extra attributes (a number, or one per vertex from its position). */
  attrs?: Record<string, number | ((x: number, y: number, z: number) => number)>
  /** 'flat', 'keep', or a crease angle in radians (smooth across gentler angles). Default 0.6. */
  shading?: Shading
  /** Also add the mirror image (the other side of the car). */
  mirror?: boolean
}

/**
 * Collects parts and merges them into one geometry. Every part is made
 * non-indexed with the same attributes (position, normal, and the list's
 * extras), because mergeGeometries returns null on a mix.
 */
export class PartList {
  private readonly parts: THREE.BufferGeometry[] = []
  constructor(private readonly extras: readonly string[] = []) {}

  add(geometry: THREE.BufferGeometry, opts: PartOptions = {}): this {
    const shading = opts.shading ?? 0.6
    let g = geometry.index ? geometry.toNonIndexed() : geometry
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name)
    if (shading === 'flat') {
      g.deleteAttribute('normal')
      g.computeVertexNormals()
    } else if (shading !== 'keep' || !g.getAttribute('normal')) {
      g.deleteAttribute('normal')
      g = toCreasedNormals(g, shading === 'keep' ? 0.6 : shading)
    }
    const pos = g.getAttribute('position')
    for (const name of this.extras) {
      const v = opts.attrs?.[name] ?? 0
      const a = new Float32Array(pos.count)
      for (let i = 0; i < pos.count; i++) a[i] = typeof v === 'number' ? v : v(pos.getX(i), pos.getY(i), pos.getZ(i))
      g.setAttribute(name, new THREE.BufferAttribute(a, 1))
    }
    this.parts.push(g)
    if (opts.mirror) this.parts.push(mirrorX(g))
    return this
  }

  /** Merge everything added so far into one geometry. Throws (loudly, at build time) if the merge fails. */
  build(label: string): THREE.BufferGeometry {
    if (this.parts.length === 0) {
      const empty = new THREE.BufferGeometry()
      empty.setAttribute('position', new THREE.Float32BufferAttribute([], 3))
      empty.setAttribute('normal', new THREE.Float32BufferAttribute([], 3))
      for (const name of this.extras) empty.setAttribute(name, new THREE.Float32BufferAttribute([], 1))
      return empty
    }
    const merged = mergeGeometries(this.parts, false)
    if (!merged) throw new Error(`[vehicle] body part merge failed for "${label}" (mismatched attributes)`)
    merged.computeBoundingSphere()
    merged.computeBoundingBox()
    return merged
  }

  get triangles(): number {
    let n = 0
    for (const p of this.parts) n += p.getAttribute('position').count / 3
    return n
  }
}
