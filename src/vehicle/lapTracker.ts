// ============================================================
//  LAP TRACKER - one per car: laps, sectors, valid and dirty laps
// ------------------------------------------------------------
//  The track hands us ordered sector checkpoints (track.checkpoints,
//  s values, checkpoints[0] = 0 = the start line). A raw line
//  crossing is not a lap. Two things have to be true:
//
//  SECTORS (was it a real lap?)
//    Every checkpoint must be passed, in order, since the last line
//    crossing. That kills the tiny-circle-over-the-line exploit: a car
//    orbiting the line never reaches the far checkpoints.
//
//  DIRTY (was it a fair lap?)
//    Off-road time adds up across the lap. Past 3 s the lap goes
//    dirty: it still counts, its time still shows, but it can never
//    set a best. Exploring stays free; cutting the course is pointless.
//
//  Two separate ideas live here, on purpose:
//    race laps   `lap` / progress: how far round the race a car is.
//                A reset (R) does NOT cost a lap - an Ai car that
//                gets stuck and resets must not drop a whole lap.
//    timed laps  the stopwatch. R or Shift+R voids the lap being
//                timed (a reset is a teleport, and a teleport could be
//                a shortcut); timing re-arms at the next line crossing.
//
//  Time is counted in physics steps (1/60 s each), so lap times are
//  exact, deterministic, and never include time spent paused.
// ============================================================

import type { TrackRuntime } from '../track/types'
import { DT, LAP } from './tuning'

export type LapEvent =
  | { kind: 'armed' }
  | { kind: 'sector'; sector: number; sectors: number; splitMs: number }
  | { kind: 'complete'; lap: number; ms: number; dirty: boolean }
  | { kind: 'void'; reason: 'skipped-sector' | 'reset' | 'restart' }
  | { kind: 'dirty' }
  | { kind: 'raceLap'; lap: number }

/** Receives what happened (the player's car turns these into events and store writes). */
export type LapListener = (e: LapEvent) => void

export class LapTracker {
  /** Completed race laps (all sectors passed). Dirty laps count; skipped-sector crossings don't. */
  lap = 0
  /** True once the car has crossed the start line since it was placed. */
  crossedOnce = false
  /** True while a lap is being timed. */
  timing = false
  /** Steps since the timed lap began. */
  stepsThisLap = 0
  offRoadSteps = 0
  dirty = false
  sectorsPassed = 0
  sectorCount = 0

  private passed = new Uint8Array(0)
  private lastS = -1
  private listener: LapListener | null

  /**
   * The last completed lap's verdict, set in the same step as lap++ (CarState.lastLapDirty /
   * lastLapMs copy these): the exact ms and dirty flag the 'complete' event carries. A lap
   * finished untimed (after an R reset) has no time: null, and dirty (it can't be a best).
   */
  lastLapMs: number | null = null
  lastLapDirty = false

  constructor(listener: LapListener | null = null) {
    this.listener = listener
  }

  /** Milliseconds into the lap being timed (0 when not timing). */
  get elapsedMs(): number {
    return this.timing ? this.stepsThisLap * DT * 1000 : 0
  }

  /** Race progress sort key: lap + fraction of the lap. Slightly negative on the grid behind the line. */
  progress(track: TrackRuntime, s: number): number {
    const f = s / track.length
    if (!this.crossedOnce) return this.lap + (f > 0.5 ? f - 1 : f)
    return this.lap + f
  }

  /**
   * A fresh start (race grid, api.teleport): laps back to 0, nothing timed.
   * `s` is where the car now is.
   */
  restartFresh(s: number): void {
    if (this.timing) this.emit({ kind: 'void', reason: 'restart' })
    this.lap = 0
    this.lastLapMs = null
    this.lastLapDirty = false
    this.crossedOnce = false
    this.clearLap()
    this.lastS = s
  }

  /** R: the timed lap dies; race progress and passed sectors are kept. */
  onRoadReset(s: number): void {
    if (this.timing) this.emit({ kind: 'void', reason: 'reset' })
    this.timing = false
    this.stepsThisLap = 0
    this.offRoadSteps = 0
    this.dirty = false
    this.lastS = s
  }

  /** Shift+R: back behind the line. The lap in progress is gone, the count stays. */
  onRestart(s: number): void {
    if (this.timing) this.emit({ kind: 'void', reason: 'restart' })
    this.crossedOnce = false
    this.clearLap()
    this.lastS = s
  }

  /** Feed once per physics step with the car's track position. */
  update(track: TrackRuntime, s: number, onRoad: boolean): void {
    const cps = track.checkpoints
    if (this.passed.length !== cps.length) {
      this.passed = new Uint8Array(cps.length)
      this.sectorCount = cps.length
    }
    if (this.timing) {
      this.stepsThisLap++
      if (!onRoad) {
        this.offRoadSteps++
        if (!this.dirty && this.offRoadSteps * DT * 1000 > LAP.dirtyGraceMs) {
          this.dirty = true
          this.emit({ kind: 'dirty' })
        }
      }
    }
    if (!Number.isFinite(s)) return
    const prev = this.lastS
    this.lastS = s
    if (prev < 0) return
    // Forward travel only. Backwards earns nothing; a huge jump is a teleport.
    const d = track.deltaS(prev, s)
    if (d <= 0 || d > LAP.maxStepJump) return

    for (let k = 1; k < cps.length; k++) {
      if (this.passed[k]) continue
      const a = track.deltaS(prev, cps[k])
      if (a > 0 && a <= d) {
        // In order: every earlier checkpoint must already be behind us.
        let inOrder = true
        for (let j = 1; j < k; j++) if (!this.passed[j]) inOrder = false
        if (!inOrder) continue
        this.passed[k] = 1
        this.sectorsPassed++
        if (this.timing) this.emit({ kind: 'sector', sector: k, sectors: cps.length, splitMs: this.elapsedMs })
      }
    }
    const toLine = track.deltaS(prev, 0)
    if (toLine > 0 && toLine <= d) this.onLine()
  }

  private onLine(): void {
    const n = this.passed.length
    let all = n > 0
    for (let k = 1; k < n; k++) if (!this.passed[k]) all = false

    if (!this.crossedOnce) {
      // Leaving the grid: this crossing just starts the first lap.
      this.crossedOnce = true
      this.beginLap()
      return
    }
    const ms = this.elapsedMs
    if (this.timing && ms < LAP.minLapMs) return // parked on the line, or wobbling over it
    if (all) {
      this.lap++
      this.lastLapMs = this.timing ? ms : null
      this.lastLapDirty = this.timing ? this.dirty : true
      this.emit({ kind: 'raceLap', lap: this.lap })
      if (this.timing) this.emit({ kind: 'complete', lap: this.lap, ms, dirty: this.dirty })
    } else if (this.timing) {
      this.emit({ kind: 'void', reason: 'skipped-sector' })
    }
    this.beginLap()
  }

  private beginLap(): void {
    this.clearLap()
    this.passed[0] = 1 // the line itself is checkpoint 0, and you are on it
    this.sectorsPassed = 1
    this.timing = true
    this.emit({ kind: 'armed' })
  }

  private clearLap(): void {
    this.passed.fill(0)
    this.sectorsPassed = 0
    this.timing = false
    this.stepsThisLap = 0
    this.offRoadSteps = 0
    this.dirty = false
  }

  private emit(e: LapEvent): void {
    this.listener?.(e)
  }
}
