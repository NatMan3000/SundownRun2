// ============================================================
//  SPLINE - a smooth closed curve through the road's control points
// ------------------------------------------------------------
//  A centripetal Catmull-Rom spline: it passes through every point,
//  never overshoots into loops or cusps on uneven spacing, and is the
//  standard choice for "draw a smooth road through these dots".
//
//  sampleClosedSpline() walks the curve in small steps and returns a
//  dense polyline. Each node remembers its `at` (control-point index +
//  fraction), which is how track pieces say where they are.
// ============================================================

export interface SplinePoint {
  x: number
  y: number
  z: number
}

/** A dense polyline along the closed spline. Node `count` (the last) repeats node 0 with at = points.length. */
export interface DensePath {
  count: number
  x: Float64Array
  y: Float64Array
  z: Float64Array
  /** Control-point index + fraction, increasing from 0 to points.length. */
  at: Float64Array
  /** Arc length (3D) from node 0. */
  cum: Float64Array
  length: number
  /** Number of control points (the at range is 0..segments). */
  segments: number
}

const ALPHA = 0.5 // centripetal

function knot(a: SplinePoint, b: SplinePoint): number {
  const d = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
  return Math.max(1e-4, Math.pow(d, ALPHA))
}

/** Evaluate one segment (p1 -> p2) at u in 0..1, writing into out. Barry-Goldman pyramid. */
function evalSegment(
  p0: SplinePoint,
  p1: SplinePoint,
  p2: SplinePoint,
  p3: SplinePoint,
  u: number,
  out: SplinePoint,
): void {
  const t0 = 0
  const t1 = t0 + knot(p0, p1)
  const t2 = t1 + knot(p1, p2)
  const t3 = t2 + knot(p2, p3)
  const t = t1 + (t2 - t1) * u
  const lerp3 = (a: SplinePoint, b: SplinePoint, ta: number, tb: number, o: SplinePoint) => {
    const w = (t - ta) / (tb - ta)
    o.x = a.x + (b.x - a.x) * w
    o.y = a.y + (b.y - a.y) * w
    o.z = a.z + (b.z - a.z) * w
  }
  const A1 = { x: 0, y: 0, z: 0 }
  const A2 = { x: 0, y: 0, z: 0 }
  const A3 = { x: 0, y: 0, z: 0 }
  lerp3(p0, p1, t0, t1, A1)
  lerp3(p1, p2, t1, t2, A2)
  lerp3(p2, p3, t2, t3, A3)
  const B1 = { x: 0, y: 0, z: 0 }
  const B2 = { x: 0, y: 0, z: 0 }
  lerp3(A1, A2, t0, t2, B1)
  lerp3(A2, A3, t1, t3, B2)
  lerp3(B1, B2, t1, t2, out)
}

/** Sample a closed centripetal Catmull-Rom spline every ~`step` metres. */
export function sampleClosedSpline(points: readonly SplinePoint[], step = 0.25): DensePath {
  const n = points.length
  const xs: number[] = []
  const ys: number[] = []
  const zs: number[] = []
  const ats: number[] = []
  const tmp = { x: 0, y: 0, z: 0 }
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n]
    const p1 = points[i]
    const p2 = points[(i + 1) % n]
    const p3 = points[(i + 2) % n]
    const chord = Math.hypot(p2.x - p1.x, p2.y - p1.y, p2.z - p1.z)
    // A little extra density: the curve can be longer than its chord.
    const m = Math.max(4, Math.ceil((chord * 1.15) / step))
    for (let k = 0; k < m; k++) {
      const u = k / m
      evalSegment(p0, p1, p2, p3, u, tmp)
      xs.push(tmp.x)
      ys.push(tmp.y)
      zs.push(tmp.z)
      ats.push(i + u)
    }
  }
  // Close the loop: repeat the first node at at = n.
  xs.push(xs[0])
  ys.push(ys[0])
  zs.push(zs[0])
  ats.push(n)

  const count = xs.length
  const x = Float64Array.from(xs)
  const y = Float64Array.from(ys)
  const z = Float64Array.from(zs)
  const at = Float64Array.from(ats)
  const cum = new Float64Array(count)
  for (let i = 1; i < count; i++) {
    cum[i] = cum[i - 1] + Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1], z[i] - z[i - 1])
  }
  return { count, x, y, z, at, cum, length: cum[count - 1], segments: n }
}

/** Arc length along the dense path where `at` falls (at wraps into 0..segments). */
export function arcLengthAtParam(path: DensePath, atIn: number): number {
  const n = path.segments
  const at = ((atIn % n) + n) % n
  let lo = 0
  let hi = path.count - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (path.at[mid] <= at) lo = mid
    else hi = mid
  }
  const a0 = path.at[lo]
  const a1 = path.at[hi]
  const f = a1 > a0 ? (at - a0) / (a1 - a0) : 0
  return path.cum[lo] + (path.cum[hi] - path.cum[lo]) * f
}

/** Index of the dense node at or before arc length s (s in 0..length). */
export function nodeAtLength(path: DensePath, s: number): number {
  let lo = 0
  let hi = path.count - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (path.cum[mid] <= s) lo = mid
    else hi = mid
  }
  return lo
}
