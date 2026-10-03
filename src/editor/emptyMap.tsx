// ============================================================
//  EMPTY MAP - hide the stand-in road while the map has no road
// ------------------------------------------------------------
//  After Clear all (or for a brand new track) the map is empty. The
//  game still needs a road to build a world around, so the editor
//  builds the world with a small hidden loop in the middle
//  (draftFile.ts emptyWorldFile: no posts, no billboards). This
//  component, inside the 3D scene under the editor's camera, keeps
//  that loop out of sight: it hides the road's group (named "road"
//  by src/look/road/RoadView.tsx) while the draft is empty, and shows
//  it again the moment there is a road, or when the editor closes.
//
//  It looks the group up only when something changed (a new build or
//  the map emptying or filling); each frame it just checks a flag.
// ============================================================

import { useEffect, useRef } from 'react'
import type * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { useGame } from '../core/store'
import { useEditor } from './draft'
import { isEmptyDraft } from './draftFile'

/** The name RoadView gives the group holding every road mesh. */
const ROAD_GROUP = 'road'

export function EmptyRoadHider(): null {
  const scene = useThree((s) => s.scene)
  const empty = useEditor((s) => s.mode === 'edit' && isEmptyDraft(s.draft))
  const trackVersion = useGame((s) => s.trackVersion)
  const group = useRef<THREE.Object3D | null>(null)

  // Find the road group again after every build (RoadView may have made a new one).
  useEffect(() => {
    group.current = scene.getObjectByName(ROAD_GROUP) ?? null
    if (group.current) group.current.visible = !empty
  }, [scene, empty, trackVersion])

  // Show the road again when the editor closes, whatever state it was left in.
  useEffect(
    () => () => {
      const g = scene.getObjectByName(ROAD_GROUP)
      if (g) g.visible = true
    },
    [scene],
  )

  // The group can mount a frame after the build: catch it then.
  useFrame(() => {
    if (!empty) return
    const g = group.current
    if (!g || !g.parent) {
      group.current = scene.getObjectByName(ROAD_GROUP) ?? null
      if (group.current) group.current.visible = false
    } else if (g.visible) g.visible = false
  })

  return null
}
