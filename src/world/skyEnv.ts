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
//  allocated once; update() reuses the same render targets, so it
//  is cheap to call every second or so (it skips itself when the
//  sky has barely changed).
//
//  The look system decides when scene.environment is set; this
//  is the tool it (or a dev scene) uses to make one.
// ============================================================

import * as THREE from 'three'
import { makeSkyMaterial } from './SkyDome'
import { worldClock } from './clock'

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
  private lastTime = -1
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

  /**
   * Re-capture the sky if the time of day moved more than `minStep`
   * since the last capture (or always, with force). Returns true if it did.
   */
  update(force = false, minStep = 0.004): boolean {
    if (!force && this.lastTime >= 0 && Math.abs(worldClock.time - this.lastTime) < minStep) return false
    this.lastTime = worldClock.time
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
