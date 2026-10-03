// ============================================================
//  3D VIEW MARKS - what is selected, and the problem pins, in 3D
// ------------------------------------------------------------
//  In 3D the map's own marks (mapDraw.ts) are drawn on the real road
//  through the 3D camera (the selected stretch's band, labels, the
//  tools' previews). This adds what reads better standing up:
//
//    a selected spot      a road point, a piece, a crossing, a prop
//                         or a core: a cyan ring on a stalk above it
//    problem pins         the Checks list's pins, each on a stalk
//                         above its spot on the road, red or amber,
//                         with a failing check's tag beside it; a
//                         click on a pin or its tag selects it, as on
//                         the map (setPinTargets3d)
//
//  The ring and pins are drawn into a flat canvas (Look3dUi.tsx owns
//  it) at the spot's position on screen, worked out from the 3D
//  camera after it has moved this frame.
// ============================================================

import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { FONTS, PALETTE } from '../core/palette'
import { useTrack } from '../track/current'
import type { TrackRuntime } from '../track/types'
import { type EditorState, useEditor } from './draft'
import type { P } from './geom'
import { roadGeometry, setPinTargets3d } from './mapDraw'
import { piecePlace } from './pieces'
import { NO_NOTES, problemsOf } from './problems'
import { frameAt } from './road'
import { groundAt, look, useLook3d } from './look3d'

/** The flat canvas over the 3D view that the rings and pins are drawn on (Look3dUi.tsx hands it over). */
let marksCanvas: HTMLCanvasElement | null = null
export function setMarksCanvas(c: HTMLCanvasElement | null): void {
  marksCanvas = c
  drawnVersion = -1
}

/** Something drawn on a stalk above a spot in the world. */
interface Spot {
  x: number
  y: number
  z: number
  kind: 'selected' | 'bad' | 'warn' | 'note'
  label: string | null
  key: string
}

/** Pixels from a spot on the road up to its pin or ring. */
const STALK_PX = 30

// scratch (no allocation per frame)
const _v = new THREE.Vector3()
let drawnVersion = -1
let drawnSpots: readonly Spot[] | null = null

/**
 * The road sample nearest to (x, z), preferring samples heading the same
 * way as `dir` (so at a crossing it picks the right road, not the one
 * passing over or under it). Without a direction, the highest road within
 * a few metres wins (the road on top). -1 when there is no road nearby.
 */
function sampleNear(t: TrackRuntime, x: number, z: number, dir: P | null, within = 12): number {
  const s = t.samples
  let best = -1
  let bestScore = Infinity
  for (let i = 0; i < s.count; i++) {
    const dx = s.px[i] - x
    const dz = s.pz[i] - z
    const d2 = dx * dx + dz * dz
    if (d2 > within * within) continue
    let score = d2
    if (dir) {
      const along = s.tx[i] * dir.x + s.tz[i] * dir.z
      // Heading the other way, or across: heavily penalised but still usable if it is all there is.
      if (along < 0.5) score += 1e6
    } else score -= s.py[i] * 1000
    if (score < bestScore) {
      bestScore = score
      best = i
    }
  }
  return best
}

/** The height of the road at x, z (heading `dir`, if known), else the ground's. */
function heightAt(t: TrackRuntime | null, x: number, z: number, dir: P | null): number {
  if (t) {
    const i = sampleNear(t, x, z, dir)
    if (i >= 0) return t.samples.py[i]
  }
  return groundAt(x, z)
}

/** What the canvas shows: the selected spot (if one) and the problem pins. */
function spotsOf(s: EditorState, t: TrackRuntime | null): Spot[] {
  const d = s.draft
  const out: Spot[] = []
  if (!d.points.length) return out
  const rc = roadGeometry(d.points, d.width).rc
  const sel = s.selection
  const onRoad = (at: number, key: string) => {
    const f = frameAt(rc, at)
    out.push({ x: f.p.x, y: heightAt(t, f.p.x, f.p.z, f.dir), z: f.p.z, kind: 'selected', label: null, key })
  }
  if (sel?.kind === 'point' && d.points[sel.index]) onRoad(sel.index, 'sel')
  else if (sel?.kind === 'piece' && d.pieces[sel.index]) {
    const p = piecePlace(rc, d.pieces[sel.index])
    out.push({ x: p.p.x, y: heightAt(t, p.p.x, p.p.z, p.dir), z: p.p.z, kind: 'selected', label: null, key: 'sel' })
  } else if (sel?.kind === 'crossing') out.push({ x: sel.x, y: heightAt(t, sel.x, sel.z, null), z: sel.z, kind: 'selected', label: null, key: 'sel' })
  else if (sel?.kind === 'prop' || sel?.kind === 'core') {
    const p = sel.kind === 'prop' ? d.props[sel.index] : d.cores[sel.index]
    if (p) out.push({ x: p.x, y: groundAt(p.x, p.z), z: p.z, kind: 'selected', label: null, key: 'sel' })
  }
  // The same rows (and the same rule about stale checks) as the map's pins (mapDraw.ts drawPins).
  const fresh = s.checkedDraft === s.draft && s.preview !== 'pending'
  const picked = sel?.kind === 'problem' ? sel.key : null
  for (const p of problemsOf({ draft: d, gates: fresh ? s.gates : null, errors: s.errors, warnings: s.warnings, notes: s.notes?.issues ?? NO_NOTES })) {
    if (!p.at) continue
    const dir = p.roadAt !== null ? frameAt(rc, p.roadAt).dir : null
    out.push({ x: p.at.x, y: heightAt(t, p.at.x, p.at.z, dir), z: p.at.z, kind: p.key === picked ? 'selected' : p.tone, label: p.label ?? null, key: p.key })
  }
  // The most serious drawn last (on top), the selected one above all.
  const rank = { note: 0, warn: 1, bad: 2, selected: 3 }
  out.sort((a, b) => rank[a.kind] - rank[b.kind])
  return out
}

/** Inside the 3D scene while the editor is open: the canvas rings and pins. */
export function Look3dMarks() {
  const on = useLook3d((s) => s.mode !== 'map')
  const track = useTrack()
  const selection = useEditor((s) => s.selection)
  const draft = useEditor((s) => s.draft)
  const gates = useEditor((s) => s.gates)
  const errors = useEditor((s) => s.errors)
  const notes = useEditor((s) => s.notes)
  const preview = useEditor((s) => s.preview)

  // The spots only change when the editor's state does; their place on screen changes as the camera moves.
  const spots = useRef<Spot[]>([])
  useEffect(() => {
    spots.current = on ? spotsOf(useEditor.getState(), track) : []
    drawnVersion = -1
  }, [on, track, selection, draft, gates, errors, notes, preview])

  useFrame((state) => {
    const canvas = marksCanvas
    if (!on || !canvas) return
    if (drawnVersion === look.version && drawnSpots === spots.current) return
    drawnVersion = look.version
    drawnSpots = spots.current
    drawSpots(canvas, state.camera, spots.current)
  })

  return null
}

/** Each spot on screen: a stalk up from where it is, and a pin (or the selection's ring) on top. */
function drawSpots(canvas: HTMLCanvasElement, camera: THREE.Camera, list: readonly Spot[]): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  const targets: Parameters<typeof setPinTargets3d>[0] = []
  for (const spot of list) {
    // Into the camera's own space: anything behind the camera is not drawn.
    _v.set(spot.x, spot.y, spot.z).applyMatrix4(camera.matrixWorldInverse)
    if (_v.z > -1) continue
    _v.applyMatrix4(camera.projectionMatrix)
    const sx = (_v.x * 0.5 + 0.5) * w
    const sy = (-_v.y * 0.5 + 0.5) * h
    if (!Number.isFinite(sx) || !Number.isFinite(sy) || sx < -80 || sx > w + 80 || sy < -80 || sy > h + 80) continue
    const box = drawSpot(ctx, spot, sx, sy)
    // A problem's pin (and its tag) can be clicked, as on the map; the selection's own ring is only a marker.
    if (spot.key !== 'sel') targets.push({ key: spot.key, sx, sy: sy - (spot.kind === 'note' ? STALK_PX * 0.6 : STALK_PX), box })
  }
  setPinTargets3d(targets)
}

/** Draws one spot; returns its tag's box on screen (null without a tag). */
function drawSpot(ctx: CanvasRenderingContext2D, spot: Spot, sx: number, sy: number): { x0: number; y0: number; x1: number; y1: number } | null {
  const colour = spot.kind === 'selected' ? PALETTE.uiAccent : spot.kind === 'bad' ? PALETTE.uiBad : spot.kind === 'warn' ? PALETTE.uiWarn : PALETTE.uiDim
  const small = spot.kind === 'note'
  const top = sy - (small ? STALK_PX * 0.6 : STALK_PX)
  ctx.save()
  // The stalk, and a dot where it touches the road.
  ctx.strokeStyle = colour
  ctx.globalAlpha = 0.85
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(sx, sy)
  ctx.lineTo(sx, top)
  ctx.stroke()
  ctx.globalAlpha = 1
  ctx.fillStyle = colour
  ctx.beginPath()
  ctx.arc(sx, sy, 3, 0, Math.PI * 2)
  ctx.fill()
  // The head: a ring for the selection, a pin with "!" for a problem.
  ctx.beginPath()
  ctx.arc(sx, top, small ? 5 : 10, 0, Math.PI * 2)
  ctx.fillStyle = PALETTE.uiPanelSolid
  ctx.fill()
  ctx.lineWidth = spot.kind === 'selected' ? 3 : 2
  ctx.strokeStyle = colour
  if (spot.kind === 'selected') {
    ctx.shadowColor = colour
    ctx.shadowBlur = 12
  }
  ctx.stroke()
  ctx.shadowBlur = 0
  if (spot.kind === 'bad' || spot.kind === 'warn' || (spot.kind === 'selected' && spot.key !== 'sel')) {
    ctx.fillStyle = colour
    ctx.font = `700 12px ${FONTS.body}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('!', sx, top + 0.5)
  }
  // A failing check's short tag, beside its pin.
  let box: { x0: number; y0: number; x1: number; y1: number } | null = null
  if (spot.label && spot.kind !== 'note') {
    ctx.font = `600 12px ${FONTS.body}`
    const tw = ctx.measureText(spot.label).width + 14
    const x0 = sx + 16
    const y0 = top - 10
    ctx.fillStyle = PALETTE.uiPanel
    ctx.strokeStyle = colour
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.roundRect(x0, y0, tw, 20, 10)
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = colour
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(spot.label, x0 + 7, y0 + 10.5)
    box = { x0, y0, x1: x0 + tw, y1: y0 + 20 }
  }
  ctx.restore()
  return box
}

/** For the dev handle: what the 3D view is marking right now (`band`: a picked stretch, drawn by the overlay on the road). */
export function marksSummary(): { spots: number; band: boolean } {
  const s = useEditor.getState()
  return { spots: drawnSpots?.length ?? 0, band: s.selection?.kind === 'section' }
}

/** `at` values on the editor's road that a stretch covers, as road samples (kept for the dev handle's band check). */
export function bandSampleRange(s: EditorState, t: TrackRuntime): { from: number; to: number } | null {
  const sel = s.selection
  if (sel?.kind !== 'section') return null
  const rc = roadGeometry(s.draft.points, s.draft.width).rc
  const a = frameAt(rc, sel.from)
  const b = frameAt(rc, sel.to)
  const from = sampleNear(t, a.p.x, a.p.z, a.dir, 20)
  const to = sampleNear(t, b.p.x, b.p.z, b.dir, 20)
  return from < 0 || to < 0 ? null : { from, to }
}
