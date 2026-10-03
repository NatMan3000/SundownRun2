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
//      ramp and bullseye, one more for all the rings
//    - gives every ramp, table and pipe its own solid triangle-mesh
//      collider, tagged 'ramp' (the car treats it like the road's
//      kickers). The bullseyes have none: they are paint on the
//      ground, so driving over one is driving on the ground
//    - draws the rings, and their explosion, countdown and comeback
//      (ringFx.ts), and runs their clock once per physics step
//      (ringComeback.ts: Josh's ringComebackSeconds knob)
//    - works out the HUD's speed cue for the launch ahead (parkCue.ts)
//    - dev handles: __dev.park(), __dev.parkGo(item, kmh),
//      __dev.laneGo(zone, a, l) (anywhere in a zone's lane, e.g.
//      beside a half pipe wall's end) and the 'stunts' section of
//      window.__game.get('play')
//
//  Scoring (rings, named gaps, bullseye landings) lives in
//  parkScoring.ts; it hooks into the trick detector so a stunt
//  scores with the jump it belongs to. On a walled track (the
//  Hyperdrome) the park is in the infield: parkReset.ts starts
//  Stunt Attack there, sends R to a park spot and gives the pause
//  menu its hop in and out.
// ============================================================

import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { useBeforePhysicsStep, useRapier } from '@react-three/rapier'
import { PALETTE } from '../../core/palette'
import { CONFIG } from '../../core/config'
import { getGame, useGame } from '../../core/store'
import { environment, getCar } from '../../core/telemetry'
import { registerDev, urlParam } from '../../core/devHandles'
import { useTrack } from '../../track/current'
import { add, removeColliderSet } from '../../track/colliders'
import type { ColliderSet } from '../../track/colliders'
import type { TrackRuntime } from '../../track/types'
import { featuresFor } from '../modes'
import { registerPlayInspector } from '../inspect'
import { buildExtruded, buildPadDecal, ParkMeshBuilder } from './parkGeometry'
import type { SolidMesh } from './parkGeometry'
import { buildParkLayout } from './parkLayout'
import type { ParkLayout } from './parkLayout'
import { makeParkMaterial, makeRingMaterial } from './stuntMaterial'
import { parkLive } from './parkLive'
import { loadParkJudge, PARK_REWIND_FLOATS, parkJudge, resetParkJudge, saveParkJudge } from './parkScoring'
import { comebackSeconds, loadRings, resetRings, rings as ringClock, ringWaitDebug, saveRings, tickRings } from './ringComeback'
import { RingFx } from './ringFx'
import { installParkResets } from './parkReset'
import { clearParkCue, cueLaunches, parkCueShown, stepParkCue } from './parkCue'
import { setAirJudge } from '../../vehicle/tricks'
import { addRewindPart } from '../../vehicle'
import { rewindPlaying } from '../../vehicle/rewind'
/** The car's middle sits this far above the ground (spawning a run in parkGo). */
const SPAWN_LIFT = 0.65

const _q = new THREE.Quaternion()
const _p = new THREE.Vector3()
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
  const round = useGame((s) => s.round)

  // ---- the render mesh and the physics solids, built once per layout ----
  const built = useMemo(() => {
    const mb = new ParkMeshBuilder()
    const solids: SolidMesh[] = []
    for (const s of layout.solids) solids.push(buildExtruded(s, track.terrainHeight, mb))
    // The bullseyes are paint on the ground: drawn with everything else, nothing for the physics.
    for (const p of layout.pads) buildPadDecal(p, track.terrain, mb)
    const g = mb.build()
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(g.positions, 3))
    geo.setAttribute('normal', new THREE.BufferAttribute(g.normals, 3))
    geo.setAttribute('aPark', new THREE.BufferAttribute(g.park, 4))
    geo.setAttribute('aPark2', new THREE.BufferAttribute(g.park2, 2))
    geo.setAttribute('aPark3', new THREE.BufferAttribute(g.park3, 4))
    geo.setIndex(new THREE.BufferAttribute(g.indices, 1))
    geo.computeBoundingSphere()
    return { geo, solids, triangles: g.indices.length / 3 }
    // The terrain under the park doesn't change with a live parameter: the layout is the key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout])
  useEffect(() => () => built.geo.dispose(), [built])

  const time = useMemo(() => ({ value: 0 }), [])
  // The sky's horizon colour, copied in every frame: the walls catch it as a sheen.
  const horizon = useMemo(() => ({ value: new THREE.Color().copy(environment.horizon) }), [])
  const edge = track.file.environment.palette?.edge ?? PALETTE.roadEdge
  const material = useMemo(() => makeParkMaterial(time, { edge, horizon }), [time, edge, horizon])
  useEffect(() => () => material.dispose(), [material])

  // ---- rings: one instanced torus, plus their explosions, countdowns and comebacks (ringFx.ts) ----
  const rings = useMemo(() => {
    const geo = new THREE.TorusGeometry(1, 0.055, 10, 56)
    const mat = makeRingMaterial()
    return { geo, mat, fx: new RingFx(layout.rings, geo, mat) }
  }, [layout])
  useEffect(
    () => () => {
      rings.fx.dispose()
      rings.geo.dispose()
      rings.mat.dispose()
    },
    [rings],
  )

  // ---- the speed cue: the launches with a sign, and the HUD told nothing when the park goes ----
  const launches = useMemo(() => cueLaunches(layout), [layout])
  useEffect(() => () => clearParkCue(), [launches])

  // ---- physics: one closed triangle mesh per piece, on its own fixed body ----
  useEffect(() => {
    const set: ColliderSet = { body: world.createRigidBody(rapier.RigidBodyDesc.fixed()), handles: [] }
    for (const s of built.solids) add(world, rapier, set, rapier.ColliderDesc.trimesh(s.vertices, s.indices, rapier.TriMeshFlags.FIX_INTERNAL_EDGES), 'ramp')
    return () => removeColliderSet(world, set)
  }, [world, rapier, built])

  // ---- scoring: the trick detector's air judge, and its part of every rewind snapshot ----
  useEffect(() => {
    parkLive.layout = layout
    const nRings = layout.rings.length
    resetRings(nRings)
    resetParkJudge()
    setAirJudge(parkJudge)
    // One snapshot holds the jump in progress and every ring's countdown, so rewinding to before a
    // pass brings the ring back whole (and the trick score takes its points back, vehicle/PlayerCar).
    const offRewind = addRewindPart({
      size: PARK_REWIND_FLOATS + nRings,
      save: (out, at) => {
        saveParkJudge(out, at)
        saveRings(out, at + PARK_REWIND_FLOATS, nRings)
      },
      load: (src, at) => {
        loadParkJudge(src, at)
        loadRings(src, at + PARK_REWIND_FLOATS, nRings)
      },
    })
    // On a walled track, R inside the park returns to a park spot (parkReset.ts).
    const offResets = installParkResets()
    return () => {
      offRewind()
      offResets()
      setAirJudge(null)
      resetParkJudge()
      resetRings(0)
      if (parkLive.layout === layout) parkLive.layout = null
    }
  }, [layout])

  // ---- a new round (Stunt Attack's next run, Restart): every ring is whole again, so runs are fair ----
  useEffect(() => {
    resetRings(layout.rings.length)
  }, [round, layout])

  // ---- the rings' countdowns run on physics steps: paused with the game, held while rewinding ----
  useBeforePhysicsStep(() => {
    tickRings(!rewindPlaying())
  })

  // ---- dev handles ----
  useEffect(() => {
    const offs = [
      registerDev(
        'park',
        (() => ({
          zones: layout.zones.map((z) => `${z.id} ${z.name} (${Math.round(z.x)}, ${Math.round(z.z)}) ${Math.round(z.length)} m`),
          items: layout.items.map((it) => `${it.id} ${it.kind} ${it.label} @(${Math.round(it.x)}, ${it.y.toFixed(1)}, ${Math.round(it.z)}) zone ${it.zone}${it.designKmh ? ` ${it.designKmh} km/h` : ''}${it.signKmh ? ` sign ${it.signKmh}` : ''}`),
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
        'laneGo',
        ((zone: number, a = 0, l = 0, turnDeg = 0, kmh = 0) => {
          const z = layout.zones[Number(zone)]
          const car = getCar('player')
          if (!z || !car?.api) return `no zone ${zone} (0..${layout.zones.length - 1})`
          // A point in the zone's lane: `a` metres along it from its start, `l` metres right of its centre line.
          const x = z.x + z.dx * (Number(a) || 0) - z.dz * (Number(l) || 0)
          const zz = z.z + z.dz * (Number(a) || 0) + z.dx * (Number(l) || 0)
          _p.set(x, track.terrainHeight(x, zz) + SPAWN_LIFT, zz)
          // Facing along the lane, turned turnDeg right (180 = back up the lane).
          const turn = ((Number(turnDeg) || 0) * Math.PI) / 180
          const fx = z.dx * Math.cos(turn) - z.dz * Math.sin(turn)
          const fz = z.dz * Math.cos(turn) + z.dx * Math.sin(turn)
          _fwd.set(fx, 0, fz).normalize()
          _left.crossVectors(_up, _fwd).normalize()
          _basis.makeBasis(_left, _up, _fwd)
          _q.setFromRotationMatrix(_basis)
          car.api.teleport(_p, _q)
          const k = Number(kmh) || 0
          const dev = (window as unknown as { __dev?: Record<string, (v: number) => unknown> }).__dev
          if (k > 0) dev?.setSpeed?.(k)
          // The zone's solids, so a test can tell where each piece (a half pipe's wall) starts and ends.
          const solids = layout.solids
            .filter((s) => s.item >= 0 && layout.items[s.item]?.zone === z.id)
            .map((s) => ({ frame: s.frame, halfWidth: s.halfWidth, taper: s.taper ?? 0, a1: s.top[s.top.length - 1].a, height: Math.max(...s.top.map((p) => p.h)) }))
          return { zone: z.id, name: z.name, lane: [z.x, z.z, z.dx, z.dz], length: z.length, start: [_p.x, _p.y, _p.z], fwd: [fx, fz], kmh: k, solids }
        }) as never,
        'laneGo(zone, a = 0, l = 0, turnDeg = 0, kmh = 0): put the player in stunt-park zone `zone`\'s lane, `a` m along it and `l` m right of its centre line, facing along it turned turnDeg right, moving at kmh; returns the lane and its solids (where a half pipe\'s walls start and end)',
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
      registerDev(
        'padRun',
        ((target: number, kmh = 60, offset = 0, angleDeg = 90, back = 40) => {
          const tg = layout.targets[Number(target)]
          const pad = layout.pads[Number(target)]
          const car = getCar('player')
          if (!tg || !pad || !car?.api) return `no target ${target} (0..${layout.targets.length - 1})`
          // The path: a straight line through the bullseye's middle (or `offset` metres to its right),
          // turned angleDeg right of its lane (90 = straight across the lane, clear of the lane's ramps).
          const turn = ((Number(angleDeg) || 0) * Math.PI) / 180
          const fx = pad.frame.dx * Math.cos(turn) - pad.frame.dz * Math.sin(turn)
          const fz = pad.frame.dz * Math.cos(turn) + pad.frame.dx * Math.sin(turn)
          const rx = -fz
          const rz = fx
          const b = Number(back) || 40
          const off = Number(offset) || 0
          const x = tg.x - fx * b + rx * off
          const z = tg.z - fz * b + rz * off
          _p.set(x, track.terrainHeight(x, z) + SPAWN_LIFT, z)
          _fwd.set(fx, 0, fz).normalize()
          _left.crossVectors(_up, _fwd).normalize()
          _basis.makeBasis(_left, _up, _fwd)
          _q.setFromRotationMatrix(_basis)
          car.api.teleport(_p, _q)
          const k = Number(kmh) || 0
          const dev = (window as unknown as { __dev?: Record<string, (v: number) => unknown> }).__dev
          if (k > 0) dev?.setSpeed?.(k)
          // The ground's own shape along the path (metres along it from the start, ground height), so a
          // test can tell a bump the bullseye adds from the hill it sits on.
          const ground: number[] = []
          for (let d = 0; d <= b * 2 + 1e-6; d += 0.5) ground.push(+track.terrainHeight(x + fx * d, z + fz * d).toFixed(3))
          return { target: tg.id, start: [x, z], dir: [fx, fz], centre: [tg.x, tg.y, tg.z], outer: tg.outer, inner: tg.inner, kmh: k, ground }
        }) as never,
        'padRun(target, kmh = 60, offset = 0, angleDeg = 90, back = 40): put the player `back` m before bullseye `target` (park().items of kind target, in order), on a straight line through its middle (`offset` m to the right of it) turned angleDeg right of its lane, moving at kmh; returns the ground heights every 0.5 m along that line',
      ),
      registerDev(
        'parkLook',
        ((item: number, dist = 30, angleDeg = 60, up = 4, ahead = 0) => {
          const it = layout.items[Number(item)]
          if (!it) return `no item ${item} (0..${layout.items.length - 1})`
          // Look at the item's reference point (a lip, a ring, a target), moved `ahead` metres along its lane.
          const lx = it.x + it.dx * (Number(ahead) || 0)
          const lz = it.z + it.dz * (Number(ahead) || 0)
          const ly = it.y
          // From `dist` metres away: angle 0 = from behind (down the run-in), 90 = from its right, 180 = from beyond.
          const ang = ((Number(angleDeg) || 0) * Math.PI) / 180
          const bx = -it.dx * Math.cos(ang) - it.dz * Math.sin(ang)
          const bz = -it.dz * Math.cos(ang) + it.dx * Math.sin(ang)
          const d = Number(dist) || 30
          const cx = lx + bx * d
          const cz = lz + bz * d
          const cy = Math.max(track.terrainHeight(cx, cz) + 1.5, ly + (Number(up) || 0))
          const name = `at:${[cx, cy, cz, lx, ly, lz].map((v) => v.toFixed(1)).join(',')}`
          const dev = (window as unknown as { __dev?: Record<string, (v: string) => unknown> }).__dev
          dev?.cam?.(name)
          return name
        }) as never,
        'parkLook(item, dist = 30, angleDeg = 60, up = 4, ahead = 0): camera on one stunt-park item (0 = from behind, 90 = its right side, 180 = from beyond), looking at its lip / ring / target moved `ahead` m along the lane',
      ),
      registerDev(
        'ringWait',
        ((ring: number, seconds: number) => {
          const i = Number(ring)
          if (!(i >= 0 && i < ringClock.wait.length)) return `no ring ${ring} (0..${ringClock.wait.length - 1})`
          const s = Number(seconds)
          ringClock.wait[i] = Number.isFinite(s) ? Math.min(comebackSeconds(), Math.max(0, s)) : 0
          return ringWaitDebug()
        }) as never,
        'ringWait(ring, seconds): set a stunt ring counting down (0 = whole now), for looking at the countdown; the rings list is park().items of kind ring, in order',
      ),
      registerPlayInspector('stunts', () => ({
        zones: layout.zones.length,
        items: layout.items.length,
        rings: layout.rings.length,
        ringWait: ringWaitDebug(),
        ringComebackSeconds: comebackSeconds(),
        ringsExploded: ringClock.explodedTotal,
        ringsBack: ringClock.backTotal,
        ringFx: rings.fx.debug(),
        targets: layout.targets.length,
        jumps: layout.jumps.length,
        triangles: built.triangles,
        colliders: built.solids.length,
        layoutMs: Math.round(layout.buildMs),
        skipped: layout.skipped,
        signs: launches.map((l) => `${l.label} ${l.kmh}`),
        lineup: { ...parkCueShown() },
      })),
    ]
    return () => {
      for (const off of offs) off()
    }
  }, [layout, built, track, launches, rings])

  // ---- per frame: the shader clock, the sky's colour, the speed cue and the rings (no allocation) ----
  useFrame((_, delta) => {
    time.value = (time.value + Math.min(delta, 0.1)) % 600
    horizon.value.copy(environment.horizon)
    stepParkCue(launches)
    // The rings' explosions and comebacks hold still while the game is paused.
    rings.fx.update(getGame().phase === 'paused' ? 0 : Math.min(delta, 0.1))
  })

  return (
    <group name="stunt-park">
      <mesh geometry={built.geo} material={material} castShadow receiveShadow frustumCulled={false} />
      {layout.rings.length > 0 && <primitive object={rings.fx.group} />}
    </group>
  )
}
