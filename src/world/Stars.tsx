// ============================================================
//  STARS - the night sky's star field
// ------------------------------------------------------------
//  Thousands of stars in ONE draw call: a THREE.Points cloud on a
//  big sphere that rides with the camera (so the stars are "at
//  infinity" and never get closer as you drive).
//
//  Each star has its own size, brightness and twinkle rhythm. Most
//  are faint; a few are bright enough (glow tier T1) for the bloom
//  to give them a soft halo. They fade in from time of day 0.3,
//  thin out toward the horizon where the haze is thick, and twinkle
//  gently - a slow shimmer, never a flicker.
//
//  The star count follows the quality preset.
// ============================================================

import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { GLOW, PALETTE } from '../core/palette'
import type { QualityLevel } from '../core/settings'
import { makeRandom } from './textures'
import { sky, skyUniforms } from './sky'
import { worldStats } from './stats'

const COUNT: Record<QualityLevel, number> = { high: 4200, medium: 2600, low: 1300 }
/** Inside the sky dome (5200 m), outside the planet (4000 m) so the planet covers them. */
const RADIUS = 4600

const vertexShader = /* glsl */ `
attribute float aSize;
attribute float aBright;
attribute float aPhase;
uniform float uTime;
uniform float uFade;
varying float vBright;
varying float vTint;
void main() {
  vec3 dir = normalize( position );
  // Thin out toward the horizon, where the haze is thick.
  float clearSky = smoothstep( 0.03, 0.34, dir.y );
  // Gentle twinkle: each star on its own slow rhythm.
  float twinkle = 0.8 + 0.2 * sin( uTime * ( 0.9 + aPhase * 1.7 ) + aPhase * 37.0 );
  vBright = aBright * twinkle * clearSky * uFade;
  vTint = fract( aPhase * 7.31 );
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  gl_PointSize = vBright > 0.004 ? aSize : 0.0;
}
`

const fragmentShader = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uTintColor;
varying float vBright;
varying float vTint;
void main() {
  float d = length( gl_PointCoord - 0.5 ) * 2.0;
  float a = 1.0 - smoothstep( 0.0, 1.0, d );
  a *= a;
  // A few stars lean violet; the rest are the palette's cool white.
  vec3 c = mix( uColor, uTintColor, step( 0.82, vTint ) * 0.55 );
  gl_FragColor = vec4( c * vBright * a, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

function makeStarGeometry(count: number, seed: number): THREE.BufferGeometry {
  const rand = makeRandom(seed)
  const position = new Float32Array(count * 3)
  const size = new Float32Array(count)
  const bright = new Float32Array(count)
  const phase = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    // Uniform over the upper hemisphere: uniform height gives uniform area on a sphere.
    const y = 0.02 + rand() * 0.98
    const r = Math.sqrt(1 - y * y)
    const a = rand() * Math.PI * 2
    position[i * 3] = Math.cos(a) * r * RADIUS
    position[i * 3 + 1] = y * RADIUS
    position[i * 3 + 2] = Math.sin(a) * r * RADIUS
    // Most stars faint, a handful bright.
    const m = Math.pow(rand(), 5)
    size[i] = 1.4 + m * 3.2
    bright[i] = 0.18 + m * (GLOW.T1 - 0.18)
    phase[i] = rand()
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(position, 3))
  g.setAttribute('aSize', new THREE.BufferAttribute(size, 1))
  g.setAttribute('aBright', new THREE.BufferAttribute(bright, 1))
  g.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1))
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), RADIUS)
  return g
}

export function Stars({ quality, seed }: { quality: QualityLevel; seed: number }) {
  const ref = useRef<THREE.Points>(null)
  const geometry = useMemo(() => makeStarGeometry(COUNT[quality], seed ^ 0x57a5), [quality, seed])
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uTime: skyUniforms.uTime,
          uFade: { value: 0 },
          uColor: { value: new THREE.Color(PALETTE.stars) },
          uTintColor: { value: new THREE.Color(PALETTE.planetRing) },
        },
        vertexShader,
        fragmentShader,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      }),
    [],
  )

  useEffect(() => {
    worldStats.stars = COUNT[quality]
    return () => geometry.dispose()
  }, [geometry, quality])
  useEffect(() => () => material.dispose(), [material])

  useFrame((state) => {
    const pts = ref.current
    if (!pts) return
    pts.position.copy(state.camera.position)
    material.uniforms.uFade.value = sky.nightSky
    pts.visible = sky.nightSky > 0.002
  })

  return <points ref={ref} geometry={geometry} material={material} frustumCulled={false} renderOrder={-990} />
}
