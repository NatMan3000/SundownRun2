// ============================================================
//  ROAD VIEW - draws the track's road ribbon
// ------------------------------------------------------------
//  The track worker builds the road as plain numbers (positions,
//  normals and the shader attributes, src/track/types.ts). This
//  turns them into three.js meshes with the wet neon road material
//  on top and a dark slab material on the sides.
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
import { dashPeriodFor, lanesFor, makeRoadMaterial, makeRoadUniforms } from './roadMaterial'
import type { RoadLook, RoadUniforms } from './roadMaterial'
import { makeSkirtMaterial } from './skirtMaterial'

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

export function roadLookFor(track: Pick<TrackRuntime, 'file' | 'length'>): RoadLook {
  return {
    edge: track.file.environment.palette?.edge ?? PALETTE.roadEdge,
    lanes: lanesFor(track.file.road.width),
    dashPeriod: dashPeriodFor(track.length),
  }
}

/** Per-frame uniforms shared by every road material instance. */
export function tickRoadUniforms(u: RoadUniforms, elapsed: number): void {
  // Wrapped so the shader's float time stays precise in long sessions (pulse cycles fit 600 s exactly).
  u.uTime.value = elapsed % 600
  u.uNight.value = environment.night
}

function triCount(g: THREE.BufferGeometry): number {
  return g.index ? g.index.count / 3 : g.attributes.position.count / 3
}

export function RoadView() {
  const track = useTrack()

  const built = useMemo(() => {
    if (!track) return null
    const look = roadLookFor(track)
    const uniforms = makeRoadUniforms(look)
    const road = geometryFrom(track.meshes.road)
    const skirt = geometryFrom(track.meshes.skirt)
    const roadMat = makeRoadMaterial(uniforms)
    const skirtMat = makeSkirtMaterial(uniforms)
    lookState.road.triangles = triCount(road) + triCount(skirt)
    lookState.road.lanes = look.lanes
    lookState.road.edgeColor = look.edge
    lookState.road.rebuilds++
    return { uniforms, road, skirt, roadMat, skirtMat }
  }, [track])

  useEffect(
    () => () => {
      if (!built) return
      built.road.dispose()
      built.skirt.dispose()
      built.roadMat.dispose()
      built.skirtMat.dispose()
    },
    [built],
  )

  useFrame((state) => {
    if (built) tickRoadUniforms(built.uniforms, state.clock.elapsedTime)
  })

  if (!built) return null
  return (
    <group name="road">
      <mesh geometry={built.road} material={built.roadMat} receiveShadow />
      <mesh geometry={built.skirt} material={built.skirtMat} receiveShadow />
    </group>
  )
}
