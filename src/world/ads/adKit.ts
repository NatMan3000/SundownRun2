// ============================================================
//  AD KIT - the pens and stencils the billboard ads are drawn with
// ------------------------------------------------------------
//  Every ad in wide.ts, tall.ts and square.ts is a little drawing
//  made from these helpers: text that always fits its box, a
//  striped synthwave sun, a lightning bolt, a car, a planet, a
//  rocket, pixel sprites and so on. They draw with plain canvas
//  shapes and the system font only (constitution section 5: no
//  images, no web fonts), and every colour is a palette token.
//
//  Draw bright on black: the hologram adds the picture as light,
//  so black shows nothing and colour glows.
// ============================================================

import { FONTS, PALETTE } from '../../core/palette'

export type Ctx = CanvasRenderingContext2D

/** The shapes an ad can come in, measured in 256 px squares ("units"). */
export type AdShape = 'wide' | 'tall' | 'square'

/** One ad: its name (for the contact sheet), its shape and the function that paints it. */
export interface AdDef {
  name: string
  shape: AdShape
  /** Paints the ad into a w x h box starting at (0, 0). */
  draw: (c: Ctx, w: number, h: number) => void
}

/** Short names for the palette, so the ads stay readable. */
export const C = {
  pink: PALETTE.roadEdge,
  cyan: PALETTE.roadEdgeAlt,
  ice: PALETTE.laneLine,
  amber: PALETTE.chevron,
  mint: PALETTE.boost,
  violet: PALETTE.wallRide,
  lilac: PALETTE.core,
  white: PALETTE.coreHot,
  ring: PALETTE.planetRing,
  planet: PALETTE.planet,
  gold: PALETTE.sunTop,
  orange: PALETTE.sunMid,
  rose: PALETTE.sunBottom,
  warm: PALETTE.cityWindowWarm,
  sky: PALETTE.cityWindowCool,
  grid: PALETTE.grid,
  red: PALETTE.aiColors[0],
  yellow: PALETTE.aiColors[1],
  blue: PALETTE.aiColors[4],
} as const

export interface TextOpts {
  size: number
  color: string
  align?: CanvasTextAlign
  /** 'display' is the tall condensed headline face, 'body' the plain one, 'mono' the code one. */
  face?: 'display' | 'body' | 'mono'
  weight?: number
  /** Widest the line may be; longer text is squeezed to fit, never cut off. */
  maxW?: number
  /** Soft neon glow around the letters (canvas blur, painted once). */
  glow?: number
}

/** One line of text. y is the baseline. */
export function text(c: Ctx, str: string, x: number, y: number, o: TextOpts): void {
  c.save()
  c.font = `${o.weight ?? 800} ${o.size}px ${FONTS[o.face ?? 'display']}`
  c.textAlign = o.align ?? 'left'
  c.textBaseline = 'alphabetic'
  c.fillStyle = o.color
  if (o.glow) {
    c.shadowColor = o.color
    c.shadowBlur = o.glow
  }
  if (o.maxW !== undefined) c.fillText(str, x, y, o.maxW)
  else c.fillText(str, x, y)
  c.restore()
}

/** Outlined text (a neon tube look): just the edges of the letters. */
export function outlineText(c: Ctx, str: string, x: number, y: number, o: TextOpts & { line?: number }): void {
  c.save()
  c.font = `${o.weight ?? 800} ${o.size}px ${FONTS[o.face ?? 'display']}`
  c.textAlign = o.align ?? 'left'
  c.textBaseline = 'alphabetic'
  c.strokeStyle = o.color
  c.lineWidth = o.line ?? 3
  c.lineJoin = 'round'
  if (o.glow) {
    c.shadowColor = o.color
    c.shadowBlur = o.glow
  }
  if (o.maxW !== undefined) c.strokeText(str, x, y, o.maxW)
  else c.strokeText(str, x, y)
  c.restore()
}

/** Run a drawing with a neon glow round everything it paints. */
export function glowing(c: Ctx, color: string, blur: number, paint: () => void): void {
  c.save()
  c.shadowColor = color
  c.shadowBlur = blur
  paint()
  c.restore()
}

/** A rounded rectangle path (stroke or fill it after). */
export function roundRect(c: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  c.beginPath()
  c.moveTo(x + r, y)
  c.arcTo(x + w, y, x + w, y + h, r)
  c.arcTo(x + w, y + h, x, y + h, r)
  c.arcTo(x, y + h, x, y, r)
  c.arcTo(x, y, x + w, y, r)
  c.closePath()
}

/** A path through points [x0, y0, x1, y1, ...]. */
export function poly(c: Ctx, pts: number[], close = true): void {
  c.beginPath()
  c.moveTo(pts[0], pts[1])
  for (let i = 2; i < pts.length; i += 2) c.lineTo(pts[i], pts[i + 1])
  if (close) c.closePath()
}

/** A little striped synthwave sun: yellow to pink, cut by bands that widen toward the bottom. */
export function stripedSun(c: Ctx, cx: number, cy: number, r: number): void {
  c.save()
  c.beginPath()
  c.arc(cx, cy, r, 0, Math.PI * 2)
  c.clip()
  const g = c.createLinearGradient(0, cy - r, 0, cy + r)
  g.addColorStop(0, PALETTE.sunTop)
  g.addColorStop(0.5, PALETTE.sunMid)
  g.addColorStop(1, PALETTE.sunBottom)
  c.fillStyle = g
  c.fillRect(cx - r, cy - r, r * 2, r * 2)
  // The cut bands, painted black (black is see-through on a hologram).
  c.fillStyle = '#000'
  for (let i = 0; i < 6; i++) c.fillRect(cx - r, cy + r * (0.05 + i * 0.17), r * 2, 2 + i * r * 0.03)
  c.restore()
}

/** A lightning bolt about s pixels tall, its top-left near (x, y). */
export function bolt(c: Ctx, x: number, y: number, s: number, color: string): void {
  const k = s / 204
  poly(c, [96, 28, 48, 140, 92, 140, 70, 232, 150, 104, 104, 104, 132, 28].map((v, i) => (i % 2 ? y + (v - 28) * k : x + (v - 48) * k)))
  c.fillStyle = color
  c.fill()
}

/** A low wedge sports car seen side-on, nose to the right, `len` pixels long, wheels on y. */
export function wedgeCar(c: Ctx, x: number, y: number, len: number, color: string, wheels = color): void {
  const k = len / 290
  c.save()
  c.strokeStyle = color
  c.lineWidth = Math.max(3, 6 * k)
  c.lineJoin = 'round'
  poly(c, [0, 0, 30, -32, 130, -54, 210, -52, 260, -26, 290, -18, 290, 0].map((v, i) => (i % 2 ? y + v * k : x + v * k)))
  c.stroke()
  c.fillStyle = wheels
  for (const wx of [60, 230]) {
    c.beginPath()
    c.arc(x + wx * k, y + 2 * k, 20 * k, 0, Math.PI * 2)
    c.fill()
  }
  // The window line.
  c.beginPath()
  c.moveTo(x + 95 * k, y - 40 * k)
  c.lineTo(x + 135 * k, y - 50 * k)
  c.lineTo(x + 200 * k, y - 48 * k)
  c.lineTo(x + 225 * k, y - 34 * k)
  c.stroke()
  c.restore()
}

/** Speed lines trailing to the left of x. */
export function speedLines(c: Ctx, x: number, y: number, n: number, len: number, gap: number, color: string): void {
  c.fillStyle = color
  for (let i = 0; i < n; i++) {
    const l = len * (1 - i * 0.18)
    c.fillRect(x - l, y + i * gap, l, Math.max(2, gap * 0.3))
  }
}

/** A ringed planet. */
export function ringedPlanet(c: Ctx, cx: number, cy: number, r: number, body: string = C.planet, ring: string = C.ring): void {
  c.save()
  c.fillStyle = body
  c.beginPath()
  c.arc(cx, cy, r, 0, Math.PI * 2)
  c.fill()
  c.strokeStyle = ring
  c.lineWidth = Math.max(3, r * 0.11)
  c.beginPath()
  c.ellipse(cx, cy, r * 1.8, r * 0.48, -0.35, 0, Math.PI * 2)
  c.stroke()
  c.restore()
}

/** A rocket pointing up, `s` pixels tall, centred on cx with its nose at y. */
export function rocket(c: Ctx, cx: number, y: number, s: number, body: string, flame: string): void {
  const k = s / 200
  c.save()
  c.fillStyle = body
  c.beginPath()
  c.moveTo(cx, y)
  c.bezierCurveTo(cx + 40 * k, y + 40 * k, cx + 34 * k, y + 120 * k, cx + 28 * k, y + 150 * k)
  c.lineTo(cx - 28 * k, y + 150 * k)
  c.bezierCurveTo(cx - 34 * k, y + 120 * k, cx - 40 * k, y + 40 * k, cx, y)
  c.fill()
  // fins
  poly(c, [cx - 28 * k, y + 105 * k, cx - 58 * k, y + 160 * k, cx - 26 * k, y + 148 * k])
  c.fill()
  poly(c, [cx + 28 * k, y + 105 * k, cx + 58 * k, y + 160 * k, cx + 26 * k, y + 148 * k])
  c.fill()
  // window
  c.fillStyle = '#000'
  c.beginPath()
  c.arc(cx, y + 62 * k, 13 * k, 0, Math.PI * 2)
  c.fill()
  // flame
  c.fillStyle = flame
  poly(c, [cx - 18 * k, y + 156 * k, cx, y + 200 * k, cx + 18 * k, y + 156 * k])
  c.fill()
  c.restore()
}

/** Pixel art: each string is a row, 'X' is a lit pixel (and 'o' a second colour). */
export function sprite(c: Ctx, rows: string[], x: number, y: number, px: number, color: string, second: string = color): void {
  for (let r = 0; r < rows.length; r++) {
    for (let k = 0; k < rows[r].length; k++) {
      const ch = rows[r][k]
      if (ch === '.') continue
      c.fillStyle = ch === 'o' ? second : color
      c.fillRect(x + k * px, y + r * px, px - Math.max(1, px * 0.12), px - Math.max(1, px * 0.12))
    }
  }
}

/** A star with `points` points. */
export function star(c: Ctx, cx: number, cy: number, r: number, points: number, color: string, inner = 0.45): void {
  c.beginPath()
  for (let i = 0; i < points * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / points
    const rr = i % 2 ? r * inner : r
    if (i === 0) c.moveTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr)
    else c.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr)
  }
  c.closePath()
  c.fillStyle = color
  c.fill()
}

/** A row of > chevrons pointing right. */
export function chevrons(c: Ctx, x: number, cy: number, n: number, size: number, gap: number, color: string): void {
  c.save()
  c.strokeStyle = color
  c.lineWidth = size * 0.28
  c.lineJoin = 'miter'
  c.lineCap = 'butt'
  for (let i = 0; i < n; i++) {
    const cx = x + i * gap
    c.beginPath()
    c.moveTo(cx, cy - size / 2)
    c.lineTo(cx + size * 0.45, cy)
    c.lineTo(cx, cy + size / 2)
    c.stroke()
  }
  c.restore()
}

/** A synthwave grid floor from the horizon (y = top) down to the bottom of the box. */
export function gridFloor(c: Ctx, x: number, top: number, w: number, bottom: number, color: string, lines = 7): void {
  c.save()
  c.beginPath()
  c.rect(x, top, w, bottom - top)
  c.clip()
  c.strokeStyle = color
  c.lineWidth = 2.5
  const cx = x + w / 2
  for (let i = 0; i <= lines * 2; i++) {
    c.beginPath()
    c.moveTo(cx, top)
    c.lineTo(cx + (i - lines) * (w / lines) * 1.4, bottom + 40)
    c.stroke()
  }
  const h = bottom - top
  for (let i = 1; i < 6; i++) {
    const y = top + h * (i * i) / 25
    c.beginPath()
    c.moveTo(x, y)
    c.lineTo(x + w, y)
    c.stroke()
  }
  c.restore()
}

/** A wireframe mountain line across the box at baseline y. */
export function mountains(c: Ctx, x: number, y: number, w: number, peak: number, color: string): void {
  const pts = [0, 0, 0.17, -0.7, 0.31, -0.2, 0.47, -1, 0.64, -0.15, 0.8, -0.65, 1, 0]
  c.save()
  c.strokeStyle = color
  c.lineWidth = 4
  c.lineJoin = 'round'
  poly(c, pts.map((v, i) => (i % 2 ? y + v * peak : x + v * w)), false)
  c.stroke()
  c.restore()
}

/** A checkered flag, cells x cells squares of `sq` pixels, waving a little. */
export function checkered(c: Ctx, x: number, y: number, cols: number, rows: number, sq: number, color: string): void {
  c.fillStyle = color
  for (let r = 0; r < rows; r++) {
    for (let k = 0; k < cols; k++) {
      if ((r + k) % 2) continue
      const wave = Math.sin(k * 0.9) * sq * 0.35
      c.fillRect(x + k * sq, y + r * sq + wave, sq, sq)
    }
  }
}

/** A robot head: rounded box, two round eyes, an antenna and a grille mouth. */
export function robotHead(c: Ctx, cx: number, cy: number, s: number, color: string, eyes: string): void {
  const w = s
  const h = s * 0.8
  c.save()
  c.strokeStyle = color
  c.lineWidth = Math.max(3, s * 0.06)
  roundRect(c, cx - w / 2, cy - h / 2, w, h, s * 0.16)
  c.stroke()
  c.beginPath()
  c.moveTo(cx, cy - h / 2)
  c.lineTo(cx, cy - h / 2 - s * 0.22)
  c.stroke()
  c.fillStyle = color
  c.beginPath()
  c.arc(cx, cy - h / 2 - s * 0.26, s * 0.07, 0, Math.PI * 2)
  c.fill()
  c.fillStyle = eyes
  for (const ex of [-0.22, 0.22]) {
    c.beginPath()
    c.arc(cx + ex * s, cy - h * 0.1, s * 0.11, 0, Math.PI * 2)
    c.fill()
  }
  c.fillStyle = color
  for (let i = 0; i < 4; i++) c.fillRect(cx - s * 0.26 + i * s * 0.14, cy + h * 0.2, s * 0.08, h * 0.16)
  c.restore()
}

/** A pizza slice, point down. */
export function pizzaSlice(c: Ctx, cx: number, y: number, s: number, crust: string, topping: string): void {
  c.save()
  c.fillStyle = crust
  poly(c, [cx - s * 0.5, y, cx + s * 0.5, y, cx, y + s * 1.05])
  c.fill()
  c.fillStyle = topping
  for (const [dx, dy] of [
    [-0.18, 0.18],
    [0.16, 0.22],
    [0, 0.52],
  ]) {
    c.beginPath()
    c.arc(cx + dx * s, y + dy * s, s * 0.09, 0, Math.PI * 2)
    c.fill()
  }
  c.fillStyle = '#000'
  c.fillRect(cx - s * 0.5, y + s * 0.06, s, s * 0.035)
  c.restore()
}

/** A drinks can, `h` pixels tall, standing on y. */
export function can(c: Ctx, cx: number, y: number, h: number, body: string, band: string): void {
  const w = h * 0.5
  c.save()
  c.strokeStyle = body
  c.lineWidth = Math.max(3, h * 0.03)
  roundRect(c, cx - w / 2, y - h, w, h, w * 0.14)
  c.stroke()
  c.fillStyle = band
  c.fillRect(cx - w / 2 + 4, y - h * 0.62, w - 8, h * 0.26)
  c.strokeStyle = body
  c.beginPath()
  c.ellipse(cx, y - h + h * 0.02, w * 0.36, h * 0.03, 0, 0, Math.PI * 2)
  c.stroke()
  c.restore()
}

/** A trophy cup. */
export function trophy(c: Ctx, cx: number, y: number, s: number, color: string): void {
  c.save()
  c.fillStyle = color
  c.strokeStyle = color
  c.lineWidth = s * 0.07
  c.beginPath() // the cup
  c.moveTo(cx - s * 0.42, y)
  c.lineTo(cx + s * 0.42, y)
  c.bezierCurveTo(cx + s * 0.42, y + s * 0.5, cx + s * 0.2, y + s * 0.62, cx, y + s * 0.64)
  c.bezierCurveTo(cx - s * 0.2, y + s * 0.62, cx - s * 0.42, y + s * 0.5, cx - s * 0.42, y)
  c.fill()
  for (const side of [-1, 1]) {
    c.beginPath() // handles
    c.arc(cx + side * s * 0.44, y + s * 0.18, s * 0.15, side > 0 ? -Math.PI / 2 : Math.PI / 2, side > 0 ? Math.PI / 2 : (Math.PI * 3) / 2, false)
    c.stroke()
  }
  c.fillRect(cx - s * 0.06, y + s * 0.62, s * 0.12, s * 0.2)
  c.fillRect(cx - s * 0.28, y + s * 0.82, s * 0.56, s * 0.12)
  c.restore()
}

/** A five-point crown. */
export function crown(c: Ctx, cx: number, y: number, s: number, color: string): void {
  c.fillStyle = color
  poly(c, [-0.5, 0.6, -0.5, 0, -0.25, 0.3, 0, -0.1, 0.25, 0.3, 0.5, 0, 0.5, 0.6].map((v, i) => (i % 2 ? y + v * s : cx + v * s)))
  c.fill()
}

/** A heart. */
export function heart(c: Ctx, cx: number, cy: number, s: number, color: string): void {
  c.save()
  c.fillStyle = color
  c.beginPath()
  c.moveTo(cx, cy + s * 0.45)
  c.bezierCurveTo(cx - s * 0.7, cy, cx - s * 0.45, cy - s * 0.55, cx, cy - s * 0.22)
  c.bezierCurveTo(cx + s * 0.45, cy - s * 0.55, cx + s * 0.7, cy, cx, cy + s * 0.45)
  c.fill()
  c.restore()
}

/** A music note (two joined quavers). */
export function notes(c: Ctx, x: number, y: number, s: number, color: string): void {
  c.save()
  c.fillStyle = color
  for (const dx of [0, 0.55]) {
    c.beginPath()
    c.ellipse(x + dx * s, y + s * (0.85 - dx * 0.25), s * 0.16, s * 0.12, -0.4, 0, Math.PI * 2)
    c.fill()
    c.fillRect(x + dx * s + s * 0.12, y + s * (0.12 - dx * 0.25), s * 0.06, s * 0.74)
  }
  poly(c, [x + s * 0.12, y + s * 0.12, x + s * 0.73, y - s * 0.02, x + s * 0.73, y + s * 0.1, x + s * 0.12, y + s * 0.24])
  c.fill()
  c.restore()
}

/** A flying saucer. */
export function ufo(c: Ctx, cx: number, cy: number, s: number, hull: string, dome: string, beam?: string): void {
  c.save()
  if (beam) {
    c.globalAlpha = 0.35
    c.fillStyle = beam
    poly(c, [cx - s * 0.18, cy + s * 0.1, cx + s * 0.18, cy + s * 0.1, cx + s * 0.5, cy + s * 1.1, cx - s * 0.5, cy + s * 1.1])
    c.fill()
    c.globalAlpha = 1
  }
  c.fillStyle = dome
  c.beginPath()
  c.ellipse(cx, cy - s * 0.08, s * 0.22, s * 0.2, 0, Math.PI, 0)
  c.fill()
  c.fillStyle = hull
  c.beginPath()
  c.ellipse(cx, cy, s * 0.5, s * 0.13, 0, 0, Math.PI * 2)
  c.fill()
  c.fillStyle = '#000'
  for (let i = -2; i <= 2; i++) {
    c.beginPath()
    c.arc(cx + i * s * 0.17, cy, s * 0.035, 0, Math.PI * 2)
    c.fill()
  }
  c.restore()
}

/** A game controller outline. */
export function controller(c: Ctx, cx: number, cy: number, s: number, body: string, buttons: string): void {
  c.save()
  c.strokeStyle = body
  c.lineWidth = Math.max(3, s * 0.05)
  c.lineJoin = 'round'
  c.beginPath()
  c.moveTo(cx - s * 0.3, cy - s * 0.2)
  c.lineTo(cx + s * 0.3, cy - s * 0.2)
  c.bezierCurveTo(cx + s * 0.5, cy - s * 0.2, cx + s * 0.6, cy + s * 0.3, cx + s * 0.48, cy + s * 0.32)
  c.bezierCurveTo(cx + s * 0.38, cy + s * 0.34, cx + s * 0.3, cy + s * 0.12, cx + s * 0.2, cy + s * 0.1)
  c.lineTo(cx - s * 0.2, cy + s * 0.1)
  c.bezierCurveTo(cx - s * 0.3, cy + s * 0.12, cx - s * 0.38, cy + s * 0.34, cx - s * 0.48, cy + s * 0.32)
  c.bezierCurveTo(cx - s * 0.6, cy + s * 0.3, cx - s * 0.5, cy - s * 0.2, cx - s * 0.3, cy - s * 0.2)
  c.stroke()
  c.fillStyle = buttons
  c.fillRect(cx - s * 0.36, cy - s * 0.06, s * 0.16, s * 0.05)
  c.fillRect(cx - s * 0.305, cy - s * 0.115, s * 0.05, s * 0.16)
  for (const [dx, dy] of [
    [0.28, -0.1],
    [0.36, -0.03],
    [0.2, -0.03],
    [0.28, 0.04],
  ]) {
    c.beginPath()
    c.arc(cx + dx * s, cy + dy * s, s * 0.03, 0, Math.PI * 2)
    c.fill()
  }
  c.restore()
}

/** A speedometer arc with its needle at `frac` (0..1). */
export function gauge(c: Ctx, cx: number, cy: number, r: number, frac: number, arc: string, needle: string): void {
  c.save()
  c.lineCap = 'round'
  c.strokeStyle = arc
  c.lineWidth = r * 0.1
  c.beginPath()
  c.arc(cx, cy, r, Math.PI * 0.8, Math.PI * 2.2)
  c.stroke()
  for (let i = 0; i <= 8; i++) {
    const a = Math.PI * 0.8 + (i / 8) * Math.PI * 1.4
    c.beginPath()
    c.moveTo(cx + Math.cos(a) * r * 0.72, cy + Math.sin(a) * r * 0.72)
    c.lineTo(cx + Math.cos(a) * r * 0.84, cy + Math.sin(a) * r * 0.84)
    c.lineWidth = r * 0.05
    c.stroke()
  }
  const a = Math.PI * 0.8 + frac * Math.PI * 1.4
  c.strokeStyle = needle
  c.lineWidth = r * 0.08
  c.beginPath()
  c.moveTo(cx, cy)
  c.lineTo(cx + Math.cos(a) * r * 0.8, cy + Math.sin(a) * r * 0.8)
  c.stroke()
  c.restore()
}

/** A palm tree silhouette in neon outline. */
export function palm(c: Ctx, x: number, y: number, s: number, color: string): void {
  c.save()
  c.strokeStyle = color
  c.lineWidth = Math.max(3, s * 0.05)
  c.lineCap = 'round'
  c.beginPath() // trunk, leaning a little
  c.moveTo(x, y)
  c.quadraticCurveTo(x + s * 0.12, y - s * 0.5, x + s * 0.06, y - s)
  c.stroke()
  const tx = x + s * 0.06
  const ty = y - s
  for (const [dx, dy] of [
    [-0.5, 0.15],
    [-0.4, -0.2],
    [0, -0.32],
    [0.42, -0.18],
    [0.52, 0.18],
  ]) {
    c.beginPath()
    c.moveTo(tx, ty)
    c.quadraticCurveTo(tx + dx * s * 0.5, ty + (dy - 0.25) * s * 0.5, tx + dx * s, ty + dy * s + s * 0.15)
    c.stroke()
  }
  c.restore()
}

/** Equaliser bars, heights picked from a fixed pattern so the ad never changes between loads. */
export function eqBars(c: Ctx, x: number, base: number, n: number, barW: number, maxH: number, color: string): void {
  c.fillStyle = color
  for (let i = 0; i < n; i++) {
    const h = maxH * (0.25 + 0.75 * Math.abs(Math.sin(i * 1.7 + 0.6) * Math.cos(i * 0.45)))
    c.fillRect(x + i * barW * 1.5, base - h, barW, h)
  }
}

/** A donut (ring with icing sprinkles). */
export function donut(c: Ctx, cx: number, cy: number, r: number, dough: string, icing: string, sprinkles: string): void {
  c.save()
  c.lineWidth = r * 0.55
  c.strokeStyle = dough
  c.beginPath()
  c.arc(cx, cy, r * 0.7, 0, Math.PI * 2)
  c.stroke()
  c.lineWidth = r * 0.4
  c.strokeStyle = icing
  c.beginPath()
  c.arc(cx, cy - r * 0.04, r * 0.7, 0, Math.PI * 2)
  c.stroke()
  c.fillStyle = sprinkles
  for (let i = 0; i < 10; i++) {
    const a = i * 0.63 + 0.3
    const rr = r * (0.58 + (i % 3) * 0.1)
    c.save()
    c.translate(cx + Math.cos(a) * rr, cy - r * 0.04 + Math.sin(a) * rr)
    c.rotate(a * 2.3)
    c.fillRect(-r * 0.08, -r * 0.025, r * 0.16, r * 0.05)
    c.restore()
  }
  c.restore()
}

/** An ice cream cone with two scoops. */
export function iceCream(c: Ctx, cx: number, y: number, s: number, cone: string, scoop1: string, scoop2: string): void {
  c.save()
  c.fillStyle = cone
  poly(c, [cx - s * 0.28, y + s * 0.55, cx + s * 0.28, y + s * 0.55, cx, y + s * 1.25])
  c.fill()
  c.strokeStyle = '#000'
  c.lineWidth = s * 0.03
  for (let i = 1; i < 4; i++) {
    c.beginPath()
    c.moveTo(cx - s * 0.28 + i * s * 0.14, y + s * 0.55)
    c.lineTo(cx + (i - 2) * s * 0.02, y + s * 1.1)
    c.stroke()
  }
  c.fillStyle = scoop1
  c.beginPath()
  c.arc(cx, y + s * 0.45, s * 0.3, 0, Math.PI * 2)
  c.fill()
  c.fillStyle = scoop2
  c.beginPath()
  c.arc(cx, y + s * 0.12, s * 0.25, 0, Math.PI * 2)
  c.fill()
  c.restore()
}

/** An oval race track seen from above (the Hyperdrome's shape). */
export function ovalTrack(c: Ctx, cx: number, cy: number, w: number, h: number, color: string, lane: string): void {
  c.save()
  c.lineWidth = h * 0.12
  c.strokeStyle = color
  roundRect(c, cx - w / 2, cy - h / 2, w, h, h / 2)
  c.stroke()
  c.lineWidth = 2
  c.strokeStyle = lane
  c.setLineDash([8, 8])
  roundRect(c, cx - w / 2, cy - h / 2, w, h, h / 2)
  c.stroke()
  c.restore()
}
