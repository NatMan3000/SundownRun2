// ============================================================
//  BRIDGE PYLONS - the supports under every raised road
// ------------------------------------------------------------
//  Slim dark-glass columns from the ground up to the underside of
//  a bridge deck, placed by pylons.ts. All of them are ONE
//  instanced mesh (one draw call however many there are).
//
//  The look, all drawn in the shader so it stays crisp at any
//  distance:
//    - a thin neon line up each vertical corner, in the track's
//      edge colour, brightest under the deck and fading toward the
//      ground (T1 at the top, so they never out-glow the road's T2
//      edge strips)
//    - a collar of light just under the deck, where the pylon meets
//      the light strip along the slab's bottom edge
//    - a faint ring where it stands in the ground
//    - a dim wash on the faces, so a pylon is never a black cut-out
//  They sit beside and under the road, never over it: no gantries.
// ============================================================

import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { GLOW, PALETTE } from '../../core/palette'
import { ROAD_GLSL } from './glsl'
import { PYLON_BURY as BURY, PYLON_WIDTH as WIDTH } from './pylons'
import type { Pylon } from './pylons'

const vertexPars = /* glsl */ `
varying vec2 vFaceUv;
varying float vUp;
varying float vSide;
varying float vLen;
`
const vertexMain = /* glsl */ `
vFaceUv = uv;
vUp = position.y;                       // 0 at the buried foot, 1 at the top
vSide = 1.0 - abs(normal.y);            // 1 on the four vertical faces
vLen = length(instanceMatrix[1].xyz);   // this pylon's full length, metres
`
const fragmentPars = /* glsl */ `
uniform vec3 uLineColor;
uniform float uGlowT0;
uniform float uGlowT1;
uniform float uWidth;
uniform float uBury;
varying vec2 vFaceUv;
varying float vUp;
varying float vSide;
varying float vLen;
${ROAD_GLSL}
`
const fragmentEmissive = /* glsl */ `
#include <emissivemap_fragment>
{
  float fromTop = (1.0 - vUp) * vLen;          // metres below the deck
  float fromGround = vUp * vLen - uBury;       // metres above the ground
  float wH = max(fwidth(fromTop), 1e-4);
  // metres from the nearest vertical corner of this face
  float acrossM = min(vFaceUv.x, 1.0 - vFaceUv.x) * uWidth;
  float wA = max(fwidth(acrossM), 1e-4);
  float corner = sr2Line(acrossM - 0.025, 0.022, wA) * vSide;
  // brightest under the deck, fading toward the ground
  float fade = 0.3 + 0.7 * exp(-fromTop / 5.0);
  float collar = sr2Line(fromTop - 0.35, 0.05, wH) * vSide;
  float foot = sr2Line(fromGround - 0.18, 0.035, wH) * vSide;
  float wash = 0.06 * fade * vSide;
  totalEmissiveRadiance += uLineColor * (corner * fade * uGlowT1 + collar * uGlowT1 * 0.9 + foot * uGlowT0 * 0.6 + wash * uGlowT0);
}
`

function makePylonMaterial(edge: string): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: PALETTE.road, roughness: 0.3, metalness: 0.45 })
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      uLineColor: { value: new THREE.Color(edge) },
      uGlowT0: { value: GLOW.T0 },
      uGlowT1: { value: GLOW.T1 },
      uWidth: { value: WIDTH },
      uBury: { value: BURY },
    })
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${vertexPars}`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>\n${vertexMain}`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${fragmentPars}`)
      .replace('#include <emissivemap_fragment>', fragmentEmissive)
  }
  mat.customProgramCacheKey = () => 'sr2-pylon-v1'
  return mat
}

export function BridgePylons({ pylons, edge }: { pylons: readonly Pylon[]; edge: string }) {
  const built = useMemo(() => {
    if (pylons.length === 0) return null
    // a unit column: 1 m tall from y = 0 (the buried foot) to y = 1, scaled per pylon
    const geo = new THREE.BoxGeometry(WIDTH, 1, WIDTH)
    geo.translate(0, 0.5, 0)
    const mat = makePylonMaterial(edge)
    const mesh = new THREE.InstancedMesh(geo, mat, pylons.length)
    mesh.name = 'road-pylons'
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const p = new THREE.Vector3()
    const sc = new THREE.Vector3()
    const up = new THREE.Vector3(0, 1, 0)
    pylons.forEach((py, i) => {
      p.set(py.x, py.footY - BURY, py.z)
      q.setFromAxisAngle(up, py.heading)
      sc.set(1, py.height + BURY, 1)
      m.compose(p, q, sc)
      mesh.setMatrixAt(i, m)
    })
    mesh.instanceMatrix.needsUpdate = true
    mesh.computeBoundingSphere()
    return { geo, mat, mesh }
  }, [pylons, edge])

  useEffect(
    () => () => {
      if (!built) return
      built.geo.dispose()
      built.mat.dispose()
      built.mesh.dispose()
    },
    [built],
  )

  if (!built) return null
  return <primitive object={built.mesh} />
}
