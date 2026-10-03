// ============================================================
//  HOLOGRAPHIC BILLBOARDS - neon ads along the run
// ------------------------------------------------------------
//  The track puts its billboard spots beside the road
//  (track.roadside.billboards: a spot on the ground and the way it
//  faces). billboardPlan.ts picks what stands on each spot: one of
//  five kinds (billboardKinds.ts: a wide panel, a tall banner, a
//  small sign, a big double screen, a spinning cube) and which of
//  the ads (./ads) it shows. Then this file builds them:
//
//    - the frames (poles, masts, legs, projector heads, the big
//      screens' dark boxes and the violet light strips) are merged
//      into ONE mesh, so all of them are one draw;
//    - every picture is one instance of ONE instanced quad. The
//      shader sizes it, turns the cube sides, picks the ad from
//      the texture array (billboardArt.ts) and draws the look:
//        hologram   moving scanlines, a slow bright sweep, a gentle
//                   flicker, a fade when seen edge-on, and the art
//                   flipped from behind so words never read
//                   backwards;
//        screen     lit dots up close, flipping between two ads
//                   with a bright wipe every few seconds;
//        cube side  a hologram that spins with the cube; the sides
//                   facing away are hidden.
//
//  <BillboardColliders /> (mounted by <WorldPhysics /> inside the
//  physics world) makes every solid frame box a collider, tagged
//  'billboard': every pole, mast, leg and screen is solid (the
//  constitution's consistency rule).
//
//  Glow: frames T0 with T1 strips, pictures T1 (big screens and
//  cubes a little under).
// ============================================================

import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { useRapier } from '@react-three/rapier'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { registerDev, registerInspector } from '../core/devHandles'
import { GLOW, PALETTE } from '../core/palette'
import { GROUPS, tagCollider, tagSurface, untagCollider, untagSurface } from '../core/physics'
import type { TrackRuntime } from '../track/types'
import { ALL_ADS } from './ads'
import { adRect, billboardLayout, billboardTextureMB, makeBillboardTexture, paintPage, paintStats } from './billboardArt'
import { CUBE_SPIN, KINDS, SCREEN_HOLD } from './billboardKinds'
import { planBillboards, planSummary, type BoardPlan } from './billboardPlan'
import { skyUniforms } from './sky'
import { worldStats } from './stats'

// ---------------------------------------------------------------- the frames

/** Every frame box of every billboard, in world space, merged into one geometry. */
function makeFrameGeometry(plans: BoardPlan[]): THREE.BufferGeometry | null {
  const parts: THREE.BufferGeometry[] = []
  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const p = new THREE.Vector3()
  const one = new THREE.Vector3(1, 1, 1)
  const up = new THREE.Vector3(0, 1, 0)
  for (const b of plans) {
    q.setFromAxisAngle(up, b.heading)
    p.set(b.x, b.y, b.z)
    m.compose(p, q, one)
    for (const f of KINDS[b.kind].frame) {
      const g = new THREE.BoxGeometry(f.w, f.h, f.d)
      g.translate(f.x, f.y, f.z)
      g.applyMatrix4(m)
      g.setAttribute('aGlow', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count).fill(f.glow), 1))
      parts.push(g)
    }
  }
  if (parts.length === 0) return null
  const merged = mergeGeometries(parts, false)
  for (const g of parts) g.dispose()
  if (!merged) throw new Error('[world] billboard frame geometry failed to merge')
  return merged
}

// ---------------------------------------------------------------- the pictures

const panelVertex = /* glsl */ `
attribute vec4 aRectA; // ad A's box in its page: u0, v0 (from the top), width, height
attribute vec4 aRectB; // ad B (a screen's second ad; the same as A everywhere else)
attribute vec2 aPage;  // the pages of A and B
attribute vec4 aShape; // width, height, forward (toward the road), the side's own turn
attribute vec3 aLook;  // style (0 hologram, 1 screen, 2 cube side), brightness, seed
uniform float uTime;
uniform float uSpin;
uniform float uHold;
varying vec2 vUv;
varying vec2 vUvA;
varying vec2 vUvB;
varying vec2 vPage;
varying float vSeed;
varying float vFacing;
varying float vGlow;
varying float vHolo;
varying float vLed;
varying float vWipe;
varying float vShowB;
void main() {
  vUv = uv;
  float style = aLook.x;
  float isCube = step( 1.5, style );
  float isScreen = step( 0.5, style ) * ( 1.0 - isCube );
  // Turn this side about the upright axis: a cube side by its place on the cube plus the spin.
  float ang = aShape.w + isCube * uTime * uSpin;
  float ca = cos( ang );
  float sa = sin( ang );
  vec3 p = vec3( position.xy * aShape.xy, aShape.z );
  p = vec3( p.x * ca + p.z * sa, p.y, -p.x * sa + p.z * ca );
  vec3 nLocal = vec3( sa, 0.0, ca );
  vec3 cLocal = nLocal * aShape.z;
  mat4 toWorld = modelMatrix * instanceMatrix;
  vec4 w = toWorld * vec4( p, 1.0 );
  vec3 n = normalize( mat3( toWorld ) * nLocal );
  vec3 centre = ( toWorld * vec4( cLocal, 1.0 ) ).xyz;
  // A hologram is light, so it shows from both sides; from behind, flip the art left to
  // right so words still read the right way round. Decided once per picture (from its
  // centre), so a picture never shows half of each.
  float behind = step( dot( n, cameraPosition - centre ), 0.0 );
  float u = mix( uv.x, 1.0 - uv.x, behind );
  vec2 inAd = vec2( u, 1.0 - uv.y ); // pages count v down from the top
  vUvA = aRectA.xy + inAd * aRectA.zw;
  vUvB = aRectB.xy + inAd * aRectB.zw;
  vPage = aPage;
  vSeed = aLook.z;
  vGlow = aLook.y;
  vHolo = 1.0 - isScreen;
  vFacing = abs( dot( n, normalize( cameraPosition - w.xyz ) ) );
  // Screen dots only up close (far away they would shimmer).
  vLed = isScreen * clamp( 1.0 - distance( cameraPosition, centre ) / 110.0, 0.0, 1.0 );
  // A screen shows A, wipes to B, shows B, wipes back. tt runs over one whole cycle.
  float cycle = 2.0 * uHold;
  float tt = mod( uTime + aLook.z * cycle, cycle );
  float second = step( uHold, tt );
  float wipe = clamp( ( tt - second * uHold ) / 0.9, 0.0, 1.0 );
  vWipe = mix( 1.0, wipe, isScreen );
  vShowB = second * isScreen;
  gl_Position = projectionMatrix * viewMatrix * w;
  // A cube side facing away is hidden (pushed outside the view), so the cube reads solid.
  if ( isCube * behind > 0.5 ) gl_Position = vec4( 0.0, 0.0, 2.0, 1.0 );
}
`

const panelFragment = /* glsl */ `
precision highp sampler2DArray;
uniform sampler2DArray uPages;
uniform float uTime;
uniform float uGlow;
uniform vec3 uEdge;
varying vec2 vUv;
varying vec2 vUvA;
varying vec2 vUvB;
varying vec2 vPage;
varying float vSeed;
varying float vFacing;
varying float vGlow;
varying float vHolo;
varying float vLed;
varying float vWipe;
varying float vShowB;
void main() {
  // Both ads are always read (no branching round a texture read: Windows' Direct3D path
  // needs texture reads in plain, unbranched code). Most pictures show the same ad twice.
  vec3 artA = texture( uPages, vec3( vUvA, vPage.x ) ).rgb;
  vec3 artB = texture( uPages, vec3( vUvB, vPage.y ) ).rgb;
  // Left of the wipe line shows the ad we're wiping to.
  float wiped = step( vUv.x, vWipe );
  float showB = mix( 1.0 - wiped, wiped, vShowB );
  vec3 art = mix( artA, artB, showB );
  float wx = ( vUv.x - vWipe ) * 60.0; // squared as x * x: pow() of a negative number is NaN
  float wipeLine = exp( -wx * wx ) * step( vWipe, 0.999 );
  // Hologram: fine scanlines drifting up, a slow bright band sweeping the panel, a flicker.
  float scan = 0.8 + 0.2 * sin( vUv.y * 170.0 - uTime * 5.0 );
  float sweepY = fract( uTime * 0.11 + vSeed );
  float sx = ( vUv.y - sweepY ) * 9.0;
  float sweep = 1.0 + 0.45 * exp( -sx * sx );
  float flicker = 0.93 + 0.07 * sin( uTime * 19.0 + vSeed * 40.0 ) * sin( uTime * 6.1 + vSeed * 11.0 );
  float holo = scan * sweep * flicker;
  // Screen: a grid of lit dots, 96 across and 48 down, fading out with distance.
  vec2 cellF = fract( vUv * vec2( 96.0, 48.0 ) ) - 0.5;
  float dotMask = 1.0 - smoothstep( 0.08, 0.2, dot( cellF, cellF ) );
  float led = mix( 1.0, 0.5 + 0.85 * dotMask, vLed );
  float look = mix( led, holo, vHolo );
  // A faint frame of light so the picture reads as a solid sheet.
  vec2 e = min( vUv, 1.0 - vUv );
  float frame = 1.0 - smoothstep( 0.0, 0.025, min( e.x, e.y * 2.0 ) );
  // (A screen gets less of the faint all-over sheet: its dark box should read as dark.)
  vec3 col = ( art * look + uEdge * ( frame * 0.6 + mix( 0.012, 0.04, vHolo ) + wipeLine * 0.8 ) ) * uGlow * vGlow;
  // Seen edge-on, a hologram thins away (a screen stays: it is a real screen).
  col *= mix( 1.0, smoothstep( 0.05, 0.35, vFacing ), vHolo );
  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

interface BillboardSet {
  frames: THREE.Mesh | null
  panels: THREE.InstancedMesh
  pictures: number
  dispose: () => void
}

function buildBillboards(plans: BoardPlan[], frameMat: THREE.Material, panelMat: THREE.Material): BillboardSet | null {
  if (plans.length === 0) return null
  const frameGeo = makeFrameGeometry(plans)
  const frames = frameGeo ? new THREE.Mesh(frameGeo, frameMat) : null
  let count = 0
  for (const b of plans) count += b.kind === 'cube' ? 4 : 1
  const panelGeo = new THREE.PlaneGeometry(1, 1)
  // The quad is sized in the shader, so give culling the size of the biggest picture.
  panelGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 20)
  const panels = new THREE.InstancedMesh(panelGeo, panelMat, count)
  const rectA = new Float32Array(count * 4)
  const rectB = new Float32Array(count * 4)
  const page = new Float32Array(count * 2)
  const shape = new Float32Array(count * 4)
  const look = new Float32Array(count * 3)
  const { cells } = billboardLayout()
  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const p = new THREE.Vector3()
  const one = new THREE.Vector3(1, 1, 1)
  const up = new THREE.Vector3(0, 1, 0)
  let k = 0
  plans.forEach((b, bi) => {
    const spec = KINDS[b.kind]
    // The picture's front (+z of the quad) must face the road, which is local -z of the frame.
    q.setFromAxisAngle(up, b.heading + Math.PI)
    p.set(b.x, b.y + spec.panelMidY, b.z)
    m.compose(p, q, one)
    const sides = b.kind === 'cube' ? 4 : 1
    for (let side = 0; side < sides; side++) {
      const a = b.ads[side % b.ads.length]
      const bAd = b.kind === 'screen' ? b.ads[1] : a
      panels.setMatrixAt(k, m)
      rectA.set(adRect(a), k * 4)
      rectB.set(adRect(bAd), k * 4)
      page[k * 2] = cells[a].page
      page[k * 2 + 1] = cells[bAd].page
      shape.set([spec.panelW, spec.panelH, spec.panelForward, (side * Math.PI) / 2], k * 4)
      look.set([spec.style, spec.glow, ((bi * 0.6180339 + side * 0.25 + 0.17) % 1)], k * 3)
      k++
    }
  })
  panelGeo.setAttribute('aRectA', new THREE.InstancedBufferAttribute(rectA, 4))
  panelGeo.setAttribute('aRectB', new THREE.InstancedBufferAttribute(rectB, 4))
  panelGeo.setAttribute('aPage', new THREE.InstancedBufferAttribute(page, 2))
  panelGeo.setAttribute('aShape', new THREE.InstancedBufferAttribute(shape, 4))
  panelGeo.setAttribute('aLook', new THREE.InstancedBufferAttribute(look, 3))
  panels.instanceMatrix.needsUpdate = true
  panels.computeBoundingSphere()
  panels.name = 'world-billboard-panels'
  panels.renderOrder = 10
  if (frames) {
    frames.castShadow = true
    frames.receiveShadow = true
    frames.name = 'world-billboard-poles'
  }
  return {
    frames,
    panels,
    pictures: count,
    dispose: () => {
      frameGeo?.dispose()
      panelGeo.dispose()
      panels.dispose()
    },
  }
}

/** How many billboard colliders the physics world has (for the inspector). */
const colliderCount = { value: 0 }

// ---------------------------------------------------------------- the contact sheet (dev)

/** Show one page of ads full size over the game (null hides it): the contact sheet. */
function showAdSheet(page: number | null): string {
  document.getElementById('sr2-ad-sheet')?.remove()
  const { pages } = billboardLayout()
  if (page === null || page === undefined) return 'hidden'
  const n = Math.max(0, Math.min(pages - 1, Math.floor(page)))
  const wrap = document.createElement('div')
  wrap.id = 'sr2-ad-sheet'
  wrap.style.cssText = `position:fixed;inset:0;z-index:99999;background:${PALETTE.uiPanelSolid};display:flex;align-items:center;justify-content:center;gap:24px;font:600 18px system-ui;color:${PALETTE.uiText}`
  const canvas = paintPage(n)
  canvas.style.cssText = `width:1024px;height:1024px;outline:1px solid ${PALETTE.uiLine}`
  const list = document.createElement('div')
  list.style.cssText = 'display:flex;flex-direction:column;gap:6px;max-height:1024px;overflow:hidden'
  const { cells } = billboardLayout()
  list.innerHTML = `<div style="color:${PALETTE.uiAccent}">PAGE ${n + 1} OF ${pages}</div>`
  ALL_ADS.forEach((ad, i) => {
    if (cells[i].page !== n) return
    const row = document.createElement('div')
    row.textContent = `${i}. ${ad.name} (${ad.shape})`
    list.appendChild(row)
  })
  wrap.appendChild(canvas)
  wrap.appendChild(list)
  document.body.appendChild(wrap)
  return `page ${n + 1} of ${pages}`
}

export function Billboards({ track }: { track: TrackRuntime }) {
  const pages = useMemo(() => makeBillboardTexture(), [])
  const { frameMat, panelMat } = useMemo(() => {
    const accent = new THREE.Color(PALETTE.grid).multiplyScalar(GLOW.T1)
    const frameMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(PALETTE.citySilhouette).lerp(new THREE.Color(PALETTE.groundSheen), 0.5),
      roughness: 0.35,
      metalness: 0.7,
    })
    frameMat.onBeforeCompile = (shader) => {
      shader.uniforms.uAccent = { value: accent }
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aGlow;\nvarying float vGlow;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aGlow;')
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uAccent;\nvarying float vGlow;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += uAccent * vGlow;')
    }
    frameMat.customProgramCacheKey = () => 'sr2-billboard-pole-v1'
    const panelMat = new THREE.ShaderMaterial({
      uniforms: {
        uPages: { value: pages },
        uTime: skyUniforms.uTime,
        uGlow: { value: GLOW.T1 },
        uEdge: { value: new THREE.Color(PALETTE.roadEdgeAlt) },
        uSpin: { value: CUBE_SPIN },
        uHold: { value: SCREEN_HOLD },
      },
      vertexShader: panelVertex,
      fragmentShader: panelFragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
    })
    return { frameMat, panelMat }
  }, [pages])

  const plans = useMemo(() => planBillboards(track), [track])
  const set = useMemo(() => buildBillboards(plans, frameMat, panelMat), [plans, frameMat, panelMat])

  useEffect(() => {
    worldStats.billboards = plans.length
    worldStats.billboardTriangles = set ? ((set.frames?.geometry.index?.count ?? 0) + set.pictures * 6) / 3 : 0
    const offInspector = registerInspector('billboards', () => ({
      ...planSummary(plans),
      pictures: set?.pictures ?? 0,
      texture: { pages: billboardLayout().pages, size: '1024x1024', megabytes: billboardTextureMB(), paintMs: paintStats.ms },
      draws: { frames: set?.frames ? 1 : 0, pictures: set ? 1 : 0 },
      colliders: colliderCount.value,
      boards: plans.map((b) => ({
        s: Math.round(b.s),
        kind: b.kind,
        ads: b.ads.map((a) => ALL_ADS[a].name),
        x: Number(b.x.toFixed(2)),
        y: Number(b.y.toFixed(2)),
        z: Number(b.z.toFixed(2)),
        heading: Number(b.heading.toFixed(4)),
      })),
    }))
    return () => {
      offInspector()
      set?.dispose()
    }
  }, [plans, set])
  useEffect(() => {
    const offSheet = registerDev('adSheet', (page: number | null) => showAdSheet(page), 'adSheet(page): show one page of billboard ads full size (0, 1, ...); adSheet(null) hides it.')
    return () => {
      offSheet()
      document.getElementById('sr2-ad-sheet')?.remove()
      frameMat.dispose()
      panelMat.dispose()
      pages.dispose()
    }
  }, [frameMat, panelMat, pages])

  if (!set) return null
  return (
    <group name="world-billboards">
      {set.frames && <primitive object={set.frames} />}
      <primitive object={set.panels} />
    </group>
  )
}

// ---------------------------------------------------------------- the solid frames

/** Every solid frame box is a collider in the world group, tagged as a billboard. Mount inside <Physics>. */
export function BillboardColliders({ track }: { track: TrackRuntime }) {
  const { world, rapier } = useRapier()

  useEffect(() => {
    const plans = planBillboards(track)
    if (plans.length === 0) return
    const body = world.createRigidBody(rapier.RigidBodyDesc.fixed())
    const handles: number[] = []
    for (let i = 0; i < plans.length; i++) {
      const b = plans[i]
      if (!Number.isFinite(b.x) || !Number.isFinite(b.y) || !Number.isFinite(b.z) || !Number.isFinite(b.heading)) {
        console.error('[world] billboard', i, 'has a non-finite position; no collider built for it')
        continue
      }
      const cos = Math.cos(b.heading)
      const sin = Math.sin(b.heading)
      const rot = { x: 0, y: Math.sin(b.heading / 2), z: 0, w: Math.cos(b.heading / 2) }
      for (const f of KINDS[b.kind].frame) {
        if (!f.solid) continue
        // The box's place in the world: its local offset turned by the heading.
        const desc = rapier.ColliderDesc.cuboid(f.w / 2 + 0.05, f.h / 2, f.d / 2 + 0.05)
          .setTranslation(b.x + f.x * cos + f.z * sin, b.y + f.y, b.z - f.x * sin + f.z * cos)
          .setRotation(rot)
          .setCollisionGroups(GROUPS.world)
          .setSolverGroups(GROUPS.world)
          .setFriction(0.4)
          .setRestitution(0.1)
        const c = world.createCollider(desc, body)
        tagSurface(c.handle, 'barrier')
        tagCollider(c.handle, { kind: 'billboard', id: `billboard-${i}` })
        handles.push(c.handle)
      }
    }
    colliderCount.value = handles.length
    return () => {
      colliderCount.value = 0
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
