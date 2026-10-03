// ============================================================
//  CLEAR ALL - wipe the map and start again (after asking first)
// ------------------------------------------------------------
//  The eraser on the tool rail (or B on the controller) asks
//  "Clear the whole track? You can undo this." with two buttons:
//
//    Cancel      the safe one, picked to start with
//    Clear all   empties the map: no road at all (draft.ts clearAll),
//                as ONE undo step
//
//  The dice (Random track) asks the same way, because it swaps the
//  whole road for a new one: "Make a random track?", then Cancel or
//  Make one (draft.ts randomRoad, also ONE undo step). On an empty
//  map there is nothing to lose, so the dice roll straight away.
//
//  While the question is up, the game's menu controls drive it (the
//  input context is 'menu', so src/core/input.ts turns keys and pad
//  buttons into menuBus actions): arrows / WASD / d-pad / stick move
//  between the buttons, Enter / Space / A presses one, Esc / B
//  cancels. Tab stays inside the box, and the map ignores the keys
//  and the pad until it closes.
//
//  Esc fires two signals at once (the pause nonce and menu 'back').
//  The 'back' closes the box; the pause press that came with it is
//  remembered (closedAtPause), so EditorUi doesn't also treat it as
//  "leave the editor".
// ============================================================

import { useEffect, useRef } from 'react'
import { create } from 'zustand'
import { controlSignals, menuBus, setInputContext } from '../core/controls'
import { audio } from '../core/api'
import { clearAll, randomRoad, say, useEditor } from './draft'
import { isBlankDraft, isEmptyDraft } from './draftFile'
import { fitToDraft } from './Overlay'
import { ClearIcon, DiceIcon } from './icons'

/** Which question: wipe the map, or swap the road for a random one. */
export type WholeMapQuestion = 'clear' | 'random'

/** Is the question showing, and which one? (A tiny store so the rail, the pad and dev hooks can all open it.) */
export const useClearAsk = create<{ open: boolean; kind: WholeMapQuestion }>(() => ({ open: false, kind: 'clear' }))

/** The pause nonce that was already used up closing the box (see the header). */
let closedAtPause = -1
/** Goes up each time the box opens or closes (the map's pad reader uses it, see Overlay.tsx). */
let askVersion = 0

/**
 * Changes whenever the box opens or closes. The pad is read in two places (the
 * game's input and the map), so in the frame the box closes the map can see the
 * button that closed it still held: it waits for a fresh press when this changes.
 */
export function clearAskVersion(): number {
  return askVersion
}
/** What had the keyboard before the box opened, to give it back after. */
let focusBefore: HTMLElement | null = null
/** True while another dialog (the track library) is open: never stack two. */
let blockedByDialog = false

/** EditorUi tells us when the library is open. */
export function setClearAllBlocked(blocked: boolean): void {
  blockedByDialog = blocked
}

/** Ask "Clear the whole track?". Returns true if the question is now showing. */
export function askClearAll(): boolean {
  const s = useEditor.getState()
  if (s.mode !== 'edit' || blockedByDialog || useClearAsk.getState().open) return false
  if (isBlankDraft(s.draft)) {
    say('Already clear. Draw a loop with the pencil, or press Random track.', 'info')
    return false
  }
  open('clear')
  return true
}

/**
 * The dice: make a random track. On an empty map it is made straight away
 * (returns true); with a road on the map it asks first (returns true if the
 * question is now showing).
 */
export function askRandomTrack(): boolean {
  const s = useEditor.getState()
  if (s.mode !== 'edit' || blockedByDialog || useClearAsk.getState().open) return false
  if (isEmptyDraft(s.draft)) {
    rollTrack()
    return true
  }
  open('random')
  return true
}

function open(kind: WholeMapQuestion): void {
  focusBefore = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
  setInputContext('menu')
  askVersion++
  useClearAsk.setState({ open: true, kind })
}

/** Roll the dice (draft.ts randomRoad) and show the whole new road. */
function rollTrack(): void {
  if (randomRoad()) requestAnimationFrame(fitToDraft)
}

/** Close the question: `yes` true clears the map (or makes the random track), false leaves everything as it was. */
export function answerClearAll(yes: boolean): void {
  if (!useClearAsk.getState().open) return
  const kind = useClearAsk.getState().kind
  closedAtPause = controlSignals.pause
  askVersion++
  useClearAsk.setState({ open: false })
  setInputContext('editor')
  focusBefore?.focus()
  focusBefore = null
  if (yes) {
    if (kind === 'clear') clearAll()
    else rollTrack()
  } else {
    audio.ui('back')
    say(kind === 'clear' ? 'Nothing was cleared.' : 'Your road is still there.', 'info')
  }
}

/**
 * EditorUi's Esc / Menu watcher calls this first with each new pause press.
 * True means the press belonged to this box (it closed it, or had already
 * closed it), so the editor must not also act on it.
 */
export function clearAllTakesPause(pause: number): boolean {
  if (useClearAsk.getState().open) {
    answerClearAll(false)
    return true
  }
  return pause === closedAtPause
}

/** The question itself. Mounted by EditorUi; renders nothing until asked. */
export function ClearAllDialog() {
  const open = useClearAsk((s) => s.open)
  const kind = useClearAsk((s) => s.kind)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const clearRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    // Cancel has the focus to start with, so a quick double press never clears by accident.
    cancelRef.current?.focus()
    const other = () => (document.activeElement === clearRef.current ? cancelRef.current : clearRef.current)
    return menuBus.on((action, device) => {
      if (action === 'back') answerClearAll(false)
      else if (action === 'accept') {
        // Enter and Space press the focused button themselves (a normal click), so only
        // the pad's A presses it from here. With no button focused, accept just picks Cancel.
        const onButton = document.activeElement === clearRef.current || document.activeElement === cancelRef.current
        if (!onButton) cancelRef.current?.focus()
        else if (device === 'gamepad') answerClearAll(document.activeElement === clearRef.current)
      } else if (action === 'left' || action === 'right' || action === 'up' || action === 'down') {
        other()?.focus()
        audio.ui('move')
      }
    })
  }, [open])

  if (!open) return null
  return (
    <div className="sre-modal" onPointerDown={(e) => e.target === e.currentTarget && answerClearAll(false)}>
      <div
        className="sre-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="sre-confirm-title"
        aria-describedby="sre-confirm-text"
        data-testid="editor-clear-confirm"
        onKeyDown={(e) => {
          // Tab and Shift+Tab go between the two buttons and never leave the box.
          if (e.key !== 'Tab') return
          e.preventDefault()
          ;(document.activeElement === clearRef.current ? cancelRef.current : clearRef.current)?.focus()
        }}
      >
        <div className="sre-confirm-icon" aria-hidden>
          {kind === 'clear' ? <ClearIcon /> : <DiceIcon />}
        </div>
        <h2 id="sre-confirm-title">{kind === 'clear' ? 'Clear the whole track?' : 'Make a random track?'}</h2>
        <p id="sre-confirm-text">You can undo this.</p>
        <p className="sre-help">
          {kind === 'clear'
            ? 'The road, pieces, start line, crash props and energy cores all go, and you get an empty map to draw a new road on. The world, name and settings stay.'
            : 'Your road, pieces, start line, crash props and energy cores are swapped for a brand new random road that is ready to drive. The world, name and settings stay.'}{' '}
          Tracks saved in your library only change if you save or test drive.
        </p>
        <div className="sre-confirm-acts">
          <button ref={cancelRef} type="button" className="sre-btn" onClick={() => answerClearAll(false)}>
            Cancel
          </button>
          <button
            ref={clearRef}
            type="button"
            className={`sre-btn ${kind === 'clear' ? 'is-danger' : 'is-primary'}`}
            onClick={() => answerClearAll(true)}
            data-testid={kind === 'clear' ? 'editor-clear-yes' : 'editor-random-yes'}
          >
            {kind === 'clear' ? 'Clear all' : 'Make one'}
          </button>
        </div>
        <p className="sre-confirm-keys">
          <kbd>Esc</kbd> or the controller's <kbd>B</kbd> cancels
        </p>
      </div>
    </div>
  )
}
