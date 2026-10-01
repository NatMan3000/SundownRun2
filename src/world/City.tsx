// ============================================================
//  CITY - the megacity skyline on the horizon
// ------------------------------------------------------------
//  A distant arc of towers (track file: environment.city), drawn
//  as ONE instanced mesh: hundreds of boxes in a single draw call.
//  A second, tiny draw holds the blinking lights on the spires.
//
//  How it is laid out: several rows of towers along an arc around
//  the world, tallest in the middle of the arc and falling away
//  toward its ends, so it reads as one skyline. Rows further back
//  are hazier, which gives the city its own depth.
//
//  How it looks:
//    - At sundown the towers are near-black silhouettes against the
//      sun (they stand in front of it by default).
//    - Windows switch on one by one as night falls (time of day
//      0.2 -> 0.9). Each window cell has its own switch-on moment
//      and its own colour (warm amber or cool cyan), worked out in
//      the shader from the tower's seed - nothing is stored.
//    - Far away, a window is smaller than a pixel. Instead of
//      flickering, the pattern fades to its average brightness as
//      the cells get small (the same trick as the terrain grid).
//    - Each tower's base dissolves into the haze by alpha, so the
//      skyline never sits on a hard line, and the sun still shows
//      through the haze between the bases.
//
//  Glow: silhouettes T0, windows T1, spire lights T1.
// ============================================================

import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { GLOW, PALETTE } from '../core/palette'
import type { QualityLevel } from '../core/settings'
import type { TrackRuntime } from '../track/types'
import { SKY_GLSL } from './skyGlsl'
import { sky, skyUniforms } from './sky'
import { makeRandom } from './textures'
import { worldStats } from './stats'

const DEG = Math.PI / 180

/** Towers per row at full density, per preset. */
const PER_ROW: Record<QualityLevel, number> = { high: 120, medium: 80, low: 48 }
/** Rows: distance offset from the city distance (m) and how hazy the row is. */
const ROWS = [
  { offset: -180, haze: 0.28, scale: 0.7 },
  { offset: 0, haze: 0.36, scale: 1.0 },
  { offset: 240, haze: 0.46, scale: 0.92 },
  { offset: 520, haze: 0.56, scale: 0.8 },
]
/** The tallest tower in the middle of the skyline, metres. */
const MAX_HEIGHT = 680
/** How far below the base height the towers start (their feet are in the haze). */
const SINK = 90
/** Height of the base haze band that the towers dissolve out of, metres. */
const BASE_FADE = 170

const vertexShader = /* glsl */ `
attribute vec3 aSize;
attribute vec2 aSeed;
attribute float aHaze;
varying vec3 vWorld;
varying vec3 vFacade;
varying vec3 vNormalW;
varying vec2 vSeed;
varying float vHeight;
varying float vHaze;
void main() {
  vHaze = aHaze;
  vec4 w = modelMatrix * instanceMatrix * vec4( position, 1.0 );
  vWorld = w.xyz;
  // Facade coordinates in metres: along the face, up the tower.
  vec3 local = position * aSize;
  vNormalW = normalize( mat3( modelMatrix * instanceMatrix ) * normal );
  float along = abs( normal.x ) > 0.5 ? local.z : local.x;
  vFacade = vec3( along, local.y, abs( normal.y ) );
  vSeed = aSeed;
  vHeight = aSize.y;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`

const fragmentShader = /* glsl */ `
${SKY_GLSL}
uniform vec3 uSilhouette;
uniform vec3 uWarm;
uniform vec3 uCool;
uniform float uWindows;
uniform float uBaseY;
uniform float uBaseFade;
varying float vHaze;
varying vec3 vWorld;
varying vec3 vFacade;
varying vec3 vNormalW;
varying vec2 vSeed;
varying float vHeight;

float hash12( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}

void main() {
  vec3 toFrag = vWorld - cameraPosition;
  vec3 dir = normalize( toFrag );

  // The silhouette: near-black, with a faint sheen of the sky on its upper floors.
  float upper = clamp( vFacade.y / max( vHeight, 1.0 ), 0.0, 1.0 );
  vec3 col = uSilhouette * ( 0.75 + 0.5 * upper );
  col += skyColor( reflect( dir, vNormalW ) ) * 0.05;

  // Windows: cells of a few floors each, lit one by one as night falls.
  float onWalls = 1.0 - step( 0.5, vFacade.z );
  vec2 cell = vec2( vFacade.x / 7.0, vFacade.y / 5.0 );
  vec2 id = floor( cell );
  vec2 f = fract( cell );
  float pane = step( 0.2, f.x ) * step( f.x, 0.8 ) * step( 0.22, f.y ) * step( f.y, 0.78 );
  float h = hash12( id + vSeed * 97.0 );
  float threshold = h / 0.74;                    // a quarter of the windows stay dark
  float on = smoothstep( threshold - 0.02, threshold + 0.02, uWindows );
  float warm = step( hash12( id * 1.37 + vSeed * 41.0 ), 0.62 );
  float level = 0.55 + 0.45 * hash12( id * 3.1 + vSeed.yx * 13.0 );
  // Cells smaller than a pixel: fade to the average instead of shimmering.
  vec2 fw = fwidth( cell );
  float tiny = smoothstep( 0.3, 0.9, max( fw.x, fw.y ) );
  // pane area x share of cells switched on x average brightness
  float average = 0.336 * clamp( uWindows, 0.0, 1.0 ) * 0.74 * 0.78;
  float lit = mix( pane * on * level, average, tiny ) * onWalls;
  // No windows in the hazy base or right at the top.
  lit *= smoothstep( uBaseY + uBaseFade * 0.55, uBaseY + uBaseFade, vWorld.y );
  lit *= 1.0 - step( vHeight - 6.0, vFacade.y );
  vec3 windowCol = mix( uCool, uWarm, mix( warm, 0.62, tiny ) );

  // Distance haze toward the sky behind; lights punch through it more than walls do.
  vec3 hazeCol = skyHazeColor( dir );
  col = mix( col, hazeCol, vHaze );
  col += windowCol * lit * ( 1.0 - vHaze * 0.55 );

  // The feet dissolve into the haze.
  float alpha = smoothstep( uBaseY, uBaseY + uBaseFade, vWorld.y );
  gl_FragColor = vec4( col, alpha );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

const lightVertex = /* glsl */ `
attribute float aPhase;
uniform float uTime;
uniform float uOn;
varying float vBright;
void main() {
  // A slow, eased blink: about 2.6 s per cycle, never a hard snap.
  float s = 0.5 + 0.5 * sin( uTime * 2.4 + aPhase * 6.2831 );
  vBright = pow( s, 6.0 ) * uOn;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  gl_PointSize = vBright > 0.01 ? 4.0 : 0.0;
}
`
const lightFragment = /* glsl */ `
uniform vec3 uColor;
varying float vBright;
void main() {
  float d = length( gl_PointCoord - 0.5 ) * 2.0;
  float a = 1.0 - smoothstep( 0.2, 1.0, d );
  gl_FragColor = vec4( uColor * vBright * a, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

interface CityLayout {
  towers: THREE.InstancedMesh
  lights: THREE.Points
  dispose: () => void
  triangles: number
}

function buildCity(track: TrackRuntime, quality: QualityLevel, material: THREE.ShaderMaterial, lightMat: THREE.ShaderMaterial): CityLayout | null {
  const env = track.file.environment
  const city = env.city
  if (!city) return null
  const rand = makeRandom((env.seed ^ 0xc17c) >>> 0)
  const az0 = (city.azimuthDeg ?? env.sky.sunAzimuthDeg ?? 0) * DEG
  const arc = (city.arcDeg ?? 120) * DEG
  const dist = city.distance ?? env.size * 2.2
  const density = Math.min(1, Math.max(0.1, city.density ?? 0.7))
  const baseY = (env.terrain.height ?? 0) - SINK

  type Tower = { x: number; z: number; yaw: number; w: number; d: number; h: number; dist: number; row: number }
  const list: Tower[] = []
  for (let r = 0; r < ROWS.length; r++) {
    const row = ROWS[r]
    const count = Math.round(PER_ROW[quality] * density * (r === 0 ? 0.55 : 1))
    for (let i = 0; i < count; i++) {
      // Spread along the arc with jitter; the outer ends are sparser.
      const u = (i + 0.5 + (rand() - 0.5) * 0.9) / count - 0.5
      const az = az0 + u * arc
      const edge = Math.abs(u) * 2
      if (rand() < edge * edge * 0.55) continue
      const R = dist + row.offset + (rand() - 0.5) * 140
      // Tallest in the middle, falling away to the ends, with plenty of variety.
      const profile = Math.pow(Math.cos(Math.min(1, edge) * Math.PI * 0.5), 1.3)
      const tall = rand() < 0.08 ? 1.25 : 0.25 + rand() * 0.75
      const h = SINK + 40 + (MAX_HEIGHT - 40) * profile * tall * row.scale
      const w = 38 + rand() * 70
      list.push({
        x: Math.sin(az) * R,
        z: -Math.cos(az) * R,
        yaw: -az + (rand() - 0.5) * 0.25,
        w,
        d: 38 + rand() * 70,
        h,
        dist: R,
        row: r,
      })
    }
  }
  // Far first: inside the single draw, the back rows blend under the front ones.
  list.sort((a, b) => b.dist - a.dist)

  const geometry = new THREE.BoxGeometry(1, 1, 1)
  geometry.translate(0, 0.5, 0)
  const size = new Float32Array(list.length * 3)
  const seed = new Float32Array(list.length * 2)
  const rowHaze = new Float32Array(list.length)
  const towers = new THREE.InstancedMesh(geometry, material, list.length)
  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const p = new THREE.Vector3()
  const s = new THREE.Vector3()
  const up = new THREE.Vector3(0, 1, 0)
  const lightPos: number[] = []
  const lightPhase: number[] = []
  for (let i = 0; i < list.length; i++) {
    const t = list[i]
    q.setFromAxisAngle(up, t.yaw)
    p.set(t.x, baseY, t.z)
    s.set(t.w, t.h, t.d)
    m.compose(p, q, s)
    towers.setMatrixAt(i, m)
    size[i * 3] = t.w
    size[i * 3 + 1] = t.h
    size[i * 3 + 2] = t.d
    seed[i * 2] = rand()
    seed[i * 2 + 1] = rand()
    rowHaze[i] = ROWS[t.row].haze
    // Spires: the tallest towers carry a blinking light on top.
    if (t.h > MAX_HEIGHT * 0.62 && lightPos.length < 3 * 40) {
      lightPos.push(t.x, baseY + t.h + 6, t.z)
      lightPhase.push(rand())
    }
  }
  geometry.setAttribute('aSize', new THREE.InstancedBufferAttribute(size, 3))
  geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 2))
  geometry.setAttribute('aHaze', new THREE.InstancedBufferAttribute(rowHaze, 1))
  towers.instanceMatrix.needsUpdate = true
  towers.frustumCulled = false
  towers.renderOrder = -970

  const lg = new THREE.BufferGeometry()
  lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lightPos), 3))
  lg.setAttribute('aPhase', new THREE.BufferAttribute(new Float32Array(lightPhase), 1))
  const lights = new THREE.Points(lg, lightMat)
  lights.frustumCulled = false
  lights.renderOrder = -960

  return {
    towers,
    lights,
    triangles: list.length * 12,
    dispose: () => {
      geometry.dispose()
      lg.dispose()
      towers.dispose()
    },
  }
}

export function City({ track, quality }: { track: TrackRuntime; quality: QualityLevel }) {
  const groupRef = useRef<THREE.Group>(null)
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          ...skyUniforms,
          uSilhouette: { value: new THREE.Color(PALETTE.citySilhouette).multiplyScalar(GLOW.T0) },
          uWarm: { value: new THREE.Color(PALETTE.cityWindowWarm).multiplyScalar(GLOW.T1) },
          uCool: { value: new THREE.Color(PALETTE.cityWindowCool).multiplyScalar(GLOW.T1) },
          uWindows: { value: 0 },
          uBaseY: { value: 0 },
          uBaseFade: { value: BASE_FADE },
        },
        vertexShader,
        fragmentShader,
        transparent: true,
        depthWrite: true,
        fog: false,
      }),
    [],
  )
  const lightMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uTime: skyUniforms.uTime,
          uOn: { value: 0 },
          uColor: { value: new THREE.Color(PALETTE.cityWindowWarm).lerp(new THREE.Color(PALETTE.roadEdge), 0.35).multiplyScalar(GLOW.T1) },
        },
        vertexShader: lightVertex,
        fragmentShader: lightFragment,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      }),
    [],
  )
  const layout = useMemo(() => buildCity(track, quality, material, lightMat), [track, quality, material, lightMat])

  useEffect(() => {
    if (!layout) {
      worldStats.cityTowers = 0
      return
    }
    worldStats.cityTowers = layout.towers.count
    worldStats.cityTriangles = layout.triangles
    material.uniforms.uBaseY.value = (track.file.environment.terrain.height ?? 0) - SINK
    return () => layout.dispose()
  }, [layout, material, track])
  useEffect(
    () => () => {
      material.dispose()
      lightMat.dispose()
    },
    [material, lightMat],
  )

  useFrame((state) => {
    const g = groupRef.current
    if (!g || !layout) return
    // Rides with the camera across the ground (it is "at the horizon"), not up and down.
    g.position.set(state.camera.position.x, 0, state.camera.position.z)
    material.uniforms.uWindows.value = sky.windows
    lightMat.uniforms.uOn.value = Math.min(1, sky.windows * 3)
  })

  if (!layout) return null
  return (
    <group ref={groupRef}>
      <primitive object={layout.towers} />
      <primitive object={layout.lights} />
    </group>
  )
}
