// ============================================================
//  SKY DOME + THE SYNTHWAVE SUN
// ------------------------------------------------------------
//  One big inside-out sphere that rides with the camera, painted
//  first, writing no depth. Everything is worked out per pixel:
//
//    1. the sky gradient (skyGlsl.ts: sundown to night, warm only
//       toward the sun, a haze band on the horizon);
//    2. the giant striped sun: a disc with a yellow -> orange ->
//       pink gradient and horizontal cut bands that widen toward
//       the bottom, drifting slowly downward. The bands are holes,
//       so the sky shows through them. The disc is HDR (glow tier
//       T2), which is what makes the bloom pick it up as the hero;
//    3. a soft halo around the sun, inside the sky itself;
//    4. thin streaks of cloud low over the horizon, backlit warm
//       near the sun and violet away from it (they cross in front
//       of the sun, the classic sunset look), lit from below by the
//       city at night.
//
//  The sun is drawn with a "gnomonic" projection (project the view
//  ray onto a flat card facing us) so it stays perfectly round and
//  its stripes stay perfectly horizontal wherever you look from.
//
//  One draw call, a few thousand triangles, nothing per frame but
//  uniform updates.
// ============================================================

import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { GLOW, PALETTE } from '../core/palette'
import { SKY_GLSL } from './skyGlsl'
import { SUN_RADIUS_DEG, sky, skyUniforms } from './sky'
import { worldStats } from './stats'
import { makeNoiseTexture } from './textures'

const vertexShader = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`

const fragmentShader = /* glsl */ `
${SKY_GLSL}
uniform vec3 uSunRight;
uniform vec3 uSunUp;
uniform float uSunTan;
uniform vec3 uSunTop;
uniform vec3 uSunMid;
uniform vec3 uSunBottom;
uniform vec3 uSunHalo;
uniform sampler2D uCloudNoise;
uniform vec3 uCloudLit;
uniform vec3 uCloudDark;
varying vec3 vDir;

// Thin streaks of cloud lying low over the horizon: backlit warm on the sun
// side, dusky violet away from it. They drift very slowly.
vec4 cloudLayer( vec3 d ) {
  float el = d.y;
  float band = smoothstep( 0.012, 0.06, el ) * ( 1.0 - smoothstep( 0.12, 0.3, el ) );
  // Azimuth as 0..1 around the compass. It jumps where the angle wraps, so
  // the texture's mip level comes from explicit gradients taken from whichever
  // of two copies (seams on opposite sides) is smooth at this pixel.
  // All of it comes BEFORE the early return: a derivative after a return only
  // some pixels of a 2x2 block make is undefined (garbage on Windows GPUs).
  // (Straight up, atan(0, 0) has no answer, so nudge z there.)
  float a = atan( d.x, -d.z + step( abs( d.x ) + abs( d.z ), 0.0 ) ) * 0.15915494;
  float b = fract( a + 1.0 );
  float dax = dFdx( a );
  float day = dFdy( a );
  float dbx = dFdx( b );
  float dby = dFdy( b );
  vec2 du = vec2( abs( dax ) < abs( dbx ) ? dax : dbx, abs( day ) < abs( dby ) ? day : dby );
  vec2 dv = vec2( dFdx( el ), dFdy( el ) );
  if ( band <= 0.0 ) return vec4( 0.0 );
  // Soft streaks: the gradients are scaled up, which blurs (a higher mip).
  vec2 s1 = vec2( 3.0, 6.0 ) * 2.6;
  vec2 s2 = vec2( 7.0, 14.0 ) * 2.0;
  vec2 uv1 = vec2( a * 3.0 + uTime * 0.0011, el * 6.0 );
  vec2 uv2 = vec2( a * 7.0 - uTime * 0.0007 + 0.37, el * 14.0 + 0.11 );
  float n = textureGrad( uCloudNoise, uv1, vec2( du.x, dv.x ) * s1, vec2( du.y, dv.y ) * s1 ).g * 0.6
          + textureGrad( uCloudNoise, uv2, vec2( du.x, dv.x ) * s2, vec2( du.y, dv.y ) * s2 ).r * 0.4;
  float cover = smoothstep( 0.48, 0.78, n ) * band;
  float sunward = skySunward( d );
  float cosA = max( dot( d, uSunDir ), 0.0 );
  float lit = clamp( sunward * sunward * 0.75 + pow( cosA, 14.0 ) * 0.9, 0.0, 1.0 );
  vec3 c = mix( uCloudDark, uCloudLit, lit );
  // City glow from below at night, toward the skyline.
  vec2 h = d.xz;
  float hl = length( h );
  float cityFacing = hl > 1e-5 ? dot( h / hl, uCityDir ) : 0.0;
  c += uCityGlow * smoothstep( uCityCos - 0.1, uCityCos + 0.3, cityFacing );
  return vec4( c, cover * 0.88 );
}

void main() {
  vec3 d = normalize( vDir );
  vec3 col = skyColor( d );

  float c = dot( d, uSunDir );
  // The sun's card position and every screen derivative the disc needs are
  // worked out for EVERY pixel, before the if() below: a derivative inside a
  // branch only some pixels of a 2x2 block take is undefined, and Windows
  // (Direct3D) GPUs can return garbage there: sun-coloured dots on the ring
  // where the branch starts (a suspect in GitHub issue #2). max() keeps d / c
  // finite away from the sun.
  // Project onto a card facing us: q is -1..1 across the disc.
  vec3 p = d / max( c, 0.1 ) - uSunDir;
  vec2 q = vec2( dot( p, uSunRight ), dot( p, uSunUp ) ) / uSunTan;
  float r = length( q );
  float aa = fwidth( r ) * 1.2;
  float bandW = fwidth( q.y / 0.13 ) * 0.75;   // 0.13 = the cut bands' period below
  float hw = fwidth( d.y ) * 0.75;
  if ( c > 0.6 && uSunVisible > 0.0 ) {

    // The halo: a soft warm bloom just outside the rim (sky-level, no HDR).
    float outside = max( r - 1.0, 0.0 );
    col += uSunHalo * ( exp( -outside * 7.0 ) * 0.3 + exp( -outside * 1.8 ) * 0.1 ) * uSunVisible;

    // The disc, antialiased with screen-space derivatives (aa, above).
    float disc = 1.0 - smoothstep( 1.0 - aa, 1.0 + aa * 0.5, r );

    // The cut bands: holes that start thin just above the middle and widen
    // toward the bottom. They drift slowly downward, growing as they go.
    float y = q.y;
    float period = 0.13;
    float ph = fract( ( y + uTime * 0.016 ) / period );
    float g = clamp( ( 0.85 - y ) / 1.85, 0.0, 1.0 );
    float gapHalf = ( g * 0.75 + g * g * 0.25 ) * 0.5;
    float w = bandW;
    float cut = 1.0 - smoothstep( gapHalf - w, gapHalf + w, abs( ph - 0.5 ) );
    cut *= smoothstep( 0.0, 0.03, gapHalf );
    disc *= 1.0 - cut;

    // Top to bottom: yellow -> orange -> pink.
    vec3 sunCol = mix( uSunBottom, uSunMid, smoothstep( -0.2, 0.45, y ) );
    sunCol = mix( sunCol, uSunTop, smoothstep( 0.45, 0.95, y ) );

    // Nothing of the disc below the horizon line (hw, above).
    float above = smoothstep( -hw, hw, d.y );
    col = mix( col, sunCol, disc * above * uSunVisible );
  }

  vec4 cl = cloudLayer( d );
  col = mix( col, cl.rgb, cl.a );

  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

/** Radius of the dome. Inside the camera's far plane (6000 m), outside everything else. */
const DOME_RADIUS = 5200

let sharedCloudNoise: THREE.Texture | null = null
/** One cloud texture for every sky material (made on first use, lives with the page). */
function cloudNoise(): THREE.Texture {
  if (!sharedCloudNoise) sharedCloudNoise = makeNoiseTexture(0xc10d)
  return sharedCloudNoise
}

/** The sky + sun material. The dome uses one; skyEnv.ts makes another for reflections. */
export function makeSkyMaterial(): THREE.ShaderMaterial {
  // Glow tier T2 (the sun is a hero), brightest at the top. Kept at the low end
  // of the tier so tone mapping keeps the yellow -> pink gradient instead of
  // washing the disc to white; only the yellow top crosses the bloom line.
  const sunTop = new THREE.Color(PALETTE.sunTop).multiplyScalar(GLOW.T2 * 0.48)
  const sunMid = new THREE.Color(PALETTE.sunMid).multiplyScalar(GLOW.T2 * 0.38)
  const sunBottom = new THREE.Color(PALETTE.sunBottom).multiplyScalar(GLOW.T2 * 0.36)
  return new THREE.ShaderMaterial({
    uniforms: {
      ...skyUniforms,
      uSunRight: { value: sky.sunRight },
      uSunUp: { value: sky.sunUp },
      uSunTan: { value: Math.tan((SUN_RADIUS_DEG * Math.PI) / 180) },
      uSunTop: { value: sunTop },
      uSunMid: { value: sunMid },
      uSunBottom: { value: sunBottom },
      uSunHalo: { value: new THREE.Color(PALETTE.skySunGlow).lerp(new THREE.Color(PALETTE.sunBottom), 0.35) },
      uCloudNoise: { value: cloudNoise() },
    },
    vertexShader,
    fragmentShader,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  })
}

export function SkyDome() {
  const ref = useRef<THREE.Mesh>(null)

  const material = useMemo(() => makeSkyMaterial(), [])

  const geometry = useMemo(() => {
    const g = new THREE.SphereGeometry(1, 64, 40)
    worldStats.skyTriangles = (g.index ? g.index.count : 0) / 3
    return g
  }, [])

  useEffect(
    () => () => {
      material.dispose()
      geometry.dispose()
    },
    [material, geometry],
  )

  useFrame((state) => {
    const mesh = ref.current
    if (!mesh) return
    mesh.position.copy(state.camera.position)
  })

  return (
    <mesh
      ref={ref}
      geometry={geometry}
      material={material}
      scale={DOME_RADIUS}
      name="world-sky"
      renderOrder={-1000}
      frustumCulled={false}
    />
  )
}
