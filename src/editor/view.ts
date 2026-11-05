// ============================================================
//  EDITOR VIEW - where the top-down map is looking
// ------------------------------------------------------------
//  The editor looks straight down at the world like a map, north
//  (-z) at the top. This tiny singleton holds where the map is
//  centred and how zoomed in it is (metres per screen pixel). The
//  3D camera (TopDownCamera.tsx) and the 2D overlay (Overlay.tsx)
//  both read it every frame, so they always line up exactly.
//
//  It is a plain mutable object, not React state: panning changes
//  it 60 times a second and nothing needs to re-render for that.
// ============================================================

import type { P } from './geom'

export const view = {
  /** World point at the centre of the screen. */
  cx: 0,
  cz: 0,
  /** Metres of world per CSS pixel (bigger = zoomed out). */
  mpp: 1.8,
  /** Screen size in CSS pixels (kept up to date by the overlay). */
  width: 1920,
  height: 1080,
  /** Bumped on every change, so drawers know to redraw. */
  version: 0,
  /** Where the scale bar starts, pixels from the left, and how far it sits above the window's bottom edge (a phone moves it into its free map: phone/PhoneEditor.tsx). */
  scaleX: 96,
  scaleUp: 28,
}

export const ZOOM = {
  /** Most zoomed in: 0.15 m per pixel (a car is about 30 px long). */
  min: 0.15,
  /** Most zoomed out: the whole world and some sky around it. */
  max: 4,
}

/** Most zoomed out on a phone, while its layout is up: the short window needs it for a square track and the whole world. */
export const ZOOM_MAX_PHONE = 8

export function setView(cx: number, cz: number, mpp: number): void {
  view.cx = cx
  view.cz = cz
  view.mpp = Math.min(ZOOM.max, Math.max(ZOOM.min, mpp))
  view.version++
}

/** Screen pixel (CSS, from the top-left of the window) to world x, z. */
export function screenToWorld(sx: number, sy: number): P {
  return { x: view.cx + (sx - view.width / 2) * view.mpp, z: view.cz + (sy - view.height / 2) * view.mpp }
}

/** World x, z to screen pixel. */
export function worldToScreen(x: number, z: number): { sx: number; sy: number } {
  return { sx: (x - view.cx) / view.mpp + view.width / 2, sy: (z - view.cz) / view.mpp + view.height / 2 }
}

/**
 * Frame a box of the world inside a box of the screen (a phone's free map,
 * phone/freeMap.ts), leaving `margin` pixels all round.
 */
export function fitBoxInto(minX: number, minZ: number, maxX: number, maxZ: number, box: { left: number; top: number; right: number; bottom: number }, margin = 12): void {
  const usableW = Math.max(100, box.right - box.left - margin * 2)
  const usableH = Math.max(100, box.bottom - box.top - margin * 2)
  const mpp = Math.min(ZOOM.max, Math.max(ZOOM.min, Math.max((maxX - minX) / usableW, (maxZ - minZ) / usableH)))
  const middleX = (box.left + box.right) / 2 - view.width / 2
  const middleY = (box.top + box.bottom) / 2 - view.height / 2
  setView((minX + maxX) / 2 - middleX * mpp, (minZ + maxZ) / 2 - middleY * mpp, mpp)
}

/** Zoom by a factor, keeping the world point under screen pixel (sx, sy) where it is. */
export function zoomAt(sx: number, sy: number, factor: number): void {
  const before = screenToWorld(sx, sy)
  const mpp = Math.min(ZOOM.max, Math.max(ZOOM.min, view.mpp * factor))
  const cx = before.x - (sx - view.width / 2) * mpp
  const cz = before.z - (sy - view.height / 2) * mpp
  setView(cx, cz, mpp)
}

export function panBy(dxPixels: number, dyPixels: number): void {
  setView(view.cx - dxPixels * view.mpp, view.cz - dyPixels * view.mpp, view.mpp)
}

/**
 * Frame a box of the world on screen, leaving room for the toolbar on
 * the left (`padLeft` px) and the panel on the right (`padRight` px).
 */
export function fitBox(minX: number, minZ: number, maxX: number, maxZ: number, padLeft = 90, padRight = 380): void {
  const margin = 60
  const usableW = Math.max(200, view.width - padLeft - padRight - margin * 2)
  const usableH = Math.max(200, view.height - margin * 2)
  const mpp = Math.max((maxX - minX) / usableW, (maxZ - minZ) / usableH)
  const clamped = Math.min(ZOOM.max, Math.max(ZOOM.min, mpp))
  // Centre the box in the usable area, which is shifted by the unequal side padding.
  const shiftPx = (padLeft - padRight) / 2
  setView((minX + maxX) / 2 - shiftPx * clamped, (minZ + maxZ) / 2, clamped)
}
