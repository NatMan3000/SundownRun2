---
type: auto
session_id: 14167a00-0a59-4379-855b-763f83b9eee3
project: SundownRun2
date: 2026-11-05
topic: Road Editor on a phone finished, crash guard, audit must-fixes, all live
duration: about 25 hours
events: 1861
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

## Related Sessions

- [2026-11-04-phone-controls-landscape-pass.md](2026-11-04-phone-controls-landscape-pass.md): the same process, its first hours
- [Kai: YCOS token exposure and the keychain](../../../.claude/sessions/2026-11-05-ycos-token-exposure-keychain.md)
- [YCOS: exposure note](../../YCOS/sessions/nathan/2026-11-05-roadmap-token-exposure-note.md)
