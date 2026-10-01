// ============================================================
//  CAR LAB - a dev-only showroom for the five car bodies
// ------------------------------------------------------------
//  Open http://localhost:5201/src/dev/carlab.html while the dev
//  server runs. It parks the cars on dark glass under the game's
//  REAL sky (the same dome, sun, reflection map and key light the
//  tracks use, from src/world), with the game's bloom and tone
//  mapping, so a body can be judged at sundown or at night without
//  driving the whole game.
//
//  URL options:
//    ?body=<id>|all       one body close up, or all five in a row (default all)
//    ?view=front3q|side|rear3q|front|rear|top|chase   camera angle (default front3q)
//    ?time=0..1           time of day: 0.12 sundown (default), 1 night
//    ?sun=<deg>           where the sun sits, degrees round from the camera
//                         (default 50: the visible side catches the light)
//    ?boost=0..1          fire the rocket nozzle (0 = idle)
//    ?brake=1             tail lights at full brake
//    ?paint=<hex> ?glow=<hex>   colours without the # (default: the player's)
//    ?dist=<m>            camera distance override
//    ?at=<z>              aim at this point along the car (1.42 = front wheel)
//    ?paints=1            one body in a row of garage paints: navy, black,
//                         pearl, red, mint, plum and a custom hue
//    ?hub=up|down|<m>     pose the suspension: up = as far as it goes on a big
//                         landing, down = hanging in the air, or metres above
//                         rest (checks a tyre never pokes through its fender)
//    ?steer=<rad> ?roll=<rad> ?pitch=<rad>   steer the front wheels, lean the body
//    ?ghost=1             build them the way the time-trial ghost is built
//    ?clone=1             swap every material for a clone, the way multiplayer
//                         cars do to fade in (checks the shader patches survive)
//
//  Not part of the game: nothing in the game imports this file.
// ============================================================

import { createRoot } from 'react-dom/client'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { EffectComposer, Bloom, ToneMapping } from '@react-three/postprocessing'
import { ToneMappingMode } from 'postprocessing'
import { GLOW, PALETTE } from '../core/palette'
import { BODIES } from '../vehicle/bodies/catalog'
import { buildCarModel, poseCarModel, setCarBoost, setCarBrake, WHEEL_REST_Y } from '../vehicle/carModel'
import { WHEEL } from '../vehicle/tuning'
import { SkyDome } from '../world/SkyDome'
import { SkyEnvironment } from '../world/skyEnv'
import { sky, updateSky } from '../world/sky'
import { worldClock } from '../world/clock'

const params = new URLSearchParams(window.location.search)
const view = params.get('view') ?? 'front3q'
const bodyParam = params.get('body') ?? 'all'
const PAINT_ROW = [
  PALETTE.paintDefault,
  PALETTE.ground,
  PALETTE.stars,
  PALETTE.aiColors[0],
  PALETTE.boost,
  PALETTE.skyMidDusk,
  '#' + new THREE.Color().setHSL(0.6, 0.65, 0.42).getHexString(), // a custom hue from the garage slider
]
const paintRow = params.get('paints') === '1'
const ids = paintRow ? PAINT_ROW.map(() => (bodyParam === 'all' ? 'dart' : bodyParam)) : bodyParam === 'all' ? BODIES.map((b) => b.id) : [bodyParam]
const hex = (name: string, fallback: string) => {
  const v = params.get(name)
  return v ? `#${v.replace('#', '')}` : fallback
}
const paint = hex('paint', PALETTE.paintDefault)
const glow = hex('glow', PALETTE.glowDefault)
const boost = Number(params.get('boost') ?? 0)
/** Physics hub heights for ?hub= (full bump: the box touching the road; full droop: the spring fully out). */
const hubParam = params.get('hub')
const hubY = hubParam === 'up' ? WHEEL.anchorY : hubParam === 'down' ? WHEEL.anchorY - WHEEL.restLength : hubParam ? WHEEL_REST_Y + Number(hubParam) : null
const posed = hubY !== null || params.has('steer') || params.has('roll') || params.has('pitch')
const pose = {
  wheelHubY: [0, 1, 2, 3].map(() => (hubY !== null && Number.isFinite(hubY) ? hubY : WHEEL_REST_Y)),
  wheelSpin: [0, 0, 0, 0],
  steerAngle: Number(params.get('steer') ?? 0),
  roll: Number(params.get('roll') ?? 0),
  pitch: Number(params.get('pitch') ?? 0),
}
const time = Number(params.get('time') ?? 0.12)
worldClock.time = Number.isFinite(time) ? THREE.MathUtils.clamp(time, 0, 1) : 0.12
worldClock.frozen = true

/** Camera direction for each view: azimuth round the car (0 = straight ahead of the nose, + toward its left) and height. */
const VIEWS: Record<string, { az: number; h: number; d: number; look: number }> = {
  front3q: { az: 38, h: 1.15, d: 7.6, look: 0.35 },
  side: { az: 90, h: 0.9, d: 8.4, look: 0.35 },
  rear3q: { az: 142, h: 1.3, d: 7.6, look: 0.35 },
  front: { az: 0, h: 0.9, d: 8, look: 0.35 },
  rear: { az: 180, h: 1.1, d: 8, look: 0.35 },
  top: { az: 90, h: 9, d: 0.01, look: 0 },
  chase: { az: 180, h: 2.4, d: 7.2, look: 0.9 },
}
const v = VIEWS[view] ?? VIEWS.front3q
const DEG = Math.PI / 180

// The sun sits `sun` degrees round from the camera (game convention: azimuth 0 = -z).
const camAz = v.az * DEG
const sunRel = Number(params.get('sun') ?? 50)
sky.sunAzimuth = Math.PI - camAz + sunRel * DEG
sky.planetAzimuth = sky.sunAzimuth + 22 * DEG

/** The game's sky, reflection map and lights, driven by the world clock. */
function World() {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const env = useMemo(() => new SkyEnvironment(gl, 256), [gl])
  const light = useMemo(() => {
    const l = new THREE.DirectionalLight()
    l.castShadow = true
    l.shadow.mapSize.set(2048, 2048)
    const c = l.shadow.camera
    c.left = c.bottom = -9
    c.right = c.top = 9
    c.near = 1
    c.far = 60
    l.shadow.bias = -0.0004
    l.shadow.normalBias = 0.02
    return l
  }, [])
  const hemi = useMemo(() => new THREE.HemisphereLight(), [])
  useEffect(() => {
    scene.environment = env.texture
    scene.add(light, light.target, hemi)
    return () => {
      scene.remove(light, light.target, hemi)
      env.dispose()
    }
  }, [scene, env, light, hemi])
  useFrame((state) => {
    updateSky(state.clock.elapsedTime)
    env.update()
    light.color.copy(sky.keyColor)
    light.intensity = sky.keyIntensity
    light.position.copy(sky.keyDir).multiplyScalar(30)
    light.target.position.set(0, 0, 0)
    hemi.color.copy(sky.hemiSky)
    hemi.groundColor.copy(sky.hemiGround)
    hemi.intensity = sky.hemiIntensity
  }, -10)
  return <SkyDome />
}

/** Dark glass floor with a faint neon grid, like the game's ground near the road. */
function Floor() {
  const tex = useMemo(() => {
    const c = document.createElement('canvas')
    c.width = c.height = 256
    const ctx = c.getContext('2d')!
    ctx.clearRect(0, 0, 256, 256) // unlit glass between the lines
    ctx.strokeStyle = PALETTE.grid
    ctx.lineWidth = 3
    ctx.strokeRect(0, 0, 256, 256)
    const t = new THREE.CanvasTexture(c)
    t.wrapS = t.wrapT = THREE.RepeatWrapping
    t.repeat.set(60, 60)
    t.anisotropy = 8
    t.colorSpace = THREE.SRGBColorSpace
    return t
  }, [])
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <planeGeometry args={[240, 240]} />
      <meshStandardMaterial
        color={PALETTE.ground}
        roughness={0.32}
        metalness={0.6}
        emissive={PALETTE.grid}
        emissiveMap={tex}
        emissiveIntensity={GLOW.T0 * 0.45}
      />
    </mesh>
  )
}

function Lineup() {
  const models = useMemo(
    () =>
      ids.map((id, i) => {
        const m = buildCarModel(id, paintRow ? PAINT_ROW[i] : paint, glow, { shadows: params.get('ghost') !== '1', ghost: params.get('ghost') === '1' })
        // all five: a diagonal line so every car shows its face at the same angle
        if (paintRow) m.position.set(0, 0.542, ((ids.length - 1) / 2 - i) * 4.8) // nose to tail, so a side view shows every paint
        else m.position.set(ids.length > 1 ? (i - (ids.length - 1) / 2) * 3.4 : 0, 0.542, 0)
        if (params.get('brake') === '1') setCarBrake(m, 1)
        if (params.get('clone') === '1') {
          m.traverse((o) => {
            const mesh = o as THREE.Mesh
            if (mesh.isMesh && !Array.isArray(mesh.material)) mesh.material = mesh.material.clone()
          })
        }
        return m
      }),
    [],
  )
  useFrame(() => {
    for (const m of models) {
      setCarBoost(m, boost)
      if (posed) poseCarModel(m, pose)
    }
  })
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
    const spread = paintRow ? 7.5 : ids.length > 1 ? 2.3 : 1
    const d = Number(params.get('dist') ?? v.d * spread)
    const at = Number(params.get('at') ?? 0)
    camera.position.set(Math.sin(camAz) * d, v.h * (ids.length > 1 ? 1.8 : 1), Math.cos(camAz) * d + at)
    if (view === 'top') camera.up.set(0, 0, 1)
    camera.lookAt(0, v.look, at)
    camera.updateProjectionMatrix()
  }, [camera])
  return null
}

function Lab() {
  return (
    <Canvas shadows dpr={1} flat camera={{ fov: 30, near: 0.1, far: 9000 }} gl={{ antialias: true, toneMapping: THREE.NoToneMapping }}>
      <World />
      <Floor />
      <Cam />
      <Lineup />
      <EffectComposer multisampling={4}>
        <Bloom mipmapBlur luminanceThreshold={1} intensity={0.95} />
        <ToneMapping mode={ToneMappingMode.NEUTRAL} />
      </EffectComposer>
    </Canvas>
  )
}

createRoot(document.getElementById('root')!).render(<Lab />)
