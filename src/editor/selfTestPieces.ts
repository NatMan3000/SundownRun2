// ============================================================
//  SELF-TEST: PLACING PIECES BY THEIR MIDDLE, AND AUTO BANK'S ANGLE
//  - rows for selfTest.ts
// ------------------------------------------------------------
//  The editor's self-test (selfTest.ts) calls pieceRows() near the
//  end. Every row judges the result with the REAL track builder
//  (judge.ts builds the draft the way the game does), not with the
//  maths that placed the piece:
//
//    click    the Place tool's click puts a wall ride's middle (and a
//             boost pad's and a ramp's) where the game builds it,
//             within a metre of the click
//    drag     a drag along the road places a wall ride whose full
//             length covers exactly the stretch dragged (forwards or
//             backwards); a drag too short or too long gets the
//             nearest allowed length on the drag's middle
//    length   a new Length keeps the middle where the game builds it
//             (wall rides grow from both ends; pads and ramps too)
//    auto     the Bank panel's "Auto (N°)" is the bank the built road
//             has on that stretch, found again by walking the road on
//             the map and asking the built road for its bank there;
//             after a bank is set and Auto pressed, it reads the new
//             build, not an old number
// ============================================================

import afterglowJson from '../../tracks/afterglow.json'
import { trackInternals } from '../track/build'
import { TRACK_DEFAULTS, type TrackFile } from '../track/schema'
import { SURFACE_CODE, type NearestHit, type TrackFrame, type TrackRuntime } from '../track/types'
import * as THREE from 'three'
import { builtBankAngle } from './bankAngle'
import type { Draft } from './draft'
import { draftFromFile } from './draftFile'
import { judgeDraft } from './judge'
import { WALLRIDE_MAX, WALLRIDE_MIN } from './pieces'
import { advanceAt, frameAt, metresBetween, roadCurve, type RoadCurve } from './road'
import { bankStretchAround } from './stretchRuns'

type Check = (name: string, fn: () => string[] | string) => void
type EditorStore = typeof import('./draft')

const m1 = (v: number) => `${Math.round(v * 10) / 10} m`

/** The draft built the way the game builds it (it must build). */
function built(d: Draft): TrackRuntime {
  const j = judgeDraft(d, 'piece-self-test')
  if (!j.runtime) throw new Error(`the track would not build: ${j.error}`)
  return j.runtime
}

/** Where the game built piece `index`'s middle, on the map. */
function builtCentre(rt: TrackRuntime, index: number): { x: number; z: number } | null {
  const p = rt.pieces.find((q) => q.index === index)
  return p ? { x: p.center.x, z: p.center.z } : null
}

const flat = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z)

/**
 * A bendy spot on Afterglow for a wall ride, well away from the start line and
 * every loop: the built road's tightest bend that has 400 m of plain road
 * either side of it. Returns its `at` on the draft.
 */
function bendSpot(rt: TrackRuntime): number {
  const S = rt.samples
  const x = trackInternals(rt)!
  const clear = Math.round(400 / S.ds)
  let best = -1
  let bestK = 0
  for (let i = clear; i < S.count - clear; i++) {
    const k = Math.abs(S.curvature[i])
    if (k <= bestK) continue
    let ok = true
    for (let j = i - clear; j <= i + clear && ok; j += 4) if (S.surface[j] === SURFACE_CODE.loop) ok = false
    if (ok) {
      best = i
      bestK = k
    }
  }
  if (best < 0) throw new Error('Afterglow has no bend clear of the loops')
  return x.atOfS(best * S.ds)
}

export function pieceRows(check: Check, store: EditorStore | undefined): void {
  const afterglow = () => draftFromFile(afterglowJson as unknown as TrackFile, true)

  // ---------------------------------------------------------------- a click puts the middle there

  check("Place: a click puts a wall ride's middle where you clicked (and a boost pad's and a ramp's), where the game builds it, within a metre (the real editor store)", () => {
    if (!store) return 'skipped: needs the editor store (run `bun src/editor/selfTest.ts`); in the game it would change your draft'
    const bad: string[] = []
    const d0 = afterglow()
    store.replaceDraft(d0, null)
    const rc = roadCurve(d0.points)
    const at = bendSpot(built(d0))
    const notes: string[] = []
    // Each kind on its own copy of the track, so they never overlap.
    const q = frameAt(rc, at).p
    for (const kind of ['wallride-right', 'wallride-left', 'wallride-both', 'boost', 'ramp'] as const) {
      store.replaceDraft(afterglow(), null)
      store.setTool('place', kind)
      if (!store.placeAt(q)) {
        bad.push(`${kind}: the click placed nothing`)
        continue
      }
      const d = store.useEditor.getState().draft
      const index = d.pieces.length - 1
      const centre = builtCentre(built(d), index)
      if (!centre) {
        bad.push(`${kind}: the game built no piece ${index}`)
        continue
      }
      const off = flat(centre, q)
      if (off > 1) bad.push(`${kind}: the game built its middle ${m1(off)} from the click`)
      notes.push(`${kind} ${m1(off)}`)
    }
    return bad.length ? bad : `middle from the click, as built: ${notes.join(', ')}`
  })

  // ---------------------------------------------------------------- a drag covers the stretch dragged

  check('Place: a drag along the road places a wall ride covering exactly the stretch dragged (forwards or backwards); a drag under 40 m or over 300 m gets that length on the middle of the drag (the real editor store, judged on the built road)', () => {
    if (!store) return 'skipped: needs the editor store (run `bun src/editor/selfTest.ts`); in the game it would change your draft'
    const bad: string[] = []
    const d0 = afterglow()
    const rc = roadCurve(d0.points)
    const at = bendSpot(built(d0))
    const frame: TrackFrame = { s: 0, position: new THREE.Vector3(), tangent: new THREE.Vector3(), up: new THREE.Vector3(), right: new THREE.Vector3(), halfWidth: 0, bank: 0, curvature: 0, surface: 'road' }
    const notes: string[] = []
    // [drag start, drag end] as metres from the bend, and the stretch the wall ride should cover.
    const cases: { name: string; a: number; b: number; from: number; to: number }[] = [
      { name: 'forwards 150 m', a: -60, b: 90, from: -60, to: 90 },
      { name: 'backwards 180 m', a: 100, b: -80, from: -80, to: 100 },
      { name: '20 m (too short)', a: 0, b: 20, from: 10 - WALLRIDE_MIN / 2, to: 10 + WALLRIDE_MIN / 2 },
      { name: '400 m (too long)', a: -200, b: 200, from: -WALLRIDE_MAX / 2, to: WALLRIDE_MAX / 2 },
    ]
    for (const c of cases) {
      store.replaceDraft(afterglow(), null)
      store.setTool('place', 'wallride-right')
      if (!store.placeWallRideSpan(advanceAt(rc, at, c.a), advanceAt(rc, at, c.b))) {
        bad.push(`${c.name}: the drag placed nothing`)
        continue
      }
      const d = store.useEditor.getState().draft
      const index = d.pieces.length - 1
      const p = d.pieces[index]
      if (p.type !== 'wallride' || p.side !== 'right') {
        bad.push(`${c.name}: it placed a ${p.type}`)
        continue
      }
      const want = Math.round(c.to - c.from)
      const length = p.length ?? TRACK_DEFAULTS.wallride.length
      if (Math.abs(length - want) > 1) bad.push(`${c.name}: it is ${length} m long, not ${want} m`)
      // Where the game builds it: its wall stands from 25 m before `at` to 25 m past the end (road.ts WALL_REACH),
      // so the piece's own length runs from s0 + 25 to s1 - 25 on the built road.
      const rt = built(d)
      const bp = rt.pieces.find((q) => q.index === index)
      if (!bp) {
        bad.push(`${c.name}: the game built no wall ride`)
        continue
      }
      const reach = (bp.s1 - bp.s0 - length + rt.length) % rt.length / 2
      const start = rt.frameAt(bp.s0 + reach, frame).position.clone()
      const end = rt.frameAt(bp.s1 - reach, frame).position.clone()
      const wantStart = frameAt(rc, advanceAt(rc, at, c.from)).p
      const wantEnd = frameAt(rc, advanceAt(rc, at, c.to)).p
      const offA = flat({ x: start.x, z: start.z }, wantStart)
      const offB = flat({ x: end.x, z: end.z }, wantEnd)
      if (offA > 1.5 || offB > 1.5) bad.push(`${c.name}: the built wall ride's ends are ${m1(offA)} and ${m1(offB)} from the ends it should cover`)
      notes.push(`${c.name}: ${length} m, ends ${m1(offA)} / ${m1(offB)} off`)
    }
    return bad.length ? bad : notes.join('; ')
  })

  // ---------------------------------------------------------------- Length keeps the middle

  check("Panel: a new Length keeps a wall ride's middle where the game builds it, both ends moving (and a boost pad's and a ramp's) (the real editor store)", () => {
    if (!store) return 'skipped: needs the editor store (run `bun src/editor/selfTest.ts`); in the game it would change your draft'
    const bad: string[] = []
    const d0 = afterglow()
    const rc = roadCurve(d0.points)
    const at = bendSpot(built(d0))
    const notes: string[] = []
    for (const [kind, lengths] of [['wallride-left', [200, 60, 300]], ['boost', [20, 6]], ['ramp', [24, 8]]] as const) {
      store.replaceDraft(afterglow(), null)
      store.setTool('place', kind)
      store.placeAt(frameAt(rc, at).p)
      const index = store.useEditor.getState().draft.pieces.length - 1
      const before = builtCentre(built(store.useEditor.getState().draft), index)
      if (!before) {
        bad.push(`${kind}: nothing was built`)
        continue
      }
      for (const len of lengths) {
        store.setPieceLength(index, len)
        const d = store.useEditor.getState().draft
        const p = d.pieces[index]
        if ((p.type === 'wallride' || p.type === 'boost' || p.type === 'ramp') && p.length !== len) bad.push(`${kind}: Length ${len} left it ${p.length} m`)
        const after = builtCentre(built(d), index)
        const moved = after ? flat(before, after) : Infinity
        if (moved > 1) bad.push(`${kind}: Length ${len} m moved its built middle ${m1(moved)}`)
        notes.push(`${kind} ${len} m: middle moved ${m1(moved)}`)
      }
    }
    // The wall ride's two ends moved by the same amount (the middle kept): checked on the stored piece too.
    store.replaceDraft(afterglow(), null)
    store.setTool('place', 'wallride-right')
    store.placeAt(frameAt(rc, at).p)
    const i = store.useEditor.getState().draft.pieces.length - 1
    const w0 = store.useEditor.getState().draft.pieces[i]
    store.setPieceLength(i, 220)
    const w1 = store.useEditor.getState().draft.pieces[i]
    const startMoved = metresBetween(rc, w1.at, w0.at)
    if (Math.abs(startMoved - 50) > 1) bad.push(`120 -> 220 m moved the start back ${m1(startMoved)}, not 50 m`)
    return bad.length ? bad : `${notes.join('; ')}; 120 -> 220 m moved the start back ${m1(startMoved)}`
  })

  // ---------------------------------------------------------------- Auto bank says its angle

  check("Bank panel: \"Auto (N°)\" is the bank the built road has on that stretch (found again by walking the road on the map), and after a bank is set and Auto pressed it reads the new build", () => {
    const bad: string[] = []
    const d0 = afterglow()
    const rt0 = built(d0)
    // The most-banked corner on the built road (not a loop), picked the way a Bank tool click picks it.
    const S = rt0.samples
    let top = -1
    for (let i = 0; i < S.count; i++) if (S.surface[i] !== SURFACE_CODE.loop && (top < 0 || Math.abs(S.bank[i]) > Math.abs(S.bank[top]))) top = i
    const corner = trackInternals(rt0)!.atOfS(top * S.ds)
    const { from, to } = bankStretchAround(d0.points, corner)
    const rc = roadCurve(d0.points)
    const label = builtBankAngle(rt0, from, to)
    if (!label) return ['no angle for the stretch']
    const walked = walkedBank(rt0, rc, from, to)
    if (Math.abs(label.most - walked) > 1) bad.push(`the label says ${label.most}°, the built road walked on the map has ${walked}° at most`)
    if (label.most < 3) bad.push(`the most-banked corner is only ${label.most}°, so this proves little`)
    if (label.into !== label.most) bad.push(`auto bank on a corner should lean into it: into ${label.into}°, most ${label.most}°`)
    // Every other banked corner too (each its own Bank tool pick), so a label that read the whole road, or the wrong stretch, shows up.
    const picks: { from: number; to: number }[] = [{ from, to }]
    const inside = (at: number, p: { from: number; to: number }) => (p.from <= p.to ? at >= p.from && at <= p.to : at >= p.from || at <= p.to)
    const others: { label: number; walked: number }[] = []
    const step = Math.round(30 / S.ds)
    for (let i = 0; i < S.count; i += step) {
      if (S.surface[i] === SURFACE_CODE.loop || Math.abs(S.bank[i]) < (3 * Math.PI) / 180) continue
      const at = trackInternals(rt0)!.atOfS(i * S.ds)
      if (picks.some((p) => inside(at, p))) continue
      const pick = bankStretchAround(d0.points, at)
      picks.push(pick)
      const l = builtBankAngle(rt0, pick.from, pick.to)
      const w = walkedBank(rt0, rc, pick.from, pick.to)
      if (!l || Math.abs(l.most - w) > 1) bad.push(`the corner at ${pick.from.toFixed(2)}-${pick.to.toFixed(2)}: the label says ${l?.most}°, the built road walked on the map has ${w}°`)
      others.push({ label: l?.most ?? -1, walked: w })
    }
    if (!others.some((o) => o.walked !== label.most)) bad.push('no other corner with a different bank to tell the stretches apart')
    let more = `; ${others.length} other corners, label/walked: ${others.map((o) => `${o.label}°/${o.walked}°`).join(', ')}`
    if (store) {
      // Set 25 degrees by hand: the built road has it. Then Auto: the label reads the rebuilt road again.
      store.replaceDraft(d0, null)
      store.setTool('bank')
      store.setSectionBank(from, to, 25)
      const set = builtBankAngle(built(store.useEditor.getState().draft), from, to)
      if (!set || Math.abs(set.most - 25) > 1) bad.push(`with 25° set by hand the built road reads ${set?.most}°`)
      store.setSectionBank(from, to, null)
      const back = store.useEditor.getState().draft
      const rt2 = built(back)
      const again = builtBankAngle(rt2, from, to)
      const walked2 = walkedBank(rt2, rc, from, to)
      if (!again || again.most !== label.most || Math.abs(again.most - walked2) > 1) bad.push(`after Auto the label says ${again?.most}° (built road ${walked2}°, before ${label.most}°)`)
      more += `; 25° by hand reads ${set?.most}°, then Auto reads ${again?.most}° again`
    }
    return bad.length ? bad : `Afterglow's most-banked corner (${Math.round(metresBetween(rc, from, to))} m picked): label Auto (${label.into}°), the built road walked on the map ${walked}°${more}`
  })
}

/**
 * The most bank (whole degrees) the built road has under the stretch, found by
 * walking the stretch on the map every 2 m and asking the built road which of
 * its samples is under each spot: a different way from bankAngle.ts (which
 * goes from samples to the map).
 */
function walkedBank(rt: TrackRuntime, rc: RoadCurve, from: number, to: number): number {
  const metres = metresBetween(rc, from, to)
  const hit: NearestHit = { s: 0, index: 0, lateral: 0, height: 0, distance: 0, onRoad: false }
  let hint: number | undefined
  let most = 0
  for (let m = 0; m <= metres; m += 2) {
    const p = frameAt(rc, advanceAt(rc, from, m)).p
    rt.nearest(p.x, rt.terrainHeight(p.x, p.z), p.z, hit, hint)
    hint = hit.s
    if (rt.samples.surface[hit.index] === SURFACE_CODE.loop) continue
    most = Math.max(most, Math.abs((rt.samples.bank[hit.index] * 180) / Math.PI))
  }
  return Math.round(most)
}
