// ============================================================
//  LIGHT TRAILS - Tron-style ribbons of light behind the cars
// ------------------------------------------------------------
//  Each car's tail lights leave a ribbon of light that fades out
//  over about a second and a half, like a long-exposure photo of
//  a car at night. Brighter while sliding or boosting. These
//  replace the drift smoke v1 had.
//
//  How it stays cheap:
//    - ALL trails live in ONE mesh (one draw call), with a fixed
//      number of slots allocated once. Nothing is created per frame.
//    - Each trail is a row of points. Point 0 follows the tail light
//      every frame; 60 times a second the row shifts back one slot
//      (a fast native copy) and point 0 starts fresh. So the trail
//      length is the same at 60 Hz or 165 Hz.
//    - The ribbon is turned to face the camera in the vertex shader,
//      so it reads as a line of light from any angle.
//    - Each point stores the moment it was laid; the shader fades it
//      by age, so fading costs the CPU nothing.
//    - The newest tenth of a second is extra bright: at speed that
//      stretches into a tail-light streak.
// ============================================================

import * as THREE from 'three'
import { GLOW } from '../../core/palette'

/** Points per trail allocated (the quality preset uses up to this many). */
export const TRAIL_MAX_POINTS = 90
/** Points laid per second (the trail covers points / rate seconds). */
export const TRAIL_RATE = 60

const vertexShader = /* glsl */ `
attribute vec3 aDir;
attribute float aSide;
attribute float aBirth;
attribute float aStrength;
attribute vec3 aColor;
uniform float uTime;
uniform float uLife;
uniform float uWidth;
varying vec3 vColor;
varying float vAlpha;
varying float vAcross;

void main() {
  float age = uTime - aBirth;
  float t = clamp(age / uLife, 0.0, 1.0);
  float fade = (1.0 - t) * (1.0 - t);
  // Young light is hotter: the tail-light streak.
  float hot = 1.0 + 1.6 * exp(-age * 14.0);
  vec3 p = position;
  vec3 toCam = normalize(cameraPosition - p);
  vec3 side = cross(aDir, toCam);
  float sl = length(side);
  side = sl > 1e-4 ? side / sl : vec3(0.0, 1.0, 0.0);
  float width = uWidth * (1.0 - 0.55 * t);
  p += side * aSide * width;
  vColor = aColor;
  vAlpha = aStrength * fade * hot * step(age, uLife) * step(0.0, age + 0.001);
  vAcross = aSide;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`

const fragmentShader = /* glsl */ `
uniform float uIntensity;
varying vec3 vColor;
varying float vAlpha;
varying float vAcross;

void main() {
  // Bright core, soft edges: a tube of light, not a flat stripe.
  float x = abs(vAcross);
  float profile = (1.0 - x * x) * (1.0 - x * x);
  float a = vAlpha * profile;
  if (a < 0.002) discard;
  gl_FragColor = vec4(vColor * uIntensity * a, 1.0);
}
`

interface TrailSlot {
  /** Who uses this slot (car id + light index), or '' when free. */
  owner: string
  /** Points in use (quality decides). */
  points: number
  /** Seconds since the last point was laid. */
  accum: number
  live: boolean
  lastX: number
  lastY: number
  lastZ: number
  colorHex: string
}

export class LightTrails {
  readonly mesh: THREE.Mesh
  readonly slots: TrailSlot[] = []

  private readonly maxTrails: number
  private readonly pos: Float32Array
  private readonly dir: Float32Array
  private readonly birth: Float32Array
  private readonly strength: Float32Array
  private readonly color: Float32Array
  private readonly posAttr: THREE.BufferAttribute
  private readonly dirAttr: THREE.BufferAttribute
  private readonly birthAttr: THREE.BufferAttribute
  private readonly strengthAttr: THREE.BufferAttribute
  private readonly colorAttr: THREE.BufferAttribute
  private readonly uniforms: { uTime: { value: number }; uLife: { value: number } }
  private time = 0
  private readonly tmpColor = new THREE.Color()
  private pointsPerTrail = TRAIL_MAX_POINTS
  private colorDirty = false

  constructor(maxTrails: number) {
    this.maxTrails = maxTrails
    const N = TRAIL_MAX_POINTS
    const verts = maxTrails * N * 2
    this.pos = new Float32Array(verts * 3)
    this.dir = new Float32Array(verts * 3)
    this.birth = new Float32Array(verts).fill(-1e6)
    this.strength = new Float32Array(verts)
    this.color = new Float32Array(verts * 3)
    const side = new Float32Array(verts)
    for (let v = 0; v < verts; v++) side[v] = v % 2 === 0 ? -1 : 1
    for (let v = 0; v < verts; v++) this.dir[v * 3 + 2] = 1

    const index = new Uint32Array(maxTrails * (N - 1) * 6)
    let w = 0
    for (let t = 0; t < maxTrails; t++) {
      for (let p = 0; p < N - 1; p++) {
        const a = (t * N + p) * 2
        const b = a + 2
        index[w++] = a
        index[w++] = a + 1
        index[w++] = b
        index[w++] = a + 1
        index[w++] = b + 1
        index[w++] = b
      }
    }

    const g = new THREE.BufferGeometry()
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage)
    this.dirAttr = new THREE.BufferAttribute(this.dir, 3).setUsage(THREE.DynamicDrawUsage)
    this.birthAttr = new THREE.BufferAttribute(this.birth, 1).setUsage(THREE.DynamicDrawUsage)
    this.strengthAttr = new THREE.BufferAttribute(this.strength, 1).setUsage(THREE.DynamicDrawUsage)
    this.colorAttr = new THREE.BufferAttribute(this.color, 3).setUsage(THREE.DynamicDrawUsage)
    g.setAttribute('position', this.posAttr)
    g.setAttribute('aDir', this.dirAttr)
    g.setAttribute('aSide', new THREE.BufferAttribute(side, 1))
    g.setAttribute('aBirth', this.birthAttr)
    g.setAttribute('aStrength', this.strengthAttr)
    g.setAttribute('aColor', this.colorAttr)
    g.setIndex(new THREE.BufferAttribute(index, 1))
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6)

    this.uniforms = { uTime: { value: 0 }, uLife: { value: N / TRAIL_RATE } }
    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        ...this.uniforms,
        uWidth: { value: 0.075 },
        uIntensity: { value: GLOW.T2 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      // The ribbon is turned to face the camera in the shader, so which way its
      // triangles wind depends on the view: draw both sides.
      side: THREE.DoubleSide,
      fog: false,
    })
    this.mesh = new THREE.Mesh(g, material)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 5
    this.mesh.name = 'light-trails'

    for (let t = 0; t < maxTrails; t++) {
      this.slots.push({ owner: '', points: N, accum: 0, live: false, lastX: 0, lastY: 0, lastZ: 0, colorHex: '' })
    }
  }

  /** Quality: how many points of history each trail keeps (its length). */
  setLength(points: number): void {
    this.pointsPerTrail = Math.max(8, Math.min(TRAIL_MAX_POINTS, Math.round(points)))
    this.uniforms.uLife.value = this.pointsPerTrail / TRAIL_RATE
  }

  get length(): number {
    return this.pointsPerTrail
  }

  /** Find (or claim) the slot for an owner key. Returns -1 when every slot is taken. */
  slotFor(owner: string): number {
    let free = -1
    for (let i = 0; i < this.maxTrails; i++) {
      if (this.slots[i].owner === owner) return i
      if (free < 0 && this.slots[i].owner === '') free = i
    }
    if (free >= 0) {
      const s = this.slots[free]
      s.owner = owner
      s.live = false
      s.accum = 0
      s.colorHex = ''
    }
    return free
  }

  /** Release a slot: its light fades out naturally (birth times are kept). */
  release(index: number): void {
    const s = this.slots[index]
    s.owner = ''
    s.live = false
  }

  /** Hide a trail instantly (teleports, resets). */
  clear(index: number): void {
    const N = TRAIL_MAX_POINTS
    this.birth.fill(-1e6, index * N * 2, (index + 1) * N * 2)
    this.slots[index].live = false
  }

  /**
   * Feed one trail its tail light's current world position this frame.
   * strength 0..1 (0 = no new light, the old light still fades out).
   */
  feed(index: number, x: number, y: number, z: number, strength: number, colorHex: string, dt: number): void {
    const s = this.slots[index]
    const N = TRAIL_MAX_POINTS
    const base = index * N * 2 // first vertex of this trail

    if (s.colorHex !== colorHex) {
      s.colorHex = colorHex
      this.tmpColor.set(colorHex)
      for (let v = 0; v < N * 2; v++) {
        const k = (base + v) * 3
        this.color[k] = this.tmpColor.r
        this.color[k + 1] = this.tmpColor.g
        this.color[k + 2] = this.tmpColor.b
      }
      this.colorDirty = true
    }

    // A jump of more than a few metres in one frame is a teleport: start a new trail.
    if (s.live) {
      const jx = x - s.lastX
      const jy = y - s.lastY
      const jz = z - s.lastZ
      if (jx * jx + jy * jy + jz * jz > 64) this.clear(index)
    }
    if (!s.live) {
      // Seed the whole history at the current point, already dead, so the
      // first segments never stretch back to an old position.
      for (let p = 0; p < N; p++) this.writePoint(base + p * 2, x, y, z, -1e6, 0)
      s.live = true
      s.accum = 0
    }
    s.lastX = x
    s.lastY = y
    s.lastZ = z

    s.accum += dt
    if (s.accum >= 1 / TRAIL_RATE) {
      s.accum = Math.min(s.accum - 1 / TRAIL_RATE, 1 / TRAIL_RATE)
      this.shift(base, this.pointsPerTrail)
    }
    // Point 0 is the live head: it sits on the tail light every frame.
    this.writePoint(base, x, y, z, this.time, strength)
    this.updateDir(base, 0)
    this.updateDir(base, 1)
  }

  private writePoint(v: number, x: number, y: number, z: number, birth: number, strength: number): void {
    for (let k = 0; k < 2; k++) {
      const i = v + k
      this.pos[i * 3] = x
      this.pos[i * 3 + 1] = y
      this.pos[i * 3 + 2] = z
      this.birth[i] = birth
      this.strength[i] = strength
    }
  }

  /** Move points 0..n-2 back one slot (the oldest falls off the end). */
  private shift(base: number, n: number): void {
    const from = base
    const to = base + 2
    const count = (n - 1) * 2
    this.pos.copyWithin(to * 3, from * 3, (from + count) * 3)
    this.dir.copyWithin(to * 3, from * 3, (from + count) * 3)
    this.birth.copyWithin(to, from, from + count)
    this.strength.copyWithin(to, from, from + count)
    // Points beyond the quality length stay dead.
    const N = TRAIL_MAX_POINTS
    if (n < N) this.birth.fill(-1e6, base + n * 2, base + N * 2)
  }

  /** Direction at point p (toward the older neighbour), for facing the camera. */
  private updateDir(base: number, p: number): void {
    const a = base + p * 2
    const b = a + 2
    let dx = this.pos[a * 3] - this.pos[b * 3]
    let dy = this.pos[a * 3 + 1] - this.pos[b * 3 + 1]
    let dz = this.pos[a * 3 + 2] - this.pos[b * 3 + 2]
    const l = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (l < 1e-4) return // keep the previous direction while standing still
    dx /= l
    dy /= l
    dz /= l
    for (let k = 0; k < 2; k++) {
      const i = (a + k) * 3
      this.dir[i] = dx
      this.dir[i + 1] = dy
      this.dir[i + 2] = dz
    }
  }

  /** Advance time and push this frame's changes to the GPU. */
  update(dt: number): void {
    this.time += dt
    this.uniforms.uTime.value = this.time
    this.posAttr.needsUpdate = true
    this.dirAttr.needsUpdate = true
    this.birthAttr.needsUpdate = true
    this.strengthAttr.needsUpdate = true
    if (this.colorDirty) {
      this.colorAttr.needsUpdate = true
      this.colorDirty = false
    }
  }

  /** Trails with light still showing (inspector). */
  activeCount(): number {
    let n = 0
    for (let i = 0; i < this.maxTrails; i++) if (this.slots[i].owner !== '') n++
    return n
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
  }
}
