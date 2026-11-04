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
