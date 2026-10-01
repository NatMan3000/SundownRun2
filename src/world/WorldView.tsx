// ============================================================
//  WORLD VIEW - the whole world for one track
// ------------------------------------------------------------
//  Takes the track as a prop (index.tsx feeds it the current
//  track), runs the time-of-day clock first thing every frame,
//  and mounts the parts: sky + sun, lights + haze, terrain.
//  Also registers the world's dev command and inspector.
// ============================================================

import { useEffect, useLayoutEffect, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { PALETTE } from '../core/palette'
import { useGame } from '../core/store'
import { useSettings } from '../core/settings'
import { registerDev, registerInspector } from '../core/devHandles'
import type { TrackRuntime } from '../track/types'
import { resetClock, settingChanged, setTimeOverride, tickClock, worldClock } from './clock'
import { configureSky, sky, updateSky } from './sky'
import { SkyDome } from './SkyDome'
import { Lighting } from './Lighting'
import { Terrain } from './Terrain'
import { Stars } from './Stars'
import { Planet } from './Planet'
import { City } from './City'
import { worldStats } from './stats'

/** The world for a given track (the editor and the title screen use the same view). */
export function WorldView({ track }: { track: TrackRuntime }) {
  const quality = useGame((s) => s.qualityLevel)
  const trackVersion = useGame((s) => s.trackVersion)

  // Sun, planet and city placement come from the track file.
  useLayoutEffect(() => {
    configureSky(track)
  }, [track])

  // A new track: start its clock (glide there if the sky was already showing).
  useLayoutEffect(() => {
    resetClock(track, true)
  }, [track.id, trackVersion])

  // A new drive restarts the clock; moving the Time of day slider glides to it.
  const trackRef = useRef(track)
  trackRef.current = track
  useEffect(() => {
    const offGame = useGame.subscribe((s, prev) => {
      if (s.sessionStartedAt !== prev.sessionStartedAt) resetClock(trackRef.current, true)
    })
    const offSettings = useSettings.subscribe((s, prev) => {
      if (s.timeOfDay !== prev.timeOfDay) settingChanged(s.timeOfDay)
    })
    return () => {
      offGame()
      offSettings()
    }
  }, [])

  useEffect(() => {
    const offDev = registerDev(
      'setTime',
      (t: number | null) => {
        setTimeOverride(t)
        return worldClock.time
      },
      'setTime(t): pin the time of day, 0 = sundown .. 1 = night. setTime(null) lets the clock run.',
    )
    const offInspector = registerInspector('world', () => ({
      timeOfDay: Number(worldClock.time.toFixed(4)),
      frozen: worldClock.frozen,
      night: Number(sky.night.toFixed(3)),
      headlights: Number(sky.headlights.toFixed(3)),
      sunElevationDeg: Number(sky.sunElevationDeg.toFixed(2)),
      keyIntensity: Number(sky.keyIntensity.toFixed(2)),
      shadow: Number(sky.shadow.toFixed(3)),
      triangles: { terrain: worldStats.terrainTriangles, sky: worldStats.skyTriangles, planet: worldStats.planetTriangles },
      stars: worldStats.stars,
      city: { towers: worldStats.cityTowers, triangles: worldStats.cityTriangles },
      terrain: { strides: worldStats.terrainStrides, chunks: worldStats.terrainChunks },
    }))
    return () => {
      offDev()
      offInspector()
    }
  }, [])

  // First thing every frame: move the clock and publish the sky (other systems read it).
  useFrame((state, dt) => {
    tickClock(dt)
    updateSky(state.clock.elapsedTime)
  }, -10)

  return (
    <>
      <color attach="background" args={[PALETTE.skyZenithNight]} />
      <SkyDome />
      <Stars quality={quality} seed={track.file.environment.seed} />
      <Planet />
      <City track={track} quality={quality} />
      <Lighting />
      <Terrain track={track} quality={quality} />
    </>
  )
}
