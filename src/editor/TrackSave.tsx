// ============================================================
//  TRACK SAVE - which track this is, is it saved, and the buttons
// ------------------------------------------------------------
//  Two pieces of the panel (Panel.tsx):
//
//    SaveStateLine  right under the track's name: one of
//                     New, not saved yet   (cyan: never saved)
//                     Saved                (mint: just as in the Library)
//                     Changes not saved    (amber: Save keeps them)
//
//    TrackActions   the buttons at the bottom of the panel, with one
//                   line above them saying exactly what Save will do
//                   ("Save updates "Canyon Run" in your Library"):
//                     Save               saves THIS track, never another
//                     Save as new track  a copy under a new name, and
//                                        you carry on with the copy
//                     Test drive         saves, then drives it
//                     Library, Exit
//
//  The saving itself is in draft.ts (saveDraft, saveAsNewTrack).
// ============================================================

import { useMemo } from 'react'
import { audio } from '../core/api'
import { isEmptyDraft } from './draftFile'
import { type SaveState, SAVE_STATE_WORDS, hasUnsavedWork, saveAsNewTrack, saveDraft, saveState, savedName, testDrive, useEditor } from './draft'

/** What each state adds, in a quieter voice, after its name. */
const MORE: Record<SaveState, string> = {
  new: 'Save puts it in your Library',
  saved: 'in your Library',
  changed: 'Save keeps them',
}

/** A tiny mark for each state, so it never rests on colour alone: a plus, a tick, a dot. */
function StateMark(p: { state: SaveState }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {p.state === 'saved' ? <path d="M3 8.5l3.2 3.2L13 4.8" /> : p.state === 'changed' ? <circle cx="8" cy="8" r="3.6" fill="currentColor" stroke="none" /> : <path d="M8 3.5v9M3.5 8h9" />}
    </svg>
  )
}

/** Under the track's name in the header: is this track saved? */
export function SaveStateLine() {
  const state = useEditor((s) => saveState(s))
  return (
    <div className={`sre-save-state is-${state}`} data-testid="editor-save-state" data-state={state}>
      <StateMark state={state} />
      <strong>{SAVE_STATE_WORDS[state]}</strong>
      <span>{MORE[state]}</span>
    </div>
  )
}

/** The panel's bottom buttons, and the line above them that says what Save does. */
export function TrackActions(p: { onLibrary: () => void; onExit: () => void }) {
  const state = useEditor((s) => saveState(s))
  const empty = useEditor((s) => isEmptyDraft(s.draft))
  const name = useEditor((s) => s.draft.name.trim() || 'My Track')
  const savedId = useEditor((s) => s.savedId)
  const dirty = useEditor((s) => s.dirty)
  const unsaved = useEditor((s) => hasUnsavedWork(s))
  // The name it is saved under (read from the Library only when that can have changed, not on every edit).
  const was = useMemo(() => savedName(savedId), [savedId, dirty])

  const says = empty
    ? 'Draw a road first, then you can save it and test drive it.'
    : state === 'new'
      ? `Save puts "${name}" in your Library as a new track.`
      : state === 'saved'
        ? `"${name}" is saved in your Library.`
        : was && was !== name
          ? `Save renames "${was}" to "${name}" and keeps your changes.`
          : `Save updates "${name}" in your Library.`

  return (
    <div className="sre-actions">
      <p className="sre-help sre-actions-why" data-testid="editor-save-says">
        {says}
      </p>
      <button type="button" className={`sre-btn${unsaved ? ' is-due' : ''}`} onClick={() => saveDraft() && audio.ui('select')} disabled={empty} data-testid="editor-save">
        Save
      </button>
      <button
        type="button"
        className="sre-btn is-quiet sre-save-new"
        onClick={() => saveAsNewTrack() && audio.ui('select')}
        disabled={empty || state === 'new'}
        title={state === 'new' ? "This track isn't saved yet, so Save already makes it a new track." : `Saves a copy under a new name and you carry on with the copy. "${was ?? name}" stays as you last saved it.`}
        data-testid="editor-save-new"
      >
        Save as new track
      </button>
      <button type="button" className="sre-btn is-primary" onClick={testDrive} disabled={empty} data-testid="editor-test-drive">
        Test drive
      </button>
      <button type="button" className="sre-btn" onClick={p.onLibrary} data-testid="editor-library">
        Library
      </button>
      <button type="button" className="sre-btn is-quiet" onClick={p.onExit} data-testid="editor-exit">
        Exit
      </button>
    </div>
  )
}
