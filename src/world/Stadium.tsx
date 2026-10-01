// ============================================================
//  STADIUM - the Hyperdrome's grandstands
// ------------------------------------------------------------
//  When a track file has environment.stadium, grandstands ring the
//  outside of the road all the way round, so the oval reads as an
//  enclosed neon stadium. Built from the road itself, so it fits
//  any oval (or any loop) a track file describes.
//
//  Cross-section, from the road outward:
//
//      road | barrier |   apron (billboards stand here)   | front wall
//      ---------------------------------------------------|  tiers rise...
//                                                         |      ...to the rim,
//                                                         |   canopy overhead,
//                                                         |   back wall down
//
//  Parts (draw calls in brackets):
//    - the stands: front wall, tiered seating slope, rim, back wall
//      and the canopy, one merged mesh [1]. Dark structure (glow T0)
//      with every fourth tier and the canopy's front edge drawn as
//      light (T1): the "floodlight rings";
//    - floodlight masts behind the stands, instanced [1];
//    - the crowd: thousands of tiny twinkling lights (phones and glow
//      sticks) on the tiers, one Points draw [1];
//    - <StadiumColliders />: the stand front is solid (a chain of
//      boxes), so a car that jumps the barrier is still held in.
//
//  The road and its barriers belong to the look and track systems.
// ============================================================

import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { useRapier } from '@react-three/rapier'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { GLOW, PALETTE } from '../core/palette'
import { GROUPS, tagSurface, untagSurface } from '../core/physics'
import type { QualityLevel } from '../core/settings'
import type { TrackRuntime } from '../track/types'
import { makeRandom } from './textures'
import { DEPTH, FRONT_H, SECTION, type StandLine, standLine } from './stadiumLayout'
import { skyUniforms } from './sky'
import { worldStats } from './stats'

/** Seating tiers (rows of seats). */
const TIERS = 20
/** Floodlight masts: one every this many metres. */
const MAST_EVERY = 140
/** Crowd lights per metre of stand, per row, by preset. */
const CROWD_DENSITY: Record<QualityLevel, number> = { high: 0.55, medium: 0.3, low: 0.15 }
const CROWD_ROWS = 14

// ---------------------------------------------------------------- the stands mesh

/** Cross-section points (outward metres from the front, metres up) and which surface each strip is. */
function profile(H: number) {
  const back = DEPTH + 2
  return {
    // [outward, up] pairs; each pair is a strip running all the way round.
    // kind: 0 structure, 1 seats, 2 canopy, 3 canopy light bar, 4 rim light ring, 5 front wall.
    strips: [
      { a: [0, 0], b: [0, FRONT_H], kind: 5 },
      { a: [0, FRONT_H], b: [DEPTH, H], kind: 1 },
      { a: [DEPTH, H], b: [back, H], kind: 4 },
      { a: [back, H], b: [back, 0], kind: 0 },
      { a: [back, H + 9], b: [DEPTH - 16, H + 6.5], kind: 2 }, //    canopy top
      { a: [DEPTH - 16, H + 5.7], b: [back, H + 8.2], kind: 2 }, //  canopy underside
      { a: [DEPTH - 16, H + 6.5], b: [DEPTH - 16, H + 5.7], kind: 3 }, // canopy front edge (light bar)
    ] as { a: number[]; b: number[]; kind: number }[],
    back,
  }
}

function buildStandsGeometry(line: StandLine): THREE.BufferGeometry {
  const { strips } = profile(line.height)
  const n = line.count
  const vertsPerStrip = n * 2
  const total = strips.length * vertsPerStrip
  const position = new Float32Array(total * 3)
  const aV = new Float32Array(total)
  const aU = new Float32Array(total)
  const aKind = new Float32Array(total)
  // Metres along the stand front, for panel seams.
  const along = new Float32Array(n)
  for (let k = 1; k < n; k++) along[k] = along[k - 1] + Math.hypot(line.fx[k] - line.fx[k - 1], line.fz[k] - line.fz[k - 1])
  const index: number[] = []
  let v = 0
  for (const st of strips) {
    const base = v
    for (let k = 0; k < n; k++) {
      for (const [p, t] of [
        [st.a, 0],
        [st.b, 1],
      ] as [number[], number][]) {
        position[v * 3] = line.fx[k] + line.ox[k] * p[0]
        position[v * 3 + 1] = line.ground[k] + p[1]
        position[v * 3 + 2] = line.fz[k] + line.oz[k] * p[0]
        aV[v] = t
        aU[v] = along[k]
        aKind[v] = st.kind
        v++
      }
    }
    for (let k = 0; k < n; k++) {
      const k2 = (k + 1) % n
      const a = base + k * 2
      const b = base + k2 * 2
      // One winding; the material is double-sided (three flips the normal for back faces).
      index.push(a, b, a + 1, a + 1, b, b + 1)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(position, 3))
  g.setAttribute('aV', new THREE.BufferAttribute(aV, 1))
  g.setAttribute('aU', new THREE.BufferAttribute(aU, 1))
  g.setAttribute('aKind', new THREE.BufferAttribute(aKind, 1))
  g.setIndex(index)
  g.computeVertexNormals()
  g.computeBoundingSphere()
  return g
}

// ---------------------------------------------------------------- floodlight masts

function box(w: number, h: number, d: number, x: number, y: number, z: number, glow: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d)
  g.translate(x, y, z)
  g.setAttribute('aGlow', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count).fill(glow), 1))
  return g
}

function buildMasts(line: StandLine, material: THREE.Material): THREE.InstancedMesh {
  const H = line.height
  const top = H + 30
  const parts = [box(1.4, top, 1.4, 0, top / 2, 0, 0), box(9, 3, 1.2, 0, top, -0.6, 0), box(8.4, 2.2, 0.2, 0, top, -1.25, 1)]
  const geo = mergeGeometries(parts, false)
  for (const p of parts) p.dispose()
  if (!geo) throw new Error('[world] stadium mast geometry failed to merge')

  const every = Math.max(1, Math.round(MAST_EVERY / SECTION))
  const count = Math.floor(line.count / every)
  const masts = new THREE.InstancedMesh(geo, material, count)
  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const up = new THREE.Vector3(0, 1, 0)
  const p = new THREE.Vector3()
  const s = new THREE.Vector3(1, 1, 1)
  const back = DEPTH + 6
  for (let i = 0; i < count; i++) {
    const k = i * every
    // Face the lamps back toward the track (local -z inward).
    q.setFromAxisAngle(up, Math.atan2(line.ox[k], line.oz[k]))
    p.set(line.fx[k] + line.ox[k] * back, line.ground[k], line.fz[k] + line.oz[k] * back)
    m.compose(p, q, s)
    masts.setMatrixAt(i, m)
  }
  masts.instanceMatrix.needsUpdate = true
  masts.computeBoundingSphere()
  masts.castShadow = false
  return masts
}

// ---------------------------------------------------------------- the crowd

const crowdVertex = /* glsl */ `
attribute float aPhase;
attribute float aTint;
uniform float uTime;
varying float vBright;
varying float vTint;
void main() {
  vTint = aTint;
  // Phones and glow sticks: each light breathes slowly, some wave.
  float wave = 0.55 + 0.45 * sin( uTime * ( 0.6 + aPhase * 1.4 ) + aPhase * 31.0 );
  vBright = wave;
  vec4 mv = modelViewMatrix * vec4( position, 1.0 );
  gl_Position = projectionMatrix * mv;
  // Bigger up close, never smaller than a pixel far away.
  gl_PointSize = clamp( 260.0 / -mv.z, 1.0, 4.0 );
}
`

const crowdFragment = /* glsl */ `
uniform vec3 uWarm;
uniform vec3 uCool;
uniform vec3 uPink;
uniform vec3 uCyan;
varying float vBright;
varying float vTint;
void main() {
  float d = length( gl_PointCoord - 0.5 ) * 2.0;
  float a = 1.0 - smoothstep( 0.3, 1.0, d );
  vec3 c = vTint < 0.45 ? uWarm : vTint < 0.8 ? uCool : vTint < 0.9 ? uPink : uCyan;
  gl_FragColor = vec4( c * vBright * a, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

function buildCrowd(line: StandLine, quality: QualityLevel, seed: number): THREE.BufferGeometry {
  const rand = makeRandom(seed)
  const H = line.height
  // Stand length.
  let length = 0
  for (let k = 0; k < line.count; k++) {
    const k2 = (k + 1) % line.count
    length += Math.hypot(line.fx[k2] - line.fx[k], line.fz[k2] - line.fz[k])
  }
  const perRow = Math.round(length * CROWD_DENSITY[quality])
  const total = perRow * CROWD_ROWS
  const position = new Float32Array(total * 3)
  const phase = new Float32Array(total)
  const tint = new Float32Array(total)
  let n = 0
  for (let r = 0; r < CROWD_ROWS; r++) {
    const t = (r + 0.6) / CROWD_ROWS
    for (let i = 0; i < perRow; i++) {
      const u = ((i + rand()) / perRow) * line.count
      const k = Math.floor(u) % line.count
      const k2 = (k + 1) % line.count
      const f = u - Math.floor(u)
      const out = t * DEPTH
      const x = line.fx[k] + (line.fx[k2] - line.fx[k]) * f + line.ox[k] * out
      const z = line.fz[k] + (line.fz[k2] - line.fz[k]) * f + line.oz[k] * out
      const y = line.ground[k] + FRONT_H + (H - FRONT_H) * t + 1.0
      position[n * 3] = x
      position[n * 3 + 1] = y
      position[n * 3 + 2] = z
      phase[n] = rand()
      tint[n] = rand()
      n++
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(position, 3))
  g.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1))
  g.setAttribute('aTint', new THREE.BufferAttribute(tint, 1))
  g.computeBoundingSphere()
  return g
}

// ---------------------------------------------------------------- component

function makeStructureMaterial(accentHex: string, masts: boolean): THREE.MeshStandardMaterial {
  const accent = new THREE.Color(accentHex).multiplyScalar(GLOW.T1)
  const lightBar = new THREE.Color(PALETTE.laneLine).multiplyScalar(GLOW.T1)
  const tierLine = new THREE.Color(PALETTE.grid).multiplyScalar(GLOW.T0 * 0.6)
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(PALETTE.citySilhouette).lerp(new THREE.Color(PALETTE.groundSheen), 0.6),
    roughness: 0.55,
    metalness: 0.4,
    side: THREE.DoubleSide,
  })
  if (masts) mat.defines = { SR2_MASTS: '' }
  mat.customProgramCacheKey = () => (masts ? 'sr2-stadium-mast-v1' : 'sr2-stadium-stands-v1')
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uAccent = { value: accent }
    shader.uniforms.uLightBar = { value: lightBar }
    shader.uniforms.uTierLine = { value: tierLine }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aV;\nattribute float aU;\nattribute float aKind;\nattribute float aGlow;\nvarying float vV;\nvarying float vU;\nvarying float vKind;\nvarying float vGlowS;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vV = aV;
vU = aU;
vKind = aKind;
#ifdef SR2_MASTS
vGlowS = aGlow;
#else
vGlowS = 0.0;
#endif`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uAccent;\nuniform vec3 uLightBar;\nuniform vec3 uTierLine;\nvarying float vV;\nvarying float vU;\nvarying float vKind;\nvarying float vGlowS;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
{
  // Seats: a faint line every fifth tier, and one accent ring halfway up.
  float seats = 1.0 - step( 0.5, abs( vKind - 1.0 ) );
  float tierCoord = vV * ${(TIERS / 5).toFixed(1)};
  float fw = fwidth( tierCoord );
  float line = 1.0 - smoothstep( fw * 0.6, fw * 1.6, abs( fract( tierCoord ) - 0.5 ) );
  float middle = 1.0 - smoothstep( fw * 0.6, fw * 1.6, abs( vV * ${(TIERS / 5).toFixed(1)} - ${(TIERS / 10).toFixed(1)} ) );
  totalEmissiveRadiance += seats * ( line * uTierLine + middle * uAccent * 0.8 );
  // Every row of seats, very faint: texture when you are close, nothing far away.
  float rowCoord = vV * ${TIERS.toFixed(1)};
  float rfw = fwidth( rowCoord );
  float row = ( 1.0 - smoothstep( rfw * 0.6, rfw * 1.6, abs( fract( rowCoord ) - 0.5 ) ) ) * ( 1.0 - smoothstep( 0.15, 0.4, rfw ) );
  totalEmissiveRadiance += seats * row * uTierLine * 0.45;
  // The front wall: an accent stripe along its top and faint panel seams every 8 m.
  float front = 1.0 - step( 0.5, abs( vKind - 5.0 ) );
  float stripe = smoothstep( 0.8, 0.84, vV ) * ( 1.0 - smoothstep( 0.9, 0.94, vV ) );
  float seamCoord = vU / 8.0;
  float sfw = fwidth( seamCoord );
  float seam = ( 1.0 - smoothstep( sfw * 0.6, sfw * 1.6, abs( fract( seamCoord ) - 0.5 ) ) ) * ( 1.0 - smoothstep( 0.15, 0.4, sfw ) );
  totalEmissiveRadiance += front * ( stripe * uAccent * 0.9 + seam * uTierLine * 0.6 );
  // The rim of the stands and the canopy's front edge are rings of light.
  float rim = 1.0 - step( 0.5, abs( vKind - 4.0 ) );
  float bar = 1.0 - step( 0.5, abs( vKind - 3.0 ) );
  totalEmissiveRadiance += uLightBar * bar + uAccent * rim;
  totalEmissiveRadiance += uLightBar * vGlowS;
}`,
      )
  }
  return mat
}

export function Stadium({ track, quality }: { track: TrackRuntime; quality: QualityLevel }) {
  // The stands take the track's SECOND accent, so they never compete with the road's edge strips.
  const accentHex = track.file.environment.palette?.edgeAlt || PALETTE.roadEdgeAlt
  const seed = track.file.environment.seed

  const line = useMemo(() => (track.file.environment.stadium ? standLine(track) : null), [track])
  const standMat = useMemo(() => makeStructureMaterial(accentHex, false), [accentHex])
  const mastMat = useMemo(() => makeStructureMaterial(accentHex, true), [accentHex])
  const crowdMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uTime: skyUniforms.uTime,
          uWarm: { value: new THREE.Color(PALETTE.cityWindowWarm).multiplyScalar(GLOW.T1) },
          uCool: { value: new THREE.Color(PALETTE.laneLine).multiplyScalar(GLOW.T1) },
          uPink: { value: new THREE.Color(PALETTE.roadEdge).multiplyScalar(GLOW.T1) },
          uCyan: { value: new THREE.Color(PALETTE.roadEdgeAlt).multiplyScalar(GLOW.T1) },
        },
        vertexShader: crowdVertex,
        fragmentShader: crowdFragment,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      }),
    [],
  )

  const parts = useMemo(() => {
    if (!line) return null
    const stands = new THREE.Mesh(buildStandsGeometry(line), standMat)
    stands.name = 'world-stadium-stands'
    stands.receiveShadow = true
    const masts = buildMasts(line, mastMat)
    masts.name = 'world-stadium-masts'
    const crowd = new THREE.Points(buildCrowd(line, quality, seed ^ 0xc20d), crowdMat)
    crowd.name = 'world-stadium-crowd'
    crowd.frustumCulled = false
    return { stands, masts, crowd }
  }, [line, quality, seed, standMat, mastMat, crowdMat])

  useEffect(() => {
    if (!parts) {
      worldStats.stadiumTriangles = 0
      worldStats.crowdLights = 0
      return
    }
    worldStats.stadiumTriangles =
      (parts.stands.geometry.index?.count ?? 0) / 3 + (parts.masts.count * (parts.masts.geometry.index?.count ?? 0)) / 3
    worldStats.crowdLights = parts.crowd.geometry.getAttribute('position').count
    return () => {
      parts.stands.geometry.dispose()
      parts.masts.geometry.dispose()
      parts.masts.dispose()
      parts.crowd.geometry.dispose()
    }
  }, [parts])
  useEffect(
    () => () => {
      standMat.dispose()
      mastMat.dispose()
      crowdMat.dispose()
    },
    [standMat, mastMat, crowdMat],
  )

  if (!parts) return null
  return (
    <group name="world-stadium">
      <primitive object={parts.stands} />
      <primitive object={parts.masts} />
      <primitive object={parts.crowd} />
    </group>
  )
}

/** The stand front is solid: a chain of boxes along it. Mount inside <Physics>. */
export function StadiumColliders({ track }: { track: TrackRuntime }) {
  const { world, rapier } = useRapier()

  useEffect(() => {
    if (!track.file.environment.stadium) return
    const line = standLine(track)
    const body = world.createRigidBody(rapier.RigidBodyDesc.fixed())
    const handles: number[] = []
    const halfT = 1.5
    for (let k = 0; k < line.count; k++) {
      const k2 = (k + 1) % line.count
      const x0 = line.fx[k]
      const z0 = line.fz[k]
      const x1 = line.fx[k2]
      const z1 = line.fz[k2]
      const len = Math.hypot(x1 - x0, z1 - z0)
      if (!(len > 0.01) || !Number.isFinite(len)) continue
      const yaw = Math.atan2(-(z1 - z0), x1 - x0)
      const hy = (FRONT_H + 6) / 2
      const g = Math.min(line.ground[k], line.ground[k2])
      // Centred half a box-thickness outward, so the wall face sits on the stand front.
      const mx = (x0 + x1) / 2 + line.ox[k] * halfT
      const mz = (z0 + z1) / 2 + line.oz[k] * halfT
      const desc = rapier.ColliderDesc.cuboid(len / 2 + 0.6, hy, halfT)
        .setTranslation(mx, g - 1 + hy, mz)
        .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) })
        .setCollisionGroups(GROUPS.world)
        .setSolverGroups(GROUPS.world)
        .setFriction(0.2)
        .setRestitution(0.1)
      const c = world.createCollider(desc, body)
      tagSurface(c.handle, 'barrier')
      handles.push(c.handle)
    }
    return () => {
      for (const h of handles) untagSurface(h)
      if (world.getRigidBody(body.handle) === body) world.removeRigidBody(body)
    }
  }, [track, world, rapier])

  return null
}
