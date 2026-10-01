// ============================================================
//  VALIDATE - check a track file and fill in its defaults
// ------------------------------------------------------------
//  validateTrack(json) reads anything (a parsed JSON file, an editor
//  draft, a track streamed from a multiplayer host) and returns:
//
//    errors    the track can't load (a missing field, a number that
//              isn't a number, a piece off the end of the road)
//    warnings  it loads, but probably isn't what the author meant
//              (a corner tighter than 25 m, a loop on a bend, a ramp
//              on the start grid, the road running into the mountains)
//    track     the same track with every default filled in, ready
//              for buildTrack(). Only present when there are no errors.
//
//  The input is never changed. The defaults themselves live in one
//  place: TRACK_DEFAULTS in schema.ts.
// ============================================================

import {
  TRACK_DEFAULTS,
  TRACK_FORMAT,
  TRACK_VERSION,
  type ResolvedTrackFile,
  type TerrainFeature,
  type TrackIssue,
  type ValidationResult,
} from './schema'
import { PALETTE } from '../core/palette'
import { hashString } from './noise'
import { sampleClosedSpline, arcLengthAtParam } from './spline'
import { LOOP_RUN_IN, loopShape } from './road'

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const HEX = /^#[0-9a-fA-F]{6}$/
const PURE_PRIMARIES = ['#ff0000', '#00ff00', '#0000ff', '#ff00ff', '#00ffff']
const MOOD_BPM = { cruise: 92, drive: 108, race: 122, hyper: 132 } as const
const MIN_RADIUS = 25

class Issues {
  errors: TrackIssue[] = []
  warnings: TrackIssue[] = []
  err(path: string, message: string) {
    this.errors.push({ path, message })
  }
  warn(path: string, message: string) {
    this.warnings.push({ path, message })
  }
  /** Warn about keys we don't know (probably a typo). */
  unknown(o: Obj, path: string, known: readonly string[]) {
    for (const k of Object.keys(o)) {
      if (!known.includes(k)) this.warn(path ? `${path}.${k}` : k, `unknown field "${k}" (ignored)`)
    }
  }
  /** Optional number in [min, max]; returns the value or the default. */
  num(o: Obj, key: string, path: string, def: number, min: number, max: number): number {
    const v = o[key]
    if (v === undefined) return def
    if (!isNum(v)) {
      this.err(`${path}.${key}`, `must be a number`)
      return def
    }
    if (v < min || v > max) {
      this.err(`${path}.${key}`, `must be between ${min} and ${max} (got ${v})`)
      return def
    }
    return v
  }
  oneOf<T extends string>(o: Obj, key: string, path: string, options: readonly T[], def: T): T {
    const v = o[key]
    if (v === undefined) return def
    if (typeof v !== 'string' || !options.includes(v as T)) {
      this.err(`${path}.${key}`, `must be one of ${options.map((x) => `'${x}'`).join(', ')}`)
      return def
    }
    return v as T
  }
  color(o: Obj, key: string, path: string, def: string): string {
    const v = o[key]
    if (v === undefined) return def
    if (typeof v !== 'string' || !HEX.test(v)) {
      this.err(`${path}.${key}`, `must be a colour like "#ff2bd6"`)
      return def
    }
    if (PURE_PRIMARIES.includes(v.toLowerCase())) this.warn(`${path}.${key}`, `pure primary colours clash with the look; pick a softer neon`)
    return v
  }
}

export function validateTrack(json: unknown): ValidationResult {
  const I = new Issues()
  if (!isObj(json)) {
    I.err('', 'a track file must be a JSON object')
    return { ok: false, errors: I.errors, warnings: I.warnings }
  }
  const f = json

  I.unknown(f, '', ['format', 'version', 'id', 'name', 'author', 'description', 'laps', 'road', 'pieces', 'props', 'cores', 'hunt', 'start', 'environment'])
  if (f.format !== TRACK_FORMAT) I.err('format', `must be "${TRACK_FORMAT}"`)
  if (f.version !== TRACK_VERSION) I.err('version', `must be ${TRACK_VERSION}`)
  if (typeof f.id !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(f.id)) I.err('id', 'must be kebab-case letters and numbers, like "my-track"')
  if (typeof f.name !== 'string' || !f.name.trim()) I.err('name', 'must be a non-empty string')
  if (f.author !== undefined && typeof f.author !== 'string') I.err('author', 'must be a string')
  if (f.description !== undefined && typeof f.description !== 'string') I.err('description', 'must be a string')
  let laps: number | null = null
  if (f.laps !== undefined) {
    if (!isNum(f.laps) || !Number.isInteger(f.laps) || f.laps < 1 || f.laps > 99) I.err('laps', 'must be a whole number from 1 to 99')
    else laps = f.laps
  }

  // ---------------------------------------------------------------- environment (first: the road needs the world size)
  let size: number = TRACK_DEFAULTS.worldSize
  let envOut: ResolvedTrackFile['environment'] | null = null
  if (!isObj(f.environment)) I.err('environment', 'is required (it holds at least terrain: { kind })')
  else envOut = validateEnvironment(I, f.environment, typeof f.id === 'string' ? f.id : 'track')
  if (envOut) size = envOut.size
  const half = size / 2

  // ---------------------------------------------------------------- road
  let roadOut: ResolvedTrackFile['road'] | null = null
  const r = f.road
  if (!isObj(r)) I.err('road', 'is required')
  else {
    I.unknown(r, 'road', ['points', 'width', 'banking', 'barriers', 'barrierHeight'])
    const width = I.num(r, 'width', 'road', TRACK_DEFAULTS.roadWidth, 4, 80)
    if (width < 8 || width > 40) I.warn('road.width', `${width} m is unusual (most roads are 10-24 m)`)
    const barriers = I.oneOf(r, 'barriers', 'road', ['none', 'walls'] as const, 'none')
    const barrierHeight = I.num(r, 'barrierHeight', 'road', TRACK_DEFAULTS.barrierHeight, 0.5, 12)
    let banking: ResolvedTrackFile['road']['banking'] = {
      auto: true,
      maxDeg: TRACK_DEFAULTS.bankMaxDeg,
      designSpeedKmh: TRACK_DEFAULTS.bankDesignSpeedKmh,
    }
    if (r.banking !== undefined) {
      if (!isObj(r.banking)) I.err('road.banking', 'must be an object')
      else {
        const b = r.banking
        I.unknown(b, 'road.banking', ['auto', 'maxDeg', 'designSpeedKmh', 'adjustable'])
        if (b.auto !== undefined && typeof b.auto !== 'boolean') I.err('road.banking.auto', 'must be true or false')
        banking = {
          auto: b.auto !== false,
          maxDeg: I.num(b, 'maxDeg', 'road.banking', TRACK_DEFAULTS.bankMaxDeg, 0, 75),
          designSpeedKmh: I.num(b, 'designSpeedKmh', 'road.banking', TRACK_DEFAULTS.bankDesignSpeedKmh, 20, 600),
        }
        if (b.adjustable !== undefined) {
          if (!isObj(b.adjustable)) I.err('road.banking.adjustable', 'must be { label, min, max }')
          else {
            const a = b.adjustable
            I.unknown(a, 'road.banking.adjustable', ['label', 'min', 'max'])
            if (typeof a.label !== 'string' || !a.label) I.err('road.banking.adjustable.label', 'must be a non-empty string')
            const min = I.num(a, 'min', 'road.banking.adjustable', 0, 0, 75)
            const max = I.num(a, 'max', 'road.banking.adjustable', 45, 0, 75)
            if (!isNum(a.min) || !isNum(a.max)) I.err('road.banking.adjustable', 'needs both min and max')
            else if (min >= max) I.err('road.banking.adjustable', 'min must be less than max')
            else if (banking.maxDeg < min || banking.maxDeg > max) I.warn('road.banking.maxDeg', `the default ${banking.maxDeg} sits outside the slider (${min}-${max})`)
            banking.adjustable = { label: String(a.label ?? 'Bank angle'), min, max }
          }
        }
      }
    }

    const points: ResolvedTrackFile['road']['points'] = []
    if (!Array.isArray(r.points)) I.err('road.points', 'must be a list of at least 4 points')
    else {
      if (r.points.length < 4) I.err('road.points', `needs at least 4 points (has ${r.points.length})`)
      r.points.forEach((p, i) => {
        const path = `road.points[${i}]`
        if (!isObj(p)) {
          I.err(path, 'must be { x, z }')
          return
        }
        I.unknown(p, path, ['x', 'z', 'y', 'lift', 'width', 'bank'])
        if (!isNum(p.x) || !isNum(p.z)) {
          I.err(path, 'needs numbers x and z')
          return
        }
        if (Math.abs(p.x) > half || Math.abs(p.z) > half) I.err(path, `(${p.x}, ${p.z}) is outside the ${size} m world`)
        const pt: ResolvedTrackFile['road']['points'][number] = { x: p.x, z: p.z }
        if (p.y !== undefined) pt.y = I.num(p, 'y', path, 0, -500, 1000)
        if (p.lift !== undefined) {
          pt.lift = I.num(p, 'lift', path, 0, -30, 200)
          if (p.y !== undefined) I.warn(`${path}.lift`, 'ignored because y is given')
        }
        if (p.width !== undefined) pt.width = I.num(p, 'width', path, width, 4, 80)
        if (p.bank !== undefined) pt.bank = I.num(p, 'bank', path, 0, -60, 85)
        points.push(pt)
      })
      for (let i = 0; i < points.length; i++) {
        const a = points[i]
        const b = points[(i + 1) % points.length]
        if (points.length >= 2 && Math.hypot(b.x - a.x, b.z - a.z) < 2) I.err(`road.points[${(i + 1) % points.length}]`, `is within 2 m of point ${i}; spread them out`)
      }
    }
    roadOut = { points, width, barriers, barrierHeight, banking }
  }

  // ---------------------------------------------------------------- pieces
  const nPts = roadOut?.points.length ?? 0
  const atOk = (v: unknown, path: string): number => {
    if (!isNum(v)) {
      I.err(path, 'must be a number (control-point index + fraction)')
      return 0
    }
    if (nPts > 0 && (v < 0 || v >= nPts)) {
      I.err(path, `must be from 0 up to (not including) ${nPts}, the number of road points`)
      return 0
    }
    return v
  }
  const pieces: ResolvedTrackFile['pieces'] = []
  if (f.pieces !== undefined && !Array.isArray(f.pieces)) I.err('pieces', 'must be a list')
  else if (Array.isArray(f.pieces)) {
    f.pieces.forEach((p, i) => {
      const path = `pieces[${i}]`
      if (!isObj(p)) {
        I.err(path, 'must be an object with a type')
        return
      }
      const at = atOk(p.at, `${path}.at`)
      switch (p.type) {
        case 'boost': {
          I.unknown(p, path, ['type', 'at', 'offset', 'length', 'width', 'strength'])
          const D = TRACK_DEFAULTS.boost
          pieces.push({
            type: 'boost',
            at,
            offset: I.num(p, 'offset', path, 0, -40, 40),
            length: I.num(p, 'length', path, D.length, 2, 60),
            width: I.num(p, 'width', path, D.width, 1, 40),
            strength: I.num(p, 'strength', path, D.strength, 0.1, 5),
          })
          break
        }
        case 'ramp': {
          I.unknown(p, path, ['type', 'at', 'offset', 'width', 'length', 'height'])
          const D = TRACK_DEFAULTS.ramp
          pieces.push({
            type: 'ramp',
            at,
            offset: I.num(p, 'offset', path, 0, -40, 40),
            width: I.num(p, 'width', path, D.width, 2, 40),
            length: I.num(p, 'length', path, D.length, 3, 60),
            height: I.num(p, 'height', path, D.height, 0.3, 12),
          })
          break
        }
        case 'loop': {
          I.unknown(p, path, ['type', 'at', 'radius'])
          pieces.push({ type: 'loop', at, radius: I.num(p, 'radius', path, TRACK_DEFAULTS.loopRadius, 6, 40) })
          break
        }
        case 'wallride': {
          I.unknown(p, path, ['type', 'at', 'length', 'side', 'height'])
          const D = TRACK_DEFAULTS.wallride
          const side = I.oneOf(p, 'side', path, ['left', 'right', 'both'] as const, 'right')
          if (p.side === undefined) I.err(`${path}.side`, "is required: 'left', 'right' or 'both'")
          pieces.push({
            type: 'wallride',
            at,
            side,
            length: I.num(p, 'length', path, D.length, 40, 800),
            height: I.num(p, 'height', path, D.height, 4, 25),
          })
          break
        }
        case 'speedtrap': {
          I.unknown(p, path, ['type', 'at'])
          pieces.push({ type: 'speedtrap', at })
          break
        }
        default:
          I.err(`${path}.type`, `must be 'boost', 'ramp', 'loop', 'wallride' or 'speedtrap'`)
      }
    })
  }

  // ---------------------------------------------------------------- props, cores, hunt, start
  const props: ResolvedTrackFile['props'] = []
  if (f.props !== undefined && !Array.isArray(f.props)) I.err('props', 'must be a list')
  else if (Array.isArray(f.props)) {
    f.props.forEach((p, i) => {
      const path = `props[${i}]`
      if (!isObj(p) || !isNum(p.x) || !isNum(p.z)) {
        I.err(path, 'must be { x, z }')
        return
      }
      I.unknown(p, path, ['x', 'z', 'kind', 'size'])
      if (Math.abs(p.x) > half || Math.abs(p.z) > half) I.err(path, 'is outside the world')
      props.push({
        x: p.x,
        z: p.z,
        kind: I.oneOf(p, 'kind', path, ['crates', 'cubes', 'tower', 'mixed'] as const, 'mixed'),
        size: I.oneOf(p, 'size', path, ['small', 'medium', 'large'] as const, 'medium'),
      })
    })
  }
  const cores: ResolvedTrackFile['cores'] = []
  if (f.cores !== undefined && !Array.isArray(f.cores)) I.err('cores', 'must be a list')
  else if (Array.isArray(f.cores)) {
    f.cores.forEach((p, i) => {
      const path = `cores[${i}]`
      if (!isObj(p) || !isNum(p.x) || !isNum(p.z)) {
        I.err(path, 'must be { x, z }')
        return
      }
      I.unknown(p, path, ['x', 'z', 'y'])
      if (Math.abs(p.x) > half || Math.abs(p.z) > half) I.err(path, 'is outside the world')
      cores.push({ x: p.x, z: p.z, y: I.num(p, 'y', path, TRACK_DEFAULTS.coreHeight, 0.3, 200) })
    })
  }
  let huntCount = Math.min(cores.length, TRACK_DEFAULTS.huntMax)
  if (f.hunt !== undefined) {
    if (!isObj(f.hunt)) I.err('hunt', 'must be { count }')
    else {
      I.unknown(f.hunt, 'hunt', ['count'])
      huntCount = Math.round(I.num(f.hunt, 'count', 'hunt', huntCount, 0, 200))
      if (huntCount > cores.length) {
        I.warn('hunt.count', `asks for ${huntCount} cores but only ${cores.length} spots exist`)
        huntCount = cores.length
      }
    }
  }
  let startAt = 0
  if (f.start !== undefined) {
    if (!isObj(f.start)) I.err('start', 'must be { at }')
    else {
      I.unknown(f.start, 'start', ['at'])
      if (f.start.at !== undefined) startAt = atOk(f.start.at, 'start.at')
    }
  }

  if (I.errors.length || !roadOut || !envOut) return { ok: false, errors: I.errors, warnings: I.warnings }

  const track = {
    format: TRACK_FORMAT,
    version: TRACK_VERSION,
    id: f.id as string,
    name: (f.name as string).trim(),
    ...(typeof f.author === 'string' ? { author: f.author } : {}),
    ...(typeof f.description === 'string' ? { description: f.description } : {}),
    laps,
    road: roadOut,
    pieces,
    props,
    cores,
    hunt: { count: huntCount },
    start: { at: startAt },
    environment: envOut,
  } as unknown as ResolvedTrackFile

  geometryWarnings(I, track)
  return { ok: true, errors: [], warnings: I.warnings, track }
}

function validateEnvironment(I: Issues, e: Obj, id: string): ResolvedTrackFile['environment'] | null {
  I.unknown(e, 'environment', ['seed', 'size', 'terrain', 'sky', 'palette', 'city', 'stadium', 'roadside', 'music'])
  const seed = e.seed === undefined ? hashString(id) : isNum(e.seed) ? Math.floor(e.seed) >>> 0 : (I.err('environment.seed', 'must be a number'), 0)
  const size = I.num(e, 'size', 'environment', TRACK_DEFAULTS.worldSize, 400, 6000)

  if (!isObj(e.terrain)) {
    I.err('environment.terrain', "is required: { kind: 'hills' } or { kind: 'flat' }")
    return null
  }
  const t = e.terrain
  I.unknown(t, 'environment.terrain', ['kind', 'height', 'relief', 'scale', 'features', 'edge'])
  if (t.kind !== 'hills' && t.kind !== 'flat') I.err('environment.terrain.kind', "must be 'hills' or 'flat'")
  const kind = t.kind === 'flat' ? 'flat' : 'hills'
  const features: TerrainFeature[] = []
  if (t.features !== undefined && !Array.isArray(t.features)) I.err('environment.terrain.features', 'must be a list')
  else if (Array.isArray(t.features)) {
    t.features.forEach((ft, i) => {
      const path = `environment.terrain.features[${i}]`
      if (!isObj(ft) || !isNum(ft.x) || !isNum(ft.z)) {
        I.err(path, 'must have a type and numbers x, z')
        return
      }
      if (Math.abs(ft.x) > size / 2 || Math.abs(ft.z) > size / 2) I.warn(path, 'is outside the world')
      switch (ft.type) {
        case 'hill':
        case 'mesa':
          I.unknown(ft, path, ['type', 'x', 'z', 'radius', 'height'])
          if (!isNum(ft.radius) || !isNum(ft.height)) I.err(path, 'needs radius and height')
          else features.push({ type: ft.type, x: ft.x, z: ft.z, radius: I.num(ft, 'radius', path, 60, 5, 2000), height: I.num(ft, 'height', path, 10, -200, 400) })
          break
        case 'bowl':
          I.unknown(ft, path, ['type', 'x', 'z', 'radius', 'depth'])
          if (!isNum(ft.radius) || !isNum(ft.depth)) I.err(path, 'needs radius and depth')
          else features.push({ type: 'bowl', x: ft.x, z: ft.z, radius: I.num(ft, 'radius', path, 60, 5, 2000), depth: I.num(ft, 'depth', path, 8, -200, 200) })
          break
        case 'bigAir':
          I.unknown(ft, path, ['type', 'x', 'z', 'headingDeg', 'scale'])
          if (!isNum(ft.headingDeg)) I.err(`${path}.headingDeg`, 'is required (0 = north, 90 = east)')
          else features.push({ type: 'bigAir', x: ft.x, z: ft.z, headingDeg: ft.headingDeg, scale: I.num(ft, 'scale', path, 1, 0.3, 3) })
          break
        default:
          I.err(`${path}.type`, "must be 'hill', 'bowl', 'mesa' or 'bigAir'")
      }
    })
  }
  const terrain = {
    kind,
    height: I.num(t, 'height', 'environment.terrain', 0, -500, 1000),
    relief: I.num(t, 'relief', 'environment.terrain', TRACK_DEFAULTS.terrainRelief, 0, 120),
    scale: I.num(t, 'scale', 'environment.terrain', TRACK_DEFAULTS.terrainScale, 30, 4000),
    edge: I.oneOf(t, 'edge', 'environment.terrain', ['ridge', 'wall'] as const, kind === 'flat' ? 'wall' : 'ridge'),
    features,
  } as ResolvedTrackFile['environment']['terrain']

  const sky = isObj(e.sky) ? e.sky : {}
  if (e.sky !== undefined && !isObj(e.sky)) I.err('environment.sky', 'must be an object')
  I.unknown(sky, 'environment.sky', ['timeOfDay', 'sunAzimuthDeg', 'planetAzimuthDeg', 'planetElevationDeg'])
  const sunAz = I.num(sky, 'sunAzimuthDeg', 'environment.sky', 0, -360, 360)
  const skyOut = {
    timeOfDay: I.num(sky, 'timeOfDay', 'environment.sky', TRACK_DEFAULTS.timeOfDay, 0, 1),
    sunAzimuthDeg: sunAz,
    planetAzimuthDeg: I.num(sky, 'planetAzimuthDeg', 'environment.sky', sunAz + 40, -360, 400),
    planetElevationDeg: I.num(sky, 'planetElevationDeg', 'environment.sky', 16, 5, 85),
  }

  const pal = isObj(e.palette) ? e.palette : {}
  if (e.palette !== undefined && !isObj(e.palette)) I.err('environment.palette', 'must be an object')
  I.unknown(pal, 'environment.palette', ['edge', 'edgeAlt', 'grid', 'haze'])
  const palette = {
    edge: I.color(pal, 'edge', 'environment.palette', PALETTE.roadEdge),
    edgeAlt: I.color(pal, 'edgeAlt', 'environment.palette', PALETTE.roadEdgeAlt),
    grid: I.color(pal, 'grid', 'environment.palette', PALETTE.grid),
    haze: I.color(pal, 'haze', 'environment.palette', PALETTE.haze),
  }

  let city: ResolvedTrackFile['environment']['city'] = false
  if (e.city !== false) {
    const c = isObj(e.city) ? e.city : {}
    if (e.city !== undefined && !isObj(e.city)) I.err('environment.city', 'must be an object or false')
    I.unknown(c, 'environment.city', ['azimuthDeg', 'arcDeg', 'distance', 'density'])
    city = {
      azimuthDeg: I.num(c, 'azimuthDeg', 'environment.city', sunAz, -360, 360),
      arcDeg: I.num(c, 'arcDeg', 'environment.city', TRACK_DEFAULTS.cityArcDeg, 5, 360),
      distance: I.num(c, 'distance', 'environment.city', size * 2.2, size * 0.6, size * 8),
      density: I.num(c, 'density', 'environment.city', TRACK_DEFAULTS.cityDensity, 0, 1),
    }
  }

  let stadium: { standsHeight: number } | undefined
  if (e.stadium !== undefined) {
    if (!isObj(e.stadium)) I.err('environment.stadium', 'must be an object')
    else {
      I.unknown(e.stadium, 'environment.stadium', ['standsHeight'])
      stadium = { standsHeight: I.num(e.stadium, 'standsHeight', 'environment.stadium', TRACK_DEFAULTS.standsHeight, 4, 120) }
    }
  }

  const rs = isObj(e.roadside) ? e.roadside : {}
  if (e.roadside !== undefined && !isObj(e.roadside)) I.err('environment.roadside', 'must be an object')
  I.unknown(rs, 'environment.roadside', ['posts', 'billboards'])
  let posts: { spacing: number } | false = { spacing: TRACK_DEFAULTS.postSpacing }
  if (rs.posts === false) posts = false
  else if (rs.posts !== undefined) {
    if (!isObj(rs.posts)) I.err('environment.roadside.posts', 'must be { spacing } or false')
    else posts = { spacing: I.num(rs.posts, 'spacing', 'environment.roadside.posts', TRACK_DEFAULTS.postSpacing, 8, 500) }
  }
  const billboards = Math.round(I.num(rs, 'billboards', 'environment.roadside', TRACK_DEFAULTS.billboards, 0, 40))

  const mu = isObj(e.music) ? e.music : {}
  if (e.music !== undefined && !isObj(e.music)) I.err('environment.music', 'must be an object')
  I.unknown(mu, 'environment.music', ['mood', 'bpm'])
  const mood = I.oneOf(mu, 'mood', 'environment.music', ['cruise', 'drive', 'race', 'hyper'] as const, 'drive')
  const music = { mood, bpm: I.num(mu, 'bpm', 'environment.music', MOOD_BPM[mood], 60, 200) }

  return {
    seed,
    size,
    terrain,
    sky: skyOut,
    palette,
    city,
    ...(stadium ? { stadium } : {}),
    roadside: { posts, billboards },
    music,
  }
}

/**
 * Warnings that need the road's shape: tight corners, loops on bends or slopes,
 * pieces on the start grid, a road running into the edge mountains, crossings.
 * Uses a flat (x, z) spline: cheap enough to run on every editor change.
 */
function geometryWarnings(I: Issues, t: ResolvedTrackFile): void {
  const pts = t.road.points
  const dense = sampleClosedSpline(
    pts.map((p) => ({ x: p.x, y: 0, z: p.z })),
    1,
  )
  const n = dense.count - 1
  const L = dense.length
  const half = t.environment.size / 2

  // Tightest corner, from three points 6 m apart (circumradius).
  const step = Math.max(1, Math.round(6 / (L / n)))
  let worst = Infinity
  let worstAt = 0
  for (let i = 0; i < n; i++) {
    const a = (i - step + n) % n
    const b = (i + step) % n
    const ax = dense.x[a]
    const az = dense.z[a]
    const bx = dense.x[i]
    const bz = dense.z[i]
    const cx = dense.x[b]
    const cz = dense.z[b]
    const area2 = Math.abs((bx - ax) * (cz - az) - (bz - az) * (cx - ax))
    if (area2 < 1e-6) continue
    const R = (Math.hypot(bx - ax, bz - az) * Math.hypot(cx - bx, cz - bz) * Math.hypot(cx - ax, cz - az)) / (2 * area2)
    if (R < worst) {
      worst = R
      worstAt = dense.at[i]
    }
  }
  if (worst < MIN_RADIUS) I.warn('road.points', `the corner near point ${worstAt.toFixed(1)} has a ${worst.toFixed(0)} m radius; keep corners above ${MIN_RADIUS} m or cars will struggle`)

  // The world edge: keep the road clear of the edge mountains or the stadium wall.
  const bound = roadBound(t.environment)
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]
    const r = Math.max(Math.abs(p.x), Math.abs(p.z))
    if (r > bound.limit) I.warn(`road.points[${i}]`, `is ${(half - r).toFixed(0)} m from the world edge; the road may run into the ${t.environment.terrain.edge === 'ridge' ? 'mountains' : 'wall'}`)
  }

  // Self-crossings in plan view (fine for bridges; warn so the author adds height).
  const stride = 4
  for (let i = 0; i < n; i += stride) {
    const i2 = Math.min(n, i + stride)
    for (let j = i + stride * 8; j < n - stride * 4; j += stride) {
      if (i < stride * 4 && j > n - stride * 8) continue
      const j2 = Math.min(n, j + stride)
      if (segmentsCross(dense.x[i], dense.z[i], dense.x[i2], dense.z[i2], dense.x[j], dense.z[j], dense.x[j2], dense.z[j2])) {
        // Both roads stand on the same patch of ground, so their height difference
        // is the difference in lift (when neither uses an absolute y).
        const la = liftAt(pts, dense.at[i])
        const lb = liftAt(pts, dense.at[j])
        if (la === null || lb === null) {
          I.warn('road.points', `the road crosses itself near point ${dense.at[i].toFixed(1)} and point ${dense.at[j].toFixed(1)}; check one passes at least 7 m over the other (bun run tracks:check measures it)`)
        } else if (Math.abs(la - lb) < BRIDGE_MIN) {
          I.warn('road.points', `the road crosses itself near point ${dense.at[i].toFixed(1)} and point ${dense.at[j].toFixed(1)} only ${Math.abs(la - lb).toFixed(1)} m apart in height: give one of them ${BRIDGE_MIN} m or more of lift to make a bridge`)
        }
      }
    }
  }

  // Pieces: loops on level straights, nothing but boosts and traps on the grid.
  const sOfAt = (at: number) => arcLengthAtParam(dense, at)
  const sStart = sOfAt(t.start.at)
  const wrap = (d: number) => ((d % L) + L * 1.5) % L - L / 2
  const curvAt = (s: number): number => {
    // Heading change over +/-20 m.
    const i0 = Math.round((((s - 20) % L) + L) % L / (L / n)) % n
    const i1 = Math.round((((s + 20) % L) + L) % L / (L / n)) % n
    const h0 = Math.atan2(dense.x[(i0 + 1) % n] - dense.x[i0], -(dense.z[(i0 + 1) % n] - dense.z[i0]))
    const h1 = Math.atan2(dense.x[(i1 + 1) % n] - dense.x[i1], -(dense.z[(i1 + 1) % n] - dense.z[i1]))
    let d = h1 - h0
    if (d > Math.PI) d -= Math.PI * 2
    if (d < -Math.PI) d += Math.PI * 2
    return Math.abs(d) / 40
  }
  /** Sideways distance from the point at s1 to a dead-straight line leaving the road at s0 along its heading. */
  const straightLineMiss = (s0: number, s1: number): number => {
    const i0 = Math.round((((s0 % L) + L) % L) / (L / n)) % n
    const i1 = Math.round((((s1 % L) + L) % L) / (L / n)) % n
    const hx = dense.x[(i0 + 1) % n] - dense.x[i0]
    const hz = dense.z[(i0 + 1) % n] - dense.z[i0]
    const hl = Math.hypot(hx, hz) || 1
    return Math.abs((hx * (dense.z[i1] - dense.z[i0]) - hz * (dense.x[i1] - dense.x[i0])) / hl)
  }
  t.pieces.forEach((p, i) => {
    const s = sOfAt(p.at)
    const fromStart = wrap(s - sStart)
    if (p.type !== 'boost' && p.type !== 'speedtrap' && fromStart > -70 && fromStart < 25) {
      I.warn(`pieces[${i}]`, `this ${p.type} is on or next to the start grid; move it at least 70 m before or 25 m after the line`)
    }
    if (p.type === 'loop') {
      // The run-in: a car aiming straight down the LOOP_RUN_IN metres before the mouth
      // must arrive in it (tracks:check --physics drives exactly this, from 2 m either
      // side of the middle). How far off the middle does a dead-straight line land?
      const miss = straightLineMiss(s - LOOP_RUN_IN, s)
      const a0 = Math.floor(p.at) % pts.length
      const a1 = (a0 + 1) % pts.length
      const halfW = Math.min(pts[a0].width ?? t.road.width, pts[a1].width ?? t.road.width) / 2
      if (miss > halfW - 3) {
        I.warn(`pieces[${i}]`, `a car aiming straight down the ${LOOP_RUN_IN} m before this loop arrives ${miss.toFixed(1)} m off the middle of its mouth; loops need a straight run-in (put the points before it in a line)`)
      }
      // The loop itself and where it comes down must be straight too.
      const land = loopShape(p.radius ?? TRACK_DEFAULTS.loopRadius).advance + 20
      let maxK = 0
      for (let d = 0; d <= land; d += 5) maxK = Math.max(maxK, curvAt(s + d))
      if (maxK > 1 / 400) I.warn(`pieces[${i}]`, `this loop sits on a bend (radius ~${(1 / maxK).toFixed(0)} m); the loop and the ${land.toFixed(0)} m after its at need a straight`)
      const a = Math.floor(p.at)
      const b = (a + 1) % pts.length
      const ya = pts[a].y ?? pts[a].lift ?? 0
      const yb = pts[b].y ?? pts[b].lift ?? 0
      if (Math.abs(ya - yb) > 3) I.warn(`pieces[${i}]`, 'this loop sits between points at different heights; loops need level ground')
    }
    if (p.type === 'wallride') {
      const mid = s + (p.length ?? 120) / 2
      if (curvAt(mid) < 1 / 800) I.warn(`pieces[${i}]`, 'wall rides work best round the outside of a long bend; this one is on a straight')
    }
    if (p.type === 'ramp' && Math.abs(p.offset ?? 0) + (p.width ?? 8) / 2 > (t.road.width ?? 14) / 2 + 0.5) {
      I.warn(`pieces[${i}]`, 'this ramp sticks out past the road edge')
    }
  })
  // Two pieces overlapping (loops, wall rides and ramps need their own bit of road).
  const spans: { i: number; type: string; s0: number; s1: number }[] = []
  t.pieces.forEach((p, i) => {
    const s = sOfAt(p.at)
    if (p.type === 'loop') spans.push({ i, type: p.type, s0: s - LOOP_RUN_IN, s1: s + loopShape(p.radius ?? TRACK_DEFAULTS.loopRadius).advance + 20 })
    else if (p.type === 'wallride') spans.push({ i, type: p.type, s0: s, s1: s + (p.length ?? 120) })
    else if (p.type === 'ramp') spans.push({ i, type: p.type, s0: s - (p.length ?? 12) / 2 - 5, s1: s + (p.length ?? 12) / 2 + 5 })
  })
  for (let a = 0; a < spans.length; a++) {
    for (let b = a + 1; b < spans.length; b++) {
      const A = spans[a]
      const B = spans[b]
      const d = wrap(B.s0 - A.s0)
      const overlap = d >= 0 ? d < A.s1 - A.s0 : -d < B.s1 - B.s0
      if (overlap) I.warn(`pieces[${B.i}]`, `this ${B.type} overlaps pieces[${A.i}] (${A.type}); give each its own stretch of road`)
    }
  }
}

/** Height a crossing needs: slab (1.2 m) plus 5 m of room for a car underneath (tracks:check measures the same). */
const BRIDGE_MIN = 6.2

/**
 * The world-edge rule for road points, in one place (the validator and the road
 * editor both use it). A road point is comfortably inside the world when
 * max(|x|, |z|) <= limit. With a ridge edge the mountains start rising about
 * 0.15 x size + 30 m in from the edge (the span is clamp(0.15 x size, 170, 300)
 * and the crest sits 30 m in, see terrain.ts), and the road keeps 40 m more.
 * A stadium wall sits 25 m in; the road keeps 15 m more.
 */
export function roadBound(environment: { size?: number; terrain?: { kind?: string; edge?: string } }): {
  half: number
  margin: number
  limit: number
} {
  const size = environment.size ?? TRACK_DEFAULTS.worldSize
  const half = size / 2
  const kind = environment.terrain?.kind === 'flat' ? 'flat' : 'hills'
  const edge = environment.terrain?.edge ?? (kind === 'flat' ? 'wall' : 'ridge')
  const margin = edge === 'ridge' ? Math.min(300, Math.max(170, size * 0.15)) + 30 + 40 : 40
  return { half, margin, limit: half - margin }
}

/** Lift at a control-point position, blended like the builder does; null if a point there uses absolute y. */
function liftAt(pts: ResolvedTrackFile['road']['points'], at: number): number | null {
  const n = pts.length
  const a = ((at % n) + n) % n
  const i = Math.floor(a) % n
  const j = (i + 1) % n
  if (typeof pts[i].y === 'number' || typeof pts[j].y === 'number') return null
  const w = (1 - Math.cos(Math.PI * (a - Math.floor(a)))) / 2
  return (pts[i].lift ?? 0) + ((pts[j].lift ?? 0) - (pts[i].lift ?? 0)) * w
}

function segmentsCross(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): boolean {
  const d1 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx)
  const d2 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx)
  const d3 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax)
  const d4 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax)
  return d1 * d2 < 0 && d3 * d4 < 0
}
