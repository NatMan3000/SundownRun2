// ============================================================
//  SPEED TRAP SIGN - a hologram beside the road
// ------------------------------------------------------------
//  Each speed trap gets a floating holographic readout off the
//  right-hand edge (never over the road: no gantries), angled to
//  face the cars coming at it. It shows the last speed through the
//  trap and the best, from store.trapLastKmh / trapBestKmh.
//
//  The text is drawn into a small canvas texture only when those
//  numbers change; the shader adds the hologram feel (scan lines,
//  a soft flicker, fading in the distance). Glow tier T1, like the
//  billboards.
// ============================================================

import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { FONTS, GLOW, PALETTE } from '../../core/palette'
import { useGame } from '../../core/store'
import type { TrackFrame, TrackRuntime } from '../../track/types'

const W = 512
const H = 256

const vertexShader = /* glsl */ `
varying vec2 vUv;
varying float vDist;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`
const fragmentShader = /* glsl */ `
uniform sampler2D uMap;
uniform float uTime;
uniform float uGlow;
varying vec2 vUv;
varying float vDist;
void main() {
  vec4 t = texture2D(uMap, vUv);
  float scan = 0.82 + 0.18 * sin(vUv.y * 180.0 - uTime * 6.0);
  float flicker = 0.94 + 0.06 * sin(uTime * 23.0) * sin(uTime * 7.0);
  float far = 1.0 - smoothstep(220.0, 420.0, vDist);
  float a = t.a * scan * flicker * far;
  if (a < 0.003) discard;
  gl_FragColor = vec4(t.rgb * uGlow * a, 1.0);
}
`

function drawSign(ctx: CanvasRenderingContext2D, last: number | null, best: number | null): void {
  ctx.clearRect(0, 0, W, H)
  // thin frame
  ctx.strokeStyle = PALETTE.speedTrap
  ctx.globalAlpha = 0.55
  ctx.lineWidth = 3
  ctx.strokeRect(6, 6, W - 12, H - 12)
  ctx.globalAlpha = 1
  ctx.fillStyle = PALETTE.speedTrap
  ctx.font = `600 34px ${FONTS.display}`
  ctx.textBaseline = 'top'
  ctx.fillText('SPEED TRAP', 26, 22)
  ctx.fillStyle = PALETTE.laneLine
  ctx.font = `700 118px ${FONTS.display}`
  ctx.textBaseline = 'alphabetic'
  const big = last === null ? '---' : String(Math.round(last))
  ctx.fillText(big, 24, 182)
  const bigW = ctx.measureText(big).width
  ctx.font = `600 34px ${FONTS.display}`
  ctx.fillText('km/h', 36 + bigW, 182)
  ctx.fillStyle = PALETTE.speedTrap
  ctx.font = `500 28px ${FONTS.display}`
  ctx.fillText(best === null ? 'BEST  ---' : `BEST  ${Math.round(best)}`, 26, 228)
}

const _f: TrackFrame = {
  s: 0,
  position: new THREE.Vector3(),
  tangent: new THREE.Vector3(),
  up: new THREE.Vector3(),
  right: new THREE.Vector3(),
  halfWidth: 0,
  bank: 0,
  curvature: 0,
  surface: 'road',
}

/** time: the road's shared uTime uniform (RoadView ticks it), so the scan lines move. */
export function SpeedTrapSigns({ track, time }: { track: TrackRuntime; time: { value: number } }) {
  const last = useGame((s) => s.trapLastKmh)
  const best = useGame((s) => s.trapBestKmh)

  const sign = useMemo(() => {
    const canvas = document.createElement('canvas')
    canvas.width = W
    canvas.height = H
    const ctx = canvas.getContext('2d')!
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: { uMap: { value: texture }, uTime: time, uGlow: { value: GLOW.T1 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
    })
    const geometry = new THREE.PlaneGeometry(4.4, 2.2)
    return { ctx, texture, material, geometry }
  }, [time])

  useEffect(() => {
    drawSign(sign.ctx, last, best)
    sign.texture.needsUpdate = true
  }, [sign, last, best])

  useEffect(
    () => () => {
      sign.texture.dispose()
      sign.material.dispose()
      sign.geometry.dispose()
    },
    [sign],
  )

  // One pose per trap, computed once per track build.
  const poses = useMemo(() => {
    const out: { position: THREE.Vector3; quaternion: THREE.Quaternion }[] = []
    for (const trap of track.speedTraps) {
      track.frameAt(trap.s, _f)
      const position = _f.position.clone().addScaledVector(_f.right, _f.halfWidth + 3.2).addScaledVector(_f.up, 2.6)
      // Face the oncoming cars, turned a little toward the road.
      const facing = _f.tangent.clone().negate().addScaledVector(_f.right, -0.45).normalize()
      const m = new THREE.Matrix4().lookAt(new THREE.Vector3(), facing, _f.up)
      const quaternion = new THREE.Quaternion().setFromRotationMatrix(m)
      // lookAt points -z at the target; the plane's face is +z, so turn it round.
      quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI))
      out.push({ position, quaternion })
    }
    return out
  }, [track])

  return (
    <group name="speed-trap-signs">
      {poses.map((p, i) => (
        <mesh key={i} name="speed-trap-sign" geometry={sign.geometry} material={sign.material} position={p.position} quaternion={p.quaternion} />
      ))}
    </group>
  )
}
