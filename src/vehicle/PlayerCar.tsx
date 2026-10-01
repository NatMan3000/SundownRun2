// ============================================================
//  PLAYER CAR - your car: input in, telemetry and events out
// ------------------------------------------------------------
//  The same SimulatedCar every Ai racer uses, with the player's
//  brain plugged in:
//
//    controls   driveInput (keyboard / pad), or driveOverride when
//               the demo autopilot or a test harness is driving
//    handling   live from Settings (grip, steering, stability ...)
//    signals    R -> reset to road, Shift+R -> start line
//    laps       store fields + lap.* events + records + ghost
//    tricks     the trick detector (tricks.ts)
//    telemetry  everything the camera, HUD, audio and fx read
//    events     boost, mag.on / mag.off, crash, reset
//
//  Phase rules: on the title screen the car waits on the grid,
//  frozen (it is the showroom backdrop); it is released when a
//  drive starts. On a results screen it brakes to a stop.
// ============================================================

import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { controlSignals, driveInput, driveOverride } from '../core/controls'
import { emit } from '../core/events'
import { steeringGain } from '../core/input'
import { getRecord, offerRecord } from '../core/records'
import { getSettings, useSettings } from '../core/settings'
import { getGame, useGame } from '../core/store'
import { telemetry } from '../core/telemetry'
import type { CarState } from '../core/telemetry'
import { getTrack, useTrack } from '../track/current'
import { demoDrive } from '../dev/demoDrive'
import { feelTrace } from '../dev/feelTrace'
import { CarSim } from './carSim'
import { ghostRecorder, loadGhost } from './ghost'
import { LapTracker } from './lapTracker'
import type { LapEvent } from './lapTracker'
import { links } from './links'
import { SimulatedCar } from './SimulatedCar'
import { TrickDetector } from './tricks'
import type { TrickInput } from './tricks'
import { startPose } from './trackNav'
import { DT } from './tuning'

const _pos = new THREE.Vector3()
const _quat = new THREE.Quaternion()
/** How fast the autopilot channel's values are smoothed (same as an analog stick). */
const OVERRIDE_RATE = 26

export function PlayerCar() {
  const body = useSettings((s) => s.carBody)
  const paint = useSettings((s) => s.paint)
  const glow = useSettings((s) => s.glow)
  const trail = useSettings((s) => s.trail)
  const quality = useGame((s) => s.qualityLevel)
  const track = useTrack()

  const sim = useMemo(() => new CarSim('player'), [])
  const tricks = useMemo(() => new TrickDetector(), [])
  const seen = useRef({ reset: controlSignals.reset, restart: controlSignals.restart, phase: getGame().phase }).current

  // ---------------------------------------------------------------- laps -> store + events
  const lap = useMemo(
    () =>
      new LapTracker((e: LapEvent) => {
        const t = getTrack()
        if (!t) return
        switch (e.kind) {
          case 'armed':
            ghostRecorder.start(getSettings().carBody)
            useGame.setState({ lapStartedAt: performance.now(), currentLapDirty: false, sectorsPassed: 1, sectorCount: t.checkpoints.length })
            break
          case 'sector':
            useGame.setState({ sectorsPassed: lapRef.current ? lapRef.current.sectorsPassed : e.sector + 1 })
            emit('lap.sector', { sector: e.sector, sectors: e.sectors, splitMs: Math.round(e.splitMs) })
            break
          case 'raceLap':
            useGame.setState({ lapCount: e.lap })
            break
          case 'complete': {
            const ms = Math.round(e.ms)
            let best = false
            let previous = getRecord(t.key, 'bestLapMs')
            if (!e.dirty) {
              const r = offerRecord(t.key, 'bestLapMs', ms)
              best = r.best
              previous = r.previous
            }
            if (best) {
              if (!ghostRecorder.commit(t.key, ms)) console.warn('[ghost] best lap had too few samples to keep')
            } else {
              ghostRecorder.discard()
            }
            useGame.setState((s) => ({ lastLapMs: ms, lastLapDirty: e.dirty, bestLapMs: best ? ms : s.bestLapMs }))
            emit('lap.complete', { lap: e.lap, ms, dirty: e.dirty, best, previousBestMs: previous })
            break
          }
          case 'void':
            ghostRecorder.discard()
            useGame.setState((s) => ({ lapVoidNonce: s.lapVoidNonce + 1, lapStartedAt: 0, currentLapDirty: false, sectorsPassed: 0 }))
            emit('lap.void', { reason: e.reason })
            break
          case 'dirty':
            ghostRecorder.discard() // a dirty lap can never be a best
            useGame.setState({ currentLapDirty: true })
            emit('lap.dirty', {})
            break
        }
      }),
    [],
  )
  const lapRef = useRef<LapTracker | null>(lap)

  // Records and the ghost follow the current track version.
  useEffect(() => {
    if (!track) return
    useGame.setState({ bestLapMs: getRecord(track.key, 'bestLapMs'), sectorCount: track.checkpoints.length })
    loadGhost(track.key)
  }, [track?.key]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    links.playerSim = sim
    links.playerLap = lap
    return () => {
      if (links.playerSim === sim) {
        links.playerSim = null
        links.playerLap = null
        links.playerBody = null
      }
    }
  }, [sim, lap])

  // A new session (round) starts with fresh trick state.
  const round = useGame((s) => s.round)
  useEffect(() => {
    tricks.cancel()
  }, [round, tricks])

  const trickIn = useMemo<TrickInput>(
    () => ({
      airborne: false,
      up: sim.up,
      fwd: sim.fwd,
      right: sim.right,
      angvel: sim.angvel,
      groundNormal: sim.groundNormal,
      speedKmh: 0,
      drifting: false,
      driftAngle: 0,
      impact: 0,
      onWall: false,
      trackS: 0,
      hasTrackS: false,
      chassisTouching: false,
    }),
    [sim],
  )

  // ---------------------------------------------------------------- before each step
  const beforeStep = (s: CarSim) => {
    const g = getGame()
    const set = getSettings()
    const h = s.handling
    h.grip = set.grip
    h.steerGain = steeringGain()
    h.stability = set.stability
    h.power = set.power
    h.brakes = set.brakes
    h.topSpeedKmh = set.topSpeedKmh
    h.magGripKmh = set.magGripKmh
    h.boostStrength = set.boostStrength

    // Phase transitions: the title screen parks the car on the grid as the showroom.
    if (g.phase !== seen.phase) {
      const was = seen.phase
      seen.phase = g.phase
      const t = getTrack()
      if (g.phase === 'title' && t) {
        const sS = startPose(t, 0, _pos, _quat)
        s.teleport(_pos, _quat, sS)
        s.frozen = true
      } else if (g.phase === 'playing' && was === 'title') {
        s.frozen = false
      }
    }
    if (g.phase === 'title' && !s.frozen) s.frozen = true

    // R / Shift+R (edge-triggered nonces from the input system).
    if (controlSignals.reset !== seen.reset) {
      seen.reset = controlSignals.reset
      if (g.phase === 'playing') s.requestReset('road')
    }
    if (controlSignals.restart !== seen.restart) {
      seen.restart = controlSignals.restart
      if (g.phase === 'playing') s.requestReset('start')
    }

    // Controls: the autopilot channel wins when active (same rack, same tyres).
    const t = getTrack()
    if (demoDrive.active && t && g.phase === 'playing') demoDrive.update(s, t)
    const c = s.controls
    c.powerScale = 1
    if (driveOverride.active) {
      const k = 1 - Math.exp(-OVERRIDE_RATE * DT)
      c.throttle += (driveOverride.throttle - c.throttle) * k
      c.brake += (driveOverride.brake - c.brake) * k
      c.steer += (driveOverride.steer - c.steer) * k
      c.handbrake = driveOverride.handbrake
    } else {
      c.throttle = driveInput.throttle
      c.brake = driveInput.brake
      c.steer = driveInput.steer
      c.handbrake = driveInput.handbrake
    }
    if (g.phase === 'results') {
      c.throttle = 0
      c.brake = 0.6
      c.handbrake = false
    }
  }

  // ---------------------------------------------------------------- after each step
  const afterStep = (s: CarSim) => {
    const t = getTrack()
    const news = s.news
    links.playerStepAt = performance.now()

    if (news.teleported) {
      links.resetTick++
      tricks.cancel()
      ghostRecorder.discard()
    }
    if (news.reset) emit('reset', news.resetReason ? { kind: news.reset, reason: news.resetReason } : { kind: news.reset })
    if (news.boosted > 0) emit('boost', { strength: Math.round(news.boosted * 100) / 100 })
    if (news.magOn) emit('mag.on', { surface: news.magOn === 'wall' ? 'wall' : 'loop', speedKmh: Math.round(s.speedKmh) })
    if (news.magOff) emit('mag.off', { surface: news.magOff === 'wall' ? 'wall' : 'loop', speedKmh: Math.round(s.speedKmh), fell: news.magFell })
    if (news.crash > 0) {
      const payload = { what: news.crashWhat, intensity: Math.round(news.crash * 100) / 100, speedKmh: Math.round(s.speedKmh) }
      emit('crash', news.crashCarId ? { ...payload, otherCarId: news.crashCarId } : payload)
    }

    // Telemetry: everything except the render pose (that is written per frame).
    telemetry.speedKmh = s.speedKmh
    telemetry.forwardSpeed = s.forwardSpeed
    telemetry.rpm = s.rpm
    telemetry.gear = s.reversing ? -1 : s.gear
    if (s.speedKmh > telemetry.topSpeedKmh) telemetry.topSpeedKmh = s.speedKmh
    telemetry.throttle = s.controls.throttle
    telemetry.brake = s.controls.brake
    telemetry.steer = s.controls.steer
    telemetry.handbrake = s.controls.handbrake
    telemetry.slip = s.slip
    telemetry.drifting = s.drifting
    telemetry.driftAngle = s.driftAngle
    telemetry.airborne = s.airborne
    telemetry.airTime = s.airTime
    telemetry.wheelsDown = s.wheelsDown
    telemetry.surface = s.surface
    telemetry.onRoad = s.onRoad
    telemetry.magGrip = s.magGrip
    telemetry.magStrength = s.magStrength
    telemetry.boost = s.boost
    telemetry.impact = s.impact // the sim decays it
    telemetry.upright = s.upright
    telemetry.trackS = s.trackS
    telemetry.lateral = s.lateral
    telemetry.carVelocity.copy(s.linvel)
    telemetry.carAngularVelocity.copy(s.angvel)

    // Tricks (player only, when the setting is on).
    trickIn.airborne = s.airborne
    trickIn.speedKmh = s.speedKmh
    trickIn.drifting = s.drifting
    trickIn.driftAngle = s.driftAngle
    trickIn.impact = s.impact
    trickIn.onWall = s.magGrip && s.surface === 'wall'
    trickIn.trackS = s.trackS
    trickIn.hasTrackS = s.hasTrackS
    trickIn.chassisTouching = s.chassisTouching
    const g = getGame()
    tricks.update(trickIn, t, getSettings().tricks && g.phase === 'playing')

    // Ghost: record this step's raw pose while a lap is being timed.
    if (lap.timing) ghostRecorder.sample(s.pos, s.quat)

    // Keep the HUD's lap clock honest after a pause (the sim clock does not run while paused).
    if (lap.timing && g.lapStartedAt > 0) {
      const expected = performance.now() - lap.elapsedMs
      if (Math.abs(expected - g.lapStartedAt) > 250) useGame.setState({ lapStartedAt: expected })
    }

    feelTrace.sample(s)
  }

  // ---------------------------------------------------------------- every frame
  const onFrame = (_s: CarSim, car: CarState) => {
    telemetry.carPosition.copy(car.position)
    telemetry.carQuaternion.copy(car.quaternion)
    telemetry.carUp.set(0, 1, 0).applyQuaternion(car.quaternion)
    telemetry.carForward.set(0, 0, 1).applyQuaternion(car.quaternion)
  }

  return (
    <SimulatedCar
      id="player"
      kind="player"
      name="You"
      body={body}
      paint={paint}
      glow={glow}
      trail={trail}
      gridSlot={0}
      sim={sim}
      lap={lap}
      beforeStep={beforeStep}
      afterStep={afterStep}
      onFrame={onFrame}
      onBody={(b) => {
        links.playerBody = b
      }}
      shadows={quality === 'high'}
    />
  )
}
