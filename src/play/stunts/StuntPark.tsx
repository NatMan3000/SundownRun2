// ============================================================
//  STUNT PARK - ramps, gaps, pipes, rings and bullseyes off the road
// ------------------------------------------------------------
//  Nathan's ask: "a bunch of stunts, jumps, and extra scoring
//  potentials scattered around the free roam zone". Every track
//  (drawn ones too) gets its own park, worked out from the track
//  itself (parkLayout.ts) and seeded by its id, so the same track
//  always gets the same park and stunt records stay fair.
//
//  It is only there in Free Roam and Stunt Attack (modes.ts):
//  races and time trials keep a clean world. Turn it off for good
//  with stuntPark in src/core/config.ts (?park=0 in the URL leaves
//  it out for one visit: handy for comparing perf).
//
//  What this component does:
//    - builds the park's one render mesh (parkGeometry.ts) with its
//      neon material (stuntMaterial.ts): one draw call for every
//      ramp and pad, one more for all the rings
//    - gives every piece its own solid triangle-mesh collider,
//      tagged 'ramp' (the car treats it like the road's kickers)
//    - flashes a ring when you fly through it
//    - dev handles: __dev.park(), __dev.parkGo(item, kmh) and the
//      'stunts' section of window.__game.get('play')
//
//  Scoring (rings, named gaps, bullseye landings) lives in
//  parkScoring.ts; it hooks into the trick detector so a stunt
//  scores with the jump it belongs to. On a walled track (the
//  Hyperdrome) the park is in the infield: parkReset.ts starts
//  Stunt Attack there, sends R to a park spot and gives the pause
//  menu its hop in and out.
// ============================================================

import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { useRapier } from '@react-three/rapier'
import { PALETTE } from '../../core/palette'
import { CONFIG } from '../../core/config'
import { useGame } from '../../core/store'
import { getCar } from '../../core/telemetry'
import { registerDev, urlParam } from '../../core/devHandles'
import { useTrack } from '../../track/current'
import { add, removeColliderSet } from '../../track/colliders'
import type { ColliderSet } from '../../track/colliders'
import type { TrackRuntime } from '../../track/types'
import { featuresFor } from '../modes'
import { registerPlayInspector } from '../inspect'
import { buildExtruded, buildPad, ParkMeshBuilder } from './parkGeometry'
import type { SolidMesh } from './parkGeometry'
import { buildParkLayout } from './parkLayout'
import type { ParkLayout } from './parkLayout'
import { makeParkMaterial, makeRingMaterial } from './stuntMaterial'
import { parkLive } from './parkLive'
import { loadParkJudge, PARK_REWIND_FLOATS, parkJudge, resetParkJudge, saveParkJudge } from './parkScoring'
import { installParkResets } from './parkReset'
import { setAirJudge } from '../../vehicle/tricks'
import { addRewindPart } from '../../vehicle'
/** A ring's flash after you fly through it, seconds (T3 must stay under half a second). */
const FLASH_S = 0.45
/** The car's middle sits this far above the ground (spawning a run in parkGo). */
const SPAWN_LIFT = 0.65

const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _p = new THREE.Vector3()
const _s = new THREE.Vector3(1, 1, 1)
const _z = new THREE.Vector3(0, 0, 1)
const _n = new THREE.Vector3()
const _basis = new THREE.Matrix4()
const _left = new THREE.Vector3()
const _up = new THREE.Vector3(0, 1, 0)
const _fwd = new THREE.Vector3()

export function StuntPark() {
  const track = useTrack()
  const mode = useGame((s) => s.mode)
  // ?park=0 leaves it out (perf and demo comparisons against a world without it).
  if (!track || !CONFIG.stuntPark || urlParam('park') === '0' || !featuresFor(mode).park) return null
  return <ParkField key={track.id} track={track} />
}

/**
 * The layout for a track file, kept while only a live parameter (the bank slider) changes: the
 * park keeps its distance from the road, so the ground under it never moves with the bank.
 * Josh's megaRampHeight knob is part of the key.
 */
const layoutCache = new WeakMap<object, { mega: number; layout: ParkLayout }>()
function layoutFor(track: TrackRuntime): ParkLayout {
  const mega = CONFIG.megaRampHeight
  const hit = layoutCache.get(track.file)
  if (hit && hit.mega === mega) return hit.layout
  const layout = buildParkLayout(track, { megaHeight: mega })
  layoutCache.set(track.file, { mega, layout })
  return layout
}

function ParkField({ track }: { track: TrackRuntime }) {
  const { world, rapier } = useRapier()
  const layout = layoutFor(track)
  const ringRef = useRef<THREE.InstancedMesh>(null)

  // ---- the render mesh and the physics solids, built once per layout ----
  const built = useMemo(() => {
    const mb = new ParkMeshBuilder()
    const solids: SolidMesh[] = []
    for (const s of layout.solids) solids.push(buildExtruded(s, track.terrainHeight, mb))
    for (const p of layout.pads) solids.push(buildPad(p, mb))
    const g = mb.build()
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(g.positions, 3))
    geo.setAttribute('normal', new THREE.BufferAttribute(g.normals, 3))
    geo.setAttribute('aPark', new THREE.BufferAttribute(g.park, 4))
    geo.setAttribute('aPark2', new THREE.BufferAttribute(g.park2, 2))
    geo.setIndex(new THREE.BufferAttribute(g.indices, 1))
    geo.computeBoundingSphere()
    return { geo, solids, triangles: g.indices.length / 3 }
    // The terrain under the park doesn't change with a live parameter: the layout is the key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout])
  useEffect(() => () => built.geo.dispose(), [built])

  const time = useMemo(() => ({ value: 0 }), [])
  const edge = track.file.environment.palette?.edge ?? PALETTE.roadEdge
  const material = useMemo(() => makeParkMaterial(time, { edge }), [time, edge])
  useEffect(() => () => material.dispose(), [material])

  // ---- rings: one instanced torus, each with its own flash ----
  const rings = useMemo(() => {
    const geo = new THREE.TorusGeometry(1, 0.055, 10, 56)
    const flash = new Float32Array(Math.max(1, layout.rings.length))
    geo.setAttribute('aFlash', new THREE.InstancedBufferAttribute(flash, 1))
    return { geo, flash, mat: makeRingMaterial() }
  }, [layout])
  useEffect(
    () => () => {
      rings.geo.dispose()
      rings.mat.dispose()
    },
    [rings],
  )
  useEffect(() => {
    const mesh = ringRef.current
    if (!mesh) return
    for (let i = 0; i < layout.rings.length; i++) {
      const r = layout.rings[i]
      _n.set(r.nx, r.ny, r.nz)
      // The torus's hole looks along +z: turn +z onto the way cars fly through it.
      _q.setFromUnitVectors(_z, _n)
      _p.set(r.x, r.y, r.z)
      _s.set(r.radius, r.radius, r.radius)
      _m.compose(_p, _q, _s)
      mesh.setMatrixAt(i, _m)
    }
    mesh.count = layout.rings.length
    mesh.instanceMatrix.needsUpdate = true
    mesh.computeBoundingSphere()
  }, [layout, rings])

  // ---- physics: one closed triangle mesh per piece, on its own fixed body ----
  useEffect(() => {
    const set: ColliderSet = { body: world.createRigidBody(rapier.RigidBodyDesc.fixed()), handles: [] }
    for (const s of built.solids) add(world, rapier, set, rapier.ColliderDesc.trimesh(s.vertices, s.indices, rapier.TriMeshFlags.FIX_INTERNAL_EDGES), 'ramp')
    return () => removeColliderSet(world, set)
  }, [world, rapier, built])

  // ---- scoring: the trick detector's air judge, and its part of every rewind snapshot ----
  useEffect(() => {
    parkLive.layout = layout
    parkLive.ringFlash = new Array(layout.rings.length).fill(0)
    resetParkJudge()
    setAirJudge(parkJudge)
    const offRewind = addRewindPart({ size: PARK_REWIND_FLOATS, save: saveParkJudge, load: loadParkJudge })
    // On a walled track, R inside the park returns to a park spot (parkReset.ts).
    const offResets = installParkResets()
    return () => {
      offRewind()
      offResets()
      setAirJudge(null)
      resetParkJudge()
      if (parkLive.layout === layout) parkLive.layout = null
    }
  }, [layout])

  // ---- dev handles ----
  useEffect(() => {
    const offs = [
      registerDev(
        'park',
        (() => ({
          zones: layout.zones.map((z) => `${z.id} ${z.name} (${Math.round(z.x)}, ${Math.round(z.z)}) ${Math.round(z.length)} m`),
          items: layout.items.map((it) => `${it.id} ${it.kind} ${it.label} @(${Math.round(it.x)}, ${it.y.toFixed(1)}, ${Math.round(it.z)}) zone ${it.zone}${it.designKmh ? ` ${it.designKmh} km/h` : ''}`),
          jumps: layout.jumps.map((j) => `${j.name} ${j.points}`),
          triangles: built.triangles,
          colliders: built.solids.length,
          layoutMs: Math.round(layout.buildMs),
          skipped: layout.skipped,
        })) as never,
        'park(): the stunt park on this track (zones, items with ids, named jumps)',
      ),
      registerDev(
        'parkGo',
        ((item: number, kmh = 0, back = 0, turnDeg = 0) => {
          const it = layout.items[Number(item)]
          const car = getCar('player')
          if (!it || !car?.api) return `no item ${item} (0..${layout.items.length - 1})`
          // Start on the lane's centre line `back` metres further back than its run-in start, facing it.
          const b = Number(back) || 0
          const x = it.runX - it.dx * b
          const z = it.runZ - it.dz * b
          _p.set(x, track.terrainHeight(x, z) + SPAWN_LIFT, z)
          // Optionally turned (+ = to the right), e.g. to drive into a half pipe's wall.
          const turn = ((Number(turnDeg) || 0) * Math.PI) / 180
          const c = Math.cos(turn)
          const sn = Math.sin(turn)
          _fwd.set(it.dx * c - it.dz * sn, 0, it.dz * c + it.dx * sn).normalize()
          _left.crossVectors(_up, _fwd).normalize()
          _basis.makeBasis(_left, _up, _fwd)
          _q.setFromRotationMatrix(_basis)
          car.api.teleport(_p, _q)
          const k = Number(kmh) || 0
          const dev = (window as unknown as { __dev?: Record<string, (v: number) => unknown> }).__dev
          if (k > 0) dev?.setSpeed?.(k)
          return { item: it.id, kind: it.kind, label: it.label, runIn: Math.round(it.runIn + b), x: Math.round(x), z: Math.round(z), kmh: k }
        }) as never,
        'parkGo(item, kmh = 0, back = 0, turnDeg = 0): put the player at the start of a run at a stunt-park item (see park()), facing it (turned turnDeg right), moving at kmh; a negative back starts further in',
      ),
      registerDev(
        'parkShot',
        ((zone: number, view = 'side') => {
          const z = layout.zones[Number(zone)]
          if (!z) return `no zone ${zone} (0..${layout.zones.length - 1})`
          const mx = z.x + z.dx * z.length * 0.5
          const mz = z.z + z.dz * z.length * 0.5
          const my = track.terrainHeight(mx, mz)
          let cx: number
          let cy: number
          let cz: number
          let lx = mx
          let ly = my + 2
          let lz = mz
          if (view === 'run') {
            // Behind the lane's start, low, looking down it.
            cx = z.x - z.dx * 25
            cz = z.z - z.dz * 25
            cy = track.terrainHeight(cx, cz) + 6
            lx = z.x + z.dx * z.length * 0.6
            lz = z.z + z.dz * z.length * 0.6
            ly = track.terrainHeight(lx, lz) + 4
          } else if (view === 'top') {
            cx = mx - z.dz * z.length * 0.15
            cz = mz + z.dx * z.length * 0.15
            cy = my + z.length * 0.75
          } else {
            // From the side, three-quarters on, a little above.
            const d = Math.max(60, z.length * 0.55)
            cx = mx - z.dz * d - z.dx * d * 0.35
            cz = mz + z.dx * d - z.dz * d * 0.35
            cy = Math.max(track.terrainHeight(cx, cz) + 4, my + d * 0.28)
          }
          const name = `at:${[cx, cy, cz, lx, ly, lz].map((v) => v.toFixed(1)).join(',')}`
          const dev = (window as unknown as { __dev?: Record<string, (v: string) => unknown> }).__dev
          dev?.cam?.(name)
          return name
        }) as never,
        "parkShot(zone, view = 'side' | 'run' | 'top'): point the camera at a stunt-park zone ( __dev.cam('free') to go back)",
      ),
      registerPlayInspector('stunts', () => ({
        zones: layout.zones.length,
        items: layout.items.length,
        rings: layout.rings.length,
        targets: layout.targets.length,
        jumps: layout.jumps.length,
        triangles: built.triangles,
        colliders: built.solids.length,
        layoutMs: Math.round(layout.buildMs),
        skipped: layout.skipped,
      })),
    ]
    return () => {
      for (const off of offs) off()
    }
  }, [layout, built, track])

  // ---- per frame: the shader clock and the ring flashes (no allocation) ----
  useFrame((_, delta) => {
    time.value = (time.value + Math.min(delta, 0.1)) % 600
    const mesh = ringRef.current
    if (!mesh) return
    let dirty = false
    const flash = rings.flash
    for (let i = 0; i < layout.rings.length; i++) {
      const hit = parkLive.ringFlash[i] ?? 0
      if (hit > 0) {
        flash[i] = 1
        parkLive.ringFlash[i] = 0
        dirty = true
      } else if (flash[i] > 0) {
        flash[i] = Math.max(0, flash[i] - Math.min(delta, 0.1) / FLASH_S)
        dirty = true
      }
    }
    if (dirty) (rings.geo.getAttribute('aFlash') as THREE.InstancedBufferAttribute).needsUpdate = true
  })

  return (
    <group name="stunt-park">
      <mesh geometry={built.geo} material={material} castShadow receiveShadow frustumCulled={false} />
      {layout.rings.length > 0 && <instancedMesh ref={ringRef} args={[rings.geo, rings.mat, layout.rings.length]} frustumCulled={false} />}
    </group>
  )
}
