// ============================================================
//  SELF-TEST: TUNNELS AT CROSSINGS AND ON A STRETCH - rows for selfTest.ts
// ------------------------------------------------------------
//  The editor's self-test (selfTest.ts) calls tunnelCrossingRows()
//  near the end. Each row changes a road the way the crossing panel
//  ("Put this road in a tunnel") or the stretch panel ("Make it a
//  tunnel", "Take the roof off") does, then judges the result on the
//  BUILT road (the real track builder and the game's own checks),
//  never with the maths that made it:
//
//    either way   on a figure-eight either road goes under in a
//                 tunnel: the game builds the tunnel, the other road
//                 is on top with room for a car and stays on the
//                 ground (not a bridge), and every check passes;
//                 Swap moves the tunnel to the other road (still one
//                 Tunnel piece), and "Make it a bridge" takes it out
//    undo         putting a road in a tunnel is one Undo step, and
//                 Redo puts it back (the real editor store)
//    remembered   a pencil redraw of another stretch keeps it a
//                 tunnel: the clean-up is handed it and puts no
//                 bridge back
//    refuse       a loop in the way of the tunnel's ramps: refused in
//                 plain words (the builder's reason) and nothing
//                 changes, in the store too
//    stretch      "Make it a tunnel" covers a picked stretch (built,
//                 every check passing, the stretch still picked) and
//                 "Take the roof off" takes it away, one Undo step
//                 each; a stretch whose ramps reach a loop is refused
//    height pick  with the Height tool, the pointer over a tunnel says
//                 TUNNEL 150 m and a click picks its covered stretch
//                 (Bank still picks a bank stretch there); a click off
//                 the tunnel picks an ordinary stretch
//    height len   the Height panel's tunnel Length changes it from its
//                 middle and keeps its new stretch picked; one too long
//                 is refused and nothing changes
// ============================================================

import afterglowJson from '../../tracks/afterglow.json'
import type { RoadPoint, TrackFile } from '../track/schema'
import { SURFACE_CODE, type TrackRuntime } from '../track/types'
import { cleanStroke, type CleanupOptions } from './cleanup'
import type { Draft } from './draft'
import { DEFAULT_BASE_WORLD, draftFromFile, pointGroundOf } from './draftFile'
import { type GroundFn, BRIDGE_GAP, buildAndCheck, builtGapAt, crossingNear, crossingsWithTunnels, keepOverOf, matchHeading, roadCrossings, tryOneWay, tunnelDraft } from './bridges'
import { checkVerdict } from './checks'
import type { P } from './geom'
import { advanceAt, metresBetween, roadCurve, sectionRedraw } from './road'
import { fitTunnelAt, fitWords, quickTunnelCheck, tunnelBlocker, tunnelWhy } from './tunnelPlace'
import { tunnelStartFor } from './pieces'
import { judgeDraft } from './judge'
import { trackInternals } from '../track/build'
import { atOf, posOf, roadLine, sOfPoint } from './shape'

type Check = (name: string, fn: () => string[] | string) => void

/**
 * The Height tool's actions (stretchTools.ts), handed in by selfTest.ts under Bun once the track
 * list can load there (as selfTestTools.ts does); the Height rows skip without them.
 */
let tools: typeof import('./stretchTools') | null = null
export function setTunnelStretchTools(m: typeof import('./stretchTools')): void {
  tools = m
}
type EditorStore = typeof import('./draft')

const TAU = Math.PI * 2
/** Where on Afterglow (its `at`) a stretch goes clear for a tunnel: the long climb (selfTestTunnel.ts CLEAR_AT). */
const CLEAR_AT = 4.5
/** Afterglow's loop sits at 25.0; a stretch here has a tunnel's ramps reaching its run-in. */
const LOOP_AT = 24.4

export function tunnelCrossingRows(check: Check, store: EditorStore | undefined, h: { shaky: (shape: (t: number) => P, count: number, wobble: number, seed: number, t0?: number, t1?: number) => P[]; opts: Partial<CleanupOptions> }): void {
  const skip = 'skipped: needs the editor store (run `bun src/editor/selfTest.ts`); in the game it would change your draft'
  /** The bridges rows' figure-eight (selfTest.ts eight()): the default world, seed pinned, cleaned as the pencil does (a bridge at its crossing). */
  const eight = (): { d: Draft; ground: GroundFn } => {
    const stroke = h.shaky((t) => ({ x: 260 * Math.sin(t * TAU), z: 130 * Math.sin(2 * t * TAU) }), 600, 3, 2, 0.1, 1.1)
    const environment = { ...JSON.parse(JSON.stringify(DEFAULT_BASE_WORLD.environment)), seed: 1 }
    const id = 'selftest-tunnel-crossing'
    const ground = pointGroundOf(environment, id)
    if (!ground) throw new Error("the eight's world didn't validate")
    const res = cleanStroke(stroke, { ...h.opts, pointGround: ground })
    const d: Draft = { id, name: 'Self-test tunnel crossing', author: '', description: '', points: res.points, width: 14, baseWorld: DEFAULT_BASE_WORLD.id, environment, pieces: [], props: [], cores: [], startAt: 0 }
    return { d, ground }
  }
  const o = (d: Draft, ground: GroundFn) => ({ id: d.id, pointGround: ground })
  const sameWay = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180) < 30
  const tunnels = (d: Draft) => d.pieces.filter((p) => p.type === 'tunnel').length

  /**
   * The crossing at `at` is a tunnel with the road heading `under` in it: on the draft (one Tunnel
   * piece, covering that road) and on the built road (the tunnel built, the other road on top with
   * room for a car and on the ground, not a bridge; every check passing, the tunnel's own row
   * saying a road runs over its roof). Returns problems and the built gap.
   */
  const tunnelVerdict = (label: string, d: Draft, ground: GroundFn, at: P, under: number): { bad: string[]; gap: number } => {
    const bad: string[] = []
    const c = crossingNear(crossingsWithTunnels(d.points, d.pieces, ground), at)?.crossing
    if (!c || c.over === null) return { bad: [`${label}: no road on top at the crossing`], gap: 0 }
    if (c.kind !== 'tunnel') bad.push(`${label}: the crossing is ${c.kind ?? 'level'}, not a tunnel`)
    const lo = c.passes[c.over === 0 ? 1 : 0]
    const hi = c.passes[c.over]
    if (!sameWay(lo.heading, under)) bad.push(`${label}: the wrong road is in the tunnel`)
    if (tunnels(d) !== 1) bad.push(`${label}: ${tunnels(d)} Tunnel pieces (wanted 1)`)
    const b = buildAndCheck(d, d.id)
    const rt: TrackRuntime | null = b.runtime
    if (!rt) return { bad: [...bad, `${label}: did not build: ${b.error}`], gap: 0 }
    if (rt.tunnels.length !== 1) bad.push(`${label}: the game built ${rt.tunnels.length} tunnels`)
    const g = builtGapAt(rt, at, hi.heading)
    if (!g) bad.push(`${label}: the built road has no two levels at the crossing`)
    else {
      if (!g.upperMatches) bad.push(`${label}: the wrong road is on top on the built road`)
      if (g.gap < BRIDGE_GAP) bad.push(`${label}: built gap ${g.gap.toFixed(2)} m (needs ${BRIDGE_GAP})`)
    }
    // The road on top is on the ground (over the roof), not a bridge: grounded where it crosses.
    const S = rt.samples
    let top = -1
    for (let i = 0; i < S.count; i++) {
      if (S.surface[i] !== SURFACE_CODE.road || Math.hypot(S.px[i] - at.x, S.pz[i] - at.z) > 4) continue
      if (top < 0 || S.py[i] > S.py[top]) top = i
    }
    if (top < 0 || S.grounded[top] !== 1) bad.push(`${label}: the road over the tunnel is a bridge there, not on the ground`)
    if (checkVerdict({ fresh: true, errors: [], gates: b.gates, cleanupErrors: 0 }) !== 'pass') {
      bad.push(`${label}: the checks fail: ${b.gates.filter((x) => x.level === 'fail').map((x) => `${x.name}: ${x.message}`).join(' / ')}`)
    }
    const row = b.gates.find((x) => x.name === 'tunnel')
    if (!row || !/the road over it/.test(row.message)) bad.push(`${label}: the tunnel row doesn't measure the road over it ("${row?.message ?? 'no row'}")`)
    return { bad, gap: g?.gap ?? 0 }
  }

  check('Tunnels at crossings: on a figure-eight either road goes under in a tunnel (built by the game, the other road on top on the ground with room for a car, every check passing); Swap moves the tunnel to the other road; "Make it a bridge" takes it out', () => {
    const { d, ground } = eight()
    const c = roadCrossings(d.points, ground)[0]
    if (!c || c.over === null) return ['the eight has no bridge']
    const at = c.at
    const bad: string[] = []
    const said: string[] = []
    const gaps: string[] = []
    for (const k of [0, 1] as const) {
      const heading = c.passes[k].heading
      const r = tunnelDraft(d, at, k, o(d, ground))
      if (!r.ok || !r.draft) {
        bad.push(`road ${k} in a tunnel: refused: ${r.reason}`)
        continue
      }
      const v = tunnelVerdict(`road ${k} in a tunnel`, r.draft, ground, at, heading)
      bad.push(...v.bad)
      gaps.push(v.gap.toFixed(1))
      said.push(r.done ?? '')
      // Swap: the other road into the tunnel (the panel's Swap on a tunnel crossing).
      const cs = crossingNear(crossingsWithTunnels(r.draft.points, r.draft.pieces, ground), at)?.crossing
      const other = cs ? matchHeading(c.passes[1 - k].heading, cs.passes[0].heading, cs.passes[1].heading) : null
      if (other === null) {
        bad.push(`road ${k}: can't find the other road at the crossing to swap`)
        continue
      }
      const sw = tunnelDraft(r.draft, at, other, o(r.draft, ground))
      if (!sw.ok || !sw.draft) bad.push(`swap from road ${k}: refused: ${sw.reason}`)
      else bad.push(...tunnelVerdict(`swapped from road ${k}`, sw.draft, ground, at, c.passes[1 - k].heading).bad)
      // "Make it a bridge instead": the road on top goes up, and the tunnel goes.
      if (k === 0) {
        const over = cs ? matchHeading(c.passes[1 - k].heading, cs.passes[0].heading, cs.passes[1].heading) : null
        const br = over === null ? null : tryOneWay(r.draft, at, over, o(r.draft, ground))
        if (!br?.ok || !br.draft) bad.push(`"Make it a bridge" refused: ${br?.reason}`)
        else {
          const bc = crossingNear(crossingsWithTunnels(br.draft.points, br.draft.pieces, ground), at)?.crossing
          if (tunnels(br.draft)) bad.push('"Make it a bridge" left the Tunnel piece')
          if (bc?.kind !== 'bridge') bad.push(`"Make it a bridge" made a ${bc?.kind ?? 'level crossing'}`)
        }
      }
    }
    return bad.length ? bad : `both ways and swapped back: gaps ${gaps.join(', ')} m; "${said[0]}"`
  })

  check('Tunnels at crossings: putting a road in a tunnel is one Undo step and Redo puts it back (the real editor store); a pencil redraw of another stretch keeps it a tunnel (no bridge comes back)', () => {
    if (!store) return skip
    const { d, ground } = eight()
    const c = roadCrossings(d.points, ground)[0]
    if (!c || c.over === null) return ['the eight has no bridge']
    store.replaceDraft(d, null)
    const before = store.useEditor.getState().draft
    const lower = c.over === 0 ? 1 : 0
    if (!store.tunnelUnder(c.at, lower)) return [`tunnelUnder refused: ${store.useEditor.getState().message?.text}`]
    const after = store.useEditor.getState()
    const bad: string[] = []
    const kind = () => {
      const dd = store.useEditor.getState().draft
      return crossingNear(crossingsWithTunnels(dd.points, dd.pieces, ground), c.at)?.crossing.kind
    }
    if (kind() !== 'tunnel') bad.push(`after "Put in a tunnel" the crossing is ${kind()}`)
    if (after.past[after.past.length - 1] !== before) bad.push('it is not one Undo step back to the draft before it')
    store.undo()
    if (JSON.stringify(store.useEditor.getState().draft) !== JSON.stringify(before)) bad.push('Undo did not bring back the draft exactly')
    store.redo()
    if (kind() !== 'tunnel') bad.push('Redo did not put it in a tunnel again')
    // A redraw of the far lobe's tip, as the underpass row does: handed the tunnel, the clean-up keeps both roads on the ground.
    const dt = store.useEditor.getState().draft
    const pts = dt.points
    const line = roadLine(pts)
    const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.z - b.z)
    const far = pts.reduce((best, p, i) => (dist(p, c.at) > dist(pts[best], c.at) ? i : best), 0)
    const sFar = sOfPoint(line, far)
    const stroke: P[] = []
    for (let i = 0; i <= 60; i++) {
      const p = posOf(line, sFar - 150 + (300 * i) / 60)
      const out = Math.sin((i / 60) * Math.PI) * 25
      stroke.push({ x: p.x + Math.sign(p.x) * out, z: p.z })
    }
    const loop = sectionRedraw(stroke, pts, 14)
    if (!loop) return [...bad, 'the far-lobe stroke was not taken as a stretch redraw']
    const kept = cleanStroke(loop, { ...h.opts, fairing: 0, pointGround: ground, keepOver: keepOverOf(pts, ground, dt.pieces) })
    const forgot = cleanStroke(loop, { ...h.opts, fairing: 0, pointGround: ground, keepOver: keepOverOf(pts, ground) })
    if (!kept.ok || !forgot.ok) return [...bad, 'the redraw failed to clean up']
    const kc = crossingNear(roadCrossings(kept.points, ground), c.at)?.crossing
    if (!kc) bad.push('after the redraw the crossing is gone')
    else if (kc.over !== null && Math.abs(kc.passes[0].height - kc.passes[1].height) > 1) bad.push(`after the redraw one road is ${kc.gap.toFixed(1)} m over the other: the clean-up put a ${kc.kind} back`)
    const fc = crossingNear(roadCrossings(forgot.points, ground), c.at)?.crossing
    if (!fc || fc.kind === null) bad.push('without the tunnel remembered, the redraw leaves both roads on the ground anyway, so this proves nothing')
    return bad.length ? bad : `one Undo step, Redo; a redraw keeps both roads on the ground for the tunnel (forgetting it brings back a ${fc?.kind}); "${after.message?.text}"`
  })

  check("Tunnels at crossings: a loop in the way of the tunnel's ramps is refused in plain words, and nothing changes (the store too)", () => {
    const { d: d8, ground } = eight()
    // Both roads on the ground (no bridge to bring down), and a loop 150 m along one road from the crossing.
    const points: RoadPoint[] = d8.points.map((p) => {
      const q = { ...p }
      delete q.lift
      delete q.y
      return q
    })
    const line = roadLine(points)
    const c = roadCrossings(points, ground)[0]
    if (!c) return ['the eight has no crossing']
    const d: Draft = { ...d8, points, pieces: [{ type: 'loop', at: Math.round(atOf(line, c.passes[0].s + 150) * 1000) / 1000 }] }
    const json = JSON.stringify(d)
    const r = tunnelDraft(d, c.at, 0, o(d, ground))
    const bad: string[] = []
    if (r.ok) bad.push('it was put in a tunnel anyway')
    if (JSON.stringify(d) !== json) bad.push('refusing changed the draft')
    const text = r.reason ?? ''
    if (!text.startsWith("Can't put this road in a tunnel") || !/loop/.test(text)) bad.push(`it said "${text}" (wanted the reason: the loop)`)
    if (store) {
      store.replaceDraft(d, null)
      const before = store.useEditor.getState().draft
      if (store.tunnelUnder(c.at, 0)) bad.push('the store put it in a tunnel anyway')
      if (store.useEditor.getState().draft !== before) bad.push("the store's draft changed")
      if (!/loop/.test(store.useEditor.getState().message?.text ?? '')) bad.push(`the store said "${store.useEditor.getState().message?.text}"`)
    }
    return bad.length ? bad : `"${text}"`
  })

  check('Tunnel on a stretch: "Make it a tunnel" covers the picked stretch (built, every check passing, the stretch still picked) and "Take the roof off" takes it away, one Undo step each; a stretch reaching a loop is refused (the real editor store)', () => {
    if (!store) return skip
    const d0 = draftFromFile(afterglowJson as unknown as TrackFile, true)
    store.replaceDraft(d0, null)
    const rc = roadCurve(d0.points)
    const from = advanceAt(rc, CLEAR_AT, -60)
    const to = advanceAt(rc, CLEAR_AT, 60)
    store.setTool('height')
    store.useEditor.setState({ selection: { kind: 'section', from, to } })
    const bad: string[] = []
    if (!store.tunnelOnStretch(from, to)) return [`refused: ${store.useEditor.getState().message?.text}`]
    const st = store.useEditor.getState()
    const p = st.draft.pieces[st.draft.pieces.length - 1]
    if (p?.type !== 'tunnel' || p.length !== 120) bad.push(`made ${p?.type} ${p?.type === 'tunnel' ? p.length : ''}, wanted a 120 m tunnel`)
    if (st.selection?.kind !== 'section') bad.push('the stretch is no longer picked (its panel has "Take the roof off")')
    if (st.past[st.past.length - 1] !== d0) bad.push('"Make it a tunnel" was not one Undo step')
    if (store.tunnelsOnStretch(st.draft, from, to).length !== 1) bad.push('the stretch panel would not see the tunnel on it')
    const b = buildAndCheck(st.draft, store.draftId(st.draft))
    if (!b.runtime || b.runtime.tunnels.length !== 1) bad.push('the game did not build the tunnel')
    if (checkVerdict({ fresh: true, errors: [], gates: b.gates, cleanupErrors: 0 }) !== 'pass') bad.push(`the checks fail: ${b.gates.filter((x) => x.level === 'fail').map((x) => x.name).join(', ')}`)
    const made = st.draft
    if (!store.roofOffStretch(from, to)) bad.push(`"Take the roof off" refused: ${store.useEditor.getState().message?.text}`)
    const st2 = store.useEditor.getState()
    if (tunnels(st2.draft)) bad.push('"Take the roof off" left a Tunnel piece')
    if (st2.past[st2.past.length - 1] !== made) bad.push('"Take the roof off" was not one Undo step')
    // Near the loop: refused, nothing changes.
    const lf = advanceAt(rc, LOOP_AT, -40)
    const lt = advanceAt(rc, LOOP_AT, 40)
    store.replaceDraft(d0, null)
    store.useEditor.setState({ selection: { kind: 'section', from: lf, to: lt } })
    const before = store.useEditor.getState().draft
    if (store.tunnelOnStretch(lf, lt)) bad.push('a stretch whose ramps reach the loop was made a tunnel')
    if (store.useEditor.getState().draft !== before) bad.push('refusing it changed the draft')
    const text = store.useEditor.getState().message?.text ?? ''
    if (!/loop/.test(text)) bad.push(`refusing it said "${text}"`)
    return bad.length ? bad : `120 m tunnel made and taken off, one Undo step each; by the loop: "${text}"`
  })

  /** Afterglow with a 150 m tunnel whose middle is at CLEAR_AT, and the tunnel's covered stretch. */
  const afterglowWithTunnel = (): { d: Draft; from: number; to: number } => {
    const d = draftFromFile(afterglowJson as unknown as TrackFile, true)
    const rc = roadCurve(d.points)
    const from = advanceAt(rc, CLEAR_AT, -75)
    d.pieces.push({ type: 'tunnel', at: Math.round(from * 1000) / 1000 })
    return { d, from: Math.round(from * 1000) / 1000, to: advanceAt(rc, Math.round(from * 1000) / 1000, 150) }
  }

  check('Tunnel in the Height tool: hovering a tunnel says TUNNEL 150 m and a click picks its covered stretch (the real editor store); Bank picks a bank stretch there; off the tunnel Height picks an ordinary stretch', () => {
    if (!store || !tools) return skip
    const { stretchToPick, stretchHoverLabel, pickStretchAt } = tools
    const { d, from, to } = afterglowWithTunnel()
    store.replaceDraft(d, null)
    const rc = roadCurve(d.points)
    const bad: string[] = []
    const inside = advanceAt(rc, from, 40)
    const pick = stretchToPick('height', d, inside)
    if (!pick.tunnel || Math.abs(metresBetween(rc, pick.from, from)) > 0.5 || Math.abs(metresBetween(rc, to, pick.to)) > 0.5) bad.push(`the Height pick inside the tunnel is ${JSON.stringify({ from: pick.from, to: pick.to, tunnel: !!pick.tunnel })}, not the tunnel's stretch ${from.toFixed(2)}..${to.toFixed(2)}`)
    const label = stretchHoverLabel(d, pick)
    if (label !== 'TUNNEL 150 m') bad.push(`the hover label is "${label}"`)
    store.setTool('height')
    store.useEditor.setState({ selection: null })
    pickStretchAt('height', inside)
    const sel = store.useEditor.getState().selection
    if (sel?.kind !== 'section' || Math.abs(sel.from - from) > 1e-3 || Math.abs(sel.to - to) > 1e-3) bad.push(`a Height click picked ${JSON.stringify(sel)}`)
    if (store.useEditor.getState().tool !== 'height') bad.push('the click left the Height tool')
    const said = store.useEditor.getState().message?.text ?? ''
    if (!/tunnel/i.test(said)) bad.push(`it said "${said}"`)
    if (store.tunnelsOnStretch(store.useEditor.getState().draft, sel?.kind === 'section' ? sel.from : 0, sel?.kind === 'section' ? sel.to : 0).length !== 1) bad.push('the panel would not see the tunnel on the picked stretch')
    if (stretchToPick('bank', d, inside).tunnel) bad.push('the Bank tool picks the tunnel too')
    const outside = advanceAt(rc, to, 300)
    if (stretchToPick('height', d, outside).tunnel) bad.push('a Height click 300 m past the tunnel picks the tunnel')
    return bad.length ? bad : `picked ${Math.round(metresBetween(rc, from, to))} m (the tunnel's roof); "${said}"`
  })

  check('Tunnel fit: a click where it cannot go (by the start grid, by the loop) finds the nearest spot or length that fits, and the game builds it there with every check that passed still passing; the words say how far it moved', () => {
    const d = { ...draftFromFile(afterglowJson as unknown as TrackFile, true), id: 'selftest-fit' }
    const bad: string[] = []
    const said: string[] = []
    // By the start line on Afterglow (at 2.0): the ramps of a 150 m tunnel reach the grid from anywhere near.
    const f = fitTunnelAt(d, 2.0, 150, d.id, {})
    if (!f.ok) return [`by the start line nothing fits: ${f.message}`]
    if (Math.abs(f.moved) < 1 && f.length === 150) bad.push('it did not move or shorten, yet a click there is refused')
    const words = fitWords(f)
    if (!/Moved it \d+ m|Made it \d+ m long/.test(words)) bad.push(`its words don't say what it did: "${words}"`)
    said.push(words)
    const next: Draft = { ...d, pieces: [...d.pieces, f.piece] }
    const j = judgeDraft(next, d.id)
    if (!j.runtime || j.runtime.tunnels.length !== 1) bad.push('the game did not build it')
    const failedBefore = new Set(judgeDraft(d, d.id).gates.filter((g) => g.level === 'fail').map((g) => g.name))
    const fresh = j.gates.filter((g) => g.level === 'fail' && !failedBefore.has(g.name))
    if (fresh.length) bad.push(`checks fail with it: ${fresh.map((g) => g.name).join(', ')}`)
    // The quick check refuses the very spot clicked (that is why it moved), naming the start line.
    const rc = roadCurve(d.points)
    const q = quickTunnelCheck(d, tunnelStartFor(rc, 2.0, 150), 150, d.id)
    if (q.ok) bad.push('the quick check says a tunnel fits right on the start line')
    else if (!/start line/.test(tunnelWhy(q, 150).why)) bad.push(`it gave the wrong reason: "${tunnelWhy(q, 150).why}"`)
    return bad.length ? bad : `moved ${Math.round(f.moved)} m, ${f.length} m long: "${words}"`
  })

  check("Tunnel refusals read in Josh's words and say where the thing in the way is: by a loop, a wall ride and the start line on Afterglow, never a piece number, with what it needs and an amber spot on the road", () => {
    const d = { ...draftFromFile(afterglowJson as unknown as TrackFile, true), id: 'selftest-why' }
    const rc = roadCurve(d.points)
    const bad: string[] = []
    const said: string[] = []
    for (const [at, word] of [
      [LOOP_AT, 'the loop is in the way'],
      [18, 'the wall ride is in the way'],
      [2.0, 'the start line is in the way'],
    ] as const) {
      const q = quickTunnelCheck(d, tunnelStartFor(rc, at, 150), 150, d.id)
      if (q.ok) {
        bad.push(`at ${at} the quick check says it fits`)
        continue
      }
      const w = tunnelWhy(q, 150)
      const all = `${w.why}. ${w.tryThis} (${w.hint})`
      if (!all.includes(word)) bad.push(`at ${at}: "${all}" (wanted "${word}")`)
      if (/pieces\[|\bindex\b/.test(all)) bad.push(`at ${at} it names a piece number: "${all}"`)
      if (!/needs \d+ m of plain road/.test(w.tryThis)) bad.push(`at ${at} it doesn't say how much road it needs: "${w.tryThis}"`)
      const where = tunnelBlocker(q)
      if (!where) bad.push(`at ${at} it doesn't say where the thing in the way is`)
      said.push(w.why)
    }
    return bad.length ? bad : said.map((t) => `"${t}"`).join(' / ')
  })

  check("Tunnel footprint: the quick check (what the hover shows before a click) agrees with the real build: the same yes or no, and the same ramps as the built tunnel's dug stretch, on Afterglow and a figure-eight", () => {
    const bad: string[] = []
    const rows: string[] = []
    const afterglowD = { ...draftFromFile(afterglowJson as unknown as TrackFile, true), id: 'selftest-quick' }
    const { d: e8 } = eight()
    for (const [label, d, spots] of [
      ['Afterglow', afterglowD, [4.5, 9, 13, 24.4, 2.0]],
      ['eight', e8, [6, 30, 55, 80]],
    ] as const) {
      const rc = roadCurve(d.points)
      for (const mid of spots) {
        const at = tunnelStartFor(rc, mid % d.points.length, 150)
        const q = quickTunnelCheck(d, at, 150, d.id)
        const j = judgeDraft({ ...d, pieces: [...d.pieces, { type: 'tunnel', at, length: 150 }] }, d.id)
        const plan = j.runtime ? trackInternals(j.runtime)?.tunnels.plans.find((p) => p.index === d.pieces.length) : null
        if (!plan) {
          bad.push(`${label} ${mid}: the real build has no plan`)
          continue
        }
        if (q.ok !== !plan.problem) bad.push(`${label} ${mid}: quick says ${q.ok ? 'fits' : 'no'}, the build says ${plan.problem ? 'no' : 'fits'}`)
        if (q.ok && j.runtime) {
          const tn = j.runtime.tunnels[0]
          const rampIn = tn.s0 - tn.a0
          const rampOut = tn.a1 - tn.s1
          if (Math.abs(rampIn - q.rampIn) > 4 || Math.abs(rampOut - q.rampOut) > 4) bad.push(`${label} ${mid}: the footprint's ramps ${Math.round(q.rampIn)} / ${Math.round(q.rampOut)} m, built ${Math.round(rampIn)} / ${Math.round(rampOut)} m`)
          rows.push(`${label} ${mid}: ramps ${Math.round(q.rampIn)}/${Math.round(q.rampOut)} m`)
        } else rows.push(`${label} ${mid}: no (${tunnelWhy(q, 150).why})`)
      }
    }
    return bad.length ? bad : rows.join('; ')
  })

  check("Tunnel in the Height tool: its Length changes it from its middle and keeps the new stretch picked; one too long is refused and nothing changes (the real editor store)", () => {
    if (!store) return skip
    const { d, from, to } = afterglowWithTunnel()
    store.replaceDraft(d, null)
    store.setTool('height')
    store.useEditor.setState({ selection: { kind: 'section', from, to } })
    const index = d.pieces.length - 1
    const rc = roadCurve(d.points)
    const mid0 = advanceAt(rc, from, 75)
    const bad: string[] = []
    store.setTunnelLengthOnStretch(index, 120)
    const st = store.useEditor.getState()
    const p = st.draft.pieces[index]
    if (p?.type !== 'tunnel' || p.length !== 120) bad.push(`Length 120 didn't take: ${st.message?.text}`)
    const sel = st.selection
    if (sel?.kind !== 'section') bad.push(`the selection is ${sel?.kind}, not the tunnel's stretch`)
    else {
      const rc1 = roadCurve(st.draft.points)
      if (Math.abs(metresBetween(rc1, sel.from, sel.to) - 120) > 1) bad.push(`the picked stretch is ${metresBetween(rc1, sel.from, sel.to).toFixed(1)} m, not 120`)
      const mid1 = advanceAt(rc1, sel.from, 60)
      const off = Math.min(metresBetween(rc1, mid0, mid1), metresBetween(rc1, mid1, mid0))
      if (off > 1) bad.push(`its middle moved ${off.toFixed(1)} m`)
    }
    // 600 m reaches the start grid with its ramps: refused, and the draft and the selection stay.
    const d1 = st.draft
    const sel1 = st.selection
    store.setTunnelLengthOnStretch(index, 600)
    const st2 = store.useEditor.getState()
    if (st2.draft !== d1) bad.push('a refused length still changed the draft')
    if (JSON.stringify(st2.selection) !== JSON.stringify(sel1)) bad.push('a refused length lost the picked stretch')
    if (!/Can't put a tunnel here/.test(st2.message?.text ?? '')) bad.push(`Length 600 said "${st2.message?.text}"`)
    return bad.length ? bad : `120 m kept its middle and its stretch; 600 m: "${st2.message?.text}"`
  })
}
