// ============================================================
//  NAN CHECK - counts broken pixels, so "no flicker" is a number
// ------------------------------------------------------------
//  A shader can make a number that is not a number: NaN, from
//  maths with no answer (0 / 0, the square root of -1, pow() of a
//  negative number), or Infinity, from a light so bright it
//  overflows. One such pixel is invisible on its own, but bloom
//  spreads it into a flickering dot (GitHub issue #2: dots on the
//  road on Josh's Windows laptop).
//
//  __dev.nancheck() draws the scene ONCE, exactly as the camera sees
//  it, into a full-precision picture with no post effects, reads
//  every pixel back and counts:
//    nan         pixels with a NaN in any colour channel
//    caught      NaN pixels the road's own guard caught (glsl.ts
//                sr2SafeLight): black in the game, so only this
//                counter can see them
//    inf         pixels with an infinite channel
//    overHalf    pixels brighter than a half-float can hold (65504):
//                a Mac stores these as Infinity, Windows as 65504
//    road48      white pixels pinned at the road's brightness cap (48)
//                in all three channels: what a NaN on the road turned
//                into before the guard (min(NaN, 48) is 48)
//    hot         pixels brighter than bloom's input cap (64): sharp
//                hot dots, the "fireflies"
//    sparkles    (with { flicker: true }) hot, lonely pixels that were
//                dark in the previous check: dots that blink as you move
//  and names the object under a sample of the bad pixels (and under
//  the single brightest one).
//
//    __dev.nancheck()                  count, and name up to 24 culprits
//    __dev.nancheck({ selftest: 1 })   also draw squares that are NaN
//                                      on purpose (raw, and through the
//                                      road's guard): proves it catches them
//    __dev.nancheck({ flicker: 1 })    also compare with the previous
//                                      flicker check and count sparkles
//    __dev.nancheck({ pick: false })   skip naming objects (faster)
//    __dev.nancheck({ geometry: 1 })   also scan every mesh's vertex data
//                                      for NaN and zero-length normals
//
//  ?nancheck=1 in the URL shows the numbers under the minimap,
//  checked every 2 seconds (with a short hitch each time), so they
//  can be read on a computer without the developer console: the
//  way to find out what Josh's laptop draws.
//
//  Nothing runs per frame unless ?nancheck=1 is on.
// ============================================================

import { useEffect } from 'react'
import * as THREE from 'three'
import { useThree } from '@react-three/fiber'
import { registerDev, urlParam } from '../core/devHandles'
import { PALETTE } from '../core/palette'
import { NAN_TAG, NAN_TAG_MARK, ROAD_GLSL } from './road/glsl'
import { ROAD_LIGHT_CAP } from './road/roadMaterial'

/** Largest number a half-float pixel holds. */
const HALF_MAX = 65504
/** Brighter than this saturates bloom's input (effects.ts caps it at 64): a firefly candidate. */
const BLOOM_CAP = 64
/** Bloom's threshold: below this a pixel doesn't glow at all. */
const BLOOM_THRESHOLD = 1
/** Most bad pixels to name (each needs a ray through the scene). */
const MAX_PICKS = 24
/** ?nancheck=1: seconds between checks. */
const WATCH_SECONDS = 2

function label(o: THREE.Object3D): string {
  const names: string[] = []
  let p: THREE.Object3D | null = o
  while (p && names.length < 3) {
    if (p.name) names.push(p.name)
    p = p.parent
  }
  return names.length ? names.join(' < ') : o.type
}

/** The value the self-test's marker square draws: proves the squares are on screen at all. */
const MARKER = 777

/**
 * Three small squares 1 m in front of the camera: the left one's shader
 * returns NaN on purpose (raw, as any material could), the middle one makes a
 * NaN and passes it through the road's own guard (so it should count as
 * "caught"), and the right one draws MARKER, so the self-test proves the
 * squares were drawn AND that both kinds of NaN were counted.
 */
function makeSelfTestSquares(camera: THREE.Camera): THREE.Group {
  const group = new THREE.Group()
  group.name = 'nancheck-selftest'
  const quad = (fragment: string, x: number) => {
    const mat = new THREE.ShaderMaterial({
      // uNanBits is the bit pattern of a NaN, handed in as a uniform. (0.0 / 0.0
      // does not work here: the Mac's shader compiler rewrites x / x as 1.)
      uniforms: { uZero: { value: 0 }, uNanBits: { value: 0x7fc00000 }, uSr2NanTag: NAN_TAG },
      vertexShader: 'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: fragment,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.02, 0.02), mat)
    mesh.position.x = x
    mesh.renderOrder = 1e6
    mesh.frustumCulled = false
    group.add(mesh)
  }
  quad('uniform uint uNanBits; void main() { gl_FragColor = vec4(vec3(uintBitsToFloat(uNanBits)), 1.0); }', -0.03)
  quad(
    `uniform uint uNanBits;\n${ROAD_GLSL}\nvoid main() { gl_FragColor = vec4(sr2SafeLight(vec3(uintBitsToFloat(uNanBits)), ${ROAD_LIGHT_CAP.toFixed(1)}), 1.0); }`,
    0,
  )
  quad(`uniform float uZero; void main() { gl_FragColor = vec4(vec3(${MARKER}.0 + uZero), 1.0); }`, 0.03)
  // 1 m in front of the camera, facing it (world pose: the camera may sit in a rig)
  camera.updateMatrixWorld()
  group.position.set(0, 0, -1).applyMatrix4(camera.matrixWorld)
  camera.getWorldQuaternion(group.quaternion)
  group.updateMatrixWorld(true)
  return group
}

function disposeGroup(group: THREE.Group): void {
  group.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose()
      ;(o.material as THREE.Material).dispose()
    }
  })
}

type Kind = 'nan' | 'caught' | 'inf' | 'overHalf' | 'road48' | 'sparkle'

interface BadPixel {
  x: number
  y: number
  kind: Kind
  rgb: string
}

export interface NanCheckOptions {
  selftest?: unknown
  /** The raw value of one pixel: [x across, y down] in buffer pixels. */
  at?: [number, number]
  /** Compare with the previous flicker check and count sparkles. */
  flicker?: unknown
  /** Name the objects under bad pixels (default true). */
  pick?: boolean
  /** Also scan every mesh's vertex data for non-finite numbers and zero-length normals. */
  geometry?: unknown
}

export interface NanCheckResult {
  size: string
  at?: string
  nan: number
  caught: number
  inf: number
  overHalf: number
  road48: number
  hot: number
  sparkles?: number
  brightest: number
  brightestHit: string
  selftestMarker?: number
  byObject: Record<string, number>
  samples: { x: number; y: number; kind: string; rgb: string; hit: string }[]
  /** With { geometry }: meshes scanned, and the ones with broken vertex data. */
  geometry?: { meshes: number; broken: Record<string, string> }
}

/**
 * Broken vertex data makes NaN pixels too: one NaN or zero-length normal at a
 * vertex turns every triangle touching it NaN (normalize(0) has no answer).
 */
function scanGeometry(scene: THREE.Scene): { meshes: number; broken: Record<string, string> } {
  let meshes = 0
  const broken: Record<string, string> = {}
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh || !mesh.geometry) return
    meshes++
    const problems: string[] = []
    for (const [name, attr] of Object.entries(mesh.geometry.attributes)) {
      const a = (attr as THREE.BufferAttribute).array
      if (!a) continue
      let bad = 0
      for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) bad++
      if (bad) problems.push(`${bad} non-finite in ${name}`)
    }
    const n = mesh.geometry.attributes.normal as THREE.BufferAttribute | undefined
    if (n) {
      let zero = 0
      for (let i = 0; i < n.count; i++) if (!(Math.hypot(n.getX(i), n.getY(i), n.getZ(i)) > 1e-6)) zero++
      if (zero) problems.push(`${zero} zero-length normals`)
    }
    const inst = (mesh as THREE.InstancedMesh).instanceMatrix
    if (inst) {
      let bad = 0
      for (let i = 0; i < inst.array.length; i++) if (!Number.isFinite(inst.array[i])) bad++
      if (bad) problems.push(`${bad} non-finite in instanceMatrix`)
    }
    if (problems.length) broken[`${label(mesh)} #${mesh.id}`] = problems.join(', ')
  })
  return { meshes, broken }
}

/** Brightness per pixel from the last flicker check (bloom's view: the brightest channel, capped). */
let previousGlow: Float32Array | null = null

export function NanCheck(): null {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const camera = useThree((s) => s.camera)

  useEffect(() => {
    const ray = new THREE.Raycaster()
    const ndc = new THREE.Vector2()
    const nameAt = (x: number, y: number, w: number, h: number): { key: string; text: string } => {
      ndc.set(((x + 0.5) / w) * 2 - 1, -(((y + 0.5) / h) * 2 - 1))
      ray.setFromCamera(ndc, camera)
      const hit = ray.intersectObjects(scene.children, true).find((i) => i.object.visible)
      if (!hit) return { key: '(sky / nothing)', text: '(sky / nothing)' }
      const key = label(hit.object)
      return { key, text: `${key} @ ${hit.distance.toFixed(1)} m` }
    }

    const run = (opts?: NanCheckOptions): NanCheckResult => {
      const size = gl.getDrawingBufferSize(new THREE.Vector2())
      const w = Math.max(1, Math.floor(size.x))
      const h = Math.max(1, Math.floor(size.y))
      const target = new THREE.WebGLRenderTarget(w, h, { type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: true })
      const square = opts?.selftest ? makeSelfTestSquares(camera) : null
      if (square) scene.add(square)

      // For this one picture, a NaN the road catches draws as the marker instead of black.
      const previous = gl.getRenderTarget()
      const autoClear = gl.autoClear
      gl.autoClear = true
      NAN_TAG.value = NAN_TAG_MARK
      try {
        gl.setRenderTarget(target)
        gl.render(scene, camera)
      } finally {
        NAN_TAG.value = 0
        gl.setRenderTarget(previous)
        gl.autoClear = autoClear
      }

      const px = new Float32Array(w * h * 4)
      gl.readRenderTargetPixels(target, 0, 0, w, h, px)
      target.dispose()
      if (square) {
        scene.remove(square)
        disposeGroup(square)
      }

      let nan = 0
      let caught = 0
      let inf = 0
      let overHalf = 0
      let road48 = 0
      let brightest = 0
      let brightestAt = -1
      let hot = 0
      let marker = 0
      const bad: BadPixel[] = []
      const glow = new Float32Array(w * h)
      for (let i = 0; i < w * h; i++) {
        const r = px[i * 4]
        const g = px[i * 4 + 1]
        const b = px[i * 4 + 2]
        let kind: Kind | null = null
        if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
          nan++
          kind = 'nan'
        } else if (r < NAN_TAG_MARK / 2 && g < NAN_TAG_MARK / 2 && b < NAN_TAG_MARK / 2) {
          // the marker, give or take the haze three mixes in after the road's guard
          caught++
          kind = 'caught'
        } else if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
          inf++
          kind = 'inf'
        } else if (r === MARKER && g === MARKER && b === MARKER) {
          marker++
        } else {
          const m = Math.max(r, g, b)
          glow[i] = Math.min(m, BLOOM_CAP)
          if (m > brightest) {
            brightest = m
            brightestAt = i
          }
          if (m > BLOOM_CAP) hot++
          if (m > HALF_MAX) {
            overHalf++
            kind = 'overHalf'
          } else if (Math.min(r, g, b) > ROAD_LIGHT_CAP * 0.85 && m <= ROAD_LIGHT_CAP + 0.01 && m - Math.min(r, g, b) < 0.5) {
            // white-hot at the cap in all three channels (a NaN under the old
            // min(light, 48) cap looked exactly like this, less a touch of haze)
            road48++
            kind = 'road48'
          }
        }
        if (kind) bad.push({ x: i % w, y: h - 1 - Math.floor(i / w), kind, rgb: `${r},${g},${b}` })
      }

      // Sparkles: a pixel that glows (over bloom's threshold), stands alone (its
      // four neighbours are under half as bright) and was under a quarter as
      // bright in the previous flicker check. Small bright things moving across
      // the screen count too, so compare runs, don't read one number on its own.
      let sparkles: number | undefined
      if (opts?.flicker) {
        sparkles = 0
        const before = previousGlow && previousGlow.length === w * h ? previousGlow : null
        if (before) {
          for (let y = 1; y < h - 1; y++) {
            for (let x = 1; x < w - 1; x++) {
              const i = y * w + x
              const v = glow[i]
              if (v <= BLOOM_THRESHOLD || v < 4 * before[i] + 0.05) continue
              const n = Math.max(glow[i - 1], glow[i + 1], glow[i - w], glow[i + w])
              if (n >= 0.5 * v) continue
              sparkles++
              if (bad.length < 4096) bad.push({ x, y: h - 1 - y, kind: 'sparkle', rgb: `${v}` })
            }
          }
        }
        previousGlow = glow
      }

      // Name the object under a spread-out sample of the bad pixels.
      const byObject: Record<string, number> = {}
      const samples: NanCheckResult['samples'] = []
      if (opts?.pick !== false) {
        const stride = Math.max(1, Math.floor(bad.length / MAX_PICKS))
        for (let k = 0; k < bad.length && samples.length < MAX_PICKS; k += stride) {
          const p = bad[k]
          const hit = nameAt(p.x, p.y, w, h)
          byObject[`${p.kind}: ${hit.key}`] = (byObject[`${p.kind}: ${hit.key}`] ?? 0) + 1
          samples.push({ x: p.x, y: p.y, kind: p.kind, rgb: p.rgb, hit: hit.text })
        }
      }

      let at: string | undefined
      if (opts?.at) {
        const ax = Math.min(w - 1, Math.max(0, Math.round(opts.at[0])))
        const ay = Math.min(h - 1, Math.max(0, Math.round(opts.at[1])))
        const i = (h - 1 - ay) * w + ax
        at = `${px[i * 4]},${px[i * 4 + 1]},${px[i * 4 + 2]},${px[i * 4 + 3]}`
      }

      let brightestHit = ''
      if (brightestAt >= 0 && opts?.pick !== false) {
        const bx = brightestAt % w
        const by = h - 1 - Math.floor(brightestAt / w)
        brightestHit = `${bx},${by} ${nameAt(bx, by, w, h).text}`
      }

      return {
        size: `${w}x${h}`,
        at,
        nan,
        caught,
        inf,
        overHalf,
        road48,
        hot,
        sparkles,
        brightest: Number(brightest.toFixed(2)),
        brightestHit,
        selftestMarker: square ? marker : undefined,
        byObject,
        samples,
        geometry: opts?.geometry ? scanGeometry(scene) : undefined,
      }
    }

    const off = registerDev(
      'nancheck',
      run as (...args: never[]) => unknown,
      'nancheck({ selftest, flicker, pick, at, geometry }) - draw the scene once at full precision and count broken pixels (NaN, NaN the road caught, Infinity, over half-float, pinned at the road cap, hot, and with flicker: blinking sparkles), naming the objects under a sample of them; selftest adds deliberate NaN squares to prove it catches them',
    )

    // ?nancheck=1: the numbers on screen, for a computer without a console.
    let panel: HTMLDivElement | null = null
    let timer = 0
    if (urlParam('nancheck') === '1') {
      panel = document.createElement('div')
      Object.assign(panel.style, {
        position: 'fixed', // top right, under the minimap: clear of the HUD panels
        right: '28px',
        top: '256px',
        zIndex: '50',
        padding: '8px 12px',
        background: PALETTE.uiPanel,
        border: `1px solid ${PALETTE.uiLine}`,
        borderRadius: '8px',
        color: PALETTE.uiText,
        font: '12px/1.5 ui-monospace, Menlo, Consolas, monospace',
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'pre',
        pointerEvents: 'none',
      })
      panel.textContent = 'NaN check: starting...'
      document.body.appendChild(panel)
      const worst = { nan: 0, caught: 0, inf: 0, overHalf: 0, sparkles: 0 }
      let checks = 0
      let last = ''
      const tick = () => {
        if (!panel) return
        const r = run({ flicker: true, pick: false })
        checks++
        worst.nan = Math.max(worst.nan, r.nan)
        worst.caught = Math.max(worst.caught, r.caught)
        worst.inf = Math.max(worst.inf, r.inf)
        worst.overHalf = Math.max(worst.overHalf, r.overHalf)
        worst.sparkles = Math.max(worst.sparkles, r.sparkles ?? 0)
        // name what is under the first broken pixel, cheaply (one ray)
        if (r.nan + r.caught + r.inf + r.overHalf > 0) {
          const named = run({ pick: true })
          const first = named.samples.find((s) => s.kind !== 'sparkle')
          if (first) last = `${first.kind} on ${first.hit}`
        }
        panel.textContent =
          `NaN check (issue #2), ${checks} checks, now / worst\n` +
          `NaN pixels        ${r.nan} / ${worst.nan}\n` +
          `NaN road caught   ${r.caught} / ${worst.caught}\n` +
          `Infinity          ${r.inf} / ${worst.inf}\n` +
          `Too bright        ${r.overHalf} / ${worst.overHalf}\n` +
          `Sparkles          ${r.sparkles ?? 0} / ${worst.sparkles}\n` +
          `Hot pixels        ${r.hot}\n` +
          (last ? `Last broken: ${last}` : 'Last broken: none yet')
        panel.style.borderColor = worst.nan + worst.caught + worst.inf + worst.overHalf > 0 ? PALETTE.uiWarn : PALETTE.uiLine
      }
      timer = window.setInterval(tick, WATCH_SECONDS * 1000)
    }

    return () => {
      off()
      if (timer) window.clearInterval(timer)
      panel?.remove()
      panel = null
    }
  }, [gl, scene, camera])

  return null
}
