// ============================================================
//  REMOTE CARS - the other players, made of matter
// ------------------------------------------------------------
//  One car per player who has said hello. Each one is two things,
//  fed by the same pose stream (net/poses.ts, 80 ms behind live):
//
//  1. A KINEMATIC rapier body with a chassis-sized box collider.
//     "Kinematic" means we move it, physics doesn't. Because we move
//     it with setNextKinematicTranslation, rapier works out how fast
//     it is going, so when it hits YOUR car, your car really gets
//     shoved. On their screen the same happens the other way round.
//     Each computer only ever simulates its own car, so the two
//     physics worlds never have to agree on anything.
//
//     The body is created IMPERATIVELY (world.createRigidBody), never
//     with <RigidBody>: the declarative wrapper also pushes its own
//     scene-graph transform into a kinematic body every frame, which
//     fights our updates and leaves the car trailing far behind (v1
//     found this the hard way).
//
//     settings.multiplayerRam off: the collider joins GROUPS.remoteGhost
//     and you drive straight through each other.
//
//  2. The VISUAL: the car body from the vehicle catalog
//     (vehicle.buildModel), posed every render frame, with a name tag.
//
//  A car is only shown (and only solid) while its player is driving
//  on the same track as us and packets keep arriving. When packets
//  stop (hidden tab, wifi drop), it fades out, leaves `cars`, and its
//  body is parked far below the world so nobody hits an invisible
//  wall. When packets come back, it fades back in.
// ============================================================

import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { useAfterPhysicsStep, useBeforePhysicsStep, useRapier } from '@react-three/rapier'
import type { RapierRigidBody, RapierCollider } from '@react-three/rapier'
import { addCar, makeCarState, removeCar } from '../core/telemetry'
import type { CarAnchors, CarState } from '../core/telemetry'
import { GROUPS, finite3, ownerOf, tagCollider, untagCollider } from '../core/physics'
import { apiInstalled, vehicle } from '../core/api'
import { getSettings, useSettings } from '../core/settings'
import { getTrack } from '../track/current'
import type { NearestHit } from '../track/types'
import { liveFor, useNet } from './netStore'
import type { PeerInfo } from './netStore'
import { INTERP_MS, JUMP_M, STALE_MS, peerPoses } from './poses'
import { POSE_FLAG } from './protocol'
import { canTag, tagged } from './rounds'
import { maybeBump } from './bump'
import { buildNameTag, disposeNameTag, TAG_WORLD_HEIGHT, TAG_WORLD_WIDTH } from './nameTag'

/** Where a hidden car's body waits: far below the world and its catch floor. */
const PARK = { x: 0, y: -5000, z: 0 }
/** Seconds to fade a car in or out. */
const FADE_S = 0.35
/**
 * A jump bigger than this between two physics steps is a reset (R, a race
 * grid): teleport the body, never sweep it, or it would smash through every
 * car in between at hundreds of m/s. Matches the pose buffer's JUMP_M.
 */
const TELEPORT_JUMP_M = JUMP_M

/** Used until the car model is built: roughly a sports car. */
const DEFAULT_HALF = new THREE.Vector3(0.95, 0.5, 2.1)
const DEFAULT_CENTER = new THREE.Vector3(0, 0.55, 0)

// ---------- module temps: never allocated per frame ----------
const _pos = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _vpos = new THREE.Vector3()
const _vquat = new THREE.Quaternion()
const _prevTarget = new THREE.Vector3()
const _vel = new THREE.Vector3()
const _hit: NearestHit = { s: 0, index: 0, lateral: 0, height: 0, distance: 0, onRoad: false }

let warnedNaN = false

/** A built car model whose materials we own (cloned), so we can fade it. */
interface FadeModel {
  group: THREE.Group
  materials: THREE.Material[]
  restore: () => void
  /** Collider box, model space. */
  half: THREE.Vector3
  center: THREE.Vector3
  anchors: CarAnchors | null
}

/**
 * Build the car through the vehicle catalog and give it private copies of
 * its materials: the catalog may share materials between cars, and fading
 * a shared one would fade the player's car too.
 */
function buildFadeModel(body: string, paint: string, glow: string): FadeModel {
  const group = vehicle.buildModel(body, paint, glow)
  const swaps: { mesh: THREE.Mesh; original: THREE.Material | THREE.Material[] }[] = []
  const materials: THREE.Material[] = []
  group.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh || !mesh.material) return
    swaps.push({ mesh, original: mesh.material })
    if (Array.isArray(mesh.material)) {
      mesh.material = mesh.material.map((m) => {
        const c = m.clone()
        materials.push(c)
        return c
      })
    } else {
      const c = mesh.material.clone()
      materials.push(c)
      mesh.material = c
    }
  })

  // Collider size: the vehicle can say exactly (userData.collider), otherwise
  // measure the model and keep it to car-like proportions.
  const half = DEFAULT_HALF.clone()
  const center = DEFAULT_CENTER.clone()
  const declared = group.userData.collider as { halfExtents?: THREE.Vector3Like; offset?: THREE.Vector3Like } | undefined
  if (declared?.halfExtents) {
    half.set(declared.halfExtents.x, declared.halfExtents.y, declared.halfExtents.z)
    if (declared.offset) center.set(declared.offset.x, declared.offset.y, declared.offset.z)
  } else {
    const box = new THREE.Box3().setFromObject(group)
    if (!box.isEmpty()) {
      box.getSize(half).multiplyScalar(0.5)
      box.getCenter(center)
      half.set(THREE.MathUtils.clamp(half.x, 0.5, 1.4), THREE.MathUtils.clamp(half.y, 0.3, 1.0), THREE.MathUtils.clamp(half.z, 1.2, 3.0))
    }
  }

  return {
    group,
    materials,
    half,
    center,
    anchors: (group.userData.anchors as CarAnchors | undefined) ?? null,
    restore: () => {
      for (const s of swaps) s.mesh.material = s.original
      for (const m of materials) m.dispose()
    },
  }
}

function setOpacity(model: FadeModel, alpha: number): void {
  const fading = alpha < 0.999
  for (let i = 0; i < model.materials.length; i++) {
    const m = model.materials[i]
    const base = (m.userData.baseOpacity as number | undefined) ?? (m.userData.baseOpacity = m.opacity)
    const wasTransparent = (m.userData.baseTransparent as boolean | undefined) ?? (m.userData.baseTransparent = m.transparent)
    const want = fading || wasTransparent
    if (m.transparent !== want) {
      m.transparent = want
      m.needsUpdate = true
    }
    m.opacity = base * alpha
  }
}

function RemoteCar({ peer }: { peer: PeerInfo }) {
  const { world, rapier } = useRapier()

  // The car's entry in core/telemetry `cars` (added while visible).
  const car = useMemo<CarState>(() => makeCarState(peer.carId, 'remote', peer.name), [peer.carId])
  car.name = peer.name
  car.body = peer.body
  car.paint = peer.paint
  car.glow = peer.glow
  car.trail = peer.trail

  // Visual root: posed every frame. The model and name tag hang off it.
  const root = useMemo(() => {
    const g = new THREE.Group()
    g.name = `remote:${peer.carId}`
    g.visible = false
    return g
  }, [peer.carId])
  car.object = root

  const tag = useMemo(() => buildNameTag(peer.name, peer.glow), [peer.name, peer.glow])
  useEffect(() => {
    root.add(tag)
    return () => {
      root.remove(tag)
      disposeNameTag(tag)
    }
  }, [root, tag])

  // ---- the car model (waits for the vehicle catalog to be installed) ----
  const [model, setModel] = useState<FadeModel | null>(null)
  useEffect(() => {
    let built: FadeModel | null = null
    let cancelled = false
    const tryBuild = (): boolean => {
      if (!apiInstalled().vehicle) return false
      try {
        built = buildFadeModel(peer.body, peer.paint, peer.glow)
      } catch (err) {
        console.error(`[net] could not build ${peer.name}'s car "${peer.body}"`, err)
        return true
      }
      if (!cancelled) setModel(built)
      return true
    }
    let timer: ReturnType<typeof setInterval> | null = null
    if (!tryBuild()) timer = setInterval(() => tryBuild() && timer && clearInterval(timer), 500)
    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
      if (built) {
        built.group.removeFromParent()
        built.restore()
        vehicle.disposeModel(built.group)
      }
    }
  }, [peer.body, peer.paint, peer.glow, peer.name])

  useEffect(() => {
    if (!model) return
    root.add(model.group)
    car.anchors = model.anchors
    return () => {
      root.remove(model.group)
    }
  }, [root, model, car])

  // ---- the solid half: an imperative kinematic body ----
  const bodyRef = useRef<RapierRigidBody | null>(null)
  const colliderRef = useRef<RapierCollider | null>(null)
  const bodyLive = useRef(false)

  useEffect(() => {
    const body = world.createRigidBody(
      rapier.RigidBodyDesc.kinematicPositionBased().setTranslation(PARK.x, PARK.y, PARK.z).setCanSleep(false),
    )
    bodyRef.current = body
    bodyLive.current = false
    return () => {
      bodyRef.current = null
      colliderRef.current = null
      try {
        // Removing the body takes its collider with it.
        if (world.bodies.contains(body.handle)) world.removeRigidBody(body)
      } catch (err) {
        // The whole physics world was torn down first (track change): nothing left to remove.
        console.debug('[net] remote body already gone with its world', err)
      }
    }
  }, [world, rapier])

  // Collider: rebuilt when the model (and so the size) arrives.
  useEffect(() => {
    const body = bodyRef.current
    if (!body) return
    const half = model?.half ?? DEFAULT_HALF
    const center = model?.center ?? DEFAULT_CENTER
    const collider = world.createCollider(
      rapier.ColliderDesc.cuboid(half.x, half.y, half.z)
        .setTranslation(center.x, center.y, center.z)
        .setFriction(0.35)
        .setRestitution(0.1)
        .setCollisionGroups(getSettings().multiplayerRam ? GROUPS.remote : GROUPS.remoteGhost),
      body,
    )
    colliderRef.current = collider
    tagCollider(collider.handle, { kind: 'remote', id: peer.carId })
    return () => {
      untagCollider(collider.handle)
      if (colliderRef.current === collider) colliderRef.current = null
      try {
        if (world.colliders.contains(collider.handle)) world.removeCollider(collider, false)
      } catch (err) {
        console.debug('[net] remote collider already gone with its world', err)
      }
    }
  }, [world, rapier, model, peer.carId])

  // Ramming on / off, live from the settings menu.
  const ram = useSettings((s) => s.multiplayerRam)
  useEffect(() => {
    colliderRef.current?.setCollisionGroups(ram ? GROUPS.remote : GROUPS.remoteGhost)
  }, [ram, model])

  // Shown = this player is driving on our track and packets are fresh.
  const shown = (now: number): boolean => {
    const buf = peerPoses.get(peer.id)
    if (!buf || now - buf.lastRecv > STALE_MS) return false
    const live = liveFor(peer.id)
    const track = getTrack()
    return live.driving && !!track && live.trackKey === track.key
  }

  // ---- physics step: hand the collider its next pose ----
  useBeforePhysicsStep(() => {
    const body = bodyRef.current
    if (!body) return
    const now = performance.now()
    const buf = peerPoses.get(peer.id)
    if (!buf || !shown(now) || !buf.sample(now - INTERP_MS, _pos, _quat)) {
      if (bodyLive.current) {
        bodyLive.current = false
        body.setTranslation(PARK, false)
      }
      return
    }
    // NaN firewall (packets were checked on arrival; this guards the maths since).
    if (!finite3(_pos.x, _pos.y, _pos.z) || !Number.isFinite(_quat.w)) {
      if (!warnedNaN) {
        warnedNaN = true
        console.warn(`[net] ${peer.name}'s pose went non-finite; parking their car`)
      }
      bodyLive.current = false
      body.setTranslation(PARK, false)
      return
    }
    // First appearance or a reset (R): teleport. Sweeping there would hit
    // everything in between at a crazy speed.
    if (!bodyLive.current || _prevTarget.distanceToSquared(_pos) > TELEPORT_JUMP_M * TELEPORT_JUMP_M) {
      body.setTranslation(_pos, false)
      body.setRotation(_quat, false)
    } else {
      body.setNextKinematicTranslation(_pos)
      body.setNextKinematicRotation(_quat)
    }
    _prevTarget.copy(_pos)
    bodyLive.current = true
  })

  // ---- contact: is OUR car touching this one right now? ----
  // Checked from our own physics every step (a real contact between our
  // chassis and this car's body). It feeds two things:
  //   - a ram: we send them their share of the hit (net/bump.ts), because
  //     nothing else would ever push their car on their screen
  //   - tag: if we're "it", they are now (only the "it" player decides)
  // With ramming off there are no contacts; rounds.ts tags by distance.
  const touch = useMemo(() => {
    const state = { hit: false, collider: null as RapierCollider | null, mine: null as RapierCollider | null }
    const onManifold = (manifold: { numContacts: () => number }) => {
      if (manifold.numContacts() > 0) state.hit = true
    }
    const onPair = (other: RapierCollider) => {
      if (state.hit || !state.collider) return
      if (ownerOf(other.handle)?.id !== 'player') return
      world.contactPair(state.collider, other, onManifold)
      if (state.hit) state.mine = other
    }
    return { state, onPair }
  }, [world])
  useAfterPhysicsStep(() => {
    const collider = colliderRef.current
    if (!collider || !bodyLive.current) return
    touch.state.hit = false
    touch.state.mine = null
    touch.state.collider = collider
    world.contactPairsWith(collider, touch.onPair)
    // (Read through a typed local: the callback above sets these, which TypeScript can't see.)
    const mineCollider = touch.state.mine as RapierCollider | null
    if (!touch.state.hit || !mineCollider) return
    const mine = mineCollider.parent() as RapierRigidBody | null
    if (mine) maybeBump(peer.id, mine, car)
    if (canTag()) tagged(peer.id)
  })

  // ---- render frame: pose the visual, fade, keep `cars` up to date ----
  const alpha = useRef(0)
  const registered = useRef(false)
  const lastPos = useRef(new THREE.Vector3())
  useEffect(
    () => () => {
      if (registered.current) removeCar(car.id)
      registered.current = false
    },
    [car],
  )

  useFrame((state, dt) => {
    const now = performance.now()
    const buf = peerPoses.get(peer.id)
    const show = shown(now) && !!buf && buf.sample(now - INTERP_MS, _vpos, _vquat)

    // Fade toward shown / hidden.
    const target = show ? 1 : 0
    const step = Math.min(1, dt / FADE_S)
    alpha.current = target > alpha.current ? Math.min(1, alpha.current + step) : Math.max(0, alpha.current - step)
    const a = alpha.current
    root.visible = a > 0.001
    if (model) setOpacity(model, a)
    ;(tag.material as THREE.SpriteMaterial).opacity = a

    // Join / leave `cars` with the fade, so the HUD and fx see only live cars.
    if (show && !registered.current) {
      addCar(car)
      registered.current = true
    } else if (!show && a <= 0.001 && registered.current) {
      removeCar(car.id)
      registered.current = false
    }
    if (!show || !buf) return

    // Velocity from motion (skip on a teleport-sized jump).
    if (dt > 0 && registered.current && lastPos.current.distanceToSquared(_vpos) < TELEPORT_JUMP_M * TELEPORT_JUMP_M) {
      _vel.subVectors(_vpos, lastPos.current).divideScalar(dt)
      car.velocity.lerp(_vel, Math.min(1, dt * 12))
    } else {
      car.velocity.set(0, 0, 0)
    }
    lastPos.current.copy(_vpos)

    root.position.copy(_vpos)
    root.quaternion.copy(_vquat)
    car.position.copy(_vpos)
    car.quaternion.copy(_vquat)
    car.speedKmh = buf.speedKmh
    car.boost = buf.boost
    car.slip = buf.slip
    car.airborne = (buf.flags & POSE_FLAG.airborne) !== 0

    const track = getTrack()
    if (track) {
      track.nearest(_vpos.x, _vpos.y, _vpos.z, _hit, car.trackS)
      car.trackS = _hit.s
      car.lap = liveFor(peer.id).lap
      car.progress = car.lap + _hit.s / track.length
    }

    // Name tag: above the roof, upright in world space, bigger with distance
    // so it stays readable (capped so a far car isn't all label).
    tag.position.set(0, (model?.center.y ?? 0.55) + (model?.half.y ?? 0.5) + 0.9, 0)
    const dist = state.camera.position.distanceTo(_vpos)
    const k = THREE.MathUtils.clamp(dist / 18, 1, 5)
    tag.scale.set(TAG_WORLD_WIDTH * k, TAG_WORLD_HEIGHT * k, 1)
  })

  return <primitive object={root} />
}

/** Mounted inside <Physics>. One car per player who has said hello. */
export function RemoteCars() {
  const peers = useNet((s) => s.peers)
  return (
    <>
      {Object.values(peers).map((p) => (
        <RemoteCar key={p.id} peer={p} />
      ))}
    </>
  )
}
