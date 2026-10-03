# CLAUDE.md

Guidance for Claude Code sessions working in this repository.

## Overview

**Sundown Run II** - a futuristic neon, synthwave-sundown 3D driving game for the browser, built for (and increasingly by) Josh, 12. Clean rebuild of `~/Dev/SundownRun` (v1, a reference only - never modify it). Vite + React 19 + TypeScript + @react-three/fiber v9 + drei + @react-three/rapier + @react-three/postprocessing + zustand, managed with Bun.

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
- URL switches: `?track=`, `?mode=free|timetrial|race|stunt`, `?demo=1`, `?time=0..1`, `?quality=low|medium|high`, `?cam=<bookmark>`, `?ai=<n>`, `?nomusic=1`, `?mp=1&name=&color=`, `?editor=1`, `?engine=muscle|rally|hover`, `?motor=nodes`, `?nancheck=1` (on-screen broken-pixel counts), `?hide=<layer>,<layer>`.
- `/api/report` on the dev and preview servers (`server/issues.ts`, the Report a problem screen's post office): `GET` says whether a GitHub key is set up, the version and commit, and how many reports wait in `reports/pending/`; `POST` files one. `__dev.ui('report')` opens the screen. Test only against a fake GitHub (`SR2_ISSUES_API=http://127.0.0.1:<port>`, plus `SR2_REPORTS_DIR` to keep saved reports out of the folder); never the real repository, which is public.

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
| `src/ui/` | title, garage, settings, pause, HUD, results, report a problem |
| `src/editor/` | the road editor and world map |
| `src/net/`, `server/` | LAN multiplayer client and relay; `server/issues.ts` posts reports as GitHub issues |

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
- An open road banks about its low edge (walled roads about the middle): `samples.py` is the middle, lifted by about half the width x sin bank (`trackInternals(t).pivotLift`). Where the road would sit unbanked (the points' heights, the editor's `roadHeightAt`) is `py - pivotLift`; compare editor heights with that, and look a banked road up with `nearest()` from its own height. Under an open road the ground must still rise to just under the HIGH edge's lip, or the cells straddling the edge leave a notch outside it that drops a wheel (`lowedge` gate; `/tmp/sr2/track6/notch.ts`).
- A road point's ground height (`averagedHeight`, `src/track/terrain.ts`) must stay a function of the point's own position and the track's `surfaceSmoothing` only: the editor's tools (`newPointHeight`, swaps, the Height tool) rely on that to keep every point's height exact. A smoothing that reads neighbouring points would move the road outside every edited stretch and break the bridge gap at crossings.
- The road and loop colliders are `buildDriveSurface` (`src/track/ribbon.ts`), not the look mesh: two triangles a metre where the road is flat across, up to 12 strips where it twists. Two full-width triangles on a twisting road make a sawtooth (19.5 degrees on a loop top) that kicks the car. The `surface` gate checks the exact collider mesh.
- The physics ground has holes: triangles inside the road's slab or a stadium barrier's box are left out (`src/track/terrainTiles.ts`, `groundCovered`), so a ray down through the road finds no ground there. Use `groundHoleAt(t, x, z)` before expecting a terrain hit.
- A bank roll's crest along a lane is lane offset x roll acceleration x speed^2 along the road's up (exactly, whatever the bank), not the edge height's vertical curve. `src/track/bankRolls.ts` re-lays any roll too quick for 250 km/h as an S in asinh(tan bank), grown into the straight only while it leans at most 15 degrees ahead of its bend (a roll grown purely into the straight leaned 54 degrees on dead-straight road at bank 60, and the demo driver slid into the inner barrier). The `crest` and `banking` gates check both.
- The car's soft CCD looks a whole step ahead (1.4 m at 300 km/h), so a feature that ends ahead of a car sliding past it becomes a wall across the road: the end of the next box in a chain, or the tip of a long thin triangle. Static walls a car slides along must be one continuous triangle mesh (FIX_INTERNAL_EDGES) cut into roughly car-sized triangles, never a chain of boxes or full-height slivers (`src/track/colliders.ts` addBarrierSolids; `tracks:check --physics` case 10 slides a car body along every barrier).
- Hard CCD (`ccd` on a RigidBody) on rapier 0.19.2 halves a body's travel while it slides in contact with a trimesh, and can stop it dead. Car bodies use `softCcdPrediction` instead.
- r3f v9 on three 0.186 logs a `THREE.Clock` deprecation warning from inside the library; it is not ours.
- Shader maths that is fine on the Mac can break on Windows (ANGLE Direct3D11), and Metal's compiler hides it, so a NaN test needs its NaN fed in through a uniform. `pow()` of a negative base is NaN (square with `x * x`, clamp other bases); `normalize()` of a zero vector is NaN (`sr2SafeNormalize`); `min(NaN, cap)` returns the cap, so never cap HDR light with a bare `min()` (use `sr2SafeLight`, `src/look/road/glsl.ts`); derivatives (`fwidth`, `dFdx`, implicit-LOD `texture`) only in uniform control flow, because ANGLE's D3D11 path really branches; D3D11 writes an overflow into a half-float target as 65504, not Infinity, so guards test >= 65504. `?nancheck=1` counts broken pixels on screen.
- `AudioWorklet` only exists on secure pages (https or localhost). LAN multiplayer guests load the game over plain `http://<ip>:5201`, so the engine's firing-pulse worklet (`src/audio/motorDsp.ts`) can't run for them; they get the node-built copy of the same voicing (`src/audio/motorNodes.ts`). Test it with `?motor=nodes`.
- The road material (`src/look/road/roadMaterial.ts`) splits the key light's highlight from the headlights' by matching the text of three's `lights_fragment_begin` shader chunk. After a three.js upgrade, check the console: if the chunk changed, it logs an error and falls back to scaling every highlight together (the night road streak gets hot again).
