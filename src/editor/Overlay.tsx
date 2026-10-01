// ============================================================
//  OVERLAY - the pencil, and everything drawn on top of the map
// ------------------------------------------------------------
//  A see-through 2D canvas laid over the 3D top-down view. It does
//  two jobs:
//
//   1. Input. Left-drag draws with the pencil. Right- or middle-
//      drag (or Space + drag) pans, the wheel zooms where you point,
//      WASD / arrows pan too, F fits the track, Ctrl+Z undoes.
//   2. Drawing. The line you are drawing, the road's control points,
//      the start line and driving direction, bridges, and pins on
//      anything the game wants to tell you about. These are crisp
//      2D shapes in screen pixels, so they stay readable at any zoom.
//
//  The 3D road under it is the real thing (the live preview), so the
//  overlay only adds what a map needs: labels and handles.
// ============================================================

import { useEffect, useRef } from 'react'
import { FONTS, PALETTE } from '../core/palette'
import { inputState } from '../core/controls'
import type { RoadPoint } from '../track/schema'
import { useEditor, undo, redo, applyStroke, say } from './draft'
import { type P, catmullRomClosed } from './geom'
import { view, panBy, screenToWorld, worldToScreen, zoomAt, fitBox } from './view'

/** Pixels the pointer must move before the pencil adds another point. */
const PENCIL_STEP_PX = 3
/** Held-key pan speed, screen pixels per second. */
const KEY_PAN_PX = 700

export function fitToDraft(): void {
  const pts = useEditor.getState().draft.points
  if (!pts.length) return
  let minX = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxZ = -Infinity
  for (const p of pts) {
    minX = Math.min(minX, p.x)
    maxX = Math.max(maxX, p.x)
    minZ = Math.min(minZ, p.z)
    maxZ = Math.max(maxZ, p.z)
  }
  const pad = 80
  fitBox(minX - pad, minZ - pad, maxX + pad, maxZ + pad)
}

/** A key event that belongs to a text field, not to the map. */
function typing(e: KeyboardEvent): boolean {
  const t = e.target
  return inputState.context === 'text' || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement
}

export function Overlay() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // ---- state for this mount (plain variables: no React re-renders while drawing) ----
    let stroke: P[] = []
    let drawing = false
    let panning = false
    let spaceHeld = false
    let lastX = 0
    let lastY = 0
    let hover: P | null = null
    const held = new Set<string>()
    let needsDraw = true
    let drawnVersion = -1
    let raf = 0
    let lastT = performance.now()

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      view.width = window.innerWidth
      view.height = window.innerHeight
      canvas.width = Math.round(view.width * dpr)
      canvas.height = Math.round(view.height * dpr)
      canvas.style.width = `${view.width}px`
      canvas.style.height = `${view.height}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      view.version++
    }
    resize()
    fitToDraft()

    // ---- pointer ----
    const onDown = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId)
      lastX = e.clientX
      lastY = e.clientY
      const s = useEditor.getState()
      const wantsPan = e.button === 1 || e.button === 2 || spaceHeld || s.tool === 'pan' || s.mode === 'map'
      if (wantsPan) {
        panning = true
        canvas.style.cursor = 'grabbing'
        return
      }
      if (e.button === 0) {
        drawing = true
        stroke = [screenToWorld(e.clientX, e.clientY)]
        needsDraw = true
      }
    }
    const onMove = (e: PointerEvent) => {
      hover = screenToWorld(e.clientX, e.clientY)
      if (panning) {
        panBy(e.clientX - lastX, e.clientY - lastY)
        lastX = e.clientX
        lastY = e.clientY
        return
      }
      if (drawing) {
        if (Math.hypot(e.clientX - lastX, e.clientY - lastY) >= PENCIL_STEP_PX) {
          stroke.push(screenToWorld(e.clientX, e.clientY))
          lastX = e.clientX
          lastY = e.clientY
        }
      }
      needsDraw = true
    }
    const onUp = (e: PointerEvent) => {
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
      if (panning) {
        panning = false
        canvas.style.cursor = ''
        return
      }
      if (!drawing) return
      drawing = false
      const done = stroke
      stroke = []
      needsDraw = true
      if (done.length < 4) return
      applyStroke(done, view.mpp)
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const lines = e.deltaMode === 1 ? 16 : 1
      zoomAt(e.clientX, e.clientY, Math.exp(e.deltaY * lines * 0.0015))
    }
    const onContext = (e: Event) => e.preventDefault()

    // ---- keyboard ----
    const onKeyDown = (e: KeyboardEvent) => {
      if (typing(e)) return
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.code === 'KeyZ') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
        return
      }
      if (mod && e.code === 'KeyY') {
        e.preventDefault()
        redo()
        return
      }
      if (mod) return
      if (e.code === 'Space') {
        spaceHeld = true
        canvas.style.cursor = 'grab'
        e.preventDefault()
        return
      }
      if (e.code === 'KeyF') fitToDraft()
      if (e.code === 'KeyP') useEditor.setState({ tool: 'pencil' })
      if (e.code === 'KeyH') useEditor.setState({ tool: 'pan' })
      if (e.code === 'Equal' || e.code === 'NumpadAdd') zoomAt(view.width / 2, view.height / 2, 1 / 1.25)
      if (e.code === 'Minus' || e.code === 'NumpadSubtract') zoomAt(view.width / 2, view.height / 2, 1.25)
      held.add(e.code)
    }
    const onKeyUp = (e: KeyboardEvent) => {
      held.delete(e.code)
      if (e.code === 'Space') {
        spaceHeld = false
        if (!panning) canvas.style.cursor = ''
      }
    }
    const onBlur = () => {
      held.clear()
      spaceHeld = false
    }

    // ---- the loop: held-key panning, then redraw if anything changed ----
    const unsub = useEditor.subscribe(() => {
      needsDraw = true
    })
    const loop = (t: number) => {
      const dt = Math.min(0.05, (t - lastT) / 1000)
      lastT = t
      let px = 0
      let py = 0
      if (held.has('KeyA') || held.has('ArrowLeft')) px += 1
      if (held.has('KeyD') || held.has('ArrowRight')) px -= 1
      if (held.has('KeyW') || held.has('ArrowUp')) py += 1
      if (held.has('KeyS') || held.has('ArrowDown')) py -= 1
      if (px || py) panBy(px * KEY_PAN_PX * dt, py * KEY_PAN_PX * dt)
      if (needsDraw || drawnVersion !== view.version) {
        drawnVersion = view.version
        needsDraw = false
        draw(ctx, stroke, hover)
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)

    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onUp)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('contextmenu', onContext)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    window.addEventListener('resize', resize)
    return () => {
      cancelAnimationFrame(raf)
      unsub()
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('contextmenu', onContext)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('resize', resize)
    }
  }, [])

  return <canvas ref={canvasRef} className="sre-overlay" data-testid="editor-overlay" />
}

// ---------------------------------------------------------------- drawing

/** The smooth road curve through the draft's points, cached until the points change. */
let curveCache: { points: RoadPoint[] | null; curve: P[] } = { points: null, curve: [] }
function roadCurve(points: RoadPoint[]): P[] {
  if (curveCache.points !== points) curveCache = { points, curve: points.length >= 3 ? catmullRomClosed(points, 6) : [] }
  return curveCache.curve
}

function draw(ctx: CanvasRenderingContext2D, stroke: readonly P[], hover: P | null): void {
  const s = useEditor.getState()
  const d = s.draft
  ctx.clearRect(0, 0, view.width, view.height)
  const curve = roadCurve(d.points)

  if (curve.length) {
    drawDirectionArrows(ctx, curve)
    drawBridges(ctx, d.points)
    if (s.mode === 'edit' && view.mpp < 2.6) drawControlPoints(ctx, d.points)
    drawStartLine(ctx, d.points, d.startAt, d.width)
  }
  drawPins(ctx)
  if (stroke.length > 1) drawStroke(ctx, stroke)
  drawScaleBar(ctx)
  drawCompass(ctx)
  if (hover) drawReadout(ctx, hover)
}

function line(ctx: CanvasRenderingContext2D, pts: readonly P[], closed: boolean): void {
  ctx.beginPath()
  for (let i = 0; i < pts.length; i++) {
    const { sx, sy } = worldToScreen(pts[i].x, pts[i].z)
    if (i === 0) ctx.moveTo(sx, sy)
    else ctx.lineTo(sx, sy)
  }
  if (closed) ctx.closePath()
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

/** Small chevrons along the road every ~140 m, pointing the way you drive. */
function drawDirectionArrows(ctx: CanvasRenderingContext2D, curve: readonly P[]): void {
  const spacingPx = 160
  ctx.save()
  ctx.strokeStyle = PALETTE.uiText
  ctx.globalAlpha = 0.75
  ctx.lineWidth = 2
  ctx.lineCap = 'round'
  let travelled = spacingPx / 2
  for (let i = 0; i < curve.length; i++) {
    const a = worldToScreen(curve[i].x, curve[i].z)
    const b = worldToScreen(curve[(i + 1) % curve.length].x, curve[(i + 1) % curve.length].z)
    const seg = Math.hypot(b.sx - a.sx, b.sy - a.sy)
    travelled += seg
    if (travelled < spacingPx || seg < 1e-3) continue
    travelled = 0
    const ux = (b.sx - a.sx) / seg
    const uy = (b.sy - a.sy) / seg
    const size = 6
    ctx.beginPath()
    ctx.moveTo(a.sx - ux * size - uy * size, a.sy - uy * size + ux * size)
    ctx.lineTo(a.sx, a.sy)
    ctx.lineTo(a.sx - ux * size + uy * size, a.sy - uy * size - ux * size)
    ctx.stroke()
  }
  ctx.restore()
}

function drawControlPoints(ctx: CanvasRenderingContext2D, points: readonly RoadPoint[]): void {
  const r = view.mpp < 0.8 ? 4 : 3
  ctx.save()
  for (const p of points) {
    const { sx, sy } = worldToScreen(p.x, p.z)
    if (sx < -10 || sy < -10 || sx > view.width + 10 || sy > view.height + 10) continue
    ctx.beginPath()
    ctx.arc(sx, sy, r, 0, Math.PI * 2)
    ctx.fillStyle = p.lift ? PALETTE.wallRide : PALETTE.uiText
    ctx.fill()
    ctx.lineWidth = 1.5
    ctx.strokeStyle = PALETTE.uiPanelSolid
    ctx.stroke()
  }
  ctx.restore()
}

/** A label on a dark pill, legible over the brightest scene. */
function pill(ctx: CanvasRenderingContext2D, text: string, sx: number, sy: number, colour: string): void {
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

/** The start line: a chequered bar across the road, a label, and an arrow the way the race goes. */
function drawStartLine(ctx: CanvasRenderingContext2D, points: readonly RoadPoint[], startAt: number, width: number): void {
  const n = points.length
  const i = Math.floor(startAt) % n
  const a = points[i]
  const b = points[(i + 1) % n]
  const dx = b.x - a.x
  const dz = b.z - a.z
  const len = Math.hypot(dx, dz) || 1
  const tx = dx / len
  const tz = dz / len
  const f = startAt - Math.floor(startAt)
  const cx = a.x + dx * f
  const cz = a.z + dz * f
  const half = width / 2 + 1.5
  const p0 = worldToScreen(cx - tz * half, cz + tx * half)
  const p1 = worldToScreen(cx + tz * half, cz - tx * half)
  const barPx = Math.hypot(p1.sx - p0.sx, p1.sy - p0.sy)
  ctx.save()
  // The chequered bar (at least 18 px long so it reads when zoomed out).
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
  // The way the race goes.
  const s = worldToScreen(cx, cz)
  const ux = tx
  const uy = tz
  const tip = { x: s.sx + ux * 34, y: s.sy + uy * 34 }
  ctx.strokeStyle = PALETTE.uiAccent
  ctx.fillStyle = PALETTE.uiAccent
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.moveTo(s.sx + ux * 8, s.sy + uy * 8)
  ctx.lineTo(tip.x, tip.y)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(tip.x + ux * 4, tip.y + uy * 4)
  ctx.lineTo(tip.x - ux * 8 - uy * 7, tip.y - uy * 8 + ux * 7)
  ctx.lineTo(tip.x - ux * 8 + uy * 7, tip.y - uy * 8 - ux * 7)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
  pill(ctx, 'START', s.sx - ux * 30 - uy * 26, s.sy - uy * 30 + ux * 26, PALETTE.uiText)
}

/** Raised stretches (bridges) get a label at their highest point. */
function drawBridges(ctx: CanvasRenderingContext2D, points: readonly RoadPoint[]): void {
  const n = points.length
  for (let i = 0; i < n; i++) {
    const lift = points[i].lift ?? 0
    if (lift < 6) continue
    const prev = points[(i - 1 + n) % n].lift ?? 0
    if (prev >= 6) continue // label each raised stretch once, at its start
    let j = i
    let count = 0
    while ((points[j % n].lift ?? 0) >= 6 && count < n) {
      j++
      count++
    }
    const mid = points[(i + Math.floor(count / 2)) % n]
    const { sx, sy } = worldToScreen(mid.x, mid.z)
    pill(ctx, `BRIDGE ${Math.round(lift)} m`, sx, sy - 22, PALETTE.wallRide)
  }
}

/** Pins for clean-up notes and validator warnings that point at a place. */
function drawPins(ctx: CanvasRenderingContext2D): void {
  const s = useEditor.getState()
  const pins: { at: P; tone: 'warn' | 'bad' | 'note' }[] = []
  for (const issue of s.notes?.issues ?? []) {
    if (issue.at && issue.code !== 'bridged') pins.push({ at: issue.at, tone: issue.level === 'warning' ? 'warn' : issue.level === 'error' ? 'bad' : 'note' })
  }
  for (const w of s.warnings) {
    const at = issueLocation(w.path, s.draft.points)
    if (at) pins.push({ at, tone: 'warn' })
  }
  for (const e of s.errors) {
    const at = issueLocation(e.path, s.draft.points)
    if (at) pins.push({ at, tone: 'bad' })
  }
  ctx.save()
  for (const pin of pins) {
    const { sx, sy } = worldToScreen(pin.at.x, pin.at.z)
    const colour = pin.tone === 'bad' ? PALETTE.uiBad : pin.tone === 'warn' ? PALETTE.uiWarn : PALETTE.uiDim
    ctx.beginPath()
    ctx.arc(sx, sy, pin.tone === 'note' ? 5 : 9, 0, Math.PI * 2)
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
      ctx.fillText('!', sx, sy + 0.5)
    }
  }
  ctx.restore()
}

/** Where on the map a validator message is about ("road.points[3]" -> that point). */
export function issueLocation(path: string, points: readonly RoadPoint[]): P | null {
  const m = /^road\.points\[(\d+)\]/.exec(path)
  if (m) {
    const p = points[Number(m[1])]
    return p ? { x: p.x, z: p.z } : null
  }
  return null
}

function drawScaleBar(ctx: CanvasRenderingContext2D): void {
  // Pick a round length that is 80-200 px on screen.
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

/** Tell the player how the pencil works the first time they open a fresh editor. */
export function pencilHint(): void {
  say('Hold the left mouse button and draw a loop. Let go and it becomes a road.', 'info')
}
