---
type: auto
session_id: 4a713ef3-5971-4a86-9ac4-35260bec3f1e
project: SundownRun2
date: 2026-10-02
topic: Hold-to-rewind, bonnet camera rides the car, Report a problem typing fix, high-speed white-noise hunt
duration: 2 hours
events: 2158
events_unit: turns
---

# Rewind, bonnet cam, Report UI and audio3 worker wave

**Project:** SundownRun2
**Purpose:** Worker wave on Josh's GitHub issues #6 (rewind) and #7 (bonnet camera, Report a problem typing) plus Nathan's "white noise at high speed" audio complaint
**Duration:** 2 hours
**Participants:** Nathan, Kai (lead orchestrator plus 3 workers)
**Session Restart ID:** `claude -r 4a713ef3-5971-4a86-9ac4-35260bec3f1e`

## Summary

One orchestrated build of four concurrent sessions on the shared SundownRun2 tree. Each worker shipped its own hunks as a patch checked with `git apply --cached --check` against HEAD, proved before/after on production builds of HEAD and HEAD+patch, and reported to `/tmp/sr2/reports/`. Rewind (#6) and the bonnet camera (#7 part A) landed on main; the Report a problem typing fix (#7 part B) and the audio3 round-2 diagnosis were delivered as patches with reports.

## What We Did

1. Hold-to-rewind (Backspace / pad LB, up to 10 s, configurable 2-20 s): a per-car ring tape of physics snapshots, rewind parts for Ai brains, all race cars rewind together, refused in multiplayer, NaN firewall. Proven by rewind/lap/race/stunt/loop-and-wall matrices (loops 72/72, wall rides 80/80). Landed (`054ac36 TASKS: rewind landed`).
2. Bonnet camera now built from the car's orientation, so it pitches, leans and rolls with the car everywhere (up within 3.5 deg of `carUp`, HEAD was 12-180 deg off). Landed as camera3.
3. Report a problem: hover no longer steals focus while typing, a click outside the text box ends typing, clicking inside the words keeps the caret. Proven with real mouse events on a production build.
4. audio3: traced Nathan's "white noise at high speed" to the steady road-hiss band (centre 4.1 kHz) plus the top of the wind, with nothing in the motor above 4 kHz to cover it; built a scripted 250 km/h speed sweep and before/after renders.

## Lead

**Session Restart ID:** `claude -r 4a713ef3-5971-4a86-9ac4-35260bec3f1e`

- Ran the rewind workstream itself (new `src/vehicle/rewind.ts`, `src/ui/hud/Rewind.tsx`, `CarSim.saveRewindState`, lap tracker and tricks rewind hooks).
- Kept rewind's hunks separable from camera3's in the shared `CameraRig.tsx` via a regenerating `mkpatch.py`.
- Flagged for Nathan: rewind sound deliberately quiet (~14 dB under mix, nothing above 1 kHz); stunt and core-hunt clocks keep running so rewind can't farm records; rewind meter blur removed (~0.6 ms GPU).
- Unresolved: one unrepeated over-long frame in a wall-ride run; camera shake up to 0.62 m in fast loops with camera3's code (0.4 m before).

## Workers

### Worker - audio3 (high-speed white noise)
**Restart ID:** `claude -r 8d203925-0768-41a3-868a-9348afd9adad`

- Two rounds on `src/audio/` (`sweep.ts`, `engine.ts`, `index.tsx`); report `/tmp/sr2/reports/audio3-round2.md`.
- New `speedInput()` scripted drive through all six gears to 250 km/h with solo-layer renders of HEAD vs patch.
- Verdict: road hiss is the white noise; motor grit, tyres, rumble and spool ruled out.

### Worker - camera3 (bonnet camera, #7 part A)
**Restart ID:** `claude -r e7684266-c4d0-45d7-8297-7bb49cd34520`

- `CameraRig.tsx` and `rigs.ts`: bonnet quaternion slerps to the car's orientation with a light chatter filter; chase and close cams untouched.
- Before/after on Afterglow and the Hyperdrome; feel battery matches HEAD. 8 findings, 0 blockers (switch glide speed and results/garage clip need a call).

### Worker - reportui (#7 part B)
**Restart ID:** `claude -r 09f65347-0f2d-4ded-a7fb-cea4cbe75c97`

- `nav.tsx` gains `typingBox()`; `Report.tsx` gains `clickBox(id)`.
- Real-mouse e2e test against unpatched and patched production builds, plus the reporter's two e2e suites. 7 findings, 0 blockers.

## Key Decisions

| Decision | Rationale |
|---|---|
| Rewind refused in multiplayer | No shared timeline across peers |
| Any rewound lap is dirty in all modes | It can't become a record or ghost |
| Stunt and core-hunt clocks don't rewind | Stops rewind being used to farm records |
| Workers deliver only their own hunks as a checked patch | Shared tree with overlapping files (CameraRig.tsx) |

## Files Modified

| File | Change |
|---|---|
| `src/vehicle/rewind.ts`, `src/ui/hud/Rewind.tsx` | New: rewind tape and HUD meter |
| `src/vehicle/carSim.ts`, `lapTracker.ts`, `tricks.ts`, `src/ui/ui.css` | Rewind state save/restore |
| `src/vehicle/camera/CameraRig.tsx`, `rigs.ts` | Bonnet cam rides the car |
| `src/ui/nav.tsx`, `src/ui/screens/Report.tsx` | Typing focus fixes |
| `src/audio/sweep.ts`, `engine.ts`, `index.tsx`, `scratchpad/engine-sounds/README.txt` | Speed sweep and audio fixes |

## Next Steps

- ⬜ Nathan / Josh listen to the rewind swoop (`/tmp/sr2/rewind/out/rewind-render.wav`) and decide if it needs to be louder
- ⬜ Camera owner looks at the 0.62 m loop shake under camera3
- ⬜ Decide camera3 findings 3 (switch glide speed) and 5 (results/garage clip)
- ⬜ Confirm reportui and audio3 round-2 patches are landed

## Atom candidates

<!-- KAI-ATOMS-VERBATIM -->
- PATTERN: When several workers edit one shared git tree, have each deliver only its own hunks as a patch regenerated by a script and verified with `git apply --cached --check` against HEAD, then prove it on a `git archive HEAD` export with the patch applied, so overlapping files don't mix workers' changes.
- GOTCHA: A UI root that calls preventDefault on mousedown keeps browser focus inside a text box while the visual focus ring moves to the clicked button, so keystrokes keep landing in the box; blur the active text box on click outside it.
<!-- /KAI-ATOMS-VERBATIM -->
