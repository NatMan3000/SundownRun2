// ============================================================
//  OVERLAY - mouse and keyboard on the map
// ------------------------------------------------------------
//  A see-through 2D canvas laid over the 3D top-down view. It turns
//  what your hands do into editor actions, depending on the tool:
//
//    Pencil   drag to draw. It always edits the road that is there: a
//             line that starts and ends on the road redraws the stretch
//             between its ends. While you draw, the map shows what letting
//             go will do (the stretch that goes lit amber, the new line
//             cyan), or that it won't do anything and why. On an empty map
//             a loop becomes the road.
//             The steady hand (shape.ts SteadyPen) makes the line trail
//             the pointer on a short string, so wobbles never reach it.
//             Hold Shift while drawing for a dead straight line from where
//             Shift went down to the pointer; let go of Shift and the line
//             carries on freehand from there.
//    Bend     grab the road and pull: the stretch near your hand comes
//             along with a soft falloff. The wheel (while dragging) or
//             [ and ] change how much road comes. One Undo step per drag.
//    Straight click the road twice: that stretch becomes dead straight.
//    Curve    click the road twice, then pull the middle out and click:
//             that stretch becomes one smooth curve through that spot.
//             Both show the result before the last click (red = too
//             tight for a car, and it won't do it); Esc starts again.
//    Select   click a piece, prop, core or road point to select it,
//             drag to move it, double-click the road to add a point,
//             Delete removes what is selected. Drag empty map to pan.
//             Click where the road crosses itself to pick which road
//             goes over (the panel's Swap button).
//    Bridges  with any tool, a click on a BRIDGE label selects that
//             crossing too.
//    Changes  with any tool, a click on a RAISED, BANK or WIDTH label picks
//             that whole stretch up in its own tool, its value showing.
//    Problems with any tool, a click on a problem's pin (or its red
//             tag) selects it: the panel says what's wrong and offers
//             Fix it, or takes you to the right tool.
//    Place    click to drop the chosen piece (a see-through preview
//             follows the mouse and snaps to the road). A wall ride
//             shows the whole wall it would place, its middle under
//             the mouse; a click puts it there, or drag along the
//             road to draw how long it is.
//    Height   drag along the road to pick a stretch (or click: the raised
//    Bank     stretch, bank or width already there, or a sensible stretch
//    Width    around the click), then set it in the panel. With Select, a
//             click on a raised stretch, an amber bank line or a width mark
//             picks that stretch up too.
//
//  Everywhere, with every tool: right or middle drag (or Space + drag)
//  pans, the wheel zooms where you point, WASD / arrows pan, F fits the
//  track, + and - zoom, Ctrl+Z undoes, Ctrl+Shift+Z or Ctrl+Y redoes.
//  Number keys pick a piece to place; P pencil, G bend, L straight,
//  C curve, V select, H height, B bank, N width.
//
//  On an empty map every tool but the pencil just pans, and a click says
//  how to get a road (draw a loop, or press Random track).
//
//  The 3D view (look3d.ts) uses all of this too, unchanged: the same
//  handlers, messages, refusals and Undo steps. Only "where is the
//  mouse in the world?" differs, so every handler asks look3dSpace.ts
//  (on the map it gives view.ts's answer; in 3D it asks the 3D camera:
//  the road you see under the mouse, or the ground). In 3D the right
//  button turns the view instead of panning, the middle button (or
//  Space + drag) slides it, a left-drag where the tool has nothing to
//  do turns it, and the wheel zooms; the marks are drawn on the real
//  road, the moment the 3D camera has moved (look3dSpace onPosed).
//  Esc stops a drag or a half-drawn line before anything else.
//
//  The drawing itself is in mapDraw.ts.
// ============================================================

import { useEffect, useRef } from 'react'
import { inputState } from '../core/controls'
import { closeMap } from '../core/session'
import { audio } from '../core/api'
import { askNewTrack, askVersion } from './askFirst'
import { PLACE_TOOLS, piecePlace, toolFor, tunnelFromDrag, tunnelStartFor, wallRideFromDrag, wallRideSide, wallRideStartFor } from './pieces'
import { TRACK_DEFAULTS } from '../track/schema'
import {
  type BendView,
  type EditorTool,
  EMPTY_MAP_HINT,
  mapIsEmpty,
  testDrive,
  applyCurve,
  applyStraight,
  applyStroke,
  beginBend,
  beginGesture,
  bendView,
  deleteSelection,
  endBend,
  endGesture,
  insertPointAt,
  isBending,
  liveChange,
  loopSpot,
  gestureStartAt,
  moveBend,
  placeAt,
  placeWallRideSpan,
  placeTunnelSpan,
  tunnelFootprints,
  redo,
  roadBoundFor,
  draftCrossings,
  say,
  selectCrossing,
  setBendReach,
  setTool,
  shapeWorld,
  undo,
  useEditor,
} from './draft'
import { type P } from './geom'
import { type MapExtras, type Pick, type ShapeView, crossingAtScreen, drawMap, markAtScreen, pieceScreen, pointsVisible, problemAtScreen, roadGeometry } from './mapDraw'
import { selectProblem } from './fixActions'
import { isStretchTool, runAt } from './stretchRuns'
import { marksOf, pickStretchAt, selectRun, stretchHoverLabel, stretchToPick } from './stretchTools'
import { type RedrawPlan, type RoadHit, frameAt, metresBetween, nearestOnRoad, planRedraw, straightPencilLine, wrapAt } from './road'
import { STEADY_STRING, SteadyPen, alongRoad, curveStretch, posOf, roadLine, sOf, straightStretch, stretchOf } from './shape'
import { view, panBy, setView, zoomAt, fitBox } from './view'
import { groundAt, look3dOn } from './look3d'
import { dragView, heightAt, in3d, mppAt, onPosed, pick3d, pose, roadNearest, roadUnder, setDragPlane, setRoadShown, toWorld, worldToScreen, zoomViewAt } from './look3dSpace'

/** Pixels the pointer must move before the pencil adds another point. */
const PENCIL_STEP_PX = 3
/** Place tool, a wall ride picked: pixels the pointer must move with the button down before it is a drag (draw its length), not a click. */
const PLACE_DRAG_PX = 6
/** Held-key pan speed, screen pixels per second. */
const KEY_PAN_PX = 700

export function fitToDraft(): void {
  const pts = useEditor.getState().draft.points
  if (!pts.length) {
    // An empty map: show the whole world, ready to draw in.
    setView(0, 0, 1700 / Math.max(300, view.height - 120))
    return
  }
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
  // Leave room for the panel on the right, however wide the window made it, and on the left for
  // the rail and the chosen tool's settings box beside it.
  const box = (sel: string) => (typeof document !== 'undefined' ? document.querySelector(sel)?.getBoundingClientRect() : undefined)
  const panel = box('.sre-panel')
  const left = Math.max(90, box('.sre-tools')?.right ?? 0, (box('.sre-options') ?? box('.sre-palette'))?.right ?? 0)
  fitBox(minX - pad, minZ - pad, maxX + pad, maxZ + pad, left, panel ? panel.width + 24 : 380)
}

/**
 * A key event that belongs to a form control, not to the map: anything
 * typed into a text box, and the arrow keys on a focused slider or list.
 * Letters and digits still reach the map after you touch a slider.
 */
function typing(e: KeyboardEvent): boolean {
  const t = e.target
  // 'menu': a question box (Save it first?) is up and owns the keys until it closes.
  if (inputState.context === 'text' || inputState.context === 'menu' || t instanceof HTMLTextAreaElement) return true
  if (t instanceof HTMLInputElement) return t.type !== 'range' || e.key.startsWith('Arrow')
  if (t instanceof HTMLSelectElement) return e.key.startsWith('Arrow') || e.key === 'Enter' || e.key === ' '
  return false
}

/** The thing under screen point (sx, sy) that the select tool can grab, nearest first. */
export function pickAt(sx: number, sy: number): Pick | null {
  const s = useEditor.getState()
  const d = s.draft
  const g = roadGeometry(d.points, d.width)
  let best: Pick | null = null
  let bestD = Infinity
  const consider = (pick: Pick, px: number, py: number, radius: number) => {
    const dd = Math.hypot(px - sx, py - sy)
    if (dd <= radius && dd < bestD) {
      bestD = dd
      best = pick
    }
  }
  d.pieces.forEach((p, i) => {
    const at = pieceScreen(g.rc, p)
    consider({ kind: 'piece', index: i }, at.sx, at.sy, 18)
  })
  d.props.forEach((p, i) => {
    const at = worldToScreen(p.x, p.z, 'ground')
    consider({ kind: 'prop', index: i }, at.sx, at.sy, 16)
  })
  d.cores.forEach((c, i) => {
    const at = worldToScreen(c.x, c.z, 'ground')
    consider({ kind: 'core', index: i }, at.sx, at.sy, 14)
  })
  if (pointsVisible(s)) {
    d.points.forEach((p, i) => {
      const at = worldToScreen(p.x, p.z, in3d() ? frameAt(g.rc, i).dir : null)
      // Points lose to pieces sitting on top of them.
      consider({ kind: 'point', index: i }, at.sx + 0.01, at.sy, 9)
    })
  }
  // A crossing: its marker where the roads cross, or its BRIDGE label (which always wins: it sits off the road).
  const crossing = crossingAtScreen(sx, sy)
  if (crossing && crossing.d < bestD) best = { kind: 'crossing', x: crossing.spot.x, z: crossing.spot.z }
  return best
}

/** Esc while a drag or a half-drawn pencil line is going on: stop it (set by the mounted Overlay). */
let cancelGestureNow: (() => boolean) | null = null

/**
 * Esc: stop the drag or the pencil line in progress (the line is dropped, a dragged thing
 * goes back where it was, a stretch being picked or a wall ride or tunnel being drawn is let
 * go of). True if there was one. A bend or a half-made Straight or Curve has its own (draft.ts).
 */
export function cancelPointerGesture(): boolean {
  return cancelGestureNow?.() ?? false
}

export function Overlay() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // ---- per-mount state (plain variables: no React re-renders while drawing) ----
    let stroke: P[] = []
    let drawing = false
    let panning = false
    // What a drag of the view does: pans the map; in 3D turns the view round or slides it.
    let panKind: 'turn' | 'slide' = 'turn'
    let spaceHeld = false
    let dragging: Pick | null = null
    // The draft when a Select drag began, so Esc can put it back.
    let dragStart: ReturnType<typeof useEditor.getState>['draft'] | null = null
    let dragOffset = { x: 0, z: 0 }
    let sectionAnchor: number | null = null
    let lastX = 0
    let lastY = 0
    // Our own double-click detection (pointer capture stops the browser's dblclick reaching us).
    let lastDown = { t: 0, x: 0, y: 0 }
    let hover: P | null = null
    let hoverPick: Pick | null = null
    let ghost: MapExtras['ghost'] = null
    // Place tool, a wall ride picked, button down on the road: where it went down, and whether it has moved (a drag draws the wall ride's length).
    let placeDrag: { at: number; q: P; x: number; y: number; moved: boolean } | null = null
    // Pencil: the steady pen (the line trails it) and where the pointer really is.
    let pen: SteadyPen | null = null
    let penTo: P | null = null
    // 3D: where the pen's line last reached (the pen's spot, worked out when the line grew, not again each frame).
    let penAt: P | null = null
    // Pencil with Shift held: the line is straight from `shiftAt` (where it was when Shift went down)
    // to the pointer; `shiftFrom` is how long the line was then. Null while drawing freehand.
    let shiftFrom: number | null = null
    let shiftAt: P | null = null
    let shiftSaid = false
    // Select: a press on empty road, so a click (not a drag) there can pick up a raised, banked or widened stretch.
    let roadClick: { x: number; y: number } | null = null
    // What letting go of the pencil would do (road.ts planRedraw), worked out at most once a frame.
    let pencilPlan: RedrawPlan | 'new' | null = null
    let pencilDirty = false
    // Bend: the highlighted stretch (hovering or dragging).
    let bending = false
    let bendShown: BendView | null = null
    // Height, Bank and Width, before a click: the stretch a click here would pick (worked out at most once a frame).
    let stretchShown: MapExtras['stretchHover'] = null
    let stretchDirty = false
    // Straight and Curve: the preview, worked out at most once a frame.
    let shapeShown: ShapeView | null = null
    let shapeDirty = false
    let shapeSaid = ''
    let pointer = { x: 0, y: 0 }
    // A press off the road with Straight or Curve pans; a click there (no drag) says what to do.
    let hintOnClick: { x: number; y: number } | null = null
    const held = new Set<string>()
    let needsDraw = true
    let drawnVersion = -1
    // 3D: the camera pose drawn last (look3dSpace pose.version).
    let drawnPose = -1
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

    const setCursor = () => {
      const s = useEditor.getState()
      if (panning) canvas.style.cursor = 'grabbing'
      else if (spaceHeld || s.mode === 'map' || (s.tool !== 'pencil' && mapIsEmpty())) canvas.style.cursor = 'grab'
      else if (s.tool === 'select') canvas.style.cursor = dragging ? 'grabbing' : hoverPick ? 'pointer' : 'default'
      else if (s.tool === 'bend') canvas.style.cursor = bending ? 'grabbing' : bendShown ? 'grab' : 'default'
      else if (s.tool === 'place' || isStretchTool(s.tool)) canvas.style.cursor = 'copy'
      else canvas.style.cursor = 'crosshair'
    }

    /** Move whatever is being dragged so it sits under world point q. */
    const dragTo = (q: P) => {
      const pick = dragging
      if (!pick || pick.kind === 'crossing') return
      const target = { x: q.x - dragOffset.x, z: q.z - dragOffset.z }
      const bound = roadBoundFor()
      const clamp = (v: number) => Math.round(Math.max(-bound, Math.min(bound, v)) * 10) / 10
      liveChange((d) => {
        if (pick.kind === 'point') {
          const p = d.points[pick.index]
          if (p) {
            p.x = clamp(target.x)
            p.z = clamp(target.z)
          }
        } else if (pick.kind === 'prop' || pick.kind === 'core') {
          const p = pick.kind === 'prop' ? d.props[pick.index] : d.cores[pick.index]
          if (p) {
            p.x = clamp(target.x)
            p.z = clamp(target.z)
          }
        } else {
          const piece = d.pieces[pick.index]
          if (!piece) return
          const rc = roadGeometry(d.points, d.width).rc
          const hit = roadNearest(rc, target)
          // Wall rides are grabbed by their middle but stored by where they start (their length stays the same).
          if (piece.type === 'wallride') piece.at = wallRideStartFor(rc, hit.at, piece.length ?? TRACK_DEFAULTS.wallride.length)
          else piece.at = Math.round(wrapAt(hit.at, d.points.length) * 100) / 100
          if (piece.type === 'boost' || piece.type === 'ramp') {
            const pieceW = piece.width ?? (piece.type === 'boost' ? 5 : 8)
            const room = Math.max(0, d.width / 2 - pieceW / 2 - 0.3)
            const off = Math.abs(hit.lateral) < 1.5 ? 0 : Math.max(-room, Math.min(room, hit.lateral))
            if (off) piece.offset = Math.round(off * 10) / 10
            else delete piece.offset
          }
        }
      })
    }

    /** The spot on the road under screen point (sx, sy), or null if the pointer is off the road (any zoom). */
    const roadHitAt = (sx: number, sy: number): RoadHit | null => {
      const d = useEditor.getState().draft
      // 3D: the road you see under the mouse (or within 12 pixels of it), never one behind a hill.
      if (in3d()) return roadUnder(roadGeometry(d.points, d.width).rc, sx, sy)
      const hit = nearestOnRoad(roadGeometry(d.points, d.width).rc, toWorld(sx, sy))
      return hit.distance <= d.width / 2 + Math.max(4, 12 * view.mpp) ? hit : null
    }

    /**
     * Select: a click on the road where Josh changed something (a bank, a width,
     * raised road) picks that whole stretch up in its own tool, its value showing.
     * The amber bank line is the easiest to see, so it wins where they overlap.
     */
    const pickRunAt = (sx: number, sy: number) => {
      const s = useEditor.getState()
      if (s.tool !== 'select' || s.mode !== 'edit') return
      const hit = roadHitAt(sx, sy)
      if (!hit) return
      const marks = marksOf(s.draft)
      const n = s.draft.points.length
      const run = runAt(marks, 'bank', hit.at, n) ?? runAt(marks, 'width', hit.at, n) ?? runAt(marks, 'height', hit.at, n)
      if (run) {
        selectRun(run)
        needsDraw = true
      }
    }

    /** While bending: say once when it turns too tight, and once when it is fine again. */
    let bendTightSaid = false
    const bendWarn = () => {
      const tight = !!bendShown?.tight
      if (tight === bendTightSaid) return
      bendTightSaid = tight
      if (tight) say('Too tight for a car there! Pull less, or roll the mouse wheel to bring more road along. If you let go now it gets opened out, or put back if it can\'t be.', 'warn')
      else say('Let go to keep the bend, or press Esc to put it back.', 'info')
    }

    /** Height, Bank or Width, before pressing: the stretch a click here would pick, with its length. */
    const stretchHover = (): MapExtras['stretchHover'] => {
      const s = useEditor.getState()
      if (!isStretchTool(s.tool) || s.mode !== 'edit' || sectionAnchor !== null || mapIsEmpty()) return null
      const hit = roadHitAt(pointer.x, pointer.y)
      if (!hit) return null
      const pick = stretchToPick(s.tool, s.draft, hit.at)
      // Already the picked stretch: it is drawn (with its length) already.
      const sel = s.selection
      if (sel?.kind === 'section' && Math.abs(sel.from - pick.from) < 1e-3 && Math.abs(sel.to - pick.to) < 1e-3) return null
      return { from: pick.from, to: pick.to, label: stretchHoverLabel(s.draft, pick) }
    }

    /** Bend, before pressing: light up the stretch that would come with your hand. */
    const bendHover = () => {
      const s = useEditor.getState()
      const hit = s.tool === 'bend' && !bending ? roadHitAt(pointer.x, pointer.y) : null
      if (!hit) {
        bendShown = null
        return
      }
      const line = roadLine(s.draft.points)
      bendShown = bendView(s.draft.points, sOf(line, hit.at), s.bendReach)
    }

    /**
     * Straight and Curve: what would happen if you clicked now. Worked out in
     * the frame loop (at most once a frame), with the reason in the status
     * line whenever it changes.
     */
    const shapePreview = (): ShapeView | null => {
      const s = useEditor.getState()
      if ((s.tool !== 'straight' && s.tool !== 'curve') || s.mode !== 'edit') return null
      const d = s.draft
      const sh = s.shaping?.tool === s.tool ? s.shaping : null
      const hit = roadHitAt(pointer.x, pointer.y)
      if (!sh) return hit ? { marks: [hit.p], pull: null, old: [], preview: [], ok: true, tight: null } : null
      const line = roadLine(d.points)
      const sA = sOf(line, sh.a)
      const A = posOf(line, sA)
      /** The shorter way round between two spots: the stretch that changes. */
      const between = (sB: number) => {
        const fwd = ((sB - sA) % line.length + line.length) % line.length
        return fwd <= line.length / 2 ? stretchOf(line, sA, sA + fwd, 4) : stretchOf(line, sB, sB + line.length - fwd, 4)
      }
      if (s.tool === 'straight') {
        if (!hit) return { marks: [A], pull: null, old: [], preview: [], ok: true, tight: null }
        const res = straightStretch(d.points, sh.a, hit.at, shapeWorld(d))
        tell(res.ok ? '' : (res.reason ?? ''), 'Click to make it straight.')
        return { marks: [A, hit.p], pull: null, old: between(sOf(line, hit.at)), preview: res.preview, ok: res.ok, tight: res.ok ? null : res.tightAt }
      }
      if (sh.b === null) {
        if (!hit) return { marks: [A], pull: null, old: [], preview: [], ok: true, tight: null }
        const far = alongRoad(sA, sOf(line, hit.at), line.length) >= 30
        return { marks: [A, hit.p], pull: null, old: between(sOf(line, hit.at)), preview: [], ok: far, tight: null }
      }
      const sB = sOf(line, sh.b)
      const B = posOf(line, sB)
      const pull = toWorld(pointer.x, pointer.y)
      const res = curveStretch(d.points, sh.a, sh.b, pull, shapeWorld(d))
      tell(res.ok ? '' : (res.reason ?? ''), 'Click to make the curve.')
      return { marks: [A, B], pull, old: between(sB), preview: res.preview, ok: res.ok, tight: res.ok ? null : res.tightAt }
    }
    /**
     * Say a preview's problem once (not on every mouse move), and when it is
     * fixed again, what to do next, so an old warning never hangs about.
     */
    const tell = (reason: string, okPrompt: string) => {
      if (reason === shapeSaid) return
      const wasBad = shapeSaid !== ''
      shapeSaid = reason
      if (reason) say(reason, 'warn')
      else if (wasBad) say(okPrompt, 'info')
    }

    /**
     * The pencil and Shift. Shift down while drawing: the line from here on is
     * straight, from where it was to the pointer (`to`). Shift up: it carries on
     * freehand from the end of the straight bit. (sx, sy) is the pointer on screen.
     */
    const pencilShift = (shift: boolean, to: P, sx: number, sy: number) => {
      if (!drawing) return
      if (shift) {
        if (shiftFrom === null) {
          // Straight from exactly where the line is now: the pen (the pointer itself with the steady
          // hand off). The line only gains a point every few pixels, so add this one if it is new.
          const at = pen ? toWorld(pen.x, pen.y) : to
          const last = stroke[stroke.length - 1]
          if (!last || Math.hypot(at.x - last.x, at.z - last.z) > 0.05) stroke.push(at)
          shiftFrom = stroke.length
          shiftAt = at
          if (!shiftSaid) {
            shiftSaid = true
            say('Straight line: let go of Shift to carry on drawing freehand.', 'info')
          }
        }
        stroke.length = shiftFrom
        // (A point every 3 pixels: in 3D, pixels where the line ends.)
        if (shiftAt) stroke.push(...straightPencilLine(shiftAt, to, Math.max(0.5, PENCIL_STEP_PX * mppAt(to.x, to.z))))
        penTo = to
        pencilDirty = true
        needsDraw = true
      } else if (shiftFrom !== null) {
        // Freehand again, from the end of the straight bit (the pen starts again where the pointer is).
        shiftFrom = null
        shiftAt = null
        pen?.start(sx, sy)
        lastX = sx
        lastY = sy
      }
    }

    // ---- pointer ----
    const onDown = (e: PointerEvent) => {
      // Clicking the map takes the keyboard back from any panel control.
      if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur()
      canvas.setPointerCapture(e.pointerId)
      lastX = e.clientX
      lastY = e.clientY
      const s = useEditor.getState()
      setDragPlane(null)
      setRoadShown(!mapIsEmpty())
      let q = toWorld(e.clientX, e.clientY)
      // The right (or middle) button, or Space, drags the map whatever the tool.
      // In 3D: the right button turns the view round, the middle one (or Space) slides it.
      const wantsPan = e.button === 1 || e.button === 2 || spaceHeld || s.mode === 'map'
      panKind = e.button === 2 ? 'turn' : e.button === 1 || spaceHeld ? 'slide' : 'turn'
      if (wantsPan) {
        panning = true
        setCursor()
        return
      }
      if (e.button !== 0) return
      // A problem's pin (or its tag) works with every tool: select that problem (the panel shows what to do).
      const pin = problemAtScreen(e.clientX, e.clientY)
      if (pin && selectProblem(pin, false)) {
        needsDraw = true
        return
      }
      if (s.tool !== 'pencil' && mapIsEmpty()) {
        // No road for this tool to work on: drag the map, and a click says how to get a road.
        panning = true
        hintOnClick = { x: e.clientX, y: e.clientY }
        setCursor()
        return
      }
      // A BRIDGE label works with every tool: select that crossing (the panel shows its Swap button).
      if (s.tool !== 'select') {
        const label = crossingAtScreen(e.clientX, e.clientY, true)
        if (label && selectCrossing(label.spot)) {
          needsDraw = true
          return
        }
      }
      // A RAISED, BANK or WIDTH label works with every tool: pick that stretch up in its own tool.
      const mark = markAtScreen(e.clientX, e.clientY)
      if (mark) {
        selectRun(mark)
        needsDraw = true
        return
      }
      if (s.tool === 'pencil') {
        drawing = true
        shiftFrom = null
        shiftAt = null
        shiftSaid = false
        stroke = [q]
        // The steady hand: the line follows a pen that trails the pointer on a string.
        pen = new SteadyPen(STEADY_STRING[s.steady] ?? 0)
        pen.start(e.clientX, e.clientY)
        penTo = q
        penAt = q
        pencilPlan = null
        pencilDirty = true
        needsDraw = true
        return
      }
      if (s.tool === 'bend') {
        const hit = roadHitAt(e.clientX, e.clientY)
        if (!hit) {
          // Off the road: drag the map instead.
          panning = true
          setCursor()
          return
        }
        // 3D: the grabbed road follows the mouse across a flat sheet at its own height.
        if (in3d()) {
          setDragPlane(pick3d(e.clientX, e.clientY)?.y ?? heightAt(hit.p.x, hit.p.z, frameAt(roadGeometry(s.draft.points, s.draft.width).rc, hit.at).dir))
          q = toWorld(e.clientX, e.clientY)
        }
        // The grab point is where the pointer is, so the road moves exactly as far as the mouse does.
        beginBend(hit.at, q)
        bending = true
        bendTightSaid = false
        bendShown = moveBend(q)
        setCursor()
        needsDraw = true
        return
      }
      if (s.tool === 'straight' || s.tool === 'curve') {
        const sh = s.shaping?.tool === s.tool ? s.shaping : null
        if (sh && sh.tool === 'curve' && sh.b !== null) {
          // Third click (anywhere): the curve goes through here.
          applyCurve(sh.a, sh.b, q)
          shapeDirty = true
          needsDraw = true
          return
        }
        const hit = roadHitAt(e.clientX, e.clientY)
        if (!hit) {
          panning = true
          hintOnClick = { x: e.clientX, y: e.clientY }
          setCursor()
          return
        }
        if (!sh) {
          useEditor.setState({ shaping: { tool: s.tool, a: hit.at, b: null } })
          say(s.tool === 'straight' ? 'Now click the road where the straight should end.' : 'Now click the road where the curve should end.', 'info')
          audio.ui('select')
        } else if (sh.tool === 'straight') {
          applyStraight(sh.a, hit.at)
        } else {
          const line = roadLine(s.draft.points)
          if (alongRoad(sOf(line, sh.a), sOf(line, hit.at), line.length) < 30) {
            say('Pick a spot further along the road (at least 30 m from the first one).', 'warn')
            audio.ui('error')
          } else {
            useEditor.setState({ shaping: { ...sh, b: hit.at } })
            say('Now move the mouse to pull the middle of the curve out, and click.', 'info')
            audio.ui('select')
          }
        }
        shapeSaid = ''
        shapeDirty = true
        needsDraw = true
        return
      }
      if (s.tool === 'place') {
        // A wall ride or tunnel: a click puts its middle here, a drag along the road draws how long it is (decided when the button comes up).
        if (wallRideSide(s.placeKind) || s.placeKind === 'tunnel') {
          const hit = roadNearest(roadGeometry(s.draft.points, s.draft.width).rc, q)
          if (hit.distance <= s.draft.width / 2 + 12) {
            placeDrag = { at: hit.at, q, x: e.clientX, y: e.clientY, moved: false }
            return
          }
        }
        // 3D: on the road you clicked (at a crossing, the one you're looking at).
        placeAt(q, in3d() ? roadNearest(roadGeometry(s.draft.points, s.draft.width).rc, q) : undefined)
        needsDraw = true
        return
      }
      if (isStretchTool(s.tool)) {
        const g = roadGeometry(s.draft.points, s.draft.width)
        const hit = roadNearest(g.rc, q)
        if (hit.distance > s.draft.width / 2 + 14) {
          useEditor.setState({ selection: null })
          say('Drag along the road to pick a stretch of it, or click the road.', 'info')
          return
        }
        sectionAnchor = hit.at
        stretchShown = null
        useEditor.setState({ selection: { kind: 'section', from: hit.at, to: hit.at } })
        return
      }
      // Select tool. A second press within 350 ms on the same spot is a double-click: add a road point.
      const now = performance.now()
      const isDouble = now - lastDown.t < 350 && Math.hypot(e.clientX - lastDown.x, e.clientY - lastDown.y) < 6
      lastDown = { t: isDouble ? 0 : now, x: e.clientX, y: e.clientY }
      if (isDouble) {
        panning = false
        onDouble(e)
        return
      }
      const pick = pickAt(e.clientX, e.clientY)
      if (pick?.kind === 'crossing') {
        // A crossing can't be dragged: select it, and the panel offers the swap.
        selectCrossing(pick)
      } else if (pick) {
        useEditor.setState({ selection: pick })
        dragging = pick
        const d = s.draft
        const anchor = pickWorld(pick)
        // 3D: what you grabbed slides on a flat sheet at its own height, under your hand.
        if (in3d() && anchor) {
          setDragPlane(pickHeight(pick, anchor))
          q = toWorld(e.clientX, e.clientY)
        }
        dragOffset = anchor ? { x: q.x - anchor.x, z: q.z - anchor.z } : { x: 0, z: 0 }
        dragStart = d
        if (d) beginGesture()
      } else {
        useEditor.setState({ selection: null })
        panning = true
        roadClick = { x: e.clientX, y: e.clientY }
      }
      setCursor()
    }
    const onMove = (e: PointerEvent) => {
      // 3D, drawing with the steady hand: only the pen's spot is picked (once a frame); the mouse's own
      // spot is picked when the button comes up, where the line ends (see onUp).
      const penOnly = drawing && shiftFrom === null && !e.shiftKey && !!pen && pen.stringPx > 0 && in3d() && !!penAt
      const q = penOnly && penAt ? penAt : toWorld(e.clientX, e.clientY)
      hover = q
      pointer = { x: e.clientX, y: e.clientY }
      const s = useEditor.getState()
      if (panning) {
        dragView(panKind, e.clientX - lastX, e.clientY - lastY)
        lastX = e.clientX
        lastY = e.clientY
        return
      }
      if (drawing && (e.shiftKey || shiftFrom !== null)) pencilShift(e.shiftKey, q, e.clientX, e.clientY)
      if (drawing && shiftFrom !== null) {
        // Shift is held: the straight line already follows the pointer.
      } else if (drawing) {
        // The line is drawn where the pen is; with the steady hand off, the pen IS the pointer.
        if (!penOnly) penTo = q
        if (pen) pen.follow(e.clientX, e.clientY)
        const px = pen ? pen.x : e.clientX
        const py = pen ? pen.y : e.clientY
        if (Math.hypot(px - lastX, py - lastY) >= PENCIL_STEP_PX) {
          penAt = toWorld(px, py)
          stroke.push(penAt)
          lastX = px
          lastY = py
          // (3D with the steady hand: what letting go would do is shown up to the pen.)
          if (penOnly) {
            penTo = penAt
            hover = penAt
          }
        }
        pencilDirty = true
      } else if (bending) {
        if (isBending()) {
          bendShown = moveBend(q)
          bendWarn()
        } else bending = false // Esc stopped it; wait for the button to come up
      } else if (s.tool === 'bend') {
        bendHover()
        setCursor()
      } else if (s.tool === 'straight' || s.tool === 'curve') {
        shapeDirty = true
      } else if (isStretchTool(s.tool) && sectionAnchor === null) {
        stretchDirty = true
      } else if (dragging) {
        dragTo(q)
      } else if (sectionAnchor !== null) {
        const g = roadGeometry(s.draft.points, s.draft.width)
        const hit = roadNearest(g.rc, q)
        // The section runs forward from the earlier end to the later one.
        const forward = metresBetween(g.rc, sectionAnchor, hit.at)
        const backward = metresBetween(g.rc, hit.at, sectionAnchor)
        const sel = forward <= backward ? { from: sectionAnchor, to: hit.at } : { from: hit.at, to: sectionAnchor }
        useEditor.setState({ selection: { kind: 'section', ...sel } })
      } else if (s.tool === 'select') {
        hoverPick = pickAt(e.clientX, e.clientY)
        setCursor()
      } else if (placeDrag) {
        // Drawing a wall ride: once the pointer has moved, the wall covers the stretch dragged.
        if (!placeDrag.moved && Math.hypot(e.clientX - placeDrag.x, e.clientY - placeDrag.y) >= PLACE_DRAG_PX) placeDrag.moved = true
        const side = wallRideSide(s.placeKind)
        if (placeDrag.moved && side) {
          const rc = roadGeometry(s.draft.points, s.draft.width).rc
          const span = wallRideFromDrag(rc, placeDrag.at, roadNearest(rc, q).at)
          const f = frameAt(rc, span.at)
          ghost = { kind: s.placeKind, at: f.p, dir: f.dir, wall: { at: span.at, length: span.length, side, dragged: { from: span.from, to: span.to }, cut: span.cut } }
        } else if (placeDrag.moved && s.placeKind === 'tunnel') {
          const rc = roadGeometry(s.draft.points, s.draft.width).rc
          const span = tunnelFromDrag(rc, placeDrag.at, roadNearest(rc, q).at)
          const f = frameAt(rc, span.at)
          ghost = { kind: s.placeKind, at: f.p, dir: f.dir, tunnel: { at: span.at, length: span.length, cut: span.cut } }
        }
      } else if (s.tool === 'place') {
        const tool = toolFor(s.placeKind)
        if (tool.onRoad) {
          const g = roadGeometry(s.draft.points, s.draft.width)
          const hit = roadNearest(g.rc, q)
          if (hit.distance < s.draft.width / 2 + 12) {
            // A wall ride shows the whole wall a click would place, its middle under the pointer.
            const side = wallRideSide(s.placeKind)
            const length = TRACK_DEFAULTS.wallride.length
            const wall = side ? { at: wallRideStartFor(g.rc, hit.at, length), length, side, dragged: null, cut: null } : undefined
            // A tunnel shows the stretch a click would cover, its middle under the pointer.
            const tl = TRACK_DEFAULTS.tunnelLength
            const tunnel = s.placeKind === 'tunnel' ? { at: tunnelStartFor(g.rc, hit.at, tl), length: tl, cut: null } : undefined
            ghost = { kind: s.placeKind, at: hit.p, dir: frameAt(g.rc, hit.at).dir, wall, tunnel }
          } else ghost = null
        } else ghost = { kind: s.placeKind, at: q, dir: { x: 1, z: 0 } }
      }
      needsDraw = true
    }
    const onUp = (e: PointerEvent) => {
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
      // (Read where the button came up first, on the sheet if dragging, then let go of the sheet.)
      const upAt = toWorld(e.clientX, e.clientY)
      setDragPlane(null)
      if (panning) {
        panning = false
        // Select: a click (not a drag) on a raised stretch, an amber bank line or a width mark picks that stretch up.
        const click = roadClick
        roadClick = null
        if (click && Math.hypot(e.clientX - click.x, e.clientY - click.y) < 5) pickRunAt(e.clientX, e.clientY)
        // Straight or Curve: a click off the road (not a drag) gets a hint.
        if (hintOnClick && Math.hypot(e.clientX - hintOnClick.x, e.clientY - hintOnClick.y) < 5) {
          const tool = useEditor.getState().tool
          if (mapIsEmpty()) say(EMPTY_MAP_HINT, 'info')
          else say(tool === 'curve' ? 'Click on the road where the curve should start.' : 'Click on the road where the straight should start.', 'info')
        }
        hintOnClick = null
        setCursor()
        return
      }
      if (bending) {
        bending = false
        endBend()
        bendHover()
        setCursor()
        needsDraw = true
        return
      }
      if (placeDrag) {
        // A wall ride: a drag places one covering the stretch dragged, a click one with its middle where you clicked.
        const pd = placeDrag
        placeDrag = null
        if (pd.moved) {
          const st = useEditor.getState()
          const d = st.draft
          const to = roadNearest(roadGeometry(d.points, d.width).rc, upAt).at
          if (st.placeKind === 'tunnel') placeTunnelSpan(pd.at, to)
          else placeWallRideSpan(pd.at, to)
        } else placeAt(pd.q)
        // The hover preview comes back when the pointer next moves (not on top of the one just placed).
        ghost = null
        needsDraw = true
        return
      }
      if (dragging) {
        const was = dragging
        dragging = null
        dragStart = null
        // A dragged loop settles on the nearest straight, level stretch (or goes back if there is none).
        // A click that only selected it (no move) leaves it exactly where it is.
        if (was.kind === 'piece') {
          const piece = useEditor.getState().draft.pieces[was.index]
          const startAt = gestureStartAt(was.index)
          const moved = !!piece && startAt !== null && Math.abs(piece.at - startAt) > 1e-6
          if (piece?.type === 'loop' && moved) {
            const spot = loopSpot(piece.at)
            if (spot === null) {
              say('A loop needs a straight, flat stretch about 140 m long. It went back where it was.', 'warn')
              liveChange((d) => {
                d.pieces[was.index].at = gestureStartAt(was.index) ?? piece.at
              })
            } else
              liveChange((d) => {
                d.pieces[was.index].at = Math.round(spot * 100) / 100
              })
          }
        }
        endGesture()
        setCursor()
        return
      }
      if (sectionAnchor !== null) {
        const s = useEditor.getState()
        const sel = s.selection
        if (sel?.kind === 'section') {
          const g = roadGeometry(s.draft.points, s.draft.width)
          // A click without a drag picks up the change already there, or a sensible stretch around it (stretchTools.ts).
          const metres = metresBetween(g.rc, sel.from, sel.to)
          if (metres < 8 && isStretchTool(s.tool)) pickStretchAt(s.tool, sel.from)
          else say(`Picked ${Math.round(metres)} m of road. Now set its ${s.tool === 'bank' ? 'bank' : s.tool === 'width' ? 'width' : 'height'} in the panel.`, 'info')
        }
        sectionAnchor = null
        stretchDirty = true
        return
      }
      if (!drawing) return
      drawing = false
      const done = stroke
      // The pen trails the pointer: finish the line where the pointer let go, so a
      // stroke ending on the road (a stretch redraw) really ends there.
      if (pen && pen.stringPx > 0) {
        const end = toWorld(e.clientX, e.clientY)
        const last = done[done.length - 1]
        if (last && Math.hypot(end.x - last.x, end.z - last.z) > 0.5) done.push(end)
      }
      pen = null
      penTo = null
      pencilPlan = null
      shiftFrom = null
      shiftAt = null
      stroke = []
      needsDraw = true
      if (done.length < 4) {
        // A click, not a line: say how the pencil works on this map.
        if (!mapIsEmpty()) say('Hold the mouse button down and draw: start on the road and end back on the road to redraw the bit in between.', 'info')
        return
      }
      // How many metres a pixel is where the line was drawn (on the map, everywhere the same; in 3D at its middle).
      const mid = done[Math.floor(done.length / 2)]
      applyStroke(done, mppAt(mid.x, mid.z))
    }
    function onDouble(e: PointerEvent) {
      const s = useEditor.getState()
      if (s.tool !== 'select' || s.mode !== 'edit') return
      if (pickAt(e.clientX, e.clientY)?.kind === 'point') return
      const g = roadGeometry(s.draft.points, s.draft.width)
      const hit = roadNearest(g.rc, toWorld(e.clientX, e.clientY))
      if (hit.distance <= s.draft.width / 2 + 4) insertPointAt(hit.at)
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const lines = e.deltaMode === 1 ? 16 : 1
      if (bending && isBending()) {
        // While bending, the wheel changes how much road comes along (up = more).
        const s = useEditor.getState()
        setBendReach(s.bendReach * Math.exp(-e.deltaY * lines * 0.0015))
        bendShown = moveBend()
        bendWarn()
        needsDraw = true
        return
      }
      zoomViewAt(e.clientX, e.clientY, Math.exp(e.deltaY * lines * 0.0015))
      if (useEditor.getState().tool === 'bend') bendHover()
    }
    const onContext = (e: Event) => e.preventDefault()
    const onLeave = () => {
      ghost = null
      hover = null
      if (!bending) bendShown = null
      stretchShown = null
      shapeDirty = true
      pointer = { x: -9999, y: -9999 }
      needsDraw = true
    }

    // ---- keyboard ----
    const toolKeys: Record<string, EditorTool> = { KeyP: 'pencil', KeyG: 'bend', KeyL: 'straight', KeyC: 'curve', KeyV: 'select', KeyH: 'height', KeyB: 'bank', KeyN: 'width' }
    const onKeyDown = (e: KeyboardEvent) => {
      if (typing(e)) return
      // In 3D the tools' keys work as on the map; moving the view (WASD, arrows, + and -) is the
      // 3D view's own (Look3dUi.tsx), and F (fit the map) waits for the map.
      const on3d = look3dOn()
      // Shift while drawing: straight from here (the pointer may not move before it is let go).
      if (e.key === 'Shift' && drawing) {
        pencilShift(true, toWorld(pointer.x, pointer.y), pointer.x, pointer.y)
        return
      }
      const mod = e.ctrlKey || e.metaKey
      // Mid-bend, Undo would pull the road out from under your hand: let go first (or Esc).
      if (mod && bending && (e.code === 'KeyZ' || e.code === 'KeyY')) {
        e.preventDefault()
        return
      }
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
      if (useEditor.getState().mode === 'map') {
        if (e.code === 'KeyF') fitToDraft()
        held.add(e.code)
        return
      }
      if (e.code === 'Space') {
        spaceHeld = true
        setCursor()
        e.preventDefault()
        return
      }
      if (e.code === 'Delete' || e.code === 'Backspace') {
        e.preventDefault()
        deleteSelection()
        return
      }
      if (toolKeys[e.code] && !bending && !drawing) {
        const before = useEditor.getState().tool
        setTool(toolKeys[e.code])
        if (toolKeys[e.code] !== 'pencil' && before !== toolKeys[e.code] && mapIsEmpty()) say(EMPTY_MAP_HINT, 'info')
      }
      // [ and ] change how much road Bend moves (also while dragging).
      if ((e.code === 'BracketLeft' || e.code === 'BracketRight') && useEditor.getState().tool === 'bend') {
        const s = useEditor.getState()
        setBendReach(s.bendReach * (e.code === 'BracketRight' ? 1.25 : 1 / 1.25))
        if (bending && isBending()) bendShown = moveBend()
        else bendHover()
        say(`Bend reach: ${useEditor.getState().bendReach} m each way.`, 'info')
        needsDraw = true
      }
      const digit = /^Digit(\d)$/.exec(e.code)
      if (digit) {
        const tool = PLACE_TOOLS.find((t) => t.key === digit[1])
        if (tool) setTool('place', tool.kind)
      }
      if (on3d) return
      if (e.code === 'KeyF') fitToDraft()
      if (e.code === 'Equal' || e.code === 'NumpadAdd') zoomAt(view.width / 2, view.height / 2, 1 / 1.25)
      if (e.code === 'Minus' || e.code === 'NumpadSubtract') zoomAt(view.width / 2, view.height / 2, 1.25)
      held.add(e.code)
    }
    const onKeyUp = (e: KeyboardEvent) => {
      held.delete(e.code)
      if (e.key === 'Shift') pencilShift(false, toWorld(pointer.x, pointer.y), pointer.x, pointer.y)
      if (e.code === 'Space') {
        spaceHeld = false
        setCursor()
      }
    }
    const onBlur = () => {
      held.clear()
      spaceHeld = false
    }

    // ---- the loop: held-key panning, then redraw if anything changed ----
    const unsub = useEditor.subscribe((s, prev) => {
      needsDraw = true
      if (s.tool !== prev.tool) {
        ghost = null
        bendShown = null
        shapeShown = null
        stretchShown = null
        setCursor()
      }
      // The road, the tool or the picked stretch changed: what a click would pick (and whether it is new) may be different now.
      if (s.draft !== prev.draft || s.tool !== prev.tool || s.selection !== prev.selection) stretchDirty = true
      // The road or a half-made Straight / Curve changed: work the preview out again.
      if (s.draft !== prev.draft || s.shaping !== prev.shaping || s.tool !== prev.tool) {
        shapeDirty = true
        if (s.shaping !== prev.shaping) shapeSaid = ''
      }
      if (s.bendReach !== prev.bendReach && !bending) bendHover()
    })
    // ---- controller: left stick pans, triggers zoom, X undo, Y redo, B new track, hold View to test drive ----
    const padWas: boolean[] = []
    let padHinted = false
    let viewHeldFor = 0
    /** B went down on the map: New track (or its "Save it first?") happens when it comes back up. */
    let clearArmed = false
    let askSeen = askVersion()
    const pollPad = (dt: number) => {
      const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : []
      let pad: Gamepad | null = null
      for (const p of pads) if (p && p.connected) pad = pad ?? p
      if (!pad) return
      if (inputState.context === 'menu' || askSeen !== askVersion()) {
        // A question box is up (or just opened or closed): the menu controls drive it, not
        // the map. Whatever is held now counts as already down, so the B (or A) that closed
        // it can't also act on the map, or open it again, when it comes back up.
        askSeen = askVersion()
        clearArmed = false
        for (let i = 0; i < pad.buttons.length; i++) padWas[i] = pad.buttons[i].pressed
        return
      }
      if (look3dOn()) {
        // The 3D view drives the controller (Look3dUi.tsx). Keep track of what is held, so the
        // B that goes back to the map can't also count as a press here when it comes up.
        clearArmed = false
        viewHeldFor = 0
        for (let i = 0; i < pad.buttons.length; i++) padWas[i] = pad.buttons[i].pressed
        return
      }
      const dead = (v: number) => (Math.abs(v) < 0.18 ? 0 : (v - Math.sign(v) * 0.18) / 0.82)
      const lx = dead(pad.axes[0] ?? 0)
      const ly = dead(pad.axes[1] ?? 0)
      const lt = pad.buttons[6]?.value ?? 0
      const rt = pad.buttons[7]?.value ?? 0
      const pressed = (i: number) => !!pad!.buttons[i]?.pressed
      const edge = (i: number) => pressed(i) && !padWas[i]
      const any = lx || ly || lt > 0.1 || rt > 0.1 || pad.buttons.some((b) => b.pressed)
      if (any && !padHinted) {
        padHinted = true
        say(
          useEditor.getState().mode === 'map'
            ? 'Controller: left stick moves the map, triggers zoom. B or Menu: back to the pause menu.'
            : 'Controller: left stick moves the map, triggers zoom, X undo, Y redo, B new track, hold View to test drive. Menu leaves.',
          'info',
        )
      }
      // The world map: B goes back to the pause menu, the same as Menu or Esc.
      if (useEditor.getState().mode === 'map' && edge(1)) closeMap()
      if (lx || ly) panBy(-lx * 900 * dt, -ly * 900 * dt)
      if (lt > 0.05 || rt > 0.05) zoomAt(view.width / 2, view.height / 2, Math.exp((lt - rt) * 1.6 * dt))
      if (useEditor.getState().mode === 'edit') {
        if (edge(2)) undo()
        if (edge(3)) redo()
        // B starts a new track when it is let go (asking "Save it first?" if there are
        // changes not saved), so the same press can't also reach the question as its
        // own "back" (cancel) the moment it opens.
        if (edge(1)) clearArmed = true
        if (clearArmed && !pressed(1)) {
          clearArmed = false
          askNewTrack()
        }
        if (pressed(8)) {
          viewHeldFor += dt
          if (viewHeldFor > 0.8) {
            viewHeldFor = -999 // once per hold
            testDrive()
          }
        } else viewHeldFor = 0
      }
      for (let i = 0; i < pad.buttons.length; i++) padWas[i] = pad.buttons[i].pressed
    }

    /** Has the view moved since the last drawing (the map's view, or in 3D the camera)? */
    const viewMoved = () => (in3d() ? drawnPose !== pose.version : drawnVersion !== view.version)
    /**
     * Once a frame: what the tools would do where the mouse is (worked out at most once a frame,
     * however fast the mouse moves), then a redraw if anything changed.
     */
    const frameWork = () => {
      // 3D: an empty map's hidden stand-in road is never picked or drawn on.
      setRoadShown(!mapIsEmpty())
      // The pencil's "what will letting go do?": once a frame at most, on the line so far plus where the pointer is.
      if (drawing && pencilDirty) {
        pencilDirty = false
        pencilPlan = pencilPreview(stroke, penTo)
        needsDraw = true
      }
      // Height, Bank and Width hover: once a frame at most (and again when the view moves under the pointer).
      if (stretchDirty || (viewMoved() && stretchShown)) {
        stretchDirty = false
        stretchShown = stretchHover()
        needsDraw = true
      }
      // Straight and Curve previews: once a frame at most, however fast the mouse moves.
      if (shapeDirty || (viewMoved() && shapeShown)) {
        shapeDirty = false
        shapeShown = shapePreview()
        needsDraw = true
      }
      // The world map follows moving cars, so it redraws every frame.
      if (needsDraw || viewMoved() || useEditor.getState().mode === 'map') {
        drawnVersion = view.version
        drawnPose = pose.version
        needsDraw = false
        drawMap(ctx, useEditor.getState(), {
          stroke,
          hover,
          ghost,
          hoverPick,
          crossings: draftCrossings(),
          bend: bendShown ? { view: bendShown, dragging: bending } : null,
          shape: shapeShown,
          pen: drawing && pen && pen.stringPx > 0 && penTo ? { at: in3d() && penAt ? penAt : toWorld(pen.x, pen.y), to: penTo } : null,
          pencil: drawing ? pencilPlan : null,
          marks: marksOf(useEditor.getState().draft),
          stretchHover: stretchShown,
          tunnels: tunnelFootprints(ghost?.tunnel ?? null, ghost?.at ?? null),
        })
      }
    }
    // 3D: the frame's work happens right after the 3D camera is placed (so the marks sit on the picture).
    onPosed(() => {
      if (in3d()) frameWork()
    })
    let was3d = false
    const loop = (t: number) => {
      const dt = Math.min(0.05, (t - lastT) / 1000)
      lastT = t
      pollPad(dt)
      const now3d = look3dOn()
      if (now3d !== was3d) {
        // Into or out of 3D: everything is worked out and drawn again the new way.
        was3d = now3d
        needsDraw = stretchDirty = shapeDirty = true
        drawnPose = -1
      }
      if (now3d) {
        // The 3D view is showing: the map neither pans nor draws here (frameWork runs after the 3D camera moves).
        raf = requestAnimationFrame(loop)
        return
      }
      let px = 0
      let py = 0
      if (held.has('KeyA') || held.has('ArrowLeft')) px += 1
      if (held.has('KeyD') || held.has('ArrowRight')) px -= 1
      if (held.has('KeyW') || held.has('ArrowUp')) py += 1
      if (held.has('KeyS') || held.has('ArrowDown')) py -= 1
      if (px || py) panBy(px * KEY_PAN_PX * dt, py * KEY_PAN_PX * dt)
      frameWork()
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    setCursor()

    // Esc mid-drag or mid-line (EditorUi.tsx asks before it goes back to the map or clears anything).
    cancelGestureNow = () => {
      if (drawing) {
        drawing = false
        stroke = []
        pen = null
        penTo = null
        pencilPlan = null
        shiftFrom = null
        shiftAt = null
        needsDraw = true
        say('Line cancelled: nothing changed.', 'info')
        return true
      }
      if (placeDrag) {
        placeDrag = null
        ghost = null
        needsDraw = true
        say('Cancelled.', 'info')
        return true
      }
      if (dragging) {
        const start = dragStart
        dragging = null
        dragStart = null
        if (start) useEditor.setState({ draft: start })
        endGesture()
        setDragPlane(null)
        setCursor()
        say('Put back where it was.', 'info')
        return true
      }
      if (sectionAnchor !== null) {
        sectionAnchor = null
        useEditor.setState({ selection: null })
        stretchDirty = true
        say('Cancelled.', 'info')
        return true
      }
      return false
    }

    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onUp)
    canvas.addEventListener('pointerleave', onLeave)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('contextmenu', onContext)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    window.addEventListener('resize', resize)
    return () => {
      cancelAnimationFrame(raf)
      unsub()
      onPosed(null)
      cancelGestureNow = null
      setDragPlane(null)
      if (dragging) endGesture()
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
      canvas.removeEventListener('pointerleave', onLeave)
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

/** 3D: how high a picked thing sits (its drag sheet): props and cores on the ground, the rest on their road. */
function pickHeight(pick: Pick, at: P): number {
  const d = useEditor.getState().draft
  if (pick.kind === 'prop' || pick.kind === 'core') return groundAt(at.x, at.z)
  const rc = roadGeometry(d.points, d.width).rc
  if (pick.kind === 'point') return heightAt(at.x, at.z, frameAt(rc, pick.index).dir)
  if (pick.kind === 'piece' && d.pieces[pick.index]) return heightAt(at.x, at.z, piecePlace(rc, d.pieces[pick.index]).dir)
  return heightAt(at.x, at.z)
}

/** World position of a picked thing (what a drag moves). */
function pickWorld(pick: Pick): P | null {
  const d = useEditor.getState().draft
  if (pick.kind === 'point') return d.points[pick.index] ?? null
  if (pick.kind === 'prop') return d.props[pick.index] ?? null
  if (pick.kind === 'core') return d.cores[pick.index] ?? null
  if (pick.kind === 'crossing') return { x: pick.x, z: pick.z }
  const p = d.pieces[pick.index]
  if (!p) return null
  return pieceScreen(roadGeometry(d.points, d.width).rc, p).centre
}

/**
 * What letting go of the pencil now would do: 'new' on an empty map (the line
 * becomes the road), otherwise road.ts planRedraw on the line so far, ending
 * where the pointer is (that is where a let-go line ends, see onUp).
 */
function pencilPreview(stroke: readonly P[], pointerAt: P | null): RedrawPlan | 'new' | null {
  const d = useEditor.getState().draft
  if (!d.points.length) return 'new'
  if (stroke.length < 2) return null
  const line = pointerAt ? [...stroke, pointerAt] : [...stroke]
  return planRedraw(line, d.points, d.width)
}

/** Tell the player how the pencil works the first time they open a fresh editor. */
export function pencilHint(): void {
  if (mapIsEmpty()) say('Hold the left mouse button and draw a loop. Let go and it becomes a road. Or press Random track.', 'info')
  else say('Pencil: start on the road, draw the new bit, and end back on the road. The bit in between is redrawn.', 'info')
}

export { issueLocation } from './mapDraw'
