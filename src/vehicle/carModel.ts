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
//     |- sprung   leans and pitches on springs: paint, glass, trim, lights, plume
//     |- wheel x4 steer group (at the hub) -> spin group -> wheel mesh
//
//  Big wheels: the tyres are drawn bigger than the physics wheel
//  (tuning.ts WHEEL.radius only says where the suspension ray meets
//  the road). poseCarModel raises each hub by the difference, so the
//  tyre still sits exactly on the road, spins slower to match its
//  size, and never rises through its fender's top.
//
//  group.userData (plain data, safe to clone):
//    collider  { halfExtents, offset }  the chassis box (net uses it)
//    anchors   CarAnchors               light / underglow / wheel / bonnet-camera points (look and camera use it)
//    bodyId
//    reverseLight  0..1                 how lit the reverse lights are right now (look's ground glow uses it)
//
//  8 draw calls per car: paint, glass, trim, lights, 4 wheels, plus the
//  rocket plume while it boosts (9). The ghost is 6: a depth-only copy of
//  its merged shell, the shell, 4 plain tyres.
//
//  Colours:
//    paint   the player's paint, plus a contrast ACCENT (wings, fins,
//            endplates) in a deep shade of their glow colour, so every
//            car is two-tone like a team car
//    lights  livery strips and the wheel rings in the glow colour, white
//            headlights, pink-red tail lights, and a pair of cool white
//            reverse lights that come on while the car backs up
//            (setCarReverse; dark clear lenses the rest of the time)
//    rocket  the nozzle core idles softly in the glow colour; when the
//            car boosts (CarState.boost, or setCarBoost for a car with
//            no registry entry) it flares, and a soft plume in the same
//            colour, white-hot at the nozzle, shoots out about a car
//            length behind and eases back as the boost runs out
//    night   the dark paint never goes black: its clear coat mirrors
//            the lit city on the horizon and the road's edges, its
//            outline catches a rim, and the car's own underglow lights
//            its lower body
//
//  Live animation (suspension, steering, wheel spin, body roll, brake
//  lights) goes through poseCarModel(); colours through
//  setCarColors(). Both are allocation-free. The rocket ticks itself
//  just before the car's lights draw.
//
//  Dev: __dev.nozzle(0..1) forces every car's rocket on (nozzle() to
//  let go); __dev.reverseLights(0..1) forces every car's reverse
//  lights (reverseLights() to let go); __game.get('carBodies') lists
//  triangles per body; __game.get('reverseLights') shows each car's
//  reverse and tail light levels.
// ============================================================

import * as THREE from 'three'
import { GLOW, PALETTE } from '../core/palette'
import { cars, environment } from '../core/telemetry'
import type { CarAnchors } from '../core/telemetry'
import { registerDev, registerInspector } from '../core/devHandles'
import { BODIES, bodyEntry } from './bodies/catalog'
import type { BodyId } from './bodies/catalog'
import { bodyGeometry, ghostBodyGeometry, ghostWheelGeometry, wheelGeometry } from './bodies/build'
import { CHASSIS, ROAD_Y_AT_REST, WHEEL } from './tuning'

interface LightUniforms {
  uLivery: { value: THREE.Color }
  uHead: { value: THREE.Color }
  uTail: { value: THREE.Color }
  uNozzle: { value: THREE.Color }
  uReverse: { value: THREE.Color }
}

interface PlumeUniforms {
  /** The plume's colour along its body and white-hot at the nozzle, HDR (colour x glow tier). */
  uPlumeCol: { value: THREE.Color }
  uPlumeHot: { value: THREE.Color }
  /** 0..1: how far out the plume is (each plume's own full-boost length x this). */
  uPlumeOut: { value: number }
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
  /** The glow colour the paint's night term lights the lower body with (linear). */
  paintGlow: { value: THREE.Color } | null
  lightUniforms: LightUniforms | null
  plumeUniforms: PlumeUniforms | null
  plume: THREE.Mesh | null
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
  /** Reverse lights: what the owner asked for (0..1), the eased ramp toward it, what is lit (-1 = not lit yet), and when it last eased (ms, -1 = never). */
  reverseTarget: number
  reverseRamp: number
  reverseShown: number
  reverseAt: number
  /** Per wheel: how much higher the drawn hub sits than the physics hub (drawn radius - physics radius). */
  hubLift: Float64Array
  /** Per wheel: the highest the drawn hub may go (body space, before lean). */
  hubMax: Float64Array
  /** Per wheel: physics radius / drawn radius (a bigger tyre turns slower at the same speed). */
  spinScale: Float64Array
  /** Per wheel: the last physics spin seen, and the drawn spin built from it. */
  spinSeen: Float64Array
  spinShown: Float64Array
}

const rigs = new WeakMap<THREE.Group, CarRig>()

/** Physics wheel centres at rest, chassis-local: FL, FR, RL, RR (the drawn hubs sit higher: see hubLift). */
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
 * livery (0), headlight (1), tail light (2), rocket core (3) or reverse
 * light (4); the colours are HDR uniforms (colour x GLOW tier), so the
 * lights bloom and the brake lights, reverse lights and rocket can change
 * without touching geometry (and without another draw call).
 */
function makeLightMaterial(): { mat: THREE.MeshBasicMaterial; uniforms: LightUniforms } {
  const uniforms: LightUniforms = {
    uLivery: { value: new THREE.Color() },
    uHead: { value: new THREE.Color() },
    uTail: { value: new THREE.Color() },
    uNozzle: { value: new THREE.Color() },
    uReverse: { value: new THREE.Color() },
  }
  const mat = new THREE.MeshBasicMaterial()
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aLight;\nvarying float vLight;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLight = aLight;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uLivery;\nuniform vec3 uHead;\nuniform vec3 uTail;\nuniform vec3 uNozzle;\nuniform vec3 uReverse;\nvarying float vLight;')
      .replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        [
          'vec3 lightCol;',
          'if (vLight < 0.5) lightCol = uLivery;',
          'else if (vLight < 1.5) lightCol = uHead;',
          'else if (vLight < 2.5) lightCol = uTail;',
          'else if (vLight < 3.5) lightCol = uNozzle;',
          'else lightCol = uReverse;',
          'vec4 diffuseColor = vec4( lightCol, opacity );',
        ].join('\n'),
      )
  }
  mat.customProgramCacheKey = () => 'sr2-car-lights-v4'
  return { mat: keepPatchOnClone(mat), uniforms }
}

/**
 * The rocket plumes: soft glowing jets, added on top of whatever is behind
 * them (additive, no depth write), so they have no hard edges and two
 * plumes crossing just get brighter. Each plume is a lathed shell one metre
 * long; the vertex shader stretches it to its full-boost length x uPlumeOut
 * and swells it a little. The fragment shader works out how close the view
 * ray passes to the plume's axis, so the jet is brightest down its middle
 * and fades to nothing at its edges from any angle, even end-on from the
 * chase camera. White-hot at the nozzle, the car's own colour along the
 * jet, faint shock diamonds, gone by the tip.
 */
function makePlumeMaterial(): { mat: THREE.MeshBasicMaterial; uniforms: PlumeUniforms } {
  const uniforms: PlumeUniforms = {
    uPlumeCol: { value: new THREE.Color() },
    uPlumeHot: { value: new THREE.Color() },
    uPlumeOut: { value: 0 },
  }
  const mat = new THREE.MeshBasicMaterial({
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide, // both walls of the jet add up; from inside its tip it still shows
    forceSinglePass: true, // added light doesn't care about order: one draw, not three's back-then-front two
  })
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        [
          '#include <common>',
          'attribute float aT;',
          'attribute float aRad;',
          'attribute float aCx;',
          'attribute float aCy;',
          'attribute float aLen;',
          'uniform float uPlumeOut;',
          'varying float vT;',
          'varying float vRad;',
          'varying float vMetres;',
          'varying vec3 vWorld;',
          'varying vec3 vAxisP;',
          'varying vec3 vAxisD;',
        ].join('\n'),
      )
      .replace(
        '#include <begin_vertex>',
        [
          '#include <begin_vertex>',
          'float plumeLen = aLen * uPlumeOut;',
          'float widen = 0.6 + 0.4 * uPlumeOut;',
          'vec2 axis = vec2(aCx, aCy);',
          'transformed.xy = axis + (transformed.xy - axis) * widen;',
          'float z0 = transformed.z + aT;', // built one metre long: the nozzle end is aT ahead
          'transformed.z = z0 - aT * plumeLen;',
          'vT = aT;',
          'vRad = aRad * widen;',
          'vMetres = aT * plumeLen;',
          'vWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
          'vAxisP = (modelMatrix * vec4(axis, z0, 1.0)).xyz;',
          'vAxisD = normalize((modelMatrix * vec4(0.0, 0.0, -1.0, 0.0)).xyz);',
        ].join('\n'),
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        [
          '#include <common>',
          'uniform vec3 uPlumeCol;',
          'uniform vec3 uPlumeHot;',
          'varying float vT;',
          'varying float vRad;',
          'varying float vMetres;',
          'varying vec3 vWorld;',
          'varying vec3 vAxisP;',
          'varying vec3 vAxisD;',
        ].join('\n'),
      )
      .replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        [
          // how close the view ray through this pixel passes to the jet's axis, as a share of its width here
          'vec3 rd = normalize(vWorld - cameraPosition);',
          'vec3 w = cameraPosition - vAxisP;',
          'vec3 nn = cross(rd, vAxisD);',
          'float nl = length(nn);',
          'float dist = nl > 1e-4 ? abs(dot(w, nn)) / nl : length(cross(w, vAxisD));',
          'float q = clamp(dist / max(vRad, 1e-3), 0.0, 1.0);',
          'float soft = (1.0 - q * q) * (1.0 - q);', // a broad bright core, fading to nothing at the edge
          'float along = 1.0 - smoothstep(0.55, 1.0, vT);',
          'float diamonds = 0.8 + 0.2 * cos(vMetres * 7.0) * (1.0 - vT);',
          'vec3 plume = mix(uPlumeHot, uPlumeCol, smoothstep(0.0, 0.3, vT)) * along * diamonds * soft;',
          'vec4 diffuseColor = vec4( plume, 1.0 );',
        ].join('\n'),
      )
      // haze fades the jet out instead of tinting it (it is added, not blended)
      .replace(
        '#include <fog_fragment>',
        [
          '#ifdef USE_FOG',
          '  #ifdef FOG_EXP2',
          '    float plumeFog = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );',
          '  #else',
          '    float plumeFog = smoothstep( fogNear, fogFar, vFogDepth );',
          '  #endif',
          '  gl_FragColor.rgb *= 1.0 - plumeFog;',
          '#endif',
        ].join('\n'),
      )
  }
  mat.customProgramCacheKey = () => 'sr2-car-plume-v1'
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
  /** Night form (below): what the clear coat mirrors, linear HDR, already scaled by how dark it is. */
  uNightCity: { value: new THREE.Color() },
  uNightEdge: { value: new THREE.Color() },
  uNightSky: { value: new THREE.Color() },
  /** How much the car's own underglow lights its lower body. */
  uUnderglow: { value: 0 },
}
/** The sunset's warmth: the sun's glow leaning to its pink bottom band (palette tokens). */
const SUN_WARM = new THREE.Color(PALETTE.skySunGlow).lerp(new THREE.Color(PALETTE.sunBottom), 0.35)
/** The lit city on the night horizon: the horizon's violet with the warm windows in it. */
const NIGHT_CITY = new THREE.Color(PALETTE.skyHorizonNight).lerp(new THREE.Color(PALETTE.cityWindowWarm), 0.3)
/** The road's edge strips (the default track accent) and the night sky above. */
const NIGHT_EDGE = new THREE.Color(PALETTE.roadEdge)
const NIGHT_SKY = new THREE.Color(PALETTE.skyHorizonNight).lerp(new THREE.Color(PALETTE.planetRing), 0.35)
/**
 * Night form strengths (linear emissive, all under T0 so none of it blooms):
 * the city band, the road edges, the sky and the outline rim at full night,
 * and the underglow's light on the lower body by day and at night.
 */
const NIGHT_FORM = { city: 0.55, edge: 0.14, sky: 0.2, dusk: 0.3, underDay: 0.05, underNight: 0.16 }
let paintSunFrame = -1

function tickPaintSun(renderer: THREE.WebGLRenderer): void {
  const frame = renderer.info.render.frame
  if (frame === paintSunFrame) return
  paintSunFrame = frame
  const sun = 1 - THREE.MathUtils.smoothstep(environment.timeOfDay, 0.22, 0.5)
  paintSun.uSunWarm.value.copy(SUN_WARM).multiplyScalar(sun)
  const d = environment.keyLightDirection
  if (Number.isFinite(d.x + d.y + d.z) && d.lengthSq() > 1e-6) paintSun.uSunDir.value.copy(d).normalize()
  // the night form: some at sundown (a dark car seen from behind), all of it at night
  const night = THREE.MathUtils.clamp(Number.isFinite(environment.night) ? environment.night : 0, 0, 1)
  const form = NIGHT_FORM.dusk + (1 - NIGHT_FORM.dusk) * night
  paintSun.uNightCity.value.copy(NIGHT_CITY).lerp(environment.horizon, 1 - night).multiplyScalar(NIGHT_FORM.city * form)
  paintSun.uNightEdge.value.copy(NIGHT_EDGE).multiplyScalar(NIGHT_FORM.edge * form)
  paintSun.uNightSky.value.copy(NIGHT_SKY).lerp(environment.zenith, 1 - night).multiplyScalar(NIGHT_FORM.sky * form)
  paintSun.uUnderglow.value = NIGHT_FORM.underDay + (NIGHT_FORM.underNight - NIGHT_FORM.underDay) * night
}

const paintSunPars = /* glsl */ `
uniform vec3 uSunWarm;
uniform vec3 uSunDir;
uniform vec3 uNightCity;
uniform vec3 uNightEdge;
uniform vec3 uNightSky;
uniform float uUnderglow;
uniform vec3 uGlowCol;
varying float vCarY;
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
  float wash = wrap * wrap * (0.015 + 0.09 * dark);
  // the wash takes on three quarters of the paint's own hue: a navy car warms on
  // its sun side without turning maroon, a plum car stays plum, so every garage
  // paint still reads as itself; sheen and rim are the light's colour
  vec3 hue = diffuseColor.rgb / max(max(diffuseColor.r, max(diffuseColor.g, diffuseColor.b)), 1e-4);
  vec3 washTint = mix(vec3(1.0), hue, 0.75);
  float sheen = pow(clamp(dot(reflect(-eyeV, normal), sunV), 0.0, 1.0), 6.0) * (0.06 + 0.3 * pow(1.0 - ndv, 3.0));
  float rim = pow(1.0 - ndv, 3.0) * smoothstep(0.0, 0.6, ndl) * 0.28;
  totalEmissiveRadiance += uSunWarm * (washTint * wash + sheen + rim);
}
// NIGHT FORM. The reflection map is only the sky, which is nearly black at
// night, so a dark glossy car mirrored nothing and read as a cut-out. Three
// cheap stand-ins for the neon world it should catch:
//   the clear coat mirrors the lit city as a band where its reflection
//   skims the horizon, the road's magenta edges below it, the sky above
//   (strongest at grazing angles, like real lacquer);
//   the outline catches a soft rim;
//   the car's own underglow lights its lower body, fading up the flanks.
{
  vec3 eyeN = normalize(vViewPosition);
  float ndvN = clamp(dot(normal, eyeN), 0.0, 1.0);
  vec3 nW = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
  vec3 rW = normalize((vec4(reflect(-eyeN, normal), 0.0) * viewMatrix).xyz);
  float fres = 0.04 + 0.96 * pow(1.0 - ndvN, 5.0);
  float band = exp(-rW.y * rW.y / 0.018);
  float below = smoothstep(-0.03, -0.4, rW.y);
  float above = smoothstep(0.08, 0.8, rW.y);
  // below the horizon: the road behind, its magenta edges and the car's own light trails
  vec3 road = uNightEdge + uGlowCol * (0.4 * length(uNightEdge));
  vec3 mirror = (uNightCity * band + road * below + uNightSky * above) * (0.45 + 0.55 * fres);
  float rimN = pow(1.0 - ndvN, 3.0);
  vec3 rimCol = mix(uNightSky * 2.0, uGlowCol * 0.12, 0.35) * rimN;
  float lumaN = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  float darkN = 1.0 - smoothstep(0.04, 0.45, lumaN);
  vec3 albedoN = mix(diffuseColor.rgb, vec3(0.5), darkN);
  float low = 1.0 - smoothstep(-0.34, 0.5, vCarY);
  float facing = 0.4 + 0.6 * clamp(0.5 - 0.5 * nW.y, 0.0, 1.0);
  vec3 bounce = uGlowCol * albedoN * (low * low * facing * uUnderglow);
  totalEmissiveRadiance += mirror + rimCol + bounce;
}
`

/**
 * The car paint: dark metal flake under a clear coat, plus the warm sun side
 * (above). `aAccent` per vertex swaps the paint for the accent colour, so the
 * whole painted body stays one draw call.
 */
function makePaintMaterial(paint: string): { mat: THREE.MeshPhysicalMaterial; accent: { value: THREE.Color }; glow: { value: THREE.Color } } {
  const accent = { value: new THREE.Color() }
  const glow = { value: new THREE.Color() }
  const mat = new THREE.MeshPhysicalMaterial({
    color: paint,
    metalness: 0.5,
    roughness: 0.18,
    clearcoat: 1,
    clearcoatRoughness: 0.03,
    envMapIntensity: 1.4,
  })
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, paintSun)
    shader.uniforms.uAccent = accent
    shader.uniforms.uGlowCol = glow
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aAccent;\nvarying float vAccent;\nvarying float vCarY;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvAccent = aAccent;\nvCarY = position.y;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${paintSunPars}\nuniform vec3 uAccent;\nvarying float vAccent;`)
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4( mix( diffuse, uAccent, vAccent ), opacity );')
      .replace('#include <emissivemap_fragment>', paintSunFragment)
  }
  mat.customProgramCacheKey = () => 'sr2-car-paint-sun-v7'
  return { mat: keepPatchOnClone(mat), accent, glow }
}

/**
 * The canopy glass: dark tinted glass that mirrors the world. Like the paint
 * (see NIGHT FORM above), it would mirror only the near-black night sky, so
 * it gets the same stand-in: the lit city on the horizon, the road below,
 * the sky above, strongest at grazing angles.
 */
const glassNightFragment = /* glsl */ `
#include <emissivemap_fragment>
{
  vec3 eyeN = normalize(vViewPosition);
  float ndvN = clamp(dot(normal, eyeN), 0.0, 1.0);
  vec3 rW = normalize((vec4(reflect(-eyeN, normal), 0.0) * viewMatrix).xyz);
  float fres = 0.04 + 0.96 * pow(1.0 - ndvN, 5.0);
  float band = exp(-rW.y * rW.y / 0.018);
  float below = smoothstep(-0.03, -0.4, rW.y);
  float above = smoothstep(0.08, 0.8, rW.y);
  vec3 mirror = (uNightCity * band + uNightEdge * below + uNightSky * above) * (0.35 + 0.65 * fres);
  // tinted glass seen from above still shows the sky's violet across its top, not just at its rim
  totalEmissiveRadiance += mirror * 0.8 + uNightSky * (1.5 * pow(1.0 - ndvN, 3.0) + 1.2 * above);
}
`

function makeGlassMaterial(): THREE.MeshPhysicalMaterial {
  const mat = new THREE.MeshPhysicalMaterial({ color: PALETTE.road, metalness: 0.9, roughness: 0.06, clearcoat: 1, envMapIntensity: 1.5 })
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNightCity = paintSun.uNightCity
    shader.uniforms.uNightEdge = paintSun.uNightEdge
    shader.uniforms.uNightSky = paintSun.uNightSky
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uNightCity;\nuniform vec3 uNightEdge;\nuniform vec3 uNightSky;')
      .replace('#include <emissivemap_fragment>', glassNightFragment)
  }
  mat.customProgramCacheKey = () => 'sr2-car-glass-v2'
  return keepPatchOnClone(mat)
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

/** Below this boost the plume is not drawn at all (no draw call while cruising). */
const PLUME_MIN = 0.01

/**
 * Light the rocket for this frame: idle, the core glows softly in the car's
 * own colour; boosting, it flares toward white-hot (inside the T2 band) and
 * the plume, in the same colour, shoots out behind with a little flicker.
 * The plume is T3-bright only at the kick (the boost envelope's first half
 * second) and eases back to T2 and shorter as the boost runs out.
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
  const pu = rig.plumeUniforms
  if (!pu || !rig.plume) return
  const on = b >= PLUME_MIN
  rig.plume.visible = on
  if (!on) return
  const kick = THREE.MathUtils.smoothstep(b, 0.75, 1)
  // both walls of the double-sided jet add up, so each carries half
  const tier = 0.5 * (GLOW.T2 * (0.7 + 0.3 * b) + (GLOW.T3 - GLOW.T2) * kick)
  pu.uPlumeCol.value.copy(rig.glow).multiplyScalar(tier)
  pu.uPlumeHot.value.copy(rig.glow).lerp(HOT_COLOUR, 0.75).multiplyScalar(tier * 1.25)
  const flicker = 0.93 + 0.07 * Math.sin(t * 47) * Math.sin(t * 29 + 1)
  pu.uPlumeOut.value = Math.pow(b, 0.45) * flicker
}

registerDev(
  'nozzle',
  ((b?: number) => {
    nozzleOverride = typeof b === 'number' && Number.isFinite(b) && b >= 0 ? Math.min(1, b) : -1
    return nozzleOverride < 0 ? 'rockets follow each car again' : `every rocket forced to boost ${nozzleOverride}`
  }) as never,
  'nozzle(b): force every car rocket to boost b (0..1) - visual only; nozzle() hands it back to the cars',
)

// ---------------------------------------------------------------- reverse lights

/** How long the reverse lights take to come on or go off, seconds (quick, but never a hard snap). */
const REVERSE_EASE_S = 0.1
/**
 * Reverse light brightness (x the cool white below). Off, they are dark
 * clear lenses (well under T0, so they never glow). On, a cool white at the
 * top of the T1 band: a little bloom, clearly dimmer than the headlights (T2).
 */
const REVERSE_GLOW = { off: 0.06, on: GLOW.T1 * 1.2 }
/** Starlight white: a cool white from the palette, not the headlights' cyan-white. */
const REVERSE_COLOUR = new THREE.Color(PALETTE.stars)

/** __dev.reverseLights(v): force every car's reverse lights to v (-1 = off, follow the cars). */
let reverseOverride = -1

/**
 * Ease the reverse lights toward what the car asked for (setCarReverse) and
 * light them. Runs when the owner sets them and again just before the car's
 * lights draw (so a model nobody drives, the garage's, still follows
 * __dev.reverseLights). Works from the clock, so running twice a frame is free.
 */
function tickReverse(rig: CarRig): void {
  const u = rig.lightUniforms
  if (!u) return
  const now = performance.now()
  const dt = rig.reverseAt < 0 ? REVERSE_EASE_S : Math.max(0, (now - rig.reverseAt) / 1000)
  rig.reverseAt = now
  const target = reverseOverride >= 0 ? reverseOverride : rig.reverseTarget
  const step = dt / REVERSE_EASE_S
  const r = rig.reverseRamp
  rig.reverseRamp = target > r ? Math.min(target, r + step) : Math.max(target, r - step)
  const shown = THREE.MathUtils.smoothstep(rig.reverseRamp, 0, 1)
  if (shown === rig.reverseShown) return
  rig.reverseShown = shown
  // fx (the soft glow on the ground behind a reversing car) reads this
  rig.group.userData.reverseLight = shown
  u.uReverse.value.copy(REVERSE_COLOUR).multiplyScalar(REVERSE_GLOW.off + (REVERSE_GLOW.on - REVERSE_GLOW.off) * shown)
}

registerDev(
  'reverseLights',
  ((v?: number) => {
    reverseOverride = typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(1, v) : -1
    return reverseOverride < 0 ? 'reverse lights follow each car again' : `every car's reverse lights forced to ${reverseOverride}`
  }) as never,
  'reverseLights(v): force every car\'s reverse lights to v (0..1) - visual only, garage included; reverseLights() hands them back to the cars',
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
  let paintGlow: CarRig['paintGlow'] = null
  let lightUniforms: CarRig['lightUniforms'] = null
  let plumeUniforms: CarRig['plumeUniforms'] = null
  let plumeMat: THREE.Material | null = null
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
    paintGlow = pm.glow
    glassMat = makeGlassMaterial()
    trimMat = makeTrimMaterial()
    const lm = makeLightMaterial()
    lightMat = lm.mat
    lightUniforms = lm.uniforms
    const wm = makeWheelMaterial()
    wheelMat = wm.mat
    wheelUniforms = wm.uniforms
    const plm = makePlumeMaterial()
    plumeMat = plm.mat
    plumeUniforms = plm.uniforms
    materials.push(paintMat, glassMat, trimMat, lightMat, wheelMat, plumeMat)
  }

  // The ghost is one see-through shell: the whole body merged into one mesh,
  // drawn after a depth-only copy of itself, so only its outer surface shows
  // (no tub, fender and wheel-well faces layered inside it). 2 draws, not 4.
  let lightMesh: THREE.Mesh | null = null
  let plumeMesh: THREE.Mesh | null = null
  if (opts.ghost) {
    const shell = ghostBodyGeometry(id)
    const depthOnly = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, transparent: true })
    materials.push(depthOnly)
    const depthMesh = new THREE.Mesh(shell, depthOnly)
    depthMesh.name = 'ghost-depth'
    const shellMesh = new THREE.Mesh(shell, glassMat)
    shellMesh.name = 'ghost-shell'
    sprung.add(depthMesh, shellMesh)
  } else {
    const paintMesh = new THREE.Mesh(g.paint, paintMat ?? glassMat)
    paintMesh.castShadow = !!opts.shadows
    paintMesh.receiveShadow = true
    if (paintMat) paintMesh.onBeforeRender = tickPaintSun
    const glassMesh = new THREE.Mesh(g.glass, glassMat)
    const trimMesh = new THREE.Mesh(g.trim, trimMat)
    lightMesh = new THREE.Mesh(g.lights, lightMat)
    sprung.add(paintMesh, glassMesh, trimMesh, lightMesh)
    if (plumeMat && g.plume.getAttribute('position').count > 0) {
      // drawn only while boosting; it grows out of the geometry's bounds in the shader, so never cull it early
      plumeMesh = new THREE.Mesh(g.plume, plumeMat)
      plumeMesh.name = 'plume'
      plumeMesh.frustumCulled = false
      plumeMesh.visible = false
      plumeMesh.renderOrder = 2
      sprung.add(plumeMesh)
    }
  }

  const steer: THREE.Group[] = []
  const spin: THREE.Group[] = []
  const hubLift = new Float64Array(4)
  const hubMax = new Float64Array(4)
  const spinScale = new Float64Array(4)
  for (let i = 0; i < 4; i++) {
    const axle = i < 2 ? 0 : 1
    const tyre = g.tyres[axle]
    hubLift[i] = tyre.r - WHEEL.radius
    hubMax[i] = g.hubMax[axle]
    spinScale[i] = WHEEL.radius / tyre.r
    const s = new THREE.Group()
    s.position.set(WHEEL_X[i], ROAD_Y_AT_REST + tyre.r, WHEEL_Z[i])
    const sp = new THREE.Group()
    // Mirror the right-hand pair so the rim face and glow ring sit outboard on both sides.
    if (i % 2 === 1) sp.scale.set(-1, 1, 1)
    const wm = new THREE.Mesh(opts.ghost ? ghostWheelGeometry(tyre) : wheelGeometry(g.wheel, tyre), wheelMat)
    wm.castShadow = !!opts.shadows
    sp.add(wm)
    s.add(sp)
    group.add(s)
    steer.push(s)
    spin.push(sp)
  }
  // transparent pass, after everything else: the depth copy first (9), then the shell and wheels (10)
  if (opts.ghost) group.traverse((o) => ((o as THREE.Mesh).renderOrder = o.name === 'ghost-depth' ? 9 : 10))

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
    paintGlow,
    lightUniforms,
    plumeUniforms,
    plume: plumeMesh,
    wheelUniforms,
    glow: new THREE.Color(),
    lastPaint: '',
    lastGlow: '',
    lastBrake: -1,
    boost: 0,
    shownBoost: -1,
    reverseTarget: 0,
    reverseRamp: 0,
    reverseShown: -1,
    reverseAt: -1,
    hubLift,
    hubMax,
    spinScale,
    spinSeen: new Float64Array(4).fill(NaN),
    spinShown: new Float64Array(4),
  }
  rigs.set(group, rig)
  if (lightUniforms && lightMesh) {
    lightMesh.onBeforeRender = () => {
      tickRocket(rig)
      tickReverse(rig)
    }
  }
  group.userData.reverseLight = 0
  setCarColors(group, paint, glow)
  setCarBrake(group, 0)
  tickReverse(rig)
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
    rig.paintGlow?.value.copy(rig.glow)
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

/**
 * Reverse lights: 1 while the car is backing up, 0 otherwise (call it every
 * frame, like setCarBrake). They ease on and off over REVERSE_EASE_S, so a
 * quick change never snaps. No allocation.
 */
export function setCarReverse(group: THREE.Group, amount: number): void {
  const rig = rigs.get(group)
  if (!rig || !rig.lightUniforms) return
  rig.reverseTarget = Number.isFinite(amount) ? THREE.MathUtils.clamp(amount, 0, 1) : 0
  tickReverse(rig)
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

/** Over the last few cm below its fender's top, a rising tyre slows to a stop instead of hitting it. */
const HUB_SOFT = 0.05
const TAU = Math.PI * 2

/**
 * Apply suspension travel, steering, wheel spin and body lean. No allocation.
 *
 * The physics hub is where a 0.34 m wheel would be; the drawn tyre is bigger,
 * so its hub sits higher by the difference (its bottom stays on the road).
 * On a big landing it could rise through the fender's top: past HUB_SOFT
 * below that limit (which leans with the body) it eases to a stop, so the
 * tyre squashes into the road for a moment instead. It spins at
 * physics radius / drawn radius of the physics spin, so it rolls true.
 */
export function poseCarModel(group: THREE.Group, p: ModelPose): void {
  const rig = rigs.get(group)
  if (!rig) return
  const roll = Number.isFinite(p.roll) ? p.roll : 0
  const pitch = Number.isFinite(p.pitch) ? p.pitch : 0
  rig.sprung.rotation.z = roll
  rig.sprung.rotation.x = -pitch
  const sr = Math.sin(roll)
  const sp = Math.sin(pitch)
  for (let i = 0; i < 4; i++) {
    const s = rig.steer[i]
    const raw = p.wheelHubY[i]
    let y = (Number.isFinite(raw) ? raw : WHEEL_REST_Y) + rig.hubLift[i]
    // where the fender is this frame: the body leans and pitches over the wheel
    const limit = rig.hubMax[i] + WHEEL_X[i] * sr + WHEEL_Z[i] * sp
    const knee = limit - HUB_SOFT
    if (y > knee) y = knee + HUB_SOFT * (1 - Math.exp(-(y - knee) / HUB_SOFT))
    s.position.y = y
    s.rotation.y = i < 2 ? p.steerAngle : 0
    // spin: follow the physics wheel's turning, scaled to the bigger tyre (and survive its wrap-around)
    const spin = p.wheelSpin[i]
    if (Number.isFinite(spin)) {
      const seen = rig.spinSeen[i]
      let d = Number.isFinite(seen) ? spin - seen : 0
      if (d > 1000 || d < -1000) d = (((d % TAU) + TAU + Math.PI) % TAU) - Math.PI
      rig.spinSeen[i] = spin
      rig.spinShown[i] = (rig.spinShown[i] + d * rig.spinScale[i]) % TAU
      rig.spin[i].rotation.x = rig.spinShown[i]
    }
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

interface BodyStats {
  /** Draw calls cruising, and while the plume is out. */
  draws: number
  drawsBoosting: number
  triangles: number
  body: number
  wheels: number
  /** Drawn tyre radius and width, front and rear, metres. */
  tyres: { front: string; rear: string }
  /** How far each drawn hub can rise above its rest height before it eases to a stop under the fender, metres. */
  hubRise: { front: number; rear: number }
}

/** Draw calls, triangles, tyre sizes and suspension room per body. */
export function carBodyStats(): Record<string, BodyStats> {
  const out: Record<string, BodyStats> = {}
  const tri = (geo: THREE.BufferGeometry) => geo.getAttribute('position').count / 3
  for (const b of BODIES) {
    const g = bodyGeometry(b.id)
    const [tf, tr] = g.tyres
    const wheels = 2 * tri(wheelGeometry(g.wheel, tf)) + 2 * tri(wheelGeometry(g.wheel, tr))
    const plume = g.plume.getAttribute('position').count > 0
    out[b.id] = {
      draws: 8,
      drawsBoosting: plume ? 9 : 8,
      triangles: Math.round(g.triangles + wheels),
      body: Math.round(g.triangles),
      wheels: Math.round(wheels),
      tyres: { front: `r ${tf.r} w ${tf.w}`, rear: `r ${tr.r} w ${tr.w}` },
      hubRise: {
        front: Math.round((g.hubMax[0] - (ROAD_Y_AT_REST + tf.r)) * 1000) / 1000,
        rear: Math.round((g.hubMax[1] - (ROAD_Y_AT_REST + tr.r)) * 1000) / 1000,
      },
    }
  }
  return out
}

registerInspector('carBodies', carBodyStats)

/** A car's rig: its own model, or (multiplayer) the model hanging from the group it registered. */
function rigOf(obj: THREE.Object3D | null | undefined): CarRig | undefined {
  if (!obj) return undefined
  const own = rigs.get(obj as THREE.Group)
  if (own) return own
  for (const child of obj.children) {
    const r = rigs.get(child as THREE.Group)
    if (r) return r
  }
  return undefined
}

/**
 * __game.get('reverseLights'): per car, the reverse lights asked for and lit
 * (0..1), the reverse uniform's brightest channel, and the tail lights'
 * (so a check can see braking is unchanged while the reverse lights work).
 */
registerInspector('reverseLights', () =>
  cars.map((c) => {
    const rig = rigOf(c.object)
    const u = rig?.lightUniforms
    const peak = (col: THREE.Color | undefined) => (col ? Math.round(Math.max(col.r, col.g, col.b) * 1000) / 1000 : null)
    return {
      id: c.id,
      kind: c.kind,
      asked: rig ? rig.reverseTarget : null,
      lit: rig ? Math.round(Math.max(0, rig.reverseShown) * 1000) / 1000 : null,
      reverseUniform: peak(u?.uReverse.value),
      tailUniform: peak(u?.uTail.value),
    }
  }),
)
