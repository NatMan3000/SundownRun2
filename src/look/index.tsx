// ============================================================
//  LOOK - the light itself
// ------------------------------------------------------------
//  The look system draws the hero surfaces and the glow:
//    RoadView   the wet neon road ribbon (road/)
//    CarFx      every car's light: trails, underglow, headlights
//    FxSystem   the reflection map + pooled shards, sparks, pulses
//    PostStack  bloom, tone mapping, vignette, SMAA, boost lens,
//               headlight beams, plus the quality manager and the
//               F9 screenshot
//  App.tsx mounts all four inside the Canvas, and
//    BridgePylonColliders  the solid bridge pylons, inside <Physics>
//
//  Inspect it live:  window.__game.get('look')
// ============================================================

import { useEffect } from 'react'
import { registerInspector } from '../core/devHandles'
import { lookState } from './lookState'
import { EnvironmentMap } from './EnvironmentMap'
import { QualityManager } from './QualityManager'
import { Screenshot } from './Screenshot'
import { DevPick } from './DevPick'
import { PostStack as Post } from './post/PostStack'
import { FxPools } from './fx/FxPools'
import { CarLights } from './fx/CarLights'
import { HeadlightRig } from './fx/HeadlightRig'
import { EventFx } from './fx/EventFx'

export { RoadView } from './road/RoadView'
export { BridgePylonColliders } from './road/BridgePylonColliders'

export function CarFx() {
  return <CarLights />
}

export function FxSystem() {
  return (
    <>
      <EnvironmentMap />
      <HeadlightRig />
      <FxPools />
      <EventFx />
    </>
  )
}

export function PostStack() {
  useEffect(() => registerInspector('look', () => lookState), [])
  return (
    <>
      <QualityManager />
      <Screenshot />
      <DevPick />
      <Post />
    </>
  )
}
