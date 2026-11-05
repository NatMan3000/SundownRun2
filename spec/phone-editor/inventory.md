---
type: spec
title: Road Editor on a phone - every action and where it goes
description: Every Road Editor action and state, how it is reached today and where it goes on a phone, with the rulings that hold it in place. Written for layout A; the last section says what changes under C, which Nathan picked.
created: 2026-11-05
---

# Road Editor: every action and state, and where it goes on a phone

Read from the code in `/tmp/sr2/wt/editor` at 0d0f714, and from the real editor in a phone window. Nothing is cut (P5). "Phone" is written for layout A, the recommendation; the last section says what changes under B or C.

Marks: **KEEP** stays where you would look for it (same side, same order, same words), **MOVE** a new spot but still one tap, **STEP** one labelled step away.

How to get in: `?editor=1` only works while the game sits on the title screen, and `?track=` skips the title, which is why `?touch=1&track=...&editor=1` did nothing. The way in is the title's Road Editor button (or `?editor=1&touch=1` with no `track`). Also from the pause menu.

Rulings this inventory stays inside:

| Ruling | Source | What it holds in place |
|---|---|---|
| Rail order: Select, Pencil, Straight, Curve, Bend, Bank, Height, Width, Place pieces | `b82859e`, `04092b6` (Nathan: "swap height and bank"), EditorUi.tsx header | The order, on every layout |
| No Pan tool: right, middle or Space drag pans with every tool | `b82859e`, Overlay.tsx header | No hand tool on the phone either: two fingers do it |
| Every tool shows its name in words; icons alone aren't self-explanatory | `6ff151e` (Nathan: the icons "aren't really self-explanatory", tooltips "take a long time to come up") | Names stay on every tool button |
| Height, Bank and Width are three tools, not one Stretch tool | `6ff151e` (Nathan: "probably should be three different separate tools") | No grouping them to save rail space |
| The preview shows "where the final thing will end up" before you commit | `6ff151e` | Finger down previews, finger up commits |
| One way to change heights: the Height tool | `6ff151e` | The point card keeps its button, gets no slider |
| Tunnels live in the Height tool, footprint shown before the click; every tool works in 3D | session 3 Oct, `4099e62` (Nathan: "I should be able to just do any edits in the 3D mode") | Both stay |
| Drive to draw is for the empty map only | `b82859e`, EmptyMapNote | Stays there |

## The tool rail

| Action | Reached today | Phone | Mark |
|---|---|---|---|
| Select | rail, V | rail | KEEP |
| Pencil | rail, P | rail | KEEP |
| Straight | rail, L | rail | KEEP |
| Curve | rail, C | rail | KEEP |
| Bend | rail, G | rail | KEEP |
| Bank | rail, B | rail | KEEP |
| Height | rail, H | rail | KEEP |
| Width | rail, N | rail | KEEP |
| Place pieces | rail, keys 1-9 and 0 | rail, named "Pieces" (the cell is too narrow for two words); the card still says Place pieces | KEEP |
| Undo | rail, Ctrl+Z, pad X | rail | KEEP |
| Redo | rail, Ctrl+Shift+Z, Ctrl+Y, pad Y | rail | KEEP |
| Zoom in, Zoom out | rail, + and -, wheel at the pointer, pad triggers | pinch at the fingers; also rail's View > Zoom in, Zoom out | MOVE (pinch), STEP (buttons) |
| Fit track | rail, F | rail's View > Fit track | STEP |
| Whole world | rail | rail's View > Whole world | STEP |
| New track | rail, pad B | Menu | STEP |
| Random track | rail | Menu; and on the empty map's note | STEP, KEEP |
| Library | rail, panel | Menu > Library | STEP |
| What a button does (hover tip with its key) | hover, 100 ms | tap picks the tool and the status line says what it does (`pickTool` already does); key names never show | MOVE |

## The chosen tool's own settings (ToolOptions, today a box beside the rail)

| Action | Reached today | Phone | Mark |
|---|---|---|---|
| Pencil: Steady hand slider and three help lines | always on while Pencil is picked | chip by the rail, "Steady hand: Some", opens the card | STEP |
| Pencil: straight line | hold Shift while drawing, let go to carry on freehand | "Straight line" toggle on the chip row; the other thumb taps it while the line is going | MOVE |
| Bend: Reach slider | box, while dragging also wheel or [ and ] | chip "Reach: 120 m", opens the card; while a finger is on the road it shows minus and plus for the other thumb (same 1.25x step as [ and ]) | STEP, MOVE |
| Straight, Curve: the numbered steps | box, current step lit | status line says the step you are on, with "Start again" | MOVE |
| Height, Bank, Width: the two steps, how to change one again | box | status line says the step; "how to change one again" is at the bottom of the card | MOVE, STEP |
| Place: piece palette (all 11: Boost pad, Ramp, Loop, Wall ride left, Wall ride right, Half-pipe, Speed trap, Tunnel, Start line, Crash props, Energy core) | box beside the rail, key per piece, blurb in hover | card, three across; picking one folds the card to a chip naming the piece, and says the blurb on the status line | MOVE |

## On the map

| Action | Reached today | Phone | Mark |
|---|---|---|---|
| Pan | right or middle drag, Space + drag, WASD, arrows, left stick; left drag off the road with Select, Bend, Straight, Curve; any drag on an empty map with a tool that needs a road | two fingers, every tool; one finger off the road where the tool has nothing to do there | MOVE |
| Zoom | wheel at the pointer, + and -, triggers | pinch at the fingers | MOVE |
| Draw with the Pencil | left drag | one finger | KEEP |
| Pick a piece, prop, core, road point, crossing | click (radii 18, 16, 14, 9, 12 px) | tap (radii 28, 26, 26, 22, 24 px; nearest wins) | KEEP |
| Move what's picked | left drag | one finger; what you drag rides 56 px above the finger | KEEP |
| Add a road point | double-click the road, Select (350 ms, 6 px) | double-tap (350 ms, 20 px); the point card and the status line say so | KEEP |
| Delete the picked thing | Delete or Backspace, card button | card's Delete | KEEP |
| Bend the road | left drag on the road | one finger | KEEP |
| Straight | click, click | tap the start; press, slide to see the preview, let go to do it | KEEP |
| Curve | click, click, move, click | tap the start; tap the end; press, slide to pull, let go to do it | KEEP |
| Height, Bank, Width: pick a stretch | drag along the road, or click | same, one finger | KEEP |
| Place a piece | click (acts on button down); wall ride or tunnel: click or drag | press shows the preview, slide to move it, let go places it; wall ride and tunnel: drag draws the length, as today | KEEP |
| Click a BRIDGE, RAISED, BANK or WIDTH label, or a problem's pin, with any tool | click | tap, boxes grown by 8 px. A problem's pin: any tool. The labels only with the tool that changes them (P8, Nathan, 5 Nov 2026): RAISED and DUG with Height, BANK with Bank, WIDTH with Width, the crossing's pill (BRIDGE, UNDERPASS, TUNNEL, LOW BRIDGE, ROADS MEET) with Select. A hidden label has no tap target, so the shortcut from other tools goes. The dashed lines and dots stay. Desktop unchanged | MOVE |
| Stop a drag, a line, a bend, a half-made shape | Esc | "Cancel" takes the Undo button's place while a finger is on the map (other thumb); "Start again" on the status line for a half-made shape | MOVE |
| What a tool would do, before you press | hover | shown while the finger is down, before it lifts | MOVE |
| x, z readout | hover | shown while a finger is on the map | MOVE |
| Scale bar | always, 96 px from the left | always, at the top left of the map, clear of the notch and the top edge, and shorter (Nathan, 5 Nov 2026) | MOVE |
| Compass | beside the 3D button | above the right stack; dropped under 300 px height on the map, where it never turns, and shown in 3D | MOVE |

## The panel, today one tall column

| Action | Reached today | Phone | Mark |
|---|---|---|---|
| Road point: which one, Corner slider, height note, Change the height here, Delete, Done | panel when picked | card when picked | MOVE |
| Boost: Kick, Length, Across the road. Ramp: Height, Length, Across the road. Loop: Size. Wall ride: side, Length, Wall height. Speed trap note. Tunnel: Length. Delete, Done | panel when picked | card when picked | MOVE |
| Crash props: What's in the pile, How many. Energy core: Height. Delete, Done | panel when picked | card when picked | MOVE |
| Crossing: Swap, Send under, Make a bridge, Make an underpass, Put one in a tunnel, Make it a bridge instead, Make it an open cutting instead, and the words for each | panel when picked | card when picked; buttons first, the long words under them | MOVE |
| Height: Make it a tunnel (hover shows the footprint), Tunnel length, Take the roof off, slider, On the ground, Make the stretch N m long, Smooth the bumps here, Change this stretch's | panel when picked | card when picked, slider first; the footprint shows only while a thumb is held on Make it a tunnel: letting go on the button acts, sliding off lets go without acting, and if it can't fit the words under the button say so and the lift does nothing (Nathan: "Try to keep the track field clear") | MOVE |
| Bank: slider, Auto, Change this stretch's. Width: slider, Track width, Change this stretch's | panel when picked | card when picked | MOVE |
| "Show it on the map" (press the selected thing's title) | panel | card, same | KEEP |
| Problem: words, Fix it, Show me, by-hand words | panel when picked | card when picked, Fix it above the long words | MOVE |
| Checks: verdict, rows, Fix all (N), "and N more" | panel | Checks button on the right stack opens the card; pins stay lit on the map; the button shows the number of problems | STEP |
| Track name | panel top | Menu > Track | STEP |
| Saved or not, stats (Length, Pieces, Bridges) | panel top | dot on the Save button; full words and stats in Menu > Track | MOVE, STEP |
| "building..." and "needs fixing" | panel top | on the Checks button | MOVE |
| Road width, Road surface, World, Time of day, Edge lights, Made by, About this track | panel | Menu > Track | STEP |
| Smooth the road | panel | Menu > Track | STEP |
| Drive to draw | panel and note, empty map only | the empty map's note, and Menu > Track | KEEP, STEP |
| Map key (every mark and what it means) | panel | Menu > Map key | STEP |
| What Save will do, one line | panel bottom | status line after a press; Menu > Track | MOVE |
| Save | panel bottom | right stack | MOVE |
| Save as new track | panel bottom | Menu | STEP |
| Test drive | panel bottom, hold View on a pad | right stack, the one filled button; closes the card first if one is open (Done) | MOVE |
| Exit | panel bottom, Esc when nothing else is going on | Menu | STEP |
| Slider help (the `title` on each) | hover | under the slider while your thumb is on it | MOVE |

## Library, share and online (all dialogs; Menu > Library opens them)

| Action | Reached today | Phone | Mark |
|---|---|---|---|
| Your tracks, Shared tracks, Everyone's tracks tabs | click | tap, full-screen page | KEEP |
| Now editing line, New track with its World, Start drawing | click | same, in the page | KEEP |
| Row: Open, Share, Export, Delete, Copy and edit, sync chip | click; Share's refusal and the chip's meaning in hover | tap; the refusal already shows on the tap, the chip gets its words under the row | KEEP |
| Delete asks through `window.confirm` | click | same; it is a real phone dialog with real buttons | KEEP |
| Import a track file, Export this track | file picker, download | same (see UNCERTAIN in the report: Export on a Home Screen copy) | KEEP |
| Shared tracks: Refresh, Download, Open, Download again, little map | click | same | KEEP |
| Everyone's tracks: Refresh, Open, Copy and edit, little map | click | same | KEEP |
| Share box: Made by, Cancel, Share it, Done, See it on GitHub | click, Enter | same; inputs at 16 px so Safari doesn't zoom | KEEP |

## Questions

| Action | Reached today | Phone | Mark |
|---|---|---|---|
| Save first? Cancel, Don't save, Save it | click, arrows, Enter, Esc, pad | tap; the "Esc or B cancels" line hides on touch; a tap outside is Cancel | KEEP |
| Make a random track? Cancel, Make one | same | same | KEEP |

## 3D view

| Action | Reached today | Phone | Mark |
|---|---|---|---|
| Open, close | 3D button, T, pad B to close, Esc | 3D button on the right stack; "Back to the map" in the note | KEEP |
| Every tool in 3D | as on the map | same handlers, same gestures | KEEP |
| Turn | right drag, Q and E, right stick; left drag where the tool has nothing to do | two fingers twist; one finger where the tool has nothing to do | MOVE |
| Tilt | right drag up and down, right stick | one finger up and down where the tool has nothing to do | MOVE |
| Slide | middle drag, Space + drag, WASD, arrows, left stick | two fingers drag | MOVE |
| Zoom | wheel, + and -, triggers | pinch | MOVE |
| The hint line | always, names mouse buttons | names fingers | KEEP |

## Drive to draw

| Action | Reached today | Phone | Mark |
|---|---|---|---|
| Finish, Clear, Clear it, Keep it, Cancel; the loop closes itself | bar at the top, click only (inline styles, buttons about 31 px tall, one 14 px line) | the same bar made thumb sized and clear of the touch controls' top row | KEEP |

## Leaving, and the Esc ladder

Esc today does the first of: close a dialog, stop a bend, half-made shape or drag, back from 3D, clear the selection, leave (asking first). On the phone each rung has its own button, so there is no one Back to learn: Close or Cancel in the dialog, Cancel or Start again on the map, Back to the map in 3D, Done on the card, Exit in the Menu.

Pad and keyboard stay exactly as they are; a pad plugged into a phone still works.

## States

| State | Shows on the phone |
|---|---|
| Empty map | Pencil on, note in the middle of the free map, Random track filled, Drive to draw beside it; Checks, Save, Test drive, Undo and Redo dashed and off, saying why when tapped (today's rule) |
| A road, nothing picked | Rail, right stack, chip for the tool's setting |
| Drawing, bending, dragging, picking a stretch | The map only: the status line says what letting go will do; Cancel in Undo's place |
| Half-made Straight or Curve | Status line says the step, with Start again |
| Picked: piece, props, core, point, stretch, crossing | Card |
| Problem picked or Checks open | Card, pins lit |
| Placing | Card to choose, then chip naming the piece |
| Building or fixing | Checks button says so at once; a slider that is building is greyed, as today |
| Library, share, question | Over everything, map hidden behind |
| 3D opening, 3D | Same screen; 3D button says Map; note says what fingers do |
| World map over a paused game | Rail is View only, card holds Map key, one Back to the game. Its way out is `phone-panels`' (not touched here) |
| Typing a name | Menu > Track scrolls so the box stays above the keyboard |

## If the owner picks B or C

| | B (Shelf) | C (One tool button) |
|---|---|---|
| Tools | KEEP order, along the bottom | STEP: all nine behind the tool button |
| Undo, Redo | right end of the shelf, always | beside the tool button, always |
| View | shelf | STEP inside the tool tray |
| Save, Test drive, Checks, 3D, Menu | top row | right stack |
| Track name and save words | top left | Menu |
| Tool settings and picked things | swap in for the tools on the shelf, one row plus words | card on the right |
| Everything else | as above | as above |

### C as built, with Nathan's ruling on the map (P8, 5 Nov 2026)

"The steady hand picker should be somewhere else (or hidden), it doesn't make sense being out there by itself. Keep the road world clear." So wherever the sections above say "chip", under C it is this, and nothing of the kind sits on the map:

| Action | Under C |
|---|---|
| The tool's setting: Steady hand, Reach, Straight's and Curve's steps, how Height, Bank and Width pick a stretch | STEP, STEP: tap the tool button, then the row above View in the tray, in the same words ("Steady hand: Some"). It opens the card. Tapping the tool you already hold in the tray opens it too. Select has no setting, so no row |
| Which piece you are placing | The tool button names it ("Boost pad", with the Pieces icon). Tool button, then the tray's row, opens the palette to change it |
| Pencil's Straight line, Bend's minus and plus | Only while a finger is on the map working that tool; they go when it lifts. They sit beside the tool button and act on the second finger's press |
| What a tool does, when you pick it | One line in a thumb's words, about 50 letters, one line at every window. The full explanation is the tool's card, from the tray's row. A computer keeps its long tips (`TOOL_TIPS_TOUCH`, `TOOL_TIPS`, `EditorUi.tsx`) |
| Stop a half-made Straight or Curve | Cancel in Undo's place, for as long as the shape is half made (the status line still says the step) |
