// ============================================================
//  SKY ENVIRONMENT - the sky as a reflection map
// ------------------------------------------------------------
//  Shiny things (the glass ground, car paint, the wet road)
//  reflect scene.environment. For those reflections to show the
//  sky the player actually sees - the striped sun, the pink
//  horizon, the night - the sky has to be captured into an
//  environment map, and re-captured as the time of day moves.
//
//  SkyEnvironment renders the real sky shader (same material as
//  the dome, so the two can never disagree) into a small cube
//  map, then runs three's PMREM filter over it so rough surfaces
//  get blurry reflections and glossy ones sharp. Everything is
//  allocated once; update() reuses the same render targets.
//
//  A re-capture costs about 7 ms of GPU time on this Mac (the PMREM
//  filter is many small passes, which tile GPUs dislike), so it must
//  be rare. update() can be called every frame: it only re-captures
//  when the sky has VISIBLY changed since last time - the horizon,
//  zenith or sun-glow colour moved, the sun moved, or the stars came
//  further out. At sundown that is every several seconds; deep in
//  the night, almost never.
//
//  The look system decides when scene.environment is set; this
//  is the tool it (or a dev scene) uses to make one.
// ============================================================

import * as THREE from 'three'
import { makeSkyMaterial } from './SkyDome'
import { sky, skyUniforms } from './sky'

/** How much the sky must change (largest colour channel step, linear 0..1) before a re-capture. */
const COLOUR_STEP = 0.014
/** ...or how far the sun must move, degrees. */
const SUN_STEP_DEG = 0.6
/** ...or how far the stars and planet must fade in. */
const NIGHT_STEP = 0.06

export class SkyEnvironment {
  /** The filtered environment texture: assign to scene.environment. */
  get texture(): THREE.Texture {
    return this.pmremTarget.texture
  }

  private readonly scene = new THREE.Scene()
  private readonly material = makeSkyMaterial()
  private readonly geometry = new THREE.SphereGeometry(10, 48, 24)
  private readonly cubeTarget: THREE.WebGLCubeRenderTarget
  private readonly cubeCamera: THREE.CubeCamera
  private readonly pmrem: THREE.PMREMGenerator
  private readonly pmremTarget: THREE.WebGLRenderTarget
  /** What the sky looked like at the last capture: horizon, zenith, sun glow, sun elevation, night sky. */
  private readonly last = new Float32Array(11).fill(-1)
  private readonly renderer: THREE.WebGLRenderer

  constructor(renderer: THREE.WebGLRenderer, size = 128) {
    this.renderer = renderer
    // The sun disc is HDR: keep it in a half-float target so reflections of it stay hot.
    this.cubeTarget = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType, generateMipmaps: false })
    this.cubeCamera = new THREE.CubeCamera(0.1, 50, this.cubeTarget)
    const dome = new THREE.Mesh(this.geometry, this.material)
    dome.frustumCulled = false
    this.scene.add(dome)
    this.scene.add(this.cubeCamera)
    this.pmrem = new THREE.PMREMGenerator(renderer)
    this.pmrem.compileCubemapShader()
    this.render()
    this.pmremTarget = this.pmrem.fromCubemap(this.cubeTarget.texture)
  }

  private render(): void {
    this.cubeCamera.update(this.renderer, this.scene)
  }

  /** True if colour c differs from the remembered one at slot k by more than `step`. */
  private moved(c: THREE.Color, k: number, step: number): boolean {
    const l = this.last
    return Math.abs(c.r - l[k]) > step || Math.abs(c.g - l[k + 1]) > step || Math.abs(c.b - l[k + 2]) > step
  }

  /** True if the sky now looks different enough from the last capture to be worth one. */
  private changed(colourStep: number): boolean {
    const u = skyUniforms
    if (this.last[0] < 0) return true
    if (this.moved(u.uSkyHorizon.value, 0, colourStep)) return true
    if (this.moved(u.uSkyZenith.value, 3, colourStep)) return true
    if (this.moved(u.uSkySunGlow.value, 6, colourStep)) return true
    if (Math.abs(sky.sunElevationDeg - this.last[9]) > SUN_STEP_DEG) return true
    return Math.abs(sky.nightSky - this.last[10]) > NIGHT_STEP
  }

  private keep(c: THREE.Color, k: number): void {
    this.last[k] = c.r
    this.last[k + 1] = c.g
    this.last[k + 2] = c.b
  }

  private remember(): void {
    const u = skyUniforms
    this.keep(u.uSkyHorizon.value, 0)
    this.keep(u.uSkyZenith.value, 3)
    this.keep(u.uSkySunGlow.value, 6)
    this.last[9] = sky.sunElevationDeg
    this.last[10] = sky.nightSky
  }

  /**
   * Re-capture the sky if it has visibly changed since the last capture
   * (or always, with force). Cheap to call every frame (no allocation).
   * `colourStep` is how far a sky colour channel (linear 0..1) must move
   * first; the default suits the reflection map. Returns true if it captured.
   */
  update(force = false, colourStep = COLOUR_STEP): boolean {
    if (!force && !this.changed(colourStep)) return false
    this.remember()
    this.render()
    this.pmrem.fromCubemap(this.cubeTarget.texture, this.pmremTarget)
    return true
  }

  dispose(): void {
    this.material.dispose()
    this.geometry.dispose()
    this.cubeTarget.dispose()
    this.pmremTarget.dispose()
    this.pmrem.dispose()
  }
}
