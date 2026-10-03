// ============================================================
//  SELF-TEST: UNDERPASSES AND DIGGING DOWN - rows for selfTest.ts
// ------------------------------------------------------------
//  The editor's self-test (selfTest.ts) calls underpassRows() near
//  the end. Each row builds a road the editor really makes, changes
//  it the way the crossing panel and the Height tool do, then checks
//  the result separately from the code that made it, on the BUILT
//  road (the real track builder and the game's own checks):
//
//    either way   a figure-eight sends each road under in turn: the
//                 road under sits in a cutting 8 m down, the other
//                 on the ground, a car fits between them, and every
//                 check passes; Swap sends the other road under, and
//                 "Make it a bridge" turns it back into a bridge
//    grounded     the road on top crosses the cutting as a short
//                 bridge (the builder's grounded rule): nothing is
//                 filled under its deck, the cutting runs on under it
//    remembered   a pencil redraw of another stretch keeps the
//                 underpass (the clean-up is handed it)
//    undo         sending a road under is one Undo step (the real
//                 editor store)
//    dig          the Height tool digs a stretch down to 10 m below
//                 the ground and no further; the dug road builds and
//                 passes every check, cutting and dips included
//    wall reach   a raise reaching into a wall ride's 25 m grow-in
//                 (before its `at`) is refused; one clear of it isn't
//    dips         the game's dips check fails a short deep dip and
//                 passes the same depth on long ramps
//    take-off     a swapped bridge never throws a car off more than
//                 the bridge it replaced (or the Height tool's limit)
// ============================================================

import type { RoadPoint } from '../track/schema'
import { SLAB_THICKNESS } from '../track/road'
import { cleanStroke, type CleanupOptions } from './cleanup'
import type { Draft } from './draft'
import { DEFAULT_BASE_WORLD, pointGroundOf } from './draftFile'
import { type GroundFn, BRIDGE_GAP, UNDER_DEPTH, buildAndCheck, builtGapAt, crossingNear, keepOverOf, matchHeading, roadCrossings, swapDraft, tryOneWay, underDraft } from './bridges'
import { checkVerdict } from './checks'
import type { P } from './geom'
import { RAISE_FLOOR, heightLimits, raiseDraft, stretchNow } from './raise'
import { CREST_LIMIT } from '../track/bankRolls'
import { crestShareAt } from '../track/cuttings'
import { sectionRedraw } from './road'
import { atOf, posOf, roadLine, sOfPoint } from './shape'

type Check = (name: string, fn: () => string[] | string) => void
type EditorStore = typeof import('./draft')

const TAU = Math.PI * 2

export function underpassRows(check: Check, store: EditorStore | undefined, h: { shaky: (shape: (t: number) => P, count: number, wobble: number, seed: number, t0?: number, t1?: number) => P[]; opts: Partial<CleanupOptions> }): void {
  /** The bridges rows' figure-eight (selfTest.ts eight()): the default world, seed pinned. */
  const eight = (): { d: Draft; ground: GroundFn } => {
    const stroke = h.shaky((t) => ({ x: 260 * Math.sin(t * TAU), z: 130 * Math.sin(2 * t * TAU) }), 600, 3, 2, 0.1, 1.1)
    const res = cleanStroke(stroke, h.opts)
    const environment = { ...JSON.parse(JSON.stringify(DEFAULT_BASE_WORLD.environment)), seed: 1 }
    const d: Draft = { id: 'selftest-underpass', name: 'Self-test underpass', author: '', description: '', points: res.points, width: 14, baseWorld: DEFAULT_BASE_WORLD.id, environment, pieces: [], props: [], cores: [], startAt: 0 }
    const ground = pointGroundOf(environment, d.id)
    if (!ground) throw new Error("the eight's world didn't validate")
    return { d, ground }
  }
  const o = (d: Draft, ground: GroundFn) => ({ id: d.id, pointGround: ground })
  const sameWay = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180) < 30

  /**
   * The crossing at `at` is an underpass with the road heading `under` in the cutting: on the
   * draft (8 m down, the other on the ground) and on the built road (the other road on top with
   * room for a car, every check passing). Returns problems, and the built gap.
   */
  const underpassVerdict = (label: string, d: Draft, ground: GroundFn, at: P, under: number): { bad: string[]; gap: number } => {
    const bad: string[] = []
    const c = crossingNear(roadCrossings(d.points, ground), at)?.crossing
    if (!c || c.over === null) return { bad: [`${label}: no road on top at the crossing`], gap: 0 }
    const lo = c.passes[c.over === 0 ? 1 : 0]
    const hi = c.passes[c.over]
    if (c.kind !== 'underpass') bad.push(`${label}: the crossing is a ${c.kind}, not an underpass`)
    if (!sameWay(lo.heading, under)) bad.push(`${label}: the wrong road went under`)
    if (lo.lift > -(UNDER_DEPTH - 0.5)) bad.push(`${label}: the road under is only ${(-lo.lift).toFixed(1)} m down`)
    if (Math.abs(hi.lift) > 0.5) bad.push(`${label}: the road on top is ${hi.lift.toFixed(1)} m off the ground`)
    const b = buildAndCheck(d, d.id)
    if (!b.runtime) return { bad: [...bad, `${label}: did not build: ${b.error}`], gap: 0 }
    const g = builtGapAt(b.runtime, at, hi.heading)
    if (!g) bad.push(`${label}: the built road has no two levels at the crossing`)
    else {
      if (!g.upperMatches) bad.push(`${label}: the wrong road is on top on the built road`)
      if (g.gap < BRIDGE_GAP) bad.push(`${label}: built gap ${g.gap.toFixed(2)} m (needs ${BRIDGE_GAP})`)
    }
    if (checkVerdict({ fresh: true, errors: [], gates: b.gates, cleanupErrors: 0 }) !== 'pass') {
      bad.push(`${label}: the checks fail: ${b.gates.filter((x) => x.level === 'fail').map((x) => `${x.name}: ${x.message}`).join(' / ')}`)
    }
    if (!b.gates.some((x) => x.name === 'cutting')) bad.push(`${label}: there is no cutting check row`)
    if (!b.gates.some((x) => x.name === 'dips')) bad.push(`${label}: there is no dips check row`)
    return { bad, gap: g?.gap ?? 0 }
  }

  check('Underpasses: on a figure-eight either road can be sent under (a cutting 8 m down, the other road on the ground), Swap sends the other one under, and it turns back into a bridge; the built road keeps a car-sized gap and passes every check each time', () => {
    const { d, ground } = eight()
    const c = roadCrossings(d.points, ground)[0]
    if (!c || c.over === null) return ['the eight has no bridge']
    const at = c.at
    const h0 = c.passes[0].heading
    const h1 = c.passes[1].heading
    const bad: string[] = []
    const gaps: string[] = []
    const said: string[] = []
    const run = (label: string, from: Draft, heading: number) => {
      const k = matchHeading(heading, ...(roadCrossings(from.points, ground).map((x) => x)[0]?.passes.map((p) => p.heading) as [number, number]))
      if (k === null) {
        bad.push(`${label}: can't find that road at the crossing`)
        return null
      }
      const r = underDraft(from, at, k, o(from, ground))
      if (!r.ok || !r.draft) {
        bad.push(`${label}: refused: ${r.reason}`)
        return null
      }
      const v = underpassVerdict(label, r.draft, ground, at, heading)
      bad.push(...v.bad)
      gaps.push(`${label} ${v.gap.toFixed(2)} m`)
      said.push(r.done ?? '')
      return r.draft
    }
    const first = run('first road under', d, h0)
    run('second road under', d, h1)
    // Swap on an underpass: the road on top goes under, the one in the cutting comes up.
    if (first) {
      run('swapped', first, h1)
      // Make it a bridge: the road on top (the second) goes up, the one in the cutting comes back to the ground.
      const k = matchHeading(h1, roadCrossings(first.points, ground)[0].passes[0].heading, roadCrossings(first.points, ground)[0].passes[1].heading)
      const r = k === null ? null : tryOneWay(first, at, k, o(first, ground))
      if (!r || !r.ok || !r.draft) bad.push(`make it a bridge: refused: ${r?.reason}`)
      else {
        const cb = crossingNear(roadCrossings(r.draft.points, ground), at)?.crossing
        if (!cb || cb.kind !== 'bridge' || cb.over === null || !sameWay(cb.passes[cb.over].heading, h1)) bad.push(`make it a bridge: the crossing is ${cb?.kind}, with the wrong road on top`)
        const lo = cb?.passes[cb.over === 0 ? 1 : 0]
        if (lo && Math.abs(lo.lift) > 0.5) bad.push(`make it a bridge: the road underneath is still ${lo.lift.toFixed(1)} m off the ground`)
        const b = buildAndCheck(r.draft, d.id)
        if (!b.runtime || checkVerdict({ fresh: true, errors: [], gates: b.gates, cleanupErrors: 0 }) !== 'pass') bad.push(`make it a bridge: the checks fail: ${b.gates.filter((x) => x.level === 'fail').map((x) => x.name).join(', ')}`)
      }
    }
    return bad.length ? bad : `crossing at ${Math.round(c.angleDeg)} degrees; built gaps ${gaps.join(', ')} (needs ${BRIDGE_GAP}); "${said[0]}"; then back to a bridge`
  })

  check("Underpasses: the road on top crosses the cutting as a short bridge (the builder's grounded rule): its deck there is a bridge, and no ground under it comes within its slab", () => {
    const { d, ground } = eight()
    const c = roadCrossings(d.points, ground)[0]
    if (!c || c.over === null) return ['the eight has no bridge']
    const r = underDraft(d, c.at, c.over, o(d, ground))
    if (!r.ok || !r.draft) return [`sending the road under was refused: ${r.reason}`]
    const b = buildAndCheck(r.draft, d.id)
    const t = b.runtime
    if (!t) return [`did not build: ${b.error}`]
    const S = t.samples
    // The two passes on the built road: the lowest and highest samples right at the crossing.
    let lo = -1
    let hi = -1
    for (let i = 0; i < S.count; i++) {
      if (Math.hypot(S.px[i] - c.at.x, S.pz[i] - c.at.z) > 4) continue
      if (lo < 0 || S.py[i] < S.py[lo]) lo = i
      if (hi < 0 || S.py[i] > S.py[hi]) hi = i
    }
    if (lo < 0 || S.py[hi] - S.py[lo] < BRIDGE_GAP) return ['the built crossing has no car-sized gap']
    const bad: string[] = []
    // How far a spot is from the lower road's middle line (its samples near the crossing).
    const fromLower = (x: number, z: number) => {
      let best = Infinity
      for (let k = -60; k <= 60; k++) {
        const j = (((lo + k) % S.count) + S.count) % S.count
        best = Math.min(best, Math.hypot(S.px[j] - x, S.pz[j] - z))
      }
      return best
    }
    let deckSamples = 0
    let grounded = 0
    let closest = Infinity
    for (let k = -80; k <= 80; k++) {
      const i = (((hi + k) % S.count) + S.count) % S.count
      // Upper-road samples whose middle is over the cutting's floor (within the lower road's width plus 2 m).
      if (fromLower(S.px[i], S.pz[i]) > S.halfWidth[lo] + 2) continue
      deckSamples++
      if (S.grounded[i]) grounded++
      // The ground under the deck, across its width, outside the lower road itself.
      for (let l = -S.halfWidth[i]; l <= S.halfWidth[i]; l += 1) {
        const x = S.px[i] + S.rx[i] * l
        const z = S.pz[i] + S.rz[i] * l
        if (fromLower(x, z) <= S.halfWidth[lo]) continue
        closest = Math.min(closest, S.py[i] + S.ry[i] * l - t.terrainHeight(x, z))
      }
    }
    if (!deckSamples) bad.push('found no upper-road samples over the cutting')
    if (grounded) bad.push(`${grounded} of ${deckSamples} samples of the road on top over the cutting are still "grounded" (filled under)`)
    if (closest < SLAB_THICKNESS + 0.3) bad.push(`ground comes ${closest.toFixed(2)} m under the deck of the road on top beside the cutting (it must stay under its ${SLAB_THICKNESS} m slab)`)
    return bad.length ? bad : `${deckSamples} samples of the road on top over the cutting, none grounded; the ground under its deck beside the road below stays ${closest.toFixed(1)} m down (slab ${SLAB_THICKNESS} m); built gap ${(S.py[hi] - S.py[lo]).toFixed(2)} m`
  })

  check('Underpasses: a pencil redraw of another stretch keeps the underpass (the clean-up is handed it), and without that it would be a bridge', () => {
    const { d, ground } = eight()
    const c = roadCrossings(d.points, ground)[0]
    if (!c || c.over === null) return ['the eight has no bridge']
    const at = c.at
    const r = underDraft(d, at, c.over === 0 ? 1 : 0, o(d, ground))
    if (!r.ok || !r.draft) return [`sending the road under was refused: ${r.reason}`]
    const pts = r.draft.points
    const want = crossingNear(roadCrossings(pts, ground), at)!.crossing
    const underHeading = want.passes[want.over === 0 ? 1 : 0].heading
    // Redraw the far lobe's tip with the pencil (as the bridges row does).
    const line = roadLine(pts)
    const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.z - b.z)
    const far = pts.reduce((best, p, i) => (dist(p, at) > dist(pts[best], at) ? i : best), 0)
    const sFar = sOfPoint(line, far)
    const stroke: P[] = []
    for (let i = 0; i <= 60; i++) {
      const p = posOf(line, sFar - 150 + (300 * i) / 60)
      const out = Math.sin((i / 60) * Math.PI) * 25
      stroke.push({ x: p.x + Math.sign(p.x) * out, z: p.z })
    }
    const loop = sectionRedraw(stroke, pts, 14)
    if (!loop) return ['the far-lobe stroke was not taken as a stretch redraw']
    const kept = cleanStroke(loop, { ...h.opts, fairing: 0, keepOver: keepOverOf(pts, ground) })
    const forgot = cleanStroke(loop, { ...h.opts, fairing: 0 })
    if (!kept.ok || !forgot.ok) return ['the redraw failed to clean up']
    const bad: string[] = []
    const kc = crossingNear(roadCrossings(kept.points, ground), at)?.crossing
    if (!kc || kc.kind !== 'underpass') bad.push(`after the redraw the crossing is ${kc?.kind ?? 'gone'}, not an underpass`)
    else if (!sameWay(kc.passes[kc.over === 0 ? 1 : 0].heading, underHeading)) bad.push('after the redraw the other road is under')
    const fc = crossingNear(roadCrossings(forgot.points, ground), at)?.crossing
    if (fc?.kind === 'underpass') bad.push('without remembering, the redraw keeps the underpass anyway, so this proves nothing')
    if (kept.issues.some((i) => i.code === 'bridge-flipped')) bad.push('the redraw says it had to flip the underpass')
    if (kc?.kind === 'underpass') bad.push(...underpassVerdict('redrawn', { ...r.draft, points: kept.points, pieces: [], startAt: 0 }, ground, at, underHeading).bad)
    return bad.length ? bad : `kept as an underpass through a redraw of the far lobe (the same road in the cutting, every check passes); without remembering it comes back as a ${fc?.kind ?? 'crossing'}`
  })

  check('Underpasses: sending a road under is one Undo step, and Redo sends it under again (the real editor store)', () => {
    if (!store) return 'skipped: needs the editor store (run `bun src/editor/selfTest.ts`); in the game it would change your draft'
    const { d, ground } = eight()
    const c = roadCrossings(d.points, ground)[0]
    if (!c || c.over === null) return ['the eight has no bridge']
    store.replaceDraft(d, null)
    const before = store.useEditor.getState().draft
    const lower = c.over === 0 ? 1 : 0
    if (!store.sendUnder(c.at, lower)) return [`sendUnder refused: ${store.useEditor.getState().message?.text}`]
    const after = store.useEditor.getState()
    const bad: string[] = []
    const kind = () => crossingNear(roadCrossings(store.useEditor.getState().draft.points, ground), c.at)?.crossing.kind
    if (kind() !== 'underpass') bad.push(`after Send under the crossing is ${kind()}`)
    if (after.past[after.past.length - 1] !== before) bad.push('it is not one Undo step back to the draft before it')
    store.undo()
    if (JSON.stringify(store.useEditor.getState().draft) !== JSON.stringify(before)) bad.push('Undo did not bring back the draft exactly')
    store.redo()
    if (kind() !== 'underpass') bad.push('Redo did not send it under again')
    return bad.length ? bad : `Send under, Undo (the draft comes back exactly), Redo; status line: "${after.message?.text}"`
  })

  /** A stadium oval with 600 m straights (gentle 150 m-radius ends), the start line on the north straight. */
  const R = 150
  const longOval = (id: string): { d: Draft; ground: GroundFn } | string => {
    const H = 300
    const per = 4 * H + TAU * R
    const at = (t: number): P => {
      let q = (((t % 1) + 1) % 1) * per
      if (q < 2 * H) return { x: -H + q, z: -R }
      q -= 2 * H
      if (q < Math.PI * R) return { x: H + R * Math.cos(-Math.PI / 2 + q / R), z: R * Math.sin(-Math.PI / 2 + q / R) }
      q -= Math.PI * R
      if (q < 2 * H) return { x: H - q, z: R }
      q -= 2 * H
      return { x: -H + R * Math.cos(Math.PI / 2 + q / R), z: R * Math.sin(Math.PI / 2 + q / R) }
    }
    const res = cleanStroke(Array.from({ length: 801 }, (_, i) => at((i / 800) * 1.03)), h.opts)
    if (!res.ok) return 'the oval did not clean up'
    const environment = { ...JSON.parse(JSON.stringify(DEFAULT_BASE_WORLD.environment)), seed: 1 }
    const d: Draft = { id, name: id, author: '', description: '', points: res.points as RoadPoint[], width: 14, baseWorld: DEFAULT_BASE_WORLD.id, environment, pieces: [], props: [], cores: [], startAt: 0 }
    const ground = pointGroundOf(environment, d.id)
    if (!ground) return "the oval's world didn't validate"
    d.startAt = nearestPoint(d.points, { x: 0, z: R })
    return { d, ground }
  }
  const nearestPoint = (pts: readonly RoadPoint[], p: P) => pts.reduce((best, q, i) => (Math.hypot(q.x - p.x, q.z - p.z) < Math.hypot(pts[best].x - p.x, pts[best].z - p.z) ? i : best), 0)

  check('Height tool: a stretch digs down to 10 m below the ground and no further (refused below), and the dug road builds and passes every check, cutting and dips included', () => {
    const oval = longOval('selftest-dig')
    if (typeof oval === 'string') return [oval]
    const { d, ground } = oval
    // Dig the middle 520 m of the south straight.
    const line = roadLine(d.points)
    const sMid = sOfPoint(line, nearestPoint(d.points, { x: 0, z: -R }))
    const from = atOf(line, sMid - 260)
    const to = atOf(line, sMid + 260)
    const bad: string[] = []
    const lim = heightLimits(d, from, to, o(d, ground))
    if (lim.lo < RAISE_FLOOR - 1e-6) bad.push(`the slider goes down to ${lim.lo} m, below the ${RAISE_FLOOR} m floor`)
    if (lim.lo > RAISE_FLOOR + 1e-6) bad.push(`the slider only goes down to ${lim.lo} m on a 520 m straight (expected ${RAISE_FLOOR} m)`)
    const dug = raiseDraft(d, from, to, RAISE_FLOOR, { ...o(d, ground), exact: true })
    if (!dug.ok || !dug.draft) bad.push(`digging to ${RAISE_FLOOR} m was refused: ${dug.reason}`)
    else {
      const mid = stretchNow(dug.draft.points, dug.from ?? from, dug.to ?? to, ground).middle
      if (Math.abs(mid - RAISE_FLOOR) > 0.3) bad.push(`dug to ${mid.toFixed(2)} m, not ${RAISE_FLOOR}`)
      const b = buildAndCheck(dug.draft, d.id)
      if (!b.runtime || checkVerdict({ fresh: true, errors: [], gates: b.gates, cleanupErrors: 0 }) !== 'pass') bad.push(`the dug road fails: ${b.gates.filter((x) => x.level === 'fail').map((x) => `${x.name}: ${x.message}`).join(' / ') || b.error}`)
      for (const name of ['cutting', 'dips']) if (!b.gates.some((x) => x.name === name)) bad.push(`the dug road has no ${name} check row`)
      // On the built road: the deepest of the stretch really is about 10 m under the ground beside it.
      if (b.runtime) {
        const S = b.runtime.samples
        let deepest = 0
        for (let i = 0; i < S.count; i++) {
          if (Math.abs(S.pz[i] + R) > 5 || Math.abs(S.px[i]) > 60) continue
          const side = b.runtime.terrainHeight(S.px[i], S.pz[i] + 40)
          deepest = Math.max(deepest, side - S.py[i])
        }
        if (deepest < 8) bad.push(`on the built road the dug stretch is only ${deepest.toFixed(1)} m below the ground 40 m beside it`)
      }
    }
    const deeper = raiseDraft(d, from, to, RAISE_FLOOR - 0.5, { ...o(d, ground), exact: true })
    if (deeper.ok) bad.push(`digging to ${RAISE_FLOOR - 0.5} m went ahead`)
    else if (!/deeper than 10 m/.test(deeper.reason ?? '')) bad.push(`digging past the floor was refused with the wrong words: "${deeper.reason}"`)
    const asked = raiseDraft(d, from, to, -14, o(d, ground))
    if (asked.ok && asked.height !== undefined && asked.height < RAISE_FLOOR - 0.3) bad.push(`asking for -14 m dug to ${asked.height.toFixed(1)} m`)
    return bad.length ? bad : `the slider goes ${lim.lo} m to ${lim.hi} m on 520 m of straight (${lim.builds} builds); dug to ${RAISE_FLOOR} m: every check passes; ${RAISE_FLOOR - 0.5} m: "${deeper.reason}"; asking for -14 m: ${asked.ok ? `${asked.height?.toFixed(1)} m` : asked.reason}`
  })

  check("Height tool: a raise that reaches into a wall ride's 25 m grow-in is refused (the wall reaches past its own `at`), and one that stops short of it goes ahead", () => {
    const oval = longOval('selftest-dig-wall')
    if (typeof oval === 'string') return [oval]
    const { d, ground } = oval
    const line = roadLine(d.points)
    // A 100 m wall ride in the middle of the south straight.
    const sWall = sOfPoint(line, nearestPoint(d.points, { x: 0, z: -R }))
    d.pieces = [{ type: 'wallride', at: atOf(line, sWall), length: 100, side: 'left' }]
    const bad: string[] = []
    // A 300 m stretch ending right where the wall's piece starts: its last 25 m sit under the grow-in.
    const into = raiseDraft(d, atOf(line, sWall - 300), atOf(line, sWall), 6, { ...o(d, ground), exact: true })
    if (into.ok) bad.push('a raise ending at the wall ride\'s `at` went ahead (its grow-in starts 25 m before it)')
    else if (!/wall ride/.test(into.reason ?? '')) bad.push(`refused with the wrong words: "${into.reason}"`)
    // The same stretch moved 60 m back, clear of the grow-in.
    const clear = raiseDraft(d, atOf(line, sWall - 360), atOf(line, sWall - 60), 6, { ...o(d, ground), exact: true })
    if (!clear.ok) bad.push(`a raise ending 60 m before the wall ride was refused: ${clear.reason}`)
    return bad.length ? bad : `into the grow-in: "${into.reason}"; 60 m short of it: goes ahead`
  })

  check('Dips: the game\'s dips check fails a road dug 8 m down over a short stretch (a car takes off at its lip) and passes the same dip on long, gentle ramps', () => {
    const oval = longOval('selftest-dips')
    if (typeof oval === 'string') return [oval]
    const { d } = oval
    const line = roadLine(d.points)
    const mid = sOfPoint(line, nearestPoint(d.points, { x: 0, z: -R }))
    const dig = (half: number): Draft => {
      // Every point within `half` metres of the middle of the south straight dips on a smooth (cosine) bump, 8 m at the middle.
      const points = d.points.map((p, i) => {
        const off = Math.abs(sOfPoint(line, i) - mid)
        if (off >= half) return p
        const w = 0.5 + 0.5 * Math.cos((Math.PI * off) / half)
        return { ...p, lift: Math.round(-8 * w * 100) / 100 }
      })
      return { ...d, points }
    }
    const bad: string[] = []
    const row = (dd: Draft) => buildAndCheck(dd, dd.id).gates.find((g) => g.name === 'dips')
    const sharp = row(dig(60))
    const gentle = row(dig(260))
    if (!sharp) bad.push('a road dug 8 m down has no dips row')
    else if (sharp.level !== 'fail') bad.push(`a 120 m long, 8 m deep dip passes the dips check: ${sharp.message}`)
    if (!gentle) bad.push('the gentle dip has no dips row')
    else if (gentle.level !== 'ok') bad.push(`a 520 m long, 8 m deep dip fails the dips check: ${gentle.message}`)
    return bad.length ? bad : `120 m long: "${sharp?.message}"; 520 m long: "${gentle?.message}"`
  })

  check('Bridges: a swapped bridge never throws a car off more than the bridge it replaces (or the Height tool\'s limit, whichever is more), at the speed a car is likely to be there', () => {
    const { d, ground } = eight()
    const c = roadCrossings(d.points, ground)[0]
    if (!c || c.over === null) return ['the eight has no bridge']
    /** The worst share of gravity's pull over the upper road at the crossing, out 260 m each way, at the fastest likely speed. */
    const worst = (dd: Draft): { share: number; kmh: number } | null => {
      const t = buildAndCheck(dd, dd.id).runtime
      if (!t) return null
      const S = t.samples
      let up = -1
      for (let i = 0; i < S.count; i++) if (Math.hypot(S.px[i] - c.at.x, S.pz[i] - c.at.z) < 4 && (up < 0 || S.py[i] > S.py[up])) up = i
      const m = Math.round(260 / S.ds)
      let v = 0
      for (let k = -m; k <= m; k++) v = Math.max(v, t.racingLine.speed[(((up + k) % S.count) + S.count) % S.count])
      v = Math.min(250 / 3.6, v * 1.15)
      let share = 0
      for (let k = -m; k <= m; k++) share = Math.max(share, crestShareAt(t, (((up + k) % S.count) + S.count) % S.count, v, 20))
      return { share, kmh: v * 3.6 }
    }
    const bad: string[] = []
    const notes: string[] = []
    let cur = d
    for (const step of ['swap', 'swap back']) {
      const was = worst(cur)
      const r = swapDraft(cur, c.at, o(cur, ground))
      if (!r.ok || !r.draft) {
        notes.push(`${step} refused: "${r.reason}"`)
        break
      }
      const now = worst(r.draft)
      if (!was || !now) return ['did not build']
      if (now.share > Math.max(CREST_LIMIT, was.share + 0.02)) bad.push(`${step}: the new bridge asks ${(now.share * 100).toFixed(0)}% of gravity's pull at ${now.kmh.toFixed(0)} km/h, the one it replaced ${(was.share * 100).toFixed(0)}%`)
      notes.push(`${step}: ${(was.share * 100).toFixed(0)}% -> ${(now.share * 100).toFixed(0)}% at ${now.kmh.toFixed(0)} km/h`)
      cur = r.draft
    }
    return bad.length ? bad : notes.join('; ')
  })
}
