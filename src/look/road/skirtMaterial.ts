// ============================================================
//  SKIRT MATERIAL - the sides and underside of the road slab
// ------------------------------------------------------------
//  The road is a solid slab, not a paper-thin sheet. Its sides are
//  dark glass, and a thin neon line runs along the top lip of each
//  side, continuing the edge strip you see from the driver's seat,
//  so a raised road or a bridge reads as one lit object from off
//  the road too. So a bridge reads as a slim lit deck, never a dark
//  wall across the sky:
//    - the lip line's light washes softly down the face (no hard
//      top edge against the sky)
//    - the upper face catches the sky's colour like satin (sheen)
//    - a light strip runs along the slab's bottom edge wherever
//      there is air under it (aLift), wrapping onto the underside
//  (BridgePylons.tsx stands the supports under it.)
//
//  uv.x on the skirt = metres from that side's top lip, round the
//  cross-section (0 at the lip); uv.y = s along the road.
//  aSlabT / aLift come from skirtExtras.ts.
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
attribute float aSlabT;
attribute float aLift;
varying float vLipDist;
varying float vSkirtS;
varying float vSkirtLat;
varying float vSkirtHalf;
varying float vSlabT;
varying float vLift;
`

const vertexMain = /* glsl */ `
vLipDist = uv.x;
vSkirtS = uv.y;
vSkirtLat = aLateral;
vSkirtHalf = aHalfWidth;
vSlabT = aSlabT;
vLift = aLift;
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
uniform vec3 uRoadColor;
uniform vec3 uHorizon;
varying float vLipDist;
varying float vSkirtS;
varying float vSkirtLat;
varying float vSkirtHalf;
varying float vSlabT;
varying float vLift;
${ROAD_GLSL}
`

// Where three reads a roughness map: work out which piece this bit of slab
// belongs to, and turn a loop's outside into near-black glass.
const fragmentFields = /* glsl */ `
float roughnessFactor = roughness;
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
// a loop's outside: the road's own near-black, glossy (a faint sheen of sky)
diffuseColor.rgb = mix(diffuseColor.rgb, uRoadColor, inLoop);
roughnessFactor = mix(roughnessFactor, 0.16, inLoop);
`

const fragmentEmissive = /* glsl */ `
#include <emissivemap_fragment>
{
  vec3 lineCol = mix(uEdgeColor, uLoopColor, inLoop);

  // A soft rim where the slab turns away from you, so its silhouette never
  // reads as a black hole. T0.
  // (geometric normal from screen derivatives: exact for this face whatever
  // the mesh's normal attribute says)
  vec3 faceN = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
  float facing = abs(dot(faceN, normalize(vViewPosition)));
  float rim = pow(1.0 - facing, 3.5);
  totalEmissiveRadiance += lineCol * rim * mix(0.22, 0.05, inLoop);

  // the lip line, continuing the road's edge strip down the side
  totalEmissiveRadiance += lineCol * sr2Line(vLipDist - 0.06, 0.035, wU) * uGlowT2 * 0.8 * (1.0 - wallBack);

  // ---- plain slab (not a loop, not a wall ride's back) ----
  float plain = (1.0 - inLoop) * (1.0 - wallBack);
  // the side faces (the underside sits between the edges, |lateral| < half width)
  float sideFace = step(vSkirtHalf - 0.02, abs(vSkirtLat)) * plain;
  // A soft top edge: the lip line's light washes down the face and fades,
  // so the slab never shows a hard bright line over a black band. T0.
  float wash = exp(-max(vLipDist - 0.06, 0.0) / 0.32);
  totalEmissiveRadiance += lineCol * wash * sideFace * uGlowT0 * 0.3;
  // Satin sheen: the upper face catches the sky's colour (strongest at a
  // glancing angle), so far away the deck melts toward the haze instead of
  // cutting a dark slab across it.
  float sheen = exp(-vLipDist / 0.8) * (0.14 + 0.5 * pow(1.0 - facing, 2.0));
  totalEmissiveRadiance += uHorizon * sheen * sideFace;
  // The underside light strip: a thin tube along the slab's bottom corner,
  // wrapping onto the underside, with a soft glow either side. Only where
  // there is air under the road (aLift), so grounded roads stay plain. T1.
  float corner = vLipDist - vSlabT; // < 0 up the side face, > 0 across the underside
  float strip = sr2Line(corner, 0.05, wU);
  float stripGlow = exp(-abs(corner) / 0.3);
  totalEmissiveRadiance += lineCol * (strip * uGlowT1 + stripGlow * uGlowT0 * 0.22) * vLift * plain;

  // loops: thin bright hoops every 3 m (same phase as the driving surface's
  // rings). Thin is the point: bloom spreads light in proportion to how much
  // of it there is, so a thin T2 line blooms as a line, where a wide one
  // washed the dark glass between the hoops into a flat panel.
  float hoop = sr2Line(abs(fract(s / 3.0 + 0.5) - 0.5) * 3.0, 0.045, wS);
  totalEmissiveRadiance += uLoopColor * inLoop * hoop * uGlowT2;

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
    shader.uniforms.uRoadColor = { value: new THREE.Color(PALETTE.road) }
    shader.uniforms.uHorizon = uniforms.uHorizon
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${vertexPars}`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>\n${vertexMain}`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${fragmentPars}`)
      .replace('#include <roughnessmap_fragment>', fragmentFields)
      .replace('#include <emissivemap_fragment>', fragmentEmissive)
  }
  mat.customProgramCacheKey = () => 'sr2-skirt-v6'
  return mat
}
