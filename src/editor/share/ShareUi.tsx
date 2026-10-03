// ============================================================
//  SHARE UI - the Share box and the Shared tracks list
// ------------------------------------------------------------
//  Both live inside the Library (Library.tsx):
//
//    ShareBox       Share on one of your tracks opens this small box.
//                   It says plainly what goes public, lets you change
//                   the Made by name right there, shows the little map
//                   and facts that will be posted, then Share it. The
//                   answer (shared, saved for later, or why not) shows
//                   in the same box.
//    SharedTracks   the Library's second tab: tracks other people
//                   shared, newest first, each with a little map drawn
//                   from its own file and a Download button. A track
//                   that fails its checks says why, before any click.
//
//  Nothing else in the editor waits on GitHub: the list only asks
//  when its tab is opened, and says so in plain words if GitHub can't
//  be reached.
// ============================================================

import { useEffect, useMemo, useRef, useState } from 'react'
import { audio } from '../../core/api'
import type { TrackFile } from '../../track/schema'
import { getTrackFile } from '../../track/registry'
import { TrackThumb } from '../../ui/TrackThumb'
import { say } from '../draft'
import { SHARE_LIMITS, type ShareResult, type SharedListResult } from './protocol'
import { type CheckedItem, canShare, checkSharedItem, downloadShared, fetchSharedList, madeByFor, shareTrack, trackFacts } from './client'
import './share.css'

// ---------------------------------------------------------------- the Share box

/** Why a share waits on this computer, in the same words as Report a problem. */
const KEPT_WHY: Record<'no-token' | 'offline' | 'refused', string> = {
  'no-token': "Reporting isn't switched on on this computer yet. Ask Dad to turn it on (the README says how).",
  offline: "The game couldn't reach GitHub. Is the internet on?",
  refused: "GitHub said no to the game's key. Ask Dad to check it.",
}

export function ShareBox(props: { file: TrackFile; changedNotSaved: boolean; ready: boolean | null; onClose: (shared: boolean) => void }) {
  const file = props.file
  const [madeBy, setMadeBy] = useState(() => madeByFor(file))
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ShareResult | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const can = useMemo(() => canShare(file, madeBy), [file, madeBy])
  const facts = useMemo(() => trackFacts(file), [file])
  const shown = madeBy.trim() || '(no name)'

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  const go = async () => {
    if (busy || !can.ok) return
    setBusy(true)
    audio.ui('select')
    const r = await shareTrack(file, madeBy)
    setBusy(false)
    setResult(r)
    audio.ui(r.status === 'rejected' ? 'error' : 'select')
    if (r.status === 'sent') say(r.updated ? `Updated "${file.name}" on GitHub (#${r.number}).` : `Shared "${file.name}" on GitHub (#${r.number}).`, 'good')
  }

  return (
    <div className="sre-modal sr-share-modal" role="dialog" aria-modal="true" aria-label={`Share ${file.name}`} onPointerDown={(e) => e.target === e.currentTarget && !busy && props.onClose(result?.status === 'sent')}>
      <div className="sre-confirm sr-share" data-testid="share-box">
        {result ? (
          <ShareAnswer result={result} name={file.name} onDone={() => props.onClose(result.status === 'sent')} />
        ) : (
          <>
            <h2>Share "{file.name}"?</h2>
            <p className="sr-share-public" data-testid="share-public">
              Anyone can see shared tracks on GitHub, with the name in Made by: <b>{shown}</b>. Use a nickname, not your real name.
            </p>
            <label className="sr-share-by">
              <span className="sre-label">Made by</span>
              <input
                ref={input}
                className="sre-input"
                value={madeBy}
                maxLength={SHARE_LIMITS.madeBy}
                placeholder="A nickname"
                data-testid="share-madeby"
                onChange={(e) => setMadeBy(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void go()
                }}
              />
            </label>
            <div className="sr-share-card">
              <TrackThumb file={file} width={120} height={76} className="sr-share-thumb" />
              <div className="sr-share-facts">
                <strong>{file.name}</strong>
                <span>
                  {facts.length}, {facts.world}
                </span>
                <span>Pieces: {facts.pieces}</span>
                {file.description && <span className="sr-share-about">{file.description}</span>}
              </div>
            </div>
            {can.ok && can.again !== null && (
              <p className="sr-share-note">
                {can.again ? `You shared it before (#${can.again}): this updates that post, it won't make a copy.` : "You shared it before: this updates that post, it won't make a copy."}
              </p>
            )}
            {props.changedNotSaved && <p className="sr-share-note is-warn">It's open with changes not saved: this shares the saved version.</p>}
            {!can.ok ? (
              <p className="sr-share-note is-bad" data-testid="share-cant">
                {can.why}
              </p>
            ) : (
              <ReadyLine ready={props.ready} />
            )}
            <div className="sre-confirm-acts">
              <button type="button" className="sre-btn" disabled={busy} onClick={() => props.onClose(false)}>
                Cancel
              </button>
              <button type="button" className="sre-btn is-primary" disabled={busy || !can.ok} title={can.ok ? 'Put it on GitHub for other players to download.' : can.why} data-testid="share-go" onClick={() => void go()}>
                {busy ? 'Sharing...' : 'Share it'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function ReadyLine(props: { ready: boolean | null }) {
  if (props.ready === null) return <p className="sr-share-note">Checking whether sharing is switched on...</p>
  if (props.ready) return <p className="sr-share-note is-good">Sharing is on: this goes straight to GitHub.</p>
  return <p className="sr-share-note is-warn">Reporting isn't switched on on this computer yet, so this will be saved here and shared once Dad turns it on.</p>
}

function ShareAnswer(props: { result: ShareResult; name: string; onDone: () => void }) {
  const r = props.result
  const done = useRef<HTMLButtonElement>(null)
  useEffect(() => done.current?.focus(), [])
  let big: string
  let lines: string[]
  let tone: 'good' | 'warn' | 'bad'
  if (r.status === 'sent') {
    big = r.updated ? 'Updated!' : 'Shared!'
    tone = r.labelMissing ? 'warn' : 'good'
    lines = [r.updated ? `"${props.name}" is updated on GitHub (#${r.number}). Anyone who downloads it now gets this version.` : `"${props.name}" is #${r.number} on GitHub. Other players see it in their Shared tracks.`]
    if (r.labelMissing) lines.push(`For Dad: GitHub left the "track" label off #${r.number}, so it won't show in Shared tracks. Add the label on GitHub, or give the key's owner push access.`)
  } else if (r.status === 'saved') {
    big = 'Saved'
    tone = 'warn'
    lines = ['Saved on this computer, it will be shared next time.', KEPT_WHY[r.reason]]
    if (r.reason === 'refused' && r.detail) lines.push(`For Dad: ${r.detail}.`)
  } else {
    big = r.reason === 'taken-down' ? 'Taken down' : "Couldn't share it"
    tone = 'bad'
    lines = [r.message]
  }
  return (
    <div className="sr-share-answer" role="status" data-testid="share-answer" data-status={r.status}>
      <span className={`sr-share-big is-${tone}`}>{big}</span>
      {lines.map((l) => (
        <p key={l}>{l}</p>
      ))}
      {r.status === 'sent' && (
        <a className="sr-share-link" href={r.url} target="_blank" rel="noopener noreferrer">
          See it on GitHub
        </a>
      )}
      <div className="sre-confirm-acts is-1">
        <button ref={done} type="button" className="sre-btn is-primary" onClick={props.onDone}>
          Done
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- the Shared tracks list

type ListState = { kind: 'loading' } | { kind: 'no-server' } | { kind: 'done'; result: SharedListResult }

export function SharedTracks(props: { onDownloaded: (id: string) => void; onOpen: (file: TrackFile) => void; onReady: (ready: boolean) => void }) {
  const [state, setState] = useState<ListState>({ kind: 'loading' })
  const [version, setVersion] = useState(0)
  const alive = useRef(true)
  const { onReady } = props

  const load = async (fresh: boolean) => {
    setState({ kind: 'loading' })
    const r = await fetchSharedList(fresh)
    if (!alive.current) return
    setState(r === 'no-server' ? { kind: 'no-server' } : { kind: 'done', result: r })
    if (r !== 'no-server') onReady(r.ready)
  }
  useEffect(() => {
    alive.current = true
    void load(false)
    return () => {
      alive.current = false
    }
  }, [])

  // Checked once per list (and again after a download, so "You have it" shows).
  const checked = useMemo<CheckedItem[]>(() => (state.kind === 'done' && state.result.status === 'ok' ? state.result.items.map(checkSharedItem) : []), [state, version])

  /** What the last Download did, shown here by the list (the editor's status line is behind the Library). */
  const [notice, setNotice] = useState<{ text: string; tone: 'good' | 'bad' } | null>(null)

  const download = (c: CheckedItem) => {
    const r = downloadShared(c.item)
    if (!r.ok) {
      audio.ui('error')
      setNotice({ text: r.why, tone: 'bad' })
      say(r.why, 'bad')
      return
    }
    audio.ui('select')
    setVersion((v) => v + 1)
    props.onDownloaded(r.id)
    const text = r.renamed ? `Downloaded it as "${r.name}": there's already a track called "${r.renamed}" in your Library, and that one stays as it is.` : `Downloaded "${r.name}". It's in your tracks now.`
    setNotice({ text, tone: 'good' })
    say(text, 'good')
  }

  return (
    <div className="sr-shared" data-testid="shared-tracks">
      <div className="sr-shared-head">
        <span className="sre-help">Tracks other players shared on the game's GitHub page, newest first.</span>
        <button type="button" className="sre-btn is-quiet" disabled={state.kind === 'loading'} onClick={() => void load(true)}>
          Refresh
        </button>
      </div>
      {notice && (
        <p className={`sr-lib-notice is-${notice.tone}`} role="status" data-testid="shared-notice">
          {notice.text}
        </p>
      )}
      {state.kind === 'loading' && <p className="sr-shared-line">Looking on GitHub...</p>}
      {state.kind === 'no-server' && (
        <p className="sr-shared-line is-warn" data-testid="shared-unavailable">
          The game's server isn't answering, so the shared tracks can't be shown. Your own tracks still work.
        </p>
      )}
      {state.kind === 'done' && state.result.status === 'unavailable' && (
        <p className="sr-shared-line is-warn" data-testid="shared-unavailable">
          {state.result.message}
        </p>
      )}
      {state.kind === 'done' && state.result.status === 'ok' && checked.length === 0 && (
        <p className="sr-shared-line">No shared tracks yet. Share one of yours from Your tracks, and it shows up here.</p>
      )}
      {checked.length > 0 && (
        <ul className="sre-lib-list sr-shared-list">
          {checked.map((c) => (
            <SharedRow key={c.item.number} c={c} onDownload={() => download(c)} onOpen={props.onOpen} />
          ))}
        </ul>
      )}
      {state.kind === 'done' && state.result.status === 'ok' && state.result.more && <p className="sr-shared-line">Showing the newest {SHARE_LIMITS.list}.</p>}
    </div>
  )
}

function SharedRow(props: { c: CheckedItem; onDownload: () => void; onOpen: (file: TrackFile) => void }) {
  const c = props.c
  const when = shortDate(c.item.createdAt)
  const openCopy = (id: string) => {
    const file = getTrackFile(id)
    if (file) props.onOpen(file)
  }
  return (
    <li className={`sre-lib-row sr-shared-row${c.ok ? '' : ' is-refused'}`} data-testid="shared-row" data-issue={c.item.number}>
      {c.ok ? <TrackThumb file={c.file} width={96} height={60} className="sr-shared-thumb" /> : <div className="sr-shared-thumb thumb thumb--empty">?</div>}
      <div className="sre-lib-name sr-shared-name">
        <strong>{c.ok ? c.file.name : c.item.title || `Post #${c.item.number}`}</strong>
        {c.ok ? (
          <>
            <span>
              by {c.madeBy || 'someone'}
              {c.mine ? ' (you shared this)' : ''}
              {when ? `, ${when}` : ''}
            </span>
            <span>
              {c.facts.length}, {c.facts.world}, pieces: {c.facts.pieces}
            </span>
          </>
        ) : (
          <span className="sr-shared-why" data-testid="shared-why">
            {c.why}
          </span>
        )}
      </div>
      <div className="sre-lib-acts">
        {c.ok && c.have ? (
          <>
            <button type="button" className="sre-btn" title="Open your copy of it in the editor." data-testid="shared-open" onClick={() => openCopy(c.have as string)}>
              Open
            </button>
            <button type="button" className="sre-btn is-quiet" title="It's already in your tracks. Download makes another copy." onClick={props.onDownload}>
              Download again
            </button>
          </>
        ) : (
          <button
            type="button"
            className={`sre-btn${c.ok ? '' : ' is-refused'}`}
            title={c.ok ? 'Put a copy in your tracks. Nothing of yours is changed.' : c.why}
            data-testid="shared-download"
            onClick={props.onDownload}
          >
            Download
          </button>
        )}
      </div>
    </li>
  )
}

/** "3 Oct" from GitHub's ISO time (the player's own calendar). */
function shortDate(iso: string): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}
