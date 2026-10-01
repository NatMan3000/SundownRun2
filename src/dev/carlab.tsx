// ============================================================
//  CAR LAB - a dev-only showroom for the five car bodies
// ------------------------------------------------------------
//  Open http://localhost:5201/src/dev/carlab.html while the dev
//  server runs. It lines the five bodies up on a dark glossy floor
//  under a synthwave-ish light, with bloom, so their shapes, livery
//  and lights can be judged without the full game around them.
//
//  URL options:
//    ?view=front|side|rear|top|three  camera angle (default three)
//    ?body=<id>                       one body, close up
//    ?brake=1                         tail lights at full brake
//
//  Not part of the game: nothing imports this file.
// ============================================================

import { createRoot } from 'react-dom/client'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { Canvas, useThree } from '@react-three/fiber'
import { EffectComposer, Bloom, ToneMapping } from '@react-three/postprocessing'
import { ToneMappingMode } from 'postprocessing'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { PALETTE } from '../core/palette'
import { BODIES } from '../vehicle/bodies/catalog'
import { buildCarModel, setCarBrake } from '../vehicle/carModel'

const params = new URLSearchParams(window.location.search)
const view = params.get('view') ?? 'three'
const only = params.get('body')
const GLOWS = ['#19e3ff', '#ff2bd6', '#ffb000', '#3dffb0', '#8f7bff']

function Env() {
  const { gl, scene } = useThree()
  useEffect(() => {
    const pm = new THREE.PMREMGenerator(gl)
    const env = pm.fromScene(new RoomEnvironment(), 0.04).texture
    scene.environment = env
    scene.environmentIntensity = 0.5
    return () => env.dispose()
  }, [gl, scene])
  return null
}

function Lineup() {
  const ids = only ? [only] : BODIES.map((b) => b.id)
  const models = useMemo(
    () =>
      ids.map((id, i) => {
        const m = buildCarModel(id, PALETTE.paintDefault, GLOWS[i % GLOWS.length], { shadows: true })
        m.position.set(only ? 0 : (i - (ids.length - 1) / 2) * 3.2, 0.542, 0)
        if (params.get('brake') === '1') setCarBrake(m, 1)
        return m
      }),
    [], // eslint-disable-line react-hooks/exhaustive-deps
  )
  return (
    <>
      {models.map((m, i) => (
        <primitive key={i} object={m} />
      ))}
    </>
  )
}

function Cam() {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  useEffect(() => {
    const d = only ? 1 : 2.6
    const pos: Record<string, [number, number, number]> = {
      three: [5.5 * d, 2.6 * d, 6.5 * d],
      front: [0, 1.0 * d, 9 * d],
      rear: [0, 1.2 * d, -9 * d],
      side: [11 * d, 1.0 * d, 0.001],
      top: [0, 14 * d, 0.001],
    }
    const p = pos[view] ?? pos.three
    camera.position.set(p[0], p[1], p[2])
    camera.lookAt(0, 0.4, 0)
    camera.updateProjectionMatrix()
  }, [camera])
  return null
}

function Lab() {
  return (
    <Canvas shadows dpr={1} camera={{ fov: 35, near: 0.1, far: 500 }} gl={{ antialias: true }}>
      <color attach="background" args={[PALETTE.skyZenithDusk]} />
      <Env />
      <Cam />
      <hemisphereLight args={[PALETTE.skyMidDusk, PALETTE.ground, 0.6]} />
      <directionalLight position={[-6, 4, -10]} intensity={2.2} color={PALETTE.skySunGlow} castShadow shadow-mapSize={[1024, 1024]} />
      <directionalLight position={[8, 6, 6]} intensity={0.5} color={PALETTE.laneLine} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[80, 80]} />
        <meshStandardMaterial color={PALETTE.ground} roughness={0.7} metalness={0.1} />
      </mesh>
      <Lineup />
      <EffectComposer>
        <Bloom mipmapBlur luminanceThreshold={1} intensity={0.9} />
        <ToneMapping mode={ToneMappingMode.AGX} />
      </EffectComposer>
    </Canvas>
  )
}

createRoot(document.getElementById('root')!).render(<Lab />)
