// ============================================================
//  EDITOR FIELDS - the small form controls the editor panel uses
// ------------------------------------------------------------
//  Text boxes, sliders, drop-downs, colour swatches and a row of
//  choice buttons. Each one changes the draft ONCE when you finish
//  (let go of a slider, press Enter in a text box), so every edit is
//  exactly one Undo step, and the 3D preview rebuilds once.
// ============================================================

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { setInputContext } from '../core/controls'
import { audio } from '../core/api'

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
    </div>
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
