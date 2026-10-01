// ============================================================
//  WORLD - everything beyond the road and the cars
// ------------------------------------------------------------
//  <World /> is mounted inside the Canvas whenever a track is
//  loaded (driving, the title screen, the editor's top-down view).
//  It owns:
//
//    WorldView.tsx   the world for one track (mounts the parts below)
//    clock.ts        what time of day it is (sundown -> night)
//    sky.ts          what that time means: colours, sun, lights
//    SkyDome.tsx     the sky and the giant striped sun
//    Lighting.tsx    the key light, the hemisphere fill, the haze
//    Terrain.tsx     the ground: dark glass with a glowing grid
//
//  <WorldPhysics /> is mounted inside <Physics> for the solid
//  parts of the world (billboard poles).
//
//  Dev handles (CONSTITUTION section 4 - make it cheap to check):
//    ?time=0.5                     pin the time of day
//    window.__dev.setTime(0.5)     same, live (null lets it run)
//    window.__game.get('world')    time of day + triangle counts
// ============================================================

import { useTrack } from '../track/current'
import { WorldView } from './WorldView'
import { BillboardColliders } from './Billboards'
import { StadiumColliders } from './Stadium'

export { WorldView }

export function World() {
  const track = useTrack()
  if (!track) return null
  return <WorldView track={track} />
}

/** The solid parts of the world (mounted inside <Physics>): billboard poles and the stand front. */
export function WorldPhysics() {
  const track = useTrack()
  if (!track) return null
  return (
    <>
      <BillboardColliders track={track} />
      <StadiumColliders track={track} />
    </>
  )
}
