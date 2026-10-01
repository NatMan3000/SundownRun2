// ============================================================
//  TERRAIN MATERIAL - dark glass with a glowing grid
// ------------------------------------------------------------
//  A normal three.js MeshPhysicalMaterial (so it takes the real
//  lights and the shadow), with extra shader code stitched in
//  through onBeforeCompile. Dark glass barely scatters light, so
//  almost everything you see on it is light the glass reflects or
//  catches, and we paint that ourselves, where we can control it:
//
//   1. THE GRID. Neon lines every 10 m with brighter lines every
//      50 m, drawn with the "pristine grid" trick (Ben Golus):
//      lines keep a real width up close and fade to their average
//      brightness far away instead of shimmering. Glow tier T1 near
//      the car, T0 by 60 m, gone in the distance.
//   2. SKY FILL. Each slope picks up a little of the glowing sky
//      low over the horizon it faces: violet on the side away from
//      the sun, pink on the sun's side. Flat glass catches little,
//      slopes more; valley floors less and crests more (the relief
//      from terrainGeometry.ts), so the tone climbs up every hill.
//      This is what gives hills their shape, so no slope is ever a
//      black hole with lines on it, or one flat purple.
//   3. REFLECTION. The sky mirrored in the glass, strongest at
//      glancing angles (Fresnel), like a real window seen side-on.
//   4. THE SUN STREAK. The low sun stretched into one soft band
//      across the glass, pointing straight at you.
//   5. KEY RIM. Faces leaning toward the sun (the planet at night)
//      catch a warm (cool) edge when seen side-on, so you can tell
//      where the sun is even with your back to it. At night the
//      planet's light also lies on the glass as one soft glint.
//   6. SHEEN + VARIATION. A violet sheen at glancing angles, and
//      noise patterns (textures.ts) that vary how much the glass
//      catches and cut it into faint plates, so it is never one flat
//      tone. The noise only ever nudges (a tenth on the sky fill,
//      more on the violet sheen) and never touches the sun streak or
//      the warm rim: big swings of warm light read as orange mud.
//   7. HAZE. Instead of three's flat fog colour, far ground melts
//      into the exact colour of the sky behind it, plus a low haze
//      that settles in the valleys.
//
//  The physical material's own reflections are switched off
//  (specularIntensity 0): a broad sun highlight through the noise is
//  what painted the old orange blotches, and the painted terms above
//  are the same sky, minus the mud.
// ============================================================

import * as THREE from 'three'
import { GLOW, PALETTE } from '../core/palette'
import { SKY_GLSL } from './skyGlsl'
import { skyUniforms } from './sky'

/** How much of the sky each slope catches (sky fill). */
const FILL = 0.36
/** How strongly the glass mirrors the sky (times the Fresnel term). */
const REFLECT = 0.3
/** The sun streak's strength: well under the road's edge strips, which stay the brightest lines. */
const STREAK = 1.2
/** Key-light rim on side-on faces leaning toward the light, and the soft wash on faces turned toward it. */
const RIM = 0.4
const WASH = 0.022
/** The violet sheen at glancing angles (the palette's sheen colour is very dark, so it is boosted). */
const SHEEN = 2.2
/** The planet-light glint on the glass at night. */
const GLINT = 1.3

export interface TerrainUniforms {
  uCarPos: { value: THREE.Vector3 }
  uGridColor: { value: THREE.Color }
  uNoise: { value: THREE.Texture }
  uNight: { value: number }
  uSheen: { value: THREE.Color }
  uHazeBase: { value: number }
  uHazeTop: { value: number }
}

const VERTEX_PARS = /* glsl */ `
attribute float aRelief;
varying vec3 vTerrainWorld;
varying vec3 vTerrainNormal;
varying float vTerrainRelief;
`
const VERTEX_MAIN = /* glsl */ `
vTerrainWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
vTerrainNormal = normalize( mat3( modelMatrix ) * objectNormal );
vTerrainRelief = aRelief;
`

const FRAGMENT_PARS = /* glsl */ `
${SKY_GLSL}
varying vec3 vTerrainWorld;
varying vec3 vTerrainNormal;
varying float vTerrainRelief;
uniform vec3 uCarPos;
uniform vec3 uGridColor;
uniform sampler2D uNoise;
uniform float uNight;
uniform vec3 uSheen;
uniform float uHazeBase;
uniform float uHazeTop;
uniform float uFogDensity;
uniform vec3 uKeyDir;
uniform vec3 uKeyColor;
uniform vec3 uSunStreak;
uniform vec3 uSkyFill;
uniform vec3 uRimColor;

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

// After color_fragment: read the noise once (the glass colour itself stays the palette's).
const COLOR_MOD = /* glsl */ `
vec4 tNoiseBig = texture2D( uNoise, vTerrainWorld.xz / 520.0 );
vec4 tNoiseMid = texture2D( uNoise, vTerrainWorld.xz / 96.0 + 0.37 );
float tPlate = texture2D( uNoise, vTerrainWorld.xz / 64.0 ).a;
float tVar = tNoiseBig.r * 0.6 + tNoiseMid.g * 0.4;
`

// After emissivemap_fragment: everything the glass shows, painted as light.
const EMISSIVE_MOD = /* glsl */ `
{
  float camDist = distance( vTerrainWorld, cameraPosition );
  float carDist = distance( vTerrainWorld.xz, uCarPos.xz );
  vec3 tN = normalize( vTerrainNormal );
  vec3 tV = normalize( cameraPosition - vTerrainWorld );
  float nv = clamp( dot( tN, tV ), 0.0, 1.0 );

  // ---- 1. the grid ----
  // Lines 14 cm (minor) and 20 cm (major) wide: fine neon threads, not bands.
  float minor = pristineGrid( vTerrainWorld.xz / 10.0, 0.014 );
  float major = pristineGrid( vTerrainWorld.xz / 50.0, 0.004 );
  // Minor lines are gone well before the major ones, which run on toward the
  // horizon (the classic synthwave floor) until the haze takes them.
  minor *= 1.0 - smoothstep( 160.0, 420.0, camDist );
  major *= 1.0 - smoothstep( 1200.0, 2600.0, camDist );
  // On steep far faces (the edge ridge) the grid goes early: mountains, not a wire curtain.
  float flatness = smoothstep( 0.55, 0.85, tN.y );
  float steepFar = ( 1.0 - flatness ) * smoothstep( 300.0, 650.0, camDist );
  minor *= 1.0 - steepFar;
  major *= 1.0 - steepFar * 0.9;
  float lines = max( minor * 0.7, major );
  // T1 close to the car, T0 by 60 m (constitution: the grid is dim).
  float tier = mix( ${GLOW.T1.toFixed(3)}, ${GLOW.T0.toFixed(3)}, smoothstep( 12.0, 60.0, carDist ) );
  // Faint shimmer travelling through the grid, slow enough to read as life, not flicker.
  float pulse = 0.88 + 0.12 * sin( uTime * 0.6 - carDist * 0.035 );
  // A little less grid on steep faces, where xz lines would stretch.
  totalEmissiveRadiance += uGridColor * lines * tier * pulse * mix( 0.3, 1.0, flatness );

  // ---- 2. sky fill: each slope catches the sky low over the horizon it faces ----
  // The zenith is nearly black at sundown; the light that shapes a hill is the
  // glowing band low down. Its colour here is a cheap two-colour stand-in for
  // the full sky (skyColor() is the dearest thing in this shader): the violet
  // horizon away from the sun, pink-and-glow toward it, mostly mixed with the
  // sky's average so the warm side never turns hot.
  float steep = length( tN.xz );
  vec3 faceDir = vec3( tN.x, 0.0, tN.z ) / max( steep, 1e-4 );
  float faceSun = skySunward( faceDir );
  vec2 faceSunDirH = uSunDir.xz / max( length( uSunDir.xz ), 1e-4 );
  vec3 coolSide = uSkyHorizonAnti;
  vec3 warmSide = mix( uSkyHorizon, uSkyMid, 0.5 ) + uSkySunGlow * 0.12;
  vec3 faceSky = mix( mix( coolSide, warmSide, faceSun * faceSun ), uSkyFill, 0.6 );
  vec3 fillCol = mix( uSkyFill, faceSky, smoothstep( 0.03, 0.3, steep ) );
  // How much it catches: little on flat glass, more the steeper the slope;
  // and less when looked straight down on (an aerial view stays dark glass,
  // not lifted, muddy ground), full strength from moderate angles on, which is
  // where hillsides are seen. At grazing angles the reflection takes over.
  float viewCatch = 0.4 + 0.6 * smoothstep( 0.0, 0.65, 1.0 - nv );
  float catchAmt = ( 0.12 + 0.88 * smoothstep( 0.04, 0.32, steep ) ) * viewCatch;
  // Form, so a hillside is never one even tone (smooth, no noise):
  //  - relief (terrainGeometry.ts: metres above the ground around it): valley
  //    floors sit in the shade of their own slopes and catch less sky, crests
  //    catch more, so the tone climbs up every hill;
  //  - on the side away from the sun the light comes from the bright band
  //    opposite it, so faces turned toward that band are lit and faces turned
  //    sideways fall off, which shades a curved hill across its surface.
  float reliefLift = smoothstep( -9.0, 9.0, vTerrainRelief );
  vec3 antiDir = normalize( vec3( -faceSunDirH.x, 0.45, -faceSunDirH.y ) );
  float bandLight = mix( 0.55, 1.3, smoothstep( -0.15, 0.95, dot( tN, antiDir ) ) );
  catchAmt *= mix( 0.45, 1.45, reliefLift ) * mix( bandLight, 1.0, faceSun * faceSun );
  // A faint drift of tone through the glass, a tenth either way: too gentle to
  // read as blotches (the old mud was a swing of over half, on warm light).
  totalEmissiveRadiance += fillCol * catchAmt * ${FILL.toFixed(3)} * ( 0.9 + 0.2 * tVar );

  // ---- 3. the sky mirrored in the glass, strongest seen side-on ----
  vec3 tR = reflect( -tV, tN );
  float fres = 0.04 + 0.96 * pow( 1.0 - nv, 5.0 );
  // The glass is not a perfect mirror: a rough reflection averages a wide patch
  // of sky, mostly the darker sky above the glowing horizon band. Looking a
  // little above the mirror direction stands in for that blur (and rays
  // reflected below the horizon would only see far ground anyway).
  vec3 reflDir = normalize( vec3( tR.x, max( tR.y, 0.0 ) + 0.14, tR.z ) );
  totalEmissiveRadiance += skyColor( reflDir ) * fres * ${REFLECT.toFixed(3)};

  // ---- 4. the sun's one soft streak ----
  // Narrow across (the reflected ray must point at the sun's compass
  // direction), long along (it may pass well below or above the sun), so it
  // stretches over the glass straight toward the eye. No noise in it.
  vec2 rH = tR.xz / max( length( tR.xz ), 1e-4 );
  vec2 sH = uSunDir.xz / max( length( uSunDir.xz ), 1e-4 );
  float across = 1.0 - dot( rH, sH );
  float along = tR.y - max( uSunDir.y, 0.0 );
  float streak = exp( -across * 600.0 ) * exp( -along * along * 14.0 ) * step( 0.0, tR.y + 0.02 );
  // Only seen side-on (Fresnel): from above, mounds facing the sun stay dark glass.
  totalEmissiveRadiance += uSunStreak * streak * fres * ${STREAK.toFixed(3)};

  // ---- 5. key rim: faces leaning toward the sun (planet at night) light up side-on ----
  // Only real slopes (not every little ripple) and only well side-on, so it
  // reads as a lit edge, not a smear.
  vec2 kH = uKeyDir.xz / max( length( uKeyDir.xz ), 1e-4 );
  float lean = smoothstep( 0.12, 0.5, dot( tN.xz, kH ) );
  float sideOn = pow( 1.0 - nv, 4.0 );
  totalEmissiveRadiance += uRimColor * lean * sideOn * ${RIM.toFixed(3)};
  // At night, the planet's light lies on the glass as one broad soft glint
  // (moonlight on still water). No noise in it. At sundown the sun streak
  // above does this job, so the glint fades in with the night.
  float glint = pow( max( dot( tR, uKeyDir ), 0.0 ), 10.0 ) * ( 0.3 + 0.7 * fres );
  totalEmissiveRadiance += uKeyColor * glint * uNight * ${GLINT.toFixed(3)};
  // Plus a faint wash on faces turned toward it, so the sun's side of every hill reads warmer.
  float wash = smoothstep( -0.1, 0.9, dot( tN, uKeyDir ) );
  totalEmissiveRadiance += uKeyColor * wash * viewCatch * ${WASH.toFixed(3)};

  // ---- 6. violet sheen at glancing angles, stronger at night when it carries the form ----
  // (plus a faint floor of it everywhere: the glass's own violet, even looked straight down on)
  float sheen = 0.06 + pow( 1.0 - nv, 4.0 );
  // Boosted at sundown (the sky is bright, the palette sheen is dark); back to
  // the plain sheen at night, so the night ground stays dark glass.
  totalEmissiveRadiance += uSheen * sheen * mix( ${SHEEN.toFixed(3)}, 1.0, uNight ) * ( 0.7 + 0.5 * tVar + 0.25 * tPlate ) * mix( 0.7, 1.15, reliefLift );
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
  // Far high ground (the ridge at the world's edge) melts into the sky behind
  // its crest, so the skyline never has a hard top edge.
  // Only where the crest is seen against the sky (looking out, not down on it).
  float againstSky = smoothstep( -0.12, -0.02, tDir.y );
  float crest = smoothstep( mix( uHazeBase, uHazeTop, 0.3 ), uHazeTop, vTerrainWorld.y ) * smoothstep( 250.0, 900.0, tDist ) * againstSky;
  // Dark glass keeps more of its own darkness than open air would: lighter fog,
  // and only the crest dissolves into the sky (no flat haze fill on the faces).
  float hazeAmt = clamp( fogF * 0.6 + lowHaze * 0.22 + crest * 0.4, 0.0, 1.0 );
  // The colour of the sky right behind this point (just above the horizon at most).
  vec3 hazeDir = normalize( vec3( tDir.x, max( tDir.y, -0.02 ), tDir.z ) );
  // Looking down through the haze onto dark ground, far less light scatters in:
  // the haze darkens the steeper you look down (no pink "bathtub" from above).
  vec3 hazeCol = skyColor( hazeDir ) * mix( 0.4, 1.0, againstSky );
  outgoingLight = mix( outgoingLight, hazeCol, hazeAmt );
}
`

/** Make the terrain material. Dispose it (and its noise texture) when done. */
export function makeTerrainMaterial(noise: THREE.Texture, gridHex: string, hazeBase: number, hazeTop: number): {
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
    uHazeTop: { value: Math.max(hazeTop, hazeBase + 1) },
  }

  // Physical (not Standard) only for specularIntensity: at 0 the material's
  // own highlight and environment reflection are off (the shader paints the
  // glass's reflections itself, see the header). No clearcoat or transmission.
  const material = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(PALETTE.ground),
    roughness: 0.6,
    metalness: 0.0,
    specularIntensity: 0,
    envMapIntensity: 0,
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
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${EMISSIVE_MOD}`)
      .replace('#include <opaque_fragment>', `${HAZE_MOD}\n#include <opaque_fragment>`)
  }
  // One program for every terrain chunk, and a stable cache key.
  material.customProgramCacheKey = () => 'sr2-terrain-v6'

  return { material, uniforms }
}
