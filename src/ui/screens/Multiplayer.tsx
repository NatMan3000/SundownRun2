// ============================================================
//  MULTIPLAYER - the way in, so nobody types an address
// ------------------------------------------------------------
//  Opens from the title screen's Multiplayer link. Your name, and
//  one big Join. Join reloads this same page with ?mp=1&name=...
//  added (net/identity.ts joinUrl): the address is still what
//  switches multiplayer on, this screen just writes it for you.
//  A game saved to the Home Screen has no address bar, so this is
//  the only way in from there.
//
//  Typing works like the Report screen's boxes (it shares them):
//  Enter on the box to type, Esc to stop. Enter while typing joins.
// ============================================================

import { useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useGame } from '../../core/store'
import { audio } from '../../core/api'
import { joinUrl, playerName } from '../../net/identity'
import { NavScreen } from '../nav'
import { HelpLine } from '../widgets'
import { HintBar } from '../hints'
import { closeScreen, setFocus, useUi } from '../uiStore'
import { ActionButton, Field, stopTyping, useKeyboardFit } from './Report'
import type { TextEl } from './Report'

/** Name tags are 14 letters (cleanPlayerName). */
const NAME_MAX = 14

export function MultiplayerScreen() {
  const touch = useGame((s) => s.inputDevice) === 'touch'
  const [name, setName] = useState(playerName)
  const [editing, setEditing] = useState(false)
  const root = useRef<HTMLDivElement | null>(null)
  const box = useRef<TextEl | null>(null)
  useKeyboardFit(root, touch)

  useLayoutEffect(() => {
    const el = root.current
    return () => {
      // Leaving with the box still focused would leave the keyboard in 'text' (the car's keys dead).
      stopTyping(el)
      useUi.setState((s) => {
        const focus = { ...s.focus }
        delete focus.multiplayer
        return { focus }
      })
    }
  }, [])

  const startTyping = () => {
    const el = box.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }

  const join = () => {
    stopTyping(root.current)
    audio.ui('start')
    // Same page, same origin: a Home Screen copy stays in its own window.
    window.location.assign(joinUrl(window.location.href, name))
  }

  const back = () => {
    // A phone's one Back button says Done while the keyboard is up, and that is all it does then.
    if (touch && editing) {
      stopTyping(root.current)
      return
    }
    stopTyping(root.current)
    closeScreen()
  }

  const onKey = (_id: 'name', e: ReactKeyboardEvent<TextEl>) => {
    // Every key typed in the box stays in the box (the game's listener is on the window).
    e.stopPropagation()
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.currentTarget.blur()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      join()
    }
  }

  return (
    <NavScreen id="multiplayer" onBack={back} initial="join">
      <div ref={root} className="screen screen--report screen--mp">
        <div className="scrim scrim--left" aria-hidden="true" />
        <section className={`panel report-panel${touch ? (editing ? ' is-typing' : '') : ''}`} aria-label="Multiplayer">
          <div className={touch ? 'report-form nav-scroll' : 'report-form'}>
            <div className="screen-head">
              <span className="eyebrow">Play with friends</span>
              <h2 className="screen-title">Multiplayer</h2>
            </div>
            <p className="mp-intro">Race and play tag with friends in the same game. Pick a name, then Join, and everyone who joins shows up on your road.</p>
            <Field<'name'>
              id="name"
              label="Your name"
              value={name}
              max={NAME_MAX}
              placeholder="Your name"
              help="The name tag other players see over your car."
              enterKeyHint="go"
              editing={editing}
              onChange={setName}
              register={(_id, el) => {
                box.current = el
              }}
              startTyping={startTyping}
              clickBox={() => {
                if (document.activeElement !== box.current) startTyping()
              }}
              onKey={onKey}
              onFocusBox={() => {
                setEditing(true)
                setFocus('multiplayer', 'name')
              }}
              onBlurBox={() => setEditing(false)}
            />
          </div>
          <nav className="report-actions" aria-label="Join or cancel">
            <ActionButton id="join" label="Join" main acceptSound={null} acceptHint="Join" help="Reload the game with multiplayer on, under this name." onAccept={join} />
            <ActionButton id="cancel" label="Cancel" acceptSound="back" help="Back to the menu without joining." onAccept={back} />
          </nav>
          <HelpLine />
        </section>
        <HintBar
          items={[
            { action: 'move', label: 'Move' },
            { action: 'accept', label: 'Select' },
            { action: 'back', label: editing ? 'Done' : 'Back' },
          ]}
        />
      </div>
    </NavScreen>
  )
}
