// ============================================================
//  TUNNEL MATERIAL - the walls and ceiling inside a tunnel
// ------------------------------------------------------------
//  Inside a tunnel it is dark: the sun, the sky and their
//  reflections fade out with the cover value (tunnelLight.ts). What
//  you see by is the car's headlights and the tunnel's own light,
//  drawn as glowing lines on its surfaces (src/track/tunnelMeshes.ts
//  gives every vertex uv.x: metres up a wall from the road's edge,
//  or metres across the ceiling from the middle; uv.y: s):
//
//    - a strip of light along each wall at about knee height, in
//      the track's edge colour (glow tier T1: it streaks past at
//      speed but never out-shines the road's own T2 edges)
//    - bars of light across the ceiling every TUNNEL_BAR_EVERY
//      metres, in the lane-line colour (T1), like the strip lights
//      in a real tunnel
//    - faint panel seams (T0) in the ground grid's violet, so the
//      walls show their shape and never read as a black void
//
//  The surface itself is the road's dark glass, lit for real by the
//  headlights (their spot lights reach it like any lit material).
// ============================================================

import * as THREE from 'three'
import { GLOW, PALETTE } from '../../core/palette'
import { ROAD_GLSL } from './glsl'
import { fragmentClamp } from './roadMaterial'
import { COVER_FOG, COVER_FRAGMENT_PARS, COVER_INDIRECT, COVER_VERTEX_MAIN, COVER_VERTEX_PARS, coverLightsBegin } from './tunnelLight'

/** Metres between the ceiling's light bars. */
export const TUNNEL_BAR_EVERY = 12
/** The wall strip's height above the road's edge, metres. */
const STRIP_HEIGHT = 1.1

export interface TunnelUniforms {
  uStripColor: { value: THREE.Color }
  uBarColor: { value: THREE.Color }
  uSeamColor: { value: THREE.Color }
}

const vertexPars = /* glsl */ `
attribute float aPart;
varying float vPart;
varying vec2 vTun;
${COVER_VERTEX_PARS}
`
const vertexMain = /* glsl */ `
vPart = aPart;
vTun = uv;
${COVER_VERTEX_MAIN}
`
const fragmentPars = /* glsl */ `
uniform vec3 uStripColor;
uniform vec3 uBarColor;
uniform vec3 uSeamColor;
varying float vPart;
varying vec2 vTun;
${COVER_FRAGMENT_PARS}
${ROAD_GLSL}
`
const fragmentEmissive = /* glsl */ `
#include <emissivemap_fragment>
{
  // Every derivative first, outside any branch (Windows' Direct3D path really branches).
  float u = vTun.x;
  float s = vTun.y;
  float wU = max(fwidth(u), 1e-4);
  float wS = max(fwidth(s), 1e-4);
  float onWall = 1.0 - step(0.5, vPart);
  float onCeil = 1.0 - onWall;
  // Far away fine lines fade to their average (no shimmer).
  float fine = 1.0 - smoothstep(0.08, 0.4, max(wU, wS));

  // The strip along each wall: a bright core in a soft band.
  float strip = sr2Line(u - ${STRIP_HEIGHT.toFixed(2)}, 0.07, wU) * onWall;
  float stripGlow = exp(-abs(u - ${STRIP_HEIGHT.toFixed(2)}) / 0.35) * onWall * 0.12;

  // Light bars across the ceiling: 0.5 m long, 3.2 m wide, every TUNNEL_BAR_EVERY metres.
  float bs = abs(fract(s / ${TUNNEL_BAR_EVERY.toFixed(1)} + 0.5) - 0.5) * ${TUNNEL_BAR_EVERY.toFixed(1)};
  float bar = sr2Line(bs, 0.25, wS) * sr2Line(u, 1.6, wU) * onCeil;
  // ...and their light pooled faintly round them on the ceiling.
  float barGlow = exp(-bs / 1.5) * exp(-abs(u) / 3.0) * onCeil * 0.06;

  // Panel seams: across every 6 m, and one along each wall at 2.8 m.
  float ps = abs(fract(s / 6.0 + 0.5) - 0.5) * 6.0;
  float seam = max(sr2Line(ps, 0.03, wS), sr2Line(u - 2.8, 0.03, wU) * onWall) * fine;

  totalEmissiveRadiance += uStripColor * (strip * ${GLOW.T1.toFixed(3)} + stripGlow);
  totalEmissiveRadiance += uBarColor * (bar * ${GLOW.T1.toFixed(3)} + barGlow);
  totalEmissiveRadiance += uSeamColor * seam * ${GLOW.T0.toFixed(3)} * 0.3;
}
`

/** The material for TrackRuntime.meshes.tunnels.inside. Dispose it with the mesh. */
export function makeTunnelMaterial(edgeHex: string): { material: THREE.MeshStandardMaterial; uniforms: TunnelUniforms } {
  const uniforms: TunnelUniforms = {
    uStripColor: { value: new THREE.Color(edgeHex) },
    uBarColor: { value: new THREE.Color(PALETTE.laneLine) },
    uSeamColor: { value: new THREE.Color(PALETTE.grid) },
  }
  const material = new THREE.MeshStandardMaterial({ color: PALETTE.road, roughness: 0.38, metalness: 0, envMapIntensity: 1 })
  const lightsBegin = coverLightsBegin(THREE.ShaderChunk.lights_fragment_begin)
  if (!lightsBegin) console.error('[look] three.js light chunk changed: tunnel walls keep the sun inside')
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${vertexPars}`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>\n${vertexMain}`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${fragmentPars}`)
      .replace('#include <emissivemap_fragment>', fragmentEmissive)
      .replace('#include <lights_fragment_begin>', lightsBegin ?? '#include <lights_fragment_begin>')
      .replace('#include <lights_fragment_end>', `${COVER_INDIRECT}\n#include <lights_fragment_end>`)
      .replace('#include <fog_fragment>', COVER_FOG)
      .replace('#include <opaque_fragment>', fragmentClamp)
  }
  material.customProgramCacheKey = () => 'sr2-tunnel-v1'
  return { material, uniforms }
}
