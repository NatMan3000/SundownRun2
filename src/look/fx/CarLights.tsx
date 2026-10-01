// ============================================================
//  CAR LIGHTS - every car's light, in a handful of draw calls
// ------------------------------------------------------------
//  For each car in `cars` (core/telemetry.ts):
//    - light trails from both tail lights (LightTrails.ts), stronger
//      while sliding or boosting; ghosts get a faint one only
//    - underglow: a glowing strip along each side of the belly, plus
//      a soft pool of coloured light on the road under the car
//    - headlight beams at night: this hands each lamp's position and
//      aim to fx/beams.ts, and the post stack draws the beams as soft
//      volumes of light (post/HeadlightBeamsEffect.ts). The player's
//      real road lighting is HeadlightRig.tsx.
//    - a pulsing aura on the car that is "it" in tag
//
//  Each of those is one instanced mesh shared by every car, so six
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
import { useGame } from '../../core/store'
import { QUALITY_PRESETS } from '../quality'
import { lookState } from '../lookState'
import { LightTrails } from './LightTrails'
import { BEAM_TUNE, MAX_BEAM_LAMPS, beamLamps } from './beams'

/** Live handles for dev inspection (the fx meshes of the mounted CarLights). */
export const carLightsDebug: { trails: LightTrails | null; pools: THREE.InstancedMesh | null } = { trails: null, pools: null }

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

/** The light pool: a soft oval of light on the road, fading out far from the camera. */
const poolVertex = /* glsl */ `
attribute float aGlow;
varying float vGlow;
varying vec3 vColor;
varying vec2 vLocal;
varying float vDist;
void main() {
  vGlow = aGlow;
  vColor = instanceColor;
  vLocal = position.xz;
  vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`
const poolFragment = /* glsl */ `
varying float vGlow;
varying vec3 vColor;
varying vec2 vLocal;
varying float vDist;
void main() {
  float r = length(vLocal);
  // wide and soft: most of the light lands around the car, not hidden under it
  float pool = 1.0 - smoothstep(0.1, 1.0, r);
  pool *= 0.55 + 0.45 * pool;
  float a = pool * vGlow * (1.0 - smoothstep(180.0, 320.0, vDist));
  if (a < 0.002) discard;
  gl_FragColor = vec4(vColor * a, 1.0);
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
  vRim = 1.0 - abs(dot(n, normalize(-p.xyz)));
  gl_Position = projectionMatrix * p;
}
`
const auraFragment = /* glsl */ `
varying float vGlow;
varying vec3 vColor;
varying float vRim;
void main() {
  float a = pow(vRim, 2.5) * vGlow;
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
  /** The car's glow colour, parsed once (re-parsed only when it changes). */
  glowHex: string
  glow: THREE.Color
}

/** Fixed table of per-car fx state (a plain array: no per-frame iterators). */
const fxCars: FxCar[] = []
for (let i = 0; i < MAX_FX_CARS; i++) {
  fxCars.push({ id: '', trailL: -1, trailR: -1, pool: 0, trail: 0, seen: false, glowHex: '', glow: new THREE.Color() })
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

function anchorToWorld(car: CarState, local: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  return out.copy(local).applyQuaternion(car.quaternion).add(car.position)
}

export function CarLights() {
  const level = useGame((s) => s.qualityLevel)

  const fx = useMemo(() => {
    const trails = new LightTrails(MAX_FX_CARS * 2)

    // underglow strips: a unit bar 2 m long along z, scaled to each body's belly length
    const barGeo = new THREE.BoxGeometry(0.05, 0.035, 2)
    const bars = instanced(barGeo, barVertex, barFragment, MAX_FX_CARS * 2, false, 'fx-underglow-strips')

    const poolGeo = new THREE.PlaneGeometry(2, 2)
    poolGeo.rotateX(-Math.PI / 2)
    const pools = instanced(poolGeo, poolVertex, poolFragment, MAX_FX_CARS, true, 'fx-underglow-pools')

    const auraGeo = new THREE.SphereGeometry(1, 20, 14)
    const auras = instanced(auraGeo, auraVertex, auraFragment, MAX_FX_CARS, true, 'fx-tag-aura')

    carLightsDebug.trails = trails
    carLightsDebug.pools = pools.mesh
    return { trails, bars, pools, auras }
  }, [])

  useEffect(() => {
    fx.trails.setLength(QUALITY_PRESETS[level].trailSegments)
    lookState.fx.trailSegments = fx.trails.length
  }, [fx, level])

  useEffect(
    () => () => {
      fx.trails.dispose()
      for (const k of [fx.bars, fx.pools, fx.auras]) {
        k.mesh.geometry.dispose()
        ;(k.mesh.material as THREE.Material).dispose()
        k.mesh.dispose()
      }
      for (const c of fxCars) c.id = ''
      beamLamps.count = 0
    },
    [fx],
  )

  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 0.05)
    const time = state.clock.elapsedTime
    const head = environment.headlights

    for (let i = 0; i < MAX_FX_CARS; i++) fxCars[i].seen = false

    let bars = 0
    let pools = 0
    let auras = 0
    beamLamps.count = 0

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
      if (tl.length > 0 && f.trailL >= 0) {
        anchorToWorld(car, tl[0], _v)
        fx.trails.feed(f.trailL, _v.x, _v.y, _v.z, f.trail, car.trail, dt)
      }
      if (tl.length > 1 && f.trailR >= 0) {
        anchorToWorld(car, tl[1], _v)
        fx.trails.feed(f.trailR, _v.x, _v.y, _v.z, f.trail, car.trail, dt)
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

      // ---- the light pool on the road (fades when the road is far below)
      const groundY = anchors.wheels.length ? anchors.wheels[0].y : ug.y - 0.12
      const poolTarget = car.airborne ? 0 : 1
      f.pool += (poolTarget - f.pool) * (1 - Math.exp(-(car.airborne ? 10 : 4) * dt))
      if (f.pool > 0.01) {
        _v.set(0, groundY + 0.04, 0)
        anchorToWorld(car, _v, _p)
        _s.set(ug.halfWidth + 1.25, 1, ug.halfLength + 1.5)
        _m.compose(_p, car.quaternion, _s)
        fx.pools.mesh.setMatrixAt(pools, _m)
        fx.pools.mesh.setColorAt(pools, f.glow)
        fx.pools.glow[pools] = GLOW.T0 * (0.6 + 0.5 * environment.night) * f.pool
        pools++
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
    finish(fx.pools, pools)
    finish(fx.auras, auras)
    lookState.fx.trails = fx.trails.activeCount()
  })

  return (
    <>
      <primitive object={fx.bars.mesh} />
      <primitive object={fx.pools.mesh} />
      <primitive object={fx.trails.mesh} />
      <primitive object={fx.auras.mesh} />
    </>
  )
}
