// ============================================================
//  CUSTOM POST EFFECTS - the pieces postprocessing doesn't ship
// ------------------------------------------------------------
//  All of these are cheap fullscreen maths that get MERGED into
//  one shader pass with bloom, tone mapping and the vignette, so
//  each costs a few instructions per pixel, not a pass of its own.
//
//    BoostLensEffect   chromatic aberration (red and blue split
//                      apart toward the screen edges) while you
//                      boost. Runs FIRST, on the raw HDR picture.
//    GradeEffect       the synthwave colour grade, after tone
//                      mapping: violet in the shadows (no dead
//                      black voids), a little contrast.
//    SpeedLinesEffect  thin light streaks rushing out past the
//                      screen edges while you boost.
//
//  The boost effects are switched by a number (uAmount), never by
//  adding or removing effects: changing the effect list recompiles
//  shaders and the game would hitch every time you hit a pad. At
//  uAmount 0 a single if() skips all their work.
//
//  applyTierThreshold() swaps bloom's brightness test for one that
//  matches the glow tiers in palette.ts (see its comment).
// ============================================================

import * as THREE from 'three'
import { BlendFunction, Effect, EffectAttribute } from 'postprocessing'
import type { BloomEffect } from 'postprocessing'

// ---------------------------------------------------------------- boost lens (chromatic aberration)

const lensFragment = /* glsl */ `
uniform float uAmount;
uniform float uMaxOffset;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  if (uAmount <= 0.0) {
    outputColor = inputColor;
    return;
  }
  // Split grows with distance from the centre, so the car stays sharp.
  vec2 d = uv - 0.5;
  float r2 = dot(d, d);
  vec2 off = d * (uMaxOffset * uAmount) * (0.25 + 3.0 * r2);
  float red = texture2D(inputBuffer, uv + off).r;
  float blue = texture2D(inputBuffer, uv - off).b;
  outputColor = vec4(red, inputColor.g, blue, inputColor.a);
}
`

export class BoostLensEffect extends Effect {
  constructor() {
    super('BoostLensEffect', lensFragment, {
      blendFunction: BlendFunction.SRC,
      attributes: EffectAttribute.CONVOLUTION,
      uniforms: new Map<string, THREE.Uniform>([
        ['uAmount', new THREE.Uniform(0)],
        ['uMaxOffset', new THREE.Uniform(0.016)],
      ]),
    })
  }
  get amount(): number {
    return this.uniforms.get('uAmount')!.value as number
  }
  set amount(v: number) {
    this.uniforms.get('uAmount')!.value = v
  }
}

// ---------------------------------------------------------------- grade

const gradeFragment = /* glsl */ `
uniform vec3 uShadowTint;
uniform float uShadowLift;
uniform float uContrast;
uniform float uSaturation;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = inputColor.rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // Lift the deepest shadows toward violet: dark glass, not a black hole.
  float shadows = 1.0 - smoothstep(0.0, 0.22, l);
  c += uShadowTint * shadows * uShadowLift;
  c = clamp(c, 0.0, 1.0);
  // smoothstep is an S-curve; blending toward it is a contrast dial.
  c = mix(c, c * c * (3.0 - 2.0 * c), uContrast);
  float g = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(g), c, uSaturation);
  outputColor = vec4(clamp(c, 0.0, 1.0), inputColor.a);
}
`

export class GradeEffect extends Effect {
  constructor(shadowTint: THREE.Color, { lift = 0.05, contrast = 0.18, saturation = 1.08 } = {}) {
    super('GradeEffect', gradeFragment, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, THREE.Uniform>([
        ['uShadowTint', new THREE.Uniform(new THREE.Vector3(shadowTint.r, shadowTint.g, shadowTint.b))],
        ['uShadowLift', new THREE.Uniform(lift)],
        ['uContrast', new THREE.Uniform(contrast)],
        ['uSaturation', new THREE.Uniform(saturation)],
      ]),
    })
  }
}

// ---------------------------------------------------------------- speed lines

const speedFragment = /* glsl */ `
uniform float uAmount;
uniform float uTime;
uniform vec3 uColor;

float sr2Hash(float n) {
  return fract(sin(n * 12.9898) * 43758.5453);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  outputColor = inputColor;
  if (uAmount <= 0.0) return;

  vec2 d = (uv - 0.5) * vec2(aspect, 1.0);
  float r = length(d);
  // Only toward the edges: the middle of the screen is where you look.
  float edge = smoothstep(0.38, 0.85, r);
  if (edge <= 0.0) return;

  const float SPOKES = 160.0;
  float a = atan(d.y, d.x) / 6.2831853 + 0.5;
  float cell = floor(a * SPOKES);
  float across = abs(fract(a * SPOKES) - 0.5) * 2.0; // 0 at the spoke's centre line

  // Each spoke runs its own streak outward and re-rolls every cycle.
  float h = sr2Hash(cell);
  float speed = 1.6 + 1.4 * h;
  float t = uTime * speed + h * 7.0;
  float cycle = floor(t);
  float alive = step(0.68, sr2Hash(cell * 1.7 + cycle * 13.1));
  float head = 0.3 + fract(t) * 0.75;           // where the streak's head is (radius)
  float len = 0.12 + 0.18 * sr2Hash(cell + cycle * 3.3);
  float along = smoothstep(head - len, head, r) * (1.0 - smoothstep(head, head + 0.02, r));

  // Thin line, anti-aliased by its own screen-space footprint.
  float w = fwidth(across) * 1.2;
  float thick = 0.08 + 0.12 * h;
  float line = 1.0 - smoothstep(thick - w, thick + w, across);

  float streak = line * along * alive * edge * uAmount;
  outputColor = vec4(inputColor.rgb + uColor * streak * 0.42, inputColor.a);
}
`

export class SpeedLinesEffect extends Effect {
  constructor(color: THREE.Color) {
    super('SpeedLinesEffect', speedFragment, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, THREE.Uniform>([
        ['uAmount', new THREE.Uniform(0)],
        ['uTime', new THREE.Uniform(0)],
        ['uColor', new THREE.Uniform(new THREE.Vector3(color.r, color.g, color.b))],
      ]),
    })
  }
  set amount(v: number) {
    this.uniforms.get('uAmount')!.value = v
  }
  get amount(): number {
    return this.uniforms.get('uAmount')!.value as number
  }
  set time(v: number) {
    this.uniforms.get('uTime')!.value = v
  }
}

// ---------------------------------------------------------------- bloom threshold that matches the glow tiers

/**
 * The stock bloom test uses luminance (how bright a colour LOOKS),
 * which counts green about ten times more than blue. Our glow tiers
 * are intensity multipliers on saturated neon colours, and a
 * magenta strip at T2 has a luminance under 1, so it would never
 * bloom while a cyan one at the same tier blazes. That breaks the
 * tier rules.
 *
 * This test uses the brightest colour channel instead, so "T2" means
 * the same glow whatever the hue, and T0 (0.85) never blooms. It also
 * feeds bloom only the part ABOVE the threshold (a soft knee), so T1
 * gets a soft halo, T2 a strong one and T3 a flash, instead of
 * everything over the line blooming at full strength.
 */
const tierLuminanceFragment = /* glsl */ `
#include <common>
#ifdef FRAMEBUFFER_PRECISION_HIGH
uniform mediump sampler2D inputBuffer;
#else
uniform lowp sampler2D inputBuffer;
#endif
uniform float threshold;
uniform float smoothing;
varying vec2 vUv;

void main() {
  vec4 texel = texture2D(inputBuffer, vUv);
  float m = max(max(texel.r, texel.g), texel.b);
  float knee = max(smoothing, 1e-4);
  float soft = clamp(m - threshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee);
  float contribution = max(soft, m - threshold);
  gl_FragColor = vec4(texel.rgb * (contribution / max(m, 1e-4)), 1.0);
}
`

export function applyTierThreshold(bloom: BloomEffect, threshold: number, knee: number): void {
  const material = bloom.luminanceMaterial
  material.fragmentShader = tierLuminanceFragment
  material.threshold = threshold
  material.smoothing = knee
  material.needsUpdate = true
}
