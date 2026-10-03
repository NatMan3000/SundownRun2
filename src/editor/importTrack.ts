// ============================================================
//  IMPORT A TRACK - one way in for a track from somewhere else
// ------------------------------------------------------------
//  The Library's "Import a track file" and the Shared tracks list's
//  Download both bring a track in through here, so they check it the
//  same way and say the same words:
//
//    - the game's validator checks every field (src/track/validate.ts),
//      and a broken or cut-off file is refused in plain words;
//    - it never lands on top of a track already here: a name that is
//      taken gets the next free number ("Canyon Run 2"), and an id that
//      is taken (yours or a built-in's) gets a free one.
// ============================================================

import { getTrackSource, importTrackJson, listDrawnTracks } from '../track/registry'
import { freeIdFor, freeName } from './draft'

export type ImportResult = { ok: true; id: string; name: string; renamed: string | null } | { ok: false; why: string }

/** Import a track file's text: checked, saved in this browser's Library, never overwriting. */
export function importTrackText(text: string): ImportResult {
  const safe = keepOthersSafe(text)
  const result = importTrackJson(safe.text)
  if (!result.ok) {
    const why = result.errors[0]?.message ?? ''
    // A broken file (cut off, or edited by hand) fails as JSON: say that in plain words.
    const plain = why.startsWith('Not valid JSON') ? "it isn't a complete track file (it may be cut off, or something was typed into it by mistake)" : why || 'something in it is wrong'
    return { ok: false, why: plain }
  }
  return { ok: true, id: safe.id ?? result.track?.id ?? '', name: result.track?.name ?? '', renamed: safe.renamed }
}

/**
 * An imported track never lands on top of one already saved here: if its id
 * is taken (by one of your tracks or a built-in) it gets a free one, and if
 * its name is taken it gets the next free number ("Canyon Run 2"). Returns
 * the file's text to import, its id, and the name it had if it was renamed.
 * Text that isn't a track goes through untouched (the import says what is
 * wrong with it).
 */
export function keepOthersSafe(text: string): { text: string; id: string | null; renamed: string | null } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { text, id: null, renamed: null }
  }
  if (!parsed || typeof parsed !== 'object') return { text, id: null, renamed: null }
  const file = parsed as { id?: unknown; name?: unknown }
  if (typeof file.id !== 'string' || typeof file.name !== 'string') return { text, id: null, renamed: null }
  const idTaken = listDrawnTracks().some((t) => t.id === file.id) || getTrackSource(file.id) === 'builtin'
  const name = freeName(file.name)
  if (!idTaken && name === file.name.trim()) return { text, id: file.id, renamed: null }
  const was = file.name
  file.name = name
  if (idTaken) file.id = freeIdFor(name)
  return { text: JSON.stringify(file), id: file.id as string, renamed: name !== was.trim() ? was : null }
}
