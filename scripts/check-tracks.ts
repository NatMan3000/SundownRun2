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
import { runTrackGates, where } from '../src/track/gates'

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
  const at = (sv: number) => where(t, sv)
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
  console.log(`    meshes    road ${t.meshes.road.indices.length / 3} tris, skirt ${t.meshes.skirt.indices.length / 3}, barriers ${t.meshes.barriers ? t.meshes.barriers.indices.length / 3 : 0}, ramps ${t.meshes.ramps ? t.meshes.ramps.indices.length / 3 : 0}`)
  console.log(`    world     ${t.world.size} m, edge ${t.world.edge}, play radius ${t.world.playRadius.toFixed(0)} m, reset below ${t.world.resetY.toFixed(1)} m`)
  console.log(`    build     ${x ? x.buildMs.toFixed(0) : '?'} ms`)
  // Every gate that needs no physics: the same function the road editor runs (src/track/gates.ts).
  for (const g of runTrackGates(t)) {
    if (g.level === 'warn') v.warnings.push({ path: g.name, message: g.message })
    else row(g.name, g.ok, g.message, g.fix)
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
    const sel = await import('../src/track/selftest')
    const b = sel.benchQueries(t)
    console.log(`    bench     cold build ${x ? x.buildMs.toFixed(0) : '?'} ms; live rebuild ${Math.min(...times).toFixed(0)}-${Math.max(...times).toFixed(0)} ms`)
    console.log(`    bench     frameAt ${b.frameAtUs.toFixed(2)} us, nearest with hint ${b.nearestHintUs.toFixed(2)} us, nearest cold ${b.nearestColdUs.toFixed(2)} us, terrainHeight ${b.terrainUs.toFixed(2)} us`)
  }
  if (physics) {
    const sel = await import('../src/track/selftest')
    const r = sel.runPhysicsSelfTest(t, await loadGameRapier())
    for (const line of r.lines) console.log(`    physics   ${line}`)
    if (!r.ok) trackFailed = true
  }
  if (trackFailed) failed++
  console.log(`    result    ${trackFailed ? '✗ FAILED (see the FAIL rows above)' : '✓ OK'}`)
}

console.log(failed ? `\n${failed} of ${targets.length} track(s) failed.` : `\nAll ${targets.length} track(s) OK.`)
process.exit(failed ? 1 : 0)
