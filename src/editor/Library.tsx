// ============================================================
//  TRACK LIBRARY - open, start, copy, import and export tracks
// ------------------------------------------------------------
//  The editor's file manager. Your tracks are saved in this browser;
//  built-in tracks can be copied and edited; a .json track file from
//  a friend can be imported (and it then shows up in the game's
//  track list too). Export saves the exact file that can go straight
//  into the game's tracks/ folder. A new track starts as an empty map
//  in the world you pick: draw a loop, or press Random track.
//
//  Across the top it says which track you are editing and whether it
//  is saved, and that track's row is marked "Open now". Opening
//  another track, or starting a new one, asks "Save it first?" when
//  the open one has changes not saved (askFirst.ts).
//
//  Two tabs: Your tracks (all of the above), and Shared tracks, the
//  tracks other players put on the game's GitHub page. Share on one of
//  your tracks posts it there (share/ShareUi.tsx, through the game's
//  server like Report a problem); Download brings a shared one in
//  through the same checks as Import a track file (importTrack.ts).
// ============================================================

import { useMemo, useRef, useState } from 'react'
import { audio } from '../core/api'
import { type TrackListing, deleteDrawnTrack, downloadTrack, listTracks } from '../track/registry'
import type { TrackFile } from '../track/schema'
import { fetchReportInfo } from '../ui/report/send'
import { BASE_WORLDS, isEmptyDraft } from './draftFile'
import { type SaveState, SAVE_STATE_WORDS, draftFromFile, fileFromDraft, forgetDeletedTrack, replaceDraft, saveState, say, useEditor } from './draft'
import { askBeforeLeavingTrack, askNewTrack } from './askFirst'
import { fitToDraft } from './Overlay'
import { DRIVE_TRACK_ID } from './driveToDraw'
import { importTrackText } from './importTrack'
import { canShare, downloadedFrom } from './share/client'
import { ShareBox, SharedTracks } from './share/ShareUi'

export function Library(props: { onClose: () => void }) {
  const [version, setVersion] = useState(0)
  const [tab, setTab] = useState<'mine' | 'shared'>('mine')
  const [sharing, setSharing] = useState<TrackFile | null>(null)
  /** Is a GitHub key set up on this computer? null while asking (the Share box says which). */
  const [ready, setReady] = useState<boolean | null>(null)
  const tracks = useMemo(() => listTracks().filter((t) => t.id !== DRIVE_TRACK_ID), [version])
  const fileInput = useRef<HTMLInputElement>(null)
  const [newWorld, setNewWorld] = useState(BASE_WORLDS[0].id)
  const empty = useEditor((s) => isEmptyDraft(s.draft))
  const savedId = useEditor((s) => s.savedId)
  const name = useEditor((s) => s.draft.name.trim() || 'My Track')
  const state = useEditor((s) => saveState(s))

  const open = (file: TrackFile, asCopy: boolean) => {
    const go = () => {
      audio.ui('select')
      replaceDraft(draftFromFile(file, asCopy), asCopy ? null : file.id)
      requestAnimationFrame(fitToDraft)
      say(asCopy ? `Editing a copy of "${file.name}": it's a new track, so Save puts it in your Library.` : `Opened "${file.name}".`, 'good')
      props.onClose()
    }
    askBeforeLeavingTrack('open', go, file.name)
  }
  const startNew = () => {
    askNewTrack(newWorld, () => {
      requestAnimationFrame(fitToDraft)
      props.onClose()
    })
  }
  /** What the last Import did, shown inside the Library (the editor's status line is behind it). */
  const [notice, setNotice] = useState<{ text: string; tone: 'good' | 'bad' } | null>(null)
  const onImport = async (file: File | undefined) => {
    if (!file) return
    const result = importTrackText(await file.text())
    if (!result.ok) {
      audio.ui('error')
      const text = `That file isn't a track this game can load: ${result.why}.`
      setNotice({ text, tone: 'bad' })
      say(text, 'bad')
      return
    }
    setVersion((v) => v + 1)
    const name = result.name || file.name
    const text = result.renamed ? `Imported it as "${name}": there's already a track called "${result.renamed}" in your Library, and that one stays as it is.` : `Imported "${name}". It's in your tracks now.`
    setNotice({ text, tone: 'good' })
    say(text, 'good')
    audio.ui('select')
  }
  const startShare = (file: TrackFile) => {
    audio.ui('select')
    setSharing(file)
    if (ready === null) void fetchReportInfo().then((info) => setReady(info ? info.ready : false))
  }

  return (
    <div className="sre-modal" role="dialog" aria-modal="true" aria-label="Track library" onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="sre-library">
        <header className="sre-lib-head">
          <h2>Track library</h2>
          <button type="button" className="sre-btn is-quiet" onClick={props.onClose}>
            Close
          </button>
        </header>

        <div className="sr-lib-tabs" role="tablist" aria-label="Which tracks">
          <button type="button" role="tab" aria-selected={tab === 'mine'} className={`sr-lib-tab${tab === 'mine' ? ' is-on' : ''}`} data-testid="lib-tab-mine" onClick={() => setTab('mine')}>
            Your tracks
          </button>
          <button type="button" role="tab" aria-selected={tab === 'shared'} className={`sr-lib-tab${tab === 'shared' ? ' is-on' : ''}`} data-testid="lib-tab-shared" onClick={() => setTab('shared')}>
            Shared tracks
          </button>
        </div>

        {tab === 'shared' && <SharedTracks onReady={setReady} onDownloaded={() => setVersion((v) => v + 1)} onOpen={(file) => open(file, false)} />}

        {tab === 'mine' && (
          <>
            <div className="sre-lib-now" data-testid="editor-lib-now">
              <span className="sre-label">Now editing</span>
              <strong>{name}</strong>
              <span className={`sre-save-chip is-${state}`}>{SAVE_STATE_WORDS[state]}</span>
              {state === 'new' && <span className="sre-help">It joins this list when you save it.</span>}
            </div>

            <div className="sre-lib-new">
              <div>
                <span className="sre-label">New track</span>
                <select className="sre-input" value={newWorld} onChange={(e) => setNewWorld(e.target.value)} aria-label="World for the new track">
                  {BASE_WORLDS.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
                <span className="sre-help">{BASE_WORLDS.find((b) => b.id === newWorld)?.blurb}</span>
              </div>
              <button type="button" className="sre-btn is-primary" onClick={startNew}>
                Start drawing
              </button>
            </div>

            {notice && (
              <p className={`sr-lib-notice is-${notice.tone}`} role="status" data-testid="lib-notice">
                {notice.text}
              </p>
            )}

            <ul className="sre-lib-list">
              {tracks.map((t) => (
                <TrackRow key={`${t.source}:${t.id}`} track={t} isOpen={t.source === 'drawn' && t.id === savedId} state={state} onOpen={open} onShare={startShare} onDeleted={() => setVersion((v) => v + 1)} />
              ))}
            </ul>

            <footer className="sre-lib-foot">
              <button type="button" className="sre-btn" onClick={() => fileInput.current?.click()}>
                Import a track file
              </button>
              <button
                type="button"
                className="sre-btn is-quiet"
                disabled={empty}
                title={empty ? 'There is no road to export yet.' : undefined}
                onClick={() => downloadTrack(fileFromDraft(useEditor.getState().draft, useEditor.getState().savedId ?? undefined))}
              >
                {empty ? 'Export this track (no road yet)' : 'Export this track'}
              </button>
              <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={(e) => void onImport(e.target.files?.[0])} />
            </footer>
          </>
        )}
      </div>
      {sharing && (
        <ShareBox
          file={sharing}
          ready={ready}
          changedNotSaved={sharing.id === savedId && state === 'changed'}
          onClose={() => {
            setSharing(null)
            setVersion((v) => v + 1)
          }}
        />
      )}
    </div>
  )
}

/** One track in the list: its name, whose it is, and what you can do with it. The open one is marked and has no Open button. */
function TrackRow(p: { track: TrackListing; isOpen: boolean; state: SaveState; onOpen: (file: TrackFile, asCopy: boolean) => void; onShare: (file: TrackFile) => void; onDeleted: () => void }) {
  const t = p.track
  const from = t.source === 'drawn' ? downloadedFrom(t.id) : null
  // Whether Share will work, and why not, before any click (the button's hover says it; a click says it too).
  const share = t.source === 'drawn' ? canShare(t.file) : null
  return (
    <li className={`sre-lib-row${p.isOpen ? ' is-open' : ''}`} data-testid={p.isOpen ? 'editor-lib-open-row' : undefined}>
      <div className="sre-lib-name">
        <strong>
          {t.name}
          {p.isOpen && <span className={`sre-save-chip is-${p.state}`}>{p.state === 'changed' ? 'Open now, changes not saved' : 'Open now'}</span>}
        </strong>
        <span>
          {t.source === 'builtin' ? 'Built-in' : t.source === 'shared' ? 'From the host' : from ? <span className="sr-lib-from">Shared by {from.madeBy || 'someone'}, from Shared tracks</span> : `Yours${t.author ? `, by ${t.author}` : ''}`}
        </span>
      </div>
      <div className="sre-lib-acts">
        {t.source === 'drawn' ? (
          <>
            {!p.isOpen && (
              <button type="button" className="sre-btn" onClick={() => p.onOpen(t.file, false)}>
                Open
              </button>
            )}
            <button
              type="button"
              className={`sre-btn is-quiet${share?.ok ? '' : ' is-refused'}`}
              aria-disabled={!share?.ok}
              title={share?.ok ? 'Put it on GitHub so other players can download it. You choose the name it shows first.' : share?.why}
              data-testid="lib-share"
              onClick={() => p.onShare(t.file)}
            >
              Share
            </button>
            <button type="button" className="sre-btn is-quiet" onClick={() => downloadTrack(t.file)}>
              Export
            </button>
            <button
              type="button"
              className="sre-btn is-danger"
              onClick={() => {
                if (!window.confirm(`Delete "${t.name}" from this browser? Export it first if you want to keep a copy.`)) return
                deleteDrawnTrack(t.id)
                // If it was the open track, the open one is now a new track that isn't saved.
                forgetDeletedTrack(t.id)
                p.onDeleted()
                say(`Deleted "${t.name}".`, 'info')
              }}
            >
              Delete
            </button>
          </>
        ) : (
          <button type="button" className="sre-btn" onClick={() => p.onOpen(t.file, true)}>
            Copy and edit
          </button>
        )}
      </div>
    </li>
  )
}
