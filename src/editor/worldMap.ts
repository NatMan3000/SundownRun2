// ============================================================
//  WORLD MAP - the editor's top-down view, read-only, over a paused game
// ------------------------------------------------------------
//  "Map" in the pause menu (session.openMap) opens the track you are
//  driving as a map: the editor's top-down view with your car, the
//  other cars, and every piece, prop pile and energy core labelled.
//  Nothing can be edited. Back or Esc (session.closeMap) and you are
//  on the pause menu again, exactly where you were: the game stays
//  paused underneath and nothing is rebuilt.
//
//  This module watches the store's mapOpen flag. When it turns on,
//  the editor's own draft is put aside and the track being driven is
//  shown instead; when it turns off, the draft comes back, so opening
//  the map never touches editor work.
// ============================================================

import { useGame } from '../core/store'
import { closeMap, openMap } from '../core/session'
import { audio } from '../core/api'
import { getCurrentTrackFile } from '../track/current'
import { type Draft, draftFromFile, useEditor } from './draft'
import { fitToDraft } from './Overlay'

let editorDraft: Draft | null = null

export function isMapOpen(): boolean {
  return useGame.getState().mapOpen
}

/** Open the world map (only over a paused game). */
export function openWorldMap(): void {
  openMap()
}

/** Close the map and go back to the pause menu. */
export function closeWorldMap(): void {
  closeMap()
}

function showMap(): void {
  const file = getCurrentTrackFile()
  if (!file) return
  const s = useEditor.getState()
  if (s.mode !== 'map') editorDraft = s.draft
  useEditor.setState({ mode: 'map', draft: draftFromFile(file, false), selection: null, notes: null, errors: [], warnings: [] })
  audio.ui('select')
  requestAnimationFrame(fitToDraft)
}

function hideMap(): void {
  useEditor.setState({ mode: 'edit', draft: editorDraft ?? useEditor.getState().draft, selection: null })
  editorDraft = null
  audio.ui('back')
}

// React to the flag, whoever set it (the pause menu, Esc, a dev command).
if (typeof window !== 'undefined') {
  useGame.subscribe((s, prev) => {
    if (s.mapOpen && !prev.mapOpen) showMap()
    else if (!s.mapOpen && prev.mapOpen) hideMap()
  })
}
