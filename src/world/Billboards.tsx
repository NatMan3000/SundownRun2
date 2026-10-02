// ============================================================
//  HOLOGRAPHIC BILLBOARDS - neon ads along the run
// ------------------------------------------------------------
//  The track puts its billboards beside the road
//  (track.roadside.billboards: a spot on the ground and the way it
//  faces). Each one is:
//
//    - a slim dark pole with a violet light strip and a projector
//      head on top (solid: every pole collides, so you can crash
//      into any of them - the constitution's consistency rule);
//    - a floating hologram panel above it showing one of the ads
//      from billboardArt.ts, with moving scanlines, a slow bright
//      sweep, a gentle flicker, and a fade when seen edge-on. It is
//      light, so it shows from both sides, and from behind the art
//      is flipped so the words never read backwards.
//
//  All the poles are ONE instanced draw; all the panels are another.
//  <BillboardColliders /> (mounted by <WorldPhysics /> inside the
//  physics world) gives each pole its collider, tagged 'billboard'.
//
//  Glow: poles T0 with a T1 strip, panel art T1.
// ============================================================

import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { useRapier } from '@react-three/rapier'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { GLOW, PALETTE } from '../core/palette'
import { GROUPS, tagCollider, tagSurface, untagCollider, untagSurface } from '../core/physics'
import type { TrackRuntime } from '../track/types'
import { ATLAS_COLS, ATLAS_ROWS, AD_COUNT, makeBillboardAtlas } from './billboardArt'
import { skyUniforms } from './sky'
import { worldStats } from './stats'

/** Pole size, metres. */
const POLE_W = 0.7
const POLE_H = 10.6
/** Panel size and the height of its bottom edge above the ground, metres. */
const PANEL_W = 13
const PANEL_H = 6.5
const PANEL_Y = 11.4

// ---------------------------------------------------------------- the pole

function box(w: number, h: number, d: number, x: number, y: number, z: number, glow: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d)
  g.translate(x, y, z)
  g.setAttribute('aGlow', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count).fill(glow), 1))
  return g
}

/** One pole: plinth (sunk into the ground for slopes), pole, projector head, light strips. Local -z faces the road. */
function makePoleGeometry(): THREE.BufferGeometry {
  const parts = [
    box(1.8, 1.8, 1.8, 0, -0.3, 0, 0),
    box(POLE_W, POLE_H, POLE_W, 0, POLE_H / 2, 0, 0),
    box(1.8, 0.7, 1.2, 0, POLE_H + 0.1, 0, 0),
    box(0.12, POLE_H - 1.6, 0.08, 0, POLE_H / 2 + 0.4, -POLE_W / 2 - 0.03, 1),
    box(0.12, POLE_H - 1.6, 0.08, 0, POLE_H / 2 + 0.4, POLE_W / 2 + 0.03, 1),
    box(1.5, 0.08, 0.9, 0, POLE_H + 0.49, 0, 1),
  ]
  const merged = mergeGeometries(parts, false)
  for (const p of parts) p.dispose()
  if (!merged) throw new Error('[world] billboard pole geometry failed to merge')
  return merged
}

// ---------------------------------------------------------------- the hologram panel

const panelVertex = /* glsl */ `
attribute float aCell;
attribute float aSeed;
varying vec2 vUv;
varying vec2 vAtlasUv;
varying float vSeed;
varying float vFacing;
void main() {
  vUv = uv;
  mat4 toWorld = modelMatrix * instanceMatrix;
  vec4 w = toWorld * vec4( position, 1.0 );
  vec3 n = normalize( mat3( toWorld ) * vec3( 0.0, 0.0, 1.0 ) );
  // A hologram is light, so it is seen from both sides. From behind, flip the
  // art left-to-right so the words still read the right way round. Decided
  // once per panel (from its centre), so a panel never shows half of each.
  vec3 centre = ( toWorld * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
  float behind = step( dot( n, cameraPosition - centre ), 0.0 );
  float u = mix( uv.x, 1.0 - uv.x, behind );
  float col = mod( aCell, ${ATLAS_COLS.toFixed(1)} );
  float row = floor( aCell / ${ATLAS_COLS.toFixed(1)} );
  // Canvas row 0 is at the top of the texture (flipY): count rows down from v = 1.
  vAtlasUv = vec2( ( col + u ) / ${ATLAS_COLS.toFixed(1)}, 1.0 - ( row + 1.0 - uv.y ) / ${ATLAS_ROWS.toFixed(1)} );
  vSeed = aSeed;
  vFacing = abs( dot( n, normalize( cameraPosition - w.xyz ) ) );
  gl_Position = projectionMatrix * viewMatrix * w;
}
`

const panelFragment = /* glsl */ `
uniform sampler2D uAtlas;
uniform float uTime;
uniform float uGlow;
uniform vec3 uEdge;
varying vec2 vUv;
varying vec2 vAtlasUv;
varying float vSeed;
varying float vFacing;
void main() {
  vec3 art = texture2D( uAtlas, vAtlasUv ).rgb;
  // Fine scanlines drifting up, and a slow bright band sweeping the panel.
  float scan = 0.8 + 0.2 * sin( vUv.y * 170.0 - uTime * 5.0 );
  float sweepY = fract( uTime * 0.11 + vSeed );
  float sx = ( vUv.y - sweepY ) * 9.0; // squared as x * x: pow() of a negative number is NaN
  float sweep = 1.0 + 0.45 * exp( -sx * sx );
  // A gentle flicker, different on every panel (never a hard blink).
  float flicker = 0.93 + 0.07 * sin( uTime * 19.0 + vSeed * 40.0 ) * sin( uTime * 6.1 + vSeed * 11.0 );
  // A faint frame of light so the panel reads as a solid sheet of hologram.
  vec2 e = min( vUv, 1.0 - vUv );
  float frame = 1.0 - smoothstep( 0.0, 0.025, min( e.x, e.y * 2.0 ) );
  vec3 col = ( art * scan * sweep + uEdge * ( frame * 0.6 + 0.04 ) ) * flicker * uGlow;
  // Seen edge-on, a hologram thins away.
  col *= smoothstep( 0.05, 0.35, vFacing );
  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

interface BillboardSet {
  poles: THREE.InstancedMesh
  panels: THREE.InstancedMesh
  dispose: () => void
}

function buildBillboards(track: TrackRuntime, poleMat: THREE.Material, panelMat: THREE.Material): BillboardSet | null {
  const spots = track.roadside.billboards
  if (spots.length === 0) return null
  const poleGeo = makePoleGeometry()
  const panelGeo = new THREE.PlaneGeometry(PANEL_W, PANEL_H)
  const poles = new THREE.InstancedMesh(poleGeo, poleMat, spots.length)
  const panels = new THREE.InstancedMesh(panelGeo, panelMat, spots.length)
  const cell = new Float32Array(spots.length)
  const seed = new Float32Array(spots.length)
  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const p = new THREE.Vector3()
  const s = new THREE.Vector3(1, 1, 1)
  const up = new THREE.Vector3(0, 1, 0)
  for (let i = 0; i < spots.length; i++) {
    const b = spots[i]
    q.setFromAxisAngle(up, b.heading)
    p.set(b.x, b.y, b.z)
    m.compose(p, q, s)
    poles.setMatrixAt(i, m)
    // The panel's front (+z of the plane) must face the road, which is local -z of the pole.
    q.setFromAxisAngle(up, b.heading + Math.PI)
    p.set(b.x, b.y + PANEL_Y + PANEL_H / 2, b.z)
    m.compose(p, q, s)
    panels.setMatrixAt(i, m)
    cell[i] = (i * 3 + Math.floor(track.file.environment.seed % AD_COUNT)) % AD_COUNT
    seed[i] = ((i * 0.6180339) + 0.17) % 1
  }
  panelGeo.setAttribute('aCell', new THREE.InstancedBufferAttribute(cell, 1))
  panelGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 1))
  poles.instanceMatrix.needsUpdate = true
  panels.instanceMatrix.needsUpdate = true
  poles.castShadow = true
  poles.receiveShadow = true
  poles.computeBoundingSphere()
  panels.computeBoundingSphere()
  poles.name = 'world-billboard-poles'
  panels.name = 'world-billboard-panels'
  panels.renderOrder = 10
  return {
    poles,
    panels,
    dispose: () => {
      poleGeo.dispose()
      panelGeo.dispose()
      poles.dispose()
      panels.dispose()
    },
  }
}

export function Billboards({ track }: { track: TrackRuntime }) {
  const atlas = useMemo(() => makeBillboardAtlas(), [])
  const { poleMat, panelMat } = useMemo(() => {
    const accent = new THREE.Color(PALETTE.grid).multiplyScalar(GLOW.T1)
    const poleMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(PALETTE.citySilhouette).lerp(new THREE.Color(PALETTE.groundSheen), 0.5),
      roughness: 0.35,
      metalness: 0.7,
    })
    poleMat.onBeforeCompile = (shader) => {
      shader.uniforms.uAccent = { value: accent }
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aGlow;\nvarying float vGlow;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aGlow;')
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uAccent;\nvarying float vGlow;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += uAccent * vGlow;')
    }
    poleMat.customProgramCacheKey = () => 'sr2-billboard-pole-v1'
    const panelMat = new THREE.ShaderMaterial({
      uniforms: {
        uAtlas: { value: atlas },
        uTime: skyUniforms.uTime,
        uGlow: { value: GLOW.T1 },
        uEdge: { value: new THREE.Color(PALETTE.roadEdgeAlt) },
      },
      vertexShader: panelVertex,
      fragmentShader: panelFragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
    })
    return { poleMat, panelMat }
  }, [atlas])

  const set = useMemo(() => buildBillboards(track, poleMat, panelMat), [track, poleMat, panelMat])

  useEffect(() => {
    worldStats.billboards = set ? set.poles.count : 0
    worldStats.billboardTriangles = set ? set.poles.count * (((set.poles.geometry.index?.count ?? 0) + 6) / 3) : 0
    return () => set?.dispose()
  }, [set])
  useEffect(
    () => () => {
      poleMat.dispose()
      panelMat.dispose()
      atlas.dispose()
    },
    [poleMat, panelMat, atlas],
  )

  if (!set) return null
  return (
    <group name="world-billboards">
      <primitive object={set.poles} />
      <primitive object={set.panels} />
    </group>
  )
}

// ---------------------------------------------------------------- the solid poles

/** Every pole is solid: a box collider in the world group, tagged as a billboard. Mount inside <Physics>. */
export function BillboardColliders({ track }: { track: TrackRuntime }) {
  const { world, rapier } = useRapier()

  useEffect(() => {
    const spots = track.roadside.billboards
    if (spots.length === 0) return
    const body = world.createRigidBody(rapier.RigidBodyDesc.fixed())
    const handles: number[] = []
    for (let i = 0; i < spots.length; i++) {
      const b = spots[i]
      if (!Number.isFinite(b.x) || !Number.isFinite(b.y) || !Number.isFinite(b.z) || !Number.isFinite(b.heading)) {
        console.error('[world] billboard', i, 'has a non-finite position; no collider built for it')
        continue
      }
      // The pole, from a metre underground to its head; the head and plinth are a touch wider.
      const pole = rapier.ColliderDesc.cuboid(POLE_W / 2 + 0.1, (POLE_H + 1.5) / 2, POLE_W / 2 + 0.1)
        .setTranslation(b.x, b.y + (POLE_H + 1.5) / 2 - 1, b.z)
        .setRotation({ x: 0, y: Math.sin(b.heading / 2), z: 0, w: Math.cos(b.heading / 2) })
        .setCollisionGroups(GROUPS.world)
        .setSolverGroups(GROUPS.world)
        .setFriction(0.4)
        .setRestitution(0.1)
      const plinth = rapier.ColliderDesc.cuboid(0.9, 0.9, 0.9)
        .setTranslation(b.x, b.y - 0.3, b.z)
        .setRotation({ x: 0, y: Math.sin(b.heading / 2), z: 0, w: Math.cos(b.heading / 2) })
        .setCollisionGroups(GROUPS.world)
        .setSolverGroups(GROUPS.world)
        .setFriction(0.4)
        .setRestitution(0.1)
      for (const desc of [pole, plinth]) {
        const c = world.createCollider(desc, body)
        tagSurface(c.handle, 'barrier')
        tagCollider(c.handle, { kind: 'billboard', id: `billboard-${i}` })
        handles.push(c.handle)
      }
    }
    return () => {
      for (const h of handles) {
        untagSurface(h)
        untagCollider(h)
      }
      // A replaced physics world has already freed this body; only remove it from its owner.
      if (world.getRigidBody(body.handle) === body) world.removeRigidBody(body)
    }
  }, [track, world, rapier])

  return null
}
