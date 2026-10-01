// ============================================================
//  BRIDGE PYLON COLLIDERS - the pylons are solid
// ------------------------------------------------------------
//  Anything that looks solid is solid (CONSTITUTION section 5,
//  Consistency). The pylons under a bridge stand off the road, but
//  you can drive under a bridge off-road, so each one gets a static
//  box collider exactly the size of the drawn column (same
//  placement: trackPylons() in pylons.ts).
//
//  They are world colliders tagged as 'barrier', built with the
//  track's own barrier settings (track/colliders.ts), so a car that
//  hits one slides and crashes the way it does against a stadium
//  wall, and the crash event says 'barrier'.
//
//  Mount inside <Physics>. Rebuilt when the track changes or a live
//  parameter rebuilds the road (useTrack() hands over a new runtime);
//  everything is removed again on unmount. A pylon with a
//  non-finite number is skipped (NaN firewall).
//
//  Dev (for checkers):
//    __dev.pylonAim(i, metres = 25)  put the player on the ground
//        beside the bridge, facing pylon i from that far away
//    __dev.pylonWatch(on = true)     start (or stop) recording how
//        close every car gets to any pylon; read it with
//        __game.get('pylons')
// ============================================================

import { useEffect } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { useRapier } from '@react-three/rapier'
import { finite3 } from '../../core/physics'
import { cars } from '../../core/telemetry'
import { getGame, useGame } from '../../core/store'
import { registerDev, registerInspector } from '../../core/devHandles'
import { useTrack } from '../../track/current'
import { add, removeColliderSet, type ColliderSet } from '../../track/colliders'
import type { TrackRuntime } from '../../track/types'
import { PYLON_BURY, PYLON_WIDTH, trackPylons, type Pylon } from './pylons'

/** Closest-approach recorder for pylonWatch (no allocation per frame once a car is known). */
const watch = {
  on: false,
  frames: 0,
  /** Car id -> closest gap (metres) between the car's centre line and a pylon's face, while below the deck. */
  closest: {} as Record<string, number>,
  /** Car id -> index of that closest pylon. */
  which: {} as Record<string, number>,
}

let current: { track: TrackRuntime; pylons: readonly Pylon[]; colliders: number } | null = null

const _p = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _up = new THREE.Vector3(0, 1, 0)

function pylonAim(i: number, metres: number): string {
  if (!current) return 'no pylons on this track'
  const p = current.pylons[i]
  if (!p) return `no pylon ${i} (there are ${current.pylons.length})`
  const player = cars.find((c) => c.id === 'player')
  if (!player?.api) return 'no player car'
  if (getGame().phase !== 'playing') return 'not playing'
  const t = current.track
  const S = t.samples
  const k = ((Math.round(p.s / S.ds) % S.count) + S.count) % S.count
  // come in from outside the bridge, square to it, so the run-up is clear of the other pylons
  let ox = S.rx[k] * p.side
  let oz = S.rz[k] * p.side
  const ol = Math.hypot(ox, oz) || 1
  ox /= ol
  oz /= ol
  const sx = p.x + ox * metres
  const sz = p.z + oz * metres
  const ground = t.terrainHeight(sx, sz)
  if (!finite3(sx, ground, sz)) return 'start spot is not finite'
  _p.set(sx, ground + 0.9, sz)
  _q.setFromAxisAngle(_up, Math.atan2(p.x - sx, p.z - sz)) // nose (+z) toward the pylon
  player.api.teleport(_p, _q)
  return `player ${metres} m from pylon ${i} (${p.x.toFixed(1)}, ${p.z.toFixed(1)}, ${p.height.toFixed(1)} m tall), facing it`
}

export function BridgePylonColliders() {
  const { world, rapier } = useRapier()
  const track = useTrack()
  const paramVersion = useGame((s) => s.trackParamVersion)

  useEffect(() => {
    if (!track) return
    const pylons = trackPylons(track)
    if (pylons.length === 0) {
      current = { track, pylons, colliders: 0 }
      return () => {
        current = null
      }
    }
    const set: ColliderSet = { body: world.createRigidBody(rapier.RigidBodyDesc.fixed()), handles: [] }
    for (let i = 0; i < pylons.length; i++) {
      const p = pylons[i]
      const half = (p.height + PYLON_BURY) / 2
      const cy = p.footY - PYLON_BURY + half
      if (!finite3(p.x, cy, p.z) || !Number.isFinite(half) || !Number.isFinite(p.heading) || half <= 0) {
        console.error('[look] pylon', i, 'has a non-finite or empty shape; no collider built for it')
        continue
      }
      const desc = rapier.ColliderDesc.cuboid(PYLON_WIDTH / 2, half, PYLON_WIDTH / 2)
        .setTranslation(p.x, cy, p.z)
        .setRotation({ x: 0, y: Math.sin(p.heading / 2), z: 0, w: Math.cos(p.heading / 2) })
      add(world, rapier, set, desc, 'barrier')
    }
    current = { track, pylons, colliders: set.handles.length }
    return () => {
      removeColliderSet(world, set)
      current = null
    }
  }, [world, rapier, track, paramVersion])

  useEffect(() => {
    const offAim = registerDev(
      'pylonAim',
      ((i = 0, metres = 25) => pylonAim(i, metres)) as never,
      'pylonAim(i, metres = 25): put the player on the ground beside the bridge, facing pylon i (test that pylons are solid)',
    )
    const offWatch = registerDev(
      'pylonWatch',
      ((on = true) => {
        watch.on = !!on
        if (watch.on) {
          watch.frames = 0
          watch.closest = {}
          watch.which = {}
        }
        return watch.on ? 'recording every car\'s closest approach to a pylon: __game.get("pylons")' : 'stopped'
      }) as never,
      'pylonWatch(on = true): record how close every car gets to any bridge pylon (read with __game.get("pylons"))',
    )
    const offInspect = registerInspector('pylons', () => ({
      count: current?.pylons.length ?? 0,
      colliders: current?.colliders ?? 0,
      watching: watch.on,
      framesWatched: watch.frames,
      closestGapMetres: watch.closest,
      closestPylon: watch.which,
      list: current?.pylons.map((p, i) => ({ i, s: Math.round(p.s), side: p.side, x: +p.x.toFixed(1), z: +p.z.toFixed(1), height: +p.height.toFixed(1) })) ?? [],
    }))
    return () => {
      offAim()
      offWatch()
      offInspect()
    }
  }, [])

  // pylonWatch: each car's closest approach to a pylon face while it is below the deck
  useFrame(() => {
    if (!watch.on || !current || current.pylons.length === 0) return
    watch.frames++
    const pylons = current.pylons
    for (let c = 0; c < cars.length; c++) {
      const car = cars[c]
      if (car.kind === 'ghost') continue
      const cp = car.position
      for (let i = 0; i < pylons.length; i++) {
        const p = pylons[i]
        if (cp.y < p.footY - 1 || cp.y > p.footY + p.height) continue
        const gap = Math.hypot(cp.x - p.x, cp.z - p.z) - PYLON_WIDTH / 2
        const best = watch.closest[car.id]
        if (best === undefined || gap < best) {
          watch.closest[car.id] = gap
          watch.which[car.id] = i
        }
      }
    }
  })

  return null
}
