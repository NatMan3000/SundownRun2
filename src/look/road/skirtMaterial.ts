// ============================================================
//  SKIRT MATERIAL - the sides and underside of the road slab
// ------------------------------------------------------------
//  The road is a solid slab, not a paper-thin sheet. Its sides are
//  dark glass with a satin sheen (so they still show their shape
//  against the sky and catch the sun), and a thin neon line runs
//  along the top lip of each side, continuing the edge strip you
//  see from the driver's seat, so a raised road or a bridge reads
//  as one lit object from off the road too.
// ============================================================

import * as THREE from 'three'
import { PALETTE } from '../../core/palette'
import type { RoadUniforms } from './roadMaterial'

const fragmentPars = /* glsl */ `
uniform vec3 uEdgeColor;
uniform float uGlowT2;
varying float vLipDist;
`

const vertexPars = /* glsl */ `
varying float vLipDist;
`

// uv.x on the skirt: metres from the slab's top lip around its cross-section.
const vertexMain = /* glsl */ `
vLipDist = uv.x;
`

const fragmentEmissive = /* glsl */ `
#include <emissivemap_fragment>
{
  float w = max(fwidth(vLipDist), 1e-4);
  float hwPx = max(0.035, w * 0.5);
  float cov = (1.0 - smoothstep(hwPx - w * 0.5, hwPx + w * 0.5, abs(vLipDist - 0.06))) * (0.035 / hwPx);
  totalEmissiveRadiance += uEdgeColor * cov * uGlowT2 * 0.8;
}
`

export function makeSkirtMaterial(uniforms: RoadUniforms): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: PALETTE.groundSheen,
    roughness: 0.42,
    metalness: 0.2,
  })
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uEdgeColor = uniforms.uEdgeColor
    shader.uniforms.uGlowT2 = uniforms.uGlowT2
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${vertexPars}`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>\n${vertexMain}`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${fragmentPars}`)
      .replace('#include <emissivemap_fragment>', fragmentEmissive)
  }
  mat.customProgramCacheKey = () => 'sr2-skirt-v1'
  return mat
}
