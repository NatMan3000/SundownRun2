// ============================================================
//  LOOK-DEV RIBBON - TEMPORARY, removed before the stage report
// ------------------------------------------------------------
//  A stand-in road (same MeshBuffers layout as src/track/types.ts)
//  plus stand-in lights, ground and camera, so the road material,
//  env map and post stack can be built before the real track
//  runtime exists.  Only active with ?lookdev=1.
//    ?ltime=0..1   time of day     ?ls=<metres>  where to look
//    ?lcam=chase|high|low
// ============================================================

import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { PALETTE } from '../core/palette'
import { environment } from '../core/telemetry'
import { urlParam } from '../core/devHandles'
import type { MeshBuffers } from '../track/types'
import { SURFACE_CODE } from '../track/types'
import { makeRoadMaterial, makeRoadUniforms, lanesFor, dashPeriodFor } from './road/roadMaterial'
import { makeSkirtMaterial } from './road/skirtMaterial'
import { geometryFrom, tickRoadUniforms } from './road/RoadView'

export const LOOKDEV = urlParam('lookdev') === '1'

interface DevRibbon {
  length: number
  count: number
  px: Float32Array
  py: Float32Array
  pz: Float32Array
  tx: Float32Array
  tz: Float32Array
  road: MeshBuffers
  skirt: MeshBuffers
}

function buildDevRibbon(): DevRibbon {
  // dense parametric loop, then resample at 1 m
  const dense: THREE.Vector3[] = []
  const M = 8000
  for (let i = 0; i < M; i++) {
    const th = (i / M) * Math.PI * 2
    const r = 300 + 80 * Math.sin(2 * th) + 45 * Math.cos(3 * th + 0.6)
    dense.push(new THREE.Vector3(r * Math.cos(th), 0, -r * Math.sin(th)))
  }
  const cum = [0]
  for (let i = 1; i <= M; i++) cum.push(cum[i - 1] + dense[i % M].distanceTo(dense[i - 1]))
  const total = cum[M]
  const count = Math.floor(total)
  const ds = total / count
  const px = new Float32Array(count)
  const py = new Float32Array(count)
  const pz = new Float32Array(count)
  let j = 0
  for (let i = 0; i < count; i++) {
    const s = i * ds
    while (cum[j + 1] < s) j++
    const f = (s - cum[j]) / (cum[j + 1] - cum[j])
    const a = dense[j]
    const b = dense[(j + 1) % M]
    px[i] = a.x + (b.x - a.x) * f
    pz[i] = a.z + (b.z - a.z) * f
    py[i] = 0.3 + 1.2 * Math.sin((s / total) * Math.PI * 6)
  }
  const tx = new Float32Array(count)
  const tz = new Float32Array(count)
  const curv = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    const n = (i + 1) % count
    const p = (i - 1 + count) % count
    const dx = px[n] - px[p]
    const dz = pz[n] - pz[p]
    const l = Math.hypot(dx, dz) || 1
    tx[i] = dx / l
    tz[i] = dz / l
  }
  for (let i = 0; i < count; i++) {
    const n = (i + 1) % count
    const p = (i - 1 + count) % count
    // dT/ds dotted with right (-tz, tx): + = turning right
    const dtx = (tx[n] - tx[p]) / (2 * ds)
    const dtz = (tz[n] - tz[p]) / (2 * ds)
    curv[i] = dtx * -tz[i] + dtz * tx[i]
  }

  const hw = 7
  const COLS = 9
  const rows = count + 1
  const pos = new Float32Array(rows * COLS * 3)
  const nor = new Float32Array(rows * COLS * 3)
  const uv = new Float32Array(rows * COLS * 2)
  const aLat = new Float32Array(rows * COLS)
  const aHalf = new Float32Array(rows * COLS)
  const aCurv = new Float32Array(rows * COLS)
  const aKind = new Float32Array(rows * COLS)
  for (let r = 0; r < rows; r++) {
    const i = r % count
    const rx = -tz[i]
    const rz = tx[i]
    for (let c = 0; c < COLS; c++) {
      const u = c / (COLS - 1)
      const lat = -hw + u * 2 * hw
      const k = r * COLS + c
      pos[k * 3] = px[i] + rx * lat
      pos[k * 3 + 1] = py[i]
      pos[k * 3 + 2] = pz[i] + rz * lat
      nor[k * 3 + 1] = 1
      uv[k * 2] = u
      uv[k * 2 + 1] = r * ds
      aLat[k] = lat
      aHalf[k] = hw
      aCurv[k] = curv[i]
      aKind[k] = i > 900 && i < 960 ? SURFACE_CODE.loop : SURFACE_CODE.road
    }
  }
  const idx = new Uint32Array(count * (COLS - 1) * 6)
  let w = 0
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < COLS - 1; c++) {
      const a = r * COLS + c
      const b = a + 1
      const cc = a + COLS
      const d = cc + 1
      idx[w++] = a
      idx[w++] = b
      idx[w++] = cc
      idx[w++] = b
      idx[w++] = d
      idx[w++] = cc
    }
  }
  const road: MeshBuffers = {
    positions: pos,
    normals: nor,
    uvs: uv,
    indices: idx,
    attributes: {
      aLateral: { array: aLat, itemSize: 1 },
      aHalfWidth: { array: aHalf, itemSize: 1 },
      aCurv: { array: aCurv, itemSize: 1 },
      aKind: { array: aKind, itemSize: 1 },
    },
  }

  // skirt: two vertical sides, uv.x = metres down from the lip
  const DEPTH = 0.9
  const sp = new Float32Array(rows * 4 * 3)
  const sn = new Float32Array(rows * 4 * 3)
  const su = new Float32Array(rows * 4 * 2)
  for (let r = 0; r < rows; r++) {
    const i = r % count
    const rx = -tz[i]
    const rz = tx[i]
    for (let side = 0; side < 2; side++) {
      const sign = side === 0 ? -1 : 1
      for (let v = 0; v < 2; v++) {
        const k = r * 4 + side * 2 + v
        sp[k * 3] = px[i] + rx * hw * sign
        sp[k * 3 + 1] = py[i] - v * DEPTH
        sp[k * 3 + 2] = pz[i] + rz * hw * sign
        sn[k * 3] = rx * sign
        sn[k * 3 + 2] = rz * sign
        su[k * 2] = v * DEPTH
        su[k * 2 + 1] = r * ds
      }
    }
  }
  const sidx = new Uint32Array(count * 2 * 6)
  w = 0
  for (let r = 0; r < count; r++) {
    for (let side = 0; side < 2; side++) {
      const top = r * 4 + side * 2
      const bot = top + 1
      const top2 = top + 4
      const bot2 = bot + 4
      if (side === 0) {
        sidx[w++] = top
        sidx[w++] = top2
        sidx[w++] = bot
        sidx[w++] = bot
        sidx[w++] = top2
        sidx[w++] = bot2
      } else {
        sidx[w++] = top
        sidx[w++] = bot
        sidx[w++] = top2
        sidx[w++] = bot
        sidx[w++] = bot2
        sidx[w++] = top2
      }
    }
  }
  const skirt: MeshBuffers = { positions: sp, normals: sn, uvs: su, indices: sidx, attributes: {} }
  return { length: count * ds, count, px, py, pz, tx, tz, road, skirt }
}

const _c = new THREE.Color()
function writeEnvironment(t: number): void {
  environment.timeOfDay = t
  environment.night = THREE.MathUtils.smoothstep(t, 0.3, 0.95)
  environment.headlights = THREE.MathUtils.smoothstep(t, 0.35, 0.6)
  const elev = THREE.MathUtils.lerp(0.035, -0.3, t)
  environment.sunDirection.set(0, Math.sin(elev), -Math.cos(elev)).normalize()
  environment.keyLightDirection.set(0.3, 0.5, -0.8).normalize()
  const n = environment.night
  _c.set(PALETTE.skyHorizonDusk)
  environment.horizon.copy(_c).lerp(_c.set(PALETTE.skyHorizonNight), n)
  _c.set(PALETTE.skyZenithDusk)
  environment.zenith.copy(_c).lerp(_c.set(PALETTE.skyZenithNight), n)
}

export function LookDev() {
  const camera = useThree((s) => s.camera)
  const scene = useThree((s) => s.scene)
  const t = Number(urlParam('ltime') ?? '0.12')
  const s0 = Number(urlParam('ls') ?? '120')
  const cam = urlParam('lcam') ?? 'chase'

  const built = useMemo(() => {
    const rib = buildDevRibbon()
    const uniforms = makeRoadUniforms({ edge: PALETTE.roadEdge, lanes: lanesFor(14), dashPeriod: dashPeriodFor(rib.length) })
    return {
      rib,
      uniforms,
      road: geometryFrom(rib.road),
      skirt: geometryFrom(rib.skirt),
      roadMat: makeRoadMaterial(uniforms),
      skirtMat: makeSkirtMaterial(uniforms),
    }
  }, [])

  useEffect(() => {
    writeEnvironment(t)
    const { rib } = built
    const i = Math.max(0, Math.min(rib.count - 1, Math.round(s0)))
    const p = new THREE.Vector3(rib.px[i], rib.py[i], rib.pz[i])
    const f = new THREE.Vector3(rib.tx[i], 0, rib.tz[i])
    const r = new THREE.Vector3(-rib.tz[i], 0, rib.tx[i])
    const ahead = (Math.round(s0) + 30) % rib.count
    const pa = new THREE.Vector3(rib.px[ahead], rib.py[ahead], rib.pz[ahead])
    if (cam === 'high') {
      camera.position.copy(p).addScaledVector(f, -40).addScaledVector(r, 25).add(new THREE.Vector3(0, 30, 0))
      camera.lookAt(pa)
    } else if (cam === 'low') {
      camera.position.copy(p).addScaledVector(r, 3).add(new THREE.Vector3(0, 1.0, 0))
      camera.lookAt(pa.add(new THREE.Vector3(0, 0.6, 0)))
    } else {
      camera.position.copy(p).addScaledVector(f, -8).add(new THREE.Vector3(0, 3.0, 0))
      camera.lookAt(pa.add(new THREE.Vector3(0, 0.4, 0)))
    }
    ;(camera as THREE.PerspectiveCamera).fov = 62
    ;(camera as THREE.PerspectiveCamera).updateProjectionMatrix()
  }, [built, camera, t, s0, cam])

  useFrame((state) => {
    tickRoadUniforms(built.uniforms, state.clock.elapsedTime)
    if (scene.environment && scene.background !== scene.environment) scene.background = scene.environment
  })

  const night = THREE.MathUtils.smoothstep(t, 0.3, 0.95)
  return (
    <group name="lookdev">
      <directionalLight
        position={[environment.sunDirection.x * 100, Math.max(5, environment.sunDirection.y * 100), environment.sunDirection.z * 100]}
        color={PALETTE.skySunGlow}
        intensity={THREE.MathUtils.lerp(2.0, 0.25, night)}
      />
      <hemisphereLight args={[PALETTE.skyMidDusk, PALETTE.ground, THREE.MathUtils.lerp(0.5, 0.18, night)]} />
      <mesh geometry={built.road} material={built.roadMat} />
      <mesh geometry={built.skirt} material={built.skirtMat} />
      <mesh rotation-x={-Math.PI / 2} position-y={-0.6}>
        <planeGeometry args={[4000, 4000]} />
        <meshStandardMaterial color={PALETTE.ground} roughness={0.35} />
      </mesh>
      <gridHelper args={[4000, 400, PALETTE.grid, PALETTE.grid]} position-y={-0.55} />
    </group>
  )
}
