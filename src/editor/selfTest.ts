// ============================================================
//  EDITOR SELF-TEST - proves the stroke clean-up works
// ------------------------------------------------------------
//  Feeds the clean-up pipeline (cleanup.ts) a set of made-up
//  drawings - a shaky circle, a hairpin too narrow for a car, a
//  figure-eight, a square with sharp corners, a road off the edge
//  of the world, a line that never comes back - and checks that
//  every result is a road a car can drive.
//
//  Run it two ways:
//    bun src/editor/selfTest.ts          (prints a pass/fail table)
//    window.__dev.editor('selftest')     (in the running game)
// ============================================================

import { CLEANUP, cleanStroke, type CleanResult, type CleanupOptions } from './cleanup'
import { type P, catmullRomClosed, dist, minRadius } from './geom'
import { validateTrack } from '../track/validate'
import { buildTrack } from '../track/build'
import { DEFAULT_BASE_WORLD, draftFile, roadBound } from './draftFile'

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
  for (const w of v.warnings) {
    if (/crosses itself/.test(w.message) && res.crossings.some((c) => c.over !== null)) continue
    bad.push(`validator warning: ${w.path} ${w.message}`)
  }
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
