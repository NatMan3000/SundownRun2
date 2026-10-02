// ============================================================
//  MAP DRAWING - every mark the editor draws over the 3D world
// ------------------------------------------------------------
//  The 3D view under the editor is the real track. On top of it this
//  draws, in crisp screen pixels, what a map needs: the road outline
//  when zoomed out, which way you drive, the start line, bridges,
//  every piece as an icon, props and cores, what is selected, and
//  pins on anything the game wants you to check (its track checks
//  come from checks.ts; a failing one gets a red tag by its pin).
//  The shaping tools draw their previews here too: the stretch Bend
//  will move (brightest at your hand), and Straight or Curve's new road
//  before the last click (cyan when it works, red when too tight).
//
//  Overlay.tsx calls drawMap() whenever something changed. Nothing
//  here changes any state.
// ============================================================

import { FONTS, PALETTE } from '../core/palette'
import { cars, telemetry } from '../core/telemetry'
import { TRACK_DEFAULTS, type Piece, type RoadPoint } from '../track/schema'
import type { BendView, EditorState } from './draft'
import { gateItems } from './checks'
import { type P } from './geom'
import { pieceColour, pieceFootprint, pieceLabel, piecePlace, toolFor, type PlaceKind } from './pieces'
import { type RoadCurve, PER, advanceAt, frameAt, roadCurve, wrapAt } from './road'
import { view, worldToScreen } from './view'

/** What can be picked on the map. */
export type Pick =
  | { kind: 'piece'; index: number }
  | { kind: 'prop'; index: number }
  | { kind: 'core'; index: number }
  | { kind: 'point'; index: number }

export interface MapExtras {
  /** The pencil line being drawn right now (world points). */
  stroke: readonly P[]
  hover: P | null
  /** Place tool: where the thing would go if you clicked now. */
  ghost: { kind: PlaceKind; at: P; dir: P } | null
  /** Select tool: the thing under the pointer. */
  hoverPick: Pick | null
  /** Bend tool: the stretch that would move (hovering) or is moving (dragging). */
  bend?: { view: BendView; dragging: boolean } | null
  /** Straight and Curve: the spots clicked, the stretch that will change and the new road there. */
  shape?: ShapeView | null
  /** Pencil with a steady hand: the pen (where the line is) and the pointer it trails behind. */
  pen?: { at: P; to: P } | null
}

/** What the map shows for a Straight or Curve in progress. */
export interface ShapeView {
  /** The clicked spots on the road, in order (1, 2). */
  marks: P[]
  /** Curve: the pulled middle (the pointer). */
  pull: P | null
  /** The stretch of road that will change. */
  old: P[]
  /** The new road there (empty until there is one to show). */
  preview: P[]
  /** False when it can't be done (too tight, off the world): drawn red. */
  ok: boolean
  /** The spot that is too tight, if any. */
  tight: P | null
}

// ---------------------------------------------------------------- cached road shape

let cache: { points: RoadPoint[] | null; width: number; rc: RoadCurve; left: P[]; right: P[] } | null = null

/** The road curve and its two edges (per-point widths included), cached until the road changes. */
export function roadGeometry(points: RoadPoint[], width: number) {
  if (cache && cache.points === points && cache.width === width) return cache
  const rc = roadCurve(points)
  const left: P[] = []
  const right: P[] = []
  const n = rc.curve.length
  const count = points.length
  for (let i = 0; i < n; i++) {
    const a = rc.curve[(i - 1 + n) % n]
    const b = rc.curve[(i + 1) % n]
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1
    const rx = -(b.z - a.z) / len
    const rz = (b.x - a.x) / len
    const k = Math.floor(i / PER)
    const t = (i % PER) / PER
    const w0 = points[k].width ?? width
    const w1 = points[(k + 1) % count].width ?? width
    const half = (w0 + (w1 - w0) * t) / 2
    right.push({ x: rc.curve[i].x + rx * half, z: rc.curve[i].z + rz * half })
    left.push({ x: rc.curve[i].x - rx * half, z: rc.curve[i].z - rz * half })
  }
  cache = { points, width, rc, left, right }
  return cache
}

/** Which road points are shown as handles right now. */
export function pointsVisible(s: EditorState): boolean {
  if (s.mode !== 'edit') return false
  return s.tool === 'select' ? view.mpp < 2.2 : view.mpp < 0.7
}

// ---------------------------------------------------------------- the whole map

/** Screen boxes of every label drawn this frame, so later labels can step around them. */
let labelBoxes: { x0: number; y0: number; x1: number; y1: number }[] = []

/** A label that steps out of the way of labels already drawn: tries each offset in turn. */
function placePill(ctx: CanvasRenderingContext2D, text: string, sx: number, sy: number, offsets: readonly number[], colour: string): void {
  ctx.save()
  ctx.font = `600 12px ${FONTS.body}`
  const w = ctx.measureText(text).width + 14
  ctx.restore()
  for (const off of offsets) {
    const r = { x0: sx - w / 2 - 2, y0: sy + off - 12, x1: sx + w / 2 + 2, y1: sy + off + 12 }
    if (labelBoxes.some((q) => r.x0 < q.x1 && r.x1 > q.x0 && r.y0 < q.y1 && r.y1 > q.y0)) continue
    labelBoxes.push(r)
    pill(ctx, text, sx, sy + off, colour)
    return
  }
}

export function drawMap(ctx: CanvasRenderingContext2D, s: EditorState, x: MapExtras): void {
  const d = s.draft
  labelBoxes = []
  ctx.clearRect(0, 0, view.width, view.height)
  const g = roadGeometry(d.points, d.width)

  if (g.rc.curve.length) {
    // Zoomed out, the 3D road's light strips get thinner than a pixel, so the map draws its outline.
    // While bending, the 3D road waits for you to let go, so the outline shows the road as it is now.
    if (view.mpp > 0.55 || x.bend?.dragging) drawRoadOutline(ctx, g.left, g.right, d.environment.palette?.edge ?? PALETTE.roadEdge)
    drawBankOverrides(ctx, g.rc, d.points)
    if (s.selection?.kind === 'section') drawSection(ctx, g.rc, s.selection.from, s.selection.to)
    if (x.bend) drawBend(ctx, x.bend.view, x.bend.dragging, d.width)
    if (x.shape) drawShape(ctx, x.shape, d.width)
    drawDirectionArrows(ctx, g.rc.curve)
    drawBridges(ctx, d.points)
    drawPieces(ctx, g.rc, d.pieces, d.width, s.selection, x.hoverPick)
    drawStartLine(ctx, g.rc, d.startAt, d.width)
    if (pointsVisible(s)) drawControlPoints(ctx, d.points, s.selection, x.hoverPick)
  }
  drawProps(ctx, d.props, s.selection, x.hoverPick)
  drawCores(ctx, d.cores, s.selection, x.hoverPick)
  if (x.ghost) drawGhost(ctx, x.ghost, d.width)
  if (s.mode === 'map') {
    drawLabels(ctx, s, g.rc)
    drawCars(ctx)
  }
  drawPins(ctx, s, g.rc)
  if (x.stroke.length > 1) drawStroke(ctx, x.stroke)
  if (x.pen) drawPen(ctx, x.pen.at, x.pen.to)
  drawScaleBar(ctx)
  drawCompass(ctx)
  if (x.hover) drawReadout(ctx, x.hover)
}

// ---------------------------------------------------------------- shapes

function line(ctx: CanvasRenderingContext2D, pts: readonly P[], closed: boolean): void {
  ctx.beginPath()
  for (let i = 0; i < pts.length; i++) {
    const { sx, sy } = worldToScreen(pts[i].x, pts[i].z)
    if (i === 0) ctx.moveTo(sx, sy)
    else ctx.lineTo(sx, sy)
  }
  if (closed) ctx.closePath()
}

/** A label on a dark pill, legible over the brightest scene. */
export function pill(ctx: CanvasRenderingContext2D, text: string, sx: number, sy: number, colour: string): void {
  ctx.save()
  ctx.font = `600 12px ${FONTS.body}`
  const w = ctx.measureText(text).width + 14
  const h = 20
  ctx.fillStyle = PALETTE.uiPanel
  ctx.strokeStyle = colour
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.roundRect(sx - w / 2, sy - h / 2, w, h, 10)
  ctx.fill()
  ctx.stroke()
  ctx.fillStyle = colour
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, sx, sy + 0.5)
  ctx.restore()
}

function drawStroke(ctx: CanvasRenderingContext2D, stroke: readonly P[]): void {
  ctx.save()
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.shadowColor = PALETTE.uiAccent
  ctx.shadowBlur = 14
  ctx.strokeStyle = PALETTE.uiAccent
  ctx.lineWidth = 4
  line(ctx, stroke, false)
  ctx.stroke()
  ctx.shadowBlur = 0
  ctx.strokeStyle = PALETTE.coreHot
  ctx.lineWidth = 1.5
  ctx.stroke()
  ctx.restore()
}

/** The steady pencil's string: a thin line from the pen (where the road is drawn) to the pointer. */
function drawPen(ctx: CanvasRenderingContext2D, at: P, to: P): void {
  const a = worldToScreen(at.x, at.z)
  const b = worldToScreen(to.x, to.z)
  ctx.save()
  ctx.strokeStyle = PALETTE.uiDim
  ctx.lineWidth = 1
  ctx.setLineDash([3, 3])
  ctx.beginPath()
  ctx.moveTo(a.sx, a.sy)
  ctx.lineTo(b.sx, b.sy)
  ctx.stroke()
  ctx.setLineDash([])
  ctx.fillStyle = PALETTE.uiAccent
  ctx.shadowColor = PALETTE.uiAccent
  ctx.shadowBlur = 8
  ctx.beginPath()
  ctx.arc(a.sx, a.sy, 3.5, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

/**
 * Bend: the stretch of road that moves with your hand, as a glowing band that
 * is brightest at your hand and fades to nothing at the reach (that is how
 * much of the pull each bit gets). Ticks mark the two ends of the reach. Red
 * where the bend would be too tight for a car.
 */
function drawBend(ctx: CanvasRenderingContext2D, v: BendView, dragging: boolean, roadWidth: number): void {
  const colour = v.tight ? PALETTE.uiBad : PALETTE.uiAccent
  const n = v.line.length
  if (n < 2) return
  ctx.save()
  ctx.lineCap = 'round'
  ctx.strokeStyle = colour
  ctx.lineWidth = Math.max(10, (roadWidth + 10) / view.mpp)
  for (let i = 0; i < n - 1; i++) {
    const a = worldToScreen(v.line[i].x, v.line[i].z)
    const b = worldToScreen(v.line[i + 1].x, v.line[i + 1].z)
    ctx.globalAlpha = 0.06 + 0.34 * ((v.weights[i] + v.weights[i + 1]) / 2)
    ctx.beginPath()
    ctx.moveTo(a.sx, a.sy)
    ctx.lineTo(b.sx, b.sy)
    ctx.stroke()
  }
  ctx.globalAlpha = 1
  // The ends of the reach: a short tick across the road.
  for (const [i, j] of [
    [0, 1],
    [n - 1, n - 2],
  ]) {
    const p = v.line[i]
    const q = v.line[j]
    const len = Math.hypot(q.x - p.x, q.z - p.z) || 1
    const rx = -(q.z - p.z) / len
    const rz = (q.x - p.x) / len
    const half = roadWidth / 2 + 6
    const a = worldToScreen(p.x - rx * half, p.z - rz * half)
    const b = worldToScreen(p.x + rx * half, p.z + rz * half)
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(a.sx, a.sy)
    ctx.lineTo(b.sx, b.sy)
    ctx.stroke()
  }
  // Your hand: a handle on the road where it is (or would be) grabbed.
  const mid = v.line[Math.floor(n / 2)]
  const m = worldToScreen(mid.x, mid.z)
  ctx.beginPath()
  ctx.arc(m.sx, m.sy, dragging ? 9 : 8, 0, Math.PI * 2)
  ctx.fillStyle = PALETTE.uiPanelSolid
  ctx.fill()
  ctx.lineWidth = 2.5
  ctx.shadowColor = colour
  ctx.shadowBlur = 10
  ctx.stroke()
  ctx.shadowBlur = 0
  ctx.beginPath()
  ctx.arc(m.sx, m.sy, 3, 0, Math.PI * 2)
  ctx.fillStyle = colour
  ctx.fill()
  ctx.restore()
  if (v.tight) {
    const t = worldToScreen(v.tight.x, v.tight.z)
    ctx.save()
    ring(ctx, t.sx, t.sy, 12, PALETTE.uiBad, 2.5)
    ctx.restore()
    placePill(ctx, 'TOO TIGHT', t.sx, t.sy, [-26, 26, -50], PALETTE.uiBad)
  }
}

/**
 * Straight and Curve: the stretch that will change (dashed), the new road
 * there (a band the width of the road with a bright centreline: cyan when it
 * works, red when it is too tight), and the numbered spots you clicked.
 */
function drawShape(ctx: CanvasRenderingContext2D, sh: ShapeView, roadWidth: number): void {
  const colour = sh.ok ? PALETTE.uiAccent : PALETTE.uiBad
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  if (sh.old.length > 1) {
    ctx.strokeStyle = PALETTE.uiDim
    ctx.lineWidth = 2
    ctx.setLineDash([6, 6])
    line(ctx, sh.old, false)
    ctx.stroke()
    ctx.setLineDash([])
  }
  if (sh.preview.length > 1) {
    ctx.strokeStyle = colour
    ctx.globalAlpha = 0.22
    ctx.lineWidth = Math.max(6, roadWidth / view.mpp)
    line(ctx, sh.preview, false)
    ctx.stroke()
    ctx.globalAlpha = 1
    ctx.lineWidth = 2.5
    ctx.shadowColor = colour
    ctx.shadowBlur = 10
    ctx.stroke()
    ctx.shadowBlur = 0
  }
  if (sh.pull && sh.marks.length === 2) {
    // A thin line from each end to the pulled middle, so you can see what you are pulling.
    const p = worldToScreen(sh.pull.x, sh.pull.z)
    ctx.strokeStyle = PALETTE.uiDim
    ctx.lineWidth = 1
    ctx.setLineDash([3, 4])
    for (const mk of sh.marks) {
      const a = worldToScreen(mk.x, mk.z)
      ctx.beginPath()
      ctx.moveTo(a.sx, a.sy)
      ctx.lineTo(p.sx, p.sy)
      ctx.stroke()
    }
    ctx.setLineDash([])
    ctx.fillStyle = PALETTE.uiPanelSolid
    ctx.strokeStyle = colour
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(p.sx, p.sy - 8)
    ctx.lineTo(p.sx + 8, p.sy)
    ctx.lineTo(p.sx, p.sy + 8)
    ctx.lineTo(p.sx - 8, p.sy)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
  }
  sh.marks.forEach((mk, i) => {
    const { sx, sy } = worldToScreen(mk.x, mk.z)
    ctx.beginPath()
    ctx.arc(sx, sy, 9, 0, Math.PI * 2)
    ctx.fillStyle = PALETTE.uiPanelSolid
    ctx.fill()
    ctx.strokeStyle = PALETTE.uiAccent
    ctx.lineWidth = 2
    ctx.stroke()
    ctx.fillStyle = PALETTE.uiAccent
    ctx.font = `700 11px ${FONTS.body}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(i + 1), sx, sy + 0.5)
  })
  ctx.restore()
  if (sh.tight) {
    const t = worldToScreen(sh.tight.x, sh.tight.z)
    ring(ctx, t.sx, t.sy, 12, PALETTE.uiBad, 2.5)
    placePill(ctx, 'TOO TIGHT', t.sx, t.sy, [-26, 26, -50], PALETTE.uiBad)
  }
}

/** The road edges as two thin glowing lines, with the road between them darkened a little. */
function drawRoadOutline(ctx: CanvasRenderingContext2D, left: readonly P[], right: readonly P[], edge: string): void {
  ctx.save()
  ctx.lineJoin = 'round'
  ctx.beginPath()
  for (const ring of [left, right]) {
    for (let i = 0; i < ring.length; i++) {
      const { sx, sy } = worldToScreen(ring[i].x, ring[i].z)
      if (i === 0) ctx.moveTo(sx, sy)
      else ctx.lineTo(sx, sy)
    }
    ctx.closePath()
  }
  ctx.fillStyle = PALETTE.road
  ctx.globalAlpha = 0.6
  ctx.fill('evenodd')
  ctx.globalAlpha = 1
  ctx.strokeStyle = edge
  ctx.shadowColor = edge
  ctx.shadowBlur = 6
  ctx.lineWidth = 1.5
  line(ctx, left, true)
  ctx.stroke()
  line(ctx, right, true)
  ctx.stroke()
  ctx.restore()
}

/** Small arrowheads down the middle of the road every ~180 px, pointing the way you drive. */
function drawDirectionArrows(ctx: CanvasRenderingContext2D, curve: readonly P[]): void {
  const spacingPx = 180
  ctx.save()
  ctx.fillStyle = PALETTE.laneLine
  ctx.globalAlpha = 0.85
  let travelled = spacingPx / 2
  for (let i = 0; i < curve.length; i++) {
    const a = worldToScreen(curve[i].x, curve[i].z)
    const b = worldToScreen(curve[(i + 1) % curve.length].x, curve[(i + 1) % curve.length].z)
    const seg = Math.hypot(b.sx - a.sx, b.sy - a.sy)
    travelled += seg
    if (travelled < spacingPx || seg < 1e-3) continue
    travelled = 0
    if (a.sx < -20 || a.sy < -20 || a.sx > view.width + 20 || a.sy > view.height + 20) continue
    const ux = (b.sx - a.sx) / seg
    const uy = (b.sy - a.sy) / seg
    ctx.beginPath()
    ctx.moveTo(a.sx + ux * 6, a.sy + uy * 6)
    ctx.lineTo(a.sx - ux * 4 - uy * 4.5, a.sy - uy * 4 + ux * 4.5)
    ctx.lineTo(a.sx - ux * 1.5, a.sy - uy * 1.5)
    ctx.lineTo(a.sx - ux * 4 + uy * 4.5, a.sy - uy * 4 - ux * 4.5)
    ctx.closePath()
    ctx.fill()
  }
  ctx.restore()
}

function ring(ctx: CanvasRenderingContext2D, sx: number, sy: number, r: number, colour: string, width = 2): void {
  ctx.beginPath()
  ctx.arc(sx, sy, r, 0, Math.PI * 2)
  ctx.strokeStyle = colour
  ctx.lineWidth = width
  ctx.stroke()
}

function isPicked(sel: EditorState['selection'] | Pick | null, kind: Pick['kind'], index: number): boolean {
  return !!sel && sel.kind === kind && 'index' in sel && sel.index === index
}

function drawControlPoints(ctx: CanvasRenderingContext2D, points: readonly RoadPoint[], sel: EditorState['selection'], hover: Pick | null): void {
  const r = view.mpp < 0.5 ? 3.5 : 2.5
  ctx.save()
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const { sx, sy } = worldToScreen(p.x, p.z)
    if (sx < -10 || sy < -10 || sx > view.width + 10 || sy > view.height + 10) continue
    const picked = isPicked(sel, 'point', i)
    const hovered = isPicked(hover, 'point', i)
    ctx.beginPath()
    ctx.arc(sx, sy, picked || hovered ? r + 2 : r, 0, Math.PI * 2)
    ctx.fillStyle = picked ? PALETTE.uiAccent : p.lift ? PALETTE.wallRide : PALETTE.uiText
    ctx.fill()
    ctx.lineWidth = 1.5
    ctx.strokeStyle = PALETTE.uiPanelSolid
    ctx.stroke()
    if (picked) ring(ctx, sx, sy, r + 6, PALETTE.uiAccent, 1.5)
  }
  ctx.restore()
}

/** The start line: a chequered bar across the road, a label, and an arrow the way the race goes. */
function drawStartLine(ctx: CanvasRenderingContext2D, rc: RoadCurve, startAt: number, width: number): void {
  const f = frameAt(rc, startAt)
  const half = width / 2 + 1.5
  const p0 = worldToScreen(f.p.x - f.right.x * half, f.p.z - f.right.z * half)
  const p1 = worldToScreen(f.p.x + f.right.x * half, f.p.z + f.right.z * half)
  const barPx = Math.hypot(p1.sx - p0.sx, p1.sy - p0.sy)
  ctx.save()
  const grow = Math.max(1, 18 / Math.max(1, barPx))
  const mx = (p0.sx + p1.sx) / 2
  const my = (p0.sy + p1.sy) / 2
  const ex = ((p1.sx - p0.sx) / 2) * grow
  const ey = ((p1.sy - p0.sy) / 2) * grow
  const cells = 8
  for (let k = 0; k < cells; k++) {
    const t0 = k / cells
    const t1 = (k + 1) / cells
    ctx.beginPath()
    ctx.moveTo(mx - ex + 2 * ex * t0, my - ey + 2 * ey * t0)
    ctx.lineTo(mx - ex + 2 * ex * t1, my - ey + 2 * ey * t1)
    ctx.lineWidth = 6
    ctx.strokeStyle = k % 2 ? PALETTE.uiPanelSolid : PALETTE.uiText
    ctx.stroke()
  }
  const ux = f.dir.x
  const uy = f.dir.z
  const tip = { x: mx + ux * 34, y: my + uy * 34 }
  ctx.strokeStyle = PALETTE.uiAccent
  ctx.fillStyle = PALETTE.uiAccent
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.moveTo(mx + ux * 8, my + uy * 8)
  ctx.lineTo(tip.x, tip.y)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(tip.x + ux * 4, tip.y + uy * 4)
  ctx.lineTo(tip.x - ux * 8 - uy * 7, tip.y - uy * 8 + ux * 7)
  ctx.lineTo(tip.x - ux * 8 + uy * 7, tip.y - uy * 8 - ux * 7)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
  placePill(ctx, 'START', mx - ux * 30 - uy * 26, my - uy * 30 + ux * 26, [0, 24, -24, 48], PALETTE.uiText)
}

/** Each raised stretch (a bridge) gets one label beside its highest point. */
function drawBridges(ctx: CanvasRenderingContext2D, points: readonly RoadPoint[]): void {
  const n = points.length
  const raised = (i: number) => (points[((i % n) + n) % n].lift ?? 0) >= 1
  for (let i = 0; i < n; i++) {
    if (!raised(i) || raised(i - 1)) continue
    let top = i
    let count = 0
    while (raised(i + count) && count < n) {
      if ((points[(i + count) % n].lift ?? 0) > (points[top % n].lift ?? 0)) top = i + count
      count++
    }
    const p = points[top % n]
    const q = points[(top + 1) % n]
    const len = Math.hypot(q.x - p.x, q.z - p.z) || 1
    const { sx, sy } = worldToScreen(p.x, p.z)
    placePill(ctx, `BRIDGE ${Math.round(p.lift ?? 0)} m`, sx + (-(q.z - p.z) / len) * 30, sy + ((q.x - p.x) / len) * 30, [0, 24, -24], PALETTE.wallRide)
  }
}

/** Stretches with a bank override: an amber line along the road and the angle, once per stretch. */
function drawBankOverrides(ctx: CanvasRenderingContext2D, rc: RoadCurve, points: readonly RoadPoint[]): void {
  const n = points.length
  const has = (i: number) => points[((i % n) + n) % n].bank !== undefined
  ctx.save()
  ctx.strokeStyle = PALETTE.chevron
  ctx.lineWidth = 3
  ctx.setLineDash([6, 5])
  for (let i = 0; i < n; i++) {
    if (!has(i) || has(i - 1)) continue
    let count = 0
    while (has(i + count) && count < n) count++
    const from = i - 0.5
    const to = i + count - 0.5
    const pts: P[] = []
    for (let f = Math.ceil(from * PER); f <= Math.floor(to * PER); f++) pts.push(rc.curve[((f % rc.curve.length) + rc.curve.length) % rc.curve.length])
    line(ctx, pts, false)
    ctx.stroke()
    const mid = frameAt(rc, i + (count - 1) / 2)
    const { sx, sy } = worldToScreen(mid.p.x, mid.p.z)
    ctx.setLineDash([])
    pill(ctx, `BANK ${points[(i + Math.floor((count - 1) / 2)) % n].bank}°`, sx - mid.right.x * 34, sy - mid.right.z * 34, PALETTE.chevron)
    ctx.setLineDash([6, 5])
  }
  ctx.restore()
}

/** The selected section: a bright band along the road with an end cap at each end. */
function drawSection(ctx: CanvasRenderingContext2D, rc: RoadCurve, from: number, to: number): void {
  const count = rc.points.length
  const f0 = wrapAt(from, count) * PER
  let f1 = wrapAt(to, count) * PER
  if (f1 < f0) f1 += rc.curve.length
  const pts: P[] = [frameAt(rc, from).p]
  for (let f = Math.ceil(f0); f <= Math.floor(f1); f++) pts.push(rc.curve[f % rc.curve.length])
  pts.push(frameAt(rc, to).p)
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = PALETTE.uiAccent
  ctx.globalAlpha = 0.35
  ctx.lineWidth = Math.max(10, 18 / view.mpp)
  line(ctx, pts, false)
  ctx.stroke()
  ctx.globalAlpha = 1
  ctx.lineWidth = 2
  ctx.stroke()
  for (const at of [from, to]) {
    const f = frameAt(rc, at)
    const a = worldToScreen(f.p.x - f.right.x * 12, f.p.z - f.right.z * 12)
    const b = worldToScreen(f.p.x + f.right.x * 12, f.p.z + f.right.z * 12)
    ctx.beginPath()
    ctx.moveTo(a.sx, a.sy)
    ctx.lineTo(b.sx, b.sy)
    ctx.lineWidth = 3
    ctx.stroke()
  }
  ctx.restore()
}

// ---------------------------------------------------------------- pieces, props, cores

/** Screen position of each road piece's icon (for drawing and picking). */
export function pieceScreen(rc: RoadCurve, p: Piece): { sx: number; sy: number; dir: P; right: P; centre: P } {
  const place = piecePlace(rc, p)
  const { sx, sy } = worldToScreen(place.p.x, place.p.z)
  return { sx, sy, dir: place.dir, right: place.right, centre: place.p }
}

function drawPieces(ctx: CanvasRenderingContext2D, rc: RoadCurve, pieces: readonly Piece[], roadWidth: number, sel: EditorState['selection'], hover: Pick | null): void {
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i]
    const colour = pieceColour(p)
    if (p.type === 'wallride') drawWallRide(ctx, rc, p.at, p.length ?? TRACK_DEFAULTS.wallride.length, p.side, roadWidth)
    const at = pieceScreen(rc, p)
    drawPieceIcon(ctx, p.type === 'wallride' ? (p.side === 'both' ? 'wallride-both' : p.side === 'left' ? 'wallride-left' : 'wallride-right') : p.type, at.sx, at.sy, at.dir, pieceFootprint(p, roadWidth), colour, 1)
    if (isPicked(sel, 'piece', i)) ring(ctx, at.sx, at.sy, 20, PALETTE.uiText, 2)
    else if (isPicked(hover, 'piece', i)) ring(ctx, at.sx, at.sy, 18, PALETTE.uiDim, 1.5)
  }
}

function drawWallRide(ctx: CanvasRenderingContext2D, rc: RoadCurve, at: number, length: number, side: 'left' | 'right' | 'both', roadWidth: number): void {
  const steps = 24
  ctx.save()
  ctx.strokeStyle = PALETTE.wallRide
  ctx.shadowColor = PALETTE.wallRide
  ctx.shadowBlur = 8
  ctx.lineWidth = 5
  ctx.lineCap = 'round'
  for (const sign of side === 'both' ? [-1, 1] : side === 'left' ? [-1] : [1]) {
    const pts: P[] = []
    for (let k = 0; k <= steps; k++) {
      const f = frameAt(rc, advanceAt(rc, at, (length * k) / steps))
      const off = sign * (roadWidth / 2 + 1)
      pts.push({ x: f.p.x + f.right.x * off, z: f.p.z + f.right.z * off })
    }
    line(ctx, pts, false)
    ctx.stroke()
  }
  ctx.restore()
}

/**
 * One piece icon at a screen point, turned to the road direction. Drawn at
 * its real size when zoomed in, and never smaller than a readable icon.
 */
export function drawPieceIcon(ctx: CanvasRenderingContext2D, kind: PlaceKind, sx: number, sy: number, dir: P, size: { length: number; width: number }, colour: string, alpha: number): void {
  const L = Math.max(16, size.length / view.mpp)
  const W = Math.max(10, size.width / view.mpp)
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.translate(sx, sy)
  ctx.rotate(Math.atan2(dir.z, dir.x))
  ctx.fillStyle = PALETTE.uiPanelSolid
  ctx.strokeStyle = colour
  ctx.lineWidth = 2
  ctx.shadowColor = colour
  ctx.shadowBlur = 10
  switch (kind) {
    case 'boost': {
      ctx.beginPath()
      ctx.roundRect(-L / 2, -W / 2, L, W, 3)
      ctx.fill()
      ctx.stroke()
      ctx.fillStyle = colour
      for (const o of [-L / 4, L / 8]) {
        ctx.beginPath()
        ctx.moveTo(o, -W * 0.3)
        ctx.lineTo(o + W * 0.35, 0)
        ctx.lineTo(o, W * 0.3)
        ctx.lineTo(o + W * 0.12, 0)
        ctx.closePath()
        ctx.fill()
      }
      break
    }
    case 'ramp': {
      ctx.beginPath()
      ctx.moveTo(-L / 2, -W / 2)
      ctx.lineTo(L / 2, -W / 2)
      ctx.lineTo(L / 2, W / 2)
      ctx.lineTo(-L / 2, W / 2)
      ctx.closePath()
      ctx.fill()
      ctx.stroke()
      // The lip, at the far end.
      ctx.beginPath()
      ctx.moveTo(L / 2 - 3, -W / 2)
      ctx.lineTo(L / 2 - 3, W / 2)
      ctx.lineWidth = 4
      ctx.stroke()
      break
    }
    case 'loop': {
      ctx.beginPath()
      ctx.ellipse(0, 0, L / 2, Math.max(8, W / 2), 0, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
      ctx.beginPath()
      ctx.ellipse(0, 0, L / 2 - 4, Math.max(4, W / 2 - 4), 0, 0, Math.PI * 2)
      ctx.stroke()
      break
    }
    case 'speedtrap': {
      ctx.beginPath()
      ctx.moveTo(0, -W / 2 - 2)
      ctx.lineTo(0, W / 2 + 2)
      ctx.lineWidth = 4
      ctx.stroke()
      break
    }
    case 'start': {
      ctx.beginPath()
      ctx.moveTo(0, -W / 2)
      ctx.lineTo(0, W / 2)
      ctx.lineWidth = 5
      ctx.strokeStyle = PALETTE.uiText
      ctx.stroke()
      break
    }
    default: {
      // Wall rides: a badge on the road (the walls themselves are drawn along the edge).
      ctx.beginPath()
      ctx.arc(0, 0, 8, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
    }
  }
  ctx.restore()
}

function drawProps(ctx: CanvasRenderingContext2D, props: EditorState['draft']['props'], sel: EditorState['selection'], hover: Pick | null): void {
  for (let i = 0; i < props.length; i++) {
    const p = props[i]
    const { sx, sy } = worldToScreen(p.x, p.z)
    drawPropIcon(ctx, sx, sy, p.size ?? 'medium', 1)
    if (isPicked(sel, 'prop', i)) ring(ctx, sx, sy, 17, PALETTE.uiText, 2)
    else if (isPicked(hover, 'prop', i)) ring(ctx, sx, sy, 15, PALETTE.uiDim, 1.5)
  }
}

export function drawPropIcon(ctx: CanvasRenderingContext2D, sx: number, sy: number, size: 'small' | 'medium' | 'large', alpha: number): void {
  const s = size === 'small' ? 4 : size === 'large' ? 6 : 5
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.shadowBlur = 8
  const boxes: [number, number, string][] = [
    [-s - 1, -1, PALETTE.propCrate],
    [s + 1, 1, PALETTE.propCube],
    [0, -s - 2, PALETTE.propCrate],
  ]
  for (const [dx, dy, c] of boxes) {
    ctx.shadowColor = c
    ctx.fillStyle = PALETTE.uiPanelSolid
    ctx.strokeStyle = c
    ctx.lineWidth = 1.8
    ctx.beginPath()
    ctx.rect(sx + dx - s, sy + dy - s, s * 2, s * 2)
    ctx.fill()
    ctx.stroke()
  }
  ctx.restore()
}

function drawCores(ctx: CanvasRenderingContext2D, cores: EditorState['draft']['cores'], sel: EditorState['selection'], hover: Pick | null): void {
  for (let i = 0; i < cores.length; i++) {
    const c = cores[i]
    const { sx, sy } = worldToScreen(c.x, c.z)
    drawCoreIcon(ctx, sx, sy, 1)
    if (isPicked(sel, 'core', i)) ring(ctx, sx, sy, 15, PALETTE.uiText, 2)
    else if (isPicked(hover, 'core', i)) ring(ctx, sx, sy, 13, PALETTE.uiDim, 1.5)
  }
}

export function drawCoreIcon(ctx: CanvasRenderingContext2D, sx: number, sy: number, alpha: number): void {
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.shadowColor = PALETTE.core
  ctx.shadowBlur = 12
  ctx.fillStyle = PALETTE.core
  ctx.beginPath()
  ctx.moveTo(sx, sy - 8)
  ctx.lineTo(sx + 6, sy)
  ctx.lineTo(sx, sy + 8)
  ctx.lineTo(sx - 6, sy)
  ctx.closePath()
  ctx.fill()
  ctx.fillStyle = PALETTE.coreHot
  ctx.beginPath()
  ctx.arc(sx, sy, 2.2, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

/** Place tool: a see-through preview of what a click would drop. */
function drawGhost(ctx: CanvasRenderingContext2D, ghost: NonNullable<MapExtras['ghost']>, roadWidth: number): void {
  const { sx, sy } = worldToScreen(ghost.at.x, ghost.at.z)
  if (ghost.kind === 'props') return drawPropIcon(ctx, sx, sy, 'medium', 0.55)
  if (ghost.kind === 'cores') return drawCoreIcon(ctx, sx, sy, 0.55)
  const sizes: Record<string, { length: number; width: number }> = {
    boost: { length: TRACK_DEFAULTS.boost.length, width: TRACK_DEFAULTS.boost.width },
    ramp: { length: TRACK_DEFAULTS.ramp.length, width: TRACK_DEFAULTS.ramp.width },
    loop: { length: TRACK_DEFAULTS.loopRadius * 2, width: roadWidth },
    speedtrap: { length: 2, width: roadWidth + 2 },
    start: { length: 2, width: roadWidth + 3 },
  }
  drawPieceIcon(ctx, ghost.kind, sx, sy, ghost.dir, sizes[ghost.kind] ?? { length: 16, width: roadWidth }, toolFor(ghost.kind).colour, 0.55)
}

// ---------------------------------------------------------------- pins, scale, compass

/**
 * Pins for clean-up notes, validator warnings and the game's track checks (checks.ts)
 * that point at a place. A failing check also gets a short red tag beside its pin.
 */
function drawPins(ctx: CanvasRenderingContext2D, s: EditorState, rc: RoadCurve): void {
  const pins: { at: P; tone: 'warn' | 'bad' | 'note'; label?: string }[] = []
  // Only while the checks are about the road on screen (not mid-drag, not the world map).
  if (s.gates && s.checkedDraft === s.draft && s.preview !== 'pending') {
    for (const it of gateItems(s.gates, s.draft, rc)) {
      if (it.at && it.tone !== 'note') pins.push({ at: it.at, tone: it.tone, label: it.label })
    }
  }
  for (const issue of s.notes?.issues ?? []) {
    if (issue.at && issue.code !== 'bridged') pins.push({ at: issue.at, tone: issue.level === 'warning' ? 'warn' : issue.level === 'error' ? 'bad' : 'note' })
  }
  for (const w of s.warnings) {
    const at = issueLocation(w.path, s.draft, rc)
    if (at) pins.push({ at, tone: 'warn' })
  }
  for (const e of s.errors) {
    const at = issueLocation(e.path, s.draft, rc)
    if (at) pins.push({ at, tone: 'bad' })
  }
  // The most serious on top: a red pin must never hide under an amber one at the same spot.
  const rank = { note: 0, warn: 1, bad: 2 }
  pins.sort((a, b) => rank[a.tone] - rank[b.tone])
  ctx.save()
  for (const pin of pins) {
    const { sx, sy } = worldToScreen(pin.at.x, pin.at.z)
    const colour = pin.tone === 'bad' ? PALETTE.uiBad : pin.tone === 'warn' ? PALETTE.uiWarn : PALETTE.uiDim
    // Offset up-right so the pin never hides the thing it is about.
    const px = pin.tone === 'note' ? sx : sx + 16
    const py = pin.tone === 'note' ? sy : sy - 16
    ctx.beginPath()
    ctx.arc(px, py, pin.tone === 'note' ? 5 : 9, 0, Math.PI * 2)
    ctx.fillStyle = PALETTE.uiPanelSolid
    ctx.fill()
    ctx.lineWidth = 2
    ctx.strokeStyle = colour
    ctx.stroke()
    if (pin.tone !== 'note') {
      ctx.fillStyle = colour
      ctx.font = `700 12px ${FONTS.body}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('!', px, py + 0.5)
    }
  }
  ctx.restore()
  // Tags after every pin, so each one can step around the others.
  for (const pin of pins) {
    if (!pin.label) continue
    const { sx, sy } = worldToScreen(pin.at.x, pin.at.z)
    placePill(ctx, pin.label, sx + 16, sy - 16, [-24, 24, -48, 48], PALETTE.uiBad)
  }
}

/** Where on the map a validator message is about ("road.points[3]", "pieces[2]", "props[0]"...). */
export function issueLocation(path: string, d: EditorState['draft'], rc?: RoadCurve): P | null {
  const m = /^(road\.points|pieces|props|cores)\[(\d+)\]/.exec(path)
  if (!m) return null
  const i = Number(m[2])
  if (m[1] === 'road.points') {
    const p = d.points[i]
    return p ? { x: p.x, z: p.z } : null
  }
  if (m[1] === 'pieces') {
    const p = d.pieces[i]
    if (!p) return null
    return piecePlace(rc ?? roadCurve(d.points), p).p
  }
  const spot = m[1] === 'props' ? d.props[i] : d.cores[i]
  return spot ? { x: spot.x, z: spot.z } : null
}

function drawScaleBar(ctx: CanvasRenderingContext2D): void {
  const choices = [10, 20, 50, 100, 200, 500, 1000]
  let metres = choices[choices.length - 1]
  for (const c of choices) {
    if (c / view.mpp >= 80) {
      metres = c
      break
    }
  }
  const px = metres / view.mpp
  const x = 96
  const y = view.height - 28
  ctx.save()
  ctx.strokeStyle = PALETTE.uiText
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(x, y - 6)
  ctx.lineTo(x, y)
  ctx.lineTo(x + px, y)
  ctx.lineTo(x + px, y - 6)
  ctx.stroke()
  ctx.font = `600 12px ${FONTS.body}`
  ctx.fillStyle = PALETTE.uiText
  ctx.textBaseline = 'bottom'
  ctx.fillText(metres >= 1000 ? `${metres / 1000} km` : `${metres} m`, x + px + 8, y + 2)
  ctx.restore()
}

function drawCompass(ctx: CanvasRenderingContext2D): void {
  const x = view.width - 412
  const y = 40
  ctx.save()
  ctx.fillStyle = PALETTE.uiPanel
  ctx.beginPath()
  ctx.arc(x, y, 18, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = PALETTE.uiLine
  ctx.stroke()
  ctx.fillStyle = PALETTE.uiAccent2
  ctx.beginPath()
  ctx.moveTo(x, y - 13)
  ctx.lineTo(x - 5, y)
  ctx.lineTo(x + 5, y)
  ctx.closePath()
  ctx.fill()
  ctx.fillStyle = PALETTE.uiText
  ctx.font = `700 11px ${FONTS.body}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('N', x, y + 8)
  ctx.restore()
}

function drawReadout(ctx: CanvasRenderingContext2D, hover: P): void {
  ctx.save()
  ctx.font = `500 12px ${FONTS.mono}`
  ctx.fillStyle = PALETTE.uiDim
  ctx.textBaseline = 'bottom'
  ctx.fillText(`x ${hover.x.toFixed(0)}  z ${hover.z.toFixed(0)}`, 96, view.height - 44)
  ctx.restore()
}

// ---------------------------------------------------------------- world map extras

/** Names beside every piece, prop pile and core (the world map is for reading, not editing). */
function drawLabels(ctx: CanvasRenderingContext2D, s: EditorState, rc: RoadCurve): void {
  const d = s.draft
  const label = (text: string, p: P, colour: string, dy: number) => {
    const { sx, sy } = worldToScreen(p.x, p.z)
    if (sx < -60 || sy < -30 || sx > view.width + 60 || sy > view.height + 30) return
    placePill(ctx, text, sx, sy, [dy, -dy, dy * 2, -dy * 2, dy * 3], colour)
  }
  for (const p of d.pieces) label(pieceLabel(p).toUpperCase(), piecePlace(rc, p).p, pieceColour(p), -26)
  for (const p of d.props) label('CRASH PROPS', p, PALETTE.propCrate, -24)
  d.cores.forEach((c, i) => label(`CORE ${i + 1}`, c, PALETTE.core, -20))
}

/** Every car: the player as a big cyan arrow with a "YOU" tag, the others as small coloured arrows. */
/** A car's local +z axis in world space, seen from above (x, z). */
function localZ(q: { x: number; y: number; z: number; w: number }): { x: number; z: number } {
  return { x: 2 * (q.x * q.z + q.w * q.y), z: 1 - 2 * (q.x * q.x + q.y * q.y) }
}

function drawCars(ctx: CanvasRenderingContext2D): void {
  // Which way is "forward" in a car's own space? Ask the player's car, whose forward we know.
  let sign = 1
  for (let i = 0; i < cars.length; i++) {
    if (cars[i].kind !== 'player') continue
    const z = localZ(cars[i].quaternion)
    sign = z.x * telemetry.carForward.x + z.z * telemetry.carForward.z >= 0 ? 1 : -1
  }
  for (let i = 0; i < cars.length; i++) {
    const c = cars[i]
    if (c.kind === 'ghost') continue
    const { sx, sy } = worldToScreen(c.position.x, c.position.z)
    const f = localZ(c.quaternion)
    const len = Math.hypot(f.x, f.z) || 1
    const ux = (sign * f.x) / len
    const uy = (sign * f.z) / len
    const player = c.kind === 'player'
    const size = player ? 11 : 7
    ctx.save()
    ctx.fillStyle = player ? PALETTE.uiAccent : c.glow
    ctx.shadowColor = ctx.fillStyle
    ctx.shadowBlur = player ? 14 : 6
    ctx.strokeStyle = PALETTE.uiPanelSolid
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(sx + ux * size, sy + uy * size)
    ctx.lineTo(sx - ux * size * 0.8 - uy * size * 0.7, sy - uy * size * 0.8 + ux * size * 0.7)
    ctx.lineTo(sx - ux * size * 0.4, sy - uy * size * 0.4)
    ctx.lineTo(sx - ux * size * 0.8 + uy * size * 0.7, sy - uy * size * 0.8 - ux * size * 0.7)
    ctx.closePath()
    ctx.stroke()
    ctx.fill()
    ctx.restore()
    if (player) placePill(ctx, 'YOU', sx, sy, [24, -24, 46, -46], PALETTE.uiAccent)
  }
}
