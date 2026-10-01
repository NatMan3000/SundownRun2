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

export interface RoadLook {
  /** Track accent for the edge strips (file.environment.palette.edge). */
  edge: string
  /** Lanes across the road (lines go between them). */
  lanes: number
  /** Dash period along the road, metres (fitted so the dashes meet at the start line). */
  dashPeriod: number
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
    uGlowT0: { value: GLOW.T0 },
    uGlowT1: { value: GLOW.T1 },
    uGlowT2: { value: GLOW.T2 },
    /** Headlight / night factor: the lines get a touch brighter at night. */
    uNight: { value: 0 },
  }
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
uniform float uGlowT0;
uniform float uGlowT1;
uniform float uGlowT2;
uniform float uNight;
${ROAD_GLSL}
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
float spill = exp(-max(abs(xs) - STRIP_HW, 0.0) / 0.6) * (1.0 - tube) * step(-0.4, dEdge);

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
  const float P = 5.0;                       // one chevron every 5 m
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
float ring = sr2Line(ringD, 0.14, wS) * isLoop;
float ribD = abs(fract(s / 2.5 + 0.5) - 0.5) * 2.5;
float rib = sr2Line(ribD, 0.07, wS) * isWall * step(0.4, dEdge);

// Painted lines are glossy paint, not puddles.
float paint = max(max(tube, lane), max(chev, ring));
roughnessFactor = mix(roughnessFactor, 0.35, paint);
diffuseColor.rgb *= 1.0 - paint * 0.6;
`

const fragmentNormal = /* glsl */ `
#include <normal_fragment_maps>
// Gentle ripples, mostly in the puddles, gone with distance.
{
  float h = sr2Noise(rp * vec2(1.3, 0.45) + 9.0) + 0.35 * sr2Noise(rp * vec2(3.5, 1.4));
  float amp = detailFade * (0.12 + 0.18 * wet);
  if (amp > 1e-4) normal = sr2Perturb(-vViewPosition, normal, vec2(dFdx(h), dFdy(h)) * amp, faceDirection);
}
`

const fragmentEmissive = /* glsl */ `
#include <emissivemap_fragment>
{
  vec3 edgeCol = mix(uEdgeColor, uLoopColor, isLoop);
  // the tube: coloured body at T2, a whiter core inside it
  vec3 em = edgeCol * tube * uGlowT2 + mix(edgeCol, vec3(1.0), 0.6) * tubeCore * uGlowT2 * 0.45;
  // its glow on the wet road (T0: under the bloom line, it reads as reflection)
  em += edgeCol * spill * (0.16 + 0.34 * wet) * uGlowT0;
  em += uLaneColor * lane * uGlowT1;
  em += uChevColor * chev * mix(uGlowT0 * 0.55, uGlowT2, chevPulse);
  em += uLoopColor * ring * uGlowT2;
  em += uWallColor * rib * uGlowT1;
  totalEmissiveRadiance += em;
}
`

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
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${fragmentPars}`)
      .replace('#include <roughnessmap_fragment>', fragmentFields)
      .replace('#include <normal_fragment_maps>', fragmentNormal)
      .replace('#include <emissivemap_fragment>', fragmentEmissive)
  }
  // One program for every road material (the shader text never changes).
  mat.customProgramCacheKey = () => 'sr2-road-v1'
  return mat
}

/** Lanes for a road of this typical width: one lane per ~4.6 m, 2 to 5. */
export function lanesFor(width: number): number {
  return Math.max(2, Math.min(5, Math.round(width / 4.6)))
}

/** A dash period near 9 m that divides the road length exactly, so dashes meet at the line. */
export function dashPeriodFor(length: number): number {
  if (!(length > 0)) return 9
  return length / Math.max(1, Math.round(length / 9))
}
