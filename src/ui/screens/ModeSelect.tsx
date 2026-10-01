// ============================================================
//  MODE SELECT - what kind of drive
// ------------------------------------------------------------
//  Solo:        Free Roam, Time Trial, Race (with the Ai count
//               and difficulty right there), Stunt Attack.
//  Multiplayer: Race, Free Roam, Tag (Ai racers are solo only).
//
//  Picking a mode opens the track select.
// ============================================================

import type { GameMode } from '../../core/store'
import { useGame } from '../../core/store'
import { SETTING_RANGES, getDefaults, useSettings } from '../../core/settings'
import { NavScreen } from '../nav'
import { MenuButton, SliderRow, HelpLine } from '../widgets'
import { HintBar } from '../hints'
import { closeScreen, openScreen, useUi } from '../uiStore'
import { formatDifficulty } from '../format'

interface ModeInfo {
  mode: GameMode
  label: string
  help: string
}

const SOLO_MODES: ModeInfo[] = [
  { mode: 'free', label: 'Free Roam', help: 'Explore the world, pull tricks, smash props and hunt the energy cores against the clock.' },
  { mode: 'timetrial', label: 'Time Trial', help: 'Set your fastest clean lap. Your ghost drives your best lap beside you.' },
  { mode: 'race', label: 'Race', help: 'Race the Ai from the grid. First over the line after the last lap wins.' },
  { mode: 'stunt', label: 'Stunt Attack', help: 'A timed run for the biggest trick score. Land it or lose it.' },
]

const MP_MODES: ModeInfo[] = [
  { mode: 'race', label: 'Race', help: 'Race everyone here from a synced start grid.' },
  { mode: 'free', label: 'Free Roam', help: 'Drive together, pull tricks and shove each other around.' },
  { mode: 'tag', label: 'Tag', help: 'One player is "it" and glows. Bump someone to pass it on. Least time as "it" wins.' },
]

export function ModeSelectScreen() {
  const mp = useGame((s) => s.multiplayer)
  const pending = useUi((s) => s.pendingMode)
  const aiRacers = useSettings((s) => s.aiRacers)
  const aiDifficulty = useSettings((s) => s.aiDifficulty)
  const modes = mp ? MP_MODES : SOLO_MODES
  const pick = (mode: GameMode) => {
    useUi.setState({ pendingMode: mode })
    openScreen('track')
  }
  const rAi = SETTING_RANGES.aiRacers!
  const rDiff = SETTING_RANGES.aiDifficulty!
  return (
    <NavScreen id="mode" onBack={closeScreen} initial={`mode:${pending}`}>
      <div className="screen screen--mode">
        <div className="scrim scrim--left" aria-hidden="true" />
        <div className="title-col title-col--sub">
          <div className="screen-head">
            <span className="eyebrow">Play</span>
            <h2 className="screen-title">Choose a mode</h2>
          </div>
          <nav className="mode-list" aria-label="Game modes">
            {modes.map((m) => (
              <div className="mode-item" key={m.mode}>
                <MenuButton id={`mode:${m.mode}`} label={m.label} help={m.help} onAccept={() => pick(m.mode)} />
                {m.mode === 'race' && !mp && (
                  <div className="mode-options">
                    <SliderRow
                      id="race:ai"
                      label="Ai racers"
                      value={aiRacers}
                      min={rAi.min}
                      max={rAi.max}
                      step={rAi.step}
                      format={(v) => (v === 0 ? 'Just you' : String(Math.round(v)))}
                      onChange={(v) => useSettings.getState().set('aiRacers', v)}
                      defaultValue={getDefaults().aiRacers}
                      help="How many Ai cars line up against you, 0 to 5."
                    />
                    <SliderRow
                      id="race:difficulty"
                      label="Difficulty"
                      value={aiDifficulty}
                      min={rDiff.min}
                      max={rDiff.max}
                      step={rDiff.step}
                      format={formatDifficulty}
                      onChange={(v) => useSettings.getState().set('aiDifficulty', v)}
                      defaultValue={getDefaults().aiDifficulty}
                      help="How badly the Ai racers want to win."
                    />
                  </div>
                )}
              </div>
            ))}
          </nav>
          <HelpLine />
        </div>
        <HintBar
          items={[
            { action: 'move', label: 'Move' },
            { action: 'accept', label: 'Select' },
            { action: 'back', label: 'Back' },
          ]}
        />
      </div>
    </NavScreen>
  )
}
