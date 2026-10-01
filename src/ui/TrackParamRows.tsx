// ============================================================
//  TRACK PARAM ROWS - live sliders for the current track
// ------------------------------------------------------------
//  A track file can expose live settings (track/current.ts
//  trackParamsFor), like the Hyperdrome's bank angle. Moving the
//  slider rebuilds the road in place while you watch, without
//  moving the car. Used by the settings Track tab and inline in
//  the pause menu.
//
//  The number on screen updates instantly; the road rebuild is
//  limited to about ten a second while you drag, plus one at the
//  end, so a fast slide never stacks up rebuilds.
// ============================================================

import { useSettings } from '../core/settings'
import { useGame } from '../core/store'
import { getCurrentTrackFile, setTrackParam, trackParamsFor, useTrack } from '../track/current'
import type { TrackFile } from '../track/schema'
import { SliderRow } from './widgets'

const REBUILD_MS = 100

const pending = new Map<string, number>()
let timer: ReturnType<typeof setTimeout> | null = null
let lastRebuild = 0

function flush(): void {
  timer = null
  lastRebuild = performance.now()
  for (const [param, value] of pending) setTrackParam(param, value)
  pending.clear()
}

/** Show the new value now; rebuild the road at most every REBUILD_MS. */
function changeParam(file: TrackFile, param: string, value: number): void {
  useSettings.getState().setTrackParam(file.id, param, value)
  pending.set(param, value)
  if (timer) return
  const wait = Math.max(0, REBUILD_MS - (performance.now() - lastRebuild))
  if (wait === 0) flush()
  else timer = setTimeout(flush, wait)
}

/** What the file itself says a param starts at (for reset-to-default). */
function paramDefault(file: TrackFile, id: string): number | undefined {
  if (id === 'bankDeg') return file.road.banking?.maxDeg ?? 10
  return undefined
}

function paramFormat(id: string): (v: number) => string {
  if (id === 'bankDeg') return (v) => (Math.round(v) === 0 ? 'Flat' : `${Math.round(v)}°`)
  return (v) => (Math.abs(v) >= 10 ? String(Math.round(v)) : v.toFixed(1))
}

function paramStep(min: number, max: number): number {
  const span = max - min
  return span >= 20 ? 1 : span >= 2 ? 0.1 : 0.01
}

export function TrackParamRows(props: { idPrefix: string; emptyText?: string }) {
  useTrack()
  useSettings((s) => s.trackParams)
  const trackName = useGame((s) => s.trackName)
  const file = getCurrentTrackFile()
  const params = file ? trackParamsFor(file) : []
  if (!file || params.length === 0) {
    return props.emptyText ? <p className="empty-note">{props.emptyText.replace('{track}', trackName || 'This track')}</p> : null
  }
  return (
    <>
      {params.map((p) => (
        <SliderRow
          key={p.id}
          id={`${props.idPrefix}:${p.id}`}
          label={p.label}
          value={p.value}
          min={p.min}
          max={p.max}
          step={paramStep(p.min, p.max)}
          format={paramFormat(p.id)}
          defaultValue={paramDefault(file, p.id)}
          onChange={(v) => changeParam(file, p.id, v)}
          help={`${file.name}: changes the road live, while you watch.`}
        />
      ))}
    </>
  )
}
