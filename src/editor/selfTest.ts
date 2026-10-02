// ============================================================
//  EDITOR SELF-TEST - proves the stroke clean-up works
// ------------------------------------------------------------
//  Feeds the clean-up pipeline (cleanup.ts) a set of made-up
//  drawings - a shaky circle, a hairpin too narrow for a car, a
//  figure-eight, a square with sharp corners, a road off the edge
//  of the world, a line that never comes back - and checks that
//  every result is a road a car can drive. It also checks the
//  editing maths, that the Checks panel's verdict (checks.ts)
//  agrees with the game's own track gates, and that Clear all
//  leaves a blank track that builds in every kind of world.
//
//  Run it two ways:
//    bun src/editor/selfTest.ts          (prints a pass/fail table)
//    window.__dev.editor('selftest')     (in the running game)
// ============================================================

import * as THREE from 'three'
import { CLEANUP, cleanStroke, type CleanResult, type CleanupOptions } from './cleanup'
import { type P, catmullRomClosed, dist, minRadius, turnAngle } from './geom'
import {
  STEADY_DEFAULT,
  STEADY_STRING,
  alongRoad,
  atOf,
  bendProfile,
  bendRoad,
  cornerAt,
  cornerRadius,
  curveStretch,
  densify,
  dirOf,
  evenRoad,
  newPointHeight,
  pointHeight,
  posOf,
  roadHeightAt,
  roadLine,
  sOf,
  sOfPoint,
  smoothRoad,
  steadyPath,
  straightStretch,
  tightestOnRoad,
} from './shape'
import { validateTrack } from '../track/validate'
import { buildTrack } from '../track/build'
import { sampleClosedSpline } from '../track/spline'
import type { NearestHit, TrackFrame, TrackRuntime } from '../track/types'
import afterglowJson from '../../tracks/afterglow.json'
import { BASE_WORLDS, DEFAULT_BASE_WORLD, clearedDraft, draftFile, isBlankDraft, pointGroundOf, roadBound, worldForCopy } from './draftFile'
import { atAfterDelete, atAfterInsert, frameAt, nearestOnRoad, roadCurve, sectionRedraw } from './road'
import type { Piece, RoadPoint, TrackFile } from '../track/schema'
import { checkBuiltTrack, checkVerdict, gateItems } from './checks'
import type { Draft } from './draft'

export interface CheckResult {
  name: string
  pass: boolean
  detail: string
}

/** Small seeded random numbers, so the shaky test drawings are the same every run. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A hand-drawn-looking stroke: the shape plus wobble, sampled like mouse events. */
function shaky(shape: (t: number) => P, count: number, wobble: number, seed: number, t0 = 0, t1 = 1): P[] {
  const r = rng(seed)
  const out: P[] = []
  let wx = 0
  let wz = 0
  for (let i = 0; i <= count; i++) {
    const t = t0 + ((t1 - t0) * i) / count
    const p = shape(t)
    wx = wx * 0.7 + (r() - 0.5) * wobble
    wz = wz * 0.7 + (r() - 0.5) * wobble
    out.push({ x: p.x + wx, z: p.z + wz })
  }
  return out
}

/**
 * A drive-to-draw road the way Josh lays one with the keyboard: a car follows
 * a kidney-shaped route, but steering is A or D held for a moment and let go
 * (with the game's attack and release), so it weaves and corrects all the
 * way round. Points every 4 m, like the drive recorder. Seeded, so the same every run.
 */
export function keyboardDrive(seed = 1): P[] {
  const r = rng(seed)
  const route = (a: number) => {
    const rr = (240 + 70 * Math.sin(2 * a) + 40 * Math.cos(3 * a)) * 1.35
    return { x: rr * Math.cos(a), z: rr * Math.sin(a) * 0.85 }
  }
  const target: P[] = []
  for (let i = 0; i < 4000; i++) target.push(route((i / 4000) * TAU))
  let p = { ...target[0] }
  let heading = Math.atan2(target[1].z - target[0].z, target[1].x - target[0].x)
  let steer = 0
  let key = 0
  let hold = 0
  let ti = 0
  const speed = 33
  const dt = 1 / 60
  const out: P[] = [{ ...p }]
  for (let step = 0; step < 60 * 400 && ti <= target.length + 40; step++) {
    let best = ti
    let bestD = Infinity
    for (let k = ti; k < ti + 60; k++) {
      const q = target[k % target.length]
      const d = Math.hypot(q.x - p.x, q.z - p.z)
      if (d < bestD) {
        bestD = d
        best = k
      }
    }
    ti = best
    const look = target[(ti + 30) % target.length]
    let e = Math.atan2(look.z - p.z, look.x - p.x) - heading
    while (e > Math.PI) e -= TAU
    while (e < -Math.PI) e += TAU
    hold -= dt
    if (hold <= 0) {
      const noisy = e + (r() - 0.5) * 0.06
      key = noisy > 0.04 ? 1 : noisy < -0.04 ? -1 : 0
      hold = 0.08 + r() * 0.12
    }
    const rate = key === 0 ? 5 : 3
    steer += Math.max(-rate * dt, Math.min(rate * dt, key - steer))
    heading += (steer / 45) * speed * dt
    p = { x: p.x + Math.cos(heading) * speed * dt, z: p.z + Math.sin(heading) * speed * dt }
    if (Math.hypot(p.x - out[out.length - 1].x, p.z - out[out.length - 1].z) >= 4) out.push({ ...p })
  }
  return out
}

/** Wobble of the road the game really builds (the track builder's own curvature), x 1,000,000; see roadRoughness. */
function builtRoughness(points: RoadPoint[]): number {
  const v = validateTrack(draftFile({ id: 'selftest-rough', name: 'Self-test rough', points }))
  if (!v.ok || !v.track) return NaN
  const S = buildTrack(v.track, {}).samples
  let rough = 0
  for (let i = 0; i < S.count; i++) rough += Math.abs(S.curvature[(i + 1) % S.count] - S.curvature[i])
  return (rough / (S.count * S.ds)) * 1e6
}

function polygon(corners: P[], perSide: number): P[] {
  const out: P[] = []
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i]
    const b = corners[(i + 1) % corners.length]
    for (let k = 0; k < perSide; k++) out.push({ x: a.x + ((b.x - a.x) * k) / perSide, z: a.z + ((b.z - a.z) * k) / perSide })
  }
  out.push({ ...corners[0] })
  return out
}

const TAU = Math.PI * 2
/** The default world (1600 m, mountain edge) lets the road reach 590 m from the centre (draftFile.roadBound). */
const BOUND = roadBound(DEFAULT_BASE_WORLD.environment)

/** Invariants every successful clean-up must meet. Returns the failures. */
function roadInvariants(res: CleanResult): string[] {
  const bad: string[] = []
  if (!res.ok) return ['not ok: ' + res.issues.map((i) => i.message).join(' / ')]
  if (res.points.length < 8) bad.push(`only ${res.points.length} control points`)
  for (let i = 0; i < res.points.length; i++) {
    const d = dist(res.points[i], res.points[(i + 1) % res.points.length])
    if (d < CLEANUP.spacing * 0.6 || d > CLEANUP.spacing * 1.5) {
      bad.push(`control spacing ${d.toFixed(1)} m at ${i}`)
      break
    }
  }
  const built = catmullRomClosed(res.points, 8)
  const tight = minRadius(built, 12)
  if (tight.radius < CLEANUP.minRadius * 0.85) bad.push(`tightest corner ${tight.radius.toFixed(1)} m`)
  const far = Math.max(...res.points.map((p) => Math.max(Math.abs(p.x), Math.abs(p.z))))
  if (far > BOUND) bad.push(`point ${far.toFixed(0)} m out from the centre (bound ${BOUND})`)
  const v = validateTrack(draftFile({ id: 'selftest', name: 'Self-test', points: res.points }))
  if (!v.ok) bad.push('validator errors: ' + v.errors.map((e) => `${e.path}: ${e.message}`).join(' / '))
  // Bridged crossings must not draw the validator's "crosses itself" warning either.
  for (const w of v.warnings) bad.push(`validator warning: ${w.path} ${w.message}`)
  for (const c of res.crossings) {
    const explained = c.over !== null || res.issues.some((i) => i.at && dist(i.at, c.at) < 1 && i.level === 'warning')
    if (!explained) bad.push(`crossing at ${c.at.x.toFixed(0)},${c.at.z.toFixed(0)} neither bridged nor flagged`)
  }
  for (const p of res.points) {
    if (p.lift !== undefined && (p.lift < 0 || p.lift > CLEANUP.bridgeLift + 1e-6)) bad.push(`lift ${p.lift} out of range`)
  }
  return bad
}

/** Lift of the control point nearest to s along the road. */
function liftNear(res: CleanResult, s: number): number {
  const i = Math.round(s / (res.length / res.points.length)) % res.points.length
  return res.points[i].lift ?? 0
}

export function runEditorSelfTest(): CheckResult[] {
  const results: CheckResult[] = []
  const opts: Partial<CleanupOptions> = { bound: BOUND, width: 14 }
  /** A check returns its problems (empty = pass), or a string to report a pass with a note. */
  let info = ''
  const check = (name: string, fn: () => string[] | string) => {
    info = ''
    try {
      const out = fn()
      const problems = Array.isArray(out) ? out : []
      const detail = Array.isArray(out) ? (problems.length ? problems.join('; ') : info || 'ok') : out
      results.push({ name, pass: problems.length === 0, detail })
    } catch (err) {
      results.push({ name, pass: false, detail: 'threw: ' + (err as Error).message })
    }
  }
  const describe = (res: CleanResult) => {
    info = `${res.points.length} points, ${Math.round(res.length)} m, tightest corner ${res.tightestRadius.toFixed(0)} m` +
      (res.crossings.length ? `, ${res.crossings.length} crossing(s)` : '')
  }

  check('shaky circle stays a circle', () => {
    const R = 180
    const stroke = shaky((t) => ({ x: 50 + R * Math.cos(t * TAU), z: -30 + R * Math.sin(t * TAU) }), 500, 5, 1, 0, 1.04)
    const res = cleanStroke(stroke, opts)
    describe(res)
    const bad = roadInvariants(res)
    const dev = Math.max(...res.dense.map((p) => Math.abs(Math.hypot(p.x - 50, p.z + 30) - R)))
    if (dev > 6) bad.push(`drifted ${dev.toFixed(1)} m from the drawn circle`)
    if (res.tightestRadius < 45) bad.push(`hand wobble left a ${res.tightestRadius.toFixed(0)} m bend in a 180 m circle`)
    if (res.crossings.length) bad.push(`${res.crossings.length} crossings on a circle`)
    if (res.issues.some((i) => i.code === 'too-close')) bad.push('too-close flagged on a circle')
    describe(res)
    info += `, max drift ${dev.toFixed(1)} m`
    return bad
  })

  check('sharp square gets rounded corners', () => {
    const stroke = polygon([{ x: -150, z: -150 }, { x: 150, z: -150 }, { x: 150, z: 150 }, { x: -150, z: 150 }], 40)
    const res = cleanStroke(stroke, opts)
    describe(res)
    return roadInvariants(res)
  })

  check('narrow hairpin stalk opens into a drivable road', () => {
    // Two legs 10 m apart for 300 m: the road edges would overlap and both ends are hairpins.
    const stroke = polygon([{ x: 0, z: 150 }, { x: 0, z: -150 }, { x: 10, z: -150 }, { x: 10, z: 150 }], 60)
    const res = cleanStroke(stroke, opts)
    describe(res)
    const bad = roadInvariants(res)
    if (res.issues.some((i) => i.code === 'too-close')) bad.push('legs still overlap')
    return bad
  })

  check('figure-eight gets one bridge', () => {
    const stroke = shaky((t) => ({ x: 260 * Math.sin(t * TAU), z: 130 * Math.sin(2 * t * TAU) }), 600, 3, 2, 0.1, 1.1)
    const res = cleanStroke(stroke, opts)
    describe(res)
    const bad = roadInvariants(res)
    if (res.crossings.length !== 1) bad.push(`${res.crossings.length} crossings (want 1)`)
    const c = res.crossings[0]
    if (c) {
      if (c.over === null) bad.push('crossing not bridged')
      else {
        const upS = c.over === 'A' ? c.sA : c.sB
        const downS = c.over === 'A' ? c.sB : c.sA
        const up = liftNear(res, upS)
        const down = liftNear(res, downS)
        if (up < CLEANUP.bridgeLift - 0.5) bad.push(`bridge only ${up} m up`)
        if (down > 0.01) bad.push(`road under the bridge lifted ${down} m`)
      }
      if (c.angleDeg < 60) bad.push(`crossing angle ${c.angleDeg.toFixed(0)} degrees (expected about 90)`)
    }
    return bad
  })

  check('road off the edge of the world is pulled inside', () => {
    const stroke = shaky((t) => ({ x: 900 * Math.cos(t * TAU), z: 600 * Math.sin(t * TAU) }), 500, 4, 3, 0, 1.02)
    const res = cleanStroke(stroke, opts)
    describe(res)
    const bad = roadInvariants(res)
    if (!res.issues.some((i) => i.code === 'kept-inside')) bad.push('no kept-inside note')
    return bad
  })

  check('open C shape is closed back to the start', () => {
    const stroke = shaky((t) => ({ x: 200 * Math.cos(t * TAU), z: 200 * Math.sin(t * TAU) }), 300, 3, 4, 0, 0.75)
    const res = cleanStroke(stroke, opts)
    describe(res)
    const bad = roadInvariants(res)
    if (!res.issues.some((i) => i.code === 'joined-far')) bad.push('no joined-far note')
    return bad
  })

  check('overshoot past the start is trimmed, not a crossing', () => {
    const stroke = shaky((t) => ({ x: 160 * Math.cos(t * TAU), z: 220 * Math.sin(t * TAU) }), 400, 3, 5, 0, 1.12)
    const res = cleanStroke(stroke, opts)
    describe(res)
    const bad = roadInvariants(res)
    if (res.crossings.length) bad.push(`${res.crossings.length} crossings left by the overshoot`)
    return bad
  })

  check('too-short stroke is refused in plain words', () => {
    const res = cleanStroke([{ x: 0, z: 0 }, { x: 40, z: 0 }, { x: 40, z: 40 }], opts)
    if (res.ok) return ['accepted a 80 m road']
    return res.issues[0]?.code === 'too-short' ? [] : [`wrong issue ${res.issues[0]?.code}`]
  })

  check('garbage input does not throw', () => {
    const res = cleanStroke([{ x: NaN, z: 0 }, { x: Infinity, z: 1 }, { x: 0, z: 0 }], opts)
    return res.ok ? ['accepted garbage'] : []
  })

  check('shallow crossing is steepened into a bridge or flagged', () => {
    const stroke = shaky((t) => ({ x: 300 * Math.sin(t * TAU), z: 40 * Math.sin(2 * t * TAU) }), 600, 2, 6, 0.1, 1.1)
    const res = cleanStroke(stroke, opts)
    describe(res)
    return roadInvariants(res)
  })

  check('a shaky drawing builds into smooth, flowing bends', () => {
    // Roughness = how much the built road's bend changes per metre, averaged over the lap.
    // A perfect (wobble-free) drawing of this shape scores about 75; raw hand wobble about 250.
    const stroke = shaky((t) => {
      const a = t * TAU
      const r = 240 + 70 * Math.sin(2 * a) + 40 * Math.cos(3 * a)
      return { x: r * Math.cos(a), z: r * Math.sin(a) * 0.85 }
    }, 500, 4, 7, 0, 1.02)
    const res = cleanStroke(stroke, opts)
    describe(res)
    const v = validateTrack(draftFile({ id: 'selftest-kidney', name: 'Self-test kidney', points: res.points }))
    if (!v.ok || !v.track) return ['validator refused it']
    const S = buildTrack(v.track, {}).samples
    let rough = 0
    for (let i = 0; i < S.count; i++) rough += Math.abs(S.curvature[(i + 1) % S.count] - S.curvature[i])
    const score = (rough / (S.count * S.ds)) * 1e6
    info += `, roughness ${score.toFixed(0)}`
    return score > 180 ? [`roughness ${score.toFixed(0)} (want under 180)`] : []
  })

  check('drawn tracks pass the real track validator', () => {
    const stroke = shaky((t) => ({ x: 260 * Math.sin(t * TAU), z: 130 * Math.sin(2 * t * TAU) }), 600, 3, 2, 0.1, 1.1)
    const res = cleanStroke(stroke, opts)
    if (!res.ok) return ['clean-up failed']
    const v = validateTrack(draftFile({ id: 'selftest-eight', name: 'Self-test eight', points: res.points }))
    if (v.errors.some((e) => /not built yet/.test(e.message))) return 'skipped: the track validator is not built yet'
    return v.ok ? [] : v.errors.map((e) => `${e.path}: ${e.message}`)
  })

  // ---------------------------------------------------------------- the Checks verdict

  check("the Checks verdict agrees with the game's gates (a loop under a bridge fails)", () => {
    // The same figure-eight: its crossing becomes a bridge. A loop that starts just
    // before the bridge rises through the deck, so the game's loops gate fails it and
    // the editor must not say "All good". Try the loop at several spots around the
    // bridge: at every one, the verdict must be exactly what the gates say.
    const stroke = shaky((t) => ({ x: 260 * Math.sin(t * TAU), z: 130 * Math.sin(2 * t * TAU) }), 600, 3, 2, 0.1, 1.1)
    const res = cleanStroke(stroke, opts)
    if (!res.ok) return ['clean-up failed']
    const bridge = res.crossings.find((c) => c.over !== null)
    if (!bridge) return ['the eight has no bridged crossing to test with']
    // The road point nearest the crossing on the lower (unlifted) branch.
    let under = -1
    let best = Infinity
    res.points.forEach((p, i) => {
      const d = dist(p, bridge.at)
      if (!p.lift && d < best) {
        best = d
        under = i
      }
    })
    if (under < 0 || best > 30) return ['no road point under the bridge']
    const run = (pieces: Piece[]) => {
      const v = validateTrack(draftFile({ id: 'selftest-checks', name: 'Self-test checks', points: res.points, pieces }))
      if (!v.ok || !v.track) return null
      const r = checkBuiltTrack(buildTrack(v.track, {}))
      return { verdict: checkVerdict({ fresh: true, errors: v.errors, gates: r.gates, cleanupErrors: 0 }), gates: r.gates, ms: r.ms }
    }
    const bad: string[] = []
    const plain = run([])
    if (!plain) return ['the eight without a loop did not validate']
    if (plain.verdict !== 'pass') bad.push(`no loop: verdict ${plain.verdict} (${plain.gates.filter((g) => g.level === 'fail').map((g) => `${g.name}: ${g.message}`).join(' / ')})`)
    const rc = roadCurve(res.points)
    const draftLike = { points: res.points, startAt: 0 } as unknown as Draft
    const seen: string[] = []
    let blocked = 0
    for (const off of [-2, -1, 0, 1]) {
      const at = (under + off + res.points.length) % res.points.length
      const r = run([{ type: 'loop', at }])
      if (!r) {
        bad.push(`loop at point ${at}: did not validate`)
        continue
      }
      const gatesFail = r.gates.some((g) => g.level === 'fail')
      if (r.verdict !== (gatesFail ? 'fail' : 'pass')) bad.push(`loop at point ${at}: verdict ${r.verdict} but the gates ${gatesFail ? 'fail' : 'pass'}`)
      const loopRow = r.gates.find((g) => g.name === 'loops')
      seen.push(`${at}: ${loopRow?.level ?? 'no row'}`)
      if (loopRow?.level !== 'fail') continue
      blocked++
      // The panel row: plain words, a fix, and a pin on the loop.
      const item = gateItems(r.gates, draftLike, rc).find((it) => it.label === 'LOOP BLOCKED')
      if (!item) bad.push(`loop at point ${at}: no LOOP BLOCKED row`)
      else {
        if (!item.fix) bad.push(`loop at point ${at}: the row has no fix line`)
        if (/s=\d/.test(`${item.detail} ${item.fix}`)) bad.push(`loop at point ${at}: the row still says s=: ${item.detail}`)
        const pin = item.at ? dist(item.at, frameAt(rc, at).p) : Infinity
        if (pin > 25) bad.push(`loop at point ${at}: the pin is ${pin.toFixed(0)} m from the loop`)
      }
    }
    if (!blocked) bad.push('no loop near the bridge failed the loops gate, so this test proves nothing: move the candidates')
    info = `no loop: ${plain.verdict} (gates ${plain.ms.toFixed(0)} ms); loops gate by start point near the bridge: ${seen.join(', ')}`
    return bad
  })

  // ---------------------------------------------------------------- editing maths (stage B)

  const ring = (count: number, r: number): RoadPoint[] =>
    Array.from({ length: count }, (_, i) => ({ x: Math.round(r * Math.sin((i / count) * TAU) * 10) / 10, z: Math.round(-r * Math.cos((i / count) * TAU) * 10) / 10 }))

  check('adding a road point keeps pieces where they were', () => {
    const pts = ring(40, 200)
    const before = roadCurve(pts)
    const ats = [3.25, 7.5, 7.9, 20.1, 39.6]
    const where = ats.map((a) => frameAt(before, a).p)
    // Insert a point on the curve halfway along segment 7 -> 8 (new index 8).
    const mid = frameAt(before, 7.5).p
    const after = [...pts.slice(0, 8), { x: mid.x, z: mid.z }, ...pts.slice(8)]
    const rc = roadCurve(after)
    const bad: string[] = []
    ats.forEach((a, i) => {
      const moved = Math.hypot(frameAt(rc, atAfterInsert(a, 8, 0.5)).p.x - where[i].x, frameAt(rc, atAfterInsert(a, 8, 0.5)).p.z - where[i].z)
      if (moved > 1.5) bad.push(`at ${a} moved ${moved.toFixed(1)} m`)
    })
    return bad
  })

  check('deleting a road point keeps pieces on the rest of the road', () => {
    const pts = ring(40, 200)
    const before = roadCurve(pts)
    const bad: string[] = []
    for (const del of [0, 12, 39]) {
      const after = pts.filter((_, i) => i !== del)
      const rc = roadCurve(after)
      for (const a of [2.5, 15.25, 30.75]) {
        // Pieces two or more segments from the deleted point must not move at all (beyond rounding).
        const gap = Math.min(Math.abs(a - del), 40 - Math.abs(a - del))
        if (gap < 2.5) continue
        const was = frameAt(before, a).p
        const now = frameAt(rc, atAfterDelete(a, del, 40)).p
        const moved = Math.hypot(now.x - was.x, now.z - was.z)
        if (moved > 0.5) bad.push(`delete ${del}: at ${a} moved ${moved.toFixed(2)} m`)
      }
    }
    return bad
  })

  check('a click to the right of the road reads as right (+offset)', () => {
    const rc = roadCurve(ring(40, 200))
    const f = frameAt(rc, 10.3)
    const q = { x: f.p.x + f.right.x * 4, z: f.p.z + f.right.z * 4 }
    const hit = nearestOnRoad(rc, q)
    return Math.abs(hit.lateral - 4) < 0.3 && Math.abs(hit.at - 10.3) < 0.05 ? [] : [`lateral ${hit.lateral.toFixed(2)} at ${hit.at.toFixed(2)}`]
  })

  check('redrawing a stretch changes only that stretch', () => {
    const pts = ring(60, 250)
    const rc = roadCurve(pts)
    // From the road at about 2 o'clock, bulge outward, back to the road at about 4 o'clock.
    const a = frameAt(rc, 8).p
    const b = frameAt(rc, 17).p
    const stroke: P[] = []
    for (let i = 0; i <= 60; i++) {
      const t = i / 60
      const base = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t }
      const out = Math.sin(t * Math.PI) * 90
      const r = Math.hypot(base.x, base.z) || 1
      stroke.push({ x: base.x + (base.x / r) * out, z: base.z + (base.z / r) * out })
    }
    const loop = sectionRedraw(stroke, pts, 14)
    if (!loop) return ['not recognised as a section redraw']
    const res = cleanStroke(loop, { ...opts, fairing: 0 })
    describe(res)
    if (!res.ok) return ['clean-up failed: ' + res.issues.map((i) => i.message).join(' / ')]
    const newRc = roadCurve(res.points)
    const bad: string[] = []
    // The far side of the circle (8 and 9 o'clock) must not have moved.
    for (const at of [35, 40, 45]) {
      const was = frameAt(rc, at).p
      const hit = nearestOnRoad(newRc, was)
      if (hit.distance > 3) bad.push(`far side moved ${hit.distance.toFixed(1)} m at ${at}`)
    }
    // The bulge must be there: some road at least 60 m outside the old circle.
    const reach = Math.max(...res.dense.map((p) => Math.hypot(p.x, p.z)))
    if (reach < 250 + 60) bad.push(`bulge only reaches ${reach.toFixed(0)} m from the centre`)
    return bad
  })

  check('a whole new loop is not mistaken for a stretch redraw', () => {
    const pts = ring(60, 250)
    const stroke = shaky((t) => ({ x: 250 * Math.sin(t * TAU), z: -250 * Math.cos(t * TAU) }), 300, 2, 9, 0, 1.02)
    return sectionRedraw(stroke, pts, 14) ? ['treated a full loop as a section'] : []
  })

  // ---------------------------------------------------------------- clear all

  check('clear all leaves a blank, valid track in the same world', () => {
    // A busy track (pieces, props, cores, a moved start line, a banked stretch) in
    // every base world plus a small hilly world and a walled stadium: clearing must
    // empty the map, keep what the track IS, and give a road that builds and stays
    // inside that world.
    const stroke = shaky((t) => ({ x: 260 * Math.sin(t * TAU), z: 130 * Math.sin(2 * t * TAU) }), 600, 3, 2, 0.1, 1.1)
    const res = cleanStroke(stroke, opts)
    if (!res.ok) return ['clean-up failed']
    const worlds = [
      ...BASE_WORLDS.map((b) => ({ id: b.id, env: b.environment })),
      { id: 'small-hills', env: { size: 1000, terrain: { kind: 'hills' as const, relief: 10, edge: 'ridge' as const } } },
      // Too small for the full-size oval: it has to shrink to stay off the mountains.
      { id: 'tiny-hills', env: { size: 800, terrain: { kind: 'hills' as const, relief: 10, edge: 'ridge' as const } } },
      { id: 'stadium', env: { size: 1300, terrain: { kind: 'flat' as const, edge: 'wall' as const } } },
    ]
    const bad: string[] = []
    for (const w of worlds) {
      const busy: Draft = {
        id: 'busy-track',
        name: 'Busy Track',
        author: 'Josh',
        description: 'Lots of stuff on it',
        points: res.points.map((p, i) => (i < 4 ? { ...p, bank: 12, width: 18 } : { ...p })),
        width: 16,
        baseWorld: w.id,
        environment: w.env,
        pieces: [{ type: 'boost', at: 3 }, { type: 'ramp', at: 9 }],
        props: [{ x: 40, z: 40 }],
        cores: [{ x: -30, z: 20 }],
        startAt: 5.3,
      }
      const before = JSON.stringify(busy)
      const c = clearedDraft(busy)
      const tag = (m: string) => bad.push(`${w.id}: ${m}`)
      if (JSON.stringify(busy) !== before) tag('clearing changed the track it was given')
      if (c.pieces.length || c.props.length || c.cores.length || c.startAt !== 0) tag('pieces, props, cores or the start line were left behind')
      if (c.points.some((p) => p.bank !== undefined || p.width !== undefined || p.lift !== undefined)) tag('per-stretch bank, width or lift were left behind')
      for (const k of ['id', 'name', 'author', 'description', 'width', 'baseWorld'] as const) if (c[k] !== busy[k]) tag(`${k} changed`)
      if (JSON.stringify(c.environment) !== JSON.stringify(busy.environment)) tag('the world changed')
      if (!isBlankDraft(c) || isBlankDraft(busy)) tag('isBlankDraft is wrong')
      if (JSON.stringify(clearedDraft(c)) !== JSON.stringify(c)) tag('clearing twice is not the same as once')
      const limit = roadBound(w.env)
      const reach = Math.max(...c.points.map((p) => Math.max(Math.abs(p.x), Math.abs(p.z))))
      if (reach > limit) tag(`the starter road reaches ${reach.toFixed(0)} m, past the ${limit.toFixed(0)} m edge limit`)
      const v = validateTrack(draftFile({ id: 'selftest-cleared', name: c.name, points: c.points, width: c.width, environment: c.environment }))
      if (!v.ok || !v.track) {
        tag(`does not validate: ${v.errors.map((e) => `${e.path}: ${e.message}`).join(' / ')}`)
        continue
      }
      const gates = checkBuiltTrack(buildTrack(v.track, {})).gates.filter((g) => g.level === 'fail')
      if (gates.length) tag(`gates fail: ${gates.map((g) => `${g.name}: ${g.message}`).join(' / ')}`)
    }
    info = `${worlds.length} worlds cleared to a valid starter road`
    return bad
  })

  // ---------------------------------------------------------------- shaping tools (shape.ts)

  const world = { width: 14, bound: BOUND, playRadius: Infinity }
  /** A road that passes the validator with no tight-corner warning. */
  const validRoad = (points: RoadPoint[], tag: string): string[] => {
    const v = validateTrack(draftFile({ id: 'selftest-shape', name: 'Self-test shape', points }))
    const bad = v.ok ? [] : [`${tag}: validator errors: ${v.errors.map((e) => e.message).join(' / ')}`]
    for (const w of v.warnings) if (/radius/.test(w.message)) bad.push(`${tag}: ${w.message}`)
    return bad
  }

  check('Smooth: a keyboard-driven road gets visibly smoother, more each press (issue #8)', () => {
    const res = cleanStroke(keyboardDrive(1), { ...opts, smoothing: 10, fairing: 8 })
    if (!res.ok) return ['the driven road did not clean up']
    // Per-point settings and a lift must ride along untouched.
    const start = res.points.map((p, i) => (i === 10 ? { ...p, bank: 8, width: 18 } : i === 40 ? { ...p, lift: 3 } : { ...p }))
    const r0 = builtRoughness(start)
    const one = smoothRoad(start, world)
    const r1 = builtRoughness(one.points)
    const two = smoothRoad(one.points, world)
    const r2 = builtRoughness(two.points)
    const bad: string[] = []
    if (!(r1 <= r0 * 0.7)) bad.push(`one press only took the wobble from ${r0.toFixed(0)} to ${r1.toFixed(0)} (want at least 30% less)`)
    if (!(r2 < r1 * 0.9)) bad.push(`the second press did not smooth more (${r1.toFixed(0)} -> ${r2.toFixed(0)})`)
    for (const [tag, out] of [['press 1', one.points], ['press 2', two.points]] as const) {
      if (out.length !== start.length) bad.push(`${tag}: ${start.length} points became ${out.length}`)
      const moved = Math.max(...out.map((p, i) => Math.hypot(p.x - start[i].x, p.z - start[i].z)))
      if (moved > 15) bad.push(`${tag}: a point moved ${moved.toFixed(1)} m (the road's shape should stay)`)
      if (out[10].bank !== 8 || out[10].width !== 18 || out[40].lift !== 3) bad.push(`${tag}: per-point settings did not stay on their points`)
      bad.push(...validRoad(out, tag))
    }
    info = `wobble ${r0.toFixed(0)} -> ${r1.toFixed(0)} (one press) -> ${r2.toFixed(0)} (two); points moved up to ${Math.max(...one.points.map((p, i) => Math.hypot(p.x - start[i].x, p.z - start[i].z))).toFixed(1)} m per press`
    return bad
  })

  check("Smooth leaves a loop's straight run-in and the start grid exactly as they are", () => {
    // A shaky stadium: two long straights, two round ends. A loop sits on one straight.
    const stadium = shaky((t) => {
      const u = t * 4
      if (u < 1) return { x: -250 + 500 * u, z: -120 }
      if (u < 2) {
        const a = -Math.PI / 2 + Math.PI * (u - 1)
        return { x: 250 + 120 * Math.cos(a), z: 120 * Math.sin(a) }
      }
      if (u < 3) return { x: 250 - 500 * (u - 2), z: 120 }
      const a = Math.PI / 2 + Math.PI * (u - 3)
      return { x: -250 + 120 * Math.cos(a), z: 120 * Math.sin(a) }
    }, 600, 3, 12, 0, 1.01)
    const res = cleanStroke(stadium, opts)
    if (!res.ok) return ['the stadium did not clean up']
    const pts = res.points
    const line = roadLine(pts)
    // The loop: the middle of the top straight (z = -120); the start line: the middle of the bottom one.
    const nearest = (q: P) => nearestOnRoad(roadCurve(pts), q).at
    const loopAt = nearest({ x: 0, z: -120 })
    const startAt = nearest({ x: 0, z: 120 })
    const keep = [
      { at: loopAt, before: 90, after: 74 },
      { at: startAt, before: 60, after: 15 },
    ]
    const out = smoothRoad(pts, world, undefined, keep).points
    const bad: string[] = []
    let kept = 0
    pts.forEach((p, k) => {
      const s = sOfPoint(line, k)
      const inZone = keep.some((z) => {
        const d = sOf(line, z.at)
        const ahead = ((s - d) % line.length + line.length) % line.length
        return ahead <= z.after || line.length - ahead <= z.before
      })
      if (!inZone) return
      kept++
      const moved = Math.hypot(out[k].x - p.x, out[k].z - p.z)
      if (moved > 0.01) bad.push(`point ${k} in a keep zone moved ${moved.toFixed(2)} m`)
    })
    if (kept < 8) bad.push(`only ${kept} points were in the keep zones: the test proves little`)
    const before = builtRoughness(pts)
    const after = builtRoughness(out)
    if (!(after < before)) bad.push(`the rest of the road did not get smoother (${before.toFixed(0)} -> ${after.toFixed(0)})`)
    info = `${kept} points in the loop's run-in and the start grid kept exactly; the rest smoothed (wobble ${before.toFixed(0)} -> ${after.toFixed(0)})`
    return bad
  })

  check('Bend: the bent stretch stays smooth, no curvature spike at the falloff edges', () => {
    // A 250 m circle with points 16 m apart; grab it and pull 30 m outward, reach 150 m.
    const pts = ring(98, 250)
    const line = roadLine(pts)
    const grabAt = 20
    const gs = sOf(line, grabAt)
    const g = posOf(line, gs)
    const reach = 150
    const pull = { x: (g.x / 250) * 30, z: (g.z / 250) * 30 }
    const bent = bendRoad(line, gs, reach, pull, world)
    const bad: string[] = []
    // Only the stretch within the reach moves, and the grabbed spot moves with the hand.
    pts.forEach((p, k) => {
      const d = alongRoad(sOfPoint(line, k), gs, line.length)
      const moved = Math.hypot(bent[k].x - p.x, bent[k].z - p.z)
      if (d >= reach && moved > 0) bad.push(`point ${k}, ${d.toFixed(0)} m away, moved`)
    })
    const bl = roadLine(bent)
    const hand = posOf(bl, sOf(bl, grabAt))
    const handMoved = Math.hypot(hand.x - g.x, hand.z - g.z)
    if (Math.abs(handMoved - 30) > 1.5) bad.push(`the grabbed spot moved ${handMoved.toFixed(1)} m (pulled 30)`)
    // How fast the bend changes (per metre) through the whole bent stretch, edges included.
    const e0 = sOf(bl, atOf(line, gs - reach))
    let e1 = sOf(bl, atOf(line, gs + reach))
    if (e1 < e0) e1 += bl.length
    const prof = bendProfile(bl, e0 - 40, e1 + 40, 1)
    const rate = prof.map((k, i) => (i ? Math.abs(k - prof[i - 1]) : 0))
    const worst = Math.max(...rate)
    const atEdge = (c: number) => Math.max(...rate.slice(Math.max(1, Math.round(c - (e0 - 40)) - 10), Math.round(c - (e0 - 40)) + 11))
    const edges = [atEdge(e0), atEdge(e1)]
    if (worst > 0.001) bad.push(`the bend changes too suddenly somewhere (${worst.toFixed(5)} per metre, limit 0.001)`)
    edges.forEach((v, i) => {
      if (v > 0.0008) bad.push(`a spike at the ${i ? 'far' : 'near'} edge of the reach (${v.toFixed(5)} per metre, limit 0.0008)`)
    })
    bad.push(...validRoad(bent, 'bent'))
    info = `hand moved ${handMoved.toFixed(1)} m; bend change per metre: worst ${worst.toFixed(5)}, at the edges ${edges.map((v) => v.toFixed(5)).join(' and ')}; tightest ${tightestOnRoad(bent).radius.toFixed(0)} m`
    return bad
  })

  check('Bend on a built-in-style road: extra points keep the road and the pieces in place', () => {
    // Points far apart, like the built-in tracks (up to 200 m): densify adds points on the same curve.
    const pts = ring(12, 300)
    const line = roadLine(pts)
    const dz = densify(line, 0, line.length)
    const bad: string[] = []
    if (dz.points.length <= pts.length) bad.push('no points were added')
    const dl = roadLine(dz.points)
    let worst = 0
    for (let s = 0; s < line.length; s += 5) {
      const p = posOf(line, s)
      const q = nearestOnRoad(roadCurve(dz.points), p)
      worst = Math.max(worst, q.distance)
    }
    if (worst > 0.5) bad.push(`the road moved ${worst.toFixed(2)} m`)
    for (const at of [0.5, 3.25, 7.9, 11.6]) {
      const was = posOf(line, sOf(line, at))
      const now = posOf(dl, sOf(dl, dz.mapAt(at)))
      const d = Math.hypot(now.x - was.x, now.z - was.z)
      if (d > 1) bad.push(`a piece at ${at} moved ${d.toFixed(2)} m`)
    }
    info = `${pts.length} -> ${dz.points.length} points, road moved at most ${worst.toFixed(2)} m`
    return bad
  })

  check('Straight: the stretch is dead straight, eased in at both ends, never too tight', () => {
    const res0 = cleanStroke(shaky((t) => {
      const a = t * TAU
      const r = 240 + 70 * Math.sin(2 * a) + 40 * Math.cos(3 * a)
      return { x: r * Math.cos(a), z: r * Math.sin(a) * 0.85 }
    }, 500, 4, 7, 0, 1.02), opts)
    if (!res0.ok) return ['the test road did not clean up']
    const pts = res0.points
    const n = pts.length
    const bad: string[] = []
    let made = 0
    let worstMiddle = 0
    for (const [a, b] of [[n * 0.05, n * 0.2], [n * 0.55, n * 0.7], [n * 0.3, n * 0.36]]) {
      const res = straightStretch(pts, a, b, world)
      const tag = `straight ${a.toFixed(0)}-${b.toFixed(0)}`
      if (!res.ok) {
        bad.push(`${tag} refused: ${res.reason}`)
        continue
      }
      made++
      const line0 = roadLine(pts)
      const A = posOf(line0, sOf(line0, a))
      const B = posOf(line0, sOf(line0, b))
      const L = Math.hypot(B.x - A.x, B.z - A.z)
      const ux = (B.x - A.x) / L
      const uz = (B.z - A.z) / L
      // The middle third lies on the line from A to B and does not bend at all; the middle
      // half is straighter than a loop's run-in needs (the ends ease in from the road).
      const nl = roadLine(res.points)
      const nrc = roadCurve(res.points)
      const sMid = sOf(nl, nearestOnRoad(nrc, A).at)
      let sEnd = sOf(nl, nearestOnRoad(nrc, B).at)
      if (sEnd < sMid) sEnd += nl.length
      const len = sEnd - sMid
      let off = 0
      for (let s = sMid + len / 3; s <= sEnd - len / 3; s += 2) {
        const p = posOf(nl, s)
        off = Math.max(off, Math.abs((p.x - A.x) * -uz + (p.z - A.z) * ux))
      }
      const third = Math.max(...bendProfile(nl, sMid + len / 3, sEnd - len / 3, 2).map(Math.abs))
      const half = Math.max(...bendProfile(nl, sMid + len / 4, sEnd - len / 4, 2).map(Math.abs))
      if (off > 0.05) bad.push(`${tag}: the middle wanders ${off.toFixed(2)} m off the straight line`)
      if (third > 1 / 5000) bad.push(`${tag}: the middle third still bends (radius ${(1 / third).toFixed(0)} m)`)
      if (half > 1 / 1500) bad.push(`${tag}: the middle half bends (radius ${(1 / half).toFixed(0)} m)`)
      worstMiddle = Math.max(worstMiddle, third)
      if (res.tightest < 25) bad.push(`${tag}: a ${res.tightest.toFixed(0)} m corner where it joins`)
      bad.push(...validRoad(res.points, tag))
    }
    // Two spots right next to each other: refused in plain words, nothing changes.
    const tiny = straightStretch(pts, 10, 10.5, world)
    if (tiny.ok || !tiny.reason) bad.push('two spots 8 m apart were not refused')
    info = `${made} straights made, middle third radius over ${worstMiddle > 0 ? (1 / worstMiddle).toFixed(0) : 'infinite'} m; spots too close refused: "${tiny.reason ?? ''}"`
    return bad
  })

  check('Curve: tangent-matched at both joins, through the pulled spot, never tighter than the minimum', () => {
    const pts = ring(98, 250)
    const line = roadLine(pts)
    const bad: string[] = []
    const a = 10
    const b = 25
    const sA = sOf(line, a)
    const sB = sOf(line, b)
    const A = posOf(line, sA)
    const B = posOf(line, sB)
    const mid = { x: (A.x + B.x) / 2, z: (A.z + B.z) / 2 }
    const r = Math.hypot(mid.x, mid.z)
    // Pull the middle 50 m out from the circle's chord.
    const pull = { x: mid.x + (mid.x / r) * 50, z: mid.z + (mid.z / r) * 50 }
    const res = curveStretch(pts, a, b, pull, world)
    if (!res.ok) return [`refused: ${res.reason}`]
    const nl = roadLine(res.points)
    // Through the pulled spot.
    const near = nearestOnRoad(roadCurve(res.points), pull).distance
    if (near > 1.5) bad.push(`the curve misses the pulled spot by ${near.toFixed(1)} m`)
    // Tangent-matched: at each join the direction just before and just after agree (no kink).
    let worstTurn = 0
    for (const at of [a, b]) {
      const s = sOf(nl, res.mapAt(at))
      const d0 = dirOf(nl, s - 3)
      const d1 = dirOf(nl, s + 3)
      const turn = (Math.acos(Math.max(-1, Math.min(1, d0.x * d1.x + d0.z * d1.z))) * 180) / Math.PI
      worstTurn = Math.max(worstTurn, turn)
      if (turn > 4) bad.push(`a kink at the join near ${at}: the road turns ${turn.toFixed(1)} degrees in 6 m`)
    }
    if (res.tightest < 25) bad.push(`a ${res.tightest.toFixed(0)} m corner`)
    bad.push(...validRoad(res.points, 'curve'))
    // Pulled much too far: refused, red, and says why.
    const far = { x: mid.x + (mid.x / r) * 400, z: mid.z + (mid.z / r) * 400 }
    const tight = curveStretch(pts, a, b, far, world)
    if (tight.ok) bad.push('a curve pulled 400 m out on a 230 m stretch was not refused')
    else if (!/tight/i.test(tight.reason ?? '')) bad.push(`refused for the wrong reason: ${tight.reason}`)
    if (!tight.ok && !tight.tightAt) bad.push('the too-tight spot was not marked')
    info = `passes ${near.toFixed(2)} m from the pulled spot; joins turn at most ${worstTurn.toFixed(1)} degrees in 6 m; tightest ${res.tightest.toFixed(0)} m; pulled 400 m: "${tight.reason ?? ''}"`
    return bad
  })

  check('Corner: gentler and tighter, joining the straights either side with no kink', () => {
    // A drawn square: four corners between long straights.
    const sq = polygon([{ x: -200, z: -200 }, { x: 200, z: -200 }, { x: 200, z: 200 }, { x: -200, z: 200 }], 50)
    const res0 = cleanStroke(sq, opts)
    if (!res0.ok) return ['the square did not clean up']
    const pts = res0.points
    const nearestTo = (list: RoadPoint[], q: P) => list.reduce((b, p, i) => (dist(p, q) < dist(list[b], q) ? i : b), 0)
    const k = nearestTo(pts, { x: 200, z: -200 })
    const c = cornerAt(pts, k)
    if (typeof c === 'string') return [`no corner found at the square's corner: ${c}`]
    const bad: string[] = []
    const seen: string[] = []
    for (const R of [35, 150]) {
      const res = cornerRadius(pts, k, R, world)
      if (!res.ok) {
        bad.push(`${R} m refused: ${res.reason}`)
        continue
      }
      const after = cornerAt(res.points, nearestTo(res.points, { x: 200, z: -200 }))
      if (typeof after === 'string') {
        bad.push(`${R} m: no corner left (${after})`)
        continue
      }
      seen.push(`${R} m asked -> ${after.radius.toFixed(0)} m`)
      if (Math.abs(after.radius - R) > R * 0.2) bad.push(`${R} m asked, the corner came out ${after.radius.toFixed(0)} m`)
      // Nowhere in or around the corner bends harder than the radius asked for (no kink where it meets the straights).
      const nl = roadLine(res.points)
      const peak = Math.max(...bendProfile(nl, after.sIn - 60, after.sOut + 60, 1).map(Math.abs))
      if (peak > 1.2 / R) bad.push(`${R} m: somewhere bends as hard as a ${(1 / peak).toFixed(0)} m corner`)
      // The far side of the square has not moved.
      const far = nearestOnRoad(roadCurve(res.points), { x: -200, z: 0 }).distance
      if (far > 0.5) bad.push(`${R} m: the opposite side moved ${far.toFixed(2)} m`)
      bad.push(...validRoad(res.points, `${R} m`))
    }
    // A point on a straight is not a corner, and says so.
    const onStraight = cornerAt(pts, nearestTo(pts, { x: 0, z: -200 }))
    if (typeof onStraight !== 'string') bad.push('a point in the middle of a straight was taken for a corner')
    info = `was ${c.radius.toFixed(0)} m; ${seen.join(', ')}; on a straight: "${typeof onStraight === 'string' ? onStraight : ''}"`
    return bad
  })

  check('Splice: road outside the changed stretch, and pieces on it, do not move', () => {
    const pts = ring(60, 250)
    const res = curveStretch(pts, 5, 15, { x: 260, z: -150 }, world)
    if (!res.ok) return [`refused: ${res.reason}`]
    const bad: string[] = []
    const kept = new Set(res.points.map((p) => `${p.x},${p.z}`))
    let untouched = 0
    pts.forEach((p, k) => {
      if (k >= 22 && k <= 58) {
        if (kept.has(`${p.x},${p.z}`)) untouched++
        else bad.push(`point ${k}, far from the curve, changed`)
      }
    })
    const line = roadLine(pts)
    const nl = roadLine(res.points)
    for (const at of [30.5, 41.2, 57.9]) {
      const was = posOf(line, sOf(line, at))
      const now = posOf(nl, sOf(nl, res.mapAt(at)))
      const d = Math.hypot(now.x - was.x, now.z - was.z)
      if (d > 0.5) bad.push(`a piece at ${at} moved ${d.toFixed(2)} m`)
    }
    info = `${untouched} far points kept exactly`
    return bad
  })

  // ---------------------------------------------------------------- copies of built-in tracks keep their road height

  const afterglow = afterglowJson as unknown as TrackFile

  check("A copy of a built-in track sits in exactly the original's world", () => {
    // Afterglow has no seed, so its hills come from its id; the copy gets a new id.
    const was = pointGroundOf(afterglow.environment, afterglow.id)
    const now = pointGroundOf(worldForCopy(afterglow), 'afterglow-copy')
    if (!was || !now) return ["a world didn't validate"]
    let worst = 0
    for (const p of afterglow.road.points) worst = Math.max(worst, Math.abs(now(p.x, p.z) - was(p.x, p.z)))
    info = `the ground under all ${afterglow.road.points.length} road points is the same to ${(worst * 1000).toFixed(1)} mm`
    return worst > 0.001 ? [`the copy's ground is ${worst.toFixed(2)} m off the original's under a road point (a copy must keep the seed)`] : []
  })

  check("Shaping a copy of a built-in track keeps its road height (Afterglow: evened, a Curve, an added point)", () => {
    const env = worldForCopy(afterglow)
    const id = 'afterglow-copy'
    const ground = pointGroundOf(env, id)
    if (!ground) return ["the copy's world didn't validate"]
    const shapeWorld = { width: afterglow.road.width ?? 14, bound: roadBound(env), playRadius: Infinity, pointGround: ground }
    const pts = afterglow.road.points
    const startAt = afterglow.start?.at ?? 0
    const build = (points: RoadPoint[], mapAt: (at: number) => number): TrackRuntime | null => {
      const pieces = (afterglow.pieces ?? []).map((p) => ({ ...p, at: Math.round(mapAt(p.at) * 1000) / 1000 }))
      const v = validateTrack(draftFile({ id, name: 'Afterglow copy', points, width: afterglow.road.width, pieces, startAt: Math.round(mapAt(startAt) * 1000) / 1000, environment: env }))
      return v.ok && v.track ? buildTrack(v.track, {}) : null
    }
    const bad: string[] = []
    // 1. The editor's height maths is the game's own curve (src/track/spline.ts) through the same heights.
    const dense = sampleClosedSpline(pts.map((p) => ({ x: p.x, y: pointHeight(p, ground), z: p.z })), 0.5)
    let maths = 0
    for (let j = 0; j < dense.count - 1; j++) maths = Math.max(maths, Math.abs(roadHeightAt(pts, dense.at[j], ground) - dense.y[j]))
    if (maths > 0.001) bad.push(`the editor's road height is ${maths.toFixed(3)} m off the game's curve`)
    const before = build(pts, (at) => at)
    if (!before) return [...bad, 'the copy did not build']
    const hit = {} as NearestHit
    const frame = { position: new THREE.Vector3(), tangent: new THREE.Vector3(), up: new THREE.Vector3(), right: new THREE.Vector3() } as TrackFrame
    /** The road's centre on `t` nearest (x, y, z): the exact spot between samples, not the nearest sample. */
    const roadAt = (t: TrackRuntime, x: number, y: number, z: number, hint?: number) => {
      t.nearest(x, y, z, hit, hint)
      return t.frameAt(hit.s, frame).position
    }
    /** Worst height change at the original points, and every 2 m of road that stayed put on the map. */
    const drift = (after: TrackRuntime) => {
      const B = before.samples
      let points = 0
      for (const p of pts) {
        const yB = roadAt(before, p.x, pointHeight(p, ground), p.z).y
        const q = roadAt(after, p.x, yB, p.z)
        if (Math.hypot(q.x - p.x, q.z - p.z) <= 0.3) points = Math.max(points, Math.abs(q.y - yB))
      }
      let road = 0
      let spots = 0
      let hint: number | undefined
      for (let i = 0; i < B.count; i += 2) {
        if (B.surface[i] === 1) continue // a loop
        const q = roadAt(after, B.px[i], B.py[i], B.pz[i], hint)
        hint = hit.s
        if (Math.hypot(q.x - B.px[i], q.z - B.pz[i]) > 0.3) continue
        spots++
        road = Math.max(road, Math.abs(q.y - B.py[i]))
      }
      return { points, road, spots }
    }
    const gateFails = (t: TrackRuntime) => checkBuiltTrack(t).gates.filter((g) => g.level === 'fail').map((g) => g.name)
    // 2. Evened: what the first Bend, Straight, Curve or Corner does to a built-in copy (40 points -> ~280).
    const even = evenRoad(pts, shapeWorld)
    const evened = build(even.line.points.slice(), even.mapAt)
    if (!evened) return [...bad, 'the evened copy did not build']
    const de = drift(evened)
    if (de.points > 0.02) bad.push(`evened: an original point's road moved ${de.points.toFixed(3)} m up or down (limit 0.02)`)
    if (de.road > 0.06 || de.spots < 1500) bad.push(`evened: the road moved ${de.road.toFixed(3)} m up or down (limit 0.06, over ${de.spots} spots)`)
    const fe = gateFails(evened)
    if (fe.length) bad.push(`evened: the game's checks fail: ${fe.join(', ')}`)
    // 3. A Curve mid-lap (new points on the reshaped stretch, the rest evened).
    const line0 = roadLine(pts)
    const sMid = sOf(line0, startAt) + line0.length * 0.45
    const m = posOf(line0, sMid)
    const d = dirOf(line0, sMid)
    const cur = curveStretch(pts, atOf(line0, sMid - 90), atOf(line0, sMid + 90), { x: m.x - d.z * 12, z: m.z + d.x * 12 }, shapeWorld)
    let dc = { points: 0, road: 0, spots: 0 }
    if (!cur.ok) bad.push(`the Curve was refused: ${cur.reason}`)
    else {
      const curved = build(cur.points, cur.mapAt)
      if (!curved) bad.push('the curved copy did not build')
      else {
        dc = drift(curved)
        if (dc.points > 0.02) bad.push(`Curve: an original point's road moved ${dc.points.toFixed(3)} m up or down (limit 0.02)`)
        if (dc.road > 0.06) bad.push(`Curve: the road outside the curve moved ${dc.road.toFixed(3)} m up or down (limit 0.06)`)
        const fc = gateFails(curved)
        if (fc.length) bad.push(`Curve: the game's checks fail: ${fc.join(', ')}`)
      }
    }
    // 4. A point added halfway between two far-apart points (double-click) sits at the road's height.
    let added = 0
    for (let k = 0; k < pts.length; k++) {
      const spot = posOf(line0, sOf(line0, k + 0.5))
      const y = pointHeight({ ...spot, ...newPointHeight(pts, k + 0.5, spot, ground) }, ground)
      added = Math.max(added, Math.abs(roadAt(before, spot.x, y, spot.z).y - y))
    }
    if (added > 0.05) bad.push(`a point added between two road points sits ${added.toFixed(3)} m off the road (limit 0.05)`)
    info = `maths = game's curve to ${(maths * 1000).toFixed(2)} mm; evened ${pts.length} -> ${even.line.points.length} points: original points ${(de.points * 100).toFixed(1)} cm, road ${(de.road * 100).toFixed(1)} cm (${de.spots} spots); Curve: ${(dc.points * 100).toFixed(1)} cm, ${(dc.road * 100).toFixed(1)} cm; added points ${(added * 100).toFixed(1)} cm; every gate passes`
    return bad
  })

  check('Steady pencil: the lazy-mouse string removes hand wobble', () => {
    // A circle drawn on screen (300 px) with a shaky hand: a few pixels of tremor every few pixels.
    const r = rng(11)
    const raw: P[] = []
    let wx = 0
    let wz = 0
    for (let i = 0; i <= 700; i++) {
      const a = (i / 700) * TAU * 1.03
      wx = wx * 0.6 + (r() - 0.5) * 5
      wz = wz * 0.6 + (r() - 0.5) * 5
      raw.push({ x: 960 + 300 * Math.cos(a) + wx, z: 540 + 300 * Math.sin(a) + wz })
    }
    /** How much the line's direction jitters: mean turn per point, degrees (a clean circle of this size is about 0.6). */
    const jitter = (pts: P[]) => {
      const even = resampleOpen(pts, 6)
      let sum = 0
      for (let i = 1; i < even.length - 1; i++) sum += Math.abs(turnAngle(even[i - 1], even[i], even[i + 1]))
      return ((sum / Math.max(1, even.length - 2)) * 180) / Math.PI
    }
    const off = jitter(steadyPath(raw, STEADY_STRING[0]))
    const some = jitter(steadyPath(raw, STEADY_STRING[STEADY_DEFAULT]))
    const lot = jitter(steadyPath(raw, STEADY_STRING[STEADY_STRING.length - 1]))
    const bad: string[] = []
    if (!(some < off * 0.5)) bad.push(`the default steady hand only took the jitter from ${off.toFixed(2)} to ${some.toFixed(2)} degrees (want half or less)`)
    if (!(lot < some)) bad.push(`"a lot" (${lot.toFixed(2)}) is not steadier than the default (${some.toFixed(2)})`)
    // And the road it makes (screen pixels as metres at a 1.8 m-per-pixel zoom) is smoother too.
    const toWorld = (pts: P[]) => pts.map((p) => ({ x: (p.x - 960) * 1.8, z: (p.z - 540) * 1.8 }))
    const roadOff = cleanStroke(toWorld(steadyPath(raw, 0)), { ...opts, bound: 2000 })
    const roadOn = cleanStroke(toWorld(steadyPath(raw, STEADY_STRING[STEADY_DEFAULT])), { ...opts, bound: 2000 })
    const ro = roadOff.ok ? builtRoughness(roadOff.points) : NaN
    const rs = roadOn.ok ? builtRoughness(roadOn.points) : NaN
    if (!(rs <= ro)) bad.push(`the steadied road is not smoother (${rs.toFixed(0)} vs ${ro.toFixed(0)} without)`)
    info = `direction jitter ${off.toFixed(2)} (off) -> ${some.toFixed(2)} (default) -> ${lot.toFixed(2)} degrees (a lot); road wobble ${ro.toFixed(0)} -> ${rs.toFixed(0)}`
    return bad
  })

  return results
}

/** An open polyline re-spaced every `step` (for measuring a pencil line). */
function resampleOpen(pts: readonly P[], step: number): P[] {
  const out: P[] = [pts[0]]
  let carry = 0
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    const seg = Math.hypot(b.x - a.x, b.z - a.z)
    let t = step - carry
    while (t <= seg) {
      out.push({ x: a.x + ((b.x - a.x) * t) / seg, z: a.z + ((b.z - a.z) * t) / seg })
      t += step
    }
    carry = seg - (t - step)
  }
  return out
}

function printTable(results: CheckResult[]): void {
  const width = Math.max(...results.map((r) => r.name.length))
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.detail}`)
  const failed = results.filter((r) => !r.pass).length
  console.log(failed ? `\n${failed} of ${results.length} checks failed` : `\nAll ${results.length} checks passed`)
}

// Run directly with Bun: print the table and exit non-zero on failure.
if ((import.meta as ImportMeta & { main?: boolean }).main) {
  const t0 = performance.now()
  const results = runEditorSelfTest()
  printTable(results)
  console.log(`(${(performance.now() - t0).toFixed(0)} ms)`)
  if (results.some((r) => !r.pass)) (globalThis as unknown as { process: { exit(code: number): void } }).process.exit(1)
}
