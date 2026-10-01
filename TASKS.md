---
type: plan
title: Sundown Run Two - build checklist
description: The living checklist for the orchestrated build. Survives context summaries; the orchestrator ticks items only against tool results from the session.
created: 2026-10-01
---

# Sundown Run Two - build checklist

Status: ✅ done (verified by a tool result) · ⬜ pending · ⚠️ partial · ⛔ blocked. Owner in brackets. A worker's report is not a tick; a checker's pass (or the orchestrator's own tool result) is.

## Phase 0 - foundation (orchestrator)

- ✅ Repo initialised, deps installed (Vite 8, React 19.3, r3f 9.8, drei 10.7, rapier 2.2 / rapier3d-compat 0.12, postprocessing 6.39, three 0.186, zustand 5)
- ✅ CONSTITUTION.md written
- ✅ Contracts frozen: config, settings, store, telemetry + car registry, events, controls, palette, physics groups, perf, dev handles, records, api, track schema, track runtime types, registry, current track, session flow
- ✅ App mount points + stub modules, boot, probe script (headless GPU Chrome verified: ANGLE Metal, M5 Max, GPU timer supported)
- ✅ Ports 5201 / 5202 added to ~/Dev/.claude/rules/reserved-ports.md
- ✅ Dev server running on 5201 (`vite --host`, LAN-reachable) for Nathan and Josh
- ✅ Nine workers spawned 2026-10-01 ~18:10 AEST: track, vehicle, world, look, audio, ui, play, editor, net

## Phase 1 - systems (workers)

### track [track]
- ⚠️ validateTrack: errors, warnings, defaults (worker + orchestrator tracks:check runs; checker pending)
- ⚠️ buildTrack: centreline spline, 1 m samples, frames, auto-bank + overrides, widths, heights (terrain-follow + lift + absolute y)
- ⚠️ Loops (teardrop corkscrew, magnetic surface) and wall rides (quarter/half pipe); in-game loop ride depends on vehicle mag grip
- ⬜ Ramps, boost zones, speed traps, props, cores, roadside placement
- ⬜ Terrain recipe: hills, flat, features (hill, bowl, mesa, bigAir), road flattening, ridge/wall edge
- ⬜ Derived: checkpoints, racing line + target speeds, grid slots, minimap, hash/key
- ⚠️ Colliders: road slab trimesh, magnetic surfaces tagged, barriers, ramps, terrain heightfield (index order probed), catch floor, boundary, auto-reset hook
- ⚠️ Live param rebuild (bankDeg) without moving the car: 17-50 ms (worker), slider in pause menu (ui)
- ⚠️ tracks/afterglow.json (redesign by designer: figure-eight, 11 m bridge), tracks/hyperdrome.json; bigAir reshape pending
- ⚠️ tracks/README.md written; 13 findings from the one-file proof being fixed
- ✅ bun run tracks:check validates every file in tracks/ (orchestrator ran it: Afterglow and Neon Pocket exit 0)

### vehicle [vehicle]
- ⬜ Input: keyboard + Gamepad API, hot-swap, smoothing, menu bus, contexts, pad gesture unlock hook
- ⬜ Multi-instance raycast car sim lifted from v1 with its fixes (handbrake self-straighten, brake balance, stability, landings, air control, NaN firewall)
- ⬜ Magnetic grip on loops / wall rides; boost response
- ⬜ Resets: R road, Shift+R start, below-ground / out-of-world auto-reset
- ⬜ Trick detector (angular-rate integration, scored at landing), lap tracker (track checkpoints + dirty rule), ghost record/playback per track key
- ⬜ Five procedural futuristic car bodies + catalog API + garage model builder
- ⬜ Camera rig: chase / close / bonnet, springs, FOV kick, up-vector spring on loops, no clipping, showroom + bookmarks
- ⬜ ?demo=1 autopilot on the racing line + perf recording

### world [world]
- ⬜ Synthwave sky: gradient, striped sun sinking with time of day, stars, ringed planet
- ⬜ Megacity skyline, windows lighting progressively
- ⬜ Terrain look: dark glass + grid, far dissolve, haze
- ⬜ Sun/moon + hemisphere lighting by time of day, sunset clock
- ⬜ Holographic billboards (solid, consistent), Hyperdrome stadium
- ⬜ ?time= override + dev command

### look [look]
- ⬜ Wet reflective road: light-strip edges, lane lines, pulsing corner chevrons, loops as light rings, wall-ride tubes, boost arrows, ramps, speed trap marker
- ⬜ Car fx: light trails, underglow, livery glow, headlights at night, tail-light streaks
- ⬜ Fx API: shards, sparks, pulses (pooled, instanced)
- ⬜ Post stack: budgeted bloom, tone mapping, vignette, SMAA, boost chromatic aberration + speed lines
- ⬜ Quality presets low / medium / high / auto

### audio [audio]
- ⬜ Engine sound (neon, tracks rpm and speed, free-revs in air), surface, boost, wind
- ⬜ Effects: crashes, prop bursts, smashes, pickups, tricks, laps, countdown, UI
- ⬜ Procedural synthwave music: drums, bass, arps, pads; intensity from speed / boost / race state; mood per track; never the same twice
- ⬜ Mixer: music and effects volumes, ducking under crashes; gamepad unlock; HMR dispose

### play [play]
- ⬜ Modes: free roam, time trial + ghost, race vs 0-5 Ai, stunt score attack
- ⬜ Ai racers on the derived racing line, difficulty, catch-up, boost pads, solid
- ⬜ Crash props (burst for points, re-scatter each round), smashables (solid slow, smash fast), energy-core hunt + clock, speed trap records
- ⬜ Records persisted, events emitted

### ui [ui]
- ⬜ Title screen + garage (bodies, paint, underglow, trail), track + mode select
- ⬜ Settings menu (all groups), pause menu, fully controller-navigable
- ⬜ HUD: speed, laps, timers, minimap, trick feed, race position, speed trap, hunt, stunt, toasts
- ⬜ Results screens

### editor [editor]
- ⬜ Top-down view of the world (doubles as the world map)
- ⬜ Freehand pencil -> smooth, min radius, auto-bank, per-section bank override, terrain flattened, loop closed
- ⬜ Place pieces: boost pads, ramps, loops, wall rides, crash props, cores, start line; undo / redo
- ⬜ Save locally, export / import the track file, test drive
- ⬜ Drive-to-draw mode

### net [net]
- ⬜ Relay + bun run mp lifted from v1 (5202), join links
- ⬜ Remote cars as imperative kinematic bodies (they shove you), interpolation
- ⬜ Synced race starts from a deterministic grid, shared prop rounds
- ⬜ Host's track (drawn included) streams to joiners
- ⬜ Tag mode

## Phase 2 - Josh's door and Windows [orchestrator + a worker]

- ⚠️ Sundown Run Two.bat, Sundown Run Two Multiplayer.bat, Sundown Run Two Update.bat written and committed, CRLF pinned (index LF, attr eol=crlf); needs the Windows human test
- ⬜ README: play, multiplayer, editor, Windows setup, GPU fix (High performance) and how to check the GPU
- ⬜ Learn To Code.html (bun run learn), missions anchored to real file:line
- ⬜ CLAUDE.md for future sessions

## Phase 3 - checks (fresh-context checkers)

- ⬜ Visual judge: both tracks at sundown and at night
- ⬜ Performance: demo drive per track on high
- ⬜ Feel: handbrake tap, held drift, mid-corner braking, landings, loops, wall rides; keyboard and controller paths
- ⬜ Track-as-one-file proof: third track authored from tracks/README.md only; loads, plays, validates laps, Ai finish it
- ⬜ Editor round-trip: draw, place, save, reload, export, import, test-drive a valid lap, Ai finish it
- ⬜ Hyperdrome: bank changes live, car holds the banking at speed, speed trap records
- ⬜ Two-client multiplayer: join, see, collide, race, tag, drawn track reaches the joiner
- ⬜ Clean clone: bun install && bun run dev first try

## Human tests (cannot be checked from the harness)

- ⬜ Physical Xbox controller over Bluetooth
- ⬜ The .bat files on Windows
- ⬜ Windows firewall rule prompt
- ⬜ Multiplayer across two real machines
- ⬜ Frame rate on Josh's laptop (RTX 4060, 165 Hz); Settings > Graphics should name the NVIDIA chip (the amber built-in-chip note only appears on an integrated chip under 50 fps)

## Found along the way

(Defects caught by checks and playtests, with owner and status.)
- ✅ [track] Hyperdrome bank flips sign across the s=0 seam (-27.5 deg at s=2269 to +22 deg at s=10); grid slot 0 sits on an 18 deg roll and a parked car rolls backwards (vehicle, live probe). Fix the seam wrap and put the line/grid on the flat straight.
- ⬜ [world] Art: near grid as bright as the road edges; ridge reads as a red-lit wall; sun stripes hairline (orchestrator frame /tmp/sr2/main/a1.png).
- ⬜ [look] Art: thick lavender centre stripe behind the car (trail or lane line?) reads as a road marking.
- ✅ [all] Two rapier copies: top-level 0.12 from @types/three vs @react-three/rapier's nested 0.19.2. Rule: never import @dimforge/rapier3d-compat directly (CLAUDE.md gotcha).
- ✅ [track/world] Ruling: sunset notch in the edge ridge (sun azimuth +/- 40 deg at ~30% rise), city at ~1.6 x world size.
- ✅ [look] Ruling: Neutral tone mapping (ACES washed the sun gradient; world's A/B screenshots).
- ✅ [audio] Ruling: audio owns the countdown beeps (from race.countdown).
- ✅ [track] Road and skirt triangles wound clockwise (ribbon.ts quad() normal = e2 x e1): road top culled from above, skirt underside shows (look). Also explains editor's "terrain covers road" from top-down.
- ⚠️ [track] Afterglow loop entrance is a solid wall (track: fixed with teardrop + drive-through gate; Ai still stalled there in designer's race, possibly older build) at s 3216: cars stop dead; five Ai + demo piled up 4+ min (play). Needs a drive-through physics test.
- ⚠️ [designer] Afterglow redesign (orchestrator, game director): rounded rectangle with long straights and an empty middle; wants a flowing layout through the world, 40-60 m elevation, big-air hill by the road, loop toward the sun, wall ride on a sweeper, a crossover bridge.
- ⬜ [vehicle] First d-pad press after a pad connects fires the menu action twice (ui).
- ⬜ [look] Live switch to Neutral tone mapping renders black (world).
- ⬜ [vehicle] Car art: faceted low-poly look and dull red-magenta paint; wants smooth normals + clearcoat. Showroom camera must frame the car in the right half (menus cover the left).
- ✅ [contract] Planet default elevation 16 deg (was 28: off-frame at night). TrackParamInfo.default added. ResolvedTrackFile.laps typed number | null. Skirt uv semantics. Physics updatePriority -50.
- ✅ [audio] Checker audio-1 (11/13): race countdown beeps stack (GO booked 3x, one a semitone off) because a booking happens per race.countdown event. Contract now: emitted once per countdown.
- ⚠️ [ui] Checker audio-1 D1 (hint added, not re-checked): pad-only player never gets sound (Chrome: pad press isn't user activation). Add a "press any key or click for sound" hint while audio isn't running.
- ⬜ [play] race.countdown emitted every second (should be once); goAt includes settle time so the HUD shows a "4".
- ⬜ [vehicle] Clean landings classified as intensity-1 crashes (8 per 45 s demo).
- ⬜ [harness, outside repo] Kai's tabguard hook denies MCP press_key/click/emulate when Canary has a new-tab-page tab (CDP /json/list says chrome://newtab/, MCP lists chrome://new-tab-page/). Not edited (outside the build's scope); checkers work around it.
- ⬜ [proof] Third track "Neon Pocket" being authored by a fresh agent from tracks/README.md only (19:30 AEST); then a checker proves it loads, plays, validates laps, Ai finish it.
- ✅ [play] Hyperdrome race proof (worker-run): 5 Ai + demo player finished all 5 laps, 3 Ai resets, finishes 218-235 s.
- ✅ [net] Stage B (worker-run, two clients): synced 5-lap race with identical results, shared prop rounds, tag agreement within 16 ms, CrashProps track-change repro 20/20 clean.
- ⬜ [look] Loop reads as a dark curling wave, not "rings of light": edge tubes round the whole loop, full hoops, no flat magenta outer face.
- ✅ [ruling] One driving brain: the ?demo=1 autopilot drives the player's car with play's Ai Driver (difficulty 1, no catch-up) through driveOverride; play owns the brain's tuning, vehicle owns the demo harness.
- ⬜ [vehicle/play] Demo autopilot leaves the new Afterglow at s 1028 (downhill right-hander), s 2323 (loop), s 2500-2640 (loop exit to hairpin, airborne), s 3185 (bridge east approach), then re-matches to the lower branch (designer, current tree).
- ⬜ [vehicle] Ai trackS jumps levels at the crossover (VECTOR 1250 -> 3568).
- ⬜ [track, next worker] Gradient-aware braking pass in the racing line (downhill right-hander at s~1028 on Afterglow; play's driver now compensates on its side).
- ⬜ [track, next worker] Drive-through gate false positive: the centreline "road at checkpoint k" run fails when an offset ramp's 18-deg side slope crosses lat 0 within its window; skip/offset those runs over a ramp's s0..s1 (designer repro: afterglow start.at 2.0, ramp at 31.6).
- ✅ [track] Worker stopped at 92% context after rounds 1-3; handoff at /tmp/sr2/reports/track-handoff.md for a fresh track worker.
- ✅ [net] Stage C (worker-run): robust 24/24, mp:check against a built preview 37/37, relay tests 18/18. Checker mp-1 running on adc93dd.
- ⚠️ [ui] Checker ui-1 on 75e790d: 5 pass / 3 fail. PASS: controller-only path, keyboard path (no arrow leak), hot-swap, settings live + persisted, Hyperdrome bank live from pause and settings (car keeps driving), HUD (rAF + refs, legible into the sun), console. FAIL: D1 settings Track tab focus on a track with no params; D2 garage car hidden behind panel (vehicle camera + ui); D3 track-select panel 77% empty; D4 settings panel blank on short tabs. Pad double-fire NOT reproduced.
- ⬜ [play] Stunt run ends instantly on resume after a pause longer than the time left (ui-1 P1).
- ⬜ [vehicle] Held trigger through pause is ignored after resume until re-pressed (car coasts into a wall); limit the anti-leak to menu keys.
- ⬜ [vehicle] NaN torque at spawn caught by the firewall on Afterglow (orchestrator probe 19:52).
- ⬜ [track, next worker] Racing-line speed through wall rides assumes ~1.9 g while its offset keeps cars on the flat; either assume flat grip there or run the offset up the wall (play).
- ⬜ [designer] Afterglow boost pads 110-165 m before the loop with a corner in between: everyone arrives 40-90 km/h too fast and misses the loop mouth (play).
- ✅ [designer] Afterglow final layout committed (648dfa8): 4.27 km figure-eight, 45 m relief, 13.4 m bridge clearance, boost straight into the loop toward the sun, 100 m wall-ride arc, big-air hill by the road; tracks:check clean, no warnings. 4 of 5 Ai finished lap 1 in the designer's race.
- ⬜ [track, next worker] Loop exit: a car going straight after the loop hits the loop's own entry leg (the corkscrew's ~7.5 m lateral shift); Ai VECTOR jammed 20 m past the loop centre. Make the exit shift longer/gentler and give the loop legs a deflecting, not blunt, face.
- ✅ [world] Sun is the hero again on both tracks at t 0-0.2 (skyline cuts its lower part); jagged dark edge ridge; stadium lights <= 0.6 T1. World worker stopped (87% context, handoff /tmp/sr2/reports/world-handoff.md). Ruling: Hyperdrome stands stay 63 m off the road (barriers + solid stand front contain the car).
- ✅ [audio] Audio worker stopped (all stages done, checker 11/13 with both fails fixed).
- ⬜ [track2] Hyperdrome sky.timeOfDay 0.35 -> 0.12 so it loads with the sun up.
- ⬜ [perf] Frame times vary 3.1-6.4 ms on the Hyperdrome across runs while other agents share the GPU: run the perf checker on a quiet machine.
- ✅ [ruling] The "SUNDOWN RUN TWO" gradient-stripe logotype is a deliberate exception to Kai's UI baseline ban on gradient text: it is the game's title art in the synthwave genre's signature style, not interface chrome. Menu panels use blurred dark glass for legibility over the live 3D scene (functional, not decorative).
- ✅ [world] NaN ridge vertices fixed by the orchestrator (clamped noise before a fractional pow; traced by look). Probe load: 0 NaN messages.
- ⚠️ [net] Checker mp-1 on adc93dd: 8 pass / 1 fail / 1 partial. PASS: launcher links, join + see each other, smooth remote motion, synced race, tag, drawn track streams, shared props, no Ai in MP. FAIL: cars spawn on the same spot at MP session start / host track change. PARTIAL: rammer stops dead on its own screen (kinematic wall). Display: both show P1 after GO, "+155.9 s" gap in countdown. Routed to net.

## Orchestrator state (resume here after a context summary)

Updated 2026-10-01 ~20:45 AEST. Lead = this session (Kai). Briefs: scratchpad/briefs/*.md (COMMON, CHECKER, per worker). Reports: /tmp/sr2/reports/. Verdicts: /tmp/sr2/checks/*-verdict.md. HEAD ~847ece6.

- Pane workers: vehicle (working numbered queue 0-11: 0 soft CCD + loop reset run-up, 1 NaN torque at race start/spawn, 2 re-verify loop/ramp on neon-pocket + afterglow at 100/150/190, 3 demo uses play's createAiDriver, 4 full-lock lateral g per speed -> track2 + rack retune >= 1.4 g, 5 air self-righting, 6 landings != crashes, 7 held trigger through pause, 8 coasting, 9 Ai trackS at crossover, 10 input.ts form controls + clearcoat + showroom framing, 11 hide ghost in multiplayer); play (loop alignment for Ai, final 5-Ai proof on afterglow + neon-pocket after vehicle item 0); track2 (waiting on vehicle's full-lock g for a g_max(v) line cap); look, ui, editor idle (editor 79% context, handoff /tmp/sr2/reports/editor-handoff.md).
- Background: net done (mp-1 fixes committed 847ece6); checkers running: feel-1 (d7ac08e), editor-1 (7cdbb60), mp-2 (847ece6). Designer, learn: done.
- Stopped: track, world, audio (handoffs in /tmp/sr2/reports/).
- Next checks: ui-2 (ui-1 D1-D4 + play P1 + sound hint on pause), onefile-2 (Neon Pocket gameplay: demo lap, 5 Ai finish, ghost) after vehicle 0-3, feel-2 (loops, wall rides, boost, ramps) after vehicle queue, visual judge (all 3 tracks sundown + night), perf (demo per track on a QUIET machine, after the demo laps cleanly), Hyperdrome bank + speed trap, clean clone (last).
- Final: regenerate Learn To Code.html (bun run learn) and commit; finish CLAUDE.md; final reply with headings Blocked on me / Changed / Found.
- ✅ [play] Afterglow 5-Ai proof (worker-run, before loop line-up): all 6 cars finished 3 laps, 15 Ai resets (11 at the bridge approach). Rerun with loop line-up + curvature feedforward steering in progress.
- ✅ [vehicle] Queue 0-10 landed (dde33f9): soft CCD + RoundCuboid chassis (no dead stops), loop reset run-up, zero NaN in 3 x 100 s, loops/ramps clean at 100-190 km/h on afterglow + neon-pocket, demo on play's brain, full lock 1.37-1.57 g, crash = lateral/forward velocity change only, triggers live on resume, coast 0.70 m/s^2 @60, teleport re-seeds the hint, form-control keys, paint, showroom. Vehicle worker stopped (context limit); handoff /tmp/sr2/vehicle/HANDOFF.md. Open for vehicle2: item 11 (hide ghost in multiplayer) + feel-1 findings.
- ⬜ [track2] nearest() with hintS may fall back to a global search near the crossover (one Ai trackS jump of 1848 m in 100 s); update gripTable with vehicle's new numbers.
- ⚠️ [vehicle2] Checker feel-1 on d7ac08e: 10 pass / 3 fail. PASS incl. keyboard tap, held drift, mid-corner braking, steering, landings, air/free-rev, camera cycle chase/close, resets, hot-swap, 0 NaN in 35 sessions. FAIL: D1 pad 400 ms handbrake tap peaks 28.2 deg (limit 25); D2 10-15/360 physics steps barely move the car on the road trimesh (one-frame 0.5-0.8 m hitches; likely hard CCD, fixed by soft CCD in dde33f9, to verify); D3 camera pops entering/leaving bonnet view. Routed to vehicle2 ahead of boost/brake steering.
- ⚠️ [net] Checker mp-2 on 847ece6: 8 pass / 1 partial / 1 fail. Ramming now passes. FAIL: countdown gap flashes absurd values; both screens show P1 for up to 1.87 s in close racing. PARTIAL: an arriving car spends one frame on slot 0 inside the other (no collisions in 17 runs). Routed to net.
- ✅ [orchestrator] Stable playtest copy on http://localhost:5203 (vite preview of e4fc579 from /tmp/sr2/stable, LAN-reachable), because workers' mid-edits can break the live 5201 dev server (net's netStore.ts did at ~21:15). Port added to reserved-ports.md. Rebuild it from the latest good commit when big fixes land.
- [state 21:20] HEAD 6ff0550. Live: vehicle2 pane (feel-1 D2 hitches / D1 pad tap 28 deg / D3 bonnet pop, then boost + brake steering, ghost hidden in MP, PlayerCar on store.playerGridSlot), track2 (idle), play (holding the final proof race for vehicle2), ui (race gap live re-check), look/editor idle; net (background) re-runs mp-2 after vehicle2's playerGridSlot. Checker editor-1 still running. Stable playtest copy: 5203 (e4fc579). Next checks: mp-3, ui-2, onefile-2, feel-2, visual judge, perf (quiet machine), Hyperdrome, clean clone.
- ⚠️ [editor/track2] Checker editor-1 on 7cdbb60: 12 pass / 3 fail / 1 partial. Round trip passes (draw, place, save, reload, export, import, test drive, track select, drive to draw, world map via API). FAIL: a track with an editor-placed loop fails tracks:check while the editor says 'All good' (track2 exports shared runTrackGates; editor uses it + straight run-in for placed loops); Ai stall at loop/wall ride (vehicle2/play); Map button hidden (fixed since in 76868c7).
- ✅ [editor] Loop run-in rule committed (fdd1f40). Editor worker stopped at 81% context; handoff /tmp/sr2/reports/editor-handoff.md. Open: switch the editor's verdict to track2's runTrackGates when it lands (spawn editor2 for it).
- [state 21:40] Look worker stopped (idle 80 min; handoff /tmp/sr2/reports/look-handoff.md). Visual judge visual-1 running on HEAD (33693e0+). editor2 switching the editor verdict to runTrackGates. vehicle2 on feel-1 D1-D3 + turn-in at speed + brake steering + ghost in MP + playerGridSlot. Respawn look/world fresh from handoffs if visual-1 fails items.
- ⚠️ [visual] Checker visual-1 on 33693e0: 27 pass / 11 fail, 0 console errors, 53-106 draw calls, 173k-382k tris. Defects: D1 muddy orange terrain sheen in sundown aerials, D3 black anti-sun hills, D5 invisible planet ring + egg distortion, D7 mirrored billboard art + too few, D9 anti-sun sky hotter than the sun side (-> world2); D4 bridge skirt reads as a slab, needs pylons + form, D6 hard-edged headlight beams (-> look2); D2 demo wipes out on Afterglow ramp 890 (-> play); D8 Neon Pocket near-primary green edge (fixed by orchestrator, 017be91).
- [state 22:00] Live: world2, look2 (visual-1 fixes), vehicle2 (A-D: feel-1 D2 hitches, D1 pad tap, D3 bonnet pop, playerGridSlot), play (final Ai proof + ramp 890), track2 (idle, 73%), ui (idle); net background (Shift+R re-run after vehicle2 D). Stopped: track, world, audio, look, editor, editor2, vehicle. Stable copy 5203 (e4fc579).
- ✅ [net] mp-2 items pass per frame (worker-run): countdown gap 0, 0 P1 clashes in close racing, no frame draws a car on another's slot (arrival, track change, Shift+R after vehicle2's playerGridSlot). Race 17/17, spawn 15/15, regression 57/57. Routed: ui 4th track card unreachable by d-pad; vehicle2 idle cars creep backwards on Neon Pocket's banked grid.
- [state 22:10] Final play proof suite running (~20 min). world2/look2 on visual-1 fixes. vehicle2 on feel-1 A-D. Next: commit vehicle2 + play results, re-checks (feel-2, onefile-2, ui-2, visual-2), perf on a quiet machine, Hyperdrome check, clean clone, CLAUDE.md, learn regen, final report.
- ✅ [play] Final Ai proof (worker-run, play-stageC.md): Afterglow 5 Ai + demo x 3 laps all finished, 0 Ai resets, every Ai completed every loop; Neon Pocket all finished, 5 resets (4 at loop exit in traffic); demo clean counted laps on all three tracks (Afterglow 110.2 s with no wipeout at ramp 890, Neon Pocket 65.4/63.3, Hyperdrome 51.4/47.7/47.5), 0 resets. Routed to vehicle2: 12 false trick.wipeout events on the Hyperdrome demo (banking?).
- ⬜ [ui-2 check] Controller path after the nav/tab changes: in ui's scripted pad run, 5 Downs on the pause menu stopped one short (Road Editor, not Quit); keyboard is correct. ui-2 must re-run the full pad walkthrough.
- ✅ [vehicle2] feel-1 D1-D3 fixed with the checker's scripts (0d70c2e): D2 0/2400 slow steps (soft CCD was the fix), D1 pad tap 6.6 deg, D3 bonnet jolts 0.07-0.11 m; playerGridSlot wired. Next: F false wipeouts on banking, E auto-hold.
- [state 22:30] Running checkers: onefile-2 (0d70c2e), ui-2 (0d70c2e). Workers: world2, look2 (visual-1), vehicle2 (F, E), ui idle, play idle (done), track2 idle (75%). Next: feel-2 after vehicle2 F/E; visual-2 + perf after world2/look2; Hyperdrome check; clean clone; CLAUDE.md; bun run learn; final report.
- ⚠️ [ui] Checker ui-2 on 0d70c2e: 6 pass / 2 fail. PASS: ui-1 D1-D4 fixed, full pad + keyboard walkthroughs, 0 drops/doubles in 300 pad presses, stunt pause, sound hint, graphics chip. FAIL: D1 world map ignores pad B and pad Menu unpauses the game; D2 menus jump 29-32 px when the sound hint disappears. Routed to ui (allowed to touch the map's back handling in src/editor).
- ✅ [proof] Checker onefile-2 on 0d70c2e: 6 pass / 1 partial: ONE FILE PROVEN (one file, tracks:check, clean demo laps 3/3 that set bests, cuts voided, all 5 Ai finish with 1 reset, ghost appears, ramp lands upright 4/4, loop hands-off 10/10). Partial: holding right through the loop at 120 km/h drops the car 4/4 (vehicle2 item G: physics-aware loop grip). Also D2: race results best lap credits dirty laps (play).
- ✅ [track2] Round 6: rapier handles in Int32Array (truncated to 0) left old ground solid after live bank rebuilds; Float64Array + live-rebuild physics gate (fc62d6f). track2 stopped at 79% context; handoff /tmp/sr2/reports/track2-handoff.md. Gotchas added to CLAUDE.md (handles, hard CCD). play sweeping its handle arrays.
- [state 23:05] Live: vehicle2 (loop grip G + Afterglow loop bleed + bump-stop cap), play (race best lap dirty laps; handle arrays), world2 (visual-1 D1/D3/D5/D7/D9, not yet reported), ui/look2 idle. Next: feel-2 after vehicle2's loop round; visual-2 + perf after world2; Hyperdrome check; clean clone; CLAUDE.md; bun run learn; final report.
- [state 23:10, pre-compact] HEAD bc3371e. Live panes: vehicle2 (G loop grip physics-aware + Afterglow loop bleed 257->66 km/h + bump-stop 26 kN cap, H CarState.lastLapDirty/lastLapMs written in the same step as lap++, then tell play), play (waits on H, then deletes its fallback dirty rule and verifies with a race), world2 (visual-1 D1 muddy sheen, D3 black anti-sun hills, D5 planet ring + egg, D7 mirrored billboard art, D9 anti-sun sky too hot; not yet reported), ui and look2 idle. Background: none running. Stopped (handoffs in /tmp/sr2/reports/): track, track2, world, audio, look, editor, editor2, vehicle. Stable playtest copy :5203 (e4fc579, rebuild from HEAD before the final report). Done checks: audio-1, ui-1, ui-2 (fixes committed), mp-1, mp-2 (fixes pass per frame), onefile-1, onefile-2 (proof passes; loop hold-right partial -> G), feel-1 (fixed), editor-1 (fixed), visual-1 (look2 D4/D6 + pylons committed; world2 pending; D8 fixed; D2 fixed by play). Remaining checks: feel-2 (after G), visual-2 + perf on a QUIET machine (after world2), Hyperdrome bank + speed trap, clean clone (last). Then: bun run learn + commit, finish CLAUDE.md, rebuild 5203, final reply with headings Blocked on me / Changed / Found.
- ✅ [world2] visual-1 D1/D3/D5/D7/D9 fixed (a965a60): terrain glass as painted light (orange/brown pixels 16% -> 0% on afterglow aerial), anti-sun slopes filled violet (mean L 2.7 -> 15.1 in the checker's region), anti-sun sky violet (166,3,103) -> (88,55,150), planet as one ray-traced impostor (ring visible at any height, ball round at the frame edge, 1 draw), billboards flip art when seen from behind. Car warmth with the sun behind the camera routed to look2 (car paint in src/vehicle/carModel.ts, vehicle2 told).
- [state 23:25] HEAD a965a60. Live panes: vehicle2 (G, loop bleed, bump-stop, H), play (waits on H), look2 (round 2: car warm rim), world2 (idle, kept for visual-2 findings), ui (idle). Checkers running: hyper-1 (a965a60, :5224, Hyperdrome bank + speed trap), visual-2 (a965a60, :5225, visual-1 re-check + full judge). Next: feel-2 after vehicle2's loop round; perf on a QUIET machine after everything lands; clean clone last; CLAUDE.md; bun run learn; rebuild 5203; final report.
- ✅ [look2] Round 2: car paint warm sun side (0396b77): navy rear panel (61,0,32) -> (107,8,31) with the sun behind the camera, bright paints unchanged, night unchanged (mean diff 0.01/255). Rulings: no keyColor in the environment contract for now; shadowed cars still get the warmth (known limit).
- ⚠️ [visual-2] Checker visual-2 on a965a60: 38 pass / 15 fail (7 defects). FIXED: visual-1 D1, D3, D4, D5, D6, D7, D8, D9 sky half. Open: D2 demo leaves the Afterglow road after the big-air landing 3/7 + Neon Pocket loop entry at 55 km/h 1/5 (play); N1 night key-light specular clips white on the road (look2) and eats the speedometer (ui); N2 Hyperdrome edges were the player's cyan (fixed by Kai: e10ef9d, edge and edgeAlt magenta); N3 wet-road ripple blocky close up (look2); N4 Hyperdrome barrier bands hard-edged rectangles (look2); N5 lap panel illegible over a billboard (ui); N6 planet behind the minimap at the night start on all 3 tracks (world2). Notes routed: chevrons dull between pulses + beam fog fan (look2), D3 fill too even + stands thin from above (world2), title shot crops the sun (ui owns the title showroom camera for one round).
- [state 23:55] HEAD e10ef9d. Live panes: vehicle2 (G loops: 24/24 pass at 110-200 km/h, tuning the 200 km/h energy loss; asked about the track frame rolling 20 deg off the loop mesh), play (visual-2 D2 + loop entry floor; final re-run after vehicle2 commits), look2 (round 3: N1 road, N3, N4, notes), ui (N1 speedo backing, N5, title framing), world2 (round 2: N6, D3 form). Checker running: hyper-1 (a965a60, :5224). Next: feel-2 after vehicle2 commits; visual-3 (spot re-check of N1-N6 + D2) and perf on a QUIET machine after all land; clean clone last; bun run learn; rebuild 5203; final report.
- ⬜ [cars] Nathan, 00:05: "i want them to be better than the previous sundown run cars. They need to be awesome! Take inspiration from the different cars in the game Rocket League." Worker `cars` spawned (bodies/*, carModel.ts geometry; physics, wheels and handling unchanged; body must cover the physics box; budget <= today's calls per car, ~15k tris). Design gate: contact sheet of five silhouettes vs today and v1 before detailing. Then a fresh visual check of the cars.
- ✅ [ui] visual-2 N1 HUD half + N5 + title framing (3bbc54a): speedometer on a glass disc (region luminance 124 -> 34.5), one dense glass token on all six HUD surfaces, title shot keeps the sun in frame. Found: the production CSS minifier dropped unprefixed backdrop-filter, so no panel had blur in any built preview (5203 included); fixed. Follow-up queued: blur off on the Low preset.
- ✅ [Kai] Planet default 22 deg right of the sun, 19 up (0366b78), from world2's measurements (visual-2 N6).
- [ui] ui stopped at 85% context; handoff /tmp/sr2/reports/ui-handoff.md. ui wrote the blur-off-on-Low follow-up before stopping (uncommitted, unreported); Kai fixed its placement and verified on a production build: computed backdropFilter `none` on ?quality=low, `blur(10px) saturate(1.2)` on high [live].
- ✅ [vehicle2] Round 4, item G loops (ae3670f): 24/24 out at 110/150/200 km/h on both loops with any steering, 60 km/h crawl falls cleanly; the loop carries its own turn, magnet judges v^2 kappa >= 0.6 g, attitude follows the loop. Bump-stop clamp kept at 26 kN (higher cap bounced landings). Gap: up to 34 km/h extra loss at 200 km/h hands-off. Item H still to do (nothing writes CarState.lastLapDirty yet).
- ⬜ [track3] Spawned: loop frames roll up to 20 deg off the real mesh near the top (normal . frame up 0.936, Neon Pocket s~227); fix frames to match the surface (>= 0.995), geometry unmoved, new gate in runTrackGates.
- [state 00:25] HEAD ae3670f+. Live: vehicle2 (H), play (visual-2 D2 proof running), look2 (round 3: N1 road, N3, N4), world2 (round 2: D3 form, sky fallbacks), cars (redesign; design gate pending), track3 (loop frames). Checkers running: hyper-1 (a965a60), feel-2 (ae3670f, :5227). Stopped: ui (handoff /tmp/sr2/reports/ui-handoff.md). Next: visual-3 (N1-N6, D2, the new cars) after look2/world2/play/cars land; perf on a QUIET machine after all; clean clone last; bun run learn; rebuild 5203; final report.
- ✅ [world2] Round 2 (70cd9cd): N6 planet clear of the HUD on all three night start frames (screen boxes x 1040-1564, 106+ px from the minimap), D3 slopes shaded by local relief (drift-hill IQR 3.5 -> 6.8, no new dark pixels). Stadium bowl skipped (stands already reach 639 m of a 650 m world; ruling: no change).
- ✅ [vehicle2] Item H (43f31de): every car writes CarState.lastLapMs / lastLapDirty in the same step as lap++; play told. vehicle2 stopped at 91% context; handoff /tmp/sr2/vehicle2/HANDOFF.md (+ reports vehicle2-round1..4). Open vehicle thread: 200 km/h hands-off loop speed loss (top 146-169 vs 180 frictionless); a fresh vehicle3 takes it with feel-2's findings, after track3's frame fix lands.
- ⚠️ [hyper-1] Checker hyper-1 on a965a60: 4 pass / 4 fail. PASS: speed trap shows (within 0.1 km/h), trap records and persists, look, console. FAIL: D1 a car on the bank during a live change ends up inside the new road (falls 9.5 m or is thrown off) -> vehicle3 (re-seat on rebuild); D2 bank not in title Settings on a fresh profile -> ui2; D3 at 60 deg the inner barrier is a 30 deg ramp over a ditch, cars stuck -> track3; D4 at 60 deg the car rolls over at ~245 km/h with four wheels on the road, demo crashes -> vehicle3 (cap the slider only by Kai's ruling). O1 rebuild stutter while sliding -> ui2 debounce (+ track3 cheaper rebuild). O2 trap best is per bank angle -> ruling: keep per-angle records, show the angle with the best (ui2). O4 steep cut slope looks plain and faceted, no far plane west -> world2 round 3.
- [state 00:40] Live: play (D2 proof), look2 (round 3), world2 (round 3: steep-bank look), cars (redesign), track3 (loop frames, then D3, terrain under the bank), vehicle3 (D4, D1, then loop re-run), ui2 (D2, slider debounce, trap labels). Checker: feel-2 (ae3670f). Stopped: vehicle2, ui, chk-hyper, chk-visual2. Next: hyper-2 after vehicle3/track3/ui2; visual-3 after look2/world2/play/cars; perf on a QUIET machine; clean clone; learn; 5203; final report.
- ✅ [look2] Round 3 (3454138): N1 night key-light highlight under the bloom line (Hyperdrome streak p95 194 -> 104), N3 ripple from analytic noise slopes (no quad bricks), N4 barrier bands as soft lap-fitted comets, chevrons lit at rest (T1), headlight pool as a soft bell (the fan was the road pool, not the volume). Gotcha added to CLAUDE.md: the key-light split depends on three's lights_fragment_begin chunk text.
- ⚠️ [cars] Design gate passed (sheets /tmp/sr2/cars/GATE-contact-sheet-sundown.png, GATE-night-rear.png, ingame-race-pass2.png): dart (bubble cab, swan-neck wing, one big rocket), blade (wedge, pontoons, twin fins), brick (truck, bull bar, roof bar), manta (flat ray, horn pods, T-tail), pulse (bubble pod, frog eyes, antenna); 8 draws and 10-12k tris per car, race frame 106 calls. GO with notes: night light signatures tracing each silhouette, toy proportions on dart/pulse, rockets in the car's own glow colour, chunkier tyres, every paint reads, per-body bonnet camera anchor so the bonnet covers the physics box.
- ✅ [ui2] Round 1 (b521f35): hyper-1 D2 bank reachable from the title on a fresh profile (keyboard and pad proven), O1 one rebuild per slider sweep (was 20-21; worst frame 320 -> 252 ms, p99 89.8 -> 19.8 ms), O2 top speed shown with its angle on the HUD, Track Select and Results. Round 2 queued: trap sign label, reset clears the saved value, old nav id in docs. Rebuild cost itself (122-157 ms, 108 ms of it ground colliders) is track3's.
- [vehicle3] D4 root cause traced to two track collider defects, routed to track3 with gates: T1 road collider sawtooth at bank transitions (one non-planar quad per sample across 22 m: 0.109 m dips and 13 deg facets at bank 60), T2 ground tiles only 0.02-0.16 m under the banked road (soft CCD contacts through the road, 12-17 kN s kicks). vehicle3 mitigating on the car (soft CCD off with 3+ wheels down: must prove no barrier tunnelling at 200/320 km/h). track3 queue: loop frames, D3 inner barrier, T1, T2, O1 rebuild cost.
- ✅ [world2] Round 3 (7244cb7): steep ground triplanar grid, no sun-streak blot on near steep cuts, smoothed shading normals; Hyperdrome city as a full ring (arcDeg 360). world2 stopped at ~80% context; handoff /tmp/sr2/reports/world2-handoff.md.
- ✅ [Kai] Contracts (9eb8a95, 44137cf): setTrackParam takes null (reset forgets the saved value); CarAnchors.bonnet optional. Constitution section 7 amended (also the missed lastLapDirty/lastLapMs entry).
- [state 01:00] Live: play (D2 acceptance rerun), look2 (idle, 59%), cars (detail pass), track3 (loop frames, D3, T1, T2, O1), vehicle3 (D4 car side, D1, loop re-run later), ui2 (reset-null UI side). Checker: feel-2 (loops done with defects; wall rides running). Stopped: world2, vehicle2, ui. Next: hyper-2 after track3/vehicle3; visual-3 after cars/play; feel-2 findings to vehicle3; perf QUIET; clean clone; learn; 5203; final report.
- ✅ [ui2] Round 2 (838320e sign, a32860a reset): trap sign reads "BEST 225 AT 30°"; every reset path leaves no saved bank (trackParams {}) and rebuilds the live road at the file default. ui2 idle, kept for visual-3 UI findings.
- [track3] Round 1 drafted (not yet committed, in-game section pending): loop roll spread evenly (2.6 -> 0.82 deg/m), road and loop colliders as buildDriveSurface (no triangle > 1 deg off the road: also fixes vehicle3's T1), new `surface` gate with a suggested loop radius, BUILDER_VERSION 5. Rulings: Hyperdrome roll-in lane lean stays (reported); default loopRadius 12 -> 13 (Kai edits schema + README + CLAUDE.md gotcha with the commit); finer loop rows not now.
- ⚠️ [feel-2 interim] On ae3670f (before track3's colliders): L1 Afterglow loop at 200 km/h with throttle slides off on the descent 4/4; L2 hard hits through the loop top at 150-200 (one-step losses to 30 km/h, 33-85 km/h lost at 200); L3 magnet drops for a step at the top at 110-150; L4 a stalled car parks on the loop climb (auto-hold?); L5 camera pops and sits under the exit ribbon after a side fall; W1 steering into a wall climbs past vertical and drops 9-11 m; W2 throttle into the wall goes over the lip at 84 km/h. Routed to new worker vehicle4 (loops and walls), re-run on the new colliders first. vehicle3 keeps the Hyperdrome (D4, D1).
- [vehicle3] D1 re-seat done (parked 6/6, driving 12/12 bank changes clean); D4 holds at 60 on track3's in-progress drive surface (3 full-throttle laps: 0 rollovers, wipeouts, resets). carSim.ts/tuning.ts shared with vehicle4: each reports a patch of only its hunks (rule added to scratchpad/briefs/COMMON.md).
- ✅ [cars] Round 1 (a9ce80d): five Rocket League style bodies, 8 draws and 12.3-14.4k tris each, race frame 106 calls / 422k tris, demo perf pass (4.24 / 12.78 ms); physics box covered within 5-9 cm; per-body bonnet camera (only the bonnet hunk of CameraRig committed, staged via update-index); multiplayer clones keep the car shaders (Material.clone drops onBeforeCompile). Round 2 queued: ghost internal faces, pulse nose, low/medium presets, brick budget.
- ⬜ [ui2] Round 3: the garage frames every car from behind; make the car the hero (3/4 front or a turntable).
- ⚠️ [vehicle4] Mid-edit carSim.ts threw at runtime in the shared tree (stepWallSupport); told to keep the tree runnable; play told to check its acceptance build.
