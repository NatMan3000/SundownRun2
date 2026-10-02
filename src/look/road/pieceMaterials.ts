// ============================================================
//  PIECE MATERIALS - kicker ramps and stadium barrier walls
// ------------------------------------------------------------
//  Same idea as the road: a normal lit material (so the sun and
//  headlights land on it) with lines drawn in its shader from the
//  mesh's own numbers, so they stay crisp at any distance.
//
//  Ramps (meshes.ramps):  dark wedge, an amber lip strip along the
//    top edge you launch off (T2), amber edge lines up both sides of
//    the ramp face (T1), and faint arrows pointing up the face.
//    Attributes: aAlong (0 at the foot, 1 at the lip), uv.x across.
//
//  Barriers (meshes.barriers, the Hyperdrome walls): dark glass with
//    a glowing top rail in the edge colour (T2), a thin base line,
//    and comets of light racing along the inside face (T1, the
//    alternate edge colour: a soft head, a long tail, a glow that
//    falls away above and below), so the stadium wall feels fast.
//    The outer face (seen from the infield or from outside the
//    stadium) is never a flat dark slab: a thin line on its top
//    edge, the rail's light washing softly down it, a satin sheen
//    of the sky, and a thin light line at road level.
//    uv.x = metres around the wall's profile from the road edge:
//    up the inner face, across the top, down the outer face.
// ============================================================

import * as THREE from 'three'
import { GLOW, PALETTE } from '../../core/palette'
import { NAN_TAG, ROAD_GLSL } from './glsl'
import { fragmentClamp } from './roadMaterial'

// ---------------------------------------------------------------- ramps

const rampVertexPars = /* glsl */ `
attribute float aAlong;
varying float vAlong;
varying vec2 vRampUv;
varying float vUp;
`
const rampVertexMain = /* glsl */ `
vAlong = aAlong;
vRampUv = uv;
vUp = normal.y;
`
const rampFragmentPars = /* glsl */ `
uniform vec3 uRampColor;
uniform float uGlowT0;
uniform float uGlowT1;
uniform float uGlowT2;
uniform float uTime;
varying float vAlong;
varying vec2 vRampUv;
varying float vUp;
${ROAD_GLSL}
`
const rampFragmentEmissive = /* glsl */ `
#include <emissivemap_fragment>
{
  float face = smoothstep(0.35, 0.6, vUp); // the sloped top face, not the sides
  float wA = max(fwidth(vAlong), 1e-4);
  float wU = max(fwidth(vRampUv.x), 1e-4);
  float lip = sr2Line(1.0 - vAlong, 0.022, wA) * face;
  float edges = (sr2Line(vRampUv.x - 0.03, 0.012, wU) + sr2Line(0.97 - vRampUv.x, 0.012, wU)) * face;
  // two faint "^" arrows up the face, drifting upward
  float q = vAlong * 3.0 + abs(vRampUv.x - 0.5) * 1.6;
  float d = abs(fract(q - uTime * 0.8) - 0.5);
  float arrows = sr2Line(d, 0.05, max(fwidth(q), 1e-4)) * face * smoothstep(0.1, 0.25, vAlong) * (1.0 - smoothstep(0.75, 0.88, vAlong));
  totalEmissiveRadiance += uRampColor * (lip * uGlowT2 + edges * uGlowT1 + arrows * uGlowT0 * 0.3);
}
`

export function makeRampMaterial(time: { value: number }): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: PALETTE.road, roughness: 0.32, metalness: 0.1 })
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      uTime: time,
      uRampColor: { value: new THREE.Color(PALETTE.ramp) },
      uGlowT0: { value: GLOW.T0 },
      uGlowT1: { value: GLOW.T1 },
      uGlowT2: { value: GLOW.T2 },
      uSr2NanTag: NAN_TAG,
    })
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${rampVertexPars}`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>\n${rampVertexMain}`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${rampFragmentPars}`)
      .replace('#include <emissivemap_fragment>', rampFragmentEmissive)
      .replace('#include <opaque_fragment>', fragmentClamp)
  }
  mat.customProgramCacheKey = () => 'sr2-ramp-v2'
  return mat
}

// ---------------------------------------------------------------- barriers

const wallVertexPars = /* glsl */ `
varying vec2 vWallUv;
`
const wallVertexMain = /* glsl */ `
vWallUv = uv;
`
const wallFragmentPars = /* glsl */ `
uniform vec3 uRailColor;
uniform vec3 uBandColor;
uniform float uRailU;      // where the top of the inner face starts (barrier height)
uniform float uRailW;      // width of the top
uniform float uGlowT0;
uniform float uGlowT1;
uniform float uGlowT2;
uniform float uTime;
uniform float uBandPeriod;
uniform vec3 uHorizon;
varying vec2 vWallUv;
${ROAD_GLSL}
`
const wallFragmentEmissive = /* glsl */ `
#include <emissivemap_fragment>
{
  float u = vWallUv.x;
  float v = vWallUv.y;
  float wU = max(fwidth(u), 1e-4);
  float wV = max(fwidth(v), 1e-4);
  // the top rail: a bright line along its inner edge whose light falls away
  // across the top (a glow, not a flat painted stripe: close up, beside a
  // steep bank, the top fills a big part of the screen)
  float rail = smoothstep(uRailU - wU, uRailU + wU, u) * (1.0 - smoothstep(uRailU + uRailW - wU, uRailU + uRailW + wU, u));
  rail *= exp(-max(u - uRailU - 0.06, 0.0) / 0.16);
  float railEdge = sr2Line(u - uRailU - 0.06, 0.05, wU);
  // a thin line along the foot of the inner face
  float base = sr2Line(u - 0.18, 0.03, wU);
  // Light racing along the inner face in the driving direction, at about car
  // height: a bright head that fades into a long tail (a comet, not a card),
  // a thin antialiased core line, and a soft glow round it that falls off
  // above and below. No hard edge anywhere: every boundary is a smooth curve.
  // d: how far behind the comet's front this point is, as a fraction of the
  // cycle (about 64 m, fitted to the lap so the comets don't jump at the
  // start line; they move forward at 48 m/s, head first)
  float d = fract((uTime * 48.0 - v) / uBandPeriod);
  float nose = smoothstep(0.0, 0.09, d);                  // ~6 m soft nose
  float tail = 1.0 - smoothstep(0.03, 0.34, d);           // ~20 m fading tail
  float run = nose * tail * tail;
  float onFace = smoothstep(0.15, 0.45, u) * (1.0 - smoothstep(uRailU - 0.6, uRailU - 0.2, u));
  float wAA = max(wU, 0.02);                              // never thinner than a smooth pixel edge
  float stripe = sr2Line(u - 0.95, 0.06, wAA * 1.5);
  float gx = (u - 0.95) / 0.32;                           // (x * x, not pow(x, 2.0): pow of a negative number is NaN)
  float glow = exp(-gx * gx);
  float band = run * onFace * (stripe + glow * 0.32);
  band *= 1.0 - smoothstep(0.5, 2.0, wV); // fades out where it would shimmer far away
  totalEmissiveRadiance += uRailColor * (rail * uGlowT1 * 0.7 + railEdge * uGlowT2 + base * uGlowT1)
    + uBandColor * band * uGlowT1;

  // ---- the outer face: from the top's outer edge down past the road
  float outerTop = uRailU + uRailW;
  float down = u - outerTop;                       // metres down the outer face
  float outer = smoothstep(-wU, wU, down);
  float outerEdge = sr2Line(down - 0.05, 0.03, wU);
  float wash = exp(-max(down, 0.0) / 0.4);
  float grazing = 1.0 - sr2Facing(vViewPosition);   // 0 square-on .. 1 edge-on, never NaN
  float sheen = exp(-max(down, 0.0) / 1.1) * (0.14 + 0.5 * grazing * grazing);
  // road level on the outer face is one barrier height below its top
  float roadLine = sr2Line(down - uRailU + 0.15, 0.035, wU);
  totalEmissiveRadiance += outer * (uRailColor * (outerEdge * uGlowT1 + wash * uGlowT0 * 0.3 + roadLine * uGlowT1 * 0.7) + uHorizon * sheen);
}
`

export function makeBarrierMaterial(
  time: { value: number },
  horizon: { value: THREE.Color },
  opts: { rail: string; band: string; height: number; bandPeriod: number },
): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: PALETTE.groundSheen, roughness: 0.22, metalness: 0.35 })
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      uTime: time,
      uRailColor: { value: new THREE.Color(opts.rail) },
      uBandColor: { value: new THREE.Color(opts.band) },
      uRailU: { value: opts.height },
      uRailW: { value: 0.7 },
      uBandPeriod: { value: opts.bandPeriod },
      uGlowT0: { value: GLOW.T0 },
      uGlowT1: { value: GLOW.T1 },
      uGlowT2: { value: GLOW.T2 },
      uHorizon: horizon,
      uSr2NanTag: NAN_TAG,
    })
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${wallVertexPars}`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>\n${wallVertexMain}`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${wallFragmentPars}`)
      .replace('#include <emissivemap_fragment>', wallFragmentEmissive)
      .replace('#include <opaque_fragment>', fragmentClamp)
  }
  mat.customProgramCacheKey = () => 'sr2-barrier-v7'
  return mat
}
