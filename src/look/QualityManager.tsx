// ============================================================
//  QUALITY MANAGER - picks the preset and applies the resolution
// ------------------------------------------------------------
//  Resolves the player's quality choice to one level and writes
//  it to store.qualityLevel (we are that field's only writer).
//  Every system that scales its detail reads that field.
//
//  'auto' starts on high. While you drive, it watches the p95
//  frame cost from core/perf.ts. Over 14 ms for 5 seconds of
//  driving and it steps down one level. It never steps back up in
//  the same session (no flip-flopping), and it ignores the first
//  few seconds after a track loads or a level changes, when shader
//  compiles make frames look worse than they are.
//
//  Dev: __dev.setQuality('low' | 'medium' | 'high' | 'auto')
//       ?quality=low|medium|high|auto
// ============================================================

import { useEffect, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { useSettings } from '../core/settings'
import type { QualityChoice, QualityLevel } from '../core/settings'
import { getGame, useGame } from '../core/store'
import { registerDev, urlParam } from '../core/devHandles'
import { resetRollingCost, rollingCostP95 } from '../core/perf'
import { AUTO_QUALITY, QUALITY_ORDER, isQualityChoice, presetDpr } from './quality'
import { lookState } from './lookState'

const urlChoice = urlParam('quality')
const URL_QUALITY: QualityChoice | null = isQualityChoice(urlChoice) ? urlChoice : null

/** The step-down threshold in use (a checker can lower it to test the step: __dev.lookAuto). */
const autoTune = { p95Ms: AUTO_QUALITY.p95Ms as number }

/** Session state for auto (module-level: survives remounts, resets on reload). */
const auto = {
  /** The level auto has stepped down to (starts high). */
  level: 'high' as QualityLevel,
  settle: 0,
  driving: 0,
  checkTimer: 0,
  lastTrackVersion: -1,
  lastPhase: '',
}

function setLevel(level: QualityLevel): void {
  lookState.quality.level = level
  if (getGame().qualityLevel !== level) useGame.setState({ qualityLevel: level })
}

export function QualityManager(): null {
  const settingsChoice = useSettings((s) => s.quality)
  const [devChoice, setDevChoice] = useState<QualityChoice | null>(null)
  const setDpr = useThree((s) => s.setDpr)
  const level = useGame((s) => s.qualityLevel)

  const choice: QualityChoice = devChoice ?? URL_QUALITY ?? settingsChoice
  lookState.quality.choice = choice
  lookState.quality.source = devChoice ? 'dev' : URL_QUALITY ? 'url' : 'settings'

  // Resolve the choice to a level whenever it changes.
  useEffect(() => {
    if (choice === 'auto') {
      setLevel(auto.level)
      auto.settle = 0
      auto.driving = 0
    } else {
      setLevel(choice)
    }
  }, [choice])

  // Apply the render resolution for the level in use.
  useEffect(() => {
    const dpr = presetDpr(level)
    lookState.quality.dpr = dpr
    setDpr(dpr)
    // A level change means new shaders and buffers: let the frame cost settle again.
    auto.settle = 0
    auto.driving = 0
  }, [level, setDpr])

  useEffect(
    () =>
      registerDev(
        'setQuality',
        ((q: QualityChoice | null) => {
          if (q !== null && !isQualityChoice(q)) return `unknown quality "${String(q)}" - use low, medium, high, auto or null`
          setDevChoice(q)
          return `quality choice ${q ?? '(settings)'}`
        }) as (...args: never[]) => unknown,
        "setQuality('low'|'medium'|'high'|'auto'|null) - session override of the quality choice (null = back to settings)",
      ),
    [],
  )

  useEffect(
    () =>
      registerDev(
        'lookAuto',
        ((opts?: { p95Ms?: number }) => {
          if (opts && typeof opts.p95Ms === 'number' && opts.p95Ms > 0) autoTune.p95Ms = opts.p95Ms
          return { p95Ms: autoTune.p95Ms, level: auto.level, lastStep: lookState.quality.lastStep, windowSeconds: auto.driving }
        }) as (...args: never[]) => unknown,
        'lookAuto({ p95Ms }) - auto quality state; pass p95Ms to change the step-down threshold for this session (test the step)',
      ),
    [],
  )

  useFrame((_, rawDt) => {
    if (choice !== 'auto') return
    const dt = Math.min(rawDt, 0.1)
    const g = getGame()

    // Anything that rebuilds the scene restarts the settle clock.
    if (g.trackVersion !== auto.lastTrackVersion || g.phase !== auto.lastPhase) {
      auto.lastTrackVersion = g.trackVersion
      auto.lastPhase = g.phase
      auto.settle = 0
      auto.driving = 0
    }
    if (g.phase !== 'playing') return

    if (auto.settle < AUTO_QUALITY.settleSeconds) {
      auto.settle += dt
      // Throw away the loading frames so they never count against the level.
      if (auto.settle >= AUTO_QUALITY.settleSeconds) resetRollingCost()
      return
    }

    auto.driving += dt
    lookState.quality.windowSeconds = auto.driving
    if (auto.driving < AUTO_QUALITY.windowSeconds) return

    auto.checkTimer += dt
    if (auto.checkTimer < 0.5) return
    auto.checkTimer = 0

    const p95 = rollingCostP95()
    lookState.quality.lastP95 = p95
    if (p95 <= autoTune.p95Ms) return

    const i = QUALITY_ORDER.indexOf(auto.level)
    if (i < 0 || i >= QUALITY_ORDER.length - 1) return // already on low
    const next = QUALITY_ORDER[i + 1]
    lookState.quality.lastStep = `${auto.level} -> ${next}: p95 ${p95.toFixed(1)} ms over ${auto.driving.toFixed(1)} s of driving`
    console.info('[look] auto quality', lookState.quality.lastStep)
    auto.level = next
    setLevel(next)
  })

  return null
}
