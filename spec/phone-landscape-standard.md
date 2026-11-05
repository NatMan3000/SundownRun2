---
type: spec
title: Sundown Run II on a landscape iPhone - the standard
description: What "fits properly on a landscape iPhone" means for every screen and HUD state, the rules each phone worker builds to, and the ledger of rulings for the phone pass.
created: 2026-11-05
---

# Sundown Run II on a landscape iPhone

Nathan, 5 Nov 2026: "it's been made for desktop, such as navigating through the menu or even the screen size, making sure that it all fits properly on a landscaped iPhone ... we might as well do it properly". Art direction and frame budgets stay `CONSTITUTION.md`; this page only adds what a phone needs. Who it is for: Josh (12) and Nathan, thumbs only, usually on Safari or added to the Home Screen.

## The windows

Every check runs at all of these, with the notch insets on. The first is the one that matters most.

| Name | CSS px | Insets (L / R / B) | What it is |
|---|---|---|---|
| `pwa` | 874 x 402 | 62 / 62 / 20 | Nathan's iPhone 17 Pro added to the Home Screen: the whole screen. Insets [live: simulator, iOS 27.2]; size from the screen [live], the saved copy itself not yet measured |
| `safari` | 874 x 292 | 62 / 62 / 20 | the same phone in a Safari tab, bars showing [live: simulator, iOS 27.2]. Safari's two-row top bar takes 110 px, and here `100vh` is 402 while the page gets 292, so use `dvh` for visible height |
| `small` | 667 x 331 | 0 / 0 / 0 | a small older iPhone in Safari: must work, need not shine |

Stood up (390 x 844) must stay usable, not polished; a phone with its rotation locked still has to play.

## The rules

1. **Everything reachable by a thumb alone.** No screen, row or action needs a key, a mouse hover or a pad. Back is a real button (`UX-Jakob`, `UX-Active`).
2. **Targets at least 44 px tall** with a usable width, including slider thumbs' hit area, swatches, tabs, chips and arrows (`UX-Fitts`). Small text is fine on a phone; small targets are not.
3. **Nothing clipped or off screen.** A panel that can't fit scrolls inside itself by a finger swipe, and a swipe that starts on a row scrolls instead of pressing it. Scrolling never moves the page.
4. **Clear of the notch and the home bar.** Everything interactive stays inside the safe area; only the game's picture runs under them.
5. **One screen, one job.** On a 292 px tall window (a Safari tab) the primary action is visible without scrolling, on the first screen of every menu (`UX-Restorff`, `UX-Hick`). The logo and decoration give way before a control does.
6. **A tap answers at once** with a visible change and its sound (`UX-Response`). A tap that opens something opens it; nothing needs a second tap because the first only "focused" it.
7. **While driving, nothing covers the road ahead or sits under a thumb.** HUD panels never overlap each other or the controls, in any mode, including the transient ones (toasts, countdown, trick pops, song name, sound chip, rewind tag).
8. **No key names on a phone.** "Press F", "Esc", glyphs for keys or pad buttons never show while touch is the device: they say the button's name, or nothing.
9. **Desktop and pad are untouched.** Everything hangs off `.sr-ui[data-touch]` or the `touch` device. A desktop shot before and after is identical.
10. **Same colours, same glass.** `CONSTITUTION.md` section 1: palette tokens only, no blur on anything that sits over the road while driving.

## The eight first-screen checks

Each screen's shot is read against these before it is called done (`~/.claude/skills/DesignPass/reference/ux-laws.md`): one thing stands out; a few choices, grouped; nothing to remember; groups mean something; works like the tools they know; the user's own words; no manual needed; answers fast.

## Decisions

| Id | Ruling | Why | Who |
|---|---|---|---|
| P1 | Target is landscape iPhone; stood up stays usable but is not polished | "fits properly on a landscaped iPhone" | Nathan, 5 Nov 2026 |
| P2 | Steering is a floating thumb stick on the left, Gas, Brake and Drift on the right; a touch on the right goes to the nearest button, and a thumb can slide between them, keeping its pedal when it slides onto Drift | No looking down; one thumb can power through a drift | Kai, 5 Nov 2026 |
| P3 | No service worker on the Home Screen copy | A deploy reaches an installed copy on its next open anyway; a cached shell behind Access is how a lapsed login bricks a PWA | Kai, 5 Nov 2026 |
| P4 | Menus are tapped directly, so the focus ring is hidden on touch | It answers a question a thumb never asks | Kai, 5 Nov 2026 |
| P5 | The Road Editor works on a phone too: its UI gets reconfigured for thumbs, and it is not hidden. Every editor function stays reachable. The layout is Nathan's pick from comps before the build | "if we can get the road editor to work, that'd be good. I think it needs a lot of effort to reconfigure the UI, but I think we can do it. Why not, lets go!" | Nathan, 5 Nov 2026 |
| P6 | Target phone is the iPhone 17 Pro. The menus already port well and are usable, so this pass fixes what overlaps and what doesn't fit, not a redesign of what works | "most of it's pretty good, it's ported over well, you can still press the menus and whatnot, so it's very usable, but there's obviously a few bits that are over top of other bits in the UI ... for a iPhone 17 Pro" | Nathan, 5 Nov 2026 |
| P7 | The Road Editor's phone layout is C, One tool button: the biggest map, one big button showing the tool in your hand, tap it for all nine tools and View, Undo and Redo always beside it, Menu, 3D, Checks, Save and Test drive down the right, settings in a card on the right. Pictures and plan: `spec/phone-editor/` | "d2 c one tool button", chosen over A Workbench (Kai's recommendation) and B Shelf | Nathan, 5 Nov 2026 |

## Sign-off

5 Nov 2026, commit d776896 (merged to main as 395e94c). Lead read every menu and HUD state in real Mobile Safari on the iPhone 17 Pro simulator at 874x292 (`scripts/ios-sim/sweep.sh`) [live]. Working views read: title, mode, track, garage, settings (car, handling, audio, multiplayer), pause, results, report, driving in free roam, race, stunt, Tag and Hunt Turns, plus countdown, toasts, speed trap and tricks with sound locked. A swipe up from a slider scrolled and left its value alone; a sideways drag set it; one tap walked title to mode to track to driving [live, simulator]. `bun run phone:check` all windows ALL PASS, every rule broken once and seen failing; `touch:check` 84 pass; desktop identical to 085600a apart from run-to-run noise. Fresh checker's verdict: ship, no blockers (`phone-checker`, report kept only in the session). `mp:check` 139 pass, 3 fail: the first three checks after a cold vite start, which also fail on 085600a under load and passed 142 of 142 on a quieter run of the HUD lane.

Not verified: a real thumb on a real phone at this commit, Home Screen window size (874x402 is the screen size), phone GPU cost, the iOS keyboard on Report, pad.

## Known, left for later

- First touch on the game freezes the page about 9 s on the simulator, inside `AudioContext.resume()` (`scripts/ios-sim/README.md`). On Nathan's real iPhone 17 Pro it is unnoticeable (his words, 5 Nov 2026), so it is the simulator's and nothing needs fixing.
- In a Safari tab on its side the keyboard leaves about 68 px of page and iOS's AutoFill bar sits on 44 of them, so a text box can't be seen while typing; the bar's tick brings it back (Multiplayer's name box, Report's boxes share `useKeyboardFit`) [live, simulator, 5 Nov 2026]. A Home Screen copy has about 178 px above the keyboard by the same sum; not seen on a phone yet.
- The gate can't see multiplayer on a phone (Pulse, Race, host banner). Pulse was placed by hand at 874x292, clear of Drift.
- World map labels overlap each other on a phone (canvas, `src/editor/mapDraw.ts`); goes with the Road Editor lane.
- Settings tabs start with Fun and Multiplayer off screen; Pause's Quit to title and Garage's Underglow and Light trail are below the fold at 292 with little cue.
- Pause shows Resume twice; Restart sits right under Resume; Mode's unlit rows can't be read before tapping them; Play is a lit row rather than a loud button. Left as they are under P6.
