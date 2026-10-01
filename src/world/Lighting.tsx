// ============================================================
//  LIGHTING + HAZE - the world's two lights and its fog
// ------------------------------------------------------------
//  Constitution section 2 allows exactly one directional light
//  and one hemisphere light in the world (the car's headlights
//  are the look worker's). Everything else that glows fakes it
//  with emissive colour.
//
//  1. KEY LIGHT. Warm sunlight from the sun's side at sundown,
//     turning into cool planet-light at night (sky.ts decides the
//     direction, colour and strength). It is the only shadow
//     caster: only on the high preset, only while the sun is up.
//     The shadow box is a tight square that follows the car and is
//     snapped to whole shadow-map texels, which stops shadow edges
//     shimmering as you drive (lifted from v1).
//
//     When the sun sets, the shadow fades out and the shadow map
//     stops being redrawn - but castShadow stays on, so no shader
//     has to recompile mid-drive (that would be a visible hitch).
//
//  2. HEMISPHERE. Violet sky above, dark glass below: the soft
//     fill that keeps the shaded side of a car from going black.
//
//  3. FOG. Exponential haze in the average horizon colour. Its
//     density is matched to the draw distance so far things fade
//     into haze before they could ever be clipped.
// ============================================================

import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { telemetry } from '../core/telemetry'
import { useGame } from '../core/store'
import { sky } from './sky'

const SHADOW_MAP = 2048
/** Half-width of the shadow box around the car, metres. */
const SHADOW_RADIUS = 70
/** How far up the light ray the light sits above the car. */
const LIGHT_DISTANCE = 240
const TEXEL = (SHADOW_RADIUS * 2) / SHADOW_MAP

/** Fog density per metre (FogExp2). ~30% haze at 1 km, ~75% at 2 km. */
export const FOG_DENSITY = 0.00058

// scratch
const _center = new THREE.Vector3()
const _axisX = new THREE.Vector3()
const _axisY = new THREE.Vector3()
const _up = new THREE.Vector3(0, 1, 0)

export function Lighting() {
  const lightRef = useRef<THREE.DirectionalLight>(null)
  const hemiRef = useRef<THREE.HemisphereLight>(null)
  const quality = useGame((s) => s.qualityLevel)
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const shadowsOn = quality === 'high'
  const shadowTypeFixed = useRef(false)

  const target = useMemo(() => new THREE.Object3D(), [])
  const fog = useMemo(() => new THREE.FogExp2(sky.fogColor.getHex(), FOG_DENSITY), [])

  useEffect(() => {
    scene.add(target)
    scene.fog = fog
    return () => {
      scene.remove(target)
      if (scene.fog === fog) scene.fog = null
    }
  }, [scene, target, fog])

  useEffect(() => {
    const light = lightRef.current
    if (!light) return
    light.target = target
    light.shadow.camera.updateProjectionMatrix()
  }, [target, shadowsOn])

  useFrame(() => {
    const light = lightRef.current
    const hemi = hemiRef.current
    if (!light || !hemi) return

    // r3f asks for PCFSoftShadowMap, which three 0.186 deprecates (and warns
    // about). Ask for the filter we actually get. Must run after Canvas has
    // configured the renderer, so it lives in the first frame (v1 lesson).
    if (!shadowTypeFixed.current) {
      shadowTypeFixed.current = true
      if (gl.shadowMap.type !== THREE.PCFShadowMap) {
        gl.shadowMap.type = THREE.PCFShadowMap
        gl.shadowMap.needsUpdate = true
      }
    }

    // ---- key light ----
    light.color.copy(sky.keyColor)
    light.intensity = sky.keyIntensity

    // Shadow box: centred on the car, snapped to whole texels in light space.
    const dir = sky.keyDir
    _axisX.crossVectors(_up, dir)
    if (_axisX.lengthSq() < 1e-6) _axisX.set(1, 0, 0)
    _axisX.normalize()
    _axisY.crossVectors(dir, _axisX).normalize()
    const car = telemetry.carPosition
    const dx = _axisX.dot(car)
    const dy = _axisY.dot(car)
    _center
      .copy(car)
      .addScaledVector(_axisX, Math.round(dx / TEXEL) * TEXEL - dx)
      .addScaledVector(_axisY, Math.round(dy / TEXEL) * TEXEL - dy)
    target.position.copy(_center)
    target.updateMatrixWorld()
    light.position.copy(_center).addScaledVector(dir, LIGHT_DISTANCE)

    // Shadows fade with the sun, then the map stops being redrawn. It is
    // drawn one last time as it switches off: three only creates the shadow
    // map when it draws it, and a shader sampling a map that was never made
    // is a WebGL error (at night from the very first frame, for example).
    const strength = shadowsOn ? sky.shadow : 0
    light.shadow.intensity = strength
    const redraw = strength > 0.001
    if (light.shadow.autoUpdate !== redraw) {
      light.shadow.autoUpdate = redraw
      if (!redraw) light.shadow.needsUpdate = true
    }

    // ---- hemisphere fill ----
    hemi.color.copy(sky.hemiSky)
    hemi.groundColor.copy(sky.hemiGround)
    hemi.intensity = sky.hemiIntensity

    // ---- haze ----
    fog.color.copy(sky.fogColor)
  })

  return (
    <>
      <directionalLight
        ref={lightRef}
        castShadow={shadowsOn}
        shadow-mapSize-width={SHADOW_MAP}
        shadow-mapSize-height={SHADOW_MAP}
        shadow-camera-left={-SHADOW_RADIUS}
        shadow-camera-right={SHADOW_RADIUS}
        shadow-camera-top={SHADOW_RADIUS}
        shadow-camera-bottom={-SHADOW_RADIUS}
        shadow-camera-near={10}
        shadow-camera-far={LIGHT_DISTANCE + SHADOW_RADIUS * 2}
        shadow-bias={-0.0003}
        shadow-normalBias={0.4}
      />
      <hemisphereLight ref={hemiRef} />
    </>
  )
}
