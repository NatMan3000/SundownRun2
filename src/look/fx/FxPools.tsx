// ============================================================
//  FX POOLS - installs the fx API (core/api.ts) and runs it
// ------------------------------------------------------------
//  Gameplay never imports the look system. It calls fx.shards(),
//  fx.sparks() and fx.pulse() from core/api.ts; this component
//  plugs our pooled particle systems into those calls when it
//  mounts, and steps them once per frame.
//
//  Dev:  __dev.fxTest('shards' | 'sparks' | 'pulse') fires one in
//        front of the camera, so a checker can see each effect.
// ============================================================

import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { installFx } from '../../core/api'
import type { BurstOptions } from '../../core/api'
import { PALETTE } from '../../core/palette'
import { useGame } from '../../core/store'
import { registerDev } from '../../core/devHandles'
import { getTrack } from '../../track/current'
import type { NearestHit } from '../../track/types'
import { QUALITY_PRESETS } from '../quality'
import { lookState } from '../lookState'
import { PulsePool, ShardPool, SparkPool } from './Particles'

const HIGH = QUALITY_PRESETS.high
const hit: NearestHit = { s: 0, index: 0, lateral: 0, height: 0, distance: 0, onRoad: false }

/** The surface height under a point: the road if we are over it, else the terrain. */
function groundBelow(x: number, y: number, z: number): number {
  const track = getTrack()
  if (!track) return y - 1.5
  let g = track.terrainHeight(x, z)
  track.nearest(x, y, z, hit)
  if (hit.onRoad) g = Math.max(g, y - hit.height)
  return Number.isFinite(g) ? g : y - 1.5
}

const _fwd = new THREE.Vector3()

export function FxPools() {
  const level = useGame((s) => s.qualityLevel)
  const camera = useThree((s) => s.camera)

  const pools = useMemo(
    () => ({
      shards: new ShardPool(HIGH.shardCap),
      sparks: new SparkPool(HIGH.sparkCap, PALETTE.coreHot, PALETTE.chevron),
      pulses: new PulsePool(HIGH.pulseCap),
    }),
    [],
  )

  useEffect(() => {
    const p = QUALITY_PRESETS[level]
    pools.shards.setCap(p.shardCap)
    pools.sparks.setCap(p.sparkCap)
    pools.pulses.setCap(p.pulseCap)
    lookState.fx.shardCap = p.shardCap
    lookState.fx.sparkCap = p.sparkCap
  }, [level, pools])

  useEffect(() => {
    installFx({
      shards: (o: BurstOptions) => {
        const { x, y, z } = o.position
        if (!Number.isFinite(x + y + z)) return
        const v = o.velocity
        pools.shards.emit(
          x, y, z,
          v?.x ?? 0, v?.y ?? 0, v?.z ?? 0,
          o.color, Math.max(1, Math.round(o.count)), Math.max(0.5, o.speed),
          o.size ?? 0.25, o.life ?? 1.6, groundBelow(x, y, z),
        )
      },
      sparks: (pos, normal, intensity) => {
        if (!Number.isFinite(pos.x + pos.y + pos.z)) return
        pools.sparks.emit(pos.x, pos.y, pos.z, normal.x, normal.y, normal.z, intensity, groundBelow(pos.x, pos.y, pos.z))
      },
      pulse: (pos, color, radius) => {
        if (!Number.isFinite(pos.x + pos.y + pos.z)) return
        pools.pulses.emit(pos.x, pos.y + 0.12, pos.z, color, Math.max(0.5, radius))
      },
    })
    return () => {
      pools.shards.dispose()
      pools.sparks.dispose()
      pools.pulses.dispose()
    }
  }, [pools])

  useEffect(
    () =>
      registerDev(
        'fxTest',
        ((kind: 'shards' | 'sparks' | 'pulse' = 'shards') => {
          camera.getWorldDirection(_fwd)
          const at = camera.position.clone().addScaledVector(_fwd, 14)
          if (kind === 'sparks') {
            pools.sparks.emit(at.x, at.y, at.z, -_fwd.x, 0.3, -_fwd.z, 1, groundBelow(at.x, at.y, at.z))
          } else if (kind === 'pulse') {
            pools.pulses.emit(at.x, groundBelow(at.x, at.y, at.z) + 0.12, at.z, PALETTE.boost, 6)
          } else {
            pools.shards.emit(at.x, at.y, at.z, 0, 0, 0, PALETTE.propCube, 40, 7, 0.3, 1.6, groundBelow(at.x, at.y, at.z))
          }
          return `${kind} fired 14 m in front of the camera`
        }) as (...args: never[]) => unknown,
        "fxTest('shards'|'sparks'|'pulse') - fire one effect 14 m in front of the camera",
      ),
    [camera, pools],
  )

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05)
    pools.shards.update(dt)
    pools.sparks.update(dt)
    pools.pulses.update(dt)
    lookState.fx.shardsAlive = pools.shards.alive
    lookState.fx.sparksAlive = pools.sparks.alive
    lookState.fx.pulsesAlive = pools.pulses.alive
  })

  return (
    <>
      <primitive object={pools.shards.mesh} />
      <primitive object={pools.sparks.mesh} />
      <primitive object={pools.pulses.mesh} />
    </>
  )
}
