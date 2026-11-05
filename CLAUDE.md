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
| Online copy (Cloudflare Worker + Durable Object relay), locally | `bun run cloud:dev` -> https://127.0.0.1:5211 (self-signed); setup and deploy: `cloud/README.md` |
| Online track library: one-time import of the GitHub shared tracks (lead, after deploy) | `bun scripts/library-import.ts --map "JJ=<email>,DAD=<email>" --token "$(cloudflared access token -app=https://sundown.nathans-lab.fyi)" --dry-run` (`cloud/README.md`) |
| Online checks | `bun run test:cloud`; with cloud:dev up, `bun run mp:check --cloud https://127.0.0.1:5211 --only client,game` |
| Deploy the online copy (Nathan, after `bunx wrangler login`) | `bun run cloud:deploy` |
| Phone controls proof (real touch events, needs a preview running) | `bun run touch:check 5220` |
| Phone gate: every screen and HUD state at the phone windows, and the Road Editor's with `--only editor` (`--port`, `--window pwa\|safari\|small`, `--only <step>`, `--out`, `--list`) | `bun run phone:check -- --port 5220` (`scripts/phone-gate.ts`; the standard is `spec/phone-landscape-standard.md`) |
| Road Editor's map with real fingers: arm, pinch, two-finger drag, twist, cancels, the tool button and its tray, a real mouse at 1920x1080 (`--window pwa\|safari`, `--only 1,2`, `--out`; needs a preview running) | `bun run editor:touch -- --port 5220` (`scripts/editor-touch-check.ts`) |
| Real Mobile Safari on the iPhone 17 Pro simulator (rotate, shot, tap, drag, pinch, sweep; one script at a time) | `bash scripts/ios-sim/shot.sh "http://localhost:5220/?nomusic=1" /tmp/a.png` (`scripts/ios-sim/README.md`) |
| Regenerate the Home Screen icons from `public/icons/icon.svg` | `bun run icons` |
| Regenerate Josh's workshop | `bun run learn` -> `Learn To Code.html` (commit it) |

Ports: 5201 dev server, 5202 multiplayer relay, 5203 Nathan's stable copy (`vite preview` of the last good commit, built from a /tmp worktree), 5210-5219 build-worker scratch servers (`cloud:dev` uses 5211), 5220-5239 checker previews.

## Inspecting a running game

`src/core/devHandles.ts` is the contract. Every build, dev and production, exposes:

- `window.__game`: read-only getters (telemetry, cars, frame stats, `renderInfo()`, settings, `get('<inspector>')`, `inspectors()`).
- `window.__dev`: commands each system registers; `__dev.help()` lists them (teleport, camera bookmarks, finish a race, hide a look layer, and so on).
- `window.__perf`: the frame report from the last `?demo=1` recording. `window.__events`: recent game events.
- URL switches: `?track=`, `?mode=free|timetrial|race|stunt|tag|turns`, `?tagSeconds=` / `?turnSeconds=` (shorter tag rounds and Hunt Turns turns for checks, read by whoever presses G), `?demo=1`, `?time=0..1`, `?quality=low|medium|high`, `?cam=<bookmark>`, `?ai=<n>`, `?nomusic=1`, `?mp=1&name=&color=` (the relay is `ws://<host>:5202` on LAN; an https page, the online copy, uses `wss://<host>/relay`; `?relay=<port>` overrides either), `?editor=1`, `?engine=muscle|rally|hover`, `?motor=nodes`, `?touch=1` (boot on the phone controls; a mouse can drive them), `?nancheck=1` (on-screen broken-pixel counts), `?hide=<layer>,<layer>`.
- `/api/report` on the dev and preview servers (`server/issues.ts`, the Report a problem screen's post office): `GET` says whether a GitHub key is set up, the version and commit, and how many reports wait in `reports/pending/`; `POST` files one. `__dev.ui('report')` opens the screen. Test only against a fake GitHub (`SR2_ISSUES_API=http://127.0.0.1:<port>`, plus `SR2_REPORTS_DIR` to keep saved reports out of the folder); never the real repository, which is public.
- `/api/library` (online copy only, `cloud/libraryApi.ts`): the online track library. Every drawn track saves itself there under the player's Cloudflare Access login, and the Library's Everyone's tracks lists every player's. `__dev.library('help')` lists checker commands (sync, status, list, state). Who you are is the Access JWT (`cloud/access.ts`), never a bare header; local tests sign their own tokens against a pretend team (`ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` in `cloud/.dev.vars`) or use `SR2_DEV_PLAYER` with `ACCESS_AUD` empty. The game at home never calls it.
- `/api/tracks` on the same servers (`server/trackShare.ts`): the editor Library's Share and Shared tracks. `GET` lists `track`-labelled issues, `POST` shares one. `__dev.share('help')` lists checker commands (list, download, can, share, mine). One brain for both the home server and the online Worker (`cloud/worker.ts`); change sharing in `server/trackShare.ts`. Test only against the fake GitHub (`bun run test:share`, or `bun server/fakeGithub.ts --port <p> --token <fake-key>[:nopush]` with `SR2_ISSUES_API` and `SR2_REPORTS_DIR` as for reports, from an export with no `github-token.txt`); never the real repository.

Checking a change: a production build (`bunx vite build`, then `bunx vite preview` on a 5220-5239 port) is what counts, not the dev server. Frame cost is measured as max(CPU, GPU) with a GPU timer query, over a `?demo=1` drive at the high preset; the budget table is in `CONSTITUTION.md` section 2. The GPU is shared with anything else probing, so measure perf with nothing else running.

## Changing things safely

- `src/core/config.ts` is Josh's knob file: the defaults, commented for a 12-year-old. A value he edits there beats the same value saved from the Settings menu. Keep new knobs in his language.
- The contracts (`CONSTITUTION.md` section 6) are frozen. Change one only by adding a dated amendment to section 7 in the same commit, and update every reader.
- A track is one file. If a change to the track builder (`src/track/build.ts`) moves geometry, bump `BUILDER_VERSION`: it feeds every track's key, so old ghosts and local records stop matching instead of replaying through moved road. A change that only moves tunnels (how they are dug, their ramps) bumps `TUNNEL_BUILDER_VERSION` instead, which only tracks with a Tunnel piece carry in their key, so the built-in tracks' ghosts and records survive it. Likewise a change that only moves the ground round bridges bumps `BRIDGE_BUILDER_VERSION`, carried only by tracks whose built road has a raised stretch (of the built-ins, only Afterglow).
- One relay brain: `server/relayCore.ts` decides everything the relay does, for both the LAN relay (`server/relay.ts`) and the online room (`cloud/room.ts`). Change relay behaviour there, never in either socket shell; `cloud/relay.remote.test.ts` runs the same checks against both.
- One library brain: `cloud/libraryStore.ts` decides what the online track library allows (unique ids across players, owner-only changes, versions, caps), on any SQL connection; `cloud/library.ts` only hands it the Durable Object's database. The browser side is `src/editor/library/sync.ts`, switched on by `isOnlinePage` (`src/net/protocol.ts`), the same switch as the relay. `cloud/library.test.ts` runs the rules on bun:sqlite and checks the Access token rules.
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
| `src/ui/` | title, garage, settings, pause, HUD, results, report a problem; `TouchControls.tsx` and `phone/` are the phone's on-screen controls and layout (`spec/phone-landscape-standard.md`) |
| `src/editor/` | the road editor and world map; `mapGestures.ts` stands in front of the map's pointer handlers (one finger is the tool, two are always the map); `src/editor/phone/` is its layout on a phone (layout C, One tool button: the same parts as the rail and panel in a new home, `spec/phone-editor/`); `src/editor/library/` is the online track library's browser side (online copy only) |
| `src/net/`, `server/` | multiplayer client and LAN relay (`server/relayCore.ts` is the relay's one brain, shared with the online room); `server/issues.ts` posts reports as GitHub issues; `server/trackShare.ts` is the track-sharing brain (no web server in it), shared by `server/trackShareNode.ts` here and the online Worker |
| `cloud/` | the online copy: Cloudflare Worker serving `dist/`, the relay room as a Durable Object, and the track library (`library.ts`, a second SQLite Durable Object, behind the Access login checked in `access.ts`) that replaces Share / Shared tracks online (`cloud/README.md`); Report a problem stays home-only |

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
- At a bridge lift-off the ground under the deck's last 10 m hides 0.6 m down (`BRIDGE_JOIN_FLAT`) except the outermost 0.5 m (`BRIDGE_JOIN_LIP`): hidden right to the edge, the cells straddling it sag outside it (`lowedge`); kept from 1 m in, a cell reaches steeply under the middle (`under`).
- The `bridges` gate measures clearance over every lane (`crossingClearance()`), not between the middles: a banked open road's high edge sits width x sin(bank) above its low edge. The editor's Fix it and `keepBridgesClear` use the same measure.
- The road and loop colliders are `buildDriveSurface` (`src/track/ribbon.ts`), not the look mesh: two triangles a metre where the road is flat across, up to 12 strips where it twists. Two full-width triangles on a twisting road make a sawtooth (19.5 degrees on a loop top) that kicks the car. The `surface` gate checks the exact collider mesh.
- The physics ground has holes: triangles inside the road's slab or a stadium barrier's box are left out (`src/track/terrainTiles.ts`, `groundCovered`), so a ray down through the road finds no ground there. Use `groundHoleAt(t, x, z)` before expecting a terrain hit.
- A bank roll's crest along a lane is lane offset x roll acceleration x speed^2 along the road's up (exactly, whatever the bank), not the edge height's vertical curve. `src/track/bankRolls.ts` re-lays any roll too quick for 250 km/h as an S in asinh(tan bank), grown into the straight only while it leans at most 15 degrees ahead of its bend (a roll grown purely into the straight leaned 54 degrees on dead-straight road at bank 60, and the demo driver slid into the inner barrier). The `crest` and `banking` gates check both.
- The car's soft CCD looks a whole step ahead (1.4 m at 300 km/h), so a feature that ends ahead of a car sliding past it becomes a wall across the road: the end of the next box in a chain, or the tip of a long thin triangle. Static walls a car slides along must be one continuous triangle mesh (FIX_INTERNAL_EDGES) cut into roughly car-sized triangles, never a chain of boxes or full-height slivers (`src/track/colliders.ts` addBarrierSolids; `tracks:check --physics` case 10 slides a car body along every barrier).
- Hard CCD (`ccd` on a RigidBody) on rapier 0.19.2 halves a body's travel while it slides in contact with a trimesh, and can stop it dead. Car bodies use `softCcdPrediction` instead.
- r3f v9 on three 0.186 logs a `THREE.Clock` deprecation warning from inside the library; it is not ours.
- Shader maths that is fine on the Mac can break on Windows (ANGLE Direct3D11), and Metal's compiler hides it, so a NaN test needs its NaN fed in through a uniform. `pow()` of a negative base is NaN (square with `x * x`, clamp other bases); `normalize()` of a zero vector is NaN (`sr2SafeNormalize`); `min(NaN, cap)` returns the cap, so never cap HDR light with a bare `min()` (use `sr2SafeLight`, `src/look/road/glsl.ts`); derivatives (`fwidth`, `dFdx`, implicit-LOD `texture`) only in uniform control flow, because ANGLE's D3D11 path really branches; D3D11 writes an overflow into a half-float target as 65504, not Infinity, so guards test >= 65504. `?nancheck=1` counts broken pixels on screen.
- `AudioWorklet` only exists on secure pages (https or localhost). LAN multiplayer guests load the game over plain `http://<ip>:5201`, so the engine's firing-pulse worklet (`src/audio/motorDsp.ts`) can't run for them; they get the node-built copy of the same voicing (`src/audio/motorNodes.ts`). Test it with `?motor=nodes`.
- A rapier collider handle is only a number, counted from 0 in every new World. Anything keyed by handle (surface tags, the tunnel list) must be forgotten when its collider goes (`removeColliderSet` / `forgetCollider`), or a later world's colliders inherit the tags. The physics self-test checks a clean exit and re-checks the first track of a batch.
- At a bridge's foot the ground under the road eases deeper over the last 8 m (`terrain.ts` `BRIDGE_FOOT_*`): ground climbing to just under the outer lanes along the road within one grid cell is a wall to a car's soft CCD. The physics check slides boxes along the outer lanes over every bridge foot.
- A search whose answer gets placed (the editor's tunnel fit) must never stop on a timer: a slow PC gets a different answer. Cap it by a count and make each step cheap (`road.ts` `tunnelPlanner`).
- `buildTrack(..., previous)` reuses the previous racing line only when `racingLineKey` matches (plan view and the line's bounds); any new reuse must keep a build a pure function of the file and params.
- The road material (`src/look/road/roadMaterial.ts`) splits the key light's highlight from the headlights' by matching the text of three's `lights_fragment_begin` shader chunk. After a three.js upgrade, check the console: if the chunk changed, it logs an error and falls back to scaling every highlight together (the night road streak gets hot again).
- A touch finger must let go through every exit: `pointerup`, `pointercancel`, `touchend` with no touches left, window blur and a hidden page all release in `src/ui/TouchControls.tsx`, and unmounting clears `touchInput`, or a lost lift leaves the gas stuck on.
- The online copy sits behind Cloudflare Access, so the Home Screen icon is inlined in `index.html` as a data: URI at build (`vite.config.ts`, `inlineTouchIcon`) and the manifest link carries `crossorigin="use-credentials"`. iOS's Add to Home Screen can't fetch a file behind a login and shows a letter tile. There is deliberately no service worker: Workers serve `index.html` for revalidation, so a deploy reaches an installed copy on its next open, and a cached shell behind Access is how a lapsed login bricks a PWA.
- A Safari tab on an iPhone 17 Pro on its side is 874x292 while `100vh` is 402, so phone CSS uses `dvh` or px, never `vh` or `vmin`; the phone gate's `safari` window rewrites those units to Safari's values to catch it.
- `frameAt` (`src/editor/road.ts`) throws on a road with no points, and the Checks list runs inside a React render with no error boundary, so one call there blanks the whole editor. Warnings outlive their road: New track empties the map before the checks run again. Guard with `rc.curve.length` (`bun run editor:touch -- --only 12`).
- A finger's grab distances (`TOUCH_REACH`) are for grabbing. Used as a test of "on a point" they refuse a double tap everywhere once points show a few pixels apart: `Overlay.tsx` `onDouble` tests a finger in metres.
- A spot on the road's last stretch can be exactly the number of points (the nearest spot to the first point, or 86.996 rounded). `draftFile.ts` writes it as 0: the validator would call it an error.
- Chrome sends no `click` for a second finger (not tried in Safari): a button the other thumb presses while one finger is on the map acts on `onPointerDown` (`src/editor/phone/PhoneEditor.tsx` Cancel). A check that taps it with one finger can't see this.
- `.sre :where(button, input, select)` sets `color: inherit` with one class's weight, so a stylesheet of the editor's that loads before `editor.css` loses every button colour to it. `phone.css` loads after it because of the order of the imports in `EditorUi.tsx`.
- A WebGL context can go at any moment and come back later, and on a lost one `getContextAttributes()`, `getParameter()` and friends answer null, so `new EffectComposer(gl)` or `new PMREMGenerator(gl).compile...` in a memo throws and React takes the whole page down. Anything built from the context takes `useGlLife` `generation` as a dep and asks `gl.getContext().isContextLost()` first (not a flag from the event, which comes a moment after the loss), and anything drawn into a render target is built again when it comes back (`src/core/glLife.ts`; `bun run editor:touch -- --only 24`). `CrashGuard.tsx` is the last line: no blank page, one Reload button.
- For its first moments after loading, Safari on an iPhone on its side says `innerWidth` is 750, then 874, with no `resize` event (the notch's room settling). Anything sized from it at load must watch an element too (`Overlay.tsx` `sizeWatch`), or the map's marks sit 62 px off the picture under them.
- `server.fs.deny` in `vite.config.ts` is what stops `bun run mp` serving the GitHub key and the waiting reports to the whole wifi (`bun run dev:check` proves it). Giving `deny` replaces Vite's own list, and a pattern with a "/" is matched against the whole absolute path, so a new secret goes on that list and a folder is spelled out from `import.meta.url`. `vite preview` serves only `dist/`.
- `bun test <file>` matches that file name anywhere in the tree, gitignored folders included, so a stale copy of a test under `data/` makes a check red on one computer only.
