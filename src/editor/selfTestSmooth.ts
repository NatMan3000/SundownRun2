// ============================================================
//  SELF-TEST: SMOOTH THE BUMPS, AND WALL RIDES ON THE MAP - rows for selfTest.ts
// ------------------------------------------------------------
//  The editor's self-test (selfTest.ts) calls smoothRows() near the
//  end. Each row checks the result with something other than the
//  code that made it: the real track builder, the game's own checks,
//  and the built road's own samples.
//
//    smooth    on a pencil road in Big Dunes, the bumpiest stretch
//              gets smoother on the BUILT road (its worst bump and
//              its 95th percentile both drop), passes every check
//              that passed before, keeps each point's kind of height,
//              and leaves the road outside the stretch where it was;
//              a stretch on flat ground is left alone
//    undo      one press is one Undo step, and Undo puts every point
//              back exactly (the real editor store)
//    wall map  the map draws a wall ride's wall where the game builds
//              it: from 25 m before `at` to 25 m past the end, full
//              height only where the game's wall is full height
// ============================================================

import { WALL_FULL_INSET, WALL_RAMP, WALL_REACH } from '../track/road'
import type { TrackRuntime } from '../track/types'
import { cleanStroke, type CleanupOptions } from './cleanup'
import type { Draft } from './draft'
import { BASE_WORLDS, pointGroundOf, roadBound } from './draftFile'
import type { GroundFn } from './bridges'
import type { P } from './geom'
import { judgeDraft, newFailures } from './judge'
import { wallRideReach } from './mapDraw'
import { frameAt, roadCurve } from './road'
import { atOf, roadHeightAt, roadLine, sOf, wrapS } from './shape'
import { SMOOTH_G, builtBumpiness, smoothDraft } from './smooth'

type Check = (name: string, fn: () => string[] | string) => void
type EditorStore = typeof import('./draft')
type StretchToolsModule = typeof import('./stretchTools')

const TAU = Math.PI * 2

/** The stretch tools' store actions, handed in by selfTest.ts under Bun (they need the real editor store). */
let tools: StretchToolsModule | undefined
export function setSmoothTools(m: StretchToolsModule): void {
  tools = m
}

/** A seeded random number generator (the same numbers every run). */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A road drawn with the pencil in a base world (its seed pinned): a shaky hand round a kidney shape, cleaned up as the pencil does. */
function pencilRoad(worldId: string, id: string): { d: Draft; ground: GroundFn } {
  const world = BASE_WORLDS.find((w) => w.id === worldId)
  if (!world) throw new Error(`no base world ${worldId}`)
  const environment = { ...JSON.parse(JSON.stringify(world.environment)), seed: 7 }
  const r = rng(11)
  let wx = 0
  let wz = 0
  const stroke: P[] = []
  for (let i = 0; i <= 700; i++) {
    const t = (i / 700) * 1.03
    wx = wx * 0.7 + (r() - 0.5) * 3
    wz = wz * 0.7 + (r() - 0.5) * 3
    stroke.push({ x: 420 * Math.sin(t * TAU) + wx, z: -260 * Math.cos(t * TAU) + 90 * Math.cos(2 * t * TAU) + wz })
  }
  const opts: Partial<CleanupOptions> = { width: 14, bound: roadBound(environment), smoothing: 10, fairing: 10 }
  const res = cleanStroke(stroke, opts)
  if (!res.ok) throw new Error(`the ${worldId} pencil road did not clean up`)
  const d: Draft = { id, name: id, author: '', description: '', points: res.points, width: 14, baseWorld: worldId, environment, pieces: [], props: [], cores: [], startAt: 0 }
  const ground = pointGroundOf(environment, id)
  if (!ground) throw new Error(`the ${worldId} world didn't validate`)
  return { d, ground }
}

/** The bumpiest `metres` of road on a built road, staying 120 m clear of the start line both ways. */
function bumpiestStretch(d: Draft, t: TrackRuntime, metres: number): { from: number; to: number; worst: number } {
  const line = roadLine(d.points)
  const s0 = sOf(line, d.startAt)
  let best = { from: 0, to: 0, worst: -1 }
  for (let s = 120; s + metres <= line.length - 120; s += 40) {
    const from = atOf(line, s0 + s)
    const to = atOf(line, s0 + s + metres)
    const b = builtBumpiness(t, from, to, d.points.length, 180)
    if (b.worst > best.worst) best = { from, to, worst: b.worst }
  }
  return best
}

const g2 = (v: number) => `${v.toFixed(2)} g`

export function smoothRows(check: Check, store: EditorStore | undefined): void {
  const dunes = pencilRoad('big-dunes', 'selftest-smooth-dunes')

  check('Smooth the bumps here: the bumpiest stretch of a pencil road in Big Dunes comes out smoother on the built road (worst bump and 95th percentile both lower), passes every check that passed before, keeps each point its kind of height and leaves the road outside it alone; a stretch on flat ground is already smooth and left alone', () => {
    const bad: string[] = []
    const d = dunes.d
    const before = judgeDraft(d, d.id)
    if (!before.runtime) return [`the Big Dunes road did not build: ${before.error}`]
    const pick = bumpiestStretch(d, before.runtime, 400)
    if (pick.worst < 0.3) return [`the bumpiest 400 m only pushes ${g2(pick.worst)} at 180 km/h: not bumpy enough to prove anything`]
    const was = builtBumpiness(before.runtime, pick.from, pick.to, d.points.length, 180)
    const res = smoothDraft(d, pick.from, pick.to, { id: d.id, pointGround: dunes.ground, before: { runtime: before.runtime, gates: before.gates } })
    if (!res.ok || !res.draft || res.from === undefined || res.to === undefined) return [`Smooth the bumps here was refused: ${res.reason}`]
    if (!/^Smoothed \d+ m: the biggest bump was [\d.]+ m\./.test(res.done ?? '')) bad.push(`it said "${res.done}"`)
    const next = res.draft
    // Judged again here: nothing that passed fails now.
    const after = judgeDraft(next, d.id, {}, before.runtime)
    if (!after.runtime) return [...bad, `the smoothed road did not build: ${after.error}`]
    const fresh = newFailures(before.gates, after.gates).map((g) => g.name)
    if (fresh.length) bad.push(`the smoothed road now fails ${fresh.join(', ')}`)
    // Smoother on the built road, measured on its own samples.
    const now = builtBumpiness(after.runtime, res.from, res.to, next.points.length, 180)
    if (now.worst >= was.worst - 0.05) bad.push(`its worst bump went ${g2(was.worst)} -> ${g2(now.worst)} at 180 km/h: no smoother`)
    if (now.p95 >= was.p95 - 0.03) bad.push(`its 95th percentile went ${g2(was.p95)} -> ${g2(now.p95)} at 180 km/h: no smoother`)
    // Nowhere does a car go light at 250 km/h that didn't before (a crest under 80% of gravity, or no worse than it was).
    const crest250 = builtBumpiness(after.runtime, res.from, res.to, next.points.length, 250).crest
    const crestWas = builtBumpiness(before.runtime, pick.from, pick.to, d.points.length, 250).crest
    if (crest250 > Math.max(0.8, crestWas)) bad.push(`a crest on it now asks ${g2(crest250)} at 250 km/h (it was ${g2(crestWas)})`)
    // Each point keeps its kind of height: no road point gains a `y`.
    if (next.points.some((p) => typeof p.y === 'number')) bad.push('a point on the drawn road got a `y` (it should get a `lift`)')
    // Outside the stretch (a point-gap in from its ends), the road is where it was to the centimetre.
    const line0 = roadLine(d.points)
    const span = wrapS(sOf(line0, pick.to) - sOf(line0, pick.from), line0.length)
    let moved = 0
    let movedAt = 0
    for (let m = span + 20; m < line0.length - 20; m += 5) {
      const at = atOf(line0, sOf(line0, pick.from) + m)
      // The same spot on the new road: the nearest one by position (the stretch may have gained points).
      const p = frameAt(roadCurve(d.points), at).p
      const rcN = roadCurve(next.points)
      let bestAt = 0
      let bestD = Infinity
      const lineN = roadLine(next.points)
      const guess = sOf(lineN, res.from) + m
      for (let k = -30; k <= 30; k++) {
        const a = atOf(lineN, guess + k)
        const q = frameAt(rcN, a).p
        const dd = Math.hypot(q.x - p.x, q.z - p.z)
        if (dd < bestD) {
          bestD = dd
          bestAt = a
        }
      }
      const dh = Math.abs(roadHeightAt(next.points, bestAt, dunes.ground) - roadHeightAt(d.points, at, dunes.ground))
      if (dh > moved) {
        moved = dh
        movedAt = m
      }
    }
    if (moved > 0.02) bad.push(`outside the stretch the road moved ${(moved * 100).toFixed(1)} cm (${Math.round(movedAt - span)} m past its end)`)

    // Pressing it again on the stretch it smoothed: already smooth (it got every bump under SMOOTH_G), nothing changes.
    const again = smoothDraft(next, res.from, res.to, { id: d.id, pointGround: dunes.ground, before: { runtime: after.runtime, gates: after.gates } })
    if (!res.limited && (again.ok || !again.already)) bad.push(`a second press smoothed it again: ${again.done ?? again.reason}`)

    // A stretch on flat ground: already smooth, nothing changes.
    const flat = pencilRoad('grid-flats', 'selftest-smooth-flat')
    const fb = judgeDraft(flat.d, flat.d.id)
    if (!fb.runtime) return [...bad, `the Grid Flats road did not build: ${fb.error}`]
    const lineF = roadLine(flat.d.points)
    const fFrom = atOf(lineF, sOf(lineF, flat.d.startAt) + 300)
    const fTo = atOf(lineF, sOf(lineF, flat.d.startAt) + 700)
    const fr = smoothDraft(flat.d, fFrom, fTo, { id: flat.d.id, pointGround: flat.ground, before: { runtime: fb.runtime, gates: fb.gates } })
    if (fr.ok || fr.draft || !fr.already) bad.push(`on flat ground it did not say "already smooth": ${fr.done ?? fr.reason}`)
    else if (!/already smooth/.test(fr.reason ?? '')) bad.push(`on flat ground it said "${fr.reason}"`)
    return bad.length
      ? bad
      : `Big Dunes, the bumpiest 400 m: "${res.done}" Built road at 180 km/h: worst ${g2(was.worst)} -> ${g2(now.worst)}, 95th percentile ${g2(was.p95)} -> ${g2(now.p95)} (target ${g2(SMOOTH_G)} at ${res.kmh} km/h, editor's measure ${g2(res.before?.worst ?? 0)} -> ${g2(res.after?.worst ?? 0)}); outside it moved ${(moved * 100).toFixed(1)} cm at most; flat ground: "${fr.reason}"`
  })

  check('Smooth the bumps here: one press is one Undo step, and Undo puts every point back exactly (the real editor store)', () => {
    if (!store || !tools) return 'skipped: needs the editor store (run `bun src/editor/selfTest.ts`); in the game it would change your draft'
    const bad: string[] = []
    const d0: Draft = JSON.parse(JSON.stringify(dunes.d))
    store.replaceDraft(d0, null)
    const original = JSON.stringify({ points: d0.points, pieces: d0.pieces, startAt: d0.startAt })
    const j = judgeDraft(d0, d0.id)
    if (!j.runtime) return ['the Big Dunes road did not build']
    const pick = bumpiestStretch(d0, j.runtime, 400)
    store.setTool('height')
    store.useEditor.setState({ selection: { kind: 'section', from: pick.from, to: pick.to } })
    const pastBefore = store.useEditor.getState().past.length
    const said = tools.smoothStretch(pick.from, pick.to)
    const s = store.useEditor.getState()
    if (!said?.changed) return [`it changed nothing: ${said?.text}`]
    if (s.past.length !== pastBefore + 1) bad.push(`one press made ${s.past.length - pastBefore} Undo steps`)
    if (JSON.stringify(s.draft.points) === JSON.stringify(d0.points)) bad.push('the draft did not change')
    if (s.selection?.kind !== 'section') bad.push('the stretch is no longer selected')
    if (s.message?.text !== said.text) bad.push(`the status line says "${s.message?.text}", the panel "${said.text}"`)
    store.undo()
    const back = store.useEditor.getState().draft
    if (JSON.stringify({ points: back.points, pieces: back.pieces, startAt: back.startAt }) !== original) bad.push('after Undo the road is not exactly what it was')
    return bad.length ? bad : `"${said.text}" One Undo step; Undo puts all ${d0.points.length} points back exactly`
  })

  check("Map: a wall ride's wall is drawn where the game builds it (25 m before `at` to 25 m past the end), at full height only where the game's wall is, growing in and fading out", () => {
    const bad: string[] = []
    // A wall ride on the outside of the kidney's long right-hand bend, on flat ground.
    const flat = pencilRoad('grid-flats', 'selftest-smooth-wall')
    const d = flat.d
    const line = roadLine(d.points)
    const at = atOf(line, sOf(line, d.startAt) + 900)
    const length = 120
    for (const side of ['left', 'right'] as const) {
      const withWall: Draft = { ...d, pieces: [{ type: 'wallride', at, side, length }] }
      const j = judgeDraft(withWall, d.id)
      if (!j.runtime) return [`the road with a wall ride did not build: ${j.error}`]
      const built = j.runtime.pieces.find((p) => p.type === 'wallride')
      if (!built) return ['the built track has no wall ride']
      const S = j.runtime.samples
      const spotAtS = (s: number) => {
        const i = ((Math.round(s / S.ds) % S.count) + S.count) % S.count
        return { x: S.px[i], z: S.pz[i] }
      }
      const rc = roadCurve(withWall.points)
      const reach = wallRideReach(rc, at, length)
      const ends: [string, P, P][] = [
        ['start', frameAt(rc, reach.from).p, spotAtS(built.s0)],
        ['end', frameAt(rc, reach.to).p, spotAtS(built.s1)],
      ]
      for (const [which, map, game] of ends) {
        const off = Math.hypot(map.x - game.x, map.z - game.z)
        if (off > 2) bad.push(`${side}: the map's wall ${which} is ${off.toFixed(1)} m from where the game's wall ${which}s`)
      }
      // Full height exactly where the game's wall is (from WALL_FULL_INSET after `at` to as far before the end), none at its ends.
      const h = reach.height
      const want: [number, number][] = [
        [-WALL_REACH, 0],
        [-WALL_REACH + WALL_RAMP / 2, 0.5],
        [WALL_FULL_INSET, 1],
        [length / 2, 1],
        [length - WALL_FULL_INSET, 1],
        [length + WALL_REACH, 0],
      ]
      for (const [m, v] of want) if (Math.abs(h(m) - v) > 0.02) bad.push(`${side}: ${m} m after \`at\` the map draws the wall ${Math.round(h(m) * 100)}% tall, the game builds it ${Math.round(v * 100)}%`)
      if (h(WALL_FULL_INSET - 2) > 0.995) bad.push(`${side}: the map draws the wall full height before the game's wall is`)
    }
    return bad.length ? bad : `left and right: the map's wall starts and ends within 2 m of the game's (${WALL_REACH} m beyond the piece each way) and is full height from ${WALL_FULL_INSET} m after \`at\` to ${WALL_FULL_INSET} m before its end`
  })
}
