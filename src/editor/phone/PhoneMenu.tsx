// ============================================================
//  THE ROAD EDITOR'S MENU ON A PHONE - the whole track, one page
// ------------------------------------------------------------
//  A tall column on a computer; a page on a phone (comp-menu.png).
//  Down the left: Track and Map key, Library, then New track, Random
//  track and Exit. Across the top: Save, Save as new track, and the
//  way back. Everything in it is the panel's own (Panel.tsx, TrackSave.tsx).
// ============================================================

import { useMemo, useState } from 'react'
import { audio } from '../../core/api'
import { askNewTrack, askRandomTrack } from '../askFirst'
import { setName, useEditor } from '../draft'
import { TextField } from '../fields'
import { roadGeometry } from '../mapDraw'
import { Legend, TrackFields, TrackStats } from '../Panel'
import { roadLength } from '../road'
import { SaveAsNewButton, SaveButton, SaveSays, SaveStateLine } from '../TrackSave'

export function PhoneMenu(p: { onClose: () => void; onLibrary: () => void; onExit: () => void }) {
  const [tab, setTab] = useState<'track' | 'key'>('track')
  const draft = useEditor((s) => s.draft)
  const length = useMemo(() => roadLength(roadGeometry(draft.points, draft.width).rc), [draft.points, draft.width])
  const pick = (t: typeof tab) => {
    audio.ui('move')
    setTab(t)
  }
  return (
    <div className="phone-menu" role="dialog" aria-label="Road editor menu" data-testid="phone-menu">
      <nav className="phone-menu-nav" aria-label="Menu">
        <button type="button" className={tab === 'track' ? 'is-on' : ''} aria-pressed={tab === 'track'} onClick={() => pick('track')}>
          Track
        </button>
        <button type="button" className={tab === 'key' ? 'is-on' : ''} aria-pressed={tab === 'key'} data-testid="phone-menu-key" onClick={() => pick('key')}>
          Map key
        </button>
        <button
          type="button"
          data-testid="editor-library"
          onClick={() => {
            audio.ui('move')
            p.onClose()
            p.onLibrary()
          }}
        >
          Library
        </button>
        <span className="phone-menu-gap" />
        <button
          type="button"
          data-rail="newTrack"
          onClick={() => {
            audio.ui('move')
            p.onClose()
            askNewTrack()
          }}
        >
          New track
        </button>
        <button
          type="button"
          data-rail="random"
          onClick={() => {
            audio.ui('move')
            p.onClose()
            askRandomTrack()
          }}
        >
          Random track
        </button>
        <button
          type="button"
          data-testid="editor-exit"
          onClick={() => {
            audio.ui('move')
            p.onExit()
          }}
        >
          Exit
        </button>
      </nav>

      <header className="phone-menu-head">
        <span className="phone-menu-kicker">Road editor</span>
        <SaveButton />
        <SaveAsNewButton />
        <button
          type="button"
          className="sre-btn is-primary"
          data-testid="phone-menu-back"
          onClick={() => {
            audio.ui('back')
            p.onClose()
          }}
        >
          Back to the map
        </button>
      </header>

      <div
        className={`phone-menu-body is-${tab}`}
        onFocus={(e) => {
          // The keyboard comes up: keep the box being typed in on screen.
          const box = e.target
          if (box instanceof HTMLInputElement && box.type !== 'range') setTimeout(() => box.scrollIntoView({ block: 'nearest' }), 300)
          if (box instanceof HTMLTextAreaElement) setTimeout(() => box.scrollIntoView({ block: 'nearest' }), 300)
        }}
      >
        {tab === 'track' ? (
          <>
            <TextField label="Track name" value={draft.name} onCommit={setName} big />
            <div className="phone-this-track">
              <span className="sre-label">This track</span>
              <TrackStats draft={draft} length={length} />
              <SaveStateLine />
            </div>
            <TrackFields draft={draft} />
            <SaveSays />
          </>
        ) : (
          <Legend editing />
        )}
      </div>
    </div>
  )
}
