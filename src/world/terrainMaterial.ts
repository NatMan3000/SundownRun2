// ============================================================
//  TERRAIN MATERIAL - dark glass with a glowing grid
// ------------------------------------------------------------
//  A normal three.js MeshPhysicalMaterial (so it gets the real
//  lights, the shadow, and reflections of the sky from
//  scene.environment), with a few extra lines of shader code
//  stitched in through onBeforeCompile:
//
//   1. VARIATION. Four noise patterns (textures.ts) nudge the
//      colour and the glossiness, and cut the glass into faint
//      plates, so the ground is never one flat tone.
//   2. THE GRID. Neon lines every 10 m with brighter lines every
//      50 m, drawn with the "pristine grid" trick (Ben Golus):
//      lines keep a real width up close and fade to their average
//      brightness far away instead of shimmering. Glow tier T1 near
//      the car, T0 by 60 m, gone in the distance.
//   3. SHEEN. A violet rim at glancing angles, so hills still show
//      their shape at night when there is little light.
//   4. HAZE. Instead of three's flat fog colour, far ground melts
//      into the exact colour of the sky behind it (skyGlsl.ts),
//      plus a low haze that settles in the valleys.
// ============================================================

import * as THREE from 'three'
import { GLOW, PALETTE } from '../core/palette'
import { SKY_GLSL } from './skyGlsl'
import { skyUniforms } from './sky'
import { FOG_DENSITY } from './Lighting'

export interface TerrainUniforms {
  uCarPos: { value: THREE.Vector3 }
  uGridColor: { value: THREE.Color }
  uNoise: { value: THREE.Texture }
  uNight: { value: number }
  uSheen: { value: THREE.Color }
  uHazeBase: { value: number }
  uFogDensity: { value: number }
}

const VERTEX_PARS = /* glsl */ `
varying vec3 vTerrainWorld;
varying vec3 vTerrainNormal;
`
const VERTEX_MAIN = /* glsl */ `
vTerrainWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
vTerrainNormal = normalize( mat3( modelMatrix ) * objectNormal );
`

const FRAGMENT_PARS = /* glsl */ `
${SKY_GLSL}
varying vec3 vTerrainWorld;
varying vec3 vTerrainNormal;
uniform vec3 uCarPos;
uniform vec3 uGridColor;
uniform sampler2D uNoise;
uniform float uNight;
uniform vec3 uSheen;
uniform float uHazeBase;
uniform float uFogDensity;

// Pristine grid (Ben Golus): uv in cells, lineWidth as a fraction of a cell.
float pristineGrid( vec2 uv, float lineWidth ) {
  vec4 dd = vec4( dFdx( uv ), dFdy( uv ) );
  vec2 deriv = vec2( length( dd.xz ), length( dd.yw ) );
  vec2 target = vec2( lineWidth );
  vec2 drawWidth = clamp( target, deriv, vec2( 0.5 ) );
  vec2 lineAA = deriv * 1.5;
  vec2 gridUV = 1.0 - abs( fract( uv ) * 2.0 - 1.0 );
  vec2 g = smoothstep( drawWidth + lineAA, drawWidth - lineAA, gridUV );
  g *= clamp( target / drawWidth, 0.0, 1.0 );
  g = mix( g, target, clamp( deriv * 2.0 - 1.0, 0.0, 1.0 ) );
  return mix( g.x, 1.0, g.y );
}
`

// After color_fragment: tint the glass with the slow noise.
const COLOR_MOD = /* glsl */ `
vec4 tNoiseBig = texture2D( uNoise, vTerrainWorld.xz / 520.0 );
vec4 tNoiseMid = texture2D( uNoise, vTerrainWorld.xz / 96.0 + 0.37 );
vec4 tNoiseFine = texture2D( uNoise, vTerrainWorld.xz / 11.0 );
float tPlate = texture2D( uNoise, vTerrainWorld.xz / 64.0 ).a;
float tVar = tNoiseBig.r * 0.6 + tNoiseMid.g * 0.4;
diffuseColor.rgb = mix( diffuseColor.rgb, uSheen, smoothstep( 0.35, 0.85, tVar ) * 0.55 + tPlate * 0.18 );
`

// After roughnessmap_fragment: glossy, but not one mirror.
const ROUGHNESS_MOD = /* glsl */ `
roughnessFactor = clamp( roughnessFactor * mix( 0.7, 1.45, tNoiseMid.g * 0.7 + tNoiseFine.b * 0.3 ) + ( tPlate - 0.4 ) * 0.08, 0.08, 0.9 );
`

// After emissivemap_fragment (the view-space normal exists now): grid + sheen.
const EMISSIVE_MOD = /* glsl */ `
{
  float camDist = distance( vTerrainWorld, cameraPosition );
  float carDist = distance( vTerrainWorld.xz, uCarPos.xz );

  float minor = pristineGrid( vTerrainWorld.xz / 10.0, 0.022 );
  float major = pristineGrid( vTerrainWorld.xz / 50.0, 0.0085 );
  // Minor lines are gone well before the major ones.
  minor *= 1.0 - smoothstep( 160.0, 420.0, camDist );
  major *= 1.0 - smoothstep( 500.0, 1300.0, camDist );
  float lines = max( minor * 0.7, major );

  // T1 close to the car, T0 by 60 m (constitution: the grid is dim).
  float tier = mix( ${GLOW.T1.toFixed(3)}, ${GLOW.T0.toFixed(3)}, smoothstep( 12.0, 60.0, carDist ) );
  // Faint shimmer travelling through the grid, slow enough to read as life, not flicker.
  float pulse = 0.88 + 0.12 * sin( uTime * 0.6 - carDist * 0.035 );
  // A little less grid on steep faces, where xz lines would stretch.
  float flatness = smoothstep( 0.55, 0.85, normalize( vTerrainNormal ).y );
  totalEmissiveRadiance += uGridColor * lines * tier * pulse * mix( 0.45, 1.0, flatness );

  // Sheen: a violet rim at glancing angles. Stronger at night, when it carries the form.
  vec3 tViewDir = normalize( vViewPosition );
  float fres = pow( 1.0 - clamp( dot( normal, tViewDir ), 0.0, 1.0 ), 4.0 );
  totalEmissiveRadiance += uSheen * fres * mix( 0.35, 0.9, uNight ) * ( 0.75 + 0.5 * tVar );
}
`

// Before opaque_fragment: melt into the sky behind (linear space, same as the dome).
const HAZE_MOD = /* glsl */ `
{
  vec3 tToFrag = vTerrainWorld - cameraPosition;
  float tDist = length( tToFrag );
  vec3 tDir = tToFrag / max( tDist, 1e-3 );
  float fogF = 1.0 - exp( - uFogDensity * uFogDensity * tDist * tDist );
  // Valley haze: thick near the ground's base height, thinning upward.
  float lowHaze = exp( - max( vTerrainWorld.y - uHazeBase, 0.0 ) / 9.0 ) * ( 1.0 - exp( - tDist / 380.0 ) );
  float hazeAmt = clamp( fogF + lowHaze * 0.22, 0.0, 1.0 );
  outgoingLight = mix( outgoingLight, skyHazeColor( tDir ), hazeAmt );
}
`

/** Make the terrain material. Dispose it (and its noise texture) when done. */
export function makeTerrainMaterial(noise: THREE.Texture, gridHex: string, hazeBase: number): {
  material: THREE.MeshPhysicalMaterial
  uniforms: TerrainUniforms
} {
  const uniforms: TerrainUniforms = {
    uCarPos: { value: new THREE.Vector3() },
    uGridColor: { value: new THREE.Color(gridHex) },
    uNoise: { value: noise },
    uNight: { value: 0 },
    uSheen: { value: new THREE.Color(PALETTE.groundSheen) },
    uHazeBase: { value: hazeBase },
    uFogDensity: { value: FOG_DENSITY },
  }

  // Physical (not Standard) only for specularIntensity: dark glass reflects,
  // but at half the strength of clear glass, so the warm sky does not turn the
  // whole ground to bronze. No clearcoat or transmission: they cost too much.
  const material = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(PALETTE.ground),
    roughness: 0.38,
    metalness: 0.0,
    specularIntensity: 0.38,
    envMapIntensity: 0.8,
    // Our own haze replaces three's fog (it melts into the sky instead of a flat colour).
    fog: false,
  })

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, skyUniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_PARS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERTEX_MAIN}`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_PARS}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${COLOR_MOD}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${ROUGHNESS_MOD}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${EMISSIVE_MOD}`)
      .replace('#include <opaque_fragment>', `${HAZE_MOD}\n#include <opaque_fragment>`)
  }
  // One program for every terrain chunk, and a stable cache key.
  material.customProgramCacheKey = () => 'sr2-terrain-v1'

  return { material, uniforms }
}
