// ============================================================
//  SELF-TEST: HEIGHT, BANK, WIDTH AND THE STRAIGHT PENCIL - rows for selfTest.ts
// ------------------------------------------------------------
//  The editor's self-test (selfTest.ts) calls toolRows() near the
//  end. Each row builds a road, uses a tool the way the panel and
//  the map do, then checks the result separately from the code that
//  made it (the real track builder and the game's own checks):
//
//    height    a click picks a stretch clear of the start grid; the
//              Height slider's top end builds and passes every check,
//              one step past it is refused, and a spot in between
//              builds too (a drawn road and an Afterglow copy)
//    re-edit   a BANK label's stretch (and a WIDTH's) is picked up
//              whole with its value, changed, and put back to Auto;
//              a raised stretch is picked up whole with its height
//              and goes back on the ground (the real editor store)
//    pencil    a line drawn with Shift held stays straight to within
//              a few centimetres on the finished road
// ============================================================

import afterglowJson from '../../tracks/afterglow.json'
import type { RoadPoint, TrackFile } from '../track/schema'
import { cleanStroke, type CleanupOptions } from './cleanup'
import type { Draft } from './draft'
import { DEFAULT_BASE_WORLD, draftFromFile, pointGroundOf } from './draftFile'
import type { GroundFn } from './bridges'
import type { P } from './geom'
import { judgeDraft, newFailures } from './judge'
import { HEIGHT_STEP, RAISE_MAX, groundDraft, heightLimits, planRaise, raiseDraft, stretchNow } from './raise'
import { nearestOnRoad, planRedraw, roadCurve, straightPencilLine } from './road'
import { atOf, posOf, roadLine, sOf, wrapS } from './shape'
import { bankRuns, heightStretchAround, heightsAboveGround, raisedRuns, runAt, stretchMarks, widthRuns } from './stretchRuns'

type Check = (name: string, fn: () => string[] | string) => void
type EditorStore = typeof import('./draft')
type StretchToolsModule = typeof import('./stretchTools')

const TAU = Math.PI * 2

/** The stretch tools' store actions, handed in by selfTest.ts under Bun (they need the real editor store). */
let tools: StretchToolsModule | undefined
export function setStretchTools(m: StretchToolsModule): void {
  tools = m
}

/** A road the way the editor holds it: a draft in the default world (seed pinned), and the ground under its points. */
function asDraft(id: string, points: RoadPoint[]): { d: Draft; ground: GroundFn } {
  const environment = { ...JSON.parse(JSON.stringify(DEFAULT_BASE_WORLD.environment)), seed: 1 }
  const d: Draft = { id, name: id, author: '', description: '', points, width: 14, baseWorld: DEFAULT_BASE_WORLD.id, environment, pieces: [], props: [], cores: [], startAt: 0 }
  const ground = pointGroundOf(environment, id)
  if (!ground) throw new Error(`the ${id} world didn't validate`)
  return { d, ground }
}

/** "8 m", "2.5 m". */
const m = (v: number) => `${Math.round(v * 10) / 10} m`

export function toolRows(check: Check, store: EditorStore | undefined, h: { opts: Partial<CleanupOptions> }): void {
  /** A pencil-drawn stadium oval: two 420 m straights and 130 m-radius ends, the start on the south straight. */
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
    const res = cleanStroke(Array.from({ length: 701 }, (_, i) => at((i / 700) * 1.03)), h.opts)
    if (!res.ok) throw new Error('the oval did not clean up')
    const f = asDraft('selftest-tools-oval', res.points)
    // The start line on the south straight, a little after its west end.
    f.d.startAt = nearestOnRoad(roadCurve(f.d.points), { x: -150, z: -130 }).at
    return f
  })()
  const afterglow = (() => {
    const d = draftFromFile(afterglowJson as unknown as TrackFile, true)
    d.id = 'afterglow-copy-tools'
    const ground = pointGroundOf(d.environment, d.id)
    if (!ground) throw new Error("the Afterglow copy's world didn't validate")
    return { d, ground }
  })()

  // ---------------------------------------------------------------- the Height slider only offers what works

  check('Height tool: a click picks a stretch clear of the start grid, and the slider only offers heights that build (its top builds and passes every check, one step past it is refused), on a drawn road and an Afterglow copy', () => {
    const bad: string[] = []
    const notes: string[] = []
    let provedTop = 0
    let provedPast = 0
    for (const [name, f] of [['drawn oval', oval], ['Afterglow copy', afterglow]] as const) {
      const d = f.d
      const before = judgeDraft(d, d.id)
      if (!before.runtime) return [`${name} did not build: ${before.error}`]
      const o = { id: d.id, pointGround: f.ground, before: { runtime: before.runtime, gates: before.gates } }
      const line = roadLine(d.points)
      // A click 60 m after the start line: the stretch it picks must stop short of the grid (and anything else in the way).
      const at = atOf(line, sOf(line, d.startAt) + 60)
      const sel = heightStretchAround(d, at, before.runtime, f.ground)
      const selMetres = wrapS(sOf(line, sel.to) - sOf(line, sel.from), line.length)
      const plan = planRaise({ points: d.points, pieces: d.pieces, startAt: d.startAt, width: d.width, pointGround: f.ground }, sel.from, sel.to, stretchNow(d.points, sel.from, sel.to, f.ground).middle + 2)
      if (!plan.ok && plan.why === 'pieces') bad.push(`${name}: the stretch a click picked runs into the start grid or a piece: "${plan.reason}"`)
      // That stretch, and a shorter one in its middle (so its top is below the highest any road goes).
      const sMid = sOf(line, sel.from) + selMetres / 2
      const stretches: [string, number, number][] = [
        [`the click's ${Math.round(selMetres)} m`, sel.from, sel.to],
        ['180 m', atOf(line, sMid - 90), atOf(line, sMid + 90)],
      ]
      for (const [label, from, to] of stretches) {
        const lim = heightLimits(d, from, to, o)
        const where = `${name}, ${label}`
        if (lim.why === 'stop' || lim.why === 'short') {
          bad.push(`${where}: no height works (${lim.why}: ${lim.reason ?? ''})`)
          continue
        }
        // Every position on the slider is on its half-metre steps.
        for (const v of [lim.lo, lim.hi]) if (Math.abs(v / HEIGHT_STEP - Math.round(v / HEIGHT_STEP)) > 1e-6) bad.push(`${where}: an end ${v} is not on the slider's steps`)
        const tryExact = (height: number) => raiseDraft(d, from, to, height, { ...o, exact: true })
        if (lim.hi > lim.value) {
          // The top end builds, and the built road passes every check that passed before (judged again here).
          const r = tryExact(lim.hi)
          if (!r.ok || !r.draft) bad.push(`${where}: the top end ${m(lim.hi)} was refused: ${r.reason}`)
          else {
            const after = judgeDraft(r.draft, d.id, {}, before.runtime)
            const fresh = after.runtime ? newFailures(before.gates, after.gates).map((g) => g.name) : ['did not build']
            if (fresh.length) bad.push(`${where}: at the top end ${m(lim.hi)} the road now fails ${fresh.join(', ')}`)
            else provedTop++
          }
        }
        // Every position on the slider builds (every half metre from its bottom to its top; every
        // metre on a long slider). Where it is now needs no build.
        const span = Math.round((lim.hi - lim.lo) / HEIGHT_STEP)
        const every = span > 14 ? 2 : 1
        let tried = 0
        for (let k = 0; k <= span; k += every) {
          const v = lim.lo + k * HEIGHT_STEP
          if (Math.abs(v - lim.value) < 1e-6 || v === lim.hi) continue
          tried++
          const r = tryExact(v)
          if (!r.ok) bad.push(`${where}: ${m(v)}, on the slider (${m(lim.lo)} to ${m(lim.hi)}), was refused: ${r.reason}`)
        }
        if (lim.jump) notes.push(`${where}: can't go up a little (${lim.jump.reason.replace(/\.$/, '')}), so the slider starts at ${m(lim.lo)}`)
        if (lim.hi < RAISE_MAX) {
          // One step past the top is refused (by the take-off rule, or built and failed).
          const past = tryExact(lim.hi + HEIGHT_STEP)
          if (past.ok) bad.push(`${where}: one step past the top (${m(lim.hi + HEIGHT_STEP)}) built, so the slider stops too low`)
          else provedPast++
        }
        notes.push(`${where}: ${m(lim.lo)} to ${m(lim.hi)} (${lim.why}, ${lim.builds} builds to find; ${tried} more positions built)`)
      }
    }
    if (!provedTop) bad.push('no stretch could go up at all, so the top end was never proved')
    if (!provedPast) bad.push('every stretch could go all the way to the top, so "one step past is refused" was never proved')
    return bad.length ? bad : `${notes.join('; ')}; tops built and passed ${provedTop}, one step past refused ${provedPast}`
  })

  // ---------------------------------------------------------------- picking a change up again

  check('Re-edit: a BANK stretch (and a WIDTH one) is picked up whole with its value, changes, and goes back to Auto; a raised stretch is picked up whole with its height and goes back on the ground (the real editor store)', () => {
    if (!store || !tools) return 'skipped: needs the editor store (run `bun src/editor/selfTest.ts`); in the game it would change your draft'
    const bad: string[] = []
    const d0: Draft = JSON.parse(JSON.stringify(oval.d))
    store.replaceDraft(d0, null)
    const line = roadLine(d0.points)
    const n = d0.points.length
    // Set a bank of 12 degrees by hand over 150 m of the north straight, and a width of 18 m over 120 m of the east end.
    const sNorth = sOf(line, nearestOnRoad(roadCurve(d0.points), { x: 0, z: 130 }).at)
    store.setTool('bank')
    store.setSectionBank(atOf(line, sNorth - 75), atOf(line, sNorth + 75), 12)
    const sEast = sOf(line, nearestOnRoad(roadCurve(d0.points), { x: 340, z: 0 }).at)
    store.setTool('width')
    store.setSectionWidth(atOf(line, sEast - 60), atOf(line, sEast + 60), 18)
    const set = store.useEditor.getState().draft
    const banked = set.points.flatMap((p, i) => (p.bank !== undefined ? [i] : []))
    const widened = set.points.flatMap((p, i) => (p.width !== undefined ? [i] : []))
    // A click on the amber line (anywhere in it) picks the whole stretch up in the Bank tool, its value showing.
    store.setTool('select')
    tools.pickStretchAt('bank', atOf(line, sNorth + 40))
    let s = store.useEditor.getState()
    const sel = s.selection
    if (s.tool !== 'bank') bad.push(`picking the bank up chose the ${s.tool} tool`)
    if (sel?.kind !== 'section') return [...bad, 'nothing was selected']
    const picked = store.sectionPoints(n, sel.from, sel.to)
    if (JSON.stringify(picked) !== JSON.stringify(banked)) bad.push(`it picked up points ${picked.join(',')}, not the banked ${banked.join(',')}`)
    const run = bankRuns(set.points)[0]
    if (!run || run.value !== 12) bad.push(`the BANK label would say ${run?.value}, not 12`)
    // Change it: every banked point, and only those.
    store.setSectionBank(sel.from, sel.to, 20)
    s = store.useEditor.getState()
    const now20 = s.draft.points.flatMap((p, i) => (p.bank === 20 ? [i] : []))
    if (JSON.stringify(now20) !== JSON.stringify(banked)) bad.push(`changing it to 20 degrees set points ${now20.join(',')}`)
    // Back to Auto: no bank set by hand anywhere, and the label goes.
    store.setSectionBank(sel.from, sel.to, null)
    s = store.useEditor.getState()
    if (s.draft.points.some((p) => p.bank !== undefined)) bad.push('Auto left a bank set by hand')
    if (bankRuns(s.draft.points).length) bad.push('the BANK label is still there after Auto')
    // The WIDTH label's stretch, the same way.
    tools.pickStretchAt('width', atOf(line, sEast))
    s = store.useEditor.getState()
    const wsel = s.selection
    if (s.tool !== 'width' || wsel?.kind !== 'section') bad.push('picking the width up did not select it in the Width tool')
    else {
      const wp = store.sectionPoints(n, wsel.from, wsel.to)
      if (JSON.stringify(wp) !== JSON.stringify(widened)) bad.push(`the width pick-up got points ${wp.join(',')}, not ${widened.join(',')}`)
      if (widthRuns(s.draft.points)[0]?.value !== 18) bad.push('the WIDTH label would not say 18 m')
      store.setSectionWidth(wsel.from, wsel.to, null)
      if (store.useEditor.getState().draft.points.some((p) => p.width !== undefined)) bad.push('Track width left a width set by hand')
    }

    // A raised stretch: raise 400 m of the north straight to 6 m, then pick it up with a click in its middle.
    const cur = store.useEditor.getState().draft
    const lineC = roadLine(cur.points)
    const sN = sOf(lineC, nearestOnRoad(roadCurve(cur.points), { x: 0, z: 130 }).at)
    const r = raiseDraft(cur, atOf(lineC, sN - 200), atOf(lineC, sN + 200), 6, { id: cur.id, pointGround: oval.ground })
    if (!r.ok || !r.draft || r.from === undefined || r.to === undefined) return [...bad, `the raise to 6 m was refused: ${r.reason}`]
    store.replaceDraft(r.draft, null)
    const raised = r.draft
    const runs = raisedRuns(raised.points, oval.ground)
    const lineR = roadLine(raised.points)
    const midAt = atOf(lineR, sOf(lineR, r.from) + wrapS(sOf(lineR, r.to) - sOf(lineR, r.from), lineR.length) / 2)
    const hr = runAt(stretchMarks(raised.points, oval.ground), 'height', midAt, raised.points.length)
    if (runs.length !== 1 || !hr) return [...bad, `found ${runs.length} raised stretches, ${hr ? 'one' : 'none'} at the middle`]
    if (Math.abs(hr.value - 6) > 0.6) bad.push(`the RAISED label would say ${m(hr.value)}, not about 6 m`)
    // The whole raise is in it: every point the raise lifted 20 cm or more, and nothing more than one point past each foot.
    const hts = heightsAboveGround(raised.points, oval.ground)
    const inRun = new Set(store.sectionPoints(raised.points.length, hr.from, hr.to))
    hts.forEach((v, i) => {
      if (v >= 0.2 && !inRun.has(i)) bad.push(`point ${i} is ${m(v)} up but outside the picked-up stretch`)
    })
    const ext = wrapS(sOf(lineR, hr.to) - sOf(lineR, hr.from), lineR.length)
    const was = wrapS(sOf(lineR, r.to) - sOf(lineR, r.from), lineR.length)
    if (ext > was + 30 || ext < was - 30) bad.push(`the picked-up stretch is ${Math.round(ext)} m long, the raise was ${Math.round(was)} m`)
    tools.pickStretchAt('height', midAt)
    s = store.useEditor.getState()
    if (s.tool !== 'height' || s.selection?.kind !== 'section') bad.push('a click on the violet dots did not pick the raised stretch up in the Height tool')
    // Its slider shows where it is (about 6 m); On the ground puts the whole stretch back down on the ground.
    const lim = heightLimits(raised, hr.from, hr.to, { id: raised.id, pointGround: oval.ground })
    if (Math.abs(lim.value - 6) > 0.5) bad.push(`the Height slider would show ${m(lim.value)}, not about 6 m`)
    const down = groundDraft(raised, hr.from, hr.to, { id: raised.id, pointGround: oval.ground })
    if (!down.ok || !down.draft) bad.push(`On the ground was refused: ${down.reason}`)
    else {
      // Every point back on the ground (to the centimetre), and the road it makes passes every check that passed before.
      const top = Math.max(...heightsAboveGround(down.draft.points, oval.ground))
      if (top > 0.05) bad.push(`after On the ground the road is still ${m(top)} up somewhere`)
      const beforeJ = judgeDraft(raised, raised.id)
      const afterJ = judgeDraft(down.draft, raised.id, {}, beforeJ.runtime)
      const fresh = afterJ.runtime ? newFailures(beforeJ.gates, afterJ.gates).map((g) => g.name) : ['did not build']
      if (fresh.length) bad.push(`after On the ground the road fails ${fresh.join(', ')}`)
    }
    return bad.length
      ? bad
      : `bank: ${banked.length} points picked up whole at 12°, set to 20°, back to Auto; width: ${widened.length} points at 18 m, back to the track's; raised: one ${Math.round(ext)} m stretch (raise ${Math.round(was)} m) at ${m(hr.value)}, slider ${m(lim.lo)} to ${m(lim.hi)}, back on the ground`
  })

  // ---------------------------------------------------------------- the pencil with Shift

  check('Pencil + Shift: a line drawn with Shift held stays straight on the finished road (to within a few cm), and freehand carries on after it', () => {
    const d = oval.d
    // Start on the south straight, go off to the south in a wobbly freehand curve, hold Shift for a
    // long straight run east (the mouse wobbling as it goes: only where it ends counts), let go, and
    // wobble back up onto the road further east.
    const start = { x: -120, z: -130 }
    const stroke: P[] = [start]
    for (let i = 1; i <= 30; i++) stroke.push({ x: -120 + i * 1.2 + Math.sin(i) * 0.6, z: -130 - i * 3 + Math.cos(i * 1.7) * 0.8 })
    const anchor = stroke[stroke.length - 1]
    const shiftFrom = stroke.length
    // While Shift is held, each mouse move redraws the straight bit from the anchor to the pointer.
    let pointer = anchor
    for (let i = 1; i <= 60; i++) {
      pointer = { x: anchor.x + i * 4, z: anchor.z + Math.sin(i * 0.9) * 6 }
      stroke.length = shiftFrom
      stroke.push(...straightPencilLine(anchor, pointer, 3))
    }
    const end = pointer
    for (let i = 1; i <= 30; i++) stroke.push({ x: end.x + i * 1.2 + Math.sin(i * 1.3) * 0.6, z: end.z + i * 3 + Math.cos(i) * 0.8 })
    // The straight bit, as drawn, is exactly straight.
    const dev = (p: P) => Math.abs((end.x - anchor.x) * (p.z - anchor.z) - (end.z - anchor.z) * (p.x - anchor.x)) / Math.hypot(end.x - anchor.x, end.z - anchor.z)
    const drawn = Math.max(...stroke.slice(shiftFrom, stroke.length - 30).map(dev))
    const bad: string[] = []
    if (drawn > 0.01) bad.push(`the line as drawn strays ${drawn.toFixed(3)} m from straight`)
    // The finished road: the pencil's redraw (planRedraw, then the clean-up as applyStroke runs it).
    const plan = planRedraw(stroke, d.points, d.width)
    if (plan.kind !== 'redraw') return [...bad, `the line didn't redraw the road (${plan.kind === 'nothing' ? plan.why : ''})`]
    const res = cleanStroke(plan.loop, { ...h.opts, width: d.width, fairing: 0, smoothing: 10 })
    if (!res.ok) return [...bad, `the clean-up refused it: ${res.issues.find((i) => i.level === 'error')?.message}`]
    // Along the middle of the straight bit (40 m in from each end, where it joins the freehand curves), the road is straight.
    const line = roadLine(res.points)
    const len = Math.hypot(end.x - anchor.x, end.z - anchor.z)
    const ux = (end.x - anchor.x) / len
    const uz = (end.z - anchor.z) / len
    let worst = 0
    let n = 0
    for (let s = 0; s < line.length; s += 1) {
      const p = posOf(line, s)
      const along = (p.x - anchor.x) * ux + (p.z - anchor.z) * uz
      if (along < 40 || along > len - 40 || dev(p) > 5) continue
      worst = Math.max(worst, dev(p))
      n++
    }
    if (n < 100) bad.push(`only ${n} m of the new road follow the straight bit`)
    if (worst > 0.05) bad.push(`the straight bit of the road strays ${(worst * 100).toFixed(1)} cm from straight`)
    return bad.length ? bad : `${Math.round(len)} m drawn with Shift held (the mouse wobbling 6 m either side): straight to ${(drawn * 1000).toFixed(1)} mm as drawn and ${(worst * 100).toFixed(1)} cm on the finished road over its middle ${n} m`
  })
}
