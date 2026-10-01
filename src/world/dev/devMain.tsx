// TEMPORARY (world worker's dev scene, removed before the stage report).
// Open http://localhost:5201/src/world/dev/index.html?cam=start&time=0.12
// Renders <WorldView> over a stand-in track with a stand-in road, a
// temporary bloom + tone mapping (the look worker owns the real post
// stack) and a sky environment map, so the world can be judged early.

import '../../core/devHandles'
import { useEffect, useMemo } from 'react'
import { createRoot } from 'react-dom/client'
import * as THREE from 'three'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { EffectComposer, Bloom, ToneMapping } from '@react-three/postprocessing'
import { ToneMappingMode } from 'postprocessing'
import { GLOW, PALETTE } from '../../core/palette'
import { telemetry } from '../../core/telemetry'
import { useGame } from '../../core/store'
import { urlParam } from '../../core/devHandles'
import { WorldView } from '../WorldView'
import { SkyEnvironment } from '../skyEnv'
import { makeDevTrack } from './devTrack'

const track = makeDevTrack()
const tm = urlParam('tm')
const TONE = tm === 'agx' ? ToneMappingMode.AGX : tm === 'neutral' ? ToneMappingMode.NEUTRAL : ToneMappingMode.ACES_FILMIC
const q = urlParam('quality')
if (q === 'low' || q === 'medium' || q === 'high') useGame.setState({ qualityLevel: q })
useGame.setState({ phase: 'playing', sessionStartedAt: 1 })

function roadPoint(i: number) {
  const s = track.samples
  const k = ((i % s.count) + s.count) % s.count
  return new THREE.Vector3(s.px[k], s.py[k], s.pz[k])
}

// The road sample heading most nearly north: we look up the road toward the sun.
let southI = 0
{
  let best = 0
  const s = track.samples
  for (let i = 0; i < s.count; i++) {
    const n = (i + 1) % s.count
    const dz = s.pz[n] - s.pz[i]
    if (-dz > best) {
      best = -dz
      southI = i
    }
  }
}

function DevCamera() {
  const camera = useThree((s) => s.camera)
  const preset = urlParam('cam') ?? 'start'
  useEffect(() => {
    const car = roadPoint(southI)
    const ahead = roadPoint(southI + 60)
    let pos = new THREE.Vector3(car.x, car.y + 3.2, car.z + 8)
    let look = new THREE.Vector3(ahead.x, ahead.y + 3, ahead.z)
    if (preset === 'aerial') {
      pos = new THREE.Vector3(0, 330, 1050)
      look = new THREE.Vector3(0, 0, -100)
    } else if (preset === 'anti') {
      pos = new THREE.Vector3(car.x, car.y + 3.2, car.z - 8)
      look = new THREE.Vector3(car.x, car.y + 6, car.z + 200)
    } else if (preset === 'side') {
      const p = roadPoint(southI + 420)
      pos = new THREE.Vector3(p.x - 6, p.y + 3, p.z + 4)
      look = new THREE.Vector3(p.x + 200, p.y + 4, p.z - 60)
      car.copy(p)
    } else if (preset === 'north') {
      // the road point nearest the north edge, looking north toward the sun
      let ni = 0
      for (let i = 0; i < track.samples.count; i++) if (track.samples.pz[i] < track.samples.pz[ni]) ni = i
      const p = roadPoint(ni)
      pos = new THREE.Vector3(p.x, p.y + 3.2, p.z + 8)
      look = new THREE.Vector3(p.x, p.y + 6, p.z - 200)
      car.copy(p)
    } else if (preset === 'planet') {
      pos = new THREE.Vector3(car.x, car.y + 3.2, car.z + 8)
      look = new THREE.Vector3(car.x + 120, car.y + 90, car.z - 160)
    } else if (preset === 'low') {
      pos = new THREE.Vector3(car.x, car.y + 1.4, car.z + 6)
      look = new THREE.Vector3(car.x + 40, car.y + 1, car.z - 120)
    }
    camera.position.copy(pos)
    camera.lookAt(look)
    telemetry.carPosition.copy(car)
  }, [camera, preset])
  return null
}

function StandInRoad() {
  const geoms = useMemo(() => {
    const s = track.samples
    const make = (inner: number, outer: number, lift: number) => {
      const pos = new Float32Array(s.count * 2 * 3)
      const idx: number[] = []
      for (let i = 0; i < s.count; i++) {
        const a = roadPoint(i - 1)
        const b = roadPoint(i + 1)
        const tx = b.x - a.x
        const tz = b.z - a.z
        const l = Math.hypot(tx, tz)
        const rx = -tz / l
        const rz = tx / l
        pos.set([s.px[i] + rx * inner, s.py[i] + lift, s.pz[i] + rz * inner], i * 6)
        pos.set([s.px[i] + rx * outer, s.py[i] + lift, s.pz[i] + rz * outer], i * 6 + 3)
        const n = (i + 1) % s.count
        idx.push(i * 2, n * 2, i * 2 + 1, i * 2 + 1, n * 2, n * 2 + 1)
      }
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      g.setIndex(idx)
      g.computeVertexNormals()
      return g
    }
    return { road: make(-7, 7, 0.1), left: make(-7, -6.6, 0.12), right: make(6.6, 7, 0.12) }
  }, [])
  const edge = useMemo(() => new THREE.Color(PALETTE.roadEdge).multiplyScalar(GLOW.T2), [])
  return (
    <group>
      <mesh geometry={geoms.road} receiveShadow>
        <meshStandardMaterial color={PALETTE.road} roughness={0.15} metalness={0.2} side={THREE.DoubleSide} />
      </mesh>
      <mesh geometry={geoms.left}>
        <meshBasicMaterial color={edge} side={THREE.DoubleSide} toneMapped={false} />
      </mesh>
      <mesh geometry={geoms.right}>
        <meshBasicMaterial color={edge} side={THREE.DoubleSide} toneMapped={false} />
      </mesh>
    </group>
  )
}

function DevCar() {
  // A box where the "car" is, so the shadow and the grid fade have something to show.
  const ref = useMemo(() => new THREE.Mesh(new THREE.BoxGeometry(2, 1.1, 4.4), new THREE.MeshStandardMaterial({ color: PALETTE.paintDefault, roughness: 0.25, metalness: 0.7 })), [])
  useFrame(() => {
    ref.position.set(telemetry.carPosition.x, telemetry.carPosition.y + 0.75, telemetry.carPosition.z)
  })
  ref.castShadow = true
  return <primitive object={ref} />
}

function DevEnvironment() {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const env = useMemo(() => new SkyEnvironment(gl), [gl])
  useEffect(() => {
    scene.environment = env.texture
    scene.environmentIntensity = 1
    return () => {
      scene.environment = null
      env.dispose()
    }
  }, [env, scene])
  useFrame(() => {
    env.update()
  })
  return null
}

function App() {
  return (
    <Canvas
      camera={{ fov: 62, near: 0.1, far: 6000, position: [0, 30, 60] }}
      gl={{ antialias: false, powerPreference: 'high-performance', stencil: false }}
      dpr={1}
      shadows
    >
      <DevCamera />
      <WorldView track={track} />
      <StandInRoad />
      <DevCar />
      <DevEnvironment />
      <EffectComposer multisampling={0}>
        <Bloom mipmapBlur luminanceThreshold={1.0} luminanceSmoothing={0.2} intensity={0.9} />
        <ToneMapping mode={TONE} />
      </EffectComposer>
    </Canvas>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
