---
type: auto
session_id: c88f4344-3259-45dc-b607-6c9a9a8390b0
project: SundownRun2
date: 2026-10-03
topic: 3 Oct playtest round - editor tools, tunnels, brakes, blow-off audio, track sharing
duration: 13 hours
events: 2416
events_unit: turns
---

# 2026-10-03 - Playtest round: editor tools, tunnels, audio and bridges

**Project:** SundownRun2 (`~/Dev/SundownRun2`)
**Purpose:** Work through Nathan's 3 Oct playtest feedback and GitHub #9 as a lead orchestrating a long chain of worker sessions
**Duration:** 13 hours
**Participants:** Nathan, Kai (lead) plus workers editor6-16, track6-10, stunts3-5, audio6-7, world3, vehicle11, tunnel1-4, share1
**Session Restart ID:** `claude -r c88f4344-3259-45dc-b607-6c9a9a8390b0`

## Summary

Kai ran a lead session from 11:00 on 3 Oct to about 02:00 on 4 Oct, spawning workers against Nathan's playtest asks and landing each patch on main through a gate (tsc, editor self-test, `tracks:check --physics`, demo laps), then rebuilding the stable copy on :5203. The big arc was tunnels (GitHub #9 part 3), first parked on a date and then, after Nathan's "there is no dates for anything", built in three stages to a usable Height-tool feature. Alongside it the road editor got a rework (ramps, Fix it, 3D view, new-track save, wall-ride placement), and the audio, brakes, stunts and billboards changes he asked for.

## What We Did

1. **Music-classic merged**: Nathan listened and approved, so the branch went to main (2de6107) and the thread closed.
2. **Road editor rework**: you can now pick which road goes over at a crossing (editor6); the tool rail is reordered and every tool edits the existing road (editor7); a whole stretch can be raised on drivable ramps with Fix it buttons (editor8); Fix it now only offers fixes it can do and mends hand-set banks (editor10); the tools explain themselves (editor9); there is a 3D view (editor11, later every tool works in 3D, editor16); Smooth the bumps (editor12); a new track never overwrites an old one (editor13); wall rides are placed from their centre and Auto bank shows its angle (editor14); bridges have straight tops (editor15). Bank now sits before Height on the rail.
3. **Track builder fixes**: track6 (no ground poking up under a bridge's lift, and the low edge of open banked road stays on the ground), track7 (roads follow the hills, not every bump, with a Road surface setting), track8 (three builder bugs on banked and raised road), track9 (the ground round every bridge is a slope capped at 31 degrees, never a cliff, with `BRIDGE_BUILDER_VERSION 1` in the track key).
4. **Tunnels (GitHub #9 part 3), all stages live**: tunnel1 (underpasses), tunnel2 (real covered tube), tunnel3 (one-click tunnel at a crossing, cars dimmed inside, engine echo, then round C putting tunnels in the Height tool with a footprint showing the road each needs either side, and round D making the fit the same on every computer). Thread resolved.
5. **Feel and audio**: Brakes 100% now stops like the old 150% (vehicle11). The rally car plays a blow-off at every upshift (audio7, after a wrong first try at a turbo spool-down) and no longer has a wind sound at high revs (round 3). There is a favourite songs list (audio6).
6. **Stunts and world**: rings explode and come back (stunts3), the half-pipe ends and quarter-pipe sides slope into the ground (stunts4/5), bullseye targets lie flat, and there are 59 billboard ads, up from 8 (world3).
7. **Track sharing through GitHub** (share1, Q14). The probe now hides real controllers unless `--real-pad`.
8. At close: tunnel4 (outer-lane jolt at the foot of a bridge, plus physics-checker fixes) and track10 (a new built-in track that lands after tunnel4) were still running.

## Key Decisions

| Decision | Rationale |
|---|---|
| Tunnels unparked and built immediately | Nathan: "there is no dates for anything. just do the q3 now"; work that waits waits on an event, never on an invented date |
| Tunnels belong in the Height tool, with the footprint shown before the click | Nathan could not find the feature or tell why placement failed |
| The new 100% brakes is the old 150% | Nathan's direct call after testing |
| Rally upshift sound is a blow-off, with the high-rev wind removed | Nathan named the sound himself after the first attempt used the wrong one |
| Quarter-pipe taper option a (inside the face, no park moves) | Nathan picked option a (Q8) |
| Bridge builder version goes into a track's key only when it has a raised stretch | Keeps lap records on tracks without bridges, and resets them only where the geometry changed |

## Files Modified

Everything landed on main through worker patches (about 60 commits on 3-4 Oct). Main areas: `src/track/` (terrain, road, deck, tunnel meshes), the editor under `src/`, the audio mixer, `CONSTITUTION.md` (section 7), `README.md`, `CLAUDE.md`, `TASKS.md`, `open-threads.md`, `TIMELINE.md`, `plans/` (tunnel scope and stages), `Learn To Code.html` (regenerated after each landing), `scripts/check-tracks.ts`.

## Next Steps

- ⬜ Land tunnel4 (the ground jolt at a bridge's foot in the outer lane, outer-lane physics checks, the checker handle leak)
- ⬜ Land track10, the new built-in track, after tunnel4 and the new outer-lane checks
- ⬜ Nathan's human tests for the build thread (Xbox pad, firewall prompt, two-computer multiplayer)

## Related Sessions

- [2026-10-02 editor tools, stunt park, music](2026-10-02-editor-tools-stunt-park-music-cluster.md)
- [2026-10-02 playtest fixes and overnight polish](2026-10-02-playtest-fixes-overnight-polish.md)

## Atom candidates

<!-- KAI-ATOMS-VERBATIM -->
- GOTCHA: A probe that drives a headless game page in Chrome still sees any real game controller plugged into the Mac (a pad's View button restarted probe runs), so hide real gamepads from probe pages by default and add an opt-in flag for real-pad tests.
- PATTERN: When a placement tool has hidden requirements (a tunnel needing run-up road either side), draw the required footprint, including the extra length in a separate shade, on the hover preview before the click, rather than refusing silently.
- DECISION: When a geometry builder change alters generated tracks, put a builder version into the track key only for tracks the change actually affects, so lap records reset only where the road changed.
<!-- /KAI-ATOMS-VERBATIM -->
