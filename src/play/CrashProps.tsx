// ============================================================
//  CRASH PROPS - neon crates and energy cubes that burst for points
// ------------------------------------------------------------
//  The clusters at every prop spot (layout: propLayout.ts) behave
//  two ways, decided by speed:
//
//    SLOW (below settings.smashKmh): they are real, light physics
//      boxes. Nudge a tower and it topples; push a crate and it
//      slides. No points: touching things isn't an achievement.
//    FAST (above it): the whole cluster BURSTS into glowing shards
//      before the car even touches it, and you score its points
//      (more the faster you hit it).
//
//  Bodies only exist while a car is near (ACTIVATE_R): far-away
//  clusters are just instanced meshes, which keeps physics cheap.
//  Every round re-deals the layout (store.round, or the shared
//  multiplayer round in core/propsSignal.ts).
//
//  Multiplayer seam: a local burst calls propsSignal.onLocalPop (net
//  broadcasts it); bursts other players caused arrive in
//  propsSignal.pending and burst here too, without points.
//
//  Two instanced meshes (crates, cubes) for every prop on the track.
//  The only per-frame allocation is rapier reading back the pose of a
//  box that is actually moving (sleeping boxes are skipped).
// ============================================================

import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { useBeforePhysicsStep, useRapier } from '@react-three/rapier'
import type { RapierRigidBody } from '@react-three/rapier'
import { cars } from '../core/telemetry'
import type { CarState } from '../core/telemetry'
import { getSettings } from '../core/settings'
import { getGame, useGame } from '../core/store'
import { emit } from '../core/events'
import { fx } from '../core/api'
import { propsSignal } from '../core/propsSignal'
import { GROUPS, tagCollider, untagCollider } from '../core/physics'
import { GLOW, PALETTE } from '../core/palette'
import { registerDev } from '../core/devHandles'
import { useTrack } from '../track/current'
import type { TrackRuntime } from '../track/types'
import { playFlags } from './modes'
import { buildPropLayout, pieceCapacity, PIECE_CRATE } from './propLayout'
import type { PropLayout } from './propLayout'
import { carHalfLength, carHalfWidth, isLocalSimCar, lookAheadSteps, stepClock } from './simCars'
import { edgeMaskTexture } from './neonLook'
import { registerPlayInspector } from './inspect'
import { aimAt } from './Smashables'

const ACTIVATE_R = 40
const DEACTIVATE_R = 60
const STEP_DT = 1 / 60
/** Box densities, kg per cubic metre: light enough to shove with a car (a crate is about 45 kg). */
const CRATE_DENSITY = 34
const CUBE_DENSITY = 26
const CAR_BELOW = 0.7
const CAR_ABOVE = 1.4
/** Extra points for hitting it faster: up to double, reached this many km/h over the burst speed. */
const SPEED_BONUS_KMH = 100

// module temps
const _m = new THREE.Matrix4()
const _p = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _s = new THREE.Vector3()
const _fwd = new THREE.Vector3()
const _burstPos = { x: 0, y: 0, z: 0 }
const _burstVel = { x: 0, y: 0, z: 0 }
const _rot = { x: 0, y: 0, z: 0, w: 1 }

export function CrashProps() {
  const track = useTrack()
  if (!track || track.props.length === 0) return null
  return <PropField key={track.key} track={track} />
}

interface FieldState {
  layout: PropLayout | null
  round: number
  nonce: number
  /** Per cluster. */
  alive: Uint8Array
  active: Uint8Array
  /** Bounding sphere of the live pieces (they move when shoved). */
  bx: Float32Array
  by: Float32Array
  bz: Float32Array
  br: Float32Array
  /** Per piece. */
  live: Uint8Array
  body: (RapierRigidBody | null)[]
  /** Collider handle of each piece's body (kept here so untagging never has to ask rapier). */
  colHandle: Int32Array
  /** Index of the piece in its instanced mesh (crates and cubes count separately). */
  slot: Int32Array
  crateCount: number
  cubeCount: number
  activeBodies: number
  burstsThisRound: number
}

function PropField({ track }: { track: TrackRuntime }) {
  const { world, rapier } = useRapier()
  const crateRef = useRef<THREE.InstancedMesh>(null)
  const cubeRef = useRef<THREE.InstancedMesh>(null)
  const cap = pieceCapacity(track)
  const clusters = track.props.length

  const st = useMemo<FieldState>(
    () => ({
      layout: null,
      round: -1,
      nonce: -1,
      alive: new Uint8Array(clusters),
      active: new Uint8Array(clusters),
      bx: new Float32Array(clusters),
      by: new Float32Array(clusters),
      bz: new Float32Array(clusters),
      br: new Float32Array(clusters),
      live: new Uint8Array(cap),
      body: new Array(cap).fill(null),
      colHandle: new Int32Array(cap),
      slot: new Int32Array(cap),
      crateCount: 0,
      cubeCount: 0,
      activeBodies: 0,
      burstsThisRound: 0,
    }),
    [clusters, cap],
  )

  const res = useMemo(() => {
    const geo = new THREE.BoxGeometry(1, 1, 1)
    const crateMask = edgeMaskTexture({ border: 0.07, inner: 0, panel: 0.35 })
    const cubeMask = edgeMaskTexture({ border: 0.08, inner: 0.22 })
    // Dark crate bodies with glowing magenta edges (T1).
    const crateMat = new THREE.MeshStandardMaterial({
      color: PALETTE.uiPanelSolid,
      metalness: 0.4,
      roughness: 0.45,
      emissive: PALETTE.propCrate,
      emissiveMap: crateMask,
      emissiveIntensity: GLOW.T1,
    })
    // Translucent cyan energy cubes: a faint glow through the body, bright edges (T1).
    const cubeMat = new THREE.MeshStandardMaterial({
      color: PALETTE.propCube,
      metalness: 0.1,
      roughness: 0.15,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      emissive: PALETTE.propCube,
      emissiveMap: cubeMask,
      emissiveIntensity: GLOW.T1,
    })
    return { geo, crateMask, cubeMask, crateMat, cubeMat }
  }, [])

  useEffect(
    () => () => {
      res.geo.dispose()
      res.crateMask.dispose()
      res.cubeMask.dispose()
      res.crateMat.dispose()
      res.cubeMat.dispose()
    },
    [res],
  )

  // ---- bodies ----
  /**
   * Forget piece p's body and take it out of the world. When the track
   * changes, <Physics> may already have freed its world by the time we
   * clean up, and calling into a freed world throws ("null pointer passed
   * to rust") and takes the whole Canvas down. So: untag from our own
   * stored handle (no rapier call), drop our reference first, and only
   * then try the removal, which is allowed to fail on a dead world.
   */
  const removeBody = (p: number, teardown = false) => {
    const b = st.body[p]
    if (!b) return
    untagCollider(st.colHandle[p])
    st.body[p] = null
    st.activeBodies--
    try {
      if (world.getRigidBody(b.handle)) world.removeRigidBody(b)
    } catch (err) {
      // On teardown a freed world is expected. Mid-game it is not: say so.
      if (!teardown) console.error('[play] could not remove a prop body', err)
    }
  }

  const activate = (c: number) => {
    const L = st.layout!
    const start = L.pieceStart[c]
    const end = start + L.pieceCount[c]
    for (let p = start; p < end; p++) {
      if (!st.live[p] || st.body[p]) continue
      _rot.x = L.qx[p]
      _rot.y = L.qy[p]
      _rot.z = L.qz[p]
      _rot.w = L.qw[p]
      const desc = rapier.RigidBodyDesc.dynamic()
        .setTranslation(L.px[p], L.py[p], L.pz[p])
        .setRotation(_rot)
        .setLinearDamping(0.25)
        .setAngularDamping(0.4)
        .setCanSleep(true)
      const body = world.createRigidBody(desc)
      const h = L.half[p]
      const col = world.createCollider(
        rapier.ColliderDesc.cuboid(h, h, h)
          .setDensity(L.type[p] === PIECE_CRATE ? CRATE_DENSITY : CUBE_DENSITY)
          .setFriction(0.7)
          .setRestitution(0.12)
          .setCollisionGroups(GROUPS.prop),
        body,
      )
      tagCollider(col.handle, { kind: 'prop', id: `cluster-${c}` })
      st.colHandle[p] = col.handle
      body.sleep() // resting until something touches it
      st.body[p] = body
      st.activeBodies++
    }
    st.active[c] = 1
  }

  const deactivate = (c: number, teardown = false) => {
    const L = st.layout!
    const start = L.pieceStart[c]
    const end = start + L.pieceCount[c]
    for (let p = start; p < end; p++) removeBody(p, teardown)
    st.active[c] = 0
  }

  const removeAllBodies = (teardown = false) => {
    if (!st.layout) return
    for (let c = 0; c < st.layout.clusterCount; c++) if (st.active[c]) deactivate(c, teardown)
  }

  // Unmount (track change, HMR): the world may already be gone, so this is a teardown.
  useEffect(() => () => removeAllBodies(true), []) // eslint-disable-line react-hooks/exhaustive-deps

  /** Deal a new round: fresh layout, every cluster standing, no bodies. */
  const deal = (round: number) => {
    removeAllBodies()
    const L = buildPropLayout(track, round)
    st.layout = L
    st.crateCount = 0
    st.cubeCount = 0
    st.burstsThisRound = 0
    for (let p = 0; p < L.pieceTotal; p++) {
      st.live[p] = 1
      st.slot[p] = L.type[p] === PIECE_CRATE ? st.crateCount++ : st.cubeCount++
    }
    for (let c = 0; c < L.clusterCount; c++) {
      st.alive[c] = 1
      st.active[c] = 0
      updateBounds(c)
    }
    const crates = crateRef.current
    const cubes = cubeRef.current
    if (crates && cubes) {
      crates.count = st.crateCount
      cubes.count = st.cubeCount
      for (let p = 0; p < L.pieceTotal; p++) writeMatrix(p)
      crates.instanceMatrix.needsUpdate = true
      cubes.instanceMatrix.needsUpdate = true
    }
  }

  const updateBounds = (c: number) => {
    const L = st.layout!
    const start = L.pieceStart[c]
    const end = start + L.pieceCount[c]
    let sx = 0
    let sy = 0
    let sz = 0
    let n = 0
    for (let p = start; p < end; p++) {
      if (!st.live[p]) continue
      sx += L.px[p]
      sy += L.py[p]
      sz += L.pz[p]
      n++
    }
    if (n === 0) {
      st.br[c] = 0
      return
    }
    sx /= n
    sy /= n
    sz /= n
    let r = 0
    for (let p = start; p < end; p++) {
      if (!st.live[p]) continue
      const d = Math.hypot(L.px[p] - sx, L.py[p] - sy, L.pz[p] - sz) + L.half[p] * 1.75
      if (d > r) r = d
    }
    st.bx[c] = sx
    st.by[c] = sy
    st.bz[c] = sz
    st.br[c] = r
  }

  const writeMatrix = (p: number) => {
    const L = st.layout!
    const mesh = L.type[p] === PIECE_CRATE ? crateRef.current : cubeRef.current
    if (!mesh) return
    if (st.live[p]) {
      _p.set(L.px[p], L.py[p], L.pz[p])
      _q.set(L.qx[p], L.qy[p], L.qz[p], L.qw[p])
      const e = L.half[p] * 2
      _m.compose(_p, _q, _s.set(e, e, e))
    } else {
      _m.makeScale(0, 0, 0)
    }
    mesh.setMatrixAt(st.slot[p], _m)
  }

  /** Burst cluster c. Returns false if it was already gone. Points only when `scorer` is the player. */
  const burst = (c: number, vx: number, vy: number, vz: number, scorer: CarState | null, remote: boolean): boolean => {
    const L = st.layout
    if (!L || c < 0 || c >= L.clusterCount || !st.alive[c]) return false
    st.alive[c] = 0
    st.burstsThisRound++
    const start = L.pieceStart[c]
    const end = start + L.pieceCount[c]
    let crates = 0
    let cubes = 0
    for (let p = start; p < end; p++) {
      if (!st.live[p]) continue
      if (L.type[p] === PIECE_CRATE) crates++
      else cubes++
      removeBody(p)
      st.live[p] = 0
      writeMatrix(p)
    }
    st.active[c] = 0
    if (crateRef.current) crateRef.current.instanceMatrix.needsUpdate = true
    if (cubeRef.current) cubeRef.current.instanceMatrix.needsUpdate = true

    const speed = Math.hypot(vx, vy, vz)
    _burstPos.x = st.bx[c]
    _burstPos.y = st.by[c]
    _burstPos.z = st.bz[c]
    _burstVel.x = vx * 0.5
    _burstVel.y = vy * 0.5 + 3
    _burstVel.z = vz * 0.5
    if (crates > 0)
      fx.shards({ position: _burstPos, velocity: _burstVel, color: PALETTE.propCrate, count: Math.min(48, crates * 5), speed: 5 + speed * 0.12, size: 0.3, life: 1.8 })
    if (cubes > 0)
      fx.shards({ position: _burstPos, velocity: _burstVel, color: PALETTE.propCube, count: Math.min(48, cubes * 5), speed: 5 + speed * 0.12, size: 0.26, life: 1.6 })
    fx.pulse(_burstPos, crates >= cubes ? PALETTE.propCrate : PALETTE.propCube, 3 + st.br[c])

    if (remote) {
      emit('prop.burst', { kind: L.kind[c], points: 0, remote: true })
    } else if (scorer && scorer.kind === 'player') {
      const over = Math.max(0, speed * 3.6 - getSettings().smashKmh)
      const points = Math.round((L.points[c] * (1 + Math.min(1, over / SPEED_BONUS_KMH))) / 5) * 5
      useGame.setState({ propScore: getGame().propScore + points })
      emit('prop.burst', { kind: L.kind[c], points, remote: false })
      propsSignal.onLocalPop?.({ cluster: c, vx, vy, vz })
    }
    return true
  }

  // ---- before every physics step: burst what a fast car is about to hit ----
  useBeforePhysicsStep(() => {
    const L = st.layout
    if (!L || !playFlags.props) return
    const burstV = getSettings().smashKmh / 3.6
    const ahead = lookAheadSteps() - stepClock.stepsSinceFrame
    for (let ci = 0; ci < cars.length; ci++) {
      const c = cars[ci]
      if (!isLocalSimCar(c)) continue
      const v = c.velocity
      const speed = Math.hypot(v.x, v.y, v.z)
      if (speed < burstV) continue
      const lag = (stepClock.stepsSinceFrame + 1) * STEP_DT
      const cx = c.position.x + v.x * lag
      const cy = c.position.y + v.y * lag
      const cz = c.position.z + v.z * lag
      _fwd.set(0, 0, 1).applyQuaternion(c.quaternion)
      _fwd.y = 0
      if (_fwd.lengthSq() < 1e-4) continue
      _fwd.normalize()
      const rx = -_fwd.z
      const rz = _fwd.x
      const vf = v.x * _fwd.x + v.z * _fwd.z
      const vr = v.x * rx + v.z * rz
      const sweep = ahead * STEP_DT
      const hw = carHalfWidth(c)
      const hl = carHalfLength(c)
      const reach = hl + speed * sweep + 1
      for (let k = 0; k < L.clusterCount; k++) {
        if (!st.alive[k]) continue
        const dxc = st.bx[k] - cx
        const dzc = st.bz[k] - cz
        const rr = reach + st.br[k]
        if (dxc * dxc + dzc * dzc > rr * rr) continue
        const start = L.pieceStart[k]
        const end = start + L.pieceCount[k]
        for (let p = start; p < end; p++) {
          if (!st.live[p]) continue
          const h = L.half[p] * 1.2
          if (cy - CAR_BELOW > L.py[p] + h || cy + CAR_ABOVE < L.py[p] - h) continue // over or under it
          const dx = L.px[p] - cx
          const dz = L.pz[p] - cz
          const lx = dx * rx + dz * rz
          const lz = dx * _fwd.x + dz * _fwd.z
          const ex = hw + h + Math.abs(vr) * sweep + 0.1
          const front = hl + h + Math.max(0, vf) * sweep + 0.1
          const back = hl + h + Math.max(0, -vf) * sweep + 0.1
          if (lx < -ex || lx > ex || lz > front || lz < -back) continue
          burst(k, v.x, v.y, v.z, c, false)
          break
        }
      }
    }
  })

  // ---- every frame: rounds, remote bursts, bodies near cars, moving boxes ----
  useFrame(() => {
    const crates = crateRef.current
    const cubes = cubeRef.current
    if (!crates || !cubes) return

    if (playFlags.layoutRound !== st.round || (propsSignal.shared && propsSignal.nonce !== st.nonce)) {
      st.round = playFlags.layoutRound
      st.nonce = propsSignal.nonce
      deal(st.round)
    }
    const L = st.layout
    if (!L) return

    if (!playFlags.props) {
      removeAllBodies()
      propsSignal.pending.length = 0
      crates.visible = false
      cubes.visible = false
      return
    }
    crates.visible = true
    cubes.visible = true

    // bursts other players caused (no points here: they scored on their machine)
    while (propsSignal.pending.length > 0) {
      const pop = propsSignal.pending.pop()!
      burst(pop.cluster, pop.vx, pop.vy, pop.vz, null, true)
    }

    let moved = false
    for (let c = 0; c < L.clusterCount; c++) {
      if (!st.alive[c]) continue
      // nearest local car
      let near2 = Infinity
      for (let ci = 0; ci < cars.length; ci++) {
        const car = cars[ci]
        if (!isLocalSimCar(car)) continue
        const dx = car.position.x - st.bx[c]
        const dz = car.position.z - st.bz[c]
        const d2 = dx * dx + dz * dz
        if (d2 < near2) near2 = d2
      }
      if (!st.active[c]) {
        if (near2 < ACTIVATE_R * ACTIVATE_R) activate(c)
        continue
      }

      // read back boxes that are moving
      const start = L.pieceStart[c]
      const end = start + L.pieceCount[c]
      let anyAwake = false
      for (let p = start; p < end; p++) {
        const b = st.body[p]
        if (!b || b.isSleeping()) continue
        anyAwake = true
        const t = b.translation()
        const r = b.rotation()
        if (!Number.isFinite(t.x + t.y + t.z)) {
          // NaN firewall: drop a body that went bad rather than let it poison the world
          removeBody(p)
          st.live[p] = 0
          writeMatrix(p)
          moved = true
          continue
        }
        L.px[p] = t.x
        L.py[p] = t.y
        L.pz[p] = t.z
        L.qx[p] = r.x
        L.qy[p] = r.y
        L.qz[p] = r.z
        L.qw[p] = r.w
        // knocked out of the world: gone
        if (t.y < track.world.resetY || t.y < track.terrainHeight(t.x, t.z) - 4) {
          removeBody(p)
          st.live[p] = 0
        }
        writeMatrix(p)
        moved = true
      }
      if (anyAwake) updateBounds(c)
      if (near2 > DEACTIVATE_R * DEACTIVATE_R && !anyAwake) deactivate(c)
    }
    if (moved) {
      crates.instanceMatrix.needsUpdate = true
      cubes.instanceMatrix.needsUpdate = true
    }
  })

  // ---- inspector + dev ----
  useEffect(() => {
    const offInspect = registerPlayInspector('props', () => {
      const L = st.layout
      let alive = 0
      let active = 0
      let livePieces = 0
      if (L) {
        for (let c = 0; c < L.clusterCount; c++) {
          alive += st.alive[c]
          active += st.active[c]
        }
        for (let p = 0; p < L.pieceTotal; p++) livePieces += st.live[p]
      }
      return {
        clusters: L?.clusterCount ?? 0,
        clustersStanding: alive,
        clustersWithBodies: active,
        pieces: L?.pieceTotal ?? 0,
        piecesStanding: livePieces,
        bodies: st.activeBodies,
        burstsThisRound: st.burstsThisRound,
        round: st.round,
        propScore: getGame().propScore,
        list: L ? Array.from({ length: L.clusterCount }, (_, c) => ({ c, kind: L.kind[c], x: +st.bx[c].toFixed(1), z: +st.bz[c].toFixed(1), alive: !!st.alive[c], points: L.points[c] })) : [],
      }
    })
    const offDev = registerDev(
      'propAim',
      ((c: number, metres = 40) => aimAt(track, st.bx[c] ?? 0, st.by[c] ?? 0, st.bz[c] ?? 0, metres)) as never,
      'propAim(c, metres=40): put the player facing prop cluster c from that far back',
    )
    // Multiplayer seam check without a second machine: queue a burst exactly as net does.
    const offRemote = registerDev(
      'propRemotePop',
      ((c: number) => {
        propsSignal.pending.push({ cluster: c, vx: 20, vy: 0, vz: 0 })
        return `queued remote burst of cluster ${c}`
      }) as never,
      'propRemotePop(c): pretend another player burst cluster c (tests the propsSignal.pending path: burst, no points)',
    )
    return () => {
      offInspect()
      offDev()
      offRemote()
    }
  }, [st, track])

  return (
    <>
      <instancedMesh ref={crateRef} args={[res.geo, res.crateMat, cap]} frustumCulled={false} castShadow receiveShadow />
      <instancedMesh ref={cubeRef} args={[res.geo, res.cubeMat, cap]} frustumCulled={false} />
    </>
  )
}
