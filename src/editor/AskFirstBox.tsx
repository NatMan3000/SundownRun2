// ============================================================
//  ASK FIRST BOX - "Save "Canyon Run" first?" and "Make a random track?"
// ------------------------------------------------------------
//  The box for the questions in askFirst.ts. Leaving a track with
//  changes that aren't saved asks:
//
//    Save "Canyon Run" first?      Cancel | Don't save | Save it
//
//  and the dice on a new track's road ask:
//
//    Make a random track?          Cancel | Make one
//
//  Cancel has the focus to start with, so a quick double press never
//  throws anything away, and a click outside the box (Cancel too) only
//  counts once the box has been up for a moment (a double-click on the
//  button that opened it would otherwise close it at once). While the box is up, the game's menu controls
//  drive it (the input context is 'menu', so src/core/input.ts turns
//  keys and pad buttons into menuBus actions): arrows / WASD / d-pad /
//  stick move between the buttons, Enter / Space / A presses one,
//  Esc / B cancels. Tab stays inside the box, and the map ignores the
//  keys and the pad until it closes.
//
//  Esc fires two signals at once (the pause nonce and menu 'back').
//  The 'back' closes the box; the pause press that came with it is
//  remembered (askFirst.ts askTakesPause), so EditorUi doesn't also
//  treat it as "leave the editor".
// ============================================================

import { useEffect, useRef } from 'react'
import { menuBus } from '../core/controls'
import { audio } from '../core/api'
import { type AskAnswer, type AskState, answerAsk, askJustOpened, setShowWholeRoad, useAsk } from './askFirst'
import { fitToDraft } from './Overlay'
import { DiceIcon, SaveIcon } from './icons'

setShowWholeRoad(() => requestAnimationFrame(fitToDraft))

/** The question's words, in Josh's language. */
function words(a: AskState): { title: string; text: string; help: string } {
  if (a.kind === 'random') {
    return {
      title: 'Make a random track?',
      text: 'You can undo this.',
      help: `The road, pieces, start line, crash props and energy cores of "${a.name}" are swapped for a brand new random road that is ready to drive. The world, name and settings stay.`,
    }
  }
  const before = {
    new: 'before you start a new track',
    random: 'before the dice make a new track',
    open: `before you open "${a.target}"`,
    exit: 'before you leave the editor',
  }[a.next]
  const text = a.saved ? `It has changes that aren't saved yet. Save them ${before}?` : `It isn't saved in your Library yet. Save it ${before}?`
  const help = {
    new: "Don't save starts the new track anyway, and Undo can still bring this one back.",
    random: "Don't save rolls the dice anyway, and Undo can still bring this one back.",
    open: a.saved ? "Don't save opens the other track, and these changes are gone for good." : "Don't save opens the other track, and this one is gone for good.",
    exit: "Don't save leaves it here in the editor for next time, but it won't be in your Library or the track list.",
  }[a.next]
  return { title: `Save "${a.name}" first?`, text, help }
}

/** The question itself. Mounted by EditorUi; renders nothing until asked. */
export function AskFirstDialog() {
  const ask = useAsk()
  const buttons = useRef<(HTMLButtonElement | null)[]>([])

  useEffect(() => {
    if (!ask.open) return
    // Cancel (the first button) has the focus to start with.
    buttons.current[0]?.focus()
    const list = () => buttons.current.filter((b): b is HTMLButtonElement => !!b)
    const step = (by: number) => {
      const all = list()
      const at = all.indexOf(document.activeElement as HTMLButtonElement)
      all[(Math.max(0, at) + by + all.length) % all.length]?.focus()
    }
    return menuBus.on((action, device) => {
      if (action === 'back') answerAsk('cancel')
      else if (action === 'accept') {
        // Enter and Space press the focused button themselves (a normal click), so only
        // the pad's A presses it from here. With no button focused, accept just picks Cancel.
        const on = list().find((b) => b === document.activeElement)
        if (!on) buttons.current[0]?.focus()
        else if (device === 'gamepad') on.click()
      } else if (action === 'left' || action === 'up') {
        step(-1)
        audio.ui('move')
      } else if (action === 'right' || action === 'down') {
        step(1)
        audio.ui('move')
      }
    })
  }, [ask.open])

  if (!ask.open) return null
  const w = words(ask)
  const acts: { answer: AskAnswer; label: string; className: string; testid: string }[] =
    ask.kind === 'random'
      ? [
          { answer: 'cancel', label: 'Cancel', className: 'sre-btn', testid: 'editor-ask-cancel' },
          { answer: 'yes', label: 'Make one', className: 'sre-btn is-primary', testid: 'editor-random-yes' },
        ]
      : [
          { answer: 'cancel', label: 'Cancel', className: 'sre-btn', testid: 'editor-ask-cancel' },
          { answer: 'discard', label: "Don't save", className: 'sre-btn is-danger', testid: 'editor-ask-discard' },
          { answer: 'save', label: 'Save it', className: 'sre-btn is-primary', testid: 'editor-ask-save' },
        ]
  buttons.current.length = acts.length
  return (
    <div className="sre-modal sre-ask-modal" onPointerDown={(e) => e.target === e.currentTarget && !askJustOpened() && answerAsk('cancel')}>
      <div
        className="sre-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="sre-confirm-title"
        aria-describedby="sre-confirm-text"
        data-testid="editor-ask"
        data-ask={ask.kind === 'random' ? 'random' : ask.next}
        onKeyDown={(e) => {
          // Tab and Shift+Tab go round the buttons and never leave the box.
          if (e.key !== 'Tab') return
          e.preventDefault()
          const all = buttons.current.filter((b): b is HTMLButtonElement => !!b)
          const at = all.indexOf(document.activeElement as HTMLButtonElement)
          all[(Math.max(0, at) + (e.shiftKey ? -1 : 1) + all.length) % all.length]?.focus()
        }}
      >
        <div className={`sre-confirm-icon${ask.kind === 'unsaved' ? ' is-save' : ''}`} aria-hidden>
          {ask.kind === 'random' ? <DiceIcon /> : <SaveIcon />}
        </div>
        <h2 id="sre-confirm-title">{w.title}</h2>
        <p id="sre-confirm-text">{w.text}</p>
        <p className="sre-help">{w.help}</p>
        <div className={`sre-confirm-acts is-${acts.length}`}>
          {acts.map((a, i) => (
            <button
              key={a.answer}
              ref={(el) => {
                buttons.current[i] = el
              }}
              type="button"
              className={a.className}
              onClick={() => answerAsk(a.answer)}
              data-testid={a.testid}
            >
              {a.label}
            </button>
          ))}
        </div>
        <p className="sre-confirm-keys">
          <kbd>Esc</kbd> or the controller's <kbd>B</kbd> cancels
        </p>
      </div>
    </div>
  )
}
