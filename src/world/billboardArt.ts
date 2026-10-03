// ============================================================
//  BILLBOARD ART - painting every ad into the billboard texture
// ------------------------------------------------------------
//  The ads themselves live in ./ads (wide.ts, tall.ts, square.ts:
//  one function per ad). This file paints them all, once, into a
//  stack of 1024 x 1024 "pages" (a texture array: one texture with
//  several layers), so every billboard in the world can show any ad
//  from ONE texture in ONE draw call.
//
//  Each page is a 4 x 4 grid of 256 px squares ("units"). A wide ad
//  takes 2 x 1 units (512 x 256), a tall one 1 x 2, a square 1 x 1.
//  layoutAds() packs them in: the tall ones first, then the wide,
//  then the squares fill the gaps, and it adds a page whenever one
//  is full.
//
//  Everything is drawn with simple canvas shapes and the system
//  font (constitution section 5), every colour from the palette,
//  bright on black: the hologram adds the art as light, so black is
//  see-through and colour glows.
//
//  Josh: to add an ad, add one entry to wide.ts, tall.ts or
//  square.ts. You never need to touch this file. If the ads no
//  longer fit on the pages, a new page is added by itself (each
//  page costs about 5 MB of graphics memory, so keep it sensible).
// ============================================================

import * as THREE from 'three'
import { PALETTE } from '../core/palette'
import { ALL_ADS } from './ads'
import type { AdDef, AdShape } from './ads/adKit'

/** One unit is a 256 px square; a page is 4 x 4 units. */
export const UNIT = 256
export const PAGE_UNITS = 4
export const PAGE = UNIT * PAGE_UNITS

const SHAPE_UNITS: Record<AdShape, [number, number]> = { wide: [2, 1], tall: [1, 2], square: [1, 1] }

/** Where one ad sits: its page, and its box on that page in pixels. */
export interface AdCell {
  page: number
  x: number
  y: number
  w: number
  h: number
}

/** Pack every ad onto pages, first fit. Same ads, same layout. */
export function layoutAds(ads: readonly AdDef[]): { cells: AdCell[]; pages: number } {
  const cells: AdCell[] = new Array(ads.length)
  const used: boolean[][] = [] // used[page][row * PAGE_UNITS + col]
  const order = ads.map((_, i) => i)
  const rank: Record<AdShape, number> = { tall: 0, wide: 1, square: 2 }
  order.sort((a, b) => rank[ads[a].shape] - rank[ads[b].shape] || a - b)
  for (const i of order) {
    const [uw, uh] = SHAPE_UNITS[ads[i].shape]
    let placed = false
    for (let p = 0; !placed; p++) {
      if (!used[p]) used[p] = new Array(PAGE_UNITS * PAGE_UNITS).fill(false)
      const grid = used[p]
      for (let r = 0; r + uh <= PAGE_UNITS && !placed; r++) {
        for (let k = 0; k + uw <= PAGE_UNITS && !placed; k++) {
          let free = true
          for (let dr = 0; dr < uh && free; dr++) for (let dk = 0; dk < uw && free; dk++) free = !grid[(r + dr) * PAGE_UNITS + k + dk]
          if (!free) continue
          for (let dr = 0; dr < uh; dr++) for (let dk = 0; dk < uw; dk++) grid[(r + dr) * PAGE_UNITS + k + dk] = true
          cells[i] = { page: p, x: k * UNIT, y: r * UNIT, w: uw * UNIT, h: uh * UNIT }
          placed = true
        }
      }
    }
  }
  return { cells, pages: used.length }
}

/** Paint one page of ads onto a canvas (also used by the dev contact sheet). */
export function paintPage(page: number, canvas?: HTMLCanvasElement): HTMLCanvasElement {
  const { cells } = billboardLayout()
  const cv = canvas ?? document.createElement('canvas')
  cv.width = PAGE
  cv.height = PAGE
  const c = cv.getContext('2d', { willReadFrequently: true })!
  // Opaque black underneath: black adds no light, and the colours at the edges of
  // shapes and letters come out right (no bright fringes from see-through pixels).
  c.fillStyle = '#000'
  c.fillRect(0, 0, PAGE, PAGE)
  for (let i = 0; i < ALL_ADS.length; i++) {
    const cell = cells[i]
    if (cell.page !== page) continue
    c.save()
    c.translate(cell.x, cell.y)
    c.beginPath()
    c.rect(0, 0, cell.w, cell.h)
    c.clip()
    // A thin frame round every ad.
    const inset = cell.w > UNIT || cell.h > UNIT ? 10 : 8
    c.strokeStyle = PALETTE.laneLine
    c.globalAlpha = 0.55
    c.lineWidth = 4
    c.strokeRect(inset, inset, cell.w - inset * 2, cell.h - inset * 2)
    c.globalAlpha = 1
    try {
      ALL_ADS[i].draw(c, cell.w, cell.h)
    } catch (err) {
      // One broken ad must not take the world down: it stays a blank frame, and says so.
      console.error(`[world] the billboard ad "${ALL_ADS[i].name}" failed to draw:`, err)
    }
    c.restore()
  }
  return cv
}

let layoutCache: { cells: AdCell[]; pages: number } | null = null
/** The packed layout of every ad (worked out once). */
export function billboardLayout(): { cells: AdCell[]; pages: number } {
  if (!layoutCache) layoutCache = layoutAds(ALL_ADS)
  return layoutCache
}

/** How long the last paint of every ad took, milliseconds (the inspector shows it). */
export const paintStats = { ms: 0 }

/**
 * The texture array with every ad (the caller disposes it). The pixels are painted
 * fresh each time (a few tens of milliseconds) and let go once they are on the
 * graphics card, so the ads never cost main memory as well.
 */
export function makeBillboardTexture(): THREE.DataArrayTexture {
  const t0 = performance.now()
  const { pages } = billboardLayout()
  const data = new Uint8Array(PAGE * PAGE * 4 * pages)
  const canvas = document.createElement('canvas')
  for (let p = 0; p < pages; p++) {
    const c = paintPage(p, canvas).getContext('2d', { willReadFrequently: true })!
    data.set(c.getImageData(0, 0, PAGE, PAGE).data, p * PAGE * PAGE * 4)
  }
  paintStats.ms = Math.round(performance.now() - t0)
  const tex = new THREE.DataArrayTexture(data, PAGE, PAGE, pages)
  tex.format = THREE.RGBAFormat
  tex.type = THREE.UnsignedByteType
  tex.colorSpace = THREE.SRGBColorSpace
  tex.generateMipmaps = true
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.anisotropy = 4
  tex.needsUpdate = true
  // Once three.js has copied the pixels to the graphics card, drop our copy (24 MB).
  tex.onUpdate = () => {
    tex.image.data = null
    tex.onUpdate = null
  }
  return tex
}

/** Graphics memory the ad pages take, megabytes (with their smaller mipmap copies). */
export function billboardTextureMB(): number {
  return Math.round(((PAGE * PAGE * 4 * billboardLayout().pages * 4) / 3 / (1024 * 1024)) * 10) / 10
}

/** The atlas box of an ad as texture coordinates: [u0, v0, du, dv] (v counts down from the top of a page). */
export function adRect(ad: number): [number, number, number, number] {
  const cell = billboardLayout().cells[ad]
  return [cell.x / PAGE, cell.y / PAGE, cell.w / PAGE, cell.h / PAGE]
}
