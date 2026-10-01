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

Ports: 5201 dev server, 5202 multiplayer relay, 5210-5219 build-worker scratch servers, 5220-5239 checker previews.

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
- r3f v9 on three 0.186 logs a `THREE.Clock` deprecation warning from inside the library; it is not ours.
