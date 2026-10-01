// ============================================================
//  HUD - what you see while driving
// ------------------------------------------------------------
//  Corners only, so nothing covers the road ahead:
//    top-left      race position / stunt / tag panel, then the lap
//                  panel (lap, clock, last, best, sector ticks, the
//                  off-road marker), then the energy-core hunt
//    top-right     minimap
//    bottom-left   the trick feed and trick score
//    bottom-right  speed trap readout, speed, gear, rpm arc, boost glow
//    top-centre    short toasts (best lap, lap void, player joined)
//  The 3-2-1-GO countdown is the one thing allowed in the middle,
//  and only while the cars are still on the grid.
//
//  Two update paths, on purpose (CONSTITUTION section 2):
//    - Numbers that change every frame (speed, rpm, the lap clock,
//      the minimap) are written straight into the DOM from ONE
//      requestAnimationFrame loop, through refs. Never React state.
//    - Things that change a few times a lap (lap count, best lap,
//      sectors) come from the store and re-render normally.
// ============================================================

import { useEffect, useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { useGame, getGame } from '../../core/store'
import { useSettings } from '../../core/settings'
import { cars, getCar, telemetry } from '../../core/telemetry'
import type { CarState } from '../../core/telemetry'
import { frameStats } from '../../core/perf'
import { getTrack } from '../../track/current'
import { formatClock, formatLap, formatScore } from '../format'
import { installFeed } from './feed'
import { SoundHint } from '../SoundHint'
import { AirTrickHint, Countdown, DriveHint, HuntPanel, RacePanel, SpeedTrap, StuntPanel, TagPanel, Toasts, TrickBoard, TrickFeed, useModePanels } from './Panels'
import { drawMinimap, invalidateMinimap, setMinimapCanvas } from './Minimap'

/** Text writes per second for numbers. The eye can't read a 60 Hz speedo anyway. */
const TEXT_MS = 1000 / 20
/** Minimap redraws per second. */
const MAP_MS = 1000 / 30
/** FPS meter writes per second. */
const FPS_MS = 250
/** Mode clocks and the race gap: 4 writes a second is plenty. */
const SLOW_MS = 250

/** The rpm arc covers 270 degrees of a circle of radius 44 (in a 100x100 box). */
const ARC_R = 44
const ARC_LEN = 2 * Math.PI * ARC_R * 0.75

// DOM writes need strings. Building one every frame would allocate every
// frame, so the strings the loop writes most are made once, up front.
const RPM_STEPS = 400
const RPM_STR: string[] = []
for (let i = 0; i <= RPM_STEPS; i++) RPM_STR.push((ARC_LEN * (1 - i / RPM_STEPS)).toFixed(2))
const BOOST_STR: string[] = []
for (let i = 0; i <= 100; i++) BOOST_STR.push((i / 100).toFixed(2))
const NUM_STR: string[] = []
for (let i = 0; i <= 999; i++) NUM_STR.push(String(i))
const num = (n: number) => (n >= 0 && n <= 999 ? NUM_STR[n] : String(n))

function LapPanel() {
  const lapCount = useGame((s) => s.lapCount)
  const lastLapMs = useGame((s) => s.lastLapMs)
  const lastDirty = useGame((s) => s.lastLapDirty)
  const bestLapMs = useGame((s) => s.bestLapMs)
  const dirty = useGame((s) => s.currentLapDirty)
  const sectors = useGame((s) => s.sectorCount)
  const passed = useGame((s) => s.sectorsPassed)
  const armed = useGame((s) => s.lapStartedAt > 0)
  const ticks: number[] = []
  for (let i = 0; i < sectors; i++) ticks.push(i)
  return (
    <div className="hud-panel hud-lap">
      <div className="hud-lap__top">
        <span className="hud-label">Lap {lapCount + 1}</span>
        <span className={`hud-tag${dirty ? ' is-on' : ''}`} aria-hidden={!dirty}>
          Off road
        </span>
      </div>
      <div className={`hud-lap__clock${dirty ? ' is-dirty' : ''}${armed ? '' : ' is-idle'}`} data-hud="clock">
        0:00.000
      </div>
      {sectors > 0 && (
        <div className="hud-sectors" aria-label={`${passed} of ${sectors} sectors`}>
          {ticks.map((i) => (
            <i key={i} className={i < passed ? (dirty ? 'is-dirty' : 'is-on') : ''} />
          ))}
        </div>
      )}
      <div className="hud-lap__rows">
        <div className="hud-lap__row">
          <span>Last</span>
          <b className={lastDirty ? 'is-dirty' : ''}>{formatLap(lastLapMs)}</b>
        </div>
        <div className="hud-lap__row">
          <span>Best</span>
          <b className="is-best">{formatLap(bestLapMs)}</b>
        </div>
      </div>
    </div>
  )
}

function SpeedCluster() {
  // 270-degree arc: the gap sits at the bottom, opening toward the screen edge.
  const dash = `${ARC_LEN} ${2 * Math.PI * ARC_R}`
  return (
    <div className="hud-speed" data-hud="cluster">
      <div className="hud-speed__boost" aria-hidden="true" />
      <svg className="hud-speed__arc" viewBox="0 0 100 100" aria-hidden="true">
        <circle className="arc-track" cx="50" cy="50" r={ARC_R} strokeDasharray={dash} />
        <circle className="arc-fill" data-hud="rpm" cx="50" cy="50" r={ARC_R} strokeDasharray={dash} strokeDashoffset={ARC_LEN} />
      </svg>
      <div className="hud-speed__readout">
        <span className="hud-speed__num" data-hud="speed">
          0
        </span>
        <span className="hud-speed__unit">km/h</span>
        <span className="hud-speed__gear" data-hud="gear">
          1
        </span>
      </div>
    </div>
  )
}

/** The minimap box takes the track's shape: a long oval gets a wide, short box. */
function minimapHeightEm(): number {
  const mm = getTrack()?.minimap
  if (!mm) return 14
  const aspect = (mm.maxZ - mm.minZ + 30) / Math.max(1, mm.maxX - mm.minX + 30)
  return Math.min(15, Math.max(7, 14 * aspect))
}

function MinimapPanel() {
  useGame((s) => s.trackVersion)
  const ref = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    setMinimapCanvas(ref.current)
    const ro = new ResizeObserver(() => invalidateMinimap())
    if (ref.current) ro.observe(ref.current)
    return () => {
      ro.disconnect()
      setMinimapCanvas(null)
    }
  }, [])
  return (
    <div className="hud-panel hud-map" style={{ height: `${minimapHeightEm().toFixed(2)}em` }}>
      <canvas ref={ref} className="hud-map__canvas" aria-label="Minimap" />
      <span className="hud-map__north" aria-hidden="true">
        N
      </span>
    </div>
  )
}

function FpsMeter() {
  return (
    <div className="hud-fps" aria-hidden="true">
      <b data-hud="fps">60</b>
      <span>fps</span>
      <b data-hud="fpsCost">0.0</b>
      <span>ms</span>
    </div>
  )
}

/** Bumped after every HUD render, so the loop knows to look its nodes up again. */
const layout = { v: 0 }

/** The one animation loop that writes per-frame numbers into the HUD. */
function useHudLoop(root: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const el = root.current
    if (!el) return
    const q = <T extends Element>(name: string) => el.querySelector(`[data-hud="${name}"]`) as T | null
    const refs = {
      speed: null as HTMLElement | null,
      gear: null as HTMLElement | null,
      rpm: null as SVGCircleElement | null,
      cluster: null as HTMLElement | null,
      clock: null as HTMLElement | null,
      fps: null as HTMLElement | null,
      fpsCost: null as HTMLElement | null,
      trickScore: null as HTMLElement | null,
      raceGap: null as HTMLElement | null,
      huntClock: null as HTMLElement | null,
      stuntClock: null as HTMLElement | null,
      tagClock: null as HTMLElement | null,
      tagMine: null as HTMLElement | null,
      countdown: null as HTMLElement | null,
      raceLap: null as HTMLElement | null,
    }
    // Panels come and go with the mode and settings; look the nodes up again after a render.
    let seenLayout = -1
    const find = () => {
      seenLayout = layout.v
      for (const k of Object.keys(refs) as (keyof typeof refs)[]) (refs as Record<string, Element | null>)[k] = q(k)
    }

    let raf = 0
    let prev = performance.now()
    let lastText = 0
    let lastSlow = 0
    let lastMap = 0
    let lastFps = 0
    let shownSpeed = 0
    let shownScore = 0
    let lastSpeed = -1
    let lastGear = -99
    let lastRpm = -1
    let lastBoost = -1
    let lastRed = false
    let lastClockMs = -1
    let lastScoreShown = -1
    let lastCount = ''
    let lastPhasePlaying = false

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      const dt = Math.min(0.1, (now - prev) / 1000)
      prev = now
      const g = getGame()
      const playing = g.phase === 'playing' || (g.multiplayer && g.phase === 'paused')
      if (!playing) {
        lastPhasePlaying = false
        return
      }
      if (seenLayout !== layout.v) find()
      if (!lastPhasePlaying) {
        lastPhasePlaying = true
        shownSpeed = telemetry.speedKmh
        shownScore = g.trickScore
      }

      // Speed and score spring toward the real value so the numbers roll, never jump.
      shownSpeed += (telemetry.speedKmh - shownSpeed) * (1 - Math.exp(-dt * 14))
      shownScore += (g.trickScore - shownScore) * (1 - Math.exp(-dt * 7))
      if (Math.abs(g.trickScore - shownScore) < 0.5) shownScore = g.trickScore

      // rpm arc and boost glow: every frame, but only when they actually move.
      const rpmRaw = telemetry.rpm < 0 ? 0 : telemetry.rpm > 1 ? 1 : telemetry.rpm
      const rpm = Math.round(rpmRaw * RPM_STEPS)
      if (refs.rpm && rpm !== lastRpm) {
        lastRpm = rpm
        refs.rpm.setAttribute('stroke-dashoffset', RPM_STR[rpm])
        const red = rpm > RPM_STEPS * 0.9
        if (red !== lastRed) {
          lastRed = red
          refs.rpm.classList.toggle('is-red', red)
        }
      }
      const boost = Math.round((telemetry.boost < 0 ? 0 : telemetry.boost > 1 ? 1 : telemetry.boost) * 100)
      if (refs.cluster && boost !== lastBoost) {
        lastBoost = boost
        refs.cluster.style.setProperty('--boost', BOOST_STR[boost])
      }

      // 3 - 2 - 1 - GO (race and stunt both use raceGoAt): every frame, so the
      // numbers land on the beat. Visual only: audio plays the beeps from the
      // race.countdown event.
      if (refs.countdown) {
        let txt = ''
        if (g.raceGoAt > 0) {
          const rem = g.raceGoAt - now
          if (rem > 0 && g.raceState === 'countdown') txt = num(Math.min(9, Math.ceil(rem / 1000)))
          else if (rem <= 0 && rem > -1100) txt = 'GO'
        }
        if (txt !== lastCount) {
          lastCount = txt
          const c = refs.countdown
          c.textContent = txt
          c.classList.remove('is-on', 'is-go')
          if (txt) {
            void c.offsetWidth // replay the pop for each new number
            c.classList.add('is-on')
            if (txt === 'GO') c.classList.add('is-go')
          }
        }
      }

      if (now - lastText >= TEXT_MS) {
        lastText = now
        const kmh = Math.round(shownSpeed)
        if (refs.speed && kmh !== lastSpeed) {
          lastSpeed = kmh
          refs.speed.textContent = num(kmh)
        }
        const gear = telemetry.forwardSpeed < -0.5 ? -1 : telemetry.gear
        if (refs.gear && gear !== lastGear) {
          lastGear = gear
          refs.gear.textContent = gear < 0 ? 'R' : num(gear)
        }
        const lapMs = g.lapStartedAt > 0 ? now - g.lapStartedAt : 0
        // Only the shown digits matter: compare whole milliseconds.
        const shown = Math.floor(lapMs)
        if (refs.clock && shown !== lastClockMs) {
          lastClockMs = shown
          refs.clock.textContent = formatLap(lapMs)
        }
        const score = Math.round(shownScore)
        if (refs.trickScore && score !== lastScoreShown) {
          lastScoreShown = score
          refs.trickScore.textContent = formatScore(score)
        }
        if (refs.huntClock && g.huntStartedAt > 0) refs.huntClock.textContent = formatLap(now - g.huntStartedAt)
      }

      // Slow numbers (4 a second): mode clocks and the race gap.
      if (now - lastSlow >= SLOW_MS) {
        lastSlow = now
        if (refs.stuntClock) refs.stuntClock.textContent = formatClock(g.stuntEndsAt > 0 ? (g.stuntEndsAt - now) / 1000 : 0)
        if (refs.tagClock) refs.tagClock.textContent = formatClock(g.tagEndsAt > 0 ? (g.tagEndsAt - now) / 1000 : 0)
        if (refs.tagMine) refs.tagMine.textContent = `${(g.tagSeconds.player ?? 0).toFixed(1)} s`
        if (refs.raceGap) refs.raceGap.textContent = raceGapText()
        if (refs.raceLap) refs.raceLap.textContent = raceLapText(g.raceLaps, g.raceState)
      }

      if (now - lastMap >= MAP_MS) {
        lastMap = now
        drawMinimap(getTrack(), g.trackVersion * 100000 + g.trackParamVersion)
      }

      if (refs.fps && now - lastFps >= FPS_MS) {
        lastFps = now
        refs.fps.textContent = num(Math.round(frameStats.fpsEma))
        if (refs.fpsCost) refs.fpsCost.textContent = frameStats.costEma.toFixed(1)
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [root])
}

/** "Lap 2 of 3" from the player's car (cars 'player'.lap = laps done this race). */
function raceLapText(laps: number, state: string): string {
  if (state === 'finished') return 'Finished'
  const me = getCar('player')
  const lap = Math.min(laps, (me?.lap ?? 0) + 1)
  return `Lap ${lap} of ${laps}`
}

/** "+1.4 s to Nova" (the car ahead), or the lead over the car behind. */
function raceGapText(): string {
  const me = getCar('player')
  const track = getTrack()
  if (!me || !track) return '\u00a0'
  let ahead: CarState | null = null
  let behind: CarState | null = null
  for (let i = 0; i < cars.length; i++) {
    const c = cars[i]
    if (c === me || c.kind === 'ghost') continue
    if (c.progress > me.progress) {
      if (!ahead || c.progress < ahead.progress) ahead = c
    } else if (!behind || c.progress > behind.progress) behind = c
  }
  const speed = Math.max(8, me.speedKmh / 3.6)
  if (ahead) return `+${(((ahead.progress - me.progress) * track.length) / speed).toFixed(1)} s to ${ahead.name}`
  if (behind) return `Leading by ${(((me.progress - behind.progress) * track.length) / speed).toFixed(1)} s`
  return '\u00a0'
}

export function Hud() {
  const phase = useGame((s) => s.phase)
  const mp = useGame((s) => s.multiplayer)
  const showFps = useSettings((s) => s.showFps)
  const hasTrack = useGame((s) => s.trackVersion > 0)
  const panels = useModePanels()
  const root = useRef<HTMLDivElement | null>(null)
  useHudLoop(root)
  useEffect(() => installFeed(), [])
  useLayoutEffect(() => {
    layout.v++
  })
  const visible = phase === 'playing'
  return (
    <div ref={root} className={`hud${visible ? ' is-visible' : ''}${mp && phase === 'paused' ? ' is-behind-menu' : ''}`} aria-hidden={!visible}>
      <div className="hud-stack hud-stack--tl">
        {showFps && <FpsMeter />}
        {panels.race && <RacePanel />}
        {panels.stunt && <StuntPanel />}
        {panels.tag && <TagPanel />}
        {!panels.stunt && !panels.tag && <LapPanel />}
        {panels.hunt && <HuntPanel />}
        {visible && <SoundHint variant="chip" />}
      </div>
      {hasTrack && <MinimapPanel />}
      <div className="hud-stack hud-stack--bl">
        <TrickFeed />
        {panels.tricks && <TrickBoard />}
      </div>
      <div className="hud-stack hud-stack--br">
        <SpeedTrap />
        <SpeedCluster />
      </div>
      <Toasts />
      <Countdown />
      {visible && <DriveHint />}
      {visible && <AirTrickHint />}
    </div>
  )
}
