// ============================================================
//  MAP DRAWING - every mark the editor draws over the 3D world
// ------------------------------------------------------------
//  The 3D view under the editor is the real track. On top of it this
//  draws, in crisp screen pixels, what a map needs: the road outline
//  when zoomed out, which way you drive, the start line, bridges
//  (a BRIDGE label at every crossing: click it to pick which road
//  goes over),
//  every piece as an icon, props and cores, the stunt park's zones
//  (world map only), what is selected, and
//  pins on anything the game wants you to check (the Checks list's
//  rows, problems.ts; a failing one gets a red tag by its pin, and a
//  click on a pin or its tag selects that problem).
//  The shaping tools draw their previews here too: the stretch Bend
//  will move (brightest at your hand), and Straight or Curve's new road
//  before the last click (cyan when it works, red when too tight). So
//  does the pencil, while you draw: the stretch a redraw replaces lit
//  amber with your new line bright cyan, or, when letting go would not
//  change anything, a grey dashed line and a tag saying what to do.
//
//  In the 3D view the same drawing goes on the real road: every spot
//  is placed through look3dSpace.ts (on the road, at the right height,
//  the right road at a crossing), the wide bands are laid between the
//  road's real edges, and labels stay flat to the screen so they read
//  from any angle. What only makes sense looking straight down (the
//  road's outline, the arrows, the scale bar) waits for the map, and
//  the problem pins are look3dMarks.tsx's (on stalks).
//
//  Overlay.tsx calls drawMap() whenever something changed. Nothing
//  here changes any state.
// ============================================================

import { FONTS, PALETTE } from '../core/palette'
import { play } from '../core/api'
import { cars, telemetry } from '../core/telemetry'
import { TRACK_DEFAULTS, type Piece, type RoadPoint } from '../track/schema'
import type { BendView, EditorState } from './draft'
import { BRIDGE_GAP, type RoadCrossing, bridgeShape } from './bridges'
import type { StretchMarks, StretchRun } from './stretchRuns'
import { NO_NOTES, problemsOf } from './problems'
import { type P } from './geom'
import { pieceColour, pieceFootprint, pieceLabel, piecePlace, toolFor, type PlaceKind } from './pieces'
import { type RedrawPlan, type RoadCurve, PER, advanceAt, frameAt, metresBetween, roadCurve, wrapAt } from './road'
import { roadLine, stretchOf } from './shape'
import { view } from './view'
import { in3d, mppAt, pointToScreen, screenDir, viewMpp, worldToScreen } from './look3dSpace'
import { WALL_RAMP, WALL_REACH } from '../track/road'
import { TUNNEL_WALL } from '../track/tunnels'
import { smoothstep } from '../track/noise'

/** What can be picked on the map. */
export type Pick =
  | { kind: 'piece'; index: number }
  | { kind: 'prop'; index: number }
  | { kind: 'core'; index: number }
  | { kind: 'point'; index: number }
  | { kind: 'crossing'; x: number; z: number }

export interface MapExtras {
  /** The pencil line being drawn right now (world points). */
  stroke: readonly P[]
  hover: P | null
  /** Place tool: where the thing would go if you clicked now (a wall ride: the whole wall, see GhostWall). */
  ghost: { kind: PlaceKind; at: P; dir: P; wall?: GhostWall; tunnel?: GhostTunnel } | null
  /** Select tool: the thing under the pointer. */
  hoverPick: Pick | null
  /** Where the road crosses itself, and which road is on top (bridges.ts roadCrossings). */
  crossings: readonly RoadCrossing[]
  /** Bend tool: the stretch that would move (hovering) or is moving (dragging). */
  bend?: { view: BendView; dragging: boolean } | null
  /** Straight and Curve: the spots clicked, the stretch that will change and the new road there. */
  shape?: ShapeView | null
  /** Pencil with a steady hand: the pen (where the line is) and the pointer it trails behind. */
  pen?: { at: P; to: P } | null
  /** Pencil: what letting go now would do ('new': the line becomes the road on an empty map). */
  pencil?: RedrawPlan | 'new' | null
  /** The stretches changed by Height, Bank and Width (stretchRuns.ts): marked, labelled and clickable. */
  marks?: StretchMarks | null
  /** Tunnels whose whole footprint shows: the Tunnel tool's ghost, a selected tunnel, the Height panel's preview (draft.ts tunnelFootprints). */
  tunnels?: readonly TunnelFootprint[]
  /** Height, Bank or Width, pointer over the road: the stretch a click there would pick, and its words. */
  stretchHover?: { from: number; to: number; label: string } | null
}

/** Place tool, a wall ride picked: the wall ride a click (or the drag so far) would place. */
export interface GhostWall {
  /** Where it starts and how long it is, as it would be stored. */
  at: number
  length: number
  side: 'left' | 'right' | 'both'
  /** While dragging: the stretch dragged so far (drawn like the Bank tool's pick). Null while just hovering. */
  dragged: { from: number; to: number } | null
  /** The drag was too short or too long, so the wall ride sits on its middle at the nearest allowed length. */
  cut: 'short' | 'long' | null
}

/**
 * A tunnel's whole footprint (draft.ts tunnelFootprints): the covered part from `at` for `length`
 * metres, the ramp down before it and the ramp up after it, whether it fits, and if not, why (in
 * Josh's words), what to try, and where on the road the thing in the way is.
 */
export interface TunnelFootprint {
  at: number
  length: number
  rampIn: number
  rampOut: number
  ok: boolean
  why: string | null
  hint: string | null
  blocker: { from: number; to: number } | null
  /** Draw the covered part too (the Height panel's preview; the ghost and a placed tunnel have theirs). */
  covered: boolean
  /** Where to put the reason's pill (the pointer), if anywhere. */
  pill: P | null
}

/** Place tool, Tunnel: the stretch a click (or the drag so far) would cover. */
export interface GhostTunnel {
  at: number
  length: number
  /** The drag was too short or too long, so it sits on the drag's middle at the nearest allowed length. */
  cut: 'short' | 'long' | null
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
  const mpp = viewMpp()
  return s.tool === 'select' ? mpp < 2.2 : mpp < 0.7
}

// ---------------------------------------------------------------- the whole map

/** Screen boxes of every label drawn this frame, so later labels can step around them. */
let labelBoxes: { x0: number; y0: number; x1: number; y1: number }[] = []

/** A label that steps out of the way of labels already drawn: tries each offset in turn. Returns its box (or null if it found no room). */
function placePill(ctx: CanvasRenderingContext2D, text: string, sx: number, sy: number, offsets: readonly number[], colour: string): { x0: number; y0: number; x1: number; y1: number } | null {
  ctx.save()
  ctx.font = `600 12px ${FONTS.body}`
  const w = ctx.measureText(text).width + 14
  ctx.restore()
  for (const off of offsets) {
    const r = { x0: sx - w / 2 - 2, y0: sy + off - 12, x1: sx + w / 2 + 2, y1: sy + off + 12 }
    if (labelBoxes.some((q) => r.x0 < q.x1 && r.x1 > q.x0 && r.y0 < q.y1 && r.y1 > q.y0)) continue
    labelBoxes.push(r)
    pill(ctx, text, sx, sy + off, colour)
    return r
  }
  return null
}

export function drawMap(ctx: CanvasRenderingContext2D, s: EditorState, x: MapExtras): void {
  const d = s.draft
  labelBoxes = []
  ctx.clearRect(0, 0, view.width, view.height)
  const g = roadGeometry(d.points, d.width)

  if (g.rc.curve.length) {
    // Zoomed out, the 3D road's light strips get thinner than a pixel, so the map draws its outline.
    // While bending, the 3D road waits for you to let go, so the outline shows the road as it is now.
    // (In 3D the real road is right there: an outline only while bending, when the real road waits for you to let go.)
    if ((!in3d() && view.mpp > 0.55) || x.bend?.dragging) drawRoadOutline(ctx, g.left, g.right, d.environment.palette?.edge ?? PALETTE.roadEdge)
    markTargets = []
    if (x.marks) {
      drawRaisedRuns(ctx, g.rc, x.marks.raised, x.crossings, s.mode === 'edit')
      drawWidthRuns(ctx, g, x.marks.width, s.mode === 'edit')
      drawBankRuns(ctx, g.rc, x.marks.bank, s.mode === 'edit')
    }
    if (x.stretchHover) drawStretchHover(ctx, g.rc, x.stretchHover, d.width)
    if (s.selection?.kind === 'section') drawSection(ctx, g.rc, s.selection.from, s.selection.to)
    if (x.bend) drawBend(ctx, x.bend.view, x.bend.dragging, d.width)
    if (x.shape) drawShape(ctx, x.shape, d.width)
    if (!in3d()) drawDirectionArrows(ctx, g.rc.curve)
    drawBridges(ctx, d.points, x.crossings, d.width, s.mode === 'edit' && s.selection?.kind === 'crossing' ? s.selection : null, x.hoverPick?.kind === 'crossing' ? x.hoverPick : null)
    drawPieces(ctx, g.rc, d.pieces, d.width, s.selection, x.hoverPick)
    drawStartLine(ctx, g.rc, d.startAt, d.width)
    if (pointsVisible(s)) drawControlPoints(ctx, d.points, s.selection, x.hoverPick, x.marks?.raisedPoint ?? null)
  }
  drawProps(ctx, d.props, s.selection, x.hoverPick)
  drawCores(ctx, d.cores, s.selection, x.hoverPick)
  if (x.ghost) drawGhost(ctx, x.ghost, d.width, g.rc)
  if (x.tunnels && g.rc.curve.length) for (const f of x.tunnels) drawTunnelFootprint(ctx, g.rc, f, d.width)
  if (s.mode === 'map') {
    drawParkZones(ctx)
    drawLabels(ctx, s, g.rc)
    drawCars(ctx)
  }
  // In 3D the pins stand on stalks (look3dMarks.tsx), and say where they were drawn (setPinTargets3d).
  if (!in3d()) drawPins(ctx, s, g.rc)
  if (x.stroke.length > 1) drawStroke(ctx, x.stroke, x.pencil ?? null, d.width, x.pen?.to ?? x.stroke[x.stroke.length - 1])
  if (x.pen) drawPen(ctx, x.pen.at, x.pen.to)
  if (!in3d()) drawScaleBar(ctx)
  if (x.hover) drawReadout(ctx, x.hover)
}

// ---------------------------------------------------------------- shapes

function line(ctx: CanvasRenderingContext2D, pts: readonly P[], closed: boolean): void {
  ctx.beginPath()
  const on3d = in3d()
  let pen = false
  for (let i = 0; i < pts.length; i++) {
    // In 3D each spot sits on the road the line runs along (heading its way), or the ground; a spot the
    // mouse picked (the pencil's line) right where it was picked.
    const { sx, sy } = pointToScreen(pts[i], on3d ? headingAt(pts, i) : null)
    if (!Number.isFinite(sx) || !Number.isFinite(sy)) {
      // Behind the 3D camera: the line breaks here and starts again where it comes back.
      pen = false
      continue
    }
    if (!pen) ctx.moveTo(sx, sy)
    else ctx.lineTo(sx, sy)
    pen = true
  }
  if (closed) ctx.closePath()
}

/** Which way the line through pts heads at its point i (the 3D view finds that road's height). */
function headingAt(pts: readonly P[], i: number): P {
  const a = pts[Math.max(0, i - 1)]
  const b = pts[Math.min(pts.length - 1, i + 1)]
  return { x: b.x - a.x, z: b.z - a.z }
}

/**
 * A band `metres` wide along pts, in the current stroke colour and alpha: on the map a thick
 * line (never thinner than `minPx`); in 3D laid on the road, its sides where the road's sides
 * really are, so it follows hills, banks and bridges (never thinner than `minPx` on screen
 * either). Either way the band's middle line is left as the current path, so a caller can
 * stroke a crisp centre line over it next.
 */
function wideLine(ctx: CanvasRenderingContext2D, pts: readonly P[], metres: number, minPx: number): void {
  if (!in3d()) {
    ctx.lineWidth = Math.max(minPx, metres / view.mpp)
    line(ctx, pts, false)
    ctx.stroke()
    return
  }
  const half = metres / 2
  const left: { sx: number; sy: number }[] = []
  const right: { sx: number; sy: number }[] = []
  const fill = () => {
    if (left.length > 1) {
      ctx.beginPath()
      ctx.moveTo(left[0].sx, left[0].sy)
      for (let k = 1; k < left.length; k++) ctx.lineTo(left[k].sx, left[k].sy)
      for (let k = right.length - 1; k >= 0; k--) ctx.lineTo(right[k].sx, right[k].sy)
      ctx.closePath()
      ctx.fill()
    }
    left.length = 0
    right.length = 0
  }
  ctx.save()
  ctx.fillStyle = ctx.strokeStyle
  for (let i = 0; i < pts.length; i++) {
    const h = headingAt(pts, i)
    const hl = Math.hypot(h.x, h.z) || 1
    const rx = -h.z / hl
    const rz = h.x / hl
    const p = pts[i]
    const c = worldToScreen(p.x, p.z, h)
    const l = worldToScreen(p.x - rx * half, p.z - rz * half, h)
    const r = worldToScreen(p.x + rx * half, p.z + rz * half, h)
    if (!Number.isFinite(c.sx + c.sy + l.sx + l.sy + r.sx + r.sy)) {
      fill()
      continue
    }
    // Never thinner than minPx: far away, widen it about its middle.
    const wx = r.sx - l.sx
    const wy = r.sy - l.sy
    const w = Math.hypot(wx, wy)
    if (w < minPx) {
      const ux = w > 1e-6 ? wx / w : 1
      const uy = w > 1e-6 ? wy / w : 0
      l.sx = c.sx - (ux * minPx) / 2
      l.sy = c.sy - (uy * minPx) / 2
      r.sx = c.sx + (ux * minPx) / 2
      r.sy = c.sy + (uy * minPx) / 2
    }
    left.push(l)
    right.push(r)
  }
  fill()
  ctx.restore()
  line(ctx, pts, false)
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

/** What the pencil's tag says when letting go would change nothing (road.ts planRedraw's reasons). */
const PENCIL_TAGS: Record<'start' | 'end' | 'together', string> = {
  start: 'START ON THE ROAD',
  end: 'END ON THE ROAD',
  together: 'END FURTHER ALONG',
}

/**
 * The pencil line being drawn, styled by what letting go would do:
 *   a new road or a redraw  bright cyan (and for a redraw, the stretch that
 *                           goes is lit amber underneath, tagged THIS BIT GOES)
 *   still heading back      cyan dashed, tagged END ON THE ROAD
 *   won't do anything       grey dashed, tagged with what to do instead
 */
function drawStroke(ctx: CanvasRenderingContext2D, stroke: readonly P[], plan: RedrawPlan | 'new' | null, roadWidth: number, tip: P): void {
  const live = plan === 'new' || plan === null || plan.kind === 'redraw'
  const waiting = plan !== null && plan !== 'new' && plan.kind === 'nothing' && plan.why === 'end'
  if (plan && plan !== 'new' && plan.kind === 'redraw' && plan.replaced.length > 1) {
    // The road that goes: a wide amber band over it, with a crisp amber centreline.
    ctx.save()
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.strokeStyle = PALETTE.uiWarn
    ctx.globalAlpha = 0.28
    wideLine(ctx, plan.replaced, roadWidth + 6, 8)
    ctx.globalAlpha = 1
    ctx.lineWidth = 2
    ctx.setLineDash([6, 5])
    ctx.stroke()
    ctx.restore()
    const k = Math.floor(plan.replaced.length / 2)
    const mid = plan.replaced[k]
    const m = worldToScreen(mid.x, mid.z, headingAt(plan.replaced, k))
    placePill(ctx, 'THIS BIT GOES', m.sx, m.sy, [-24, 24, -48, 48], PALETTE.uiWarn)
  }
  ctx.save()
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  if (live) {
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
  } else {
    ctx.strokeStyle = waiting ? PALETTE.uiAccent : PALETTE.uiDim
    ctx.globalAlpha = waiting ? 0.85 : 0.7
    ctx.lineWidth = 3
    ctx.setLineDash([8, 7])
    line(ctx, stroke, false)
    ctx.stroke()
  }
  ctx.restore()
  if (plan && plan !== 'new' && plan.kind === 'nothing' && plan.why !== 'short') {
    const at = plan.why === 'start' ? stroke[0] : tip
    const p = pointToScreen(at)
    placePill(ctx, PENCIL_TAGS[plan.why], p.sx, p.sy, [-26, 26, -50], plan.why === 'end' ? PALETTE.uiAccent : PALETTE.uiWarn)
  }
}

/** The steady pencil's string: a thin line from the pen (where the road is drawn) to the pointer. */
function drawPen(ctx: CanvasRenderingContext2D, at: P, to: P): void {
  const a = pointToScreen(at)
  const b = pointToScreen(to)
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
  for (let i = 0; i < n - 1; i++) {
    ctx.globalAlpha = 0.06 + 0.34 * ((v.weights[i] + v.weights[i + 1]) / 2)
    wideLine(ctx, [v.line[i], v.line[i + 1]], roadWidth + 10, 10)
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
    const along = { x: q.x - p.x, z: q.z - p.z }
    const a = worldToScreen(p.x - rx * half, p.z - rz * half, along)
    const b = worldToScreen(p.x + rx * half, p.z + rz * half, along)
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(a.sx, a.sy)
    ctx.lineTo(b.sx, b.sy)
    ctx.stroke()
  }
  // Your hand: a handle on the road where it is (or would be) grabbed.
  const mid = v.line[Math.floor(n / 2)]
  const m = worldToScreen(mid.x, mid.z, headingAt(v.line, Math.floor(n / 2)))
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
    wideLine(ctx, sh.preview, roadWidth, 6)
    ctx.globalAlpha = 1
    ctx.lineWidth = 2.5
    ctx.shadowColor = colour
    ctx.shadowBlur = 10
    ctx.stroke()
    ctx.shadowBlur = 0
  }
  if (sh.pull && sh.marks.length === 2) {
    // A thin line from each end to the pulled middle, so you can see what you are pulling.
    const p = pointToScreen(sh.pull)
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
  // In 3D just the two glowing edges (seen in perspective the fill between them would cross itself over hills).
  if (!in3d()) {
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
  }
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

/** Road points as handles: white, violet where the road is raised a metre or more (`raised`, per point), cyan when picked. */
function drawControlPoints(ctx: CanvasRenderingContext2D, points: readonly RoadPoint[], sel: EditorState['selection'], hover: Pick | null, raised: readonly boolean[] | null): void {
  const r = viewMpp() < 0.5 ? 3.5 : 2.5
  ctx.save()
  const on3d = in3d()
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const { sx, sy } = worldToScreen(p.x, p.z, on3d ? headingAt(points, i) : null)
    if (sx < -10 || sy < -10 || sx > view.width + 10 || sy > view.height + 10) continue
    const picked = isPicked(sel, 'point', i)
    const hovered = isPicked(hover, 'point', i)
    ctx.beginPath()
    ctx.arc(sx, sy, picked || hovered ? r + 2 : r, 0, Math.PI * 2)
    ctx.fillStyle = picked ? PALETTE.uiAccent : (raised ? raised[i] : (p.lift ?? 0) >= 1) ? PALETTE.wallRide : PALETTE.uiText
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
  const p0 = worldToScreen(f.p.x - f.right.x * half, f.p.z - f.right.z * half, f.dir)
  const p1 = worldToScreen(f.p.x + f.right.x * half, f.p.z + f.right.z * half, f.dir)
  if (!Number.isFinite(p0.sx + p0.sy + p1.sx + p1.sy)) return
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
  const sd = screenDir(f.p, f.dir, f.dir)
  const ux = sd.x
  const uy = sd.y
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

/**
 * Where on screen each crossing can be clicked (its marker and its BRIDGE
 * label), filled in by drawBridges every frame. See crossingAtScreen.
 */
let crossingTargets: { spot: P; sx: number; sy: number; box: { x0: number; y0: number; x1: number; y1: number } | null }[] = []

/**
 * The crossing under screen point (sx, sy), as drawn last frame: on its
 * BRIDGE label (distance 0), or within 12 px of its marker (that distance).
 * `labelOnly` ignores the marker (the drawing tools, where a press on the road
 * itself must still draw).
 */
export function crossingAtScreen(sx: number, sy: number, labelOnly = false): { spot: P; d: number } | null {
  let best: { spot: P; d: number } | null = null
  for (const t of crossingTargets) {
    const inBox = !!t.box && sx >= t.box.x0 && sx <= t.box.x1 && sy >= t.box.y0 && sy <= t.box.y1
    const d = inBox ? 0 : Math.hypot(sx - t.sx, sy - t.sy)
    if (!inBox && (labelOnly || d > 12)) continue
    if (!best || d < best.d) best = { spot: t.spot, d }
  }
  return best
}

/** Where each crossing's marker and BRIDGE label were drawn last frame, screen pixels (so a probe can click them). */
export function crossingScreens(): { x: number; z: number; marker: { sx: number; sy: number }; label: { sx: number; sy: number } | null }[] {
  return crossingTargets.map((t) => ({
    x: t.spot.x,
    z: t.spot.z,
    marker: { sx: t.sx, sy: t.sy },
    label: t.box ? { sx: (t.box.x0 + t.box.x1) / 2, sy: (t.box.y0 + t.box.y1) / 2 } : null,
  }))
}

/** A unit direction on the map from a compass heading (0 = north, up the map). */
function headingDir(heading: number): P {
  const r = (heading * Math.PI) / 180
  return { x: Math.sin(r), z: -Math.cos(r) }
}

/**
 * Bridges. Every crossing gets a marker where the roads cross and a label in
 * the gap between them: "BRIDGE 8 m" (violet) when one road goes over with
 * room for a car ("UNDERPASS 8 m" when the road underneath dips into a
 * cutting instead, "TUNNEL" when it goes under in a tunnel: the game digs it,
 * and its Checks row says how deep), "LOW BRIDGE" or "ROADS MEET" (amber) when not. Click either
 * to select it. The selected crossing lights up both roads: the one that
 * GOES OVER in violet, the one that GOES UNDER in cyan. Road raised by hand
 * away from any crossing has its own RAISED label (drawRaisedRuns).
 */
function drawBridges(
  ctx: CanvasRenderingContext2D,
  points: readonly RoadPoint[],
  crossings: readonly RoadCrossing[],
  width: number,
  selected: { x: number; z: number } | null,
  hover: { x: number; z: number } | null,
): void {
  crossingTargets = []
  // (Road raised by hand away from any crossing has its own RAISED label: drawRaisedRuns.)
  const near = (c: RoadCrossing, spot: { x: number; z: number } | null) => !!spot && Math.hypot(c.at.x - spot.x, c.at.z - spot.z) < 1
  const sel = crossings.find((c) => near(c, selected)) ?? null
  // The selected crossing's two roads first (under everything), their GOES OVER / GOES UNDER labels last,
  // so the BRIDGE labels (the things to click) always get their spot.
  const roadLabels = sel ? drawCrossingRoads(ctx, points, sel, width) : []
  for (const c of crossings) {
    const good = c.kind === 'tunnel' || (c.over !== null && c.gap >= BRIDGE_GAP)
    const colour = good ? PALETTE.wallRide : PALETTE.chevron
    const isSel = c === sel
    const { sx, sy } = worldToScreen(c.at.x, c.at.z)
    ctx.save()
    ctx.fillStyle = PALETTE.uiPanel
    ctx.strokeStyle = isSel ? PALETTE.uiText : colour
    ctx.lineWidth = isSel || near(c, hover) ? 3 : 2
    ctx.beginPath()
    ctx.arc(sx, sy, isSel ? 9 : 7, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = colour
    ctx.beginPath()
    ctx.arc(sx, sy, 3, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
    // The label sits in the gap between the two roads (between their directions), clear of both.
    const a = headingDir(c.passes[0].heading)
    const b = headingDir(c.passes[1].heading)
    let ux = a.x + b.x
    let uz = a.z + b.z
    const ul = Math.hypot(ux, uz) || 1
    ux /= ul
    uz /= ul
    if (in3d()) {
      const sd = screenDir(c.at, { x: ux, z: uz })
      ux = sd.x
      uz = sd.y
    }
    const text = c.kind === 'tunnel' ? 'TUNNEL' : good ? `${c.kind === 'underpass' ? 'UNDERPASS' : 'BRIDGE'} ${Math.round(c.gap)} m` : c.over !== null ? `LOW BRIDGE ${c.gap.toFixed(1)} m` : 'ROADS MEET'
    const box = placePill(ctx, text, sx + ux * 46, sy + uz * 46, [0, 24, -24, 48], isSel ? PALETTE.uiText : colour)
    crossingTargets.push({ spot: c.at, sx, sy, box })
  }
  for (const l of roadLabels) placePill(ctx, l.text, l.sx, l.sy, [0, 24, -24, 48], l.colour)
}

/**
 * The selected crossing: the road that goes over (violet) and the one that goes under (cyan), as far as
 * the bridge reaches. Returns the labels to put along them (drawn after the BRIDGE labels).
 */
function drawCrossingRoads(
  ctx: CanvasRenderingContext2D,
  points: readonly RoadPoint[],
  c: RoadCrossing,
  width: number,
): { text: string; sx: number; sy: number; colour: string }[] {
  const labels: { text: string; sx: number; sy: number; colour: string }[] = []
  const road = roadLine(points)
  const { flat, ramp } = bridgeShape(c.angleDeg, width)
  const reach = flat + ramp
  const order: (0 | 1)[] = c.over === 1 ? [1, 0] : [0, 1]
  // The road underneath first, so the bridge is drawn over it, like the real thing.
  for (const k of [...order].reverse()) {
    const pass = c.passes[k]
    const isOver = c.over === k
    const colour = c.over === null ? PALETTE.chevron : isOver ? PALETTE.wallRide : PALETTE.uiAccent
    const pts = stretchOf(road, pass.s - reach, pass.s + reach, 4)
    ctx.save()
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = colour
    ctx.globalAlpha = 0.4
    wideLine(ctx, pts, width * 1.1, 10)
    ctx.globalAlpha = 1
    ctx.lineWidth = 2
    ctx.stroke()
    ctx.restore()
    if (c.over === null) continue
    // A label along each road, out on its ramp in the driving direction (clear of the crossing's own marker and label).
    const ti = Math.round(0.85 * (pts.length - 1))
    const tip = pts[ti]
    const { sx, sy } = worldToScreen(tip.x, tip.z, headingAt(pts, ti))
    labels.push({ text: isOver ? 'GOES OVER' : 'GOES UNDER', sx, sy, colour })
  }
  return labels
}

// ---------------------------------------------------------------- stretches changed by Height, Bank and Width

/**
 * Where each RAISED, BANK and WIDTH label was drawn last frame (screen
 * pixels), with its stretch: a click on one picks that stretch up in its own
 * tool (see markAtScreen).
 */
let markTargets: { run: StretchRun; box: { x0: number; y0: number; x1: number; y1: number } }[] = []

/** The stretch whose RAISED, BANK or WIDTH label is under screen point (sx, sy), as drawn last frame. */
export function markAtScreen(sx: number, sy: number): StretchRun | null {
  for (let i = markTargets.length - 1; i >= 0; i--) {
    const b = markTargets[i].box
    if (sx >= b.x0 && sx <= b.x1 && sy >= b.y0 && sy <= b.y1) return markTargets[i].run
  }
  return null
}

/** Every RAISED, BANK and WIDTH label as drawn last frame (so a probe can click one with the real mouse). */
export function markScreens(): { tool: StretchRun['tool']; from: number; to: number; value: number; label: { sx: number; sy: number } }[] {
  return markTargets.map((t) => ({ tool: t.run.tool, from: t.run.from, to: t.run.to, value: t.run.value, label: { sx: (t.box.x0 + t.box.x1) / 2, sy: (t.box.y0 + t.box.y1) / 2 } }))
}

/** The road's centreline over a run (from point `first` to point `last`, `pad` points either side), from the drawn curve. */
function runLine(rc: RoadCurve, run: StretchRun, pad: number): P[] {
  const n = rc.points.length
  const from = run.first - pad
  let to = run.last + pad
  if (to < from) to += n
  const pts: P[] = []
  const len = rc.curve.length
  for (let f = Math.ceil(from * PER); f <= Math.floor(to * PER); f++) pts.push(rc.curve[((f % len) + len) % len])
  return pts
}

/** A run's label: on a pill beside the road at its label point (`side` -1 left, +1 right), stepping round other labels; clickable while editing. */
function runLabel(ctx: CanvasRenderingContext2D, rc: RoadCurve, run: StretchRun, text: string, colour: string, side: number, clickable: boolean): void {
  const f = frameAt(rc, run.labelPoint)
  const { sx, sy } = worldToScreen(f.p.x, f.p.z, f.dir)
  const out = screenDir(f.p, f.right, f.dir)
  const box = placePill(ctx, text, sx + out.x * side * 34, sy + out.y * side * 34, [0, 22, -22, 44, -44], colour)
  if (box && clickable) markTargets.push({ run, box })
}

/** "8 m", "2.5 m": a height on the map. */
function heightWords(v: number): string {
  const r = Math.round(v * 2) / 2
  return `${Number.isInteger(r) ? r.toFixed(0) : r.toFixed(1)} m`
}

/**
 * Road raised above the ground: violet dots along the middle of the road over
 * the whole raised stretch (its ramps too), and a RAISED label at its top. A
 * bridge over a crossing has the crossing's BRIDGE label instead.
 */
function drawRaisedRuns(ctx: CanvasRenderingContext2D, rc: RoadCurve, runs: readonly StretchRun[], crossings: readonly RoadCrossing[], clickable: boolean): void {
  ctx.save()
  ctx.fillStyle = PALETTE.wallRide
  ctx.shadowColor = PALETTE.wallRide
  ctx.shadowBlur = 6
  // Every dot goes in one path, filled once (a fill each was the slowest thing on screen in 3D).
  ctx.beginPath()
  const on3d = in3d()
  for (const run of runs) {
    // A dot every 11 px or so along the road.
    const pts = runLine(rc, run, 0)
    let gap = 0
    for (let i = 1; i < pts.length; i++) {
      const along = on3d ? { x: pts[i].x - pts[i - 1].x, z: pts[i].z - pts[i - 1].z } : null
      const a = worldToScreen(pts[i - 1].x, pts[i - 1].z, along)
      const b = worldToScreen(pts[i].x, pts[i].z, along)
      const seg = Math.hypot(b.sx - a.sx, b.sy - a.sy)
      if (!Number.isFinite(seg)) continue
      // In 3D a bit of road right by the camera can stretch across thousands of pixels: skip it rather than dot it.
      if (seg > 4000) {
        gap = 0
        continue
      }
      gap += seg
      while (gap >= 11) {
        gap -= 11
        const t = seg > 0 ? 1 - gap / seg : 0
        const dx = a.sx + (b.sx - a.sx) * t
        const dy = a.sy + (b.sy - a.sy) * t
        // Only the dots on screen are drawn.
        if (dx < -10 || dy < -10 || dx > view.width + 10 || dy > view.height + 10) continue
        ctx.moveTo(dx + 2.2, dy)
        ctx.arc(dx, dy, 2.2, 0, Math.PI * 2)
      }
    }
  }
  ctx.fill()
  ctx.restore()
  for (const run of runs) {
    const top = rc.points[run.labelPoint]
    if (crossings.some((c) => c.over !== null && Math.hypot(c.at.x - top.x, c.at.z - top.z) < 150)) continue
    runLabel(ctx, rc, run, run.value < 0 ? `DUG ${heightWords(-run.value)}` : `RAISED ${heightWords(run.value)}`, PALETTE.wallRide, 1, clickable)
  }
}

/** Stretches with a bank set by hand: an amber dashed line along the road, and its BANK label. */
function drawBankRuns(ctx: CanvasRenderingContext2D, rc: RoadCurve, runs: readonly StretchRun[], clickable: boolean): void {
  ctx.save()
  ctx.strokeStyle = PALETTE.chevron
  ctx.lineWidth = 3
  ctx.setLineDash([6, 5])
  for (const run of runs) {
    line(ctx, runLine(rc, run, 0.5), false)
    ctx.stroke()
  }
  ctx.restore()
  for (const run of runs) runLabel(ctx, rc, run, `BANK ${Math.round(run.value)}°`, PALETTE.chevron, -1, clickable)
}

/** Stretches with a width set by hand: both road edges traced with a light dashed line, and a WIDTH label. */
function drawWidthRuns(ctx: CanvasRenderingContext2D, g: { rc: RoadCurve; left: P[]; right: P[] }, runs: readonly StretchRun[], clickable: boolean): void {
  const n = g.rc.points.length
  const len = g.left.length
  ctx.save()
  ctx.strokeStyle = PALETTE.uiText
  ctx.globalAlpha = 0.85
  ctx.lineWidth = 2
  ctx.setLineDash([3, 4])
  for (const run of runs) {
    let to = run.last + 0.5
    const from = run.first - 0.5
    if (to < from) to += n
    for (const edge of [g.left, g.right]) {
      const pts: P[] = []
      for (let f = Math.ceil(from * PER); f <= Math.floor(to * PER); f++) pts.push(edge[((f % len) + len) % len])
      line(ctx, pts, false)
      ctx.stroke()
    }
  }
  ctx.restore()
  for (const run of runs) runLabel(ctx, g.rc, run, `WIDTH ${Math.round(run.value)} m`, PALETTE.uiText, 1, clickable)
}

/** The road from `from` forward to `to`, from the drawn curve (both ends exactly). */
function stretchPoints(rc: RoadCurve, from: number, to: number): P[] {
  const count = rc.points.length
  const f0 = wrapAt(from, count) * PER
  let f1 = wrapAt(to, count) * PER
  if (f1 < f0) f1 += rc.curve.length
  const pts: P[] = [frameAt(rc, from).p]
  for (let f = Math.ceil(f0); f <= Math.floor(f1); f++) pts.push(rc.curve[f % rc.curve.length])
  pts.push(frameAt(rc, to).p)
  return pts
}

/**
 * Height, Bank or Width before a click: the stretch a click here would pick,
 * as a soft glowing band with a tick across the road at each end (the same
 * look as Bend's reach before you grab), and how long it is (or which change
 * it would pick up) on a pill beside it.
 */
function drawStretchHover(ctx: CanvasRenderingContext2D, rc: RoadCurve, h: { from: number; to: number; label: string }, roadWidth: number): void {
  const pts = stretchPoints(rc, h.from, h.to)
  if (pts.length < 2) return
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = PALETTE.uiAccent
  ctx.globalAlpha = 0.2
  wideLine(ctx, pts, roadWidth + 10, 10)
  ctx.globalAlpha = 1
  ctx.lineWidth = 2
  for (const at of [h.from, h.to]) {
    const f = frameAt(rc, at)
    const half = roadWidth / 2 + 6
    const a = worldToScreen(f.p.x - f.right.x * half, f.p.z - f.right.z * half, f.dir)
    const b = worldToScreen(f.p.x + f.right.x * half, f.p.z + f.right.z * half, f.dir)
    ctx.beginPath()
    ctx.moveTo(a.sx, a.sy)
    ctx.lineTo(b.sx, b.sy)
    ctx.stroke()
  }
  ctx.restore()
  const mid = pts[Math.floor(pts.length / 2)]
  const f = frameAt(rc, nearestAtOn(rc, mid))
  const m = worldToScreen(mid.x, mid.z, f.dir)
  const out = screenDir(mid, f.right, f.dir)
  placePill(ctx, h.label, m.sx + out.x * 40, m.sy + out.y * 40, [0, 24, -24, 48], PALETTE.uiAccent)
}

/** The `at` of a spot that is on the road's drawn curve (for its direction). */
function nearestAtOn(rc: RoadCurve, p: P): number {
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < rc.curve.length; i++) {
    const d = Math.hypot(rc.curve[i].x - p.x, rc.curve[i].z - p.z)
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  return best / PER
}

/** The selected section: a bright band along the road with an end cap at each end, and how long it is. */
function drawSection(ctx: CanvasRenderingContext2D, rc: RoadCurve, from: number, to: number, label = true): void {
  const pts = stretchPoints(rc, from, to)
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = PALETTE.uiAccent
  ctx.globalAlpha = 0.35
  wideLine(ctx, pts, 18, 10)
  ctx.globalAlpha = 1
  ctx.lineWidth = 2
  ctx.stroke()
  for (const at of [from, to]) {
    const f = frameAt(rc, at)
    const a = worldToScreen(f.p.x - f.right.x * 12, f.p.z - f.right.z * 12, f.dir)
    const b = worldToScreen(f.p.x + f.right.x * 12, f.p.z + f.right.z * 12, f.dir)
    ctx.beginPath()
    ctx.moveTo(a.sx, a.sy)
    ctx.lineTo(b.sx, b.sy)
    ctx.lineWidth = 3
    ctx.stroke()
  }
  ctx.restore()
  // How long it is (while it is being dragged out too).
  const metres = metresBetween(rc, from, to)
  if (label && metres >= 1) {
    const mid = pts[Math.floor(pts.length / 2)]
    const f = frameAt(rc, nearestAtOn(rc, mid))
    const m = worldToScreen(mid.x, mid.z, f.dir)
    const out = screenDir(mid, f.right, f.dir)
    placePill(ctx, `${Math.round(metres)} m`, m.sx + out.x * 40, m.sy + out.y * 40, [0, 24, -24, 48], PALETTE.uiAccent)
  }
}

// ---------------------------------------------------------------- pieces, props, cores

/** Screen position of each road piece's icon (for drawing and picking). */
export function pieceScreen(rc: RoadCurve, p: Piece): { sx: number; sy: number; dir: P; right: P; centre: P } {
  const place = piecePlace(rc, p)
  const { sx, sy } = worldToScreen(place.p.x, place.p.z, place.dir)
  return { sx, sy, dir: place.dir, right: place.right, centre: place.p }
}

/** 3D: an icon's turn and size on screen at a spot on the road heading `dir` (the map: as they are). */
function iconOnScreen(at: P, dir: P, along: P | null): { dir: P; mpp: number } {
  if (!in3d()) return { dir, mpp: view.mpp }
  const sd = screenDir(at, dir, along)
  return { dir: { x: sd.x, z: sd.y }, mpp: mppAt(at.x, at.z, along) }
}

function drawPieces(ctx: CanvasRenderingContext2D, rc: RoadCurve, pieces: readonly Piece[], roadWidth: number, sel: EditorState['selection'], hover: Pick | null): void {
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i]
    const colour = pieceColour(p)
    if (p.type === 'wallride') drawWallRide(ctx, rc, p.at, p.length ?? TRACK_DEFAULTS.wallride.length, p.side, roadWidth)
    if (p.type === 'tunnel') drawTunnel(ctx, rc, p.at, p.length ?? TRACK_DEFAULTS.tunnelLength, roadWidth, 1, true)
    const at = pieceScreen(rc, p)
    const icon = iconOnScreen(at.centre, at.dir, at.dir)
    drawPieceIcon(ctx, p.type === 'wallride' ? (p.side === 'both' ? 'wallride-both' : p.side === 'left' ? 'wallride-left' : 'wallride-right') : p.type, at.sx, at.sy, icon.dir, pieceFootprint(p, roadWidth), colour, 1, icon.mpp)
    if (isPicked(sel, 'piece', i)) ring(ctx, at.sx, at.sy, 20, PALETTE.uiText, 2)
    else if (isPicked(hover, 'piece', i)) ring(ctx, at.sx, at.sy, 18, PALETTE.uiDim, 1.5)
  }
}

/**
 * Where a wall ride's wall really stands, as the game builds it (src/track/road.ts):
 * from WALL_REACH metres before `at` to WALL_REACH metres past `at + length`. Its
 * `at` values on the map's road, and `height(m)`: how much of its full height the
 * wall has `m` metres after `at` (0 to 1: it grows in over WALL_RAMP metres at
 * the start and fades out over WALL_RAMP at the end).
 */
export function wallRideReach(rc: RoadCurve, at: number, length: number): { from: number; to: number; startM: number; endM: number; height: (m: number) => number } {
  const startM = -WALL_REACH
  const endM = length + WALL_REACH
  return {
    from: advanceAt(rc, at, startM),
    to: advanceAt(rc, at, endM),
    startM,
    endM,
    height: (m) => smoothstep(0, WALL_RAMP, Math.min(m - startM, endM - m)),
  }
}

/**
 * A wall ride on the map: a bold glowing line along the road's edge where the
 * wall stands full height, thinning and fading where it grows in and fades out,
 * so the map shows the whole wall the game builds, not just the piece's length.
 */
function drawWallRide(ctx: CanvasRenderingContext2D, rc: RoadCurve, at: number, length: number, side: 'left' | 'right' | 'both', roadWidth: number, alpha = 1): void {
  const reach = wallRideReach(rc, at, length)
  const steps = Math.max(24, Math.ceil((reach.endM - reach.startM) / 4))
  ctx.save()
  ctx.strokeStyle = PALETTE.wallRide
  ctx.shadowColor = PALETTE.wallRide
  ctx.shadowBlur = 8
  ctx.lineCap = 'round'
  for (const sign of side === 'both' ? [-1, 1] : side === 'left' ? [-1] : [1]) {
    const off = sign * (roadWidth / 2 + 1)
    const spot = (m: number): P => {
      const f = frameAt(rc, advanceAt(rc, at, m))
      return { x: f.p.x + f.right.x * off, z: f.p.z + f.right.z * off }
    }
    // Segment by segment, as thick and as bright as the wall is tall there.
    let a = spot(reach.startM)
    for (let k = 1; k <= steps; k++) {
      const m = reach.startM + ((reach.endM - reach.startM) * k) / steps
      const b = spot(m)
      const h = reach.height(m - (reach.endM - reach.startM) / steps / 2)
      if (h > 0.01) {
        ctx.globalAlpha = (0.3 + 0.7 * h) * alpha
        ctx.lineWidth = 1.5 + 3.5 * h
        line(ctx, [a, b], false)
        ctx.stroke()
      }
      a = b
    }
  }
  ctx.restore()
}

/**
 * A tunnel on the map: the stretch it covers, as a band of the ground grid's violet over the
 * road as wide as the tunnel's walls reach (the hill goes back over it there), edged with
 * dashes, and (when `label`) a TUNNEL pill with its length.
 */
function drawTunnel(ctx: CanvasRenderingContext2D, rc: RoadCurve, at: number, length: number, roadWidth: number, alpha: number, label: boolean): void {
  const steps = Math.max(8, Math.ceil(length / 4))
  const along = (off: number): P[] => {
    const pts: P[] = []
    for (let k = 0; k <= steps; k++) {
      const f = frameAt(rc, advanceAt(rc, at, (length * k) / steps))
      pts.push({ x: f.p.x + f.right.x * off, z: f.p.z + f.right.z * off })
    }
    return pts
  }
  const half = roadWidth / 2 + TUNNEL_WALL
  ctx.save()
  ctx.globalAlpha = 0.45 * alpha
  ctx.strokeStyle = PALETTE.grid
  ctx.lineCap = 'butt'
  wideLine(ctx, along(0), 2 * half, 4)
  ctx.globalAlpha = alpha
  ctx.lineWidth = 1.5
  ctx.setLineDash([6, 5])
  for (const sign of [-1, 1]) {
    line(ctx, along(sign * half), false)
    ctx.stroke()
  }
  ctx.setLineDash([])
  ctx.restore()
  if (label) {
    const f = frameAt(rc, advanceAt(rc, at, length / 2))
    const m = worldToScreen(f.p.x, f.p.z, f.dir)
    const out = screenDir(f.p, f.right, f.dir)
    placePill(ctx, `TUNNEL ${Math.round(length)} m`, m.sx + out.x * 44, m.sy + out.y * 44, [0, 24, -24, 48], PALETTE.grid)
  }
}

/** Points along the road's middle from `at` for `metres` (negative: backwards), every 4 m or so. */
function roadAlong(rc: RoadCurve, at: number, metres: number): P[] {
  const steps = Math.max(4, Math.ceil(Math.abs(metres) / 4))
  const pts: P[] = []
  for (let k = 0; k <= steps; k++) pts.push(frameAt(rc, advanceAt(rc, at, (metres * k) / steps)).p)
  return pts
}

/**
 * A tunnel's whole footprint: each ramp down beyond the covered part in a lighter shade of the
 * tunnel's colour with its length ("ramp 200 m"), the covered part ("TUNNEL 150 m": drawn here only
 * for the Height panel's preview), all in amber where it can't go, whatever is in the way marked
 * amber where it sits ("IN THE WAY"), and the reason with what to try in pills by the pointer.
 */
function drawTunnelFootprint(ctx: CanvasRenderingContext2D, rc: RoadCurve, f: TunnelFootprint, roadWidth: number): void {
  const colour = f.ok ? PALETTE.grid : PALETTE.chevron
  const half = roadWidth / 2 + TUNNEL_WALL
  if (f.covered) drawTunnel(ctx, rc, f.at, f.length, roadWidth, 0.6, true)
  const end = advanceAt(rc, f.at, f.length)
  const ramps: [P[], number][] = []
  if (f.rampIn > 0) ramps.push([roadAlong(rc, f.at, -f.rampIn), f.rampIn])
  if (f.rampOut > 0) ramps.push([roadAlong(rc, end, f.rampOut), f.rampOut])
  // Every band first, then the labels on top: the reason and what to try by the pointer (clear of
  // its icon), then each ramp's length and what is in the way.
  const blocker = f.blocker ? roadAlong(rc, f.blocker.from, Math.max(8, metresBetween(rc, f.blocker.from, f.blocker.to))) : null
  ctx.save()
  ctx.lineCap = 'butt'
  ctx.strokeStyle = colour
  for (const [pts] of ramps) {
    ctx.globalAlpha = 0.18
    wideLine(ctx, pts, 2 * half, 4)
  }
  if (!f.ok) {
    // The covered part, amber: it can't go here.
    ctx.globalAlpha = 0.4
    wideLine(ctx, roadAlong(rc, f.at, f.length), 2 * half, 4)
  }
  if (blocker) {
    // What is in the way, where it sits on the road.
    ctx.strokeStyle = PALETTE.chevron
    ctx.lineCap = 'round'
    ctx.globalAlpha = 0.85
    wideLine(ctx, blocker, roadWidth + 6, 8)
  }
  ctx.restore()
  if (!f.ok && f.why && f.pill) {
    // (In 3D, by the mouse: at the spot it picked, or on the road there.)
    const m = pointToScreen(f.pill)
    labelBoxes.push({ x0: m.sx - 22, y0: m.sy - 22, x1: m.sx + 22, y1: m.sy + 22 })
    const r = placePill(ctx, `Can't fit: ${f.why}`, m.sx, m.sy, [38, -38, 64, -64, 90, -90], PALETTE.chevron)
    if (f.hint) {
      const off = r ? (r.y0 > m.sy ? [r.y1 + 14 - m.sy, r.y0 - 38 - m.sy] : [r.y0 - 14 - m.sy, 38]) : [38, -38]
      placePill(ctx, f.hint, m.sx, m.sy, off, PALETTE.chevron)
    }
  }
  for (const [pts, metres] of ramps) {
    const k = Math.floor(pts.length / 2)
    const mid = pts[k]
    const m = worldToScreen(mid.x, mid.z, headingAt(pts, k))
    placePill(ctx, `ramp ${Math.round(metres)} m`, m.sx, m.sy, [0, 24, -24, 48], colour)
  }
  if (blocker) {
    const k = Math.floor(blocker.length / 2)
    const mid = blocker[k]
    const m = worldToScreen(mid.x, mid.z, headingAt(blocker, k))
    placePill(ctx, 'IN THE WAY', m.sx, m.sy, [-30, 30, -54, 54, -78, 78], PALETTE.chevron)
  }
}

/**
 * One piece icon at a screen point, turned to the road direction. Drawn at
 * its real size when zoomed in, and never smaller than a readable icon.
 */
export function drawPieceIcon(ctx: CanvasRenderingContext2D, kind: PlaceKind, sx: number, sy: number, dir: P, size: { length: number; width: number }, colour: string, alpha: number, mpp: number = view.mpp): void {
  const L = Math.max(16, size.length / mpp)
  const W = Math.max(10, size.width / mpp)
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
    const { sx, sy } = worldToScreen(p.x, p.z, 'ground')
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
    const { sx, sy } = worldToScreen(c.x, c.z, 'ground')
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
function drawGhost(ctx: CanvasRenderingContext2D, ghost: NonNullable<MapExtras['ghost']>, roadWidth: number, rc: RoadCurve): void {
  if (ghost.wall && rc.curve.length) return drawWallGhost(ctx, rc, ghost.wall, roadWidth)
  if (ghost.tunnel && rc.curve.length) return drawTunnel(ctx, rc, ghost.tunnel.at, ghost.tunnel.length, roadWidth, 0.6, true)
  const onGround = ghost.kind === 'props' || ghost.kind === 'cores'
  const { sx, sy } = worldToScreen(ghost.at.x, ghost.at.z, onGround ? 'ground' : ghost.dir)
  if (ghost.kind === 'props') return drawPropIcon(ctx, sx, sy, 'medium', 0.55)
  if (ghost.kind === 'cores') return drawCoreIcon(ctx, sx, sy, 0.55)
  const icon = iconOnScreen(ghost.at, ghost.dir, ghost.dir)
  const sizes: Record<string, { length: number; width: number }> = {
    boost: { length: TRACK_DEFAULTS.boost.length, width: TRACK_DEFAULTS.boost.width },
    ramp: { length: TRACK_DEFAULTS.ramp.length, width: TRACK_DEFAULTS.ramp.width },
    loop: { length: TRACK_DEFAULTS.loopRadius * 2, width: roadWidth },
    speedtrap: { length: 2, width: roadWidth + 2 },
    start: { length: 2, width: roadWidth + 3 },
  }
  drawPieceIcon(ctx, ghost.kind, sx, sy, icon.dir, sizes[ghost.kind] ?? { length: 16, width: roadWidth }, toolFor(ghost.kind).colour, 0.55, icon.mpp)
}

/**
 * Place tool, a wall ride picked: the wall ride it would place, drawn the way a
 * selected one is (its whole wall along the edge, growing in and fading out,
 * and its badge in the middle with the selection ring), a little see-through
 * because it isn't there yet. While dragging, the stretch dragged is lit like
 * the Bank tool's pick, and a pill says how long the wall ride will be.
 */
function drawWallGhost(ctx: CanvasRenderingContext2D, rc: RoadCurve, w: GhostWall, roadWidth: number): void {
  if (w.dragged) drawSection(ctx, rc, w.dragged.from, w.dragged.to, false)
  drawWallRide(ctx, rc, w.at, w.length, w.side, roadWidth, 0.8)
  const mid = frameAt(rc, advanceAt(rc, w.at, w.length / 2))
  const { sx, sy } = worldToScreen(mid.p.x, mid.p.z, mid.dir)
  const kind: PlaceKind = w.side === 'both' ? 'wallride-both' : w.side === 'left' ? 'wallride-left' : 'wallride-right'
  const icon = iconOnScreen(mid.p, mid.dir, mid.dir)
  drawPieceIcon(ctx, kind, sx, sy, icon.dir, { length: w.length, width: roadWidth }, PALETTE.wallRide, 0.8, icon.mpp)
  ring(ctx, sx, sy, 20, PALETTE.uiText, 2)
  const words = w.cut === 'short' ? `${w.length} m (the shortest)` : w.cut === 'long' ? `${w.length} m (the longest)` : `${w.length} m`
  const out = screenDir(mid.p, mid.right, mid.dir)
  placePill(ctx, w.side === 'both' ? `HALF-PIPE ${words}` : `WALL RIDE ${words}`, sx + out.x * 46, sy + out.y * 46, [0, 24, -24, 48], PALETTE.wallRide)
}

// ---------------------------------------------------------------- pins and scale (the compass is beside the 3D button, Look3dUi.tsx)

/**
 * Pins for clean-up notes, validator warnings and the game's track checks (checks.ts)
 * that point at a place. A failing check also gets a short red tag beside its pin.
 */
function drawPins(ctx: CanvasRenderingContext2D, s: EditorState, rc: RoadCurve): void {
  pinTargets = []
  if (!rc.curve.length) return
  // The same rows the Checks list shows (problems.ts). The game's checks only count while they
  // are about the road on screen (not mid-drag, not before the rebuild after a change).
  const fresh = s.checkedDraft === s.draft && s.preview !== 'pending'
  const selected = s.selection?.kind === 'problem' ? s.selection.key : null
  const pins = problemsOf({ draft: s.draft, gates: fresh ? s.gates : null, errors: s.errors, warnings: s.warnings, notes: s.notes?.issues ?? NO_NOTES })
    .filter((p) => p.at)
    .map((p) => ({ at: p.at as P, tone: p.tone, label: p.label, key: p.key }))
  // The most serious on top (a red pin never hides under an amber one at the same spot), the selected one above all.
  const rank = { note: 0, warn: 1, bad: 2 }
  pins.sort((a, b) => (a.key === selected ? 3 : rank[a.tone]) - (b.key === selected ? 3 : rank[b.tone]))
  ctx.save()
  for (const pin of pins) {
    const { sx, sy } = worldToScreen(pin.at.x, pin.at.z)
    const colour = pin.tone === 'bad' ? PALETTE.uiBad : pin.tone === 'warn' ? PALETTE.uiWarn : PALETTE.uiDim
    const isSel = pin.key === selected
    // Offset up-right so the pin never hides the thing it is about.
    const px = pin.tone === 'note' ? sx : sx + 16
    const py = pin.tone === 'note' ? sy : sy - 16
    if (isSel) {
      // The selected problem: a ring on the road where it is, joined to its pin.
      ctx.strokeStyle = PALETTE.uiText
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(sx, sy, 14, 0, Math.PI * 2)
      ctx.moveTo(sx + 10, sy - 10)
      ctx.lineTo(px - 7, py + 7)
      ctx.stroke()
    }
    ctx.beginPath()
    ctx.arc(px, py, pin.tone === 'note' ? 5 : isSel ? 11 : 9, 0, Math.PI * 2)
    ctx.fillStyle = PALETTE.uiPanelSolid
    ctx.fill()
    ctx.lineWidth = isSel ? 3 : 2
    ctx.strokeStyle = isSel ? PALETTE.uiText : colour
    ctx.stroke()
    if (pin.tone !== 'note') {
      ctx.fillStyle = colour
      ctx.font = `700 12px ${FONTS.body}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('!', px, py + 0.5)
    }
    pinTargets.push({ key: pin.key, sx: px, sy: py, box: null })
  }
  ctx.restore()
  // Tags after every pin, so each one can step around the others. A tag can be clicked too.
  for (const pin of pins) {
    if (!pin.label) continue
    const { sx, sy } = worldToScreen(pin.at.x, pin.at.z)
    const box = placePill(ctx, pin.label, sx + 16, sy - 16, [-24, 24, -48, 48], pin.key === selected ? PALETTE.uiText : PALETTE.uiBad)
    const t = pinTargets.find((x) => x.key === pin.key)
    if (t) t.box = box
  }
}

/** Where each problem's pin (and its tag) was drawn last frame, screen pixels. See problemAtScreen. */
let pinTargets: { key: string; sx: number; sy: number; box: { x0: number; y0: number; x1: number; y1: number } | null }[] = []

/**
 * 3D: the pins stand on stalks (look3dMarks.tsx draws them), which says here where each pin's
 * head and tag went, so a click on one selects its problem exactly as on the map.
 */
export function setPinTargets3d(list: typeof pinTargets): void {
  pinTargets = list
}

/** The problem whose pin (within 12 px) or tag is under screen point (sx, sy), as drawn last frame. */
export function problemAtScreen(sx: number, sy: number): string | null {
  let best: string | null = null
  let bestD = 12
  for (const t of pinTargets) {
    const inBox = !!t.box && sx >= t.box.x0 && sx <= t.box.x1 && sy >= t.box.y0 && sy <= t.box.y1
    const d = inBox ? 0 : Math.hypot(sx - t.sx, sy - t.sy)
    if (d <= bestD) {
      bestD = d
      best = t.key
    }
  }
  return best
}

/** Every problem pin as drawn last frame (so a probe can click one with the real mouse). */
export function pinScreens(): { key: string; pin: { sx: number; sy: number }; tag: { sx: number; sy: number } | null }[] {
  return pinTargets.map((t) => ({ key: t.key, pin: { sx: t.sx, sy: t.sy }, tag: t.box ? { sx: (t.box.x0 + t.box.x1) / 2, sy: (t.box.y0 + t.box.y1) / 2 } : null }))
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
  // The stunt park's zones (Free Roam and Stunt Attack), named in the middle of each lane.
  for (const z of play.parkZones()) label(z.name, { x: z.x + z.dx * z.length * 0.5, z: z.z + z.dz * z.length * 0.5 }, PALETTE.ramp, -18)
}

/**
 * The stunt park's zones (Free Roam and Stunt Attack only; play.parkZones is empty otherwise):
 * each lane as a dashed amber outline, with a chevron at its start pointing the way in.
 */
function drawParkZones(ctx: CanvasRenderingContext2D): void {
  const zones = play.parkZones()
  if (zones.length === 0) return
  ctx.save()
  ctx.strokeStyle = PALETTE.ramp
  ctx.fillStyle = PALETTE.ramp
  ctx.lineJoin = 'round'
  for (const z of zones) {
    // Corners: start left, start right, end right, end left (right = the heading turned clockwise).
    const rx = -z.dz * z.halfWidth
    const rz = z.dx * z.halfWidth
    const ex = z.x + z.dx * z.length
    const ez = z.z + z.dz * z.length
    const c = [worldToScreen(z.x - rx, z.z - rz), worldToScreen(z.x + rx, z.z + rz), worldToScreen(ex + rx, ez + rz), worldToScreen(ex - rx, ez - rz)]
    ctx.beginPath()
    ctx.moveTo(c[0].sx, c[0].sy)
    for (let i = 1; i < 4; i++) ctx.lineTo(c[i].sx, c[i].sy)
    ctx.closePath()
    ctx.globalAlpha = 0.1
    ctx.fill()
    ctx.globalAlpha = 0.8
    ctx.lineWidth = 1.5
    ctx.setLineDash([6, 5])
    ctx.stroke()
    ctx.setLineDash([])
    // The way in: a chevron a little way up the lane from its start.
    const tip = worldToScreen(z.x + z.dx * z.halfWidth * 1.4, z.z + z.dz * z.halfWidth * 1.4)
    const back = worldToScreen(z.x + z.dx * z.halfWidth * 0.6, z.z + z.dz * z.halfWidth * 0.6)
    const ux = tip.sx - back.sx
    const uy = tip.sy - back.sy
    const L = Math.hypot(ux, uy) || 1
    const k = Math.min(9, Math.max(5, L))
    const ax = (ux / L) * k
    const ay = (uy / L) * k
    ctx.globalAlpha = 0.95
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(tip.sx - ax - ay * 0.8, tip.sy - ay + ax * 0.8)
    ctx.lineTo(tip.sx, tip.sy)
    ctx.lineTo(tip.sx - ax + ay * 0.8, tip.sy - ay - ax * 0.8)
    ctx.stroke()
  }
  ctx.restore()
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
