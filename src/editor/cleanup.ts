// ============================================================
//  STROKE CLEAN-UP - turns a wobbly pencil line into a race track
// ------------------------------------------------------------
//  When you draw a road in the editor, your hand is not a robot:
//  the line wobbles, the corners are too sharp for a car, the end
//  never quite meets the start, and it might wander off the edge of
//  the world or cross itself. cleanStroke() fixes all of that and
//  hands back the control points the track file stores.
//
//  The steps, in order (each one is a small function below):
//    1. tidy     - drop broken points and duplicates
//    2. close    - join the end back to the start (trimming any overlap)
//    3. smooth   - iron out hand wobble
//    4. relax    - open up corners tighter than the minimum radius,
//                  push apart bits of road that run too close together,
//                  and keep everything inside the world
//    5. cross    - find where the road crosses itself; lift one branch
//                  into a bridge, or flag it if a bridge can't fit
//    6. start    - put the start line on a straight
//    7. points   - pick evenly spaced control points for the file
//
//  It is pure: points in, points out. The same pipeline cleans the
//  road the car lays in "drive to draw" mode. Checks live in
//  selfTest.ts and run with `bun src/editor/selfTest.ts`.
// ============================================================

import type { RoadPoint } from '../track/schema'
import {
  type P,
  arcLengths,
  catmullRomClosed,
  dist,
  minRadius,
  pointAt,
  polylineLength,
  gaussianSmoothClosed,
  resample,
  segmentIntersection,
  turnAngle,
} from './geom'

/** The clean-up's knobs. The defaults make roads a car can actually drive. */
export const CLEANUP = {
  /** Metres between the control points written to the file. */
  spacing: 16,
  /** No corner tighter than this radius, metres (measured on the centreline, like the track validator does). */
  minRadius: 25,
  /**
   * Corners are opened to this many times minRadius while cleaning. The game
   * runs a smooth curve through the control points, and with points 16 m
   * apart that curve can bend up to about a quarter tighter than the cleaned
   * line where a straight meets a corner, so we leave room for it.
   */
  cornerMargin: 1.35,
  /** Shortest road we accept, metres (a 25 m circle is 157 m round, so this leaves room). */
  minLength: 260,
  /** Keep the road this many metres further in than the world bound. */
  worldMargin: 10,
  /** If the end of the line comes within this many metres of the start, they join there. */
  joinGap: 70,
  /** How far from each end of the line we look for that join, metres. */
  endWindow: 90,
  /** Working spacing while relaxing corners, metres (small = precise, big = fast). */
  fine: 4,
  /**
   * How much hand wobble to iron out, metres. The editor sets this from the
   * zoom (a wobble of a few pixels is more metres when zoomed out).
   */
  smoothing: 12,
  /** Bridges: how high the upper road goes, and how long each ramp up to it is, metres. */
  bridgeLift: 8,
  bridgeRamp: 80,
  /** Crossings flatter than this angle can't be bridged (the roads would overlap for too long). */
  minCrossDeg: 28,
  /** Gap kept between the edges of two bits of road that run side by side, metres. */
  clearance: 4,
}

export type CleanupOptions = typeof CLEANUP & {
  /** Road width in metres (the file's road.width). */
  width: number
  /**
   * How far the road may reach from the map centre along x or z, metres
   * (a square: see roadBound() in draftFile.ts). Infinity = no limit.
   */
  bound: number
  /** Optional round limit too: the world's reachable radius (TrackRuntime.world.playRadius). */
  playRadius: number
}

export type IssueLevel = 'error' | 'warning' | 'note'

/** Something the clean-up wants Josh to know, in plain words, pinned to a spot on the map. */
export interface StrokeIssue {
  level: IssueLevel
  code:
    | 'too-short'
    | 'too-few-points'
    | 'joined-far'
    | 'trimmed'
    | 'kept-inside'
    | 'tight-corner'
    | 'too-close'
    | 'bridged'
    | 'shallow-crossing'
    | 'bridge-conflict'
  message: string
  at?: P
}

/** A place where the road crosses itself. s values are metres along the cleaned road from the start line. */
export interface Crossing {
  at: P
  /** The two passes through the crossing, first and second in driving order. */
  sA: number
  sB: number
  /** Angle between the two roads, 0..90 degrees. */
  angleDeg: number
  /** Which pass became the bridge, or null if it could not be bridged. */
  over: 'A' | 'B' | null
}

export interface CleanResult {
  ok: boolean
  /** Control points for road.points, in driving order; point 0 is the start line. */
  points: RoadPoint[]
  /** The cleaned centreline at fine spacing (for drawing the preview), starting at the start line. */
  dense: P[]
  length: number
  /** Tightest corner radius of the road the file will actually build (metres). */
  tightestRadius: number
  crossings: Crossing[]
  issues: StrokeIssue[]
}

// ---------------------------------------------------------------- the pipeline

export function cleanStroke(raw: readonly P[], options: Partial<CleanupOptions> = {}): CleanResult {
  const o: CleanupOptions = { ...CLEANUP, width: 14, bound: Infinity, playRadius: Infinity, ...options }
  const issues: StrokeIssue[] = []
  const fail = (issue: StrokeIssue): CleanResult => ({
    ok: false,
    points: [],
    dense: [],
    length: 0,
    tightestRadius: 0,
    crossings: [],
    issues: [issue],
  })

  // 1. tidy
  const pts = tidy(raw)
  if (pts.length < 3) {
    return fail({ level: 'error', code: 'too-few-points', message: 'Draw a road first: press and drag to draw a loop.' })
  }
  const drawnLength = polylineLength(pts, false)
  if (drawnLength < o.minLength) {
    return fail({
      level: 'error',
      code: 'too-short',
      message: `That road is only ${Math.round(drawnLength)} m long. Draw a bigger loop (at least ${o.minLength} m).`,
      at: pts[0],
    })
  }

  // 2. close the loop
  const closed = closeStroke(pts, o, issues)
  if (polylineLength(closed, true) < o.minLength) {
    return fail({
      level: 'error',
      code: 'too-short',
      message: `Once the ends are joined that loop is only ${Math.round(polylineLength(closed, true))} m round. Draw a bigger loop.`,
      at: pts[0],
    })
  }

  // 3. smooth (on an even spacing first, so every bit of the line counts the same)
  const limit: WorldLimit = {
    square: Math.max(80, o.bound - o.worldMargin),
    radius: Math.max(80, o.playRadius - o.width / 2 - o.worldMargin),
  }
  let smoothed = resample(closed, o.fine, true)
  smoothed = gaussianSmoothClosed(smoothed, o.smoothing)
  const movedIn = keepInside(smoothed, limit)
  if (movedIn > 5) {
    issues.push({ level: 'note', code: 'kept-inside', message: 'Part of the road went past the edge of the world, so it was pulled back in.' })
  }

  // 4-7, with a wider corner margin if the built road still comes out too tight.
  let shaped = shapeRoad(smoothed, pts[0], o, limit, o.cornerMargin)
  for (let attempt = 1; attempt <= 3 && shaped.tight.radius < o.minRadius; attempt++) {
    const wider = shapeRoad(smoothed, pts[0], o, limit, o.cornerMargin + 0.2 * attempt)
    if (wider.tight.radius > shaped.tight.radius) shaped = wider
  }
  const { loop, points, crossings, length, tight } = shaped
  issues.push(...shaped.issues)
  if (tight.radius < o.minRadius) {
    issues.push({
      level: 'warning',
      code: 'tight-corner',
      message: `One corner is still tight (${Math.round(tight.radius)} m radius). Try redrawing it wider.`,
      at: tight.at,
    })
  }
  for (const near of findTooClose(loop, crossings, o)) issues.push(near)

  const ok = !issues.some((i) => i.level === 'error')
  return { ok, points, dense: loop, length, tightestRadius: tight.radius, crossings, issues }
}

/** Steps 4 to 7 on the smoothed loop, with corners opened to `margin` x minRadius. */
function shapeRoad(smoothed: P[], drawnStart: P, o: CleanupOptions, limit: WorldLimit, margin: number) {
  const issues: StrokeIssue[] = []

  // 4. relax corners, spacing and the world edge
  let loop = relax(smoothed, o, limit, margin)

  // 5. crossings and bridges
  const crossings = findCrossings(loop)
  const spans = planBridges(loop, crossings, o, issues)

  // 6. start line on a straight, then make it point 0
  const startIndex = pickStart(loop, crossings, drawnStart, o)
  loop = [...loop.slice(startIndex), ...loop.slice(0, startIndex)]
  const length = polylineLength(loop, true)
  const shift = (s: number) => wrap(s - startIndex * (length / loop.length), length)
  for (const span of spans) span.s = shift(span.s)
  for (const c of crossings) {
    c.sA = shift(c.sA)
    c.sB = shift(c.sB)
    if (c.sA > c.sB) {
      ;[c.sA, c.sB] = [c.sB, c.sA]
      c.over = c.over === 'A' ? 'B' : c.over === 'B' ? 'A' : null
    }
  }

  // 7. control points for the file, evenly spaced
  const count = Math.max(8, Math.round(length / o.spacing))
  const points: RoadPoint[] = []
  for (let k = 0; k < count; k++) {
    const s = (k * length) / count
    const p = pointAt(loop, s, true)
    const point: RoadPoint = { x: round1(p.x), z: round1(p.z) }
    const lift = liftAt(s, spans, length, o)
    if (lift > 0.05) point.lift = round1(lift)
    points.push(point)
  }

  // Measure the road the file will really build: the smooth curve through the control points.
  const built = catmullRomClosed(points, 8)
  const m = minRadius(built, 12)
  const tight = { radius: m.radius, at: built[Math.max(0, m.index)] }
  return { loop, points, crossings, length, tight, issues }
}

// ---------------------------------------------------------------- 1. tidy

/** Drop non-numbers and points that sit on top of the one before. */
export function tidy(raw: readonly P[]): P[] {
  const out: P[] = []
  for (const p of raw) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) continue
    if (out.length && dist(out[out.length - 1], p) < 0.3) continue
    out.push({ x: p.x, z: p.z })
  }
  return out
}

// ---------------------------------------------------------------- 2. close

/**
 * Join the end of the line back to the start. Josh rarely lands exactly on
 * the start: he stops short or overshoots. We look near both ends for the
 * spot where they come closest (an overshoot actually crosses, distance 0),
 * cut off anything past it, and let the smoothing blend the join. If the
 * ends are far apart, the road runs back to the start on its own.
 */
function closeStroke(pts: P[], o: CleanupOptions, issues: StrokeIssue[]): P[] {
  const line = resample(pts, 2, false)
  const arcs = arcLengths(line)
  const total = arcs[arcs.length - 1]
  const window = Math.min(o.endWindow, total * 0.15)
  let best = { i: 0, j: line.length - 1, d: dist(line[0], line[line.length - 1]) }
  for (let i = 0; i < line.length && arcs[i] <= window; i++) {
    for (let j = line.length - 1; j > i && total - arcs[j] <= window; j--) {
      const d = dist(line[i], line[j])
      if (d < best.d) best = { i, j, d }
    }
  }
  if (best.d <= o.joinGap) {
    const trimmed = arcs[best.i] + (total - arcs[best.j])
    if (trimmed > 10) {
      issues.push({ level: 'note', code: 'trimmed', message: 'The ends overlapped, so the extra bit was trimmed off.', at: line[best.i] })
    }
    return line.slice(best.i, best.j + 1)
  }
  issues.push({
    level: 'note',
    code: 'joined-far',
    message: `The end was ${Math.round(best.d)} m from the start, so the road was joined back to the start for you.`,
    at: line[line.length - 1],
  })
  return line
}

// ---------------------------------------------------------------- 4. relax

/** Where the road may go: inside a square (the track validator's world bound) and a circle. */
interface WorldLimit {
  square: number
  radius: number
}

/** Pull any point past the world edge back inside it. Returns the furthest a point moved. */
function keepInside(pts: P[], limit: WorldLimit): number {
  let moved = 0
  for (const p of pts) {
    const x0 = p.x
    const z0 = p.z
    p.x = Math.max(-limit.square, Math.min(limit.square, p.x))
    p.z = Math.max(-limit.square, Math.min(limit.square, p.z))
    const r = Math.hypot(p.x, p.z)
    if (r > limit.radius) {
      p.x *= limit.radius / r
      p.z *= limit.radius / r
    }
    moved = Math.max(moved, Math.hypot(p.x - x0, p.z - z0))
  }
  return moved
}

/**
 * Open up tight corners until every corner is at least minRadius, and keep
 * separate bits of road apart. Two rules, applied a little at a time, over
 * and over, until the road settles (like easing a bent wire straight):
 *
 *  - Corner rule: a point that turns more sharply than a minRadius corner
 *    allows is eased toward the middle of its two neighbours. Repeated,
 *    this rounds a sharp corner off on the inside, the way a real road
 *    would cut it.
 *  - Spacing rule (see separate()): two stretches of road that are far
 *    apart along the track but close on the map are pushed apart. Running
 *    side by side, they only need room for both roads. Coming back the
 *    other way just after a U-turn (a hairpin), they need room for the
 *    turn itself, so a hairpin too narrow for a car opens into a rounded
 *    "bulb" instead of shrinking away.
 *
 * Every point is also kept inside the world.
 */
function relax(input: P[], o: CleanupOptions, limit: WorldLimit, margin: number): P[] {
  let pts = resample(input, o.fine, true)
  // Aim wider than the minimum (see CLEANUP.cornerMargin).
  const R = o.minRadius * margin
  const maxTurn = 2 * Math.asin(Math.min(1, o.fine / (2 * R)))
  const startLength = polylineLength(pts, true)
  const MAX_ITERS = 2000
  for (let iter = 0; iter < MAX_ITERS; iter++) {
    const n = pts.length
    // Corner rule.
    let worstTurn = 0
    const next = new Array<P>(n)
    for (let i = 0; i < n; i++) {
      const a = pts[(i - 1 + n) % n]
      const b = pts[i]
      const c = pts[(i + 1) % n]
      const turn = Math.abs(turnAngle(a, b, c))
      if (turn > worstTurn) worstTurn = turn
      next[i] = turn <= maxTurn ? b : { x: b.x + 0.25 * ((a.x + c.x) / 2 - b.x), z: b.z + 0.25 * ((a.z + c.z) / 2 - b.z) }
    }
    pts = next
    // Spacing rule.
    const pushed = separate(pts, R, o.width + o.clearance)
    keepInside(pts, limit)
    if (iter % 4 === 3) pts = resample(pts, o.fine, true)
    if (polylineLength(pts, true) > startLength * 3) break // runaway guard: the issues report what is left
    if (worstTurn < maxTurn * 1.05 && pushed < 0.05 && iter > 3) break
  }
  return resample(pts, o.fine, true)
}

/**
 * The spacing rule: bits of road that are close on the map but should not
 * be are pushed apart.
 *
 *  - The two sides of a U-turn. On a circle of radius R, two points that
 *    are s metres apart ALONG the road are 2R x sin(s / 2R) apart in a
 *    straight line. If a U-turn brings them closer than that, the turn is
 *    too tight, so they are pushed apart. Only pairs that have turned well
 *    past a right angle count: an ordinary corner is left to the corner
 *    rule, which rounds it off on the inside.
 *  - Further along than half a circle, the two sides still need room: 2R
 *    apart right after the turn, easing down to `gap` (two roads side by
 *    side). That is what turns a too-narrow hairpin into a "bulb".
 *  - Two stretches running the same way side by side: at least `gap`.
 *  - Roads crossing at a proper angle are left alone (that becomes a
 *    bridge). A crossing flatter than 35 degrees counts as side by side,
 *    so the push swings the roads round until they cross more squarely.
 *
 * Returns the biggest push made.
 */
function separate(pts: P[], R: number, gap: number): number {
  const n = pts.length
  const h = polylineLength(pts, true) / n
  const halfCircle = Math.PI * R
  const taper = 4 * R
  const cell = 2 * R
  const grid = new Map<string, number[]>()
  for (let i = 0; i < n; i++) {
    const k = `${Math.floor(pts[i].x / cell)},${Math.floor(pts[i].z / cell)}`
    const list = grid.get(k)
    if (list) list.push(i)
    else grid.set(k, [i])
  }
  const cosParallel = Math.cos((35 * Math.PI) / 180)
  const cosUTurn = Math.cos((107 * Math.PI) / 180)
  const moves = new Float64Array(n * 2)
  let biggest = 0
  for (let i = 0; i < n; i++) {
    const p = pts[i]
    const cx = Math.floor(p.x / cell)
    const cz = Math.floor(p.z / cell)
    const ti = tangent(pts, i)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const list = grid.get(`${cx + dx},${cz + dz}`)
        if (!list) continue
        for (const j of list) {
          if (j <= i) continue
          const sep = Math.min(j - i, n - (j - i)) * h
          if (sep < 2.5 * h) continue
          const q = pts[j]
          const d = dist(p, q)
          if (d < 0.5) continue
          const tj = tangent(pts, j)
          const dot = ti.x * tj.x + ti.z * tj.z
          let need: number
          if (sep < halfCircle) {
            if (dot > cosUTurn) continue
            need = 2 * R * Math.sin(sep / (2 * R))
          } else if (dot > cosParallel) need = gap
          else if (dot < -cosParallel) need = Math.max(gap, 2 * R - ((sep - halfCircle) / taper) * (2 * R - gap))
          else continue
          if (d >= need) continue
          const push = 0.3 * (need - d)
          const ux = (p.x - q.x) / d
          const uz = (p.z - q.z) / d
          moves[i * 2] += ux * push
          moves[i * 2 + 1] += uz * push
          moves[j * 2] -= ux * push
          moves[j * 2 + 1] -= uz * push
          if (push > biggest) biggest = push
        }
      }
    }
  }
  if (biggest > 0) {
    // Cap any one point's move per pass so many small pushes can't fling it.
    for (let i = 0; i < n; i++) {
      let mx = moves[i * 2]
      let mz = moves[i * 2 + 1]
      const m = Math.hypot(mx, mz)
      if (m > 2) {
        mx *= 2 / m
        mz *= 2 / m
      }
      pts[i].x += mx
      pts[i].z += mz
    }
  }
  return biggest
}

function tangent(pts: readonly P[], i: number): P {
  const n = pts.length
  const a = pts[(i - 1 + n) % n]
  const b = pts[(i + 1) % n]
  const d = Math.hypot(b.x - a.x, b.z - a.z) || 1
  return { x: (b.x - a.x) / d, z: (b.z - a.z) / d }
}

// ---------------------------------------------------------------- 5. crossings and bridges

/** Every place a closed polyline crosses itself (a figure-eight has one). */
export function findCrossings(pts: readonly P[]): Crossing[] {
  const n = pts.length
  const arcs = arcLengths([...pts, pts[0]])
  const cell = 24
  const grid = new Map<string, number[]>()
  for (let i = 0; i < n; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % n]
    const x0 = Math.floor(Math.min(a.x, b.x) / cell)
    const x1 = Math.floor(Math.max(a.x, b.x) / cell)
    const z0 = Math.floor(Math.min(a.z, b.z) / cell)
    const z1 = Math.floor(Math.max(a.z, b.z) / cell)
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const k = `${x},${z}`
        const list = grid.get(k)
        if (list) list.push(i)
        else grid.set(k, [i])
      }
    }
  }
  const seen = new Set<string>()
  const out: Crossing[] = []
  for (const list of grid.values()) {
    for (let p = 0; p < list.length; p++) {
      for (let q = p + 1; q < list.length; q++) {
        const i = Math.min(list[p], list[q])
        const j = Math.max(list[p], list[q])
        if (j - i < 2 || (i === 0 && j === n - 1)) continue
        const pair = `${i}:${j}`
        if (seen.has(pair)) continue
        seen.add(pair)
        const a = pts[i]
        const b = pts[(i + 1) % n]
        const c = pts[j]
        const d = pts[(j + 1) % n]
        const hit = segmentIntersection(a, b, c, d)
        if (!hit) continue
        const ux = b.x - a.x
        const uz = b.z - a.z
        const vx = d.x - c.x
        const vz = d.z - c.z
        const cos = Math.abs(ux * vx + uz * vz) / (Math.hypot(ux, uz) * Math.hypot(vx, vz) || 1)
        out.push({
          at: { x: a.x + ux * hit.t, z: a.z + uz * hit.t },
          sA: arcs[i] + hit.t * dist(a, b),
          sB: arcs[j] + hit.u * dist(c, d),
          angleDeg: (Math.acos(Math.min(1, cos)) * 180) / Math.PI,
          over: null,
        })
      }
    }
  }
  out.sort((x, y) => x.sA - y.sA)
  return out
}

/** A raised stretch of road centred on s (metres along the road). */
interface BridgeSpan {
  s: number
  /** Metres either side of s held at full height (over the other road). */
  flat: number
}

/**
 * Decide which road goes over at each crossing. The straighter pass is
 * lifted (a bridge on a bend is harder to drive), unless that clashes with
 * another crossing nearby where the same stretch has to stay low. If
 * neither way fits, the crossing is flagged for Josh to fix.
 */
function planBridges(pts: readonly P[], crossings: Crossing[], o: CleanupOptions, issues: StrokeIssue[]): BridgeSpan[] {
  const length = polylineLength(pts, true)
  const ups: BridgeSpan[] = []
  const downs: BridgeSpan[] = []
  for (const c of crossings) {
    if (c.angleDeg < o.minCrossDeg) {
      issues.push({
        level: 'warning',
        code: 'shallow-crossing',
        message: `The road crosses itself at a very flat angle (${Math.round(c.angleDeg)} degrees), too flat for a bridge. Redraw one side so they cross more squarely.`,
        at: c.at,
      })
      continue
    }
    const flat = (o.width / 2 + 3) / Math.sin((c.angleDeg * Math.PI) / 180) + 4
    const reach = flat + o.bridgeRamp
    const bendA = maxCurvatureNear(pts, c.sA, reach, length)
    const bendB = maxCurvatureNear(pts, c.sB, reach, length)
    const order: ('A' | 'B')[] = bendA <= bendB ? ['A', 'B'] : ['B', 'A']
    let chosen: 'A' | 'B' | null = null
    for (const side of order) {
      const upS = side === 'A' ? c.sA : c.sB
      const downS = side === 'A' ? c.sB : c.sA
      const upClash = downs.some((d) => Math.abs(deltaS(upS, d.s, length)) < reach + d.flat)
      const downClash = ups.some((u) => Math.abs(deltaS(downS, u.s, length)) < flat + u.flat + o.bridgeRamp)
      const selfClash = Math.abs(deltaS(upS, downS, length)) < reach + flat
      if (!upClash && !downClash && !selfClash) {
        chosen = side
        ups.push({ s: upS, flat })
        downs.push({ s: downS, flat })
        break
      }
    }
    c.over = chosen
    if (chosen) {
      issues.push({ level: 'note', code: 'bridged', message: 'The road crosses itself here, so one side became a bridge.', at: c.at })
    } else {
      issues.push({
        level: 'warning',
        code: 'bridge-conflict',
        message: 'The road crosses itself here too close to another crossing for a bridge to fit. Spread them out a bit.',
        at: c.at,
      })
    }
  }
  return ups
}

/** Height of the road above the ground at s: full height over the crossing, eased ramps either side. */
function liftAt(s: number, spans: readonly BridgeSpan[], length: number, o: CleanupOptions): number {
  let lift = 0
  for (const span of spans) {
    const d = Math.abs(deltaS(s, span.s, length))
    if (d <= span.flat) lift = Math.max(lift, o.bridgeLift)
    else if (d < span.flat + o.bridgeRamp) {
      const t = 1 - (d - span.flat) / o.bridgeRamp
      lift = Math.max(lift, o.bridgeLift * (0.5 - 0.5 * Math.cos(Math.PI * t)))
    }
  }
  return lift
}

/** Sharpest bend (1 / radius) within `reach` metres either side of s. */
function maxCurvatureNear(pts: readonly P[], s: number, reach: number, length: number): number {
  const n = pts.length
  const h = length / n
  const centre = Math.round(s / h)
  const steps = Math.ceil(reach / h)
  const k = Math.max(1, Math.round(5 / h))
  let worst = 0
  for (let d = -steps; d <= steps; d++) {
    const i = (((centre + d) % n) + n) % n
    const r = circumradiusAt(pts, i, k)
    worst = Math.max(worst, 1 / r)
  }
  return worst
}

function circumradiusAt(pts: readonly P[], i: number, k: number): number {
  const n = pts.length
  const a = pts[(i - k + n) % n]
  const b = pts[i]
  const c = pts[(i + k) % n]
  const cross = Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x))
  if (cross < 1e-9) return Infinity
  return (dist(a, b) * dist(b, c) * dist(c, a)) / (2 * cross)
}

/**
 * Stretches that run side by side so close their road edges touch, which
 * the relax step could not push apart (no room). Crossings are not counted:
 * they have their own issues.
 */
function findTooClose(pts: readonly P[], crossings: readonly Crossing[], o: CleanupOptions): StrokeIssue[] {
  const n = pts.length
  const length = polylineLength(pts, true)
  const h = length / n
  const minApart = Math.ceil((3 * (o.width + o.clearance)) / h)
  const touch = o.width + 1
  const out: StrokeIssue[] = []
  const reported: P[] = []
  for (let i = 0; i < n; i++) {
    for (let j = i + minApart; j < n; j++) {
      if (n - (j - i) < minApart) break
      if (dist(pts[i], pts[j]) >= touch) continue
      const mid = { x: (pts[i].x + pts[j].x) / 2, z: (pts[i].z + pts[j].z) / 2 }
      if (crossings.some((c) => dist(c.at, mid) < o.width * 2.5)) continue
      if (reported.some((r) => dist(r, mid) < 60)) continue
      reported.push(mid)
      out.push({
        level: 'warning',
        code: 'too-close',
        message: 'Two bits of road run so close here that they overlap. Pull one of them away.',
        at: mid,
      })
    }
  }
  return out
}

// ---------------------------------------------------------------- 6. start line

/**
 * The start line goes on a straight: the grid lines up behind it, so it
 * needs about 70 m of calm road behind and a bit in front. Of the straight
 * spots, the one nearest where Josh started drawing wins. Never on or under
 * a bridge.
 */
function pickStart(pts: readonly P[], crossings: readonly Crossing[], drawnStart: P, o: CleanupOptions): number {
  const n = pts.length
  const length = polylineLength(pts, true)
  const h = length / n
  const back = Math.ceil(70 / h)
  const ahead = Math.ceil(30 / h)
  const k = Math.max(1, Math.round(5 / h))
  const curv = new Float64Array(n)
  for (let i = 0; i < n; i++) curv[i] = 1 / circumradiusAt(pts, i, k)
  let bestStraight = -1
  let bestStraightDist = Infinity
  let bestAny = 0
  let bestAnyCurv = Infinity
  for (let i = 0; i < n; i++) {
    const s = i * h
    const clear = o.bridgeRamp + 3 * o.width + 80
    if (crossings.some((c) => Math.abs(deltaS(s, c.sA, length)) < clear || Math.abs(deltaS(s, c.sB, length)) < clear)) continue
    let worst = 0
    for (let d = -back; d <= ahead; d++) worst = Math.max(worst, curv[(((i + d) % n) + n) % n])
    if (worst < bestAnyCurv) {
      bestAnyCurv = worst
      bestAny = i
    }
    if (worst <= 1 / 180) {
      const dd = dist(pts[i], drawnStart)
      if (dd < bestStraightDist) {
        bestStraightDist = dd
        bestStraight = i
      }
    }
  }
  return bestStraight >= 0 ? bestStraight : bestAny
}

// ---------------------------------------------------------------- small helpers

function wrap(s: number, length: number): number {
  return ((s % length) + length) % length
}

/** Signed shortest distance from a to b around a loop of the given length. */
function deltaS(a: number, b: number, length: number): number {
  let d = wrap(b - a, length)
  if (d > length / 2) d -= length
  return d
}

function round1(v: number): number {
  return Math.round(v * 10) / 10
}
