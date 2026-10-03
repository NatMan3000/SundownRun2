// ============================================================
//  ASK FIRST - nothing is lost without a question
// ------------------------------------------------------------
//  Before the editor leaves the track you are on (New track, Random
//  track on a saved track, opening another track from the Library,
//  or leaving the editor), it checks for changes that aren't saved.
//  If there are some it asks, with three buttons:
//
//    Cancel      the safe one, picked to start with: nothing happens
//    Don't save  go on anyway (after New track or Random track, Undo
//                still brings the changes back)
//    Save it     save the track first (draft.ts saveDraft), then go on;
//                if it can't be saved, nothing else happens and the
//                status line says why
//
//  With nothing unsaved it just goes: the track you were on is safe
//  in your Library already.
//
//  The dice on a new track that was never saved ask their own old
//  question, "Make a random track?" (Cancel or Make one), because
//  there the new road replaces the road on the map.
//
//  This file is the questions' logic (no buttons): AskFirstBox.tsx draws
//  the box. Keeping them apart lets the editor's self-test press the
//  same buttons without a browser.
// ============================================================

import { create } from 'zustand'
import { controlSignals, setInputContext } from '../core/controls'
import { audio } from '../core/api'
import { hasUnsavedWork, newTrack, randomRoad, saveDraft, say, useEditor } from './draft'
import { isBlankDraft, isEmptyDraft } from './draftFile'

/** Which question: save first (before leaving this track), or swap a new track's road for a random one. */
export type AskKind = 'unsaved' | 'random'

/** What happens after Save it or Don't save (it changes the question's words). */
export type NextStep = 'new' | 'random' | 'open' | 'exit'

/** The buttons: Save it, Don't save and Cancel ('yes' is the random question's Make one). */
export type AskAnswer = 'save' | 'discard' | 'cancel' | 'yes'

export interface AskState {
  open: boolean
  kind: AskKind
  next: NextStep
  /** The track this question is about (its name now). */
  name: string
  /** True if that track is saved in the Library (its changes aren't); false if it was never saved. */
  saved: boolean
  /** The track about to be opened, for 'open'. */
  target: string
}

/** Is a question showing, and which one? (A tiny store so the rail, the pad, the Library and dev hooks can all open it.) */
export const useAsk = create<AskState>(() => ({ open: false, kind: 'unsaved', next: 'new', name: '', saved: false, target: '' }))

/** What to do after Save it or Don't save. */
let pending: (() => void) | null = null
/** The pause nonce that was already used up closing the box (see AskFirstBox.tsx). */
let closedAtPause = -1
/** Goes up each time the box opens or closes (the map's pad reader uses it, see Overlay.tsx). */
let version = 0
/** When the box last opened (performance.now()), so the second click of a double-click can't close it at once. */
let openedAt = -Infinity
/** What had the keyboard before the box opened, to give it back after. */
let focusBefore: HTMLElement | null = null
/** True while another dialog (the track library) is open: the rail and the pad never stack a second one. */
let blockedByDialog = false
/** Frames the whole road on the map after the dice (AskFirstBox.tsx sets it: the map's view lives in Overlay.tsx). */
let showWholeRoad: () => void = () => {}

/**
 * Changes whenever the box opens or closes. The pad is read in two places (the
 * game's input and the map), so in the frame the box closes the map can see the
 * button that closed it still held: it waits for a fresh press when this changes.
 */
export function askVersion(): number {
  return version
}

/**
 * True for a moment after the box opens: a click outside it then is the second
 * click of a double-click on the button that opened it, not "never mind".
 */
export function askJustOpened(): boolean {
  return typeof performance !== 'undefined' && performance.now() - openedAt < 450
}

/** EditorUi tells us when the library is open. */
export function setAskBlocked(blocked: boolean): void {
  blockedByDialog = blocked
}

/** AskFirstBox.tsx hands over the map's "fit the track" here. */
export function setShowWholeRoad(fn: () => void): void {
  showWholeRoad = fn
}

function open(kind: AskKind, next: NextStep, target = ''): void {
  if (typeof document !== 'undefined') {
    focusBefore = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
  }
  setInputContext('menu')
  version++
  openedAt = typeof performance !== 'undefined' ? performance.now() : 0
  const s = useEditor.getState()
  useAsk.setState({ open: true, kind, next, name: s.draft.name.trim() || 'My Track', saved: !!s.savedId, target })
}

function close(): void {
  closedAtPause = controlSignals.pause
  version++
  useAsk.setState({ open: false })
  setInputContext('editor')
  focusBefore?.focus()
  focusBefore = null
}

/**
 * Leave the track you are on (to start another, open another, or leave the
 * editor): `then` runs straight away if nothing would be lost, or after Save it
 * or Don't save. Returns true if `then` ran or the question is now showing.
 */
export function askBeforeLeavingTrack(next: NextStep, then: () => void, target = ''): boolean {
  if (useAsk.getState().open) return false
  if (!hasUnsavedWork()) {
    then()
    return true
  }
  pending = then
  open('unsaved', next, target)
  audio.ui('move')
  return true
}

/**
 * New track (the rail, or the pad's B). With `baseWorldId` (the Library's New
 * track) it starts in that world; `after` runs once the new track is there.
 * Returns true if it happened or the question is showing.
 */
export function askNewTrack(baseWorldId?: string, after?: () => void): boolean {
  const s = useEditor.getState()
  if (s.mode !== 'edit' || useAsk.getState().open) return false
  if (blockedByDialog && !after) return false
  if (!s.savedId && isBlankDraft(s.draft) && (!baseWorldId || baseWorldId === s.draft.baseWorld)) {
    // Already a new, empty track: newTrack says so.
    newTrack(baseWorldId)
    after?.()
    return false
  }
  return askBeforeLeavingTrack('new', () => {
    if (newTrack(baseWorldId)) after?.()
  })
}

/**
 * The dice: make a random track. On an empty map it rolls straight away. On a
 * saved track the new road is a new track (the saved one stays as it is), so it
 * only asks if there are changes not saved. On a new track that has a road, it
 * asks "Make a random track?" first. Returns true if it rolled or a question is showing.
 */
export function askRandomTrack(): boolean {
  const s = useEditor.getState()
  if (s.mode !== 'edit' || blockedByDialog || useAsk.getState().open) return false
  if (s.savedId) return askBeforeLeavingTrack('random', rollTrack)
  if (isEmptyDraft(s.draft)) {
    rollTrack()
    return true
  }
  open('random', 'random')
  audio.ui('move')
  return true
}

/** Roll the dice (draft.ts randomRoad) and show the whole new road. */
function rollTrack(): void {
  if (randomRoad()) showWholeRoad()
}

/**
 * A button was pressed. Cancel leaves everything as it was. Save it saves
 * first and only goes on if that worked. Don't save (or Make one) goes on.
 */
export function answerAsk(answer: AskAnswer): void {
  const st = useAsk.getState()
  if (!st.open) return
  const then = pending
  pending = null
  close()
  if (answer === 'cancel') {
    audio.ui('back')
    say(st.kind === 'random' ? 'Your road is still there.' : st.next === 'exit' ? 'Still here: nothing changed.' : 'Nothing changed.', 'info')
    return
  }
  if (st.kind === 'random') {
    rollTrack()
    return
  }
  if (answer === 'save' && !saveDraft()) {
    // saveDraft said why on the status line; the track stays open, nothing else happens.
    return
  }
  then?.()
}

/**
 * EditorUi's Esc / Menu watcher calls this first with each new pause press.
 * True means the press belonged to the box (it closed it, or had already
 * closed it), so the editor must not also act on it.
 */
export function askTakesPause(pause: number): boolean {
  if (useAsk.getState().open) {
    answerAsk('cancel')
    return true
  }
  return pause === closedAtPause
}
