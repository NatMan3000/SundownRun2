// ============================================================
//  SELF-TEST: THE 3D VIEW - rows for selfTest.ts
// ------------------------------------------------------------
//  The editor's self-test (selfTest.ts) calls look3dRows() at the
//  end. Each row checks the 3D view's camera maths (look3dMath.ts)
//  with a real three.js camera, the same way TopDownCamera.tsx
//  places it, against what it promises:
//
//    the swap     a 3D camera put where the map's matching camera
//                 goes shows the ground exactly where the flat map
//                 shows it (within half a pixel), so pressing 3D
//                 can't be seen until it starts to tilt
//    the ground   wherever you turn the camera over a hilly world, it
//                 is never under the ground, the line to the spot it
//                 looks at clears every hill, and it stays inside the
//                 world's edge
//    smoothness   turning round a hill moves the camera smoothly (no
//                 jumps when a hill comes between it and the spot)
//    sliding      right-drag on a camera looking straight down moves
//                 the ground under the mouse exactly as far as the
//                 mouse moved, the same way the map pans
//    the ends     the tilt starts on the map and ends on the 3D view,
//                 with nothing broken by a bad number on the way
// ============================================================

import * as THREE from 'three'
import { LOOK, type GroundAt, type Orbit, type V3, aim, blendOrbit, ease, filmOffsetFor, mapOrbit, openingOrbit, orbit, orbitOk, panOrbit, placeCamera, poseCamera, stickEnd } from './look3dMath'

type Check = (name: string, fn: () => string[] | string) => void

const DEG = Math.PI / 180

/** A world with real hills: smooth bumps up to 60 m, a ridge round the edge like the game's. */
function hills(half: number): GroundAt {
  return (x, z) => {
    const bumps = 28 * Math.sin(x / 70) * Math.cos(z / 90) + 22 * Math.sin((x + z) / 130) + 10
    const edge = Math.max(Math.abs(x), Math.abs(z))
    const ridge = edge > half - 120 ? ((edge - (half - 120)) / 120) ** 2 * 90 : 0
    return bumps + ridge
  }
}

/** A three.js camera placed by the same steps as TopDownCamera.tsx, for an Orbit. */
function cameraFor(o: Orbit, ground: GroundAt, half: number, width: number, height: number, shiftPx: number): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(LOOK.fovDeg, width / height, 0.5, 11000)
  const pos = placeCamera(o, ground, half, { x: 0, y: 0, z: 0 })
  const facing = aim(pos, o, o.yaw, { yaw: 0, pitch: 0 })
  poseCamera(c, pos, facing)
  c.filmOffset = filmOffsetFor(shiftPx, width, width / height, c.filmGauge)
  c.updateProjectionMatrix()
  return c
}

/** Where a world point lands on a screen width x height, in pixels. */
function onScreen(c: THREE.Camera, p: V3, width: number, height: number): { sx: number; sy: number } {
  const v = new THREE.Vector3(p.x, p.y, p.z).project(c)
  return { sx: (v.x * 0.5 + 0.5) * width, sy: (-v.y * 0.5 + 0.5) * height }
}

export function look3dRows(check: Check): void {
  check('3D view: the swap from the map is invisible', () => {
    const bad: string[] = []
    let worst = 0
    let cases = 0
    for (const [width, height] of [
      [1920, 1080],
      [1366, 768],
    ]) {
      for (const mpp of [0.15, 0.6, 1.2, 1.77, 4]) {
        for (const groundY of [0, 37.5]) {
          const cx = 120
          const cz = -40
          const flat: GroundAt = () => groundY
          const map = mapOrbit(cx, cz, groundY, height, mpp, 0, orbit())
          const c = cameraFor(map, flat, 5000, width, height, 0)
          // Ground points under a grid of screen spots, as the flat map places them (view.ts worldToScreen).
          for (const fx of [0.05, 0.3, 0.5, 0.8, 0.97]) {
            for (const fy of [0.04, 0.5, 0.93]) {
              const sx = fx * width
              const sy = fy * height
              const world = { x: cx + (sx - width / 2) * mpp, y: groundY, z: cz + (sy - height / 2) * mpp }
              const got = onScreen(c, world, width, height)
              const err = Math.hypot(got.sx - sx, got.sy - sy)
              worst = Math.max(worst, err)
              if (err > 0.5) bad.push(`${width}x${height} mpp ${mpp} ground ${groundY}: (${sx.toFixed(0)}, ${sy.toFixed(0)}) shows at (${got.sx.toFixed(1)}, ${got.sy.toFixed(1)})`)
              cases++
            }
          }
        }
      }
    }
    return bad.length ? bad.slice(0, 4) : `${cases} spots over 2 window sizes, 5 zooms (to the most zoomed out) and 2 ground heights: worst ${worst.toFixed(3)} px off where the map has them`
  })

  check('3D view: never under the ground, never past the edge', () => {
    const half = 900
    const ground = hills(half)
    const bad: string[] = []
    let n = 0
    let lifted = 0
    let edged = 0
    const pos: V3 = { x: 0, y: 0, z: 0 }
    const want: V3 = { x: 0, y: 0, z: 0 }
    for (const tx of [-860, -400, 0, 333, 860]) {
      for (const tz of [-860, -120, 0, 500, 860]) {
        for (let yawDeg = 0; yawDeg < 360; yawDeg += 30) {
          for (const pitchDeg of [5, 12, 30, 60, 89]) {
            for (const dist of [12, 80, 400, 2400]) {
              const o: Orbit = { x: tx, y: ground(tx, tz), z: tz, yaw: yawDeg * DEG, pitch: pitchDeg * DEG, dist }
              placeCamera(o, ground, half, pos)
              stickEnd(o, want)
              if (pos.y > want.y + 1e-6) lifted++
              if (pos.x !== want.x || pos.z !== want.z) edged++
              n++
              const lim = half - LOOK.edgeMargin
              if (Math.abs(pos.x) > lim + 1e-6 || Math.abs(pos.z) > lim + 1e-6) bad.push(`past the edge at (${pos.x.toFixed(0)}, ${pos.z.toFixed(0)})`)
              if (pos.y < ground(pos.x, pos.z) + LOOK.clearance - 1e-6) bad.push(`under the ground at (${pos.x.toFixed(0)}, ${pos.z.toFixed(0)})`)
              // The line from the camera to the spot clears the hills (checked finer than the camera checks it).
              for (let k = 25; k <= 100; k++) {
                const t = k / 100
                const px = o.x + (pos.x - o.x) * t
                const pz = o.z + (pos.z - o.z) * t
                const py = o.y + (pos.y - o.y) * t
                if (py < ground(px, pz) + LOOK.clearance * 0.5) {
                  bad.push(`a hill hides the spot from (${pos.x.toFixed(0)}, ${pos.y.toFixed(0)}, ${pos.z.toFixed(0)}) yaw ${yawDeg} pitch ${pitchDeg} dist ${dist}`)
                  break
                }
              }
              if (bad.length > 4) return bad
            }
          }
        }
      }
    }
    if (lifted === 0 || edged === 0) bad.push(`the world never tested it (lifted ${lifted}, held at the edge ${edged})`)
    return bad.length ? bad : `${n} camera spots over a hilly 1800 m world: none under the ground or past the edge, the spot always in sight (${lifted} lifted over a hill, ${edged} held inside the edge)`
  })

  check('3D view: turning round a hill never jumps', () => {
    const half = 900
    const ground = hills(half)
    const pos: V3 = { x: 0, y: 0, z: 0 }
    const before: V3 = { x: 0, y: 0, z: 0 }
    let worst = 0
    const bad: string[] = []
    for (const [tx, tz, pitchDeg, dist] of [
      [0, 0, 8, 300],
      [-300, 250, 14, 150],
      [700, -650, 6, 600],
    ]) {
      const o: Orbit = { x: tx, y: ground(tx, tz), z: tz, yaw: 0, pitch: pitchDeg * DEG, dist }
      placeCamera(o, ground, half, before)
      // One degree a step all the way round: how far does the camera move per degree, compared with its stick?
      for (let step = 1; step <= 360; step++) {
        o.yaw = step * DEG
        placeCamera(o, ground, half, pos)
        const moved = Math.hypot(pos.x - before.x, pos.y - before.y, pos.z - before.z)
        // A camera turning on its stick moves dist x 1 degree in radians; allow the lift to add a few times that.
        const ratio = moved / (dist * DEG)
        worst = Math.max(worst, ratio)
        if (ratio > 4) bad.push(`at (${tx}, ${tz}) yaw ${step}: moved ${moved.toFixed(1)} m in one degree`)
        before.x = pos.x
        before.y = pos.y
        before.z = pos.z
      }
    }
    return bad.length ? bad.slice(0, 4) : `3 full turns low over hills, a degree at a time: the camera never moved more than ${worst.toFixed(2)}x its stick's own swing`
  })

  check('3D view: sliding moves the ground with the mouse', () => {
    const bad: string[] = []
    const width = 1920
    const height = 1080
    const flat: GroundAt = () => 0
    for (const yawDeg of [0, 90, 200]) {
      // Looking almost straight down, turned round by the yaw.
      const o: Orbit = { x: 50, y: 0, z: -20, yaw: yawDeg * DEG, pitch: LOOK.maxPitch, dist: 400 }
      const before = cameraFor(o, flat, 5000, width, height, 0)
      const grabbed = { sx: 1100, sy: 400 }
      // The world point under the grabbed pixel.
      const ray = new THREE.Raycaster()
      ray.setFromCamera(new THREE.Vector2((grabbed.sx / width) * 2 - 1, -(grabbed.sy / height) * 2 + 1), before)
      const hit = new THREE.Vector3()
      ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit)
      const mpp = (2 * o.dist * Math.tan((LOOK.fovDeg * DEG) / 2)) / height
      panOrbit(o, 120, -70, mpp)
      const after = cameraFor(o, flat, 5000, width, height, 0)
      const now = onScreen(after, hit, width, height)
      const err = Math.hypot(now.sx - (grabbed.sx + 120), now.sy - (grabbed.sy - 70))
      if (err > 3) bad.push(`yaw ${yawDeg}: the grabbed ground ended ${err.toFixed(1)} px from the mouse`)
    }
    return bad.length ? bad : 'looking down at 3 headings, the ground under the mouse follows a 120 x 70 px drag to within 3 px'
  })

  check('3D view: the tilt starts on the map and ends on the 3D view', () => {
    const bad: string[] = []
    const map = mapOrbit(10, 20, 4, 1080, 1.2, 0, orbit())
    const open = openingOrbit(map, orbit())
    const out = orbit()
    blendOrbit(map, open, ease(0), out)
    if (Math.abs(out.pitch - Math.PI / 2) > 1e-9 || Math.abs(out.dist - map.dist) > 1e-6) bad.push('the start is not the map')
    blendOrbit(map, open, ease(1), out)
    if (Math.abs(out.pitch - LOOK.openPitch) > 1e-9 || Math.abs(out.dist - open.dist) > 1e-6) bad.push('the end is not the 3D view')
    let last = -1
    for (let i = 0; i <= 100; i++) {
      const e = ease(i / 100)
      if (e < last) bad.push(`the ease goes backwards at ${i}%`)
      last = e
    }
    // Back to the map the short way round: after turning 2.2 turns, the map is reached within half a turn.
    const back = mapOrbit(10, 20, 4, 1080, 1.2, 2.2 * Math.PI * 2, orbit())
    if (Math.abs(back.yaw - 2.2 * Math.PI * 2) > Math.PI) bad.push('going back to the map spins the long way round')
    const broken: Orbit = { ...open, dist: Number.NaN }
    if (orbitOk(broken)) bad.push('a NaN in the camera passes the firewall')
    if (filmOffsetFor(0, 1920, 16 / 9, 35) !== 0) bad.push('the map has its lens slid sideways')
    return bad.length ? bad : `opens at ${(LOOK.openPitch / DEG).toFixed(0)} degrees, ${Math.round(open.dist)} m out (the map's camera is ${Math.round(map.dist)} m up); the tilt eases without going back; it turns back the short way; a NaN is caught`
  })

  check('3D view: the spot sits in the middle of the open map', () => {
    // 3D opens with the lens slid left so its spot is in the middle of the map you can see (left of the panel).
    const width = 1920
    const height = 1080
    const shift = 330
    const flat: GroundAt = () => 0
    const o: Orbit = { x: 0, y: 0, z: 0, yaw: 0.4, pitch: 30 * DEG, dist: 500 }
    const c = cameraFor(o, flat, 5000, width, height, shift)
    const at = onScreen(c, o, width, height)
    const err = Math.hypot(at.sx - (width / 2 - shift), at.sy - height / 2)
    return err > 0.5 ? [`the spot shows at (${at.sx.toFixed(1)}, ${at.sy.toFixed(1)}), not (${width / 2 - shift}, ${height / 2})`] : `slid ${shift} px left: the spot shows ${err.toFixed(3)} px from the open map's middle`
  })
}
