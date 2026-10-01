// ============================================================
//  SMASHABLES - the neon posts along the roadside
// ------------------------------------------------------------
//  Slim dark pylons with glowing tops, both sides of the road
//  (track.roadside.posts). The rule (CONSTITUTION section 5,
//  "Consistency") is the same for every post, every time:
//
//    hit SLOWER than settings.smashKmh  ->  it is solid. The car stops
//        or bounces off; rapier does all the work, no code runs here.
//    hit FASTER                         ->  it smashes. We remove its
//        collider just BEFORE the physics step that would touch it, so
//        no hard contact is ever solved and a fast car can't be bricked.
//        In its place: a shower of shards, a small speed loss, and the
//        post flies off, topples and fades.
//
//  Only posts near a car have a live collider (activated within
//  ACTIVATE_R of any car this machine simulates, dropped again past
//  DEACTIVATE_R), which keeps the physics world small. A car can't
//  reach a post without passing inside that radius first, so a post
//  that would collide always does.
//
//  Posts come back every round. Everything is instanced (two draw
//  calls for every post on the track) and nothing allocates per frame.
// ============================================================

import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { useBeforePhysicsStep, useRapier } from '@react-three/rapier'
import type { RapierCollider } from '@react-three/rapier'
import { cars } from '../core/telemetry'
import type { CarState } from '../core/telemetry'
import { getSettings } from '../core/settings'
import { getGame } from '../core/store'
import { emit } from '../core/events'
import { fx } from '../core/api'
import { GROUPS, tagCollider, untagCollider } from '../core/physics'
import { GLOW, PALETTE } from '../core/palette'
import { registerDev } from '../core/devHandles'
import { useTrack } from '../track/current'
import type { TrackRuntime } from '../track/types'
import { playFlags } from './modes'
import { carBody, carHalfLength, carHalfWidth, isLocalSimCar, lookAheadSteps, stepClock } from './simCars'
import type { PhysicsWorld } from './simCars'
import { registerPlayInspector } from './inspect'

// ---- post shape (metres) ----
const BODY_H = 1.86
const CAP_H = 0.34
const CAP_BOTTOM = 1.84 // overlaps the body by 2 cm so the faces never sit coplanar
const POST_H = CAP_BOTTOM + CAP_H
const RADIUS = 0.15
/** The post sinks this far into the ground so a slope never shows a gap under it. */
const SINK = 0.25

// ---- colliders ----
const ACTIVATE_R = 36
const DEACTIVATE_R = 52
const CELL = 32

// ---- the smash ----
const STEP_DT = 1 / 60
/** Speed a smash costs the car, m/s. Felt, never fatal. */
const SPEED_LOSS = 1.6
/** Car body height range around its centre, for "did it fly over the post?". */
const CAR_BELOW = 0.7
const CAR_ABOVE = 1.3

// ---- the flying post ----
const GRAVITY = 15
const SETTLE_ANGLE = 1.75
const FADE_START = 2.0
const FADE_S = 0.8

const STANDING = 0
const FLYING = 1
const GONE = 2

// module temps
const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _qy = new THREE.Quaternion()
const _axis = new THREE.Vector3()
const _p = new THREE.Vector3()
const _s = new THREE.Vector3()
const _fwd = new THREE.Vector3()
const _up = new THREE.Vector3(0, 1, 0)
const _impulse = { x: 0, y: 0, z: 0 }
const _shardPos = { x: 0, y: 0, z: 0 }
const _shardVel = { x: 0, y: 0, z: 0 }

export function Smashables() {
  const track = useTrack()
  if (!track || track.roadside.posts.length === 0) return null
  return <PostField key={`${track.key}:${track.roadside.posts.length}`} track={track} />
}

interface PostState {
  n: number
  x: Float32Array
  y: Float32Array
  z: Float32Array
  heading: Float32Array
  state: Uint8Array
  collider: (RapierCollider | null)[]
  /** Indices of posts with a live collider (swap-remove list). */
  active: Int32Array
  activeCount: number
  // flight
  t: Float32Array
  px: Float32Array
  py: Float32Array
  pz: Float32Array
  vx: Float32Array
  vy: Float32Array
  vz: Float32Array
  ax: Float32Array
  az: Float32Array
  angle: Float32Array
  spin: Float32Array
  flying: Int32Array
  flyingCount: number
  smashedThisRound: number
  // broadphase grid (CSR)
  gn: number
  half: number
  cellStart: Int32Array
  cellItems: Int32Array
}

function buildState(track: TrackRuntime): PostState {
  const posts = track.roadside.posts
  const n = posts.length
  const half = track.world.half + CELL
  const gn = Math.max(1, Math.ceil((half * 2) / CELL))
  const cellOf = (v: number) => Math.min(gn - 1, Math.max(0, Math.floor((v + half) / CELL)))
  const counts = new Int32Array(gn * gn)
  for (const p of posts) counts[cellOf(p.x) + cellOf(p.z) * gn]++
  const cellStart = new Int32Array(gn * gn + 1)
  let acc = 0
  for (let c = 0; c < gn * gn; c++) {
    cellStart[c] = acc
    acc += counts[c]
  }
  cellStart[gn * gn] = acc
  const cursor = cellStart.slice(0, gn * gn)
  const cellItems = new Int32Array(n)
  for (let i = 0; i < n; i++) cellItems[cursor[cellOf(posts[i].x) + cellOf(posts[i].z) * gn]++] = i

  const f = () => new Float32Array(n)
  const st: PostState = {
    n,
    x: f(),
    y: f(),
    z: f(),
    heading: f(),
    state: new Uint8Array(n),
    collider: new Array(n).fill(null),
    active: new Int32Array(n),
    activeCount: 0,
    t: f(),
    px: f(),
    py: f(),
    pz: f(),
    vx: f(),
    vy: f(),
    vz: f(),
    ax: f(),
    az: f(),
    angle: f(),
    spin: f(),
    flying: new Int32Array(n),
    flyingCount: 0,
    smashedThisRound: 0,
    gn,
    half,
    cellStart,
    cellItems,
  }
  for (let i = 0; i < n; i++) {
    st.x[i] = posts[i].x
    st.y[i] = posts[i].y - SINK
    st.z[i] = posts[i].z
    st.heading[i] = posts[i].heading
  }
  return st
}

function cellIndex(st: PostState, v: number): number {
  return Math.min(st.gn - 1, Math.max(0, Math.floor((v + st.half) / CELL)))
}

function PostField({ track }: { track: TrackRuntime }) {
  const { world, rapier } = useRapier()
  const bodyRef = useRef<THREE.InstancedMesh>(null)
  const capRef = useRef<THREE.InstancedMesh>(null)
  const st = useMemo(() => buildState(track), [track])
  const roundRef = useRef(-1)
  const dirtyRef = useRef(true)

  const accent = track.file.environment.palette.edgeAlt ?? PALETTE.roadEdgeAlt

  const { bodyGeo, capGeo, bodyMat, capMat } = useMemo(() => {
    const bodyGeo = new THREE.CylinderGeometry(RADIUS * 0.75, RADIUS, BODY_H, 6, 1)
    bodyGeo.translate(0, BODY_H / 2, 0)
    const capGeo = new THREE.CylinderGeometry(RADIUS * 1.05, RADIUS * 0.95, CAP_H, 6, 1)
    capGeo.translate(0, CAP_BOTTOM + CAP_H / 2, 0)
    // Dark, glossy metal: it shows its form by reflection and rim light, never a black void.
    const bodyMat = new THREE.MeshStandardMaterial({ color: PALETTE.groundSheen, metalness: 0.75, roughness: 0.32 })
    const capMat = new THREE.MeshStandardMaterial({
      color: accent,
      emissive: accent,
      emissiveIntensity: GLOW.T1,
      metalness: 0.1,
      roughness: 0.4,
    })
    return { bodyGeo, capGeo, bodyMat, capMat }
  }, [accent])

  useEffect(
    () => () => {
      bodyGeo.dispose()
      capGeo.dispose()
      bodyMat.dispose()
      capMat.dispose()
    },
    [bodyGeo, capGeo, bodyMat, capMat],
  )

  // ---- collider management ----
  const addCollider = (i: number) => {
    if (st.collider[i] || st.state[i] !== STANDING) return
    const desc = rapier.ColliderDesc.cylinder(POST_H / 2, RADIUS)
      .setTranslation(st.x[i], st.y[i] + POST_H / 2, st.z[i])
      .setCollisionGroups(GROUPS.prop)
      .setFriction(0.6)
      .setRestitution(0.2)
    const col = world.createCollider(desc)
    tagCollider(col.handle, { kind: 'smashable', id: `post-${i}` })
    st.collider[i] = col
    st.active[st.activeCount++] = i
  }
  const dropCollider = (i: number) => {
    const col = st.collider[i]
    if (!col) return
    untagCollider(col.handle)
    world.removeCollider(col, true)
    st.collider[i] = null
    for (let k = 0; k < st.activeCount; k++) {
      if (st.active[k] === i) {
        st.active[k] = st.active[--st.activeCount]
        break
      }
    }
  }

  // Remove every collider we made when the field goes away (track change, HMR).
  useEffect(
    () => () => {
      for (let i = 0; i < st.n; i++) {
        const col = st.collider[i]
        if (!col) continue
        untagCollider(col.handle)
        try {
          world.removeCollider(col, false)
        } catch {
          // the physics world was already torn down with the track: nothing left to remove
        }
        st.collider[i] = null
      }
      st.activeCount = 0
    },
    [st, world],
  )

  /** Smash post i, hit by car c going `speed` m/s. */
  const smash = (world: PhysicsWorld, i: number, c: CarState, speed: number) => {
    dropCollider(i)
    st.state[i] = FLYING
    st.t[i] = 0
    st.px[i] = st.x[i]
    st.py[i] = st.y[i]
    st.pz[i] = st.z[i]
    st.smashedThisRound++
    const v = c.velocity
    const inv = 1 / Math.max(speed, 0.001)
    // fling along the car's motion, biased away from the side it was clipped on
    let ox = st.x[i] - c.position.x
    let oz = st.z[i] - c.position.z
    const ol = Math.hypot(ox, oz) || 1
    ox /= ol
    oz /= ol
    let dx = v.x * inv * 0.8 + ox * 0.5
    let dz = v.z * inv * 0.8 + oz * 0.5
    const dl = Math.hypot(dx, dz) || 1
    dx /= dl
    dz /= dl
    const launch = 5 + speed * 0.22
    st.vx[i] = dx * launch
    st.vz[i] = dz * launch
    st.vy[i] = 3 + speed * 0.06
    st.ax[i] = -dz
    st.az[i] = dx
    st.spin[i] = 3.5 + speed * 0.08
    st.angle[i] = 0
    st.flying[st.flyingCount++] = i
    dirtyRef.current = true

    _shardPos.x = st.x[i]
    _shardPos.y = st.y[i] + CAP_BOTTOM
    _shardPos.z = st.z[i]
    _shardVel.x = v.x * 0.55
    _shardVel.y = v.y * 0.55 + 2
    _shardVel.z = v.z * 0.55
    fx.shards({ position: _shardPos, velocity: _shardVel, color: accent, count: 16, speed: 4 + speed * 0.08, size: 0.2, life: 1.3 })

    // a small speed loss: felt, never fatal
    const body = carBody(world, c.id)
    if (body) {
      const m = body.mass()
      _impulse.x = -v.x * inv * SPEED_LOSS * m
      _impulse.y = 0
      _impulse.z = -v.z * inv * SPEED_LOSS * m
      body.applyImpulse(_impulse, true)
    }
    if (c.kind === 'player') emit('smash', { kind: 'post', speedKmh: Math.round(speed * 3.6) })
  }

  // ---- before every physics step: smash what a fast car is about to hit ----
  useBeforePhysicsStep((w) => {
    if (!playFlags.smashables || st.n === 0) return
    const smashV = getSettings().smashKmh / 3.6
    const ahead = lookAheadSteps() - stepClock.stepsSinceFrame // steps past the estimated pose
    for (let ci = 0; ci < cars.length; ci++) {
      const c = cars[ci]
      if (!isLocalSimCar(c)) continue
      const v = c.velocity
      const speed = Math.hypot(v.x, v.y, v.z)
      if (speed < smashV) continue // slow: posts are solid, rapier handles it

      // where the car really is now (the render pose lags the sim a little)
      const lag = (stepClock.stepsSinceFrame + 1) * STEP_DT
      const cx = c.position.x + v.x * lag
      const cy = c.position.y + v.y * lag
      const cz = c.position.z + v.z * lag
      _fwd.set(0, 0, 1).applyQuaternion(c.quaternion)
      _fwd.y = 0
      if (_fwd.lengthSq() < 1e-4) continue // nose-down: let the collider do it
      _fwd.normalize()
      const rx = -_fwd.z // right = forward x up, flattened
      const rz = _fwd.x
      const vf = v.x * _fwd.x + v.z * _fwd.z
      const vr = v.x * rx + v.z * rz
      const sweep = ahead * STEP_DT
      const hw = carHalfWidth(c)
      const hl = carHalfLength(c)
      const reach = hl + Math.abs(vf) * sweep + RADIUS + 1
      const x0 = cellIndex(st, cx - reach)
      const x1 = cellIndex(st, cx + reach)
      const z0 = cellIndex(st, cz - reach)
      const z1 = cellIndex(st, cz + reach)
      for (let gz = z0; gz <= z1; gz++) {
        for (let gx = x0; gx <= x1; gx++) {
          const cell = gx + gz * st.gn
          for (let k = st.cellStart[cell], e = st.cellStart[cell + 1]; k < e; k++) {
            const i = st.cellItems[k]
            if (st.state[i] !== STANDING) continue
            if (cy - CAR_BELOW > st.y[i] + POST_H || cy + CAR_ABOVE < st.y[i] + SINK) continue // flying over it
            const dx = st.x[i] - cx
            const dz = st.z[i] - cz
            const lx = dx * rx + dz * rz
            const lz = dx * _fwd.x + dz * _fwd.z
            const ex = hw + RADIUS + Math.abs(vr) * sweep + 0.1
            const front = hl + RADIUS + Math.max(0, vf) * sweep + 0.1
            const back = hl + RADIUS + Math.max(0, -vf) * sweep + 0.1
            if (lx < -ex || lx > ex || lz > front || lz < -back) continue
            smash(w, i, c, speed)
          }
        }
      }
    }
  })

  // ---- every frame: round resets, collider activation, flying posts ----
  useFrame((_, delta) => {
    const body = bodyRef.current
    const cap = capRef.current
    if (!body || !cap) return
    const dt = Math.min(delta, 0.05)

    // a new round: every post stands again
    if (playFlags.layoutRound !== roundRef.current) {
      roundRef.current = playFlags.layoutRound
      for (let i = 0; i < st.n; i++) st.state[i] = STANDING
      st.flyingCount = 0
      st.smashedThisRound = 0
      dirtyRef.current = true
    }

    if (!playFlags.smashables) {
      while (st.activeCount > 0) dropCollider(st.active[0])
      body.visible = false
      cap.visible = false
      return
    }
    body.visible = true
    cap.visible = true

    // activate posts near any local car
    for (let ci = 0; ci < cars.length; ci++) {
      const c = cars[ci]
      if (!isLocalSimCar(c)) continue
      const px = c.position.x
      const pz = c.position.z
      const x0 = cellIndex(st, px - ACTIVATE_R)
      const x1 = cellIndex(st, px + ACTIVATE_R)
      const z0 = cellIndex(st, pz - ACTIVATE_R)
      const z1 = cellIndex(st, pz + ACTIVATE_R)
      for (let gz = z0; gz <= z1; gz++) {
        for (let gx = x0; gx <= x1; gx++) {
          const cell = gx + gz * st.gn
          for (let k = st.cellStart[cell], e = st.cellStart[cell + 1]; k < e; k++) {
            const i = st.cellItems[k]
            if (st.collider[i] || st.state[i] !== STANDING) continue
            const dx = st.x[i] - px
            const dz = st.z[i] - pz
            if (dx * dx + dz * dz < ACTIVATE_R * ACTIVATE_R) addCollider(i)
          }
        }
      }
    }
    // drop colliders no car is near any more
    for (let k = st.activeCount - 1; k >= 0; k--) {
      const i = st.active[k]
      let near = false
      for (let ci = 0; ci < cars.length && !near; ci++) {
        const c = cars[ci]
        if (!isLocalSimCar(c)) continue
        const dx = st.x[i] - c.position.x
        const dz = st.z[i] - c.position.z
        near = dx * dx + dz * dz < DEACTIVATE_R * DEACTIVATE_R
      }
      if (!near) dropCollider(i)
    }

    // standing posts: write every matrix once after a reset
    if (dirtyRef.current) {
      for (let i = 0; i < st.n; i++) {
        if (st.state[i] === STANDING) {
          _qy.setFromAxisAngle(_up, st.heading[i])
          _p.set(st.x[i], st.y[i], st.z[i])
          _m.compose(_p, _qy, _s.set(1, 1, 1))
        } else if (st.state[i] === GONE) {
          _m.makeScale(0, 0, 0)
        } else continue
        body.setMatrixAt(i, _m)
        cap.setMatrixAt(i, _m)
      }
      dirtyRef.current = false
      body.instanceMatrix.needsUpdate = true
      cap.instanceMatrix.needsUpdate = true
    }

    // flying posts: fling, topple, land, fade
    if (st.flyingCount > 0) {
      for (let k = st.flyingCount - 1; k >= 0; k--) {
        const i = st.flying[k]
        st.t[i] += dt
        if (st.angle[i] < SETTLE_ANGLE) {
          st.px[i] += st.vx[i] * dt
          st.py[i] += st.vy[i] * dt
          st.pz[i] += st.vz[i] * dt
          st.vy[i] -= GRAVITY * dt
          st.angle[i] = Math.min(SETTLE_ANGLE, st.angle[i] + st.spin[i] * dt)
          const ground = track.terrainHeight(st.px[i], st.pz[i]) - SINK * 0.5
          if (st.py[i] <= ground) {
            st.py[i] = ground
            st.vx[i] *= 0.3
            st.vz[i] *= 0.3
            st.vy[i] = Math.abs(st.vy[i]) < 1.5 ? 0 : -st.vy[i] * 0.2
          }
        }
        const t = st.t[i]
        const scale = t <= FADE_START ? 1 : Math.max(0, 1 - (t - FADE_START) / FADE_S)
        if (scale <= 0) {
          st.state[i] = GONE
          st.flying[k] = st.flying[--st.flyingCount]
          _m.makeScale(0, 0, 0)
        } else {
          _axis.set(st.ax[i], 0, st.az[i])
          _q.setFromAxisAngle(_axis, st.angle[i])
          _qy.setFromAxisAngle(_up, st.heading[i])
          _q.multiply(_qy)
          _p.set(st.px[i], st.py[i], st.pz[i])
          _m.compose(_p, _q, _s.set(scale, scale, scale))
        }
        body.setMatrixAt(i, _m)
        cap.setMatrixAt(i, _m)
      }
      body.instanceMatrix.needsUpdate = true
      cap.instanceMatrix.needsUpdate = true
    }
  })

  // ---- inspector + dev ----
  useEffect(() => {
    const offInspect = registerPlayInspector('posts', () => {
      let standing = 0
      for (let i = 0; i < st.n; i++) if (st.state[i] === STANDING) standing++
      return { total: st.n, standing, liveColliders: st.activeCount, smashedThisRound: st.smashedThisRound, smashKmh: getSettings().smashKmh }
    })
    const offDev = registerDev(
      'postAim',
      ((i: number, metres = 30) => aimAt(track, st.x[i] ?? 0, st.y[i] ?? 0, st.z[i] ?? 0, metres)) as never,
      'postAim(i, metres=30): put the player on the road facing post i from that far back (to test slow hits and smashes)',
    )
    return () => {
      offInspect()
      offDev()
    }
  }, [st, track])

  return (
    <>
      <instancedMesh ref={bodyRef} args={[bodyGeo, bodyMat, st.n]} frustumCulled={false} receiveShadow />
      <instancedMesh ref={capRef} args={[capGeo, capMat, st.n]} frustumCulled={false} />
    </>
  )
}

const _tp = new THREE.Vector3()
const _tq = new THREE.Quaternion()
const _tm = new THREE.Matrix4()

/** Dev helper: teleport the player `metres` away from a point, facing it. */
export function aimAt(track: TrackRuntime, x: number, y: number, z: number, metres: number): string {
  const player = cars.find((c) => c.id === 'player')
  if (!player?.api) return 'no player car'
  if (getGame().phase !== 'playing') return 'not playing'
  // approach along the road direction nearest the target
  const hit = { s: 0, index: 0, lateral: 0, height: 0, distance: 0, onRoad: true }
  track.nearest(x, y, z, hit)
  const i = hit.index
  const tx = track.samples.tx[i]
  const tz = track.samples.tz[i]
  const tl = Math.hypot(tx, tz) || 1
  const sx = x - (tx / tl) * metres
  const sz = z - (tz / tl) * metres
  const ground = Math.max(track.terrainHeight(sx, sz), y)
  _tp.set(sx, ground + 1.2, sz)
  _tm.lookAt(_tp, new THREE.Vector3(x, ground + 1.2, z), new THREE.Vector3(0, 1, 0))
  _tq.setFromRotationMatrix(_tm)
  // Matrix4.lookAt points -z at the target; cars drive along +z, so turn half a circle.
  _tq.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI))
  player.api.teleport(_tp, _tq)
  return `player ${metres} m from (${x.toFixed(1)}, ${z.toFixed(1)}), facing it`
}
