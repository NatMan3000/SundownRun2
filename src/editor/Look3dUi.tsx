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
//    top of the map, in 3D  one line: what your mouse does here, and
//                           "Back to the map"
//    the whole map, in 3D   a see-through layer holding the problem pins
//                           and the selected spot (look3dMarks.tsx); the
//                           mouse goes straight through it to the map's
//                           own layer (Overlay.tsx), where every tool
//                           works in 3D just as on the map
//
//  The keys that move the 3D view (WASD and the arrows slide, Q and E
//  turn, + and - zoom, Space + drag slides) and the controller are
//  here; the tools' own keys stay in Overlay.tsx and work in 3D too.
//  The T key opens and closes it anywhere on the map. Esc first stops a
//  drag or a half-made line, and only then closes it (EditorUi.tsx).
// ============================================================

import { useEffect, useRef } from 'react'
import { inputState } from '../core/controls'
import { registerDev } from '../core/devHandles'
import { useEditor } from './draft'
import { look, closeLook3d, lookSummary, openLook3d, slideLook, toggleLook3d, turnLook, useLook3d, zoomLook, resetLook3d } from './look3d'
import { setMarksCanvas, marksSummary } from './look3dMarks'
import { frame3dStats, pick3d, pickStats, pose, roadUnder, worldToScreen, worldToScreenY } from './look3dSpace'
import { roadGeometry } from './mapDraw'
import { frameAt } from './road'
import './look3d.css'

/** Held-key and stick speeds in 3D. */
const SLIDE_PX_PER_S = 700
const STICK_SLIDE_PX_PER_S = 900
const STICK_TURN_RAD_PER_S = 2.2

/** The note's words in 3D: what the mouse does here (Josh's words). */
export const LOOK_HINT = 'Right-drag to look round. Middle-drag or Space + drag to move. Wheel to zoom. Every tool works here too.'

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
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('pointerup', up, true)
    window.addEventListener('pointercancel', up, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('pointerup', up, true)
      window.removeEventListener('pointercancel', up, true)
      window.removeEventListener('keydown', onKey)
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
          <span className="sre-look-text">{LOOK_HINT}</span>
          <button type="button" className="sre-btn is-primary" onClick={() => closeLook3d()} data-testid="editor-3d-back">
            Back to the map
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
 * Over the whole map while in 3D: holds the canvas the pins are drawn on, and
 * takes the keys that move the view and the controller. The mouse goes through
 * it to the map's layer (Overlay.tsx), which works in 3D too.
 */
function LookSurface() {
  const surface = useRef<HTMLDivElement>(null)
  const marks = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    setMarksCanvas(marks.current)
    return () => setMarksCanvas(null)
  }, [])

  useEffect(() => {
    const held = new Set<string>()
    const onKeyDown = (e: KeyboardEvent) => {
      if (typing(e) || e.ctrlKey || e.metaKey) return
      // (Space + drag slides the view: the map's layer reads Space itself.)
      if (e.code === 'Space') {
        e.preventDefault()
        return
      }
      if (e.code === 'Equal' || e.code === 'NumpadAdd') zoomLook(1 / 1.25)
      if (e.code === 'Minus' || e.code === 'NumpadSubtract') zoomLook(1.25)
      held.add(e.code)
    }
    const onKeyUp = (e: KeyboardEvent) => {
      held.delete(e.code)
    }
    const onBlur = () => {
      held.clear()
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

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      cancelAnimationFrame(raf)
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
 *   'picks'              how many road picks the mouse has needed so far (hover work is once a frame at most)
 *   'screen' at          where the editor's road at `at` shows on screen in 3D (to aim the real mouse)
 *   'project' [x, y, z]  where that world spot shows on screen in 3D
 *   'pick' [sx, sy]      what the mouse there would pick in 3D: the built road's sample and the editor's `at`
 */
function look3dCommand(cmd: string, arg?: unknown): unknown {
  const nums = Array.isArray(arg) ? arg.map(Number) : []
  const rad = (d: number) => (d * Math.PI) / 180
  switch (cmd) {
    case 'help':
      return "state | open | close | turn [yawDeg, pitchDeg] | slide [dxPx, dyPx] | zoom factor | goto [x, z, yawDeg, pitchDeg, dist] | marks | picks | screen at | project [x, y, z] | pick [sx, sy]"
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
    case 'picks':
      // How many road picks have been worked out, and how many frames the camera moved (picking stays once a frame at most).
      return {
        picks: pickStats.picks,
        poseVersion: pose.version,
        overlayFrames: frame3dStats.frames,
        overlayAvgMs: Math.round((frame3dStats.ms / Math.max(1, frame3dStats.frames)) * 1000) / 1000,
        overlayMaxMs: Math.round(frame3dStats.maxMs * 1000) / 1000,
      }
    case 'screen': {
      // Where a spot on the editor's road (an `at`) shows on screen in 3D, on its own road (so a runner can aim the real mouse).
      const d = useEditor.getState().draft
      if (!d.points.length) return 'no road'
      const f = frameAt(roadGeometry(d.points, d.width).rc, Number(arg))
      const s = worldToScreen(f.p.x, f.p.z, f.dir)
      return { sx: Math.round(s.sx * 10) / 10, sy: Math.round(s.sy * 10) / 10, x: Math.round(f.p.x * 10) / 10, z: Math.round(f.p.z * 10) / 10 }
    }
    case 'project': {
      // Where world spot [x, y, z] shows on screen in 3D (to aim a drag at a spot on the drag sheet).
      const [x, y, z] = nums
      const s = worldToScreenY(x, y, z)
      return { sx: Math.round(s.sx * 10) / 10, sy: Math.round(s.sy * 10) / 10 }
    }
    case 'pick': {
      // What the mouse at screen spot [sx, sy] would pick in 3D: the built road there, and the editor's road (its `at`).
      const [sx, sy] = nums
      const hit = pick3d(sx, sy)
      const d = useEditor.getState().draft
      const e = d.points.length ? roadUnder(roadGeometry(d.points, d.width).rc, sx, sy) : null
      const r = (v: number) => Math.round(v * 100) / 100
      return hit ? { sample: hit.i, direct: hit.direct, px: r(hit.px), x: r(hit.x), y: r(hit.y), z: r(hit.z), at: e ? r(e.at) : null } : null
    }
    case 'state':
      return lookSummary()
    default:
      return `unknown look3d command "${cmd}" - try __dev.look3d('help')`
  }
}

registerDev('look3d', look3dCommand as (...args: never[]) => unknown, "the editor's 3D view: __dev.look3d('help')")
