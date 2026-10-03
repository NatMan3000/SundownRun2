---
type: auto
session_id: 1105ef14-74f9-46c1-9866-efc4f6d4bd79
project: SundownRun2
date: 2026-10-03
topic: Handbrake slides and 180s, reverse lights and ground-following glow, stunt park speed signs, classic music restored
duration: 2.7 hours
events: 2532
events_unit: turns
---

# Handbrake, reverse lights, stunt signs and classic music worker wave

**Project:** SundownRun2
**Purpose:** Four-worker wave on Nathan's playtest asks: released handbrake slides that keep going, reverse lights, stunt park round 2, and the original band sound back by default
**Duration:** 2.7 hours
**Participants:** Nathan, Kai (lead orchestrator plus 4 workers)
**Session Restart ID:** `claude -r 1105ef14-74f9-46c1-9866-efc4f6d4bd79`

## Summary

One orchestrated build across four concurrent worker sessions on the shared SundownRun2 tree (2-3 Oct). Each worker patched only its own hunks, proved before/after on production builds served from `git archive` snapshots, and reported to `/tmp/sr2/reports/`; the lead reviewed and committed. All four rounds landed on main: handbrake (0484226), reverse lights (757476c, dd95057), stunt park round 2 (8e0e70a) and classic music (5c50072, merged later from branch `music-classic`).

## What We Did

1. **Handbrake (vehicle10):** a slide started by a person's handbrake now keeps going when released past 30-40 deg (the three swing-back assists switch off; counter-steer restores them), and the drift ceiling is off below 55 km/h, fading back by 85 km/h, so handbrake 180s work at 40-80 km/h. Ai and demo untouched. CONSTITUTION section 3 amended.
2. **Reverse lights (revlights, patch 1):** white reverse lamps on all five bodies through a new channel in the one car light material (no extra draw calls), driven like brake lights, for player and Ai; ghosts have no lights.
3. **Ground glow (revlights, patch 2):** underglow and reverse glow moved to a screen-space post effect in `src/look/post`, fixing Nathan's "glow cut off by uneven floor" artifact; one draw call fewer. Remote cars light reverse from velocity via the new `VehicleApi.setReverse` contract (887fa87), no protocol change.
4. **Stunt park round 2 (stunts2):** speed number painted on every launch face, HUD speed cue ("Faster / On speed / Ease off"), park zones on minimap and world map, rings counted in the mid-air combo, lit end walls. Three round-1 design speeds corrected for tilted lanes. Contract d05e827 (`stunt.lineup`, `PlayApi.parkZones()`).
5. **Classic music (audio5):** original band restored bit for bit by default (null tests -136 to -141 dB vs HEAD), title keeps its new sound, house palette opt-in via `musicStyle` in `config.ts`; renders for Nathan in `scratchpad/music/`.

## Lead

**Session Restart ID:** `claude -r 1105ef14-74f9-46c1-9866-efc4f6d4bd79`

The brief's lead id is the vehicle10 worker (the orchestrating session itself was logged separately). It ran the longest (2.7 hours, 33 background-run notifications) iterating builds v10a to v10g against HEAD.
- Probes: Nathan's case at 40/70/110 km/h, handbrake 180 and drive-off, full feel battery at stability 0.5/1/1.5, high-speed taps, 3-Ai races on all three tracks (0 Ai resets), loops, wall rides, rewind into a released slide.
- Lead add-on: re-checked the stunt park kicker speed signs against the new car sim.
- Decisions handed up: keep the longer 50-70 km/h flick (F1), leave the slower settle at 150+ km/h (F6), proposed constitution tap wording; `bun run learn` after commit (PASS A anchor moved), landed as 0b91668.

## Workers

### Worker - audio5: original band sound back by default
**Restart ID:** `claude -r c04bbd61-28cf-495f-a220-2ad51b65febd`
- Null-test campaign proving every mood but the title matches HEAD; render variance traced to HEAD's ping-pong echo (Chrome feedback-loop ordering).
- `musicStyle: 'classic' | 'house'` knob, style switches at the next bar; idle band switched off after 8 s.
- Driving reactions refitted to the classic mix; `reactions-after.wav`, `race-house.wav` rendered.

### Worker - revlights: reverse lights and screen-space ground pools
**Restart ID:** `claude -r 0fb8df6b-8243-4cc0-abf6-281f77d11f4f`
- Patch 1 reverse lights on all bodies; patch 2 screen-space pools plus remote reverse.
- Two-window multiplayer check through a local relay.
- Known limit: remote reverse is inferred from motion (about 1.2 s lag, slow backwards slides can light up); a packet flag would fix it.

### Worker - stunts2: stunt park round 2
**Restart ID:** `claude -r a5415918-e67e-488a-a166-9d361acef753`
- Virtual-controller proof on all 26 launches across three tracks, every one scoring with no wipeouts.
- NaN in the first shader version caught with a SwiftShader NaN check before the final build.
- Perf inside budget (worst p99 14.1 ms vs 16.6).

## Key Decisions

| Decision | Rationale |
|---|---|
| Handbrake changes apply only to slides a person's handbrake started | Keeps Ai and demo driving byte-identical |
| Keep the longer 50-70 km/h flick | A softer yaw limit (v10g) barely helped; HEAD's limit is what blocked the 180 |
| Ground glows rendered as a post effect | Geometry quads were cut off by uneven ground and body roll |
| Remote reverse inferred from velocity, no protocol change | Cheap; a packet flag left as the lead's call |
| Classic band is the default, house opt-in | Nathan: the originals sound better except the title |

## Files Modified

| File | Change |
|---|---|
| `src/vehicle/carSim.ts`, `src/vehicle/tuning.ts` | Released-slide and handbrake ceiling logic |
| `src/vehicle/bodies/*`, `carModel.ts`, `SimulatedCar.tsx`, `src/look/fx/CarLights.tsx`, `groundPools.ts` | Reverse lamp channel |
| `src/look/post/GroundPoolsEffect.ts`, `PostStack.tsx`, `src/net/RemoteCars.tsx` | Screen-space pools, remote reverse |
| `src/vehicle/tricks.ts`, `src/play/stunts/*`, `src/ui/hud/ParkCue.tsx` | Speed signs, cue, combo rings |
| `src/audio/music/*` | Classic default, house style |

## Next Steps

- ⬜ Nathan to playtest the handbrake feel (F1 flick size, F6 high-speed settle)
- ⬜ Nathan's ear on the classic answer stab loudness (`STAB` in `instruments.ts`)
- ⬜ Decide whether to add a reversing flag to the network packet
- ⬜ Add the two COMMON.md gotchas (below) to the team rules

## Related Sessions

- [2026-10-02 editor tools, stunt park, music cluster](2026-10-02-editor-tools-stunt-park-music-cluster.md)
- [2026-10-02 rewind, bonnet cam cluster](2026-10-02-rewind-bonnet-cam-report-ui-audio-cluster.md)

## Atom candidates

<!-- KAI-ATOMS-VERBATIM -->
- GOTCHA: A scratch vite dev server run from a snapshot directory that symlinks the main checkout's node_modules rewrites the shared dev server's dependency cache; give each scratch server its own cacheDir.
- GOTCHA: For two-window browser multiplayer tests, use a separate browser per window and point the host at 127.0.0.1 rather than localhost; a second tab in the same browser stalls and never shows the other car.
- GOTCHA: Web Audio renders with a feedback-loop delay (ping-pong echo) are not bit-reproducible in Chrome, so null tests need several runs per side or the echo muted to separate real differences from run-to-run noise.
- PATTERN: Ground light pools (underglow, reverse glow) drawn as mesh quads get clipped by uneven terrain and body roll; compositing them in a screen-space post effect makes them follow the real ground and saves a draw call.
<!-- /KAI-ATOMS-VERBATIM -->
