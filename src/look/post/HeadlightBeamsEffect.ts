// ============================================================
//  HEADLIGHT BEAMS EFFECT - beams of light in the night air
// ------------------------------------------------------------
//  A fullscreen effect (merged into the post stack's one big pass,
//  so it costs no extra pass) that draws every car's headlight
//  beams as soft volumes of light. Why not a cone mesh: see
//  fx/beams.ts.
//
//  For each pixel, and each lamp:
//    1. Work out the line of sight through this pixel (camera space).
//    2. Find the stretch of it that lies inside the lamp's beam cone
//       (exact maths, a quadratic), and cut that stretch off where
//       the scene is: the depth buffer says how far away the road,
//       hill or car in this pixel is.
//    3. Walk along that stretch in a few steps, adding up the beam's
//       density: brightest along the middle and near the lamp, fading
//       smoothly to nothing at the edges, toward the far end, and in
//       the last stretch before it touches a surface (the
//       "soft-particle" fade, so a beam never shows a line where it
//       meets the road or a hillside), and right in front of the
//       camera lens.
//  Pixels whose line of sight misses every beam do almost no work,
//  and with no beams at all (daytime) one if() skips everything.
//
//  The light is added to the HDR picture before bloom's threshold
//  and tone mapping, but stays far below 1.0: beams are haze, they
//  never bloom (CONSTITUTION section 1, glow tiers).
// ============================================================

import * as THREE from 'three'
import { BlendFunction, Effect, EffectAttribute } from 'postprocessing'
import { BEAM_TUNE, MAX_BEAM_LAMPS, beamLamps } from '../fx/beams'

const fragment = /* glsl */ `
uniform int uLampCount;
uniform vec3 uLampPos[MAX_LAMPS];   // camera space
uniform vec3 uLampDir[MAX_LAMPS];   // camera space, unit length
uniform float uLampGain[MAX_LAMPS];
uniform vec4 uProj;                 // projection: m00, m11, m20, m21 (rebuilds a pixel's line of sight)
uniform vec4 uShape;                // start radius, spread, length, soft-contact distance
uniform vec3 uBeamColor;
uniform float uBeamIntensity;
uniform float uBeamMax;             // the brightest a pixel of beam can get (below bloom)
uniform float uPhaseG;              // 0 = haze glows the same from every side, toward 1 = mostly onward
uniform float uBeamFade;            // metres over which the light near the lamp thins out

// Interleaved gradient noise: a fixed per-pixel offset for the steps, so
// a few steps look smooth instead of banded.
float beamNoise(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

// How much beam is at point p (camera space) for a lamp at o pointing along d.
float beamDensity(vec3 p, vec3 o, vec3 d) {
  vec3 v = p - o;
  float z = dot(v, d);
  float r2 = max(dot(v, v) - z * z, 0.0);
  float w = uShape.x + max(z, 0.0) * uShape.y;
  float x = r2 / (w * w);
  // a bright core whose light falls away gradually, with long faint tails
  // (1 / (1 + kx)^2, not a Gaussian): seen from behind, a Gaussian cone
  // shows its sides as two straight lines; this melts into the dark
  float q = 1.0 + 3.0 * x;
  float across = 1.0 / (q * q);
  // fades in over the first metre and a half (no hot spot at the lamp), is
  // strongest near the lamp (light thins out as it spreads), and fades out
  // over the far 60% of its length
  float along = smoothstep(0.0, 1.5, z) * (1.0 - smoothstep(uShape.z * 0.4, uShape.z, z)) * (0.3 + 0.7 * exp(-z / uBeamFade));
  // the same light spread over a wider beam is dimmer (0.5 keeps the lamp end from blazing)
  return across * along / (w * w + 0.5);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  outputColor = inputColor;
  if (uLampCount <= 0) return;

  // line of sight, camera space, scaled so its z is -1: a point at
  // parameter t is t metres in front of the camera (view depth)
  vec2 ndc = uv * 2.0 - 1.0;
  vec3 ray = vec3((ndc.x + uProj.z) / uProj.x, (ndc.y + uProj.w) / uProj.y, -1.0);
  float rayLen = length(ray);
  vec3 e = ray / rayLen;
  // how far the scene is along this line of sight (metres along e)
  float sceneDist = -getViewZ(depth) * rayLen;

  float startR = uShape.x;
  float spread = uShape.y;
  float len = uShape.z;
  // the bounding cone is 2.6x the beam's own radius: past that the tails are under 0.2% bright
  float T = spread * 2.6;
  float k = 1.0 + T * T;
  float apexBack = startR / spread; // the cone's tip sits this far behind the lamp
  float jitter = beamNoise(gl_FragCoord.xy);
  float light = 0.0;

  for (int i = 0; i < MAX_LAMPS; i++) {
    if (i >= uLampCount) break;
    vec3 o = uLampPos[i];
    vec3 d = uLampDir[i];
    vec3 A = o - d * apexBack;

    // ---- stretch of the line of sight between the beam's two end planes (0..len along d)
    float alpha = dot(e, d);
    float od = dot(o, d);
    float t0 = 0.0;
    float t1 = sceneDist;
    if (abs(alpha) > 1e-5) {
      float ta = od / alpha;
      float tb = (len + od) / alpha;
      t0 = max(t0, min(ta, tb));
      t1 = min(t1, max(ta, tb));
    } else if (-od < 0.0 || -od > len) {
      continue;
    }
    if (t1 <= t0) continue;

    // ---- ...and inside the cone: (v.d)^2 (1 + T^2) >= |v|^2, v = e t - A
    float q = -dot(A, d);
    float eA = dot(e, A);
    float qa = k * alpha * alpha - 1.0;
    float qb = 2.0 * (k * alpha * q + eA);
    float qc = k * q * q - dot(A, A);
    float disc = qb * qb - 4.0 * qa * qc;
    if (abs(qa) < 1e-6) qa = qa < 0.0 ? -1e-6 : 1e-6;
    if (qa < 0.0) {
      if (disc <= 0.0) continue;
      float sq = sqrt(disc);
      float r1 = (-qb + sq) / (2.0 * qa);
      float r2 = (-qb - sq) / (2.0 * qa);
      t0 = max(t0, min(r1, r2));
      t1 = min(t1, max(r1, r2));
    } else if (disc > 0.0) {
      float sq = sqrt(disc);
      float r1 = (-qb - sq) / (2.0 * qa);
      float r2 = (-qb + sq) / (2.0 * qa);
      // inside means outside the roots; only one side lies in front of the lamp
      if (min(t1, r1) > t0) t1 = min(t1, r1);
      else t0 = max(t0, r2);
    }
    if (t1 <= t0) continue;

    // ---- haze scatters light mostly onward: a beam seen from behind (your
    // own, from the driver's seat) is dimmer than from the side, and an
    // oncoming car's beams glare (Henyey-Greenstein, scaled so side-on = 1)
    float g = uPhaseG;
    float phase = pow((1.0 + g * g) / max(1.0 + g * g + 2.0 * g * alpha, 1e-3), 1.5);

    // ---- walk the stretch, adding up the beam
    float dt = (t1 - t0) / float(BEAM_STEPS);
    float sum = 0.0;
    for (int s = 0; s < BEAM_STEPS; s++) {
      float t = t0 + (float(s) + jitter) * dt;
      float contact = clamp((sceneDist - t) / uShape.w, 0.0, 1.0);
      // and no haze right against the lens (the bonnet camera sits just above the lamps)
      float lens = smoothstep(1.0, 4.0, t);
      sum += beamDensity(e * t, o, d) * contact * contact * (3.0 - 2.0 * contact) * lens;
    }
    light += sum * dt * uLampGain[i] * phase;
  }

  // Soft ceiling: looking straight down a beam you see through a lot of
  // it, so the light builds up like fog does (1 - e^-x), never past uBeamMax.
  float glow = uBeamMax * (1.0 - exp(-light * uBeamIntensity / uBeamMax));
  outputColor = vec4(inputColor.rgb + uBeamColor * glow, inputColor.a);
}
`

const _view = new THREE.Matrix4()
const _p = new THREE.Vector3()

export class HeadlightBeamsEffect extends Effect {
  constructor(color: THREE.Color, steps: number) {
    super('HeadlightBeamsEffect', fragment, {
      blendFunction: BlendFunction.SRC,
      attributes: EffectAttribute.DEPTH,
      defines: new Map<string, string>([
        ['MAX_LAMPS', String(MAX_BEAM_LAMPS)],
        ['BEAM_STEPS', String(Math.max(4, Math.round(steps)))],
      ]),
      uniforms: new Map<string, THREE.Uniform>([
        ['uLampCount', new THREE.Uniform(0)],
        ['uLampPos', new THREE.Uniform(Array.from({ length: MAX_BEAM_LAMPS }, () => new THREE.Vector3()))],
        ['uLampDir', new THREE.Uniform(Array.from({ length: MAX_BEAM_LAMPS }, () => new THREE.Vector3(0, 0, -1)))],
        ['uLampGain', new THREE.Uniform(new Float32Array(MAX_BEAM_LAMPS))],
        ['uProj', new THREE.Uniform(new THREE.Vector4(1, 1, 0, 0))],
        ['uShape', new THREE.Uniform(new THREE.Vector4())],
        ['uBeamColor', new THREE.Uniform(new THREE.Vector3(color.r, color.g, color.b))],
        ['uBeamIntensity', new THREE.Uniform(BEAM_TUNE.intensity)],
        ['uBeamMax', new THREE.Uniform(BEAM_TUNE.maxBrightness)],
        ['uPhaseG', new THREE.Uniform(BEAM_TUNE.forwardScatter)],
        ['uBeamFade', new THREE.Uniform(BEAM_TUNE.nearFade)],
      ]),
    })
  }

  /**
   * Copy this frame's lamps (fx/beams.ts, world space) into camera space.
   * Call once per frame after the camera has moved. No allocation.
   * Returns how many lamps are lit.
   */
  sync(camera: THREE.Camera): number {
    camera.updateMatrixWorld()
    _view.copy(camera.matrixWorldInverse)
    const u = this.uniforms
    const pos = u.get('uLampPos')!.value as THREE.Vector3[]
    const dir = u.get('uLampDir')!.value as THREE.Vector3[]
    const gain = u.get('uLampGain')!.value as Float32Array
    const camPos = camera.position
    let n = 0
    for (let i = 0; i < beamLamps.count && n < MAX_BEAM_LAMPS; i++) {
      const g = beamLamps.gain[i]
      if (g <= 0.001) continue
      const p = beamLamps.position[i]
      // far-away cars' beams fade out instead of costing pixels
      const dist = _p.copy(p).sub(camPos).length()
      const fade = 1 - THREE.MathUtils.smoothstep(dist, BEAM_TUNE.fadeNear, BEAM_TUNE.fadeFar)
      if (fade <= 0.001) continue
      pos[n].copy(p).applyMatrix4(_view)
      dir[n].copy(beamLamps.direction[i]).transformDirection(_view)
      gain[n] = g * fade
      n++
    }
    u.get('uLampCount')!.value = n

    const m = (camera as THREE.PerspectiveCamera).projectionMatrix.elements
    ;(u.get('uProj')!.value as THREE.Vector4).set(m[0], m[5], m[8], m[9])
    ;(u.get('uShape')!.value as THREE.Vector4).set(
      Math.max(0.02, BEAM_TUNE.startRadius),
      Math.max(0.02, BEAM_TUNE.spread),
      Math.max(1, BEAM_TUNE.length),
      Math.max(0.05, BEAM_TUNE.softContact),
    )
    u.get('uBeamIntensity')!.value = BEAM_TUNE.intensity
    u.get('uBeamMax')!.value = Math.max(0.01, BEAM_TUNE.maxBrightness)
    u.get('uPhaseG')!.value = THREE.MathUtils.clamp(BEAM_TUNE.forwardScatter, 0, 0.9)
    u.get('uBeamFade')!.value = Math.max(1, BEAM_TUNE.nearFade)
    return n
  }
}
