// ============================================================
//  TRACK LIBRARY - open, start, copy, import and export tracks
// ------------------------------------------------------------
//  The editor's file manager. Your tracks are saved in this browser;
//  built-in tracks can be copied and edited; a .json track file from
//  a friend can be imported (and it then shows up in the game's
//  track list too). Export saves the exact file that can go straight
//  into the game's tracks/ folder.
// ============================================================

import { useMemo, useRef, useState } from 'react'
import { audio } from '../core/api'
import { deleteDrawnTrack, downloadTrack, importTrackJson, listTracks } from '../track/registry'
import type { TrackFile } from '../track/schema'
import { BASE_WORLDS } from './draftFile'
import { draftFromFile, fileFromDraft, newDraft, replaceDraft, say, useEditor } from './draft'
import { fitToDraft, pencilHint } from './Overlay'
import { DRIVE_TRACK_ID } from './driveToDraw'

export function Library(props: { onClose: () => void }) {
  const [version, setVersion] = useState(0)
  const tracks = useMemo(() => listTracks().filter((t) => t.id !== DRIVE_TRACK_ID), [version])
  const fileInput = useRef<HTMLInputElement>(null)
  const [newWorld, setNewWorld] = useState(BASE_WORLDS[0].id)
  const dirty = useEditor((s) => s.dirty)

  const open = (file: TrackFile, asCopy: boolean) => {
    if (dirty && !window.confirm('Your changes to this track are not saved. Open another one anyway?')) return
    audio.ui('select')
    replaceDraft(draftFromFile(file, asCopy), asCopy ? null : file.id)
    requestAnimationFrame(fitToDraft)
    say(asCopy ? `Editing a copy of "${file.name}". Save it to keep it.` : `Opened "${file.name}".`, 'good')
    props.onClose()
  }
  const startNew = () => {
    if (dirty && !window.confirm('Your changes to this track are not saved. Start a new one anyway?')) return
    audio.ui('select')
    replaceDraft(newDraft(newWorld), null)
    requestAnimationFrame(fitToDraft)
    pencilHint()
    props.onClose()
  }
  const onImport = async (file: File | undefined) => {
    if (!file) return
    const text = await file.text()
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
    say(`Imported "${result.track?.name ?? file.name}". It's in your tracks now.`, 'good')
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
            <li key={`${t.source}:${t.id}`} className="sre-lib-row">
              <div className="sre-lib-name">
                <strong>{t.name}</strong>
                <span>{t.source === 'builtin' ? 'Built-in' : t.source === 'shared' ? 'From the host' : `Yours${t.author ? `, by ${t.author}` : ''}`}</span>
              </div>
              <div className="sre-lib-acts">
                {t.source === 'drawn' ? (
                  <>
                    <button type="button" className="sre-btn" onClick={() => open(t.file, false)}>
                      Open
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
                        const s = useEditor.getState()
                        if (s.savedId === t.id) {
                          // Same road, just no longer saved: the checks already run on it still count.
                          const draft = { ...s.draft, id: '' }
                          useEditor.setState({ savedId: null, dirty: true, draft, checkedDraft: s.checkedDraft === s.draft ? draft : s.checkedDraft })
                        }
                        setVersion((v) => v + 1)
                        say(`Deleted "${t.name}".`, 'info')
                      }}
                    >
                      Delete
                    </button>
                  </>
                ) : (
                  <button type="button" className="sre-btn" onClick={() => open(t.file, true)}>
                    Copy and edit
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>

        <footer className="sre-lib-foot">
          <button type="button" className="sre-btn" onClick={() => fileInput.current?.click()}>
            Import a track file
          </button>
          <button type="button" className="sre-btn is-quiet" onClick={() => downloadTrack(fileFromDraft(useEditor.getState().draft, useEditor.getState().savedId ?? undefined))}>
            Export this track
          </button>
          <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={(e) => void onImport(e.target.files?.[0])} />
        </footer>
      </div>
    </div>
  )
}
