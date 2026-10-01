// ============================================================
//  MINIMAP - the track from above, every car a dot
// ------------------------------------------------------------
//  A small 2D canvas in the top-right corner. North is always up.
//
//  Cheap by design:
//    - the road is drawn ONCE into an offscreen canvas when the
//      track loads (from track.minimap, the decimated centreline);
//    - each frame we copy that picture and draw a dot per car,
//      about 30 times a second, with no allocation.
//
//  The HUD's animation loop calls drawMinimap(); this file only
//  holds the drawing code and the canvas element.
// ============================================================

import { PALETTE } from '../../core/palette'
import { cars, telemetry } from '../../core/telemetry'
import type { TrackFrame, TrackRuntime } from '../../track/types'
import * as THREE from 'three'

/** Reused frame for the start-line query (drawn once per track). */
const startFrame: TrackFrame = {
  s: 0,
  position: new THREE.Vector3(),
  tangent: new THREE.Vector3(),
  up: new THREE.Vector3(),
  right: new THREE.Vector3(),
  halfWidth: 0,
  bank: 0,
  curvature: 0,
  surface: 'road',
}

interface MapState {
  canvas: HTMLCanvasElement | null
  ctx: CanvasRenderingContext2D | null
  base: HTMLCanvasElement | null
  /** The track stamp the base picture was drawn for (-1 = needs drawing). */
  baseStamp: number
  pxW: number
  pxH: number
  scale: number
  ox: number
  oz: number
  dpr: number
}

const map: MapState = { canvas: null, ctx: null, base: null, baseStamp: -1, pxW: 0, pxH: 0, scale: 1, ox: 0, oz: 0, dpr: 1 }

export function setMinimapCanvas(el: HTMLCanvasElement | null): void {
  map.canvas = el
  map.ctx = el ? el.getContext('2d') : null
  map.baseStamp = -1
}

/** Size the canvas to its CSS box (call on resize). */
function fitCanvas(): boolean {
  const c = map.canvas
  if (!c) return false
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const w = Math.max(1, Math.round(c.clientWidth * dpr))
  const h = Math.max(1, Math.round(c.clientHeight * dpr))
  if (c.width !== w || c.height !== h) {
    c.width = w
    c.height = h
    map.baseStamp = -1
  }
  map.pxW = w
  map.pxH = h
  map.dpr = dpr
  return w > 1 && h > 1
}

function drawBase(track: TrackRuntime): void {
  const { pxW: w, pxH: h, dpr } = map
  const base = map.base ?? document.createElement('canvas')
  map.base = base
  base.width = w
  base.height = h
  const g = base.getContext('2d')
  if (!g) return
  g.clearRect(0, 0, w, h)
  const mm = track.minimap
  const pad = 14 * dpr
  const spanX = Math.max(1, mm.maxX - mm.minX)
  const spanZ = Math.max(1, mm.maxZ - mm.minZ)
  const s = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanZ)
  map.scale = s
  map.ox = (w - spanX * s) / 2 - mm.minX * s
  map.oz = (h - spanZ * s) / 2 - mm.minZ * s

  const path = mm.path
  const n = path.length >> 1
  if (n < 2) return
  const trace = () => {
    g.beginPath()
    g.moveTo(path[0] * s + map.ox, path[1] * s + map.oz)
    for (let i = 1; i < n; i++) g.lineTo(path[i * 2] * s + map.ox, path[i * 2 + 1] * s + map.oz)
    g.closePath()
  }
  const edge = track.file.environment?.palette?.edge ?? PALETTE.roadEdge
  g.lineJoin = 'round'
  g.lineCap = 'round'
  // soft glow, then the dark road body, then a thin bright centre line
  g.globalAlpha = 0.28
  g.strokeStyle = edge
  g.lineWidth = 9 * dpr
  trace()
  g.stroke()
  g.globalAlpha = 1
  g.strokeStyle = PALETTE.road
  g.lineWidth = 5 * dpr
  trace()
  g.stroke()
  g.strokeStyle = edge
  g.lineWidth = 1.6 * dpr
  trace()
  g.stroke()

  // start line: a short bar across the road where s = 0 (the real start, from the track)
  const f = track.frameAt(track.startS, startFrame)
  const x0 = f.position.x * s + map.ox
  const z0 = f.position.z * s + map.oz
  const tl = Math.hypot(f.tangent.x, f.tangent.z) || 1
  const nx = -f.tangent.z / tl
  const nz = f.tangent.x / tl
  g.strokeStyle = PALETTE.laneLine
  g.lineWidth = 2 * dpr
  g.beginPath()
  g.moveTo(x0 - nx * 6 * dpr, z0 - nz * 6 * dpr)
  g.lineTo(x0 + nx * 6 * dpr, z0 + nz * 6 * dpr)
  g.stroke()
}

/** Draw one frame of the minimap. Returns false if there's nothing to draw on. */
export function drawMinimap(track: TrackRuntime | null, trackStamp: number): boolean {
  const ctx = map.ctx
  if (!ctx || !track) return false
  if (map.baseStamp !== trackStamp) {
    if (!fitCanvas()) return false
    drawBase(track)
    map.baseStamp = trackStamp
  }
  const { pxW: w, pxH: h, dpr, scale: s, ox, oz } = map
  ctx.clearRect(0, 0, w, h)
  if (map.base) ctx.drawImage(map.base, 0, 0)

  const edgePad = 5 * dpr
  // Other cars first, so the player's arrow is always on top.
  for (let i = 0; i < cars.length; i++) {
    const c = cars[i]
    if (c.kind === 'player') continue
    let x = c.position.x * s + ox
    let z = c.position.z * s + oz
    x = x < edgePad ? edgePad : x > w - edgePad ? w - edgePad : x
    z = z < edgePad ? edgePad : z > h - edgePad ? h - edgePad : z
    const r = (c.kind === 'ghost' ? 3 : 3.6) * dpr
    ctx.beginPath()
    ctx.arc(x, z, r, 0, Math.PI * 2)
    if (c.kind === 'ghost') {
      ctx.strokeStyle = PALETTE.ghost
      ctx.lineWidth = 1.2 * dpr
      ctx.stroke()
    } else {
      ctx.fillStyle = c.isIt ? PALETTE.tagIt : c.glow
      ctx.fill()
      if (c.isIt) {
        ctx.strokeStyle = PALETTE.tagIt
        ctx.lineWidth = 1.5 * dpr
        ctx.beginPath()
        ctx.arc(x, z, r + 2.5 * dpr, 0, Math.PI * 2)
        ctx.stroke()
      }
    }
  }

  // The player: an arrow pointing the way the car faces.
  const px = telemetry.carPosition.x * s + ox
  const pz = telemetry.carPosition.z * s + oz
  const fx = telemetry.carForward.x
  const fz = telemetry.carForward.z
  const fl = Math.hypot(fx, fz) || 1
  const ax = fx / fl
  const az = fz / fl
  const L = 7 * dpr
  const W = 4.5 * dpr
  const cx = px < edgePad ? edgePad : px > w - edgePad ? w - edgePad : px
  const cz = pz < edgePad ? edgePad : pz > h - edgePad ? h - edgePad : pz
  ctx.beginPath()
  ctx.moveTo(cx + ax * L, cz + az * L)
  ctx.lineTo(cx - ax * L * 0.6 - az * W, cz - az * L * 0.6 + ax * W)
  ctx.lineTo(cx - ax * L * 0.25, cz - az * L * 0.25)
  ctx.lineTo(cx - ax * L * 0.6 + az * W, cz - az * L * 0.6 - ax * W)
  ctx.closePath()
  ctx.fillStyle = PALETTE.uiAccent
  ctx.fill()
  ctx.strokeStyle = PALETTE.uiPanelSolid
  ctx.lineWidth = 1.2 * dpr
  ctx.stroke()
  return true
}

/** Force the base picture to redraw (canvas resized). */
export function invalidateMinimap(): void {
  map.baseStamp = -1
}
