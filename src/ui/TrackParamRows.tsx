// ============================================================
//  TRACK PARAM ROWS - live sliders for tracks that have them
// ------------------------------------------------------------
//  A track file can expose live settings (track/current.ts
//  trackParamsFor), like the Hyperdrome's bank angle. Two ways
//  to show them:
//
//    TrackParamRows     the track you are on, inline in the pause
//                       menu (the bank slider right there)
//    AllTrackParamRows  every track that has live settings, one
//                       group per track, in the settings Track tab.
//                       The track you are on comes first and
//                       changes while you watch; the others are
//                       saved and used the next time you drive them.
//                       This is how the title screen reaches the
//                       Hyperdrome's bank before you have driven it.
//
//  Rebuilding the road is heavy (a whole frame or more), so the
//  number on screen moves at once but the road only rebuilds once
//  the slider has settled, or when the menu closes. Holding the
//  slider down therefore costs one rebuild, at the end, instead of
//  one per step.
// ============================================================

import { useEffect, useMemo } from 'react'
import { useSettings } from '../core/settings'
import { useGame } from '../core/store'
import { getCurrentTrackFile, getTrack, setTrackParam, trackParamsFor, useTrack } from '../track/current'
import { listTracks } from '../track/registry'
import type { TrackFile } from '../track/schema'
import type { TrackParamInfo } from '../track/types'
import { SliderRow } from './widgets'

// ---------------------------------------------------------------- the debounced rebuild

/** Rebuild once the slider has been still this long (while it is being held, steps come faster than this). */
const SETTLE_MS = 250
/**
 * The first step of a new press waits longer, because it may be the start of
 * a hold: a held d-pad only starts repeating after 350 ms, a held key after
 * about 375 to 500 ms. Waiting past that means a held slider never rebuilds
 * halfway through.
 */
const FIRST_STEP_MS = 550
/** Steps closer together than this are one movement (same window as the menu's hold streak). */
const SAME_MOVE_MS = 260

/** The newest change waiting to be built: which track, which param, what value. */
let waiting: { trackId: string; param: string; value: number } | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let lastChangeAt = -Infinity
/** True from a rebuild until the new road has been drawn, so two never overlap. */
let building = false
let buildAgain = false

/**
 * Build the waiting change now (the slider settled, or the menu closed).
 * Every saved param of the track goes into the one rebuild, so a change to
 * two sliders still costs one rebuild.
 */
export function flushTrackParams(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  if (!waiting) return
  if (building) {
    buildAgain = true
    return
  }
  const w = waiting
  waiting = null
  // The track changed meanwhile: nothing to rebuild. The value is saved, so
  // that track builds with it next time.
  if (getCurrentTrackFile()?.id !== w.trackId) return
  building = true
  setTrackParam(w.param, w.value)
  // Two frames: the new road is committed and drawn before another rebuild may start.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      building = false
      if (buildAgain) {
        buildAgain = false
        flushTrackParams()
      }
    }),
  )
}

/**
 * "Reset all" wiped the saved track params: if the road you are on was built
 * at a changed value, rebuild it at the track's default so it matches the menu.
 */
export function rebuildLiveTrackAfterReset(): void {
  const file = getCurrentTrackFile()
  const live = getTrack()
  if (!file || !live) return
  for (const p of trackParamsFor(file)) {
    if (live.params[p.id] !== p.value) {
      waiting = { trackId: file.id, param: p.id, value: p.value }
      flushTrackParams()
      return
    }
  }
}

/** A slider moved: save and show the value now; rebuild the road once it settles. */
function changeParam(file: TrackFile, param: string, value: number): void {
  // Saving it is what moves the number on screen (and what the next build of this track reads).
  useSettings.getState().setTrackParam(file.id, param, value)
  // Not the track you are on: saved for next time, nothing to rebuild.
  if (getCurrentTrackFile()?.id !== file.id) return
  waiting = { trackId: file.id, param, value }
  const now = performance.now()
  const wait = now - lastChangeAt < SAME_MOVE_MS ? SETTLE_MS : FIRST_STEP_MS
  lastChangeAt = now
  if (timer) clearTimeout(timer)
  timer = setTimeout(flushTrackParams, wait)
}

/** Closing the menu (this component unmounting) builds anything still waiting. */
function useFlushOnClose(): void {
  useEffect(() => () => flushTrackParams(), [])
}

// ---------------------------------------------------------------- rows

function paramFormat(id: string): (v: number) => string {
  if (id === 'bankDeg') return (v) => (Math.round(v) === 0 ? 'Flat' : `${Math.round(v)}°`)
  return (v) => (Math.abs(v) >= 10 ? String(Math.round(v)) : v.toFixed(1))
}

function paramStep(min: number, max: number): number {
  const span = max - min
  return span >= 20 ? 1 : span >= 2 ? 0.1 : 0.01
}

function ParamRow(props: { id: string; file: TrackFile; p: TrackParamInfo; live: boolean }) {
  const { file, p } = props
  return (
    <SliderRow
      id={props.id}
      label={p.label}
      value={p.value}
      min={p.min}
      max={p.max}
      step={paramStep(p.min, p.max)}
      format={paramFormat(p.id)}
      defaultValue={p.default}
      onChange={(v) => changeParam(file, p.id, v)}
      help={props.live ? `${file.name}: changes the road live, while you watch.` : `${file.name}: saved now, used the next time you drive it.`}
    />
  )
}

/** The track you are on (pause menu). Nav ids: `<idPrefix>:<param>`. */
export function TrackParamRows(props: { idPrefix: string; emptyText?: string }) {
  useTrack()
  useSettings((s) => s.trackParams)
  useFlushOnClose()
  const trackName = useGame((s) => s.trackName)
  const file = getCurrentTrackFile()
  const params = file ? trackParamsFor(file) : []
  if (!file || params.length === 0) {
    return props.emptyText ? <p className="empty-note">{props.emptyText.replace('{track}', trackName || 'This track')}</p> : null
  }
  return (
    <>
      {params.map((p) => (
        <ParamRow key={p.id} id={`${props.idPrefix}:${p.id}`} file={file} p={p} live />
      ))}
    </>
  )
}

export interface TrackParamGroup {
  file: TrackFile
  /** The track you are on: its road changes live. */
  live: boolean
  params: TrackParamInfo[]
}

/** Every track with live settings, the one you are on first, then in track-list order (same order as AllTrackParamRows). */
export function trackParamGroups(): TrackParamGroup[] {
  const current = getCurrentTrackFile()
  const groups: TrackParamGroup[] = []
  const seen = new Set<string>()
  const add = (file: TrackFile, live: boolean) => {
    if (seen.has(file.id)) return
    seen.add(file.id)
    const params = trackParamsFor(file)
    if (params.length) groups.push({ file, live, params })
  }
  if (current) add(current, true)
  for (const t of listTracks()) add(t.file, false)
  return groups
}

/** The nav id of one track's param row in the grouped list. */
export function groupRowId(idPrefix: string, trackId: string, param: string): string {
  return `${idPrefix}:${trackId}:${param}`
}

/** Every track that has live settings, grouped and labelled by track (settings Track tab). */
export function AllTrackParamRows(props: { idPrefix: string; emptyText: string }) {
  useTrack()
  useSettings((s) => s.trackParams)
  useFlushOnClose()
  // The track list reads saved drawn tracks from storage, so read it once per open.
  const listed = useMemo(() => listTracks().map((t) => t.file), [])
  const current = getCurrentTrackFile()
  const files = current ? [current, ...listed.filter((f) => f.id !== current.id)] : listed
  // Values are re-read every render, so a moved slider shows its new number straight away.
  const groups = files.map((file) => ({ file, live: file === current, params: trackParamsFor(file) })).filter((g) => g.params.length)
  if (groups.length === 0) return <p className="empty-note">{props.emptyText}</p>
  return (
    <>
      {groups.map((g) => (
        <div className={`param-group${g.live ? ' is-live' : ''}`} key={g.file.id} role="group" aria-label={g.file.name}>
          <div className="param-group__head">
            <span className="param-group__name">{g.file.name}</span>
            <span className="param-group__tag">{g.live ? 'Changes live' : 'Used next time you drive it'}</span>
          </div>
          {g.params.map((p) => (
            <ParamRow key={p.id} id={groupRowId(props.idPrefix, g.file.id, p.id)} file={g.file} p={p} live={g.live} />
          ))}
        </div>
      ))}
    </>
  )
}
