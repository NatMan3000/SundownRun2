// ============================================================
//  TERRAIN - draws the track's ground as dark glass with a grid
// ------------------------------------------------------------
//  Geometry comes from terrainGeometry.ts (chunks of the height
//  grid, each built at three levels of detail); the look comes from
//  terrainMaterial.ts. Every chunk shares one material, so they all
//  compile into a single shader program.
//
//  Every frame each chunk shows the level of detail its distance
//  from the camera calls for. Swapping a chunk's geometry is just a
//  pointer change (all levels are built up front, at load), and the
//  switch distance has a little slack either way so a chunk on the
//  boundary does not flip back and forth.
//
//  Rebuilds when the track changes, when a live track parameter
//  rebuilds the road (the road tuck follows the road), and when the
//  quality preset changes. Old geometry is disposed.
// ============================================================

import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { PALETTE } from '../core/palette'
import { telemetry } from '../core/telemetry'
import type { QualityLevel } from '../core/settings'
import type { TrackRuntime } from '../track/types'
import { LEVEL_DISTANCE, buildTerrain, buildTunnelHill } from './terrainGeometry'
import { buildOuterGround } from './outerGround'
import { makeTerrainMaterial } from './terrainMaterial'
import { makeNoiseTexture } from './textures'
import { sky } from './sky'
import { worldStats } from './stats'

/** Slack (metres) around each switch distance, so chunks don't flicker between levels. */
const HYSTERESIS = 25

export function Terrain({ track, quality }: { track: TrackRuntime; quality: QualityLevel }) {
  const env = track.file.environment
  const gridHex = env.palette?.grid || PALETTE.grid
  const seed = env.seed

  const noise = useMemo(() => makeNoiseTexture(seed ^ 0x51a7), [seed])
  const { material, uniforms } = useMemo(
    () => makeTerrainMaterial(noise, gridHex, track.terrain.minHeight, track.terrain.maxHeight),
    [noise, gridHex, track.terrain.minHeight, track.terrain.maxHeight],
  )
  const build = useMemo(() => buildTerrain(track, quality), [track, quality])
  const outer = useMemo(() => buildOuterGround(track), [track])
  // The hill over every tunnel, in the same material (one more draw).
  const tunnelHill = useMemo(() => buildTunnelHill(track, build), [track, build])

  // One mesh per chunk, starting at the far level; useFrame picks the real one.
  const { group, meshes, level } = useMemo(() => {
    const g = new THREE.Group()
    g.name = 'world-terrain'
    const list: THREE.Mesh[] = []
    for (const c of build.chunks) {
      const m = new THREE.Mesh(c.levels[2], material)
      m.receiveShadow = true
      m.castShadow = false
      m.matrixAutoUpdate = false
      g.add(m)
      list.push(m)
    }
    // The land beyond the world's edge, in the same material (one more draw).
    const apron = new THREE.Mesh(outer, material)
    apron.name = 'world-outer-ground'
    apron.receiveShadow = false
    apron.matrixAutoUpdate = false
    g.add(apron)
    if (tunnelHill) {
      const hill = new THREE.Mesh(tunnelHill, material)
      hill.name = 'world-tunnel-hill'
      hill.receiveShadow = true
      hill.castShadow = true
      hill.matrixAutoUpdate = false
      g.add(hill)
    }
    return { group: g, meshes: list, level: new Int8Array(build.chunks.length).fill(2) }
  }, [build, material, outer, tunnelHill])

  useEffect(() => {
    worldStats.terrainChunks = build.chunks.length
    worldStats.terrainStrides = build.strides.join('/')
    return () => {
      for (const c of build.chunks) for (const g of c.levels) g.dispose()
    }
  }, [build])
  useEffect(() => {
    worldStats.outerGroundTriangles = (outer.index?.count ?? 0) / 3
    return () => outer.dispose()
  }, [outer])
  useEffect(() => () => tunnelHill?.dispose(), [tunnelHill])
  useEffect(() => () => material.dispose(), [material])
  useEffect(() => () => noise.dispose(), [noise])

  useFrame((state) => {
    uniforms.uCarPos.value.copy(telemetry.carPosition)
    uniforms.uNight.value = sky.night

    const cam = state.camera.position
    let tris = 0
    for (let i = 0; i < meshes.length; i++) {
      const c = build.chunks[i]
      // Distance from the camera to the chunk's square (0 when above it).
      const dx = cam.x < c.minX ? c.minX - cam.x : cam.x > c.maxX ? cam.x - c.maxX : 0
      const dz = cam.z < c.minZ ? c.minZ - cam.z : cam.z > c.maxZ ? cam.z - c.maxZ : 0
      const d = Math.sqrt(dx * dx + dz * dz)
      let want = c.pinNear ? 0 : level[i]
      if (c.pinNear) {
        // (A tunnel reaches into this chunk: always the near level, see terrainGeometry.ts.)
      } else if (want === 0 && d > LEVEL_DISTANCE[0] + HYSTERESIS) want = 1
      if (!c.pinNear) {
        if (want === 1 && d > LEVEL_DISTANCE[1] + HYSTERESIS) want = 2
        if (want === 2 && d < LEVEL_DISTANCE[1] - HYSTERESIS) want = 1
        if (want === 1 && d < LEVEL_DISTANCE[0] - HYSTERESIS) want = 0
      }
      if (want !== level[i]) {
        level[i] = want
        meshes[i].geometry = c.levels[want]
      }
      tris += c.triangles[want]
    }
    worldStats.terrainTriangles = tris
  })

  return <primitive object={group} />
}
