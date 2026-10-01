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
//    anchors   CarAnchors               light / underglow / wheel / bonnet-camera points (look and camera use it)
//    bodyId
//
//  8 draw calls per car: paint, glass, trim, lights, 4 wheels.
//
//  Colours:
//    paint   the player's paint, plus a contrast ACCENT (wings, fins,
//            endplates) in a deep shade of their glow colour, so every
//            car is two-tone like a team car
//    lights  livery strips and the wheel rings in the glow colour, white
//            headlights, pink-red tail lights
//    rocket  the nozzle core idles softly in the glow colour; when the
//            car boosts (CarState.boost, or setCarBoost for a car with
//            no registry entry) it flares, and a flame in the same
//            colour, white-hot at the nozzle, shoots out of the back
//
//  Live animation (suspension, steering, wheel spin, body roll, brake
//  lights) goes through poseCarModel(); colours through
//  setCarColors(). Both are allocation-free. The rocket ticks itself
//  just before the car's lights draw.
//
//  Dev: __dev.nozzle(0..1) forces every car's rocket on (nozzle() to
//  let go); __game.get('carBodies') lists triangles per body.
// ============================================================

import * as THREE from 'three'
import { GLOW, PALETTE } from '../core/palette'
import { cars, environment } from '../core/telemetry'
import type { CarAnchors } from '../core/telemetry'
import { registerDev, registerInspector } from '../core/devHandles'
import { BODIES, bodyEntry } from './bodies/catalog'
import type { BodyId } from './bodies/catalog'
import { bodyGeometry, wheelGeometry } from './bodies/build'
import { CHASSIS, ROAD_Y_AT_REST, WHEEL } from './tuning'

interface LightUniforms {
  uLivery: { value: THREE.Color }
  uHead: { value: THREE.Color }
  uTail: { value: THREE.Color }
  uNozzle: { value: THREE.Color }
  uFlame: { value: THREE.Color }
  uFlameHot: { value: THREE.Color }
  /** 0..1: how far the flames are stretched out (each flame's own length x this). */
  uFlameOut: { value: number }
}

/** Everything needed to animate one model. Kept outside userData (materials don't clone). */
interface CarRig {
  group: THREE.Group
  sprung: THREE.Group
  steer: THREE.Group[]
  spin: THREE.Group[]
  materials: THREE.Material[]
  paint: THREE.MeshPhysicalMaterial | null
  accent: { value: THREE.Color } | null
  lightUniforms: LightUniforms | null
  wheelUniforms: { uGlow: { value: THREE.Color } } | null
  /** The glow colour, linear (the nozzle idles in it). */
  glow: THREE.Color
  lastPaint: string
  lastGlow: string
  lastBrake: number
  /** Boost set by hand (garage, car lab); a car in the registry uses its CarState.boost. */
  boost: number
  /** The boost the rocket is showing right now (-1 = not drawn yet). */
  shownBoost: number
}

const rigs = new WeakMap<THREE.Group, CarRig>()

/** Wheel centres at rest, chassis-local: FL, FR, RL, RR. */
export const WHEEL_REST_Y = WHEEL.anchorY - WHEEL.restLength + 0.1
const WHEEL_X = [WHEEL.halfTrack, -WHEEL.halfTrack, WHEEL.halfTrack, -WHEEL.halfTrack]
const WHEEL_Z = [WHEEL.halfBase, WHEEL.halfBase, -WHEEL.halfBase, -WHEEL.halfBase]

const _c = new THREE.Color()
const HOT_COLOUR = new THREE.Color(PALETTE.coreHot)
/** How dark the paint accent is next to the glow colour it comes from (linear multiplier). */
const ACCENT_SHADE = 0.45
/** Dark chrome for rims, nozzles and bars: the ground's sheen with a little planet-ring silver. */
const CHROME = new THREE.Color(PALETTE.groundSheen).lerp(new THREE.Color(PALETTE.planetRing), 0.35)
const RUBBER = new THREE.Color(PALETTE.ground)

// ---------------------------------------------------------------- materials

/**
 * A material that keeps its shader patch when cloned. Material.clone() does
 * not copy onBeforeCompile, so a clone (multiplayer cars clone every material
 * to fade them in) would lose the lights, the accent and the sun term.
 * The clone shares the original's uniforms, so recolouring still reaches it.
 */
function keepPatchOnClone<T extends THREE.Material>(mat: T): T {
  const baseClone = Object.getPrototypeOf(mat).clone as (this: THREE.Material) => THREE.Material
  const patched = function (this: THREE.Material): THREE.Material {
    const c = baseClone.call(this)
    c.onBeforeCompile = this.onBeforeCompile
    c.customProgramCacheKey = this.customProgramCacheKey
    return c
  }
  ;(mat as THREE.Material).clone = patched as THREE.Material['clone']
  return mat
}

/**
 * One material for every glowing part of a car. `aLight` per vertex picks
 * livery (0), headlight (1), tail light (2), rocket core (3) or rocket flame
 * (4); the colours are HDR uniforms (colour x GLOW tier), so the lights bloom
 * and the brake lights and rocket can flare without touching geometry. The
 * flame's vertices slide backward by `aFlame` x uFlameOut in the vertex
 * shader, so it grows out of the nozzle with no extra mesh.
 */
function makeLightMaterial(): { mat: THREE.MeshBasicMaterial; uniforms: LightUniforms } {
  const uniforms: LightUniforms = {
    uLivery: { value: new THREE.Color() },
    uHead: { value: new THREE.Color() },
    uTail: { value: new THREE.Color() },
    uNozzle: { value: new THREE.Color() },
    uFlame: { value: new THREE.Color() },
    uFlameHot: { value: new THREE.Color() },
    uFlameOut: { value: 0 },
  }
  const mat = new THREE.MeshBasicMaterial()
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute float aLight;\nattribute float aFlame;\nuniform float uFlameOut;\nvarying float vLight;\nvarying float vFlame;',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvLight = aLight;\nvFlame = aFlame;\nif (aLight > 3.5) transformed.z -= aFlame * uFlameOut;',
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform vec3 uLivery;\nuniform vec3 uHead;\nuniform vec3 uTail;\nuniform vec3 uNozzle;\nuniform vec3 uFlame;\nuniform vec3 uFlameHot;\nvarying float vLight;\nvarying float vFlame;',
      )
      .replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        [
          'vec3 lightCol;',
          'if (vLight < 0.5) lightCol = uLivery;',
          'else if (vLight < 1.5) lightCol = uHead;',
          'else if (vLight < 2.5) lightCol = uTail;',
          'else if (vLight < 3.5) lightCol = uNozzle;',
          // white-hot at the nozzle, the car's own colour along the plume, dimming toward the tip
          'else lightCol = mix(uFlameHot, uFlame, clamp(vFlame * 2.2, 0.0, 1.0)) * (1.0 - 0.55 * clamp(vFlame, 0.0, 1.0));',
          'vec4 diffuseColor = vec4( lightCol, opacity );',
        ].join('\n'),
      )
  }
  mat.customProgramCacheKey = () => 'sr2-car-lights-v2'
  return { mat: keepPatchOnClone(mat), uniforms }
}

/** Wheel: rubber or dark chrome per vertex (`aMetal`), plus an emissive rim ring (`aGlow`) in the car's glow colour. */
function makeWheelMaterial(): { mat: THREE.MeshStandardMaterial; uniforms: NonNullable<CarRig['wheelUniforms']> } {
  const uniforms = { uGlow: { value: new THREE.Color() } }
  const shared = { uRubber: { value: RUBBER }, uChrome: { value: CHROME } }
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0 })
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, shared)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aGlow;\nattribute float aMetal;\nvarying float vGlow;\nvarying float vMetal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aGlow;\nvMetal = aMetal;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uGlow;\nuniform vec3 uRubber;\nuniform vec3 uChrome;\nvarying float vGlow;\nvarying float vMetal;')
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4( mix( uRubber, uChrome, vMetal ), opacity );')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix( roughnessFactor, 0.24, vMetal );')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix( metalnessFactor, 0.9, vMetal );')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += uGlow * vGlow;')
  }
  mat.customProgramCacheKey = () => 'sr2-car-wheel-v2'
  return { mat: keepPatchOnClone(mat), uniforms }
}

/** Trim: matte black parts and dark chrome parts (`aMetal`) in one material. Double-sided: plates and bells. */
function makeTrimMaterial(): THREE.MeshStandardMaterial {
  const shared = { uChrome: { value: CHROME } }
  const mat = new THREE.MeshStandardMaterial({ color: PALETTE.citySilhouette, metalness: 0.3, roughness: 0.62, side: THREE.DoubleSide })
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aMetal;\nvarying float vMetal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMetal = aMetal;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uChrome;\nvarying float vMetal;')
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4( mix( diffuse, uChrome, vMetal ), opacity );')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix( roughnessFactor, 0.2, vMetal );')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix( metalnessFactor, 0.92, vMetal );')
  }
  mat.customProgramCacheKey = () => 'sr2-car-trim-v1'
  return keepPatchOnClone(mat)
}

// ---------------------------------------------------------------- paint: warm sun side

/**
 * The paint is dark and glossy, so on its own it mostly mirrors the sky.
 * At sundown that left the side of the car facing the sun violet whenever
 * the sun was behind you. This adds the sunset's warmth back to the paint,
 * worked out from the light's direction in the shader (no extra lights,
 * draws or reflection lookups):
 *
 *   wash   panels turned toward the sun glow warm, softly wrapping round
 *          the edges, tinted halfway to the paint's own hue so a navy car
 *          and a plum car stay different. Strongest on dark paints, which
 *          barely catch the key light themselves; bright paints already
 *          do, so they get little and keep their own colour.
 *   sheen  the clear coat catching the low sun: a broad warm highlight
 *          wherever a panel reflects toward the sun (the colour of the
 *          light, on every paint)
 *   rim    a thin warm edge on the sun side of the car's outline
 *
 * It follows the warm key light out (gone by timeOfDay 0.5, the same
 * window the world's sun light fades over) so night is unchanged.
 * All three share two uniforms, ticked once a frame by whichever car
 * draws first (onBeforeRender).
 */
const paintSun = {
  /** Warm colour x how much sun is left (black at night). */
  uSunWarm: { value: new THREE.Color() },
  /** World-space unit vector toward the key light (environment.keyLightDirection). */
  uSunDir: { value: new THREE.Vector3(0, 0.3, -1) },
}
/** The sunset's warmth: the sun's glow leaning to its pink bottom band (palette tokens). */
const SUN_WARM = new THREE.Color(PALETTE.skySunGlow).lerp(new THREE.Color(PALETTE.sunBottom), 0.35)
let paintSunFrame = -1

function tickPaintSun(renderer: THREE.WebGLRenderer): void {
  const frame = renderer.info.render.frame
  if (frame === paintSunFrame) return
  paintSunFrame = frame
  const sun = 1 - THREE.MathUtils.smoothstep(environment.timeOfDay, 0.22, 0.5)
  paintSun.uSunWarm.value.copy(SUN_WARM).multiplyScalar(sun)
  const d = environment.keyLightDirection
  if (Number.isFinite(d.x + d.y + d.z) && d.lengthSq() > 1e-6) paintSun.uSunDir.value.copy(d).normalize()
}

const paintSunPars = /* glsl */ `
uniform vec3 uSunWarm;
uniform vec3 uSunDir;
`
const paintSunFragment = /* glsl */ `
#include <emissivemap_fragment>
if (uSunWarm.r + uSunWarm.g + uSunWarm.b > 0.001) {
  vec3 sunV = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz); // toward the sun, view space
  vec3 eyeV = normalize(vViewPosition);                          // toward the camera
  float ndl = dot(normal, sunV);
  float wrap = clamp((ndl + 0.45) / 1.45, 0.0, 1.0);
  float ndv = clamp(dot(normal, eyeV), 0.0, 1.0);
  float paintLuma = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  float dark = 1.0 - smoothstep(0.04, 0.45, paintLuma);
  float wash = wrap * wrap * (0.015 + 0.07 * dark);
  // the wash takes on most of the paint's own hue (navy warms to violet, plum to
  // magenta, never all to maroon), so every garage paint still reads as itself;
  // sheen and rim are the light's colour
  vec3 hue = diffuseColor.rgb / max(max(diffuseColor.r, max(diffuseColor.g, diffuseColor.b)), 1e-4);
  vec3 washTint = hue;
  float sheen = pow(clamp(dot(reflect(-eyeV, normal), sunV), 0.0, 1.0), 6.0) * (0.06 + 0.3 * pow(1.0 - ndv, 3.0));
  float rim = pow(1.0 - ndv, 3.0) * smoothstep(0.0, 0.6, ndl) * 0.28;
  // the wash is the paint's own hue in half-warm light; sheen and rim are the light itself
  vec3 washLight = mix(uSunWarm, vec3(dot(uSunWarm, vec3(0.2126, 0.7152, 0.0722)) * 2.2), 0.5);
  totalEmissiveRadiance += washLight * washTint * wash + uSunWarm * (sheen + rim);
}
`

/**
 * The car paint: dark metal flake under a clear coat, plus the warm sun side
 * (above). `aAccent` per vertex swaps the paint for the accent colour, so the
 * whole painted body stays one draw call.
 */
function makePaintMaterial(paint: string): { mat: THREE.MeshPhysicalMaterial; accent: { value: THREE.Color } } {
  const accent = { value: new THREE.Color() }
  const mat = new THREE.MeshPhysicalMaterial({
    color: paint,
    metalness: 0.5,
    roughness: 0.18,
    clearcoat: 1,
    clearcoatRoughness: 0.03,
    envMapIntensity: 1.4,
  })
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSunWarm = paintSun.uSunWarm
    shader.uniforms.uSunDir = paintSun.uSunDir
    shader.uniforms.uAccent = accent
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aAccent;\nvarying float vAccent;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvAccent = aAccent;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${paintSunPars}\nuniform vec3 uAccent;\nvarying float vAccent;`)
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4( mix( diffuse, uAccent, vAccent ), opacity );')
      .replace('#include <emissivemap_fragment>', paintSunFragment)
  }
  mat.customProgramCacheKey = () => 'sr2-car-paint-sun-v5'
  return { mat: keepPatchOnClone(mat), accent }
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

// ---------------------------------------------------------------- the rocket

/** __dev.nozzle(b): force every rocket to this boost (-1 = off, follow the cars). */
let nozzleOverride = -1

/** The boost this model should show: its car's CarState.boost, else the hand-set value. */
function liveBoost(rig: CarRig): number {
  if (nozzleOverride >= 0) return nozzleOverride
  const g = rig.group
  const parent = g.parent
  for (let i = 0; i < cars.length; i++) {
    const c = cars[i]
    // a car's owner registers the model itself (player, Ai, ghost) or the group it hangs from (multiplayer)
    if (c.object === g || (parent !== null && c.object === parent)) {
      const b = Number.isFinite(c.boost) ? c.boost : 0
      return b > rig.boost ? b : rig.boost
    }
  }
  return rig.boost
}

/**
 * Light the rocket for this frame: idle, the core glows softly in the car's
 * own colour; boosting, it flares toward white-hot (inside the T2 band) and
 * the flame, in the same colour, stretches out with a little flicker.
 */
function tickRocket(rig: CarRig): void {
  const u = rig.lightUniforms
  if (!u) return
  const raw = liveBoost(rig)
  const b = raw < 0 ? 0 : raw > 1 ? 1 : raw
  if (b < 0.002 && rig.shownBoost === 0) return
  rig.shownBoost = b < 0.002 ? 0 : b
  const t = performance.now() * 0.001
  u.uNozzle.value
    .copy(rig.glow)
    .lerp(HOT_COLOUR, 0.45 * b)
    .multiplyScalar(GLOW.T1 * 0.75 + (GLOW.T2 * 1.5 - GLOW.T1 * 0.75) * b)
  u.uFlame.value.copy(rig.glow).multiplyScalar(GLOW.T2 * (0.6 + 0.6 * b) * (b > 0 ? 1 : 0))
  u.uFlameHot.value.copy(rig.glow).lerp(HOT_COLOUR, 0.7).multiplyScalar(GLOW.T2 * 1.4 * b)
  const flicker = 0.9 + 0.1 * Math.sin(t * 47) * Math.sin(t * 29 + 1)
  u.uFlameOut.value = Math.pow(b, 0.7) * flicker
}

registerDev(
  'nozzle',
  ((b?: number) => {
    nozzleOverride = typeof b === 'number' && Number.isFinite(b) && b >= 0 ? Math.min(1, b) : -1
    return nozzleOverride < 0 ? 'rockets follow each car again' : `every rocket forced to boost ${nozzleOverride}`
  }) as never,
  'nozzle(b): force every car rocket to boost b (0..1) - visual only; nozzle() hands it back to the cars',
)

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
  let accent: CarRig['accent'] = null
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
    // Dark glossy paint: metal flake under a clear coat, so it mirrors the neon world,
    // with the sunset's warmth on the side facing the sun.
    const pm = makePaintMaterial(paint)
    paintMat = pm.mat
    accent = pm.accent
    glassMat = new THREE.MeshPhysicalMaterial({ color: PALETTE.road, metalness: 0.9, roughness: 0.06, clearcoat: 1, envMapIntensity: 1.5 })
    trimMat = makeTrimMaterial()
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
  if (paintMat) paintMesh.onBeforeRender = tickPaintSun
  const glassMesh = new THREE.Mesh(g.glass, glassMat)
  const trimMesh = new THREE.Mesh(g.trim, trimMat)
  const lightMesh = new THREE.Mesh(g.lights, lightMat)
  // the flame grows out of the geometry's bounds in the shader: never cull it early
  lightMesh.frustumCulled = false
  sprung.add(paintMesh, glassMesh, trimMesh, lightMesh)

  const steer: THREE.Group[] = []
  const spin: THREE.Group[] = []
  const wg = wheelGeometry(g.wheel)
  for (let i = 0; i < 4; i++) {
    const s = new THREE.Group()
    s.position.set(WHEEL_X[i], WHEEL_REST_Y, WHEEL_Z[i])
    const sp = new THREE.Group()
    // Mirror the right-hand pair so the rim face and glow ring sit outboard on both sides.
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
    bonnet: g.bonnet.clone(),
  }
  group.userData.collider = {
    halfExtents: { ...CHASSIS.halfExtents },
    offset: { x: 0, y: CHASSIS.offsetY, z: 0 },
  }
  group.userData.anchors = anchors
  group.userData.bodyId = id

  const rig: CarRig = {
    group,
    sprung,
    steer,
    spin,
    materials,
    paint: paintMat,
    accent,
    lightUniforms,
    wheelUniforms,
    glow: new THREE.Color(),
    lastPaint: '',
    lastGlow: '',
    lastBrake: -1,
    boost: 0,
    shownBoost: -1,
  }
  rigs.set(group, rig)
  if (lightUniforms) lightMesh.onBeforeRender = () => tickRocket(rig)
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
    rig.glow.set(glow)
    rig.accent?.value.copy(rig.glow).multiplyScalar(ACCENT_SHADE)
    if (rig.lightUniforms) {
      rig.lightUniforms.uLivery.value.copy(rig.glow).multiplyScalar(GLOW.T2)
      rig.lightUniforms.uHead.value.set(PALETTE.laneLine).multiplyScalar(GLOW.T2)
    }
    if (rig.wheelUniforms) rig.wheelUniforms.uGlow.value.copy(rig.glow).multiplyScalar(GLOW.T2 * 0.8)
    rig.shownBoost = -1 // re-light the rocket in the new colour
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

/** Rocket nozzle: 0 idle .. 1 full boost, for a model with no car in the registry (garage, car lab). */
export function setCarBoost(group: THREE.Group, boost: number): void {
  const rig = rigs.get(group)
  if (rig) rig.boost = Number.isFinite(boost) ? boost : 0
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

/** Draw calls and triangles per body (one car: paint, glass, trim, lights + 4 wheels). */
export function carBodyStats(): Record<string, { draws: number; triangles: number; body: number; wheel: number }> {
  const out: Record<string, { draws: number; triangles: number; body: number; wheel: number }> = {}
  for (const b of BODIES) {
    const g = bodyGeometry(b.id)
    const wheel = wheelGeometry(g.wheel).getAttribute('position').count / 3
    out[b.id] = { draws: 8, triangles: Math.round(g.triangles + 4 * wheel), body: Math.round(g.triangles), wheel: Math.round(wheel) }
  }
  return out
}

registerInspector('carBodies', carBodyStats)
