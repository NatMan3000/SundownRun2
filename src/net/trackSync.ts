// ============================================================
//  TRACK SYNC - the host's track goes to everyone
// ------------------------------------------------------------
//  The host (the computer running `bun run mp`) picks the track.
//  Its whole track FILE travels over the network, not just its name,
//  so a track drawn in the host's editor - one that exists only in the
//  host's browser - still reaches every joiner and is drivable there.
//
//  Host side: whenever the track changes (trackVersion), a live
//  parameter changes (the Hyperdrome bank slider, trackParamVersion),
//  or we become the host, send { file, params }. Never while the host
//  is in the editor: a half-drawn track isn't sent; the finished one
//  goes out when the host leaves the editor.
//
//  Joiner side: register the file as a 'shared' track, build it,
//  announce mp.track. If it is the same file we already have, only the
//  live parameters are applied (no rebuild, the car stays put). If a
//  joiner is in the editor, the track waits until they leave it.
// ============================================================

import { getGame, useGame } from '../core/store'
import { useSettings } from '../core/settings'
import { emit } from '../core/events'
import { getCurrentTrackFile, getTrack, setTrackFromFile, setTrackParam } from '../track/current'
import { getTrackFile, getTrackSource, registerSharedTrack } from '../track/registry'
import type { TrackFile } from '../track/schema'
import { onMessage, send } from './client'
import { getNet, useNet } from './netStore'
import type { TrackMsg } from './protocol'

// ---------------------------------------------------------------- host side

let lastSentFile: TrackFile | null = null
let lastSentParams = ''

/** Send our track if we host and it changed since we last sent it (or `force`). */
export function sendTrackIfHost(force = false): void {
  const net = getNet()
  if (!net.isHost || net.status !== 'online') return
  if (getGame().phase === 'editor') return
  const file = getCurrentTrackFile()
  const track = getTrack()
  if (!file || !track) return
  const params = JSON.stringify(track.params)
  if (!force && file === lastSentFile && params === lastSentParams) return
  if (send({ t: 'track', file, params: { ...track.params } })) {
    lastSentFile = file
    lastSentParams = params
  }
}

// ---------------------------------------------------------------- joiner side

let pending: TrackMsg | null = null
/** The JSON of the last host file we built, so a repeat only applies params. */
let lastAppliedJson = ''
let lastAppliedId = ''

/** Pick an id for the shared copy that can't be mistaken for one of OUR tracks with the same id. */
function sharedId(file: TrackFile, json: string): string {
  const local = getTrackFile(file.id)
  const source = getTrackSource(file.id)
  if (!local || source === 'shared') return file.id
  // Same id, same content (a built-in track both sides have): just use it.
  if (JSON.stringify(local) === json) return file.id
  return `${file.id}-host`
}

/** Build the host's track here (or just update its live parameters). */
export function applyHostTrack(msg: TrackMsg): void {
  const net = getNet()
  if (net.isHost) return
  if (getGame().phase === 'editor') {
    pending = msg
    return
  }
  pending = null
  const json = JSON.stringify(msg.file)
  const current = getTrack()

  // Same file as last time: only live parameters may have moved.
  if (json === lastAppliedJson && current && current.id === lastAppliedId) {
    for (const [param, value] of Object.entries(msg.params)) {
      if (Number.isFinite(value) && current.params[param] !== value) setTrackParam(param, value)
    }
    return
  }

  const id = sharedId(msg.file, json)
  const file: TrackFile = id === msg.file.id ? msg.file : { ...msg.file, id }
  // Store the host's live parameters as ours for this track first, so the
  // track builds with them straight away (one build, not two).
  for (const [param, value] of Object.entries(msg.params)) {
    if (Number.isFinite(value)) useSettings.getState().setTrackParam(file.id, param, value)
  }
  registerSharedTrack(file)
  const result = setTrackFromFile(file)
  if (!result.ok) {
    const why = result.errors.map((e) => `${e.path} ${e.message}`.trim()).join('; ')
    console.error('[net] the host track could not be built here:', why)
    useNet.setState({ trackError: `The host's track "${msg.file.name}" could not be built: ${why}` })
    return
  }
  lastAppliedJson = json
  lastAppliedId = file.id
  useNet.setState({ hostTrack: { id: file.id, name: file.name }, trackError: null })
  emit('mp.track', { trackId: file.id, trackName: file.name, fromHost: true })
}

// ---------------------------------------------------------------- wiring

let wired = false
let unsubs: (() => void)[] = []

/** Hook track sync into the client and the game store (idempotent). */
export function startTrackSync(): void {
  if (wired) return
  wired = true
  unsubs.push(onMessage('track', (m) => applyHostTrack(m)))
  unsubs.push(
    onMessage('welcome', (m) => {
      if (m.track && m.hostId !== m.id) applyHostTrack(m.track)
    }),
  )
  unsubs.push(
    // Becoming host (on connect, or when the old host leaves): the relay holds
    // no track for us yet, so send ours. A disconnect always clears isHost,
    // so this fires once per connection.
    useNet.subscribe((s, prev) => {
      if (s.isHost && !prev.isHost) {
        lastSentFile = null
        sendTrackIfHost()
      }
    }),
  )
  unsubs.push(
    useGame.subscribe((s, prev) => {
      if (s.trackVersion !== prev.trackVersion || s.trackParamVersion !== prev.trackParamVersion) sendTrackIfHost()
      if (s.phase !== prev.phase && prev.phase === 'editor') {
        // Leaving the editor: the host shares what it built; a joiner catches up.
        sendTrackIfHost()
        if (pending) applyHostTrack(pending)
      }
    }),
  )
}

export function stopTrackSync(): void {
  for (const u of unsubs) u()
  unsubs = []
  wired = false
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => stopTrackSync())
}
