---
type: auto
session_id: 9c5d033e-244d-47db-9d3f-e43e49f31c0a
project: SundownRun2
date: 2026-11-04
topic: Phone touch controls and Home Screen icon live, landscape iPhone DesignPass
duration: 11 minutes
events: 887
events_unit: turns
---

# Phone controls and the landscape iPhone pass

**Project:** SundownRun2
**Purpose:** Make the game drivable and properly fitted on a landscape iPhone.
**Duration:** 11 minutes
**Participants:** Nathan, Kai
**Session Restart ID:** `claude -r 9c5d033e-244d-47db-9d3f-e43e49f31c0a`

## Summary

Nathan found the online game loads on his iPhone with no way to drive. Touch controls and a Home Screen icon shipped first (085600a), and he confirmed both on his phone: "it works!" and "icon worked!". A full DesignPass for the iPhone 17 Pro then ran overnight in worker lanes. This log captures the session as of 04:02 AEDT on 5 Nov, when it was still live: the pass was merged on `phone/integrate` and waiting on a fresh checker, not yet on main or deployed.

## What We Did

1. Added touch as a third input device: a thumb stick wherever the left thumb lands, Gas, Brake and Drift on the right, a top row, a touch proof, and the Home Screen icon and manifest. Deployed at 085600a.
2. Wrote `spec/phone-landscape-standard.md` with decisions P1-P6, including no service worker (P3) and keeping the Road Editor on phones (P5).
3. Downloaded an iOS runtime and built a simulator rig that rotates, taps and drags over XCUITest, since this Xcode has no Simulator app. It measured real Safari landscape at 874x292, against the roughly 390 height the first layout assumed.
4. Built the gate `bun run phone:check` (merged to main, e32a4e9), proving each rule can fail. Its first baseline found 333 failures at the Home Screen size, 242 of them buttons under 44 px.
5. Ran HUD, play menu and panel lanes in separate worktrees and merged them on `phone/integrate`. The overlaps Nathan saw are gone in free, race and stunt shots. A Race press that starts nothing now says "Needs another player".
6. Read a sweep of every menu and HUD state in sim Safari. A fix-up worker cleared the trick score under the sound chip, the clipped Mode heading and two sibling overlaps, added gate steps, and moved the rig to `scripts/ios-sim/`.
7. Traced a 9 s first-tap stall in the simulator to `AudioContext.resume()` in `AudioSystem.unlock` (`src/audio/system.ts:223`). A plain page taps in 4 ms and later taps are instant. Not measured on a real iPhone.
8. Drew three Road Editor layouts and asked `D2`. Started the fresh-context checker on the merged build.

## Key Decisions

| Decision | Rationale |
|----------|-----------|
| Target iPhone 17 Pro; fix overlaps and fit, don't redesign (P6) | Nathan: "most of it's pretty good ... a few bits that are over top of other bits" |
| Road Editor stays on phones and gets rebuilt for thumbs (P5) | Nathan: "if we can get the road editor to work, that'd be good ... lets go!" |
| No service worker (P3) | Recorded in the standard's ledger |
| Skip the full DesignIntent interview | CONSTITUTION plus the standard are the intent; Nathan asked for the pass, not a questionnaire |
| Rule 5 judges the first screen at 292 px | The measured Safari tab height |
| Gate gets a Safari units shim (R11) | Safari's vh differs from Chrome's in the same window: 1vh = 4.02 px at 292 tall |
| Desktop "CHANGED" on title and track is noise | A focus glow that flips between runs, and 1 px at 1/255 |

Left as they are for Nathan's final note: Restart second on Pause, Resume shown twice on Pause, Mode's unlit rows, Play as a lit row. Hunt's idle clock is hidden on touch to make room, so its best time no longer shows there.

## Files Created

| File | Purpose |
|------|---------|
| `src/ui/TouchControls.tsx` | On-screen controls |
| `public/manifest.webmanifest`, `public/icons/icon.svg` | Home Screen app |
| `scripts/make-icons.ts` | Icon generator |
| `spec/phone-landscape-standard.md` | The phone standard and decisions ledger |
| `scripts/phone-gate.ts` | Phone gate (merged to main) |
| `scripts/ios-sim/` | Simulator rig (on `phone/integrate`) |

## Files Modified

| File | Change |
|------|--------|
| `CONSTITUTION.md`, `scripts/touch-check.ts` | Edits on the `phone/hud` lane |
| HUD, menu and panel UI, `CLAUDE.md` | On `phone/integrate` until merged |

## Next Steps

Held by the live session (notes: `~/.claude/state/session-notes/32383-1793796421.md`); no thread opened, since `D2` has its own card and the session owns the rest.

- ⬜ Read phone-checker's report (`/tmp/sr2/phone/checker-report.md`), fix blockers through a worker
- ⬜ Merge `phone/integrate` to main, deploy on the standing yes, live probe, tell Nathan
- ⬜ Ask Nathan how long his first tap takes after the deploy; steering feel and multi-mode HUD are also unverified on a real phone
- ⬜ Shut the simulator down: its built-in apps raise Little Snitch alerts on the Mac (Deny is safe)
- ⬜ `D2` Road Editor layout (Nexus #1731): A Workbench (recommended), B Shelf, C One tool button. On his answer, record P7 and spawn a fresh worker in `/tmp/sr2/wt/editor` for Phase B, gesture layer first

## Open Questions

- Does a real iPhone stall on the first tap?
- Why did the map's road line vanish with 6 game tabs open in sim Safari? One tab is fine at 150 s; cause unproven.

## Related Sessions

- [2026-11-03-online-cloudflare-track-library.md](2026-11-03-online-cloudflare-track-library.md)
- [2026-11-05-road-editor-phone-phase-b.md](2026-11-05-road-editor-phone-phase-b.md): the same process from 04:02 AEDT on 5 Nov, which finished every Next Step above

## Atom candidates

<!-- KAI-ATOMS-VERBATIM -->
- FACT: An iPhone 17 Pro in landscape gives a Safari tab only 874x292 of its 874x402 screen, because Safari's bars take 110 px, so a landscape web layout must be measured at the tab height and not the screen height (measured in the iOS Simulator, Nov 2026).
- GOTCHA: A Chrome window sized to iOS Safari's tab height mis-measures vh layouts, because Safari resolves 1vh to 4.02 px on an iPhone 17 Pro in landscape at 292 px tall; a phone gate needs a Safari units shim or a real simulator shot.
- GOTCHA: The Xcode 27.2 install has no Simulator app and simctl cannot rotate a device, so landscape iOS Simulator work needs an XCUITest route for rotation, taps and drags; a tap on a heavy live page can take about 3 minutes.
- GOTCHA: A booted iOS Simulator's built-in apps raise Little Snitch alerts on the Mac (the News widget calling Apple); Deny is safe for Safari-on-localhost testing, and shutting the simulator down stops them.
- GOTCHA: In the iOS Simulator, AudioContext.resume() on the first touchend can block the page for about 9 s before the click arrives, so a first tap that seems ignored may be audio unlock rather than the rig or the menus; compare with a plain page before blaming the UI.
<!-- /KAI-ATOMS-VERBATIM -->
