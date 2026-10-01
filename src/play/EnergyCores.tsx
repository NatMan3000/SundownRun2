// ============================================================
//  ENERGY CORES - the free-roam hunt
// ------------------------------------------------------------
//  Each round deals `track.file.hunt.count` cores to spots picked
//  from track.cores (seeded by track and round, so a round is the
//  same every time you load it and different from the next one).
//  They float, bob and turn: a violet crystal shell around a
//  white-hot centre (T2), a turning ring, and a faint light beam
//  rising from each one so you can spot it from across the map.
//
//  Drive any part of your car within PICKUP_R metres of a core to
//  collect it. The HUNT CLOCK starts on the round's first pickup and
//  stops on the last; your best time is saved per track.
//
//  Live in free roam only (modes.ts). Four instanced meshes for all
//  the cores, nothing allocated per frame.
// ============================================================

import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { telemetry, getCar } from '../core/telemetry'
import { getGame, useGame } from '../core/store'
import { emit } from '../core/events'
import { fx } from '../core/api'
import { offerRecord } from '../core/records'
import { showResults } from '../core/session'
import { GLOW, PALETTE } from '../core/palette'
import { registerDev } from '../core/devHandles'
import { useTrack } from '../track/current'
import type { TrackRuntime } from '../track/types'
import { playFlags } from './modes'
import { mulberry32, roundSeed, shuffleInPlace } from './random'
import { carHalfLength, carHalfWidth } from './simCars'
import { registerPlayInspector } from './inspect'
import { aimAt } from './Smashables'

/** Pick up when any part of the car comes within this many metres. */
const PICKUP_R = 3
const POP_S = 0.35
const BEAM_H = 46
const CAR_HALF_H = 0.7

const _obj = new THREE.Object3D()
const _local = new THREE.Vector3()
const _invQ = new THREE.Quaternion()
const _pulsePos = { x: 0, y: 0, z: 0 }

export function EnergyCores() {
  const track = useTrack()
  if (!track || track.cores.length === 0) return null
  return <CoreField key={track.key} track={track} />
}

interface HuntState {
  round: number
  /** Indices into track.cores dealt this round. */
  picks: number[]
  alive: boolean[]
  popT: number[]
  time: number
}

function dealCores(track: TrackRuntime, round: number): number[] {
  const all = track.cores.map((_, i) => i)
  shuffleInPlace(all, mulberry32(roundSeed(track.key, round, 11)))
  const want = Math.max(1, Math.min(all.length, track.file.hunt.count))
  return all.slice(0, want)
}

function CoreField({ track }: { track: TrackRuntime }) {
  const shellRef = useRef<THREE.InstancedMesh>(null)
  const hotRef = useRef<THREE.InstancedMesh>(null)
  const ringRef = useRef<THREE.InstancedMesh>(null)
  const beamRef = useRef<THREE.InstancedMesh>(null)
  const max = track.cores.length

  const st = useMemo<HuntState>(() => ({ round: -1, picks: [], alive: [], popT: [], time: 0 }), [])

  const res = useMemo(() => {
    const shellGeo = new THREE.IcosahedronGeometry(1.0, 0)
    const hotGeo = new THREE.OctahedronGeometry(0.46, 0)
    const ringGeo = new THREE.TorusGeometry(1.55, 0.055, 6, 48)
    // The beam: an open tube fading to nothing as it rises (vertex alpha, no texture).
    const beamGeo = new THREE.CylinderGeometry(0.12, 0.16, BEAM_H, 8, 6, true)
    beamGeo.translate(0, BEAM_H / 2, 0)
    const pos = beamGeo.getAttribute('position')
    const colors = new Float32Array(pos.count * 3)
    const beamCol = new THREE.Color(PALETTE.core)
    for (let i = 0; i < pos.count; i++) {
      const fade = Math.pow(1 - pos.getY(i) / BEAM_H, 1.6) * 0.32 // additive: brightness IS the alpha; kept well under the road edges
      colors[i * 3] = beamCol.r * fade
      colors[i * 3 + 1] = beamCol.g * fade
      colors[i * 3 + 2] = beamCol.b * fade
    }
    beamGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3))

    // Crystal shell: violet, glossy, lit, glowing from within (T2 at its brightest point).
    const shellMat = new THREE.MeshStandardMaterial({
      color: PALETTE.core,
      emissive: PALETTE.core,
      emissiveIntensity: GLOW.T2 * 0.45,
      metalness: 0.2,
      roughness: 0.15,
      transparent: true,
      opacity: 0.72,
      flatShading: true,
      depthWrite: false,
    })
    // The white-hot centre (T2): the hottest point, what bloom grabs.
    const hotMat = new THREE.MeshStandardMaterial({
      color: PALETTE.coreHot,
      emissive: PALETTE.coreHot,
      emissiveIntensity: GLOW.T2,
      roughness: 0.4,
    })
    const ringMat = new THREE.MeshStandardMaterial({
      color: PALETTE.core,
      emissive: PALETTE.core,
      emissiveIntensity: GLOW.T1,
      roughness: 0.3,
    })
    // A light beam is light, not a surface, so an unlit additive material is right here (T0: no bloom).
    const beamMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    return { shellGeo, hotGeo, ringGeo, beamGeo, shellMat, hotMat, ringMat, beamMat }
  }, [])

  useEffect(
    () => () => {
      for (const v of Object.values(res)) (v as { dispose: () => void }).dispose()
    },
    [res],
  )

  const startRound = (round: number) => {
    st.round = round
    if (!playFlags.cores) {
      st.picks = []
      st.alive = []
      st.popT = []
      useGame.setState({ coresTotal: 0, coresFound: 0, huntStartedAt: 0 })
      return
    }
    st.picks = dealCores(track, round)
    st.alive = st.picks.map(() => true)
    st.popT = st.picks.map(() => 0)
    useGame.setState({ coresTotal: st.picks.length, coresFound: 0, huntStartedAt: 0 })
  }

  const collect = (k: number) => {
    if (!st.alive[k]) return
    st.alive[k] = false
    st.popT[k] = 1e-6
    const core = track.cores[st.picks[k]]
    _pulsePos.x = core.x
    _pulsePos.y = core.y
    _pulsePos.z = core.z
    fx.pulse(_pulsePos, PALETTE.core, 5)

    const g = getGame()
    const now = performance.now()
    const found = g.coresFound + 1
    const total = st.picks.length
    const startedAt = g.huntStartedAt > 0 ? g.huntStartedAt : now
    useGame.setState({ coresFound: found, huntStartedAt: startedAt })
    emit('core.pickup', { index: st.picks[k], found, total })

    if (found >= total) {
      const ms = Math.round(now - startedAt)
      const { best, previous } = offerRecord(track.key, 'huntBestMs', ms)
      useGame.setState({ huntLastMs: ms, huntBestMs: best ? ms : previous, huntStartedAt: 0 })
      emit('hunt.complete', { ms, best, previousBestMs: previous })
      showResults()
    }
  }

  useFrame((_, delta) => {
    const shell = shellRef.current
    const hot = hotRef.current
    const ring = ringRef.current
    const beam = beamRef.current
    if (!shell || !hot || !ring || !beam) return
    if (playFlags.layoutRound !== st.round) startRound(playFlags.layoutRound)

    const n = st.picks.length
    const on = playFlags.cores && n > 0
    shell.visible = hot.visible = ring.visible = beam.visible = on
    if (!on) return
    shell.count = hot.count = ring.count = beam.count = n

    const dt = Math.min(delta, 0.05)
    st.time += dt
    const time = st.time

    // pickup test: the core's distance to the player's car box (only while driving)
    const player = getCar('player')
    const canPick = getGame().phase === 'playing' && !!player
    if (canPick) _invQ.copy(telemetry.carQuaternion).invert()
    const hw = player ? carHalfWidth(player) : 1
    const hl = player ? carHalfLength(player) : 2.2

    for (let k = 0; k < n; k++) {
      const core = track.cores[st.picks[k]]
      const phase = k * 2.399963

      if (canPick && st.alive[k]) {
        _local.set(core.x, core.y, core.z).sub(telemetry.carPosition).applyQuaternion(_invQ)
        const ox = Math.max(0, Math.abs(_local.x) - hw)
        const oy = Math.max(0, Math.abs(_local.y) - CAR_HALF_H)
        const oz = Math.max(0, Math.abs(_local.z) - hl)
        if (ox * ox + oy * oy + oz * oz < PICKUP_R * PICKUP_R) collect(k)
      }

      let scale = 1
      let lift = Math.sin(time * 1.3 + phase) * 0.3
      let spin = time * 0.8 + phase
      const pop = st.popT[k]
      if (pop > 0) {
        const u = Math.min(1, pop / POP_S)
        st.popT[k] = pop + dt
        scale = u < 0.3 ? 1 + u * 2 : Math.max(0, 1.6 * (1 - (u - 0.3) / 0.7))
        lift += u * 2
        spin += u * 8
      } else if (!st.alive[k]) {
        scale = 0
      }

      _obj.position.set(core.x, core.y + lift, core.z)
      _obj.rotation.set(0.35, spin, 0.15)
      _obj.scale.setScalar(scale)
      _obj.updateMatrix()
      shell.setMatrixAt(k, _obj.matrix)
      _obj.rotation.set(-0.5, -spin * 1.7, 0.4)
      _obj.updateMatrix()
      hot.setMatrixAt(k, _obj.matrix)
      _obj.rotation.set(Math.PI / 2 + Math.sin(time * 0.9 + phase) * 0.35, 0, spin * 0.6)
      _obj.updateMatrix()
      ring.setMatrixAt(k, _obj.matrix)
      // beam: stands from the core straight up, gone once collected
      _obj.position.set(core.x, core.y, core.z)
      _obj.rotation.set(0, 0, 0)
      _obj.scale.set(st.alive[k] ? 1 : 0, st.alive[k] ? 1 : 0, st.alive[k] ? 1 : 0)
      _obj.updateMatrix()
      beam.setMatrixAt(k, _obj.matrix)
    }
    shell.instanceMatrix.needsUpdate = true
    hot.instanceMatrix.needsUpdate = true
    ring.instanceMatrix.needsUpdate = true
    beam.instanceMatrix.needsUpdate = true
  })

  useEffect(() => {
    const offInspect = registerPlayInspector('cores', () => ({
      live: playFlags.cores,
      round: st.round,
      total: st.picks.length,
      found: st.alive.filter((a) => !a).length,
      list: st.picks.map((i, k) => ({ k, index: i, ...track.cores[i], alive: st.alive[k] })),
    }))
    const offAim = registerDev(
      'coreAim',
      ((k: number, metres = 25) => {
        const i = st.picks[k]
        if (i === undefined) return `no core ${k} this round`
        const c = track.cores[i]
        return aimAt(track, c.x, c.y - 1.6, c.z, metres)
      }) as never,
      'coreAim(k, metres=25): put the player facing this round\'s core k from that far back',
    )
    const offCollect = registerDev(
      'collectCores',
      ((leave = 0) => {
        let left = st.alive.filter(Boolean).length
        for (let k = 0; k < st.alive.length && left > leave; k++) {
          if (st.alive[k]) {
            collect(k)
            left--
          }
        }
        return `${left} cores left`
      }) as never,
      'collectCores(leave=0): collect every core but `leave` of them (tests the clock and results)',
    )
    return () => {
      offInspect()
      offAim()
      offCollect()
    }
  }, [st, track]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <instancedMesh ref={beamRef} args={[res.beamGeo, res.beamMat, max]} frustumCulled={false} renderOrder={2} />
      <instancedMesh ref={shellRef} args={[res.shellGeo, res.shellMat, max]} frustumCulled={false} renderOrder={3} />
      <instancedMesh ref={hotRef} args={[res.hotGeo, res.hotMat, max]} frustumCulled={false} />
      <instancedMesh ref={ringRef} args={[res.ringGeo, res.ringMat, max]} frustumCulled={false} />
    </>
  )
}
