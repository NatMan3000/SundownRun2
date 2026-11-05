---
type: auto
session_id: 14167a00-0a59-4379-855b-763f83b9eee3
project: SundownRun2
date: 2026-11-05
topic: Road Editor on a phone finished, crash guard, audit must-fixes, all live
duration: about 25 hours
session_ids: [9c5d033e-244d-47db-9d3f-e43e49f31c0a, 14167a00-0a59-4379-855b-763f83b9eee3]
events: 2839
events_unit: turns
---

# Road Editor on a phone, Phase B, and the audit must-fixes

**Project:** SundownRun2
**Purpose:** Finish the landscape iPhone DesignPass: rebuild the Road Editor for thumbs, then fix what playing and an audit turned up.
**Duration:** about 25 hours of wall clock (23:47 AEDT 4 Nov to 01:00 AEDT 6 Nov), mostly workers and gates running
**Participants:** Nathan, Kai (Opus 5.5, then Fable 5.1 from about 21:00 on 5 Nov)
**Session Restart ID:** `claude -r 14167a00-0a59-4379-855b-763f83b9eee3`

## Summary

One long process in two segments: `9c5d033e` up to the compaction at 16:06 AEDT on 5 Nov, then `14167a00`. The dream cycle logged the first segment as of 04:02 on 5 Nov in [2026-11-04-phone-controls-landscape-pass.md](2026-11-04-phone-controls-landscape-pass.md), when the pass was still on a branch. This log picks up from there and runs to the end of the session.

The phone pass merged and deployed at 04:24. All ten pieces of Road Editor Phase B then went live, on Nathan's layout C. On the way a real crash turned up, a lost WebGL context blanking the page for good, and got a guard. Nathan hit two bugs playing, both fixed. A read-only Ponytail audit found 18 things, and its 4 must-fixes went live on his "d6 fix go". Final state: version a6234ad4 on the online copy, main 00912e6 on both remotes.

A credential exposure ran alongside this on the evening of 5 Nov, started by a worker of this project. It is logged in Kai: [2026-11-05-ycos-token-exposure-keychain.md](../../../.claude/sessions/2026-11-05-ycos-token-exposure-keychain.md). Sundown Run itself holds no part of it, apart from `github-token.txt` going owner-only.

## What We Did

1. **Phone pass out (04:24).** `phone/integrate` merged, version 364f1656, live probe OK.
2. **Credit and a way into multiplayer.** "Made with [sun] by Josh & Kai" on the title (`src/ui/MadeWith.tsx`, Nathan's ask, like Fruity's). A Multiplayer link in the title's quiet row with a name box, Join and Leave multiplayer, so nobody types `?mp=1` (`src/ui/screens/Multiplayer.tsx`).
3. **Phase B, pieces 1 to 10 of `spec/phone-editor/plan.md`:**
   - Piece 1, the gesture layer: one finger is the tool, two are always the map (`src/editor/mapGestures.ts`). Found and fixed a blank-editor crash in the Checks list on the way.
   - Piece 2, tools under a finger: preview on the press, act on the lift, wider grabs, dragged things ride above the finger.
   - Pieces 3 to 5, layout C: one tool button with a tray, Undo and Redo beside it, settings in a card, a Menu page, Save, Test drive, Checks and 3D down the right (`src/editor/phone/`).
   - The map kept clear after Nathan's words (P8, P9, P10): no tool chip, scale top left, one-line tool tips, tunnel footprint only while a thumb holds the button, road labels only with their own tool, and pills that step clear of the edge buttons.
   - Pieces 6 to 9: every phone-facing line rewritten for a finger (`src/editor/phoneWords.ts`, scenario 25); Library, Share and online tracks fitted to a phone; the 3D note one fading line; the Drive to draw bar one row at the bottom (scenario 26).
   - Piece 10, the proof: `editor:touch` 1821 passes at the end, `phone:check` all pass.
4. **The crash.** A WebGL context lost while the post stack built took the whole page down, because nothing caught it. Now no composer or reflection map is built on a lost context, both are rebuilt on restore, and a root `CrashGuard` shows one Reload button. Section 7 amendment in `CONSTITUTION.md` for `App.tsx`.
5. **Two bugs Nathan hit playing.** Settings' Time of day read "Dusk 0.25", now "Dusk, 7:30 pm" (0 = 6:00 pm, 1 = 12:00 am). A 3-lap race said "Final lap" as lap 2 started. `test:format` and `lap:check` prove both.
6. **Ponytail audit** over main at 3c6b1cd: [research/2026-11-05-ponytail-sundownrun2-audit.md](../research/2026-11-05-ponytail-sundownrun2-audit.md), 18 findings, 4 must-fix, each spot-checked, the first run live.
7. **The 4 must-fixes, all live (scenario 27):**
   - The Vite dev server served `github-token.txt` to anyone on the wifi during `bun run mp`. Now `server.fs.deny`, proved by `bun run dev:check`.
   - Ghost laps filled the browser until tracks stopped saving. Now one ghost lap per track, and ghosts give way before a drawing fails to save, with the player told when it still can't be kept.
   - A sync conflict could overwrite this computer's track when its copy couldn't be saved. Now it never does.
   - An empty library answer could delete the browser's tracks. Now it deletes nothing.

## Key Decisions

| Decision | Rationale |
|----------|-----------|
| Road Editor layout is C, One tool button (P7) | Nathan's pick over my A: "c one tool button" |
| Layout C stopped waiting on his thumb test | He expected the button, and the gesture numbers are a one-line retune |
| Nothing on the road map but the map, the transient status line and the buttons round its edge (P8) | Nathan: "Keep the road world clear" |
| The scale sits top left on a phone (P9) | Nathan: "Move the scale up to the top left on the editor. Try to keep the track field clear" |
| Each road label shows only with the tool that changes it (P10) | Nathan's "D3 yes"; tapping a hidden label goes with it; desktop unchanged |
| Phone layout is checked in Chrome at the phone windows and deployed on that; the iOS simulator is never a gate (P11) | Nathan: "Can't you just do this in Chrome or Canary and size the screen accordingly? I already know that the game itself runs fine on my iPhone". I had held a deploy over an hour on a simulator blank page |
| No worker for the first-tap stall | Nathan on his real phone: "unnoticable". The 9 s is the simulator's |
| Fix the 4 audit must-fixes now, leave the rest | Nathan: "d6 fix go" |
| The GitHub key stays, not rotated | Nathan: "no risk yet". `bun run mp` has run on home wifi only |
| A browser remembering 2+ uploaded tracks that sees none of them online stops syncing rather than deleting | The audit's data-loss path; the cost is a sync that needs a look |

## Files Created

| File | Purpose |
|------|---------|
| `src/editor/mapGestures.ts` | Stands in front of the map's pointer handlers |
| `src/editor/phone/` | Layout C: `PhoneEditor.tsx`, `PhoneMenu.tsx`, `phone.css`, `trayGuard.ts`, `freeMap.ts` |
| `src/editor/phoneWords.ts` | Every line a phone player reads, at the point of display |
| `src/CrashGuard.tsx`, `src/core/glLife.ts` | The last line against a blank page, and the context's generation |
| `src/ui/MadeWith.tsx`, `src/ui/screens/Multiplayer.tsx` | Credit, and the way into multiplayer |
| `src/core/ghostStore.ts` | One ghost per track, ghosts give way |
| `scripts/editor-touch-check.ts`, `scripts/dev-server-check.ts`, `scripts/lap-check.ts` | Real-finger editor proof, the dev server's deny list, the lap words |
| `spec/phone-editor/` | Plan, inventory, layout pictures, piece reports |
| `research/2026-11-05-ponytail-sundownrun2-audit.md` | The audit with Kai's spot-check |

## Files Modified

| File | Change |
|------|--------|
| `spec/phone-landscape-standard.md` | Ledger rows P7 to P11 |
| `vite.config.ts` | `server.fs.deny`, with Vite's own defaults repeated |
| `src/editor/library/sync.ts`, `src/editor/draft.ts`, `src/vehicle/ghost.ts`, `src/track/registry.ts` | The save and sync must-fixes |
| `src/core/events.ts`, `src/play/ModeController.tsx`, `src/ui/format.ts` | `race.lap` defined as laps completed; the clock-time word |
| `src/App.tsx`, `src/look/post/PostStack.tsx`, `src/look/EnvironmentMap.tsx`, `src/core/perf.ts`, `CONSTITUTION.md` | The lost-context guard |
| `scripts/phone-gate.ts` | Editor steps; rule 12 goes red if a chip returns to the map |

## Lessons

- A Vite dev server serves any file under its root unless `server.fs.deny` names it, and giving `deny` replaces Vite's defaults. A pattern with a "/" matches the whole absolute path, so `reports/**` never matched. `vite preview` serves only `dist/`.
- The lap bug: `raceBook`'s `onLap` fires after `lapsDone` counted the lap, so emitting `lapsDone + 1` made "Final lap" a lap early and swallowed "Lap 2 of 3". Multiplayer already sent laps done.
- Two lanes each adding "scenario 23" to one check script merge with a conflict. Number scenarios in the brief.
- A deploy proof is the asset hash in the live `index.html` against `dist/`. A grep for a word matched the old build too.
- Cloudflare's API answers 10500 on a deploy now and then, and a plain retry works. The first probe straight after a deploy can still serve the old asset.
- `bun test <file>` matches that file name anywhere in the tree, gitignored folders included. A stale copy under `data/worktree-patches-2026-10-21/` made `test:share` red on this Mac only.
- Canvas pills on the phone map must step clear of the fixed buttons, measured from the DOM, or a raised label sits under Undo and a tap hits Undo.
- Don't chain a script and its commit in one Bash call: a python assert failed and the commit still ran, committing conflict markers locally (amended, never pushed).

## Next Steps

- ⬜ `Q2` (Nexus #1737): act on what Nathan says about the editor on his phone. He said "I will test those things when I get a chance". Numbers are at the top of `src/editor/mapGestures.ts`.
- ⬜ The audit's later list, in the report: should-fixes 5 to 14, the dead `TASKS.md` ledger (108 ⬜ for systems long built), trashing `data/worktree-patches-2026-10-21` (needs his yes), and the public device details in reports.

## Open Questions

- What makes real Safari lose its picture? Mobile Safari on the simulator loses the context on the first real touch under load; on a real phone the trigger is unknown.
- A simulator walk showed a 62 px strip and the Road Editor not opening. Neither was explained; both were cut when P11 took the simulator out of the gate.
- Not verified on a real phone: the editor by a real thumb, 3D gestures, the phone GPU's cost. Nathan's first tap is the first online proof of the Multiplayer link: no script joined the live room.
- The keyboard covers the name box in a Safari tab on its side (the standard's Known list). Disclosed, not fixed.

## Git Status

Main was 00912e6 on Forgejo and the GitHub mirror before this log's commit (read back with `ls-remote`), tree clean. This session's stretch runs 395e94c to 00912e6. Left alone: `data/worktree-patches-2026-10-21/` (gitignored) and two old `.claude/worktrees/agent-*` worktrees that aren't this session's.

## Continued - 2026-11-05

The chain's brief reopened this log for its first segment and its 17 named workers. No new work needs adding to the story above: the lead's turns past the first log's 04:02 cut-off are told in What We Did, and all 10 of the segment's prompts fall before that cut-off. What was missing is the worker record, below. The 2839 in the frontmatter is the chain's summed turns, not 978 turns of new work.

### Segment 9c5d033e - the phone pass and Phase B up to the compaction

**Restart ID:** `claude -r 9c5d033e-244d-47db-9d3f-e43e49f31c0a`

- Touch controls, the icon and the phone standard, told in [2026-11-04-phone-controls-landscape-pass.md](2026-11-04-phone-controls-landscape-pass.md).
- From 04:02 on 5 Nov: the checker's SHIP verdict, the merge and deploy at 04:24, then Phase B to the compaction at 16:06, told in What We Did above.

### Segment 14167a00 - already logged above

**Restart ID:** `claude -r 14167a00-0a59-4379-855b-763f83b9eee3`

### Workers

#### Worker - phone-gate
**Restart ID:** `claude -r 343f20fd-a62d-4bb3-b14f-001718bfa96b`
- Built `scripts/phone-gate.ts` and `bun run phone:check`: 5 windows, 33 screens and states, with a `--break` proof per rule. Merged at e32a4e9.

#### Worker - phone-hud
**Restart ID:** `claude -r b627a94e-e407-48bd-a8d5-bf8c29afd837`
- One slim band over the sky at 874x292, touch buttons regrouped, and a Race press that starts nothing says why. b3d0426. The toast itself was not shot in real Safari.

#### Worker - phone-play
**Restart ID:** `claude -r 7770c1a7-96e1-4720-beb3-49e3c6940cc0`
- Tap and swipe rules for every menu (`watchFingers()` in `src/ui/nav.tsx`), 3 taps from opening to driving. 1235b04.

#### Worker - phone-panels
**Restart ID:** `claude -r ed5ad8f3-2504-496f-bc1f-9ac16125b9f6`
- Settings, Pause, Results, Report, songs and the map fit at the measured height; a swipe on a slider scrolls. 048111e. 5 findings, 0 blockers; slider and Report keyboard unproven on a real iPhone.

#### Worker - phone-editor
**Restart ID:** `claude -r 0d809d66-38a0-4bbc-a827-00ee5945c0c6`
- Phase A only: editor inventory, three layout comps and the plan, recommending A. Nathan picked C.

#### Worker - sim-rig
**Restart ID:** `claude -r fcdace07-0cc4-4f6e-9b43-300d26308c82`
- iPhone 17 Pro simulator rig over XCUITest; measured Safari landscape at 874x292. Tap and drag ran, but their effect on a page was unconfirmed in its report.

#### Worker - phone-fixup
**Restart ID:** `claude -r d4cdda70-d17b-4ad7-be32-d832a0329624`
- Cleared the last overlaps and moved the rig to `scripts/ios-sim/`. eb2eb23. Gate all pass, touch 84 pass and 0 fail. Hunt's idle clock is hidden on touch to make room.

#### Worker - phone-checker
**Restart ID:** `claude -r 43677bf8-5cce-4e62-8de5-3aef19a5c071`
- Fresh check of d776896: SHIP, no blockers, defects of medium or lower. Left open: one extra `mp:check` failure in a section flaky on both commits.

#### Worker - editor-gesture
**Restart ID:** `claude -r d6b656d4-9c66-401a-813f-67fd0983b599`
- Piece 1, the gesture layer and `bun run editor:touch` (d0c80d4), plus the blank-editor crash on New track (a421928).

#### Worker - editor-tools
**Restart ID:** `claude -r 28d49b08-9fe4-43bb-b233-791c5deff6f8`
- Piece 2, tools under a finger, including `src/editor/ThumbButtons.tsx`. 4727098.

#### Worker - editor-shell
**Restart ID:** `claude -r dc310aa1-dc18-4767-ab71-af951aba82a9`
- Pieces 3 to 5, layout C (0a68ec3), then P8 (1880491) and the scale, tips and tunnel hold (a675ae6). Found two real bugs behind 15 red lines after a merge: a refused double tap, and a piece on the road's seam making the file invalid.

#### Worker - mp-join
**Restart ID:** `claude -r 6dbc1bf0-ca05-403b-8023-0bfa0957832a`
- The Multiplayer link, screen, Join and Leave, and a Reload button on a version mismatch. 50d51f2.

#### Worker - gl-loss
**Restart ID:** `claude -r 122bcc90-f027-4a3e-a449-8d77839ca175`
- Root cause: `new EffectComposer` reads context attributes that a lost context answers with null, and no error boundary existed. Guard and Reload screen at d18130f, Chrome only.

#### Worker - road-labels
**Restart ID:** `claude -r 900d75ed-40b2-4f22-ba9c-52d60c878611`
- Road labels only with their own tool, stepping clear of edge buttons (P10). 6bcbd16; desktop byte-identical.

#### Worker - editor-words
**Restart ID:** `claude -r a088db7e-7d3b-42a5-b6d0-a3c4390d9f62`
- Pieces 6 and 8's words, `src/editor/phoneWords.ts`, scenario 25. 7387234. Its stray `export -n` started the exposure logged in Kai.

#### Worker - editor-rooms
**Restart ID:** `claude -r 2f4be9c2-6c54-4868-b0ad-070b8e3a5b34`
- Pieces 7, 9 and 8's layout: scenario 26 went from 91 pass and 32 fail to 123 pass and 0 fail; computer layout pixel-identical. cf90a9b.

#### Worker - game-fixes
**Restart ID:** `claude -r 2312b191-8da8-4412-851a-a65b5874a335`
- Time of day clock and the Final lap fix. 2d08727.

## Related Sessions

- [2026-11-04-phone-controls-landscape-pass.md](2026-11-04-phone-controls-landscape-pass.md): the same process, its first hours
- [Kai: YCOS token exposure and the keychain](../../../.claude/sessions/2026-11-05-ycos-token-exposure-keychain.md)
- [YCOS: exposure note](../../YCOS/sessions/nathan/2026-11-05-roadmap-token-exposure-note.md)

## Atom candidates

<!-- KAI-ATOMS-VERBATIM -->
- GOTCHA: postprocessing's `new EffectComposer(gl)` throws on a lost WebGL context because `getContextAttributes()` returns null, and with no React error boundary that blanks the whole page for good; don't build it on a lost context, and keep a root boundary.
- GOTCHA: In a browser gate, a tap on a shared page unlocks audio for every later step on that page, so steps that test a sound-locked state need their own page.
<!-- /KAI-ATOMS-VERBATIM -->
