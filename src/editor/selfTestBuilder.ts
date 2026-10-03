// ============================================================
//  SELF-TEST: THE GAME'S OWN BUGS ON DRAWN ROADS - rows for selfTest.ts
// ------------------------------------------------------------
//  The editor's self-test (selfTest.ts) calls builderRows() at the
//  end. Each row builds a road the editor really made (a shaky
//  drawing cleaned up, a hand-set bank, a raised stretch) and checks
//  that a check the editor shows as GAME BUG (nothing Josh can do)
//  passes, because the track builder got it right:
//
//    low edge     a hand-banked road keeps level ground beside its
//                 low edge right up to where it lifts off the ground
//                 (it used to sag into a groove there: `lowedge`)
//    bridges      a bridge over a road banked by hand is measured over
//                 the road's high lane, which rises toward it: too low
//                 shows as LOW BRIDGE (Josh's to fix), never as the
//                 game losing track of the cars under it (`tracking`)
//    raise        every half metre the Height tool offers on an
//                 Afterglow copy builds (some heights between 9.5 and
//                 12.5 m didn't)
//
//  Each row failed before the builder fix it guards (track8).
// ============================================================

import { cleanStroke } from './cleanup'
import type { P } from './geom'
import { BASE_WORLDS, DEFAULT_BASE_WORLD, draftFromFile, pointGroundOf, roadBound } from './draftFile'
import { judgeDraft } from './judge'
import { type GroundFn, builtGapAt, roadCrossings } from './bridges'
import { liftBridgeBy } from './bankBridges'
import { problemsOf } from './problems'
import { runFix } from './fixes'
import { alongRoad, atOf, roadLine, sOf, sOfPoint } from './shape'
import { heightStretchAround } from './stretchRuns'
import { raiseDraft } from './raise'
import type { Draft } from './draft'
import type { TrackFile } from '../track/schema'
import { BRIDGE_ROOM, crossingClearance } from '../track/gates'
import afterglowJson from '../../tracks/afterglow.json'

type Check = (name: string, fn: () => string[] | string) => void

const TAU = Math.PI * 2
/** Flat ground, for a world with no hills. */
const FLAT: GroundFn = () => 0

/** Small seeded random numbers, so the drawings are the same every run. */
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

/** A shape traced by a slightly shaky hand: `count` points from t0 to t1. */
function shaky(shape: (t: number) => P, count: number, wobble: number, seed: number, t0: number, t1: number): P[] {
  const r = rng(seed)
  const out: P[] = []
  let wx = 0
  let wz = 0
  for (let i = 0; i <= count; i++) {
    const p = shape(t0 + ((t1 - t0) * i) / count)
    wx = wx * 0.7 + (r() - 0.5) * wobble
    wz = wz * 0.7 + (r() - 0.5) * wobble
    out.push({ x: p.x + wx, z: p.z + wz })
  }
  return out
}

/** A drawn road, cleaned up the way the pencil does, as a draft in one of the base worlds. */
function drawn(id: string, shape: (t: number) => P, seed: number, world: string | undefined, t0: number, t1: number): { d: Draft; ground: GroundFn } | null {
  const base = BASE_WORLDS.find((b) => b.id === world) ?? DEFAULT_BASE_WORLD
  const res = cleanStroke(shaky(shape, 600, 3, seed, t0, t1), { bound: roadBound(base.environment), width: 14 })
  if (!res.ok) return null
  const environment = { ...JSON.parse(JSON.stringify(base.environment)), seed }
  const d = { id, name: id, author: '', description: '', points: res.points, width: 14, baseWorld: base.id, environment, pieces: [], props: [], cores: [], startAt: 0 } as unknown as Draft
  return { d, ground: pointGroundOf(environment, id) ?? FLAT }
}

const WORLDS = ['neon-valley', 'grid-flats', 'big-dunes', 'midnight-grid']
const SHAPES: ((t: number) => P)[] = [
  (t) => ({ x: 600 * Math.cos(t * TAU), z: 380 * Math.sin(t * TAU) }),
  (t) => ({ x: 260 * Math.sin(t * TAU), z: 130 * Math.sin(2 * t * TAU) }),
  (t) => ({ x: 420 * Math.sin(t * TAU), z: 220 * Math.sin(2 * t * TAU) }),
  (t) => {
    const r = 300 + 90 * Math.cos(2 * t * TAU)
    return { x: 1.3 * r * Math.cos(t * TAU), z: r * Math.sin(t * TAU) }
  },
]

/**
 * editor10's sweep: a drawn road with one or two stretches banked 20-45 degrees by hand
 * (every other point 1.5 degrees less), as Josh sets them with the Bank tool.
 */
function handBanked(seed: number): ReturnType<typeof drawn> {
  const r = rng(seed * 7919)
  const eight = seed % 4 === 1 || seed % 4 === 2
  const world = WORLDS[Math.floor(r() * 4)]
  const f = drawn(`hand-bank-${seed}`, SHAPES[seed % 4], seed, world, eight ? 0.1 : 0, eight ? 1.1 : 1.04)
  if (!f) return null
  const n = f.d.points.length
  const stretches = 1 + Math.floor(r() * 2)
  for (let s = 0; s < stretches; s++) {
    const k0 = Math.floor(r() * n)
    const len = 2 + Math.floor(r() * 9)
    const b = (Math.round((20 + r() * 25) * 2) / 2) * (r() < 0.2 ? -1 : 1)
    for (let k = k0; k < k0 + len; k++) f.d.points[k % n].bank = b + (k % 2 ? -1.5 : 0)
  }
  return f
}

/** One gate's row from the game's checks on a draft: its level and the start of its message. */
function gateOf(gates: readonly { name: string; level: string; message: string }[], name: string): string {
  const g = gates.find((x) => x.name === name)
  return g ? `${g.level}: ${g.message.slice(0, 140)}` : 'no row'
}

export function builderRows(check: Check): void {
  check('A hand-banked drawn road keeps level ground beside its low edge right up to where it lifts off (no groove: lowedge)', () => {
    // Seeds 10 and 34 failed: the ground sagged 0.3 m just past the low edge 7-8 m before a bridge.
    const bad: string[] = []
    for (const seed of [10, 34]) {
      const f = handBanked(seed)
      if (!f) {
        bad.push(`seed ${seed}: the drawing did not clean up`)
        continue
      }
      const j = judgeDraft(f.d, f.d.id)
      const g = j.gates.find((x) => x.name === 'lowedge')
      if (!j.runtime) bad.push(`seed ${seed}: did not build (${j.error})`)
      else if (!g) bad.push(`seed ${seed}: no lowedge row (no bank?)`)
      else if (g.level !== 'ok') bad.push(`seed ${seed}: ${gateOf(j.gates, 'lowedge')}`)
    }
    return bad
  })

  check('A bridge over a road banked 45 degrees by hand is judged over its high lane: LOW BRIDGE until a car fits, never the game losing track of cars under it', () => {
    // editor10's bridge.ts 45: the eight's lower road banked 45 degrees under its bridge, and the
    // bridge raised 4.6 m (what the Bank tool used to do: the lower road's middle lift, plus some).
    // The middles were 7.0 m apart, so `bridges` passed, but the high lane rose to 3.0 m under the
    // bridge and `tracking` (GAME BUG) found a car on it on the bridge above.
    const f = drawn('bridge-bank', (t) => ({ x: 260 * Math.sin(t * TAU), z: 130 * Math.sin(2 * t * TAU) }), 2, undefined, 0.1, 1.1)
    if (!f) return ['the eight did not clean up']
    const c = roadCrossings(f.d.points, f.ground)[0]
    if (!c || c.over === null) return ['the eight has no bridge']
    const under = c.passes[c.over === 0 ? 1 : 0]
    const over = c.passes[c.over]
    const line = roadLine(f.d.points)
    const banked = f.d.points.map((p, k) => (alongRoad(sOfPoint(line, k), under.s, line.length) <= 60 ? { ...p, bank: 45 } : { ...p }))
    const up = liftBridgeBy(banked, f.d.pieces, f.d.startAt, f.d.width, c.at, 4.6, f.ground)
    if (!up.ok) return [`the bridge could not be raised: ${up.reason}`]
    const low: Draft = { ...f.d, points: up.points, startAt: up.mapAt(f.d.startAt) }
    const j = judgeDraft(low, f.d.id)
    if (!j.runtime) return [`did not build (${j.error})`]
    const bad: string[] = []
    const middles = builtGapAt(j.runtime, c.at, over.heading)?.gap ?? 0
    if (middles < BRIDGE_ROOM) bad.push(`the setup is off: the middles are only ${middles.toFixed(1)} m apart (want more than ${BRIDGE_ROOM})`)
    const gap = crossingClearance(j.runtime)?.gap ?? Infinity
    if (gap >= BRIDGE_ROOM) bad.push(`bridges says ${gap.toFixed(1)} m (the middles are ${middles.toFixed(1)} m apart): it doesn't measure over the banked road's high lane`)
    if (j.gates.find((x) => x.name === 'tracking')?.level !== 'ok') bad.push(`with the bridge too low, tracking still blames the game: ${gateOf(j.gates, 'tracking')}`)
    // Fix it on the LOW BRIDGE row (raises the bridge by what the high lane is short of, or eases
    // the bank): then both pass, and the crossing is tried.
    const p = problemsOf({ draft: low, gates: j.gates, errors: j.errors, warnings: j.warnings, notes: [] }).find((x) => x.source === 'gate' && x.gate?.name === 'bridges')
    if (!p) return [...bad, 'Checks shows no LOW BRIDGE row']
    const fixed = runFix(p, low, { id: f.d.id, world: { width: low.width, bound: 2000, playRadius: Infinity, pointGround: f.ground }, before: j })
    if (!fixed.ok || !fixed.draft) return [...bad, `Fix it could not mend LOW BRIDGE: ${fixed.reason}`]
    const j2 = judgeDraft(fixed.draft, f.d.id)
    for (const name of ['bridges', 'tracking']) if (j2.gates.find((x) => x.name === name)?.level !== 'ok') bad.push(`after Fix it (${fixed.did}): ${name} ${gateOf(j2.gates, name)}`)
    if (!/found on the level it is on/.test(gateOf(j2.gates, 'tracking'))) bad.push(`after Fix it: tracking did not try the crossing: ${gateOf(j2.gates, 'tracking')}`)
    return bad.length ? bad : `middles ${middles.toFixed(1)} m apart, ${gap.toFixed(1)} m over the high lane: LOW BRIDGE (tracking passes, the crossing left to that row); Fix it ${(fixed.did ?? '').replace(/\.$/, '')}, then bridges and tracking pass with the crossing tried`
  })

  check('Every half metre from 9 to 13 m builds on an Afterglow copy raised 60 m after the start (lowedge used to fail at some heights only, by how the road met the grid)', () => {
    const d = draftFromFile(afterglowJson as unknown as TrackFile, true)
    d.id = 'afterglow-copy-raise'
    const ground = pointGroundOf(d.environment, d.id) ?? FLAT
    const before = judgeDraft(d, d.id)
    const line = roadLine(d.points)
    const sel = heightStretchAround(d, atOf(line, sOf(line, d.startAt) + 60), before.runtime, ground)
    const o = { id: d.id, pointGround: ground, before: { runtime: before.runtime, gates: before.gates }, exact: true }
    const bad: string[] = []
    for (let h = 9; h <= 13; h += 0.5) {
      const r = raiseDraft(d, sel.from, sel.to, h, o)
      if (!r.ok) bad.push(`${h} m: ${r.reason?.slice(0, 160)}`)
    }
    return bad
  })
}
