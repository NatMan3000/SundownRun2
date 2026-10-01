// ============================================================
//  ROAD MATERIAL - the wet neon road
// ------------------------------------------------------------
//  A normal three.js physically based material (so the sun, the
//  sky reflection and the headlights all light it properly) with
//  extra shader code that draws everything ON the road using the
//  ribbon's own per-vertex numbers (see src/track/types.ts):
//
//    aLateral    metres left (-) / right (+) of the centre line
//    aHalfWidth  half the drivable width here
//    aCurv       how hard the road bends here (+ = right-hander)
//    aKind       road / loop / wall ride ... (SURFACE_CODE)
//    uv.y        s, metres along the road
//
//  What it draws:
//    - the wet surface: puddle patches (mirror smooth) and damp
//      patches (a bit rougher), fine grain, gentle ripples
//    - light-strip edges in the track's edge colour (glow tier T2):
//      a white-hot core in a coloured tube, with its glow spilling
//      onto the wet road beside it
//    - dashed lane lines (T1)
//    - corner chevrons on the OUTSIDE of real bends, pointing into
//      the corner and lighting up one after another in the driving
//      direction (peaks T2)
//    - loops: rings of light across the surface (T2)
//    - wall rides: violet ribs (T1) with T2 edge lines
//
//  Every line is anti-aliased with fwidth (see glsl.ts), so it is
//  crisp near the car and still a clean line at the horizon.
// ============================================================

import * as THREE from 'three'
import { GLOW, PALETTE } from '../../core/palette'
import { SURFACE_CODE } from '../../track/types'
import { ROAD_GLSL } from './glsl'

/** Most boost pads / speed traps one track can show (extra ones are skipped with a warning). */
export const MAX_BOOSTS = 32
export const MAX_TRAPS = 4
/** Most loops / wall rides per track whose slab sides get hoops (skirt shader). */
export const MAX_RANGES = 8

export interface RoadLook {
  /** Track accent for the edge strips (file.environment.palette.edge). */
  edge: string
  /** Lanes across the road (lines go between them). */
  lanes: number
  /** Dash period along the road, metres (fitted so the dashes meet at the start line). */
  dashPeriod: number
  /** Road length in metres (s wraps here). */
  length: number
  /** Boost pads: where along (s0..s1) and across (lat0..lat1) the road. */
  boosts: readonly { s0: number; s1: number; lat0: number; lat1: number }[]
  /** Speed trap lines (s). */
  traps: readonly number[]
  /** Loop and wall-ride pieces along the road (s0..s1): their slab sides get hoops / ribs. */
  loops: readonly { s0: number; s1: number }[]
  walls: readonly { s0: number; s1: number }[]
  /** The megacity's compass direction and spread (null = no city), for its glow on the wet road at night. */
  city: { azimuthDeg: number; arcDeg: number } | null
}

/** Uniforms the road shader reads. Shared so RoadView can animate time. */
export function makeRoadUniforms(look: RoadLook) {
  const c = (hex: string) => new THREE.Color(hex)
  return {
    uTime: { value: 0 },
    uEdgeColor: { value: c(look.edge) },
    uLaneColor: { value: c(PALETTE.laneLine) },
    uChevColor: { value: c(PALETTE.chevron) },
    uLoopColor: { value: c(PALETTE.loopRing) },
    uWallColor: { value: c(PALETTE.wallRide) },
    uLanes: { value: look.lanes },
    uDashPeriod: { value: look.dashPeriod },
    // ~5 m, fitted so the lap holds a whole number of 6-chevron comet cycles
    uChevPeriod: { value: lapPeriodFor(look.length, 30) / 6 },
    uGlowT0: { value: GLOW.T0 },
    uGlowT1: { value: GLOW.T1 },
    uGlowT2: { value: GLOW.T2 },
    uLength: { value: look.length },
    /** 0..1 night (environment.night), ticked per frame. */
    uNight: { value: 0 },
    /** The key light's mirror highlight: share kept, night soft cap, and how much of the cap applies (see the shader). */
    uKeySpec: { value: 0.35 },
    uKeyCap: { value: 0.4 },
    uKeyCapOn: { value: 0 },
    uBoostColor: { value: c(PALETTE.boost) },
    uTrapColor: { value: c(PALETTE.speedTrap) },
    uBoost: { value: boostVectors(look) },
    uBoostCount: { value: Math.min(MAX_BOOSTS, look.boosts.length) },
    uTrap: { value: trapValues(look) },
    uTrapCount: { value: Math.min(MAX_TRAPS, look.traps.length) },
    uLoopRange: { value: rangeVectors(look.loops) },
    uLoopCount: { value: Math.min(MAX_RANGES, look.loops.length) },
    uWallRange: { value: rangeVectors(look.walls) },
    uWallCount: { value: Math.min(MAX_RANGES, look.walls.length) },
    // The player's headlights (HeadlightRig writes headlightState; RoadView ticks these).
    uHeadPos: { value: new THREE.Vector3() },
    uHeadDir: { value: new THREE.Vector3(0, 0, 1) },
    uHeadOn: { value: 0 },
    uHeadColor: { value: c(PALETTE.laneLine) },
    // The city's lit skyline, mirrored in the wet road at night.
    uCityDir: { value: cityDir(look) },
    uCityCos: { value: cityCos(look) },
    uCityOn: { value: 0 },
    uCityWarm: { value: c(PALETTE.cityWindowWarm) },
    uCityCool: { value: c(PALETTE.cityWindowCool) },
    /** The sky's horizon colour right now (environment.horizon), for the slab and barrier sheen. */
    uHorizon: { value: new THREE.Color(PALETTE.skyHorizonDusk) },
  }
}

function rangeVectors(list: readonly { s0: number; s1: number }[]): THREE.Vector2[] {
  const out: THREE.Vector2[] = []
  for (let i = 0; i < MAX_RANGES; i++) out.push(list[i] ? new THREE.Vector2(list[i].s0, list[i].s1) : new THREE.Vector2(-1e6, -1e6))
  return out
}

/** Unit xz vector toward the city (0 deg = north = -z, 90 = east = +x). */
function cityDir(look: RoadLook): THREE.Vector2 {
  const a = THREE.MathUtils.degToRad(look.city?.azimuthDeg ?? 0)
  return new THREE.Vector2(Math.sin(a), -Math.cos(a))
}

/** cos of the city's half arc (outer edge) and of 70% of it (fully lit). */
function cityCos(look: RoadLook): THREE.Vector2 {
  const half = THREE.MathUtils.degToRad((look.city?.arcDeg ?? 0) / 2)
  return look.city ? new THREE.Vector2(Math.cos(half), Math.cos(half * 0.7)) : new THREE.Vector2(2, 3)
}

function boostVectors(look: RoadLook): THREE.Vector4[] {
  if (look.boosts.length > MAX_BOOSTS) console.warn(`[look] ${look.boosts.length} boost pads; the road draws the first ${MAX_BOOSTS}`)
  const out: THREE.Vector4[] = []
  for (let i = 0; i < MAX_BOOSTS; i++) {
    const b = look.boosts[i]
    out.push(b ? new THREE.Vector4(b.s0, b.s1, Math.min(b.lat0, b.lat1), Math.max(b.lat0, b.lat1)) : new THREE.Vector4())
  }
  return out
}

function trapValues(look: RoadLook): number[] {
  const out: number[] = []
  for (let i = 0; i < MAX_TRAPS; i++) out.push(look.traps[i] ?? -1e6)
  return out
}

export type RoadUniforms = ReturnType<typeof makeRoadUniforms>

const KIND = SURFACE_CODE

const vertexPars = /* glsl */ `
attribute float aLateral;
attribute float aHalfWidth;
attribute float aCurv;
attribute float aKind;
varying float vLat;
varying float vHalf;
varying float vCurv;
varying float vKind;
varying float vS;
varying vec3 vRoadWorld;
`

const vertexWorld = /* glsl */ `
#include <project_vertex>
vRoadWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
`

const vertexMain = /* glsl */ `
vLat = aLateral;
vHalf = aHalfWidth;
vCurv = aCurv;
vKind = aKind;
vS = uv.y;
`

const fragmentPars = /* glsl */ `
varying float vLat;
varying float vHalf;
varying float vCurv;
varying float vKind;
varying float vS;
uniform float uTime;
uniform vec3 uEdgeColor;
uniform vec3 uLaneColor;
uniform vec3 uChevColor;
uniform vec3 uLoopColor;
uniform vec3 uWallColor;
uniform float uLanes;
uniform float uDashPeriod;
uniform float uChevPeriod;
uniform float uGlowT0;
uniform float uGlowT1;
uniform float uGlowT2;
uniform float uLength;
uniform float uNight;
uniform float uKeySpec;
uniform float uKeyCap;
uniform float uKeyCapOn;
uniform vec3 uBoostColor;
uniform vec3 uTrapColor;
uniform vec4 uBoost[${MAX_BOOSTS}];
uniform int uBoostCount;
uniform float uTrap[${MAX_TRAPS}];
uniform int uTrapCount;
uniform vec3 uHeadPos;
uniform vec3 uHeadDir;
uniform float uHeadOn;
uniform vec3 uHeadColor;
uniform vec2 uCityDir;
uniform vec2 uCityCos;
uniform float uCityOn;
uniform vec3 uCityWarm;
uniform vec3 uCityCool;
varying vec3 vRoadWorld;
${ROAD_GLSL}
// Signed distance along the road from b to a, wrapped into (-L/2, L/2].
float sr2SDelta(float a, float b) {
  float d = a - b;
  return d - uLength * floor(d / uLength + 0.5);
}
`

// Runs where three would read a roughness map: work out every road
// field once, here, and keep the results for the emissive step.
const fragmentFields = /* glsl */ `
float kind = floor(vKind + 0.5);
float isRoad = 1.0 - step(0.5, abs(kind - ${KIND.road.toFixed(1)}));
float isLoop = 1.0 - step(0.5, abs(kind - ${KIND.loop.toFixed(1)}));
float isWall = 1.0 - step(0.5, abs(kind - ${KIND.wall.toFixed(1)}));

float lat = vLat;
float hw = max(vHalf, 0.5);
float s = vS;
float wLat = max(fwidth(lat), 1e-4);
float wS = max(fwidth(s), 1e-4);
// Far away (or at a grazing angle) a pixel covers metres: fade fine detail out.
float detailFade = 1.0 - smoothstep(0.05, 0.25, max(wLat, wS));
float dEdge = hw - abs(lat); // metres inside the drivable edge

// ---- wetness: big puddle patches stretched along the road + smaller ones
vec2 rp = vec2(lat, s);
float n1 = sr2Noise(rp * vec2(0.16, 0.045));
float n2 = sr2Noise(rp * vec2(0.55, 0.22) + 17.0);
float wet = smoothstep(0.42, 0.78, n1 * 0.7 + n2 * 0.3);
float grain = sr2Noise(rp * vec2(5.0, 5.0) + 3.0) - 0.5;

float roughnessFactor = mix(0.24, 0.045, wet) + grain * 0.10 * detailFade * (1.0 - wet);
// Shoulder beyond the drivable width (if the ribbon has one): drier, rougher.
roughnessFactor = mix(roughnessFactor, 0.5, smoothstep(0.0, -0.4, dEdge));
diffuseColor.rgb *= mix(1.0, 0.7, wet) * (1.0 + grain * 0.35 * detailFade);

// ---- edge strips: a neon tube 0.3 m inside each edge
const float STRIP_IN = 0.32;
const float STRIP_HW = 0.11;
float xs = dEdge - STRIP_IN;
float tube = sr2Line(xs, STRIP_HW, wLat);
float tubeCore = sr2Line(xs, STRIP_HW * 0.32, wLat);
// The tube's glow on the wet road beside it (a reflection, under the bloom line).
float spill = exp(-max(abs(xs) - STRIP_HW, 0.0) / 0.7) * (1.0 - tube) * step(-0.4, dEdge);

// ---- lane lines between lanes, dashed along the road
float laneU = (lat / hw * 0.5 + 0.5) * uLanes;
float laneK = floor(laneU + 0.5);
float laneDist = abs(laneU - laneK) * (2.0 * hw / uLanes);
float inner = step(0.5, laneK) * step(laneK, uLanes - 0.5);
float lane = sr2Line(laneDist, 0.06, wLat) * inner
  * sr2Dashes(s, uDashPeriod, 0.36, wS) * isRoad;

// ---- corner chevrons on the outside of real bends
float chev = 0.0;
float chevPulse = 0.0;
float bend = smoothstep(1.0 / 160.0, 1.0 / 70.0, abs(vCurv)) * isRoad;
if (bend > 0.001) {
  // Outside of a right-hander (+curvature) is the left edge.
  float outside = vCurv > 0.0 ? -1.0 : 1.0;
  float xo = lat * outside;                  // + toward the outside edge
  const float BAND_IN = 0.7;                 // band starts this far inside the edge
  const float BAND_W = 1.9;
  float y = (hw - xo) - BAND_IN;             // 0 at the band's outer side, BAND_W at its inner side
  float P = uChevPeriod;                     // one chevron about every 5 m (fitted to the lap)
  float cellF = s / P;
  float cell = floor(cellF);
  float ts = (fract(cellF) - 0.5) * P;       // metres from this chevron's centre
  const float ARM = 1.7;
  float k = (0.72 * BAND_W) / ARM;
  float yc = 0.86 * BAND_W - k * abs(ts);    // a ">" pointing into the corner
  float d = abs(y - yc) / sqrt(1.0 + k * k);
  float inBand = step(0.0, y) * step(y, BAND_W) * (1.0 - smoothstep(ARM * 0.9, ARM, abs(ts)));
  chev = sr2Line(d, 0.16, max(fwidth(d), 1e-4)) * inBand * bend;
  // A comet of light runs forward through the chevrons, one every 6.
  float lag = fract((uTime * 9.0 - cell) / 6.0);
  chevPulse = exp(-lag * 5.5);
}

// ---- loops: rings of light every 3 m; wall rides: ribs every 2.5 m
float ringD = abs(fract(s / 3.0 + 0.5) - 0.5) * 3.0;
float ring = sr2Line(ringD, 0.07, wS) * isLoop; // thin: blooms as a line, not a wash
float ribD = abs(fract(s / 2.5 + 0.5) - 0.5) * 2.5;
float rib = sr2Line(ribD, 0.08, wS) * isWall * smoothstep(0.2, 0.6, -dEdge); // on the wall, beyond the road's edge

// ---- boost pads: a lit outline and mint arrows flowing forward
float boostArrow = 0.0;
float boostEdge = 0.0;
float boostFill = 0.0;
for (int i = 0; i < ${MAX_BOOSTS}; i++) {
  if (i >= uBoostCount) break;
  vec4 z = uBoost[i];
  float len = z.y - z.x;
  if (len < 0.0) len += uLength;
  float a = sr2SDelta(s, z.x);              // metres from the pad's start
  if (a < -0.6 || a > len + 0.6) continue;
  float bc = 0.5 * (z.z + z.w);
  float bh = 0.5 * (z.w - z.z);
  float b = lat - bc;
  if (abs(b) > bh + 0.6) continue;
  float dIn = min(min(a, len - a), bh - abs(b)); // metres inside the pad (negative outside)
  float wIn = max(max(wLat, wS), 1e-4);
  boostFill = max(boostFill, smoothstep(-wIn, wIn, dIn));
  boostEdge = max(boostEdge, sr2Line(dIn - 0.14, 0.06, wIn));
  // "^" arrows, tip forward, 2.4 m apart, flowing forward at 7 m/s
  const float AK = 0.85;
  const float AP = 2.4;
  float q = a + abs(b) * AK;
  float ph = fract(q / AP - uTime * 2.9);
  float dq = abs(ph - 0.5) * AP / sqrt(1.0 + AK * AK);
  float arrow = sr2Line(dq, 0.2, max(fwidth(dq), 1e-4)) * smoothstep(0.3, 0.5, dIn);
  // hotter toward the front of the pad: it reads as "go"
  boostArrow = max(boostArrow, arrow * (0.55 + 0.45 * clamp(a / len, 0.0, 1.0)));
}
boostFill *= isRoad;

// ---- speed traps: an amber line across the road with a thin echo line either side
float trap = 0.0;
for (int i = 0; i < ${MAX_TRAPS}; i++) {
  if (i >= uTrapCount) break;
  float d = abs(sr2SDelta(s, uTrap[i]));
  trap = max(trap, sr2Line(d, 0.2, wS) + 0.6 * sr2Line(abs(d - 1.4), 0.06, wS));
}
trap *= step(0.0, dEdge);

// ---- start / finish line: a checkered band across the road at s = 0
float d0 = sr2SDelta(s, 0.0);
float startBand = (1.0 - smoothstep(0.8 - wS, 0.8 + wS, abs(d0))) * step(0.0, dEdge - STRIP_IN - STRIP_HW) * isRoad;
// Two rows of 0.8 m squares: the row is fixed by which side of the line
// you are on, so the band's own soft edges (fading over a pixel past +/-0.8)
// never pick up a third row's opposite colour (that showed as a 1-px seam).
// Square edges are softened over a pixel, so the pattern never stair-steps.
float cu = lat / 0.8;
float par = abs(mod(floor(cu), 2.0) - step(0.0, d0)); // 0 or 1: column parity xor row
float dCol = abs(fract(cu + 0.5) - 0.5) * 0.8;        // metres to the nearest column line
float squareAA = min(smoothstep(0.0, wLat, dCol), smoothstep(0.0, wS, abs(d0)));
float checker = mix(0.5, par, squareAA);
checker = mix(checker, 0.5, smoothstep(0.15, 0.5, max(wLat, wS) / 0.8)); // averages out far away
float start = startBand * checker;

// Painted lines are glossy paint, not puddles.
float paint = max(max(max(tube, lane), max(chev, ring)), max(max(boostArrow, boostEdge), max(trap, start)));
roughnessFactor = mix(roughnessFactor, 0.35, paint);
diffuseColor.rgb *= 1.0 - paint * 0.6;
`

const fragmentNormal = /* glsl */ `
#include <normal_fragment_maps>
// Gentle ripples, mostly in the puddles, gone with distance. The ripple's
// slope across and along the road is worked out exactly (sr2NoiseD), then
// turned into a screen slope with the road coordinates' own derivatives,
// which are smooth: so the reflection smears into streaks, never 2x2 blocks.
// The finer ripple is turned 35 degrees so its cells never line up in rows.
{
  float amp = detailFade * (0.12 + 0.18 * wet);
  if (amp > 1e-4) {
    const vec2 SC1 = vec2(1.3, 0.45);
    const vec2 SC2 = vec2(3.5, 1.4);
    const mat2 TURN = mat2(0.8192, 0.5736, -0.5736, 0.8192);
    vec3 r1 = sr2NoiseD(rp * SC1 + 9.0);
    vec3 r2 = sr2NoiseD((TURN * rp) * SC2);
    // slope of the height in metres: d/dlat, d/ds
    vec2 g = r1.yz * SC1 + 0.35 * ((r2.yz * SC2) * TURN);
    vec2 dHdxy = vec2(g.x * dFdx(rp.x) + g.y * dFdx(rp.y), g.x * dFdy(rp.x) + g.y * dFdy(rp.y));
    normal = sr2Perturb(-vViewPosition, normal, dHdxy * amp, faceDirection);
  }
}
`

const fragmentEmissive = /* glsl */ `
#include <emissivemap_fragment>
{
  vec3 edgeCol = mix(uEdgeColor, uLoopColor, isLoop);
  // the tube: coloured body at T2, a whiter core inside it
  vec3 em = edgeCol * tube * uGlowT2 + mix(edgeCol, vec3(1.0), 0.6) * tubeCore * uGlowT2 * 0.45;
  // its glow on the wet road (T0: under the bloom line, it reads as reflection)
  em += edgeCol * spill * (0.16 + 0.34 * wet) * (1.0 + 0.6 * uNight) * uGlowT0;
  em += uLaneColor * lane * uGlowT1;
  // lit at every moment (a steady T1 glow with a soft halo), and a T2 comet
  // racing through them in the direction of the corner
  em += uChevColor * chev * mix(uGlowT1 * 0.85, uGlowT2, chevPulse);
  em += uLoopColor * ring * uGlowT2;
  em += uWallColor * rib * uGlowT1;
  em += uBoostColor * (boostArrow * uGlowT2 + boostEdge * uGlowT1 + boostFill * 0.16);
  em += uTrapColor * trap * uGlowT2;
  em += uLaneColor * start * uGlowT1;

  vec3 viewW = normalize(vRoadWorld - cameraPosition);
  vec3 nW = inverseTransformDirection(normal, viewMatrix);

  // The player's headlights. The real spot lights light everything, but this
  // road is near-black glass, so their pool is drawn here too, and painted
  // lines flare in the beam the way retroreflective road paint does.
  if (uHeadOn > 0.001) {
    vec3 toP = vRoadWorld - uHeadPos;
    float dist = length(toP);
    // A bell-shaped falloff to the sides (brightest straight ahead, no flat
    // top): a plateau with a ramp at each side reads as a fan with two
    // straight borders; a bell has no corners for the eye to find.
    // (1 - cos) is about half the angle squared: half bright at ~13 degrees.
    float cone = exp(-(1.0 - dot(toP / max(dist, 1e-3), uHeadDir)) / 0.038);
    float beam = cone * uHeadOn / (1.0 + dist * dist * 0.0022) * (1.0 - smoothstep(50.0, 75.0, dist));
    em += uHeadColor * beam * (0.05 + 0.10 * (1.0 - wet));
    em += uHeadColor * (lane + start) * beam * uGlowT1 * 0.9 + uChevColor * chev * beam * uGlowT1 * 0.6;
  }

  // The lit city skyline mirrored in the wet road at night: the horizon band
  // around the city's compass direction, broken into building columns.
  if (uCityOn > 0.001) {
    vec3 rW = reflect(viewW, nW);
    // Ripples on a wet road smear reflections into long vertical streaks, so
    // the band reaches much higher than the skyline itself (fading as it goes).
    float band = smoothstep(-0.01, 0.004, rW.y) * (1.0 - smoothstep(0.0, 0.22, rW.y));
    vec2 rh = normalize(rW.xz + vec2(1e-5, 0.0));
    float arc = smoothstep(uCityCos.x, uCityCos.y, dot(rh, uCityDir));
    if (band * arc > 0.001) {
      float az = atan(rh.y, rh.x);
      float lit = smoothstep(0.35, 0.8, sr2Noise(vec2(az * 60.0, 0.5)));
      vec3 cityCol = mix(uCityWarm, uCityCool, step(0.5, sr2Noise(vec2(az * 23.0, 3.0))));
      float fres = 0.04 + 0.96 * pow(1.0 - clamp(dot(nW, -viewW), 0.0, 1.0), 5.0);
      em += cityCol * band * arc * lit * fres * (0.35 + 0.65 * wet) * uCityOn * 1.1;
    }
  }
  totalEmissiveRadiance += em;
}
`

// HDR safety: a mirror-wet highlight can exceed what a half-float pixel holds
// (65504) and turn into infinity, which bloom then smears over the whole frame.
// Nothing on the road needs to be brighter than this.
const fragmentClamp = /* glsl */ `
outgoingLight = min(outgoingLight, vec3(48.0));
#include <opaque_fragment>
`

// The key light's mirror highlight on the wet road. The sun's analytic
// highlight is a white-hot slab that swamps the picture at sundown (the sky
// reflection already draws the sun's streak), so the road keeps only
// uKeySpec of it. At night the key light is the planet's cool glow, a T0 sky
// object: its highlight is squeezed under uKeyCap (a soft knee, never a
// flat clip), so it can never be the brightest thing on screen. The
// headlights (spot lights) keep their full glare: they are lit before the
// key light, so only the key light's share is touched.
const KEY_START = '#if ( NUM_SUN_LIGHTS > 0 ) && defined( RE_Direct )'
const KEY_END = '#if ( NUM_RECT_AREA_LIGHTS > 0 ) && defined( RE_Direct_RectArea )'
const lightsBegin = THREE.ShaderChunk.lights_fragment_begin
const keyLightsSplit = lightsBegin.includes(KEY_START) && lightsBegin.includes(KEY_END)
const fragmentLightsBegin = keyLightsSplit
  ? lightsBegin.replace(KEY_START, `vec3 sr2SpecBeforeKey = reflectedLight.directSpecular;\n${KEY_START}`).replace(
      KEY_END,
      `{
  vec3 key = (reflectedLight.directSpecular - sr2SpecBeforeKey) * uKeySpec;
  key = mix(key, key / (1.0 + key / uKeyCap), uKeyCapOn);
  reflectedLight.directSpecular = sr2SpecBeforeKey + key;
}
${KEY_END}`,
    )
  : '#include <lights_fragment_begin>'
if (!keyLightsSplit) console.error('[look] three.js light chunk changed: the road scales all direct highlights together (key-light split unavailable)')
const fragmentLightsEnd = keyLightsSplit
  ? '#include <lights_fragment_end>'
  : `#include <lights_fragment_end>
reflectedLight.directSpecular *= uKeySpec;
`

/** Live road tunables (__dev.lookRoad). */
export const ROAD_TUNE = {
  /** Share of the key light's mirror highlight the road keeps. */
  keySpec: 0.35,
  /** At full night the key light's highlight is squeezed under this (HDR; bloom starts at 1). */
  nightKeyCap: 0.4,
  /** Strength of the player's headlight pool drawn on the road (1 = as designed). */
  headPool: 1,
}

/**
 * The wet road material. One instance per track build; dispose it with the mesh.
 */
export function makeRoadMaterial(uniforms: RoadUniforms): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: PALETTE.road,
    roughness: 0.2,
    metalness: 0,
    envMapIntensity: 1,
  })
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${vertexPars}`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>\n${vertexMain}`)
      .replace('#include <project_vertex>', vertexWorld)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${fragmentPars}`)
      .replace('#include <opaque_fragment>', fragmentClamp)
      .replace('#include <roughnessmap_fragment>', fragmentFields)
      .replace('#include <normal_fragment_maps>', fragmentNormal)
      .replace('#include <emissivemap_fragment>', fragmentEmissive)
      .replace('#include <lights_fragment_begin>', fragmentLightsBegin)
      .replace('#include <lights_fragment_end>', fragmentLightsEnd)
  }
  // One program for every road material (the shader text never changes).
  mat.customProgramCacheKey = () => 'sr2-road-v7'
  return mat
}

/** Lanes for a road of this typical width: one lane per ~4.6 m, 2 to 5. */
export function lanesFor(width: number): number {
  return Math.max(2, Math.min(5, Math.round(width / 4.6)))
}

/**
 * A repeat length near `target` metres that divides the lap exactly, so a
 * pattern laid along s (dashes, chevrons, the barrier comets) meets itself
 * at the start line instead of jumping there.
 */
export function lapPeriodFor(length: number, target: number): number {
  if (!(length > 0)) return target
  return length / Math.max(1, Math.round(length / target))
}

/** A dash period near 9 m that divides the road length exactly, so dashes meet at the line. */
export function dashPeriodFor(length: number): number {
  return lapPeriodFor(length, 9)
}
