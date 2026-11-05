---
type: spec
title: Road Editor on a phone - Phase A report and plan
description: The Phase A report for the Road Editor's phone build: what today's touch handling does, the gesture map, the three layouts compared, and the ten pieces of Phase B. Nathan picked C.
created: 2026-11-05
---

Copied here on 5 Nov 2026 from the worker's report, because /tmp doesn't last. **Nathan then picked C, One tool button (ledger P7), over the A this report recommends.** Only C's and the sheet's pictures were kept: `comps-sheet.png` shows all three. The gesture map and the work list hold whichever layout won.

# Road Editor on a phone: Phase A report (comps and plan, no build)

No edits under `src/`; nothing committed. My preview on 5232 is stopped. Scripts in `/tmp/sr2/phone/editor-tools/`.

**Recommended: A (Workbench). Riskiest: telling a tool's finger from a pinch's first finger.**

Show Nathan: [comps-sheet.png](comps-sheet.png) (all three, one picture). Full list of pictures below. Inventory: [editor-inventory.md](inventory.md).

## Read this first

- **The window moved twice while I worked.** My brief said 844x390; BRIEF.md changed to the iPhone 17 Pro (874x402 L62 R62 B21, 874x340 L62 R62). Later one wins, so the comps are at 874x402 and 874x340.
- **Safari on the Simulator is shorter than 340.** `sim-rig-report.md` measured Mobile Safari on the iPhone 17 Pro Simulator at **874 x 292 with a 20 px bottom inset**, so 272 px usable, not 340. I drew every comp at 292 too, and it decides B. Main's standard and the gate script already say 292 (the gate lane's worktree copy of the spec is stale until it merges); rule 5's 340 is being fixed on main by the lead.
- `.sr-ui[data-touch]` can't carry this lane: `src/ui/index.tsx:350` returns null in the editor phase, so the editor's root is `.sre`. Phase B hangs off a new `.sre[data-touch]`, set from `inputDevice === 'touch'`, same rule, different root.

## Does a layout need the Home Screen copy? (Safari tab 874x292, L62 R62 B20, measured on the iPhone 17 Pro Simulator, not yet confirmed on a real phone; Home Screen 874x402)

The 402 column is assumed from the screen size: nobody has measured a saved Home Screen copy.

| Layout | Home Screen, 402 | Safari tab, 292 (272 usable) | Plainly |
|---|---|---|---|
| A | Roomy: 534x369 of map, 338x369 with settings open | Works but tight: rail at 44 px rows, no gaps, 2 px from the top, compass gone; 338x260 of map with settings open; long words scroll in the card | Does not need the Home Screen copy |
| B | Works: 742x263 of map, 742x217 with settings open, but a square track already doesn't fit once they're open | 742x154 of map; 108 with settings open, 90 with a problem showing: the road no longer fits and you work through a letterbox | **Needs the Home Screen copy to be usable** |
| C | Roomiest: 742x369 of map, 366x369 with settings open | Works: tool button, Undo and the right stack all fit; 366x260 with settings open | Does not need the Home Screen copy |

Pictures at 292: `comp-a-292.png`, `comp-a-open-292.png`, `comp-a-fix-292.png`, `comp-a-pieces-292.png`, `comp-a-empty-292.png`, and the same for b and c. The bottom inset is drawn as 21 at 402, as first briefed; at 20 nothing changes.

## The three layouts

Real map (the production editor, Afterglow Valley copy, a real picked stretch and a real problem), real icons from the rail, real words from the panel with "click" said as "tap". The tool that made them flags every target under 44 px, off the safe area, or overlapping another: all clean except text-and-button content meant to scroll inside its card.

| | Trade, in a sentence | Closed | Tool in use | Tightest |
|---|---|---|---|---|
| **A: Workbench**, tools down the left in the computer's order, settings slide in on the right | Every tool is one tap away and nothing moves, but the rail always takes a fifth of the screen, and with settings open about 40% is left for the map. | `comp-a.png` | `comp-a-open.png` | `comp-a-open-292.png` |
| **B: Shelf**, tools along the bottom like a maps app, settings swap in for them | The map stays as wide as the phone, but it loses height, which a phone on its side is shortest of: a square track won't fit once settings are open, and the middle tools are a stretch. | `comp-b.png` | `comp-b-open.png` | `comp-b-open-292.png` |
| **C: One tool button**, one big button shows the tool in your hand, tap it for the rest | The map is at its biggest while you draw, but you can't see your other tools, and swapping tools is always two taps. | [comp-c.png](comp-c.png) | [comp-c-open.png](comp-c-open.png), tray [comp-c-tray.png](comp-c-tray.png) | [comp-c-open-292.png](comp-c-open-292.png) |

Every comp also has `-fix`, `-pieces`, `-empty`, each at `-340` and `-292`, in `` (for example `comp-a-fix-292.png`). The shared Menu page: [comp-menu.png](comp-menu.png), `comp-menu-292.png`.

What today looks like: `today-1-editor.png`.

### How big the road is

Metres per screen pixel when Fit frames the track, in the free map: smaller is a bigger road. Afterglow is square, so it is the hard case, and the game's zoom stops at 4.

| Track, window | A closed | A open | B closed | B open | C closed | C open |
|---|---|---|---|---|---|---|
| Afterglow, 402 | 2.73 | 3.15 | 4.01 | 5.03 | 2.73 | 2.88 |
| Afterglow, 340 | 3.12 | 3.15 | 4.89 | 6.50 | 3.12 | 3.12 |
| Afterglow, 292 | 4.06 | 4.06 | 7.71 | 12.64 | 4.06 | 4.06 |
| Ember Pass, 292 | 2.36 | 3.38 | 4.48 | 7.35 | 2.36 | 3.10 |
| Hyperdrome (wide), 292 | 2.13 | 3.52 | 3.05 | 5.00 | 1.61 | 3.22 |

Free map at 292: A 534x260 closed, 338x260 open. B 742x154 closed, 742x108 open. C 742x260 closed, 366x260 open. B's 108 px is the number that kills it in Safari. Nathan still chooses; no score decides for him.

### Recommendation, in a 12-year-old's words

"All your tools stay down the left in the same order as on the computer, right by your thumb, with their names on. When you pick a bit of road, its settings slide in on the right by your other thumb, and the map stays in the middle. The map is a bit smaller, but you never have to hunt for anything, and you already know where everything is."

Why, for the lead: Nathan's own history in this editor is about finding things (icons "aren't really self-explanatory", "it's just not obvious", could not find tunnels). A is the only one where the tool names are always on screen, in the order Josh already knows. C's road is barely bigger than A's on a square track with settings open (2.88 against 3.15 at 402, equal at 292), because height is what limits it, and it hides the tools. B's map is the widest and the shortest.

Considered and dropped: a thin one-column rail with Height, Bank and Width folded into one button. It would save 60 px, but Nathan split those three apart on purpose (`6ff151e`).

### The eight first-screen checks

| Check | A | B | C |
|---|---|---|---|
| 1. One thing stands out | ✅ Test drive is the only fill; on the empty map, Random track; on a problem, Fix it | ✅ same | ⚠️ the tool button and Test drive compete, in opposite corners |
| 2. A few choices, grouped | ⚠️ 12 cells on the left is more than three, but they are the tools you came for, and two groups read at a glance: change the road (left), the whole track (right) | ⚠️ 12 cells in one line read as one long list | ✅ two corners, tray on demand |
| 3. Nothing to remember | ✅ | ✅ track name shows too | ❌ the other tools' names are out of sight until you open the tray |
| 4. Groups mean something | ✅ left and right; no boxes in boxes | ⚠️ settings and tools never show together, and the top row mixes save and drive | ✅ |
| 5. Works like the tools they know | ✅ drawing apps, and the desktop editor itself | ✅ maps apps | ⚠️ a game's weapon button, unusual for a drawing tool |
| 6. Their own words | ✅ same names as the computer; "Pieces" for Place pieces on the cell | ✅ | ✅ |
| 7. No manual needed | ✅ | ✅ | ⚠️ you must find out the button opens the rest; it does say the tool's name |
| 8. Answers fast | ✅ same in all three: a tap shows at once; a slider that has to build says so already | ✅ | ✅ |

Honest about the tight windows: at 292 A's rail fits only at 44 px rows with no gaps, 2 px from the top edge, with the compass gone. It fits, it isn't roomy. At 292 with a card open, a long explanation scrolls inside the card; the slider and buttons stay on the first screen. Afterglow at 292 needs a touch more zoom-out than the game allows (see Work, piece 3).

Not drawn, worked out only: `small` 667x331 (A leaves 451 px of map closed, 255 open; rail and stack both fit), 844x390 (same usable width as 874), stood up (rail stays, card becomes the lower half: usable, not polished).

## What the real handlers do today [live]

Real touches through CDP on the production build at 874x402 (`editor-tools/probe-touch.ts`, shots `today-*.png`). `Overlay.tsx` is pointer events with `touch-action: none` on the canvas, so one finger mostly works already. It assumes one pointer, and a mouse that hovers.

| Finding | Evidence |
|---|---|
| ✅ One finger: Pencil loop becomes a road, Bend, Height picks a stretch, drag off the road pans, double tap adds a point | 229 points, 1 undo; bend 1 undo; `{kind:section}`; view moved 400 m; 1 point added |
| ❌ Pinch does no zoom: the map lurches sideways | mpp stays 4, cx jumps 664 m: both fingers feed one `lastX` (Overlay.tsx:697) |
| ❌ A second finger while drawing wrecks the line | `today-3-pencil-2fingers.png`: the line zigzags between the fingers; `stroke` restarts in `onDown` (Overlay.tsx:557) |
| ❌ The real point is hard to hit | Tap 8 px off: picked. 10 px off: nothing (radius 9, Overlay.tsx:203) |
| ❌ Straight and Curve show no preview before they act | Straight acts on finger down, before lift (Overlay.tsx:611); Curve's third press too (:594) |
| ❌ Curve warns falsely after two taps: "That goes off the edge of the world" | `onLeave` sets `pointer` to -9999 on every lift (Overlay.tsx:924), and the preview reads it (:449) |
| ❌ Place acts on finger down with no preview | Boost pad placed before lift (Overlay.tsx:638) |
| ❌ A stretch tool off the road clears the selection and won't pan | Overlay.tsx:645 |
| ❌ The rail's hover tip sticks after a tap | opacity 1, `:hover` true (`today-6-rail-tap.png`) |
| ❌ Today's layout can't work: four rail buttons off screen (Select, Pencil, Whole world, Library) | rail -53 to 456 in 402 |
| ❌ The panel's scrolling part is 8 px tall, so Selected, Track, Checks and Map key are out of reach; panel takes 43% of the width | `clientHeight 8`, `scrollHeight 1066` |
| ❌ `.sre` font bottoms out at 11 px; an input is 15.95 px, so Safari would zoom the page | computed |
| ❌ `pointercancel` runs `onUp`, so a system interruption commits half a line | Overlay.tsx:1230 (read, not triggered) |
| ⚠️ Status line goes into a thin tall column | `today-3`, its CSS keeps clear of the desktop panel |

## The gesture map

The rule, decided: **one finger is the tool; two fingers are always the map.** That is what Nathan's no-Pan-tool ruling means on glass: nothing to switch, in every tool.

| Mouse or keyboard | Thumb |
|---|---|
| Left press and drag | One finger: the tool |
| Right or middle drag, Space + drag, WASD, arrows | Two fingers drag (3D: slide) |
| Wheel, + and - | Pinch at the fingers (3D: closer and further) |
| Right drag in 3D, Q and E | Two fingers twist; one finger where the tool has nothing to do (exists today) |
| Hover | Finger down previews, finger up commits |
| Click | Tap |
| Double-click | Double tap, tolerance 20 px |
| Delete | Delete on the card |
| Shift while drawing | "Straight line" toggle, other thumb |
| Wheel or [ ] during a bend | Minus and plus on the Reach chip, other thumb |
| Esc | Its own button at each rung (inventory, Esc ladder) |
| Ctrl+Z, Ctrl+Y | Undo, Redo on the rail; Undo turns into Cancel while a finger is on the map (mid-bend Undo is blocked today, for the same reason) |
| T, F, keys 1-0, tool letters | 3D button, View, card, rail |

Hard cases, decided:

- **Pan versus draw versus drag a point.** A finger on the map does not act at once. It arms: the tool starts when the finger moves 6 px, or after 80 ms, or on lift. A second finger inside that window makes it a map gesture and the tool never heard about it, so a pinch never leaves a mark. The Pencil loses nothing: the points seen while armed are handed over when it starts. A second finger after the tool has started and within 24 px of its start cancels the tool (the existing `cancelPointerGesture`) and becomes the pinch; later than that it is ignored, so a long line can't be wrecked by a resting thumb.
- **One finger off the road** pans wherever the tool has nothing to do there: Select, Bend, Straight and Curve do already; Height, Bank, Width and Place join them, keeping today's hint on a tap. The Pencil always draws.
- **Hover-only feedback.** Bend lights its stretch on press (it already does). Stretch tools show the pick after the tap. Straight, Curve and Place preview during the press, and commit on lift. The tunnel footprint shows only while a thumb is held on Make it a tunnel; letting go on it acts, sliding off doesn't (changed 5 Nov 2026: on screen the whole time, it was too much on the road). Slider help shows while your thumb is on the slider.
- **Fat finger on a small point.** Radii on touch: points 22, pieces 28, props and cores 26, crossings and pins 24, road 20, label boxes plus 8. Nearest wins, so close neighbours still work, and points only show when zoomed in (today's rule). Pinch first for a crowded corner.
- **The finger hiding what it drags.** Once it moves, a dragged point, piece, prop or core eases over 120 ms to sit 56 px above the finger (below it near the top edge). No lift for the Pencil: the line trails the finger on the steady hand's string, and the amber "this bit goes" is bigger than a finger. No lift for Bend, whose effect is wide.
- **Precise placement.** Pinch in (0.15 m a pixel is plenty) plus the lift. Fine numbers stay the card's sliders (Across the road, Length). No nudge arrows.
- **Undo** is always on the rail, thumb's reach, in all three layouts.
- **A map that's shrunk by a card** pans just enough to keep the picked thing in the free part; no re-fit, so the map doesn't jump.

The top tasks under A, tool taps only:

| Task | How |
|---|---|
| Draw a road | Opens on Pencil. Draw a loop, let go. 0 taps |
| Shape it | Tap Bend, drag the road. Or Select, pinch in, tap a point, drag. Or Straight, tap, press, slide, let go |
| Add a piece | Pieces, tap one (card folds to a chip), press the road, slide, let go |
| Fix a problem | Tap the pin (or Checks, then a row), Fix it, Done |
| Drive it | Test drive. If a card is open, Done first. Back through pause > Road Editor (already there) |

## Work for Phase B

Sizes are relative: S small and self-contained, M a real piece, L large or hard to prove.

| # | Piece | Size | Notes |
|---|---|---|---|
| 1 | Gesture layer in front of `Overlay.tsx`'s handlers: arm, second finger, pinch, two-finger drag, twist; `pointercancel` cancels on touch | **L, riskiest** | Mouse and pen pass straight through, so desktop can't change. Uses `dragView`, `zoomViewAt`, `turnLook`, `cancelPointerGesture`, which exist |
| 2 | Tools on touch: pointer set on press, nothing wiped on lift, commit on lift for Straight, Curve, Place; radii; lift; double tap; off-road pan; straight-line toggle; reach step | M | Branches on `pointerType`, mostly in `Overlay.tsx`, radii in `mapDraw.ts` |
| 3 | Shell: `.sre[data-touch]`, rail, right stack, chip, status line, View, dvh, type sizes, `fitToDraft` reads the new boxes with a smaller margin, scale bar at the top left of the map (Nathan, 5 Nov 2026: "Move the scale up to the top left on the editor. Try to keep the track field clear"), road labels (RAISED and DUG, BANK, WIDTH, the crossing's pill) shown only with the tool that changes them and not tappable otherwise (Nathan, 5 Nov 2026, P8), widest zoom raised on touch so a square track and the whole world fit | M | New `src/editor/phone/`; the 3D camera's far plane already reaches past the widest map, to re-check at the new zoom |
| 4 | The card: `Inspector`, tool settings, `Palette`, `Problems` in it, slider-first ordering | M | Those are components already; touch renders them in a different home |
| 5 | Menu: Track, Map key, Library, Save as new, New track, Random track, Exit | M | Reuses `Panel` parts and `TrackActions` |
| 6 | Words: about 110 lines across 20 files say click, mouse, Esc, Shift or wheel, comments included, so fewer shown strings than that. One function at the point of display, plain swaps plus hand-written lines for the hard ones; a check fails if those words render on touch | M | Stored messages stay as they are, so desktop reads the same |
| 7 | Library, Share, online tracks, questions, on the phone: rows, 16 px inputs, hide key hints, keyboard room | M | CSS mostly |
| 8 | 3D on a phone: hint words, note layout, twist | S | Frame cost on a phone is unmeasured |
| 9 | Drive to draw bar | S | Inline styles today; keep clear of the touch top row |
| 10 | Proof: `scripts/editor-touch-check.ts` with real touches (draw, pinch, pinch mid-line, tap a point, drag with lift, place with slide, fix, test drive), plus the shared gate pointed at the editor, plus 1920 before and after | M | The gate has no editor screens yet |

**Why piece 1 is the riskiest:** every tool acts on finger down today, and the arm delay changes what "down" means for all of them at once. Too long and drawing feels late; too short and pinches leave marks. Headless Chrome can check the logic, but Safari's own gestures (page zoom, edge swipe back, bars collapsing on a swipe) only show on the Simulator or a real phone, and the Simulator rig scripts one finger only. It needs a real hand on a real phone before it is called done. I would build and prove it first, on today's layout, so a bad feel shows before any styling depends on it.

## For another lane

- **gate:** the lane's worktree copy of the spec still says 340 until it merges; main and the gate script say 292.
- **phone-panels:** the world map shares this editor's rail and panel. On a phone it needs View, Map key and Back to the game; I left it alone as asked. If its way out lands first, tell me where.
- **play or panels:** the title's Road Editor button is 29 px tall.

## UNCERTAIN

1. Answered by the lead: a Safari tab is 874x292, L62 R62 B20, as measured on the iPhone 17 Pro Simulator (iOS 27.2) and not yet on a real phone. Phase B judges 292 as the tightest window.
2. `UNCERTAIN:` does `touch-action: none` on the canvas stop Safari's page pinch-zoom, or does it need a `gesturestart` guard as well? Can only be settled on the Simulator or a phone, in piece 1.
3. `UNCERTAIN:` does Export (a blob download) work on a Home Screen copy? If it doesn't, the platform's share sheet is the fix. Needs a device.

## Not done

Phase B. Nothing under `src/`. The three pictures show states from real data, but the layouts themselves are drawings.
