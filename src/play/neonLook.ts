// ============================================================
//  NEON LOOK - the shared materials for play's props
// ------------------------------------------------------------
//  Crates, energy cubes and posts are dark solid things with light
//  running along their edges. Rather than modelling the light strips,
//  each face gets a small procedural "edge mask" texture (drawn on a
//  canvas, 128 px, no image files): white along the border, black
//  in the middle. Used as an emissive map, only the border glows, so
//  every face of a box gets a glowing frame for free.
//
//  Glow tiers (CONSTITUTION section 1): prop edges and posts are T1
//  (a soft halo), well under the road's T2, so the road stays the
//  brightest line in the world.
// ============================================================

import * as THREE from 'three'

/**
 * Draw an edge mask. `inner` is how bright the middle of the face is
 * (0 = dark, 1 = as bright as the edge). Mask values are greyscale
 * data, not colours: the colour comes from the material's emissive.
 */
export function edgeMaskTexture(opts: { size?: number; border: number; inner: number; panel?: number }): THREE.CanvasTexture {
  const size = opts.size ?? 128
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const grey = (v: number) => {
    const c = Math.round(Math.max(0, Math.min(1, v)) * 255)
    return `rgb(${c},${c},${c})`
  }
  ctx.fillStyle = grey(opts.inner)
  ctx.fillRect(0, 0, size, size)
  const b = Math.max(1, Math.round(size * opts.border))
  ctx.strokeStyle = grey(1)
  ctx.lineWidth = b * 2
  ctx.strokeRect(0, 0, size, size)
  if (opts.panel && opts.panel > 0) {
    // a faint inset panel line, so a big crate face isn't one flat slab
    const inset = Math.round(size * 0.24)
    ctx.strokeStyle = grey(opts.panel)
    ctx.lineWidth = Math.max(1, Math.round(b * 0.5))
    ctx.strokeRect(inset, inset, size - inset * 2, size - inset * 2)
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.NoColorSpace
  tex.generateMipmaps = true
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.anisotropy = 4
  return tex
}
