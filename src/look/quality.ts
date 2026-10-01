// ============================================================
//  QUALITY PRESETS - how much the graphics are allowed to cost
// ------------------------------------------------------------
//  Three presets (low, medium, high) plus 'auto'. Each preset is
//  one row of numbers below: render resolution, bloom size, SMAA,
//  trail length, particle caps and headlight-beam detail. Everything in src/look reads
//  its budget from here, and the world worker reads the level the
//  game settled on from store.qualityLevel.
//
//  'auto' starts on high. If frames get too expensive while you
//  drive (CONSTITUTION section 2: p95 frame cost over 14 ms for
//  5 seconds), it steps down ONE level and never steps back up in
//  the same session, so the picture never flips back and forth.
//
//  The level is chosen by, in order: __dev.setQuality(q), the
//  ?quality= URL switch, then the Settings menu choice.
// ============================================================

import type { QualityChoice, QualityLevel } from '../core/settings'

export interface QualityPreset {
  /** Render resolution multiplier (capped by the screen's own pixel ratio). */
  dpr: number
  /** Bloom on/off. */
  bloom: boolean
  /** Bloom works on a buffer this fraction of the screen (1 = full resolution). */
  bloomScale: number
  /** Mipmap blur levels (fewer = smaller, cheaper glow). */
  bloomLevels: number
  /** Edge smoothing pass. */
  smaa: boolean
  /** Light-trail ribbon segments per car (longer = more history). */
  trailSegments: number
  /** Most glowing shards alive at once. */
  shardCap: number
  /** Most sparks alive at once. */
  sparkCap: number
  /** Most pulse rings alive at once. */
  pulseCap: number
  /**
   * Size of the environment (reflection) cube map. Measured on the baseline
   * GPU: a rebuild costs about 4 ms at 128 and 10 ms at 256, and the sky is
   * smooth gradients, so 128 everywhere.
   */
  envSize: number
  /** Steps along each headlight beam per pixel (fewer = cheaper, a little grainier). */
  beamSteps: number
}

export const QUALITY_PRESETS: Record<QualityLevel, QualityPreset> = {
  high: {
    dpr: 1.5,
    bloom: true,
    bloomScale: 1,
    bloomLevels: 7,
    smaa: true,
    trailSegments: 90,
    shardCap: 480,
    sparkCap: 360,
    pulseCap: 12,
    envSize: 128,
    beamSteps: 10,
  },
  medium: {
    dpr: 1,
    bloom: true,
    bloomScale: 0.5,
    bloomLevels: 6,
    smaa: true,
    trailSegments: 64,
    shardCap: 300,
    sparkCap: 220,
    pulseCap: 8,
    envSize: 128,
    beamSteps: 8,
  },
  low: {
    dpr: 0.85,
    bloom: false,
    bloomScale: 0.5,
    bloomLevels: 5,
    smaa: false,
    trailSegments: 40,
    shardCap: 160,
    sparkCap: 120,
    pulseCap: 6,
    envSize: 128,
    beamSteps: 6,
  },
}

/** The order auto steps down through. */
export const QUALITY_ORDER: readonly QualityLevel[] = ['high', 'medium', 'low']

/** Auto-quality thresholds (CONSTITUTION section 2). */
export const AUTO_QUALITY = {
  /** Step down when the p95 frame cost is above this... */
  p95Ms: 14,
  /** ...after at least this many seconds of driving at the current level. */
  windowSeconds: 5,
  /** Ignore everything for this long after a track loads or a level changes (shader compiles, warm-up). */
  settleSeconds: 4,
} as const

export function isQualityChoice(v: unknown): v is QualityChoice {
  return v === 'auto' || v === 'low' || v === 'medium' || v === 'high'
}

/** Effective device pixel ratio for a preset on this screen. */
export function presetDpr(level: QualityLevel): number {
  const screen = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
  return Math.min(screen, QUALITY_PRESETS[level].dpr)
}
