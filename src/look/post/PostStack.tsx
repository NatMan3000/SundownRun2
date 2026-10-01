// ============================================================
//  POST STACK - bloom, tone mapping and the finishing passes
// ------------------------------------------------------------
//  The scene renders into a half-float (HDR) buffer, so emissive
//  neon can be brighter than white. Then, in order:
//
//    1. BoostLens   chromatic aberration while boosting (uniform-
//                   gated: free when you are not boosting)
//       Beams       every car's headlight beams at night, drawn as
//                   soft volumes of light that fade into whatever
//                   they meet (reads the depth buffer; free by day)
//    2. Bloom       mipmap blur. Only light above 1.0 (the brightest
//                   channel) blooms, so the glow tiers in palette.ts
//                   decide what glows: T0 never, T1 a soft halo, T2
//                   the hero glow, T3 a flash.
//    3. ToneMapping Khronos PBR Neutral (art direction ruling: it keeps
//                   the sun's yellow -> orange -> pink bands and the
//                   saturated neon; ACES and AgX can be compared with
//                   __dev.lookPost). The ONLY tone map in
//                   the frame: the renderer's own is switched off
//                   while this stack is mounted, or the picture
//                   would be tone mapped twice and go milky.
//    4. Grade       violet shadow lift + a little contrast
//    5. Vignette    gentle; sits the eye on the car
//    6. SpeedLines  light streaks at the edges while boosting
//    -- all of 1-6 are merged into ONE fullscreen pass --
//    7. SMAA        edge smoothing on the finished picture (its own
//                   pass; off on the low preset)
//
//  The quality preset decides bloom size and SMAA. Changing preset
//  rebuilds the stack once (rare); boosting never rebuilds anything.
//
//  Dev:  __dev.lookPost({ exposure, toneMapping, bloom, intensity,
//        threshold, knee, radius }),  __dev.previewBoost(0..1)  and
//        __dev.lookBeams({ length, spread, intensity, ... })
// ============================================================

import { useEffect, useMemo, useState } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import {
  BlendFunction,
  BloomEffect,
  EffectComposer,
  EffectPass,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from 'postprocessing'
import type { Effect } from 'postprocessing'
import { PALETTE } from '../../core/palette'
import { telemetry } from '../../core/telemetry'
import { useGame } from '../../core/store'
import { registerDev } from '../../core/devHandles'
import { QUALITY_PRESETS } from '../quality'
import { lookState } from '../lookState'
import { BoostLensEffect, GradeEffect, SpeedLinesEffect, applyTierThreshold } from './effects'
import { HeadlightBeamsEffect } from './HeadlightBeamsEffect'
import { BEAM_TUNE } from '../fx/beams'

type ToneName = 'aces' | 'agx' | 'neutral'

const TONE_MODES: Record<ToneName, number> = {
  aces: ToneMappingMode.ACES_FILMIC,
  agx: ToneMappingMode.AGX,
  neutral: ToneMappingMode.NEUTRAL,
}

/** Tunables (dev command can change them live). */
const tune = {
  toneMapping: 'neutral' as ToneName,
  /** Neutral is close to identity below 0.76, so exposure 1 keeps the palette as written. */
  exposure: 1.0,
  bloom: true,
  intensity: 0.95,
  threshold: 1.0,
  knee: 0.35,
  radius: 0.72,
  /** Preview the boost lens without boosting (checkers): -1 = follow telemetry. */
  previewBoost: -1,
}

/** Bloom whose blur runs on a smaller buffer when the preset asks for it. */
class BudgetBloomEffect extends BloomEffect {
  scale = 1
  setSize(width: number, height: number): void {
    super.setSize(Math.max(1, Math.round(width * this.scale)), Math.max(1, Math.round(height * this.scale)))
  }
}

const _shadowTint = new THREE.Color()
const _streak = new THREE.Color()
const _beamColor = new THREE.Color()

/** Smoothed boost lens amount (eases in and out on its own spring). */
let lens = 0
let lensTime = 0

export function PostStack() {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const camera = useThree((s) => s.camera)
  const size = useThree((s) => s.size)
  const dpr = useThree((s) => s.viewport.dpr)
  const level = useGame((s) => s.qualityLevel)
  const [version, setVersion] = useState(0)

  const stack = useMemo(() => {
    void version
    const preset = QUALITY_PRESETS[level]
    const composer = new EffectComposer(gl, {
      frameBufferType: THREE.HalfFloatType,
      multisampling: 0,
      stencilBuffer: false,
      depthBuffer: true,
    })
    composer.addPass(new RenderPass(scene, camera))

    const boostLens = new BoostLensEffect()
    _beamColor.set(PALETTE.stars) // clean cool white: the light itself, not a neon colour
    const beams = new HeadlightBeamsEffect(_beamColor, preset.beamSteps)
    const effects: Effect[] = [boostLens, beams]

    let bloom: BudgetBloomEffect | null = null
    if (preset.bloom && tune.bloom) {
      bloom = new BudgetBloomEffect({
        blendFunction: BlendFunction.ADD,
        mipmapBlur: true,
        intensity: tune.intensity,
        radius: tune.radius,
        levels: preset.bloomLevels,
      })
      bloom.scale = preset.bloomScale
      applyTierThreshold(bloom, tune.threshold, tune.knee)
      effects.push(bloom)
    }

    effects.push(new ToneMappingEffect({ mode: TONE_MODES[tune.toneMapping] }))
    _shadowTint.set(PALETTE.groundSheen)
    effects.push(new GradeEffect(_shadowTint))
    effects.push(new VignetteEffect({ offset: 0.32, darkness: 0.52 }))
    _streak.set(PALETTE.laneLine)
    const speedLines = new SpeedLinesEffect(_streak)
    effects.push(speedLines)

    const main = new EffectPass(camera, ...effects)
    composer.addPass(main)

    let smaa: EffectPass | null = null
    if (preset.smaa) {
      smaa = new EffectPass(camera, new SMAAEffect({ preset: SMAAPreset.MEDIUM }))
      composer.addPass(smaa)
    }

    lookState.post.toneMapping = tune.toneMapping
    lookState.post.bloom = !!bloom
    lookState.post.bloomIntensity = bloom ? tune.intensity : 0
    lookState.post.bloomThreshold = tune.threshold
    lookState.post.bloomKnee = tune.knee
    lookState.post.bloomRadius = bloom ? tune.radius : 0
    lookState.post.bloomScale = bloom ? preset.bloomScale : 0
    lookState.post.bloomLevels = bloom ? preset.bloomLevels : 0
    lookState.post.smaa = !!smaa
    lookState.post.passes = composer.passes.length

    return { composer, boostLens, beams, speedLines, effects, main, smaa, bloom }
  }, [gl, scene, camera, level, version])

  // Size the buffers to the drawing buffer (CSS size x pixel ratio).
  useEffect(() => {
    stack.composer.setSize(size.width, size.height, false)
  }, [stack, size.width, size.height, dpr])

  useEffect(
    () => () => {
      // Disposes every pass, and each EffectPass disposes its effects.
      stack.composer.dispose()
    },
    [stack],
  )

  // One tone map per frame: ours. Park the renderer's while mounted.
  useEffect(() => {
    const previous = gl.toneMapping
    gl.toneMapping = THREE.NoToneMapping
    return () => {
      gl.toneMapping = previous
    }
  }, [gl])

  useEffect(() => {
    const offA = registerDev(
      'lookPost',
      ((opts?: Partial<typeof tune>) => {
        if (opts && typeof opts === 'object') {
          const rebuild =
            (opts.toneMapping !== undefined && opts.toneMapping !== tune.toneMapping) ||
            (opts.bloom !== undefined && opts.bloom !== tune.bloom)
          if (opts.toneMapping !== undefined && !(opts.toneMapping in TONE_MODES)) return 'toneMapping must be aces, agx or neutral'
          Object.assign(tune, opts)
          if (rebuild) setVersion((v) => v + 1)
        }
        return { ...tune }
      }) as (...args: never[]) => unknown,
      'lookPost({ exposure, toneMapping: aces|agx|neutral, bloom, intensity, threshold, knee, radius }) - tune the post stack live; no argument returns the current values',
    )
    const offB = registerDev(
      'previewBoost',
      ((v: number) => {
        tune.previewBoost = typeof v === 'number' && Number.isFinite(v) ? v : -1
        return tune.previewBoost < 0 ? 'boost lens follows telemetry.boost' : `boost lens held at ${tune.previewBoost}`
      }) as (...args: never[]) => unknown,
      'previewBoost(0..1) - hold the boost aberration + speed lines at a level (-1 = follow the car)',
    )
    const offC = registerDev(
      'lookBeams',
      ((opts?: Partial<typeof BEAM_TUNE>) => {
        if (opts && typeof opts === 'object') {
          for (const key of Object.keys(opts) as (keyof typeof BEAM_TUNE)[]) {
            const v = opts[key]
            if (key in BEAM_TUNE && typeof v === 'number' && Number.isFinite(v)) BEAM_TUNE[key] = v
          }
        }
        return { ...BEAM_TUNE, lampsDrawn: lookState.post.beamLamps }
      }) as (...args: never[]) => unknown,
      'lookBeams({ length, spread, startRadius, intensity, maxBrightness, nearFade, forwardScatter, softContact, aimDrop, fadeNear, fadeFar }) - tune the headlight beams live; no argument returns the current values',
    )
    return () => {
      offA()
      offB()
      offC()
    }
  }, [])

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.1)
    const { composer, boostLens, beams, speedLines, bloom } = stack

    // Live tunables (cheap uniform writes).
    gl.toneMappingExposure = tune.exposure
    lookState.post.exposure = tune.exposure
    if (bloom) {
      bloom.intensity = tune.intensity
      bloom.luminanceMaterial.threshold = tune.threshold
      bloom.luminanceMaterial.smoothing = tune.knee
      bloom.mipmapBlurPass.radius = tune.radius
    }

    // Boost lens: follow the boost envelope on a spring so it eases in and out.
    const target = tune.previewBoost >= 0 ? tune.previewBoost : telemetry.boost
    const rate = target > lens ? 10 : 3.5
    lens += (target - lens) * (1 - Math.exp(-rate * dt))
    if (lens < 0.002) lens = 0
    lensTime = (lensTime + dt) % 3600 // keep the shader's time small and precise
    boostLens.amount = lens
    speedLines.amount = THREE.MathUtils.smoothstep(lens, 0.05, 0.7)
    speedLines.time = lensTime
    lookState.post.boostLens = lens

    // Headlight beams: this frame's lamps into camera space (after the camera has moved).
    lookState.post.beamLamps = beams.sync(camera)

    composer.render(dt)
  }, 1)

  return null
}
