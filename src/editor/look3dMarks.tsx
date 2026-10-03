// ============================================================
//  3D VIEW MARKS - what is selected, and the problem pins, in 3D
// ------------------------------------------------------------
//  The map's own marks (mapDraw.ts) are drawn flat for a camera
//  looking straight down, so in the 3D view they are hidden. This
//  draws the few that matter while you look round:
//
//    a selected stretch   a see-through cyan band laid on the real
//                         road, edges bright, following its hills
//                         and banks (a real 3D mesh, so hills in
//                         front of it hide it)
//    a selected spot      a road point, a piece, a crossing, a prop
//                         or a core: a cyan ring on a stalk above it
//    problem pins         the Checks list's pins, each on a stalk
//                         above its spot on the road, red or amber,
//                         with a failing check's tag beside it
//
//  The ring and pins are drawn into a flat canvas (Look3dUi.tsx owns
//  it) at the spot's position on screen, worked out from the 3D
//  camera after it has moved this frame.
// ============================================================

import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { FONTS, GLOW, PALETTE } from '../core/palette'
import { useTrack } from '../track/current'
import type { TrackRuntime } from '../track/types'
import { type EditorState, useEditor } from './draft'
import type { P } from './geom'
import { roadGeometry } from './mapDraw'
import { piecePlace } from './pieces'
import { NO_NOTES, problemsOf } from './problems'
import { type RoadCurve, frameAt } from './road'
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

/** How high the selected-stretch band floats over the road, metres (separate from the road, so they never flicker into each other). */
const BAND_LIFT = 0.35
/** How far the band reaches past each road edge, metres. */
const BAND_OVER = 1.5
/** The bright strip along each edge of the band, metres wide. */
const BAND_EDGE = 1.1
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

/** The selected stretch's band on the real road, or null. Rebuilt when the selection or the track changes. */
function bandGeometry(s: EditorState, t: TrackRuntime | null): THREE.BufferGeometry | null {
  const sel = s.selection
  if (!t || sel?.kind !== 'section' || !s.draft.points.length) return null
  const rc: RoadCurve = roadGeometry(s.draft.points, s.draft.width).rc
  const a = frameAt(rc, sel.from)
  const b = frameAt(rc, sel.to)
  const i0 = sampleNear(t, a.p.x, a.p.z, a.dir, 20)
  const i1 = sampleNear(t, b.p.x, b.p.z, b.dir, 20)
  if (i0 < 0 || i1 < 0) return null
  const S = t.samples
  const n = S.count
  const steps = ((i1 - i0 + n) % n) + 1
  if (steps < 2) return null
  // Four rows of vertices across the road per sample: outer edge, inner edge, inner edge, outer edge.
  const pos = new Float32Array(steps * 4 * 3)
  const col = new Float32Array(steps * 4 * 4)
  const accent = new THREE.Color(PALETTE.uiAccent)
  // The edges glow softly (T1); the middle is a faint see-through wash.
  const edge = accent.clone().multiplyScalar(GLOW.T1)
  const across = [-1, -1, 1, 1]
  for (let k = 0; k < steps; k++) {
    const i = (i0 + k) % n
    const half = S.halfWidth[i] + BAND_OVER
    for (let j = 0; j < 4; j++) {
      const outer = j === 0 || j === 3
      const w = across[j] * (outer ? half : half - BAND_EDGE)
      const v = (k * 4 + j) * 3
      pos[v] = S.px[i] + S.rx[i] * w + S.ux[i] * BAND_LIFT
      pos[v + 1] = S.py[i] + S.ry[i] * w + S.uy[i] * BAND_LIFT
      pos[v + 2] = S.pz[i] + S.rz[i] * w + S.uz[i] * BAND_LIFT
      const c = (k * 4 + j) * 4
      const tint = outer ? edge : accent
      col[c] = tint.r
      col[c + 1] = tint.g
      col[c + 2] = tint.b
      col[c + 3] = outer ? 0.95 : 0.14
    }
  }
  // Triangles: each pair of neighbouring rows across, joined to the next sample.
  const index: number[] = []
  for (let k = 0; k < steps - 1; k++) {
    for (let j = 0; j < 3; j++) {
      const a0 = k * 4 + j
      const b0 = (k + 1) * 4 + j
      index.push(a0, b0, a0 + 1, a0 + 1, b0, b0 + 1)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('color', new THREE.BufferAttribute(col, 4))
  g.setIndex(index)
  g.computeBoundingSphere()
  return g
}

/** Inside the 3D scene while the editor is open: the selected stretch's band, and the canvas rings and pins. */
export function Look3dMarks() {
  const on = useLook3d((s) => s.mode !== 'map')
  const track = useTrack()
  const selection = useEditor((s) => s.selection)
  const draft = useEditor((s) => s.draft)
  const gates = useEditor((s) => s.gates)
  const errors = useEditor((s) => s.errors)
  const notes = useEditor((s) => s.notes)
  const preview = useEditor((s) => s.preview)

  const material = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
        fog: false,
      }),
    [],
  )
  useEffect(() => () => material.dispose(), [material])

  const band = useMemo(() => (on ? bandGeometry(useEditor.getState(), track) : null), [on, track, selection, draft])
  useEffect(() => () => band?.dispose(), [band])

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

  if (!on || !band) return null
  return <mesh geometry={band} material={material} renderOrder={5} frustumCulled={false} />
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
  for (const spot of list) {
    // Into the camera's own space: anything behind the camera is not drawn.
    _v.set(spot.x, spot.y, spot.z).applyMatrix4(camera.matrixWorldInverse)
    if (_v.z > -1) continue
    _v.applyMatrix4(camera.projectionMatrix)
    const sx = (_v.x * 0.5 + 0.5) * w
    const sy = (-_v.y * 0.5 + 0.5) * h
    if (!Number.isFinite(sx) || !Number.isFinite(sy) || sx < -80 || sx > w + 80 || sy < -80 || sy > h + 80) continue
    drawSpot(ctx, spot, sx, sy)
  }
}

function drawSpot(ctx: CanvasRenderingContext2D, spot: Spot, sx: number, sy: number): void {
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
  }
  ctx.restore()
}

/** For the dev handle: what the 3D view is marking right now. */
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
