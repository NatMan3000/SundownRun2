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
| `scripts/editor-touch-check.ts` | `permanent` | Editor touch check behind bun run editor:touch: drives the Road Editor's gesture layer with real multi-finger CDP touch events |
| `public/manifest.webmanifest` | `permanent` | Home Screen app manifest |

## `scripts/` (Warden 2026-10-15)

| File | Retention | Description |
|------|-----------|-------------|
| `scripts/learn-to-code.ts` | permanent | LEARN TO CODE - bun run learn |
| `scripts/check-tracks.ts` | permanent | CHECK TRACKS - prove a track file works without opening the game |
| `scripts/library-import.ts` | permanent | One-time import of the GitHub shared tracks into the online track library (admin, cloud/README.md step 7) |
