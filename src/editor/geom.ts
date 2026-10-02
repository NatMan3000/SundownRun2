// ============================================================
//  EDITOR GEOMETRY - flat 2D helpers for drawn roads
// ------------------------------------------------------------
//  The road editor works on the map seen from above, so every
//  shape here is 2D: a point is { x, z } in world metres (+x east,
//  -z north, the same axes as the track file).
//
//  A "polyline" is a list of points joined by straight lines. A
//  "closed" polyline joins its last point back to its first, which
//  is what a race track is. These helpers measure, resample, smooth
//  and intersect polylines. They are pure functions: no three.js, no
//  React, no game state, so they are easy to test (see selfTest.ts).
// ============================================================

export interface P {
  x: number
  z: number
}

export function dist(a: P, b: P): number {
  return Math.hypot(a.x - b.x, a.z - b.z)
}

/** Length of a polyline, optionally including the closing segment back to the start. */
export function polylineLength(pts: readonly P[], closed: boolean): number {
  let len = 0
  for (let i = 1; i < pts.length; i++) len += dist(pts[i - 1], pts[i])
  if (closed && pts.length > 1) len += dist(pts[pts.length - 1], pts[0])
  return len
}

/** Cumulative distance along the polyline at every point (arc[0] = 0). */
export function arcLengths(pts: readonly P[]): number[] {
  const out = new Array<number>(pts.length)
  out[0] = 0
  for (let i = 1; i < pts.length; i++) out[i] = out[i - 1] + dist(pts[i - 1], pts[i])
  return out
}

/**
 * Re-space a polyline so its points sit an even `spacing` apart along it.
 * Closed: the result is a loop whose segments (including the closing one)
 * are all the same length, as close to `spacing` as divides the loop evenly.
 */
export function resample(pts: readonly P[], spacing: number, closed: boolean): P[] {
  if (pts.length < 2) return pts.map((p) => ({ x: p.x, z: p.z }))
  const path = closed ? [...pts, pts[0]] : pts
  const arcs = arcLengths(path)
  const total = arcs[arcs.length - 1]
  if (total <= 1e-6) return [{ x: pts[0].x, z: pts[0].z }]
  const segments = Math.max(closed ? 3 : 1, Math.round(total / spacing))
  const step = total / segments
  const count = closed ? segments : segments + 1
  const out: P[] = []
  let j = 1
  for (let k = 0; k < count; k++) {
    const s = Math.min(total, k * step)
    while (j < arcs.length - 1 && arcs[j] < s) j++
    const s0 = arcs[j - 1]
    const s1 = arcs[j]
    const t = s1 > s0 ? (s - s0) / (s1 - s0) : 0
    out.push({ x: path[j - 1].x + (path[j].x - path[j - 1].x) * t, z: path[j - 1].z + (path[j].z - path[j - 1].z) * t })
  }
  return out
}

/** Point at distance s along a polyline (clamped, or wrapped when closed). */
export function pointAt(pts: readonly P[], s: number, closed: boolean): P {
  const path = closed ? [...pts, pts[0]] : pts
  const arcs = arcLengths(path)
  const total = arcs[arcs.length - 1]
  let t = closed ? ((s % total) + total) % total : Math.max(0, Math.min(total, s))
  let j = 1
  while (j < arcs.length - 1 && arcs[j] < t) j++
  const s0 = arcs[j - 1]
  const s1 = arcs[j]
  t = s1 > s0 ? (t - s0) / (s1 - s0) : 0
  return { x: path[j - 1].x + (path[j].x - path[j - 1].x) * t, z: path[j - 1].z + (path[j].z - path[j - 1].z) * t }
}

/**
 * Taubin smoothing on a closed polyline: a shrink step (pull each point
 * toward its neighbours) then an inflate step (push it back out). Plain
 * smoothing makes a loop shrink a little every pass; Taubin's pair irons
 * out hand wobble while keeping the loop the size Josh drew it.
 */
export function smoothClosed(pts: P[], passes: number, lambda = 0.5, mu = -0.53): P[] {
  let cur = pts.map((p) => ({ x: p.x, z: p.z }))
  const n = cur.length
  if (n < 4) return cur
  for (let pass = 0; pass < passes; pass++) {
    for (const k of [lambda, mu]) {
      const next = new Array<P>(n)
      for (let i = 0; i < n; i++) {
        const a = cur[(i - 1 + n) % n]
        const b = cur[i]
        const c = cur[(i + 1) % n]
        next[i] = { x: b.x + k * ((a.x + c.x) / 2 - b.x), z: b.z + k * ((a.z + c.z) / 2 - b.z) }
      }
      cur = next
    }
  }
  return cur
}

/**
 * Gaussian smoothing on an evenly spaced closed polyline: each point becomes
 * a weighted average of its neighbours within about 3 x sigma metres, the
 * nearest counting most. It removes wobble shorter than a few sigma and
 * barely touches big shapes (a 180 m circle shrinks by under 0.2% at sigma 10).
 */
export function gaussianSmoothClosed(pts: readonly P[], sigma: number): P[] {
  const n = pts.length
  if (n < 4 || sigma <= 0) return pts.map((p) => ({ x: p.x, z: p.z }))
  const h = polylineLength(pts, true) / n
  const reach = Math.min(Math.floor((n - 1) / 2), Math.ceil((3 * sigma) / h))
  const weights: number[] = []
  let total = 0
  for (let k = -reach; k <= reach; k++) {
    const w = Math.exp(-((k * h) ** 2) / (2 * sigma * sigma))
    weights.push(w)
    total += w
  }
  const out = new Array<P>(n)
  for (let i = 0; i < n; i++) {
    let x = 0
    let z = 0
    for (let k = -reach; k <= reach; k++) {
      const p = pts[(((i + k) % n) + n) % n]
      const w = weights[k + reach]
      x += p.x * w
      z += p.z * w
    }
    out[i] = { x: x / total, z: z / total }
  }
  return out
}

/**
 * Signed turn angle at each point of a closed polyline, in radians: how far
 * the direction swings from the segment arriving at the point to the segment
 * leaving it. Positive = turning one way, negative = the other; on an even
 * spacing h, the local corner radius is about h / |angle|.
 */
export function turnAngles(pts: readonly P[]): number[] {
  const n = pts.length
  const out = new Array<number>(n)
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n]
    const b = pts[i]
    const c = pts[(i + 1) % n]
    out[i] = turnAngle(a, b, c)
  }
  return out
}

export function turnAngle(a: P, b: P, c: P): number {
  const d1x = b.x - a.x
  const d1z = b.z - a.z
  const d2x = c.x - b.x
  const d2z = c.z - b.z
  return Math.atan2(d1x * d2z - d1z * d2x, d1x * d2x + d1z * d2z)
}

/**
 * Corner radius at every point of a closed polyline, measured over chords
 * about `window` metres long (so tiny wobbles between neighbouring points
 * do not count as corners). Straight bits come out as Infinity.
 */
export function radii(pts: readonly P[], window = 10): number[] {
  const n = pts.length
  const out = new Array<number>(n).fill(Infinity)
  if (n < 3) return out
  const h = polylineLength(pts, true) / n
  const k = Math.max(1, Math.round(window / 2 / Math.max(h, 1e-6)))
  for (let i = 0; i < n; i++) out[i] = circumradius(pts[(i - k + n) % n], pts[i], pts[(i + k) % n])
  return out
}

/** Tightest corner radius on a closed polyline (see radii) and where it is. */
export function minRadius(pts: readonly P[], window = 10): { radius: number; index: number } {
  const r = radii(pts, window)
  let best = Infinity
  let at = -1
  for (let i = 0; i < r.length; i++) {
    if (r[i] < best) {
      best = r[i]
      at = i
    }
  }
  return { radius: best, index: at }
}

/** Radius of the circle through three points (Infinity when they are in a straight line). */
export function circumradius(a: P, b: P, c: P): number {
  const ab = dist(a, b)
  const bc = dist(b, c)
  const ca = dist(c, a)
  const cross = Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x))
  if (cross < 1e-9) return Infinity
  return (ab * bc * ca) / (2 * cross)
}

/**
 * Where segment a->b crosses segment c->d, as fractions along each
 * (t on the first, u on the second), or null if they do not cross.
 */
export function segmentIntersection(a: P, b: P, c: P, d: P): { t: number; u: number } | null {
  const rx = b.x - a.x
  const rz = b.z - a.z
  const sx = d.x - c.x
  const sz = d.z - c.z
  const denom = rx * sz - rz * sx
  if (Math.abs(denom) < 1e-12) return null
  const qx = c.x - a.x
  const qz = c.z - a.z
  const t = (qx * sz - qz * sx) / denom
  const u = (qx * rz - qz * rx) / denom
  if (t < 0 || t >= 1 || u < 0 || u >= 1) return null
  return { t, u }
}

/**
 * Centripetal Catmull-Rom through a closed list of control points, sampled
 * `perSegment` times between each pair. This is the same family of smooth
 * curve the track builder runs through the file's points, so the editor can
 * check that the control points it writes really give the road it cleaned.
 */
export function catmullRomClosed(ctrl: readonly P[], perSegment: number): P[] {
  const n = ctrl.length
  const out: P[] = []
  for (let i = 0; i < n; i++) {
    const p0 = ctrl[(i - 1 + n) % n]
    const p1 = ctrl[i]
    const p2 = ctrl[(i + 1) % n]
    const p3 = ctrl[(i + 2) % n]
    const t01 = Math.sqrt(Math.max(dist(p0, p1), 1e-4))
    const t12 = Math.sqrt(Math.max(dist(p1, p2), 1e-4))
    const t23 = Math.sqrt(Math.max(dist(p2, p3), 1e-4))
    for (let k = 0; k < perSegment; k++) {
      const u = k / perSegment
      out.push(centripetalPoint(p0, p1, p2, p3, t01, t12, t23, u))
    }
  }
  return out
}

/**
 * One spot on that same closed curve: `at` is a control-point index plus
 * a fraction (at 3.5 = halfway from point 3 to point 4, as in track files).
 */
export function catmullRomAt(ctrl: readonly P[], at: number): P {
  const n = ctrl.length
  const a = ((at % n) + n) % n
  const i = Math.floor(a) % n
  const p0 = ctrl[(i - 1 + n) % n]
  const p1 = ctrl[i]
  const p2 = ctrl[(i + 1) % n]
  const p3 = ctrl[(i + 2) % n]
  const t01 = Math.sqrt(Math.max(dist(p0, p1), 1e-4))
  const t12 = Math.sqrt(Math.max(dist(p1, p2), 1e-4))
  const t23 = Math.sqrt(Math.max(dist(p2, p3), 1e-4))
  return centripetalPoint(p0, p1, p2, p3, t01, t12, t23, a - Math.floor(a))
}

function centripetalPoint(p0: P, p1: P, p2: P, p3: P, t01: number, t12: number, t23: number, u: number): P {
  // Tangents at p1 and p2 for the centripetal parameterisation (Barry-Goldman, as a Hermite segment).
  const m1x = t12 * ((p1.x - p0.x) / t01 - (p2.x - p0.x) / (t01 + t12) + (p2.x - p1.x) / t12)
  const m1z = t12 * ((p1.z - p0.z) / t01 - (p2.z - p0.z) / (t01 + t12) + (p2.z - p1.z) / t12)
  const m2x = t12 * ((p2.x - p1.x) / t12 - (p3.x - p1.x) / (t12 + t23) + (p3.x - p2.x) / t23)
  const m2z = t12 * ((p2.z - p1.z) / t12 - (p3.z - p1.z) / (t12 + t23) + (p3.z - p2.z) / t23)
  const u2 = u * u
  const u3 = u2 * u
  const h00 = 2 * u3 - 3 * u2 + 1
  const h10 = u3 - 2 * u2 + u
  const h01 = -2 * u3 + 3 * u2
  const h11 = u3 - u2
  return {
    x: h00 * p1.x + h10 * m1x + h01 * p2.x + h11 * m2x,
    z: h00 * p1.z + h10 * m1z + h01 * p2.z + h11 * m2z,
  }
}

/** Signed area of a closed polyline (positive when it runs one way round, negative the other). */
export function signedArea(pts: readonly P[]): number {
  let a = 0
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i]
    const q = pts[(i + 1) % n]
    a += p.x * q.z - q.x * p.z
  }
  return a / 2
}

/** Shortest distance from point p to segment a->b, and the fraction along it. */
export function distToSegment(p: P, a: P, b: P): { d: number; t: number } {
  const vx = b.x - a.x
  const vz = b.z - a.z
  const len2 = vx * vx + vz * vz
  let t = len2 > 0 ? ((p.x - a.x) * vx + (p.z - a.z) * vz) / len2 : 0
  t = Math.max(0, Math.min(1, t))
  return { d: Math.hypot(p.x - (a.x + vx * t), p.z - (a.z + vz * t)), t }
}

/** Nearest point on a closed polyline to p: segment index, fraction, distance and arc position. */
export function nearestOnClosed(pts: readonly P[], p: P): { index: number; t: number; d: number; s: number } {
  let best = { index: 0, t: 0, d: Infinity, s: 0 }
  let arc = 0
  for (let i = 0, n = pts.length; i < n; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % n]
    const r = distToSegment(p, a, b)
    const len = dist(a, b)
    if (r.d < best.d) best = { index: i, t: r.t, d: r.d, s: arc + r.t * len }
    arc += len
  }
  return best
}
