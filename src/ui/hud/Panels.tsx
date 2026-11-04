// ============================================================
//  HUD PANELS - the parts of the HUD that depend on the mode
// ------------------------------------------------------------
//  RacePanel   P2 / 6, lap X of Y, the gap to the car ahead
//  StuntPanel  time left, score, your best
//  HuntPanel   energy cores found / total, the hunt clock
//  TagPanel    who's "it", your seconds as it, round clock
//  TurnsPanel  Hunt Turns: hunting or running, the turn and its clock,
//              everyone's catches, the pulse (hunter), and an arrow
//              to the nearest runner (hunter) or to the hunter
//  TurnsCard   Hunt Turns: the between-turns card ("Your turn to hunt")
//  TrickBoard  banked trick points + the live combo
//  TrickFeed   the latest tricks, landing by landing
//  Toasts      short top-centre messages (best lap, joined ...)
//  Countdown   3 - 2 - 1 - GO
//  SpeedTrap   a big amber readout after a speed trap
//  DriveHint   the controls for your device, until you're driving
//  (the rewind meter, screen tint and REWIND tag are in Rewind.tsx)
//  AirTrickHint  how to flip and roll, only while you're in the air
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
import type { TrapReadout } from './feed'
import { on } from '../../core/events'
import { Glyph } from '../hints'
import { formatLap, formatScore, formatTopSpeed } from '../format'

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
      {/* While you're "it": which way the nearest player is, and how far (the HUD loop fills it in and shows it). */}
      <div className="hud-lap__row hud-tagp__hunt" data-hud="tagHunt" style={{ display: 'none' }}>
        <span>Nearest</span>
        <b>
          <svg className="hud-tagp__arrow" data-hud="tagArrow" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 2 L20 20 L12 15.5 L4 20 Z" />
          </svg>
          <span data-hud="tagDist">0 m</span>
        </b>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- hunt turns

function nameFor(id: string, names: Record<string, string>): string {
  return id === 'player' ? 'You' : names[id] ?? getCar(id)?.name ?? 'Someone'
}

export function TurnsPanel() {
  const turns = useGame((s) => s.turns)
  const hunter = turns?.hunterId ?? null
  const me = hunter === 'player'
  const names = turns?.names ?? {}
  // You first, then everyone else by points.
  const pts = (id: string) => turns?.points[id] ?? 0
  const ids = turns ? Object.keys(turns.catches).sort((a, b) => (a === 'player' ? -1 : b === 'player' ? 1 : pts(b) - pts(a))) : []
  const big = !turns ? 'Get ready' : turns.done ? 'Round over' : hunter === null ? 'Next turn' : me ? 'You\'re hunting' : 'Run!'
  return (
    <div className={`hud-panel hud-mode hud-tagp hud-turnsp${me ? ' is-it' : ''}`}>
      <div className="hud-mode__top">
        <span className="hud-label">{turns ? `Turn ${turns.turn} of ${turns.turns}` : 'Hunt Turns'}</span>
        <span className={`hud-mode__clock${turns && !turns.done ? '' : ' is-idle'}`} data-hud="turnsClock">
          0:00
        </span>
      </div>
      <div className="hud-mode__big hud-tagp__it">{big}</div>
      {hunter !== null && !me && <div className="hud-turnsp__who">{nameFor(hunter, names)} is hunting</div>}
      {hunter !== null && !me && <div className="hud-turnsp__earn">Tricks and rings score!</div>}
      {me && <div className="hud-turnsp__earn is-hunting">Catches score {formatScore(turns?.catchPoints ?? 0)}</div>}
      <div className="hud-turnsp__rows">
        {ids.map((id) => (
          <div key={id} className={`hud-turnsp__row${id === hunter ? ' is-hunter' : ''}${id === 'player' ? ' is-me' : ''}`}>
            <span className="hud-turnsp__name">{nameFor(id, names)}</span>
            <span className="hud-turnsp__c">{turns?.catches[id] ?? 0} {(turns?.catches[id] ?? 0) === 1 ? 'catch' : 'catches'}</span>
            <b className="hud-turnsp__n">{formatScore(pts(id))}</b>
          </div>
        ))}
        <div className="hud-turnsp__unit">points</div>
      </div>
      {/* The hunter's tag pulse: ready, or how long until it is (the HUD loop writes it). Always in the
          DOM (hidden while running) so the loop's handle on it survives the panel re-rendering. */}
      <div className="hud-lap__row hud-turnsp__pulse" style={{ display: me ? '' : 'none' }}>
        <span>Pulse</span>
        <b data-hud="turnsPulse">Ready</b>
      </div>
      {/* Hunter: the way to the nearest runner. Runner: the way to the hunter, and how far. (The HUD loop fills it in.) */}
      <div className="hud-lap__row hud-tagp__hunt" data-hud="turnsHunt" style={{ display: 'none' }}>
        <span data-hud="turnsHuntLabel">Nearest</span>
        <b>
          <svg className="hud-tagp__arrow" data-hud="turnsArrow" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 2 L20 20 L12 15.5 L4 20 Z" />
          </svg>
          <span data-hud="turnsDist">0 m</span>
        </b>
      </div>
    </div>
  )
}

/** Between two turns: who hunts next, and how the last turn went. Shown until the next countdown. */
export function TurnsCard() {
  const turns = useGame((s) => s.turns)
  const until = turns?.cardUntil ?? 0
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!until) return
    const left = until - performance.now()
    if (left <= 0) return
    const t = setTimeout(() => setTick((n) => n + 1), left + 30)
    return () => clearTimeout(t)
  }, [until])
  if (!turns || !until || performance.now() >= until) return null
  const next = turns.nextHunterId
  const last = turns.history[turns.history.length - 1]
  const lastLine = last ? `${last.hunterId === 'player' ? 'You' : nameFor(last.hunterId, turns.names)} caught ${last.catches === 0 ? 'nobody' : last.catches === 1 ? '1' : last.catches}` : ''
  return (
    <div className={`hud-turnscard${next === 'player' ? ' is-hunter' : ''}`} role="status">
      <span className="hud-label">
        Turn {turns.turn} of {turns.turns}
      </span>
      <span className="hud-turnscard__big">{next === 'player' ? 'Your turn to hunt' : 'Run!'}</span>
      {next !== null && next !== 'player' && <span className="hud-turnscard__sub">{nameFor(next, turns.names)} hunts next</span>}
      {turns.points && (
        <span className="hud-turnscard__last">
          {Object.keys(turns.points)
            .sort((a, b) => (turns.points[b] ?? 0) - (turns.points[a] ?? 0))
            .map((id) => `${id === 'player' ? 'You' : nameFor(id, turns.names)} ${formatScore(turns.points[id] ?? 0)}`)
            .join(' · ')}
        </span>
      )}
      {lastLine && <span className="hud-turnscard__last">Last turn: {lastLine}</span>}
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

/** "New top speed!" or "Best 224 km/h"; on the Hyperdrome each bank angle has its own best, so the angle is named. */
function trapBestLine(trap: TrapReadout): string {
  if (trap.best) return trap.angle ? `New top speed at ${trap.angle}!` : 'New top speed!'
  if (trap.bestKmh === null) return ''
  return `Best ${formatTopSpeed(trap.bestKmh, trap.angle)}`
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
      <span className="hud-trap__best">{trapBestLine(trap)}</span>
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
  ['LB', 'Rewind'],
  ['Y', 'Reset'],
  ['VIEW', 'Restart'],
  ['B', 'Next song'],
  ['MENU', 'Menu'],
]

const KEY_HINTS: [string, string][] = [
  ['W A S D', 'Drive'],
  ['Space', 'Handbrake'],
  ['C', 'Camera'],
  ['Backspace', 'Rewind'],
  ['R', 'Reset'],
  ['Shift+R', 'Restart'],
  ['N', 'Next song'],
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
  const device = useGame((s) => s.inputDevice)
  const pad = device === 'gamepad'
  const round = useGame((s) => s.round)
  const mp = useGame((s) => s.multiplayer)
  const mode = useGame((s) => s.mode)
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
  // On a phone the controls are on the screen, each with its name on it.
  if (device === 'touch') return null
  // Rewind is off in multiplayer, so its hint is too.
  const items = (pad ? PAD_HINTS : KEY_HINTS).filter(([, label]) => !(mp && label === 'Rewind'))
  const race: [string, string] | null = mp ? [pad ? 'X' : 'G', 'Start a race'] : null
  // Hunt Turns: the hunter's tag pulse.
  const pulse: [string, string] | null = mp && mode === 'turns' ? [pad ? 'RS' : 'F', 'Tag pulse'] : null
  return (
    <div className={`hud-hint${gone ? ' is-gone' : ''}`} aria-hidden={gone}>
      {[...items, ...(pulse ? [pulse] : []), ...(race ? [race] : [])].map(([k, label]) => (
        <span className="hint" key={k}>
          <Glyph name={k} pad={pad} />
          <span className="hint__label">{label}</span>
        </span>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- air-trick hint

/** Seconds in the air before the trick hint shows (small hops don't count). */
const AIR_HINT_DELAY_S = 0.2

/**
 * "Space + W A S D in the air: tricks" (or "A + LS" on the pad), shown only
 * while the car is airborne, so the hint bar stays calm on the ground. Once
 * you land a flip, spin or roll this round, you know: it stays hidden until
 * the next round.
 */
export function AirTrickHint() {
  const device = useGame((s) => s.inputDevice)
  const pad = device === 'gamepad'
  const round = useGame((s) => s.round)
  const tricks = useSettings((s) => s.tricks)
  const [show, setShow] = useState(false)
  const learned = useRef(false)
  useEffect(() => {
    learned.current = false
    const off = on('trick.land', (e) => {
      if (e.tricks.some((t) => t.name === 'flip' || t.name === 'spin' || t.name === 'roll')) learned.current = true
    })
    // A few checks a second is plenty; React state only changes on the edges.
    let shown = false
    const t = setInterval(() => {
      const want = !learned.current && telemetry.airborne && telemetry.airTime >= AIR_HINT_DELAY_S
      if (want !== shown) {
        shown = want
        setShow(want)
      }
    }, 100)
    return () => {
      off()
      clearInterval(t)
    }
  }, [round])
  if (!tricks) return null
  return (
    <div className={`hud-hint hud-hint--air${show ? '' : ' is-gone'}`} aria-hidden={!show}>
      {device === 'touch' ? (
        <span className="hint">
          <span className="hint__label">Hold Drift and push the stick in the air: tricks</span>
        </span>
      ) : (
        <span className="hint">
          <Glyph name={pad ? 'A' : 'Space'} pad={pad} />
          <span className="hint__plus">+</span>
          <Glyph name={pad ? 'LS' : 'W A S D'} pad={pad} />
          <span className="hint__label">in the air: tricks</span>
        </span>
      )}
    </div>
  )
}

/** Which mode panel goes in the top-left, under (or instead of) the lap panel. */
export function useModePanels(): { race: boolean; stunt: boolean; hunt: boolean; tag: boolean; turns: boolean; tricks: boolean } {
  const mode = useGame((s) => s.mode)
  const coresTotal = useGame((s) => s.coresTotal)
  const tricks = useSettings((s) => s.tricks)
  // Hunt Turns already lists everyone's points; a phone hasn't the room to say it twice.
  const touch = useGame((s) => s.inputDevice) === 'touch'
  return {
    race: mode === 'race',
    stunt: mode === 'stunt',
    hunt: mode === 'free' && coresTotal > 0,
    tag: mode === 'tag',
    turns: mode === 'turns',
    tricks: tricks && (mode === 'free' || mode === 'stunt' || mode === 'tag' || (mode === 'turns' && !touch)),
  }
}
