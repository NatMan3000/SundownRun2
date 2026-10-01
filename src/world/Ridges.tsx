// ============================================================
//  DISTANT RIDGES - mountains beyond the edge of the world
// ------------------------------------------------------------
//  Two rings of mountains well outside the play area, for depth:
//  you see them over the edge ridge from high places, above the
//  Hyperdrome's stands, and either side of the city. On ridge-edged
//  tracks a third ring of jagged, dark peaks stands right behind the
//  edge ridge's crest and breaks its smooth top into peaks and
//  saddles (only their top quarter dissolves; no grid on them).
//
//  The v1 lesson, kept: fogging far mountains to one flat colour
//  makes a cardboard slab with a hard top edge. These dissolve by
//  ALPHA instead: fully see-through at the summit, solid lower
//  down, so the skyline is always the real sky melting into the
//  mountain - no edge to find. They are also hazed toward the
//  exact sky colour behind them (skyGlsl.ts), the further ring
//  more than the nearer one.
//
//  The neon touch: slopes facing the sun catch a warm rim at
//  sundown, and a faint wireframe grid runs over them.
//
//  Across the city's arc the ridges drop low, so they never hide
//  the skyline. They stay put in the world (no camera following),
//  so they slide against the nearer ground as you drive.
//
//  One mesh, one draw call, about 13k triangles with the crest.
// ============================================================

import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { GLOW, PALETTE } from '../core/palette'
import type { TrackRuntime } from '../track/types'
import { SKY_GLSL } from './skyGlsl'
import { sky, skyUniforms } from './sky'
import { makeRandom } from './textures'
import { worldStats } from './stats'

const SEG = 288
const LAYERS = 7
const DEG = Math.PI / 180

/** The two rings: distance (in world half-sizes), height (degrees above eye level, seen from the middle), haze. */
const RINGS = [
  { dist: 2.5, minDeg: 1.6, maxDeg: 5.2, haze: 0.42, seed: 11.3, fade: 0.55 },
  { dist: 3.4, minDeg: 2.4, maxDeg: 6.6, haze: 0.62, seed: 47.9, fade: 0.65 },
]

const vertexShader = /* glsl */ `
attribute float aAlpha;
attribute float aHaze;
attribute float aGrid;
attribute vec2 aGridUv;
varying vec3 vWorld;
varying vec3 vNormalW;
varying float vAlpha;
varying float vHaze;
varying float vGrid;
varying vec2 vGridUv;
void main() {
  vec4 w = modelMatrix * vec4( position, 1.0 );
  vWorld = w.xyz;
  vNormalW = normalize( mat3( modelMatrix ) * normal );
  vAlpha = aAlpha;
  vHaze = aHaze;
  vGrid = aGrid;
  vGridUv = aGridUv;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`

const fragmentShader = /* glsl */ `
${SKY_GLSL}
uniform vec3 uBody;
uniform vec3 uRim;
uniform vec3 uGrid;
varying vec3 vWorld;
varying vec3 vNormalW;
varying float vAlpha;
varying float vHaze;
varying float vGrid;
varying vec2 vGridUv;

float gridLine( vec2 uv ) {
  vec2 fw = fwidth( uv );
  vec2 g = abs( fract( uv - 0.5 ) - 0.5 ) / max( fw, vec2( 1e-4 ) );
  float l = 1.0 - min( min( g.x, g.y ), 1.0 );
  // Fade the grid where its cells shrink below a few pixels (no shimmer).
  return l * ( 1.0 - smoothstep( 0.15, 0.4, max( fw.x, fw.y ) ) );
}

void main() {
  vec3 dir = normalize( vWorld - cameraPosition );
  vec3 n = normalize( vNormalW );
  vec3 col = uBody;
  // Slopes that face the sun catch its warm light (only while it is up or glowing).
  vec2 sunH = normalize( uSunDir.xz + vec2( 1e-5 ) );
  float facing = max( dot( normalize( n.xz + vec2( 1e-5 ) ), sunH ), 0.0 );
  col += uRim * pow( facing, 2.0 ) * ( 0.25 + 0.75 * clamp( n.y, 0.0, 1.0 ) );
  col += uGrid * gridLine( vGridUv ) * vGrid;
  // Haze toward the exact sky behind; the far ring more than the near one.
  float haze = vHaze;
  col = mix( col, skyColor( normalize( vec3( dir.x, max( dir.y, -0.02 ), dir.z ) ) ), haze );
  gl_FragColor = vec4( col, vAlpha );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

function noise1(rand: () => number, n: number): Float32Array {
  // Smooth periodic noise around the ring: a few random sine waves.
  const out = new Float32Array(n)
  const waves = 6
  const amp: number[] = []
  const ph: number[] = []
  for (let w = 0; w < waves; w++) {
    amp.push((rand() * 0.8 + 0.2) / (w + 1))
    ph.push(rand() * Math.PI * 2)
  }
  let max = 0
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2
    let v = 0
    for (let w = 0; w < waves; w++) v += amp[w] * Math.sin(t * (w * 2 + 3) + ph[w])
    out[i] = v
    max = Math.max(max, Math.abs(v))
  }
  for (let i = 0; i < n; i++) out[i] = out[i] / max * 0.5 + 0.5
  return out
}

/** Peaks along the crest of the world's edge ridge: segments round the world. */
const CREST_SEG = 360

/**
 * A ring of jagged peaks standing on the plateau just behind the edge ridge's
 * crest (scenery only: the containment ring on the crest keeps cars out). They
 * break the ridge's smooth top into peaks and saddles, stay dark (silhouettes),
 * and only their top quarter dissolves into the sky. Through the sunset notch
 * they stay low, so the sun and the city keep their window.
 */
function addCrest(
  track: TrackRuntime,
  rand: () => number,
  start: number,
  position: Float32Array,
  alpha: Float32Array,
  haze: Float32Array,
  gridAmt: Float32Array,
  grid: Float32Array,
  index: number[],
): void {
  const half = track.world.half
  const sunAz = (track.file.environment.sky.sunAzimuthDeg ?? 0) * DEG
  const shape = noise1(rand, CREST_SEG)
  const detail = noise1(rand, CREST_SEG)
  let v = start
  for (let i = 0; i < CREST_SEG; i++) {
    const az = (i / CREST_SEG) * Math.PI * 2
    const sx = Math.sin(az)
    const sz = -Math.cos(az)
    // On the world's rounded-square edge (|x|^8 + |z|^8 = r^8), a little inside the grid border.
    const k = Math.pow(Math.abs(sx) ** 8 + Math.abs(sz) ** 8, 1 / 8)
    const R = (half - 12) / k
    const groundY = track.terrainHeight(sx * R, sz * R)
    // Peaks and saddles: a broad shape, sharpened, plus a jagged detail.
    // Noise can dip below zero; a negative base to a fractional power is NaN, so clamp first.
    const peak = Math.pow(Math.max(0, shape[i]), 2.2) * 0.75 + Math.pow(Math.max(0, detail[i]), 3) * 0.45
    let toSun = Math.abs(az - sunAz) % (Math.PI * 2)
    if (toSun > Math.PI) toSun = Math.PI * 2 - toSun
    const notch = 0.3 + 0.7 * Math.min(1, Math.max(0, (toSun - 40 * DEG) / (25 * DEG)))
    const height = (10 + 58 * peak) * notch
    const bottom = groundY - 8
    for (let l = 0; l <= LAYERS; l++) {
      const f = l / LAYERS
      position[v * 3] = sx * (R + f * f * 6)
      position[v * 3 + 1] = bottom + (height + 8) * f
      position[v * 3 + 2] = sz * (R + f * f * 6)
      // Solid silhouettes; only the top quarter melts into the sky.
      alpha[v] = Math.min(1, (1 - f) / 0.25)
      haze[v] = 0.16
      gridAmt[v] = 0
      grid[v * 2] = 0
      grid[v * 2 + 1] = 0
      v++
    }
  }
  for (let i = 0; i < CREST_SEG; i++) {
    const j = (i + 1) % CREST_SEG
    for (let l = 0; l < LAYERS; l++) {
      const a = start + i * (LAYERS + 1) + l
      const b = start + j * (LAYERS + 1) + l
      index.push(a, b, b + 1, a, b + 1, a + 1)
    }
  }
}

function buildRidges(track: TrackRuntime): THREE.BufferGeometry {
  const env = track.file.environment
  const half = track.world.half
  const ground = env.terrain.height ?? 0
  const eye = track.terrainHeight(0, 0) + 3
  const rand = makeRandom((env.seed ^ 0x41d9e) >>> 0)
  const city = env.city
  const cityAz = city ? (city.azimuthDeg ?? env.sky.sunAzimuthDeg ?? 0) * DEG : 0
  const cityHalfArc = city ? ((city.arcDeg ?? 120) * DEG) / 2 + 8 * DEG : 0

  const verts = RINGS.length * SEG * (LAYERS + 1)
  const crestVerts = track.world.edge === 'ridge' ? CREST_SEG * (LAYERS + 1) : 0
  const total = verts + crestVerts
  const position2 = new Float32Array(total * 3)
  const alpha2 = new Float32Array(total)
  const haze = new Float32Array(total)
  const gridAmt = new Float32Array(total)
  const grid = new Float32Array(total * 2)
  const index: number[] = []

  // Far ring first: within the one draw, the near ring blends over it.
  const order = [1, 0]
  let v = 0
  for (const r of order) {
    const spec = RINGS[r]
    const R0 = half * spec.dist
    const shape = noise1(rand, SEG)
    const detail = noise1(rand, SEG)
    const base = v
    for (let i = 0; i < SEG; i++) {
      const th = (i / SEG) * Math.PI * 2 // compass azimuth
      // Lower across the city's arc, so the skyline stands clear.
      let gap = 0
      if (city) {
        let d = Math.abs(th - cityAz) % (Math.PI * 2)
        if (d > Math.PI) d = Math.PI * 2 - d
        gap = 1 - Math.min(1, Math.max(0, (d - cityHalfArc * 0.8) / (cityHalfArc * 0.4)))
      }
      const peakDeg = spec.minDeg + (spec.maxDeg - spec.minDeg) * Math.pow(Math.max(0, shape[i] * 0.75 + detail[i] * 0.25), 1.3)
      const R = R0 * (1 + (detail[i] - 0.5) * 0.08)
      const top = eye + Math.tan(peakDeg * DEG) * R * (1 - 0.72 * gap)
      const bottom = ground - 30
      const sx = Math.sin(th)
      const sz = -Math.cos(th)
      for (let l = 0; l <= LAYERS; l++) {
        const f = l / LAYERS // 0 base -> 1 summit
        const y = bottom + (top - bottom) * Math.pow(f, 0.8)
        // Mountains lean back as they rise, so they have a slope to light.
        const rr = R + f * f * (top - bottom) * 0.9
        position2[v * 3] = sx * rr
        position2[v * 3 + 1] = y
        position2[v * 3 + 2] = sz * rr
        // Zero alpha at the summit: the silhouette IS the sky.
        alpha2[v] = Math.pow(Math.min(1, (1 - f) / spec.fade), 0.7)
        haze[v] = spec.haze
        gridAmt[v] = 1
        grid[v * 2] = (th * R0) / 70
        grid[v * 2 + 1] = y / 45
        v++
      }
    }
    for (let i = 0; i < SEG; i++) {
      const j = (i + 1) % SEG
      for (let l = 0; l < LAYERS; l++) {
        const a = base + i * (LAYERS + 1) + l
        const b = base + j * (LAYERS + 1) + l
        index.push(a, b, b + 1, a, b + 1, a + 1)
      }
    }
  }
  if (crestVerts > 0) addCrest(track, rand, v, position2, alpha2, haze, gridAmt, grid, index)

  const position = position2
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(position2, 3))
  g.setAttribute('aAlpha', new THREE.BufferAttribute(alpha2, 1))
  g.setAttribute('aHaze', new THREE.BufferAttribute(haze, 1))
  g.setAttribute('aGrid', new THREE.BufferAttribute(gridAmt, 1))
  g.setAttribute('aGridUv', new THREE.BufferAttribute(grid, 2))
  g.setIndex(index)
  g.computeVertexNormals()
  // The rings face inward (toward the play area): make sure the normals do too.
  const nrm = g.getAttribute('normal') as THREE.BufferAttribute
  let dot = 0
  for (let i = 0; i < nrm.count; i += 7) dot += nrm.getX(i) * position[i * 3] + nrm.getZ(i) * position[i * 3 + 2]
  if (dot > 0) {
    for (let i = 0; i < nrm.count; i++) nrm.setXYZ(i, -nrm.getX(i), -nrm.getY(i), -nrm.getZ(i))
  }
  g.computeBoundingSphere()
  return g
}

const WARM_RIM = new THREE.Color(PALETTE.skySunGlow).lerp(new THREE.Color(PALETTE.sunBottom), 0.4)
const COOL_RIM = new THREE.Color(PALETTE.planetRing)

export function Ridges({ track }: { track: TrackRuntime }) {
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          ...skyUniforms,
          uBody: { value: new THREE.Color(PALETTE.citySilhouette).lerp(new THREE.Color(PALETTE.groundSheen), 0.45) },
          uRim: { value: new THREE.Color() },
          uGrid: { value: new THREE.Color(PALETTE.grid).multiplyScalar(GLOW.T0 * 0.35) },
        },
        vertexShader,
        fragmentShader,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      }),
    [],
  )
  const geometry = useMemo(() => buildRidges(track), [track])
  useEffect(() => {
    worldStats.ridgeTriangles = (geometry.index?.count ?? 0) / 3
    return () => geometry.dispose()
  }, [geometry])
  useEffect(() => () => material.dispose(), [material])

  // Warm rim while the sun is up or glowing; a faint cool planet-light rim at night.
  useFrame(() => {
    const rim = material.uniforms.uRim.value as THREE.Color
    rim.copy(WARM_RIM).multiplyScalar(0.4 * sky.afterglow)
    rim.r += COOL_RIM.r * 0.07 * sky.nightSky
    rim.g += COOL_RIM.g * 0.07 * sky.nightSky
    rim.b += COOL_RIM.b * 0.07 * sky.nightSky
  })

  return <mesh name="world-ridges" geometry={geometry} material={material} renderOrder={-955} frustumCulled={false} />
}
