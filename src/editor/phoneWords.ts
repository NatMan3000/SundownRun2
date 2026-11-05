// ============================================================
//  PHONE WORDS - the Road Editor's lines, said for a finger
// ------------------------------------------------------------
//  The editor's messages, tips and help were written for a mouse and a
//  keyboard: they say click, mouse, wheel, Shift, Esc, "the panel on the
//  right". Those lines are stored (and read on a computer) exactly as
//  they are. On a phone they are changed here, at the point of display:
//
//    words(text)   what a component shows. On a computer it is the
//                  text itself, the same string, so a computer can't
//                  tell this file is here. On touch it is phoneWords.
//
//  phoneWords is two lists, in this order:
//    HAND   a line that needs a thumb's own sentence (a key, the wheel,
//           Esc, "hold the mouse button"). Each says what a finger
//           really does, checked against mapGestures.ts, ThumbButtons.tsx
//           and the touch branches in Overlay.tsx.
//    SWAPS  the plain words: click is tap, press is tap, the panel is the card.
//
//  A line that names a key and is in neither list still shows as it
//  was: scenario 25 of scripts/editor-touch-check.ts and the phone
//  gate's rule 8 fail it, which is how a new one gets found.
// ============================================================

import { useGame } from '../core/store'

/** Whole sentences (or the part of one) that need a different meaning, not a different word. */
const HAND: [RegExp, string][] = [
  // ---- the pencil
  [/Hold the left mouse button and draw a loop\. Let go and it becomes a road\. Or press Random track\./g, 'Put a finger down and draw a loop. Lift it and it becomes a road. Or tap Random track.'],
  [/Hold the mouse button down and draw:/g, 'Keep a finger down and draw:'],
  [/Hold Shift (?:while you draw )?for a (?:dead )?straight line\. Let go of Shift to carry on freehand\./g, 'While you draw, tap Straight line with your other thumb for a dead straight line. Tap it again to carry on freehand.'],
  [/Hold Shift (?:while you draw )?for a straight line/g, 'Tap Straight line while you draw for a straight line'],
  [/let go of Shift to carry on drawing freehand/g, 'tap it again to carry on drawing freehand'],
  [/behind the mouse/g, 'behind your finger'],
  // ("control" is one of the phone gate's key words, so it can't stay)
  [/down for more control/g, 'down to follow your finger more closely'],
  // ---- Bend: the reach is the - and + beside the thumb while a finger drags
  [/While you drag: mouse wheel, or \[ and \]\./g, 'While you drag, tap - or + with your other thumb.'],
  [/The mouse wheel \(or \[ and \]\) changes how much road comes with it\./g, 'While you drag, the - and + buttons change how much road comes with it.'],
  [/Mouse wheel: how much\./g, 'While you drag, - and + say how much.'],
  [/\(mouse wheel while you drag\)/g, '(tap + while you drag)'],
  [/roll the mouse wheel for a longer reach/g, 'tap + while you drag for a longer reach'],
  [/roll the mouse wheel to bring more road along/g, 'tap + to bring more road along'],
  [/Hold the mouse button down on the road and drag to bend it\./g, 'Put a finger on the road and drag to bend it.'],
  [/press Esc to put it back/g, 'tap Cancel to put it back'],
  // ---- Straight and Curve: a finger shows the line while it is down and makes it as it lifts
  [/Pull the middle out, then click\./g, 'Put a finger down and pull the middle out, then let go.'],
  [/Now move the mouse to pull the middle of the curve out, and click\./g, 'Now put a finger down and slide to pull the curve out, then let go.'],
  [/Click to make it straight\./g, 'Let go to make it straight.'],
  [/Click to make the curve\./g, 'Let go to make the curve.'],
  [/Esc starts again/g, 'Cancel starts again'],
  // ---- Select
  [/Delete removes it/g, 'Delete on its card removes it'],
  // ---- the stretch tools: the card is the panel
  [/,? in the panel on the right/g, ' on the card'],
  [/the Checks panel/g, 'Checks'],
  // ---- Place
  [/before you click \(/g, 'while your finger is down ('],
  // ---- the Map key (Menu): a label answers a tap only with the tool that changes it (P10)
  [/Click it to change its height\./g, 'Tap it with the Height tool to change its height.'],
  [/Click it to change it, or put it back to Auto\./g, 'Tap it with the Bank tool to change it, or put it back to Auto.'],
  [/Click it to change it\./g, 'Tap it with the Width tool to change it.'],
  [/Click it to (pick which road goes (?:over|under)|fix it)\./g, 'Tap it with the Select tool to $1.'],
  [/Click a BRIDGE label on the map\./g, 'Pick Select, then tap a BRIDGE label on the map.'],
  // ---- buttons that live in the Menu, said from the map
  [/Press it again for another, or Undo\./g, 'Tap Random track in the Menu for another, or Undo.'],
  [/Press Random track again\./g, 'Tap Random track in the Menu again.'],
  [/Press New track first, then Drive to draw\./g, 'Tap Menu, then New track, then Drive to draw.'],
  [/Pick another world in the panel\./g, 'Pick another world in the Menu.'],
  [/press and drag to draw a loop/g, 'put a finger down and drag to draw a loop'],
  // ---- 3D
  [/Right-drag to look round\. Middle-drag or Space \+ drag to move\. Wheel to zoom\./g, 'Two fingers: drag moves, pinch zooms, twist turns.'],
  [/The mouse wheel zooms too\./g, 'Pinching zooms too.'],
]

/** The plain swaps. */
const SWAPS: [RegExp, string][] = [
  [/\bin the panel\b/g, 'on the card'],
  [/\bthe panel\b/g, 'the card'],
  [/\bDouble-click\b/g, 'Double-tap'],
  [/\bdouble-click\b/g, 'double-tap'],
  [/\bClick on the\b/g, 'Tap the'],
  [/\bclicked\b/g, 'tapped'],
  [/\bClick\b/g, 'Tap'],
  [/\bclick\b/g, 'tap'],
  [/\bPress(?= )/g, 'Tap'],
  [/\bpress(?= )/g, 'tap'],
]

/** A line said for a finger. Always converts: `words` is the one that waits for touch. */
export function phoneWords(text: string): string {
  let out = text
  for (const [from, to] of HAND) out = out.replace(from, to)
  for (const [from, to] of SWAPS) out = out.replace(from, to)
  return out
}

/** True while the device in use is a touch screen. */
export const onTouch = (): boolean => useGame.getState().inputDevice === 'touch'

/** What to show: the line itself on a computer, the line said for a finger on a phone. */
export const words = (text: string): string => (onTouch() ? phoneWords(text) : text)
