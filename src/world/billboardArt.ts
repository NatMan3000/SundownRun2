// ============================================================
//  BILLBOARD ART - the ads on the holographic billboards
// ------------------------------------------------------------
//  Eight made-up adverts for made-up neon-city brands, painted by
//  code onto one 1024 x 1024 canvas (a texture "atlas": 2 columns
//  x 4 rows of 512 x 256 cells). Each billboard shows one cell.
//
//  Everything is drawn with simple canvas shapes and the system
//  font (no images, no web fonts: constitution section 5), and
//  every colour comes from the palette. The art is drawn bright on
//  black, because the hologram shader adds it as light: black is
//  see-through, colour glows.
//
//  Josh: want your own ad? Add a function to ADS that draws into
//  a 512 x 256 box starting at (0, 0), and bump ATLAS_ROWS if you
//  need more room.
// ============================================================

import * as THREE from 'three'
import { FONTS, PALETTE } from '../core/palette'

export const CELL_W = 512
export const CELL_H = 256
export const ATLAS_COLS = 2
export const ATLAS_ROWS = 4

type Ctx = CanvasRenderingContext2D
/** Draws one ad into a CELL_W x CELL_H box at the origin. */
type Ad = (c: Ctx) => void

function title(c: Ctx, text: string, x: number, y: number, size: number, color: string, align: CanvasTextAlign = 'left') {
  c.font = `800 ${size}px ${FONTS.display}`
  c.textAlign = align
  c.textBaseline = 'alphabetic'
  c.fillStyle = color
  c.fillText(text, x, y, fitWidth(x, align))
}

/** Room left in the cell from x (keeps every line inside its ad, squeezing it if needed). */
function fitWidth(x: number, align: CanvasTextAlign): number {
  const margin = 26
  if (align === 'center') return 2 * Math.min(x - margin, CELL_W - margin - x)
  return CELL_W - margin - x
}

function small(c: Ctx, text: string, x: number, y: number, color: string, align: CanvasTextAlign = 'left') {
  c.font = `600 22px ${FONTS.body}`
  c.textAlign = align
  c.textBaseline = 'alphabetic'
  c.fillStyle = color
  c.fillText(text, x, y, fitWidth(x, align))
}

/** A little striped synthwave sun. */
function stripedSun(c: Ctx, cx: number, cy: number, r: number) {
  const g = c.createLinearGradient(0, cy - r, 0, cy + r)
  g.addColorStop(0, PALETTE.sunTop)
  g.addColorStop(0.5, PALETTE.sunMid)
  g.addColorStop(1, PALETTE.sunBottom)
  c.save()
  c.beginPath()
  c.arc(cx, cy, r, 0, Math.PI * 2)
  c.clip()
  c.fillStyle = g
  c.fillRect(cx - r, cy - r, r * 2, r * 2)
  // the cut bands, wider toward the bottom
  c.globalCompositeOperation = 'destination-out'
  for (let i = 0; i < 6; i++) {
    const y = cy + r * (0.05 + i * 0.17)
    c.fillRect(cx - r, y, r * 2, 2 + i * 2.2)
  }
  c.restore()
}

const ADS: Ad[] = [
  // 1. A radio station
  (c) => {
    stripedSun(c, 120, 140, 84)
    title(c, 'SUNDOWN FM', 230, 118, 64, PALETTE.roadEdge)
    title(c, '88.4', 232, 196, 76, PALETTE.roadEdgeAlt)
    small(c, 'SYNTHS ALL NIGHT', 380, 196, PALETTE.laneLine)
  },
  // 2. A fizzy drink
  (c) => {
    c.strokeStyle = PALETTE.chevron
    c.fillStyle = PALETTE.chevron
    c.beginPath() // lightning bolt
    c.moveTo(96, 28)
    c.lineTo(48, 140)
    c.lineTo(92, 140)
    c.lineTo(70, 232)
    c.lineTo(150, 104)
    c.lineTo(104, 104)
    c.lineTo(132, 28)
    c.closePath()
    c.fill()
    title(c, 'HYPER COLA', 180, 126, 70, PALETTE.roadEdge)
    small(c, 'ZERO GRAVITY TASTE', 184, 170, PALETTE.laneLine)
    title(c, 'NOW 30% MORE FIZZ', 184, 224, 34, PALETTE.boost)
  },
  // 3. A car maker
  (c) => {
    c.strokeStyle = PALETTE.roadEdgeAlt
    c.lineWidth = 6
    c.lineJoin = 'round'
    c.beginPath() // low wedge car
    c.moveTo(40, 150)
    c.lineTo(70, 118)
    c.lineTo(170, 96)
    c.lineTo(250, 98)
    c.lineTo(300, 124)
    c.lineTo(330, 132)
    c.lineTo(330, 150)
    c.closePath()
    c.stroke()
    c.beginPath()
    c.arc(100, 152, 20, 0, Math.PI * 2)
    c.arc(270, 152, 20, 0, Math.PI * 2)
    c.fillStyle = PALETTE.roadEdgeAlt
    c.fill()
    for (let i = 0; i < 4; i++) c.fillRect(352, 100 + i * 14, 120 - i * 26, 4) // speed lines
    title(c, 'GRIDLINE MOTORS', 40, 220, 52, PALETTE.laneLine)
  },
  // 4. Space tourism
  (c) => {
    c.fillStyle = PALETTE.planet
    c.beginPath()
    c.arc(118, 128, 62, 0, Math.PI * 2)
    c.fill()
    c.strokeStyle = PALETTE.planetRing
    c.lineWidth = 7
    c.beginPath()
    c.ellipse(118, 128, 112, 30, -0.35, 0, Math.PI * 2)
    c.stroke()
    title(c, 'VISIT ORBIT 9', 250, 118, 58, PALETTE.planetRing)
    small(c, 'RINGSIDE ROOMS FROM 99 CREDITS', 252, 162, PALETTE.laneLine)
    title(c, 'BOOK NOW', 252, 222, 40, PALETTE.roadEdge)
  },
  // 5. Fast food
  (c) => {
    c.fillStyle = PALETTE.chevron
    c.beginPath() // a bowl
    c.arc(116, 128, 76, 0, Math.PI)
    c.closePath()
    c.fill()
    c.strokeStyle = PALETTE.laneLine
    c.lineWidth = 5
    for (let i = 0; i < 3; i++) {
      c.beginPath() // steam
      const x = 82 + i * 34
      c.moveTo(x, 110)
      c.bezierCurveTo(x - 16, 84, x + 16, 66, x, 36)
      c.stroke()
    }
    title(c, 'TURBO', 230, 110, 72, PALETTE.boost)
    title(c, 'NOODLES', 230, 180, 72, PALETTE.chevron)
    small(c, 'READY BEFORE THE NEXT LAP', 232, 226, PALETTE.laneLine)
  },
  // 6. A holiday valley
  (c) => {
    c.strokeStyle = PALETTE.grid
    c.lineWidth = 3
    for (let i = 0; i < 7; i++) {
      c.beginPath() // receding grid lines
      c.moveTo(256, 140)
      c.lineTo(-60 + i * 105, 256)
      c.stroke()
    }
    for (let i = 0; i < 4; i++) {
      const y = 150 + i * i * 9 + i * 8
      c.beginPath()
      c.moveTo(0, y)
      c.lineTo(512, y)
      c.stroke()
    }
    c.strokeStyle = PALETTE.roadEdge
    c.lineWidth = 4
    c.beginPath() // wireframe mountains
    c.moveTo(0, 140)
    c.lineTo(90, 70)
    c.lineTo(160, 120)
    c.lineTo(240, 40)
    c.lineTo(330, 125)
    c.lineTo(410, 76)
    c.lineTo(512, 140)
    c.stroke()
    title(c, 'NEON VALLEY', 256, 236, 54, PALETTE.roadEdgeAlt, 'center')
  },
  // 7. An arcade
  (c) => {
    const px = 14
    const ghost = ['..XXXX..', '.XXXXXX.', 'XX.XX.XX', 'XXXXXXXX', 'XXXXXXXX', 'X.X..X.X']
    c.fillStyle = PALETTE.boost
    for (let r = 0; r < ghost.length; r++) {
      for (let k = 0; k < ghost[r].length; k++) if (ghost[r][k] === 'X') c.fillRect(48 + k * px, 72 + r * px, px - 2, px - 2)
    }
    title(c, 'ARCADE 3000', 210, 120, 64, PALETTE.boost)
    small(c, 'HIGH SCORES  /  FREE PLAY FRIDAY', 212, 164, PALETTE.laneLine)
    title(c, 'INSERT COIN', 212, 222, 38, PALETTE.roadEdge)
  },
  // 8. Pizza
  (c) => {
    c.fillStyle = PALETTE.chevron
    c.beginPath() // a slice
    c.moveTo(60, 50)
    c.lineTo(200, 70)
    c.lineTo(110, 220)
    c.closePath()
    c.fill()
    c.fillStyle = PALETTE.roadEdge
    for (const [x, y] of [
      [110, 90],
      [150, 92],
      [120, 140],
    ]) {
      c.beginPath()
      c.arc(x, y, 12, 0, Math.PI * 2)
      c.fill()
    }
    title(c, 'PIZZA', 236, 108, 74, PALETTE.roadEdge)
    title(c, 'HYPERLOOP', 236, 176, 62, PALETTE.chevron)
    small(c, 'HOT IN 90 SECONDS OR IT FLIES FREE', 238, 222, PALETTE.laneLine)
  },
]

export const AD_COUNT = ADS.length

/** Paint every ad into one canvas texture (call once; the caller disposes it). */
export function makeBillboardAtlas(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = CELL_W * ATLAS_COLS
  canvas.height = CELL_H * ATLAS_ROWS
  const c = canvas.getContext('2d')!
  // Left transparent black: the hologram adds the art as light, so black shows nothing.
  c.clearRect(0, 0, canvas.width, canvas.height)
  for (let i = 0; i < ADS.length; i++) {
    const col = i % ATLAS_COLS
    const row = Math.floor(i / ATLAS_COLS)
    c.save()
    c.translate(col * CELL_W, row * CELL_H)
    c.beginPath()
    c.rect(0, 0, CELL_W, CELL_H)
    c.clip()
    // a thin frame around every ad
    c.strokeStyle = PALETTE.laneLine
    c.globalAlpha = 0.55
    c.lineWidth = 4
    c.strokeRect(10, 10, CELL_W - 20, CELL_H - 20)
    c.globalAlpha = 1
    ADS[i](c)
    c.restore()
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  tex.generateMipmaps = true
  tex.minFilter = THREE.LinearMipmapLinearFilter
  return tex
}
