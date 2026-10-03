// ============================================================
//  ROAD VIEW - draws the track's road ribbon
// ------------------------------------------------------------
//  The track worker builds the road as plain numbers (positions,
//  normals and the shader attributes, src/track/types.ts). This
//  turns them into three.js meshes with the wet neon road material
//  on top and a dark slab material on the sides.
//
//  Under every raised stretch it stands slim neon pylons
//  (BridgePylons.tsx, placed by pylons.ts), so a bridge reads as a
//  bridge and not a slab floating across the sky.
//
//  Inside every tunnel it draws the walls and ceiling (tunnelMaterial.ts:
//  dark, lit by glowing strips). The hill over a tunnel is part of the
//  ground and is drawn with it (world/Terrain.tsx).
//
//  It rebuilds when the track changes (trackVersion) or when a
//  live parameter like the Hyperdrome's bank angle moves
//  (trackParamVersion): useTrack() hands us a new runtime then, and
//  the old geometry is disposed.
// ============================================================

import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { PALETTE } from '../../core/palette'
import { environment } from '../../core/telemetry'
import { useTrack } from '../../track/current'
import type { MeshBuffers, TrackRuntime } from '../../track/types'
import { lookState } from '../lookState'
import { registerDev } from '../../core/devHandles'
import { ROAD_TUNE, dashPeriodFor, lapPeriodFor, lanesFor, makeRoadMaterial, makeRoadUniforms } from './roadMaterial'
import type { RoadLook, RoadUniforms } from './roadMaterial'
import { makeSkirtMaterial } from './skirtMaterial'
import { makeBarrierMaterial, makeRampMaterial } from './pieceMaterials'
import { makeTunnelMaterial } from './tunnelMaterial'
import { SpeedTrapSigns } from './SpeedTrapSign'
import { skirtExtras } from './skirtExtras'
import { trackPylons } from './pylons'
import { BridgePylons } from './BridgePylons'
import { headlightState } from '../fx/HeadlightRig'

/** Wrap the runtime's arrays in a BufferGeometry (no copies: the arrays are shared). */
export function geometryFrom(buf: MeshBuffers): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(buf.positions, 3))
  g.setAttribute('normal', new THREE.BufferAttribute(buf.normals, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(buf.uvs, 2))
  for (const name of Object.keys(buf.attributes)) {
    const a = buf.attributes[name]
    g.setAttribute(name, new THREE.BufferAttribute(a.array, a.itemSize))
  }
  g.setIndex(new THREE.BufferAttribute(buf.indices, 1))
  g.computeBoundingSphere()
  return g
}

export function roadLookFor(track: Pick<TrackRuntime, 'file' | 'length' | 'boostZones' | 'speedTraps' | 'pieces'>): RoadLook {
  const env = track.file.environment
  const city = env.city
  return {
    edge: track.file.environment.palette?.edge ?? PALETTE.roadEdge,
    lanes: lanesFor(track.file.road.width),
    dashPeriod: dashPeriodFor(track.length),
    length: track.length,
    boosts: track.boostZones.map((z) => ({ s0: z.s0, s1: z.s1, lat0: z.lat0, lat1: z.lat1 })),
    traps: track.speedTraps.map((t) => t.s),
    loops: track.pieces.filter((p) => p.type === 'loop').map((p) => ({ s0: p.s0, s1: p.s1 })),
    walls: track.pieces.filter((p) => p.type === 'wallride').map((p) => ({ s0: p.s0, s1: p.s1 })),
    city: city ? { azimuthDeg: city.azimuthDeg ?? env.sky?.sunAzimuthDeg ?? 0, arcDeg: city.arcDeg ?? 120 } : null,
  }
}

/** Per-frame uniforms shared by every road material instance. */
export function tickRoadUniforms(u: RoadUniforms, elapsed: number): void {
  // Wrapped so the shader's float time stays precise in long sessions (every animation cycle divides 600 s).
  u.uTime.value = elapsed % 600
  u.uNight.value = environment.night
  u.uKeySpec.value = ROAD_TUNE.keySpec
  u.uKeyCap.value = Math.max(0.05, ROAD_TUNE.nightKeyCap)
  u.uKeyCapOn.value = environment.night
  u.uHeadOn.value = headlightState.strength * ROAD_TUNE.headPool
  u.uHeadPos.value.copy(headlightState.position)
  u.uHeadDir.value.copy(headlightState.direction)
  // windows come on from timeOfDay 0.2 to 0.9 (constitution)
  u.uCityOn.value = THREE.MathUtils.smoothstep(environment.timeOfDay, 0.2, 0.9)
  u.uHorizon.value.copy(environment.horizon)
}

function triCount(g: THREE.BufferGeometry): number {
  return g.index ? g.index.count / 3 : g.attributes.position.count / 3
}

export function RoadView() {
  const track = useTrack()

  useEffect(
    () =>
      registerDev(
        'lookRoad',
        ((opts?: Partial<typeof ROAD_TUNE>) => {
          if (opts && typeof opts === 'object') {
            for (const key of Object.keys(opts) as (keyof typeof ROAD_TUNE)[]) {
              const v = opts[key]
              if (key in ROAD_TUNE && typeof v === 'number' && Number.isFinite(v)) ROAD_TUNE[key] = v
            }
          }
          return { ...ROAD_TUNE }
        }) as (...args: never[]) => unknown,
        'lookRoad({ keySpec, nightKeyCap, headPool }) - the key light\'s mirror highlight on the wet road (share kept, night soft cap) and the headlight pool strength; no argument returns the values',
      ),
    [],
  )

  const built = useMemo(() => {
    if (!track) return null
    const look = roadLookFor(track)
    const uniforms = makeRoadUniforms(look)
    const road = geometryFrom(track.meshes.road)
    const skirt = geometryFrom(track.meshes.skirt)
    // slab thickness + air underneath, per vertex, for the bottom-edge light strip
    const extras = skirtExtras(track)
    skirt.setAttribute('aSlabT', new THREE.BufferAttribute(extras.slabT, 1))
    skirt.setAttribute('aLift', new THREE.BufferAttribute(extras.lift, 1))
    const pylons = trackPylons(track)
    const roadMat = makeRoadMaterial(uniforms)
    const skirtMat = makeSkirtMaterial(uniforms)
    const ramps = track.meshes.ramps ? geometryFrom(track.meshes.ramps) : null
    const rampMat = ramps ? makeRampMaterial(uniforms.uTime) : null
    const barriers = track.meshes.barriers ? geometryFrom(track.meshes.barriers) : null
    const pal = track.file.environment.palette
    const barrierMat = barriers
      ? makeBarrierMaterial(uniforms.uTime, uniforms.uHorizon, {
          rail: pal?.edge ?? PALETTE.roadEdge,
          band: pal?.edgeAlt ?? PALETTE.roadEdgeAlt,
          height: track.file.road.barrierHeight,
          bandPeriod: lapPeriodFor(track.length, 64),
        })
      : null
    const tunnels = track.meshes.tunnels ? geometryFrom(track.meshes.tunnels.inside) : null
    const tunnelMat = tunnels ? makeTunnelMaterial(look.edge).material : null
    lookState.road.triangles =
      triCount(road) + triCount(skirt) + (ramps ? triCount(ramps) : 0) + (barriers ? triCount(barriers) : 0) + (tunnels ? triCount(tunnels) : 0)
    lookState.road.lanes = look.lanes
    lookState.road.edgeColor = look.edge
    lookState.road.rebuilds++
    lookState.road.pylons = pylons.length
    return { uniforms, road, skirt, roadMat, skirtMat, ramps, rampMat, barriers, barrierMat, tunnels, tunnelMat, pylons, edge: look.edge }
  }, [track])

  useEffect(
    () => () => {
      if (!built) return
      built.road.dispose()
      built.skirt.dispose()
      built.roadMat.dispose()
      built.skirtMat.dispose()
      built.ramps?.dispose()
      built.rampMat?.dispose()
      built.barriers?.dispose()
      built.barrierMat?.dispose()
      built.tunnels?.dispose()
      built.tunnelMat?.dispose()
    },
    [built],
  )

  useFrame((state) => {
    if (built) tickRoadUniforms(built.uniforms, state.clock.elapsedTime)
  })

  if (!built) return null
  return (
    <group name="road">
      <mesh name="road-surface" geometry={built.road} material={built.roadMat} receiveShadow />
      <mesh name="road-skirt" geometry={built.skirt} material={built.skirtMat} receiveShadow />
      {built.ramps && built.rampMat && <mesh name="road-ramps" geometry={built.ramps} material={built.rampMat} castShadow receiveShadow />}
      {built.barriers && built.barrierMat && (
        <mesh name="road-barriers" geometry={built.barriers} material={built.barrierMat} receiveShadow />
      )}
      {built.tunnels && built.tunnelMat && <mesh name="road-tunnels" geometry={built.tunnels} material={built.tunnelMat} />}
      {track && track.speedTraps.length > 0 && <SpeedTrapSigns track={track} time={built.uniforms.uTime} />}
      <BridgePylons pylons={built.pylons} edge={built.edge} />
    </group>
  )
}
