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
| `pwa` | 844 x 390 | 47 / 47 / 21 | iPhone 14-class added to the Home Screen: the whole screen |
| `safari` | 844 x 340 | 47 / 47 / 0 | the same phone in Safari, tab bar showing (the tightest common height) |
| `small` | 667 x 331 | 0 / 0 / 0 | iPhone SE-class in Safari |

Stood up (390 x 844) must stay usable, not polished; a phone with its rotation locked still has to play.

## The rules

1. **Everything reachable by a thumb alone.** No screen, row or action needs a key, a mouse hover or a pad. Back is a real button (`UX-Jakob`, `UX-Active`).
2. **Targets at least 44 px tall** with a usable width, including slider thumbs' hit area, swatches, tabs, chips and arrows (`UX-Fitts`). Small text is fine on a phone; small targets are not.
3. **Nothing clipped or off screen.** A panel that can't fit scrolls inside itself by a finger swipe, and a swipe that starts on a row scrolls instead of pressing it. Scrolling never moves the page.
4. **Clear of the notch and the home bar.** Everything interactive stays inside the safe area; only the game's picture runs under them.
5. **One screen, one job.** On a 340 px tall window the primary action is visible without scrolling, on the first screen of every menu (`UX-Restorff`, `UX-Hick`). The logo and decoration give way before a control does.
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
