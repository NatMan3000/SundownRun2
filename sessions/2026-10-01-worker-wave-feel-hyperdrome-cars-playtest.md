---
type: auto
session_id: c22c4949-581a-46e7-aba8-4c3b5080536a
project: SundownRun2
date: 2026-10-01
topic: Worker wave - feel/Hyperdrome fix rounds, cars redesign, checkers, Josh's playtest asks
duration: 8.5 hours
events: 15159
events_unit: turns
---

# Sundown Run II - worker wave (vehicle, track, play, cars, checkers, playtest asks)

**Project:** SundownRun2 (`~/Dev/SundownRun2`)
**Purpose:** The 24 worker sessions Kai's team lead spawned across 1-2 Oct to clear checker verdicts (feel, Hyperdrome, visual) and Nathan/Josh's playtest asks
**Duration:** 8.5 hours (longest member; members ran concurrently over 1-2 Oct)
**Participants:** Nathan, Kai (team-lead session e3382bc5, logged separately), 23 workers + play2
**Session Restart ID:** `claude -r c22c4949-581a-46e7-aba8-4c3b5080536a`

## Summary

This log consolidates the worker side of the Sundown Run II orchestrated build. The team lead (logged in [2026-10-01-sundown-run-two-orchestrated-build](2026-10-01-sundown-run-two-orchestrated-build.md) and [2026-10-02-playtest-fixes-overnight-polish](2026-10-02-playtest-fixes-overnight-polish.md)) ran independent checkers (feel-2/3, hyper-2/3, visual-3) against production builds of HEAD, then rotated build workers (vehicle3-9, track3-5, play2, cars/cars2) through their defect lists, each building from a HEAD snapshot plus its own patch on its own preview port and reporting a `git apply --cached --check`-clean patch for the lead to commit. Single-purpose workers delivered Nathan's playtest asks: editor "Clear all", the in-game "Report a problem" GitHub issue screen, the muscle engine whoosh fix, the road flicker NaN audit, and a Learn To Code refresh. The brief's nominated lead id (c22c4949) is actually the play2 worker.

## What We Did

1. **Feel standard re-checked and fixed** - feel-2 (at ae3670f) and feel-3 (at a65b70c) measured every CONSTITUTION section 3 item on keyboard and pad paths; vehicle3-6 and vehicle8 fixed rollovers on bank changes, loops and wall rides, roll-back catch, landing catch, crash classification and camera pops.
2. **Hyperdrome bank at speed made drivable** - hyper-2/hyper-3 checks; track4 lengthened bank-transition crests (`bankRolls.ts`, new `crest` gate, lean rule); track5 replaced the barrier box chain with a striped trimesh tube (0 snags in 480 lab runs, was 25-48 per 20); vehicle7 found the Ai's `kRoad` used horizontal curvature and landed `kRoad x cos(bank)` with a bank-aware rack.
3. **Ai/demo brain (play2)** - Afterglow demo laps driven to clean across sundown and night, reverse-for-a-run-up gated on rear clearance, accepted on 962cf6b.
4. **Cars redesigned** - five original Rocket League-style bodies (dart, blade, brick, manta, pulse) with neon night signatures and boost-reactive rockets (3 rounds), then cars2 fixed visual-3's C1-C4 (per-body tyres, night paint, additive plume, Dart nose).
5. **Brakes** - vehicle9 found the friction circle capped braking at ~1.55 g and two boost pads in Afterglow's hairpin braking zone; 200-0 now 111 m and the slider scales to tyre grip.
6. **Playtest asks** - editor3 "Clear all" (one undo step, pad and keyboard); reporter's "Report a problem" posting to GitHub via `server/issues.ts`, tested only against a fake API; audio2 rebuilt engine voicings and traced the muscle high-rev wind to the intake whoosh layer; flicker class-wide NaN guards plus `?nancheck=1`; learn2 re-anchored Learn To Code after the steering-brain rewrite; ui2 garage hero view.

## Lead

**Session Restart ID:** `claude -r c22c4949-581a-46e7-aba8-4c3b5080536a`

The cluster's nominated lead is the **play2** worker (the real orchestrator is session e3382bc5, already logged). It took over from the rotated play worker: traced dusk and night demo laps, fixed the brain's take-off and hairpin braking on Afterglow, added a rear clearance check before reversing, kept the committed `kRoad` line identical, and reported round 1 (8 findings, 0 blockers) with patch `/tmp/sr2/play2/mine.patch` on `src/play/aiDriver.ts` and `src/play/index.tsx`.

## Workers

### Worker - cars (body redesign)
**Restart ID:** `claude -r 269b56e2-afdf-4233-82f0-e038bddf624f`
- Five new bodies via `src/vehicle/bodies/{kit,build,profiles}.ts`, `carModel.ts`, `src/dev/carlab.tsx`; committed over 3 rounds.

### Worker - track3 (loop frames, drive surface, barriers)
**Restart ID:** `claude -r 1c37d6c2-ecc5-4db3-afeb-ad6f3a7abd47`
- Loop frames, drive-surface collider and `surface` gate (round 1); inner barrier, ditch and ground under the banked deck (round 2).

### Worker - feel-2 checker
**Restart ID:** `claude -r 37bc6fd6-7c0b-469c-8e00-66dae590037d`
- Independent measured verdict on section 3 feel at ae3670f (loops, walls, boost, ramps, banking, standstill).

### Worker - vehicle3 (rollover, re-seat)
**Restart ID:** `claude -r 5229f732-c64b-406c-a748-9f4ac026fff8`
- Traced the 60 deg rollover to track collider sawtooth and ground tiles under the banked road; added trace channels and `__dev.groundUnder`.

### Worker - ui2 (menus, garage)
**Restart ID:** `claude -r 1ee141e5-a578-42be-879a-3e3e67453260`
- Three rounds on track select and garage; garage now frames the car 3/4 front with a slow orbit.

### Worker - vehicle4 (loops, wall rides, camera)
**Restart ID:** `claude -r 62745dcd-bf8c-40b9-976d-66a75dfb31af`
- Magnet, loop/wall support, lip guard, camera L5/O7 fixes; committed as 8efd811.

### Worker - track4 (bank-transition crests)
**Restart ID:** `claude -r 0e56db3f-1939-469d-9fa9-96a8cb848c03`
- `shapeBankRolls` quintic re-lay, `crest` gate, lean rule after a straight-grown roll leaned 52-54 deg and put the demo into the barrier 59 times.

### Worker - visual-3 checker
**Restart ID:** `claude -r 32f3553c-b83f-462c-b02f-84dd61013f7f`
- Verdict at f783aa4: 29 pass, 8 fail (D2 demo, car defects C1-C5, seams N7-N8).

### Worker - cars2 (visual-3 car defects)
**Restart ID:** `claude -r 6c89f639-8b0d-4e63-a0b6-61659413b4b0`
- C1-C4 fixed; C5 (lead fix at speed) waited on vehicle3.

### Worker - vehicle5 (feel-2 observations)
**Restart ID:** `claude -r 6e167383-29e8-449f-a081-f7ec08fab939`
- Roll-back catch, landing catch, crash typing (road vs terrain), top-speed check.

### Worker - track5 (barrier physics)
**Restart ID:** `claude -r bd173752-9b6a-4929-87e2-4c164c4d6556`
- Barrier box chain replaced with one striped trimesh tube per side; root cause was soft-CCD contacts with the next box's square end.

### Worker - hyper-2 checker
**Restart ID:** `claude -r edb019e0-d69f-49f1-b8a8-e5764f4096fd`
- Hyperdrome live bank, banking at speed, Ai, speed trap and look re-checked at aa47f21.

### Worker - feel-3 checker
**Restart ID:** `claude -r afd688cc-ef7b-495d-81aa-6019a464a428`
- Re-checked every feel-2 fail at a65b70c; raised F1-F4 (crawl wedge, camera pop, loop read as impact, landing).

### Worker - vehicle6 (feel-3 F1-F3)
**Restart ID:** `claude -r e4819ee6-760b-408a-9eca-fcb4df609d3b`
- Crawl wedges, exit-ribbon camera pop and loop-turn impact fixes across carSim, rigs and CameraRig.

### Worker - vehicle7 (bank 60 steering)
**Restart ID:** `claude -r 72961994-50fc-456c-8181-6e9839819d55`
- Bank-aware rack, re-seat under pause, R on a 60 deg bank, and the Ai `kRoad x cos(bank)` fix (committed 976fa84 / 4c82c29).

### Worker - vehicle8 (landing catch F4)
**Restart ID:** `claude -r d838a6d9-a91f-43ed-a9cb-406663f652fc`
- COM push along the mean ground normal with pitch/roll damping only and look-ahead rays; per-point spring coupling rejected (rolled 30-36 deg).

### Worker - hyper-3 checker
**Restart ID:** `claude -r e8e93ebf-1ef4-4ed7-b468-4b2cd999c778`
- Short re-check of D1-D6, K2 and Nathan's done criterion at 502b73b.

### Worker - vehicle9 (brakes)
**Restart ID:** `claude -r f7eb444f-c942-424d-92a8-28cbae69728e`
- Brake strength and slider scaling retuned; hairpin brake from 250 to 120 km/h now 129 m (was 267 m and a crash).

### Worker - editor3 (Clear all)
**Restart ID:** `claude -r 4b9525d9-7a17-4076-a3aa-714eb72f5883`
- Eraser on the tool rail with confirm box, single undo step, pad B, and a Clear in drive-to-draw.

### Worker - audio2 (engine sound)
**Restart ID:** `claude -r 3cd24c78-3cba-4ab6-9748-0b14aef794bf`
- New `engineVoicings.ts`, `motorDsp.ts`, `motorNodes.ts`; muscle high-rev wind traced to the intake whoosh by solo-layer FFT.

### Worker - reporter (Report a problem)
**Restart ID:** `claude -r 807fe6b4-7b4a-4c07-a73e-964b9a4b1a4a`
- Title and pause entries, public-page privacy warning, offline queue; verified end to end against a fake GitHub only.

### Worker - learn2 (Learn To Code)
**Restart ID:** `claude -r 83345c41-7e4f-47b8-a486-e43b4142957f`
- Fixed three hard misses and one silent substring match (`STEER_GAIN` matched `STEER_GAIN_SEED`); Mission 7 rewritten.

### Worker - flicker (issue #2)
**Restart ID:** `claude -r 8f573fdb-fd71-438f-93b3-60ad124a50e3`
- NaN/overflow audit of every shader, class-wide guards, `NanCheck.tsx` and `?nancheck=1`; later confirmed fixed on Josh's laptop.

## Key Decisions

| Decision | Rationale |
|---|---|
| Workers build from a HEAD snapshot plus their own patch, each on its own preview port | The working tree was shared mid-edit by several workers; acceptance must not measure someone else's half-done change |
| Workers never commit; they report a patch of only their hunks and the lead lands it | One integrator keeps history coherent across 20+ concurrent workers |
| Independent checkers verify against a production build of a pinned commit | Separates "built" from "measured"; verdicts cite the commit |
| Bank roll length follows the bank change, with a lean rule | A roll grown into the straight leaned 52-54 deg on dead-straight road |
| Barrier as one continuous striped trimesh tube | Box chains create speculative contacts against the next box's square end |
| Ai lateral curvature uses road-plane curvature (`x cos(bank)`) | Horizontal curvature doubles at 60 deg bank and forced over-turn |
| Reporter tested only against a fake GitHub endpoint | Issues go to a public page; nothing real sent until Nathan provides the token |

## Files Created

| File | Purpose |
|---|---|
| `src/vehicle/bodies/kit.ts`, `build.ts`, `profiles.ts` | New car body kit |
| `src/dev/carlab.tsx` | Car lab dev page |
| `src/audio/engineVoicings.ts`, `motorDsp.ts`, `motorNodes.ts`, `sweep.ts` | Engine sound rebuild |
| `src/look/NanCheck.tsx` | On-screen NaN detector |
| `scratchpad/engine-sounds/README.txt` | Rendered engine sound notes |

## Files Modified

| File | Change |
|---|---|
| `src/vehicle/carSim.ts`, `tuning.ts`, `SimulatedCar.tsx`, `SimCar.tsx`, `PlayerCar.tsx`, `index.tsx`, `camera/rigs.ts` | Feel, landing, braking, rollover fixes |
| `src/track/road.ts`, `ribbon.ts`, `gates.ts`, `build.ts` | Loop frames, drive surface, gates |
| `src/play/aiDriver.ts` | Demo/Ai brain |
| `src/editor/*` | Clear all |
| `src/ui/report/*`, `server/issues.ts`, `src/ui/screens/*`, `vite.config.ts` | Report a problem |
| `src/look/road/*.ts` | NaN-safe road shaders |
| `scripts/learn-to-code.ts`, `scripts/probe.ts` | Learn To Code anchors; probe options |
| `README.md`, `CLAUDE.md`, `.gitignore` | Reporter docs, token ignore |

## Next Steps

- ✅ Worker patches landed by the lead (see the 2026-10-02 lead log; main clean at 7533025)
- ⬜ ui2's garage trail preview (a parked car lays no trail) and the sunset-behind-3/4-view limit
- ⬜ play2 known gaps: bridge approach s 3000-3145 and one Neon Pocket s112 off-road

## Related Sessions

- [2026-10-01-sundown-run-two-orchestrated-build](2026-10-01-sundown-run-two-orchestrated-build.md) - lead, day 1
- [2026-10-02-playtest-fixes-overnight-polish](2026-10-02-playtest-fixes-overnight-polish.md) - lead, day 2

## Atom candidates

<!-- KAI-ATOMS-VERBATIM -->
- PATTERN: When many workers share one git working tree, have each build its acceptance runs from a `git archive HEAD` snapshot plus only its own patch, served on its own preview port, so measurements never include another worker's half-applied edits.
- GOTCHA: A box-chain barrier collider in Rapier snags sliding cars because soft-CCD speculative contacts hit the next box's square end (normal pointing backwards along the road); one continuous trimesh tube per side with the inner face cut in strips removes the snags.
- GOTCHA: A pure-pursuit driver on a steeply banked road must use road-plane curvature (horizontal curvature x cos(bank)); horizontal curvature roughly doubles at 60 deg bank and forces an over-turn into the inner barrier.
- GOTCHA: A substring-based code anchor check can silently pass after a rename (`STEER_GAIN` still matched `STEER_GAIN_SEED`); anchors should match whole identifiers.
- GOTCHA: A shader light cap written as `min(light, cap)` turns NaN into a full-bright pixel on some GPUs, which bloom spreads into flickering white dots; guard the maths against NaN rather than relying on the clamp.
<!-- /KAI-ATOMS-VERBATIM -->
