# Track files

Every track in Sundown Run II is **one JSON file in this folder**. The game builds the whole world from it: the road, the terrain, the jumps and loops, the crash props and energy cores, the sky and the music mood. It also works out, by itself, the lap checkpoints, the Ai racing line, the start grid, the minimap and the ghost key. Drop a new file in here and it shows up in the game. You never touch any code.

This page is the whole format. It is written for Josh and for a future Claude session that has only this file.

- The TypeScript version of the format is `src/track/schema.ts` (the two must agree).
- `afterglow.json` (open world, every kind of piece) and `hyperdrome.json` (banked stadium oval) are full worked examples.

## Quick start

1. Copy the minimal example below into `tracks/my-track.json`. The file name must match the `id`.
2. Run `bun run tracks:check tracks/my-track.json`. It validates the file, builds the whole track the way the game does, prints a summary and lists any warnings. Exit code 0 means it works.
3. Run `bun run tracks:check tracks/my-track.json --physics` too. This drops test cars all over it and fires them at the edges in a real physics world, to prove nothing falls through and nothing escapes.
4. Play it: `bun run dev`, then open `http://localhost:5201/?track=my-track`.

## Coordinates

| | |
|---|---|
| Units | metres and degrees |
| `+x` | east (right on the map) |
| `-z` | north (up on the map) |
| `+y` | up |
| Centre of the world | `(0, 0)` |
| Headings and azimuths | 0 = north (-z), 90 = east (+x), 180 = south, 270 = west |
| The world | a square `environment.size` metres across, centred on (0, 0), so x and z run from `-size/2` to `+size/2` |

### Positions along the road: `at`

Pieces (and the start line) say where they are with `at`: a road-point index plus a fraction.

- `at: 3` is exactly at point 3.
- `at: 3.5` is halfway from point 3 to point 4.
- `at: 3.9` is most of the way to point 4.
- `at` must be at least 0 and less than the number of points. After the last point the road joins back to point 0, so with 20 points, `at: 19.5` is halfway from point 19 back to point 0.
- `at` always refers to the points **in your file**, before anything is built. A loop adds road, but it never changes what `at` means.

### Distances along the built road: `s`

The checker reports places as `s=812 (at 7.4)`. `s` is metres along the **built** road from the start line, so it includes the extra road each loop adds (about 5 x radius). The `at` in brackets is the matching position in your file, which is the number you edit.

## The minimal complete track

```json
{
  "format": "sundown-run-track",
  "version": 1,
  "id": "my-track",
  "name": "My Track",
  "road": {
    "points": [
      { "x": -200, "z": 120 },
      { "x": 200, "z": 120 },
      { "x": 260, "z": 0 },
      { "x": 200, "z": -120 },
      { "x": -200, "z": -120 },
      { "x": -260, "z": 0 }
    ]
  },
  "pieces": [
    { "type": "boost", "at": 0.6 },
    { "type": "ramp", "at": 3.5 }
  ],
  "environment": {
    "terrain": { "kind": "hills" }
  }
}
```

That's a ~1.4 km loop through rolling hills, with a boost pad and a jump. Everything else gets a sensible default.

## Every field

### Top level

| Field | Type | Default | Notes |
|---|---|---|---|
| `format` | `"sundown-run-track"` | required | Always exactly this |
| `version` | `1` | required | Always 1 for now |
| `id` | string | required | kebab-case letters and numbers (`my-track`). Must match the file name and be unique. |
| `name` | string | required | Shown in menus |
| `author` | string | none | |
| `description` | string | none | One or two sentences for the track picker |
| `laps` | whole number 1-99 | the player's race-laps setting | Laps in a race on this track |
| `road` | object | required | See **road** |
| `pieces` | list | `[]` | Boost pads, ramps, loops, wall rides, speed traps. See **pieces**. |
| `props` | list | `[]` | Crash-prop spots. See **props**. |
| `cores` | list | `[]` | Energy-core spots for the hunt. See **cores**. |
| `hunt` | `{ count }` | `{ count: all spots, max 12 }` | Cores per hunt round, picked from the spots |
| `start` | `{ at }` | `{ at: 0 }` | Where the start/finish line is. The grid lines up behind it. |
| `environment` | object | required | At least `{ "terrain": { "kind": "hills" } }`. See **environment**. |

### road

| Field | Type | Default | Notes |
|---|---|---|---|
| `points` | list of road points | required, at least 4 | The centreline in driving order. The road is a closed loop: after the last point it joins back to the first. It passes through every point on a smooth curve (a centripetal Catmull-Rom spline). Points must be at least 2 m apart. |
| `width` | metres, 4-80 | 14 | Road width. Under 8 or over 40 gets a warning. |
| `banking` | object | see below | |
| `barriers` | `"none"` or `"walls"` | `"none"` | `"walls"` puts solid walls along both edges (a stadium) and turns off the roadside posts. Each wall is one smooth solid along its whole length, so a car pressed against it slides along it instead of catching |
| `barrierHeight` | metres | 2.2 | |

**A road point**

| Field | Type | Default | Notes |
|---|---|---|---|
| `x`, `z` | metres | required | Must be inside the world |
| `y` | metres | none | Where the road sits here before it banks. On a bank the low edge stays at this height and the high side rises (a road with `"walls"` tilts about its middle instead). Leave it out and the road sits on the ground. |
| `lift` | metres | 0 | Metres above the natural ground here. Ignored when `y` is given. Use 2-4 for a crest you can jump, 8 or more for a bridge over another part of the road. Measured the same way as `y`: on a bank, to the low edge. |
| `width` | metres | `road.width` | This point's width. Widths blend smoothly between points. |
| `bank` | degrees, -60 to 85 | auto | A bank override, in degrees **into the corner**: 0 is flat, negative is off-camber. On a straight, positive lifts the left edge. Overrides blend smoothly toward neighbouring points and win over auto-banking. A big change of bank between points close together may not have room to roll gently; the `crest` row says so. |

How a point's height is decided: its `y` if given; otherwise the natural ground averaged over about 12 m around it, plus `lift`. Between points the spline makes the road smooth, and the terrain is cut and filled to meet it. On a bank, an open road keeps its LOW edge at that height (on the ground, for a road on the ground) and tilts up from it: the high side rises, and the ground is filled up under it into a bank. Beside the low edge the ground stays level with the edge for about 4.5 m before it blends back to natural, so a car that puts a wheel off the low side has nothing to drop into. A road with `"walls"` tilts about its middle instead (its barrier stands on the low edge, with level ground behind it). While the bank rolls in or out (and through an S-bend, where its lean changes side) the low edge sits a little above the points' height, so the road never twists or dips sharply. Beside a road on the ground, the terrain meets the edge nearly flush (about 5 cm below the lip), so driving back on from the grass is smooth. Where the road ends up more than 6 m above the natural ground it becomes a **bridge**: the ground under it stays natural (cut down to keep 5 m of clearance under the road) instead of being filled up to it.

**banking**

| Field | Type | Default | Notes |
|---|---|---|---|
| `auto` | boolean | true | Bank corners automatically from how tight they are |
| `maxDeg` | degrees, 0-75 | 10 | Auto-banking never goes steeper than this |
| `designSpeedKmh` | km/h | 120 | Corners are banked for this speed: bank = atan(v^2 / (g x radius)), capped at `maxDeg`. Faster design speed or a tighter corner means a steeper bank. Only real corners bank: a bend must turn at least 4 degrees over 80 m to get any bank (12 degrees for full bank), and curves gentler than a 3 km radius count as straight. |
| `adjustable` | `{ label, min, max }` | none | Turns `maxDeg` into a live slider (the Hyperdrome's "Bank angle"). The game rebuilds the road in place when the slider moves, without moving the car. |

The bank rolls in and out smoothly over at least 40 m, so corners never twist suddenly. A bigger change of bank gets a longer roll, so a car on any lane stays on the road even at 250 km/h: on the Hyperdrome's 22 m road about 125 m for 30 degrees, 160 m for 45 and 200-210 m for 60. The roll is an even S (it starts and ends gently). It grows into the straight beside the corner only while the bank there stays within 15 degrees of what the bend wants (a bank on a straight pulls every car down the slope), and takes the rest from the banked corner. It never grows into the start grid, a loop (with its run-in and the S back after it) or road that bends the other way. A roll from one corner straight into another leaning the other way is level where the bend changes hand. On an open road the road rises gently over the last 100-200 m into a banked corner (and settles back after it), so where the bank rolls the lanes ride it as gently as on a road tilting about its middle; across a ramp, the 150 m its jump lands on, and round a loop, that rise is held level, so jumps and loops sit exactly as they would, just a little higher.

### pieces

Every piece has a `type` and an `at`.

| type | Fields (defaults) | What it is |
|---|---|---|
| `boost` | `offset` 0 (metres right of the centre, minus = left), `length` 10, `width` 5, `strength` 1 | A glowing pad that kicks you forward. Centred on `at`. |
| `ramp` | `offset` 0, `width` 8, `length` 12, `height` 2.4 | A curved kicker ramp. It grows out of the road with no bump and gets steeper toward the lip, which faces the driving direction. Its sides slope at about 35 degrees, so clipping the edge tips you up and off rather than flicking you sideways, and the slope stays narrow (about 1.4 x height wide) so the rest of the road is clear. An offset ramp leaves a lane beside it; `tracks:check --physics` drives that lane. Centred on `at`. |
| `loop` | `radius` 13 (the loop is 2 x radius tall) | A corkscrew loop with magnetic grip. On a 14 m road keep the radius 13 m or more (wider road: bigger loop); `tracks:check` checks it. The road runs dead straight into the loop's mouth at `at`, goes up and over a teardrop loop (gentle at the bottom, tight at the top) while drifting sideways by the road width plus 1 m, comes down about 2.6 x radius metres further on, then eases back onto its original line over 180 m on a gentle S. The way in and the way out run side by side. The loop drifts toward the side the road bends to next, so the ease back flows into that bend; on a road that carries on straight it drifts right. The loop adds about 5 x radius metres of road. |
| `wallride` | `side` (required: `"left"`, `"right"` or `"both"`), `length` 120, `height` 9 (the wall's curve radius) | A curved quarter-pipe wall along the edge, rising from the road through vertical to about 100 degrees, with magnetic grip. It runs `length` metres forward from `at` and ramps in and out over 15 m at each end. `both` makes a half-pipe. |
| `speedtrap` | none | Measures and records your speed as you pass `at` |

Placing pieces well:

- **Loops** need a level straight: an 80 m run-in before `at` that a car can aim straight down and land in the mouth (the validator warns when a dead-straight line from 80 m out would arrive more than half the road width minus 3 m off the middle), the loop itself and about 20 m past where it comes down on a straight (no bend tighter than a 400 m radius), and no climb. The 180 m ease back after the loop can run into a gentle bend. Getting a truly straight road out of the spline: the road between points i and i+1 is only straight when points i-1, i, i+1 and i+2 all lie on one line. So for a straight, put at least four points in a line, and put the loop between the 2nd and 3rd of them (with points 100 m or more apart). A loop at the 4th of 5 points in a line sits where the curve already starts and gets flagged. Put a boost pad 100-150 m before the loop, on the straight; the Ai takes loops at about 120 km/h.
- **Wall rides** belong on the **outside** of a long bend: `right` on a left-hander, `left` on a right-hander.
- **Ramps** work best on straights. A ramp that launches you into a tight corner is mean (the Ai slows down for it).
- **Nothing but boosts and speed traps on the start grid**: no other piece anywhere from 70 m before the start line to 25 m after it. The grid itself (12 slots) reaches 47 m behind the line. Put it on straight, flat road: the checker warns if anywhere from 50 m behind to 10 m after the line bends tighter than a 400 m radius or is banked more than 3 degrees.
- Loops, wall rides and ramps each need their own stretch of road; overlapping ones get a warning.

### props

Crash-prop clusters that burst for points and re-scatter every round.

| Field | Type | Default | Notes |
|---|---|---|---|
| `x`, `z` | metres | required | Put some on the road (on the racing line) and some off-road |
| `kind` | `"crates"`, `"cubes"`, `"tower"` or `"mixed"` | `"mixed"` | |
| `size` | `"small"`, `"medium"` or `"large"` | `"medium"` | How many pieces |

### cores

Energy-core spots. Each hunt round picks `hunt.count` of them.

| Field | Type | Default | Notes |
|---|---|---|---|
| `x`, `z` | metres | required | |
| `y` | metres above the ground | 1.6 | Put some up high as a challenge, for example over a jump's landing. On a road, it is measured from the road surface. |

Good spots: hilltops, the top of the big-air hill, high over a jump, hidden corners (off-road is fine, that's the point of the hunt), the foothills of the edge mountains. Keep cores out of a loop's footprint (the 40 m either side of its `at`), where the loop's own road passes overhead.

### environment

| Field | Type | Default | Notes |
|---|---|---|---|
| `seed` | number | made from the `id` | Seed for everything random (hills, mountains, billboard picks). Change it to reshuffle the hills. |
| `size` | metres, 400-6000 | 1600 | The world square's side. Keep every road point at least the **edge margin** in from the edge, i.e. `max(abs(x), abs(z)) <= size/2 - margin`. With a `ridge` edge the margin is `clamp(0.15 x size, 170, 300) + 70` (the mountains start that much minus 40 m in): 240 m for a 1000 m world, 310 m for 1600, 340 m for 1800, 370 m for 2000 or more. With a `wall` edge it is 40 m. The validator warns when a point is closer. |
| `terrain` | object | required | See below |
| `sky` | object | see below | |
| `palette` | object | see below | |
| `city` | object or `false` | a city on the sun side | The distant megacity skyline |
| `stadium` | `{ standsHeight }` | none | An enclosed stadium around the road (grandstands 28 m tall by default) |
| `roadside` | object | see below | |
| `music` | object | see below | |

**terrain**

| Field | Type | Default | Notes |
|---|---|---|---|
| `kind` | `"hills"` or `"flat"` | required | Rolling open world, or a level floor (stadiums) |
| `height` | metres | 0 | Base ground height |
| `relief` | metres, 0-120 | 14 | How tall the rolling hills are (peak to trough is roughly this). Ignored for flat. |
| `scale` | metres | 260 | How wide the rolling hills are |
| `features` | list | `[]` | See below |
| `edge` | `"ridge"` or `"wall"` | ridge for hills, wall for flat | How the world edge holds you in. `ridge` is a ring of mountains up to 110 m tall following the world's rounded-square edge: gentle foothills first, then a face you can't climb. Toward the sun (`sky.sunAzimuthDeg`, +/-40 degrees, fading back by +/-65) the ridge drops to 40% of its height and gets steeper instead, so the sunset and the city are visible from the whole valley. `wall` is a solid circular stadium wall about 25 m inside the world edge. |

**terrain features** (added to the rolling hills; the road still cuts through them)

| type | Fields | Shape |
|---|---|---|
| `hill` | `x`, `z`, `radius`, `height` | A round hill |
| `bowl` | `x`, `z`, `radius`, `depth` | A round dip |
| `mesa` | `x`, `z`, `radius`, `height` | A flat-topped hill with steep sides |
| `bigAir` | `x`, `z`, `headingDeg`, `scale` (default 1, 0.3-3) | The big-air run, in this order along `headingDeg`: a big round hill you can climb from any side (32 m tall, 140 m radius), a shallow dip, then a small 12 m mountain whose tight rounded crest launches you, with the ground falling away behind it for the landing. The big hill's top is a broad dome (220 m vertical radius), so a car stays planted over it up to about 165 km/h and only the small mountain throws it in the air (it launches anything over ~60 km/h). The rolling hills fade out under the run so their bumps can't spoil it. At scale 1 the run is about 420 m long, and `x, z` is its middle: the big hill's top is 72 m behind it, the launch crest 160 m ahead. Every length and height multiplies by `scale` (so crest radii do too). Put it off-road but where players will see it from the road, with about 150 m of open ground past the launch crest. `tracks:check --physics` sends a car over it at 100, 150 and 200 km/h and reports every jump. |

**sky**

| Field | Default | Notes |
|---|---|---|
| `timeOfDay` | 0.12 | 0 = sundown (the sun's lower half on the horizon) to 1 = full night. The player's setting can override it. |
| `sunAzimuthDeg` | 0 | The compass direction the sun sets toward. Point the start straight at it. |
| `planetAzimuthDeg` | sun + 22 | Where the ringed planet hangs |
| `planetElevationDeg` | 19 | Degrees above the horizon |

**palette** (colours as `"#rrggbb"`; avoid pure primaries like `#ff0000`)

| Field | Default | Notes |
|---|---|---|
| `edge` | `#ff2bd6` | Road edge strips (the track's accent) |
| `edgeAlt` | `#19e3ff` | Secondary accent |
| `grid` | `#6b4dff` | Ground grid |
| `haze` | `#43175e` | Distance haze |

**city**: `azimuthDeg` (default: the sun's), `arcDeg` (120), `distance` (2.2 x size), `density` 0-1 (0.7). `false` means no city.

**roadside**: `posts` is `{ spacing }` (default 45 m: smashable neon posts along both edges) or `false`. `billboards` is the most holographic billboards to place (default 10). The game picks the spots itself, 14-30 m out from the edge, on the outside of bends first, facing the road and clear of other road. They are solid, so none go where cars fly or bunch up: round loops and wall rides, ramps and the 150 m they throw you over, crests that go light and the 150 m after them, and along a big-air run. A small or tightly packed track may have room for fewer, and the checker then prints a warning with the number placed. Each spot gets one of five kinds of billboard (a wide panel, a tall banner, a small sign, a big double screen or a spinning cube) and its ads, picked from the track's seed, so a track always shows the same billboards. If even spacing leaves it short, the game closes the spacing, but never puts two billboards closer than 36 m.

**music**: `mood` is `"cruise"`, `"drive"` (default), `"race"` or `"hyper"`. `bpm` defaults from the mood (92 / 108 / 122 / 132).

## What the game works out for you

You never write these; they come from the file:

- **Checkpoints**: 8-16 sector lines spaced evenly round the lap (one every ~150-250 m), the first on the start line.
- **The racing line**: a smooth outside-apex-outside line that stays 2.5 m inside the edges (3 m on tracks with walls), and a target speed for every metre, planned for 1.25 g of grip plus what banking gives (never over 1.4 g, and never more than 95% of what the least grippy car can steer at full lock at that speed: about 1.24 g at 90 km/h, rising to 1.4 g by about 180 km/h); those two caps are on the turn along the road's own surface, which on a bank is gentler than the curve seen from above (curvature x cos(bank)), so the steeper the bank, the faster the line goes through the same corner (the Hyperdrome's ends: about 165 km/h flat, 186 at 30 degrees, 243 at 60), with crests, loops (~120 km/h) and braking zones taken into account. Braking is 7 m/s^2 on the flat and feels the hill: downhill, gravity eats into it (about 1 m/s^2 less per 10% of slope), uphill it helps; acceleration (5 m/s^2 on the flat) is the other way round. Wall rides are driven on their flat floor beside the wall, so a wall-ride bend is planned on tyre grip like any other corner (riding up the wall is for the player). The line is centred into each loop's mouth and lines up with each ramp's own offset. The Ai racers and the demo drive follow it.
- **The start grid**: two abreast, rows 8 m apart, starting 7 m behind the line.
- **The minimap**, **roadside posts** (skipped on loops, wall rides, ramps, bridges, steep shoulders and stadium tracks), **billboard spots**, and the **track key** used for records and the ghost (`id@hash`; it changes when the road or pieces change, or when the game changes how it builds roads, so an old ghost never haunts a changed track).

## Checking a track

`bun run tracks:check` checks every file in `tracks/`; give it a path to check one. For each track it prints:

| Line | Meaning |
|---|---|
| `road` | Length, samples, tightest corner radius, steepest bank |
| `height` | Road heights, how much is on the ground, terrain range |
| `pieces` | Every piece with where it ended up (`s` and `at`) |
| `checkpts` | Where the lap checkpoints fell (`at`). They are spaced evenly from the start line; one that would land inside a loop moves to 10 m before it. |
| `derived`, `racing`, `meshes`, `world`, `build` | What got built and how long it took |
| `crests` | Every crest with its vertical radius and the speed above which a car goes light (leaves the ground): `sqrt(9.81 x radius)` |
| `line` (gate) | The Ai racing line. Limits: no more than 35% of the lap pinned at the edge limit, no pinned stretch longer than 150 m, never closer to an edge than 2.5 m (3 m with walls), planned grip at most 1.45 g, no corner turning tighter than the least grippy car can steer at full lock at its planned speed, and no braking zone asking for more than the brakes have on its slope. A FAIL names the limit it broke. The builder plans the line itself, so a failure means a corner is too abrupt: spread its points or add one so it tightens gradually. (A full-lock or braking FAIL is a builder bug, not your file.) |
| `winding` (gate) | Every triangle faces the way its normal says. The game hides the back of a triangle, so a wrongly wound road would be invisible. A FAIL is a builder bug, not your file. |
| `smooth` (gate) | No kinks: the sharpest turn per metre is 4 degrees on the road and 9 in loops, and the roll is 4. A FAIL usually means a corner under ~15 m radius or two points almost on top of each other. |
| `banking` (gate) | The road leans INTO every corner and its roll changes by at most 1.5 degrees per metre, including across the start line. Up to 5 m of lean the wrong way is allowed, because rolling smoothly through an S-bend means the lean trails the curve briefly. "Leaning out of a corner" means the auto-bank tilts the wrong way where the road curves (radius under 600 m, measured over 40 m). It usually happens at a point squeezed between two bends; move that point a little so the bend flows. Lean caused on purpose by a `bank` override (off-camber) is allowed and reported separately, never as a failure. It also never leans more than 16 degrees ahead of its bend (more than the bend wants at the track's design speed, up to 200 km/h): on road that hardly turns, a bank pulls every car down the slope. Checked at the track's bank and at both ends of a bank slider. |
| `crest` (gate) | Where the bank rolls, no lane lifts a car off the road. A car driving 10 m from the middle of a rolling road rides a hill: where the roll speeds up, its lane drops away under it, and where the roll slows down, the other lane does. On every lane a car can be on (up to 1 m from each edge) the row measures how much of gravity's pull toward the road that hill asks for, at the speed a car can be doing there (the racing line's speed plus 15%, up to 250 km/h). Limit 80%, so a fifth of the car's weight always stays on its tyres. A corner under the bank presses the car on and helps; a wobble the other way under a steep bank lifts it and counts against it; the middle's own hilltops (crests on purpose) are not judged, but the rise and fall a bank puts in the middle of an open road (it tilts about its low edge) is, like the lanes. Checked at the track's bank and at both ends of a bank slider. The builder lengthens rolls by itself, so a FAIL means it had no room: put more straight road beside the banked corner (spread its points out), keep the start line and loops away from it, or use less bank there. |
| `loops` (gate) | Around every loop (80 m of run-in, the loop, and where it lands) nothing solid sits within a car's height (2.2 m) of the surface, and the loop didn't have to be bent more than 2 m to land on the road. A FAIL names where: usually another part of the road crossing too close to the loop, or a loop on a bend. Give it its own straight. |
| `surface` (gate) | The road faces the way its frames say. In the middle of the road the surface faces "up" within 5.7 degrees everywhere; on a loop, the lanes (up to 1 m from each edge) lean along the road at most 5.7 degrees; and every physics triangle faces within 2 degrees of the real road. A corkscrew loop has to roll about its own direction on the way round (about 80 degrees for a 13 m loop on a 14 m road), and the tighter the loop and the wider the road, the faster it rolls and the more its lanes lean. A FAIL on a loop names a radius that would pass: on a 14 m road use 13 m or more. On ordinary road the lanes lean where the bank rolls in; the row reports how much (the banking row limits it). |
| `under` (gate) | No physics ground sits closer than 0.5 m under the road at an angle (more than 15 degrees off the road's own slope). The game leaves the ground out under the road's solid slab and inside stadium barriers, so on a track with walls there is none under the road at all; an open road keeps ground just under its outer 4.5 m on purpose, so driving back on from the grass is smooth. A FAIL is a builder bug. |
| `lowedge` (gate) | On an open road, every bank keeps its low edge where the road would sit unbanked (at most 5 cm below), and the ground beside the low edge (out to 6 m, on road that sits on the ground) never dips more than 0.2 m below the edge and rises again: no ditch for a car on the low lane, or just off it, to drop into. A FAIL is a builder bug, not your file. |
| `barriers` (gate) | On a track with walls: the barrier on a bank's low edge is a wall wherever the bank is 15 degrees or more: its face rises at least 55 degrees from flat (so it's not a ramp a car drives up) and meets the road at least 55 degrees (so it doesn't lean over the road's edge, where a parked car wedges); and the ground behind it never dips more than 0.5 m below the road's edge. Checked at the track's bank and at both ends of a bank slider. A FAIL is a builder bug. |
| `tracking` (gate) | "Where am I on the road?" never jumps by mistake: a point walked round the whole lap in three lanes, asking with its last position as a hint the way every car does, never jumps more than 2 m; and at every crossing a car is found on the level it is actually on (after dropping off the bridge onto the road below, with a stale hint from the other level, or with none). A FAIL is a builder bug, not your file. |
| `bridges` (gate) | Where the road passes over itself, the gap between the levels (needs 6.2 m) |
| `ground` (gate) | The ground stays under the road everywhere (3 cm tolerance), at the track's own bank and at both ends of a bank slider, and meets the edge nearly flush (median under 10 cm). A FAIL is a builder bug, not your file. |
| `warning` | It works, but check it: tight corners, a loop on a bend, a piece on the grid, the grid on a bend, fewer billboards than asked, a road running into the mountains, a field name with a typo |
| `result` | ✓ OK or ✗ FAILED for this track |

Add `--physics` to drop and fire test cars in a real physics world (the same rapier the game runs): the terrain collider matches the ground, cars rest on the road, cars fired at 60 m/s onto every kind of surface stay on top, frictionless cars slid along the road into every loop, ramp, wall ride and checkpoint never hit a face (a checkpoint that falls on a ramp is driven in the clear lane beside it; the ramp's own runs cover the ramp), cars driven hands-off at every loop never hit it (aimed straight down the 80 m run-in from 2 m either side of the middle, they must go into the mouth; leaving the loop 2 m off-line and 3 degrees off-straight, they must run clear of its legs), a car sent over every big-air run at 100 and 150 km/h stays planted over the big hill and flies off the launch crest, a 12 x 12 drop grid over the whole world holds, cars fired at the edge at 90 m/s from 24 directions (plus 5 straight into the sunset notch) stay inside, on a track with walls a car body pressed sideways into each barrier at 200 and 300 km/h, from a start every 130 m round the lap and at both ends of a bank slider, slides along it (no barrier contact may push it back along the road and none may stop it), and the catch floor works. Add `--bench` for build and query timings.

Every row without `--physics` (line, winding, smooth, banking, crest, bridges, loops, surface, under, barriers, tracking, ground and the build warnings) comes from one function, `runTrackGates` in `src/track/gates.ts`, which the road editor runs too, so the editor and this checker always agree.

Every FAIL row prints a `fix:` line saying what to change. Anything marked FAIL, or an error, makes the command exit with code 1, and the last line counts failed **tracks** ("1 of 3 track(s) failed"), not failed rows.

If a physics `drive-through` hit is reported, something solid crosses the road there, usually two pieces overlapping or a loop on a bend or slope. The message gives the `at` to look at. A `hands off into a loop` hit means the run-in isn't straight enough for a car to aim at the mouth: line up the points before the loop.

## Design tips

- **Keep corners above a 25 m radius.** A tighter one gets a warning, and cars struggle.
- **Spacing.** Points 60-150 m apart make flowing roads. Use closer points only where you want a tight shape (a hairpin needs 4-5 points round it).
- **Crests that unload the car**: three points about 40-55 m apart, the middle one with `lift` 2.5-3.5. Run `bun run tracks:check` and read the `crests` row: a vertical radius of 120-140 m goes light at about 130 km/h. Smaller radius means lighter at lower speed.
- **Bridges**: give the upper road `lift` 8 or more where it crosses (the gap must be at least 6.2 m: a slab plus a car). The validator warns when the lifts at a crossing are less than 6.2 m apart, and `tracks:check` measures the real gap.
- **Elevation**: let the terrain do it (`relief`, `hill` features). The road follows the ground through its points.
- **Start line**: on a straight, pointing at the sun (`sunAzimuthDeg`), with at least 50 m of straight, flat road behind it for the grid and no pieces from 70 m behind the line to 25 m after it.
- **Stay inside the world edge**: see `size` above. The validator warns when a point is too close.
