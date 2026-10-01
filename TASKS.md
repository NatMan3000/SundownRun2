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
- ⬜ validateTrack: errors, warnings, defaults
- ⬜ buildTrack: centreline spline, 1 m samples, frames, auto-bank + overrides, widths, heights (terrain-follow + lift + absolute y)
- ⬜ Loops (corkscrew offset, magnetic surface) and wall rides (quarter/half pipe)
- ⬜ Ramps, boost zones, speed traps, props, cores, roadside placement
- ⬜ Terrain recipe: hills, flat, features (hill, bowl, mesa, bigAir), road flattening, ridge/wall edge
- ⬜ Derived: checkpoints, racing line + target speeds, grid slots, minimap, hash/key
- ⬜ Colliders: road slab trimesh, magnetic surfaces tagged, barriers, ramps, terrain heightfield (index order probed), catch floor, boundary, auto-reset hook
- ⬜ Live param rebuild (bankDeg) without moving the car, fast enough for a slider
- ⬜ tracks/afterglow.json (fun track), tracks/hyperdrome.json
- ⬜ tracks/README.md documents the format completely
- ⬜ bun run tracks:check validates every file in tracks/

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
- ⬜ Frame rate on Josh's laptop (RTX 4060, 165 Hz)

## Found along the way

(Defects caught by checks and playtests, with owner and status.)
- ⬜ [track] Hyperdrome bank flips sign across the s=0 seam (-27.5 deg at s=2269 to +22 deg at s=10); grid slot 0 sits on an 18 deg roll and a parked car rolls backwards (vehicle, live probe). Fix the seam wrap and put the line/grid on the flat straight.
- ⬜ [world] Art: near grid as bright as the road edges; ridge reads as a red-lit wall; sun stripes hairline (orchestrator frame /tmp/sr2/main/a1.png).
- ⬜ [look] Art: thick lavender centre stripe behind the car (trail or lane line?) reads as a road marking.
- ✅ [all] Two rapier copies: top-level 0.12 from @types/three vs @react-three/rapier's nested 0.19.2. Rule: never import @dimforge/rapier3d-compat directly (CLAUDE.md gotcha).
- ✅ [track/world] Ruling: sunset notch in the edge ridge (sun azimuth +/- 40 deg at ~30% rise), city at ~1.6 x world size.
- ✅ [look] Ruling: Neutral tone mapping (ACES washed the sun gradient; world's A/B screenshots).
- ✅ [audio] Ruling: audio owns the countdown beeps (from race.countdown).
- ⬜ [track] Road and skirt triangles wound clockwise (ribbon.ts quad() normal = e2 x e1): road top culled from above, skirt underside shows (look). Also explains editor's "terrain covers road" from top-down.
- ⬜ [track] Afterglow loop entrance is a solid wall at s 3216: cars stop dead; five Ai + demo piled up 4+ min (play). Needs a drive-through physics test.
- ⬜ [track] Afterglow redesign (orchestrator, game director): rounded rectangle with long straights and an empty middle; wants a flowing layout through the world, 40-60 m elevation, big-air hill by the road, loop toward the sun, wall ride on a sweeper, a crossover bridge.
- ⬜ [vehicle] First d-pad press after a pad connects fires the menu action twice (ui).
- ⬜ [look] Live switch to Neutral tone mapping renders black (world).
- ⬜ [vehicle] Car art: faceted low-poly look and dull red-magenta paint; wants smooth normals + clearcoat. Showroom camera must frame the car in the right half (menus cover the left).
- ✅ [contract] Planet default elevation 16 deg (was 28: off-frame at night). TrackParamInfo.default added. ResolvedTrackFile.laps typed number | null. Skirt uv semantics. Physics updatePriority -50.
