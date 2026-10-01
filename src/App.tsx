// ============================================================
//  APP - the scene graph, one mount point per system
// ------------------------------------------------------------
//  Orchestrator-owned glue. Each system lives in its own folder and
//  is mounted exactly once here; systems talk through the contracts
//  in src/core (store, telemetry, events, controls, api), never by
//  reaching into each other's files.
// ============================================================

import { Suspense } from 'react'
import { Canvas } from '@react-three/fiber'
import { Physics } from '@react-three/rapier'
import { useGame } from './core/store'
import { PerfProbe } from './core/perf'
import { useTrack } from './track/current'
import { TrackPhysics } from './track'
import { World, WorldPhysics } from './world'
import { RoadView, CarFx, FxSystem, PostStack, BridgePylonColliders } from './look'
import { VehicleLayer, CameraRig, InputSystem } from './vehicle'
import { PlayLayer } from './play'
import { NetLayer } from './net'
import { AudioSystem } from './audio'
import { UiRoot } from './ui'
import { EditorScene, EditorUi, EditorDrive, EditorDriveUi } from './editor'

function Scene() {
  const phase = useGame((s) => s.phase)
  const multiplayer = useGame((s) => s.multiplayer)
  const trackVersion = useGame((s) => s.trackVersion)
  const mapOpen = useGame((s) => s.mapOpen)
  const track = useTrack()
  const editing = phase === 'editor'
  const paused = !multiplayer && phase === 'paused'

  return (
    <>
      <PerfProbe />
      <InputSystem />
      {track && <World />}
      {track && <RoadView />}
      {track && !editing && (
        <Physics
          key={`${track.id}:${trackVersion}`}
          timeStep={1 / 60}
          interpolate
          paused={paused}
          colliders={false}
          // Step physics before every priority-0 useFrame (camera, fx, HUD) even after a remount,
          // so they all read THIS frame's car pose. Negative keeps r3f's auto-render on.
          updatePriority={-50}
        >
          <TrackPhysics />
          <WorldPhysics />
          <BridgePylonColliders />
          <VehicleLayer />
          <PlayLayer />
          <NetLayer />
        </Physics>
      )}
      {track && !editing && <CarFx />}
      {track && !editing && <EditorDrive />}
      <FxSystem />
      {editing || mapOpen ? <EditorScene /> : <CameraRig />}
      <PostStack />
      <AudioSystem />
    </>
  )
}

export function App() {
  const phase = useGame((s) => s.phase)
  const mapOpen = useGame((s) => s.mapOpen)
  return (
    <>
      <Canvas
        camera={{ fov: 62, near: 0.1, far: 6000, position: [0, 30, 60] }}
        gl={{ antialias: false, powerPreference: 'high-performance', stencil: false }}
        dpr={1}
        shadows
      >
        <Suspense fallback={null}>
          <Scene />
        </Suspense>
      </Canvas>
      <UiRoot />
      {(phase === 'editor' || mapOpen) && <EditorUi />}
      <EditorDriveUi />
    </>
  )
}
