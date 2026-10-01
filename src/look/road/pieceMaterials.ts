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
//    and bands of light racing along the inside face (T1, the
//    alternate edge colour), so the stadium wall feels fast.
//    uv.x = metres around the wall's profile from the road edge:
//    up the inner face, across the top, down the outer face.
// ============================================================

import * as THREE from 'three'
import { GLOW, PALETTE } from '../../core/palette'
import { ROAD_GLSL } from './glsl'

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
    })
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${rampVertexPars}`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>\n${rampVertexMain}`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${rampFragmentPars}`)
      .replace('#include <emissivemap_fragment>', rampFragmentEmissive)
  }
  mat.customProgramCacheKey = () => 'sr2-ramp-v1'
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
uniform float uGlowT1;
uniform float uGlowT2;
uniform float uTime;
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
  // the top rail: the whole top, brightest along its inner edge
  float rail = smoothstep(uRailU - wU, uRailU + wU, u) * (1.0 - smoothstep(uRailU + uRailW - wU, uRailU + uRailW + wU, u));
  float railEdge = sr2Line(u - uRailU - 0.06, 0.05, wU);
  // a thin line along the foot of the inner face
  float base = sr2Line(u - 0.18, 0.03, wU);
  // light streaks racing along the inner face in the driving direction: a
  // bright stripe at about car height with a faint wash above and below
  float inner = step(0.3, u) * step(u, uRailU - 0.25);
  float ph = fract((v - uTime * 48.0) / 64.0);
  float run = smoothstep(0.0, 0.02, ph) * (1.0 - smoothstep(0.02, 0.2, ph));
  float stripe = sr2Line(u - 0.95, 0.12, wU);
  float band = run * inner * (stripe + 0.12);
  band *= 1.0 - smoothstep(0.5, 2.0, wV); // fades out where it would shimmer far away
  totalEmissiveRadiance += uRailColor * (rail * uGlowT1 * 0.7 + railEdge * uGlowT2 + base * uGlowT1)
    + uBandColor * band * uGlowT1;
}
`

export function makeBarrierMaterial(
  time: { value: number },
  opts: { rail: string; band: string; height: number },
): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: PALETTE.groundSheen, roughness: 0.22, metalness: 0.35 })
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      uTime: time,
      uRailColor: { value: new THREE.Color(opts.rail) },
      uBandColor: { value: new THREE.Color(opts.band) },
      uRailU: { value: opts.height },
      uRailW: { value: 0.7 },
      uGlowT1: { value: GLOW.T1 },
      uGlowT2: { value: GLOW.T2 },
    })
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${wallVertexPars}`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>\n${wallVertexMain}`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${wallFragmentPars}`)
      .replace('#include <emissivemap_fragment>', wallFragmentEmissive)
  }
  mat.customProgramCacheKey = () => 'sr2-barrier-v2'
  return mat
}
