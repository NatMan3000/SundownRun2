// ============================================================
//  EDITOR FIELDS - the small form controls the editor panel uses
// ------------------------------------------------------------
//  Text boxes, sliders, drop-downs, colour swatches and a row of
//  choice buttons. Each one changes the draft ONCE when you finish
//  (let go of a slider, press Enter in a text box), so every edit is
//  exactly one Undo step, and the 3D preview rebuilds once.
// ============================================================

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { setInputContext } from '../core/controls'
import { audio } from '../core/api'
import { useGame } from '../core/store'

/** Text input that only changes the draft when you finish typing (Enter or click away). */
export function TextField(p: { label: string; value: string; onCommit: (v: string) => void; placeholder?: string; big?: boolean; multiline?: boolean; max?: number }) {
  const [text, setText] = useState(p.value)
  useEffect(() => setText(p.value), [p.value])
  const done = () => {
    setInputContext('editor')
    if (text !== p.value) p.onCommit(text)
  }
  const common = {
    className: 'sre-input',
    value: text,
    placeholder: p.placeholder,
    maxLength: p.max ?? 40,
    onFocus: () => setInputContext('text'),
    onBlur: done,
  }
  return (
    <label className={`sre-field${p.big ? ' is-big' : ''}`}>
      <span className="sre-label">{p.label}</span>
      {p.multiline ? (
        <textarea
          {...common}
          rows={2}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setText(p.value)
              ;(e.target as HTMLTextAreaElement).blur()
            }
            e.stopPropagation()
          }}
        />
      ) : (
        <input
          {...common}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') {
              setText(p.value)
              ;(e.target as HTMLInputElement).blur()
            }
            e.stopPropagation()
          }}
        />
      )}
    </label>
  )
}

/** Slider that shows its value while dragging and commits one change on release. */
export function SliderField(p: {
  label: string
  value: number
  min: number
  max: number
  step: number
  unit?: string
  format?: (v: number) => string
  onCommit: (v: number) => void
  help?: string
  /** Optional "reset" link beside the value (e.g. back to automatic). */
  reset?: { label: string; onClick: () => void }
  /** Greyed out and still (while its range is being worked out, or a change is being built). */
  disabled?: boolean
}) {
  const [v, setV] = useState(p.value)
  const dragging = useRef(false)
  // On a phone the slider is worked through FingerStrip, and its help shows while the thumb is down: there is no hover.
  const touch = useGame((s) => s.inputDevice === 'touch')
  const [thumbDown, setThumbDown] = useState(false)
  useEffect(() => {
    if (!dragging.current) setV(p.value)
  }, [p.value])
  const commitNow = () => {
    dragging.current = false
    if (v !== p.value) {
      audio.ui('slide')
      p.onCommit(v)
    }
  }
  return (
    <div className="sre-field" title={p.help}>
      <span className="sre-label">
        {p.label}
        <span className="sre-value">
          {p.reset && (
            <button type="button" className="sre-link" onClick={p.reset.onClick} disabled={p.disabled}>
              {p.reset.label}
            </button>
          )}
          {p.format ? p.format(v) : `${v}${p.unit ? ` ${p.unit}` : ''}`}
        </span>
      </span>
      <input
        type="range"
        className="sre-range"
        aria-label={p.label}
        min={p.min}
        max={p.max}
        step={p.step}
        value={v}
        disabled={p.disabled}
        // How full the track is, for the phone's slider (phone/phone.css).
        style={{ '--fill': p.max > p.min ? (v - p.min) / (p.max - p.min) : 0 } as CSSProperties}
        onPointerDown={() => (dragging.current = true)}
        onChange={(e) => {
          const next = Number(e.target.value)
          setV(next)
          // Keyboard (arrow keys) changes land straight away: one undo step per press.
          if (!dragging.current && next !== p.value) p.onCommit(next)
        }}
        onPointerUp={commitNow}
        onBlur={() => dragging.current && commitNow()}
      />
      {touch && <FingerStrip min={p.min} max={p.max} step={p.step} value={v} disabled={p.disabled} onThumb={setThumbDown} onSlide={setV} onDone={(next) => {
        if (next === p.value) return
        audio.ui('slide')
        p.onCommit(next)
      }} />}
      {thumbDown && p.help && <span className="sre-help">{p.help}</span>}
    </div>
  )
}

/** A finger this close to the thumb picks it up where it is, so the thumb doesn't jump to the finger. */
const THUMB_GRAB_PX = 30
/** A finger must go this far sideways before it counts as a drag: under that it is a tap, or the start of a scroll. */
const SLIDE_START_PX = 7
/** The thumb's width on a phone (phone/phone.css): the track's ends sit half of it in from the slider's. */
const THUMB_PX = 44

/**
 * What a finger touches on a phone, laid over the real slider. A browser's own slider jumps to
 * the finger the moment it lands, so a swipe up the card would set it on its way past. Here a
 * finger changes nothing until it goes sideways; up or down the browser takes it for the scroll
 * and cancels this pointer. A tap sets the value where it landed. The same manners as the menus'
 * sliders (src/ui/widgets.tsx).
 */
function FingerStrip(p: { min: number; max: number; step: number; value: number; disabled?: boolean; onThumb: (down: boolean) => void; onSlide: (v: number) => void; onDone: (v: number) => void }) {
  const strip = useRef<HTMLDivElement>(null)
  const finger = useRef<{ id: number; x: number; y: number; grab: number; slid: boolean } | null>(null)
  const span = Math.max(p.max - p.min, 1e-9)
  const valueAt = (clientX: number) => {
    const r = strip.current!.getBoundingClientRect()
    const t = Math.min(1, Math.max(0, (clientX - r.left - THUMB_PX / 2) / Math.max(1, r.width - THUMB_PX)))
    const snapped = p.min + Math.round((t * span) / p.step) * p.step
    return Math.min(p.max, Math.max(p.min, Math.round(snapped * 1e6) / 1e6))
  }
  const lift = (e: ReactPointerEvent, cancelled: boolean) => {
    const f = finger.current
    if (!f || f.id !== e.pointerId) return
    finger.current = null
    p.onThumb(false)
    // A tap, or the end of a slide. (A cancelled touch became a scroll: nothing has changed.)
    if (!cancelled) p.onDone(valueAt((f.slid ? e.clientX : f.x) + f.grab))
    else if (f.slid) p.onSlide(p.value)
  }
  return (
    <div
      ref={strip}
      className="sre-range-hit"
      aria-hidden
      onPointerDown={(e) => {
        if (p.disabled || finger.current) return
        const r = e.currentTarget.getBoundingClientRect()
        const off = r.left + THUMB_PX / 2 + ((p.value - p.min) / span) * (r.width - THUMB_PX) - e.clientX
        finger.current = { id: e.pointerId, x: e.clientX, y: e.clientY, grab: Math.abs(off) <= THUMB_GRAB_PX ? off : 0, slid: false }
        p.onThumb(true)
      }}
      onPointerMove={(e) => {
        const f = finger.current
        if (!f || f.id !== e.pointerId) return
        if (!f.slid) {
          const dx = Math.abs(e.clientX - f.x)
          if (dx < SLIDE_START_PX || dx < Math.abs(e.clientY - f.y)) return
          f.slid = true
          e.currentTarget.setPointerCapture(e.pointerId)
        }
        p.onSlide(valueAt(e.clientX + f.grab))
      }}
      onPointerUp={(e) => lift(e, false)}
      onPointerCancel={(e) => lift(e, true)}
    />
  )
}

export function SelectField(p: { label: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void; help?: string }) {
  return (
    <label className="sre-field">
      <span className="sre-label">{p.label}</span>
      <select
        className="sre-input"
        value={p.value}
        onChange={(e) => {
          audio.ui('toggle')
          p.onChange(e.target.value)
        }}
      >
        {p.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {p.help && <span className="sre-help">{p.help}</span>}
    </label>
  )
}

export function ColourField(p: { label: string; value: string; options: readonly string[]; onChange: (v: string) => void }) {
  return (
    <div className="sre-field">
      <span className="sre-label">{p.label}</span>
      <div className="sre-swatches" role="radiogroup" aria-label={p.label}>
        {p.options.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={c.toLowerCase() === p.value.toLowerCase()}
            className={`sre-swatch${c.toLowerCase() === p.value.toLowerCase() ? ' is-on' : ''}`}
            style={{ '--swatch': c } as CSSProperties}
            onClick={() => {
              audio.ui('toggle')
              p.onChange(c)
            }}
            aria-label={c}
          />
        ))}
      </div>
    </div>
  )
}

/** A row of buttons where exactly one is chosen (Left / Both / Right). */
export function Segmented<V extends string>(p: { label: string; value: V; options: { value: V; label: string }[]; onChange: (v: V) => void }) {
  return (
    <div className="sre-field">
      <span className="sre-label">{p.label}</span>
      <div className="sre-seg" role="radiogroup" aria-label={p.label}>
        {p.options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={o.value === p.value}
            className={`sre-seg-btn${o.value === p.value ? ' is-on' : ''}`}
            onClick={() => {
              if (o.value === p.value) return
              audio.ui('toggle')
              p.onChange(o.value)
            }}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}
