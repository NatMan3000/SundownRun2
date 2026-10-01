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
  /** Car tilted more than this from world up (on the ground) = follow the car's up. ~25 deg. */
  steepCos: 0.9,
  /** Rotational speed shake - tiny. Nausea is a bug. */
  shakeAmp: 0.0016,
  kickRot: 0.05,
  kickPos: 0.35,
  /** Never closer than this to the ground or a wall. */
  clearance: 0.5,
  wallPad: 0.35,
  /** A wall that appears between car and camera pulls the arm in at this rate (1/s: ~95% in 3 frames at 60 fps)... */
  clipInRate: 60,
  /** ...and once clear it lets the arm back out at this speed, m/s. */
  clipOutSpeed: 6,
}
