// ============================================================
//  LOOK STATE - live numbers the look system shares
// ------------------------------------------------------------
//  A plain mutable object (no React state, CONSTITUTION section 2)
//  that the look modules write and the `look` inspector reads:
//    window.__game.get('look')
//  Checkers use it to confirm what the post stack, trails and
//  particles are actually doing right now.
// ============================================================

import type { QualityChoice, QualityLevel } from '../core/settings'

export const lookState = {
  quality: {
    /** What the player (or URL / dev command) asked for. */
    choice: 'auto' as QualityChoice,
    /** Where that choice came from. */
    source: 'settings' as 'settings' | 'url' | 'dev',
    /** The level in use. */
    level: 'high' as QualityLevel,
    /** Why auto last stepped down (empty if it never did). */
    lastStep: '',
    /** Seconds of driving counted towards the current auto window. */
    windowSeconds: 0,
    /** Last p95 the auto manager looked at, ms. */
    lastP95: 0,
    dpr: 1,
  },
  post: {
    toneMapping: 'neutral' as 'aces' | 'agx' | 'neutral',
    exposure: 1,
    bloom: false,
    bloomIntensity: 0,
    bloomThreshold: 1,
    bloomKnee: 0.25,
    bloomRadius: 0,
    bloomScale: 1,
    bloomLevels: 0,
    smaa: false,
    /** 0..1 how much boost lens (aberration + speed lines) is applied right now. */
    boostLens: 0,
    /** Headlight lamps whose beams are being drawn this frame. */
    beamLamps: 0,
    passes: 0,
  },
  env: {
    /** How many times the reflection map has been rebuilt. */
    builds: 0,
    /** timeOfDay the current map was built for. */
    timeOfDay: -1,
    size: 0,
    lastBuildMs: 0,
  },
  road: {
    /** Triangles in the road + skirt meshes. */
    triangles: 0,
    lanes: 0,
    edgeColor: '',
    rebuilds: 0,
    /** Bridge pylons standing under raised road on this track. */
    pylons: 0,
  },
  fx: {
    trails: 0,
    trailSegments: 0,
    shardsAlive: 0,
    sparksAlive: 0,
    pulsesAlive: 0,
    shardCap: 0,
    sparkCap: 0,
  },
}
