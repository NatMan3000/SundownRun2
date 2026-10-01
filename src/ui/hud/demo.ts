// ============================================================
//  HUD DEMO - fill the HUD with sample moments, for screenshots
// ------------------------------------------------------------
//  window.__dev.uiHudDemo('race') and friends. Checkers use this to
//  look at every HUD state without having to play into it.
//
//  Gameplay moments go through the REAL event feed (emit), so this
//  tests the same path a real trick or lap takes to the screen.
//  Panel numbers (race position, cores found ...) are written into
//  the store the way the play system would; the next real update
//  from the game simply overwrites them. Dev only, never called by
//  the game itself.
// ============================================================

import { emit } from '../../core/events'
import { useGame } from '../../core/store'

export const HUD_DEMO_HELP =
  "uiHudDemo(scene) - sample HUD state for screenshots: 'race', 'countdown', 'stunt', 'hunt', 'tag', 'tricks', 'toasts', 'trap', 'clear'"

export function hudDemo(scene: string): string {
  const now = performance.now()
  switch (scene) {
    case 'race':
      useGame.setState({ mode: 'race', raceState: 'running', raceLaps: 3, racePosition: 2, raceRacers: 6, lapCount: 1, lapStartedAt: now - 23456, sectorCount: 10, sectorsPassed: 4, bestLapMs: 61234, lastLapMs: 62890 })
      return 'race'
    case 'countdown':
      useGame.setState({ mode: 'race', raceState: 'countdown', raceGoAt: now + 3200, raceLaps: 3, racePosition: 4, raceRacers: 4 })
      emit('race.countdown', { seconds: 3, racers: 4 })
      return 'countdown (GO in 3.2 s)'
    case 'stunt':
      useGame.setState({ mode: 'stunt', stuntEndsAt: now + 83000, stuntScore: 12450, stuntBest: 18900, trickScore: 12450, comboCount: 3 })
      return 'stunt'
    case 'hunt':
      useGame.setState({ mode: 'free', coresFound: 5, coresTotal: 12, huntStartedAt: now - 47210, huntBestMs: 132400 })
      return 'hunt'
    case 'tag':
      useGame.setState({ mode: 'tag', tagItId: 'player', tagEndsAt: now + 95000, tagSeconds: { player: 14.2 } })
      emit('tag.it', { id: 'player', name: 'You', byId: null })
      return 'tag'
    case 'tricks':
      useGame.setState({ trickScore: (useGame.getState().trickScore || 0) + 4300, comboCount: 2 })
      emit('trick.land', { tricks: [{ name: 'bigAir', label: 'Big Air', points: 900 }, { name: 'flip', label: 'Flip', points: 1500 }], airTimeS: 1.8, combo: 2, points: 4800, clean: true })
      emit('drift.end', { seconds: 3.4, points: 640, maxAngleDeg: 38 })
      emit('trick.wipeout', { lostPoints: 1200 })
      return 'tricks'
    case 'toasts':
      emit('lap.complete', { lap: 3, ms: 61234, dirty: false, best: true, previousBestMs: 62011 })
      emit('lap.void', { reason: 'skipped-sector' })
      emit('mp.join', { name: 'JOSH', id: 'net-2' })
      return 'toasts'
    case 'trap':
      emit('speedtrap', { kmh: 312.4, best: true, previousBestKmh: 298 })
      return 'trap'
    case 'clear':
      useGame.setState({ mode: 'free', raceState: 'idle', raceGoAt: 0, stuntEndsAt: 0, coresTotal: 0, tagItId: null, tagEndsAt: 0, comboCount: 0 })
      return 'clear'
    default:
      return HUD_DEMO_HELP
  }
}
