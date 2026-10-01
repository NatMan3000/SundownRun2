// ============================================================
//  SKIRT MATERIAL - the sides and underside of the road slab
// ------------------------------------------------------------
//  The road is a solid slab, not a paper-thin sheet. Its sides are
//  dark glass with a satin sheen, and a thin neon line runs along
//  the top lip of each side, continuing the edge strip you see from
//  the driver's seat, so a raised road or a bridge reads as one lit
//  object from off the road too.
//
//  uv.x on the skirt = metres from that side's top lip, round the
//  cross-section (0 at the lip); uv.y = s along the road.
//
//  Loops are rings of light: on a loop the slab's sides and outside
//  carry the same hoops as the driving surface, at the same spacing
//  and phase, so road + skirt make full hoops round the whole
//  cross-section; the outside is dark glass with a soft cyan glow,
//  never a flat coloured face.
//  Wall rides: the wall's top lip gets an edge tube, and its back
//  carries the violet ribs of its face.
// ============================================================

import * as THREE from 'three'
import { PALETTE } from '../../core/palette'
import { MAX_RANGES } from './roadMaterial'
import type { RoadUniforms } from './roadMaterial'
import { ROAD_GLSL } from './glsl'

const vertexPars = /* glsl */ `
attribute float aLateral;
attribute float aHalfWidth;
varying float vLipDist;
varying float vSkirtS;
varying float vSkirtLat;
varying float vSkirtHalf;
`

const vertexMain = /* glsl */ `
vLipDist = uv.x;
vSkirtS = uv.y;
vSkirtLat = aLateral;
vSkirtHalf = aHalfWidth;
`

const fragmentPars = /* glsl */ `
uniform vec3 uEdgeColor;
uniform vec3 uLoopColor;
uniform vec3 uWallColor;
uniform float uGlowT0;
uniform float uGlowT1;
uniform float uGlowT2;
uniform vec2 uLoopRange[${MAX_RANGES}];
uniform int uLoopCount;
uniform vec2 uWallRange[${MAX_RANGES}];
uniform int uWallCount;
varying float vLipDist;
varying float vSkirtS;
varying float vSkirtLat;
varying float vSkirtHalf;
${ROAD_GLSL}
`

const fragmentEmissive = /* glsl */ `
#include <emissivemap_fragment>
{
  float s = vSkirtS;
  float wS = max(fwidth(s), 1e-4);
  float wU = max(fwidth(vLipDist), 1e-4);

  // which piece (if any) this bit of slab belongs to (soft ends: 1.5 m fades)
  float inLoop = 0.0;
  for (int i = 0; i < ${MAX_RANGES}; i++) {
    if (i >= uLoopCount) break;
    inLoop = max(inLoop, smoothstep(uLoopRange[i].x - 1.5, uLoopRange[i].x, s) * (1.0 - smoothstep(uLoopRange[i].y, uLoopRange[i].y + 1.5, s)));
  }
  float inWall = 0.0;
  for (int i = 0; i < ${MAX_RANGES}; i++) {
    if (i >= uWallCount) break;
    inWall = max(inWall, smoothstep(uWallRange[i].x - 1.5, uWallRange[i].x, s) * (1.0 - smoothstep(uWallRange[i].y, uWallRange[i].y + 1.5, s)));
  }
  // the wall's own back (beyond the drivable edge), not the plain slab side opposite it
  float wallBack = inWall * step(vSkirtHalf + 0.5, abs(vSkirtLat));

  vec3 lineCol = mix(uEdgeColor, uLoopColor, inLoop);

  // A soft rim where the slab turns away from you, so its silhouette never
  // reads as a black hole. T0.
  // (geometric normal from screen derivatives: exact for this face whatever
  // the mesh's normal attribute says)
  vec3 faceN = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
  float facing = abs(dot(faceN, normalize(vViewPosition)));
  float rim = pow(1.0 - facing, 3.5);
  totalEmissiveRadiance += lineCol * rim * 0.22;

  // the lip line, continuing the road's edge strip down the side
  totalEmissiveRadiance += lineCol * sr2Line(vLipDist - 0.06, 0.035, wU) * uGlowT2 * 0.8 * (1.0 - wallBack);

  // loops: hoops every 3 m (same phase as the driving surface's rings) and
  // a soft glow over the outside so the loop reads against the night sky
  // (on the outside the hoops sit just over the bloom line, T1 at its low end:
  // at full T2 their bloom filled the dark glass between them into a flat cyan
  // face; this keeps a soft halo and dark glass in between)
  float hoop = sr2Line(abs(fract(s / 3.0 + 0.5) - 0.5) * 3.0, 0.09, wS);
  totalEmissiveRadiance += uLoopColor * inLoop * (hoop * 1.25 + 0.02 * uGlowT0);

  // wall rides: an edge tube along the top lip, violet ribs down the back
  float lipTube = sr2Line(vLipDist - 0.4, 0.11, wU);
  float rib = sr2Line(abs(fract(s / 2.5 + 0.5) - 0.5) * 2.5, 0.08, wS) * step(0.9, vLipDist);
  totalEmissiveRadiance += wallBack * (uEdgeColor * lipTube * uGlowT2 + uWallColor * rib * uGlowT1);
}
`

export function makeSkirtMaterial(uniforms: RoadUniforms): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: PALETTE.groundSheen,
    roughness: 0.42,
    metalness: 0.2,
  })
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${vertexPars}`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>\n${vertexMain}`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${fragmentPars}`)
      .replace('#include <emissivemap_fragment>', fragmentEmissive)
  }
  mat.customProgramCacheKey = () => 'sr2-skirt-v4'
  return mat
}
