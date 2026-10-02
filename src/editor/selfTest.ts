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

import { CLEANUP, cleanStroke, type CleanResult, type CleanupOptions } from './cleanup'
import { type P, catmullRomClosed, dist, minRadius } from './geom'
import { validateTrack } from '../track/validate'
import { buildTrack } from '../track/build'
import { BASE_WORLDS, DEFAULT_BASE_WORLD, clearedDraft, draftFile, isBlankDraft, roadBound } from './draftFile'
import { atAfterDelete, atAfterInsert, frameAt, nearestOnRoad, roadCurve, sectionRedraw } from './road'
import type { Piece, RoadPoint } from '../track/schema'
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

  return results
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
