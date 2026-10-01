// ============================================================
//  DRAFT FILE - the editor's work, written as a real track file
// ------------------------------------------------------------
//  Everything the editor makes ends up as one TrackFile (the same
//  format as tracks/*.json, see src/track/schema.ts). This module
//  builds that file from the editor's pieces of work, and holds the
//  "base worlds" a drawn track can sit in.
//
//  A base world is just an `environment` block: the ground, the sky,
//  the city, the music. Pick one and the draft gets a copy of it.
// ============================================================

import { roadBound as trackRoadBound } from '../track/validate'
import { TRACK_FORMAT, TRACK_VERSION, type EnvironmentSpec, type Piece, type PropSpot, type CoreSpot, type RoadPoint, type TrackFile } from '../track/schema'

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
      roadside: { posts: { spacing: 40 }, billboards: 10 },
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
      roadside: { posts: { spacing: 40 }, billboards: 12 },
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
}

/** Assemble a complete, valid-shaped TrackFile from the editor's parts. */
export function draftFile(parts: DraftParts): TrackFile {
  const file: TrackFile = {
    format: TRACK_FORMAT,
    version: TRACK_VERSION,
    id: parts.id,
    name: parts.name,
    road: {
      points: parts.points.map((p) => ({ ...p })),
      width: parts.width ?? 14,
      banking: { auto: true },
    },
    environment: cloneJson(parts.environment ?? DEFAULT_BASE_WORLD.environment),
  }
  if (parts.author) file.author = parts.author
  if (parts.description) file.description = parts.description
  if (parts.pieces?.length) file.pieces = cloneJson(parts.pieces)
  if (parts.props?.length) file.props = cloneJson(parts.props)
  if (parts.cores?.length) file.cores = cloneJson(parts.cores)
  if (parts.startAt) file.start = { at: parts.startAt }
  return file
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
