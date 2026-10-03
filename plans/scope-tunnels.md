---
type: plan
title: Tunnels scope (GitHub #9 part 3)
description: What a tunnel can be on the tile-mesh ground, what the track file, builder, editor and gates need, the risks, and three stages (underpass first).
created: 2026-10-03
status: approved
---

# Tunnels (GitHub #9 part 3): scope

Scoped 3 Oct 2026 by a read-only planning agent against main at 5fb6ba1; line numbers are as of that commit. Not started: waits on Nathan's go, and on track7 (road heights) and editor9/editor10 (editor tools, Fix it) landing, because stage 1 touches the same files.

Note: the physics ground is no longer a rapier heightfield. It is triangle-mesh tiles built from one height per 3 m grid point (`terrainTiles.ts:4-9`, `terrain.ts:389`), with triangles left out as holes (`terrainTiles.ts:115-124`). It still can't overhang. The CLAUDE.md heightfield gotchas describe v1.

## 1. What a tunnel can be

- **A. Underpass (open cutting).** The road going under gets a negative `lift`; the existing cut and fill digs a cutting for it (sloped sides 12-36 m wide, `terrain.ts:640-654`). The other road stays at ground level and crosses the cutting on its own slab, as a short bridge.
- **B. Cut-and-cover tunnel.** The ground grid holds the cutting floor; a separate closed "tube" solid (walls, ceiling, a top at natural ground height) puts the hill back over it.
- **C. Bored tunnel. Rejected.** The grid keeps the hill and a tube runs underneath it, but about 20 callers read `terrainHeight` as "the ground under me" and would think a car inside is buried: the camera clamp (`CameraRig.tsx:1016-1019`), the below-ground reset (`carSim.ts:2683-2690`, held off only by `onRoad`), pylons and sparks (`pylons.ts:110-118`, `FxPools.tsx:34`), plus stair-stepped holes in the 3 m grid at each mouth.

Recommendation: A first, then B. Both keep one fact true: the grid is what a car on the road stands over.

## 2. What it needs

**Track file**
- Depth: negative `lift`, already accepted (`validate.ts:183`, -30 to 200). No new field for stage 1.
- Depth limit (Nathan's ask): an editor floor of -10 m to go with the 16 m ceiling (`raise.ts:49`). An underpass needs about 7.4 m (`BRIDGE_GAP` 6.2 + 1.2 m slab). The validator warns below -10; the README says so.
- Roofing (stage 2): an explicit `{ type: 'tunnel', at, length }` piece, shaped like a wall ride, so Josh chooses an open cutting or a tunnel at the same depth. Contract change: `schema.ts`, README, CONSTITUTION section 7.

**Builder**
- Stage 1, the grounded rule (`road.ts:653-661`): a road point counts as a bridge where another stretch passes 6.2 m or more below it across the cutting's width; otherwise the top road fills its embankment back into the cutting (`terrain.ts:546-552`).
- Stage 2, the tube: one continuous triangle mesh along the road, built like `barrierSolidMesh` (`colliders.ts:196`); walls tagged `barrier`, top `terrain`; retaining walls on the approaches; grid points under the tube become holes; the ground beside the roof 5 cm below its edge (`terrain.ts:409`); drawn terrain pushed down under the tube (`terrainGeometry.ts:25-31`); a new `meshes.tunnels` in the runtime contract (`types.ts:263`, amendment); posts, billboards, props and cores keep off it (`build.ts:305-318`).
- Light inside: one shadow map near the car, so the road mesh gets a per-vertex "cover" value (like `aLateral`, `ribbon.ts:157`) that dims sun, sky, reflections and height fog; glowing wall strips (T1, T2 edge) light it.

**Editor**
- `planSwap` gets an "under" mode: the chosen road drops to -8 m on the same 80 m ramps and the other comes down to the ground (`bridges.ts:268-291`); `builtGapAt` checks the right road is lower.
- The crossing panel gets "Send this road under" (later "...in a tunnel"); `keepOverOf` and the clean-up remember it (`bridges.ts:486-501`, `cleanup.ts:645-723`).
- The Height tool's floor goes to -10 (`raise.ts:220`, `raise.ts:419`, the Height panel).
- Map labels UNDERPASS and TUNNEL beside BRIDGE.

**Gates**
- `bridges` already measures the gap either way up (`gates.ts:170`); reword its fix line. `ground` and `under` already judge a sunken road.
- New `cutting`: the ground beside a sunken road never steeper than about 45 degrees and never stepping more than 1.5 m per grid cell.
- New `dips`: the lip at the top of a ramp down asks no more than `CREST_LIMIT` (`raise.ts` `launchOver` as a gate).
- New `tunnel` (stage 2): at least 5 m road to ceiling, no physics ground inside the tube, roof edge within 10 cm of the ground beside it, `winding` covers the tube.

## 3. Risks and proof

- Physics: CCD looks a whole step ahead, so retaining wall and tunnel wall must be one mesh of car-sized triangles (CLAUDE.md barrier gotcha); the roof is a closed solid with a road-edge lip; every tube vertex checked finite before rapier (`colliders.ts:64-74`, NaN firewall); `resetY` and `catchFloorY` already follow the lowest road (`build.ts:257-270`).
- Visuals: separate roof and terrain geometrically (no `polygonOffset`); the cover value must cut height fog too or a deep mouth fills with pink haze; the portal reads as hillside, not an arch (constitution section 1).
- Perf: about 5k triangles per 200 m of tunnel, 1-2 draws, one collision mesh; measure on a production preview.
- Proof, stage 1: `tracks:check --physics` 3/3 with built-in hashes unchanged (no `BUILDER_VERSION` bump), editor self-test all pass, an under-swap sweep on figure-eights at 0/20/45/90 degrees across worlds (12/12), demo laps 0 resets.
- Proof, stage 2: physics cases sliding along tunnel walls and dropping a car on the roof at 40 and 100 m/s, a lap through at 250+ km/h with 0 resets, `?nancheck=1` 0 inside, perf, screenshots inside, at the mouth and on the hill above (sundown and night).

## 4. Stages

1. **Underpass.** The grounded rule, "Send this road under", the -10 m floor, the `cutting` and `dips` gates. Player gets: at any crossing, choose which road goes under; the Height tool digs a stretch down to 10 m. No file-format change.
2. **Tunnel.** The tunnel piece, tube, retaining walls, holes, interior light and fog, the `tunnel` gate and physics cases, a Tunnel piece in Place pieces. Player gets: real covered tunnels through hills, lit inside, a drivable hill above.
3. **Editor and feel.** "Put this road in a tunnel" at crossings, a Tunnel toggle on a stretch, tunnels on the minimap and map, reflections dimmed inside (telemetry `environment` amendment), engine echo inside. Player gets: tunnels in one click that feel like tunnels.

Decided 3 Oct 2026 (Nathan, "q7 yes"): go on stage 1 once track7, editor9 and editor10 have landed; a tunnel is an explicit choice, not automatic past a set depth.

Stage 1 landed 3 Oct (f91f588). Nathan, 3 Oct ("q10 yes keep doing the tunnels. dont stop till they are done."): stages 2 and 3 go ahead back to back; tunnel2 started on stage 2.
