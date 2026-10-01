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
  await mod.default.init()
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
  let minR = Infinity
  let maxBank = 0
  let minY = Infinity
  let maxY = -Infinity
  let grounded = 0
  for (let i = 0; i < S.count; i++) {
    if (S.surface[i] === SURFACE_CODE.road) {
      const k = Math.abs(S.curvature[i])
      if (k > 1e-6) minR = Math.min(minR, 1 / k)
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
  console.log(`\n✓ ${name}  "${t.name}"  key ${t.key}`)
  console.log(`    road      ${(t.length / 1000).toFixed(2)} km, ${S.count} samples @ ${S.ds.toFixed(3)} m, tightest radius ${minR.toFixed(0)} m, max bank ${((maxBank * 180) / Math.PI).toFixed(1)} deg`)
  console.log(`    height    road ${minY.toFixed(1)} .. ${maxY.toFixed(1)} m, ${((grounded / S.count) * 100).toFixed(0)}% grounded; terrain ${t.terrain.minHeight.toFixed(1)} .. ${t.terrain.maxHeight.toFixed(1)} m on a ${t.terrain.n}x${t.terrain.n} grid (${t.terrain.cellSize.toFixed(2)} m cells)`)
  console.log(`    pieces    ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ') || 'none'}`)
  console.log(`    derived   ${t.checkpoints.length} checkpoints, ${t.props.length} prop spots, ${t.cores.length} cores, ${t.roadside.posts.length} posts, ${t.roadside.billboards.length} billboards`)
  console.log(`    racing    line speeds ${(vmin * 3.6).toFixed(0)} .. ${(vmax * 3.6).toFixed(0)} km/h`)
  console.log(`    meshes    road ${t.meshes.road.indices.length / 3} tris, skirt ${t.meshes.skirt.indices.length / 3}, barriers ${t.meshes.barriers ? t.meshes.barriers.indices.length / 3 : 0}, ramps ${t.meshes.ramps ? t.meshes.ramps.indices.length / 3 : 0}`)
  console.log(`    world     ${t.world.size} m, edge ${t.world.edge}, play radius ${t.world.playRadius.toFixed(0)} m, reset below ${t.world.resetY.toFixed(1)} m`)
  console.log(`    build     ${x ? x.buildMs.toFixed(0) : '?'} ms`)
  // No kinks: a sharp change of direction between neighbouring samples is a bump or a step.
  const { groundClearance, ribbonSmoothness, crossingClearance, windingErrors, bankCheck } = await import('../src/track/selftest')
  // Every visible triangle faces outward (agrees with its vertex normals).
  const wind = windingErrors(t)
  const windBad = Object.values(wind).reduce((n, w) => n + w.bad, 0)
  if (windBad) failed++
  console.log(`    winding   ${windBad ? 'FAIL' : 'ok  '} ${Object.entries(wind).map(([k, w]) => `${k} ${w.total - w.bad}/${w.total}`).join(', ')} triangles face the way their normals do`)
  const sm = ribbonSmoothness(t)
  const smoothOk = sm.roadTurn < 4 && sm.upTurn < 4 && sm.loopTurn < 9 && sm.spacingErr < 0.05
  if (!smoothOk) failed++
  console.log(`    smooth    ${smoothOk ? 'ok  ' : 'FAIL'} sharpest turn ${sm.roadTurn.toFixed(2)} deg/m on the road (s=${sm.at.toFixed(0)}), ${sm.loopTurn.toFixed(2)} in loops; roll ${sm.upTurn.toFixed(2)} deg/m; spacing error ${(sm.spacingErr * 100).toFixed(1)} cm`)
  // Banking leans into every corner and rolls gently, including across the start-line seam.
  {
    const hasOverrides = v.track.road.points.some((p) => typeof p.bank === 'number')
    const adj = v.track.road.banking.adjustable
    for (const b of adj ? [adj.max] : [null]) {
      const tb = b === null ? t : buildTrack(v.track, { bankDeg: b }, t)
      const bc = bankCheck(tb)
      const rateOk = bc.maxRate <= 1.5
      const signOk = hasOverrides || bc.wrongSign === 0
      if (!rateOk || !signOk) failed++
      console.log(
        `    banking   ${rateOk && signOk ? 'ok  ' : 'FAIL'} ${b === null ? '' : `bank ${b} deg: `}fastest roll ${bc.maxRate.toFixed(2)} deg/m at s=${bc.rateAt.toFixed(0)} (limit 1.5); ${bc.wrongSign} m leaning out of a corner${bc.wrongSign ? ` (first at s=${bc.wrongAt.toFixed(0)})` : ''}${hasOverrides ? ' (file has bank overrides: not judged)' : ''}`,
      )
    }
  }
  // Bridges: where the road passes over itself, a car must fit underneath.
  const cross = crossingClearance(t)
  if (cross) {
    const ok = cross.gap >= 6.2
    if (!ok) failed++
    console.log(`    bridges   ${ok ? 'ok  ' : 'FAIL'} the road passes over itself with ${cross.gap.toFixed(1)} m between levels at the tightest (s=${cross.s1.toFixed(0)} over s=${cross.s2.toFixed(0)}; needs 6.2 m: slab plus a car)`)
  }
  // The ground must stay under the road everywhere (at every bank angle a slider allows).
  const adjBank = v.track.road.banking.adjustable
  const variants = adjBank ? [adjBank.min, v.track.road.banking.maxDeg, adjBank.max] : [null]
  for (const b of variants) {
    const tv = b === null ? t : buildTrack(v.track, { bankDeg: b }, t)
    const g = groundClearance(tv)
    const ok = g.worst < -0.1
    if (!ok) failed++
    console.log(`    ground    ${ok ? 'ok  ' : 'FAIL'} ${b === null ? '' : `bank ${b} deg: `}ground stays ${(-g.worst).toFixed(2)} m or more under the road (closest at s=${g.s.toFixed(0)}, lateral ${g.lateral.toFixed(1)})`)
  }
  for (const w of v.warnings) console.log(`    warning   ${w.path || '(file)'}: ${w.message}`)

  if (bench) {
    const { benchQueries } = await import('../src/track/selftest')
    // Rebuild timings: a cold build, then live rebuilds that reuse the natural ground.
    const times: number[] = []
    let prev = t
    for (let k = 0; k < 5; k++) {
      prev = buildTrack(v.track, { ...t.params }, prev)
      times.push(trackInternals(prev)?.buildMs ?? 0)
    }
    const b = benchQueries(t)
    console.log(`    bench     cold build ${x ? x.buildMs.toFixed(0) : '?'} ms; live rebuild ${Math.min(...times).toFixed(0)}-${Math.max(...times).toFixed(0)} ms`)
    console.log(`    bench     frameAt ${b.frameAtUs.toFixed(2)} us, nearest with hint ${b.nearestHintUs.toFixed(2)} us, nearest cold ${b.nearestColdUs.toFixed(2)} us, terrainHeight ${b.terrainUs.toFixed(2)} us`)
  }
  if (physics) {
    const { runPhysicsSelfTest } = await import('../src/track/selftest')
    const r = runPhysicsSelfTest(t, await loadGameRapier())
    for (const line of r.lines) console.log(`    physics   ${line}`)
    if (!r.ok) failed++
  }
}

console.log(failed ? `\n${failed} track(s) failed.` : `\nAll ${targets.length} track(s) OK.`)
process.exit(failed ? 1 : 0)
