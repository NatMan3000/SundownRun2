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
//    draft.ts       the track being edited, undo / redo, save, test drive
//    draftFile.ts   the draft as a real track file, and the base worlds
//    view.ts        where the map is looking (pan and zoom)
//    Overlay.tsx    pencil input and the map markings
//    EditorUi.tsx   toolbar, panel, library
//    dev.ts         __dev.editor(...) for checkers, ?editor=1
//    selfTest.ts    proves the clean-up works (bun src/editor/selfTest.ts)
// ============================================================

import { useEffect } from 'react'
import { setInputContext } from '../core/controls'
import { TopDownCamera } from './TopDownCamera'
import { EditorUi as EditorOverlayUi } from './EditorUi'
import { onEditorOpen } from './draft'
import './dev'

export function EditorScene() {
  return <TopDownCamera />
}

export function EditorUi() {
  useEffect(() => {
    setInputContext('editor')
    onEditorOpen('edit')
  }, [])
  return <EditorOverlayUi />
}
