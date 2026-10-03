// ============================================================
//  3D VIEW - the button, the note, and your hands in 3D
// ------------------------------------------------------------
//  The DOM half of the editor's 3D view (look3d.ts says how it all
//  fits):
//
//    top right of the map   the compass (it turns as you look round
//                           in 3D, so north is always findable) and
//                           the 3D button beside it; in 3D it says
//                           "Map" and takes you back
//    top of the map, in 3D  one line: what your mouse does, and
//                           "Back to the map to edit"
//    the whole map, in 3D   a see-through layer that takes your mouse
//                           (drag turns, right-drag slides, the wheel
//                           zooms), with the problem pins and the
//                           selected spot drawn on it (look3dMarks.tsx)
//
//  The T key opens and closes it anywhere on the map. Esc closes it
//  too (EditorUi.tsx asks closeLook3d() before anything else Esc does).
//  While it shows, the map's tools wait: the rail dims (look3d.css),
//  the map's own keys and controller are off (Overlay.tsx), and a click
//  on the rail says how to get back.
// ============================================================

import { useEffect, useRef } from 'react'
import { inputState } from '../core/controls'
import { registerDev } from '../core/devHandles'
import { say, useEditor } from './draft'
import { look, closeLook3d, lookSummary, openLook3d, slideLook, toggleLook3d, turnLook, useLook3d, zoomLook, resetLook3d } from './look3d'
import { setMarksCanvas, marksSummary } from './look3dMarks'
import { view } from './view'
import './look3d.css'

/** Held-key and stick speeds in 3D. */
const SLIDE_PX_PER_S = 700
const STICK_SLIDE_PX_PER_S = 900
const STICK_TURN_RAD_PER_S = 2.2
/** One full turn for a drag the height of the screen (the same feel as most 3D viewers). */
const TURN_PER_PX = () => (Math.PI * 2) / Math.max(300, view.height)

/** The words on the rail when it is clicked in 3D, and in the note. */
export const LOOK_BACK_HINT = 'Back to the map to edit: press Map, T or Esc.'

/** True while a mouse button is down anywhere (T waits, so a half-drawn line can't be cut off). */
let pointerHeld = false

/** A key that belongs to a text box or a menu question, not to the view. */
function typing(e: KeyboardEvent): boolean {
  const t = e.target
  if (inputState.context === 'text' || inputState.context === 'menu') return true
  if (t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return true
  return t instanceof HTMLInputElement && t.type !== 'range'
}

export function Look3dUi() {
  const editing = useEditor((s) => s.mode === 'edit')
  const mode = useLook3d((s) => s.mode)
  const on = mode !== 'map'

  // T: open or close the 3D view (on the map's edit mode only, never while a mouse button is held).
  useEffect(() => {
    const down = () => {
      pointerHeld = true
    }
    const up = () => {
      pointerHeld = false
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'KeyT' || e.repeat || e.ctrlKey || e.metaKey || e.altKey || typing(e)) return
      if (useEditor.getState().mode !== 'edit' || pointerHeld) return
      e.preventDefault()
      toggleLook3d()
    }
    // A click on the dimmed rail in 3D says how to get back to the tools.
    const onClick = (e: MouseEvent) => {
      if (useLook3d.getState().mode === 'map') return
      const t = e.target
      if (t instanceof Element && t.closest('.sre-tools, .sre-options, .sre-palette')) say(LOOK_BACK_HINT, 'info')
    }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('pointerup', up, true)
    window.addEventListener('pointercancel', up, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('click', onClick, true)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('pointerup', up, true)
      window.removeEventListener('pointercancel', up, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('click', onClick, true)
      pointerHeld = false
      resetLook3d()
    }
  }, [])

  // The world map (paused game) has no 3D view: if it opens, the 3D view closes.
  useEffect(() => {
    if (!editing) resetLook3d()
  }, [editing])

  return (
    <>
      {on && <LookSurface />}
      <ViewCorner show3d={editing} on={mode === 'opening' || mode === '3d'} />
      {on && (
        <div className="sre-look-note" role="note" data-testid="editor-3d-note">
          <span className="sre-look-kicker">3D view</span>
          <span className="sre-look-text">Drag to look round. Right-drag to move. Wheel to zoom.</span>
          <button type="button" className="sre-btn is-primary" onClick={() => closeLook3d()} data-testid="editor-3d-back">
            Back to the map to edit
          </button>
        </div>
      )}
    </>
  )
}

/** Top right of the map: the compass, and the 3D button beside it. */
function ViewCorner(p: { show3d: boolean; on: boolean }) {
  const needle = useRef<SVGGElement>(null)

  // The compass turns as you look round in 3D (north is always where its pointer says). Only
  // touches the DOM when the angle really changed, so a still view costs nothing.
  useEffect(() => {
    let raf = 0
    let shown = NaN
    const tick = () => {
      const deg = useLook3d.getState().mode === 'map' ? 0 : Math.round(((look.shown.yaw * 180) / Math.PI) * 10) / 10
      if (deg !== shown && needle.current) {
        shown = deg
        needle.current.setAttribute('transform', `rotate(${deg} 18 18)`)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div className="sre-look-corner">
      <svg className="sre-compass" viewBox="0 0 36 36" width="36" height="36" role="img" aria-label="Compass: the pointer shows north">
        <circle cx="18" cy="18" r="17" className="sre-compass-face" />
        <g ref={needle}>
          <path d="M18 5 L13 18 L23 18 Z" className="sre-compass-north" />
          <text x="18" y="27" textAnchor="middle" className="sre-compass-n">
            N
          </text>
        </g>
      </svg>
      {p.show3d && (
        <button
          type="button"
          className={`sre-btn sre-look-btn${p.on ? ' is-on' : ''}`}
          aria-pressed={p.on}
          aria-label={p.on ? 'Back to the map (T)' : 'See it in 3D (T)'}
          data-testid="editor-3d-button"
          onClick={() => toggleLook3d()}
        >
          {p.on ? <MapIcon /> : <CubeIcon />}
          <span>{p.on ? 'Map' : '3D'}</span>
          <kbd>T</kbd>
        </button>
      )}
    </div>
  )
}

/** A cube in three faces: the 3D view. */
function CubeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" />
      <path d="M4 7.5l8 4.5 8-4.5M12 12v9" />
    </svg>
  )
}

/** A folded paper map: back to the map. */
function MapIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 6.5l6-2.5 6 2.5 6-2.5v13.5l-6 2.5-6-2.5-6 2.5V6.5z" />
      <path d="M9 4v13.5M15 6.5V20" />
    </svg>
  )
}

/**
 * Over the whole map while in 3D: takes the mouse (the map's own canvas is
 * hidden underneath), the keys and the controller, and holds the canvas the
 * pins are drawn on.
 */
function LookSurface() {
  const surface = useRef<HTMLDivElement>(null)
  const marks = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    setMarksCanvas(marks.current)
    return () => setMarksCanvas(null)
  }, [])

  useEffect(() => {
    const el = surface.current
    if (!el) return
    let drag: 'turn' | 'slide' | null = null
    let lastX = 0
    let lastY = 0
    let spaceHeld = false
    const held = new Set<string>()
    const setCursor = () => {
      el.style.cursor = drag ? 'grabbing' : spaceHeld ? 'grab' : 'move'
    }

    const onDown = (e: PointerEvent) => {
      // Clicking the view takes the keyboard back from any panel control.
      if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur()
      if (e.button !== 0 && e.button !== 1 && e.button !== 2) return
      el.setPointerCapture(e.pointerId)
      drag = e.button === 0 && !spaceHeld ? 'turn' : 'slide'
      lastX = e.clientX
      lastY = e.clientY
      setCursor()
    }
    const onMove = (e: PointerEvent) => {
      if (!drag) return
      const dx = e.clientX - lastX
      const dy = e.clientY - lastY
      lastX = e.clientX
      lastY = e.clientY
      if (drag === 'turn') turnLook(-dx * TURN_PER_PX(), dy * TURN_PER_PX())
      else slideLook(dx, dy)
    }
    const onUp = (e: PointerEvent) => {
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
      drag = null
      setCursor()
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const lines = e.deltaMode === 1 ? 16 : 1
      zoomLook(Math.exp(e.deltaY * lines * 0.0015))
    }
    const onContext = (e: Event) => e.preventDefault()
    const onKeyDown = (e: KeyboardEvent) => {
      if (typing(e) || e.ctrlKey || e.metaKey) return
      if (e.code === 'Space') {
        spaceHeld = true
        setCursor()
        e.preventDefault()
        return
      }
      if (e.code === 'Equal' || e.code === 'NumpadAdd') zoomLook(1 / 1.25)
      if (e.code === 'Minus' || e.code === 'NumpadSubtract') zoomLook(1.25)
      held.add(e.code)
    }
    const onKeyUp = (e: KeyboardEvent) => {
      held.delete(e.code)
      if (e.code === 'Space') {
        spaceHeld = false
        setCursor()
      }
    }
    const onBlur = () => {
      held.clear()
      spaceHeld = false
      drag = null
      setCursor()
    }

    // Held keys and the controller, every frame while the 3D view shows.
    const padWas: boolean[] = []
    let first = true
    let raf = 0
    let lastT = performance.now()
    const loop = (t: number) => {
      const dt = Math.min(0.05, (t - lastT) / 1000)
      lastT = t
      let px = 0
      let py = 0
      if (held.has('KeyA') || held.has('ArrowLeft')) px += 1
      if (held.has('KeyD') || held.has('ArrowRight')) px -= 1
      if (held.has('KeyW') || held.has('ArrowUp')) py += 1
      if (held.has('KeyS') || held.has('ArrowDown')) py -= 1
      if (px || py) slideLook(px * SLIDE_PX_PER_S * dt, py * SLIDE_PX_PER_S * dt)
      if (held.has('KeyQ')) turnLook(STICK_TURN_RAD_PER_S * 0.6 * dt, 0)
      if (held.has('KeyE')) turnLook(-STICK_TURN_RAD_PER_S * 0.6 * dt, 0)
      pollPad(dt)
      raf = requestAnimationFrame(loop)
    }
    const pollPad = (dt: number) => {
      const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : []
      let pad: Gamepad | null = null
      for (const p of pads) if (p && p.connected) pad = pad ?? p
      if (!pad) return
      const pressed = (i: number) => !!pad!.buttons[i]?.pressed
      // Whatever was already held when 3D opened (the press that opened it) doesn't count as a new press.
      if (first) {
        first = false
        for (let i = 0; i < pad.buttons.length; i++) padWas[i] = pressed(i)
      }
      if (inputState.context === 'menu') {
        for (let i = 0; i < pad.buttons.length; i++) padWas[i] = pressed(i)
        return
      }
      const dead = (v: number) => (Math.abs(v) < 0.18 ? 0 : (v - Math.sign(v) * 0.18) / 0.82)
      const lx = dead(pad.axes[0] ?? 0)
      const ly = dead(pad.axes[1] ?? 0)
      const rx = dead(pad.axes[2] ?? 0)
      const ry = dead(pad.axes[3] ?? 0)
      const lt = pad.buttons[6]?.value ?? 0
      const rt = pad.buttons[7]?.value ?? 0
      if (lx || ly) slideLook(-lx * STICK_SLIDE_PX_PER_S * dt, -ly * STICK_SLIDE_PX_PER_S * dt)
      if (rx || ry) turnLook(-rx * STICK_TURN_RAD_PER_S * dt, ry * STICK_TURN_RAD_PER_S * 0.6 * dt)
      if (lt > 0.05 || rt > 0.05) zoomLook(Math.exp((lt - rt) * 1.6 * dt))
      // B: back to the map.
      if (pressed(1) && !padWas[1]) closeLook3d()
      for (let i = 0; i < pad.buttons.length; i++) padWas[i] = pressed(i)
    }
    raf = requestAnimationFrame(loop)
    setCursor()

    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('contextmenu', onContext)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      cancelAnimationFrame(raf)
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('contextmenu', onContext)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  return (
    <div ref={surface} className="sre-look-surface" data-testid="editor-3d-surface">
      <canvas ref={marks} className="sre-look-marks" aria-hidden />
    </div>
  )
}

// ---------------------------------------------------------------- dev handle

/**
 * __dev.look3d(...) for checkers:
 *   'state'              where the 3D camera is, and the map's view now and when 3D opened
 *   'open' / 'close'     the same as pressing 3D / Map
 *   'turn' [yawDeg, pitchDeg]   'slide' [dxPx, dyPx]   'zoom' factor
 *   'goto' [x, z, yawDeg, pitchDeg, dist]   put the camera somewhere exactly (after it has glided there)
 *   'marks'              how many pins and rings are drawn, and whether a stretch band shows
 */
function look3dCommand(cmd: string, arg?: unknown): unknown {
  const nums = Array.isArray(arg) ? arg.map(Number) : []
  const rad = (d: number) => (d * Math.PI) / 180
  switch (cmd) {
    case 'help':
      return "state | open | close | turn [yawDeg, pitchDeg] | slide [dxPx, dyPx] | zoom factor | goto [x, z, yawDeg, pitchDeg, dist] | marks"
    case 'open':
      openLook3d()
      return useLook3d.getState().mode
    case 'close':
      closeLook3d()
      return useLook3d.getState().mode
    case 'turn':
      turnLook(rad(nums[0] ?? 0), rad(nums[1] ?? 0))
      return lookSummary()
    case 'slide':
      slideLook(nums[0] ?? 0, nums[1] ?? 0)
      return lookSummary()
    case 'zoom':
      zoomLook(Number(arg))
      return lookSummary()
    case 'goto': {
      const [x, z, yaw, pitch, dist] = nums
      if (Number.isFinite(x)) look.goal.x = x
      if (Number.isFinite(z)) look.goal.z = z
      if (Number.isFinite(yaw)) look.goal.yaw = rad(yaw)
      if (Number.isFinite(pitch)) look.goal.pitch = rad(pitch)
      if (Number.isFinite(dist)) look.goal.dist = dist
      turnLook(0, 0)
      zoomLook(1)
      slideLook(0, 0)
      return lookSummary()
    }
    case 'marks':
      return marksSummary()
    case 'state':
      return lookSummary()
    default:
      return `unknown look3d command "${cmd}" - try __dev.look3d('help')`
  }
}

registerDev('look3d', look3dCommand as (...args: never[]) => unknown, "the editor's 3D view: __dev.look3d('help')")
