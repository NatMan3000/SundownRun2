// ============================================================
//  DRIVE TO DRAW - lay a road behind the car, then edit it
// ------------------------------------------------------------
//  Instead of drawing with the mouse, Josh drives: the car leaves a
//  glowing line on the ground wherever it goes. When he comes back
//  near where he started (or presses Finish), the line goes through
//  the same clean-up as a pencil stroke and opens in the editor.
//
//  How it works:
//    startDriveToDraw()  saves a temporary track: the draft's world
//                        with a small starter loop, so the game has a
//                        road to stand on, and starts a free drive on it
//    <EditorDrive />     inside the 3D scene: records the car every few
//                        metres and draws the glowing line (one mesh,
//                        allocated once, no garbage per frame)
//    <EditorDriveUi />   the bar on top: how much road is laid, Finish
//                        and Cancel
//    finish / cancel     clean up, delete the temporary track, back to
//                        the editor
// ============================================================

import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { FONTS, GLOW, PALETTE } from '../core/palette'
import { telemetry } from '../core/telemetry'
import { getGame, useGame } from '../core/store'
import { openEditor, startSession } from '../core/session'
import { audio } from '../core/api'
import { deleteDrawnTrack, saveDrawnTrack } from '../track/registry'
import type { RoadPoint } from '../track/schema'
import { cleanStroke, CLEANUP } from './cleanup'
import { draftFile, roadBound } from './draftFile'
import { type Draft, replaceDraft, say, useEditor } from './draft'
import { create } from 'zustand'

/** The temporary track's id (hidden from the track library). */
export const DRIVE_TRACK_ID = 'drive-to-draw'

/** Record a point every this many metres. */
const STEP_M = 4
/** Most points one drive can lay (about 16 km): the line mesh is sized for this once. */
const CAPACITY = 4000
/** Back within this many metres of the first point (after laying a full loop) closes it. */
const CLOSE_M = 30
/** The glowing line's width on the ground, metres. */
const LINE_WIDTH = 0.8

/** Recording state. Plain mutable data (written every frame) plus a small React store for the bar. */
const rec = {
  active: false,
  /** x, y, z of every recorded point. */
  xyz: new Float32Array(CAPACITY * 3),
  count: 0,
  length: 0,
  /** Environment of the world being driven (from the draft). */
  draft: null as Draft | null,
  /** Bumped when points are added, so the mesh knows to update. */
  version: 0,
  /** Furthest the car has been from the first point (the loop only closes after a real trip out). */
  maxFromStart: 0,
}

/** What the bar shows (changes a few times a second at most). */
const useDrive = create<{ active: boolean; metres: number; note: string | null }>(() => ({ active: false, metres: 0, note: null }))

function starterLoop(): RoadPoint[] {
  const pts: RoadPoint[] = []
  const n = 16
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2
    pts.push({ x: Math.round(48 * Math.sin(t) * 10) / 10, z: Math.round(-48 * Math.cos(t) * 10) / 10 })
  }
  return pts
}

/** Start driving to draw, in the current draft's world. */
export function startDriveToDraw(): boolean {
  const draft = useEditor.getState().draft
  const file = draftFile({
    id: DRIVE_TRACK_ID,
    name: 'Drive to draw',
    points: starterLoop(),
    width: draft.width,
    environment: draft.environment,
  })
  if (!saveDrawnTrack(file)) {
    say('Could not start: this browser is out of storage space.', 'bad')
    return false
  }
  rec.active = true
  rec.count = 0
  rec.length = 0
  rec.maxFromStart = 0
  rec.draft = draft
  rec.version++
  useDrive.setState({ active: true, metres: 0, note: null })
  audio.ui('start')
  if (!startSession({ mode: 'free', trackId: DRIVE_TRACK_ID })) {
    stop()
    say('Could not start drive to draw.', 'bad')
    return false
  }
  return true
}

function stop(): void {
  rec.active = false
  useDrive.setState({ active: false, metres: 0, note: null })
  deleteDrawnTrack(DRIVE_TRACK_ID)
}

/** Turn the driven line into a road and open it in the editor. Returns false (and keeps driving) if it is too short. */
export function finishDriveToDraw(): boolean {
  if (!rec.active || !rec.draft) return false
  const raw = []
  for (let i = 0; i < rec.count; i++) raw.push({ x: rec.xyz[i * 3], z: rec.xyz[i * 3 + 2] })
  const base = rec.draft
  const res = cleanStroke(raw, { width: base.width, bound: roadBound(base.environment), smoothing: 10, fairing: 8 })
  if (!res.ok) {
    const why = res.issues.find((i) => i.level === 'error')?.message ?? 'That road could not be cleaned up.'
    useDrive.setState({ note: `${why} Keep driving!` })
    audio.ui('error')
    return false
  }
  const draft: Draft = { ...structuredClone(base), id: '', name: 'Driven Road', points: res.points, pieces: [], props: [], cores: [], startAt: 0 }
  stop()
  replaceDraft(draft, null)
  useEditor.setState({ dirty: true, notes: { crossings: res.crossings, issues: res.issues }, tool: 'select' })
  openEditor()
  say(`Your drive became a ${(res.length / 1000).toFixed(2)} km road. Save it to keep it.`, 'good')
  audio.ui('select')
  return true
}

/** Stop without making a road; back to the editor and the track you had before. */
export function cancelDriveToDraw(): void {
  if (!rec.active) return
  const before = rec.draft
  stop()
  if (before) useEditor.setState({ draft: before })
  openEditor()
  audio.ui('back')
}

/** Dev / checker: the recorded points so far, and a way to feed fake ones. */
export const driveRecorder = {
  get active() {
    return rec.active
  },
  get count() {
    return rec.count
  },
  get metres() {
    return Math.round(rec.length)
  },
  /** Add a point as if the car had driven there (for checkers without a driver). */
  add(x: number, y: number, z: number) {
    addPoint(x, y, z)
  },
}

function addPoint(x: number, y: number, z: number): void {
  if (rec.count >= CAPACITY) return
  const i = rec.count
  if (i > 0) rec.length += Math.hypot(x - rec.xyz[(i - 1) * 3], z - rec.xyz[(i - 1) * 3 + 2])
  rec.xyz[i * 3] = x
  rec.xyz[i * 3 + 1] = y
  rec.xyz[i * 3 + 2] = z
  rec.count++
  rec.version++
}

// ---------------------------------------------------------------- the glowing line (inside the Canvas)

/** Inside the 3D scene while driving: records the car and draws the laid road. Renders nothing otherwise. */
export function EditorDrive() {
  const active = useDrive((s) => s.active)
  if (!active) return null
  return <DriveLine />
}

function DriveLine() {
  const { mesh, geometry, material } = useMemo(() => {
    const g = new THREE.BufferGeometry()
    // Two vertices per recorded point (left and right edge of the line).
    const positions = new Float32Array(CAPACITY * 2 * 3)
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage))
    const index = new Uint32Array((CAPACITY - 1) * 6)
    for (let i = 0; i < CAPACITY - 1; i++) {
      const a = i * 2
      index.set([a, a + 2, a + 1, a + 1, a + 2, a + 3], i * 6)
    }
    g.setIndex(new THREE.BufferAttribute(index, 1))
    g.setDrawRange(0, 0)
    // A line of light, not a lit surface: unlit, soft-halo glow (tier T1) so it guides
    // without out-shining the car or the road.
    const m = new THREE.MeshBasicMaterial({
      color: new THREE.Color(PALETTE.uiAccent).multiplyScalar(GLOW.T1),
      toneMapped: false,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    })
    const me = new THREE.Mesh(g, m)
    me.frustumCulled = false
    me.renderOrder = 4
    return { mesh: me, geometry: g, material: m }
  }, [])
  useEffect(
    () => () => {
      geometry.dispose()
      material.dispose()
    },
    [geometry, material],
  )

  const shown = useRef(-1)
  const lastNote = useRef(0)
  useFrame(() => {
    if (!rec.active) return
    const g = getGame()
    if (g.phase === 'playing') {
      const p = telemetry.carPosition
      const n = rec.count
      if (n === 0) {
        if (telemetry.speedKmh > 8) addPoint(p.x, p.y, p.z)
      } else {
        const lx = rec.xyz[(n - 1) * 3]
        const lz = rec.xyz[(n - 1) * 3 + 2]
        const d = Math.hypot(p.x - lx, p.z - lz)
        if (d >= STEP_M) addPoint(p.x, p.y, p.z)
        const fromStart = Math.hypot(p.x - rec.xyz[0], p.z - rec.xyz[2])
        if (fromStart > rec.maxFromStart) rec.maxFromStart = fromStart
        // Back at the start after a real trip out: close the loop.
        if (rec.length > CLEANUP.minLength + 40 && rec.maxFromStart > 80 && fromStart < CLOSE_M) finishDriveToDraw()
      }
      const now = performance.now()
      if (now - lastNote.current > 250) {
        lastNote.current = now
        useDrive.setState({ metres: Math.round(rec.length) })
      }
    }
    if (shown.current === rec.version) return
    shown.current = rec.version
    updateRibbon(geometry)
  })
  return <primitive object={mesh} />
}

/** Rebuild the ribbon's vertices from the recorded points (in place; no allocation). */
function updateRibbon(g: THREE.BufferGeometry): void {
  const attr = g.getAttribute('position') as THREE.BufferAttribute
  const pos = attr.array as Float32Array
  const n = rec.count
  const xyz = rec.xyz
  const half = LINE_WIDTH / 2
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1)
    const b = Math.min(n - 1, i + 1)
    let dx = xyz[b * 3] - xyz[a * 3]
    let dz = xyz[b * 3 + 2] - xyz[a * 3 + 2]
    const len = Math.hypot(dx, dz) || 1
    dx /= len
    dz /= len
    // Just under the car's body, on the road it was driving on.
    const y = xyz[i * 3 + 1] - 0.35
    pos[i * 6] = xyz[i * 3] - dz * half
    pos[i * 6 + 1] = y
    pos[i * 6 + 2] = xyz[i * 3 + 2] + dx * half
    pos[i * 6 + 3] = xyz[i * 3] + dz * half
    pos[i * 6 + 4] = y
    pos[i * 6 + 5] = xyz[i * 3 + 2] - dx * half
  }
  attr.needsUpdate = true
  attr.clearUpdateRanges()
  attr.addUpdateRange(0, n * 6)
  g.setDrawRange(0, Math.max(0, (n - 1) * 6))
}

// ---------------------------------------------------------------- the bar on top (DOM)

/** The drive-to-draw bar: metres laid, what to do, Finish and Cancel. Renders nothing unless active. */
export function EditorDriveUi() {
  const s = useDrive()
  const phase = useGame((g) => g.phase)
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!s.active) return
    const t = setInterval(() => setTick((v) => v + 1), 500)
    return () => clearInterval(t)
  }, [s.active])
  if (!s.active || phase !== 'playing') return null
  const enough = s.metres >= CLEANUP.minLength
  return (
    <div role="status" style={driveBarStyle}>
      <span style={kickerStyle}>Drive to draw</span>
      <span style={metresStyle}>{s.metres} m laid</span>
      <span style={textStyle}>{s.note ?? (enough ? 'Drive back to where you started to close the loop, or press Finish.' : `Drive anywhere! Lay at least ${CLEANUP.minLength} m of road.`)}</span>
      <button type="button" style={buttonStyle(true)} onClick={() => finishDriveToDraw()}>
        Finish
      </button>
      <button type="button" style={buttonStyle(false)} onClick={cancelDriveToDraw}>
        Cancel
      </button>
    </div>
  )
}

// Inline styles from palette tokens (this bar shows while the editor stylesheet's root isn't mounted).
const driveBarStyle: React.CSSProperties = {
  position: 'fixed',
  top: 18,
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 30,
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  padding: '10px 12px 10px 18px',
  borderRadius: 999,
  background: PALETTE.uiPanel,
  border: `1px solid ${PALETTE.uiLine}`,
  color: PALETTE.uiText,
  font: `14px ${FONTS.body}`,
  backdropFilter: 'blur(10px)',
  pointerEvents: 'auto',
}
const kickerStyle: React.CSSProperties = { color: PALETTE.uiAccent, letterSpacing: '0.18em', textTransform: 'uppercase', fontSize: 12, fontWeight: 600 }
const metresStyle: React.CSSProperties = { fontVariantNumeric: 'tabular-nums', fontWeight: 600 }
const textStyle: React.CSSProperties = { color: PALETTE.uiDim }
function buttonStyle(primary: boolean): React.CSSProperties {
  return {
    padding: '7px 14px',
    borderRadius: 999,
    border: `1px solid ${primary ? PALETTE.uiAccent : PALETTE.uiLine}`,
    background: primary ? PALETTE.uiAccent : 'transparent',
    color: primary ? PALETTE.uiPanelSolid : PALETTE.uiText,
    font: 'inherit',
    fontWeight: 600,
    cursor: 'pointer',
  }
}
