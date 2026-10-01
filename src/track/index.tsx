// ============================================================
//  TRACK PHYSICS - mounts the track's colliders in the rapier world
// ------------------------------------------------------------
//  App.tsx mounts <TrackPhysics /> inside <Physics>. It builds the
//  colliders imperatively (colliders.ts) rather than as hundreds of
//  React elements: one WASM call each, no reconciling.
//
//  - A whole new track arrives as a new <Physics> (App remounts it
//    on trackVersion), so this component simply mounts again.
//  - A live parameter change (the Hyperdrome bank slider) bumps
//    trackParamVersion: the road set is swapped for a new one in the
//    same world, and only the ground tiles whose heights changed are
//    rebuilt, so the car keeps driving on the new banking.
//
//  Dev handles (window.__dev):
//    trackInfo()           summary of the current track build
//    trackRebuild(bank?)   rebuild the road live (optionally at a bank angle)
//  Inspector (window.__game.get('track')): the current TrackRuntime.
// ============================================================

import { useEffect, useRef } from 'react'
import { useRapier } from '@react-three/rapier'
import { useGame } from '../core/store'
import { registerDev, registerInspector } from '../core/devHandles'
import { getTrack, setTrackParam, useTrack } from './current'
import { createRoadColliders, createWorldColliders, removeColliderSet } from './colliders'
import { trackInternals } from './build'
import { createTerrainTiles, removeTerrainTiles, updateTerrainTiles, type TerrainTiles } from './terrainTiles'
import type { TrackRuntime } from './types'

export function TrackPhysics() {
  const { world, rapier } = useRapier()
  const track = useTrack()
  const paramVersion = useGame((s) => s.trackParamVersion)
  const tiles = useRef<{ tiles: TerrainTiles; builtFrom: TrackRuntime } | null>(null)

  // World edge, catch floor and the ground: once per track (this component remounts with <Physics>).
  useEffect(() => {
    const t = getTrack()
    if (!t) return
    const set = createWorldColliders(world, rapier, t)
    tiles.current = { tiles: createTerrainTiles(world, rapier, t), builtFrom: t }
    return () => {
      removeColliderSet(world, set)
      if (tiles.current) removeTerrainTiles(world, tiles.current.tiles)
      tiles.current = null
    }
  }, [world, rapier])

  // Road, skirt, barriers, ramps: rebuilt in place on live parameter changes,
  // along with any ground tiles the new cut-and-fill changed.
  useEffect(() => {
    const t = getTrack()
    if (!t) return
    const t0 = performance.now()
    const set = createRoadColliders(world, rapier, t)
    let changedTiles = 0
    if (tiles.current && tiles.current.builtFrom !== t) {
      changedTiles = updateTerrainTiles(world, rapier, tiles.current.tiles, t)
      tiles.current.builtFrom = t
    }
    if (paramVersion > 0) console.info(`[track] road colliders rebuilt in ${(performance.now() - t0).toFixed(1)} ms (${changedTiles} ground tiles)`)
    return () => removeColliderSet(world, set)
  }, [world, rapier, track, paramVersion])

  return null
}

// ---- dev affordances (module level: registered once) ----
registerInspector('track', () => getTrack())
registerDev(
  'trackInfo',
  () => {
    const t = getTrack()
    if (!t) return null
    const x = trackInternals(t)
    return {
      id: t.id,
      key: t.key,
      lengthM: Math.round(t.length),
      samples: t.samples.count,
      pieces: t.pieces.map((p) => `${p.type}@${p.s0.toFixed(0)}`),
      cores: t.cores.length,
      props: t.props.length,
      posts: t.roadside.posts.length,
      billboards: t.roadside.billboards.length,
      checkpoints: t.checkpoints.length,
      terrainCells: t.terrain.n,
      world: t.world,
      params: t.params,
      buildMs: x ? Math.round(x.buildMs) : null,
    }
  },
  'summary of the current track build',
)
registerDev(
  'trackRebuild',
  (bankDeg?: number) => {
    const t = getTrack()
    if (!t) return null
    const t0 = performance.now()
    setTrackParam('bankDeg', typeof bankDeg === 'number' ? bankDeg : (t.params.bankDeg ?? 0))
    return { ms: Math.round((performance.now() - t0) * 10) / 10, bankDeg: getTrack()?.params.bankDeg }
  },
  'rebuild the road in place (optionally at a new bank angle, Hyperdrome)',
)
