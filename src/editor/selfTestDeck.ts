// ============================================================
//  SELF-TEST: STRAIGHT-TOPPED BRIDGES - rows for selfTest.ts
// ------------------------------------------------------------
//  The editor's self-test (selfTest.ts) calls deckRows() at the end.
//  Bridges used to sit a fixed height above the ground all the way
//  over, so the hills under a small figure-eight's bridge showed
//  through at its top and threw cars off (30 of 48 sweep eights).
//  Now a bridge's top runs straight and its ramps are shaped by the
//  Height tool's rule (deck.ts). Each row checks the result apart
//  from the code that made it:
//
//    ramp maths   each ramp meets the old road and the deck at the
//                 same height and slope, the top is a straight
//                 line, and on flat ground the crest of a 160 m
//                 ramp asks no more than the Height tool allows
//    hilly eights the clean-up's bridge on small figure-eights over
//                 hills: its top is straight on the draft, and on
//                 the BUILT road a car at full speed stays on over it
//                 (racing line + 15%, up to 250 km/h, at most 80% of
//                 gravity's pull, or no worse than the road on the
//                 ground there); every check passes
//    swap, under  Swap and Send under on the same eight give the
//                 moving road a straight top (or floor) too
//    too steep    a crossing on top of a big hill gets the clean-up's
//                 note saying a car may go light, and flat ground
//                 gets no note
// ============================================================

import { CREST_CHECK_KMH, CREST_LIMIT } from '../track/bankRolls'
import { crestShareAt, crestHalf } from '../track/cuttings'
import { SURFACE_CODE, type TrackRuntime } from '../track/types'
import { cleanStroke, type CleanupOptions } from './cleanup'
import { DECK_TOP_SPEED, PLAN_SHARE, deckCrest, deckHeight, planDeck } from './deck'
import type { Draft } from './draft'
import { BASE_WORLDS, pointGroundOf } from './draftFile'
import { type GroundFn, bridgeShape, buildAndCheck, crossingNear, roadCrossings, swapDraft, underDraft } from './bridges'
import { checkVerdict } from './checks'
import type { P } from './geom'
import { atOf, roadHeightAt, roadLine } from './shape'

type Check = (name: string, fn: () => string[] | string) => void

const TAU = Math.PI * 2

export function deckRows(check: Check, h: { shaky: (shape: (t: number) => P, count: number, wobble: number, seed: number, t0?: number, t1?: number) => P[]; opts: Partial<CleanupOptions> }): void {
  /** The sweep's small figure-eight (520 x 260 m), turned `rotDeg`, on base world `worldId` with hills from `seed`, cleaned knowing the ground. */
  const eight = (worldId: string, rotDeg: number, seed: number): { d: Draft; ground: GroundFn; notes: string[] } => {
    const base = BASE_WORLDS.find((b) => b.id === worldId)
    if (!base) throw new Error(`no base world ${worldId}`)
    const rot = (rotDeg * Math.PI) / 180
    const stroke = h.shaky((t) => {
      const x = 260 * Math.sin(t * TAU)
      const z = 130 * Math.sin(2 * t * TAU)
      return { x: x * Math.cos(rot) - z * Math.sin(rot), z: x * Math.sin(rot) + z * Math.cos(rot) }
    }, 600, 3, 2, 0.1, 1.1)
    const environment = { ...JSON.parse(JSON.stringify(base.environment)), seed }
    const id = `selftest-deck-${worldId}`
    const ground = pointGroundOf(environment, id)
    if (!ground) throw new Error(`${worldId}'s world didn't validate`)
    const res = cleanStroke(stroke, { ...h.opts, pointGround: ground })
    if (!res.ok) throw new Error(`the eight on ${worldId} didn't clean up`)
    const d: Draft = { id, name: 'Self-test deck', author: '', description: '', points: res.points, width: 14, baseWorld: base.id, environment, pieces: [], props: [], cores: [], startAt: 0 }
    return { d, ground, notes: res.issues.map((i) => i.code) }
  }

  /**
   * How far the road's top over the crossing at `at` is from a straight line: the pass that is
   * `which` (the upper one, or the lower) sampled every 2 m over `half` metres either side, on the
   * draft's own heights (shape.ts, exactly as the game builds them). Metres.
   */
  const bentBy = (d: Draft, ground: GroundFn, at: P, which: 'upper' | 'lower', half: number): number => {
    const c = crossingNear(roadCrossings(d.points, ground), at)?.crossing
    if (!c || c.over === null) return Infinity
    const pass = c.passes[which === 'upper' ? c.over : c.over === 0 ? 1 : 0]
    const line = roadLine(d.points)
    const hAt = (s: number) => roadHeightAt(d.points, atOf(line, s), ground)
    const y0 = hAt(pass.s - half)
    const y1 = hAt(pass.s + half)
    let worst = 0
    for (let k = -half; k <= half; k += 2) worst = Math.max(worst, Math.abs(hAt(pass.s + k) - (y0 + ((y1 - y0) * (k + half)) / (2 * half))))
    return worst
  }

  /**
   * Over the upper road at the crossing on the BUILT road (out to the ramps' feet and 30 m more):
   * the most of gravity's pull a car needs to stay on, at the fastest it is likely to be there
   * (the racing line plus 15%, up to 250 km/h), and the worst amount by which that is more than
   * CREST_LIMIT where the same road on the ground (`flat`, built with no lifts) asked less.
   */
  const crestOver = (t: TrackRuntime, flat: TrackRuntime, at: P, reach: number): { worst: number; over: number; kmh: number } => {
    const S = t.samples
    let top = -1
    for (let i = 0; i < S.count; i++) {
      if (S.surface[i] === SURFACE_CODE.loop || Math.hypot(S.px[i] - at.x, S.pz[i] - at.z) > 4) continue
      if (top < 0 || S.py[i] > S.py[top]) top = i
    }
    if (top < 0) return { worst: Infinity, over: Infinity, kmh: 0 }
    const m = Math.round((reach + 30) / S.ds)
    const wrap = (i: number) => ((i % S.count) + S.count) % S.count
    let v = 0
    for (let k = -m; k <= m; k++) v = Math.max(v, t.racingLine.speed[wrap(top + k)])
    v = Math.min(CREST_CHECK_KMH / 3.6, v * 1.15)
    const half = crestHalf(2 * reach)
    let worst = 0
    let over = -Infinity
    for (let k = -m; k <= m; k++) {
      const i = wrap(top + k)
      const share = crestShareAt(t, i, v, half)
      // The same spot on the ground road: the same share of the way round (only the heights differ).
      const j = Math.round((i / S.count) * flat.samples.count) % flat.samples.count
      const was = crestShareAt(flat, j, v, half)
      worst = Math.max(worst, share)
      over = Math.max(over, share - Math.max(CREST_LIMIT, was + 0.02))
    }
    return { worst, over, kmh: v * 3.6 }
  }

  check('Bridges: a ramp meets the old road and the straight top at the same height and slope, and on flat ground a 160 m ramp crests no sharper than the Height tool allows at 250 km/h', () => {
    const bad: string[] = []
    const flat = 14
    const notes: string[] = []
    // A rolling old road (its own hills and slope), and dead flat ground.
    const rolling = (d: number) => 3 * Math.sin(d / 47) + 1.5 * Math.cos(d / 23) + 0.02 * d
    for (const [label, was, rise, ramp] of [
      ['rolling, bridge', rolling, 8, 200],
      ['rolling, dip', rolling, -8, 200],
      ['flat, bridge', () => 0, 8, 160],
      ['flat, dip', () => 0, -8, 160],
    ] as const) {
      const deck = planDeck(was, was(0), rise, flat, ramp)
      const reach = flat + ramp
      const y = (d: number) => deckHeight(deck, d, was(d))
      const slope = (d: number) => (y(d + 0.05) - y(d - 0.05)) / 0.1
      // The joins: deck to ramp (at +-flat) and ramp to old road (at +-reach).
      for (const j of [-reach, -flat, flat, reach]) {
        const dy = Math.abs(y(j + 0.001) - y(j - 0.001))
        const ds = Math.abs(slope(j + 0.2) - slope(j - 0.2))
        if (dy > 0.002) bad.push(`${label}: a step of ${dy.toFixed(3)} m at ${j} m`)
        if (ds > 0.01) bad.push(`${label}: a kink (slope changes by ${ds.toFixed(3)}) at ${j} m`)
      }
      // The top is a straight line through the crossing at the asked height.
      if (Math.abs(y(0) - (was(0) + rise)) > 0.001) bad.push(`${label}: the crossing is at ${y(0).toFixed(2)}, not ${(was(0) + rise).toFixed(2)}`)
      const mid = (y(-flat) + y(flat)) / 2
      if (Math.abs(y(0) - mid) > 0.001) bad.push(`${label}: the top is not straight (${(y(0) - mid).toFixed(3)} m off)`)
      const crest = deckCrest(deck, was, DECK_TOP_SPEED)
      notes.push(`${label} ${ramp} m: crest ${(crest.worst * 100).toFixed(0)}%`)
      if (label.startsWith('flat') && crest.worst > PLAN_SHARE) bad.push(`${label}: a ${ramp} m ramp asks ${(crest.worst * 100).toFixed(0)}% at 250 km/h (the Height tool allows ${PLAN_SHARE * 100}%)`)
    }
    return bad.length ? bad : notes.join('; ')
  })

  // Small figure-eights the old bridges threw cars off (tunnel1's sweep: 81-148% of gravity's pull), and flat ground.
  const hilly: [string, number, number][] = [
    ['big-dunes', 45, 2],
    ['big-dunes', 90, 2],
    ['neon-valley', 0, 2],
    ['grid-flats', 0, 1],
  ]
  check("Bridges: on small figure-eights over hills the clean-up's bridge has a straight top, and on the built road a car at full speed stays on over it (every check passes)", () => {
    const bad: string[] = []
    const said: string[] = []
    for (const [world, rot, seed] of hilly) {
      const tag = `${world} ${rot} deg`
      const { d, ground } = eight(world, rot, seed)
      const c = roadCrossings(d.points, ground)[0]
      if (!c || c.over === null || c.kind !== 'bridge') {
        bad.push(`${tag}: the crossing isn't a bridge`)
        continue
      }
      const { flat } = bridgeShape(c.angleDeg, d.width)
      const bent = bentBy(d, ground, c.at, 'upper', flat)
      if (bent > 0.03) bad.push(`${tag}: the bridge's top bends ${(bent * 100).toFixed(0)} cm off a straight line`)
      const b = buildAndCheck(d, d.id)
      if (!b.runtime) {
        bad.push(`${tag}: did not build: ${b.error}`)
        continue
      }
      if (checkVerdict({ fresh: true, errors: [], gates: b.gates, cleanupErrors: 0 }) !== 'pass') {
        bad.push(`${tag}: the checks fail: ${b.gates.filter((x) => x.level === 'fail').map((x) => x.name).join(', ')}`)
      }
      const onGround = buildAndCheck({ ...d, points: d.points.map((p) => ({ x: p.x, z: p.z })) }, d.id).runtime
      if (!onGround) {
        bad.push(`${tag}: the same road on the ground did not build`)
        continue
      }
      // Measured over the longest ramps the clean-up makes, whichever it used.
      const cr = crestOver(b.runtime, onGround, c.at, flat + 200)
      said.push(`${tag}: ${(cr.worst * 100).toFixed(0)}% at ${cr.kmh.toFixed(0)} km/h, top straight to ${(bent * 100).toFixed(1)} cm`)
      if (cr.over > 0) bad.push(`${tag}: a car at ${cr.kmh.toFixed(0)} km/h goes light over the bridge (${(cr.worst * 100).toFixed(0)}% of gravity's pull, limit ${CREST_LIMIT * 100}%)`)
    }
    return bad.length ? bad : said.join('; ')
  })

  check('Bridges: Swap and Send under on a hilly figure-eight give the moving road a straight top (or floor) too, and every check passes', () => {
    const bad: string[] = []
    const said: string[] = []
    const { d, ground } = eight('big-dunes', 90, 2)
    const c = roadCrossings(d.points, ground)[0]
    if (!c || c.over === null) return ['the eight has no bridge']
    const { flat } = bridgeShape(c.angleDeg, d.width)
    const sw = swapDraft(d, c.at, { id: d.id, pointGround: ground })
    if (!sw.ok || !sw.draft) bad.push(`the swap was refused: ${sw.reason}`)
    else {
      const bent = bentBy(sw.draft, ground, c.at, 'upper', flat)
      said.push(`swapped: top straight to ${(bent * 100).toFixed(1)} cm`)
      if (bent > 0.03) bad.push(`swapped: the new bridge's top bends ${(bent * 100).toFixed(0)} cm off a straight line`)
    }
    const lower = c.over === 0 ? 1 : 0
    const un = underDraft(d, c.at, lower, { id: d.id, pointGround: ground })
    if (!un.ok || !un.draft) bad.push(`send under was refused: ${un.reason}`)
    else {
      const bent = bentBy(un.draft, ground, c.at, 'lower', flat)
      said.push(`sent under: floor straight to ${(bent * 100).toFixed(1)} cm`)
      if (bent > 0.03) bad.push(`sent under: the dip's floor bends ${(bent * 100).toFixed(0)} cm off a straight line`)
    }
    return bad.length ? bad : said.join('; ')
  })

  check("Bridges: a crossing on top of a big hill gets the clean-up's note that a car may go light, and flat ground gets none", () => {
    const bad: string[] = []
    // The sweep's eight crosses itself at the middle of the map: a 16 m hill there, 70 m wide.
    const stroke = h.shaky((t) => ({ x: 260 * Math.sin(t * TAU), z: 130 * Math.sin(2 * t * TAU) }), 600, 3, 2, 0.1, 1.1)
    const hill: GroundFn = (x, z) => 16 * Math.exp(-(x * x + z * z) / (2 * 70 * 70))
    const steep = cleanStroke(stroke, { ...h.opts, pointGround: hill })
    const level = cleanStroke(stroke, { ...h.opts, pointGround: () => 0 })
    const note = steep.issues.find((i) => i.code === 'steep-bridge')
    if (!steep.crossings.some((c) => c.over !== null)) bad.push('over the hill the crossing was not bridged')
    if (!note) bad.push(`over the hill there is no steep-bridge note (${steep.issues.map((i) => i.code).join(', ')})`)
    else if (!/go light/.test(note.message)) bad.push(`the note doesn't say a car may go light: "${note.message}"`)
    if (level.issues.some((i) => i.code === 'steep-bridge')) bad.push('flat ground got a steep-bridge note')
    return bad.length ? bad : `"${note?.message}"`
  })
}
