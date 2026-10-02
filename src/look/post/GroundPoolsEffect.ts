// ============================================================
//  GROUND POOLS EFFECT - car light that lands on the real ground
// ------------------------------------------------------------
//  A fullscreen effect (merged into the post stack's one big pass,
//  so it costs no extra pass) that adds each car's underglow pool
//  and reverse glow (fx/groundPools.ts) to whatever the picture
//  shows near the car. Why not a mesh any more: see that file.
//
//  For each pixel:
//    1. The depth buffer says how far away the thing in this pixel
//       is, so we know the exact point it shows (camera space).
//    2. For each pool near that point, measure it in the car's own
//       directions: how far along the car, across it, and above or
//       below the car's road level.
//    3. Along and across give the soft oval of light (brightest in
//       the middle, fading to nothing at its edge). Height decides
//       whether it is ground: under the car only the road itself
//       is lit (the car's own body never is); away from the car the
//       light climbs a kerb or hill and dips into a hollow, so it
//       follows the ground instead of being cut off by it.
//  A pixel far from every car does one distance check per pool
//  and nothing else; with no pools at all one if() skips it.
//
//  The light is added to the HDR picture before bloom and tone
//  mapping, at the glow tier CarLights gives it (T0: it lights the
//  ground, it never blooms).
// ============================================================

import * as THREE from 'three'
import { BlendFunction, Effect, EffectAttribute } from 'postprocessing'
import { POOL_TUNE, groundPools } from '../fx/groundPools'

/** Most pools the shader draws in one frame (taken in the hand-over's order; past that, any extras go without: eight cars' worth). */
export const MAX_DRAWN_POOLS = 16

const fragment = /* glsl */ `
uniform int uPoolCount;
uniform vec4 uPoolA[MAX_POOLS];   // camera space: centre xyz, half width
uniform vec4 uPoolB[MAX_POOLS];   // camera space: forward xyz (unit), half length
uniform vec4 uPoolC[MAX_POOLS];   // camera space: up xyz (unit), body box offset along forward
uniform vec3 uPoolCol[MAX_POOLS]; // light colour x strength (linear HDR)
uniform vec4 uPoolProj;           // projection: m00, m11, then m20, m21 (perspective) or m30, m31 (the world map's top-down view)
uniform float uPoolOrtho;         // 1 for the top-down (orthographic) camera
uniform vec4 uPoolBody;           // body half width, body half length, rise under the car, rise away from it
uniform float uPoolDrop;          // how far below road level light still lands

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  outputColor = inputColor;
  if (uPoolCount <= 0) return;

  // the point this pixel shows, camera space: along its line of sight, at its depth
  // (the top-down map camera looks straight down, every line of sight parallel)
  vec2 ndc = uv * 2.0 - 1.0;
  float dist = -getViewZ(depth);
  vec3 p = uPoolOrtho > 0.5
    ? vec3((ndc.x - uPoolProj.z) / uPoolProj.x, (ndc.y - uPoolProj.w) / uPoolProj.y, -dist)
    : vec3((ndc.x + uPoolProj.z) / uPoolProj.x, (ndc.y + uPoolProj.w) / uPoolProj.y, -1.0) * dist;

  vec3 light = vec3(0.0);
  for (int i = 0; i < MAX_POOLS; i++) {
    if (i >= uPoolCount) break;
    vec4 a = uPoolA[i];
    vec4 b = uPoolB[i];
    vec4 c = uPoolC[i];
    vec3 d = p - a.xyz;
    float reach = max(a.w, b.w) + uPoolDrop;
    if (dot(d, d) > reach * reach) continue;

    // where the point is in the car's own directions
    float along = dot(d, b.xyz);
    float height = dot(d, c.xyz);
    float across = length(d - b.xyz * along - c.xyz * height);

    // the soft oval of light: wide and soft, most of it round the car, not hidden under it
    float r = length(vec2(across / max(a.w, 0.01), along / max(b.w, 0.01)));
    float pool = 1.0 - smoothstep(0.1, 1.0, r);
    if (pool <= 0.0) continue;
    pool *= 0.55 + 0.45 * pool;

    // ground or not: inside the car's box only road level counts (never the car's
    // own sides); outside it the light may climb a kerb or hill
    vec2 q = abs(vec2(across, along - c.w)) - uPoolBody.xy;
    float outside = length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0);
    float rise = mix(uPoolBody.z, uPoolBody.w, smoothstep(0.0, 0.6, outside));
    float ground = (1.0 - smoothstep(rise * 0.5, rise, height)) * (1.0 - smoothstep(uPoolDrop * 0.4, uPoolDrop, -height));

    light += uPoolCol[i] * (pool * ground);
  }
  outputColor = vec4(inputColor.rgb + light, inputColor.a);
}
`

const _view = new THREE.Matrix4()
const _p = new THREE.Vector3()
const _cam = new THREE.Vector3()

export class GroundPoolsEffect extends Effect {
  constructor() {
    super('GroundPoolsEffect', fragment, {
      blendFunction: BlendFunction.SRC,
      attributes: EffectAttribute.DEPTH,
      defines: new Map<string, string>([['MAX_POOLS', String(MAX_DRAWN_POOLS)]]),
      uniforms: new Map<string, THREE.Uniform>([
        ['uPoolCount', new THREE.Uniform(0)],
        ['uPoolA', new THREE.Uniform(Array.from({ length: MAX_DRAWN_POOLS }, () => new THREE.Vector4()))],
        ['uPoolB', new THREE.Uniform(Array.from({ length: MAX_DRAWN_POOLS }, () => new THREE.Vector4(0, 0, -1, 1)))],
        ['uPoolC', new THREE.Uniform(Array.from({ length: MAX_DRAWN_POOLS }, () => new THREE.Vector4(0, 1, 0, 0)))],
        ['uPoolCol', new THREE.Uniform(Array.from({ length: MAX_DRAWN_POOLS }, () => new THREE.Vector3()))],
        ['uPoolProj', new THREE.Uniform(new THREE.Vector4(1, 1, 0, 0))],
        ['uPoolOrtho', new THREE.Uniform(0)],
        ['uPoolBody', new THREE.Uniform(new THREE.Vector4())],
        ['uPoolDrop', new THREE.Uniform(1)],
      ]),
    })
  }

  /**
   * Copy this frame's pools (fx/groundPools.ts, world space) into camera
   * space. Call once per frame after the camera has moved. No allocation.
   * Returns how many pools are drawn.
   */
  sync(camera: THREE.Camera): number {
    camera.updateMatrixWorld()
    _view.copy(camera.matrixWorldInverse)
    _cam.setFromMatrixPosition(camera.matrixWorld)
    const u = this.uniforms
    const A = u.get('uPoolA')!.value as THREE.Vector4[]
    const B = u.get('uPoolB')!.value as THREE.Vector4[]
    const C = u.get('uPoolC')!.value as THREE.Vector4[]
    const col = u.get('uPoolCol')!.value as THREE.Vector3[]
    const drop = Math.max(0.1, POOL_TUNE.dropBelow)
    let n = 0
    for (let i = 0; i < groundPools.count && n < MAX_DRAWN_POOLS; i++) {
      const c = groundPools.colour[i]
      if (!(c.r + c.g + c.b > 0.001)) continue
      const centre = groundPools.centre[i]
      // far-away pools fade out instead of costing pixels
      const fade = 1 - THREE.MathUtils.smoothstep(centre.distanceTo(_cam), POOL_TUNE.fadeNear, POOL_TUNE.fadeFar)
      if (fade <= 0.001) continue
      const hw = groundPools.halfWidth[i]
      const hl = groundPools.halfLength[i]
      _p.copy(centre).applyMatrix4(_view)
      // wholly behind the camera: nothing on screen to light
      if (_p.z > Math.max(hw, hl) + drop) continue
      if (!Number.isFinite(_p.x + _p.y + _p.z)) continue
      A[n].set(_p.x, _p.y, _p.z, hw)
      _p.copy(groundPools.forward[i]).transformDirection(_view)
      B[n].set(_p.x, _p.y, _p.z, hl)
      _p.copy(groundPools.up[i]).transformDirection(_view)
      C[n].set(_p.x, _p.y, _p.z, groundPools.bodyOffset[i])
      col[n].set(c.r * fade, c.g * fade, c.b * fade)
      n++
    }
    u.get('uPoolCount')!.value = n

    const m = (camera as THREE.PerspectiveCamera).projectionMatrix.elements
    const ortho = (camera as THREE.OrthographicCamera).isOrthographicCamera === true
    ;(u.get('uPoolProj')!.value as THREE.Vector4).set(m[0], m[5], ortho ? m[12] : m[8], ortho ? m[13] : m[9])
    u.get('uPoolOrtho')!.value = ortho ? 1 : 0
    ;(u.get('uPoolBody')!.value as THREE.Vector4).set(
      Math.max(0.1, POOL_TUNE.bodyHalfWidth),
      Math.max(0.1, POOL_TUNE.bodyHalfLength),
      Math.max(0.02, POOL_TUNE.riseUnderCar),
      Math.max(0.05, POOL_TUNE.riseAway),
    )
    u.get('uPoolDrop')!.value = drop
    return n
  }
}
