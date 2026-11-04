---
type: spec
title: Road Editor on a phone - piece 1 report, the gesture layer
description: What the gesture layer does and why, its numbers, the frameAt sweep, the break-it table, what real Safari showed, the phone trial list, and what piece 2 needs to know.
created: 2026-11-05
---

Copied here on 5 Nov 2026 from the worker's report, because /tmp doesn't last. Merged to main as b158b7c and deployed as version 76477285. The gate's 18 sound chip lines in "Read this first" are fixed since (795fae6: `hud-song` gets its own page).

# Road Editor on a phone, piece 1: the gesture layer

Worktree `/tmp/sr2/wt/editor`, branch `phone/editor`, on 202af1c. Nothing committed. Server on 5212 stopped. I shut the simulator down at 07:55 AEDT; at 09:20 AEDT it was booted again, and not by me, so I left it alone.

**Built and proven in Chrome at both windows, with pinch and one Pencil stroke proven in real Safari. The New track crash is fixed. It needs Nathan's thumb next.**

## Read this first

1. ✅ **A crash that was on main too, now fixed (follow-up from the lead).** A road with a "near point" warning (a corner too tight, a crossing too low, which a scribble easily makes), then New track: the whole editor went blank, the Overlay and every panel unmounted, on a computer as well as a phone. `src/editor/problems.ts:280` called `frameAt` on the empty new road while the old warnings were still in the store, inside a React render with no error boundary. Fixed at `problems.ts:278`, guarding on `rc.curve.length`, the same test as :176. Guarding the `if` rather than the one call makes a stale row fall through to "no button", so an empty map never offers a Fix it for a road that has gone. Sweep and proof below.
2. ✅ **Page zoom settled, UNCERTAIN 2 closed.** `touch-action: none` alone stops Safari's page pinch on the canvas: two real fingers at 874x292, `visualViewport` stayed scale 1, 874x292, while the map zoomed 4 to 0.9 m a pixel. But a pinch landing on a panel made the whole page bulge to 946 wide and spring back within about a second, with both fingers cancelled. So there is a `gesturestart` guard too, only where `navigator.maxTouchPoints > 0` (a Mac's trackpad sends that event). With it, a pinch on the panel and on the rail moves nothing [live].
3. ✅ **A real Safari bug the Chrome check can't see, found and fixed.** Safari says `innerWidth` is 750 for the first moments after loading, then 874, with no `resize` event. A page opened straight on `?editor=1` sized the map's layer 750 wide while the picture was 874, so every neon mark sat 62 px off its road and the right 124 px had no map layer. Fixed with a `ResizeObserver` (`Overlay.tsx` `sizeWatch`). The log showed `ow 750` before and `ow 874` after [live]. Going in through the title's button mounts late enough to miss it (874 at mount) [live].
4. ⚠️ **The phone gate fails 18 lines, and all of them fail on main's build too.** Every line is `hud-sound-* R7 "the sound chip never showed with music on"`. Same 18 lines on 202af1c and on this build in a full run; `--only hud-sound-race,hud-sound-tag` passes on both. Not from this change, but the sign-off said ALL PASS, so someone should look. The gate's other rules pass.
5. ⚠️ **The rig's squeeze isn't a pinch.** `pinch.sh 0.6 -1` starts the fingers so far apart that in a 292 tab one lands in Safari's bars, and the page sees one finger, a pan. Noted in the rig's README. Fingers coming together is proven only in Chrome.

## What changed

| File | What |
|---|---|
| `src/editor/mapGestures.ts` (new) | The layer: armed, tool, map. The numbers are in one block at the top. Mouse and pen pass straight through, in the same call. It knows nothing about tools; `Overlay.tsx` hands it its handlers |
| `src/editor/Overlay.tsx` | Pointer listeners go through the layer. `takeBackPress` puts a called-off press back. `sizeWatch`. Double tap compares when the finger landed (`e.timeStamp`), so the arm time can't shift it. `lastPencilLine` for the check. A guard on the wall ride and tunnel drag for an empty road (sweep below). Otherwise mouse paths unchanged |
| `src/editor/problems.ts` | The New track crash: one guard, one comment |
| `src/editor/dev.ts` | `__game.get('editorGesture')`: counts, the exact view, the last line |
| `src/editor/EditorUi.tsx` | `data-touch` on `.sre`, edit mode only. The world map keeps its own `data-map-touch` |
| `src/editor/editor.css` | A marked block at the end, touch only, for piece 3 to delete: scrolling rail clear of the notch, 40 px rows, no sticky tips, no text selection on the map, narrow panel, no settings box |
| `scripts/editor-touch-check.ts` (new), `package.json` | `bun run editor:touch -- --port 5212` |
| `scripts/ios-sim/pinch.sh` (new), `proj/UITests/RigTests.swift`, `README.md` | Real two-finger pinch, centred on the page or on an element by its label |
| `CLAUDE.md`, `FILE-INDEX.md` | Check row, architecture row, Safari width gotcha, `frameAt` gotcha, index row |

No frozen contract touched, no new dependency.

## The numbers

Top of `mapGestures.ts`, one line each. None moved from the plan.

| Name | Value | Means |
|---|---|---|
| `ARM_MS` | 80 | Plan's. Longer: drawing feels late. Shorter: a slow pinch leaves a mark |
| `ARM_PX` | 6 | Plan's |
| `TAKE_BACK_PX` | 24 | Plan's. Measured as the furthest the finger has been, so a loop closing back on its start can't be wrecked |
| `TWIST_START_DEG` | 10 | New. Every pinch twists a little by accident; without this a 6 degree wobble turned the 3D view |
| `LOST_FINGER_MS` | 100 | New. Wait for a late pointerup before calling a finger lost |

## Calls I made beyond the words, for you to overrule

- **A second finger always joins a one-finger pan, however far it has gone.** The written rule ignores it after 24 px to protect a long line, and a pan has no line. Otherwise "two fingers are always the map" fails exactly when the map is already moving. One condition to remove (`hands.justPanning()`).
- **Map room for the trial.** The brief only asked for Select and Pencil to be reachable, but with the settings box and panel the Pencil had a 100 px wide strip of map. I hid the box and narrowed the panel to 200 px: now 480 px wide. Lost for the trial: Steady hand slider, Bend's Reach slider, Straight's numbered steps. The panel's own scrolling part is still too short, as the plan found. Piece 3 deletes all of it.
- **A cancelled press puts back more than `cancelPointerGesture` does.** That function doesn't cover a bend (`cancelBend` does) or a pan, and Straight, Curve and Place have already acted by the time a slow second finger lands. So `takeBackPress` restores draft, Undo, Redo, selection, half-made shape, tool, saved state and the status line. This isn't a scrap of piece 2: it works today, and goes on working once piece 2 moves those tools to the lift.
- **After a pinch, the finger left over does nothing until it lifts**, so ending a pinch one finger at a time never leaves a mark. A new finger beside it grips the map again.
- **A resting thumb that was ignored stays ignored**, and a new finger beside it is a tool's finger, not a pinch.
- **Lost fingers.** `touchend` with no touches left, a primary finger landing, window blur and a hidden page all let go, or one lost pointerup would make every later finger a "second finger", per the CLAUDE.md gotcha on touch fingers.

## World map

It goes through the same handlers, so pinch works there and one finger still pans the whole of its path, at both windows [live, Chrome]. Scenario 11. It keeps its own phone layout, not the trial's rail.

## The `frameAt` sweep

`frameAt` throws on a road with no points. `roadCurve` is also empty under 3 points, but `deletePoint` stops at 8, so that never arises in play. Every call outside the self-tests, read [live for the two marked, read from the code for the rest]:

| Call | Reached from | Can it see an empty road? | Done |
|---|---|---|---|
| `problems.ts:280` | Validator warnings, in a React render | **Yes: the crash** [live] | Guarded at :278 |
| `Overlay.tsx:774`, `:779` | Moving a wall ride or tunnel drag | **Yes, if Undo takes the road away mid-drag** [live]. Threw once a move, with no unmount | Guarded: `if (mapIsEmpty()) ghost = null` |
| `problems.ts:176`, `:383`, `checks.ts:136` | Gate rows and the row's pin spot | No: already guarded | None |
| `mapDraw.ts:681` start line | `drawMap:223` | No: inside `if (g.rc.curve.length)` at :205 | None |
| `mapDraw.ts:905` run labels | `drawMap:212-214` | No: same block | None |
| `mapDraw.ts:1012`, `:1014`, `:1036`, `:1047` stretch hover | `drawMap:216` | No: same block | None |
| `mapDraw.ts:1080`, `:1094` section | `drawMap:217`; `drawWallGhost` | No: same block; ghost gated by :1471 | None |
| `mapDraw.ts:1123` pieces, via `pieces.ts:247` | `drawMap:222` | No: same block | None |
| `mapDraw.ts:1166` wall ride | `drawPieces`; `drawWallGhost` | No: same block; :1471 | None |
| `mapDraw.ts:1197`, `:1218` tunnel | `drawPieces`; `drawGhost` | No: same block; :1472 | None |
| `mapDraw.ts:1230`, `:1274` tunnel footprint | `drawMap:229` | No: own `rc.curve.length` there | None |
| `mapDraw.ts:1498` wall ghost | `drawGhost:1471` | No | None |
| `mapDraw.ts:1616` warning's piece | The stale warnings path | No: `if (!p) return null` first, and a new track has no pieces (`draftFile.ts:325`) | None |
| `mapDraw.ts:1669` labels | World map only | No: the track being driven always has a road, and `showMap` returns if there is none | None |
| `draft.ts:1232` footprints | Each frame | No: `isEmptyDraft` return at :1201 | None |
| `draft.ts:1424`, `:2066` add a point, loop spot | Actions | No: `noRoadYet`, `isEmptyDraft` before them | None |
| `draft.ts:1554` carry alongside | Road edits | No: an empty old road returns at the distance test | None |
| `fixes.ts:829` | Fix it | No: needs the piece first | None |
| `look3dMarks.tsx:106`, `:123` 3D pins | Each 3D frame, stale warnings too | No: `if (!d.points.length) return out` at the top | None |
| `look3dMarks.tsx:265-266` | Dev handle only | Not in play: it needs a picked stretch, and New track and Undo both clear the selection | None |
| `Look3dUi.tsx:346` | Dev handle | No: says "no road" first | None |
| `Overlay.tsx:207`, `:594`, `:795`, `:1325` | Picks and hover | No: a loop over points, or behind a road hit, and an empty road's distance is Infinity | None |
| `dev.ts:472`, `:503` | Checker commands only | Yes, but the throw goes back to the checker's own call, not a render | Left alone |

Also tested with Undo mid-press on Height, Bank and Select: no throw, so nothing needed there.

## Check results, final build

`bun run editor:touch` at 874x402 and 874x292 with notch insets, plus a real mouse at 1920x1080:

| Scenario | Result, both windows |
|---|---|
| 1 Pencil loop | ✅ road, one Undo, same start and same points as the mouse (0 px off), steady hand on and off |
| 2 Pinch, nine tools | ✅ ratio 0.5 within 2%, spot between the fingers stays within 2 px, no Undo, road identical, tool never heard |
| 3 Two-finger drag, nine tools | ✅ view follows within 1.5 px, no zoom, no mark |
| 4 Second finger within 24 px | ✅ nine tools, plus Straight and Curve on their finishing press, Place with Redo waiting, Select on a road point: taken back, Undo and Redo and selection and shape as they were, carries on as a pinch |
| 5 Second finger late | ✅ same line and same road within 2 px, view never moved, resting thumb moves nothing |
| 6 Touch cancelled | ✅ mid-line, mid-drag, while armed, mid-pinch, window blur, a lost lift: nothing commits |
| 7 One finger | ✅ tap picks a point and a stretch, double tap adds a point, off-road pan gets all of its path, quick and slower |
| 8 3D | ✅ pinch, slide, twist each do only their own job, ground turns with the fingers, no tool fired |
| 9 Mouse and pen | ✅ press acts at once, right drag from the first pixel, wheel at the pointer, a mouse's pointercancel still lands the line, none of it armed |
| 10 Trial rail | ✅ fits, clears the notch, Select and Pencil tap, swipe scrolls and picks nothing |
| 11 World map | ✅ |
| 12 New track over warnings | ✅ finger at both windows, real mouse at 1920x1080: the road really has a near point warning; the rail's real New track and Don't save; `editor-ui` and the Overlay stay mounted; map empty, Pencil in hand; New track from 3D; the new road draws, one Undo; Undo mid-press on five tools throws nothing |

Scenarios 1 to 11, the last full run: 687 checks pass, 336 at each window, 15 desktop. Fingers landed 20.3 to 42.1 ms apart as the page measured, median 31.8. That run was before this follow-up. After it, on the final build, `--only 4,9,12`, the scenarios the follow-up touched: 336 pass, 0 fail (153 at each window, 30 desktop). Other gates: `bun run touch:check` 84 pass, also before the follow-up; `bun run typecheck` clean on the final tree; `phone:check` as in point 4 above.

**1920x1080 before and after.** 13 shots of main's build at 202af1c against this one, across all nine tools, hover, 3D and back. Differences are the same scattered faint noise as a build against itself:

| Pair | Most pixels differing | Biggest step, 2D map shots | Biggest step, 3D shot |
|---|---|---|---|
| Same build, twice (three pairs) | 20,790 | 22 | 68 |
| main against this build (two pairs) | 26,398 | 19 | 63 |

In the shots I broke down by screen area (select, curve, pencil), the differing cells fall on the same road edges in both kinds of pair. It is not literally pixel-identical run to run, on either build; shots are at `shots/editor-b1/desk-*.png`.

## Break it

Each ran at 874x402 with the source really broken, rebuilt, then restored (`cmp` against a clean copy).

| Break | Ran | Went red |
|---|---|---|
| No arm delay | all | 1, 2, 3, 6, 7, 8 |
| No second-finger handling | all | 2, 3, 4, 7, 8, 11 |
| `pointercancel` runs the lift, as today | all | 6 (half a line lands, one Undo) |
| Second finger takes back however late | 4, 5 | 5 |
| A pan ignores a late second finger | 7 | 7 |
| Armed points thrown away | 1, 7, 11 | 1 |
| Mouse goes through the arming | 9 | 9 |
| A taken-back press stays done | 4 | 4 |
| Pinch zooms at the screen's middle | 2, 11 | 2, 11 |
| Twist backwards | 8 | 8 |
| No twist threshold | 8 | 8 |
| A lost lift stays held | 6 | 6 |
| Finger left after a pinch forgotten | 7 | 7 |
| Rail as today | 10 | 10 |
| No page pinch guard | 10 | 0 (setup) |
| Guard on with no fingers | 9 | 9 |
| New track guard removed (as on main) | 12 | 12: the editor unmounts, by finger and by real mouse, on the real New track press |
| Mid-drag guard removed | 12 | 12: 14 page errors each, finger and mouse, from the wall ride and tunnel drags |

Things worth knowing from that:

- **No arm delay leaves no mark on its own.** The take-back catches a press that got through, so only "the tool never heard" goes red. The two layers overlap, which is good, but the arm delay's job is really stopping the flash and the sound.
- **Armed points took three tries to go red.** My first two versions passed under the break: the steady hand hides a lost start, and CDP's pace means only one or two moves arrive armed. The check now runs with the steady hand off and a first move of 3.2 px.
- **The width fix has no Chrome break:** Chrome's window doesn't change that way. Its proof is the Safari log.

## What real Safari showed

iPhone 17 Pro simulator, iOS 27.2, 874x292, notch and bars live. Log: `/tmp/sr2/phone/editor-b1-sim-log-final.txt`. Shots: `shots/editor-b1/sim-*.png`.

| Test | Result |
|---|---|
| `pinch.sh` on the map | ✅ Real two fingers, landing within 1 ms. Scale 1 throughout; mpp 4 to 1.13; spot between the fingers held (z -255 to -255.3); phase `map`; tool never heard |
| Pinch on the panel, guard off | ⚠️ Both fingers cancelled, page bulged to 946 wide, sprang back in about 1 s |
| Pinch on the panel and on the rail, guard on | ✅ Nothing moved, no cancel |
| `drag.sh` Pencil stroke on the road | ✅ Armed, then tool, Undo +1, "Redrew that stretch of road". `innerHeight` stayed 292: Safari drew, it did not scroll or collapse its bars |
| Tap | ✅ Reaches the tool on lift. `pointerup` comes before `touchend`, as the lost-finger code assumes |
| Rotate to portrait and back | ✅ Map layer follows both ways |
| Title's button | ✅ One programmatic click, mounts at 874 |

Not run in Safari: two-finger drag, twist, double tap, 3D (the rig has `rotate(withVelocity:)`, not added). Those rest on Chrome and Nathan's phone.

## Try this on your phone

Open the game, turn the phone on its side, tap **Road Editor** on the title. It looks rough on purpose: the box beside the tools is gone, the panel is thin, some words still say "click". Those come later. Swipe the tool list to see all of them.

1. **Draw.** Swipe the tools and tap New track (Don't save, if it asks). The Pencil is already in your hand. Draw a big loop with one finger and let go. *Good: the line starts right under your finger with no gap and no wait, and it becomes a road when you let go.*
2. **Pinch.** Pencil still on. Put two fingers on the road and spread them, lazily, one finger landing a moment before the other. *Good: the map grows around your fingers and the pencil never leaves a mark.*
3. **Slide.** Two fingers down, move them together, with any tool. *Good: the map stuck to your fingers, nothing drawn.*
4. **Thumb.** Draw a long slow line and halfway along rest your other thumb on the map, then lift it. *Good: the line carries on as if nothing happened.*
5. **Pick.** Tap Select. Pinch in until dots show on the road. Tap a dot, drag it. Double tap the road between dots. Drag empty map with one finger. *Good: each one answers straight away and you never wonder if it heard you. The double tap adds a dot; the drag slides the map.*
6. **3D.** Tap 3D, then Pencil. Pinch, slide, and twist two fingers. *Good: closer and further, the ground slides, the world turns with your fingers, nothing drawn.*

Tell us: did a line ever feel late (`ARM_MS` down)? Did a pinch ever leave a mark (`ARM_MS` up)? Did the page itself ever zoom or the bars jump? Don't judge the road tools' feel yet: Straight, Curve and Place still act as you press, with no preview. That's piece 2.

## For piece 2

- `takeBackPress`'s `undo()` line goes dead once Straight, Curve and Place commit on the lift. Delete it then. Until then, a slow pinch on those tools makes a blip of their sound and then "back".
- The layer forwards only the tool finger's `pointerleave`. The pointer wipe belongs in `onLeave`'s touch branch, and the layer needs no change.
- `pointer` is still set only on a move, so a tap reads a stale spot. `down` in the hands passed to `attachMapGestures` is the place to set it.
- Double tap's distance is still 6 px. Its time is now measured from the landing.
- A lost start only shows with the steady hand off. Any check of drawing feel should use it off.
- Untested and worth asking the phone: the swipe in from the left edge for Back. Layout C's map runs to the edge; the rail covers it today.

## Not done

Everything from piece 2 on. The gate's 18 (point 4): left alone, the lead is on it. A full rerun of scenarios 1 to 11 and the touch check after the follow-up: its only source changes are the two guards, and scenarios 4, 9 and 12 cover them. A real thumb on a real phone: nothing here says how it feels. Frame cost on a phone. The Home Screen window. No commit.

`ps aux` was refused by a hook early on. I dropped it, and it wasn't needed (`simctl list` answered the question).
