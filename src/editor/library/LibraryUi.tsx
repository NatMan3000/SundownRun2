// ============================================================
//  ONLINE LIBRARY UI - the bits of the Library that only show online
// ------------------------------------------------------------
//  Library.tsx uses these on the online copy instead of Share and
//  Shared tracks (the game at home keeps those):
//
//    SyncLine        top of Your tracks: your tracks save online by
//                    themselves, and how the last sync went
//    SyncChip        on each of your tracks: Online, Waiting to
//                    upload, or why the library said no
//    EveryonesTracks the second tab: every player's tracks, newest
//                    first, with whose they are. Yours open; someone
//                    else's opens as your own copy (theirs never
//                    changes).
// ============================================================

import { useState, useSyncExternalStore } from 'react'
import type { TrackFile } from '../../track/schema'
import { getTrackFile } from '../../track/registry'
import { TrackThumb } from '../../ui/TrackThumb'
import { trackFacts } from '../share/client'
import type { LibraryTrackMeta } from './protocol'
import { everyonesTracks, libraryMe, libraryStatus, libraryVersion, otherTrackFile, subscribeLibrary, syncNow, trackSyncState } from './sync'
import '../share/share.css'
import './library.css'

/** Re-render whenever the library's state changes. */
export function useLibrary(): number {
  return useSyncExternalStore(subscribeLibrary, libraryVersion)
}

export function SyncLine() {
  useLibrary()
  const s = libraryStatus()
  const me = libraryMe()
  let line: string
  let tone: 'good' | 'warn' | 'dim' = 'dim'
  if (s.state === 'starting' || s.state === 'syncing') line = 'Checking the online library...'
  else if (s.state === 'ok') {
    line = `Your tracks save online by themselves${me?.name ? ` as ${me.name}` : ''}, so they're on any computer you log in on.`
    tone = 'good'
  } else {
    line = s.message
    tone = 'warn'
  }
  return (
    <p className={`sr-sync-line is-${tone}`} role="status" data-testid="library-sync-line" data-state={s.state}>
      {line}
    </p>
  )
}

const CHIP_WORDS = { online: 'Online', waiting: 'Waiting to upload', refused: "Couldn't upload", 'other-login': 'Not on this login', theirs: 'Not yours', off: 'Only here' } as const

export function SyncChip(props: { file: TrackFile }) {
  useLibrary()
  const st = trackSyncState(props.file)
  const title =
    st.kind === 'online'
      ? 'Saved in the online library: it is on any computer you log in on.'
      : st.kind === 'waiting'
        ? 'Saved in this browser. It uploads to the online library by itself.'
        : st.kind === 'other-login'
          ? 'It was uploaded under a different login on this computer, so it stays out of your online tracks.'
          : st.kind === 'theirs'
            ? `${st.madeBy}'s track from Shared tracks. It stays in this browser; change something and it becomes yours and saves online.`
            : st.message
  return (
    <span className={`sr-sync-chip is-${st.kind}`} title={title} data-testid="library-sync-chip" data-kind={st.kind}>
      {CHIP_WORDS[st.kind]}
    </span>
  )
}

export function EveryonesTracks(props: { onOpenMine: (file: TrackFile) => void; onCopy: (file: TrackFile) => void }) {
  useLibrary()
  const [busy, setBusy] = useState(false)
  const s = libraryStatus()
  const tracks = everyonesTracks()
  const refresh = async () => {
    setBusy(true)
    await syncNow()
    setBusy(false)
  }
  return (
    <div className="sr-shared" data-testid="everyones-tracks">
      <div className="sr-shared-head">
        <span className="sre-help">Every player's tracks, newest first. Copy one to make it your own: theirs stays just as it is.</span>
        <button type="button" className="sre-btn is-quiet" disabled={busy || s.state === 'syncing'} onClick={() => void refresh()}>
          Refresh
        </button>
      </div>
      {(s.state === 'off' || s.state === 'no-login' || s.state === 'offline') && (
        <p className="sr-shared-line is-warn" data-testid="everyones-unavailable">
          {s.message}
        </p>
      )}
      {(s.state === 'starting' || (s.state === 'syncing' && tracks.length === 0)) && <p className="sr-shared-line">Looking in the online library...</p>}
      {s.state === 'ok' && tracks.length === 0 && <p className="sr-shared-line">No tracks online yet. Draw one and save it: it shows up here for everyone.</p>}
      {tracks.length > 0 && (
        <ul className="sre-lib-list sr-shared-list">
          {tracks.map((t) => (
            <EveryoneRow key={t.id} t={t} onOpenMine={props.onOpenMine} onCopy={props.onCopy} />
          ))}
        </ul>
      )}
    </div>
  )
}

function EveryoneRow(props: { t: LibraryTrackMeta; onOpenMine: (file: TrackFile) => void; onCopy: (file: TrackFile) => void }) {
  const t = props.t
  const file = t.mine ? getTrackFile(t.id) : otherTrackFile(t.id)
  const facts = file ? trackFacts(file) : null
  const when = shortDate(t.updated)
  return (
    <li className="sre-lib-row sr-shared-row" data-testid="everyone-row" data-id={t.id} data-mine={t.mine ? '1' : '0'}>
      {file ? <TrackThumb file={file} width={96} height={60} className="sr-shared-thumb" /> : <div className="sr-shared-thumb thumb thumb--empty">?</div>}
      <div className="sre-lib-name sr-shared-name">
        <strong>{t.name}</strong>
        <span data-testid="everyone-owner">
          by {t.ownerName}
          {t.mine ? ' (you)' : ''}
          {when ? `, ${when}` : ''}, {Math.max(1, Math.round(t.size / 1024))} KB
        </span>
        {facts && (
          <span>
            {facts.length}, {facts.world}, pieces: {facts.pieces}
          </span>
        )}
      </div>
      <div className="sre-lib-acts">
        {t.mine ? (
          <button type="button" className="sre-btn" disabled={!file} title={file ? 'Open it in the editor.' : 'It is still coming down from the library.'} onClick={() => file && props.onOpenMine(file)}>
            Open
          </button>
        ) : (
          <button
            type="button"
            className="sre-btn"
            disabled={!file}
            title={file ? `Make your own copy to change. ${t.ownerName}'s track stays just as it is.` : 'It is still coming down from the library.'}
            data-testid="everyone-copy"
            onClick={() => file && props.onCopy(file)}
          >
            Copy and edit
          </button>
        )}
      </div>
    </li>
  )
}

/** "3 Oct" in the player's own calendar. */
function shortDate(ms: number): string {
  const d = new Date(ms)
  if (!Number.isFinite(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}
