// ============================================================
//  COLOUR PICKER DATA - the garage swatches and the hue maths
// ------------------------------------------------------------
//  Every swatch comes from src/core/palette.ts, so a picked
//  colour always belongs to the game's look. The custom hue
//  slider makes a colour from a hue (0-360) at a brightness that
//  suits the job: paint stays a deep body colour, glow and trail
//  stay a bright neon.
// ============================================================

import { PALETTE } from '../core/palette'

/** Body paint: deep, glossy colours that let the neon pop, then a few bold ones. */
export const PAINT_SWATCHES: readonly string[] = [
  PALETTE.paintDefault, // midnight navy
  PALETTE.ground, //       black glass
  PALETTE.skyMidDusk, //   plum
  PALETTE.planet, //       indigo
  PALETTE.uiDim, //        lavender silver
  PALETTE.stars, //        pearl white
  PALETTE.aiColors[0], //  sunset red
  PALETTE.sunMid, //       orange
  PALETTE.aiColors[1], //  yellow
  PALETTE.boost, //        mint
]

/** Underglow, light strips and trails: the world's neon colours. */
export const NEON_SWATCHES: readonly string[] = [
  PALETTE.glowDefault,
  PALETTE.roadEdge,
  PALETTE.boost,
  PALETTE.chevron,
  PALETTE.wallRide,
  PALETTE.core,
  PALETTE.laneLine,
  PALETTE.skyHorizonDusk,
  PALETTE.sunTop,
  PALETTE.cityWindowWarm,
]

export type ColourTone = 'paint' | 'neon'

export interface Hsl {
  h: number // 0..360
  s: number // 0..1
  l: number // 0..1
}

export function hexToHsl(hex: string): Hsl {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return { h: 190, s: 1, l: 0.55 }
  const n = parseInt(m[1], 16)
  const r = ((n >> 16) & 255) / 255
  const g = ((n >> 8) & 255) / 255
  const b = (n & 255) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  let h = 0
  let s = 0
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0)
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
  }
  return { h, s, l }
}

export function hslToHex({ h, s, l }: Hsl): string {
  const hue = ((h % 360) + 360) % 360
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = l - c / 2
  let r = 0
  let g = 0
  let b = 0
  if (hue < 60) [r, g, b] = [c, x, 0]
  else if (hue < 120) [r, g, b] = [x, c, 0]
  else if (hue < 180) [r, g, b] = [0, c, x]
  else if (hue < 240) [r, g, b] = [0, x, c]
  else if (hue < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  const to = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`
}

/**
 * A custom colour at `hue`, keeping the feel of the current colour:
 * paint keeps its depth (a dark paint stays dark), neon stays bright.
 * Never a pure primary: neon tops out at 62% lightness and 92% saturation.
 */
export function colourForHue(hue: number, current: string, tone: ColourTone): string {
  if (tone === 'neon') return hslToHex({ h: hue, s: 0.92, l: 0.6 })
  const c = hexToHsl(current)
  return hslToHex({ h: hue, s: Math.max(0.45, Math.min(0.85, c.s)), l: Math.min(0.6, Math.max(0.14, c.l)) })
}
