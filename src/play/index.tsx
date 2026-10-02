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
//    StuntPark       ramps, gaps, pipes, rings and bullseyes off the
//                    road (free roam and stunt attack only)
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
import { getTrack } from '../track/current'
import { recentEvents } from '../core/events'
import { aiWatch, reverseLog } from './aiDriver'
import { ModeController, devFinish, devRace, newRound, restartSession } from './ModeController'
import { AiRacers } from './AiRacers'
import { CrashProps } from './CrashProps'
import { Smashables } from './Smashables'
import { EnergyCores } from './EnergyCores'
import { SpeedTraps } from './SpeedTraps'
import { StuntPark } from './stunts/StuntPark'
import { doParkHop, parkHop } from './stunts/parkReset'
import { parkZones } from './stunts/parkLive'
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
      steerGains: Array.from(d.steerGains, (g) => +g.toFixed(4)),
      loops: `${d.loopsDone}/${d.loopsDone + d.loopsMissed}`,
      resetLog: d.resetLog,
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
  const ai = [...drivers.values()].map((d) => `${d.id}:${d.mode}@${Math.round(d.targetKmh)}r${d.resets}L${d.loopsDone}/${d.loopsDone + d.loopsMissed}`)
  const resets = recentEvents().filter((e) => e.type === 'reset').length
  const rev = reverseLog.rows
  const count = (what: string) => rev.filter((r) => r.what === what).length
  return `t=${Math.round(performance.now() / 1000)}s stage=${flow.stage} phase=${g.phase} pos=${g.racePosition}/${g.raceRacers} | ${racers.join(' ')} | ${ai.join(' ')} | resets=${resets} | reverse backed=${count('backed')} blocked=${count('blocked')} stopped=${count('stopped')} contacts=${reverseLog.contacts}`
}

export function PlayLayer() {
  useEffect(() => {
    installPlay({ newRound, restartSession, parkHop, doParkHop, parkZones })
    const offs = [
      registerDev('round', () => newRound(), 'new round of the current mode (props and cores re-scatter)'),
      registerDev('race', ((n: number) => devRace(n)) as never, 'race(n): start a race now with n Ai racers (0-5)'),
      registerDev('finishRace', () => devFinish(), 'end the running race (or stunt run) now and show results'),
      registerDev('aiResets', () => [...drivers.values()].map((d) => `${d.id}: ` + d.resetLog.map((r) => `${r.why}@${r.s}m ${r.kmh}kmh lat${r.lateral} h${r.height}`).join(', ')).join(' | '), 'where and why each Ai racer reset'),
      registerDev('aiLoops', () => [...drivers.values()].map((d) => `${d.id}: ` + d.loopLog.map((r) => `s${r.s}(-${r.toLoop}m) ${r.kmh}/${r.targetKmh}kmh lat${r.lateral} hdg${r.headingDeg}`).join(', ')).join(' | '), 'each Ai racer\'s last loop approaches: speed/target, lateral, heading error every 10 m'),
      registerDev(
        'lineDump',
        ((s0: number, s1: number, step = 10) => {
          const t = getTrack()
          if (!t) return 'no track'
          const S = t.samples
          const out: string[] = []
          for (let s = s0; s <= s1; s += step) {
            const i = Math.floor(t.wrapS(s) / S.ds) % S.count
            out.push(`${s}: off${t.racingLine.offset[i].toFixed(1)} v${Math.round(t.racingLine.speed[i] * 3.6)} hw${S.halfWidth[i].toFixed(1)} k${(S.curvature[i] * 1000).toFixed(1)} su${S.surface[i]} ty${S.ty[i].toFixed(2)}`)
          }
          return out.join(' | ')
        }) as never,
        'lineDump(s0, s1, step=10): racing line offset/speed, half width, curvature (1/km), surface code, slope along the road',
      ),
      registerDev(
        'aiWatch',
        ((s0: number, s1: number) => {
          aiWatch.s0 = s0
          aiWatch.s1 = s1
          aiWatch.rows.length = 0
          return `watching s ${s0}..${s1}`
        }) as never,
        'aiWatch(s0, s1): trace every Ai every 5 m through that stretch (read with aiWatchGet)',
      ),
      registerDev('aiWatchGet', () => aiWatch.rows.join('\n'), 'the aiWatch trace so far'),
      registerDev(
        'aiStall',
        ((n: number) => {
          const d = drivers.get(`ai-${n}`)
          if (!d) return `no ai-${n}`
          d.stallAtNextLoop = true
          return `ai-${n} will stop dead just before its next loop`
        }) as never,
        'aiStall(n): Ai racer n stops dead just before its next loop (tests backing up for a run-up in traffic)',
      ),
      registerDev('aiReverse', () => reverseLog.rows.map((r) => `${r.id} ${r.kind} ${r.what}${r.other ? ' ' + r.other : ''} @${r.s}m ${r.kmh}kmh`).join(' | ') + ` | contacts=${reverseLog.contacts}`, 'every time a driver wanted to back up: backed / blocked (car behind) / stopped (car came up) / contact'),
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
      <StuntPark />
    </>
  )
}
