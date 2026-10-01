// ============================================================
//  PAUSE MENU - Esc / Menu while driving
// ------------------------------------------------------------
//  Resume, Restart, Settings, the current track's live sliders
//  right here (the Hyperdrome's bank angle, so you can tilt the
//  banking and watch the road change), Road Editor, Quit.
//
//  Single player: the world is frozen behind this. Multiplayer:
//  the world can't stop for one player, so it keeps running and
//  your car just coasts while the menu is open.
// ============================================================

import { useGame } from '../../core/store'
import { openEditor, resumeGame } from '../../core/session'
import { NavScreen } from '../nav'
import { HelpLine, MenuButton } from '../widgets'
import { HintBar } from '../hints'
import { openScreen } from '../uiStore'
import { quitToTitle, restartSession } from '../flow'
import { TrackParamRows } from '../TrackParamRows'
import { SoundHint } from '../SoundHint'

const MODE_WORD = { free: 'Free Roam', timetrial: 'Time Trial', race: 'Race', stunt: 'Stunt Attack', tag: 'Tag' } as const

export function PauseScreen() {
  const mp = useGame((s) => s.multiplayer)
  const trackName = useGame((s) => s.trackName)
  const mode = useGame((s) => s.mode)
  return (
    <NavScreen id="pause" onBack={resumeGame} initial="resume">
      <div className="screen screen--pause screen--over-game">
        <div className="scrim scrim--left" aria-hidden="true" />
        <section className="panel pause-panel" aria-label={mp ? 'Menu' : 'Paused'}>
          <div className="screen-head">
            <span className="eyebrow">
              {trackName || 'Track'} · {MODE_WORD[mode]}
            </span>
            <h2 className="screen-title">{mp ? 'Menu' : 'Paused'}</h2>
          </div>
          {mp && <p className="pause-note">Multiplayer: the world keeps running while this menu is open.</p>}
          <nav className="pause-menu" aria-label="Pause menu">
            <MenuButton id="resume" label="Resume" help="Back to the road." onAccept={resumeGame} acceptSound="back" />
            <MenuButton id="restart" label="Restart" help="Start this run again from the start line." onAccept={restartSession} acceptSound="start" />
            <MenuButton id="settings" label="Settings" help="Handling, camera, sound, time of day and more. Changes apply straight away." onAccept={() => openScreen('settings')} />
            <div className="pause-params">
              <TrackParamRows idPrefix="pause-track" />
            </div>
            <MenuButton id="editor" label="Road Editor" help="Draw your own track. This run ends." onAccept={openEditor} />
            <MenuButton id="quit" label="Quit to title" help="Leave this run and go back to the title screen." onAccept={quitToTitle} acceptSound="back" />
          </nav>
          <HelpLine />
          <SoundHint variant="menu" />
        </section>
        <HintBar
          items={[
            { action: 'move', label: 'Move' },
            { action: 'accept', label: 'Select' },
            { action: 'back', label: 'Resume' },
          ]}
        />
      </div>
    </NavScreen>
  )
}
