// ============================================================
//  DEMO DRIVE - ?demo=1, the scripted drive the perf check uses
// ------------------------------------------------------------
//  One driving brain, not two: the player's car is driven by the
//  play worker's Ai Driver (src/play/aiDriver.ts, difficulty 1, no
//  catch-up), fed through the driveOverride channel - the same
//  steering rack, tyres and friction circle a human gets, so the
//  frames it measures are the frames a player gets. play owns the
//  brain and its tuning; this file is only the harness:
//
//    warm-up   3 s, then a 30 s perf recording (core/perf.ts ->
//              window.__perf); it keeps driving afterwards so a
//              checker can screenshot a moving car
//    backstop  if the car is somehow stuck for 8 s (the brain has
//              its own recovery first), reset it to the road
//
//  Deterministic: no random numbers, no wall-clock branches.
//  Works on every track, drawn ones included.
// ============================================================

import { driveOverride } from '../core/controls'
import { urlParam } from '../core/devHandles'
import { startPerfRecording } from '../core/perf'
import { getGame } from '../core/store'
import type { TrackRuntime } from '../track/types'
import type { Driver } from '../core/api'
import type { CarState } from '../core/telemetry'
import { createAiDriver } from '../play/aiDriver'
import type { CarSim } from '../vehicle/carSim'
import { addRewindPart } from '../vehicle/rewind'
import { DT } from '../vehicle/tuning'
import { registerDev } from '../core/devHandles'

const WARMUP_STEPS = 180 // 3 s
const RECORD_SECONDS = 30
const STUCK_SPEED = 1.5
const BACKSTOP_STEPS = 480 // 8 s

export const demoDrive = {
  active: urlParam('demo') === '1',
  steps: 0,
  recording: false,
  stuckSteps: 0,
  unsticks: 0,
  brain: null as Driver | null,
  brainTrack: '',
  /** Leaves the rewind recorder (the brain goes back in time with the car it drives). */
  rewindOff: null as (() => void) | null,

  /** Once per physics step while the demo runs: writes driveOverride. */
  update(sim: CarSim, track: TrackRuntime, car: CarState): void {
    driveOverride.active = true
    this.steps++
    if (!this.recording && this.steps >= WARMUP_STEPS) {
      this.recording = true
      startPerfRecording({ seconds: RECORD_SECONDS, label: 'demo', track: track.id, quality: getGame().qualityLevel })
    }
    // One brain per demo session and track.
    if (!this.brain || this.brainTrack !== track.key) {
      const brain = createAiDriver({ id: 'player', difficulty: 1, catchUp: false })
      this.brain = brain
      this.brainTrack = track.key
      this.rewindOff?.()
      this.rewindOff = addRewindPart({ size: brain.REWIND_SIZE, save: (out, at) => brain.saveRewind(out, at), load: (src, at) => brain.loadRewind(src, at) })
    }
    // Backstop: the brain recovers on its own; this only catches a car stuck for good.
    if (!sim.frozen && sim.speed < STUCK_SPEED && this.steps > WARMUP_STEPS) this.stuckSteps++
    else this.stuckSteps = 0
    if (this.stuckSteps > BACKSTOP_STEPS) {
      this.stuckSteps = 0
      this.unsticks++
      sim.requestReset('road', 'demo-unstick')
    }
    const b = this.brain
    b.update(car, DT)
    driveOverride.throttle = b.throttle
    driveOverride.brake = b.brake
    driveOverride.steer = b.steer
    driveOverride.handbrake = b.handbrake
    sim.controls.powerScale = b.powerScale ?? 1
  },
}

/** Tests: hand the car back to the keys and pad mid-run (or give it to the autopilot again). */
registerDev(
  'demoDrive',
  ((on = true) => {
    demoDrive.active = on !== false
    if (!demoDrive.active) driveOverride.active = false
    return demoDrive.active
  }) as never,
  'demoDrive(on = true): switch the ?demo=1 autopilot on or off mid-run (off = the keys and pad drive again)',
)
