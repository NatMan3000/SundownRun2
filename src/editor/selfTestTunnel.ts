// ============================================================
//  SELF-TEST: TUNNELS - rows for selfTest.ts
// ------------------------------------------------------------
//  The editor's self-test (selfTest.ts) calls tunnelRows() near the
//  end. Every row works through the real editor store (the Place
//  tool's click and drag, the Length slider, Undo) on a copy of
//  Afterglow, and judges the result on the BUILT road (the real track
//  builder), never with the maths that placed it:
//
//    place    a click on clear road makes a tunnel with its middle
//             where you clicked, that the game builds, and every
//             check still passes; it is one Undo step
//    refuse   a tunnel whose ramps would reach a loop, or the start
//             grid, is refused in plain words and nothing changes
//    length   a new Length keeps the middle where it was; one too
//             long for its stretch is refused and nothing changes
//    drag     a drag along the road makes a tunnel covering the
//             stretch dragged
//    tube     the built tunnel is a tunnel: the ceiling stands 5 m or
//             more over every lane (measured on the drawn ceiling),
//             the ground under the roof between its walls sits under
//             the road (and is left out of physics), and the ground
//             beside the roof meets its edge
// ============================================================

import afterglowJson from '../../tracks/afterglow.json'
import * as THREE from 'three'
import type { TrackFile } from '../track/schema'
import type { NearestHit, TrackFrame, TrackRuntime } from '../track/types'
import { groundHoleAt } from '../track/terrainTiles'
import type { Draft } from './draft'
import { draftFromFile } from './draftFile'
import { judgeDraft } from './judge'
import { advanceAt, frameAt, metresBetween, roadCurve } from './road'

type Check = (name: string, fn: () => string[] | string) => void
type EditorStore = typeof import('./draft')

/** Where on Afterglow (its `at`) a tunnel's middle goes: the clear road up its long climb. */
const CLEAR_AT = 4.5
/** Too close to the loop at 25.0 (its run-in is inside a tunnel's ramps from here). */
const LOOP_AT = 24.4
/** The start line. */
const START_AT = 2.0

/** The draft built the way the game builds it (null if it wouldn't). */
function built(store: EditorStore, d: Draft): TrackRuntime | null {
  return judgeDraft(d, store.draftId(d)).runtime
}

/** The built tunnel of piece `index`: where its covered stretch's middle is on the map. */
function tunnelMiddle(rt: TrackRuntime, index: number): { x: number; z: number } | null {
  const tn = rt.tunnels.find((x) => x.index === index)
  if (!tn) return null
  const f = newFrame()
  rt.frameAt(tn.s0 + (tn.s1 - tn.s0) / 2, f)
  return { x: f.position.x, z: f.position.z }
}

const flat = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z)

/** A frame to fill (TrackRuntime.frameAt). */
function newFrame(): TrackFrame {
  return { s: 0, position: new THREE.Vector3(), tangent: new THREE.Vector3(), up: new THREE.Vector3(), right: new THREE.Vector3(), halfWidth: 0, bank: 0, curvature: 0, surface: 'road' }
}

/** Every check that fails on a built track, by name. */
function failing(store: EditorStore, d: Draft): string[] {
  const j = judgeDraft(d, store.draftId(d))
  return j.gates.filter((g) => g.level === 'fail').map((g) => `${g.name}: ${g.message}`)
}

export function tunnelRows(check: Check, store: EditorStore | undefined): void {
  const afterglow = () => draftFromFile(afterglowJson as unknown as TrackFile, true)
  const skip = 'skipped: needs the editor store (run `bun src/editor/selfTest.ts`); in the game it would change your draft'

  check('Tunnel: a click on clear road puts a tunnel there, its middle where you clicked, built by the game with every check passing; one Undo step (the real editor store)', () => {
    if (!store) return skip
    const bad: string[] = []
    const d0 = afterglow()
    store.replaceDraft(d0, null)
    const rc = roadCurve(d0.points)
    const q = frameAt(rc, CLEAR_AT).p
    store.setTool('place', 'tunnel')
    if (!store.placeAt(q)) return [`refused: ${store.useEditor.getState().message?.text}`]
    const st = store.useEditor.getState()
    const index = st.draft.pieces.length - 1
    const p = st.draft.pieces[index]
    if (p?.type !== 'tunnel') return ['no tunnel was added']
    const rt = built(store, st.draft)
    if (!rt) return ['the track would not build']
    const mid = tunnelMiddle(rt, index)
    if (!mid) bad.push('the game did not build the tunnel')
    else if (flat(mid, q) > 3) bad.push(`the built tunnel's middle is ${flat(mid, q).toFixed(1)} m from the click`)
    bad.push(...failing(store, st.draft))
    if (st.past[st.past.length - 1] !== d0) bad.push('placing it was not one Undo step')
    store.undo()
    if (store.useEditor.getState().draft.pieces.some((x) => x.type === 'tunnel')) bad.push('Undo left the tunnel')
    return bad.length ? bad : `middle ${mid ? flat(mid, q).toFixed(1) : '?'} m from the click; "${st.message?.text}"`
  })

  check("Tunnel: by the loop (no room within 500 m) a click is refused in Josh's words and nothing changes; by the start grid it moves to the nearest spot that fits and says so, one Undo step (the real editor store)", () => {
    if (!store) return skip
    const bad: string[] = []
    const said: string[] = []
    {
      const d0 = afterglow()
      store.replaceDraft(d0, null)
      store.setTool('place', 'tunnel')
      const ok = store.placeAt(frameAt(roadCurve(d0.points), LOOP_AT).p)
      const st = store.useEditor.getState()
      if (ok) bad.push('a tunnel by the loop was placed')
      if (st.draft !== d0) bad.push('refusing by the loop still changed the draft')
      const text = st.message?.text ?? ''
      if (!text.includes("Can't put a tunnel here") || !text.includes('the loop is in the way')) bad.push(`by the loop it said "${text}" (wanted the reason: the loop is in the way)`)
      if (/pieces\[/.test(text)) bad.push(`it named a piece number: "${text}"`)
      said.push(text)
    }
    {
      const d0 = afterglow()
      store.replaceDraft(d0, null)
      store.setTool('place', 'tunnel')
      const ok = store.placeAt(frameAt(roadCurve(d0.points), START_AT).p)
      const st = store.useEditor.getState()
      const text = st.message?.text ?? ''
      if (!ok) bad.push(`by the start grid nothing fits: "${text}"`)
      else {
        if (!/Moved it \d+ m/.test(text)) bad.push(`by the start grid it didn't say it moved: "${text}"`)
        if (st.past[st.past.length - 1] !== d0) bad.push('it was not one Undo step')
        const rt = built(store, st.draft)
        if (!rt || rt.tunnels.length !== 1) bad.push('the game did not build the moved tunnel')
        bad.push(...failing(store, st.draft))
      }
      said.push(text)
    }
    return bad.length ? bad : said.map((t) => `"${t}"`).join(' / ')
  })

  check('Tunnel: a new Length changes it from its middle (both ends move); one too long for its stretch is refused and nothing changes (the real editor store)', () => {
    if (!store) return skip
    const bad: string[] = []
    const d0 = afterglow()
    store.replaceDraft(d0, null)
    store.setTool('place', 'tunnel')
    if (!store.placeAt(frameAt(roadCurve(d0.points), CLEAR_AT).p)) return [`placing it was refused: ${store.useEditor.getState().message?.text}`]
    const index = store.useEditor.getState().draft.pieces.length - 1
    const rt0 = built(store, store.useEditor.getState().draft)
    const m0 = rt0 ? tunnelMiddle(rt0, index) : null
    store.setPieceLength(index, 120)
    const d1 = store.useEditor.getState().draft
    const p1 = d1.pieces[index]
    if (p1?.type !== 'tunnel' || p1.length !== 120) bad.push(`Length 120 didn't take: ${store.useEditor.getState().message?.text}`)
    const rt1 = built(store, d1)
    const tn1 = rt1?.tunnels.find((x) => x.index === index)
    const m1 = rt1 ? tunnelMiddle(rt1, index) : null
    if (!tn1 || Math.abs(tn1.s1 - tn1.s0 - 120) > 3) bad.push(`built covered length ${tn1 ? (tn1.s1 - tn1.s0).toFixed(0) : 'none'} m, not 120`)
    if (m0 && m1 && flat(m0, m1) > 3) bad.push(`its middle moved ${flat(m0, m1).toFixed(1)} m`)
    // 600 m reaches the start grid with its ramps.
    store.setPieceLength(index, 600)
    const st = store.useEditor.getState()
    if (st.draft !== d1) bad.push('a refused Length still changed the draft')
    const text = st.message?.text ?? ''
    if (!text.includes("Can't put a tunnel here")) bad.push(`Length 600 said "${text}"`)
    return bad.length ? bad : `120 m: middle moved ${m0 && m1 ? flat(m0, m1).toFixed(1) : '?'} m; 600 m: "${text}"`
  })

  check('Tunnel: a drag along the road makes one covering the stretch dragged (the real editor store)', () => {
    if (!store) return skip
    const d0 = afterglow()
    store.replaceDraft(d0, null)
    store.setTool('place', 'tunnel')
    const rc = roadCurve(d0.points)
    const a = advanceAt(rc, CLEAR_AT, -60)
    const b = advanceAt(rc, CLEAR_AT, 60)
    if (!store.placeTunnelSpan(a, b)) return [`refused: ${store.useEditor.getState().message?.text}`]
    const d = store.useEditor.getState().draft
    const index = d.pieces.length - 1
    const p = d.pieces[index]
    const bad: string[] = []
    if (p?.type !== 'tunnel' || p.length !== 120) bad.push(`made length ${p?.type === 'tunnel' ? p.length : '?'}, wanted 120`)
    const rt = built(store, d)
    const tn = rt?.tunnels.find((x) => x.index === index)
    if (!rt || !tn) return [...bad, 'the game did not build it']
    // Its covered stretch's ends are where the drag started and stopped.
    const f = newFrame()
    rt.frameAt(tn.s0, f)
    const e0 = flat(f.position, frameAt(rc, a).p)
    rt.frameAt(tn.s1, f)
    const e1 = flat(f.position, frameAt(rc, b).p)
    if (e0 > 3 || e1 > 3) bad.push(`its ends are ${e0.toFixed(1)} and ${e1.toFixed(1)} m from where the drag started and stopped`)
    return bad.length ? bad : `120 m, ends within ${Math.max(e0, e1).toFixed(1)} m of the drag (${Math.round(metresBetween(rc, a, b))} m dragged)`
  })

  check('Tunnel: the built tube has 5 m or more over every lane to its drawn ceiling, the ground under its roof stays under the road (and out of physics), and its edge meets the ground beside it', () => {
    if (!store) return skip
    const d = afterglow()
    d.pieces.push({ type: 'tunnel', at: 4, length: 150 })
    const rt = built(store, d)
    const tn = rt?.tunnels[0]
    const inside = rt?.meshes.tunnels?.inside
    const hill = rt?.meshes.tunnels?.hill
    if (!rt || !tn || !inside || !hill) return ['the tunnel was not built']
    const bad: string[] = []
    const S = rt.samples
    const hit: NearestHit = { s: 0, index: 0, lateral: 0, height: 0, distance: 0, onRoad: false }
    // The ceiling as drawn: every ceiling vertex's height over the road beneath it.
    const part = inside.attributes.aPart.array
    let room = Infinity
    for (let v = 0; v < part.length; v++) {
      if (part[v] < 0.5) continue
      const x = inside.positions[v * 3]
      const y = inside.positions[v * 3 + 1]
      const z = inside.positions[v * 3 + 2]
      rt.nearest(x, y - 5, z, hit, tn.s0)
      const i = hit.index
      const hw = S.halfWidth[i]
      for (const l of [-hw, 0, hw]) room = Math.min(room, y - (S.py[i] + S.ry[i] * l))
    }
    if (room < 5) bad.push(`only ${room.toFixed(2)} m from the road to the drawn ceiling`)
    // Under the roof, from wall to wall: the physics ground is a hole, or below the road's edge.
    let worst = -Infinity
    let holes = 0
    for (let i = Math.ceil(tn.s0 / S.ds); i < Math.floor(tn.s1 / S.ds); i += 2) {
      const hw = S.halfWidth[i]
      for (let l = -hw; l <= hw; l += 0.5) {
        const x = S.px[i] + S.rx[i] * l
        const z = S.pz[i] + S.rz[i] * l
        // (The ground's height there is what the camera and the car's "am I under the ground?"
        // test read, hole or not: it must be under the road too.)
        worst = Math.max(worst, rt.terrainHeight(x, z) - (S.py[i] + S.ry[i] * l))
        if (groundHoleAt(rt, x, z)) holes++
      }
    }
    if (worst > -0.04) bad.push(`the ground is ${worst.toFixed(2)} m from the road surface under the roof`)
    if (!holes) bad.push('the physics ground under the roof is not left out anywhere')
    // The hill's lowest points round its outside edge sit within 10 cm of the ground just beyond.
    let lip = 0
    for (let k = 0; k < hill.positions.length; k += 3) {
      const nx = hill.normals[k]
      const nz = hill.normals[k + 2]
      if (hill.normals[k + 1] > 0.2 || Math.hypot(nx, nz) < 0.9) continue
      // Only the skirts round its outer edges: facing across the road, away from it (not a
      // portal or an end, which face along it, nor a wall's face, which faces the road).
      rt.nearest(hill.positions[k], hill.positions[k + 1], hill.positions[k + 2], hit, tn.s0)
      const i = hit.index
      if (Math.abs(nx * S.tx[i] + nz * S.tz[i]) > 0.3) continue
      if ((hill.positions[k] - S.px[i]) * nx + (hill.positions[k + 2] - S.pz[i]) * nz < 0) continue
      const x = hill.positions[k] + nx * 0.05
      const z = hill.positions[k + 2] + nz * 0.05
      const ground = rt.terrainHeight(x, z)
      // (A skirt's top vertex is the tube's edge; its bottom is buried, under the ground.)
      if (hill.positions[k + 1] > ground) lip = Math.max(lip, hill.positions[k + 1] - ground)
    }
    if (lip > 0.1) bad.push(`the tube's edge stands ${lip.toFixed(2)} m over the ground beside it`)
    return bad.length ? bad : `${room.toFixed(1)} m to the ceiling, the ground under the roof at least ${(-worst).toFixed(2)} m under the road (${holes} of its spots left out of physics), edge within ${(lip * 100).toFixed(0)} cm of the ground`
  })
}
