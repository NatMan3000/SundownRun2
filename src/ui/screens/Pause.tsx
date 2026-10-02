// ============================================================
//  PAUSE MENU - Esc / Menu while driving
// ------------------------------------------------------------
//  Resume, Restart, Settings, Map (the editor's top-down world map;
//  this menu hides while it's open), Stunt park / Back to the track
//  (only on a walled track whose stunt park sits in the infield:
//  play.parkHop), the current track's live sliders
//  right here (the Hyperdrome's bank angle, so you can tilt the
//  banking and watch the road change), the music (Next song, Save
//  song, All songs / Favourites: SongRows.tsx), Road Editor, Report a
//  problem (screens/Report.tsx), Quit.
//
//  Single player: the world is frozen behind this. Multiplayer:
//  the world can't stop for one player, so it keeps running and
//  your car just coasts while the menu is open.
// ============================================================

import { useGame } from '../../core/store'
import { openEditor, openMap, resumeGame } from '../../core/session'
import { play } from '../../core/api'
import { NavScreen } from '../nav'
import { HelpLine, MenuButton } from '../widgets'
import { HintBar } from '../hints'
import { openScreen } from '../uiStore'
import { quitToTitle, restartSession } from '../flow'
import { TrackParamRows } from '../TrackParamRows'
import { SoundHint } from '../SoundHint'
import { SongRows } from '../SongRows'

/**
 * The Map button opens the editor's top-down world map over the paused game.
 * The editor's map and its Back / Esc (closeMap) are wired, so it's on. Set
 * this to false to hide the button if the map ever breaks: opening a map
 * with no way back would strand the player on an empty screen.
 */
const MAP_READY = true

const MODE_WORD = { free: 'Free Roam', timetrial: 'Time Trial', race: 'Race', stunt: 'Stunt Attack', tag: 'Tag' } as const

export function PauseScreen() {
  const mp = useGame((s) => s.multiplayer)
  const trackName = useGame((s) => s.trackName)
  const mode = useGame((s) => s.mode)
  // Asked when the menu opens: where the car is decides which way the hop goes.
  const hop = play.parkHop()
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
            {MAP_READY && <MenuButton id="map" label="Map" help="The whole world from above: where you are, the road and everything on it." onAccept={openMap} />}
            {hop && (
              <MenuButton
                id="park-hop"
                label={hop === 'park' ? 'Stunt park' : 'Back to the track'}
                help={hop === 'park' ? 'Jump into the stunt park in the middle of the stadium: big ramps, gaps, rings and bullseyes.' : 'Back onto the road, at the start line.'}
                onAccept={() => {
                  play.doParkHop()
                  resumeGame()
                }}
                acceptSound="start"
              />
            )}
            <div className="pause-params">
              <TrackParamRows idPrefix="pause-track" />
            </div>
            <SongRows />
            <MenuButton id="editor" label="Road Editor" help="Draw your own track. This run ends." onAccept={openEditor} />
            <MenuButton id="report" label="Report a problem" help="Something broken, or got an idea? Send it to the game's GitHub page. Your car stays right here." onAccept={() => openScreen('report')} />
            <MenuButton id="quit" label="Quit to title" help="Leave this run and go back to the title screen." onAccept={quitToTitle} acceptSound="back" />
          </nav>
          <HelpLine />
        </section>
        <SoundHint variant="menu" />
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
