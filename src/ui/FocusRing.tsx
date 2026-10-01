// ============================================================
//  FOCUS RING - the neon outline that glides to whatever is focused
// ------------------------------------------------------------
//  One ring for every menu. Each frame it finds the focused item's
//  box on screen and springs toward it, so moving focus slides the
//  ring across instead of blinking it, and the ring keeps up with
//  panels that are still sliding in. It copies the item's corner
//  radius, so it hugs a round swatch as well as a long row.
//
//  Moving to another screen doesn't glide: the ring fades in on the
//  new screen's focused item instead of flying across the display.
//
//  Writes only transform / size / radius, and only when they move.
// ============================================================

import { useEffect, useRef } from 'react'
import { focusedElement } from './nav'
import { activeScreen } from './uiStore'

/** Spring stiffness: higher = snappier. ~26 settles in about 180 ms. */
const OMEGA = 26
const PAD = 4

export function FocusRing() {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const ring = ref.current
    if (!ring) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)')
    let raf = 0
    let prev = performance.now()
    let shown = false
    let target: HTMLElement | null = null
    let screen: string | null = null
    // position and size, with velocities
    let x = 0
    let y = 0
    let w = 0
    let h = 0
    let vx = 0
    let vy = 0
    let vw = 0
    let vh = 0
    let wx = -1
    let wy = -1
    let ww = -1
    let wh = -1

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      const dt = Math.min(1 / 30, (now - prev) / 1000)
      prev = now
      const el = focusedElement()
      if (!el) {
        if (shown) {
          shown = false
          ring.classList.remove('is-on')
        }
        target = null
        return
      }
      const r = el.getBoundingClientRect()
      const tx = r.left - PAD
      const ty = r.top - PAD
      const tw = r.width + PAD * 2
      const th = r.height + PAD * 2
      if (el !== target) {
        target = el
        const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0
        ring.style.borderRadius = `${radius + PAD}px`
        ring.classList.toggle('is-round', el.classList.contains('swatch'))
      }
      // A new screen: appear on its first item instead of flying across from the old one.
      const scr = activeScreen()
      if (scr !== screen) {
        screen = scr
        shown = false
        // Replay the fade-in (removing the class, reading layout once, adding it back).
        ring.classList.remove('is-fresh')
        void ring.offsetWidth
        ring.classList.add('is-fresh')
      }
      if (!shown || reduce.matches) {
        // Appear in place (no flying in from the corner), then glide from there on.
        x = tx
        y = ty
        w = tw
        h = th
        vx = vy = vw = vh = 0
        if (!shown) {
          shown = true
          ring.classList.add('is-on')
        }
      } else {
        const k = OMEGA * OMEGA
        const c = 2 * OMEGA
        vx += (k * (tx - x) - c * vx) * dt
        vy += (k * (ty - y) - c * vy) * dt
        vw += (k * (tw - w) - c * vw) * dt
        vh += (k * (th - h) - c * vh) * dt
        x += vx * dt
        y += vy * dt
        w += vw * dt
        h += vh * dt
      }
      // Write only when something moved by a visible amount.
      if (Math.abs(x - wx) > 0.1 || Math.abs(y - wy) > 0.1) {
        wx = x
        wy = y
        ring.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`
      }
      if (Math.abs(w - ww) > 0.1 || Math.abs(h - wh) > 0.1) {
        ww = w
        wh = h
        ring.style.width = `${w.toFixed(1)}px`
        ring.style.height = `${h.toFixed(1)}px`
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])
  return <div ref={ref} className="focus-ring" aria-hidden="true" />
}
