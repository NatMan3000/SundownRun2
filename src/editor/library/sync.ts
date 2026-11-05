// ============================================================
//  ONLINE TRACK LIBRARY, THE BROWSER SIDE - keep your tracks online
// ------------------------------------------------------------
//  Online only (the https copy behind the login: net/protocol.ts
//  isOnlinePage, the same switch as the relay). The game at home never
//  runs any of this.
//
//  Your drawn tracks stay in this browser (the registry's localStorage,
//  the working copy that also works offline), and every one is kept in
//  the online library under your login as well:
//
//    - Save, Import, Save as new, Delete: the registry tells us
//      (onDrawnTracksChanged) and a sync runs a moment later;
//    - a sync uploads every track that changed since it was last
//      online, deletes the ones you deleted, and brings down your
//      tracks saved from another computer. A failed upload is simply
//      still "changed", so the next sync tries again (on a timer that
//      backs off, when the browser comes back online, when you come
//      back to the tab, when the Library opens): that is the outbox;
//    - the first sync in a browser uploads the tracks already in it,
//      once: after that each one is remembered as uploaded;
//    - the library may give a new track a different id (its id was
//      another player's): it is moved to that id here too;
//    - a track changed both here and on another computer keeps both:
//      the other computer's version under its name, this one as a copy;
//    - other players' tracks are fetched (only the ones that changed)
//      and handed to the registry as 'library' tracks, so they show in
//      the track list with their owner's player name.
//
//  What this browser remembers (localStorage):
//    sr2.library.v1         per track id: which login it was uploaded
//                           under, the version and fingerprint uploaded;
//                           deletes still waiting to go
//    sr2.library.others.v1  other players' tracks (file text + version),
//                           so only changed ones are fetched again
//
//  Two tabs never sync at once (a Web Lock), so the first upload can't
//  happen twice. For checkers: __dev.library('help').
// ============================================================

import { registerDev } from '../../core/devHandles'
import { isOnlinePage } from '../../net/protocol'
import { playerName } from '../../net/identity'
import { deleteDrawnTrack, listDrawnTracks, onDrawnTracksChanged, saveDrawnTrack, setLibraryTracks } from '../../track/registry'
import type { TrackFile } from '../../track/schema'
import { fingerprint } from '../share/protocol'
import { downloadedFrom } from '../share/client'
import { DRIVE_TRACK_ID } from '../driveToDraw'
import { followRenamedTrack, freeIdFor, freeName } from '../draft'
import {
  LIBRARY_ENDPOINT,
  type LibraryGetResult,
  type LibraryListResult,
  type LibraryDeleteResult,
  type LibraryRefusal,
  type LibrarySaveRequest,
  type LibrarySaveResult,
  type LibraryTrackMeta,
} from './protocol'

const STATE_KEY = 'sr2.library.v1'
const OTHERS_KEY = 'sr2.library.others.v1'
const REQUEST_TIMEOUT_MS = 20_000
/** Wait after a save before syncing, so a burst of saves is one upload. */
const SOON_MS = 800
/** Retry waits after a failed sync (ms): the last one repeats. */
const BACKOFF_MS = [5_000, 15_000, 60_000, 5 * 60_000]

// ---------------------------------------------------------------- remembering

interface Uploaded {
  /** The login (LibraryMe.key) it lives under online. */
  owner: string
  rev: number
  /** Fingerprint of the file as it is online. */
  check: string
}

interface SyncState {
  uploaded: Record<string, Uploaded>
  /** Deletes still to send: id -> the login it belongs to. */
  deletes: Record<string, { owner: string }>
  /** A track the library refused, and why, until the track changes. */
  refused: Record<string, { check: string; message: string }>
}

interface OtherTrack {
  rev: number
  ownerName: string
  updated: number
  file: string
}

function readJson<T>(key: string, empty: T): T {
  try {
    const raw = localStorage.getItem(key)
    const v: unknown = raw ? JSON.parse(raw) : null
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as T) : empty
  } catch (err) {
    console.error(`[library] could not read ${key} from this browser`, err)
    return empty
  }
}

function writeJson(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch (err) {
    console.error(`[library] could not save ${key} in this browser (storage full?)`, err)
    return false
  }
}

function readState(): SyncState {
  const s = readJson<Partial<SyncState>>(STATE_KEY, {})
  return { uploaded: s.uploaded ?? {}, deletes: s.deletes ?? {}, refused: s.refused ?? {} }
}

const checkOf = (file: TrackFile) => fingerprint(JSON.stringify(file))

// ---------------------------------------------------------------- what the UI reads

export type LibraryStatus =
  | { state: 'starting' }
  | { state: 'syncing' }
  | { state: 'ok'; at: number }
  | { state: 'off' | 'no-login'; message: string }
  | { state: 'offline'; message: string }

export type TrackSyncState =
  | { kind: 'online' }
  | { kind: 'waiting' }
  | { kind: 'refused'; message: string }
  | { kind: 'other-login' }
  | { kind: 'theirs'; madeBy: string }
  | { kind: 'off'; message: string }

let status: LibraryStatus = { state: 'starting' }
let me: { key: string; name: string | null } | null = null
let everyone: LibraryTrackMeta[] = []
let version = 0
const listeners = new Set<() => void>()

function changed(next?: LibraryStatus): void {
  if (next) status = next
  version++
  for (const l of listeners) l()
}

/** For useSyncExternalStore: a number that changes whenever anything below does. */
export function subscribeLibrary(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
export const libraryVersion = () => version
export const libraryStatus = (): LibraryStatus => status
export const libraryMe = () => me
/** Every track in the library at the last sync (yours too, marked mine), newest first. */
export const everyonesTracks = (): LibraryTrackMeta[] => everyone

/** Is the online library in play on this page at all? */
export function libraryOn(): boolean {
  return typeof window !== 'undefined' && isOnlinePage(window.location)
}

/** How one of your tracks stands online, for its row in the Library. */
export function trackSyncState(file: TrackFile): TrackSyncState {
  if (status.state === 'off' || status.state === 'no-login') return { kind: 'off', message: status.message }
  const st = readState()
  const refused = st.refused[file.id]
  const check = checkOf(file)
  if (refused && refused.check === check) return { kind: 'refused', message: refused.message }
  const up = st.uploaded[file.id]
  if (up && me && up.owner !== me.key) return { kind: 'other-login' }
  if (up && up.check === check) return { kind: 'online' }
  const from = untouchedDownload(file, check)
  if (!up && from) return { kind: 'theirs', madeBy: from }
  return { kind: 'waiting' }
}

/**
 * A track downloaded from Shared tracks (GitHub) and never changed is still
 * its maker's track: it isn't uploaded as yours (its maker's own copy is in
 * the library). Change it and it becomes yours, and uploads. Returns the
 * maker's name, or null.
 */
function untouchedDownload(file: TrackFile, check = checkOf(file)): string | null {
  const from = downloadedFrom(file.id)
  return from && from.check === check ? from.madeBy || 'SOMEONE' : null
}

/** Another player's track as a file (from this browser's copy), or null. */
export function otherTrackFile(id: string): TrackFile | null {
  const t = readJson<Record<string, OtherTrack>>(OTHERS_KEY, {})[id]
  if (!t) return null
  try {
    return JSON.parse(t.file) as TrackFile
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- talking to the Worker

type Answer<T> = T | LibraryRefusal | { status: 'offline'; message: string }

const OFFLINE = "The online library can't be reached right now. Your tracks are safe in this browser and upload when it's back."

async function call<T extends { status: string }>(method: string, path: string, body?: unknown): Promise<Answer<T>> {
  let res: Response
  try {
    res = await fetch(`${LIBRARY_ENDPOINT}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      // A lapsed Access login answers with a redirect to the login page: don't follow it into HTML.
      redirect: 'manual',
    })
  } catch (err) {
    console.warn(`[library] ${method} ${path} did not answer`, err)
    return { status: 'offline', message: OFFLINE }
  }
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    return { status: 'refused', code: 'no-login', message: 'Your login has run out. Reload the page and log in again.' }
  }
  try {
    const parsed = (await res.json()) as T | LibraryRefusal
    if (parsed && typeof parsed === 'object' && typeof parsed.status === 'string') return parsed
  } catch {
    // fall through
  }
  console.warn(`[library] ${method} ${path} answered ${res.status} with something unexpected`)
  return { status: 'offline', message: OFFLINE }
}

// ---------------------------------------------------------------- writing here without uploading it again

let quiet = false

/** Save or delete a drawn track here for the library's own reasons (no upload is set off). */
function quietly<T>(fn: () => T): T {
  quiet = true
  try {
    return fn()
  } finally {
    quiet = false
  }
}

// ---------------------------------------------------------------- one sync

let running: Promise<void> | null = null
let again = false

/** Run a sync now (or straight after the one running). Resolves when the library is up to date or a step failed. */
export function syncNow(): Promise<void> {
  if (!libraryOn()) return Promise.resolve()
  if (running) {
    again = true
    return running
  }
  running = (async () => {
    try {
      do {
        again = false
        await withLock(syncOnce)
      } while (again)
    } finally {
      running = null
    }
  })()
  return running
}

async function withLock(fn: () => Promise<void>): Promise<void> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  if (locks?.request) {
    await locks.request('sr2-library-sync', fn)
    return
  }
  await fn()
}

let failures = 0
let retryTimer: ReturnType<typeof setTimeout> | null = null

function retryLater(): void {
  if (retryTimer) return
  const wait = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)]
  failures++
  retryTimer = setTimeout(() => {
    retryTimer = null
    void syncNow()
  }, wait)
}

/** A step failed: say why and stop this sync. Network trouble retries later; a refused login doesn't. */
function stopped(r: { status: 'offline'; message: string } | LibraryRefusal): void {
  if (r.status === 'offline' || r.code === 'error') {
    changed({ state: 'offline', message: r.message })
    retryLater()
  } else if (r.code === 'off' || r.code === 'no-login') {
    changed({ state: r.code, message: r.message })
  } else {
    changed({ state: 'offline', message: r.message })
    retryLater()
  }
}

/** Errors that belong to one track (it stays here and waits until it changes); anything else stops the sync. */
function trackProblem(r: LibraryRefusal): boolean {
  return r.code === 'too-many' || r.code === 'full' || r.code === 'too-big' || r.code === 'invalid'
}

async function fetchFile(id: string): Promise<{ file: TrackFile; meta: LibraryTrackMeta; text: string } | Answer<never> | null> {
  const r = await call<LibraryGetResult & { status: 'ok' }>('GET', `/tracks/${encodeURIComponent(id)}`)
  if (r.status !== 'ok') return r.status === 'refused' && r.code === 'not-found' ? null : (r as Answer<never>)
  try {
    return { file: JSON.parse(r.track.file) as TrackFile, meta: r.track, text: r.track.file }
  } catch {
    console.error(`[library] track ${id} came back unreadable`)
    return null
  }
}

async function syncOnce(): Promise<void> {
  changed({ state: 'syncing' })
  const list = await call<LibraryListResult & { status: 'ok' }>('GET', '')
  if (list.status !== 'ok') return stopped(list)
  me = list.me
  everyone = list.tracks
  const key = list.me.key
  const name = playerName()
  const st = readState()
  const save = () => writeJson(STATE_KEY, st)
  const mineOnline = new Map(list.tracks.filter((t) => t.mine).map((t) => [t.id, t]))

  // 1. Deletes waiting to go (only the ones that belong to this login).
  for (const [id, d] of Object.entries(st.deletes)) {
    if (d.owner !== key) continue
    const r = await call<LibraryDeleteResult & { status: 'ok' }>('DELETE', `/tracks/${encodeURIComponent(id)}`)
    if (r.status === 'ok' || (r.status === 'refused' && (r.code === 'not-found' || r.code === 'not-yours'))) {
      delete st.deletes[id]
      mineOnline.delete(id)
      save()
    } else return stopped(r)
  }

  // A library that shows none of this login's tracks while this browser remembers several uploaded under it is more likely
  // reset or wrong than deleted from another computer: delete nothing here, say so, and look again later.
  const remembered = Object.entries(st.uploaded).filter(([, u]) => u.owner === key)
  if (remembered.length > 1 && !remembered.some(([id]) => mineOnline.has(id))) {
    console.error(`[library] the library lists none of your ${remembered.length} uploaded tracks: nothing is deleted here, the sync stopped`)
    return stopped({
      status: 'refused',
      code: 'error',
      message: `The online library looks empty, but ${remembered.length} of your tracks were saved there. Your tracks are still safe in this browser. It will look again soon.`,
    })
  }

  // 2. Every track in this browser.
  for (const file of listDrawnTracks()) {
    if (file.id === DRIVE_TRACK_ID) continue
    const up = st.uploaded[file.id]
    if (up && up.owner !== key) continue // uploaded under another login: leave it be
    const check = checkOf(file)
    if (st.refused[file.id] && st.refused[file.id].check === check) continue
    if (!up && untouchedDownload(file, check)) continue
    const online = mineOnline.get(file.id)
    let upload: 'new' | 'version' | null = null

    if (!up) {
      // Never uploaded from here. The same id online could be this very track (this browser forgot) or another one of yours.
      if (online) {
        const got = await fetchFile(file.id)
        if (got && 'file' in got && got.text === JSON.stringify(file)) {
          st.uploaded[file.id] = { owner: key, rev: got.meta.rev, check }
          save()
          continue
        }
        if (got && !('file' in got)) return stopped(got)
      }
      upload = 'new'
    } else if (!online) {
      // Gone online: deleted from another computer. Unchanged here: delete it here too. Changed here: it goes up again as new.
      if (up.check === check) {
        quietly(() => deleteDrawnTrack(file.id))
        delete st.uploaded[file.id]
        save()
        continue
      }
      delete st.uploaded[file.id]
      upload = 'new'
    } else if (online.rev === up.rev) {
      if (up.check !== check) upload = 'version'
    } else {
      // A newer version was saved from another computer.
      const got = await fetchFile(file.id)
      if (!got) continue
      if (!('file' in got)) return stopped(got)
      if (up.check !== check) {
        // Changed here as well: keep this one as a copy, which uploads as a new track below.
        const copyName = freeName(`${file.name} (this computer)`)
        const copy: TrackFile = { ...file, id: freeIdFor(copyName), name: copyName }
        if (!quietly(() => saveDrawnTrack(copy))) {
          // No room for the copy: the other version would replace the only one of this computer's. Leave the track alone.
          console.warn(`[library] "${file.name}" changed here and on another computer, but this browser is full and could not keep a copy: left as it is`)
          continue
        }
        followRenamedTrack(file.id, copy.id)
        again = true
        console.warn(`[library] "${file.name}" changed here and on another computer: this computer's version is now "${copyName}"`)
      }
      if (!quietly(() => saveDrawnTrack(got.file))) {
        console.warn(`[library] "${file.name}": the newer version could not be kept (browser storage full), left as it is`)
        continue
      }
      st.uploaded[file.id] = { owner: key, rev: got.meta.rev, check: checkOf(got.file) }
      save()
      continue
    }
    if (!upload) continue

    const body: LibrarySaveRequest = upload === 'new' ? { file, playerName: name } : { file, playerName: name, baseRev: up?.rev }
    const r =
      upload === 'new'
        ? await call<LibrarySaveResult & { status: 'ok' }>('POST', '/tracks', body)
        : await call<LibrarySaveResult & { status: 'ok' }>('PUT', `/tracks/${encodeURIComponent(file.id)}`, body)
    if (r.status === 'ok') {
      let now = file
      if (r.id !== file.id) {
        // The library gave it another id (its own was taken): move it here too.
        now = { ...file, id: r.id }
        // Only drop the old id once the new one is safely kept.
        const kept = quietly(() => saveDrawnTrack(now) && (deleteDrawnTrack(file.id), true))
        if (!kept) {
          console.warn(`[library] "${file.name}" got a new id online but could not be kept under it here (browser storage full): left as it is`)
          continue
        }
        followRenamedTrack(file.id, r.id)
        delete st.uploaded[file.id]
      }
      st.uploaded[r.id] = { owner: key, rev: r.rev, check: checkOf(now) }
      delete st.refused[file.id]
      save()
      continue
    }
    if (r.status === 'refused' && trackProblem(r)) {
      st.refused[file.id] = { check, message: r.message }
      save()
      continue
    }
    if (r.status === 'refused' && r.code === 'changed') {
      // Saved from another computer between the list and now: the next round sorts it out.
      again = true
      continue
    }
    if (r.status === 'refused' && r.code === 'not-found' && up) {
      delete st.uploaded[file.id]
      save()
      again = true
      continue
    }
    return stopped(r)
  }

  // 3. Your tracks saved from another computer that this browser doesn't have yet.
  const here = new Set(listDrawnTracks().map((t) => t.id))
  for (const t of mineOnline.values()) {
    if (here.has(t.id) || st.deletes[t.id]) continue
    const got = await fetchFile(t.id)
    if (!got) continue
    if (!('file' in got)) return stopped(got)
    quietly(() => saveDrawnTrack(got.file))
    st.uploaded[t.id] = { owner: key, rev: got.meta.rev, check: checkOf(got.file) }
    save()
  }

  // 4. Everyone else's tracks: fetch the ones that changed, forget the ones gone.
  const cached = readJson<Record<string, OtherTrack>>(OTHERS_KEY, {})
  const others = list.tracks.filter((t) => !t.mine)
  const keep: Record<string, OtherTrack> = {}
  for (const t of others) {
    const have = cached[t.id]
    if (have && have.rev === t.rev) {
      keep[t.id] = { ...have, ownerName: t.ownerName }
      continue
    }
    const got = await fetchFile(t.id)
    if (!got) continue
    if (!('file' in got)) return stopped(got)
    keep[t.id] = { rev: got.meta.rev, ownerName: t.ownerName, updated: got.meta.updated, file: got.text }
  }
  if (!writeJson(OTHERS_KEY, keep)) console.warn('[library] other players\' tracks are kept for this visit only (browser storage full)')
  publishOthers(keep)

  failures = 0
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  changed({ state: 'ok', at: Date.now() })
}

function publishOthers(all: Record<string, OtherTrack>): void {
  const entries: { file: TrackFile; owner: string }[] = []
  for (const t of Object.values(all)) {
    try {
      entries.push({ file: JSON.parse(t.file) as TrackFile, owner: t.ownerName })
    } catch {
      console.error('[library] an other player\'s track in this browser is unreadable; it is fetched again next time')
    }
  }
  setLibraryTracks(entries)
}

// ---------------------------------------------------------------- wiring

let soonTimer: ReturnType<typeof setTimeout> | null = null

function syncSoon(): void {
  if (soonTimer) clearTimeout(soonTimer)
  soonTimer = setTimeout(() => {
    soonTimer = null
    void syncNow()
  }, SOON_MS)
}

let started = false

/** Start keeping this browser's tracks online (online pages only; idempotent). */
export function startLibrarySync(): void {
  if (started || !libraryOn()) return
  started = true
  // Other players' tracks this browser already has, straight away (the sync refreshes them).
  publishOthers(readJson<Record<string, OtherTrack>>(OTHERS_KEY, {}))
  onDrawnTracksChanged((change) => {
    if (quiet) return
    if (change.kind === 'delete') {
      const st = readState()
      const up = st.uploaded[change.id]
      if (up) {
        st.deletes[change.id] = { owner: up.owner }
        delete st.uploaded[change.id]
      }
      delete st.refused[change.id]
      writeJson(STATE_KEY, st)
    }
    if (change.kind === 'save' && change.file.id === DRIVE_TRACK_ID) return
    changed()
    syncSoon()
  })
  window.addEventListener('online', () => void syncNow())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void syncNow()
  })
  void syncNow()
}

// ---------------------------------------------------------------- for checkers

async function libraryCommand(cmd = 'help'): Promise<unknown> {
  switch (cmd) {
    case 'sync':
      await syncNow()
      return { status, me, tracks: everyone.length }
    case 'status':
      return { on: libraryOn(), status, me }
    case 'list':
      return everyone.map((t) => ({ id: t.id, name: t.name, by: t.ownerName, mine: t.mine, rev: t.rev, size: t.size }))
    case 'state':
      return { state: readState(), others: Object.keys(readJson(OTHERS_KEY, {})) }
    default:
      return {
        commands: {
          sync: 'run a sync now and wait for it',
          status: 'is the library on, the last sync, who you are',
          list: 'every track in the library at the last sync',
          state: 'what this browser remembers (uploaded tracks, waiting deletes, refusals, cached tracks)',
        },
      }
  }
}

registerDev('library', libraryCommand as (...args: never[]) => unknown, "online track library: __dev.library('help')")

if (typeof window !== 'undefined') startLibrarySync()
