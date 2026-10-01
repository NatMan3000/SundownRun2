// ============================================================
//  TRACK THUMBNAIL - a little map of a track file, drawn as SVG
// ------------------------------------------------------------
//  Works straight from the file's control points (road.points),
//  so it never has to build the track: a smooth closed curve
//  through every point (Catmull-Rom, the same kind of curve the
//  game builds the road from), north up, with a tick at the start
//  line. Drawn tracks and shared tracks get one for free.
// ============================================================

import { useMemo } from 'react'
import type { TrackFile } from '../track/schema'
import { PALETTE } from '../core/palette'

interface ThumbGeom {
  d: string
  start: { x: number; y: number; ax: number; ay: number } | null
  w: number
  h: number
}

/** Closed Catmull-Rom curve through the points as an SVG path, fitted into a w x h box. */
function thumbGeometry(file: TrackFile, w: number, h: number, pad: number): ThumbGeom | null {
  const pts = file.road?.points
  if (!Array.isArray(pts) || pts.length < 3) return null
  let minX = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxZ = -Infinity
  for (const p of pts) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) return null
    minX = Math.min(minX, p.x)
    maxX = Math.max(maxX, p.x)
    minZ = Math.min(minZ, p.z)
    maxZ = Math.max(maxZ, p.z)
  }
  const spanX = Math.max(1, maxX - minX)
  const spanZ = Math.max(1, maxZ - minZ)
  const s = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanZ)
  const ox = (w - spanX * s) / 2
  const oy = (h - spanZ * s) / 2
  // +x east is right; -z north is up, and SVG y grows downward, so z maps straight to y.
  const X = (x: number) => (x - minX) * s + ox
  const Y = (z: number) => (z - minZ) * s + oy
  const n = pts.length
  const at = (i: number) => pts[((i % n) + n) % n]
  let d = `M${X(at(0).x).toFixed(1)} ${Y(at(0).z).toFixed(1)}`
  for (let i = 0; i < n; i++) {
    const p0 = at(i - 1)
    const p1 = at(i)
    const p2 = at(i + 1)
    const p3 = at(i + 2)
    const c1x = X(p1.x + (p2.x - p0.x) / 6)
    const c1y = Y(p1.z + (p2.z - p0.z) / 6)
    const c2x = X(p2.x - (p3.x - p1.x) / 6)
    const c2y = Y(p2.z - (p3.z - p1.z) / 6)
    d += ` C${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${X(p2.x).toFixed(1)} ${Y(p2.z).toFixed(1)}`
  }
  // Start line: at `start.at` (point index + fraction), facing along the road.
  const startAt = Number.isFinite(file.start?.at) ? (file.start!.at as number) : 0
  const i0 = Math.floor(startAt)
  const f = startAt - i0
  const a = at(i0)
  const b = at(i0 + 1)
  const sx = X(a.x + (b.x - a.x) * f)
  const sy = Y(a.z + (b.z - a.z) * f)
  const dx = X(b.x) - X(a.x)
  const dy = Y(b.z) - Y(a.z)
  const len = Math.hypot(dx, dy) || 1
  return { d, start: { x: sx, y: sy, ax: dx / len, ay: dy / len }, w, h }
}

/** Rough road length in metres from the control points (sampled spline). */
export function approxTrackLength(file: TrackFile): number {
  const pts = file.road?.points
  if (!Array.isArray(pts) || pts.length < 3) return 0
  const n = pts.length
  const at = (i: number) => pts[((i % n) + n) % n]
  let total = 0
  for (let i = 0; i < n; i++) {
    const p0 = at(i - 1)
    const p1 = at(i)
    const p2 = at(i + 1)
    const p3 = at(i + 2)
    let px = p1.x
    let pz = p1.z
    for (let k = 1; k <= 8; k++) {
      const t = k / 8
      const t2 = t * t
      const t3 = t2 * t
      const cr = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3)
      const x = cr(p0.x, p1.x, p2.x, p3.x)
      const z = cr(p0.z, p1.z, p2.z, p3.z)
      total += Math.hypot(x - px, z - pz)
      px = x
      pz = z
    }
  }
  return total
}

export function TrackThumb(props: { file: TrackFile; width?: number; height?: number; className?: string }) {
  const w = props.width ?? 160
  const h = props.height ?? 100
  const geom = useMemo(() => thumbGeometry(props.file, w, h, 10), [props.file, w, h])
  const edge = props.file.environment?.palette?.edge ?? PALETTE.roadEdge
  if (!geom) {
    return <div className={`thumb thumb--empty ${props.className ?? ''}`}>No road yet</div>
  }
  const s = geom.start
  return (
    <svg className={`thumb ${props.className ?? ''}`} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <path className="thumb__halo" d={geom.d} style={{ stroke: edge }} />
      <path className="thumb__road" d={geom.d} style={{ stroke: edge }} />
      {s && (
        <line
          className="thumb__start"
          x1={s.x - s.ay * 5}
          y1={s.y + s.ax * 5}
          x2={s.x + s.ay * 5}
          y2={s.y - s.ax * 5}
        />
      )}
    </svg>
  )
}
