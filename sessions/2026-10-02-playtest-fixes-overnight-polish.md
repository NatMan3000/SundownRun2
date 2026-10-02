---
type: auto
session_id: e3382bc5-22eb-447a-90db-5701667e6f05
project: SundownRun2
date: 2026-10-02
topic: Sundown Run II playtest fixes, Josh's reports and overnight polish
duration: 16 hours
events: 5477
events_unit: turns
---

# Sundown Run II - playtest fixes and overnight polish

## Summary

Second day of the Sundown Run II build, same session id as the 1 Oct log (resumed), running 2 Oct ~11:30 AEST to 3 Oct ~03:30 AEST across several compactions. Kai led and orchestrated: engineer workers per task with written briefs in `scratchpad/briefs/`, each patch landed with `git apply --cached` after a HEAD+patch typecheck, pushed after every commit (Forgejo fetch, GitHub public push mirror), and Nathan's stable playtest copy on :5203 rebuilt after each landing. The 2 Oct work came from Nathan's playtesting and Josh's in-game problem reports (GitHub issues #1-#8, all handled and closed). Nathan went to bed at ~00:40 with "dont end session until you are satified with all the work"; overnight Kai landed music, reverse lights, stunts round 2 and a handbrake rework, then ran the final done-criteria checks, all passing. About 90 commits; main is clean at 7533025, and branch `music-classic` is pushed and deliberately unmerged until Nathan listens.

## What We Did

**2 Oct (playtest and Josh's reports)**

1. Menu engine buzz silenced (engine off in menus).
2. Engine sound rebuilt as a firing-pulse AudioWorklet with voicings, muscle V8 the default ("muscle is the best sound"); the high-rev whoosh and wind hiss removed; tyre scrub reworked (#5).
3. Report a problem: an in-game screen that files GitHub issues through a Vite plugin (`server/issues.ts`, `/api/report`) with a fine-grained token in gitignored `github-token.txt`; queued reports flush on startup; a "For Dad" refusal detail.
4. Title Roman numeral II with joined serifs; README screenshot.
5. Windows flicker fix (#2): ANGLE D3D11 shader maths (pow of a negative base, `min(NaN, cap)`, derivatives in non-uniform flow, 65504 half-float overflow) plus `?nancheck=1`; confirmed fixed on Josh's laptop.
6. Rewind (#6): hold Backspace / LB over a preallocated per-step tape ("rewind works really well").
7. Bonnet cam and Report typing fixes (#7); editor drawing tools Bend / Straight / Curve / Corner / Steady + Smooth (#8), copies keep their road heights.
8. Stunt park round 1: seeded ramps, rings, gaps and bullseyes in Free Roam and Stunt Attack.
9. Light trails halved twice (`trailSeconds` 0.45).

**Overnight 3 Oct**

1. audio5 (music): Nathan preferred the original band ("befores sound better, except for the title-after.wav"). The original band is back by default bit for bit (null tests -136 to -141 dB against HEAD renders), the title keeps the new sound, a house band is opt-in via `musicStyle`, and the new music features stay (landing answers, lap-record fanfare, final-lap key lift, Next song on N / pad B, song names, favourites). On branch `music-classic` (5c50072, main merged in at 51b8c7a), not merged.
2. revlights: reverse lights on all five bodies and the Ai (757476c); `VehicleApi.setReverse` contract with a CONSTITUTION section 7 amendment (887fa87); underglow pool and reverse glow moved to a screen-space effect in the post pass so ground and body roll cannot slice them; multiplayer reverse lights inferred from motion (dd95057).
3. stunts2: lip-speed signs on every launch fitted to the placed pieces (26/26 launches score fully at their number), HUD Faster / On speed / Ease off cue, park zones on minimap and world map, rings in the live combo, lit walls (8e0e70a).
4. vehicle10 (handbrake): a released handbrake slide keeps its momentum instead of snapping straight; 180s work at 40-80 km/h; taps at speed, brakes, Ai, loops and wall rides unchanged. CONSTITUTION section 3 amended plus a section 7 line (0484226).
5. Learn To Code.html regenerated twice (27bc178, 0b91668); `mp:check` snapshot now copies `server/` (2a303f2), 76/76 again.
6. Final checks [live]: quiet-machine perf at the high preset on :5203, all three tracks pass (cost avg 6.2-6.9 ms, p99 8.6-9.3 ms against 12 / 16.6 ms); a clean clone from GitHub installs, typechecks, builds, passes `tracks:check` 3/3 and plays; `mp:check` 76/76.

**Kai repo (`~/.claude`)**

1. Keycap question-code format reworked after Nathan compared tmux and plain terminal rendering: tmux `variation-selector-always-wide on`, no space between digit keycaps, a plain space after; `keycap-format-guard` hook and tests updated (7658ad82, 80e6ac6c, 98218f37, 451994d8).
2. commit-discipline rule: `git add` sweeps other workers' unstaged hunks, stage by patch (0a055c25).
3. delegation rule: Nathan corrected Kai that workers ran at extra-high effort although he asked for high. Cause: a named spawn without isolation becomes a teammate and runs at the lead's effort. Rule fixed (61fb04bc).

## Key Decisions

| Decision | Rationale |
|---|---|
| Original procedural band for every drive mood, new house sound only on the title; house band opt-in via `musicStyle` | Nathan preferred the originals; the new mix had a thin kick and lost bass |
| Music change on a pushed branch, not main | Nathan must hear it first; lets the lead keep landing other work overnight without breaking the listen gate |
| Longer handbrake flick at 50-70 km/h swings much further - kept as built | Kai's ruling; tunable via `ASSIST.spinFreeLo/Hi` if Nathan or Josh dislike it |
| Underglow and reverse glow as a screen-space post effect | Follows real ground from depth at no measurable cost; flat quads got sliced |
| Muscle V8 default engine voicing | Nathan's call after hearing the voicings |

## Files Modified

- `server/issues.ts`, `vite.config.ts` - Report a problem post office
- `src/audio/motorDsp.ts`, `src/audio/motorNodes.ts` - firing-pulse engine and its non-worklet copy
- `src/look/road/glsl.ts` - NaN-safe helpers for ANGLE D3D11
- `src/core/config.ts` - `musicStyle`, `trailSeconds` and other knobs
- `CONSTITUTION.md` - section 3 handbrake rule, section 7 amendments (setReverse, handbrake)
- `TASKS.md` - state and dated decisions
- `Learn To Code.html` - regenerated
- `~/.claude/rules/core/delegation.md`, `~/.claude/rules/governance/commit-discipline.md`, keycap guard hook

## Lessons

- With agent teams on, a named spawn without isolation is a teammate and ignores the agent def's effort.
- Snapshot copiers of this repo must include `server/` because `vite.config.ts` imports it.
- Web Audio renders through a feedback delay are not bit-repeatable in Chrome; null tests need several pairs or the echo muted.

## Next Steps

- ⬜ Nathan listens to `scratchpad/music` renders, then merge `music-classic` on his yes and rebuild :5203 (⚑ thread).
- ⬜ Nathan's human tests: real Xbox pad, Windows firewall prompt when hosting, two-computer multiplayer (Josh runs Update.bat first).

## Open Questions

- Is the bigger handbrake swing at 50-70 km/h what Nathan and Josh want?

## Git Status

- SundownRun2: main at 7533025, clean, pushed; `music-classic` pushed, intentionally unmerged. `scratchpad/` and `github-token.txt` gitignored.
- `~/.claude`: this session's commits all pushed.

## Related Sessions

- [2026-10-01 orchestrated build](2026-10-01-sundown-run-two-orchestrated-build.md) - day one of the same session id.
