// ============================================================
//  TRACK FILE SCHEMA - the format every track is written in
// ------------------------------------------------------------
//  CONTRACT (orchestrator-owned). The human-readable version of
//  this is tracks/README.md; keep the two in step.
//
//  A track is ONE JSON file in tracks/ (or a drawn track saved by
//  the editor, which is the same format). The game builds the whole
//  world from it: road ribbon, terrain, pieces, props, cores, sky,
//  and derives checkpoints, the Ai racing line, the start grid, the
//  minimap and the ghost key from it. Nothing else is needed.
//
//  Units: metres and degrees. World axes: +x is east (right on the
//  map), -z is north (up on the map), +y is up. The map centre is
//  (0, 0). Headings and azimuths: 0 = north (-z), 90 = east (+x).
//
//  Positions along the road use `at`: a control-point index plus a
//  fraction. at: 3 is point 3; at: 3.5 is halfway from point 3 to
//  point 4; the last point wraps back to point 0.
// ============================================================

export const TRACK_FORMAT = 'sundown-run-track' as const
export const TRACK_VERSION = 1 as const

export interface TrackFile {
  format: typeof TRACK_FORMAT
  version: typeof TRACK_VERSION
  /** kebab-case, unique, matches the file name (tracks/<id>.json). */
  id: string
  name: string
  author?: string
  description?: string
  /** Laps in a race on this track (default: the player's raceLaps setting). */
  laps?: number
  road: RoadSpec
  pieces?: Piece[]
  props?: PropSpot[]
  cores?: CoreSpot[]
  hunt?: HuntSpec
  start?: StartSpec
  environment: EnvironmentSpec
}

// ---------------------------------------------------------------- road

export interface RoadSpec {
  /**
   * Control points of the centreline, in driving order. The road is a
   * closed loop: after the last point it returns to the first. At least 4.
   * The road passes through every point (smooth spline).
   */
  points: RoadPoint[]
  /** Road width in metres (default 14). A point's own width wins. */
  width?: number
  banking?: BankingSpec
  /** Barriers along the road edges: 'none' (open world) or 'walls' (stadium). Default 'none'. */
  barriers?: 'none' | 'walls'
  /** Barrier wall height in metres (default 2.2). */
  barrierHeight?: number
}

export interface RoadPoint {
  x: number
  z: number
  /** Absolute surface height in metres. Omit to sit on the ground. */
  y?: number
  /** Metres above the ground here (bridges, crests). Ignored when y is given. Default 0. */
  lift?: number
  /** Road width here in metres. */
  width?: number
  /**
   * Bank in degrees INTO the corner here, overriding auto-banking.
   * 0 = flat, negative = off-camber. On a straight, positive lifts the left edge.
   */
  bank?: number
}

export interface BankingSpec {
  /** Bank corners automatically from their curvature (default true). */
  auto?: boolean
  /** Auto-bank never exceeds this many degrees (default 10). */
  maxDeg?: number
  /** Corners are banked for this speed (default 120 km/h): tighter + faster = steeper, up to maxDeg. */
  designSpeedKmh?: number
  /**
   * Expose maxDeg as a live slider (track param 'bankDeg'), e.g. the Hyperdrome.
   * The game rebuilds the road when it moves, without moving the car.
   */
  adjustable?: { label: string; min: number; max: number }
}

// ---------------------------------------------------------------- pieces

export type Piece = BoostPiece | RampPiece | LoopPiece | WallRidePiece | SpeedTrapPiece

export interface BoostPiece {
  type: 'boost'
  at: number
  /** Metres right (+) or left (-) of the centreline (default 0). */
  offset?: number
  /** Pad length and width in metres (default 10 x 5). */
  length?: number
  width?: number
  /** Kick multiplier (default 1). */
  strength?: number
}

export interface RampPiece {
  type: 'ramp'
  at: number
  offset?: number
  /** Default 8 wide, 12 long, 2.4 high. The lip faces the driving direction. */
  width?: number
  length?: number
  height?: number
}

export interface LoopPiece {
  type: 'loop'
  /** Put it on a straight, level stretch: the road needs room either side. */
  at: number
  /** Loop radius in metres (default 12). */
  radius?: number
}

export interface WallRidePiece {
  type: 'wallride'
  /** Where the wall starts; it runs `length` metres forward from here. */
  at: number
  /** Default 120 m. Best around the outside of a corner. */
  length?: number
  /** Which edge gets a wall: 'left', 'right' or 'both' (a half-pipe). */
  side: 'left' | 'right' | 'both'
  /** Wall curve radius in metres - how tall it is (default 9). */
  height?: number
}

export interface SpeedTrapPiece {
  type: 'speedtrap'
  at: number
}

// ---------------------------------------------------------------- props, cores, start

export interface PropSpot {
  x: number
  z: number
  /** What gets scattered here each round (default 'mixed'). */
  kind?: 'crates' | 'cubes' | 'tower' | 'mixed'
  /** How many pieces (default 'medium'). */
  size?: 'small' | 'medium' | 'large'
}

export interface CoreSpot {
  x: number
  z: number
  /** Metres above the ground (default 1.6). Put some up high as a challenge. */
  y?: number
}

export interface HuntSpec {
  /** Cores per round, picked from the spots (default: all spots, max 12). */
  count?: number
}

export interface StartSpec {
  /** Where the start/finish line is (default 0). */
  at?: number
}

// ---------------------------------------------------------------- environment

export interface EnvironmentSpec {
  /** Seed for everything random in this world (default: derived from the id). */
  seed?: number
  /** World size: a square this many metres across, centred on (0,0) (default 1600). */
  size?: number
  terrain: TerrainSpec
  sky?: SkySpec
  palette?: PaletteSpec
  /** The distant megacity skyline, or false for none. */
  city?: CitySpec | false
  /** An enclosed stadium around the road (the Hyperdrome). */
  stadium?: StadiumSpec
  roadside?: RoadsideSpec
  music?: MusicSpec
}

export interface TerrainSpec {
  /** 'hills' = rolling open world; 'flat' = a level floor (stadiums). */
  kind: 'hills' | 'flat'
  /** Base ground height in metres (default 0). */
  height?: number
  /** How tall the rolling hills are, metres (default 14; ignored for flat). */
  relief?: number
  /** How wide the rolling hills are, metres (default 260). */
  scale?: number
  features?: TerrainFeature[]
  /** How the world edge holds you in: 'ridge' (mountains) or 'wall' (default: ridge for hills, wall for flat). */
  edge?: 'ridge' | 'wall'
}

export type TerrainFeature =
  /** A round hill. */
  | { type: 'hill'; x: number; z: number; radius: number; height: number }
  /** A round dip. */
  | { type: 'bowl'; x: number; z: number; radius: number; depth: number }
  /** A flat-topped hill with steep sides. */
  | { type: 'mesa'; x: number; z: number; radius: number; height: number }
  /**
   * The big-air hill: a big natural hill you can climb from any side, a dip,
   * then a small mountain to launch off, in that order along headingDeg.
   * scale 1 is about 260 m long.
   */
  | { type: 'bigAir'; x: number; z: number; headingDeg: number; scale?: number }

export interface SkySpec {
  /** Default time of day, 0 = sundown ... 1 = night (the player's setting can override). */
  timeOfDay?: number
  /** Compass direction the sun sets toward (default 0 = north). */
  sunAzimuthDeg?: number
  /** Where the ringed planet hangs (defaults: 40 degrees right of the sun, 28 degrees up). */
  planetAzimuthDeg?: number
  planetElevationDeg?: number
}

export interface PaletteSpec {
  /** Road edge strip colour (default palette roadEdge). */
  edge?: string
  edgeAlt?: string
  grid?: string
  haze?: string
}

export interface CitySpec {
  /** Compass direction of the skyline centre (default: the sun's azimuth). */
  azimuthDeg?: number
  /** How wide the skyline spreads, degrees (default 120). */
  arcDeg?: number
  /** Distance from the centre, metres (default 2.2 x world size). */
  distance?: number
  /** 0..1 how packed (default 0.7). */
  density?: number
}

export interface StadiumSpec {
  /** Grandstand height in metres (default 28). */
  standsHeight?: number
}

export interface RoadsideSpec {
  /** Smashable neon posts along both edges, every `spacing` metres (default 45), or false. */
  posts?: { spacing?: number } | false
  /** How many holographic billboards line the run (default 10). */
  billboards?: number
}

export interface MusicSpec {
  /** Soundtrack mood for this track (default 'drive'). */
  mood?: 'cruise' | 'drive' | 'race' | 'hyper'
  /** Tempo, beats per minute (default from mood). */
  bpm?: number
}

// ---------------------------------------------------------------- validation result

export interface TrackIssue {
  /** JSON path, e.g. "road.points[3].x" or "pieces[2]". */
  path: string
  message: string
}

export interface ValidationResult {
  ok: boolean
  /** Fatal problems: the track will not load. */
  errors: TrackIssue[]
  /** It loads, but something is probably not what the author meant. */
  warnings: TrackIssue[]
  /** The file with every default filled in (present when ok). */
  track?: ResolvedTrackFile
}

/** A TrackFile after validation: every optional field filled with its default. */
export type ResolvedTrackFile = Omit<TrackFile, 'laps'> & {
  /** null when the file doesn't set laps (use the player's raceLaps setting). */
  laps: number | null
  road: Required<Pick<RoadSpec, 'points' | 'width' | 'barriers' | 'barrierHeight'>> & {
    banking: Required<Omit<BankingSpec, 'adjustable'>> & Pick<BankingSpec, 'adjustable'>
  }
  pieces: Piece[]
  props: PropSpot[]
  cores: CoreSpot[]
  hunt: Required<HuntSpec>
  start: Required<StartSpec>
  environment: EnvironmentSpec & {
    seed: number
    size: number
    terrain: TerrainSpec & Required<Pick<TerrainSpec, 'height' | 'relief' | 'scale' | 'edge'>> & { features: TerrainFeature[] }
    sky: Required<SkySpec>
    palette: Required<PaletteSpec>
    city: Required<CitySpec> | false
    roadside: { posts: { spacing: number } | false; billboards: number }
    music: Required<MusicSpec>
  }
}

/** Defaults, in one place (validate fills these in). */
export const TRACK_DEFAULTS = {
  roadWidth: 14,
  barrierHeight: 2.2,
  bankMaxDeg: 10,
  bankDesignSpeedKmh: 120,
  worldSize: 1600,
  terrainRelief: 14,
  terrainScale: 260,
  boost: { length: 10, width: 5, strength: 1 },
  ramp: { width: 8, length: 12, height: 2.4 },
  loopRadius: 12,
  wallride: { length: 120, height: 9 },
  coreHeight: 1.6,
  huntMax: 12,
  postSpacing: 45,
  billboards: 10,
  timeOfDay: 0.12,
  cityArcDeg: 120,
  cityDensity: 0.7,
  standsHeight: 28,
} as const
