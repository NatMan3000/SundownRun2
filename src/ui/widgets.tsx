// ============================================================
//  WIDGETS - the building blocks every menu is made of
// ------------------------------------------------------------
//  MenuButton   a big pickable line (Play, Resume, Quit ...)
//  SliderRow    a number: left/right to change (hold to go faster),
//               drag with the mouse, A / Enter resets to default
//  ToggleRow    on / off
//  ChoiceRow    one of a few (Chase / Close / Bonnet)
//  ColourRow    a row of swatches plus a custom hue strip
//  HelpLine     describes whatever is focused
//
//  Every widget is a nav item (see nav.tsx), so a controller, a
//  keyboard and a mouse all work on it the same way.
// ============================================================

import { useRef } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { audio } from '../core/api'
import { useNavItem, holdMultiplier, focusedHandlers } from './nav'
import { useUi } from './uiStore'
import { colourForHue, hexToHsl } from './colour'
import type { ColourTone } from './colour'

// ---------------------------------------------------------------- helpers

function decimalsOf(step: number): number {
  const s = String(step)
  const i = s.indexOf('.')
  return i < 0 ? 0 : s.length - i - 1
}

/** Snap to the slider's step and range, without float noise (0.30000000004). */
export function snap(v: number, min: number, max: number, step: number): number {
  const n = Math.round((v - min) / step) * step + min
  const c = Math.min(max, Math.max(min, n))
  return Number(c.toFixed(decimalsOf(step)))
}

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

/** Little circular arrow: "this row is changed, A resets it". Drawn, not a font glyph. */
function ResetIcon() {
  return (
    <svg className="reset-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.2 8a4.8 4.8 0 1 0 1.5-3.5" />
      <path d="M2.6 2.4v3.1h3.1" />
    </svg>
  )
}

// ---------------------------------------------------------------- MenuButton

export function MenuButton(props: {
  id: string
  label: string
  sub?: string
  onAccept: () => void
  disabled?: boolean
  help?: string
  className?: string
  acceptSound?: 'select' | 'start' | 'back' | null
  /** What A / Enter does here, for the hint bar (default "Select"). */
  acceptHint?: string
  children?: ReactNode
}) {
  const nav = useNavItem<HTMLButtonElement>(props.id, {
    onAccept: props.onAccept,
    disabled: props.disabled,
    help: props.help,
    acceptSound: props.acceptSound,
    acceptHint: props.acceptHint ?? 'Select',
  })
  return (
    <button
      type="button"
      tabIndex={-1}
      ref={nav.ref}
      {...nav.props}
      className={cx('menu-btn', nav.focused && 'is-focused', props.disabled && 'is-disabled', props.className)}
      aria-disabled={props.disabled || undefined}
    >
      <span className="menu-btn__label">{props.label}</span>
      {props.sub && <span className="menu-btn__sub">{props.sub}</span>}
      {props.children}
    </button>
  )
}

// ---------------------------------------------------------------- SliderRow

export interface SliderRowProps {
  id: string
  label: string
  value: number
  min: number
  max: number
  step: number
  format: (v: number) => string
  onChange: (v: number) => void
  /** Default value: A / Enter or the reset icon puts it back. Omit for no reset. */
  defaultValue?: number
  help?: string
  disabled?: boolean
  /** Extra class for the fill (the hue strip uses a rainbow track). */
  variant?: 'hue'
  /** Called when a drag ends (sliders that rebuild something heavy commit here). */
  onCommit?: (v: number) => void
}

export function SliderRow(p: SliderRowProps) {
  const trackRef = useRef<HTMLDivElement | null>(null)
  const dragging = useRef(false)
  const changed = p.defaultValue !== undefined && Math.abs(p.value - p.defaultValue) > p.step * 0.25

  const stepBy = (dir: -1 | 1, streak: number) => {
    const next = snap(p.value + dir * p.step * holdMultiplier(streak), p.min, p.max, p.step)
    if (next !== p.value) {
      audio.ui('slide')
      p.onChange(next)
      p.onCommit?.(next)
    }
    return true
  }

  const reset = () => {
    if (p.defaultValue === undefined || !changed) return
    audio.ui('toggle')
    p.onChange(p.defaultValue)
    p.onCommit?.(p.defaultValue)
  }

  const nav = useNavItem<HTMLDivElement>(p.id, {
    onLeft: (s) => stepBy(-1, s),
    onRight: (s) => stepBy(1, s),
    onAccept: reset,
    acceptSound: null,
    acceptHint: p.defaultValue !== undefined && changed ? 'Reset to default' : undefined,
    sideHint: 'Adjust',
    onClick: () => {},
    help: p.help,
    disabled: p.disabled,
  })

  const valueAt = (clientX: number) => {
    const el = trackRef.current
    if (!el) return p.value
    const r = el.getBoundingClientRect()
    const t = Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width)))
    return snap(p.min + t * (p.max - p.min), p.min, p.max, p.step)
  }

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (p.disabled || e.button !== 0) return
    dragging.current = true
    e.currentTarget.setPointerCapture(e.pointerId)
    audio.unlock()
    const v = valueAt(e.clientX)
    if (v !== p.value) {
      audio.ui('slide')
      p.onChange(v)
    }
  }
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return
    const v = valueAt(e.clientX)
    if (v !== p.value) p.onChange(v)
  }
  const onUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return
    dragging.current = false
    e.currentTarget.releasePointerCapture(e.pointerId)
    p.onCommit?.(valueAt(e.clientX))
  }

  const t = p.max > p.min ? (p.value - p.min) / (p.max - p.min) : 0
  return (
    <div ref={nav.ref} {...nav.props} className={cx('row row--slider', nav.focused && 'is-focused', p.disabled && 'is-disabled', changed && 'is-changed')}>
      <span className="row__label">
        {p.label}
        <i className="row__dot" aria-hidden="true" />
      </span>
      <div
        className={cx('slider', p.variant === 'hue' && 'slider--hue')}
        ref={trackRef}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        <div className="slider__rail">
          <div className="slider__fill" style={{ transform: `scaleX(${t})` }} />
        </div>
        <div className="slider__thumb" style={{ left: `${t * 100}%` }} />
      </div>
      <span className="row__value">{p.format(p.value)}</span>
      <button
        type="button"
        tabIndex={-1}
        className={cx('row__reset', changed && 'is-on')}
        aria-label={`Reset ${p.label}`}
        onClick={reset}
      >
        <ResetIcon />
      </button>
    </div>
  )
}

// ---------------------------------------------------------------- ToggleRow

export function ToggleRow(p: {
  id: string
  label: string
  value: boolean
  onChange: (v: boolean) => void
  defaultValue?: boolean
  help?: string
  onLabel?: string
  offLabel?: string
}) {
  const flip = (to?: boolean) => {
    const next = to ?? !p.value
    if (next === p.value) return true
    audio.ui('toggle')
    p.onChange(next)
    return true
  }
  const changed = p.defaultValue !== undefined && p.value !== p.defaultValue
  const nav = useNavItem<HTMLDivElement>(p.id, {
    onAccept: () => flip(),
    acceptSound: null,
    onLeft: () => flip(false),
    onRight: () => flip(true),
    acceptHint: p.value ? 'Turn off' : 'Turn on',
    help: p.help,
  })
  return (
    <div ref={nav.ref} {...nav.props} className={cx('row row--toggle', nav.focused && 'is-focused', changed && 'is-changed')}>
      <span className="row__label">
        {p.label}
        <i className="row__dot" aria-hidden="true" />
      </span>
      <span className="toggle-wrap">
        <span className={cx('toggle', p.value && 'is-on')} aria-hidden="true">
          <span className="toggle__knob" />
        </span>
        <span className="row__value">{p.value ? p.onLabel ?? 'On' : p.offLabel ?? 'Off'}</span>
      </span>
      <span />
      <span className="row__reset" aria-hidden="true" />
    </div>
  )
}

// ---------------------------------------------------------------- ChoiceRow

export function ChoiceRow<V extends string>(p: {
  id: string
  label: string
  value: V
  options: readonly { value: V; label: string }[]
  onChange: (v: V) => void
  defaultValue?: V
  help?: string
}) {
  const idx = Math.max(0, p.options.findIndex((o) => o.value === p.value))
  const step = (dir: -1 | 1, wrap: boolean) => {
    const n = p.options.length
    if (n < 2) return true
    let next = idx + dir
    if (wrap) next = (next + n) % n
    else if (next < 0 || next >= n) return true
    audio.ui('toggle')
    p.onChange(p.options[next].value)
    return true
  }
  const changed = p.defaultValue !== undefined && p.value !== p.defaultValue
  const nav = useNavItem<HTMLDivElement>(p.id, {
    onLeft: () => step(-1, false),
    onRight: () => step(1, false),
    onAccept: () => step(1, true),
    acceptSound: null,
    acceptHint: 'Next',
    sideHint: 'Choose',
    onClick: () => {},
    help: p.help,
  })
  return (
    <div ref={nav.ref} {...nav.props} className={cx('row row--choice', nav.focused && 'is-focused', changed && 'is-changed')}>
      <span className="row__label">
        {p.label}
        <i className="row__dot" aria-hidden="true" />
      </span>
      <span className="choice" role="radiogroup" aria-label={p.label}>
        {p.options.map((o) => (
          <span
            key={o.value}
            role="radio"
            aria-checked={o.value === p.value}
            className={cx('choice__opt', o.value === p.value && 'is-on')}
            onClick={() => {
              if (o.value !== p.value) {
                audio.ui('toggle')
                p.onChange(o.value)
              }
            }}
          >
            {o.label}
          </span>
        ))}
      </span>
      <span className="row__reset" aria-hidden="true" />
    </div>
  )
}

// ---------------------------------------------------------------- ColourRow

export function ColourRow(p: {
  id: string
  label: string
  value: string
  swatches: readonly string[]
  tone: ColourTone
  onChange: (hex: string) => void
  defaultValue?: string
  help?: string
}) {
  const lower = p.value.toLowerCase()
  const idx = p.swatches.findIndex((s) => s.toLowerCase() === lower)
  const changed = p.defaultValue !== undefined && lower !== p.defaultValue.toLowerCase()

  const pick = (hex: string) => {
    if (hex.toLowerCase() === lower) return
    audio.ui('toggle')
    p.onChange(hex)
  }

  const swatchNav = useNavItem<HTMLDivElement>(`${p.id}:swatches`, {
    onLeft: () => {
      const n = idx < 0 ? 0 : Math.max(0, idx - 1)
      pick(p.swatches[n])
      return true
    },
    onRight: () => {
      const n = idx < 0 ? 0 : Math.min(p.swatches.length - 1, idx + 1)
      pick(p.swatches[n])
      return true
    },
    onAccept: () => {
      if (p.defaultValue && changed) pick(p.defaultValue)
    },
    acceptSound: null,
    acceptHint: changed ? 'Reset to default' : undefined,
    sideHint: 'Pick colour',
    onClick: () => {},
    help: p.help,
  })

  const hsl = hexToHsl(p.value)
  const hue = Math.round(hsl.h / 5) * 5

  return (
    <div className={cx('colour', changed && 'is-changed')}>
      <div ref={swatchNav.ref} {...swatchNav.props} className={cx('row row--swatches', swatchNav.focused && 'is-focused', changed && 'is-changed')}>
        <span className="row__label">
          {p.label}
          <i className="row__dot" aria-hidden="true" />
        </span>
        <span className="swatches">
          {p.swatches.map((s) => (
            <span
              key={s}
              className={cx('swatch', s.toLowerCase() === lower && 'is-on')}
              style={{ ['--sw' as string]: s }}
              onClick={() => pick(s)}
              role="radio"
              aria-checked={s.toLowerCase() === lower}
              aria-label={s}
            />
          ))}
          <span className={cx('swatch swatch--custom', idx < 0 && 'is-on')} style={{ ['--sw' as string]: p.value }} aria-label="custom colour" />
        </span>
        <span className="row__value row__value--mono">{p.value.toUpperCase()}</span>
        <button
          type="button"
          tabIndex={-1}
          className={cx('row__reset', changed && 'is-on')}
          aria-label={`Reset ${p.label}`}
          onClick={() => {
            if (p.defaultValue) pick(p.defaultValue)
          }}
        >
          <ResetIcon />
        </button>
      </div>
      <SliderRow
        id={`${p.id}:hue`}
        label={`${p.label} hue`}
        value={hue}
        min={0}
        max={355}
        step={5}
        format={(v) => `${Math.round(v)}°`}
        onChange={(h) => p.onChange(colourForHue(h, p.value, p.tone))}
        help={`Any colour you like for the ${p.label.toLowerCase()}: slide through the rainbow.`}
        variant="hue"
      />
    </div>
  )
}

// ---------------------------------------------------------------- HelpLine

/** One line describing whatever is focused (reads the focused item's `help`). */
export function HelpLine(props: { fallback?: string }) {
  useUi((s) => s.focus)
  useUi((s) => s.stack)
  useUi((s) => s.hintNonce)
  const text = focusedHandlers()?.help ?? props.fallback ?? ''
  return (
    <div className="helpline" aria-live="polite">
      {text}
    </div>
  )
}
