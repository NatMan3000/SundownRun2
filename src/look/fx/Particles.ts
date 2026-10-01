// ============================================================
//  PARTICLES - glowing shards, hot sparks and pulse rings
// ------------------------------------------------------------
//  The fx API (core/api.ts) other systems call:
//    fx.shards(...)  crash props, smashables and energy cubes burst
//                    into glowing shards that fly, bounce and fade
//    fx.sparks(...)  hot streaks off a scrape or a hit
//    fx.pulse(...)   an expanding ring of light (pickups, boost kick,
//                    the finish line)
//
//  Each kind is ONE instanced mesh (one draw call) with a fixed pool
//  allocated up front. A new burst overwrites the oldest pieces, so
//  a big pile-up can never allocate or blow the frame budget; the
//  quality preset sets the caps. Everything flashes at glow tier T3
//  for well under half a second, then settles to T2 and fades out.
// ============================================================

import * as THREE from 'three'
import { GLOW } from '../../core/palette'

/** Deterministic noise so the scripted demo drive renders the same frames every run. */
let seed = 0x2f6b9a1d
function rand(): number {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 4294967296
}

/** Glow over a piece's life: a T3 flash, settle to T2, then fade out. */
function glowCurve(age: number, life: number): number {
  const flash = age < 0.12 ? GLOW.T3 : age < 0.4 ? GLOW.T3 + (GLOW.T2 - GLOW.T3) * ((age - 0.12) / 0.28) : GLOW.T2
  const fadeStart = life * 0.55
  const fade = age < fadeStart ? 1 : Math.max(0, 1 - (age - fadeStart) / (life - fadeStart))
  return flash * fade * fade
}

// ---------------------------------------------------------------- shards

const shardVertex = /* glsl */ `
attribute float aGlow;
varying float vGlow;
varying vec3 vColor;
varying vec3 vNormal;
void main() {
  vGlow = aGlow;
  vColor = instanceColor;
  mat4 mv = modelViewMatrix * instanceMatrix;
  vNormal = normalize(mat3(mv) * normal);
  gl_Position = projectionMatrix * mv * vec4(position, 1.0);
}
`

const shardFragment = /* glsl */ `
varying float vGlow;
varying vec3 vColor;
varying vec3 vNormal;
void main() {
  // Facets catch the light differently, so a shard reads as a solid crystal.
  float facet = 0.55 + 0.45 * abs(vNormal.z);
  gl_FragColor = vec4(vColor * vGlow * facet, 1.0);
}
`

export class ShardPool {
  readonly mesh: THREE.InstancedMesh
  cap: number
  alive = 0
  private readonly max: number
  private cursor = 0
  private readonly pos: Float32Array
  private readonly vel: Float32Array
  private readonly axis: Float32Array
  private readonly spin: Float32Array
  private readonly angle: Float32Array
  private readonly size: Float32Array
  private readonly age: Float32Array
  private readonly life: Float32Array
  private readonly ground: Float32Array
  private readonly glow: Float32Array
  private readonly glowAttr: THREE.InstancedBufferAttribute
  private readonly m = new THREE.Matrix4()
  private readonly q = new THREE.Quaternion()
  private readonly v = new THREE.Vector3()
  private readonly s = new THREE.Vector3()
  private readonly ax = new THREE.Vector3()
  private readonly c = new THREE.Color()

  constructor(max: number) {
    this.max = max
    this.cap = max
    // A long, sharp crystal: an octahedron stretched along y.
    const geo = new THREE.OctahedronGeometry(0.5, 0)
    geo.scale(0.55, 1.25, 0.4)
    this.glow = new Float32Array(max)
    this.glowAttr = new THREE.InstancedBufferAttribute(this.glow, 1).setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('aGlow', this.glowAttr)
    const mat = new THREE.ShaderMaterial({ vertexShader: shardVertex, fragmentShader: shardFragment, fog: false })
    this.mesh = new THREE.InstancedMesh(geo, mat, max)
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.mesh.setColorAt(0, this.c.set(1, 1, 1))
    this.mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage)
    this.mesh.frustumCulled = false
    this.mesh.count = 0
    this.mesh.name = 'fx-shards'
    this.pos = new Float32Array(max * 3)
    this.vel = new Float32Array(max * 3)
    this.axis = new Float32Array(max * 3)
    this.spin = new Float32Array(max)
    this.angle = new Float32Array(max)
    this.size = new Float32Array(max)
    this.age = new Float32Array(max)
    this.life = new Float32Array(max).fill(-1)
    this.ground = new Float32Array(max)
  }

  emit(
    x: number, y: number, z: number,
    bvx: number, bvy: number, bvz: number,
    color: string, count: number, speed: number, size: number, life: number, groundY: number,
  ): void {
    const n = Math.min(count, this.cap)
    this.c.set(color)
    for (let k = 0; k < n; k++) {
      const i = this.cursor
      this.cursor = (this.cursor + 1) % this.cap
      // a random direction, biased upward so bursts fountain rather than splat
      const u = rand() * 2 - 1
      const th = rand() * Math.PI * 2
      const r = Math.sqrt(1 - u * u)
      const sp = speed * (0.45 + 0.75 * rand())
      this.pos[i * 3] = x + (rand() - 0.5) * 0.4
      this.pos[i * 3 + 1] = y + rand() * 0.3
      this.pos[i * 3 + 2] = z + (rand() - 0.5) * 0.4
      this.vel[i * 3] = r * Math.cos(th) * sp + bvx * 0.6
      this.vel[i * 3 + 1] = Math.abs(u) * sp * 0.9 + speed * 0.35 + bvy * 0.3
      this.vel[i * 3 + 2] = r * Math.sin(th) * sp + bvz * 0.6
      this.ax.set(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize()
      this.axis[i * 3] = this.ax.x
      this.axis[i * 3 + 1] = this.ax.y
      this.axis[i * 3 + 2] = this.ax.z
      this.spin[i] = (4 + rand() * 10) * (rand() < 0.5 ? -1 : 1)
      this.angle[i] = rand() * 6.28
      this.size[i] = size * (0.6 + rand() * 0.8)
      this.age[i] = 0
      this.life[i] = life * (0.75 + rand() * 0.5)
      this.ground[i] = groundY
      this.mesh.setColorAt(i, this.c)
    }
    this.mesh.instanceColor!.needsUpdate = true
  }

  /** Quality: most pieces alive at once (never above the pool size). */
  setCap(n: number): void {
    this.cap = Math.max(1, Math.min(this.max, Math.round(n)))
    if (this.cursor >= this.cap) this.cursor = 0
  }

  update(dt: number): void {
    let alive = 0
    let highest = 0
    const drag = Math.exp(-0.6 * dt)
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] < 0) continue
      this.age[i] += dt
      if (this.age[i] >= this.life[i] || i >= this.cap) {
        this.life[i] = -1
        this.glow[i] = 0
        this.m.makeScale(0, 0, 0)
        this.mesh.setMatrixAt(i, this.m)
        continue
      }
      alive++
      highest = i + 1
      const j = i * 3
      this.vel[j] *= drag
      this.vel[j + 1] = this.vel[j + 1] * drag - 9.8 * dt
      this.vel[j + 2] *= drag
      this.pos[j] += this.vel[j] * dt
      this.pos[j + 1] += this.vel[j + 1] * dt
      this.pos[j + 2] += this.vel[j + 2] * dt
      // bounce off the ground, losing most of the energy
      const floor = this.ground[i] + this.size[i] * 0.3
      if (this.pos[j + 1] < floor) {
        this.pos[j + 1] = floor
        if (this.vel[j + 1] < 0) {
          this.vel[j + 1] = -this.vel[j + 1] * 0.32
          this.vel[j] *= 0.55
          this.vel[j + 2] *= 0.55
          this.spin[i] *= 0.5
        }
      }
      this.angle[i] += this.spin[i] * dt
      this.ax.set(this.axis[j], this.axis[j + 1], this.axis[j + 2])
      this.q.setFromAxisAngle(this.ax, this.angle[i])
      const sc = this.size[i]
      this.m.compose(this.v.set(this.pos[j], this.pos[j + 1], this.pos[j + 2]), this.q, this.s.set(sc, sc, sc))
      this.mesh.setMatrixAt(i, this.m)
      this.glow[i] = glowCurve(this.age[i], this.life[i])
    }
    this.alive = alive
    this.mesh.count = highest
    this.mesh.instanceMatrix.needsUpdate = true
    this.glowAttr.needsUpdate = true
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
    this.mesh.dispose()
  }
}

// ---------------------------------------------------------------- sparks

const sparkVertex = /* glsl */ `
attribute vec3 aHead;
attribute vec3 aTail;
attribute float aHeat;
varying float vHeat;
varying float vAcross;
uniform float uWidth;
void main() {
  // position.x: 0 = head, 1 = tail; position.y: -1 / +1 = the two sides
  vec3 p = mix(aHead, aTail, position.x);
  vec3 dir = aHead - aTail;
  vec3 toCam = normalize(cameraPosition - p);
  vec3 side = cross(dir, toCam);
  float sl = length(side);
  side = sl > 1e-5 ? side / sl : vec3(0.0, 1.0, 0.0);
  p += side * position.y * uWidth * (1.0 - 0.6 * position.x);
  vHeat = aHeat * (1.0 - 0.7 * position.x);
  vAcross = position.y;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`

const sparkFragment = /* glsl */ `
uniform vec3 uHot;
uniform vec3 uWarm;
varying float vHeat;
varying float vAcross;
void main() {
  float a = (1.0 - vAcross * vAcross) * vHeat;
  if (a < 0.003) discard;
  // white-hot when fresh, cooling to amber
  vec3 col = mix(uWarm, uHot, clamp(vHeat / ${GLOW.T3.toFixed(1)}, 0.0, 1.0));
  gl_FragColor = vec4(col * a, 1.0);
}
`

export class SparkPool {
  readonly mesh: THREE.Mesh
  cap: number
  alive = 0
  private readonly max: number
  private cursor = 0
  private readonly pos: Float32Array
  private readonly vel: Float32Array
  private readonly age: Float32Array
  private readonly life: Float32Array
  private readonly ground: Float32Array
  private readonly head: Float32Array
  private readonly tail: Float32Array
  private readonly heat: Float32Array
  private readonly headAttr: THREE.InstancedBufferAttribute
  private readonly tailAttr: THREE.InstancedBufferAttribute
  private readonly heatAttr: THREE.InstancedBufferAttribute

  constructor(max: number, hot: string, warm: string) {
    this.max = max
    this.cap = max
    const g = new THREE.InstancedBufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, 0, 0, 1, 0, 1, -1, 0, 1, 1, 0], 3))
    g.setIndex([0, 2, 1, 1, 2, 3])
    this.head = new Float32Array(max * 3)
    this.tail = new Float32Array(max * 3)
    this.heat = new Float32Array(max)
    this.headAttr = new THREE.InstancedBufferAttribute(this.head, 3).setUsage(THREE.DynamicDrawUsage)
    this.tailAttr = new THREE.InstancedBufferAttribute(this.tail, 3).setUsage(THREE.DynamicDrawUsage)
    this.heatAttr = new THREE.InstancedBufferAttribute(this.heat, 1).setUsage(THREE.DynamicDrawUsage)
    g.setAttribute('aHead', this.headAttr)
    g.setAttribute('aTail', this.tailAttr)
    g.setAttribute('aHeat', this.heatAttr)
    g.instanceCount = 0
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6)
    const mat = new THREE.ShaderMaterial({
      vertexShader: sparkVertex,
      fragmentShader: sparkFragment,
      uniforms: {
        uWidth: { value: 0.035 },
        uHot: { value: new THREE.Color(hot) },
        uWarm: { value: new THREE.Color(warm) },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide, // camera-facing streaks: winding depends on the view
      fog: false,
    })
    this.mesh = new THREE.Mesh(g, mat)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 6
    this.mesh.name = 'fx-sparks'
    this.pos = new Float32Array(max * 3)
    this.vel = new Float32Array(max * 3)
    this.age = new Float32Array(max)
    this.life = new Float32Array(max).fill(-1)
    this.ground = new Float32Array(max)
  }

  emit(x: number, y: number, z: number, nx: number, ny: number, nz: number, intensity: number, groundY: number): void {
    const k = Math.max(0, Math.min(1, intensity))
    const n = Math.min(this.cap, Math.round(6 + 34 * k))
    for (let c = 0; c < n; c++) {
      const i = this.cursor
      this.cursor = (this.cursor + 1) % this.cap
      const sp = (3 + 8 * k) * (0.4 + 0.8 * rand())
      const j = i * 3
      this.pos[j] = x
      this.pos[j + 1] = y
      this.pos[j + 2] = z
      // spray along the normal, widely scattered
      this.vel[j] = (nx + (rand() - 0.5) * 1.6) * sp
      this.vel[j + 1] = (Math.abs(ny) * 0.5 + 0.2 + rand() * 0.5) * sp * 0.5
      this.vel[j + 2] = (nz + (rand() - 0.5) * 1.6) * sp
      this.age[i] = 0
      this.life[i] = 0.25 + rand() * 0.45
      this.ground[i] = groundY
    }
  }

  /** Quality: most pieces alive at once (never above the pool size). */
  setCap(n: number): void {
    this.cap = Math.max(1, Math.min(this.max, Math.round(n)))
    if (this.cursor >= this.cap) this.cursor = 0
  }

  update(dt: number): void {
    let alive = 0
    let highest = 0
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] < 0) continue
      this.age[i] += dt
      if (this.age[i] >= this.life[i] || i >= this.cap) {
        this.life[i] = -1
        this.heat[i] = 0
        continue
      }
      alive++
      highest = i + 1
      const j = i * 3
      this.vel[j + 1] -= 9.8 * dt
      this.pos[j] += this.vel[j] * dt
      this.pos[j + 1] += this.vel[j + 1] * dt
      this.pos[j + 2] += this.vel[j + 2] * dt
      if (this.pos[j + 1] < this.ground[i] + 0.02 && this.vel[j + 1] < 0) {
        this.pos[j + 1] = this.ground[i] + 0.02
        this.vel[j + 1] *= -0.3
        this.vel[j] *= 0.7
        this.vel[j + 2] *= 0.7
      }
      // the streak: from where it is back along its velocity (motion blur)
      const streak = 0.028
      this.head[j] = this.pos[j]
      this.head[j + 1] = this.pos[j + 1]
      this.head[j + 2] = this.pos[j + 2]
      this.tail[j] = this.pos[j] - this.vel[j] * streak
      this.tail[j + 1] = this.pos[j + 1] - this.vel[j + 1] * streak
      this.tail[j + 2] = this.pos[j + 2] - this.vel[j + 2] * streak
      const t = this.age[i] / this.life[i]
      this.heat[i] = GLOW.T3 * (1 - t) * (1 - t)
    }
    this.alive = alive
    ;(this.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount = highest
    this.headAttr.needsUpdate = true
    this.tailAttr.needsUpdate = true
    this.heatAttr.needsUpdate = true
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
  }
}

// ---------------------------------------------------------------- pulses

const pulseVertex = /* glsl */ `
attribute float aGlow;
varying float vGlow;
varying vec3 vColor;
varying vec2 vLocal;
void main() {
  vGlow = aGlow;
  vColor = instanceColor;
  vLocal = position.xz;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`

const pulseFragment = /* glsl */ `
varying float vGlow;
varying vec3 vColor;
varying vec2 vLocal;
void main() {
  // a bright thin rim with a faint wash inside
  float r = length(vLocal);
  float rim = smoothstep(0.88, 0.975, r) * (1.0 - smoothstep(0.975, 1.0, r));
  float wash = smoothstep(0.3, 0.95, r) * (1.0 - smoothstep(0.95, 1.0, r)) * 0.06;
  float a = (rim + wash) * vGlow;
  if (a < 0.003) discard;
  gl_FragColor = vec4(vColor * a, 1.0);
}
`

export class PulsePool {
  readonly mesh: THREE.InstancedMesh
  cap: number
  alive = 0
  private readonly max: number
  private cursor = 0
  private readonly pos: Float32Array
  private readonly radius: Float32Array
  private readonly age: Float32Array
  private readonly glow: Float32Array
  private readonly glowAttr: THREE.InstancedBufferAttribute
  private readonly m = new THREE.Matrix4()
  private readonly c = new THREE.Color()
  static readonly LIFE = 0.55

  constructor(max: number) {
    this.max = max
    this.cap = max
    const geo = new THREE.CircleGeometry(1, 64)
    geo.rotateX(-Math.PI / 2) // flat on the ground, facing up
    this.glow = new Float32Array(max)
    this.glowAttr = new THREE.InstancedBufferAttribute(this.glow, 1).setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('aGlow', this.glowAttr)
    const mat = new THREE.ShaderMaterial({
      vertexShader: pulseVertex,
      fragmentShader: pulseFragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
    })
    this.mesh = new THREE.InstancedMesh(geo, mat, max)
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.mesh.setColorAt(0, this.c.set(1, 1, 1))
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 6
    this.mesh.count = 0
    this.mesh.name = 'fx-pulses'
    this.pos = new Float32Array(max * 3)
    this.radius = new Float32Array(max)
    this.age = new Float32Array(max).fill(1e3)
  }

  emit(x: number, y: number, z: number, color: string, radius: number): void {
    const i = this.cursor
    this.cursor = (this.cursor + 1) % this.cap
    this.pos[i * 3] = x
    this.pos[i * 3 + 1] = y
    this.pos[i * 3 + 2] = z
    this.radius[i] = radius
    this.age[i] = 0
    this.mesh.setColorAt(i, this.c.set(color))
    this.mesh.instanceColor!.needsUpdate = true
  }

  /** Quality: most pieces alive at once (never above the pool size). */
  setCap(n: number): void {
    this.cap = Math.max(1, Math.min(this.max, Math.round(n)))
    if (this.cursor >= this.cap) this.cursor = 0
  }

  update(dt: number): void {
    let alive = 0
    let highest = 0
    for (let i = 0; i < this.max; i++) {
      this.age[i] += dt
      const t = this.age[i] / PulsePool.LIFE
      if (t >= 1 || i >= this.cap) {
        this.glow[i] = 0
        this.m.makeScale(0, 0, 0)
        this.mesh.setMatrixAt(i, this.m)
        continue
      }
      alive++
      highest = i + 1
      // ease-out expansion, fading as it grows
      const e = 1 - (1 - t) * (1 - t) * (1 - t)
      const r = Math.max(0.05, this.radius[i] * (0.15 + 0.85 * e))
      this.m.makeScale(r, 1, r)
      this.m.setPosition(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2])
      this.mesh.setMatrixAt(i, this.m)
      this.glow[i] = (t < 0.35 ? GLOW.T3 : GLOW.T3 * (1 - (t - 0.35) / 0.65)) * (1 - t * 0.3)
    }
    this.alive = alive
    this.mesh.count = highest
    this.mesh.instanceMatrix.needsUpdate = true
    this.glowAttr.needsUpdate = true
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
    this.mesh.dispose()
  }
}
