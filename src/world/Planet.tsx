// ============================================================
//  PLANET - the big ringed planet that rises into the night
// ------------------------------------------------------------
//  A banded gas giant and its tilted ring, hanging in the sky
//  where the track file puts it (sky.planetAzimuthDeg and
//  planetElevationDeg). Like the sky dome it rides with the camera,
//  so it is always the same size and never gets closer.
//
//  Both shaders are lit by the sun, which by night is below the
//  horizon - so the planet shows a glowing crescent on the side
//  facing the set sun, with its dark side just visible.
//
//  Two shadows are worked out exactly, per pixel, with a little
//  geometry (no shadow maps): the planet's shadow falling across
//  the ring, and the ring's shadow lying across the planet. That is
//  what makes it read as one solid object instead of two stickers.
//
//  It fades in from time of day 0.3 (with the stars). Glow tier
//  T0: it is scenery, never brighter than the road.
// ============================================================

import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { GLOW, PALETTE } from '../core/palette'
import { dirFromAzEl, sky, skyUniforms } from './sky'
import { worldStats } from './stats'

/** Distance from the camera, metres (inside the stars, outside the city). */
const DISTANCE = 4000
/** Angular radius of the planet body, degrees. */
const RADIUS_DEG = 6.5
const RADIUS = DISTANCE * Math.sin((RADIUS_DEG * Math.PI) / 180)
/** Ring inner and outer edges, in planet radii. */
const RING_IN = 1.35
const RING_OUT = 2.35
/** How far the planet's axis leans, degrees (toward the viewer's right). */
const TILT_DEG = 24
/** How open the ring looks: the axis leans toward the viewer by this much, degrees. */
const OPEN_DEG = 16

const SHARED_GLSL = /* glsl */ `
uniform vec3 uCenter;
uniform vec3 uAxis;
uniform float uRadius;
uniform float uFade;
uniform vec3 uSunDir;
uniform float uTime;
varying vec3 vWorld;

// Ring density at r (in planet radii): bands, a dark gap, soft edges.
float ringDensity( float r ) {
  float d = 0.55 + 0.22 * sin( r * 41.0 ) + 0.16 * sin( r * 97.0 + 1.3 ) + 0.1 * sin( r * 211.0 + 0.4 );
  d *= smoothstep( ${RING_IN.toFixed(3)}, ${(RING_IN + 0.08).toFixed(3)}, r );
  d *= 1.0 - smoothstep( ${(RING_OUT - 0.12).toFixed(3)}, ${RING_OUT.toFixed(3)}, r );
  // The big gap two thirds of the way out.
  d *= 1.0 - 0.85 * ( 1.0 - smoothstep( 0.0, 0.035, abs( r - 1.93 ) ) );
  return clamp( d, 0.0, 1.0 );
}
`

const vertexShader = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4( position, 1.0 );
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`

const planetFragment = /* glsl */ `
${SHARED_GLSL}
uniform vec3 uBody;
uniform vec3 uBandLight;
uniform vec3 uBandDark;
uniform vec3 uRim;

void main() {
  vec3 n = normalize( vWorld - uCenter );
  vec3 viewDir = normalize( cameraPosition - vWorld );

  // Bands of cloud along the planet's latitude, gently wavy.
  float lat = dot( n, uAxis );
  vec3 side = normalize( cross( uAxis, vec3( 0.0, 1.0, 0.0 ) ) + vec3( 1e-4 ) );
  float lon = atan( dot( n, side ), dot( n, cross( uAxis, side ) ) );
  float wave = sin( lon * 3.0 + lat * 7.0 + uTime * 0.01 ) * 0.03;
  // Broad bands, with a few finer ones riding on them.
  float b = smoothstep( -0.6, 0.6, sin( ( lat + wave ) * 9.0 + 0.6 ) );
  float b2 = sin( ( lat - wave * 0.6 ) * 31.0 + 1.7 ) * 0.5 + 0.5;
  vec3 col = mix( uBandDark, uBody, b );
  col = mix( col, uBandLight, smoothstep( 0.7, 1.0, b2 ) * 0.25 * b );

  // Lit by the (set) sun, with a soft terminator; the dark side keeps a little light.
  float lit = smoothstep( -0.18, 0.55, dot( n, uSunDir ) );

  // The ring's shadow on the planet: follow the light from here to the ring plane.
  float denom = dot( uSunDir, uAxis );
  if ( abs( denom ) > 1e-3 ) {
    float t = dot( uCenter - vWorld, uAxis ) / denom;
    if ( t > 0.0 ) {
      float r = length( vWorld + uSunDir * t - uCenter ) / uRadius;
      lit *= 1.0 - 0.8 * ringDensity( r );
    }
  }

  vec3 shade = col * ( 0.09 + 0.91 * lit );
  // A thin atmosphere glowing at the rim, strongest on the lit side.
  float rim = pow( 1.0 - clamp( dot( n, viewDir ), 0.0, 1.0 ), 3.0 );
  shade += uRim * rim * ( 0.25 + 0.75 * lit );

  gl_FragColor = vec4( shade, uFade );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

const ringFragment = /* glsl */ `
${SHARED_GLSL}
uniform vec3 uRingColor;

void main() {
  vec3 rel = vWorld - uCenter;
  float r = length( rel ) / uRadius;
  float density = ringDensity( r );
  if ( density < 0.01 ) discard;

  // The planet's shadow on the ring: does the light from here hit the planet?
  float b = dot( rel, uSunDir );
  float c = dot( rel, rel ) - uRadius * uRadius;
  float disc = b * b - c;
  float shadow = 0.0;
  if ( disc > 0.0 && -b - sqrt( disc ) > 0.0 ) shadow = smoothstep( 0.0, uRadius * uRadius * 0.08, disc );

  // A thin ring catches light on either face.
  float lit = ( 0.35 + 0.65 * abs( dot( uAxis, uSunDir ) ) ) * ( 1.0 - 0.85 * shadow );
  vec3 col = uRingColor * ( 0.22 + 0.78 * lit );
  gl_FragColor = vec4( col, density * 0.85 * uFade );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

// scratch
const _dir = new THREE.Vector3()
const _toward = new THREE.Vector3()
const _up = new THREE.Vector3(0, 1, 0)
const _q = new THREE.Quaternion()
const _zAxis = new THREE.Vector3(0, 0, 1)

export function Planet() {
  const planetRef = useRef<THREE.Mesh>(null)
  const ringRef = useRef<THREE.Mesh>(null)

  const uniforms = useMemo(
    () => ({
      uCenter: { value: new THREE.Vector3() },
      uAxis: { value: new THREE.Vector3(0, 1, 0) },
      uRadius: { value: RADIUS },
      uFade: { value: 0 },
      uSunDir: skyUniforms.uSunDir,
      uTime: skyUniforms.uTime,
    }),
    [],
  )

  const { planetMat, ringMat, sphere, ring } = useMemo(() => {
    const t0 = GLOW.T0
    const body = new THREE.Color(PALETTE.planet).multiplyScalar(t0)
    const planetMat = new THREE.ShaderMaterial({
      uniforms: {
        ...uniforms,
        uBody: { value: body },
        uBandLight: { value: new THREE.Color(PALETTE.planetRing).multiplyScalar(t0 * 0.8) },
        uBandDark: { value: new THREE.Color(PALETTE.planet).lerp(new THREE.Color(PALETTE.skyMidNight), 0.55).multiplyScalar(t0) },
        uRim: { value: new THREE.Color(PALETTE.planetRing).multiplyScalar(t0 * 0.7) },
      },
      vertexShader,
      fragmentShader: planetFragment,
      transparent: true,
      depthWrite: true,
      fog: false,
    })
    const ringMat = new THREE.ShaderMaterial({
      uniforms: {
        ...uniforms,
        uRingColor: { value: new THREE.Color(PALETTE.planetRing).multiplyScalar(t0 * 0.9) },
      },
      vertexShader,
      fragmentShader: ringFragment,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    })
    const sphere = new THREE.SphereGeometry(RADIUS, 64, 40)
    const ring = new THREE.RingGeometry(RADIUS * RING_IN, RADIUS * RING_OUT, 160, 1)
    return { planetMat, ringMat, sphere, ring }
  }, [uniforms])

  useEffect(() => {
    worldStats.planetTriangles = ((sphere.index?.count ?? 0) + (ring.index?.count ?? 0)) / 3
    return () => {
      planetMat.dispose()
      ringMat.dispose()
      sphere.dispose()
      ring.dispose()
    }
  }, [planetMat, ringMat, sphere, ring])

  useFrame((state) => {
    const planet = planetRef.current
    const ringMesh = ringRef.current
    if (!planet || !ringMesh) return
    const fade = sky.nightSky
    uniforms.uFade.value = fade
    planet.visible = fade > 0.002
    ringMesh.visible = fade > 0.002
    if (!planet.visible) return

    // Where it hangs: track-fixed direction, always DISTANCE from the camera.
    dirFromAzEl(sky.planetAzimuth, sky.planetElevation, _dir)
    const center = uniforms.uCenter.value.copy(state.camera.position).addScaledVector(_dir, DISTANCE)
    planet.position.copy(center)
    ringMesh.position.copy(center)

    // The planet's axis: world up, leaned sideways (tilt) and toward us (so the ring opens).
    _toward.copy(_dir).negate()
    const axis = uniforms.uAxis.value
      .copy(_up)
      .applyAxisAngle(_dir, (-TILT_DEG * Math.PI) / 180)
      .addScaledVector(_toward, Math.sin((OPEN_DEG * Math.PI) / 180))
      .normalize()
    // RingGeometry lies in the xy plane facing +z: turn +z onto the axis.
    _q.setFromUnitVectors(_zAxis, axis)
    ringMesh.quaternion.copy(_q)
  })

  return (
    <>
      <mesh ref={planetRef} geometry={sphere} material={planetMat} frustumCulled={false} renderOrder={-980} />
      <mesh ref={ringRef} geometry={ring} material={ringMat} frustumCulled={false} renderOrder={-979} />
    </>
  )
}
