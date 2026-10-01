// ============================================================
//  ENVIRONMENT MAP - what shiny things reflect
// ------------------------------------------------------------
//  The wet road, the car paint and anything glossy reflect
//  `scene.environment`. We never ship an HDR photo for it
//  (self-contained rule). The world system's SkyEnvironment
//  renders the REAL sky dome shader (striped sun, horizon glow,
//  night) into a cube map and pre-blurs it with three's PMREM
//  filter, so a rough surface gets a soft reflection and a wet one
//  a sharp one, and the reflection always matches the sky you see.
//
//  The look system owns WHEN that happens and how big the map is:
//    - a 128 px cube (see QUALITY_PRESETS.envSize for why)
//    - re-captured only when the sky has moved by 0.015 of the
//      sundown-to-night range: about every 8 s at the default
//      sunset speed, never while time stands still. A capture costs
//      about 4 ms of GPU on the baseline laptop, inside one frame's
//      headroom, so it never drops a frame there
//    - forced on a new track (new sky settings)
// ============================================================

import { useEffect, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { useGame } from '../core/store'
import { environment } from '../core/telemetry'
import { registerDev } from '../core/devHandles'
import { SkyEnvironment } from '../world/skyEnv'
import { QUALITY_PRESETS } from './quality'
import { lookState } from './lookState'

/** Re-capture after the time of day has moved this much (0..1 scale). */
const MIN_STEP = 0.015

const state = { forced: true, trackVersion: -1 }

export function EnvironmentMap(): null {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const level = useGame((s) => s.qualityLevel)
  const size = QUALITY_PRESETS[level].envSize

  const sky = useMemo(() => new SkyEnvironment(gl, size), [gl, size])

  useEffect(() => {
    scene.environment = sky.texture
    state.forced = true
    lookState.env.size = size
    return () => {
      if (scene.environment === sky.texture) scene.environment = null
      sky.dispose()
    }
  }, [sky, scene, size])

  useEffect(
    () =>
      registerDev(
        'rebuildEnv',
        (() => {
          state.forced = true
          return 'environment map will rebuild next frame'
        }) as (...args: never[]) => unknown,
        'rebuildEnv() - force the reflection map to re-capture the sky now',
      ),
    [],
  )

  useFrame(() => {
    const trackVersion = useGame.getState().trackVersion
    if (trackVersion !== state.trackVersion) {
      state.trackVersion = trackVersion
      state.forced = true
    }
    const t0 = performance.now()
    if (!sky.update(state.forced, MIN_STEP)) return
    state.forced = false
    lookState.env.builds++
    lookState.env.timeOfDay = environment.timeOfDay
    lookState.env.lastBuildMs = performance.now() - t0
  }, -1)

  return null
}
