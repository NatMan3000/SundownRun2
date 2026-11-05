---
type: spec
title: Road Editor on a phone - pieces 3, 4 and 5 report, the shell, the card and the Menu
description: What layout C became, the tool button and tray, the card, the Menu, Nathan's ruling that nothing sits on the map (P8), the gate's editor steps and rule 12, what the merge's red lines turned out to be, the break-it tables and what is left for pieces 6 to 9.
created: 2026-11-05
---

Copied here on 5 Nov 2026 from the worker's report, because /tmp doesn't last. Paths under /tmp are where the run's logs and shots were.

# Road Editor on a phone, pieces 3, 4, 5: the shell, the card and the Menu (layout C)

Worktree `/tmp/sr2/wt/editor`, branch `phone/editor`, on f7fff7c (main and piece 2 merged in), plus uncommitted work since. Nothing committed by me. Port 5212. Simulator not touched: the real Safari check is the lead's.

**Layout C is built: tool button, tray with the tool's setting and View, card, Menu, right stack, and nothing on the map but the road (P8). Every inventory action is reachable. All in headless Chrome: not yet on real Safari or a real thumb.** Numbers: "Gate" and "Proof". Findings: the merge's 15 lines came to two real bugs and a leak in my own check.

## After the merge: the 15 red lines

Run alone, 15 and 17 passed; run after scenario 10, they failed. **The trigger is in my check; underneath it were two real bugs.**

| Lines | Verdict | What it was | Done |
|---|---|---|---|
| All of 12, 15, 17's setups | **The check (mine)** | Scenario 10 opens Afterglow, and the dice keep the world they find. Every later `random 7` was a different road (87 points, not 174) in another world, with a different zoom | `freshRoad` puts the world back first, so a scenario gets the same road whatever ran before |
| 12 pwa "near point warning" | Check | The same leak: its scribbles came out clean on that ground | Fixed by the above |
| 17 double tap at 8 and 18 px, second finger on a double tap | **Real bug, piece 2 and my Fit together** | `onDouble` refused anywhere within a finger's 22 px reach of a road point. My Fit zooms in further, so points show (under 2.2 m a pixel) a few pixels apart: every spot on the road is within reach of one, and a double tap silently adds nothing until you zoom a long way in. This would have hit any small track, and any pinch | `Overlay.tsx` `onDouble`: for a finger, "on a point" is within 3 m of one that is showing, not within reach. There it says "That spot already is a road point...", on a phone only. A mouse is unchanged. 17 now also double taps with points showing, and right on a point |
| 15 piece 22 and 27 px, 874x292 | **Real bug, on a computer too** | Not the reach: a red problem pin won the tap. A piece placed right on the road's first point got `at` 87 on an 87-point road, because the nearest spot on a loop can be the end of its last stretch. The validator calls that an error, so a plain tap made a "Not ready" track. Also 86.996 rounding up, and the start line | `draftFile.ts` `onTheLoop`: the file writes that spot as 0, one place for every piece and the start line. Self-test row added, since it can't be hit reliably by a finger |
| 15 piece 22 and 27 px, 874x402 | Check | A road point was nearer than the piece, and nearest wins, which is the plan's rule | The piece's reach is measured with points hidden |
| 15 road "not from 32 px" | Check | `away(32)` fell back on a spot that was really 12.6 px from the road [live: all four directions measured], so grabbing it was right | `away` searches the whole road for a spot truly that far, and fails out loud rather than falling back |
| 15 "a crossing to grab" n:0 | Check | `shape eight` does nothing on a map that has a road ("Nothing changed"), so the check was leaning on `random 7` happening to have a bridge. Once it did make the eight: New track left the Pencil in hand, points showed nearer than the marker, and its "blank" spot wasn't blank on the new road | New track first, Select in hand, points hidden, an empty spot found on that road |

Not one check was loosened: every threshold is what it was, and the new rows only add. No code in `mapGestures.ts`.

## Nathan's ruling on the map: P8

"The steady hand picker should be somewhere else (or hidden), it doesn't make sense being out there by itself. Keep the road world clear." This overrules the chip in `comp-c.png` and my call to keep it on the empty map.

- No chip on the map, for any tool, in any state. `ToolChips` and its CSS are gone.
- The tool's setting is a row in the tray, above View, in the same words ("Steady hand: Some"), and opens the same card. Tapping the tool you hold opens it too. Select has no setting, so no row. At 292 the tray's cells go to 46 px so it still fits: top of tray at 10 px, nothing clipped (gate R1 to R5).
- The tool button names the piece in hand ("Boost pad", with the Pieces icon). Its tray row opens the palette.
- `ThumbButtons` (Straight line, Reach minus and plus) shows only while a finger works that tool, beside the tool button, and goes on the lift. Showing moves nothing: the check reads the view before and after, and the second finger presses it as before.
- **Start again had to go somewhere** (it was a chip): **a half-made Straight or Curve now puts Cancel in Undo's place**, for as long as it is half made. That also stops Undo taking back an earlier edit by surprise. My call, for you to overrule.
- New gate rule 12, `map-clear`: on `road`, every `hand-*`, `pieces-chip` and `empty`, between the tool button's column and the right stack there is the map and the status line and nothing else. **The empty map's note stays allowed, named at the step:** it is where Random track and Drive to draw live. If Nathan meant that too, it needs a new home. The scale bar is drawn on the map's own canvas, so it is part of the map.
- `spec/phone-editor/inventory.md`'s last section says all this. I didn't touch the ledger row: "Ledger P8" read as yours.

## Narrowed, as you asked

- **Cancel:** a finger only moving the map isn't the tool working. Undo stays Undo through a one-finger pan, and a card stays up through it too, where before it hid. `touchState.panning`, read each frame by `useToolFinger`.
- **Bend's Reach twice:** gone, superseded by P8: the row only shows while a finger holds the road, and the chip no longer exists.

## Read this first

1. **A native slider jumps to a finger the moment it lands.** The gate caught a swipe up the card changing the slider it started on (R6). Sliders on touch now go through `FingerStrip` (`src/editor/fields.tsx`), the same manners as the menus' slider (`src/ui/widgets.tsx`): nothing until 7 px sideways, up or down is the scroll's, a tap sets it, a finger near the thumb picks it up where it is. The real `<input>` stays underneath for its value and for VoiceOver. Desktop never renders the strip.
2. **Chrome sends no `click` for a second finger** [live, Chrome: `pointerup` for both fingers, no click]. Cancel acts on `onPointerDown`, and scenario 10 presses it with a second finger. `ThumbButtons` as merged does the same. Not tried in Safari.
3. **The tray needed a guard, not a backdrop.** A tap on the map with Place in hand would drop a piece, and a backdrop would kill the pinch (rule: two fingers are always the map). `src/editor/phone/trayGuard.ts` holds back the first finger, hands it over if a second lands, and otherwise the map never hears. It dispatches a synthetic `pointerdown` carrying the real pointer id into `mapGestures.ts`: **please try a pinch started with the tray open in real Safari**, that is the one thing here I can't prove from Chrome.
4. **`.sre :where(button, input, select)` beats a stylesheet loaded before `editor.css`**, so the import order in `EditorUi.tsx` matters (it cost every button colour on my first look). In CLAUDE.md's gotchas.
5. Sizes follow a container query on `.sre`, not a media query, because I can't tell from here whether Safari's media `height` reads 292 or 402 in a tab. The container reads the box actually shown.

## Calls I made beyond the pictures, for you to overrule

- ~~The chip stays on the empty map.~~ Overruled by P8, above.
- **Small corner mark on the tool button**: the plan's check 7 was "you must find out the button opens the rest", and since P8 the tool's settings are behind it too. One corner tick says there is more. Delete `.phone-tool-more` if Nathan doesn't like it.
- **View is a page inside the tray** (Zoom in, Zoom out, Fit track, Whole world, Back to the tools). Zoom stays open for another tap; Fit and Whole world fold the tray. In 3D Zoom zooms the 3D view; Fit and Whole world act on the map underneath, as on the computer.
- **Done from a problem opened from Checks comes back to Checks**, then Done closes it: fix, Done, next row. A problem picked from its pin just closes.
- **Menu > Library closes the Menu first**, so opening a track lands you on the map, not on the Menu. Exit keeps the Menu under its question; New track and Random track fold it.
- **A tap on a dashed Undo, Redo, Checks, Save or Test drive says why** on the status line ("Nothing to undo yet."), so they use `aria-disabled`, not `disabled`. Two new lines of words; the rest are `saveDraft` and `testDrive`'s own.
- **Checks rows are short on a phone**: title and whether Fix it can mend it. The row's detail and Fix lines moved to the problem's card, so nothing is lost and no row is taller than the card. Fix all is a real button under the verdict.
- **A card asked for waits for the finger**, and one already up steps aside after 150 ms of the tool working ("the map only" in the inventory); it comes back on the lift. When it opens the map glides, 180 ms, just enough to keep the picked thing in the free part. Map only: in 3D nothing moves.
- **Fit reserves the tool button's column**, so no road sits under it. Wide tracks are a bit smaller than the plan's table, which ignored the column:

| Metres a pixel, shut / card open | Afterglow | Ember Pass | Hyperdrome |
|---|---|---|---|
| pwa (874x402) | 2.74 / 2.81 | 1.93 / 3.01 | 2.01 / 3.13 |
| safari (874x292) | 4.03 / 4.03 | 2.40 / 3.01 | 2.01 / 3.13 |
| small (667x331) | 3.22 / 3.69 | 2.28 / 3.95 | 2.37 / 4.10 |
| plan's C at 292 | 4.06 / 4.06 | 2.36 / 3.10 | 1.61 / 3.22 |

## What changed

| File | What |
|---|---|
| `src/editor/phone/PhoneEditor.tsx` (new) | The shell: Undo and Redo (Cancel while a finger works the tool or a shape is half made), the tool button, the tray with the tool's setting and its View page, the right stack with the compass, the card. Renders the panel's own `Inspector`, `Problems` and the rail's `Palette`, `ToolOptions`, unforked |
| `src/editor/phone/PhoneMenu.tsx` (new) | The Menu page: Track, Map key, Library, New track, Random track, Exit; Save, Save as new track, Back to the map |
| `src/editor/phone/phone.css` (new) | All of the layout, off `.sre[data-touch]` or `.phone-*`. Slider-first is CSS `order` over the panel's own parts |
| `src/editor/phone/freeMap.ts` (new) | `freeMapBox()`: the part of the map no button sits on, read from the page. Null on a computer and on the world map |
| `src/editor/phone/trayGuard.ts` (new) | A tap or drag on the map closes the tray and does nothing else; a pinch that starts with the tray open still works; any other button folds the tray and does its job |
| `src/editor/EditorUi.tsx` | Renders `PhoneEditor` instead of rail, palette, options and panel on touch. Exports `RAIL`, `pickTool`, `Palette`, `ToolOptions`. (`PhoneEditor` imports them back: a cycle, read only at render time) |
| `src/editor/Panel.tsx` | `Inspector` takes an optional `frame` (desktop path unchanged); `TrackStats`, `TrackFields` pulled out; `Problems`, `Legend`, `useProblems` exported; on touch the tunnel footprint shows while Make it a tunnel is on screen, and the problem card carries the row's Fix line |
| `src/editor/TrackSave.tsx` | `SaveSays`, `SaveButton`, `SaveAsNewButton` pulled out of `TrackActions`, same DOM |
| `src/editor/Look3dUi.tsx` | `Compass` pulled out; the corner steps aside on touch |
| `src/editor/fields.tsx` | `FingerStrip` on touch; slider help under the slider while the thumb is down; `--fill` for the track |
| `src/editor/view.ts` | `scaleX`, `scaleUp`, `ZOOM_MAX_PHONE` (8, while the layout is up), `fitBoxInto` |
| `src/editor/mapDraw.ts` | `drawScaleBar`, `drawReadout` read `view.scaleX`, `scaleUp` (defaults 96, 28). No other line |
| `src/editor/Overlay.tsx` | `fitToDraft` (below); after the merge also `onDouble` and two reads a frame (`touchState.panning`, `useThumb.working`) |
| `src/editor/ThumbButtons.tsx` | Piece 2's. Shows only while a finger works that tool. Its styles moved from `editor.css` into `phone.css` |
| `src/editor/draftFile.ts`, `src/editor/selfTestPieces.ts` | `onTheLoop` and its self-test row: a spot on the road's seam is valid in the file |
| `src/editor/look3d.ts` | `openMiddleX` reads the free map |
| `src/editor/dev.ts` | `view` also returns `scaleX`, `scaleUp` |
| `src/editor/index.tsx`, `CLAUDE.md` | One line each on `phone/`; check rows; two gotchas |
| `src/editor/editor.css` | Piece 1's marked block deleted |
| `scripts/phone-gate.ts` | Editor steps (`--only editor`), `BREAKS_EDITOR`, `firstAll`, rule 12 `map-clear`, the question box measured alone, named word exceptions, desktop guard for the editor |
| `scripts/editor-touch-check.ts` | Scenario 10 replaced: the real tool button and tray by real touches. Scenario 12 presses Menu first on a phone, and draws at a fixed zoom. `freshRoad` puts the world back. 15, 17, 19 as in the sections above |

No frozen contract touched, no new dependency.

## Lines touched in `Overlay.tsx` (for the merge)

Two imports (`:127` adds `fitBoxInto`; `:131` new line `import { fitWorldInto, freeMapBox } from './phone/freeMap'`) and `fitToDraft` only: `const free = freeMapBox()` before the empty test; `if (free) fitWorldInto(free) else setView(...)` on an empty map; `if (free) { fitBoxInto(...); return }` before `const pad = 80`. Nothing else. `mapGestures.ts` untouched.


## Gate

`bun run phone:check -- --port 5212 --only editor` (42 editor steps at each window; shots at `/tmp/sr2/phone/shots/editor-shell/final/`). Log: `/tmp/sr2/phone/editor-shell-gate-final.txt`.

| Run | Lines |
|---|---|
| Baseline, today's trial layout at f576ee2, all five windows (`editor-shell-gate-base.txt`) | **10,249**: R1 751, R2 2,327, R3 1,896, R4 2,819, R5 21, R6 9, R7 58, R8 847, R9 1,521 |
| First look at the new layout, Safari only | 150, then the real ones below went |
| Three landscape windows | 3 |
| Final build, after the merge and P8, rule 12 on, all five windows | **0**, ALL PASS, no page errors |

What it caught that I'd have shipped: the native slider jumping on a swipe (R6); seg buttons at 42 px and On the ground's hit area cut by the slider (R2); the Menu see-through over the stack (R3, R7); the empty note touching the status line (R7); Delete below the fold on the wall ride's card at 292 (R5). That last one only showed once the step proved its card had opened: the first version of the step tapped the wrong spot, no card opened, and it passed on an empty screen. Every card step now fails if its card didn't open. Rule 5's addition is `firstAll`: every slider, choice and button on a card sits on its first screen at 292.

Gate changes beyond the steps: a question box up means only the box is measured (nothing behind it can be pressed); a scroller below the fold of another is brought into view before its swipe; `.sre` counts for the click counter; more kinds of panel join the overlap rule. `--only map,title` at safari and desktop still ALL PASS; the full gate is yours.

**Seen failing,** `--break n` with `BREAKS_EDITOR`, seven editor states at Safari, `/tmp/sr2/phone/editor-shell-gate-breaks.txt`:

| Break | Lines on that rule |
|---|---|
| 1 Card and Menu stop scrolling | 10 R1 |
| 2 Buttons at 40% | 129 R2 |
| 3 A sheet over the middle | 53 R3 |
| 4 Everything slides into the notch | 71 R4 |
| 5 Primary actions off the first screen | 7 R5 |
| 6 Every tap lands twice, a swipe presses | 5 R6 |
| 7 Undo pair on the tool button, status over the stack | 42 R7 |
| 8 A key glyph and "Press Enter" | 30 R8 |
| 9 7 px words, a label cut off | 44 R9 |
| 12 A chip back on the map (run on `road`, `hand-bend`, `pieces-chip`, `empty`, after the merge) | Red on each (`/tmp/sr2/phone/editor-shell-breaks4.txt`) |

Rule 12 also went red with no injection, on the real thing: Straight line left on the map, and Reach left on the map (below).

## Proof

| Check | Result |
|---|---|
| `bun run editor:touch -- --port 5212 --only 10,12,13,14,15,16,17,18,19,20`, 874x402 and 874x292, plus a real mouse at 1920x1080, on the merged tree with P8 | **ALL PASS, 586 checks**: 281 at each window, 24 desktop (`/tmp/sr2/phone/editor-shell-touch-final.txt`). The 15 lines are gone. Scenarios 1 to 9 and 11 last ran in my 876-check full run before the merge, and in your merged run |
| Scenario 10, replaced | Tool button fits, clears the notch, says its tool; one tap opens the tray; nine tools in the computer's order, each by its own tap; the tool button names the piece in hand; the tray's row, for each tool, says its setting and opens its card, and so does tapping the tool you hold; Select has no row; a tap and a drag on the map close the tray and the tool never hears; a pinch with the tray open zooms at the fingers; View's four; the whole world and the road fit the free map, and Fit fills it; Afterglow at both windows; the scale bar in the free map; a picked stretch opens the card over the stack; pinch and two-finger drag with the card open; Fit with the card open; the card's slider, sideways one Undo step, a swipe up scrolls and changes nothing; Done; Undo, Redo; a line that lands proved first, then Cancel by a second finger leaves nothing; a half-made Straight's Cancel; a pan is not Cancel and doesn't move the card, a finger on the road does and it comes back; the Menu |
| Scenario 12 | Presses Menu then New track on a phone. Its lines now draw at a fixed zoom: at the new empty-map zoom the clean-up smoothed them too clean to warn |
| Scenario 19, the other thumb | No Straight line or Reach with no finger down; they show while one works, at least 44 px; showing moves nothing (the view is read before and after, the line keeps coming); a second finger presses them as before; they go on the lift |
| `bun run typecheck` | Clean on the final tree, after the merge and P8 |
| `bun src/editor/selfTest.ts` | 117 pass on the final tree, one of them the new seam row |
| 3D at the widest zoom | Far plane fine: `look3d open` from mpp 8 at all three windows, whole picture, nothing clipped. Shots `/tmp/sr2/phone/shots/editor-shell/zoom/*-widest-3d.png` [live, Chrome] |
| Second finger and `click` | `pointerup` for both, no click, first finger on the map, second on a button [live, Chrome]: `editor-shell-tools/dbg2.ts` |

**Scenario 10 seen failing,** source really broken, rebuilt, restored (`/tmp/sr2/phone/editor-shell-breaks.txt`, `-breaks2.txt`):

| Break | Red |
|---|---|
| Tray guard off | 11: the tap doesn't close it, a piece lands, the Pencil draws |
| Guard forgets the first finger of a pinch | 5: no zoom, the tool hears |
| Fit ignores the free map | 4: road under the tray, "and fills it" 0.65 |
| Widest zoom stays at 4 | 1: the whole world runs 83 px past the free map |
| Cancel waits for a click | 1: the line lands, `undo 1`. My first version of this check passed under this break, because its line never started on the road and so never landed; it now proves the line lands first |
| Scale bar stays where it was | 1 |
| Height before Bank in the tray | 1 |
| Undo never offers Cancel | 1 |

**After the merge and P8, source really broken, rebuilt, restored** (`/tmp/sr2/phone/editor-shell-breaks3.txt`, `-breaks4.txt`):

| Break | Red |
|---|---|
| Double tap refuses within a finger's reach of a point, as merged | 2 in 17: "with the points showing adds a point" |
| Double tap never refuses, even on a point | 1 in 17: it no longer says why. (The point isn't added either way: `insertPointAt` has its own guard) |
| A spot on the seam goes into the file as it is | Self-test row red, exit 1. The finger check in 14 stayed green here: it can't land on the seam reliably, which is why the row exists |
| A pan counts as the tool working | 2 in 10: Undo goes to Cancel, the card hides |
| The card never steps aside | 1 in 10 |
| Straight line always on the map | 2 in 19, and 2 lines of gate R12 on `road` |
| Reach row always on the map | 2 in 19, and 4 lines of gate R12 on `hand-bend` |
| The thumb's buttons never show | 2 in 19 |
| No row in the tray | 2 in 10 |
| Tool button says Pieces, not the piece | 2 in 10, 1 in the gate's `pieces-chip` |
| The tool you hold doesn't open its card | 14 in 10 |
| A half-made Straight keeps Undo | 3 in 10 |

**1920x1080 before and after,** run before the merge, on my build then (nothing a computer draws has changed in my lane since: the merge's fixes are in touch-only branches, and scenario 20's real mouse is green). Against f576ee2, 13 shots across all nine tools, hover, 3D and back, piece 1's method (`/tmp/sr2/phone/editor-shell-desk.txt`; shots `/tmp/sr2/phone/shots/editor-shell/desk/`):

| Pair | Most pixels differing | Interface (rail, panel, 3D button): biggest step | Over 8 in the interface | Map, biggest step 2D | 3D shot |
|---|---|---|---|---|---|
| Old build, twice | 39,847 | 1 | 0 | 21 | 59 |
| New build, twice | about 50,000 | 2 | 0 | 19 | 79 |
| Old against new | 33,124 | 1 | 0 | 19 | 59 |
| Second old against second new | 58,921 | 2 | 0 | 19 | 79 |

Same-build pairs differ as much as old against new, on a machine with other workers on it. The interface's differences are the map's faint noise through the glass. Desktop guard in the gate: no `data-touch`, no `.phone-*`, rail and panel there, ALL PASS.

## The eight checks, state by state

Read off the shots at all three windows; the path is the Safari one, the hardest. `/tmp/sr2/phone/shots/editor-shell/final/<window>-editor-<state>.png`, windows `pwa`, `safari`, `small`, `portrait`. Checks: 1 one thing stands out, 2 few choices, 3 nothing to remember, 4 groups mean something, 5 tools they know, 6 their words, 7 no manual, 8 answers fast.

| State | Shot (`safari-editor-`) | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | Note |
|---|---|---|---|---|---|---|---|---|---|---|
| Nothing picked | `road`, `hand-bend`, `hand-straight`, `hand-height` | ✅ | ✅ | ⚠️ | ✅ | ⚠️ | ✅ | ⚠️ | ✅ | Test drive is the only fill, and the map is all road, which is the point of P8. **Check 7 is the price, and it got worse with P8:** nothing on screen says the tools and the tool's setting are behind that button except its name and a small corner mark. Steady hand and Reach are now two taps away and out of sight until you find it. Nathan chose the trade; his thumb is the test |
| Tray open | `tray`, `tray-select` | ✅ | ⚠️ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | Eleven choices at most, but they are the tools you came for, in the order Josh knows. Once it is open, the tool's setting says itself, so 7 is fine here |
| View | `view` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | |
| Tool's card | `tool-pencil`, `tool-bend`, `tool-straight`, `tool-height` | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ | Slider first, long words scroll. "Mouse", "click", "Esc" until piece 6 |
| Stretch, slider first | `stretch-height`, `stretch-bank`, `stretch-width` | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ | Slider, Make it a tunnel, Smooth, Change this stretch's, all on the first screen at 292 (gate R5 `firstAll`). "Panel" and "click" in the words |
| Picked things | `point`, `piece-boost`, `piece-ramp`, `piece-loop`, `piece-wallride`, `props`, `core`, `crossing` | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ | Delete is on the first screen on every one at 292 |
| Placing pieces | `pieces`, `pieces-chip` | ✅ | ⚠️ | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ✅ | Eleven pieces is what there is, three across. Picking one folds the card and the tool button names it. To change piece: tool button, then the row. 7 as above. (`pieces-chip` keeps its old name; there is no chip in it) |
| A problem | `problem` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | Fix it is the fill, above the long words |
| Checks | `checks` | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ | "click one to see how" until piece 6 |
| Empty map | `empty`, `empty-tray` | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ | Random track is the fill; the rest are dashed and say why. "Press" until piece 6 |
| Menu | `menu`, `menu-key` | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ | Back to the map is the fill; Save goes amber when there is something to save. "Click it to" in the Map key until piece 6 |
| Questions | `ask-random`, `ask-save` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | Key line and icon gone on touch, so the box fits 292 |
| Building, needs fixing | `/tmp/sr2/phone/shots/editor-shell/moments/building.png`, `needs-fixing.png` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | Checks says Building... at once, Needs fixing in red with its count [live, Chrome]. Half-made Straight: `moments/half-made.png` |
| 3D | `3d` | ⚠️ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ | Back to the map and Test drive both fill. Note's words name the mouse until piece 8 |
| The other thumb | `/tmp/sr2/phone/shots/editor-shell/moments/safari-bend-held.png`, `pwa-pencil-held.png` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ | Only while a finger works. You have to be drawing to learn that Straight line exists, and the status line that used to say "Hold Shift" is piece 6's to reword |
| Stood up | `portrait-editor-road`, `portrait-editor-stretch-height`, `portrait-editor-menu` | usable | | | | | | | | Map on top, card as the lower half, Menu's left column runs along the top and swipes. Not polished, as asked |

## Inventory: anything not reachable?

None. Piece 2's Straight line and Reach buttons are merged and show while a finger works the tool.

Everything in `spec/phone-editor/inventory.md` was walked: all nine tools, the tool's setting and View in the tray; Undo, Redo, Cancel (which is also how a half-made shape starts again); every tool's settings on the card; every picked thing on the card; Checks with Fix all; Track name, stats, save words, Road width, Road surface, World, Time of day, Edge lights, Made by, About this track, Smooth the road, Drive to draw, what Save will do, Save, Save as new track, Map key, Library, New track, Random track, Exit in the Menu; Test drive, Save, Checks, 3D, Menu on the stack; slider help under a thumb; tunnel footprint while its button is on screen; compass; scale bar. World map is untouched (`data-map-touch`, `phone-panels`' lane).

## For piece 6 (words)

Named, temporary exceptions in `scripts/phone-gate.ts`, top of the file: rule 8, screen `editor`, by opening words. A new line that names a key still fails.

- `TOOL_TIPS` (`EditorUi.tsx`), all nine. They are also long: Height's is six lines at 874 and nine at 667, on the status line for 4.5 s. Worth shortening when they are rewritten.
- `ToolOptions` and its steps: "behind the mouse", "Hold Shift", "mouse wheel, or [ and ]", "Click the road", "then click", "Esc starts again", "click them", "click it", and "in the panel on the right" (it is the card now).
- Panel: "Double-click the road", "click one to see how", every "Click it to" in the Map key. Also "panel" throughout the stretch messages.
- Messages: `Smoothed: ... Press it again`, `Picked the raised road ... press On the ground`, `New track "...": ... press Random track`, `Hold the mouse button down and draw`, the empty note's "press Random track".
- Not seen by the gate, because they only show mid-gesture or on a press: slider help ("behind the mouse"), `PLACE_TOOLS` blurbs ("Click the side of the road", "Click: its middle goes there"), placing messages ("where you clicked"), "Now click the road", "Roll the mouse wheel", "press Esc". Piece 6's sweep should grep rather than trust the list.
- `LOOK_HINT` (`Look3dUi.tsx`): piece 8.

## For another lane

- **Piece 7:** the Library is reachable from the Menu and its Close stays on screen at 292 (one `max-height` line in `phone.css`); nothing else about it is done. The gate only proves it opens (`reachOnly`). I hid the questions' icon and key line and sized their buttons because the Menu's New track, Random track and Exit run through them; that bit of piece 7 is done.
- **Lead's Safari check:** (1) pinch started with the tray open; (2) a slider: sideways drag, swipe up from it, a tap; (3) Cancel and Straight line with a second finger: the row appears mid-stroke, so that is the first time a real thumb reaches for something that wasn't there when the line began; (4) the sizes at 292 (the container query); (5) `Save` and `Test drive` dashed on the empty map saying why.

## Not done

- Real Safari and a real thumb: nothing here says how it feels. Headless Chrome only.
- Home Screen window size, phone GPU cost.
- `keepInFreeMap` does nothing in 3D: a card can open over the picked thing there.
- Gate has no step for a Speed trap or Tunnel piece's card (Afterglow has neither); same parts as the others.
- Library, Share, online tracks, Drive to draw, 3D words: pieces 7, 9, 8.

Stopped: my preview on 5212. Not committed. `bun src/editor/selfTest.ts` and the other full suites are yours. One command refused: late on, `kai-bash-guard` refused a read of a finished background task's output file as polling; I read the check's own log instead, nothing was lost.
