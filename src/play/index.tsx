// ============================================================
//  PLAY - turns the drive into a game
// ------------------------------------------------------------
//  <PlayLayer /> is mounted once, inside <Physics> (src/App.tsx).
//  It holds every gameplay system:
//
//    ModeController  free roam, time trial, race, stunt score attack
//    AiRacers        the Ai cars (vehicle's SimCar + our AiDriver brain)
//    CrashProps      neon crates and energy cubes that burst for points
//    Smashables      roadside posts: solid when slow, smashed when fast
//    EnergyCores     the free-roam core hunt with a clock
//    SpeedTraps      top-speed readings on the straights
//
//  It also installs the play API (core/api.ts: newRound,
//  restartSession) and the dev handles checkers use:
//    window.__dev.round()       new round (re-scatter props and cores)
//    window.__dev.race(n)       start a race with n Ai racers now
//    window.__dev.finishRace()  end the race / stunt run now
//    window.__game.get('play')  what play is doing (modes, Ai brains, props)
// ============================================================

import { useEffect } from 'react'
import { useFrame } from '@react-three/fiber'
import { useAfterPhysicsStep } from '@react-three/rapier'
import { installPlay } from '../core/api'
import { registerDev, registerInspector } from '../core/devHandles'
import { getGame } from '../core/store'
import { recentEvents } from '../core/events'
import { ModeController, devFinish, devRace, newRound, restartSession } from './ModeController'
import { AiRacers } from './AiRacers'
import { CrashProps } from './CrashProps'
import { Smashables } from './Smashables'
import { EnergyCores } from './EnergyCores'
import { SpeedTraps } from './SpeedTraps'
import { playFlags } from './modes'
import { drivers, flow } from './flow'
import { raceBook } from './raceBook'
import { playInspectors } from './inspect'
import { stepClock } from './simCars'

/** Counts physics steps between rendered frames, so hit tests know how stale a render pose is. */
function StepClock() {
  useAfterPhysicsStep(() => {
    stepClock.stepsSinceFrame++
  })
  // Default priority on purpose: a positive priority would switch off r3f's automatic rendering.
  // Children subscribe before <Physics>, so this runs just before the frame's physics steps.
  useFrame(() => {
    stepClock.stepsSinceFrame = 0
  })
  return null
}

function inspectPlay() {
  const g = getGame()
  const ai = [...drivers.values()].map((d) => {
    const r = raceBook.racers.find((x) => x.id === d.id)
    return {
      id: d.id,
      mode: d.mode,
      s: Math.round(d.s),
      targetKmh: Math.round(d.targetKmh),
      aimLateral: +d.aimLateral.toFixed(2),
      throttle: +d.throttle.toFixed(2),
      brake: +d.brake.toFixed(2),
      steer: +d.steer.toFixed(2),
      powerScale: +(d.powerScale ?? 1).toFixed(3),
      resets: d.resets,
      lapsDone: r?.lapsDone ?? 0,
      dist: r ? Math.round(r.dist) : 0,
      position: r?.position ?? 0,
      finished: r?.finished ?? false,
      finishMs: r?.finished ? Math.round(r.finishMs) : null,
    }
  })
  return {
    mode: g.mode,
    phase: g.phase,
    round: g.round,
    multiplayer: g.multiplayer,
    flow: { kind: flow.kind, stage: flow.stage, goAt: flow.goAt },
    features: { ...playFlags },
    race: raceBook.active
      ? {
          laps: raceBook.laps,
          length: Math.round(raceBook.length),
          racers: raceBook.racers.map((r) => ({
            id: r.id,
            name: r.name,
            position: r.position,
            lapsDone: r.lapsDone,
            dist: Math.round(r.dist),
            finished: r.finished,
            bestLapMs: r.bestLapMs === null ? null : Math.round(r.bestLapMs),
          })),
        }
      : null,
    ai,
    ...playInspectors(),
  }
}

/** Compact one-line race status for probes and checkers. */
function raceSummary(): string {
  const g = getGame()
  const racers = raceBook.racers.map((r) => `${r.name}:${r.lapsDone}L/${Math.round(r.dist)}m${r.finished ? `/F${(r.finishMs / 1000).toFixed(1)}s` : ''}`)
  const ai = [...drivers.values()].map((d) => `${d.id}:${d.mode}@${Math.round(d.targetKmh)}r${d.resets}`)
  const resets = recentEvents().filter((e) => e.type === 'reset').length
  return `t=${Math.round(performance.now() / 1000)}s stage=${flow.stage} phase=${g.phase} pos=${g.racePosition}/${g.raceRacers} | ${racers.join(' ')} | ${ai.join(' ')} | resets=${resets}`
}

export function PlayLayer() {
  useEffect(() => {
    installPlay({ newRound, restartSession })
    const offs = [
      registerDev('round', () => newRound(), 'new round of the current mode (props and cores re-scatter)'),
      registerDev('race', ((n: number) => devRace(n)) as never, 'race(n): start a race now with n Ai racers (0-5)'),
      registerDev('finishRace', () => devFinish(), 'end the running race (or stunt run) now and show results'),
      registerDev('raceSummary', () => raceSummary(), 'one-line race status: stage, each racer laps/metres, Ai modes, resets'),
      registerInspector('play', inspectPlay),
    ]
    return () => {
      for (const off of offs) off()
    }
  }, [])

  return (
    <>
      <StepClock />
      <ModeController />
      <AiRacers />
      <CrashProps />
      <Smashables />
      <EnergyCores />
      <SpeedTraps />
    </>
  )
}
