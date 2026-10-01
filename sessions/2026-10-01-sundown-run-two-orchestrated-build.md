---
type: auto
session_id: e3382bc5-22eb-447a-90db-5701667e6f05
project: SundownRun2
date: 2026-10-01
topic: Sundown Run Two clean-room orchestrated build (lead + 15 workers and checkers)
duration: 6.2 hours
events: 14812
events_unit: turns
---

# Sundown Run Two - orchestrated build

**Project:** SundownRun2 (`~/Dev/SundownRun2`)
**Purpose:** Rebuild Josh's golden-hour 3D driving game from an empty repo, with every lesson from the July Sundown Run written into the brief up front
**Duration:** 6.2 hours
**Participants:** Nathan, Kai (lead orchestrator + 15 worker/checker sessions)
**Session Restart ID:** `claude -r e3382bc5-22eb-447a-90db-5701667e6f05`

## Summary

Nathan asked for a clean run of Sundown Run as "Sundown Run Two", built from scratch by one orchestrated session. The lead froze the contracts and a CONSTITUTION, spawned nine owned-area workers (track, vehicle, world, look, audio, ui, play, editor, net), and drove a loop of independent hands-off checkers (frozen worktree, production build, one tab) whose verdicts were routed back to fresh workers when the originals hit ~75% context. By the end of the window the repo had ~198 commits, every system existed and was playable on port 5201, and remaining work was checker-driven fixing, chiefly car physics on loops and banks plus a Rocket League style car redesign Nathan asked for late in the session.

## What We Did

1. Foundation: repo initialised (Vite 8, React 19, r3f, rapier, zustand), CONSTITUTION.md, frozen contracts in `src/core/*` and `src/track/schema.ts`, probe script with headless GPU Chrome, worker briefs in `scratchpad/briefs/`, living checklist `TASKS.md`.
2. Nine workers built the systems in parallel: data-driven tracks (Afterglow figure-eight, Hyperdrome with live bank slider, Neon Pocket authored from the README only), raycast car sim with magnetic loops and wall rides, synthwave sky and city, wet neon road and post stack, procedural music, menus/HUD/Garage, game modes with Ai racers and crash props, a road editor with drive-to-draw, and LAN multiplayer with tag.
3. Independent checkers (audio, ui, mp, onefile, feel, editor round-trip, visual judge, hyper bank) produced verdicts with defect IDs; each was routed to the owning worker and re-checked.
4. Context rotation: track, vehicle, world, look, editor, ui and play were retired at ~75-80% context and replaced by fresh workers (track2..4, vehicle2..4, world2, look2, editor2, ui2, play2) started from written handoff files.
5. Nathan asked for car designs "better than the previous Sundown Run", inspired by Rocket League; a cars worker shipped five new bodies (dart, blade, brick, manta, pulse) with rocket nozzles and neon signatures.
6. Learn To Code page and Windows launchers (`Sundown Run Two*.bat`) added for Josh.

## Lead

**Session Restart ID:** `claude -r e3382bc5-22eb-447a-90db-5701667e6f05`

- Wrote CONSTITUTION, contracts, briefs (COMMON, per-worker, CHECKER) and TASKS.md; owned contract changes (e.g. `playerGridSlot`, `garageOpen`, `setTrackParam(null)`).
- Ticked TASKS only against tool results or checker passes, never worker reports; committed workers' rounds by explicit path.
- Ruled on cross-owner disputes (Hyperdrome stands distance, bridge/self-crossing validator, ramp gate flakiness) and routed checker defects.
- Gave Nathan a mid-build status (about three-quarters done, car physics the bottleneck) and spawned the Rocket League car round.

## Workers

### Worker - track
**Restart ID:** `claude -r 4d6e8039-62a7-4270-9a2d-b7a880761758`
- Validator, builder, colliders, terrain recipe, derived racing line and `tracks:check`; three rounds committed.
- Asked to add gradient-aware braking for the Afterglow downhill right-hander before retiring.

### Worker - world
**Restart ID:** `claude -r 649a06bc-4d65-44f6-8bd5-386ed371da6d`
- Sky, sun, city, terrain look, Hyperdrome stadium; handoff at `/tmp/sr2/reports/world-handoff.md`.
- Lead ruled the Hyperdrome stands stay 63 m off the road.

### Worker - audio
**Restart ID:** `claude -r f269953c-b9ce-4f13-8d4d-da51e7536adc`
- Procedural music, engine, countdown; fixed the audio-1 failures (countdown abort silences beeps, pad-only press no longer unlocks audio).

### Worker - play
**Restart ID:** `claude -r 1cde5aea-2ee9-4110-b625-ffd85f218c7d`
- Game modes, Ai driving brain, race book, crash props, energy cores; brain lands ramps, never enters a loop under 110 km/h (`bcaec52`).

### Worker - editor
**Restart ID:** `claude -r e6af70a3-2632-4735-9ef4-e2a616347454`
- Road editor stage 1 (draw, clean-up, live preview, save, test-drive); 17 self-checks; handed off the gates switch-over.

### Worker - ui
**Restart ID:** `claude -r 79b8b602-3b17-4226-9daa-c50a7aeec264`
- Menus, settings, HUD, Garage; low-quality preset drops backdrop blur over the WebGL canvas.

### Worker - look
**Restart ID:** `claude -r decda760-3664-47ee-a1fb-3482dcdbfe99`
- Wet neon road, car fx, post stack, quality presets; stood by for the visual judge.

### Worker - vehicle
**Restart ID:** `claude -r ae67fd3f-3c83-429f-b187-4b573e9721dc`
- Raycast car sim, input, cameras, lap/trick tracking, demo autopilot; three stages plus a 10-item fix round.

### Worker - track2
**Restart ID:** `claude -r c5acefb5-11fe-4234-abe8-dca9d3fc59cd`
- Six rounds from the track handoff; found 64-bit collider IDs being stored lossily (same bug flagged in `CrashProps.tsx`).

### Worker - vehicle2
**Restart ID:** `claude -r 5376f619-1757-4b95-973e-99b206a19e06`
- Continued the car fix list (loop frame twist, lap validity fields) from the vehicle handoff.

### Worker - editor2
**Restart ID:** `claude -r 096c4d57-a326-42b9-bd43-05b8139368bc`
- Made the editor's "All good" verdict agree with `bun run tracks:check`.

### Worker - world2
**Restart ID:** `claude -r 5ad186ab-facb-4578-8fe7-36bad07b77cb`
- Fixed visual-1 world defects: triplanar steep ground, no magenta rim, Hyperdrome city as a full 360 ring.

### Worker - look2
**Restart ID:** `claude -r eec18c78-19b7-42c0-92b8-3863953e45a4`
- Five rounds: Garage light trail, clean start/finish checker band, Hyperdrome barrier top luminance p50 96 -> 38.

### Worker - checker hyper-1
**Restart ID:** `claude -r 01e03504-a77b-4d5c-a2de-18144068002f`
- Hyperdrome bank and speed-trap check; demo crashed at 60 degrees, clean at 30; flagged rebuild stutter and per-angle best speed.

### Worker - checker visual-2
**Restart ID:** `claude -r d8cd770b-06c3-40a7-bc7a-762cb6486476`
- Visual judge across three tracks, sundown and night; 0 console errors in 23 loads, draw calls well under budget.

## Key Decisions

| Decision | Rationale |
|---|---|
| Contracts and CONSTITUTION frozen before any worker spawned | Nine concurrent owners in one checkout need fixed seams; changes go through the lead |
| A worker report is not a tick; only a checker pass or lead tool result is | July build showed self-reports overstate |
| Checkers run hands-off on a frozen worktree with a production build | HMR tree changes under them; evidence must be reproducible |
| Rotate workers at ~75% context from a written handoff | Fresh workers outperformed long-context ones; handoff files made it cheap |
| Replace the five generic coupes with Rocket League style bodies | Nathan: cars must be "awesome", better than v1 |

## Files Created

| File | Purpose |
|---|---|
| `CONSTITUTION.md` | Art direction, colour semantics, contracts, amendments |
| `TASKS.md` | Living build checklist |
| `scratchpad/briefs/*.md` | COMMON, per-worker and CHECKER briefs |
| `src/core/*`, `src/track/*`, `src/net/*`, `server/*` | Contracts, track runtime, multiplayer relay and client |
| `tracks/*.json` | Afterglow, Hyperdrome, Neon Pocket |
| `scripts/probe.ts` | Headless GPU Chrome probe |
| `Learn To Code.html`, `Sundown Run Two*.bat` | Josh's workshop page and Windows launchers |

## Files Modified

| File | Change |
|---|---|
| `CLAUDE.md` | Build gotchas (no `cd` before reads, ports 5201/5202) |
| `~/Dev/.claude/rules/reserved-ports.md` | Ports 5201 / 5202 reserved |

## Next Steps

- ⬜ Finish car physics on loops and steep banks (vehicle4 / track4 rounds in flight, uncommitted at log time)
- ⬜ Final visual-judge pass on the new Rocket League cars
- ⬜ 60fps check on a quiet machine and a clean-clone test
- ⬜ Afterglow demo lap 10/10 clean (was 7/10)
- ⬜ Decide whether speed-trap best is per bank angle (hyper-1 design question)

## Open Questions

- Should the speed-trap "New top speed!" compare across bank angles or per angle?

## Related Sessions

- v1 build: `~/Dev/SundownRun/sessions/` (July 2026)

## Atom candidates

<!-- KAI-ATOMS-VERBATIM -->
- PATTERN: In a multi-worker orchestrated build, run verification as separate hands-off checker sessions on a frozen git worktree with a production build and one browser tab, and tick the checklist only on a checker pass, never on a worker's own report.
- PATTERN: Rotate long-running orchestrated workers at about 75% context by having them write a handoff file (state, rulings, module map, next round) and spawning a fresh worker from it, rather than letting them run to compaction.
- GOTCHA: When editing exports in a live HMR tree shared by several workers, add new exports before their importers and update importers before removing an export, or the dev server breaks for everyone mid-edit.
- GOTCHA: Rapier collider handles are 64-bit; storing them in a plain number array or Float32 loses precision and untags the wrong collider, so keep them in a 64-bit-safe array.
<!-- /KAI-ATOMS-VERBATIM -->
