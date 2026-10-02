// ============================================================
//  CAR LIGHTS - every car's light, in a handful of draw calls
// ------------------------------------------------------------
//  For each car in `cars` (core/telemetry.ts):
//    - light trails from both tail lights (LightTrails.ts), stronger
//      while sliding or boosting; ghosts get a faint one only. In the
//      Garage the parked player car shows its trail as if it were
//      driving, so a new trail colour shows the moment you pick it
//      (same mesh: no extra draw)
//    - underglow: a glowing strip along each side of the belly, plus
//      a soft pool of coloured light on the ground under the car
//    - reversing: a soft pool of white light on the ground behind the
//      car while its reverse lights are on (the model says how lit
//      they are in userData.reverseLight), so you can see where you
//      are backing at night
//      Both pools are handed to fx/groundPools.ts, and the post stack
//      adds them to whatever ground the picture shows there
//      (post/GroundPoolsEffect.ts), so they follow the real road and
//      hills instead of being flat squares the ground can cut through.
//      No draw call at all.
//    - headlight beams at night: this hands each lamp's position and
//      aim to fx/beams.ts, and the post stack draws the beams as soft
//      volumes of light (post/HeadlightBeamsEffect.ts). The player's
//      real road lighting is HeadlightRig.tsx.
//    - a pulsing aura on the car that is "it" in tag
//
//  The rest are each one instanced mesh shared by every car, so six
//  racers cost the same handful of draw calls as one. Everything is
//  placed from the car's render pose and its fx anchors (set by the
//  vehicle system when it builds the body), with module-level temps:
//  nothing is allocated per frame.
// ============================================================

import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { GLOW, PALETTE } from '../../core/palette'
import { cars, environment } from '../../core/telemetry'
import type { CarState } from '../../core/telemetry'
import { getGame, useGame } from '../../core/store'
import { QUALITY_PRESETS } from '../quality'
import { lookState } from '../lookState'
import { LightTrails, TRAIL_RATE } from './LightTrails'
import { CONFIG } from '../../core/config'
import { BEAM_TUNE, MAX_BEAM_LAMPS, beamLamps } from './beams'
import { MAX_GROUND_POOLS, groundPools } from './groundPools'

/** Live handles for dev inspection (the fx meshes of the mounted CarLights). */
export const carLightsDebug: { trails: LightTrails | null } = { trails: null }

/** Most cars that get light at once (player + 5 Ai + ghost + remote players). */
export const MAX_FX_CARS = 12

// ---------------------------------------------------------------- shaders

/** Unlit glow for the underglow strips: colour x glow tier. */
const barVertex = /* glsl */ `
attribute float aGlow;
varying float vGlow;
varying vec3 vColor;
void main() {
  vGlow = aGlow;
  vColor = instanceColor;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`
const barFragment = /* glsl */ `
varying float vGlow;
varying vec3 vColor;
void main() {
  if (vGlow < 0.001) discard;
  gl_FragColor = vec4(vColor * vGlow, 1.0);
}
`

/** Tag aura: a glowing shell, bright at its rim. */
const auraVertex = /* glsl */ `
attribute float aGlow;
varying float vGlow;
varying vec3 vColor;
varying float vRim;
void main() {
  vGlow = aGlow;
  vColor = instanceColor;
  mat4 mv = modelViewMatrix * instanceMatrix;
  vec4 p = mv * vec4(position, 1.0);
  vec3 n = normalize(mat3(mv) * normal);
  // clamped: rounding can push abs(dot) a hair over 1, and pow() of the
  // negative leftover (in the fragment shader) is NaN
  vRim = clamp(1.0 - abs(dot(n, normalize(-p.xyz))), 0.0, 1.0);
  gl_Position = projectionMatrix * p;
}
`
const auraFragment = /* glsl */ `
varying float vGlow;
varying vec3 vColor;
varying float vRim;
void main() {
  float a = pow(max(vRim, 0.0), 2.5) * vGlow;
  if (a < 0.002) discard;
  gl_FragColor = vec4(vColor * a, 1.0);
}
`

function instanced(geo: THREE.BufferGeometry, vertexShader: string, fragmentShader: string, count: number, additive: boolean, name: string) {
  const glow = new Float32Array(count)
  const glowAttr = new THREE.InstancedBufferAttribute(glow, 1).setUsage(THREE.DynamicDrawUsage)
  geo.setAttribute('aGlow', glowAttr)
  const mat = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: additive,
    depthWrite: !additive,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    side: additive ? THREE.DoubleSide : THREE.FrontSide,
    fog: false,
  })
  const mesh = new THREE.InstancedMesh(geo, mat, count)
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  mesh.setColorAt(0, new THREE.Color(1, 1, 1))
  mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  mesh.frustumCulled = false
  mesh.count = 0
  mesh.name = name
  if (additive) mesh.renderOrder = 5
  return { mesh, glow, glowAttr }
}

// ---------------------------------------------------------------- per-car state

interface FxCar {
  /** Car id, or '' for a free slot. */
  id: string
  trailL: number
  trailR: number
  /** Smoothed 0..1 light-pool strength (fades out in the air). */
  pool: number
  /** Smoothed trail strength. */
  trail: number
  seen: boolean
  /** The trail is posed for the Garage preview (cleared when the Garage closes). */
  posed: boolean
  /** The car's glow colour, parsed once (re-parsed only when it changes). */
  glowHex: string
  glow: THREE.Color
}

/** Fixed table of per-car fx state (a plain array: no per-frame iterators). */
const fxCars: FxCar[] = []
for (let i = 0; i < MAX_FX_CARS; i++) {
  fxCars.push({ id: '', trailL: -1, trailR: -1, pool: 0, trail: 0, seen: false, posed: false, glowHex: '', glow: new THREE.Color() })
}

function fxFor(id: string): FxCar | null {
  for (let i = 0; i < MAX_FX_CARS; i++) if (fxCars[i].id === id) return fxCars[i]
  return null
}

function freeFx(): FxCar | null {
  for (let i = 0; i < MAX_FX_CARS; i++) if (fxCars[i].id === '') return fxCars[i]
  return null
}

type Instanced = ReturnType<typeof instanced>

function finish(k: Instanced, n: number): void {
  k.mesh.count = n
  if (n === 0) return
  k.mesh.instanceMatrix.needsUpdate = true
  k.mesh.instanceColor!.needsUpdate = true
  k.glowAttr.needsUpdate = true
}

// Module-level temps (no per-frame allocation).
const _p = new THREE.Vector3()
const _s = new THREE.Vector3()
const _v = new THREE.Vector3()
const _m = new THREE.Matrix4()
const _tag = new THREE.Color(PALETTE.tagIt)
const _fwd = new THREE.Vector3()
const _left = new THREE.Vector3()

/** The reverse lights' cool white (the same palette white as the lamps on the car). */
const _reverse = new THREE.Color(PALETTE.stars)
/**
 * The glow behind a reversing car: how far its middle sits behind the tail
 * lights, its half length and how much wider than the belly it spreads
 * (metres), and how bright it is at sundown and at full night (x GLOW.T0,
 * so it lights the road without blooming).
 */
const REVERSE_POOL = { back: 0.7, halfLength: 1.8, widen: 0.15, dusk: 0.25, night: 0.6 }

/**
 * The Garage trail preview: how fast the parked car "drives" (sets the trail's
 * length), its strength and ripple, and a gentle bend toward the car's left,
 * the side the Garage camera opens on, so the trail sweeps out from behind
 * the car into view instead of hiding behind it.
 */
const GARAGE_TRAIL = { speed: 9, strength: 0.85, wave: 0.14, curve: 0.02 }

function anchorToWorld(car: CarState, local: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  return out.copy(local).applyQuaternion(car.quaternion).add(car.position)
}

/**
 * How lit a car's reverse lights are (0..1): the model says so in its
 * userData; a multiplayer car registers the group its model hangs from.
 */
function reverseLightOf(car: CarState): number {
  const obj = car.object
  if (!obj) return 0
  let v = obj.userData.reverseLight as number | undefined
  if (v === undefined) {
    const kids = obj.children
    for (let k = 0; k < kids.length && v === undefined; k++) v = kids[k].userData.reverseLight as number | undefined
  }
  return v !== undefined && Number.isFinite(v) ? v : 0
}

/**
 * Hand one soft pool of light to the post stack (fx/groundPools.ts): its
 * middle at `local` (car space, at road level), `halfWidth` x `halfLength`
 * metres, in `colour` x `strength`. False when the hand-over is full.
 */
function addPool(car: CarState, local: THREE.Vector3, halfWidth: number, halfLength: number, colour: THREE.Color, strength: number): boolean {
  const n = groundPools.count
  if (n >= MAX_GROUND_POOLS) return false
  anchorToWorld(car, local, groundPools.centre[n])
  groundPools.forward[n].set(0, 0, 1).applyQuaternion(car.quaternion)
  groundPools.up[n].set(0, 1, 0).applyQuaternion(car.quaternion)
  groundPools.halfWidth[n] = halfWidth
  groundPools.halfLength[n] = halfLength
  // the car's body sits round its own origin: that far ahead of this pool's middle
  groundPools.bodyOffset[n] = -local.z
  groundPools.colour[n].copy(colour).multiplyScalar(strength)
  groundPools.count = n + 1
  return true
}

export function CarLights() {
  const level = useGame((s) => s.qualityLevel)

  const fx = useMemo(() => {
    const trails = new LightTrails(MAX_FX_CARS * 2)

    // underglow strips: a unit bar 2 m long along z, scaled to each body's belly length
    const barGeo = new THREE.BoxGeometry(0.05, 0.035, 2)
    const bars = instanced(barGeo, barVertex, barFragment, MAX_FX_CARS * 2, false, 'fx-underglow-strips')

    const auraGeo = new THREE.SphereGeometry(1, 20, 14)
    const auras = instanced(auraGeo, auraVertex, auraFragment, MAX_FX_CARS, true, 'fx-tag-aura')

    carLightsDebug.trails = trails
    return { trails, bars, auras }
  }, [])

  useEffect(() => {
    // config.ts trailSeconds sets how long a trail lasts; the quality preset caps how many points it may use
    fx.trails.setLength(Math.min(QUALITY_PRESETS[level].trailSegments, Math.round(CONFIG.trailSeconds * TRAIL_RATE)))
    lookState.fx.trailSegments = fx.trails.length
  }, [fx, level])

  useEffect(
    () => () => {
      fx.trails.dispose()
      for (const k of [fx.bars, fx.auras]) {
        k.mesh.geometry.dispose()
        ;(k.mesh.material as THREE.Material).dispose()
        k.mesh.dispose()
      }
      for (const c of fxCars) c.id = ''
      beamLamps.count = 0
      groundPools.count = 0
    },
    [fx],
  )

  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 0.05)
    const time = state.clock.elapsedTime
    const head = environment.headlights
    const g = getGame()
    const garage = g.garageOpen && g.phase === 'title'

    for (let i = 0; i < MAX_FX_CARS; i++) fxCars[i].seen = false

    let bars = 0
    let auras = 0
    beamLamps.count = 0
    groundPools.count = 0

    for (let i = 0; i < cars.length; i++) {
      const car = cars[i]
      const anchors = car.anchors
      if (!anchors) continue
      // skip a car whose pose is not finite this frame (a physics reset in progress)
      const cp = car.position
      const cq = car.quaternion
      if (!Number.isFinite(cp.x + cp.y + cp.z + cq.x + cq.y + cq.z + cq.w)) continue
      let f = fxFor(car.id)
      if (!f) {
        f = freeFx()
        if (!f) continue // more cars than fx slots: the extras go without
        f.id = car.id
        f.trailL = fx.trails.slotFor(`${car.id}:L`)
        f.trailR = fx.trails.slotFor(`${car.id}:R`)
        f.pool = 0
        f.trail = 0
        f.posed = false
        f.glowHex = ''
      }
      if (f.glowHex !== car.glow) {
        f.glowHex = car.glow
        f.glow.set(car.glow)
      }
      f.seen = true
      const ghost = car.kind === 'ghost'
      const speed = car.velocity.length()

      // ---- trails
      const moving = THREE.MathUtils.smoothstep(speed, 1.5, 9)
      const target = ghost ? 0.22 * moving : (0.42 + 0.58 * Math.max(car.slip, car.boost)) * moving
      f.trail += (target - f.trail) * (1 - Math.exp(-8 * dt))
      const tl = anchors.tailLights
      if (garage && car.kind === 'player') {
        // Garage preview: lay both trails out behind the parked car as if it were driving.
        _fwd.set(0, 0, 1).applyQuaternion(car.quaternion)
        // the car's left is +x in its own space (nose +z, up +y; the front-left wheel sits at +x)
        _left.set(1, 0, 0).applyQuaternion(car.quaternion)
        for (let k = 0; k < 2 && k < tl.length; k++) {
          const slot = k === 0 ? f.trailL : f.trailR
          if (slot < 0) continue
          anchorToWorld(car, tl[k], _v)
          fx.trails.pose(slot, _v.x, _v.y, _v.z, _fwd.x, _fwd.y, _fwd.z, _left.x, _left.y, _left.z, GARAGE_TRAIL.speed, GARAGE_TRAIL.wave, GARAGE_TRAIL.curve, GARAGE_TRAIL.strength, car.trail)
        }
        f.posed = true
      } else {
        if (f.posed) {
          // The Garage closed: the preview goes at once (the parked car is not really moving).
          if (f.trailL >= 0) fx.trails.clear(f.trailL)
          if (f.trailR >= 0) fx.trails.clear(f.trailR)
          f.posed = false
        }
        if (tl.length > 0 && f.trailL >= 0) {
          anchorToWorld(car, tl[0], _v)
          fx.trails.feed(f.trailL, _v.x, _v.y, _v.z, f.trail, car.trail, dt)
        }
        if (tl.length > 1 && f.trailR >= 0) {
          anchorToWorld(car, tl[1], _v)
          fx.trails.feed(f.trailR, _v.x, _v.y, _v.z, f.trail, car.trail, dt)
        }
      }
      if (ghost) continue // ghosts get a faint trail only

      const ug = anchors.underglow

      // ---- underglow strips along both sides of the belly
      for (let side = -1; side <= 1; side += 2) {
        _v.set(side * (ug.halfWidth - 0.03), ug.y - 0.02, 0)
        anchorToWorld(car, _v, _p)
        _s.set(1, 1, ug.halfLength)
        _m.compose(_p, car.quaternion, _s)
        fx.bars.mesh.setMatrixAt(bars, _m)
        fx.bars.mesh.setColorAt(bars, f.glow)
        fx.bars.glow[bars] = GLOW.T2
        bars++
      }

      // ---- the light pool on the ground (fades when the ground is far below: in the air)
      const groundY = anchors.wheels.length ? anchors.wheels[0].y : ug.y - 0.12
      const poolTarget = car.airborne ? 0 : 1
      f.pool += (poolTarget - f.pool) * (1 - Math.exp(-(car.airborne ? 10 : 4) * dt))
      if (f.pool > 0.01) {
        const night = Number.isFinite(environment.night) ? environment.night : 0
        _v.set(0, groundY, 0)
        addPool(car, _v, ug.halfWidth + 1.25, ug.halfLength + 1.5, f.glow, GLOW.T0 * (0.6 + 0.5 * night) * f.pool)

        // ---- reversing: soft white light on the ground behind the car
        const rev = reverseLightOf(car)
        if (rev > 0.01 && tl.length > 0) {
          let tailZ = 0
          for (let k = 0; k < tl.length; k++) tailZ += tl[k].z
          tailZ /= tl.length
          _v.set(0, groundY, tailZ - REVERSE_POOL.back)
          const strength = GLOW.T0 * (REVERSE_POOL.dusk + (REVERSE_POOL.night - REVERSE_POOL.dusk) * night) * rev * f.pool
          addPool(car, _v, ug.halfWidth + REVERSE_POOL.widen, REVERSE_POOL.halfLength, _reverse, strength)
        }
      }

      // ---- headlight beams at night: hand each lamp to the post stack
      if (head > 0.01) {
        const hl = anchors.headLights
        for (let k = 0; k < hl.length && k < 2 && beamLamps.count < MAX_BEAM_LAMPS; k++) {
          const n = beamLamps.count++
          anchorToWorld(car, hl[k], beamLamps.position[n])
          // straight ahead, aimed a little down, each lamp splayed slightly outward
          _v.set(hl[k].x * 0.035, -BEAM_TUNE.aimDrop, 1).normalize()
          beamLamps.direction[n].copy(_v).applyQuaternion(car.quaternion)
          beamLamps.gain[n] = head
        }
      }

      // ---- tag: the car that is "it" pulses
      if (car.isIt) {
        _p.copy(car.position)
        const pulse = 0.65 + 0.35 * Math.sin(time * 6)
        _s.set(2.4, 1.6, 3.4)
        _m.compose(_p, car.quaternion, _s)
        fx.auras.mesh.setMatrixAt(auras, _m)
        fx.auras.mesh.setColorAt(auras, _tag)
        fx.auras.glow[auras] = GLOW.T2 * pulse
        auras++
      }
    }

    // Cars that left: release their trails (their light fades out on its own).
    for (let i = 0; i < MAX_FX_CARS; i++) {
      const c = fxCars[i]
      if (c.id === '' || c.seen) continue
      if (c.trailL >= 0) fx.trails.release(c.trailL)
      if (c.trailR >= 0) fx.trails.release(c.trailR)
      c.id = ''
      c.trailL = -1
      c.trailR = -1
    }

    fx.trails.update(dt)
    finish(fx.bars, bars)
    finish(fx.auras, auras)
    lookState.fx.trails = fx.trails.activeCount()
  })

  return (
    <>
      <primitive object={fx.bars.mesh} />
      <primitive object={fx.trails.mesh} />
      <primitive object={fx.auras.mesh} />
    </>
  )
}
