# CLAUDE.md

Guidance for Claude Code sessions working in this repository.

## Overview

**Sundown Run Two** - a futuristic neon, synthwave-sundown 3D driving game for the browser, built for (and increasingly by) Josh, 12. Clean rebuild of `~/Dev/SundownRun` (v1, a reference only - never modify it). Vite + React 19 + TypeScript + @react-three/fiber v9 + drei + @react-three/rapier + @react-three/postprocessing + zustand, managed with Bun.

## Read first

- `CONSTITUTION.md` - the binding standard: art direction, the 60fps budget, the feel standard, the verification protocol, hard rules, and the list of frozen contracts. Disputes are settled against it.
- `TASKS.md` - the build checklist (what is done, verified, pending).
- `tracks/README.md` - the track file format. A new track is one file in `tracks/`.

## Running it

| What | Command |
|---|---|
| Play | `bun run dev` -> http://localhost:5201 |
| Typecheck / build | `bun run typecheck` / `bun run build` |
| Check every track file | `bun run tracks:check` |
| Headless probe (screenshots, perf) | `bun run probe -- --url "http://localhost:5201/?track=afterglow" --wait 6 --shot /tmp/a.png` |
| Physics proofs for a track | `bun run tracks:check tracks/<id>.json --physics` (`--bench` adds build timings) |
| Multiplayer host / relay alone | `bun run mp` / `bun run relay` |
| Two-client multiplayer proof / relay tests | `bun run mp:check` / `bun run test:relay` |
| Regenerate Josh's workshop | `bun run learn` -> `Learn To Code.html` (commit it) |

Ports: 5201 dev server, 5202 multiplayer relay, 5203 Nathan's stable copy (`vite preview` of the last good commit, built from a /tmp worktree), 5210-5219 build-worker scratch servers, 5220-5239 checker previews.

## Inspecting a running game

`src/core/devHandles.ts` is the contract. Every build, dev and production, exposes:

- `window.__game`: read-only getters (telemetry, cars, frame stats, `renderInfo()`, settings, `get('<inspector>')`, `inspectors()`).
- `window.__dev`: commands each system registers; `__dev.help()` lists them (teleport, camera bookmarks, finish a race, hide a look layer, and so on).
- `window.__perf`: the frame report from the last `?demo=1` recording. `window.__events`: recent game events.
- URL switches: `?track=`, `?mode=free|timetrial|race|stunt`, `?demo=1`, `?time=0..1`, `?quality=low|medium|high`, `?cam=<bookmark>`, `?ai=<n>`, `?nomusic=1`, `?mp=1&name=&color=`, `?editor=1`.

Checking a change: a production build (`bunx vite build`, then `bunx vite preview` on a 5220-5239 port) is what counts, not the dev server. Frame cost is measured as max(CPU, GPU) with a GPU timer query, over a `?demo=1` drive at the high preset; the budget table is in `CONSTITUTION.md` section 2. The GPU is shared with anything else probing, so measure perf with nothing else running.

## Changing things safely

- `src/core/config.ts` is Josh's knob file: the defaults, commented for a 12-year-old. A value he edits there beats the same value saved from the Settings menu. Keep new knobs in his language.
- The contracts (`CONSTITUTION.md` section 6) are frozen. Change one only by adding a dated amendment to section 7 in the same commit, and update every reader.
- A track is one file. If a change to the track builder (`src/track/build.ts`) moves geometry, bump `BUILDER_VERSION`: it feeds every track's key, so old ghosts and local records stop matching instead of replaying through moved road.
- One driving brain: the Ai racers and the demo autopilot both use `createAiDriver` in `src/play/aiDriver.ts`. Fix driving there, never in a second copy.
- Colours come from `src/core/palette.ts` and follow the colour semantics in `CONSTITUTION.md` section 1 (cyan player, magenta track, amber caution, mint boost, violet pickups). No pure primaries.
- `~/Dev/SundownRun` is v1: read it for proven solutions, never modify it.

## Architecture

Contracts in `src/core/` and `src/track/{schema,types,registry,current}.ts` are orchestrator-owned and frozen; systems talk only through them.

| Folder | System |
|---|---|
| `src/core/` | config (Josh's knobs), settings, store, telemetry + car registry, events, controls, palette, physics groups, perf, dev handles, records, cross-module api, session flow |
| `src/track/` | track file validation, the road ribbon + terrain builder, colliders, registry |
| `src/vehicle/` | input, raycast car physics, tricks, laps, ghost, car bodies, camera |
| `src/world/` | sky, sun, stars, planet, city, terrain look, lighting, billboards, stadium |
| `src/look/` | road surface and pieces, car fx, particles, post stack, quality presets |
| `src/audio/` | engine, effects, procedural synthwave music, mixer |
| `src/play/` | game modes, Ai racers, props, smashables, energy cores, speed traps |
| `src/ui/` | title, garage, settings, pause, HUD, results |
| `src/editor/` | the road editor and world map |
| `src/net/`, `server/` | LAN multiplayer client and relay |

## Gotchas

Inherited from v1 (each cost a rework there):

- Rapier heightfields are infinitely thin; fast falls tunnel through and CCD won't arm. Keep the catch floor and the below-ground auto-reset.
- Rapier's heightfield index order is column-major (`iz + ix * (n + 1)`); the terrain grid is row-major. The track builder converts; probe it after any change.
- `mergeGeometries` returns `null` silently on mixed indexed and non-indexed input. Check for null.
- Coplanar faces z-fight. Separate them geometrically, never with `polygonOffset`.
- Fogging far scenery to a solid colour makes a slab. Dissolve it by vertex alpha.
- Never drive a kinematic body through the declarative `<RigidBody>`; create it imperatively (`world.createRigidBody`).
- Every value entering rapier goes through the NaN firewall; one NaN poisons the WASM for good.
- A gamepad press isn't a browser gesture: a pad-only player never unlocks WebAudio unless the audio system polls for sticky user activation.
- Capture the arrow keys on menus so they don't leak into throttle (`src/core/controls.ts` input contexts).
- Vite HMR orphans Web Workers and AudioContexts unless `import.meta.hot.dispose()` shuts them down.
- Never `import` from `@dimforge/rapier3d-compat` directly: that resolves to a stray 0.12 copy pulled in by `@types/three`, while `@react-three/rapier` runs its own nested 0.19.2. Use `useRapier()` (`rapier` namespace and `world`) at runtime and derive types from it (`ReturnType<typeof useRapier>['world']`, `RapierRigidBody`, `RapierCollider` from `@react-three/rapier`).
- Rapier body and collider handles are 64-bit floats. Never store them in an Int32Array or Uint32Array: they truncate (often to 0), and a later remove or untag hits the wrong collider. Use Float64Array or a plain array.
- The road and loop colliders are `buildDriveSurface` (`src/track/ribbon.ts`), not the look mesh: two triangles a metre where the road is flat across, up to 12 strips where it twists. Two full-width triangles on a twisting road make a sawtooth (19.5 degrees on a loop top) that kicks the car. The `surface` gate checks the exact collider mesh.
- The physics ground has holes: triangles inside the road's slab or a stadium barrier's box are left out (`src/track/terrainTiles.ts`, `groundCovered`), so a ray down through the road finds no ground there. Use `groundHoleAt(t, x, z)` before expecting a terrain hit.
- Hard CCD (`ccd` on a RigidBody) on rapier 0.19.2 halves a body's travel while it slides in contact with a trimesh, and can stop it dead. Car bodies use `softCcdPrediction` instead.
- r3f v9 on three 0.186 logs a `THREE.Clock` deprecation warning from inside the library; it is not ours.
- The road material (`src/look/road/roadMaterial.ts`) splits the key light's highlight from the headlights' by matching the text of three's `lights_fragment_begin` shader chunk. After a three.js upgrade, check the console: if the chunk changed, it logs an error and falls back to scaling every highlight together (the night road streak gets hot again).
