# Track files

Every track in Sundown Run Two is **one JSON file in this folder**. The game builds the whole world from it: the road, the terrain, the jumps and loops, the crash props and energy cores, the sky and the music mood. It also works out, by itself, the lap checkpoints, the Ai racing line, the start grid, the minimap and the ghost key. Drop a new file in here and it shows up in the game. You never touch any code.

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
| `barriers` | `"none"` or `"walls"` | `"none"` | `"walls"` puts solid walls along both edges (a stadium) and turns off the roadside posts |
| `barrierHeight` | metres | 2.2 | |

**A road point**

| Field | Type | Default | Notes |
|---|---|---|---|
| `x`, `z` | metres | required | Must be inside the world |
| `y` | metres | none | An absolute surface height. Leave it out and the road sits on the ground. |
| `lift` | metres | 0 | Metres above the natural ground here. Ignored when `y` is given. Use 2-4 for a crest you can jump, 8 or more for a bridge over another part of the road. |
| `width` | metres | `road.width` | This point's width. Widths blend smoothly between points. |
| `bank` | degrees, -60 to 85 | auto | A bank override, in degrees **into the corner**: 0 is flat, negative is off-camber. On a straight, positive lifts the left edge. Overrides blend smoothly toward neighbouring points and win over auto-banking. |

How a point's height is decided: its `y` if given; otherwise the natural ground averaged over about 12 m around it, plus `lift`. Between points the spline makes the road smooth, and the terrain is cut and filled to meet it. Where the road ends up more than 6 m above the natural ground it becomes a **bridge**: the ground under it stays natural (cut down to keep 5 m of clearance under the road) instead of being filled up to it.

**banking**

| Field | Type | Default | Notes |
|---|---|---|---|
| `auto` | boolean | true | Bank corners automatically from how tight they are |
| `maxDeg` | degrees, 0-75 | 10 | Auto-banking never goes steeper than this |
| `designSpeedKmh` | km/h | 120 | Corners are banked for this speed: bank = atan(v^2 / (g x radius)), capped at `maxDeg`. Faster design speed or a tighter corner means a steeper bank. Corners gentler than a 3 km radius count as straight. |
| `adjustable` | `{ label, min, max }` | none | Turns `maxDeg` into a live slider (the Hyperdrome's "Bank angle"). The game rebuilds the road in place when the slider moves, without moving the car. |

The bank rolls in and out smoothly over about 40 m, so corners never twist suddenly.

### pieces

Every piece has a `type` and an `at`.

| type | Fields (defaults) | What it is |
|---|---|---|
| `boost` | `offset` 0 (metres right of the centre, minus = left), `length` 10, `width` 5, `strength` 1 | A glowing pad that kicks you forward. Centred on `at`. |
| `ramp` | `offset` 0, `width` 8, `length` 12, `height` 2.4 | A curved kicker ramp. It grows out of the road with no bump and gets steeper toward the lip, which faces the driving direction. Its sides slope so clipping the edge rolls you off rather than flicking you. Centred on `at`. |
| `loop` | `radius` 12 (the loop is 2 x radius tall) | A corkscrew loop with magnetic grip. The road slides sideways over 80 m before it, goes up and over a teardrop loop (gentle at the bottom, tight at the top) while drifting across by the road width plus 1 m, then slides back over 80 m. The way in and the way out run side by side. The loop adds about 5 x radius metres of road. |
| `wallride` | `side` (required: `"left"`, `"right"` or `"both"`), `length` 120, `height` 9 (the wall's curve radius) | A curved quarter-pipe wall along the edge, rising from the road through vertical to about 100 degrees, with magnetic grip. It runs `length` metres forward from `at` and ramps in and out over 15 m at each end. `both` makes a half-pipe. |
| `speedtrap` | none | Measures and records your speed as you pass `at` |

Placing pieces well:

- **Loops** need a level straight: about 100 m before and after `at` with no bends (radius over 400 m) and no climb. Put a boost pad 100-150 m before the loop; the Ai takes loops at about 120 km/h.
- **Wall rides** belong on the **outside** of a long bend: `right` on a left-hander, `left` on a right-hander.
- **Ramps** work best on straights. A ramp that launches you into a tight corner is mean (the Ai slows down for it).
- **Nothing but boosts and speed traps on the start grid**: keep other pieces at least 70 m before or 25 m after the start line.
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

Good spots: hilltops, the top of the big-air hill, high over a jump, hidden corners, the foothills of the edge mountains.

### environment

| Field | Type | Default | Notes |
|---|---|---|---|
| `seed` | number | made from the `id` | Seed for everything random (hills, mountains, billboard picks). Change it to reshuffle the hills. |
| `size` | metres, 400-6000 | 1600 | The world square's side. With a `ridge` edge, the mountains start rising about `0.15 x size + 30` metres in from the edge (200-330 m), so keep the road at least that plus 40 m in from the edge. The validator warns when a point is closer. |
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
| `edge` | `"ridge"` or `"wall"` | ridge for hills, wall for flat | How the world edge holds you in. `ridge` is a ring of steep mountains following the world's rounded-square edge, gentle foothills first, then a face you can't climb. `wall` is a solid circular stadium wall about 25 m inside the world edge. |

**terrain features** (added to the rolling hills; the road still cuts through them)

| type | Fields | Shape |
|---|---|---|
| `hill` | `x`, `z`, `radius`, `height` | A round hill |
| `bowl` | `x`, `z`, `radius`, `depth` | A round dip |
| `mesa` | `x`, `z`, `radius`, `height` | A flat-topped hill with steep sides |
| `bigAir` | `x`, `z`, `headingDeg`, `scale` (default 1, 0.3-3) | The big-air run: a big round hill you can climb from any side (32 m tall at scale 1), then a dip, then a small mountain whose upslope launches you, in that order along `headingDeg`. Scale 1 is about 260 m long, and `x, z` is the middle of the run. Put it off-road, but where players will see it from the road, and aim it at open ground so the landing is clear. |

**sky**

| Field | Default | Notes |
|---|---|---|
| `timeOfDay` | 0.12 | 0 = sundown (the sun's lower half on the horizon) to 1 = full night. The player's setting can override it. |
| `sunAzimuthDeg` | 0 | The compass direction the sun sets toward. Point the start straight at it. |
| `planetAzimuthDeg` | sun + 40 | Where the ringed planet hangs |
| `planetElevationDeg` | 28 | |

**palette** (colours as `"#rrggbb"`; avoid pure primaries like `#ff0000`)

| Field | Default | Notes |
|---|---|---|
| `edge` | `#ff2bd6` | Road edge strips (the track's accent) |
| `edgeAlt` | `#19e3ff` | Secondary accent |
| `grid` | `#6b4dff` | Ground grid |
| `haze` | `#43175e` | Distance haze |

**city**: `azimuthDeg` (default: the sun's), `arcDeg` (120), `distance` (2.2 x size), `density` 0-1 (0.7). `false` means no city.

**roadside**: `posts` is `{ spacing }` (default 45 m: smashable neon posts along both edges) or `false`. `billboards` is how many holographic billboards to place (default 10). The game picks billboard spots itself, 25-45 m out on the outside of bends, facing the road.

**music**: `mood` is `"cruise"`, `"drive"` (default), `"race"` or `"hyper"`. `bpm` defaults from the mood (92 / 108 / 122 / 132).

## What the game works out for you

You never write these; they come from the file:

- **Checkpoints**: 8-16 sector lines spaced evenly round the lap (one every ~150-250 m), the first on the start line.
- **The racing line**: a smooth line that cuts the apexes, staying 2 m inside the edges, and a target speed for every metre (corner grip, banking, crests, braking zones). The Ai racers and the demo drive follow it.
- **The start grid**: two abreast, rows 8 m apart, starting 7 m behind the line.
- **The minimap**, **roadside posts** (skipped on loops, wall rides, ramps, bridges, steep shoulders and stadium tracks), **billboard spots**, and the **track key** used for records and the ghost (`id@hash`; it changes when the road or pieces change, so an old ghost never haunts a changed track).

## Checking a track

`bun run tracks:check` checks every file in `tracks/`; give it a path to check one. For each track it prints:

| Line | Meaning |
|---|---|
| `road` | Length, samples, tightest corner radius, steepest bank |
| `height` | Road heights, how much is on the ground, terrain range |
| `pieces`, `derived`, `racing`, `meshes`, `world`, `build` | What got built and how long it took |
| `smooth` | No kinks: the sharpest turn per metre on the road and in loops |
| `bridges` | Where the road passes over itself, the gap between the levels (needs 6.2 m) |
| `ground` | The ground stays under the road everywhere, at every bank the slider allows |
| `warning` | It works, but check it: tight corners, a loop on a bend, a piece on the grid, a road running into the mountains, a field name with a typo |

Add `--physics` to drop and fire test cars in a real physics world (the same rapier the game runs): the terrain collider matches the ground, cars rest on the road, cars fired at 60 m/s onto every kind of surface stay on top, a 12 x 12 drop grid over the whole world holds, cars fired at the edge at 90 m/s from 24 directions stay inside, and the catch floor works. Add `--bench` for build and query timings.

Anything marked FAIL, or an error, makes the command exit with code 1.

## Design tips

- **Keep corners above a 25 m radius.** A tighter one gets a warning, and cars struggle.
- **Spacing.** Points 60-150 m apart make flowing roads. Use closer points only where you want a tight shape (a hairpin needs 4-5 points round it).
- **Crests that unload the car**: three points about 40-55 m apart, the middle one with `lift` 2.5-3.5. Run `bun run tracks:check`: a crest with a vertical radius of 120-140 m goes light at about 130 km/h.
- **Bridges**: give the upper road `lift` 8 or more where it crosses. `tracks:check` measures the gap.
- **Elevation**: let the terrain do it (`relief`, `hill` features). The road follows the ground through its points.
- **Start line**: on a straight, pointing at the sun (`sunAzimuthDeg`), with at least 60 m of clear road behind it for the grid.
- **Stay inside the world edge**: see `size` above. The validator warns when a point is too close.
