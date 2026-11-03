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
//
//  If the joiner has a different track of the same id (their own, or the
//  host's track downloaded from Shared tracks, whose Made by differs), the
//  host's copy is held as `<id>-host` so theirs is never overwritten. That
//  copy still builds as the host's road: it keeps the host's id in its
//  key (registerSharedTrack's hostId, TrackRuntime.keyId) and the host's
//  world seed, so every same-track check, the round seeds and the stunt
//  park match the host's.
// ============================================================

import { getGame, useGame } from '../core/store'
import { useSettings } from '../core/settings'
import { emit } from '../core/events'
import { getCurrentTrackFile, getTrack, setTrackFromFile, setTrackParam } from '../track/current'
import { getTrackFile, getTrackSource, registerSharedTrack } from '../track/registry'
import { hashString } from '../track/noise'
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
  if (send({ t: 'track', file: outgoingFile(file, track.keyId), params: { ...track.params } })) {
    lastSentFile = file
    lastSentParams = params
  }
}

/**
 * The file as it goes out: under the id in its key. A joiner who became host while on a renamed
 * copy of the old host's track (`<id>-host`) sends it under the old host's id, so everyone,
 * the old host included, ends up with the same key again.
 */
export function outgoingFile(file: TrackFile, keyId: string): TrackFile {
  return keyId === file.id ? file : { ...file, id: keyId }
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
  // Another player's online library track isn't ours: the host's copy (newer, if they differ)
  // takes its place under the real id, so no "-host" copy sits beside it in the track list.
  if (!local || source === 'shared' || source === 'library') return file.id
  // Same id, same content (a built-in track both sides have): just use it.
  if (JSON.stringify(local) === json) return file.id
  return `${file.id}-host`
}

/**
 * The host's file under another id. A file with no world seed takes it from its id
 * (src/track/validate.ts), so the copy is given the seed the host's id makes: same world.
 */
function renamedCopy(file: TrackFile, id: string): TrackFile {
  const env = file.environment
  return { ...file, id, environment: env && env.seed === undefined ? { ...env, seed: hashString(file.id) } : env }
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
  const file: TrackFile = id === msg.file.id ? msg.file : renamedCopy(msg.file, id)
  // Store the host's live parameters as ours for this track first, so the
  // track builds with them straight away (one build, not two).
  for (const [param, value] of Object.entries(msg.params)) {
    if (Number.isFinite(value)) useSettings.getState().setTrackParam(file.id, param, value)
  }
  registerSharedTrack(file, msg.file.id)
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
