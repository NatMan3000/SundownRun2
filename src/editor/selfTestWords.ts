// ============================================================
//  SELF-TEST: THE EDITOR'S WORDS ON A PHONE - rows for selfTest.ts
// ------------------------------------------------------------
//  phoneWords.ts says the editor's mouse-and-keyboard lines for a
//  finger. These rows pin the hand-written ones (what a computer
//  reads, what a phone reads) and prove the plain swaps leave
//  nothing behind: no click, mouse, wheel, Shift, Esc, "press" or
//  "the panel" in a phone's line, and a computer's line untouched.
//  The real screen is scenario 25 of scripts/editor-touch-check.ts.
// ============================================================

import { PLACE_TOOLS } from './pieces'
import { phoneWords } from './phoneWords'

type Check = (name: string, fn: () => string[] | string) => void

/** What a phone must never be told (the phone gate's rule 8, and the editor's own). */
const KEY_WORDS = /click|\bmouse\b|\bwheel\b|\bEsc\b|\bEscape\b|\bShift\b|\bpanel\b|hover|right-drag|middle-drag|\bpress |\[ and \]|on the right|keyboard|controller|WASD|\b(?:Enter|Return|Space|Spacebar|Backspace|Tab|Ctrl|Control|Alt|Cmd|arrow keys?|any key)\b/i

/** The hand-written lines: [what a computer reads, what a phone reads]. */
const HAND_LINES: [string, string][] = [
  ['Hold the left mouse button and draw a loop. Let go and it becomes a road. Or press Random track.', 'Put a finger down and draw a loop. Lift it and it becomes a road. Or tap Random track.'],
  ['Hold the mouse button down and draw: start on the road and end back on the road to redraw the bit in between.', 'Keep a finger down and draw: start on the road and end back on the road to redraw the bit in between.'],
  ['Hold the mouse button down on the road and drag to bend it.', 'Put a finger on the road and drag to bend it.'],
  ['Hold Shift while you draw for a dead straight line. Let go of Shift to carry on freehand.', 'While you draw, tap Straight line with your other thumb for a dead straight line. Tap it again to carry on freehand.'],
  ['Straight line: let go of Shift to carry on drawing freehand.', 'Straight line: tap it again to carry on drawing freehand.'],
  ['How much road comes with your hand. While you drag: mouse wheel, or [ and ].', 'How much road comes with your hand. While you drag, tap - or + with your other thumb.'],
  ['Pull less, or roll the mouse wheel for a longer reach.', 'Pull less, or tap + while you drag for a longer reach.'],
  ['Let go to keep the bend, or press Esc to put it back.', 'Let go to keep the bend, or tap Cancel to put it back.'],
  ['Pull the middle out, then click.', 'Put a finger down and pull the middle out, then let go.'],
  ['Now move the mouse to pull the middle of the curve out, and click.', 'Now put a finger down and slide to pull the curve out, then let go.'],
  ['Click to make it straight.', 'Let go to make it straight.'],
  ['Your line trails a little behind the mouse, so a shaky hand still draws a smooth road. Turn it up for smoother, down for more control.', 'Your line trails a little behind your finger, so a shaky hand still draws a smooth road. Turn it up for smoother, down to follow your finger more closely.'],
  ['Red means too tight for a car. Esc starts again.', 'Red means too tight for a car. Cancel starts again.'],
  ['Set its tilt, in the panel on the right.', 'Set its tilt on the card.'],
  ['Click it to change its height.', 'Tap it with the Height tool to change its height.'],
  ['Click it to pick which road goes under.', 'Tap it with the Select tool to pick which road goes under.'],
  ['There\'s no crossing there any more. Click a BRIDGE label on the map.', 'There\'s no crossing there any more. Pick Select, then tap a BRIDGE label on the map.'],
  ['Random track: a circuit, 2.1 km. Press it again for another, or Undo.', 'Random track: a circuit, 2.1 km. Tap Random track in the Menu for another, or Undo.'],
  ['Right-drag to look round. Middle-drag or Space + drag to move. Wheel to zoom. Every tool works here too.', 'Two fingers: drag moves, pinch zooms, twist turns. Every tool works here too.'],
  ['Picked the raised road: 4 m up at its highest. Change its height in the panel, or press On the ground to put it back down.', 'Picked the raised road: 4 m up at its highest. Change its height on the card, or tap On the ground to put it back down.'],
  ['Click the road where the straight starts.', 'Tap the road where the straight starts.'],
  ['Double-click the road to add a point.', 'Double-tap the road to add a point.'],
]

export function wordsRows(check: Check): void {
  check('words on a phone: the hand-written lines say what a finger does', () => {
    const bad: string[] = []
    for (const [desktop, phone] of HAND_LINES) {
      const got = phoneWords(desktop)
      if (got !== phone) bad.push(`"${desktop.slice(0, 60)}" came out "${got}", wanted "${phone}"`)
      if (KEY_WORDS.test(phone)) bad.push(`the wanted line "${phone.slice(0, 60)}" still names a key`)
    }
    return bad.length ? bad : `${HAND_LINES.length} lines`
  })
  check('words on a phone: the piece blurbs name no click', () => {
    const bad = PLACE_TOOLS.map((t) => [t.label, phoneWords(t.blurb)]).filter(([, line]) => KEY_WORDS.test(line)).map(([label, line]) => `${label}: ${line.slice(0, 80)}`)
    return bad.length ? bad : `${PLACE_TOOLS.length} blurbs`
  })
  check('words on a phone: a line with nothing to change comes back the same', () => {
    const lines = ['Drag along the road to pick a stretch.', 'Tap the road where the straight starts.', 'Fix it moves the start line to the nearest straight.']
    const bad = lines.filter((l) => phoneWords(l) !== l)
    return bad.length ? bad : 'unchanged'
  })
}
