// ============================================================
//  CAR MODEL - a drawable car: body, lights, four wheels
// ------------------------------------------------------------
//  buildCarModel(body, paint, glow) returns a THREE.Group whose
//  origin is the car's physics origin (the same point as
//  telemetry.carPosition and CarState.position). The same builder
//  makes the player's car, the Ai cars, remote multiplayer cars,
//  the ghost and the garage preview.
//
//    group
//     |- sprung   leans and pitches on springs: paint, glass, trim, lights
//     |- wheel x4 steer group (at the hub) -> spin group -> wheel mesh
//
//  group.userData (plain data, safe to clone):
//    collider  { halfExtents, offset }  the chassis box (net uses it)
//    anchors   CarAnchors               light / underglow / wheel points (look uses it)
//    bodyId
//
//  8 draw calls per car: paint, glass, trim, lights, 4 wheels.
//
//  Live animation (suspension, steering, wheel spin, body roll, brake
//  lights) goes through poseCarModel(); colours through
//  setCarColors(). Both are allocation-free.
// ============================================================

import * as THREE from 'three'
import { GLOW, PALETTE } from '../core/palette'
import type { CarAnchors } from '../core/telemetry'
import { bodyEntry } from './bodies/catalog'
import type { BodyId } from './bodies/catalog'
import { bodyGeometry, wheelGeometry } from './bodies/build'
import { CHASSIS, ROAD_Y_AT_REST, WHEEL } from './tuning'

/** Everything needed to animate one model. Kept outside userData (materials don't clone). */
interface CarRig {
  sprung: THREE.Group
  steer: THREE.Group[]
  spin: THREE.Group[]
  materials: THREE.Material[]
  paint: THREE.MeshPhysicalMaterial | null
  lightUniforms: { uLivery: { value: THREE.Color }; uHead: { value: THREE.Color }; uTail: { value: THREE.Color } } | null
  wheelUniforms: { uGlow: { value: THREE.Color } } | null
  lastPaint: string
  lastGlow: string
  lastBrake: number
}

const rigs = new WeakMap<THREE.Group, CarRig>()

/** Wheel centres at rest, chassis-local: FL, FR, RL, RR. */
export const WHEEL_REST_Y = WHEEL.anchorY - WHEEL.restLength + 0.1
const WHEEL_X = [WHEEL.halfTrack, -WHEEL.halfTrack, WHEEL.halfTrack, -WHEEL.halfTrack]
const WHEEL_Z = [WHEEL.halfBase, WHEEL.halfBase, -WHEEL.halfBase, -WHEEL.halfBase]

const _c = new THREE.Color()

// ---------------------------------------------------------------- materials

/**
 * One material for every glowing part of a car. `aLight` per vertex picks
 * livery (0), headlight (1) or tail light (2); the colours are HDR uniforms
 * (colour x GLOW tier), so the lights bloom and the brake lights can flare
 * without touching geometry.
 */
function makeLightMaterial(): { mat: THREE.MeshBasicMaterial; uniforms: NonNullable<CarRig['lightUniforms']> } {
  const uniforms = {
    uLivery: { value: new THREE.Color() },
    uHead: { value: new THREE.Color() },
    uTail: { value: new THREE.Color() },
  }
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff })
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uLivery = uniforms.uLivery
    shader.uniforms.uHead = uniforms.uHead
    shader.uniforms.uTail = uniforms.uTail
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aLight;\nvarying float vLight;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLight = aLight;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uLivery;\nuniform vec3 uHead;\nuniform vec3 uTail;\nvarying float vLight;')
      .replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        'vec3 lightCol = vLight < 0.5 ? uLivery : (vLight < 1.5 ? uHead : uTail);\nvec4 diffuseColor = vec4( lightCol, opacity );',
      )
  }
  mat.customProgramCacheKey = () => 'sr2-car-lights'
  return { mat, uniforms }
}

/** Wheel: palette vertex colours, plus an emissive rim ring (`aGlow`) in the car's glow colour. */
function makeWheelMaterial(): { mat: THREE.MeshStandardMaterial; uniforms: NonNullable<CarRig['wheelUniforms']> } {
  const uniforms = { uGlow: { value: new THREE.Color() } }
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.55 })
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uGlow = uniforms.uGlow
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aGlow;\nvarying float vGlow;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aGlow;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uGlow;\nvarying float vGlow;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += uGlow * vGlow;')
  }
  mat.customProgramCacheKey = () => 'sr2-car-wheel'
  return { mat, uniforms }
}

/** One shared see-through material per ghost model. */
function makeGhostMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: PALETTE.ghost,
    emissive: PALETTE.ghost,
    emissiveIntensity: 0.7,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
    roughness: 0.4,
    metalness: 0,
  })
}

// ---------------------------------------------------------------- build

export interface BuildOptions {
  /** A translucent ghost (no shadows, one shared material). */
  ghost?: boolean
  /** Cast shadows (player car on the high preset). */
  shadows?: boolean
}

/** Build a car model. The caller owns it: dispose with disposeCarModel(). */
export function buildCarModel(bodyId: string, paint: string, glow: string, opts: BuildOptions = {}): THREE.Group {
  const id = bodyEntry(bodyId).id as BodyId
  const g = bodyGeometry(id)
  const group = new THREE.Group()
  group.name = `car:${id}`
  const sprung = new THREE.Group()
  sprung.name = 'sprung'
  group.add(sprung)

  const materials: THREE.Material[] = []
  let paintMat: THREE.MeshPhysicalMaterial | null = null
  let lightUniforms: CarRig['lightUniforms'] = null
  let wheelUniforms: CarRig['wheelUniforms'] = null
  let glassMat: THREE.Material
  let trimMat: THREE.Material
  let lightMat: THREE.Material
  let wheelMat: THREE.Material

  if (opts.ghost) {
    const m = makeGhostMaterial()
    materials.push(m)
    paintMat = null
    glassMat = trimMat = lightMat = wheelMat = m
  } else {
    // Dark glossy paint: metal flake under a clear coat, so it mirrors the neon world.
    paintMat = new THREE.MeshPhysicalMaterial({
      color: paint,
      metalness: 0.5,
      roughness: 0.18,
      clearcoat: 1,
      clearcoatRoughness: 0.03,
      envMapIntensity: 1.4,
    })
    glassMat = new THREE.MeshPhysicalMaterial({ color: PALETTE.road, metalness: 0.9, roughness: 0.06, clearcoat: 1, envMapIntensity: 1.5 })
    trimMat = new THREE.MeshStandardMaterial({ color: PALETTE.citySilhouette, metalness: 0.3, roughness: 0.62 })
    const lm = makeLightMaterial()
    lightMat = lm.mat
    lightUniforms = lm.uniforms
    const wm = makeWheelMaterial()
    wheelMat = wm.mat
    wheelUniforms = wm.uniforms
    materials.push(paintMat, glassMat, trimMat, lightMat, wheelMat)
  }

  const paintMesh = new THREE.Mesh(g.paint, paintMat ?? glassMat)
  paintMesh.castShadow = !!opts.shadows
  paintMesh.receiveShadow = !opts.ghost
  const glassMesh = new THREE.Mesh(g.glass, glassMat)
  const trimMesh = new THREE.Mesh(g.trim, trimMat)
  const lightMesh = new THREE.Mesh(g.lights, lightMat)
  sprung.add(paintMesh, glassMesh, trimMesh, lightMesh)

  const steer: THREE.Group[] = []
  const spin: THREE.Group[] = []
  const wg = wheelGeometry()
  for (let i = 0; i < 4; i++) {
    const s = new THREE.Group()
    s.position.set(WHEEL_X[i], WHEEL_REST_Y, WHEEL_Z[i])
    const sp = new THREE.Group()
    // Mirror the right-hand pair so the disc face and glow ring sit outboard on both sides.
    if (i % 2 === 1) sp.scale.set(-1, 1, 1)
    const wm = new THREE.Mesh(wg, wheelMat)
    wm.castShadow = !!opts.shadows
    sp.add(wm)
    s.add(sp)
    group.add(s)
    steer.push(s)
    spin.push(sp)
  }
  if (opts.ghost) group.traverse((o) => ((o as THREE.Mesh).renderOrder = 10))

  const anchors: CarAnchors = {
    tailLights: g.tailLights.map((v) => v.clone()),
    headLights: g.headLights.map((v) => v.clone()),
    underglow: { ...g.underglow },
    wheels: [0, 1, 2, 3].map((i) => new THREE.Vector3(WHEEL_X[i], ROAD_Y_AT_REST, WHEEL_Z[i])),
  }
  group.userData.collider = {
    halfExtents: { ...CHASSIS.halfExtents },
    offset: { x: 0, y: CHASSIS.offsetY, z: 0 },
  }
  group.userData.anchors = anchors
  group.userData.bodyId = id

  const rig: CarRig = {
    sprung,
    steer,
    spin,
    materials,
    paint: paintMat,
    lightUniforms,
    wheelUniforms,
    lastPaint: '',
    lastGlow: '',
    lastBrake: -1,
  }
  rigs.set(group, rig)
  setCarColors(group, paint, glow)
  setCarBrake(group, 0)
  return group
}

/** Recolour a model in place (garage changes apply live). Cheap when nothing changed. */
export function setCarColors(group: THREE.Group, paint: string, glow: string): void {
  const rig = rigs.get(group)
  if (!rig) return
  if (paint !== rig.lastPaint) {
    rig.lastPaint = paint
    rig.paint?.color.set(paint)
  }
  if (glow !== rig.lastGlow) {
    rig.lastGlow = glow
    if (rig.lightUniforms) {
      rig.lightUniforms.uLivery.value.set(glow).multiplyScalar(GLOW.T2)
      rig.lightUniforms.uHead.value.set(PALETTE.laneLine).multiplyScalar(GLOW.T2)
    }
    if (rig.wheelUniforms) rig.wheelUniforms.uGlow.value.set(glow).multiplyScalar(GLOW.T2 * 0.8)
  }
}

/** Brake lights: a soft glow at rest, flaring under braking (still inside the T2 band). */
export function setCarBrake(group: THREE.Group, brake: number): void {
  const rig = rigs.get(group)
  if (!rig || !rig.lightUniforms) return
  const b = Math.round(brake * 20) / 20
  if (b === rig.lastBrake) return
  rig.lastBrake = b
  rig.lightUniforms.uTail.value.copy(_c.set(PALETTE.sunBottom)).multiplyScalar(GLOW.T1 + (GLOW.T2 * 1.4 - GLOW.T1) * b)
}

/** Per-frame pose data for a model (the sim's wheel and body state). */
export interface ModelPose {
  wheelHubY: ArrayLike<number>
  wheelSpin: ArrayLike<number>
  steerAngle: number
  roll: number
  pitch: number
}

/** Apply suspension travel, steering, wheel spin and body lean. No allocation. */
export function poseCarModel(group: THREE.Group, p: ModelPose): void {
  const rig = rigs.get(group)
  if (!rig) return
  rig.sprung.rotation.z = p.roll
  rig.sprung.rotation.x = -p.pitch
  for (let i = 0; i < 4; i++) {
    const s = rig.steer[i]
    const y = p.wheelHubY[i]
    s.position.y = Number.isFinite(y) ? y : WHEEL_REST_Y
    s.rotation.y = i < 2 ? p.steerAngle : 0
    rig.spin[i].rotation.x = p.wheelSpin[i]
  }
}

/** Free a model's materials. Geometry is cached per body and shared, so it stays. */
export function disposeCarModel(group: THREE.Group): void {
  const rig = rigs.get(group)
  if (!rig) return
  for (const m of rig.materials) m.dispose()
  rigs.delete(group)
  group.removeFromParent()
}
