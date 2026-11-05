# File Index

| File | Retention | Description |
|------|-----------|-------------|
| `CONSTITUTION.md` | `reference` | Art direction, colour semantics, frozen contracts, amendments |
| `TASKS.md` | `reference` | Living build checklist for the orchestrated build |
| `TIMELINE.md` | `reference` | Project milestones |
| `Learn To Code.html` | `reference` | Josh's Learn To Code workshop page |
| `Sundown Run II.bat` | `permanent` | Windows launcher |
| `Sundown Run II Multiplayer.bat` | `permanent` | Windows LAN multiplayer launcher |
| `Sundown Run II Update.bat` | `permanent` | Windows update launcher |
| `scripts/probe.ts` | `permanent` | Headless GPU Chrome probe |
| `tracks/afterglow.json` | `export` | Afterglow figure-eight track |
| `tracks/hyperdrome.json` | `export` | Hyperdrome bank track |
| `tracks/neon-pocket.json` | `export` | Neon Pocket, authored from the README only |
| `docs/title-screen.jpg` | `permanent` | Title screen screenshot shown at the top of the README |
| `plans/scope-tunnels.md` | `reference` | Tunnels scope (GitHub #9 part 3): options, needs, risks, three stages |
| `cloud/README.md` | `reference` | Online copy on Cloudflare: local try-out, deploy, custom domain, Access setup, budget |
| `spec/phone-landscape-standard.md` | `reference` | Landscape iPhone standard and decisions ledger (P1-P7) |
| `spec/phone-editor/plan.md` | `reference` | Road Editor on a phone: what today's touch does, the gesture map, the layouts compared, the ten pieces of Phase B |
| `spec/phone-editor/inventory.md` | `reference` | Every Road Editor action and state, and where it goes on a phone |
| `spec/phone-editor/piece-1-report.md` | `reference` | Piece 1, the gesture layer: numbers, break-it table, Safari results, the phone trial list, notes for piece 2 |
| `spec/phone-editor/piece-3-5-report.md` | `reference` | Pieces 3 to 5, layout C: shell, card, Menu, the map kept clear (P8), the gate's editor steps, the merge's red lines, break-it tables |
| `spec/phone-editor/*.png` | `reference` | Pictures of the chosen layout (C, One tool button) and the sheet of all three |
| `scripts/make-icons.ts` | `permanent` | Home Screen icon generator |
| `scripts/phone-gate.ts` | `permanent` | Phone gate behind bun run phone:check |
| `scripts/chrome.ts` | `permanent` | Finds which Chrome the dev tools drive: explicit path, $CHROME_PATH, puppeteer's cache, then an installed one |
| `scripts/touch-check.ts` | `permanent` | Touch check behind bun run touch:check: drives the phone controls with real CDP touch events |
| `scripts/lap-check.ts` | `permanent` | Lap check behind bun run lap:check: a real 3 lap race driven by the demo autopilot; the toasts must be "Lap 2 of 3" then "Final lap", none after the finish |
| `scripts/dev-server-check.ts` | `permanent` | Dev server check behind bun run dev:check: dev server and preview on scratch ports from a throwaway copy with a FAKE github-token.txt; no request may get a secret's contents back, and the game, /api/report and /api/tracks still answer |
| `src/core/ghostStore.ts` | `permanent` | Which saved ghost laps this browser keeps: one per track id, all dropped when storage is full |
| `scripts/format.test.ts` | `permanent` | Unit check behind bun run test:format: the Time of day row shows a clock time, never the 0 to 1 number |
| `scripts/editor-touch-check.ts` | `permanent` | Editor touch check behind bun run editor:touch: drives the Road Editor's gesture layer with real multi-finger CDP touch events |
| `public/manifest.webmanifest` | `permanent` | Home Screen app manifest |
| `research/2026-11-05-ponytail-sundownrun2-audit.md` | `reference` | Read-only code audit of main at 3c6b1cd (18 findings, 4 must-fix) with Kai's spot-check and five findings of his own |

## `scripts/` (Warden 2026-10-15)

| File | Retention | Description |
|------|-----------|-------------|
| `scripts/learn-to-code.ts` | permanent | LEARN TO CODE - bun run learn |
| `scripts/check-tracks.ts` | permanent | CHECK TRACKS - prove a track file works without opening the game |
| `scripts/library-import.ts` | permanent | One-time import of the GitHub shared tracks into the online track library (admin, cloud/README.md step 7) |
| `scripts/editor-backends.ts` | permanent | The two things the Library talks to (home, online), in-process, shared by the phone gate and the editor touch check so they run with no server, GitHub or Cloudflare |
| `scripts/ios-sim/tap.sh` | permanent | iOS Simulator rig: a tap at points from the window's top-left, through XCUITest |
| `scripts/ios-sim/sweep.sh` | permanent | iOS Simulator rig: real Safari one state at a time from a steps file, Safari restarted between them |
| `scripts/ios-sim/sweep-server.ts` | permanent | iOS Simulator rig: serves a built game with a small script added so a URL can open any screen |
| `scripts/ios-sim/rotate.sh` | permanent | iOS Simulator rig: sets the device orientation through XCUITest |
| `scripts/ios-sim/_run.sh` | permanent | iOS Simulator rig: builds the XCUITest bundle when needed and runs a single test on the booted simulator |
| `scripts/ios-sim/shot.sh` | permanent | iOS Simulator rig: opens a URL in Safari, waits 4 s, screenshots |
| `scripts/ios-sim/sheet.ts` | permanent | iOS Simulator rig: lays sweep shots out as 874x292 cells on one sheet |
| `scripts/ios-sim/_env.sh` | permanent | iOS Simulator rig: sourced by the scripts, finds the booted iPhone 17 Pro and the output folder |
| `scripts/ios-sim/pinch.sh` | permanent | iOS Simulator rig: a two-finger pinch through XCUITest, on the page or on a labelled element |
| `scripts/ios-sim/drag.sh` | permanent | iOS Simulator rig: a drag between two points, same coordinates as tap.sh |
| `scripts/ios-sim/proj/project.yml` | permanent | iOS Simulator rig: project spec for the Host app and the UITests bundle |
| `scripts/ios-sim/proj/Host/App.swift` | permanent | iOS Simulator rig: the empty SwiftUI host app the UI tests need |
| `scripts/ios-sim/proj/UITests/RigTests.swift` | permanent | iOS Simulator rig: the XCUITest cases behind rotate, tap, drag and pinch, driving Safari |
