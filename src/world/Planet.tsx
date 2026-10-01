// ============================================================
//  PLANET - the big ringed planet that rises into the night
// ------------------------------------------------------------
//  A banded gas giant and its tilted ring, hanging in the sky
//  where the track file puts it (sky.planetAzimuthDeg and
//  planetElevationDeg). Like the sky dome it rides with the camera,
//  so it is always the same size and never gets closer.
//
//  HOW IT IS DRAWN. Not as a real 3D sphere: a camera's lens
//  stretches anything near the edge of the picture, and a big
//  sphere there turns into an egg. Instead the planet is one flat
//  square (an "impostor") that always faces the screen, and the
//  shader works out, for every pixel, what a ray looking at the
//  planet would hit: the ball, the ring, or empty sky. A circle
//  painted on a card facing the screen stays a circle anywhere in
//  the frame. The ray tracing also tells us, exactly, where the
//  ring passes in front of the ball and where it hides behind it.
//
//  THE RING leans toward you by a fixed angle measured from YOUR
//  line of sight (RING_OPEN_DEG), so it always opens into a clear
//  ellipse, however high the track puts the planet. (It used to
//  lean by a fixed angle from straight up, and at a planet height
//  of 16 degrees the two cancelled: the ring was edge-on, invisible.)
//
//  LIGHT comes from the set sun (raised a little, so the lit side
//  faces the world rather than the floor). Two shadows are worked
//  out per pixel with a little geometry: the planet's shadow
//  falling across the ring, and the ring's shadow lying across the
//  planet. That is what makes it read as one solid object.
//
//  It fades in from time of day 0.3 (with the stars). Glow tier
//  T0: it is scenery, never brighter than the road. One draw call,
//  two triangles. __dev.planetRing(false) hides the ring for A/B shots,
//  __dev.planetAt(az, el) tries a placement, and the world inspector's
//  `planet` entry says where it sits on screen.
// ============================================================

import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { GLOW, PALETTE } from '../core/palette'
import { registerDev } from '../core/devHandles'
import { dirFromAzEl, sky, skyUniforms } from './sky'
import { worldStats } from './stats'

const DEG = Math.PI / 180
/** Distance from the camera, metres (inside the stars, outside the city). */
const DISTANCE = 4000
/** Angular radius of the planet body, degrees. */
const RADIUS_DEG = 6.5
const RADIUS = DISTANCE * Math.tan(RADIUS_DEG * DEG)
/** Ring inner and outer edges, in planet radii. */
const RING_IN = 1.35
const RING_OUT = 2.35
/** How far the planet's axis leans sideways, seen from here, degrees (to the viewer's right). */
const TILT_DEG = 24
/** How far the ring plane opens toward you, degrees from edge-on (0 = edge-on, 90 = face-on). */
const RING_OPEN_DEG = 21
/** Half the impostor card's size: room for the whole ring when it is seen face-on. */
const HALF = RADIUS * RING_OUT * 1.04
/** The set sun's light on the planet comes from at most this far below the horizon (radians, as a sine). */
const LIGHT_MIN_Y = -0.28

const vertexShader = /* glsl */ `
varying vec2 vLocal;
void main() {
  vLocal = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`

const fragmentShader = /* glsl */ `
uniform vec3 uCenter;
uniform vec3 uForward;
uniform vec3 uRight;
uniform vec3 uUp;
uniform vec3 uAxis;
uniform vec3 uLight;
uniform float uRadius;
uniform float uHalf;
uniform float uFade;
uniform float uTime;
uniform vec3 uBody;
uniform vec3 uBandLight;
uniform vec3 uBandDark;
uniform vec3 uRim;
uniform vec3 uRingColor;
uniform float uRingOn;
varying vec2 vLocal;

// Ring density at r (in planet radii): bands, a dark gap, soft edges.
float ringDensity( float r ) {
  float d = 0.62 + 0.2 * sin( r * 41.0 ) + 0.14 * sin( r * 97.0 + 1.3 ) + 0.08 * sin( r * 211.0 + 0.4 );
  d *= smoothstep( ${RING_IN.toFixed(3)}, ${(RING_IN + 0.08).toFixed(3)}, r );
  d *= 1.0 - smoothstep( ${(RING_OUT - 0.12).toFixed(3)}, ${RING_OUT.toFixed(3)}, r );
  // The big gap two thirds of the way out.
  d *= 1.0 - 0.85 * ( 1.0 - smoothstep( 0.0, 0.035, abs( r - 1.93 ) ) );
  return clamp( d, 0.0, 1.0 );
}

void main() {
  // Where this pixel's ray passes the planet's centre plane (metres, across the line of sight).
  vec3 p = ( vLocal.x * uRight + vLocal.y * uUp ) * uHalf;
  float d = length( p ) / uRadius;

  // ---- the ball ----
  vec3 planetCol = vec3( 0.0 );
  float planetA = 0.0;
  float front = 0.0; // how far in front of the centre plane the ball's surface is, metres
  if ( d < 1.02 ) {
    float aa = fwidth( d ) * 1.2;
    planetA = 1.0 - smoothstep( 1.0 - aa, 1.0 + aa * 0.5, d );
    float z = sqrt( max( 1.0 - d * d, 0.0 ) ) * uRadius;
    front = z;
    vec3 n = normalize( p - uForward * z );
    vec3 surf = uCenter + p - uForward * z;

    // Bands of cloud along the planet's latitude, gently wavy.
    float lat = dot( n, uAxis );
    vec3 side = normalize( cross( uAxis, uForward ) );
    float lon = atan( dot( n, side ), dot( n, cross( uAxis, side ) ) );
    float wave = sin( lon * 3.0 + lat * 7.0 + uTime * 0.01 ) * 0.03;
    float b = smoothstep( -0.6, 0.6, sin( ( lat + wave ) * 9.0 + 0.6 ) );
    float b2 = sin( ( lat - wave * 0.6 ) * 31.0 + 1.7 ) * 0.5 + 0.5;
    vec3 col = mix( uBandDark, uBody, b );
    col = mix( col, uBandLight, smoothstep( 0.7, 1.0, b2 ) * 0.25 * b );

    // Lit by the set sun, with a soft terminator; the dark side keeps a little light.
    float lit = smoothstep( -0.18, 0.55, dot( n, uLight ) );
    // The ring's shadow on the ball: follow the light from here to the ring plane.
    float denom = dot( uLight, uAxis );
    if ( abs( denom ) > 1e-3 ) {
      float t = dot( uCenter - surf, uAxis ) / denom;
      if ( t > 0.0 ) {
        float r = length( surf + uLight * t - uCenter ) / uRadius;
        lit *= 1.0 - 0.75 * ringDensity( r );
      }
    }
    planetCol = col * ( 0.1 + 0.9 * lit );
    // A thin atmosphere glowing at the rim, strongest on the lit side.
    float rim = pow( 1.0 - clamp( z / uRadius, 0.0, 1.0 ), 3.0 );
    planetCol += uRim * rim * ( 0.25 + 0.75 * lit );
  }

  // ---- the ring ----
  // Where the ray crosses the ring plane: s metres beyond the centre plane.
  float s = -dot( p, uAxis ) / dot( uForward, uAxis );
  vec3 rel = p + uForward * s;
  float rr = length( rel ) / uRadius;
  float density = ringDensity( rr ) * uRingOn;
  vec3 ringCol = vec3( 0.0 );
  float ringA = 0.0;
  if ( density > 0.004 ) {
    // The planet's shadow on the ring: does the light from here hit the ball?
    float bq = dot( rel, uLight );
    float c = dot( rel, rel ) - uRadius * uRadius;
    float disc = bq * bq - c;
    float shadow = 0.0;
    if ( disc > 0.0 && -bq - sqrt( disc ) > 0.0 ) shadow = smoothstep( 0.0, uRadius * uRadius * 0.12, disc );
    // A thin ring of ice catches light on either face, and glows when the light is behind it.
    float lit = 0.4 + 0.6 * abs( dot( uAxis, uLight ) ) + 0.35 * pow( max( dot( uForward, uLight ), 0.0 ), 3.0 );
    lit *= 1.0 - 0.85 * shadow;
    ringCol = uRingColor * ( 0.2 + 0.8 * lit );
    ringA = density * 0.9;
  }

  // ---- put them together: whichever is nearer along the ray goes on top ----
  bool ringInFront = s < -front || planetA <= 0.0;
  vec3 col;
  float a;
  if ( ringInFront ) {
    a = ringA + planetA * ( 1.0 - ringA );
    col = ringCol * ringA + planetCol * planetA * ( 1.0 - ringA );
  } else {
    a = planetA + ringA * ( 1.0 - planetA );
    col = planetCol * planetA + ringCol * ringA * ( 1.0 - planetA );
  }
  if ( a < 0.003 ) discard;
  gl_FragColor = vec4( col / a, a * uFade );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

// The camera and canvas size of the last frame drawn, for planetInfo() (read on demand by checkers).
let lastCamera: THREE.Camera | null = null
const lastSize = { width: 1, height: 1 }
let lastOffAxis = 1

/**
 * Where the planet is, for checkers (window.__game.get('world').planet): its
 * direction, the camera's heading, and the box the ball and ring cover on
 * screen, in canvas pixels [left, top, right, bottom]. Worked out only when
 * asked (it allocates a little, which is fine outside the frame loop).
 */
export function planetInfo(uniforms: PlanetUniforms | null): Record<string, unknown> {
  const out: Record<string, unknown> = {
    azimuthDeg: +(sky.planetAzimuth / DEG).toFixed(1),
    elevationDeg: +(sky.planetElevation / DEG).toFixed(1),
    sunAzimuthDeg: +(sky.sunAzimuth / DEG).toFixed(1),
    fade: +sky.nightSky.toFixed(3),
  }
  const cam = lastCamera
  if (!cam || !uniforms) return out
  const f = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 2).negate()
  out.viewAzimuthDeg = +((Math.atan2(f.x, -f.z) / DEG + 360) % 360).toFixed(1)
  out.viewElevationDeg = +(Math.asin(Math.max(-1, Math.min(1, f.y))) / DEG).toFixed(1)
  const camRight = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0)
  const camUp = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1)
  const u = uniforms
  const axis = u.uAxis.value
  const e1 = new THREE.Vector3().crossVectors(axis, u.uForward.value).normalize()
  const e2 = new THREE.Vector3().crossVectors(axis, e1).normalize()
  const v = new THREE.Vector3()
  const rel = new THREE.Vector3()
  const box = [Infinity, Infinity, -Infinity, -Infinity]
  const add = (px: number, py: number) => {
    v.copy(u.uCenter.value).addScaledVector(camRight, px * lastOffAxis).addScaledVector(camUp, py * lastOffAxis).project(cam)
    const x = ((v.x + 1) / 2) * lastSize.width
    const y = ((1 - v.y) / 2) * lastSize.height
    box[0] = Math.min(box[0], x)
    box[1] = Math.min(box[1], y)
    box[2] = Math.max(box[2], x)
    box[3] = Math.max(box[3], y)
  }
  for (let i = 0; i < 48; i++) {
    const t = (i / 48) * Math.PI * 2
    add(Math.cos(t) * RADIUS, Math.sin(t) * RADIUS)
    rel.copy(e1).multiplyScalar(Math.cos(t) * RADIUS * RING_OUT).addScaledVector(e2, Math.sin(t) * RADIUS * RING_OUT)
    add(rel.dot(u.uRight.value), rel.dot(u.uUp.value))
  }
  out.screenBox = box.map((n) => Math.round(n))
  out.canvas = [lastSize.width, lastSize.height]
  return out
}

interface PlanetUniforms {
  uCenter: { value: THREE.Vector3 }
  uForward: { value: THREE.Vector3 }
  uRight: { value: THREE.Vector3 }
  uUp: { value: THREE.Vector3 }
  uAxis: { value: THREE.Vector3 }
}

/** The live planet's uniforms (set while a Planet is mounted), for planetInfo(). */
export const planetLive: { uniforms: PlanetUniforms | null } = { uniforms: null }

// scratch (module-level: no allocation per frame)
const _dir = new THREE.Vector3()
const _camRight = new THREE.Vector3()
const _camForward = new THREE.Vector3()
const _worldUp = new THREE.Vector3(0, 1, 0)
const _upPerp = new THREE.Vector3()

export function Planet() {
  const ref = useRef<THREE.Mesh>(null)

  const { material, geometry, uniforms } = useMemo(() => {
    const t0 = GLOW.T0
    const uniforms = {
      uCenter: { value: new THREE.Vector3() },
      uForward: { value: new THREE.Vector3(0, 0, -1) },
      uRight: { value: new THREE.Vector3(1, 0, 0) },
      uUp: { value: new THREE.Vector3(0, 1, 0) },
      uAxis: { value: new THREE.Vector3(0, 1, 0) },
      uLight: { value: new THREE.Vector3(0, 1, 0) },
      uRadius: { value: RADIUS },
      uHalf: { value: HALF },
      uFade: { value: 0 },
      uTime: skyUniforms.uTime,
      uBody: { value: new THREE.Color(PALETTE.planet).multiplyScalar(t0) },
      uBandLight: { value: new THREE.Color(PALETTE.planetRing).multiplyScalar(t0 * 0.8) },
      uBandDark: { value: new THREE.Color(PALETTE.planet).lerp(new THREE.Color(PALETTE.skyMidNight), 0.55).multiplyScalar(t0) },
      uRim: { value: new THREE.Color(PALETTE.planetRing).multiplyScalar(t0 * 0.7) },
      uRingColor: { value: new THREE.Color(PALETTE.planetRing).multiplyScalar(t0 * 0.95) },
      uRingOn: { value: 1 },
    }
    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      fog: false,
    })
    const geometry = new THREE.PlaneGeometry(2, 2)
    return { material, geometry, uniforms }
  }, [])

  // Checkers: __dev.planetRing(false) hides the ring (true shows it) to compare
  // frames; __dev.planetAt(az, el) moves the planet for this session (to try a
  // placement before writing it into a track file; the night key light moves with it).
  useEffect(() => {
    planetLive.uniforms = uniforms
    const offRing = registerDev(
      'planetRing',
      (on: boolean = true) => {
        uniforms.uRingOn.value = on ? 1 : 0
        return on ? 'ring shown' : 'ring hidden'
      },
      'planetRing(on = true) - show or hide the planet ring (to compare frames)',
    )
    const offAt = registerDev(
      'planetAt',
      (azimuthDeg?: number, elevationDeg?: number) => {
        if (typeof azimuthDeg === 'number' && Number.isFinite(azimuthDeg)) sky.planetAzimuth = azimuthDeg * DEG
        if (typeof elevationDeg === 'number' && Number.isFinite(elevationDeg)) sky.planetElevation = elevationDeg * DEG
        return { azimuthDeg: +(sky.planetAzimuth / DEG).toFixed(1), elevationDeg: +(sky.planetElevation / DEG).toFixed(1) }
      },
      'planetAt(azimuthDeg?, elevationDeg?) - move the planet for this session (compass degrees); no arguments reports where it is',
    )
    return () => {
      if (planetLive.uniforms === uniforms) planetLive.uniforms = null
      offRing()
      offAt()
    }
  }, [uniforms])

  useEffect(() => {
    worldStats.planetTriangles = (geometry.index?.count ?? 0) / 3
    return () => {
      material.dispose()
      geometry.dispose()
    }
  }, [material, geometry])

  useFrame((state) => {
    const mesh = ref.current
    if (!mesh) return
    const fade = sky.nightSky
    uniforms.uFade.value = fade
    mesh.visible = fade > 0.002
    if (!mesh.visible) return
    const cam = state.camera

    // Where it hangs: a track-fixed direction, always DISTANCE from the camera.
    dirFromAzEl(sky.planetAzimuth, sky.planetElevation, _dir)
    uniforms.uCenter.value.copy(cam.position).addScaledVector(_dir, DISTANCE)
    uniforms.uForward.value.copy(_dir)

    // The card faces the screen. Its "across" axes are the camera's right and
    // up, squared off against the line of sight, so camera roll tilts the
    // planet the way it tilts everything else.
    _camRight.setFromMatrixColumn(cam.matrixWorld, 0)
    const right = uniforms.uRight.value.copy(_camRight).addScaledVector(_dir, -_camRight.dot(_dir)).normalize()
    uniforms.uUp.value.crossVectors(right, _dir).normalize()

    // The planet's axis: world up seen across the line of sight, leaned
    // sideways by TILT, then toward the viewer by RING_OPEN (so the ring
    // always opens by that much, whatever the planet's height).
    _upPerp.copy(_worldUp).addScaledVector(_dir, -_worldUp.dot(_dir)).normalize().applyAxisAngle(_dir, -TILT_DEG * DEG)
    uniforms.uAxis.value
      .copy(_upPerp)
      .multiplyScalar(Math.cos(RING_OPEN_DEG * DEG))
      .addScaledVector(_dir, -Math.sin(RING_OPEN_DEG * DEG))
      .normalize()

    // The set sun lights it, from no lower than LIGHT_MIN_Y.
    const light = uniforms.uLight.value.copy(sky.sunDir)
    light.y = Math.max(light.y, LIGHT_MIN_Y)
    light.normalize()

    // Card placement: centred on the planet, facing the screen. Scaled by how
    // far off the middle of the view it is, so it keeps the same size on screen
    // wherever it sits in the frame (a card farther off-axis is nearer the lens plane).
    _camForward.setFromMatrixColumn(cam.matrixWorld, 2).negate()
    const offAxis = Math.max(0.3, _camForward.dot(_dir))
    lastCamera = cam
    lastSize.width = state.size.width
    lastSize.height = state.size.height
    lastOffAxis = offAxis
    mesh.position.copy(uniforms.uCenter.value)
    mesh.quaternion.copy(cam.quaternion)
    mesh.scale.setScalar(HALF * offAxis)
  })

  return <mesh name="world-planet" ref={ref} geometry={geometry} material={material} frustumCulled={false} renderOrder={-980} />
}
