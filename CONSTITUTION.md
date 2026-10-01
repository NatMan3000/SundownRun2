# Sundown Run Two - Constitution

The one standard every worker and checker judges against. Disputes are settled against this document, never against taste in the moment or a worker's report. Changes are deliberate, dated in section 7 and committed by the orchestrator; never drive-by.

## 1. Art direction - "Neon Sundown"

A synthwave sundown that turns into night. A giant striped sun sinks into a magenta-to-violet sky; stars, a ringed planet and a lit megacity come out as it goes. The ground is dark glass with a glowing grid; the road is wet, reflective and outlined in light. One cohesive look, committed fully.

**Reference class:** the best three.js / react-three-fiber showcase work, the award-site demos people share. If a screenshot would not make a stranger stop scrolling, it is not done.

**Palette.** Every colour in code comes from `src/core/palette.ts`. No other hex literals in scene code (UI CSS reads the same tokens).

| Role | Colour | Notes |
|---|---|---|
| Sky, sundown | zenith `#1b0b3a`, mid `#5b1670`, horizon `#ff3d7f`, sun glow `#ff8a3d` | warm only near the sun; anti-sun side stays violet |
| Sky, night | zenith `#04020c`, mid `#120726`, horizon `#3a0f52` | city glow lifts the horizon |
| Sun | `#ffe66b` -> `#ff9a3c` -> `#ff2e7e`, top to bottom | horizontal cut bands that widen toward the bottom |
| Stars, planet | stars `#e6ebff`; planet `#4a3a8a`, ring `#a99bff` | fade in from timeOfDay 0.3 |
| City | silhouette `#0a0618`, windows `#ffb35c` and `#62e6ff` | windows switch on one by one as night falls |
| Ground | glass `#07050e`, sheen `#1a1030`, grid `#6b4dff` | the grid is dim (T0-T1) and fades with distance |
| Road | wet base `#0a0a12`, edge strips: track accent (default `#ff2bd6`), lane lines `#c4f7ff`, chevrons `#ffb000` | the road is the brightest line structure in the world |
| Pieces | boost `#3dffb0`, loops `#19e3ff`, wall rides `#b14dff`, ramps `#ffb000` | |
| Pickups and props | energy cores `#c77dff` with a white-hot centre; crates `#ff2bd6`; energy cubes `#19e3ff` | |
| Player car | paint `#1b1f3b`, livery, underglow and trail `#19e3ff` | changeable in the garage |
| Ai racers | `#ff5d3d`, `#ffd23f`, `#3dffb0`, `#ff2bd6`, `#8f7bff` | one each, never the player's colour |

**Colour semantics:** cyan is the player and guidance, magenta is the track, amber is caution (chevrons, ramp lips, speed trap), mint is boost, violet is pickups and magnetic surfaces. No pure primaries (`#ff0000`, `#00ff00`, `#0000ff`, `#ff00ff`, `#00ffff`).

**Glow is budgeted, not a slider.** Bloom only picks up HDR emissive above luminance 1.0. Every emissive surface declares a tier from `GLOW` in `palette.ts`:

| Tier | Intensity | Allowed on |
|---|---|---|
| T0 | below 1 (no bloom) | ground grid beyond 60 m, city silhouettes, planet, billboard bodies, stadium structure |
| T1 | 1-2 (soft halo) | near grid, lane lines, city windows, billboard images, roadside posts, stars |
| T2 | 2-5 (hero) | road edge strips, chevron peaks, the car's livery, underglow, lights and trail, boost pads, loop rings, energy cores, the sun |
| T3 | up to 10, under 0.5 s | impacts, shard bursts, boost kick, pickups |

The brightest thing on screen is always the road, the car or the sun. If a background element out-glows the road, it is wrong.

**Light and depth.**
- Three readable depth planes in every gameplay frame: near (road, car, roadside), mid (terrain forms, billboards, props), far (skyline, ridges, sun, planet).
- Haze is height and distance fog tinted from the horizon colour. Far geometry dissolves into the sky by vertex alpha; it never fogs to a flat slab with a hard top edge.
- The sun's direction is always obvious: its glow on the horizon, warm rim light on terrain and car from the sun side at sundown, and its reflection streak in the wet road.
- Nothing is an unlit black void: every dark surface still shows form through rim light, reflection, sheen or grid.
- Time of day runs 0 (sundown: the sun's lower half on the horizon) to 1 (full night). Headlights fade in from 0.35 and cast real light on the road at night. City windows come on from 0.2 to 0.9; stars and the planet fade in from 0.3.

**Fails on sight:** flat purple gradients everywhere; glow on everything so nothing reads; untextured monotone ground; default three.js lighting or materials; `MeshBasicMaterial` on a surface that should be lit; pure primaries; anything that pops, snaps or judders; decorative gates, arches or gantries over the road.

**UI** speaks the same language: dark glass panels, thin neon rules, cyan and magenta accents, system font stacks only (no web fonts), tabular numerals, legible over the brightest scene.

## 2. Performance budget - the 60fps line

60fps is held over visual quality whenever they conflict. Find a cheaper route to the look.

Measured with the scripted demo drive (`?demo=1&track=<id>`) on this Mac's integrated GPU (the "ordinary laptop" baseline), high preset, 1920x1080 viewport, 30 s window after a 3 s warm-up. Frame cost is per frame `max(CPU frame time, GPU frame time)`, the GPU side from `EXT_disjoint_timer_query_webgl2`. Results land in `window.__perf` (`src/core/perf.ts`).

| Budget | High | Medium | Low |
|---|---|---|---|
| Frame cost avg | <= 12 ms | <= 10 ms | <= 8 ms |
| Frame cost p99 | <= 16.6 ms | <= 14 ms | <= 12 ms |
| Draw calls (all passes) | <= 250 | <= 180 | <= 120 |
| Triangles (all passes) | <= 1.5 M | <= 1.0 M | <= 0.6 M |
| Bloom | mipmap blur, full res, <= 2.0 ms GPU | half res | off |

- One `EffectComposer`; all effects merged into as few passes as possible. Base stack: bloom, tone mapping, vignette, SMAA. Chromatic aberration and speed lines only while boosting. No SSAO, SSR or depth of field.
- Instancing is mandatory for anything repeated more than 8 times (posts, billboards, props, cores, shards, buildings, stars).
- No per-frame allocation in `useFrame` or physics callbacks: module-level temps only, no `new`, spreads, closures or object literals per frame. No React state per frame: per-frame values live in `telemetry`, `cars` and other mutable singletons.
- Lights: one directional (sun or moon), one hemisphere, and the player's two headlight spot lights (no shadows). Everything else that "emits light" fakes it with emissive geometry. One shadow map at most (<= 2048, tight frustum following the car, high preset, sundown only).
- Textures are procedural (canvas or DataTexture) and <= 1024 px.
- Physics: fixed 60 Hz. Static colliders are the road ribbon (trimesh), the terrain (heightfield), walls, a catch floor and props near the player.
- Draw distance and fog are matched; distant geometry fades into haze, never pops.
- Quality `auto` starts at high and steps down one preset if frame cost p95 exceeds 14 ms over 5 s of driving.

## 3. Feel standard

Each item here cost v1 a rework round. A checker tests every one on both the keyboard and the controller path.

- Physics at a fixed 60 Hz with interpolated rendering, so it is smooth at 165 Hz. Nothing snaps except an explicit reset.
- Springs and damping on everything that moves: camera position, look target, up vector and FOV; car body roll and pitch; HUD numbers and panels.
- A quick handbrake tap with hands off self-straightens: drift angle peaks under 25 degrees and decays below 5 degrees within 3 s. A held handbrake drift stays alive and is catchable with countersteer.
- Braking mid-corner never spins the car (brake balance plus the `stability` setting).
- Steering is speed-sensitive; keyboard steering is attack/release smoothed so it never twitches; sensitivity is a setting.
- Landings are forgiving: a short two-wheel recovery window (about 0.35 s) saves near-misses. Landing on the roof is a wipeout.
- Air control is generous but calm. The engine free-revs in the air rather than falling silent.
- Loops and wall rides use magnetic grip: above the surface's minimum speed the car stays stuck; below it, the grip fades and the car falls off cleanly. No tunnelling through the ribbon, no snapping onto it.
- Boost pads kick the FOV, add chromatic aberration and speed lines, and ease back out; nothing jumps.
- Camera: chase, close and bonnet, cycled with an eased transition. It never clips through the road, terrain or walls. On loops and wall rides its up vector follows the car's up on a spring.
- Input is analog-first with hot-swap: whichever device was touched last wins, no config. In menus the arrow keys and d-pad navigate and never leak into throttle.

| Action | Keyboard | Xbox controller |
|---|---|---|
| Throttle / brake-reverse | W / S or Up / Down | RT / LT (analog) |
| Steer | A / D or Left / Right | left stick (analog) |
| Handbrake | Space | A |
| Camera cycle | C | RB |
| Reset to road | R | Y |
| Restart at start line | Shift+R | View (Back) |
| Menu | Esc | Menu (Start) |

## 4. Verification protocol

- A worker's "done" is a claim. It counts once a fresh-context checker that did not write the code has re-executed it: built a preview of a pinned commit on its own port (5220-5239), driven it in one WebGL tab, taken screenshots, read the console, measured frames, and judged against this document.
- Named checks: visual judge (both launch tracks at sundown and at night); performance (demo drive per track, section 2 table); feel (every section 3 item, keyboard and controller paths); track-as-one-file proof (a third track written as a file only loads, plays, validates laps, and the Ai racers finish it); editor round-trip; Hyperdrome bank and speed trap; loops and wall rides; two-client multiplayer; clean clone.
- "Looks good" is never asserted; it points at a screenshot taken in this session. Every progress claim points at a tool result from this session.
- Failures go back to the owning worker with the specific defect, and the loop repeats until true. If a checker's verdict looks wrong, it is settled against this document, not overruled quietly.

## 5. Hard rules

- **Containment.** Every reachable part of every track, drawn ones included, physically contains the car: the world edge is a ridge or wall that reads as a boundary, a catch floor sits under the terrain, and a car below the terrain or outside the world auto-resets to the road. The road ribbon is a closed slab, not a single sheet.
- **Consistency.** If one roadside piece is solid, every one is. Smashables are solid when hit slow and smash when hit fast, every time, at the speed in `config.ts`.
- **Tracks are data.** A track is one file in `tracks/` in the format documented in `tracks/README.md`. Adding a track never touches code. Checkpoints, the Ai racing line, spawn grid, minimap and ghost all derive from the file.
- **Self-contained.** No external model, texture, font, audio or CDN URLs. Geometry, textures, sound and music are generated in code. `bun install && bun run dev` on a clean clone is the whole setup.
- **NaN firewall.** Every value entering rapier is checked finite first; a bad value logs once and resets the car, it never reaches the WASM.
- **Kid door.** `src/core/config.ts` holds every default a player can feel, with plain comments. Josh edits a value, saves, and sees it change. An edit there beats an older menu choice.
- **Event feed.** Gameplay moments go through `src/core/events.ts` and nowhere else, so a future radio commentator can plug in without touching gameplay code.
- **No placeholders.** No TODOs, stubs or "coming soon" in shipped code.
- **Ports.** 5201 dev server (orchestrator owns the running instance), 5202 multiplayer relay, 5210-5219 worker scratch servers, 5220-5239 checker previews.
- **Ownership.** Workers edit only the paths they own. Contracts (section 6) change only through the orchestrator. No new dependencies without orchestrator approval.

## 6. Frozen contracts

| Contract | File |
|---|---|
| Kid knobs (defaults) | `src/core/config.ts` |
| Persisted settings | `src/core/settings.ts` |
| Game store (low-frequency state) | `src/core/store.ts` |
| Per-frame telemetry, car registry, world light (`environment`) | `src/core/telemetry.ts` |
| Game-event feed | `src/core/events.ts` |
| Controls (input to game, menu bus) | `src/core/controls.ts` |
| Palette and glow tiers | `src/core/palette.ts` |
| Physics groups and surface tags | `src/core/physics.ts` |
| Measurement handles (`window.__perf`, `window.__game`) | `src/core/perf.ts`, `src/core/devHandles.ts` |
| Records (best laps, scores) | `src/core/records.ts` |
| Track file schema | `src/track/schema.ts`, `tracks/README.md` |
| Track runtime and road ribbon API | `src/track/types.ts` |
| Cross-module APIs (fx, audio, vehicle catalog, SimCar + Driver, play) | `src/core/api.ts` |
| Session flow (start, pause, results, editor) | `src/core/session.ts` |
| Multiplayer crash-prop seam | `src/core/propsSignal.ts` |
| Full-lock grip per speed (values owned by vehicle, read by the racing line) | `src/core/gripTable.ts` |
| Track registry and current track | `src/track/registry.ts`, `src/track/current.ts` |
| App mount points and boot | `src/App.tsx`, `src/boot.ts`, `src/main.tsx` |

## 7. Amendments

- 2026-10-01: written before the first line of game code.
- 2026-10-01: contract table gains gripTable.ts. Tone mapping is Khronos Neutral (picked by A/B against ACES: Neutral keeps the sun gradient). One driving brain: the demo autopilot uses the Ai Driver.
- 2026-10-01: CarState gains `lastLapDirty` and `lastLapMs`, written by each car's lap tracker in the same step as `lap++`: the one source for lap validity (race results never count a dirty lap as a best). Store gains `playerGridSlot` and `mapOpen`.
- 2026-10-02: `setTrackParam` (store and `track/current.ts`) takes `null`: back to the track file's default and the saved value is forgotten, so a later change to the file's default still wins. The `track.param` event carries the value actually built.
- 2026-10-02: `CarAnchors` gains an optional `bonnet` point (each body's bonnet camera mount), so a body can cover the physics box without swallowing the camera.
