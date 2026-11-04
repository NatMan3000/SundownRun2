// ============================================================
//  GARAGE - pick a car body and paint it
// ------------------------------------------------------------
//  The real car is sitting on the grid beside this panel, and while
//  the Garage is open (store.garageOpen) the camera circles it as the
//  hero, lingering on its front three-quarter view, so every change
//  shows up on the actual car straight away. There is no separate model viewer:
//  body, paint, underglow and trail are just settings (carBody,
//  paint, glow, trail) that the vehicle and look systems read live.
//
//  The car list comes from the vehicle system (vehicle.bodies()).
//
//  On a phone a sideways swipe changes the car too, on the picker or
//  over the car itself.
// ============================================================

import { useEffect, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { getDefaults, useSettings } from '../../core/settings'
import { useGame } from '../../core/store'
import { audio, vehicle } from '../../core/api'
import type { CarBodyInfo } from '../../core/api'
import { NavScreen, useNavItem } from '../nav'
import { ColourRow, HelpLine } from '../widgets'
import { HintBar } from '../hints'
import { closeScreen } from '../uiStore'
import { COLOUR_ROWS } from '../settingsSchema'

function StatBar(props: { label: string; value: number }) {
  const v = Math.min(1, Math.max(0, props.value))
  return (
    <div className="stat">
      <span className="stat__label">{props.label}</span>
      <span className="stat__bar">
        <span className="stat__fill" style={{ transform: `scaleX(${v})` }} />
      </span>
    </div>
  )
}

/** Step to the next or previous car, round and round. */
function cycleCar(bodies: readonly CarBodyInfo[], dir: -1 | 1): true {
  if (bodies.length < 2) return true
  const idx = Math.max(0, bodies.findIndex((b) => b.id === useSettings.getState().carBody))
  audio.ui('toggle')
  useSettings.getState().set('carBody', bodies[(idx + dir + bodies.length) % bodies.length].id)
  return true
}

/** How far a thumb must travel sideways, in pixels, to change the car. */
const SWIPE_PX = 36

/**
 * A sideways swipe on a finger changes the car: to the left brings the next one in.
 * Mostly-vertical moves belong to the panel's scroll. The colours themselves don't
 * take swipes, so dragging along a row of swatches can't change the car by accident.
 */
function useCarSwipe(bodies: readonly CarBodyInfo[]) {
  const from = useRef<{ id: number; x: number; y: number } | null>(null)
  return {
    onPointerDown: (e: ReactPointerEvent) => {
      if (e.pointerType !== 'touch' || !e.isPrimary || (e.target as Element).closest('.garage-colours, .hintbar')) return
      from.current = { id: e.pointerId, x: e.clientX, y: e.clientY }
    },
    onPointerUp: (e: ReactPointerEvent) => {
      const f = from.current
      if (!f || f.id !== e.pointerId) return
      from.current = null
      const dx = e.clientX - f.x
      if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < Math.abs(e.clientY - f.y) * 1.5) return
      audio.unlock()
      cycleCar(bodies, dx < 0 ? 1 : -1)
    },
    onPointerCancel: () => {
      from.current = null
    },
  }
}

function Chevron(props: { dir: 'left' | 'right'; onPress: () => void }) {
  return (
    <span
      className={`chev chev--${props.dir}`}
      role="button"
      aria-label={props.dir === 'left' ? 'Previous car' : 'Next car'}
      onClick={props.onPress}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d={props.dir === 'left' ? 'M10 3 5 8l5 5' : 'M6 3l5 5-5 5'} />
      </svg>
    </span>
  )
}

function CarPicker(props: { bodies: readonly CarBodyInfo[] }) {
  const current = useSettings((s) => s.carBody)
  const { bodies } = props
  const idx = Math.max(0, bodies.findIndex((b) => b.id === current))
  const body = bodies[idx]
  const cycle = (dir: -1 | 1) => cycleCar(bodies, dir)
  const nav = useNavItem<HTMLDivElement>('car', {
    onLeft: () => cycle(-1),
    onRight: () => cycle(1),
    onAccept: () => cycle(1),
    acceptSound: null,
    sideHint: 'Change car',
    acceptHint: 'Next car',
    onClick: () => {},
    help: 'Every car drives differently: speed, grip and weight.',
  })
  return (
    <div ref={nav.ref} {...nav.props} className={`car-pick${nav.focused ? ' is-focused' : ''}`}>
      <Chevron dir="left" onPress={() => cycle(-1)} />
      <div className="car-pick__info" key={body?.id ?? current}>
        <div className="car-pick__name">{body?.name ?? current}</div>
        {body?.blurb && <div className="car-pick__blurb">{body.blurb}</div>}
        {body && (
          <div className="car-pick__stats">
            <StatBar label="Speed" value={body.stats.speed} />
            <StatBar label="Grip" value={body.stats.grip} />
            <StatBar label="Weight" value={body.stats.weight} />
          </div>
        )}
        {bodies.length > 1 && (
          <div className="car-pick__dots" aria-hidden="true">
            {bodies.map((b) => (
              <i key={b.id} className={b.id === current ? 'is-on' : ''} />
            ))}
          </div>
        )}
      </div>
      <Chevron dir="right" onPress={() => cycle(1)} />
    </div>
  )
}

export function GarageScreen() {
  // While this screen is up the camera frames the car as the hero; leaving it by any route clears the flag.
  useEffect(() => {
    useGame.setState({ garageOpen: true })
    return () => useGame.setState({ garageOpen: false })
  }, [])
  const bodies = vehicle.bodies()
  const touch = useGame((s) => s.inputDevice) === 'touch'
  const swipe = useCarSwipe(bodies)
  // One selector per value: a selector that builds a new object every time
  // would make zustand re-render forever.
  const paint = useSettings((s) => s.paint)
  const glow = useSettings((s) => s.glow)
  const trail = useSettings((s) => s.trail)
  const values = { paint, glow, trail }
  const set = useSettings((s) => s.set)
  const defaults = getDefaults()
  return (
    <NavScreen id="garage" onBack={closeScreen} initial="car">
      <div className="screen screen--garage" {...(touch ? swipe : undefined)}>
        <div className="scrim scrim--left" aria-hidden="true" />
        <section className="panel garage-panel" aria-label="Garage">
          <div className="screen-head">
            <h2 className="screen-title">Garage</h2>
            <span className="eyebrow">Changes show on your car straight away</span>
          </div>
          <CarPicker bodies={bodies} />
          <div className="garage-colours">
            {COLOUR_ROWS.map((c) => (
              <ColourRow
                key={c.key}
                id={`garage:${c.key}`}
                label={c.label}
                value={values[c.key]}
                swatches={c.swatches}
                tone={c.tone}
                onChange={(v) => set(c.key, v)}
                defaultValue={defaults[c.key]}
                help={c.help}
                compact
              />
            ))}
          </div>
          <HelpLine />
        </section>
        <HintBar
          items={[
            { action: 'move', label: 'Move' },
            { action: 'back', label: 'Done' },
          ]}
        />
      </div>
    </NavScreen>
  )
}
