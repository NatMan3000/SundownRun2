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
//                  into a bridge (a straight top on smooth ramps, over
//                  the ground it is given: deck.ts), or flag it if a
//                  bridge can't fit
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
import { type Deck, deckCrest, deckHeight, planDeck, tabulate } from './deck'

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
  /**
   * A last, gentle smoothing after the corners are opened, metres. It evens
   * out how sharply the road bends from one metre to the next, so banking
   * and Ai speeds flow instead of twitching.
   */
  fairing: 12,
  /**
   * Bridges: how high the upper road goes over the road under it, and how long each ramp
   * up to it is, metres (an underpass's dip goes as far down, on ramps as long). The top
   * of a bridge runs straight (deck.ts), so the hills under it don't show through, and its
   * ramps are shaped so a car at 250 km/h, the fastest the game expects anywhere, stays on
   * the road over the top (the Height tool's rule, PLAN_SHARE). The 80 m ramps bridges
   * used to have threw cars into the air above about 130 km/h.
   */
  bridgeLift: 8,
  bridgeRamp: 200,
  /**
   * Where 200 m ramps don't fit (another crossing too close, or they take the only straight
   * the start grid could have), the bridges get ramps this long instead, as long as a car
   * flat out still stays on over them; where it wouldn't, the 200 m ramps win and the start
   * grid goes on the gentlest bend (pickRamps). A bridge too sharp either way says so (the
   * 'steep-bridge' note).
   */
  bridgeRampShort: 160,
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
  /**
   * Which road goes over at crossings the road had before (bridges.ts
   * keepOverOf): a crossing found within 40 m of one, with a road heading the
   * same way, keeps that road on top instead of the automatic choice. Redrawing
   * a stretch passes these in, so a swapped bridge stays swapped. `under` marks
   * an underpass: the other road dips under this one, which stays on the ground.
   */
  keepOver?: readonly { at: P; heading: number; under?: boolean }[]
  /**
   * The ground a road point with no height of its own sits on (the draft's world: see
   * pointGroundFor in draft.ts). With it, each bridge's top runs straight between its
   * ramps whatever the hills under it do, and the steeper way round is avoided. Without
   * it the ground counts as flat (the lifts are then the bridge's height above it).
   */
  pointGround?: (x: number, z: number) => number
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
    | 'bridge-flipped'
    | 'steep-bridge'
    | 'bent-start'
    | 'too-tangled'
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
  const limit = worldLimit(o)
  let smoothed = resample(closed, o.fine, true)
  smoothed = gaussianSmoothClosed(smoothed, o.smoothing)
  const movedIn = keepInside(smoothed, limit)
  if (movedIn > 5) {
    issues.push({ level: 'note', code: 'kept-inside', message: 'Part of the road went past the edge of the world, so it was pulled back in.' })
  }

  // 4-7, with a wider corner margin if the built road still comes out too tight.
  // All the tries share one work budget (see RELAX_WORK), so a tangled drawing can't freeze the editor.
  const work: RelaxWork = { left: RELAX_WORK, ranOut: false }
  let shaped = shapeRoad(smoothed, pts[0], o, limit, o.cornerMargin, work)
  for (let attempt = 1; attempt <= 3 && shaped.tight.radius < o.minRadius && !work.ranOut; attempt++) {
    const wider = shapeRoad(smoothed, pts[0], o, limit, o.cornerMargin + 0.2 * attempt, work)
    if (wider.tight.radius > shaped.tight.radius) shaped = wider
  }
  const { loop, points, crossings, length, tight } = shaped
  issues.push(...shaped.issues)
  if (work.ranOut) {
    issues.push({
      level: 'warning',
      code: 'too-tangled',
      message: 'This drawing is too tangled to tidy up all the way, so some of it may be messy. Try a simpler loop that does not go back over itself.',
      at: pts[0],
    })
  }
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
function shapeRoad(smoothed: P[], drawnStart: P, o: CleanupOptions, limit: WorldLimit, margin: number, work: RelaxWork) {
  const issues: StrokeIssue[] = []

  // 4. relax corners, spacing and the world edge, then even out the bends
  let loop = relax(smoothed, o, limit, margin, work)
  if (o.fairing > 0) loop = resample(gaussianSmoothClosed(loop, o.fairing), o.fine, true)

  // 5. crossings and bridges, on the gentlest ramps that fit, and
  // 6. the start line on a straight clear of them (then it becomes point 0).
  // Each ramp length is planned in full, then the best is kept (see pickRamps).
  const ramps = [...new Set([o.bridgeRamp, Math.min(o.bridgeRamp, o.bridgeRampShort)])]
  const tries: RampTry[] = ramps.map((ramp) => {
    const used = { ...o, bridgeRamp: ramp }
    const tryIssues: StrokeIssue[] = []
    const found = findCrossings(loop)
    const planned = planBridges(loop, found, used, tryIssues)
    const start = pickStart(loop, found, drawnStart, used)
    return {
      ramp,
      crossings: found,
      spans: planned,
      start,
      issues: tryIssues,
      bridged: found.every((c) => c.over !== null || c.angleDeg < used.minCrossDeg),
      steep: planned.some((span) => span.steep),
    }
  })
  const chosen = pickRamps(tries)
  const { crossings, spans } = chosen
  const startIndex = chosen.start.index
  issues.push(...chosen.issues)
  // A bridge (or dip) whose ramps are too sharp for a car flat out, even with its straight top, says so.
  for (const span of spans) {
    if (!span.steep) continue
    issues.push({
      level: 'note',
      code: 'steep-bridge',
      message:
        chosen.ramp < o.bridgeRamp
          ? `There's no room here for the gentlest bridge ramps, so they are ${chosen.ramp} m long instead of ${o.bridgeRamp} m, and the ground makes them too sharp: a car going flat out may go light ${span.dip ? 'over the lip of the dip' : 'over the top'}. Draw the road with more room either side of the crossing to make them gentler.`
          : `The ground here makes this ${span.dip ? "underpass's dip" : "bridge's ramps"} too sharp: a car going flat out may go light ${span.dip ? 'over its lip' : 'over the top'}. Draw the crossing somewhere flatter to make them gentler.`,
      at: span.at,
    })
  }
  // Long ramps kept a car on the bridge, but took the only straight: the start grid is on the gentlest bend left.
  if (!chosen.start.straight && !chosen.steep && tries.some((t) => t !== chosen && t.start.straight)) {
    issues.push({
      level: 'note',
      code: 'bent-start',
      message: `The start line is on a gentle bend: the only straight here is part of the bridge's ${chosen.ramp} m ramps, and shorter ramps would throw a car going flat out off the top. Draw the road with a longer straight away from the crossing to start on.`,
      at: loop[startIndex],
    })
  }
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
    const lift = liftAt(s, point, spans, length, o.pointGround)
    // To the centimetre (like the shaping tools): a straight bridge top stays straight.
    if (Math.abs(lift) >= 0.01) point.lift = roundCm(lift)
    points.push(point)
  }

  // Measure the road the file will really build: the smooth curve through the control points.
  const built = catmullRomClosed(points, 8)
  const m = minRadius(built, 12)
  const tight = { radius: m.radius, at: built[Math.max(0, m.index)] }
  return { loop, points, crossings, length, tight, issues }
}

/** One ramp length planned in full: its bridges and where the start line goes. */
interface RampTry {
  ramp: number
  crossings: Crossing[]
  spans: BridgeSpan[]
  start: { index: number; straight: boolean }
  issues: StrokeIssue[]
  /** Every crossing steep enough to bridge got a bridge. */
  bridged: boolean
  /** Some bridge's ramps are still too sharp for a car flat out (deck.ts deckCrest). */
  steep: boolean
}

/**
 * Which ramp length to build (`tries` longest first). Best: every crossing
 * bridged, the start line on a straight, and no bridge that throws a car off.
 * Where no length gives all three, a bridge a car stays on matters more than a
 * straight start: the grid goes on the gentlest bend instead (the game's start
 * check warns about it, and the clean-up says why). Where every length is too
 * sharp somewhere, the longest that still bridges every crossing (the gentlest),
 * else the shortest.
 */
function pickRamps(tries: readonly RampTry[]): RampTry {
  return (
    tries.find((t) => t.bridged && t.start.straight && !t.steep) ??
    tries.find((t) => t.bridged && !t.steep) ??
    tries.find((t) => t.bridged) ??
    tries[tries.length - 1]
  )
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
export interface WorldLimit {
  square: number
  radius: number
}

/** The world limit for a set of clean-up options (the road's centreline stays this far in). */
export function worldLimit(o: Pick<CleanupOptions, 'bound' | 'playRadius' | 'width' | 'worldMargin'>): WorldLimit {
  return {
    square: Math.max(80, o.bound - o.worldMargin),
    radius: Math.max(80, o.playRadius - o.width / 2 - o.worldMargin),
  }
}

/**
 * The clean-up's corner, spacing and world-edge rules (step 4) on a road
 * that is already a closed loop. Smooth (shape.ts) uses it so a smoothed
 * road obeys exactly the same rules as a freshly drawn one.
 */
export function relaxLoop(loop: readonly P[], options: Partial<CleanupOptions>, margin = CLEANUP.cornerMargin): P[] {
  const o: CleanupOptions = { ...CLEANUP, width: 14, bound: Infinity, playRadius: Infinity, ...options }
  return relax(loop.map((p) => ({ x: p.x, z: p.z })), o, worldLimit(o), margin, { left: RELAX_WORK, ranOut: false })
}

/**
 * How much work the relax step may do for one clean-up, counted in pairs of
 * road points the spacing rule looks at. An ordinary drawing settles using
 * one to six million. The self-test's hardest fixture (a hairpin that never
 * quite settles and runs all 2000 passes) uses about 60 million, so this
 * leaves it plenty of room and it comes out exactly as before. A drawing that
 * goes back over itself can keep pushing its doubled road apart without ever
 * settling: that used to take 20 to 55 seconds and froze the editor. Now it
 * stops here, in about a second at worst, and says so (the 'too-tangled'
 * warning). The self-test times one (its "tangled drawing" row).
 */
export const RELAX_WORK = 150_000_000

/** The relax step's work budget, shared by every try in one clean-up. */
export interface RelaxWork {
  left: number
  /** True once the budget ran out (the road was left as it was then). */
  ranOut: boolean
}

/** Pull any point past the world edge back inside it. Returns the furthest a point moved. */
export function keepInside(pts: P[], limit: WorldLimit): number {
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
function relax(input: P[], o: CleanupOptions, limit: WorldLimit, margin: number, work: RelaxWork): P[] {
  let pts = resample(input, o.fine, true)
  // Aim wider than the minimum (see CLEANUP.cornerMargin).
  const R = o.minRadius * margin
  const maxTurn = 2 * Math.asin(Math.min(1, o.fine / (2 * R)))
  const startLength = polylineLength(pts, true)
  const MAX_ITERS = 2000
  for (let iter = 0; iter < MAX_ITERS; iter++) {
    if (work.left <= 0) {
      work.ranOut = true
      break
    }
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
    const pushed = separate(pts, R, o.width + o.clearance, work)
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
 * Returns the biggest push made, and takes the pairs it looked at off `work`.
 *
 * Speed (it runs up to 2000 times per clean-up): each point's direction is
 * worked out once per pass, not once per pair, and a pair further apart than
 * any rule can ask for is skipped before anything else is worked out. Both
 * give exactly the same pushes as checking every pair in full.
 */
function separate(pts: P[], R: number, gap: number, work: RelaxWork): number {
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
  // No rule below ever asks for more room than 2R (2R x sin(...) <= 2R, and gap is far less than 2R for
  // any real road). If gap were ever bigger, nothing is skipped.
  const furthest = gap <= 2 * R ? 2 * R : Infinity
  const furthest2 = furthest * furthest
  const tx = new Float64Array(n)
  const tz = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const t = tangent(pts, i)
    tx[i] = t.x
    tz[i] = t.z
  }
  const moves = new Float64Array(n * 2)
  let biggest = 0
  let looked = 0
  for (let i = 0; i < n; i++) {
    const p = pts[i]
    const cx = Math.floor(p.x / cell)
    const cz = Math.floor(p.z / cell)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const list = grid.get(`${cx + dx},${cz + dz}`)
        if (!list) continue
        looked += list.length
        for (const j of list) {
          if (j <= i) continue
          const sep = Math.min(j - i, n - (j - i)) * h
          if (sep < 2.5 * h) continue
          const q = pts[j]
          const ex = p.x - q.x
          const ez = p.z - q.z
          if (ex * ex + ez * ez >= furthest2) continue
          const d = dist(p, q)
          if (d < 0.5) continue
          const dot = tx[i] * tx[j] + tz[i] * tz[j]
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
  work.left -= looked
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

/** A raised stretch of road centred on s (metres along the road), or a dipped one (an underpass). */
interface BridgeSpan {
  s: number
  /** Metres either side of s held at full height (over the other road), or full depth (under it). */
  flat: number
  /** True when this stretch dips bridgeLift metres down under the other road instead of rising over it. */
  dip?: boolean
  /** Where the roads cross. */
  at?: P
  /** Its straight top (or bottom) and ramps (deck.ts); none for the road held on the ground. */
  deck?: Deck
  /** True when even so a car flat out would go light over it (its ramps are too sharp for the ground there). */
  steep?: boolean
}

/**
 * Decide which road goes over at each crossing. The straighter pass is
 * lifted (a bridge on a bend is harder to drive), unless that clashes with
 * another crossing nearby where the same stretch has to stay low, or its
 * ramps would be too sharp for a car flat out over the ground there and the
 * other pass's wouldn't. A crossing the road already had keeps the road it
 * had on top (o.keepOver), and says so if it can't; one that was an underpass
 * stays one (the lower road dips down instead of the upper one rising). If
 * neither way fits, the crossing is flagged for Josh to fix.
 */
function planBridges(pts: readonly P[], crossings: Crossing[], o: CleanupOptions, issues: StrokeIssue[]): BridgeSpan[] {
  const length = polylineLength(pts, true)
  const ground = o.pointGround ?? (() => 0)
  /** The ground under the road, d metres from s along it (the clean-up's road rides the ground). */
  const groundAlong = (s: number, reach: number) => tabulate((d) => {
    const p = pointAt(pts, wrap(s + d, length), true)
    return ground(p.x, p.z)
  }, -reach - 40, reach + 40)
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
    let order: ('A' | 'B')[] = bendA <= bendB ? ['A', 'B'] : ['B', 'A']
    const keptChoice = keptSide(pts, c, o.keepOver ?? [], length)
    const kept = keptChoice?.side ?? null
    if (kept) order = kept === 'A' ? ['A', 'B'] : ['B', 'A']
    // An underpass stays an underpass: the road under it dips down, the one on top stays on the ground.
    const dip = !!keptChoice?.under
    // Every way round that fits, in order of preference, with its straight-topped deck.
    const fitting: { side: 'A' | 'B'; moveS: number; holdS: number; deck: Deck; steep: boolean }[] = []
    for (const side of order) {
      const upS = side === 'A' ? c.sA : c.sB
      const downS = side === 'A' ? c.sB : c.sA
      // The road whose heights change (the bridge, or the dip under the other road), and the one held on the ground.
      const moveS = dip ? downS : upS
      const holdS = dip ? upS : downS
      const upClash = downs.some((d) => Math.abs(deltaS(moveS, d.s, length)) < reach + d.flat)
      const downClash = ups.some((u) => Math.abs(deltaS(holdS, u.s, length)) < flat + u.flat + o.bridgeRamp)
      const selfClash = Math.abs(deltaS(moveS, holdS, length)) < reach + flat
      // A dip and a bridge can't share road.
      const kindClash = ups.some((u) => !!u.dip !== dip && Math.abs(deltaS(moveS, u.s, length)) < reach + u.flat + o.bridgeRamp)
      if (upClash || downClash || selfClash || kindClash) continue
      // The deck: straight through the crossing, bridgeLift over (or under) the road held on the ground there.
      const was = groundAlong(moveS, reach)
      const deck = planDeck(was, ground(c.at.x, c.at.z), dip ? -o.bridgeLift : o.bridgeLift, flat, o.bridgeRamp)
      fitting.push({ side, moveS, holdS, deck, steep: deckCrest(deck, was).over > 0 })
    }
    // The first that fits, unless its ramps would throw a car off and the other way's wouldn't (a road
    // Josh put on top stays on top, steep or not: the note below says so).
    const gentle = kept ? undefined : fitting.find((f) => !f.steep)
    const pick = gentle ?? fitting[0]
    let chosen: 'A' | 'B' | null = null
    if (pick) {
      chosen = pick.side
      ups.push({ s: pick.moveS, flat, dip, at: c.at, deck: pick.deck, steep: pick.steep })
      downs.push({ s: pick.holdS, flat })
    }
    c.over = chosen
    if (chosen && kept && chosen !== kept) {
      issues.push({
        level: 'warning',
        code: 'bridge-flipped',
        message: dip
          ? 'The road you sent under here has no room for its dip any more, so the other road goes under now. Select the crossing to swap it back once there is room.'
          : 'The road you put on top here has no room for its ramps any more, so the other road goes over now. Select the bridge to swap it back once there is room.',
        at: c.at,
      })
    } else if (chosen && dip) {
      issues.push({ level: 'note', code: 'bridged', message: 'The road crosses itself here, and one side still goes under the other in a cutting.', at: c.at })
    } else if (chosen) {
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

/**
 * If this crossing was on the road before (a kept choice within 40 m), which
 * pass goes over: the one heading the same way as the road that was on top,
 * and whether it was an underpass.
 */
function keptSide(pts: readonly P[], c: Crossing, keep: readonly { at: P; heading: number; under?: boolean }[], length: number): { side: 'A' | 'B'; under: boolean } | null {
  let best: { at: P; heading: number; under?: boolean } | null = null
  for (const k of keep) if (dist(k.at, c.at) < 40 && (!best || dist(k.at, c.at) < dist(best.at, c.at))) best = k
  if (!best) return null
  const heading = (s: number) => {
    const a = pointAt(pts, wrap(s - 3, length), true)
    const b = pointAt(pts, wrap(s + 3, length), true)
    return ((Math.atan2(b.x - a.x, -(b.z - a.z)) * 180) / Math.PI + 360) % 360
  }
  const off = (h: number) => Math.abs(((((h - best.heading) % 360) + 540) % 360) - 180)
  const offA = off(heading(c.sA))
  const offB = off(heading(c.sB))
  if (Math.min(offA, offB) > 60) return null
  return { side: offA <= offB ? 'A' : 'B', under: !!best.under }
}

/**
 * Height of the road above the ground at s (standing on `p`): on a bridge, its
 * straight top over the crossing and the ramps easing up to it from the ground
 * either side (deck.ts); in an underpass's dip, as far under (negative).
 */
function liftAt(s: number, p: P, spans: readonly BridgeSpan[], length: number, pointGround?: (x: number, z: number) => number): number {
  const g = pointGround ? pointGround(p.x, p.z) : 0
  let lift: number | null = null
  let dip: number | null = null
  for (const span of spans) {
    const deck = span.deck
    if (!deck) continue
    const d = deltaS(span.s, s, length)
    if (Math.abs(d) >= deck.flat + deck.ramp) continue
    const here = deckHeight(deck, d, g) - g
    if (deck.dip) dip = dip === null ? here : Math.min(dip, here)
    else lift = lift === null ? here : Math.max(lift, here)
  }
  return (lift ?? 0) + (dip ?? 0)
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
 * a bridge. Says whether it found a straight (else it is the calmest spot).
 */
function pickStart(pts: readonly P[], crossings: readonly Crossing[], drawnStart: P, o: CleanupOptions): { index: number; straight: boolean } {
  const n = pts.length
  const length = polylineLength(pts, true)
  const h = length / n
  // The grid sits from 50 m behind the line to 10 m after it (tracks:check's start gate); keep a margin.
  const back = Math.ceil(60 / h)
  const ahead = Math.ceil(15 / h)
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
    // Straight enough that auto-banking stays near flat (the start gate dislikes a banked grid).
    if (worst <= 1 / 600) {
      const dd = dist(pts[i], drawnStart)
      if (dd < bestStraightDist) {
        bestStraightDist = dd
        bestStraight = i
      }
    }
  }
  return bestStraight >= 0 ? { index: bestStraight, straight: true } : { index: bestAny, straight: false }
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

function roundCm(v: number): number {
  return Math.round(v * 100) / 100
}

function round1(v: number): number {
  return Math.round(v * 10) / 10
}
