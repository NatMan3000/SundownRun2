// ============================================================
//  STUNT PARK MATERIALS - how the ramps, pads and rings look
// ------------------------------------------------------------
//  The park is dark, wet-looking structure (the road's own colour,
//  lit by the sun and the headlights like any surface) with its
//  shape drawn in light, the same way the road draws its lines:
//  in the shader, from numbers stored on each vertex
//  (parkGeometry.ts aPark / aPark2), so they stay crisp at any
//  distance and cost nothing extra.
//
//  What the colours mean (CONSTITUTION section 1):
//    magenta (the track's accent)  every edge: you can read each
//                                  ramp's shape at night
//    amber (caution)               lips and pipe copings: where you
//                                  leave the ground
//    cyan (guidance)               "land here": the top of a landing,
//                                  arrows down it, the bullseye pads
//    violet (pickups)              the stunt rings you fly through
//    grid violet (the ground's grid) dim panel lines on the walls, which
//                  also catch the sky's colour like the road's barriers,
//                  so a tall face is never a black slab
//  A launch's face also carries its speed sign: the km/h to leave its lip
//  at (parkLayout.ts signKmh), in amber 7-segment digits, T1.
//  Glow tiers: edges and guidance T1, lips and the bullseye's middle
//  T2 (like the road's chevron peaks), a ring flashes T3 for under
//  half a second as it re-forms after its countdown (ringFx.ts draws
//  the explosion), its ghost is T0 to T1, wall panels T0. The road
//  stays brighter.
// ============================================================

import * as THREE from 'three'
import { GLOW, PALETTE } from '../../core/palette'
import { NAN_TAG, ROAD_GLSL } from '../../look/road/glsl'
import { fragmentClamp } from '../../look/road/roadMaterial'

const vertexPars = /* glsl */ `
attribute vec4 aPark;
attribute vec2 aPark2;
attribute vec4 aPark3;
varying vec4 vPark;
varying vec2 vPark2;
varying vec4 vPark3;
`
const vertexMain = /* glsl */ `
vPark = aPark;
vPark2 = aPark2;
vPark3 = aPark3;
{
  // A bullseye is paint on the ground (parkGeometry.ts buildPadDecal), so it must stay just above
  // the ground's drawn surface without ever flickering into it. Separated geometrically (never
  // with polygonOffset: CLAUDE.md): lifted a little, more with distance, because the depth buffer
  // gets coarser with the square of the distance and the terrain is drawn coarser far away
  // (its mid and far levels can stand up to about 0.35 m above the paint's ground). At 10 m that
  // is 2 cm, at 230 m 0.2 m, at 720 m about 1 m: always about a pixel or less on screen.
  float sr2Pad = step(3.5, aPark.x);
  float sr2Dist = length((modelMatrix * vec4(transformed, 1.0)).xyz - cameraPosition);
  transformed.y += sr2Pad * (0.015 + 0.0006 * sr2Dist + 1.2e-6 * sr2Dist * sr2Dist);
}
`

const fragmentPars = /* glsl */ `
uniform vec3 uEdge;
uniform vec3 uLip;
uniform vec3 uGuide;
uniform vec3 uGrid;
uniform vec3 uHorizon;
uniform float uGlowT0;
uniform float uGlowT1;
uniform float uGlowT2;
uniform float uTime;
varying vec4 vPark;
varying vec2 vPark2;
varying vec4 vPark3;
${ROAD_GLSL}

// ---- the speed signs' digits, drawn like a 7-segment display (no texture, no font) ----
// Which segments light for a digit: bit 0 top, 1 upper right, 2 lower right, 3 bottom,
// 4 lower left, 5 upper left, 6 middle.
int sr2Seg7(int d) {
  const int SEG[10] = int[10](63, 6, 91, 79, 102, 109, 125, 7, 127, 111);
  return SEG[clamp(d, 0, 9)];
}
float sr2SegDist(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h);
}
float sr2Lit(int mask, int bit) {
  return float((mask >> bit) & 1);
}
// Metres from p to the nearest lit segment of a digit w wide and h tall, centred on 0, strokes t thick.
float sr2Digit7(vec2 p, int mask, float w, float h, float t) {
  float x = w * 0.5 - t * 0.5;
  float y = h * 0.5 - t * 0.5;
  float g = t; // each segment stops short of the corners, so the digit reads as separate bars of light
  float d = 1e4;
  d = min(d, mix(1e4, sr2SegDist(p, vec2(-x + g, y), vec2(x - g, y)), sr2Lit(mask, 0)));
  d = min(d, mix(1e4, sr2SegDist(p, vec2(x, y - g), vec2(x, g)), sr2Lit(mask, 1)));
  d = min(d, mix(1e4, sr2SegDist(p, vec2(x, -g), vec2(x, -y + g)), sr2Lit(mask, 2)));
  d = min(d, mix(1e4, sr2SegDist(p, vec2(-x + g, -y), vec2(x - g, -y)), sr2Lit(mask, 3)));
  d = min(d, mix(1e4, sr2SegDist(p, vec2(-x, -g), vec2(-x, -y + g)), sr2Lit(mask, 4)));
  d = min(d, mix(1e4, sr2SegDist(p, vec2(-x, y - g), vec2(-x, g)), sr2Lit(mask, 5)));
  d = min(d, mix(1e4, sr2SegDist(p, vec2(-x + g, 0.0), vec2(x - g, 0.0)), sr2Lit(mask, 6)));
  return d;
}
`

// Every derivative is taken first, outside any branch (Windows GPUs need that: CLAUDE.md).
const fragmentEmissive = /* glsl */ `
#include <emissivemap_fragment>
{
  float role = vPark.x;
  float edge = vPark.y;
  float arc = vPark.z;
  float lip = vPark.w;
  float zone = vPark2.x;
  float katch = vPark2.y;
  float wE = max(fwidth(edge), 1e-4);
  float wA = max(fwidth(arc), 1e-4);
  float wL = max(fwidth(lip), 1e-4);
  float wC = max(fwidth(katch), 1e-4);
  float isTop = 1.0 - step(0.5, role);
  float isSide = step(0.5, role) * (1.0 - step(1.5, role));
  float isEnd = step(1.5, role) * (1.0 - step(2.5, role));
  float isPad = step(3.5, role);
  float zLaunch = 1.0 - step(0.5, abs(zone - 1.0));
  float zLand = 1.0 - step(0.5, abs(zone - 2.0));
  float zDeck = 1.0 - step(0.5, abs(zone - 3.0));
  float zPipe = 1.0 - step(0.5, abs(zone - 4.0));
  // far away the fine patterns fade (they would shimmer); the outlines stay
  float near = 1.0 - smoothstep(0.25, 1.2, wA);

  // ---- a launch's speed sign: the km/h to leave its lip at, in amber digits up the face ----
  // Text space on the face: x metres to the right, y metres up the face toward the lip (so the
  // number stands the right way up as you drive at it), leaning forward like the HUD's numbers.
  float sKmh = vPark3.y;
  float sH = max(vPark3.z, 0.1);
  int kmh = int(sKmh + 0.5);
  int nDig = kmh >= 100 ? 3 : 2;
  float faceHalf = edge + abs(vPark3.x);
  // never zero (a wall's numbers give no width here): x / 0 is NaN on Windows, even times hasSign = 0
  float dW = max(0.05, min(sH * 0.48, (faceHalf * 1.5) / (1.3 * float(nDig) - 0.3)));
  float pitch = dW * 1.3;
  float total = pitch * float(nDig) - dW * 0.3;
  float ty = (vPark3.w + sH * 0.5) - lip;
  vec2 tp = vec2(vPark3.x + total * 0.5 - ty * 0.16, ty);
  float tw = max(max(fwidth(tp.x), fwidth(tp.y)), 1e-4);
  float cell = floor(tp.x / pitch);
  int ci = int(cell);
  int digit = ci == 0 ? (nDig == 3 ? kmh / 100 : kmh / 10) : (ci == 1 ? (nDig == 3 ? (kmh / 10) % 10 : kmh % 10) : kmh % 10);
  int mask = (ci >= 0 && ci < nDig) ? sr2Seg7(digit) : 0;
  float stroke = dW * 0.17;
  // a 1 stands in the middle of its cell (its bars are the right-hand ones), so "111" reads evenly
  float centreOne = (digit == 1 ? 1.0 : 0.0) * (dW * 0.5 - stroke * 0.5);
  float dSeg = sr2Digit7(vec2(tp.x - cell * pitch - dW * 0.5 + centreOne, tp.y), mask, dW, sH, stroke);
  float hasSign = step(0.5, sKmh) * isTop * zLaunch;
  float numCore = 1.0 - smoothstep(stroke * 0.5 - tw * 0.5, stroke * 0.5 + tw * 0.5, dSeg);
  float numHalo = exp(-max(dSeg - stroke * 0.5, 0.0) / (stroke * 0.6)) * 0.35;
  // the launch arrows step back under the number, so it reads clean
  float signBand = hasSign * (1.0 - smoothstep(sH * 0.5, sH * 0.5 + 1.0, abs(ty)));

  vec3 glow = vec3(0.0);
  // ---- tops: edges, lip, catch line, and a pattern per zone ----
  float topEdge = sr2Line(edge - 0.14, 0.09, wE);
  float lipLine = sr2Line(lip, 0.16, wL);
  float lipWash = exp(-max(lip, 0.0) / 0.9) * 0.35;
  float catchLine = sr2Line(katch, 0.11, wC);
  // launch: faint "^" arrows drifting up the face toward the lip
  float qL = arc / 2.6 - edge * 0.22 - uTime * 0.7;
  float launchArrows = sr2Line(abs(fract(qL) - 0.5), 0.06, max(fwidth(qL), 1e-4)) * near;
  // landing: "v" chevrons drifting down it (the way you roll out)
  float qD = arc / 3.0 + edge * 0.22 + uTime * 0.6;
  float landArrows = sr2Line(abs(fract(qD) - 0.5), 0.06, max(fwidth(qD), 1e-4)) * near;
  // pipe: bands of light round the curve
  float qP = arc / 1.4;
  float pipeBands = sr2Line(abs(fract(qP) - 0.5) - 0.5, 0.05, max(fwidth(qP), 1e-4)) * near;
  // deck: seams every 4 m
  float qK = arc / 4.0;
  float deckSeams = sr2Line(abs(fract(qK) - 0.5) - 0.5, 0.03, max(fwidth(qK), 1e-4)) * near;
  glow += isTop * (
      uEdge * topEdge * uGlowT1
    + uLip * (lipLine * uGlowT2 + lipWash * uGlowT0 * 0.5)
    + uGuide * catchLine * uGlowT1
    + uLip * launchArrows * zLaunch * uGlowT0 * 0.35 * (1.0 - signBand * 0.85)
    + uLip * hasSign * (numCore * uGlowT1 + numHalo * uGlowT0)
    + uGuide * landArrows * zLand * uGlowT0 * 0.2
    + uEdge * pipeBands * zPipe * uGlowT0 * 0.35
    + uEdge * deckSeams * zDeck * uGlowT0 * 0.25);

  // ---- sides: a line along the top edge and light washing down from it (panels: see walls) ----
  float sideTop = sr2Line(edge - 0.06, 0.05, wE);
  float sideWash = exp(-max(edge, 0.0) / 0.7) * 0.22;
  glow += isSide * uEdge * (sideTop * uGlowT1 + sideWash * uGlowT0);

  // ---- end faces (a lip face, a landing's back wall): outline, and the lip on a launch ----
  float endLine = sr2Line(edge - 0.06, 0.05, wE);
  float endLip = sr2Line(lip - 0.12, 0.12, wL);
  glow += isEnd * (uEdge * (endLine * uGlowT1 + exp(-max(edge, 0.0) / 0.6) * 0.2 * uGlowT0) + uLip * endLip * uGlowT2);

  // ---- every wall (sides and end faces): the sky's sheen and dim panel lines ----
  // A tall face (the mega ramp's sides, a gap landing's wall) would otherwise be a black slab.
  // Like the road's barriers, it catches the horizon's colour, most where you see it edge-on and
  // near its top; and dim lines in the ground grid's violet (T0, no bloom) panel it, every 2 m
  // down from the top and every 3 m across (an end face's arc is its distance across).
  float isWall = isSide + isEnd;
  float down = max(edge, 0.0);
  float grazing = 1.0 - sr2Facing(vViewPosition);
  float wallSheen = (0.05 + 0.3 * exp(-down / 3.0)) * (0.3 + 0.7 * grazing * grazing);
  float qB = down / 2.0;
  float wallBands = sr2Line(abs(fract(qB) - 0.5) - 0.5, 0.025, max(fwidth(qB), 1e-4)) * smoothstep(0.6, 1.2, down);
  float qW = arc / 3.0;
  float wallSeams = sr2Line(abs(fract(qW) - 0.5) - 0.5, 0.015, max(fwidth(qW), 1e-4));
  float panels = max(wallBands, wallSeams) * near * exp(-down / 9.0);
  glow += isWall * (uHorizon * wallSheen + uGrid * panels * uGlowT0 * 0.4);

  // ---- bullseye pads: aPark.z = outer radius, aPark.w = inner radius ----
  float r = edge;
  float rOut = arc;
  float rIn = lip;
  float outerRing = sr2Line(r - rOut + 0.2, 0.16, wE);
  float innerRing = sr2Line(r - rIn, 0.13, wE);
  float dot0 = 1.0 - smoothstep(0.55 - wE, 0.55 + wE, r);
  float fillOut = (1.0 - smoothstep(rOut - wE, rOut + wE, r)) * smoothstep(rIn - wE, rIn + wE, r);
  float fillIn = 1.0 - smoothstep(rIn - wE, rIn + wE, r);
  // a slow ripple of light running outward
  float qR = r / 1.2 - uTime * 0.5;
  // (a pad's own distance-fade: its 'arc' is a constant radius, so the shared one never fades)
  float nearPad = 1.0 - smoothstep(0.25, 1.2, wE);
  float ripple = sr2Line(abs(fract(qR) - 0.5) - 0.5, 0.04, max(fwidth(qR), 1e-4)) * nearPad * (1.0 - smoothstep(rOut - 0.5, rOut, r));
  glow += isPad * uGuide * (outerRing * uGlowT1 + innerRing * uGlowT2 * 0.8 + dot0 * uGlowT2 + fillOut * uGlowT0 * 0.08 + fillIn * uGlowT0 * 0.22 + ripple * uGlowT0 * 0.4);

  totalEmissiveRadiance += glow;
}
`

export interface ParkMaterialOptions {
  /** The track's accent colour (its palette.edge), for the edges. */
  edge: string
  /** The sky's horizon colour right now (environment.horizon, copied in every frame), for the walls' sheen. */
  horizon: { value: THREE.Color }
}

/** The material for every solid in the park and the bullseye pads: one draw call for the lot. */
export function makeParkMaterial(time: { value: number }, opts: ParkMaterialOptions): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: PALETTE.road, roughness: 0.34, metalness: 0.18 })
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      uTime: time,
      uEdge: { value: new THREE.Color(opts.edge) },
      uLip: { value: new THREE.Color(PALETTE.ramp) },
      uGuide: { value: new THREE.Color(PALETTE.loopRing) },
      uGrid: { value: new THREE.Color(PALETTE.grid) },
      uHorizon: opts.horizon,
      uGlowT0: { value: GLOW.T0 },
      uGlowT1: { value: GLOW.T1 },
      uGlowT2: { value: GLOW.T2 },
      uSr2NanTag: NAN_TAG,
    })
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${vertexPars}`).replace('#include <begin_vertex>', `#include <begin_vertex>\n${vertexMain}`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${fragmentPars}`)
      .replace('#include <emissivemap_fragment>', fragmentEmissive)
      .replace('#include <opaque_fragment>', fragmentClamp)
  }
  mat.customProgramCacheKey = () => 'sr2-stunt-park-v7'
  return mat
}

// ---------------------------------------------------------------- rings

// Each ring's state arrives per instance in aRing (written by ringFx.ts every frame it changes):
//   x  hot: 0..1, the white-hot flash as a ring re-forms (T3, under half a second)
//   y  thickness of the tube: 1 = a whole ring, 0.3 = the thin ghost that marks where an
//      exploded ring will come back, 0 = nothing at all (the moment it explodes)
//   z  ghost: 0 = the ring's own look, 1 = the ghost's look
//   w  how far the countdown has got, 0..1: the ghost's dial lights up as it fills
const ringVertexPars = /* glsl */ `
attribute vec4 aRing;
varying vec4 vRing;
varying vec2 vRingLocal;
`
const ringVertexMain = /* glsl */ `
vRing = aRing;
vRingLocal = position.xy;
{
  // Pull the tube in toward its centre line (radius 1 in the torus's own plane), so the ghost
  // is a thin thread of the same ring and a ring that just exploded is gone.
  vec2 c = position.xy / max(length(position.xy), 1e-4);
  vec3 line = vec3(c, 0.0);
  transformed = line + (transformed - line) * clamp(aRing.y, 0.0, 1.0);
}
`
const ringFragmentPars = /* glsl */ `
uniform vec3 uRing;
uniform vec3 uHot;
uniform float uGlowT0;
uniform float uGlowT1;
uniform float uGlowT2;
uniform float uGlowT3;
varying vec4 vRing;
varying vec2 vRingLocal;
${ROAD_GLSL}
`
const ringFragmentEmissive = /* glsl */ `
#include <emissivemap_fragment>
{
  float hot = clamp(vRing.x, 0.0, 1.0);
  float ghost = clamp(vRing.z, 0.0, 1.0);
  float done = clamp(vRing.w, 0.0, 1.0);
  // A whole ring: a tube of violet light (T2), white-hot for a moment as it re-forms (T3).
  vec3 whole = mix(uRing * uGlowT2, mix(uRing, uHot, 0.6) * uGlowT3, hot);
  // The ghost: a dashed thread, clockwise from the top; the part of the countdown already gone
  // glows (T1), the rest is dim (T0), so it reads as a dial filling up.
  float around = fract(atan(vRingLocal.x, vRingLocal.y) / 6.2831853);
  float dash = step(0.4, fract(around * 36.0));
  float lit = step(around, done);
  vec3 thread = uRing * mix(uGlowT0 * 0.55 * dash, uGlowT1, lit);
  totalEmissiveRadiance += mix(whole, thread, ghost);
}
`

/** The stunt rings: violet light tubes (pickup colour); ringFx.ts sets each one's state (aRing). */
export function makeRingMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: PALETTE.uiPanelSolid, roughness: 0.4, metalness: 0.2 })
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      uRing: { value: new THREE.Color(PALETTE.core) },
      uHot: { value: new THREE.Color(PALETTE.coreHot) },
      uGlowT0: { value: GLOW.T0 },
      uGlowT1: { value: GLOW.T1 },
      uGlowT2: { value: GLOW.T2 },
      uGlowT3: { value: GLOW.T3 },
      uSr2NanTag: NAN_TAG,
    })
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${ringVertexPars}`).replace('#include <begin_vertex>', `#include <begin_vertex>\n${ringVertexMain}`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${ringFragmentPars}`)
      .replace('#include <emissivemap_fragment>', ringFragmentEmissive)
      .replace('#include <opaque_fragment>', fragmentClamp)
  }
  mat.customProgramCacheKey = () => 'sr2-stunt-ring-v2'
  return mat
}
