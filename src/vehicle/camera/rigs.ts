// ============================================================
//  CAMERA RIGS - chase, close and bonnet, as numbers
// ------------------------------------------------------------
//  Each mode is a rig: where the camera sits relative to the car,
//  where it looks, and how tight its springs are. Switching mode
//  (C / RB) never cuts: CameraRig eases between the two rigs'
//  targets over TRANSITION_S while the springs keep smoothing.
//
//  The chase rig's distance and height come from Settings
//  (cameraDistance / cameraHeight), so Josh's config.ts edits and
//  the Settings sliders move it live.
// ============================================================

import type { CameraMode } from '../../core/settings'

export interface CameraRigSpec {
  /** 'orbit' rides behind the car; 'mount' is bolted to the chassis. */
  kind: 'orbit' | 'mount'
  /** orbit: metres behind / above (chase uses the settings instead). */
  distance: number
  height: number
  /** mount: chassis-local position. */
  mountY: number
  mountZ: number
  /** How far the orbit swings from the nose toward the velocity (sells a drift). */
  velocityBlendBase: number
  velocityBlendSlip: number
  lookAhead: number
  lookAheadSpeedGain: number
  lookHeight: number
  /** Spring catch-up times, seconds. Smaller = tighter. */
  posSmooth: number
  posSmoothDrift: number
  lookSmooth: number
  /** Speed shake and impact kick, scaled per mode. */
  shakeScale: number
  /** Degrees added to the FOV. */
  fovOffset: number
  /**
   * Velocity lead 0..1. A spring chasing a moving target trails it by about
   * v x smoothTime. For an orbit that lag IS the feel; for a camera bolted to
   * the nose it would sit inside the cabin at speed. Adding v x smoothTime back
   * onto the target cancels it, leaving the spring only the jolts.
   */
  velocityLead: number
}

export const CAMERA_MODES: readonly CameraMode[] = ['chase', 'close', 'bonnet']

export const RIGS: Record<CameraMode, CameraRigSpec> = {
  chase: {
    kind: 'orbit',
    distance: 7.5,
    height: 2.6,
    mountY: 0,
    mountZ: 0,
    velocityBlendBase: 0.35,
    velocityBlendSlip: 0.5,
    lookAhead: 2.4,
    lookAheadSpeedGain: 0.06,
    lookHeight: 0.9,
    posSmooth: 0.16,
    posSmoothDrift: 0.12,
    lookSmooth: 0.1,
    shakeScale: 1,
    fovOffset: 0,
    velocityLead: 0,
  },
  close: {
    kind: 'orbit',
    distance: 4.3,
    height: 1.0,
    mountY: 0,
    mountZ: 0,
    velocityBlendBase: 0.5,
    velocityBlendSlip: 0.62,
    lookAhead: 3.4,
    lookAheadSpeedGain: 0.075,
    lookHeight: 0.75,
    posSmooth: 0.11,
    posSmoothDrift: 0.085,
    lookSmooth: 0.08,
    shakeScale: 1.15,
    fovOffset: 2,
    velocityLead: 0,
  },
  bonnet: {
    kind: 'mount',
    distance: 0,
    height: 0,
    // Just above the nose: a sliver of bonnet, the road filling the frame.
    mountY: 0.5,
    mountZ: 1.55,
    velocityBlendBase: 0,
    velocityBlendSlip: 0,
    lookAhead: 14,
    lookAheadSpeedGain: 0.25,
    lookHeight: 0.1,
    posSmooth: 0.045,
    posSmoothDrift: 0.045,
    lookSmooth: 0.05,
    shakeScale: 0.45,
    fovOffset: 6,
    velocityLead: 1,
  },
}

/** How long a mode change takes to ease across. */
export const TRANSITION_S = 0.4

export const CAMERA = {
  /** Distance / height grow a little with speed. */
  distanceSpeedGain: 0.1,
  heightSpeedGain: 0.05,
  /** Degrees of extra FOV at top speed (before boost). */
  fovSpeed: 8,
  fovSmooth: 0.35,
  /** Up-vector spring time, seconds: loops roll the view smoothly, never snap it. */
  upSmooth: 0.22,
  /**
   * ...and while it follows the car's up, its target leads the car's up by the car's own spin
   * x this many seconds (at most upLeadMax rad), so it doesn't trail a loop by ~60 deg.
   * 0.7 x upSmooth: most of the lag goes, the spring's smoothing stays.
   */
  upLead: 0.15,
  upLeadMax: 1.1,
  /** Car tilted more than this from world up (on the ground) = follow the car's up. ~25 deg. */
  steepCos: 0.9,
  /** Rotational speed shake - tiny. Nausea is a bug. */
  shakeAmp: 0.0016,
  kickRot: 0.05,
  kickPos: 0.35,
  /** Never closer than this to the ground or a wall. */
  clearance: 0.5,
  wallPad: 0.35,
  /** The clip test looks from this far above the car (m, along the camera's up). */
  pivotHeight: 1.1,
  /** Under a slab overhead (an overpass) the camera's target is kept this far below its underside, m... */
  ceilingPad: 0.6,
  /** ...eased in; but never closer than this (m), at once: the near plane (0.1 m) stays out of the slab. */
  ceilingMin: 0.2,
  /** And never closer than this (m) to any face of a road, loop, wall or ramp slab, from any side. */
  slabClear: 0.3,
  /** A wall that appears between car and camera pulls the arm in at this rate (1/s: ~95% in 3 frames at 60 fps)... */
  clipInRate: 60,
  /**
   * A slab (road, loop, wall, ramp) about to swing in between car and camera is seen this far
   * (m) beside the camera, and the arm closes in ahead of it: eased at clipSoftRate (1/s) and
   * never faster than clipInMax m/s (0.35 m a frame at 60 fps), so it never has to jump in front
   * of one.
   */
  clipLookRadius: 1.2,
  /** The look-ahead runs only while the car is slower than this, km/h (crawling about beside slabs). */
  clipLookKmh: 55,
  clipSoftRate: 10,
  clipInMax: 21,
  /**
   * A slab's side face (|normal . up| under sideFace) between the car and the camera's spot lifts the
   * spot over it by the first of these heights (m) that gives a clear view of the car.
   */
  riseSteps: [0.8, 1.6, 2.6, 4] as readonly number[],
  sideFace: 0.6,
  /** The look-ahead also tests the line as it will be this many seconds from now (two horizons). */
  clipAhead: [0.12, 0.3] as readonly number[],
  /** After the look-ahead last saw a slab coming, the arm holds (doesn't ease back out) this long, seconds. */
  clipHold: 0.6,
  /** ...and once clear it lets the arm back out at this speed, m/s. */
  clipOutSpeed: 6,
}
