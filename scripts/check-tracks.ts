// ============================================================
//  CHECK TRACKS - prove a track file works without opening the game
// ------------------------------------------------------------
//    bun run tracks:check                    every tracks/*.json
//    bun run tracks:check tracks/foo.json    just one file
//    bun run tracks:check --physics          also drop test cars on
//                                            the road in a headless
//                                            rapier world (selftest.ts)
//
//  For each track it validates the file, builds the whole runtime
//  (road, terrain, meshes, racing line...) exactly as the game does,
//  and prints a one-screen summary. Exit code 1 if any track has an
//  error, so a future session (or Josh) can trust "it printed OK".
// ============================================================

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { validateTrack } from '../src/track/validate'
import { buildTrack, trackInternals } from '../src/track/build'
import { SURFACE_CODE } from '../src/track/types'
import { LINE_MAX_LAT_G } from '../src/track/derived'

const args = process.argv.slice(2)
const physics = args.includes('--physics')
const bench = args.includes('--bench')
const files = args.filter((a) => !a.startsWith('--'))
const root = resolve(import.meta.dir, '..')
const targets = files.length
  ? files.map((f) => resolve(f))
  : readdirSync(join(root, 'tracks'))
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => join(root, 'tracks', f))

/**
 * The exact rapier the game runs: @react-three/rapier's own copy. (An older
 * copy is hoisted to node_modules/@dimforge for @types/three; testing against
 * that one would prove nothing about the game.)
 */
let rapier: unknown = null
async function loadGameRapier() {
  if (rapier) return rapier as never
  const req = createRequire(import.meta.url)
  const from = dirname(req.resolve('@react-three/rapier/package.json'))
  const path = createRequire(join(from, 'package.json')).resolve('@dimforge/rapier3d-compat')
  const mod = await import(path)
  // rapier's own loader prints a harmless 'deprecated parameters' notice; keep the output clean.
  const warn = console.warn
  console.warn = (...a: unknown[]) => {
    if (!String(a[0]).includes('deprecated parameters')) warn(...a)
  }
  await mod.default.init()
  console.warn = warn
  rapier = mod.default
  return rapier as never
}

let failed = 0
for (const path of targets) {
  const name = path.split('/').pop()
  let json: unknown
  try {
    json = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    console.log(`\n✗ ${name}: not valid JSON (${(err as Error).message})`)
    failed++
    continue
  }
  const v = validateTrack(json)
  if (!v.ok || !v.track) {
    console.log(`\n✗ ${name}: ${v.errors.length} error(s)`)
    for (const e of v.errors) console.log(`    error   ${e.path || '(file)'}: ${e.message}`)
    for (const w of v.warnings) console.log(`    warning ${w.path || '(file)'}: ${w.message}`)
    failed++
    continue
  }
  const id = (json as { id: string }).id
  if (name !== `${id}.json`) v.warnings.push({ path: 'id', message: `the file is called ${name} but the id is "${id}"; they should match` })

  let t
  try {
    const adj = v.track.road.banking.adjustable
    t = buildTrack(v.track, adj ? { bankDeg: v.track.road.banking.maxDeg } : {})
  } catch (err) {
    console.log(`\n✗ ${name}: the build threw: ${(err as Error).stack}`)
    failed++
    continue
  }
  const S = t.samples
  const sel = await import('../src/track/selftest')
  const at = (sv: number) => sel.where(t, sv)
  // One failed track counts once, however many rows fail.
  let trackFailed = false
  const row = (label: string, ok: boolean, text: string, fix?: string) => {
    if (!ok) trackFailed = true
    console.log(`    ${label.padEnd(9)} ${ok ? 'ok  ' : 'FAIL'} ${text}`)
    if (!ok && fix) console.log(`              fix: ${fix}`)
  }
  let minR = Infinity
  let minRAt = 0
  let maxBank = 0
  let minY = Infinity
  let maxY = -Infinity
  let grounded = 0
  for (let i = 0; i < S.count; i++) {
    if (S.surface[i] === SURFACE_CODE.road) {
      const k = Math.abs(S.curvature[i])
      if (k > 1e-6 && 1 / k < minR) {
        minR = 1 / k
        minRAt = i * S.ds
      }
    }
    maxBank = Math.max(maxBank, Math.abs(S.bank[i]))
    minY = Math.min(minY, S.py[i])
    maxY = Math.max(maxY, S.py[i])
    grounded += S.grounded[i]
  }
  const counts: Record<string, number> = {}
  for (const p of t.pieces) counts[p.type] = (counts[p.type] ?? 0) + 1
  const x = trackInternals(t)
  const rl = t.racingLine.speed
  let vmin = Infinity
  let vmax = 0
  for (let i = 0; i < rl.length; i++) {
    vmin = Math.min(vmin, rl[i])
    vmax = Math.max(vmax, rl[i])
  }
  console.log(`\n${name}  "${t.name}"  key ${t.key}`)
  console.log(`    road      ${(t.length / 1000).toFixed(2)} km, ${S.count} samples @ ${S.ds.toFixed(3)} m, tightest radius ${minR.toFixed(0)} m at ${at(minRAt)}, max bank ${((maxBank * 180) / Math.PI).toFixed(1)} deg`)
  console.log(`    height    road ${minY.toFixed(1)} .. ${maxY.toFixed(1)} m, ${((grounded / S.count) * 100).toFixed(0)}% grounded; terrain ${t.terrain.minHeight.toFixed(1)} .. ${t.terrain.maxHeight.toFixed(1)} m on a ${t.terrain.n}x${t.terrain.n} grid (${t.terrain.cellSize.toFixed(2)} m cells)`)
  console.log(`    pieces    ${t.pieces.map((p) => `${p.type} ${at(p.s0)}`).join(', ') || 'none'}`)
  console.log(`    checkpts  ${t.checkpoints.length}: ${Array.from(t.checkpoints).map((c) => `at ${(x ? x.atOfS(c) : 0).toFixed(1)}`).join(', ')}`)
  console.log(`    derived   ${t.props.length} prop spots, ${t.cores.length} cores, ${t.roadside.posts.length} posts, ${t.roadside.billboards.length} billboards`)
  const wantBb = v.track.environment.roadside.billboards
  if (t.roadside.billboards.length < wantBb) {
    v.warnings.push({ path: 'environment.roadside.billboards', message: `asked for ${wantBb}, placed ${t.roadside.billboards.length}: there are only that many clear spots 25-45 m outside the bends (fewer is fine; widen the world or the bends for more)` })
  }
  console.log(`    racing    line speeds ${(vmin * 3.6).toFixed(0)} .. ${(vmax * 3.6).toFixed(0)} km/h`)
  // Crests: where the road goes light, so an author can check a jump does what they meant.
  {
    const W = Math.max(1, Math.round(6 / S.ds))
    const crests: { s: number; R: number }[] = []
    let cur: { s: number; R: number } | null = null
    for (let i = 0; i < S.count; i++) {
      if (S.surface[i] !== SURFACE_CODE.road) continue
      const a = (i - W + S.count) % S.count
      const b = (i + W) % S.count
      const ga = S.ty[a] / (Math.hypot(S.tx[a], S.tz[a]) || 1)
      const gb = S.ty[b] / (Math.hypot(S.tx[b], S.tz[b]) || 1)
      const kv = (gb - ga) / (2 * W * S.ds)
      if (kv < -1 / 400) {
        const R = -1 / kv
        if (cur && i * S.ds - cur.s < 20) {
          if (R < cur.R) cur = { s: i * S.ds, R }
          crests[crests.length - 1] = cur
        } else {
          cur = { s: i * S.ds, R }
          crests.push(cur)
        }
      }
    }
    console.log(`    crests    ${crests.length ? crests.map((c) => `${at(c.s)}: vertical radius ${c.R.toFixed(0)} m, goes light above ${(Math.sqrt(9.81 * c.R) * 3.6).toFixed(0)} km/h`).join('; ') : 'none (no crest tighter than a 400 m vertical radius)'}`)
  }
  // The start grid should sit on straight, level-ish road (12 slots: 47 m behind the line).
  {
    let worstK = 0
    let worstBank = 0
    for (let sv = -50; sv <= 10; sv += 1) {
      const i = Math.round(t.wrapS(sv) / S.ds) % S.count
      worstK = Math.max(worstK, Math.abs(S.curvature[i]))
      worstBank = Math.max(worstBank, Math.abs(S.bank[i]))
    }
    const ok = worstK < 1 / 400 && (worstBank * 180) / Math.PI < 3
    if (!ok) v.warnings.push({ path: 'start.at', message: `the start grid (50 m behind the line to 10 m after it) is on a bend (tightest radius ${(1 / Math.max(worstK, 1e-9)).toFixed(0)} m) or banked (${((worstBank * 180) / Math.PI).toFixed(1)} deg); move start.at onto a straight` })
  }
  {
    // The racing line must be a real line: not glued to one edge, never closer to an edge
    // than the margin, never planning more sideways grip than the car has, and never
    // braking harder than the brakes can on that bit of hill, and never turning tighter
    // than the least grippy car can steer at that speed.
    const margin = v.track.road.barriers === 'walls' ? 3 : 2.5
    const r = sel.racingLineStats(t)
    const LIM = { clamp: 0.35, run: 150, grip: +(LINE_MAX_LAT_G + 0.05).toFixed(2) }
    const bad: string[] = []
    if (r.clampFrac > LIM.clamp) bad.push(`${(r.clampFrac * 100).toFixed(0)}% at a limit > ${LIM.clamp * 100}%`)
    if (r.longestClampM > LIM.run) bad.push(`longest stretch at a limit ${r.longestClampM.toFixed(0)} m > ${LIM.run} m`)
    if (r.minEdgeGap < margin - 0.05) bad.push(`closest to an edge ${r.minEdgeGap.toFixed(2)} m < ${margin} m`)
    if (r.maxLatG > LIM.grip) bad.push(`planned grip ${r.maxLatG.toFixed(2)} g > limit ${LIM.grip} g`)
    if (r.lockShare > 1) bad.push(`a corner at ${r.lockShareKmh.toFixed(0)} km/h needs ${(r.lockShare * 100).toFixed(0)}% of the least grippy car's full lock (a builder bug, not your file)`)
    if (r.brakeOverM > 0) bad.push(`${r.brakeOverM.toFixed(0)} m of braking asks ${r.brakeOverBy.toFixed(2)} m/s^2 more than the brakes have on that slope (a builder bug, not your file)`)
    row(
      'line',
      bad.length === 0,
      bad.length ? bad.join('; ') : `${(r.clampFrac * 100).toFixed(0)}% of the lap at a limit (longest ${r.longestClampM.toFixed(0)} m), closest ${r.minEdgeGap.toFixed(2)} m to an edge (needs ${margin}), planned grip up to ${r.maxLatG.toFixed(2)} g (limit ${LIM.grip}), at most ${(r.lockShare * 100).toFixed(0)}% of full lock (at ${r.lockShareKmh.toFixed(0)} km/h), braking fits every slope`,
      'the builder plans these itself; a failure means a corner is too tight or too abrupt for it. Ease the corner: spread its points out or add a point so the curve tightens gradually.',
    )
  }
  console.log(`    meshes    road ${t.meshes.road.indices.length / 3} tris, skirt ${t.meshes.skirt.indices.length / 3}, barriers ${t.meshes.barriers ? t.meshes.barriers.indices.length / 3 : 0}, ramps ${t.meshes.ramps ? t.meshes.ramps.indices.length / 3 : 0}`)
  console.log(`    world     ${t.world.size} m, edge ${t.world.edge}, play radius ${t.world.playRadius.toFixed(0)} m, reset below ${t.world.resetY.toFixed(1)} m`)
  console.log(`    build     ${x ? x.buildMs.toFixed(0) : '?'} ms`)
  // Every visible triangle faces outward (agrees with its vertex normals).
  const wind = sel.windingErrors(t)
  const windBad = Object.values(wind).reduce((n, w) => n + w.bad, 0)
  row('winding', windBad === 0, `${Object.entries(wind).map(([k, w]) => `${k} ${w.total - w.bad}/${w.total}`).join(', ')} triangles face the way their normals do`, 'this is a builder bug, not your file: report it.')
  // No kinks: a sharp change of direction between neighbouring samples is a bump or a step.
  const sm = sel.ribbonSmoothness(t)
  row(
    'smooth',
    sm.roadTurn < 4 && sm.upTurn < 4 && sm.loopTurn < 9 && sm.spacingErr < 0.05,
    `sharpest turn ${sm.roadTurn.toFixed(2)} deg/m on the road at ${at(sm.at)} (limit 4), ${sm.loopTurn.toFixed(2)} in loops (limit 9); roll ${sm.upTurn.toFixed(2)} deg/m (limit 4); spacing error ${(sm.spacingErr * 100).toFixed(1)} cm`,
    'a corner tighter than ~15 m radius, or two points almost on top of each other: spread the points near that at.',
  )
  // Banking leans into every corner and rolls gently, including across the start-line seam.
  {
    const adj = v.track.road.banking.adjustable
    for (const b of adj ? [adj.max] : [null]) {
      const tb = b === null ? t : buildTrack(v.track, { bankDeg: b }, t)
      const bc = sel.bankCheck(tb)
      const bad: string[] = []
      if (bc.maxRate > 1.5) bad.push(`roll changes ${bc.maxRate.toFixed(2)} deg/m at ${at(bc.rateAt)} > limit 1.5`)
      // Up to 5 m is allowed: rolling smoothly through an S-bend means the lean trails the curve briefly.
      if (bc.wrongSign > 5) bad.push(`${bc.wrongSign} m leaning OUT of a corner (limit 5 m), first at ${at(bc.wrongAt)}`)
      row(
        'banking',
        bad.length === 0,
        `${b === null ? '' : `bank ${b} deg: `}${bad.length ? bad.join('; ') : `fastest roll ${bc.maxRate.toFixed(2)} deg/m (limit 1.5), ${bc.wrongSign} m leaning out of a corner (limit 5)`}${bc.overrideOut ? `; ${bc.overrideOut} m off-camber because of your bank overrides (allowed)` : ''}`,
        'the road there changes direction too abruptly for the auto-bank to follow (often a point squeezed between two bends): move the point a little so the bend flows, or set a `bank` override there.',
      )
    }
  }
  // Bridges: where the road passes over itself, a car must fit underneath.
  const cross = sel.crossingClearance(t)
  const bridgeLow = !!cross && cross.gap < 6.2
  if (cross) {
    row(
      'bridges',
      cross.gap >= 6.2,
      `the road passes over itself with ${cross.gap.toFixed(1)} m between levels at the tightest (${at(cross.s1)} over ${at(cross.s2)}; needs 6.2 m: slab plus a car)`,
      'give the upper road more `lift` at the crossing (8 m or more).',
    )
  }
  // Road tracking: nearest() with a hint never jumps to another bit of road by mistake,
  // and a car that dropped off a bridge is found on the road below.
  {
    const r = sel.roadTracking(t)
    row(
      'tracking',
      r.failures.length === 0,
      r.failures.length
        ? r.failures.slice(0, 3).join('; ')
        : `walked the lap with hints in 3 lanes (biggest step ${r.maxStep.toFixed(1)} m)${r.crossings ? `; at ${r.crossings} crossing(s) a car is found on the level it is on, fallen, stale hint or none` : ''}`,
      'this is a builder bug, not your file: report it.',
    )
  }
  // The ground must stay under the road everywhere (at every bank angle a slider allows).
  const adjBank = v.track.road.banking.adjustable
  const variants = adjBank ? [adjBank.min, v.track.road.banking.maxDeg, adjBank.max] : [null]
  for (const b of variants) {
    const tv = b === null ? t : buildTrack(v.track, { bankDeg: b }, t)
    const g = sel.groundClearance(tv)
    // Tolerance 3 cm: right at the lip the rule asks for 3 cm, so this still means "never above the road".
    row(
      'ground',
      g.worst <= 0.03 && Math.abs(g.edgeStep) <= 0.1,
      `${b === null ? '' : `bank ${b} deg: `}the ground stays under the road everywhere (closest ${(g.worst * 100).toFixed(1)} cm past the allowed clearance at ${at(g.s)}, lateral ${g.lateral.toFixed(1)}; limit 3 cm); just outside the edge it sits ${(g.edgeStep * 100).toFixed(0)} cm below the lip (median, limit 10)`,
      bridgeLow ? 'the bridge above is too low: under a bridge the ground is cut away to make room, which can dig under the road below. Fix the bridges row first.' : 'this is a builder bug, not your file: report it.',
    )
  }
  for (const w of v.warnings) console.log(`    warning   ${w.path || '(file)'}: ${w.message}`)

  if (bench) {
    // Rebuild timings: a cold build, then live rebuilds that reuse the natural ground.
    const times: number[] = []
    let prev = t
    for (let k = 0; k < 5; k++) {
      prev = buildTrack(v.track, { ...t.params }, prev)
      times.push(trackInternals(prev)?.buildMs ?? 0)
    }
    const b = sel.benchQueries(t)
    console.log(`    bench     cold build ${x ? x.buildMs.toFixed(0) : '?'} ms; live rebuild ${Math.min(...times).toFixed(0)}-${Math.max(...times).toFixed(0)} ms`)
    console.log(`    bench     frameAt ${b.frameAtUs.toFixed(2)} us, nearest with hint ${b.nearestHintUs.toFixed(2)} us, nearest cold ${b.nearestColdUs.toFixed(2)} us, terrainHeight ${b.terrainUs.toFixed(2)} us`)
  }
  if (physics) {
    const r = sel.runPhysicsSelfTest(t, await loadGameRapier())
    for (const line of r.lines) console.log(`    physics   ${line}`)
    if (!r.ok) trackFailed = true
  }
  if (trackFailed) failed++
  console.log(`    result    ${trackFailed ? '✗ FAILED (see the FAIL rows above)' : '✓ OK'}`)
}

console.log(failed ? `\n${failed} of ${targets.length} track(s) failed.` : `\nAll ${targets.length} track(s) OK.`)
process.exit(failed ? 1 : 0)
