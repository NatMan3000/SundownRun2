// ============================================================
//  NAME TAG - the floating label over another player's car
// ------------------------------------------------------------
//  A sprite (a flat picture that always faces the camera) with a
//  small canvas texture drawn in code: a dark glass pill, a thin
//  neon rule in the player's glow colour, and their name.
//
//  It is drawn on top of everything (no depth test) so you can find
//  your friends behind a hill, and it stays readable far away because
//  RemoteCar scales it up with distance. Its colours never go above
//  1.0, so bloom leaves it alone (glow tier T0/T1 territory).
// ============================================================

import * as THREE from 'three'
import { FONTS, PALETTE } from '../core/palette'

const W = 512
const H = 128

/** Width / height of the tag in metres at close range. */
export const TAG_WORLD_HEIGHT = 0.55
export const TAG_WORLD_WIDTH = TAG_WORLD_HEIGHT * (W / H)

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/** Build a name tag sprite. Caller disposes it with disposeNameTag(). */
export function buildNameTag(name: string, glow: string): THREE.Sprite {
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!

  ctx.font = `700 64px ${FONTS.display}`
  const textW = Math.min(W - 64, ctx.measureText(name).width)
  const pillW = textW + 72
  const x = (W - pillW) / 2
  const y = 18
  const h = H - 36

  // Dark glass pill.
  roundRect(ctx, x, y, pillW, h, h / 2)
  ctx.fillStyle = PALETTE.uiPanel
  ctx.fill()
  // Thin neon rule in their colour.
  ctx.lineWidth = 4
  ctx.strokeStyle = glow
  ctx.stroke()
  // The name.
  ctx.fillStyle = PALETTE.uiText
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(name, W / 2, H / 2 + 2, W - 64)

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  })
  const sprite = new THREE.Sprite(material)
  sprite.scale.set(TAG_WORLD_WIDTH, TAG_WORLD_HEIGHT, 1)
  sprite.renderOrder = 10
  sprite.name = `nameTag:${name}`
  return sprite
}

export function disposeNameTag(sprite: THREE.Sprite): void {
  const m = sprite.material as THREE.SpriteMaterial
  m.map?.dispose()
  m.dispose()
}
