// ============================================================
//  DRAFT FILE - the editor's work, written as a real track file
// ------------------------------------------------------------
//  Everything the editor makes ends up as one TrackFile (the same
//  format as tracks/*.json, see src/track/schema.ts). This module
//  builds that file from the editor's pieces of work (and a draft
//  from a file: a copy keeps everything that makes the track
//  itself), and holds the "base worlds" a drawn track can sit in.
//
//  A base world is just an `environment` block: the ground, the sky,
//  the city, the music. Pick one and the draft gets a copy of it.
//
//  It also knows what "Clear all" leaves behind (an empty map: the
//  world with no road yet), and the hidden stand-in road the game
//  builds that world with while the map is empty.
// ============================================================

import { roadBound as trackRoadBound, validateTrack } from '../track/validate'
import { averagedHeight, makeNaturalTerrain } from '../track/terrain'
import { hashString } from '../track/noise'
import { TRACK_FORMAT, TRACK_VERSION, type EnvironmentSpec, type HuntSpec, type Piece, type PropSpot, type CoreSpot, type RoadPoint, type TrackFile } from '../track/schema'
import type { Draft, RoadSettings } from './draft'

export interface BaseWorld {
  id: string
  name: string
  /** One line for the picker. */
  blurb: string
  environment: EnvironmentSpec
}

/** The base worlds a drawn track can be built in. */
export const BASE_WORLDS: readonly BaseWorld[] = [
  {
    id: 'neon-valley',
    name: 'Neon Valley',
    blurb: 'Rolling hills under the sinking sun, the city on the horizon.',
    environment: {
      size: 1600,
      terrain: { kind: 'hills', relief: 14, scale: 260, edge: 'ridge' },
      sky: { timeOfDay: 0.12, sunAzimuthDeg: 0 },
      city: { density: 0.7 },
      roadside: { posts: { spacing: 45 }, billboards: 8 },
      music: { mood: 'drive' },
    },
  },
  {
    id: 'grid-flats',
    name: 'Grid Flats',
    blurb: 'Dead flat glowing grid as far as you can see. Pure speed.',
    environment: {
      size: 1600,
      terrain: { kind: 'flat', edge: 'ridge' },
      sky: { timeOfDay: 0.25, sunAzimuthDeg: 0 },
      city: { density: 0.85, arcDeg: 150 },
      roadside: { posts: { spacing: 40 }, billboards: 15 },
      music: { mood: 'race' },
    },
  },
  {
    id: 'big-dunes',
    name: 'Big Dunes',
    blurb: 'Tall, wide hills: your road rides up and over them.',
    environment: {
      size: 1600,
      terrain: { kind: 'hills', relief: 26, scale: 340, edge: 'ridge' },
      sky: { timeOfDay: 0.08, sunAzimuthDeg: 30 },
      city: { density: 0.5, arcDeg: 90 },
      roadside: { posts: { spacing: 50 }, billboards: 6 },
      music: { mood: 'cruise' },
    },
  },
  {
    id: 'midnight-grid',
    name: 'Midnight Grid',
    blurb: 'Gentle hills after dark: headlights on, the city all lit up.',
    environment: {
      size: 1600,
      terrain: { kind: 'hills', relief: 8, scale: 220, edge: 'ridge' },
      sky: { timeOfDay: 0.9, sunAzimuthDeg: 200 },
      city: { density: 0.9, arcDeg: 160 },
      roadside: { posts: { spacing: 40 }, billboards: 16 },
      music: { mood: 'hyper' },
    },
  },
]

export const DEFAULT_BASE_WORLD = BASE_WORLDS[0]

/** Deep copy (environment blocks are plain JSON). */
export function cloneJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

export interface DraftParts {
  id: string
  name: string
  author?: string
  description?: string
  points: RoadPoint[]
  width?: number
  pieces?: Piece[]
  props?: PropSpot[]
  cores?: CoreSpot[]
  startAt?: number
  environment?: EnvironmentSpec
  /** The road's banking and walls (see Draft.roadSettings); none = automatic banking, no walls. */
  roadSettings?: RoadSettings
  laps?: number
  hunt?: HuntSpec
}

/** Assemble a complete, valid-shaped TrackFile from the editor's parts. */
export function draftFile(parts: DraftParts): TrackFile {
  // The banking, and the rest of the road's settings (its barrier walls) just as they were.
  const { banking, ...restOfRoad } = cloneJson(parts.roadSettings ?? {})
  const file: TrackFile = {
    format: TRACK_FORMAT,
    version: TRACK_VERSION,
    id: parts.id,
    name: parts.name,
    road: {
      points: parts.points.map((p) => ({ ...p })),
      width: parts.width ?? 14,
      // A drawn road banks its corners by itself; a copied one keeps its track's banking.
      banking: banking ?? { auto: true },
      ...restOfRoad,
    },
    environment: cloneJson(parts.environment ?? DEFAULT_BASE_WORLD.environment),
  }
  if (parts.author) file.author = parts.author
  if (parts.description) file.description = parts.description
  if (parts.laps !== undefined) file.laps = parts.laps
  if (parts.pieces?.length) file.pieces = cloneJson(parts.pieces)
  if (parts.props?.length) file.props = cloneJson(parts.props)
  if (parts.cores?.length) file.cores = cloneJson(parts.cores)
  if (parts.hunt && parts.cores?.length) {
    // Never more cores a round than there are spots (the game would use them all and warn).
    const hunt = cloneJson(parts.hunt)
    if (hunt.count !== undefined) hunt.count = Math.min(hunt.count, parts.cores.length)
    file.hunt = hunt
  }
  if (parts.startAt) file.start = { at: parts.startAt }
  return file
}

/**
 * Turn any track file (built-in, drawn or imported) into a draft. Built-ins
 * become a copy. A copy keeps everything that makes the track itself: its
 * world exactly (see worldForCopy), its road's banking and walls, its laps
 * and its hunt. Only the id and the name change.
 */
export function draftFromFile(file: TrackFile, asCopy: boolean): Draft {
  const { points, width, ...roadSettings } = file.road
  const d: Draft = {
    id: asCopy ? '' : file.id,
    name: asCopy ? `${file.name} copy` : file.name,
    author: file.author ?? '',
    description: file.description ?? '',
    points: cloneJson(points),
    width: width ?? 14,
    baseWorld: 'custom',
    environment: asCopy ? worldForCopy(file) : cloneJson(file.environment),
    pieces: cloneJson(file.pieces ?? []),
    props: cloneJson(file.props ?? []),
    cores: cloneJson(file.cores ?? []),
    startAt: file.start?.at ?? 0,
  }
  if (Object.keys(roadSettings).length) d.roadSettings = cloneJson(roadSettings)
  if (typeof file.laps === 'number') d.laps = file.laps
  if (file.hunt) d.hunt = cloneJson(file.hunt)
  return d
}

/** The track file a draft makes, under the id given (the store's fileFromDraft picks a free one). */
export function fileOfDraft(d: Draft, id: string): TrackFile {
  return draftFile({
    id,
    name: d.name.trim() || 'My Track',
    author: d.author.trim() || undefined,
    description: d.description.trim() || undefined,
    points: d.points,
    width: d.width,
    pieces: d.pieces,
    props: d.props,
    cores: d.cores,
    startAt: d.startAt,
    environment: d.environment,
    roadSettings: d.roadSettings,
    laps: d.laps,
    hunt: d.hunt,
  })
}

/**
 * How far a road's centreline may reach from the map centre, along x or z,
 * in this world (the edge mountains or stadium wall take up the rim). The
 * rule lives with the track validator, so the editor and the validator
 * can never disagree about it.
 */
export function roadBound(environment: EnvironmentSpec): number {
  return trackRoadBound(environment).limit
}

// ---------------------------------------------------------------- the world under the road

/**
 * A track's world, for a copy of that track. A world with no `seed` takes its
 * randomness (the rolling hills, where the roadside things go) from the
 * track's id, and a copy gets a new id, so the copy is given the original's
 * seed and sits in exactly the same world. (Without it, a copy of Afterglow
 * sat on different hills, and every road point with no set height rode up or
 * down with them.)
 */
export function worldForCopy(file: TrackFile): EnvironmentSpec {
  const environment = cloneJson(file.environment)
  if (environment.seed === undefined) environment.seed = hashString(file.id)
  return environment
}

/** The last world's ground, kept: the shaping tools ask for it on every use (a Bend once per drag). */
let groundMemo: { key: string; ground: (x: number, z: number) => number } | null = null

/**
 * The ground a road point with no `y` sits on, in this world, for a track
 * with this id, worked out exactly the way the game does it (the natural
 * ground averaged over about 12 m: averagedHeight in src/track/terrain.ts).
 * undefined if the world itself is not valid. Only the world and the id
 * matter (a world with no `seed` takes its hills from the id), so it is
 * checked with the starter road: a half-finished draft still gets it.
 */
export function pointGroundOf(environment: EnvironmentSpec, id: string): ((x: number, z: number) => number) | undefined {
  const v = validateTrack(draftFile({ id, name: 'Ground', points: starterRoad(environment), environment }))
  const env = v.track?.environment
  if (!env) return undefined
  // What the game's natural ground depends on (the envKey in src/track/build.ts).
  const key = JSON.stringify([env.seed, env.size, env.terrain, env.sky.sunAzimuthDeg])
  if (groundMemo?.key !== key) {
    const nat = makeNaturalTerrain(env)
    groundMemo = { key, ground: (x, z) => averagedHeight(nat, x, z) }
  }
  return groundMemo.ground
}

// ---------------------------------------------------------------- the empty map

/** The world-check oval's size, metres from the centre: across (x) and up and down (z). */
const CHECK_HALF_X = 220
const CHECK_HALF_Z = 140

/**
 * A plain oval that fits in this world, used only to ask the track validator
 * whether a world is valid (pointGroundOf): the validator checks a world
 * together with a road. It is never drawn or saved. In a small world the
 * oval shrinks to stay off the edge.
 */
export function starterRoad(environment?: EnvironmentSpec): RoadPoint[] {
  const limit = environment ? roadBound(environment) : Infinity
  const scale = Math.min(1, Math.max(0.3, (limit - 20) / CHECK_HALF_X))
  const pts: RoadPoint[] = []
  const count = 40
  for (let i = 0; i < count; i++) {
    const t = (i / count) * Math.PI * 2
    pts.push({ x: Math.round(CHECK_HALF_X * scale * Math.sin(t) * 10) / 10, z: Math.round(-CHECK_HALF_Z * scale * Math.cos(t) * 10) / 10 })
  }
  return pts
}

/**
 * A small round loop in the middle of the world, `radius` metres across from
 * the centre (16 points). Drive to draw starts the car on one; the empty map
 * builds its world around a hidden one (emptyWorldFile).
 */
export function smallLoop(radius = 48): RoadPoint[] {
  const pts: RoadPoint[] = []
  const n = 16
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2
    pts.push({ x: Math.round(radius * Math.sin(t) * 10) / 10, z: Math.round(-radius * Math.cos(t) * 10) / 10 })
  }
  return pts
}

/** True when the draft has no road at all (a cleared map, or a new track before the first loop). */
export function isEmptyDraft(d: Pick<Draft, 'points'>): boolean {
  return d.points.length === 0
}

/**
 * What the game builds while the map is empty. The game can't build a world
 * with no road at all (the terrain, the car's spawn and the checks all hang
 * off the road), so the empty map's world is built around a small hidden
 * loop in the middle, held up in the air: no roadside posts or billboards,
 * and the editor hides the loop itself (emptyMap.tsx). The terrain, sky, city and music are the
 * draft's own, under the draft's own id, so the hills are the ones a road
 * drawn on this map will sit on. Never saved, never driven.
 */
/** How high the empty map's hidden stand-in loop floats, metres (see emptyWorldFile). */
const EMPTY_LOOP_LIFT = 14

export function emptyWorldFile(d: Draft, id: string): TrackFile {
  const environment = cloneJson(d.environment)
  environment.roadside = { ...(environment.roadside ?? {}), posts: false, billboards: 0 }
  // Held up in the air, so the ground under it isn't tucked down to make room for it (from above,
  // a tucked ring of ground would show where the hidden loop is).
  const points = smallLoop().map((p) => ({ ...p, lift: EMPTY_LOOP_LIFT }))
  return draftFile({ id, name: d.name.trim() || 'My Track', points, width: d.width, environment })
}

/**
 * "Clear all": the same track with nothing on the map. The road goes (so
 * every per-stretch bank, width and height goes with it), and so do every
 * piece, crash-prop pile, energy core and the start line. What the track IS
 * stays: its name, maker, blurb, world, time of day, edge lights, road width,
 * banking, walls, laps and hunt.
 */
export function clearedDraft(d: Draft): Draft {
  return {
    ...cloneJson(d),
    points: [],
    pieces: [],
    props: [],
    cores: [],
    startAt: 0,
  }
}

/** True when "Clear all" would change nothing (the map is already empty). */
export function isBlankDraft(d: Draft): boolean {
  return JSON.stringify(clearedDraft(d)) === JSON.stringify(d)
}
