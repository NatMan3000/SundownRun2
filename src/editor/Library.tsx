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
// ============================================================

import { useMemo, useRef, useState } from 'react'
import { audio } from '../core/api'
import { type TrackListing, deleteDrawnTrack, downloadTrack, importTrackJson, listDrawnTracks, listTracks } from '../track/registry'
import type { TrackFile } from '../track/schema'
import { BASE_WORLDS, isEmptyDraft } from './draftFile'
import { type SaveState, SAVE_STATE_WORDS, draftFromFile, freeIdFor, freeName, fileFromDraft, forgetDeletedTrack, replaceDraft, saveState, say, useEditor } from './draft'
import { askBeforeLeavingTrack, askNewTrack } from './askFirst'
import { fitToDraft } from './Overlay'
import { DRIVE_TRACK_ID } from './driveToDraw'

export function Library(props: { onClose: () => void }) {
  const [version, setVersion] = useState(0)
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
  const onImport = async (file: File | undefined) => {
    if (!file) return
    const { text, renamed } = keepOthersSafe(await file.text())
    const result = importTrackJson(text)
    if (!result.ok) {
      audio.ui('error')
      const why = result.errors[0]?.message ?? ''
      // A broken file (cut off, or edited by hand) fails as JSON: say that in plain words.
      const plain = why.startsWith('Not valid JSON') ? "it isn't a complete track file (it may be cut off, or something was typed into it by mistake)" : why || 'something in it is wrong'
      say(`That file isn't a track this game can load: ${plain}.`, 'bad')
      return
    }
    setVersion((v) => v + 1)
    const name = result.track?.name ?? file.name
    say(renamed ? `Imported it as "${name}": there's already a track called "${renamed}" in your Library, and that one stays as it is.` : `Imported "${name}". It's in your tracks now.`, 'good')
    audio.ui('select')
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

        <ul className="sre-lib-list">
          {tracks.map((t) => (
            <TrackRow key={`${t.source}:${t.id}`} track={t} isOpen={t.source === 'drawn' && t.id === savedId} state={state} onOpen={open} onDeleted={() => setVersion((v) => v + 1)} />
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
      </div>
    </div>
  )
}

/** One track in the list: its name, whose it is, and what you can do with it. The open one is marked and has no Open button. */
function TrackRow(p: { track: TrackListing; isOpen: boolean; state: SaveState; onOpen: (file: TrackFile, asCopy: boolean) => void; onDeleted: () => void }) {
  const t = p.track
  return (
    <li className={`sre-lib-row${p.isOpen ? ' is-open' : ''}`} data-testid={p.isOpen ? 'editor-lib-open-row' : undefined}>
      <div className="sre-lib-name">
        <strong>
          {t.name}
          {p.isOpen && <span className={`sre-save-chip is-${p.state}`}>{p.state === 'changed' ? 'Open now, changes not saved' : 'Open now'}</span>}
        </strong>
        <span>{t.source === 'builtin' ? 'Built-in' : t.source === 'shared' ? 'From the host' : `Yours${t.author ? `, by ${t.author}` : ''}`}</span>
      </div>
      <div className="sre-lib-acts">
        {t.source === 'drawn' ? (
          <>
            {!p.isOpen && (
              <button type="button" className="sre-btn" onClick={() => p.onOpen(t.file, false)}>
                Open
              </button>
            )}
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

/**
 * An imported track never lands on top of one already saved here: if its id
 * is taken it gets a free one, and if its name is taken it gets the next free
 * number ("Canyon Run 2"). Returns the file's text to import, and the name it
 * had if it was renamed. Text that isn't a track goes through untouched (the
 * import says what is wrong with it).
 */
function keepOthersSafe(text: string): { text: string; renamed: string | null } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { text, renamed: null }
  }
  if (!parsed || typeof parsed !== 'object') return { text, renamed: null }
  const file = parsed as { id?: unknown; name?: unknown }
  if (typeof file.id !== 'string' || typeof file.name !== 'string') return { text, renamed: null }
  const idTaken = listDrawnTracks().some((t) => t.id === file.id)
  const name = freeName(file.name)
  if (!idTaken && name === file.name.trim()) return { text, renamed: null }
  const was = file.name
  file.name = name
  if (idTaken) file.id = freeIdFor(name)
  return { text: JSON.stringify(file), renamed: name !== was.trim() ? was : null }
}
