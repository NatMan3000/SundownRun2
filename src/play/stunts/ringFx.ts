// ============================================================
//  RING FX - what a stunt ring looks like as it explodes, counts
//  down and comes back
// ------------------------------------------------------------
//  Nathan: "right now you can't really tell, because it's already
//  behind you once you've jumped through it ... it would explode
//  when you go through it, so that you can see the big effect as
//  you're driving through it, and then it's disappeared, and in its
//  place is a countdown timer before it regenerates back again."
//
//  A ring is behind you a moment after you pass it, so the
//  explosion TRAVELS WITH YOU: everything in it starts at the ring
//  with your car's speed and falls the way your car falls, so it
//  stays around the car in the chase and bonnet cameras.
//
//    pieces      the ring breaks into 18 glowing arcs that tumble
//                outward around the car, some running ahead of it
//                (white-hot T3 for a moment, then violet T2, fading)
//    shockwaves  two rings of light growing in the ring's plane:
//                one around you, one flung ahead along your path
//    shards      sprays of violet and white crystals (the shared
//                fx.shards pool, core/api.ts), the bigger one
//                flung ahead of you, where the bonnet camera looks
//    points      "+150" pops up in front of the camera, where you
//                can read it whichever camera you use
//
//  Then the ring is gone. In its place hangs a thin dashed ghost of
//  it (a dial that lights up as the time runs down) and the seconds
//  left in big numbers that always face the camera, readable from
//  the run-in. In the last moment the pieces fly back in from all
//  around, the ring snaps whole with a white-hot flash, and it
//  scores again.
//
//  The clock itself lives in ringComeback.ts; this file only draws.
//  Every part is one instanced mesh with a fixed pool made once
//  (no allocation per frame), and dispose() frees it all.
// ============================================================

import * as THREE from 'three'
import { fx } from '../../core/api'
import { FONTS, GLOW, PALETTE } from '../../core/palette'
import type { ParkRing } from './parkLayout'
import { BURST_FLOATS, comebackSeconds, rings } from './ringComeback'

/** Arcs one ring breaks into. */
const PIECES_PER_RING = 18
/** Most arcs flying at once (a 3-ring chain exploding while a 4th comes back). */
const PIECE_CAP = PIECES_PER_RING * 4
/** Most shockwaves at once (two per explosion). */
const WAVE_CAP = 8
/** Part of the blast is flung this many seconds ahead along the car's path (about 10 m at 120 km/h). */
const FLING_S = 0.3
/** Gravity on everything that flies with the car (m/s^2): the same as the car's, so it keeps up. */
const GRAVITY = 9.81
/** Seconds after an explosion before the ghost and the countdown fade in (the pieces have the stage). */
const GHOST_DELAY = 0.45
/** Seconds the ghost and the numbers take to fade in. */
const GHOST_FADE = 0.4
/** The pieces fly back in over the countdown's last this-many seconds. */
const CONVERGE_S = 0.7
/** The white-hot flash as a ring comes back, seconds (T3 stays under half a second). */
const FORM_FLASH_S = 0.4
/** The ghost's tube, as a share of the ring's. */
const GHOST_THICK = 0.3
/** The "+150" in front of the camera: seconds it shows. */
const POP_S = 1.3
/** ...its height in metres, 10 m in front of the camera (about a twelfth of the screen). */
const POP_HEIGHT = 0.95
const POP_DIST = 10
/** Countdown digits: their height as a share of the ring's radius (two fit inside it). */
const DIGIT_SCALE = 0.95
/** Up to 3 digits a ring (the knob may be over 99 s). */
const DIGITS_PER_RING = 3
/** "+1200" is the longest popup (an 8-ring chain's last ring). */
const POP_GLYPHS = 5
/** The countdown turns white-hot for its last few seconds. */
const HOT_SECONDS = 5

// ---------------------------------------------------------------- the digit atlas

/** Glyph cells in the atlas: 0-9, then '+'. */
const PLUS = 10
const ATLAS_COLS = 6
const ATLAS_ROWS = 2
const CELL_W = 170
const CELL_H = 256
/** A glyph's width / height. */
const GLYPH_ASPECT = CELL_W / CELL_H
/** Glyphs sit this many glyph-widths apart (the cells have room either side of each digit). */
const GLYPH_STEP = 0.74

/**
 * The digits drawn once into a small canvas (system font, no web fonts). It is a MASK, not a
 * picture: the red channel is the digit, the green channel its thick outline, so the shader can
 * light the digit in any colour and keep a dark edge that reads over the bright sky.
 */
function makeAtlas(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = CELL_W * ATLAS_COLS
  canvas.height = CELL_H * ATLAS_ROWS
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = 'rgb(0, 0, 0)' // mask: nothing
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.font = `800 ${Math.round(CELL_H * 0.8)}px ${FONTS.display}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  const chars = '0123456789+'
  for (let i = 0; i < chars.length; i++) {
    const cx = (i % ATLAS_COLS) * CELL_W + CELL_W / 2
    const cy = Math.floor(i / ATLAS_COLS) * CELL_H + CELL_H / 2 + CELL_H * 0.04
    ctx.lineWidth = CELL_H * 0.09
    ctx.strokeStyle = 'rgb(0, 255, 0)' // mask: the outline
    ctx.strokeText(chars[i], cx, cy)
    ctx.fillStyle = 'rgb(255, 0, 0)' // mask: the digit
    ctx.fillText(chars[i], cx, cy)
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.anisotropy = 4
  return tex
}

// Shared by the countdowns (in the world, facing the camera) and the popup (in front of the camera).
const glyphVertex = /* glsl */ `
attribute vec3 iAnchor;
attribute vec4 iGlyph; // x: offset in glyph widths, y: atlas cell, z: height (m), w: opacity
attribute vec4 iTint;  // rgb: colour, w: glow
uniform vec2 uCells;
uniform float uAspect;
varying vec2 vUv;
varying float vAlpha;
varying vec4 vTint;
void main() {
  float h = iGlyph.z;
#ifndef VIEW_SPACE
  // Far away the numbers grow a little (up to 1.5x from 70 m), so they read from the whole run-in.
  float far = -(viewMatrix * vec4(iAnchor, 1.0)).z;
  h *= clamp(far / 70.0, 1.0, 1.5);
#endif
  float w = h * uAspect;
  float cell = iGlyph.y;
  float col = mod(cell, uCells.x);
  float row = floor(cell / uCells.x);
  vUv = vec2((col + uv.x) / uCells.x, 1.0 - (row + 1.0 - uv.y) / uCells.y);
  vTint = iTint;
#ifdef VIEW_SPACE
  // Anchored in front of the camera: iAnchor is already in view space.
  vec4 mv = vec4(iAnchor + vec3((iGlyph.x + position.x) * w, position.y * h, 0.0), 1.0);
  vAlpha = iGlyph.w;
#else
  // A billboard: always faces the camera.
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 p = iAnchor + right * ((iGlyph.x + position.x) * w) + up * (position.y * h);
  vec4 mv = viewMatrix * vec4(p, 1.0);
  float d = -mv.z;
  // Gone when the camera flies right through it, and fading into the far haze.
  vAlpha = iGlyph.w * smoothstep(3.0, 9.0, d) * (1.0 - smoothstep(260.0, 340.0, d));
#endif
  gl_Position = projectionMatrix * mv;
}
`
const glyphFragment = /* glsl */ `
uniform sampler2D uAtlas;
uniform vec3 uInk;
varying vec2 vUv;
varying float vAlpha;
varying vec4 vTint;
void main() {
  vec4 m = texture2D(uAtlas, vUv);
  float fill = m.r;
  float edge = m.g;
  float a = clamp(fill + edge, 0.0, 1.0) * vAlpha;
  if (a < 0.01) discard;
  // The digit in light, its outline in the UI's dark ink.
  vec3 col = mix(uInk, vTint.rgb * vTint.w, clamp(fill / max(fill + edge, 1e-3), 0.0, 1.0));
  gl_FragColor = vec4(col, a);
}
`

function makeGlyphMaterial(atlas: THREE.Texture, viewSpace: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: glyphVertex,
    fragmentShader: glyphFragment,
    defines: viewSpace ? { VIEW_SPACE: '' } : {},
    uniforms: {
      uAtlas: { value: atlas },
      uInk: { value: new THREE.Color(PALETTE.uiPanelSolid) },
      uCells: { value: new THREE.Vector2(ATLAS_COLS, ATLAS_ROWS) },
      uAspect: { value: GLYPH_ASPECT },
    },
    transparent: true,
    depthWrite: false,
    // The countdowns hide behind ramps; the popup is never hidden by your own car.
    depthTest: !viewSpace,
    fog: false,
  })
}

/** A set of glyph quads: one instanced mesh, its per-instance numbers written straight into its buffers. */
class GlyphSet {
  readonly mesh: THREE.InstancedMesh
  private readonly anchor: Float32Array
  private readonly glyph: Float32Array
  private readonly tint: Float32Array
  private readonly attrs: THREE.InstancedBufferAttribute[]
  used = 0

  constructor(
    readonly cap: number,
    material: THREE.ShaderMaterial,
    name: string,
  ) {
    const geo = new THREE.PlaneGeometry(1, 1)
    this.anchor = new Float32Array(cap * 3)
    this.glyph = new Float32Array(cap * 4)
    this.tint = new Float32Array(cap * 4)
    this.attrs = [
      new THREE.InstancedBufferAttribute(this.anchor, 3).setUsage(THREE.DynamicDrawUsage),
      new THREE.InstancedBufferAttribute(this.glyph, 4).setUsage(THREE.DynamicDrawUsage),
      new THREE.InstancedBufferAttribute(this.tint, 4).setUsage(THREE.DynamicDrawUsage),
    ]
    geo.setAttribute('iAnchor', this.attrs[0])
    geo.setAttribute('iGlyph', this.attrs[1])
    geo.setAttribute('iTint', this.attrs[2])
    this.mesh = new THREE.InstancedMesh(geo, material, cap)
    this.mesh.frustumCulled = false
    this.mesh.count = 0
    this.mesh.visible = false
    this.mesh.renderOrder = 7
    this.mesh.name = name
  }

  begin(): void {
    this.used = 0
  }

  /** Add one glyph (returns false when the set is full). */
  add(x: number, y: number, z: number, offset: number, cell: number, height: number, alpha: number, c: THREE.Color, glow: number): boolean {
    if (this.used >= this.cap) return false
    const i = this.used++
    this.anchor[i * 3] = x
    this.anchor[i * 3 + 1] = y
    this.anchor[i * 3 + 2] = z
    this.glyph[i * 4] = offset
    this.glyph[i * 4 + 1] = cell
    this.glyph[i * 4 + 2] = height
    this.glyph[i * 4 + 3] = alpha
    this.tint[i * 4] = c.r
    this.tint[i * 4 + 1] = c.g
    this.tint[i * 4 + 2] = c.b
    this.tint[i * 4 + 3] = glow
    return true
  }

  end(): void {
    this.mesh.count = this.used
    this.mesh.visible = this.used > 0
    if (this.used > 0) for (const a of this.attrs) a.needsUpdate = true
  }

  dispose(): void {
    this.mesh.geometry.dispose()
  }
}

// ---------------------------------------------------------------- pieces and shockwaves

const pieceVertex = /* glsl */ `
attribute float aGlow;
varying float vGlow;
varying vec3 vNormal;
void main() {
  vGlow = aGlow;
  mat4 mv = modelViewMatrix * instanceMatrix;
  vNormal = normalize(mat3(mv) * normal);
  gl_Position = projectionMatrix * mv * vec4(position, 1.0);
}
`
const pieceFragment = /* glsl */ `
uniform vec3 uRing;
uniform vec3 uHot;
uniform float uT2;
uniform float uT3;
varying float vGlow;
varying vec3 vNormal;
void main() {
  // White-hot while the glow is above the hero tier, violet as it settles; facets catch the light.
  vec3 col = mix(uRing, uHot, clamp((vGlow - uT2) / (uT3 - uT2), 0.0, 1.0));
  float facet = 0.6 + 0.4 * abs(vNormal.z);
  gl_FragColor = vec4(col * vGlow * facet, 1.0);
}
`
const waveFragment = /* glsl */ `
uniform vec3 uRing;
uniform vec3 uHot;
uniform float uT2;
uniform float uT3;
varying float vGlow;
varying vec3 vNormal;
void main() {
  vec3 col = mix(uRing, uHot, clamp((vGlow - uT2) / (uT3 - uT2), 0.0, 1.0));
  gl_FragColor = vec4(col * vGlow, 1.0);
}
`

function fxUniforms() {
  return {
    uRing: { value: new THREE.Color(PALETTE.core) },
    uHot: { value: new THREE.Color(PALETTE.coreHot) },
    uT2: { value: GLOW.T2 },
    uT3: { value: GLOW.T3 },
  }
}

/** Glow over a flying piece's life: a T3 flash (0.12 s), down to T2 by 0.4 s, fading out over its second half. */
function pieceGlow(age: number, life: number): number {
  const flash = age < 0.12 ? GLOW.T3 : age < 0.4 ? GLOW.T3 + (GLOW.T2 - GLOW.T3) * ((age - 0.12) / 0.28) : GLOW.T2
  const fadeStart = life * 0.5
  const fade = age < fadeStart ? 1 : Math.max(0, 1 - (age - fadeStart) / (life - fadeStart))
  return flash * fade * fade
}

/** Deterministic noise, so a scripted run draws the same frames every time. */
let seed = 0x51a7c0de
function rand(): number {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 4294967296
}

// Module-level temps (no allocation per frame).
const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _q2 = new THREE.Quaternion()
const _p = new THREE.Vector3()
const _s = new THREE.Vector3()
const _a = new THREE.Vector3()
const _u = new THREE.Vector3()
const _v = new THREE.Vector3()
const _z = new THREE.Vector3(0, 0, 1)
const _c = new THREE.Color()
const _cHot = new THREE.Color()

export class RingFx {
  readonly group = new THREE.Group()
  /** The rings themselves (one draw call): the material is stuntMaterial.ts makeRingMaterial. */
  readonly ringMesh: THREE.InstancedMesh

  private readonly list: readonly ParkRing[]
  private readonly n: number
  /** Each ring's turn: the way its hole looks, as a quaternion (x, y, z, w). */
  private readonly ringQ: Float32Array
  /** Per ring, what the picture last showed. */
  private readonly ringState: Float32Array
  private readonly ringAttr: THREE.InstancedBufferAttribute
  private readonly shownWait: Float64Array
  private readonly sinceGone: Float32Array
  private readonly sinceBack: Float32Array
  private readonly converging: Uint8Array

  // The flying arcs.
  private readonly pieces: THREE.InstancedMesh
  private readonly pGlow: Float32Array
  private readonly pGlowAttr: THREE.InstancedBufferAttribute
  private readonly pPos = new Float32Array(PIECE_CAP * 3)
  private readonly pVel = new Float32Array(PIECE_CAP * 3)
  private readonly pQuat = new Float32Array(PIECE_CAP * 4)
  private readonly pAxis = new Float32Array(PIECE_CAP * 3)
  private readonly pSpin = new Float32Array(PIECE_CAP)
  private readonly pSize = new Float32Array(PIECE_CAP)
  private readonly pAge = new Float32Array(PIECE_CAP)
  private readonly pLife = new Float32Array(PIECE_CAP).fill(-1)
  /** 0 = flying out from an explosion, 1 = flying back in to re-form a ring. */
  private readonly pMode = new Uint8Array(PIECE_CAP)
  /** A piece flying back in: where it starts (pVel holds where it ends). */
  private readonly pFrom = new Float32Array(PIECE_CAP * 3)
  private pCursor = 0

  // The shockwaves.
  private readonly waves: THREE.InstancedMesh
  private readonly wGlow: Float32Array
  private readonly wGlowAttr: THREE.InstancedBufferAttribute
  private readonly wPos = new Float32Array(WAVE_CAP * 3)
  private readonly wVel = new Float32Array(WAVE_CAP * 3)
  private readonly wQuat = new Float32Array(WAVE_CAP * 4)
  private readonly wR0 = new Float32Array(WAVE_CAP)
  private readonly wGrow = new Float32Array(WAVE_CAP)
  private readonly wAge = new Float32Array(WAVE_CAP)
  private readonly wLife = new Float32Array(WAVE_CAP).fill(-1)
  private wCursor = 0

  // The numbers.
  private readonly atlas: THREE.CanvasTexture
  private readonly digits: GlyphSet
  private readonly popup: GlyphSet
  private popAge = -1
  private popPoints = 0
  private readonly popCells = new Int8Array(POP_GLYPHS)
  private popLen = 0
  private readonly digitCells = new Int8Array(DIGITS_PER_RING)

  // Materials and geometry made here, for dispose().
  private readonly owned: { dispose(): void }[] = []

  constructor(list: readonly ParkRing[], ringGeo: THREE.BufferGeometry, ringMat: THREE.Material) {
    this.list = list
    this.n = list.length
    const n = Math.max(1, this.n)
    this.group.name = 'stunt-rings'

    // ---- the rings ----
    this.ringQ = new Float32Array(n * 4)
    this.ringState = new Float32Array(n * 4)
    this.ringAttr = new THREE.InstancedBufferAttribute(this.ringState, 4).setUsage(THREE.DynamicDrawUsage)
    ringGeo.setAttribute('aRing', this.ringAttr)
    this.ringMesh = new THREE.InstancedMesh(ringGeo, ringMat, n)
    this.ringMesh.frustumCulled = false
    this.ringMesh.name = 'stunt-ring-tubes'
    this.shownWait = new Float64Array(n)
    this.sinceGone = new Float32Array(n).fill(99)
    this.sinceBack = new Float32Array(n).fill(99)
    this.converging = new Uint8Array(n)
    for (let i = 0; i < this.n; i++) {
      const r = list[i]
      _a.set(r.nx, r.ny, r.nz)
      // The torus's hole looks along +z: turn +z onto the way cars fly through it.
      _q.setFromUnitVectors(_z, _a)
      _q.toArray(this.ringQ, i * 4)
      _p.set(r.x, r.y, r.z)
      _s.set(r.radius, r.radius, r.radius)
      _m.compose(_p, _q, _s)
      this.ringMesh.setMatrixAt(i, _m)
      this.ringState[i * 4 + 1] = 1 // whole
    }
    this.ringMesh.count = this.n
    this.ringMesh.instanceMatrix.needsUpdate = true
    this.group.add(this.ringMesh)

    // ---- the arcs a ring breaks into: one 1/18th of the ring's tube, centred on its own middle ----
    const arc = (Math.PI * 2) / PIECES_PER_RING
    const pieceGeo = new THREE.TorusGeometry(1, 0.055, 6, 5, arc * 0.92)
    pieceGeo.rotateZ(-arc * 0.46)
    pieceGeo.translate(-1, 0, 0)
    this.pGlow = new Float32Array(PIECE_CAP)
    this.pGlowAttr = new THREE.InstancedBufferAttribute(this.pGlow, 1).setUsage(THREE.DynamicDrawUsage)
    pieceGeo.setAttribute('aGlow', this.pGlowAttr)
    const pieceMat = new THREE.ShaderMaterial({ vertexShader: pieceVertex, fragmentShader: pieceFragment, uniforms: fxUniforms(), fog: false })
    this.pieces = new THREE.InstancedMesh(pieceGeo, pieceMat, PIECE_CAP)
    this.pieces.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.pieces.frustumCulled = false
    this.pieces.count = 0
    this.pieces.visible = false
    this.pieces.name = 'stunt-ring-pieces'
    this.group.add(this.pieces)
    this.owned.push(pieceGeo, pieceMat)

    // ---- shockwaves: a thin ring of light, added on top ----
    const waveGeo = new THREE.TorusGeometry(1, 0.035, 6, 72)
    this.wGlow = new Float32Array(WAVE_CAP)
    this.wGlowAttr = new THREE.InstancedBufferAttribute(this.wGlow, 1).setUsage(THREE.DynamicDrawUsage)
    waveGeo.setAttribute('aGlow', this.wGlowAttr)
    const waveMat = new THREE.ShaderMaterial({
      vertexShader: pieceVertex,
      fragmentShader: waveFragment,
      uniforms: fxUniforms(),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    })
    this.waves = new THREE.InstancedMesh(waveGeo, waveMat, WAVE_CAP)
    this.waves.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.waves.frustumCulled = false
    this.waves.count = 0
    this.waves.visible = false
    this.waves.renderOrder = 6
    this.waves.name = 'stunt-ring-waves'
    this.group.add(this.waves)
    this.owned.push(waveGeo, waveMat)

    // ---- the numbers ----
    this.atlas = makeAtlas()
    const digitMat = makeGlyphMaterial(this.atlas, false)
    const popMat = makeGlyphMaterial(this.atlas, true)
    this.digits = new GlyphSet(n * DIGITS_PER_RING, digitMat, 'stunt-ring-countdowns')
    this.popup = new GlyphSet(POP_GLYPHS, popMat, 'stunt-ring-points')
    this.group.add(this.digits.mesh)
    this.group.add(this.popup.mesh)
    this.owned.push(this.atlas, digitMat, popMat, this.digits, this.popup)
  }

  // ------------------------------------------------------------ explosions

  private explode(i: number, vx: number, vy: number, vz: number, points: number): void {
    const r = this.list[i]
    if (!r) return
    const R = r.radius
    _q.fromArray(this.ringQ, i * 4)
    _u.set(1, 0, 0).applyQuaternion(_q)
    _v.set(0, 1, 0).applyQuaternion(_q)
    _a.set(r.nx, r.ny, r.nz)
    // The ring breaks into its arcs, each flying on with the car and out from the middle.
    for (let k = 0; k < PIECES_PER_RING; k++) {
      const j = this.pCursor
      this.pCursor = (this.pCursor + 1) % PIECE_CAP
      const th = ((k + 0.5) / PIECES_PER_RING) * Math.PI * 2
      const c = Math.cos(th)
      const s = Math.sin(th)
      // Out from the middle, in the ring's plane.
      const ox = _u.x * c + _v.x * s
      const oy = _u.y * c + _v.y * s
      const oz = _u.z * c + _v.z * s
      this.pPos[j * 3] = r.x + ox * R
      this.pPos[j * 3 + 1] = r.y + oy * R
      this.pPos[j * 3 + 2] = r.z + oz * R
      // Every other arc runs on ahead of the car (into the bonnet camera's view), the rest burst
      // out wide and drop back past the chase camera: the spray is all around you.
      const ahead = (k & 1) === 1
      const carry = ahead ? 1.1 + 0.15 * rand() : 0.82 + 0.18 * rand()
      const out = (ahead ? 1.5 + 3 * rand() : 4 + 5 * rand()) * Math.max(0.6, R / 4)
      const along = (rand() - 0.3) * 4
      this.pVel[j * 3] = vx * carry + ox * out + _a.x * along
      this.pVel[j * 3 + 1] = vy * carry + oy * out + _a.y * along + 1.5
      this.pVel[j * 3 + 2] = vz * carry + oz * out + _a.z * along
      // Its turn: the ring's, then round to its place on the ring.
      _q2.setFromAxisAngle(_z, th).premultiply(_q)
      _q2.toArray(this.pQuat, j * 4)
      _p.set(rand() - 0.5, rand() - 0.5, rand() - 0.5)
      if (_p.lengthSq() < 1e-4) _p.set(0, 1, 0)
      _p.normalize().toArray(this.pAxis, j * 3)
      this.pSpin[j] = 3 + 7 * rand()
      this.pSize[j] = R
      this.pAge[j] = 0
      this.pLife[j] = 1.5 + 0.7 * rand()
      this.pMode[j] = 0
    }
    // Where the blast is flung to, along your path: a third of a second ahead of the car, so the
    // bonnet camera sees it burst in front of you and the chase camera sees it beyond the car.
    const ax = r.x + vx * FLING_S
    const ay = r.y + vy * FLING_S
    const az = r.z + vz * FLING_S
    // Two shockwaves growing out in the ring's plane: one around you, one flung ahead of you.
    for (let k = 0; k < 2; k++) {
      const j = this.wCursor
      this.wCursor = (this.wCursor + 1) % WAVE_CAP
      this.wPos[j * 3] = k === 0 ? r.x : ax
      this.wPos[j * 3 + 1] = k === 0 ? r.y : ay
      this.wPos[j * 3 + 2] = k === 0 ? r.z : az
      this.wVel[j * 3] = vx
      this.wVel[j * 3 + 1] = vy
      this.wVel[j * 3 + 2] = vz
      _q.toArray(this.wQuat, j * 4)
      this.wR0[j] = R * (k === 0 ? 1 : 0.45)
      this.wGrow[j] = k === 0 ? 3.2 : 3.6
      this.wAge[j] = k === 0 ? 0 : -0.05
      this.wLife[j] = k === 0 ? 0.6 : 0.55
    }
    // Sprays of crystals from the shared fx pool: one where the ring was, one flung ahead.
    _p.set(r.x, r.y, r.z)
    _s.set(vx * 0.9, vy * 0.9 + 2, vz * 0.9)
    fx.shards({ position: _p, velocity: _s, color: PALETTE.core, count: 16, speed: 9, size: 0.22, life: 1.4 })
    _p.set(ax, ay, az)
    _s.set(vx, vy + 1.5, vz)
    fx.shards({ position: _p, velocity: _s, color: PALETTE.core, count: 22, speed: 10, size: 0.22, life: 1.4 })
    fx.shards({ position: _p, velocity: _s, color: PALETTE.coreHot, count: 12, speed: 13, size: 0.16, life: 0.9 })
    // The points it added, in front of the camera.
    this.popAge = 0
    this.popPoints = Math.max(0, Math.round(points))
    this.setPopText(this.popPoints)
    this.sinceGone[i] = 0
    this.converging[i] = 0
  }

  /** The pieces fly back in from all around, arriving as the countdown ends (in `seconds`). */
  private converge(i: number, seconds: number): void {
    const r = this.list[i]
    if (!r) return
    const R = r.radius
    _q.fromArray(this.ringQ, i * 4)
    _u.set(1, 0, 0).applyQuaternion(_q)
    _v.set(0, 1, 0).applyQuaternion(_q)
    _a.set(r.nx, r.ny, r.nz)
    for (let k = 0; k < PIECES_PER_RING; k++) {
      const j = this.pCursor
      this.pCursor = (this.pCursor + 1) % PIECE_CAP
      const th = ((k + 0.5) / PIECES_PER_RING) * Math.PI * 2
      const ox = _u.x * Math.cos(th) + _v.x * Math.sin(th)
      const oy = _u.y * Math.cos(th) + _v.y * Math.sin(th)
      const oz = _u.z * Math.cos(th) + _v.z * Math.sin(th)
      // Ends exactly where its arc of the ring is...
      this.pVel[j * 3] = r.x + ox * R
      this.pVel[j * 3 + 1] = r.y + oy * R
      this.pVel[j * 3 + 2] = r.z + oz * R
      // ...starting well out from it, a little in front or behind.
      const far = R * (1.6 + 1.4 * rand())
      const side = (rand() - 0.5) * R * 1.2
      this.pFrom[j * 3] = this.pVel[j * 3] + ox * far + _a.x * side
      this.pFrom[j * 3 + 1] = this.pVel[j * 3 + 1] + oy * far + _a.y * side
      this.pFrom[j * 3 + 2] = this.pVel[j * 3 + 2] + oz * far + _a.z * side
      _q2.setFromAxisAngle(_z, th).premultiply(_q)
      _q2.toArray(this.pQuat, j * 4)
      this.pSize[j] = R
      this.pAge[j] = 0
      this.pLife[j] = Math.max(0.15, seconds)
      this.pMode[j] = 1
    }
  }

  private setPopText(points: number): void {
    // "+" then the number's digits.
    let len = 1
    this.popCells[0] = PLUS
    let p = Math.min(99999, points)
    let digits = 1
    for (let t = p; t >= 10; t = Math.floor(t / 10)) digits++
    digits = Math.min(digits, POP_GLYPHS - 1)
    for (let k = digits; k >= 1; k--) {
      this.popCells[k] = p % 10
      p = Math.floor(p / 10)
    }
    len += digits
    this.popLen = len
  }

  // ------------------------------------------------------------ every frame

  /** Step everything by dt seconds (0 while paused: the picture holds still). */
  update(dt: number): void {
    // New explosions from the physics step.
    const q = rings.bursts
    for (let b = 0; b < rings.burstCount; b++) {
      const at = b * BURST_FLOATS
      const i = q[at] | 0
      this.explode(i, q[at + 1], q[at + 2], q[at + 3], q[at + 4])
      if (i >= 0 && i < this.n) this.shownWait[i] = rings.wait[i]
    }
    rings.burstCount = 0

    this.stepRings(dt)
    this.stepPieces(dt)
    this.stepWaves(dt)
    this.stepPopup(dt)
  }

  private stepRings(dt: number): void {
    const total = comebackSeconds()
    let dirty = false
    this.digits.begin()
    _c.set(PALETTE.core)
    _cHot.set(PALETTE.coreHot)
    for (let i = 0; i < this.n; i++) {
      const w = i < rings.wait.length ? rings.wait[i] : 0
      const was = this.shownWait[i]
      let hot = 0
      let thick = 1
      let ghost = 0
      let done = 0
      if (w > 0) {
        // Counting down. A countdown that appeared without an explosion came from a rewind: no delay.
        if (was <= 0) this.sinceGone[i] = 99
        this.sinceGone[i] += dt
        if (w <= CONVERGE_S && !this.converging[i]) {
          this.converging[i] = 1
          this.converge(i, w)
        }
        const appear = Math.min(1, Math.max(0, (this.sinceGone[i] - GHOST_DELAY) / GHOST_FADE))
        const leaving = Math.min(1, w / CONVERGE_S)
        thick = GHOST_THICK * appear * leaving
        ghost = 1
        done = Math.min(1, Math.max(0, 1 - w / total))
        this.addCountdown(i, w, appear * leaving)
      } else {
        // Whole. Just back (from its countdown or a rewind): the white-hot flash.
        if (was > 0) {
          this.sinceBack[i] = 0
          this.converging[i] = 0
        }
        this.sinceBack[i] += dt
        hot = this.sinceBack[i] < FORM_FLASH_S ? 1 - this.sinceBack[i] / FORM_FLASH_S : 0
      }
      this.shownWait[i] = w
      const s = this.ringState
      if (s[i * 4] !== hot || s[i * 4 + 1] !== thick || s[i * 4 + 2] !== ghost || s[i * 4 + 3] !== done) {
        s[i * 4] = hot
        s[i * 4 + 1] = thick
        s[i * 4 + 2] = ghost
        s[i * 4 + 3] = done
        dirty = true
      }
    }
    this.digits.end()
    if (dirty) this.ringAttr.needsUpdate = true
  }

  /** The seconds left, in the ring's place: violet, white-hot for the last few. */
  private addCountdown(i: number, w: number, alpha: number): void {
    if (alpha <= 0.01) return
    const r = this.list[i]
    const secs = Math.max(1, Math.ceil(w - 1e-6))
    let len = 1
    for (let t = secs; t >= 10; t = Math.floor(t / 10)) len++
    len = Math.min(len, DIGITS_PER_RING)
    let v = secs
    for (let k = len - 1; k >= 0; k--) {
      this.digitCells[k] = v % 10
      v = Math.floor(v / 10)
    }
    const h = r.radius * DIGIT_SCALE * (len > 2 ? 0.75 : 1)
    const last = w <= HOT_SECONDS
    const c = last ? _cHot : _c
    const glow = last ? GLOW.T2 * 0.8 : GLOW.T1
    for (let k = 0; k < len; k++) {
      this.digits.add(r.x, r.y, r.z, (k - (len - 1) / 2) * GLYPH_STEP, this.digitCells[k], h, alpha, c, glow)
    }
  }

  private stepPieces(dt: number): void {
    let alive = 0
    for (let j = 0; j < PIECE_CAP; j++) {
      if (this.pLife[j] < 0) continue
      this.pAge[j] += dt
      const age = this.pAge[j]
      const life = this.pLife[j]
      if (age >= life) {
        this.pLife[j] = -1
        continue
      }
      let glow: number
      if (this.pMode[j] === 0) {
        // Flying out: falls like the car, tumbling.
        this.pVel[j * 3 + 1] -= GRAVITY * dt
        this.pPos[j * 3] += this.pVel[j * 3] * dt
        this.pPos[j * 3 + 1] += this.pVel[j * 3 + 1] * dt
        this.pPos[j * 3 + 2] += this.pVel[j * 3 + 2] * dt
        _q.fromArray(this.pQuat, j * 4)
        _a.fromArray(this.pAxis, j * 3)
        _q2.setFromAxisAngle(_a, this.pSpin[j] * dt)
        _q.multiply(_q2).normalize()
        _q.toArray(this.pQuat, j * 4)
        _p.fromArray(this.pPos, j * 3)
        glow = pieceGlow(age, life)
      } else {
        // Flying back in: speeding up as it nears its place, glowing brighter.
        const t = age / life
        const e = t * t
        _p.set(
          this.pFrom[j * 3] + (this.pVel[j * 3] - this.pFrom[j * 3]) * e,
          this.pFrom[j * 3 + 1] + (this.pVel[j * 3 + 1] - this.pFrom[j * 3 + 1]) * e,
          this.pFrom[j * 3 + 2] + (this.pVel[j * 3 + 2] - this.pFrom[j * 3 + 2]) * e,
        )
        _q.fromArray(this.pQuat, j * 4)
        glow = GLOW.T1 + (GLOW.T2 - GLOW.T1) * t
      }
      _s.setScalar(this.pSize[j])
      _m.compose(_p, _q, _s)
      this.pieces.setMatrixAt(alive, _m)
      this.pGlow[alive] = glow
      alive++
    }
    this.pieces.count = alive
    this.pieces.visible = alive > 0
    if (alive > 0) {
      this.pieces.instanceMatrix.needsUpdate = true
      this.pGlowAttr.needsUpdate = true
    }
  }

  private stepWaves(dt: number): void {
    let alive = 0
    for (let j = 0; j < WAVE_CAP; j++) {
      if (this.wLife[j] < 0) continue
      this.wAge[j] += dt
      const age = this.wAge[j]
      const life = this.wLife[j]
      if (age >= life) {
        this.wLife[j] = -1
        continue
      }
      // It rides along with the car from the moment of the pass (waiting ones too).
      this.wVel[j * 3 + 1] -= GRAVITY * dt
      this.wPos[j * 3] += this.wVel[j * 3] * dt
      this.wPos[j * 3 + 1] += this.wVel[j * 3 + 1] * dt
      this.wPos[j * 3 + 2] += this.wVel[j * 3 + 2] * dt
      if (age < 0) continue
      const t = age / life
      const grow = 1 - (1 - t) * (1 - t) * (1 - t)
      _p.fromArray(this.wPos, j * 3)
      _q.fromArray(this.wQuat, j * 4)
      _s.setScalar(this.wR0[j] * (1 + this.wGrow[j] * grow))
      _m.compose(_p, _q, _s)
      this.waves.setMatrixAt(alive, _m)
      // T3 at first, under T2 by about a quarter of a second, gone at the end.
      this.wGlow[alive] = GLOW.T3 * (1 - t) * (1 - t)
      alive++
    }
    this.waves.count = alive
    this.waves.visible = alive > 0
    if (alive > 0) {
      this.waves.instanceMatrix.needsUpdate = true
      this.wGlowAttr.needsUpdate = true
    }
  }

  private stepPopup(dt: number): void {
    this.popup.begin()
    if (this.popAge >= 0) {
      this.popAge += dt
      const t = this.popAge
      if (t >= POP_S) this.popAge = -1
      else {
        // Pops in big, settles, drifts up and fades.
        const settle = Math.min(1, t / 0.14)
        const h = POP_HEIGHT * (1 + 0.45 * (1 - settle) * (1 - settle))
        const fadeIn = Math.min(1, t / 0.06)
        const fadeOut = t > POP_S - 0.35 ? (POP_S - t) / 0.35 : 1
        const y = 1.25 + 0.5 * (t / POP_S)
        _c.set(PALETTE.coreHot)
        const n = this.popLen
        for (let k = 0; k < n; k++) {
          this.popup.add(0, y, -POP_DIST, (k - (n - 1) / 2) * GLYPH_STEP, this.popCells[k], h, fadeIn * fadeOut, _c, GLOW.T2)
        }
      }
    }
    this.popup.end()
  }

  // ------------------------------------------------------------ dev

  /** For the inspector: what is on screen right now. */
  debug(): { pieces: number; waves: number; countdownGlyphs: number; popup: string } {
    let txt = ''
    if (this.popAge >= 0) txt = `+${this.popPoints}`
    return { pieces: this.pieces.count, waves: this.waves.count, countdownGlyphs: this.digits.used, popup: txt }
  }

  /** Free every buffer, texture and material this made (the ring geometry and material are the caller's). */
  dispose(): void {
    for (const o of this.owned) o.dispose()
    this.pieces.dispose()
    this.waves.dispose()
    this.ringMesh.dispose()
    this.digits.mesh.dispose()
    this.popup.mesh.dispose()
  }
}
