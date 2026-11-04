// ============================================================
//  TOUCH CONTROLS - driving a phone with two thumbs
// ------------------------------------------------------------
//  Shows while driving when touch is the device in use (a finger
//  was the last thing to touch the game; see src/core/input.ts).
//  A key press or a pad takes over and it steps aside.
//
//    Left thumb    a stick that appears wherever the thumb lands.
//                  Only its sideways slide steers on the ground;
//                  in the air, up and down pitch the car.
//    Right thumb   Gas, Brake and Drift. A touch anywhere on the
//                  right goes to the NEAREST of the three, so you
//                  never have to look, and a thumb can slide from
//                  one to the next. Sliding from Gas (or Brake)
//                  onto Drift keeps that pedal on: one thumb can
//                  power through a drift.
//    Left edge     Menu and Reset, up high where a thumb on the stick
//                  can't land on them by accident.
//    By the map    Camera, and Race in multiplayer.
//    Above Gas     Rewind (held; it shows how much is stored), or in
//                  Hunt Turns while you hunt, Pulse (it shows when it's
//                  ready). Lifting off Gas to press either is what you
//                  want anyway. Next song is in the pause menu: nobody
//                  should reach across the road for it at 200 km/h.
//
//  Fingers only write the touchInput singleton and the edge-trigger
//  nonces in controlSignals; input.ts smooths them like any device.
//  Moves write straight to the DOM (no React state), and nothing
//  here runs per frame: Rewind's meter and Pulse's countdown tick a
//  few times a second on a timer, and only touch the DOM on a change.
// ============================================================

import { useEffect, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode, RefObject } from 'react'
import { CONFIG } from '../core/config'
import { controlSignals, touchInput } from '../core/controls'
import { getGame, useGame } from '../core/store'
import { rewind } from '../core/telemetry'
import { audio } from '../core/api'

type Pedal = 'gas' | 'brake' | 'drift'
const PEDALS: Pedal[] = ['gas', 'brake', 'drift']

interface Finger {
  pedal: Pedal
  /** The pedal this thumb slid onto Drift from: it stays on until the thumb leaves Drift or lifts. */
  carried: 'gas' | 'brake' | null
}

/** A thumb only changes button once it's this much closer (px) to the new one, so a seam can't flicker. */
const PEDAL_STICKINESS = 10

function releaseTouchInput(): void {
  touchInput.steer = 0
  touchInput.stickY = 0
  touchInput.gas = false
  touchInput.brake = false
  touchInput.handbrake = false
  touchInput.rewind = false
}

/** How often Rewind's meter and Pulse's countdown look at their numbers. */
const SLOW_TICK_MS = 150

/** One small button. Fires on the finger going down: a game can't wait for the lift. */
function TopButton(props: { label: string; onPress: () => void; onRelease?: () => void; children: ReactNode; extra?: string; root?: RefObject<HTMLButtonElement | null>; meter?: boolean }) {
  const { label, onPress, onRelease, children, extra, root, meter } = props
  const down = (e: ReactPointerEvent<HTMLButtonElement>) => {
    e.currentTarget.classList.add('is-down')
    e.currentTarget.setPointerCapture?.(e.pointerId)
    onPress()
  }
  const up = (e: ReactPointerEvent<HTMLButtonElement>) => {
    e.currentTarget.classList.remove('is-down')
    onRelease?.()
  }
  return (
    <button ref={root} type="button" tabIndex={-1} data-touch-button="" className={`touch-top${extra ? ` ${extra}` : ''}`} aria-label={label} onPointerDown={down} onPointerUp={up} onPointerCancel={up}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        {children}
      </svg>
      <span>{label}</span>
      {meter && <i className="touch-top__meter" aria-hidden="true" />}
    </button>
  )
}

/** Rewind, with how much is stored as a bar along its foot. Goes dim when there's nothing to go back to. */
function RewindButton() {
  const root = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    let shown = -1
    const write = () => {
      const f = rewind.capacity > 0 ? Math.round(Math.min(1, Math.max(0, rewind.stored / rewind.capacity)) * 100) : 0
      if (f === shown || !root.current) return
      shown = f
      root.current.style.setProperty('--fill', (f / 100).toFixed(2))
      root.current.classList.toggle('is-empty', f === 0)
    }
    write()
    const t = setInterval(write, SLOW_TICK_MS)
    return () => clearInterval(t)
  }, [])
  return (
    <TopButton label="Rewind" extra="touch-rewind is-empty" root={root} meter onPress={() => (touchInput.rewind = true)} onRelease={() => (touchInput.rewind = false)}>
      <path d="M11.5 6l-8 6 8 6zM20.5 6l-8 6 8 6z" />
    </TopButton>
  )
}

/** The hunter's tag pulse: lit when it can fire, the seconds until it can when it can't. */
function PulseButton() {
  const root = useRef<HTMLButtonElement | null>(null)
  const word = useRef<HTMLSpanElement | null>(null)
  useEffect(() => {
    let shown = ''
    const write = () => {
      const t = getGame().turns
      if (!t || !root.current || !word.current) return
      const wait = Math.max(t.pulseReadyAt, t.noCatchUntil, t.goAt) - performance.now()
      const txt = wait <= 0 ? 'Pulse' : `${(wait / 1000).toFixed(1)} s`
      if (txt === shown) return
      shown = txt
      word.current.textContent = txt
      root.current.classList.toggle('is-ready', wait <= 0)
    }
    write()
    const t = setInterval(write, SLOW_TICK_MS)
    return () => clearInterval(t)
  }, [])
  const press = (e: ReactPointerEvent<HTMLButtonElement>) => {
    e.currentTarget.classList.add('is-down')
    e.currentTarget.setPointerCapture?.(e.pointerId)
    controlSignals.pulse++
  }
  const lift = (e: ReactPointerEvent<HTMLButtonElement>) => e.currentTarget.classList.remove('is-down')
  return (
    <button ref={root} type="button" tabIndex={-1} data-touch-button="" className="touch-pulse" aria-label="Pulse" onPointerDown={press} onPointerUp={lift} onPointerCancel={lift}>
      <span ref={word}>Pulse</span>
    </button>
  )
}

function TouchLayer() {
  const mp = useGame((s) => s.multiplayer)
  const hunting = useGame((s) => s.mode === 'turns' && s.turns?.hunterId === 'player' && !s.turns.done)
  const layer = useRef<HTMLDivElement | null>(null)
  const base = useRef<HTMLDivElement | null>(null)
  const knob = useRef<HTMLDivElement | null>(null)
  const gas = useRef<HTMLDivElement | null>(null)
  const brake = useRef<HTMLDivElement | null>(null)
  const drift = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = layer.current
    const stickBase = base.current
    const stickKnob = knob.current
    const pedalEls: Record<Pedal, HTMLDivElement | null> = { gas: gas.current, brake: brake.current, drift: drift.current }
    if (!el || !stickBase || !stickKnob) return

    const range = Math.max(10, CONFIG.touchStickPixels)
    const fingers = new Map<number, Finger>()
    let stickId: number | null = null
    let originX = 0
    let originY = 0
    let restX = 0
    let restY = 0

    const centre = (p: Pedal) => {
      const r = pedalEls[p]?.getBoundingClientRect()
      return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: 0, y: 0 }
    }
    const distanceTo = (p: Pedal, x: number, y: number) => {
      const c = centre(p)
      return Math.hypot(x - c.x, y - c.y)
    }
    const nearest = (x: number, y: number): Pedal => {
      let best: Pedal = 'gas'
      let bestD = Infinity
      for (const p of PEDALS) {
        const d = distanceTo(p, x, y)
        if (d < bestD) {
          bestD = d
          best = p
        }
      }
      return best
    }

    /** Which side of the screen a new finger belongs to: halfway between the stick's rest spot and Brake. */
    const onPedalSide = (x: number) => {
      const stickRight = stickBase.offsetLeft + stickBase.offsetWidth // its rest spot: offsets ignore the transform
      const brakeLeft = pedalEls.brake?.getBoundingClientRect().left ?? window.innerWidth / 2
      return x >= (stickRight + brakeLeft) / 2
    }

    const writePedals = () => {
      let g = false
      let b = false
      let d = false
      for (const f of fingers.values()) {
        g ||= f.pedal === 'gas' || f.carried === 'gas'
        b ||= f.pedal === 'brake' || f.carried === 'brake'
        d ||= f.pedal === 'drift'
      }
      touchInput.gas = g
      touchInput.brake = b
      touchInput.handbrake = d
      pedalEls.gas?.classList.toggle('is-down', g)
      pedalEls.brake?.classList.toggle('is-down', b)
      pedalEls.drift?.classList.toggle('is-down', d)
    }

    const writeStick = (x: number, y: number) => {
      // Past the end of its travel the stick's middle follows the thumb, so turning back
      // starts counter-steering at once instead of crossing a dead stretch of glass.
      if (x - originX > range) originX = x - range
      else if (originX - x > range) originX = x + range
      if (y - originY > range) originY = y - range
      else if (originY - y > range) originY = y + range
      const dx = x - originX
      const dy = y - originY
      touchInput.steer = dx / range
      touchInput.stickY = -dy / range
      stickBase.style.transform = `translate3d(${originX - restX}px, ${originY - restY}px, 0)`
      stickKnob.style.transform = `translate3d(${dx}px, ${dy}px, 0)`
    }

    const releaseStick = () => {
      stickId = null
      touchInput.steer = 0
      touchInput.stickY = 0
      stickBase.classList.remove('is-held')
      stickBase.style.transform = ''
      stickKnob.style.transform = ''
    }

    const isButton = (t: EventTarget | null) => t instanceof Element && !!t.closest('[data-touch-button]')

    const onDown = (e: PointerEvent) => {
      if (isButton(e.target)) return
      el.setPointerCapture?.(e.pointerId)
      if (onPedalSide(e.clientX)) {
        fingers.set(e.pointerId, { pedal: nearest(e.clientX, e.clientY), carried: null })
        writePedals()
      } else if (stickId === null) {
        stickId = e.pointerId
        restX = stickBase.offsetLeft + stickBase.offsetWidth / 2
        restY = stickBase.offsetTop + stickBase.offsetHeight / 2
        originX = e.clientX
        originY = e.clientY
        stickBase.classList.add('is-held')
        writeStick(e.clientX, e.clientY)
      }
    }

    const onMove = (e: PointerEvent) => {
      if (e.pointerId === stickId) {
        writeStick(e.clientX, e.clientY)
        return
      }
      const f = fingers.get(e.pointerId)
      if (!f) return
      const next = nearest(e.clientX, e.clientY)
      if (next === f.pedal || distanceTo(next, e.clientX, e.clientY) > distanceTo(f.pedal, e.clientX, e.clientY) - PEDAL_STICKINESS) return
      f.carried = next === 'drift' && f.pedal !== 'drift' ? f.pedal : null
      f.pedal = next
      writePedals()
    }

    const onUp = (e: PointerEvent) => {
      if (e.pointerId === stickId) releaseStick()
      if (fingers.delete(e.pointerId)) writePedals()
    }

    const releaseAll = () => {
      fingers.clear()
      writePedals()
      releaseStick()
    }

    // A missed lift must never leave the gas stuck on, so every way a finger can be lost lets go.
    const onTouchEnd = (e: TouchEvent) => {
      audio.unlock() // the lift is the gesture Safari wants before it lets sound start
      if (e.touches.length === 0) releaseAll()
    }
    // Stops Safari's magnifier, callout and double-tap zoom. Buttons fire on pointer down, so nothing here needs a click.
    const noBrowserGesture = (e: TouchEvent) => {
      if (e.cancelable) e.preventDefault()
    }
    const onHidden = () => {
      if (document.hidden) releaseAll()
    }

    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
    el.addEventListener('touchstart', noBrowserGesture, { passive: false })
    el.addEventListener('touchmove', noBrowserGesture, { passive: false })
    window.addEventListener('touchend', onTouchEnd)
    window.addEventListener('touchcancel', onTouchEnd)
    window.addEventListener('blur', releaseAll)
    document.addEventListener('visibilitychange', onHidden)
    return () => {
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
      el.removeEventListener('touchstart', noBrowserGesture)
      el.removeEventListener('touchmove', noBrowserGesture)
      window.removeEventListener('touchend', onTouchEnd)
      window.removeEventListener('touchcancel', onTouchEnd)
      window.removeEventListener('blur', releaseAll)
      document.removeEventListener('visibilitychange', onHidden)
      releaseTouchInput()
    }
  }, [])

  return (
    <div ref={layer} className="touch" data-testid="touch-controls">
      <div className="touch-row">
        <TopButton label="Menu" onPress={() => controlSignals.pause++}>
          <path d="M8 5v14M16 5v14" />
        </TopButton>
        <TopButton label="Reset" onPress={() => controlSignals.reset++}>
          <path d="M5 12a7 7 0 1 0 2.2-5.1M5 5v4.5h4.5" />
        </TopButton>
      </div>
      <div className="touch-row touch-row--view">
        {mp && (
          <TopButton label="Race" extra="touch-top--hot" onPress={() => controlSignals.race++}>
            <path d="M6 21V4M6 4.5c4-2 7 2 12 0v9c-5 2-8-2-12 0" />
          </TopButton>
        )}
        <TopButton label="Camera" onPress={() => controlSignals.cameraCycle++}>
          <path d="M3.5 8.5h4l1.5-2.5h6l1.5 2.5h4v10h-17zM12 11a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2z" />
        </TopButton>
      </div>
      {!mp && <RewindButton />}
      {mp && hunting && <PulseButton />}

      <div ref={base} className="touch-stick" aria-hidden="true">
        <i className="touch-stick__arrow touch-stick__arrow--l" />
        <i className="touch-stick__arrow touch-stick__arrow--r" />
        <div ref={knob} className="touch-stick__knob" />
      </div>

      <div ref={drift} className="touch-pedal touch-pedal--drift">
        Drift
      </div>
      <div ref={brake} className="touch-pedal touch-pedal--brake">
        Brake
      </div>
      <div ref={gas} className="touch-pedal touch-pedal--gas">
        Gas
      </div>
    </div>
  )
}

/** Mounted only while driving on touch: leaving unmounts it, and that lets go of everything held. */
export function TouchControls() {
  const touch = useGame((s) => s.inputDevice) === 'touch'
  const playing = useGame((s) => s.phase) === 'playing'
  const mapOpen = useGame((s) => s.mapOpen)
  if (!touch || !playing || mapOpen) return null
  return <TouchLayer />
}
