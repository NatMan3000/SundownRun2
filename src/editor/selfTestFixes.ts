// ============================================================
//  SELF-TEST: RAISING STRETCHES AND FIX IT - rows for selfTest.ts
// ------------------------------------------------------------
//  The editor's self-test (selfTest.ts) calls fixAndRaiseRows() at
//  the end. Each row builds a road, changes it the way the Stretch
//  tool's Height slider or a Fix it button does, then builds the
//  result with the real track builder and checks it with the game's
//  own checks, separately from the code that made the change:
//
//    raising   a drawn oval and an Afterglow copy raised to 8 m and
//              16 m pass every check and a car stays on over the top;
//              a stretch too short for the height is limited and says
//              why; a road point's height is a smooth bump; a bridge
//              keeps room for a car; a loop or the start grid on the
//              stretch refuses it
//    fixing    a road that fails each fixable check, mended by Fix it:
//              that check passes after and no other check fails; the
//              editor's own issues likewise; the game's own bugs get
//              no Fix it button; a fix that would break another check
//              changes nothing; Fix all
//    editor10  Fix it only says it can mend a problem once it has found
//              the fix; Nathan's hand-banked gentle bend is mended; a
//              hand bank under a bridge gets the bridge raised; setting
//              a bank under a bridge keeps room for a car
//    undo      a raise, a fix and a Fix all are each ONE Undo step
//              (the real editor store, Bun only)
// ============================================================

import { CREST_LIMIT } from '../track/bankRolls'
import type { TrackGate } from '../track/gates'
import type { Piece, RoadPoint } from '../track/schema'
import afterglowJson from '../../tracks/afterglow.json'
import type { TrackFile } from '../track/schema'
import { CLEANUP, type CleanupOptions, cleanStroke } from './cleanup'
import { checkVerdict } from './checks'
import type { Draft } from './draft'
import { DEFAULT_BASE_WORLD, draftFromFile, pointGroundOf } from './draftFile'
import { BRIDGE_GAP, type GroundFn, builtGapAt, roadCrossings } from './bridges'
import { keepBridgesClear } from './bankBridges'
import type { P } from './geom'
import { type FixContext, runFix, runFixAll } from './fixes'
import { type Judged, judgeDraft } from './judge'
import { type Problem, problemsOf } from './problems'
import { RAISE_MIN_METRES, launchHalf, launchOver, planRaise, pointStretch, raiseDraft, stretchNow, stretchSamples, stretchSpeed } from './raise'
import { atOf, densify, posOf, roadHeightAt, roadLine, sOf, sOfPoint, wrapS } from './shape'
import { nearestOnRoad, roadCurve } from './road'
import type { TrackRuntime } from '../track/types'
import { SURFACE_CODE } from '../track/types'

type Check = (name: string, fn: () => string[] | string) => void
type EditorStore = typeof import('./draft')
type Shaky = (shape: (t: number) => P, count: number, wobble: number, seed: number, t0?: number, t1?: number) => P[]

const TAU = Math.PI * 2

/** Where Nathan's case is drawn and banked (found by /tmp/sr2/editor10/findloop.sh: the editor before editor10 couldn't mend it). */
const NATHAN = { seed: 4, k0: 50, len1: 6, gap: 2, len2: 4 }

/** A road the way the editor holds it: a draft in the default world (seed pinned), and the ground under its points. */
interface Fixture {
  d: Draft
  ground: GroundFn
}

function asDraft(id: string, points: RoadPoint[], width = 14): Fixture {
  const environment = { ...JSON.parse(JSON.stringify(DEFAULT_BASE_WORLD.environment)), seed: 1 }
  const d: Draft = { id, name: id, author: '', description: '', points, width, baseWorld: DEFAULT_BASE_WORLD.id, environment, pieces: [], props: [], cores: [], startAt: 0 }
  const ground = pointGroundOf(environment, id)
  if (!ground) throw new Error(`the ${id} world didn't validate`)
  return { d, ground }
}

/** A copy that can be changed freely. */
function clone(f: Fixture): Fixture {
  return { d: JSON.parse(JSON.stringify(f.d)) as Draft, ground: f.ground }
}

/** The `at` on a draft's road nearest a map spot. */
function mapNear(d: Draft, p: P): number {
  return nearestOnRoad(roadCurve(d.points), p).at
}

/**
 * The worst crest over samples `idx`: how much of gravity's pull a car at `v` m/s
 * needs to stay on, from the road's slope `half` metres either side (worked out
 * here, apart from raise.ts, so the row checks it rather than repeats it).
 */
function topCrest(t: TrackRuntime, idx: readonly number[], v: number, half: number): number {
  const S = t.samples
  const W = Math.max(1, Math.round(Math.max(6, Math.min(20, half)) / S.ds))
  let worst = 0
  for (const i of idx) {
    const a = (i - W + S.count) % S.count
    const b = (i + W) % S.count
    if (S.surface[i] !== SURFACE_CODE.road) continue
    const slope = (j: number) => Math.atan2(S.ty[j], Math.hypot(S.tx[j], S.tz[j]))
    const bend = (slope(a) - slope(b)) / (2 * W * S.ds)
    worst = Math.max(worst, (v * v * bend) / (9.81 * Math.cos(slope(i))))
  }
  return worst
}

function failing(gates: readonly TrackGate[]): string[] {
  return gates.filter((g) => g.level === 'fail').map((g) => g.name)
}

export function fixAndRaiseRows(check: Check, store: EditorStore | undefined, h: { shaky: Shaky; opts: Partial<CleanupOptions> }): void {
  // ---------------------------------------------------------------- the roads

  /** A pencil-drawn stadium oval: two 420 m straights (south heading east, north heading west) and 130 m-radius ends. */
  const oval = (() => {
    const R = 130
    const H = 210
    const per = 4 * H + TAU * R
    const at = (t: number): P => {
      let d = (((t % 1) + 1) % 1) * per
      if (d < 2 * H) return { x: -H + d, z: -R }
      d -= 2 * H
      if (d < Math.PI * R) return { x: H + R * Math.cos(-Math.PI / 2 + d / R), z: R * Math.sin(-Math.PI / 2 + d / R) }
      d -= Math.PI * R
      if (d < 2 * H) return { x: H - d, z: R }
      d -= 2 * H
      return { x: -H + R * Math.cos(Math.PI / 2 + d / R), z: R * Math.sin(Math.PI / 2 + d / R) }
    }
    const res = cleanStroke(h.shaky(at, 700, 2, 3, 0, 1.03), h.opts)
    if (!res.ok) throw new Error('the oval did not clean up')
    return asDraft('selftest-oval', res.points)
  })()
  /** The bridges rows' figure-eight (one crossing, the clean-up's 8 m bridge). */
  const eight = (() => {
    const res = cleanStroke(h.shaky((t) => ({ x: 260 * Math.sin(t * TAU), z: 130 * Math.sin(2 * t * TAU) }), 600, 3, 2, 0.1, 1.1), h.opts)
    if (!res.ok) throw new Error('the eight did not clean up')
    return asDraft('selftest-bridges', res.points)
  })()
  /** "Copy and edit" Afterglow: 40 points up to 200 m apart, 16 of them with set heights. */
  const afterglow = (() => {
    const d = draftFromFile(afterglowJson as unknown as TrackFile, true)
    d.id = 'afterglow-copy'
    const ground = pointGroundOf(d.environment, d.id)
    if (!ground) throw new Error("the Afterglow copy's world didn't validate")
    return { d, ground }
  })()
  const judged = new Map<Draft, Judged>()
  const judge = (d: Draft): Judged => {
    let j = judged.get(d)
    if (!j) {
      j = judgeDraft(d, d.id)
      judged.set(d, j)
    }
    return j
  }

  // ---------------------------------------------------------------- raising a stretch

  /** Raise and judge it independently: the height, every check, a car over the top, the road elsewhere. */
  const raiseVerdict = (f: Fixture, from: number, to: number, height: number): { bad: string[]; note: string; draft?: Draft } => {
    const before = judge(f.d)
    const r = raiseDraft(f.d, from, to, height, { id: f.d.id, pointGround: f.ground })
    if (!r.ok || !r.draft || r.from === undefined || r.to === undefined) return { bad: [`${height} m was refused: ${r.reason}`], note: '' }
    const bad: string[] = []
    if (r.limited) bad.push(`${height} m was limited to ${r.height?.toFixed(2)} m: ${r.done}`)
    const got = stretchNow(r.draft.points, r.from, r.to, f.ground).middle
    if (Math.abs(got - height) > 0.15) bad.push(`the middle is ${got.toFixed(2)} m up, not ${height}`)
    const after = judgeDraft(r.draft, f.d.id)
    if (!after.runtime) return { bad: [...bad, `did not build: ${after.error}`], note: '' }
    const fresh = failing(after.gates).filter((n) => !failing(before.gates).includes(n))
    if (fresh.length) bad.push(`now fails ${fresh.join(', ')}`)
    // A car stays on over the top, at the speed cars can be doing there (the racing line before, +15%, up to
    // 250 km/h): over the middle half of the stretch the road may fall away from it by at most CREST_LIMIT of
    // gravity (worked out here from the built road's own slope), and nowhere may it be worse than the old road.
    const v = stretchSpeed(before.runtime, f.d.points, from, to)
    const metres = stretchNow(f.d.points, from, to, f.ground).metres
    const idx = stretchSamples(after.runtime, r.from, r.to, r.draft.points.length, 0)
    const top = topCrest(after.runtime, idx.slice(Math.floor(idx.length / 4), Math.ceil((3 * idx.length) / 4)), v, metres / 8)
    if (top > CREST_LIMIT) bad.push(`over the top a car at ${(v * 3.6).toFixed(0)} km/h needs ${(top * 100).toFixed(0)}% of gravity (limit ${CREST_LIMIT * 100}%)`)
    const worse = launchOver(after.runtime, before.runtime, stretchSamples(after.runtime, r.from, r.to, r.draft.points.length, 30), v, launchHalf(metres))
    if (worse.over > 0) bad.push(`a car at ${(v * 3.6).toFixed(0)} km/h is lighter than on the old road by ${(worse.over * 100).toFixed(0)}% of gravity at the ${worse.s.toFixed(0)} m mark`)
    // The road outside the stretch (more than 20 m from it) keeps every point exactly.
    const line = roadLine(f.d.points)
    const s0 = sOf(line, from)
    const len = wrapS(sOf(line, to) - s0, line.length)
    let kept = 0
    f.d.points.forEach((p, k) => {
      const d0 = wrapS(sOfPoint(line, k) - s0, line.length)
      if (d0 < len + 20 || d0 > line.length - 20) return
      const q = r.draft?.points.find((x) => x.x === p.x && x.z === p.z)
      if (!q || q.y !== p.y || q.lift !== p.lift || q.bank !== p.bank) bad.push(`point ${k} outside the stretch changed`)
      else kept++
    })
    return { bad, note: `${height} m: middle ${got.toFixed(2)} m, over the top ${(top * 100).toFixed(0)}% of gravity at ${(v * 3.6).toFixed(0)} km/h, ${kept} points outside kept`, draft: r.draft }
  }

  check('Raise: a drawn road raised to 8 m and to 16 m over a 545 m stretch passes every check, and a car stays on over the top', () => {
    const line = roadLine(oval.d.points)
    const notes: string[] = []
    const bad: string[] = []
    for (const H of [8, 16]) {
      const v = raiseVerdict(oval, 42, 76, H)
      bad.push(...v.bad.map((b) => `${H} m: ${b}`))
      notes.push(v.note)
    }
    return bad.length ? bad : `${Math.round(sOfPoint(line, 76) - sOfPoint(line, 42))} m of the north straight and its ends; ${notes.join('; ')}`
  })

  check('Raise: an Afterglow copy (points 200 m apart, set heights) raised to 8 m and to 16 m passes every check, and a car stays on', () => {
    const line = roadLine(afterglow.d.points)
    const from = atOf(line, 2971)
    const to = atOf(line, 3571)
    const notes: string[] = []
    const bad: string[] = []
    for (const H of [8, 16]) {
      const v = raiseVerdict(afterglow, from, to, H)
      bad.push(...v.bad.map((b) => `${H} m: ${b}`))
      notes.push(v.note)
      // A point keeps its own kind of height: every set height stays a set height.
      const setBefore = afterglow.d.points.filter((p) => p.y !== undefined).length
      const setAfter = v.draft?.points.filter((p) => p.y !== undefined && afterglow.d.points.some((o) => o.x === p.x && o.z === p.z)).length ?? setBefore
      if (setAfter !== setBefore) bad.push(`${H} m: only ${setAfter} of ${setBefore} original set heights are still set heights`)
    }
    // Over the stretch with its hand-set heights: every point that has a set height (y) keeps one, and gets no lift.
    const k = afterglow.d.points.findIndex((p) => p.y !== undefined)
    const sy = sOfPoint(line, k)
    const plan = planRaise({ ...afterglow.d, pointGround: afterglow.ground }, atOf(line, sy - 150), atOf(line, sy + 150), stretchNow(afterglow.d.points, atOf(line, sy - 150), atOf(line, sy + 150), afterglow.ground).middle + 3)
    const even = densify(line, 0, line.length, 20, CLEANUP.spacing, { pointGround: afterglow.ground }).points
    if (!plan.ok) bad.push(`the stretch over the set heights was refused: ${plan.reason}`)
    else {
      let changedSet = 0
      even.forEach((p, i) => {
        const q = plan.points[i]
        if (p.y === undefined || !q) return
        if (q.y === undefined || q.lift !== undefined) bad.push(`point ${i} had a set height and now has ${q.y === undefined ? 'none' : 'a lift too'}`)
        else if (q.y !== p.y) changedSet++
      })
      if (!changedSet) bad.push('no set height in the stretch was changed, so this proves nothing')
      notes.push(`${changedSet} set heights raised and still set heights`)
    }
    return bad.length ? bad : `600 m from the 2.97 km point; ${notes.join('; ')}`
  })

  check('Raise: a stretch too short for the height goes as high as is safe and says how long it needs to be; under 30 m is refused', () => {
    const line = roadLine(oval.d.points)
    const from = 46
    const to = atOf(line, sOfPoint(line, 46) + 150)
    const r = raiseDraft(oval.d, from, to, 16, { id: oval.d.id, pointGround: oval.ground })
    const bad: string[] = []
    if (!r.ok || !r.draft) return [`refused instead of limited: ${r.reason}`]
    if (!r.limited) bad.push('not marked as limited')
    if (!(r.height !== undefined && r.height > 0.5 && r.height < 8)) bad.push(`went to ${r.height?.toFixed(2)} m`)
    if (!/Select about \d+ m of road to go to 16 m/.test(r.done ?? '')) bad.push(`no "select about N m" in "${r.done}"`)
    // The limited height really is drivable: every check, and a car stays on.
    const v = raiseVerdict(oval, from, to, Math.round((r.height ?? 0) * 10) / 10)
    bad.push(...v.bad.filter((b) => !/limited/.test(b)))
    const tiny = raiseDraft(oval.d, 46, atOf(line, sOfPoint(line, 46) + 20), 8, { id: oval.d.id, pointGround: oval.ground })
    if (tiny.ok || !new RegExp(`at least ${RAISE_MIN_METRES} m`).test(tiny.reason ?? '')) bad.push(`a 20 m stretch: ${tiny.ok ? 'went ahead' : tiny.reason}`)
    return bad.length ? bad : `150 m asked for 16 m: "${r.done}"; 20 m: "${tiny.reason}"`
  })

  check("Raise: a road point's height is a smooth hump over the road either side, not a spike", () => {
    const k = 60
    const st = pointStretch(oval.d.points, k, 8, judge(oval.d).runtime, oval.ground)
    const r = raiseDraft(oval.d, st.from, st.to, 8, { id: oval.d.id, pointGround: oval.ground })
    if (!r.ok || !r.draft || r.from === undefined || r.to === undefined) return [`refused: ${r.reason}`]
    const bad: string[] = []
    if (st.metres < 64) bad.push(`the hump is only ${st.metres} m long`)
    const after = judgeDraft(r.draft, oval.d.id)
    if (failing(after.gates).length) bad.push(`fails ${failing(after.gates).join(', ')}`)
    // How much the road rose, along the hump: all of it at the point, about half a quarter of the way
    // out either side, nothing at the ends. A spike would rise at the point and hardly anywhere else.
    const oldLine = roadLine(oval.d.points)
    const raised = r.draft
    const sc = sOfPoint(oldLine, k)
    const rise = (d: number) => {
      const p = posOf(oldLine, sc + d)
      return roadHeightAt(raised.points, mapNear(raised, p), oval.ground) - roadHeightAt(oval.d.points, atOf(oldLine, sc + d), oval.ground)
    }
    const q = st.metres / 4
    const rises = [-2 * q, -q, 0, q, 2 * q].map(rise)
    const peak = rises[2]
    if (!(peak > 6)) bad.push(`the road rose only ${peak.toFixed(2)} m at the point`)
    for (const i of [1, 3]) if (!(rises[i] > 0.3 * peak && rises[i] < 0.75 * peak)) bad.push(`a quarter of the way out it rose ${rises[i].toFixed(2)} m (a smooth hump: about half of ${peak.toFixed(2)})`)
    for (const i of [0, 4]) if (Math.abs(rises[i]) > 0.3) bad.push(`at the ends it moved ${rises[i].toFixed(2)} m`)
    return bad.length ? bad : `${st.metres} m hump; the road rose ${rises.map((x) => x.toFixed(1)).join(', ')} m every ${q.toFixed(0)} m; every check passes`
  })

  check("Raise: a bridge keeps room for a car (raising the road under it, or lowering the bridge, stops short or is refused)", () => {
    const c = roadCrossings(eight.d.points, eight.ground)[0]
    if (!c || c.over === null) return ['the eight has no bridge']
    const line = roadLine(eight.d.points)
    const under = c.passes[c.over === 0 ? 1 : 0]
    const over = c.passes[c.over]
    const bad: string[] = []
    const said: string[] = []
    for (const [label, pass, H] of [['the road under the bridge to 8 m', under, 8], ['the bridge down to the ground', over, 0]] as const) {
      const s = sOf(line, pass.at)
      const r = raiseDraft(eight.d, atOf(line, s - 150), atOf(line, s + 150), H, { id: eight.d.id, pointGround: eight.ground })
      if (r.ok && r.draft) {
        const after = judgeDraft(r.draft, eight.d.id)
        const g = after.runtime ? builtGapAt(after.runtime, c.at, over.heading) : null
        if (!g || !g.upperMatches || g.gap < BRIDGE_GAP) bad.push(`${label}: the built gap is ${g?.gap.toFixed(2)} m${g && !g.upperMatches ? ', and the wrong road is on top' : ''}`)
        if (!r.limited) bad.push(`${label}: went all the way`)
        if (!/between them \(a car needs 6\.2 m\)/.test(r.done ?? '')) bad.push(`${label}: stopped short without saying it's for the bridge: "${r.done}"`)
        said.push(`${label}: stopped at ${r.height?.toFixed(1)} m, gap ${g?.gap.toFixed(1)} m ("${r.done}")`)
      } else {
        if (!/between them \(a car needs 6\.2 m\)/.test(r.reason ?? '')) bad.push(`${label}: refused without saying it's the bridge: "${r.reason}"`)
        said.push(`${label}: "${r.reason}"`)
      }
    }
    return bad.length ? bad : said.join('; ')
  })

  check('Raise: a loop or the start grid on the stretch refuses it in plain words, and nothing changes', () => {
    const bad: string[] = []
    const withLoop = clone(oval)
    withLoop.d.pieces = [{ type: 'loop', at: 60 } as Piece]
    const before = JSON.stringify(withLoop.d)
    const plan = planRaise({ ...withLoop.d, pointGround: withLoop.ground }, 52, 68, 6)
    if (plan.ok || !/A loop is on this stretch/.test(plan.reason ?? '')) bad.push(`loop: ${plan.ok ? 'went ahead' : plan.reason}`)
    const grid = planRaise({ ...oval.d, pointGround: oval.ground }, 96, 6, 6)
    if (grid.ok || !/start line is on this stretch/.test(grid.reason ?? '')) bad.push(`start: ${grid.ok ? 'went ahead' : grid.reason}`)
    if (JSON.stringify(withLoop.d) !== before) bad.push('the draft was changed')
    return bad.length ? bad : `"${plan.reason}" / "${grid.reason}"`
  })

  // ---------------------------------------------------------------- Fix it

  const ctxFor = (f: Fixture, d: Draft): FixContext => ({ id: f.d.id, world: { width: d.width, bound: 2000, playRadius: Infinity, pointGround: f.ground }, before: judge(d) })
  const problemsFor = (d: Draft): Problem[] => {
    const j = judge(d)
    return problemsOf({ draft: d, gates: j.gates, errors: j.errors, warnings: j.warnings, notes: [] })
  }
  /** Mend the problem `pick` finds, then judge the result separately: it is gone and nothing else fails. */
  const fixVerdict = (label: string, f: Fixture, d: Draft, pick: (p: Problem) => boolean): { bad: string[]; note: string } => {
    const list = problemsFor(d)
    const p = list.find(pick)
    if (!p) return { bad: [`${label}: the fixture doesn't show the problem (it shows ${list.map((x) => x.key).join(', ') || 'nothing'})`], note: '' }
    if (p.remedy.kind !== 'fix') return { bad: [`${label}: no Fix it (${p.remedy.kind})`], note: '' }
    const before = JSON.stringify(d)
    const r = runFix(p, d, ctxFor(f, d))
    if (JSON.stringify(d) !== before) return { bad: [`${label}: the draft it was given was changed`], note: '' }
    if (!r.ok || !r.draft) return { bad: [`${label}: not fixed: ${r.reason}`], note: '' }
    const after = judgeDraft(r.draft, f.d.id)
    if (!after.runtime) return { bad: [`${label}: the fixed track did not build: ${after.error}`], note: '' }
    const was = failing(judge(d).gates)
    const fresh = failing(after.gates).filter((n) => !was.includes(n))
    const still = problemsOf({ draft: r.draft, gates: after.gates, errors: after.errors, warnings: after.warnings, notes: [] }).filter((x) => x.source === p.source && (p.gate ? x.gate?.name === p.gate.name && x.gate.level === p.gate.level : x.key.split(':').slice(0, 3).join(':') === p.key.split(':').slice(0, 3).join(':')))
    const bad: string[] = []
    if (still.length) bad.push(`${label}: still there after the fix (${still[0].title})`)
    if (fresh.length) bad.push(`${label}: the fix made ${fresh.join(', ')} fail`)
    return { bad, note: `${label}: ${r.did}` }
  }
  const gate = (name: string) => (p: Problem) => p.source === 'gate' && p.gate?.name === name && p.gate.level !== 'ok'
  const issue = (re: RegExp) => (p: Problem) => p.source === 'validator' && re.test(p.issue?.message ?? '')

  check('Fix it: a kink (a point dragged sideways, or one lifted 6 m) is smoothed away and nothing else fails', () => {
    // A point on the ground (no lift on it or its neighbours: clear of the bridge's ramps), near point 30.
    const onGround = (k: number) => [-3, -2, -1, 0, 1, 2, 3].every((j) => !eight.d.points[(k + j + eight.d.points.length) % eight.d.points.length].lift)
    let kink = 30
    while (!onGround(kink) && kink < eight.d.points.length - 4) kink++
    const side = clone(eight)
    side.d.points[kink].x += 12
    const spike = clone(eight)
    spike.d.points[kink].lift = 6
    const a = fixVerdict('dragged', side, side.d, gate('smooth'))
    const b = fixVerdict('lifted', spike, spike.d, gate('smooth'))
    const pin = clone(eight)
    pin.d.points[12].x *= 0.75
    pin.d.points[12].z *= 0.75
    const c = fixVerdict('a hairpin pulled in to a 1 m corner', pin, pin.d, gate('smooth'))
    const bad = [...a.bad, ...b.bad, ...c.bad]
    return bad.length ? bad : `${a.note} / ${b.note} / ${c.note}`
  })

  check('Fix it: a bridge too low for a car is lifted onto a proper bridge, and the built road has room under it', () => {
    const low = clone(eight)
    low.d.points = low.d.points.map((p) => (p.lift && p.lift > 3 ? { ...p, lift: 3 } : p))
    const v = fixVerdict('low bridge', low, low.d, gate('bridges'))
    const w = fixVerdict('crossing warning', low, low.d, issue(/crosses itself/))
    return v.bad.length || w.bad.length ? [...v.bad, ...w.bad] : `${v.note} / ${w.note}`
  })

  check('Fix it: a sudden tilt and a car going light (bank set by hand) are eased over a longer stretch', () => {
    const tilt = clone(oval)
    tilt.d.points[10].bank = 45
    tilt.d.points[11].bank = 45
    const light = clone(oval)
    light.d.points[10].bank = 45
    light.d.points[11].bank = 0
    const out = clone(oval)
    out.d.width = 24
    out.d.pieces = [{ type: 'loop', at: 10, radius: 8 } as Piece]
    const a = fixVerdict('banked 45 degrees on a straight (SUDDEN TILT)', tilt, tilt.d, gate('banking'))
    const b = fixVerdict('leaning out of the corner after a loop (SUDDEN TILT)', out, out.d, gate('banking'))
    const c = fixVerdict('banked 45 then 0 (CAR GOES LIGHT)', light, light.d, gate('crest'))
    const bad = [...a.bad, ...b.bad, ...c.bad]
    return bad.length ? bad : [a.note, b.note, c.note].join(' / ')
  })

  check('Fix it: a loop on a bend moves to a straight, and a loop that twists too fast gets as big as the game says', () => {
    const bend = clone(oval)
    bend.d.pieces = [{ type: 'loop', at: 30 } as Piece]
    const twist = clone(oval)
    twist.d.width = 24
    twist.d.pieces = [{ type: 'loop', at: 10, radius: 8 } as Piece]
    const a = fixVerdict('loop on a bend (LOOP BLOCKED)', bend, bend.d, gate('loops'))
    const b = fixVerdict('loop on a bend (validator)', bend, bend.d, issue(/sits on a bend/))
    const c = fixVerdict('loop twisting too fast', twist, twist.d, (p) => gate('surface')(p) && /twists too fast/.test(p.gate?.message ?? ''))
    const bad = [...a.bad, ...b.bad, ...c.bad]
    return bad.length ? bad : [a.note, b.note, c.note].join(' / ')
  })

  check('Fix it: the start grid on a bend moves to the nearest straight', () => {
    const f = clone(oval)
    f.d.startAt = 30
    const v = fixVerdict('start on a bend', f, f.d, gate('start.at'))
    return v.bad.length ? v.bad : v.note
  })

  check("Fix it: the editor's own issues (points on top of each other, off the world, a tight corner, pieces on the grid, off the road, overlapping)", () => {
    const close = clone(eight)
    const p50 = close.d.points[50]
    const p51 = close.d.points[51]
    close.d.points.splice(51, 0, { x: p50.x + (p51.x - p50.x) * 0.05, z: p50.z + (p51.z - p50.z) * 0.05 })
    const prop = clone(eight)
    prop.d.props = [{ x: 5000, z: 0 }]
    const tight = clone(eight)
    tight.d.points[30].x += 12
    const pieces = clone(oval)
    pieces.d.pieces = [{ type: 'ramp', at: 60, offset: 6 } as Piece, { type: 'ramp', at: 0.5 } as Piece, { type: 'ramp', at: 52 } as Piece, { type: 'ramp', at: 52.3 } as Piece]
    const rows = [
      fixVerdict('points on top of each other', close, close.d, issue(/within 2 m of point/)),
      fixVerdict('a prop off the world', prop, prop.d, issue(/outside the world/)),
      fixVerdict('a corner tighter than 25 m', tight, tight.d, issue(/m radius; keep corners/)),
      fixVerdict('a ramp off the road', pieces, pieces.d, issue(/sticks out past the road edge/)),
      fixVerdict('a ramp on the start grid', pieces, pieces.d, issue(/on or next to the start grid/)),
      fixVerdict('two ramps overlapping', pieces, pieces.d, issue(/overlaps/)),
    ]
    const bad = rows.flatMap((r) => r.bad)
    return bad.length ? bad : rows.map((r) => r.note).join(' / ')
  })

  check("Fix it: the game's own bugs get no Fix it button (they say so), and a fix that would break another check changes nothing", () => {
    const bad: string[] = []
    const bug = (name: string, message: string): TrackGate => ({ name, ok: false, level: 'fail', message, fix: 'this is a builder bug, not your file: report it.' })
    const fake = [bug('winding', 'road 1/2 triangles face the way their normals do'), bug('tracking', 'walking the lap with hints, s jumped 40 m at s=10 (at 1.0)'), bug('under', 'physics ground 0.1 m under the road at s=300 (at 20.0)'), bug('surface', 'a physics triangle faces 3 deg away from the real road at s=300 (at 20.0)'), bug('banking', 'the bank leans 30 deg more than the road\'s bend wants at s=300 (at 20.0)')]
    for (const p of problemsOf({ draft: oval.d, gates: fake, errors: [], warnings: [], notes: [] })) {
      if (p.remedy.kind !== 'game') bad.push(`${p.gate?.name}: offers "${p.remedy.kind}"`)
      else if (!/game's fault/.test(p.remedy.does)) bad.push(`${p.gate?.name}: doesn't say it's the game's fault`)
    }
    // A loop on a bend upsets the racing line too; smoothing the road there can't fix that without a kink, so it is refused.
    const bend = clone(oval)
    bend.d.pieces = [{ type: 'loop', at: 30 } as Piece]
    const line = problemsFor(bend.d).find(gate('line'))
    let refused = ''
    if (line) {
      const before = JSON.stringify(bend.d)
      const r = runFix(line, bend.d, ctxFor(bend, bend.d))
      if (r.ok) {
        const after = judgeDraft(r.draft as Draft, bend.d.id)
        const fresh = failing(after.gates).filter((n) => !failing(judge(bend.d).gates).includes(n))
        if (fresh.length) bad.push(`the line fix went ahead and made ${fresh.join(', ')} fail`)
        refused = `(the line fix worked: ${r.did})`
      } else refused = `"${r.reason}"`
      if (JSON.stringify(bend.d) !== before) bad.push('the draft was changed')
    } else bad.push("the loop on a bend doesn't upset the racing line any more: pick another refusal")
    // The rule itself: a way of mending the start grid that also puts a 6 m spike in the road (a new kink) is never used.
    const start = clone(oval)
    start.d.startAt = 30
    const sp = problemsFor(start.d).find(gate('start.at'))
    if (!sp) bad.push('the start-on-a-bend fixture shows no start grid problem')
    else {
      const good = runFix(sp, start.d, ctxFor(start, start.d))
      if (!good.ok || !good.draft) bad.push(`the start grid fix failed: ${good.reason}`)
      else {
        const spiked = { ...good.draft, points: good.draft.points.map((p, i) => (i === 60 ? { ...p, lift: 6 } : p)) }
        const before = JSON.stringify(start.d)
        const only = runFix(sp, start.d, ctxFor(start, start.d), [{ draft: spiked, did: 'moved it and spiked the road' }])
        if (only.ok) bad.push('a fix that makes the smooth check fail went ahead')
        const both = runFix(sp, start.d, ctxFor(start, start.d), [{ draft: spiked, did: 'spiked' }, { draft: good.draft, did: 'clean' }])
        if (!both.ok || both.did !== 'clean') bad.push(`with a clean way second, it took "${both.did}"`)
        if (JSON.stringify(start.d) !== before) bad.push('the draft was changed')
        refused += `; a start-line fix that also spikes the road: "${only.reason}", the clean one taken instead`
      }
    }
    return bad.length ? bad : `5 game-bug rows: no Fix it; the racing line next to a loop on a bend: ${refused}`
  })

  check('Fix all: a loop on a bend and everything it upsets (racing line, loop, surface, warnings) mended in one go', () => {
    const bend = clone(oval)
    bend.d.pieces = [{ type: 'loop', at: 30 } as Piece]
    const before = judge(bend.d)
    const res = runFixAll(bend.d, ctxFor(bend, bend.d), [])
    const after = judgeDraft(res.draft, bend.d.id)
    const bad: string[] = []
    const verdict = checkVerdict({ fresh: true, errors: after.errors, gates: after.gates, cleanupErrors: 0 })
    if (verdict !== 'pass') bad.push(`still failing: ${failing(after.gates).join(', ')}`)
    const fresh = failing(after.gates).filter((n) => !failing(before.gates).includes(n))
    if (fresh.length) bad.push(`made ${fresh.join(', ')} fail`)
    return bad.length ? bad : `before: ${failing(before.gates).join(', ')}; ${res.did.length} fixes: ${res.did.join(' ')}; after: every check passes`
  })

  // ---------------------------------------------------------------- editor10: only promise what it can do; banks set by hand

  /**
   * Nathan's case (GitHub playtest, 3 Oct): a gentle bend banked by hand at 32 degrees,
   * a short gap, then 29.5 degrees, and CAR GOES LIGHT where the bank rolls. Before
   * editor10 the row said "Fix it can mend this" and Fix all said it couldn't mend any.
   */
  const gentle = (() => {
    const res = cleanStroke(h.shaky((t) => ({ x: 700 * Math.cos(t * TAU), z: 450 * Math.sin(t * TAU) }), 700, 2, NATHAN.seed, 0, 1.03), h.opts)
    if (!res.ok) throw new Error('the gentle ellipse did not clean up')
    const f = asDraft('selftest-gentle', res.points)
    const n = f.d.points.length
    for (let k = NATHAN.k0; k < NATHAN.k0 + NATHAN.len1; k++) f.d.points[k % n].bank = 32
    for (let k = NATHAN.k0 + NATHAN.len1 + NATHAN.gap; k < NATHAN.k0 + NATHAN.len1 + NATHAN.gap + NATHAN.len2; k++) f.d.points[k % n].bank = 29.5
    return f
  })()
  /** Judge a mended draft from scratch (its own build, not the one fixes.ts made): `p` gone, nothing new failing. */
  const mendedVerdict = (label: string, d: Draft, p: Problem, mended: Draft): string[] => {
    const after = judgeDraft(mended, d.id)
    if (!after.runtime) return [`${label}: the mended road did not build: ${after.error}`]
    const was = failing(judge(d).gates)
    const fresh = failing(after.gates).filter((n) => !was.includes(n))
    const bad: string[] = []
    if (p.gate && after.gates.some((g) => g.name === p.gate?.name && g.level === 'fail')) bad.push(`${label}: ${p.gate.name} still fails`)
    if (fresh.length) bad.push(`${label}: now fails ${fresh.join(', ')}`)
    return bad
  }
  /** The steepest bank set by hand on a road. */
  const steepest = (d: Draft) => Math.max(0, ...d.points.map((p) => Math.abs(p.bank ?? 0)))

  check("Fix it: Nathan's gentle bend banked by hand at 32 and 29.5 degrees (CAR GOES LIGHT) is mended by Fix it and by Fix all, keeping as much bank as works", () => {
    const j = judge(gentle.d)
    const p = problemsFor(gentle.d).find(gate('crest'))
    if (!p) return [`the fixture doesn't fail crest (it fails ${failing(j.gates).join(', ') || 'nothing'})`]
    const bad: string[] = []
    const one = runFix(p, gentle.d, ctxFor(gentle, gentle.d))
    if (!one.ok || !one.draft) bad.push(`Fix it: not fixed: ${one.reason}`)
    else bad.push(...mendedVerdict('Fix it', gentle.d, p, one.draft))
    const all = runFixAll(gentle.d, ctxFor(gentle, gentle.d), [])
    if (!all.did.length) bad.push(`Fix all couldn't mend any (${all.couldNot.length} tried)`)
    else bad.push(...mendedVerdict('Fix all', gentle.d, p, all.draft))
    // The gentlest fix keeps his bank: every point he banked still has (nearly) the bank he set, the
    // roll just runs over more road either side. (Easing the bank itself, or Auto, is for when that can't work.)
    if (one.draft) {
      const mended = one.draft
      const lost = gentle.d.points.filter((q) => q.bank !== undefined && !mended.points.some((m) => Math.hypot(m.x - q.x, m.z - q.z) < 1 && Math.abs(m.bank ?? 0) >= 0.9 * Math.abs(q.bank ?? 0)))
      if (lost.length) bad.push(`Fix it changed the bank he set on ${lost.length} points (it should spread the roll and keep his bank here)`)
    }
    return bad.length ? bad : `${p.detail?.slice(0, 120)}... / Fix it: ${one.did} (steepest bank by hand now ${steepest(one.draft as Draft)} degrees, was 32) / Fix all: ${all.did.join(' ')}`
  })

  check('Fix it: a road banked by hand under a bridge (LOW BRIDGE) gets the bridge raised: the same road stays on top, with room for a car', () => {
    const c = roadCrossings(eight.d.points, eight.ground)[0]
    if (!c || c.over === null) return ['the eight has no bridge']
    const f = clone(eight)
    const line = roadLine(f.d.points)
    const under = c.passes[c.over === 0 ? 1 : 0]
    const over = c.passes[c.over]
    f.d.points.forEach((q, k) => {
      const a = wrapS(sOfPoint(line, k) - under.s, line.length)
      if (Math.min(a, line.length - a) <= 60) q.bank = 30
    })
    const before = judge(f.d)
    const gapBefore = before.runtime ? builtGapAt(before.runtime, c.at, over.heading) : null
    const p = problemsFor(f.d).find(gate('bridges'))
    if (!p) return [`banking the road under the bridge didn't make it too low (gap ${gapBefore?.gap.toFixed(2)} m): the row proves nothing`]
    const r = runFix(p, f.d, ctxFor(f, f.d))
    if (!r.ok || !r.draft) return [`not fixed: ${r.reason}`]
    const bad = mendedVerdict('the low bridge', f.d, p, r.draft)
    const after = judgeDraft(r.draft, f.d.id)
    const g = after.runtime ? builtGapAt(after.runtime, c.at, over.heading) : null
    // Which road is on top now, by the heights the mended points give (headings are 60-ish degrees apart here,
    // too close for builtGapAt's "same way" test to tell a swap).
    const c2 = roadCrossings(r.draft.points, f.ground).find((x) => Math.hypot(x.at.x - c.at.x, x.at.z - c.at.z) < 30)
    const turn = c2 && c2.over !== null ? Math.abs(((c2.passes[c2.over].heading - over.heading + 540) % 360) - 180) : 180
    if (turn > 20) bad.push(`the other road ended up on top (a swap, ${turn.toFixed(0)} degrees off): the bridge should be raised, or the bank under it eased`)
    if (!g || g.gap < BRIDGE_GAP) bad.push(`only ${g?.gap.toFixed(2)} m between the roads`)
    return bad.length ? bad : `banked 30 degrees under the bridge: ${gapBefore?.gap.toFixed(1)} m between the roads; ${r.did} Now ${g?.gap.toFixed(1)} m, the same road on top`
  })

  check('Setting a bank under a bridge keeps room for a car: the bridge goes up with it, and it says so', () => {
    const c = roadCrossings(eight.d.points, eight.ground)[0]
    if (!c || c.over === null) return ['the eight has no bridge']
    const line = roadLine(eight.d.points)
    const under = c.passes[c.over === 0 ? 1 : 0]
    const over = c.passes[c.over]
    const banked = eight.d.points.map((q, k) => {
      const a = wrapS(sOfPoint(line, k) - under.s, line.length)
      return Math.min(a, line.length - a) <= 60 ? { ...q, bank: 30 } : { ...q }
    })
    const kept = keepBridgesClear(eight.d.points, banked, eight.d.pieces, eight.d.startAt, eight.d.width, eight.ground)
    const bad: string[] = []
    if (!/went up/.test(kept.words)) bad.push(`it didn't say the bridge went up: "${kept.words}"`)
    const d: Draft = { ...eight.d, points: kept.points, startAt: kept.mapAt(eight.d.startAt) }
    const j = judgeDraft(d, eight.d.id)
    const g = j.runtime ? builtGapAt(j.runtime, c.at, over.heading) : null
    if (!g || !g.upperMatches || g.gap < BRIDGE_GAP) bad.push(`the built gap is ${g?.gap.toFixed(2)} m${g && !g.upperMatches ? ' and the wrong road is on top' : ''}`)
    if (j.gates.some((x) => x.name === 'bridges' && x.level === 'fail')) bad.push('the bridges check fails')
    // The bank Josh set is still there, untouched.
    const still = kept.points.filter((q) => q.bank === 30).length
    if (still < banked.filter((q) => q.bank === 30).length) bad.push('some of the bank he set was changed')
    // In the editor: the Bank tool's setSectionBank does the same, as one Undo step.
    if (store) {
      store.replaceDraft(JSON.parse(JSON.stringify(eight.d)) as Draft, null)
      const was = JSON.stringify(store.useEditor.getState().draft)
      const lineNow = roadLine(store.useEditor.getState().draft.points)
      store.setSectionBank(atOf(lineNow, under.s - 60), atOf(lineNow, under.s + 60), 30)
      const s = store.useEditor.getState()
      if (!/went up/.test(s.message?.text ?? '')) bad.push(`the Bank tool didn't say the bridge went up: "${s.message?.text}"`)
      const jj = judgeDraft(s.draft, eight.d.id)
      const gg = jj.runtime ? builtGapAt(jj.runtime, c.at, over.heading) : null
      if (!gg || !gg.upperMatches || gg.gap < BRIDGE_GAP) bad.push(`with the Bank tool the built gap is ${gg?.gap.toFixed(2)} m`)
      if (s.past.length < 1 || JSON.stringify(s.past[s.past.length - 1]) !== was) bad.push('the Bank tool change is not one Undo step')
      store.undo()
      if (JSON.stringify(store.useEditor.getState().draft) !== was) bad.push('Undo did not bring the road back exactly')
    }
    return bad.length ? bad : `"${kept.words}" Built gap ${g?.gap.toFixed(1)} m with the road banked 30 degrees under it${store ? '; the Bank tool does the same, one Undo step' : ''}`
  })

  check("Fix it only promises a fix it has found: each row says \"Fix it can mend this\" only once its fix is built and checked, and one it can't find shows how to do it by hand", () => {
    if (!store) return 'skipped: needs the editor store (run `bun src/editor/selfTest.ts`); in the game it would change your draft'
    const actions = fixActionsForBun
    if (!actions) return ['the fix actions did not load']
    const bad: string[] = []
    const said: string[] = []
    let none = 0
    let found = 0
    for (const [label, f] of [['the loop on a bend', (() => { const b = clone(oval); b.d.pieces = [{ type: 'loop', at: 30 } as Piece]; return b })()], ["Nathan's banked gentle bend", gentle]] as const) {
      store.replaceDraft(JSON.parse(JSON.stringify(f.d)) as Draft, null)
      store.previewNow()
      // Before anything has been looked for: no row promises anything.
      for (const p of actions.currentProblems()) if (actions.canWords(p, actions.fixOffer(p.key)) === 'Fix it can mend this') bad.push(`${label}: "${p.title}" promises a fix before one was looked for`)
      actions.findFixesNow()
      const d = store.useEditor.getState().draft
      for (const p of actions.currentProblems()) {
        if (p.remedy.kind !== 'fix') continue
        const offer = actions.fixOffer(p.key)
        const words = actions.canWords(p, offer)
        if (offer === 'looking') bad.push(`${label}: "${p.title}" is still being looked for after the search finished`)
        if (offer === 'none') {
          none++
          if (words) bad.push(`${label}: "${p.title}" has no fix but says "${words}"`)
          if (!p.remedy.hand) bad.push(`${label}: "${p.title}" has no fix and no words for doing it by hand`)
          said.push(`${label}: "${p.title}" no fix found, shows "${p.remedy.hand.slice(0, 60)}..."${p.remedy.go ? ` and "${p.remedy.go.button}"` : ''}`)
        }
        if (offer === 'found') {
          found++
          if (words !== 'Fix it can mend this') bad.push(`${label}: "${p.title}" has a fix but says "${words}"`)
          // What it found really mends it: press Fix it, then judge the result from scratch.
          const was = JSON.stringify(d)
          if (!actions.fixProblem(p.key)) bad.push(`${label}: "${p.title}" was offered but Fix it refused: ${store.useEditor.getState().message?.text}`)
          else bad.push(...mendedVerdict(`${label}: "${p.title}"`, d, p, store.useEditor.getState().draft))
          store.undo()
          if (JSON.stringify(store.useEditor.getState().draft) !== was) bad.push(`${label}: Undo after Fix it did not bring the road back`)
          store.previewNow()
          actions.findFixesNow()
        }
      }
    }
    if (!none) bad.push('no row had a fix it couldn\'t find, so this proves nothing about them: pick another fixture')
    if (!found) bad.push('no row had a fix, so this proves nothing about the ones that do')
    return bad.length ? bad : `${found} rows offered Fix it, each mended when pressed; ${none} without a fix: ${said.join(' / ')}`
  })

  // ---------------------------------------------------------------- one Undo step each (the real editor store)

  check('Undo: a raise, a Fix it and a Fix all are each one Undo step that brings the road back exactly', () => {
    if (!store) return 'skipped: needs the editor store (run `bun src/editor/selfTest.ts`); in the game it would change your draft'
    const actions = fixActionsForBun
    if (!actions) return ['the fix actions did not load']
    const bad: string[] = []
    const said: string[] = []
    const oneStep = (label: string, d: Draft, act: () => boolean) => {
      store.replaceDraft(JSON.parse(JSON.stringify(d)) as Draft, null)
      const before = store.useEditor.getState().draft
      const was = JSON.stringify(before)
      if (!act()) {
        bad.push(`${label}: refused: ${store.useEditor.getState().message?.text}`)
        return
      }
      const s = store.useEditor.getState()
      if (s.past[s.past.length - 1] !== before) bad.push(`${label}: not one Undo step`)
      if (JSON.stringify(s.draft) === was) bad.push(`${label}: nothing changed`)
      said.push(`${label}: "${s.message?.text}"`)
      store.undo()
      if (JSON.stringify(store.useEditor.getState().draft) !== was) bad.push(`${label}: Undo did not bring the road back exactly`)
    }
    oneStep('raise to 8 m', oval.d, () => actions.raiseSection(42, 76, 8))
    const start = clone(oval)
    start.d.startAt = 30
    oneStep('Fix it on the start grid', start.d, () => {
      store.previewNow()
      const p = actions.currentProblems().find(gate('start.at'))
      return !!p && actions.fixProblem(p.key)
    })
    const bend = clone(oval)
    bend.d.pieces = [{ type: 'loop', at: 30 } as Piece]
    oneStep('Fix all', bend.d, () => {
      store.previewNow()
      return actions.fixAll()
    })
    return bad.length ? bad : said.join(' / ')
  })
}

/** The fix and raise actions (fixActions.ts) for the Undo row: loaded by selfTest.ts under Bun, with the store. */
let fixActionsForBun: typeof import('./fixActions') | undefined
export function setFixActions(actions: typeof import('./fixActions') | undefined): void {
  fixActionsForBun = actions
}
