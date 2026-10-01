// ============================================================
//  ROAD EDITOR - Josh draws tracks
// ------------------------------------------------------------
//  App.tsx mounts two things while the game is in the 'editor' phase:
//
//    <EditorScene />  inside the 3D canvas: the top-down camera. The
//                     world and road keep rendering the current track,
//                     which IS the draft (it is rebuilt as you edit).
//    <EditorUi />     the DOM on top: the pencil overlay, tools, the
//                     side panel and the track library.
//
//  How the pieces fit:
//    cleanup.ts     turns a pencil line into a drivable road (pure maths)
//    geom.ts        the 2D helpers it is built from
//    road.ts        "where on the road is this?" (at, offset), keeping
//                   pieces in place when points are added or removed
//    pieces.ts      the things you can place, and their rules
//    draft.ts       the track being edited, undo / redo, every edit action,
//                   save, test drive
//    draftFile.ts   the draft as a real track file, and the base worlds
//    view.ts        where the map is looking (pan and zoom)
//    Overlay.tsx    mouse and keyboard on the map, per tool
//    mapDraw.ts     everything drawn on the map
//    EditorUi.tsx   tool rail, piece palette, status line
//    Panel.tsx      this track, the selected thing, checks, map key
//    Library.tsx    open, new, copy, import, export
//    fields.tsx     the panel's sliders and boxes; icons.tsx its icons
//    dev.ts         __dev.editor(...) for checkers, ?editor=1
//    selfTest.ts    proves the maths works (bun src/editor/selfTest.ts)
// ============================================================

import { useEffect } from 'react'
import { setInputContext } from '../core/controls'
import { TopDownCamera } from './TopDownCamera'
import { EditorUi as EditorOverlayUi } from './EditorUi'
import { onEditorOpen } from './draft'
import { isMapOpen } from './worldMap'
import './dev'

export { EditorDrive, EditorDriveUi, startDriveToDraw } from './driveToDraw'
export { openWorldMap, closeWorldMap } from './worldMap'

export function EditorScene() {
  return <TopDownCamera />
}

export function EditorUi() {
  useEffect(() => {
    setInputContext('editor')
    // The world map opens over a paused game: never rebuild the track then.
    if (!isMapOpen()) onEditorOpen('edit')
  }, [])
  return <EditorOverlayUi />
}
