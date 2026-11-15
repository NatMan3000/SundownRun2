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
| Deploy the online copy (after `bunx wrangler login`). Standing yes (Nathan, D7, 3 Nov 2026): once a change has passed its checks and been committed and pushed, run it without asking, then tell him it is live. It covers game and Worker code only: Cloudflare Access apps or policies, the custom domain, workers.dev or preview URLs, and Worker secrets still need his yes first | `bun run cloud:deploy` |
| Regenerate Josh's workshop | `bun run learn` -> `Learn To Code.html` (commit it) |

More commands (multiplayer, online copy and library import, phone gates, the iOS simulator, icons): `docs/commands.md`. The iOS simulator never gates a deploy: Chrome at the phone windows plus the diff read is enough (Nathan, 5 Nov 2026).

Ports: `~/Dev/.claude/rules/reserved-ports.md` (this project: 5201 to 5203, build-worker servers 5210-5219, checker previews 5220-5239).

## Inspecting a running game

`src/core/devHandles.ts` is the contract: every build, dev and production, exposes `window.__game`, `window.__dev` (`__dev.help()` lists its commands), `window.__perf`, `window.__events` and the URL switches (`?track=`, `?mode=`, `?demo=1` and the rest). The full list, with the report, library and share endpoints, is in `docs/dev-handles.md`. Test the report and share endpoints only against a fake GitHub (`SR2_ISSUES_API`, `bun run test:share`), never the real public repository.

Checking a change: a production build (`bunx vite build`, then `bunx vite preview` on a 5220-5239 port) is what counts, not the dev server. Frame cost is measured as max(CPU, GPU) with a GPU timer query, over a `?demo=1` drive at the high preset; the budget table is in `CONSTITUTION.md` section 2. The GPU is shared with anything else probing, so measure perf with nothing else running.

## Changing things safely

- `src/core/config.ts` is Josh's knob file: the defaults, commented for a 12-year-old. A value he edits there beats the same value saved from the Settings menu. Keep new knobs in his language.
- The contracts (`CONSTITUTION.md` section 6) are frozen. Change one only by adding a dated amendment to section 7 in the same commit, and update every reader.
- A track is one file. If a change to the track builder (`src/track/build.ts`) moves geometry, bump `BUILDER_VERSION`: it feeds every track's key, so old ghosts and local records stop matching instead of replaying through moved road. A change that only moves tunnels (how they are dug, their ramps) bumps `TUNNEL_BUILDER_VERSION` instead, which only tracks with a Tunnel piece carry in their key, so the built-in tracks' ghosts and records survive it. Likewise a change that only moves the ground round bridges bumps `BRIDGE_BUILDER_VERSION`, carried only by tracks whose built road has a raised stretch (of the built-ins, only Afterglow).
- One relay brain: `server/relayCore.ts` decides everything the relay does, for both the LAN relay (`server/relay.ts`) and the online room (`cloud/room.ts`). Change relay behaviour there, never in either socket shell; `cloud/relay.remote.test.ts` runs the same checks against both.
- One library brain: `cloud/libraryStore.ts` decides what the online track library allows (unique ids across players, owner-only changes, versions, caps), on any SQL connection; `cloud/library.ts` only hands it the Durable Object's database. The browser side is `src/editor/library/sync.ts`, switched on by `isOnlinePage` (`src/net/protocol.ts`), the same switch as the relay. `cloud/library.test.ts` runs the rules on bun:sqlite and checks the Access token rules.
- One driving brain: the Ai racers and the demo autopilot both use `createAiDriver` in `src/play/aiDriver.ts`. Fix driving there, never in a second copy.
- Colours come from `src/core/palette.ts` and follow the colour semantics in `CONSTITUTION.md` section 1 (cyan player, magenta track, amber caution, mint boost, violet pickups). No pure primaries.

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
| `src/ui/` | title, garage, settings, pause, HUD, results, report a problem; `TouchControls.tsx` and `phone/` are the phone's on-screen controls and layout (`spec/phone-landscape-standard.md`) |
| `src/editor/` | the road editor and world map; `mapGestures.ts` stands in front of the map's pointer handlers (one finger is the tool, two are always the map); `src/editor/phone/` is its layout on a phone (layout C, One tool button: the same parts as the rail and panel in a new home, `spec/phone-editor/`); `src/editor/library/` is the online track library's browser side (online copy only) |
| `src/net/`, `server/` | multiplayer client and LAN relay (`server/relayCore.ts` is the relay's one brain, shared with the online room); `server/issues.ts` posts reports as GitHub issues; `server/trackShare.ts` is the track-sharing brain (no web server in it), shared by `server/trackShareNode.ts` here and the online Worker |
| `cloud/` | the online copy: Cloudflare Worker serving `dist/`, the relay room as a Durable Object, and the track library (`library.ts`, a second SQLite Durable Object, behind the Access login checked in `access.ts`) that replaces Share / Shared tracks online (`cloud/README.md`); Report a problem stays home-only |

## Gotchas

Track, editor, look and server gotchas load from `.claude/rules/sr2-track-editor-gotchas.md` when you touch those files; read it before work there.

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
- `server.fs.deny` in `vite.config.ts` is what stops `bun run mp` serving the GitHub key and the waiting reports to the whole wifi (`bun run dev:check` proves it). Giving `deny` replaces Vite's own list, and a pattern with a "/" is matched against the whole absolute path, so a new secret goes on that list and a folder is spelled out from `import.meta.url`. `vite preview` serves only `dist/`.
- `bun test <file>` matches that file name anywhere in the tree, gitignored folders included, so a stale copy of a test under `data/` makes a check red on one computer only.
