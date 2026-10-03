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
//
//  Each frame it also writes telemetry.tunnel: how far inside a
//  covered tunnel the player's car is (0..1).
// ============================================================

import { useEffect, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { useRapier } from '@react-three/rapier'
import { telemetry } from '../core/telemetry'
import { useGame } from '../core/store'
import { registerDev, registerInspector } from '../core/devHandles'
import { getTrack, setTrackParam, useTrack } from './current'
import { createRoadColliders, createWorldColliders, removeColliderSet } from './colliders'
import { trackInternals } from './build'
import { createTerrainTiles, removeTerrainTiles, updateTerrainTiles, type TerrainTiles } from './terrainTiles'
import type { TrackRuntime } from './types'

/** Collider build timings, for trackInfo(). */
const timing = { worldMs: 0, roadMs: 0, tilesRebuilt: 0 }

export function TrackPhysics() {
  const { world, rapier } = useRapier()
  const track = useTrack()
  const paramVersion = useGame((s) => s.trackParamVersion)
  const tiles = useRef<{ tiles: TerrainTiles; builtFrom: TrackRuntime } | null>(null)

  // World edge, catch floor and the ground: once per track (this component remounts with <Physics>).
  useEffect(() => {
    const t = getTrack()
    if (!t) return
    const t0 = performance.now()
    const set = createWorldColliders(world, rapier, t)
    tiles.current = { tiles: createTerrainTiles(world, rapier, t), builtFrom: t }
    timing.worldMs = performance.now() - t0
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
    timing.roadMs = performance.now() - t0
    timing.tilesRebuilt = changedTiles
    if (paramVersion > 0) console.info(`[track] road colliders rebuilt in ${timing.roadMs.toFixed(1)} ms (${changedTiles} ground tiles)`)
    return () => removeColliderSet(world, set)
  }, [world, rapier, track, paramVersion])

  // How far inside a tunnel the player's car is (telemetry.tunnel): the cover value under the
  // roof at its spot on the road, 0 anywhere else (the hill over a tunnel included).
  useFrame(() => {
    const t = getTrack()
    const ts = t && t.tunnels.length ? trackInternals(t)?.tunnels : null
    if (!t || !ts) {
      telemetry.tunnel = 0
      return
    }
    const S = t.samples
    const i = ((Math.round(telemetry.trackS / S.ds) % S.count) + S.count) % S.count
    const under = ts.covered[i] === 1 && telemetry.carPosition.y < ts.ceil[i] && Math.abs(telemetry.lateral) < S.halfWidth[i] + 1
    const v = under ? ts.cover[i] : 0
    telemetry.tunnel = Number.isFinite(v) ? v : 0
  })

  return null
}

// ---- dev affordances (module level: registered once) ----
registerInspector('track', () => getTrack())
// The world edge as the world worker needs it: ridge height round the compass, and the sunset notch.
registerInspector('trackRidge', () => {
  const t = getTrack()
  const x = t ? trackInternals(t) : undefined
  if (!t || !x) return null
  const nat = x.nat
  const base = t.file.environment.terrain.height ?? 0
  const skyline: { bearingDeg: number; crestY: number }[] = []
  for (let b = 0; b < 360; b += 10) skyline.push({ bearingDeg: b, crestY: base + nat.ridgeRiseAtBearing(b) })
  return { edge: nat.edge, riseM: nat.ridgeRise, footMinRounded: nat.ridgeFootMin, notch: nat.notch, skyline }
})
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
      colliderMs: { groundAndEdge: Math.round(timing.worldMs), road: Math.round(timing.roadMs), tilesRebuilt: timing.tilesRebuilt },
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
