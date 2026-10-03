// ============================================================
//  SELF-TEST: WHICH TRACK IS THIS, AND SAVING - rows for selfTest.ts
// ------------------------------------------------------------
//  The editor's self-test (selfTest.ts) calls trackRows() near the
//  end. Every row drives the real editor store (draft.ts) and the
//  real "Save it first?" logic (askFirst.ts), and checks the result
//  in the saved tracks themselves (src/track/registry.ts), not in
//  what the editor thinks it saved. They need Bun (in the game they
//  would change your track and your Library, so they skip).
//
//    two tracks    Nathan's case: draw and save A, New track, draw
//                  and save B: the Library has A and B, both intact
//    save as new   Save as new track from A: A as it was, plus a copy
//                  with A's changes, on the same hills, and you are on
//                  the copy; Undo puts you back on A
//    rename        renaming a saved track and saving keeps ONE entry;
//                  a name another track has gets a number
//    ask first     New track with changes not saved asks; Cancel
//                  changes nothing, Save it saves first, Don't save
//                  goes on (and Undo brings it back); with nothing
//                  unsaved it just goes; opening another track asks too
//    undo          Undo after New track gives back A's road AND A: Save
//                  then updates A, not a new track; Redo is the new one
//    dice          Random track on a saved track makes a new track and
//                  leaves the saved one alone
// ============================================================

import type { RoadPoint, TrackFile } from '../track/schema'
import type { Draft } from './draft'
import { pointGroundOf } from './draftFile'

type Check = (name: string, fn: () => string[] | string) => void
type EditorStore = typeof import('./draft')
type Registry = typeof import('../track/registry')
type AskFirst = typeof import('./askFirst')

const TAU = Math.PI * 2

/** The library and the questions, handed over by selfTest.ts's Bun loader (the browser skips these rows). */
let registry: Registry | undefined
let ask: AskFirst | undefined

export function setTrackModules(m: { registry: Registry; askFirst: AskFirst }): void {
  registry = m.registry
  ask = m.askFirst
}

/** A plain loop of `count` points, `r` metres round, centred at (cx, cz). */
function loop(count: number, r: number, cx = 0, cz = 0): RoadPoint[] {
  return Array.from({ length: count }, (_, i) => ({ x: Math.round((cx + r * Math.sin((i / count) * TAU)) * 10) / 10, z: Math.round((cz - r * Math.cos((i / count) * TAU)) * 10) / 10 }))
}

/** The road of a saved track, for comparing (null if it isn't saved). */
function savedRoad(r: Registry, id: string | null): string | null {
  const f = id ? r.getTrackFile(id) : null
  return f ? JSON.stringify(f.road.points) : null
}

const SKIP = 'skipped: needs the editor store (run `bun src/editor/selfTest.ts`); in the game it would change your track and your Library'

export function trackRows(check: Check, store: EditorStore | undefined): void {
  /** A fresh start: a new track called `name` in the default world, with `points` drawn on it (one commit). */
  const drawn = (s: EditorStore, name: string, points: RoadPoint[]): void => {
    s.replaceDraft({ ...s.newDraft(), name }, null)
    s.commit((d) => {
      d.points = points
    })
  }
  /** Draw a road on the empty map the editor is on now (one commit, as the pencil's first loop is). */
  const draw = (s: EditorStore, points: RoadPoint[]): void =>
    s.commit((d) => {
      d.points = points
    })
  const state = (s: EditorStore) => s.saveState(s.useEditor.getState())

  check("Nathan's case: draw and save A, New track, draw and save B: the Library has A and B, both intact (the real editor store)", () => {
    if (!store || !registry) return SKIP
    const r = registry
    const bad: string[] = []
    const roadA = loop(40, 210)
    const roadB = loop(36, 160, 40, -20)
    drawn(store, 'Canyon Run', roadA)
    const idA = store.saveDraft()
    if (!idA) return [`A would not save: ${store.useEditor.getState().message?.text}`]
    if (state(store) !== 'saved') bad.push(`after Save the header says "${state(store)}"`)
    const count = r.listDrawnTracks().length
    if (!store.newTrack()) return [...bad, `New track refused: ${store.useEditor.getState().message?.text}`]
    const s1 = store.useEditor.getState()
    if (s1.savedId !== null) bad.push(`New track kept the saved id "${s1.savedId}" (Save would write over A)`)
    if (s1.draft.points.length) bad.push('New track left a road on the map')
    if (s1.draft.name === 'Canyon Run') bad.push('New track kept the name "Canyon Run"')
    if (state(store) !== 'new') bad.push(`a new track's header says "${state(store)}", not "new"`)
    if (s1.draft.environment.seed === undefined) bad.push("the new track's hills are not pinned (they would move when it is renamed)")
    draw(store, roadB)
    const idB = store.saveDraft()
    if (!idB) return [...bad, `B would not save: ${store.useEditor.getState().message?.text}`]
    if (idB === idA) bad.push('B was saved over A')
    if (r.listDrawnTracks().length !== count + 1) bad.push(`the Library went from ${count} to ${r.listDrawnTracks().length} tracks, not one more`)
    if (savedRoad(r, idA) !== JSON.stringify(roadA)) bad.push("A's saved road changed")
    if (r.getTrackFile(idA)?.name !== 'Canyon Run') bad.push(`A is now called "${r.getTrackFile(idA)?.name}"`)
    if (savedRoad(r, idB) !== JSON.stringify(roadB)) bad.push("B's saved road is not the road drawn")
    const nameB = r.getTrackFile(idB)?.name ?? ''
    if (!nameB || nameB === 'Canyon Run') bad.push(`B is called "${nameB}"`)
    return bad.length ? bad : `A "Canyon Run" (${idA}) and B "${nameB}" (${idB}) both saved, both roads exactly as drawn; status: "${store.useEditor.getState().message?.text}"`
  })

  check('Save as new track from A: A stays as last saved, the copy has the changes on the same hills, and you carry on with the copy; Undo puts you back on A (the real editor store)', () => {
    if (!store || !registry) return SKIP
    const r = registry
    const bad: string[] = []
    drawn(store, 'Sunset Loop', loop(44, 230))
    const idA = store.saveDraft()
    if (!idA) return [`A would not save: ${store.useEditor.getState().message?.text}`]
    const fileA = JSON.stringify(r.getTrackFile(idA))
    store.setWidth(18)
    const idC = store.saveAsNewTrack()
    if (!idC) return [...bad, `Save as new refused: ${store.useEditor.getState().message?.text}`]
    const s1 = store.useEditor.getState()
    if (idC === idA) bad.push('the copy was saved over A')
    if (JSON.stringify(r.getTrackFile(idA)) !== fileA) bad.push('A changed')
    const copy = r.getTrackFile(idC) as TrackFile
    if (copy.road.width !== 18) bad.push(`the copy's road is ${copy.road.width} m wide, not the 18 m it was changed to`)
    if (copy.name !== 'Sunset Loop 2') bad.push(`the copy is called "${copy.name}", not "Sunset Loop 2"`)
    if (s1.savedId !== idC || s1.draft.name !== copy.name) bad.push(`the editor is on "${s1.draft.name}" (${s1.savedId}), not the copy`)
    if (state(store) !== 'saved') bad.push(`the header says "${state(store)}"`)
    // Same hills: the ground a road point with no height sits on is the same for the two saved files, each under its own id.
    const fa = r.getTrackFile(idA) as TrackFile
    const groundA = pointGroundOf(fa.environment, idA, fa.road.surfaceSmoothing)
    const groundC = pointGroundOf(copy.environment, idC, copy.road.surfaceSmoothing)
    const spots = [
      [0, 0],
      [150, -90],
      [-260, 120],
    ]
    if (!groundA || !groundC) bad.push('no ground to compare')
    else for (const [x, z] of spots) if (Math.abs(groundA(x, z) - groundC(x, z)) > 1e-6) bad.push(`the copy's hills are ${groundC(x, z).toFixed(2)} m at (${x}, ${z}), A's ${groundA(x, z).toFixed(2)} m`)
    store.undo()
    const s2 = store.useEditor.getState()
    if (s2.savedId !== idA || s2.draft.name !== 'Sunset Loop') bad.push(`Undo is on "${s2.draft.name}" (${s2.savedId}), not back on A`)
    if (state(store) !== 'changed') bad.push(`back on A with its unsaved width change the header says "${state(store)}"`)
    return bad.length ? bad : `A untouched, copy "${copy.name}" (${idC}) 18 m wide on the same hills; Undo back on A; status was "${s1.message?.text}"`
  })

  check('Renaming a saved track and saving keeps ONE entry (same track, new name); a name another track has gets a number (the real editor store)', () => {
    if (!store || !registry) return SKIP
    const r = registry
    const bad: string[] = []
    drawn(store, 'Harbour Run', loop(40, 200))
    const idOther = store.saveDraft()
    drawn(store, 'Ridge Line', loop(40, 190, 30, 10))
    const idA = store.saveDraft()
    if (!idA || !idOther) return ['the two tracks would not save']
    const count = r.listDrawnTracks().length
    store.setName('Ridge Line Deluxe')
    if (state(store) !== 'changed') bad.push(`after renaming the header says "${state(store)}"`)
    if (store.saveDraft() !== idA) bad.push('saving the renamed track saved it under a different id')
    if (r.listDrawnTracks().length !== count) bad.push(`renaming and saving changed the Library from ${count} to ${r.listDrawnTracks().length} tracks`)
    if (r.getTrackFile(idA)?.name !== 'Ridge Line Deluxe') bad.push(`the saved name is "${r.getTrackFile(idA)?.name}"`)
    const said = store.useEditor.getState().message?.text ?? ''
    if (!/it was called "Ridge Line"/.test(said)) bad.push(`the status line said "${said}"`)
    // Now the other track's name: it gets a number, and the other track is left alone.
    const other = JSON.stringify(r.getTrackFile(idOther))
    store.setName('harbour run ')
    store.saveDraft()
    const now = r.getTrackFile(idA)?.name
    if (now !== 'harbour run 2') bad.push(`saving with another track's name made "${now}", not "harbour run 2"`)
    if (store.useEditor.getState().draft.name !== now) bad.push('the name box does not show the name it was saved under')
    if (JSON.stringify(r.getTrackFile(idOther)) !== other) bad.push('the other track changed')
    if (r.listDrawnTracks().length !== count) bad.push('the Library grew')
    return bad.length ? bad : `one entry, renamed; taken name became "${now}": "${store.useEditor.getState().message?.text}"`
  })

  check('Ask first: New track with changes not saved asks; Cancel changes nothing, Save it saves first, Don\'t save goes on (Undo brings it back); nothing unsaved: no question; opening another track asks too (the real store and askFirst.ts)', () => {
    if (!store || !registry || !ask) return SKIP
    const r = registry
    const a = ask
    const bad: string[] = []
    drawn(store, 'Glass Canyon', loop(40, 205))
    const idA = store.saveDraft()
    if (!idA) return ['A would not save']
    const savedA = JSON.stringify(r.getTrackFile(idA))
    // With nothing unsaved: no question, straight to the new track.
    if (!a.askNewTrack() || a.useAsk.getState().open) bad.push('a saved track with no changes asked first')
    if (store.useEditor.getState().savedId !== null || store.useEditor.getState().draft.points.length) bad.push('New track did not happen with nothing unsaved')
    store.undo()
    if (store.useEditor.getState().savedId !== idA) return [...bad, 'Undo did not come back to A']
    // A change, then New track: it asks.
    store.setWidth(20)
    const before = store.useEditor.getState().draft
    a.askNewTrack()
    const q = a.useAsk.getState()
    if (!q.open || q.kind !== 'unsaved' || q.next !== 'new' || q.name !== 'Glass Canyon' || !q.saved) bad.push(`the question is ${JSON.stringify(q)}`)
    if (store.useEditor.getState().draft !== before) bad.push('the map changed while the question was up')
    // Cancel: nothing changes.
    a.answerAsk('cancel')
    if (a.useAsk.getState().open) bad.push('Cancel did not close the question')
    if (store.useEditor.getState().draft !== before || store.useEditor.getState().savedId !== idA) bad.push('Cancel changed the track')
    if (JSON.stringify(r.getTrackFile(idA)) !== savedA) bad.push('Cancel saved A')
    // Save it: A is saved with the change, then the new track starts.
    a.askNewTrack()
    a.answerAsk('save')
    if (r.getTrackFile(idA)?.road.width !== 20) bad.push(`Save it did not save A's change (saved width ${r.getTrackFile(idA)?.road.width})`)
    if (store.useEditor.getState().savedId !== null || store.useEditor.getState().draft.points.length) bad.push('after Save it, the new track did not start')
    // Don't save: back on A, another change, New track, Don't save: A keeps what was saved, and Undo brings the change back.
    store.undo()
    store.setWidth(12)
    const changed = store.useEditor.getState().draft
    a.askNewTrack()
    a.answerAsk('discard')
    if (store.useEditor.getState().savedId !== null) bad.push("after Don't save, the new track did not start")
    if (r.getTrackFile(idA)?.road.width !== 20) bad.push(`Don't save saved A anyway (width ${r.getTrackFile(idA)?.road.width})`)
    store.undo()
    if (store.useEditor.getState().draft !== changed || store.useEditor.getState().savedId !== idA) bad.push("Undo after Don't save did not bring back A with its change")
    // Opening another track asks the same way, and only runs after the answer.
    let opened = 0
    a.askBeforeLeavingTrack('open', () => opened++, 'Ridge Line')
    if (!a.useAsk.getState().open || a.useAsk.getState().next !== 'open' || opened) bad.push('opening another track with changes not saved did not ask first')
    a.answerAsk('cancel')
    if (opened) bad.push('Cancel opened it anyway')
    // An empty new track has nothing to lose: no question.
    store.newTrack()
    let left = 0
    a.askBeforeLeavingTrack('exit', () => left++)
    if (left !== 1 || a.useAsk.getState().open) bad.push('leaving an empty new track asked first')
    return bad.length ? bad : 'no unsaved: no question; Cancel: nothing; Save it: saved then new; Don\'t save: new, Undo brings the change back; Open asks too'
  })

  check('Undo after New track gives back A\'s road AND A: Save then updates A, not a new track; Redo goes back to the new track (the real editor store)', () => {
    if (!store || !registry) return SKIP
    const r = registry
    const bad: string[] = []
    const roadA = loop(40, 215)
    drawn(store, 'Neon Bend', roadA)
    const idA = store.saveDraft()
    if (!idA) return ['A would not save']
    const aDraft = store.useEditor.getState().draft
    store.newTrack()
    draw(store, loop(38, 170, -30, 15))
    const idB = store.saveDraft()
    if (!idB) return ['B would not save']
    const count = r.listDrawnTracks().length
    store.undo()
    store.undo()
    const s1 = store.useEditor.getState()
    if (JSON.stringify(s1.draft.points) !== JSON.stringify(roadA)) bad.push("two Undos did not bring back A's road")
    if (s1.savedId !== idA) bad.push(`after Undo the editor is on "${s1.savedId}", not A (${idA})`)
    if (s1.draft !== aDraft) bad.push("it is not A's draft exactly")
    if (state(store) !== 'saved') bad.push(`back on A, unchanged, the header says "${state(store)}"`)
    // Redo, twice: back on B, saved.
    store.redo()
    store.redo()
    const s2 = store.useEditor.getState()
    if (s2.savedId !== idB) bad.push(`Redo is on "${s2.savedId}", not B (${idB})`)
    if (state(store) !== 'saved') bad.push(`back on B the header says "${state(store)}"`)
    // Back to A, change it, Save: A is updated; no new track.
    store.undo()
    store.undo()
    store.setWidth(16)
    const id = store.saveDraft()
    if (id !== idA) bad.push(`Save after Undo saved "${id}", not A`)
    if (r.listDrawnTracks().length !== count) bad.push(`Save after Undo made a new track (${count} -> ${r.listDrawnTracks().length})`)
    if (r.getTrackFile(idA)?.road.width !== 16) bad.push("A doesn't have the change")
    if (savedRoad(r, idB) === null) bad.push('B is gone')
    return bad.length ? bad : `Undo: A's road and A (${idA}); Redo: B (${idB}); Save after Undo updated A`
  })

  check('Random track on a saved track makes a new track and leaves the saved one alone; one Undo is back on it (the real editor store)', () => {
    if (!store || !registry || !ask) return SKIP
    const r = registry
    const bad: string[] = []
    drawn(store, 'Dice Base', loop(40, 200))
    const idA = store.saveDraft()
    if (!idA) return ['A would not save']
    const savedA = JSON.stringify(r.getTrackFile(idA))
    const res = store.randomRoad(4242)
    if (!res) return [`the dice found nothing: ${store.useEditor.getState().message?.text}`]
    const s1 = store.useEditor.getState()
    if (s1.savedId !== null) bad.push('the random road is still on A (Save would write over it)')
    if (s1.draft.name === 'Dice Base') bad.push('the random track kept A\'s name')
    if (!s1.draft.points.length) bad.push('no road')
    if (JSON.stringify(r.getTrackFile(idA)) !== savedA) bad.push('A changed')
    const idNew = store.saveDraft()
    if (!idNew || idNew === idA) bad.push(`saving the random track saved "${idNew}"`)
    if (JSON.stringify(r.getTrackFile(idA)) !== savedA) bad.push('saving the random track changed A')
    store.undo()
    if (store.useEditor.getState().savedId !== idA) bad.push('Undo is not back on A')
    // The rail's dice on a saved track with nothing unsaved: no question, a new track.
    const before = store.useEditor.getState().draft as Draft
    if (!ask.askRandomTrack() || ask.useAsk.getState().open) bad.push('the dice on a saved track with nothing unsaved asked first')
    if (store.useEditor.getState().draft === before || store.useEditor.getState().savedId !== null) bad.push("the rail's dice did not make a new track")
    if (JSON.stringify(r.getTrackFile(idA)) !== savedA) bad.push("the rail's dice changed A")
    return bad.length ? bad : `new track "${s1.draft.name}"; A untouched; "${s1.message?.text}"`
  })
}
