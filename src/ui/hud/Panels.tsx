// ============================================================
//  HUD PANELS - the parts of the HUD that depend on the mode
// ------------------------------------------------------------
//  RacePanel   P2 / 6, lap X of Y, the gap to the car ahead
//  StuntPanel  time left, score, your best
//  HuntPanel   energy cores found / total, the hunt clock
//  TagPanel    who's "it", your seconds as it, round clock
//  TrickBoard  banked trick points + the live combo
//  TrickFeed   the latest tricks, landing by landing
//  Toasts      short top-centre messages (best lap, joined ...)
//  Countdown   3 - 2 - 1 - GO
//  SpeedTrap   a big amber readout after a speed trap
//  DriveHint   the controls for your device, until you're driving
//
//  Anything that ticks every frame (clocks, the gap, the countdown)
//  has a data-hud="..." slot that the HUD's one animation loop
//  fills in (Hud.tsx). The rest re-renders from the store or the
//  HUD feed (feed.ts), a few times a lap at most.
// ============================================================

import { useEffect, useRef, useState } from 'react'
import { useGame } from '../../core/store'
import { useSettings } from '../../core/settings'
import { getCar, telemetry } from '../../core/telemetry'
import { useFeed } from './feed'
import { Glyph } from '../hints'
import { formatLap, formatScore } from '../format'

// ---------------------------------------------------------------- race

export function RacePanel() {
  const pos = useGame((s) => s.racePosition)
  const racers = useGame((s) => s.raceRacers)
  return (
    <div className="hud-panel hud-race">
      <div className="hud-race__pos">
        <span className="hud-race__p">P</span>
        <span key={pos} className="hud-race__num">
          {pos}
        </span>
        <span className="hud-race__of">/ {Math.max(racers, pos)}</span>
      </div>
      <div className="hud-race__side">
        <span className="hud-label" data-hud="raceLap">
          Lap 1
        </span>
        <span className="hud-race__gap" data-hud="raceGap">
          {' '}
        </span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- stunt

export function StuntPanel() {
  const score = useGame((s) => s.stuntScore)
  const best = useGame((s) => s.stuntBest)
  const running = useGame((s) => s.stuntEndsAt > 0)
  return (
    <div className="hud-panel hud-mode">
      <div className="hud-mode__top">
        <span className="hud-label">Stunt attack</span>
        <span className={`hud-mode__clock${running ? '' : ' is-idle'}`} data-hud="stuntClock">
          0:00
        </span>
      </div>
      <div className="hud-mode__big" key={score}>
        {formatScore(score)}
      </div>
      <div className="hud-lap__row">
        <span>Best</span>
        <b className="is-best">{formatScore(best)}</b>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- hunt

export function HuntPanel() {
  const found = useGame((s) => s.coresFound)
  const total = useGame((s) => s.coresTotal)
  const best = useGame((s) => s.huntBestMs)
  const running = useGame((s) => s.huntStartedAt > 0)
  const done = total > 0 && found >= total
  return (
    <div className={`hud-panel hud-hunt${done ? ' is-done' : ''}`}>
      <span className="hud-hunt__core" aria-hidden="true" />
      <div className="hud-hunt__count" key={found}>
        {found}
        <i>/{total}</i>
      </div>
      <div className="hud-hunt__side">
        <span className="hud-label">Energy cores</span>
        <span className={`hud-hunt__clock${running ? '' : ' is-idle'}`} data-hud="huntClock">
          {running ? '0:00.000' : best !== null ? `Best ${formatLap(best)}` : 'Find them all'}
        </span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- tag

export function TagPanel() {
  const it = useGame((s) => s.tagItId)
  const running = useGame((s) => s.tagEndsAt > 0)
  const me = it === 'player'
  const itName = it === null ? null : me ? 'You' : getCar(it)?.name ?? 'Someone'
  return (
    <div className={`hud-panel hud-mode hud-tagp${me ? ' is-it' : ''}`}>
      <div className="hud-mode__top">
        <span className="hud-label">Tag</span>
        <span className={`hud-mode__clock${running ? '' : ' is-idle'}`} data-hud="tagClock">
          0:00
        </span>
      </div>
      <div className="hud-mode__big hud-tagp__it">{itName === null ? 'Waiting' : me ? 'You\'re it' : `${itName} is it`}</div>
      <div className="hud-lap__row">
        <span>Time as it</span>
        <b data-hud="tagMine">0.0 s</b>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- tricks

export function TrickBoard() {
  const combo = useGame((s) => s.comboCount)
  return (
    <div className="hud-panel hud-tricks">
      <div className="hud-tricks__top">
        <span className="hud-label">Tricks</span>
        <span className={`hud-combo${combo > 1 ? ' is-on' : ''}`} aria-hidden={combo <= 1}>
          Combo x{Math.max(2, combo)}
        </span>
      </div>
      <div className="hud-tricks__score" data-hud="trickScore">
        0
      </div>
    </div>
  )
}

export function TrickFeed() {
  const pops = useFeed((s) => s.pops)
  return (
    <div className="hud-feed" aria-live="polite">
      {pops.map((p) => (
        <div key={p.id} className={`hud-pop hud-pop--${p.kind}${p.big ? ' is-big' : ''}`}>
          <span className="hud-pop__label">{p.label}</span>
          <span className="hud-pop__pts">{p.points >= 0 ? `+${formatScore(p.points)}` : `-${formatScore(-p.points)}`}</span>
          {p.combo > 1 && <span className="hud-pop__combo">x{p.combo}</span>}
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- toasts, trap, countdown

export function Toasts() {
  const toasts = useFeed((s) => s.toasts)
  return (
    <div className="hud-toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`hud-toast hud-toast--${t.kind}`}>
          <span className="hud-toast__text">{t.text}</span>
          {t.sub && <span className="hud-toast__sub">{t.sub}</span>}
        </div>
      ))}
    </div>
  )
}

export function SpeedTrap() {
  const trap = useFeed((s) => s.trap)
  if (!trap) return null
  return (
    <div key={trap.id} className={`hud-trap${trap.best ? ' is-best' : ''}`} role="status">
      <span className="hud-label">Speed trap</span>
      <span className="hud-trap__kmh">
        {Math.round(trap.kmh)}
        <i>km/h</i>
      </span>
      <span className="hud-trap__best">{trap.best ? 'New top speed!' : trap.bestKmh !== null ? `Best ${Math.round(trap.bestKmh)} km/h` : ''}</span>
    </div>
  )
}

/** Filled in by the HUD loop (number changes replay the pop animation). */
export function Countdown() {
  return <div className="hud-count" data-hud="countdown" aria-live="assertive" />
}

// ---------------------------------------------------------------- drive hint

const PAD_HINTS: [string, string][] = [
  ['LS', 'Steer'],
  ['RT', 'Gas'],
  ['LT', 'Brake'],
  ['A', 'Handbrake'],
  ['RB', 'Camera'],
  ['Y', 'Reset'],
  ['VIEW', 'Restart'],
  ['MENU', 'Menu'],
]

const KEY_HINTS: [string, string][] = [
  ['W A S D', 'Drive'],
  ['Space', 'Handbrake'],
  ['C', 'Camera'],
  ['R', 'Reset'],
  ['Shift+R', 'Restart'],
  ['Esc', 'Menu'],
]

/** Seconds of actual driving before the controls hint bows out. */
const HINT_DRIVE_S = 8

/**
 * The controls for whichever device you're holding, along the bottom
 * edge at the start of a run. It fades once you've been driving for a
 * few seconds, and comes back next run.
 */
export function DriveHint() {
  const pad = useGame((s) => s.inputDevice) === 'gamepad'
  const round = useGame((s) => s.round)
  const mp = useGame((s) => s.multiplayer)
  const [gone, setGone] = useState(false)
  const driven = useRef(0)
  useEffect(() => {
    setGone(false)
    driven.current = 0
    const t = setInterval(() => {
      if (telemetry.speedKmh > 10) driven.current += 0.5
      if (driven.current >= HINT_DRIVE_S) {
        setGone(true)
        clearInterval(t)
      }
    }, 500)
    return () => clearInterval(t)
  }, [round])
  const items = pad ? PAD_HINTS : KEY_HINTS
  const race: [string, string] | null = mp ? [pad ? 'X' : 'G', 'Start a race'] : null
  return (
    <div className={`hud-hint${gone ? ' is-gone' : ''}`} aria-hidden={gone}>
      {[...items, ...(race ? [race] : [])].map(([k, label]) => (
        <span className="hint" key={k}>
          <Glyph name={k} pad={pad} />
          <span className="hint__label">{label}</span>
        </span>
      ))}
    </div>
  )
}

/** Which mode panel goes in the top-left, under (or instead of) the lap panel. */
export function useModePanels(): { race: boolean; stunt: boolean; hunt: boolean; tag: boolean; tricks: boolean } {
  const mode = useGame((s) => s.mode)
  const coresTotal = useGame((s) => s.coresTotal)
  const tricks = useSettings((s) => s.tricks)
  return {
    race: mode === 'race',
    stunt: mode === 'stunt',
    hunt: mode === 'free' && coresTotal > 0,
    tag: mode === 'tag',
    tricks: tricks && (mode === 'free' || mode === 'stunt' || mode === 'tag'),
  }
}
