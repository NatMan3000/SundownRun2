// ============================================================
//  SELF-TEST: PICKING IN 3D - rows for selfTest.ts
// ------------------------------------------------------------
//  The editor's tools work in the 3D view by asking which road (or
//  ground) is under the mouse, seen through the 3D camera
//  (look3dPick.ts, look3dSpace.ts). These rows check that on real
//  built tracks, with real three.js cameras placed the way
//  TopDownCamera.tsx places them:
//
//    there and back   a road spot shown on screen is picked at that
//                     very spot (and shows back at the same pixel);
//                     just off the road's edge (inside the map's reach,
//                     12 pixels, never under 4 m) still picks it, twice
//                     that far does not
//    a crossing       looking down at a bridge picks the bridge, and
//                     looking along the road under it picks that road,
//                     both as the built road and as the editor's road
//    behind a hill    a road hidden by a hill is not picked through it
//                     (and the same road with nothing in the way is)
// ============================================================

import * as THREE from 'three'
import afterglowJson from '../../tracks/afterglow.json'
import { validateTrack } from '../track/validate'
import { buildTrack } from '../track/build'
import type { TrackRuntime } from '../track/types'
import { cleanStroke } from './cleanup'
import { draftFile, roadBound } from './draftFile'
import { DEFAULT_BASE_WORLD } from './draftFile'
import { roadCurve, frameAt } from './road'
import { LOOK, type Orbit, aim, placeCamera, poseCamera } from './look3dMath'
import { PICK_REACH, RoadPicker, project } from './look3dPick'
import { nearestOnRoadHeading } from './look3dSpace'

type Check = (name: string, fn: () => string[] | string) => void

const W = 1920
const H = 1080
const DEG = Math.PI / 180

/** A 3D camera placed by the same steps as TopDownCamera.tsx for an Orbit over this track's ground. */
function orbitCamera(o: Orbit, picker: RoadPicker): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(LOOK.fovDeg, W / H, 0.5, 11000)
  const ground = (x: number, z: number) => picker.ground(x, z)
  const pos = placeCamera(o, ground, picker.track.world.half, { x: 0, y: 0, z: 0 })
  poseCamera(c, pos, aim(pos, o, o.yaw, { yaw: 0, pitch: 0 }))
  c.updateProjectionMatrix()
  return c
}

/** A camera at `from` looking at `to`. */
function lookCamera(from: THREE.Vector3, to: THREE.Vector3): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(LOOK.fovDeg, W / H, 0.5, 11000)
  c.position.copy(from)
  c.lookAt(to)
  c.updateMatrixWorld()
  c.updateProjectionMatrix()
  return c
}

/** True when the ground comes within `margin` metres of the straight line between a and b (checked every metre, not the picker's way). */
function groundInTheWay(picker: RoadPicker, a: THREE.Vector3, b: THREE.Vector3, margin: number): number {
  const len = a.distanceTo(b)
  let worst = -Infinity
  for (let m = 2; m < len - 4; m += 1) {
    const t = m / len
    const x = a.x + (b.x - a.x) * t
    const y = a.y + (b.y - a.y) * t
    const z = a.z + (b.z - a.z) * t
    worst = Math.max(worst, picker.ground(x, z) + margin - y)
  }
  return worst
}

let afterglow: TrackRuntime | null = null
function afterglowTrack(): TrackRuntime {
  if (!afterglow) {
    const v = validateTrack(afterglowJson)
    if (!v.ok || !v.track) throw new Error('afterglow did not validate')
    afterglow = buildTrack(v.track, {})
  }
  return afterglow
}

/** A figure-eight drawn and cleaned up by the editor: its crossing becomes a bridge. */
function eightTrack(): { runtime: TrackRuntime; points: ReturnType<typeof cleanStroke>['points'] } | null {
  const stroke = Array.from({ length: 600 }, (_, k) => {
    const t = (k / 600) * 1.1 + 0.1
    return { x: 260 * Math.sin(t * Math.PI * 2), z: 130 * Math.sin(2 * t * Math.PI * 2) }
  })
  const res = cleanStroke(stroke, { bound: roadBound(DEFAULT_BASE_WORLD.environment), width: 14 })
  if (!res.ok) return null
  const v = validateTrack(draftFile({ id: 'selftest-pick-eight', name: 'Self-test pick eight', points: res.points }))
  if (!v.ok || !v.track) return null
  return { runtime: buildTrack(v.track, {}), points: res.points }
}

export function pickRows(check: Check): void {
  check('3D picking: a road spot on screen picks that spot, and shows back at the same pixel; the reach is the map\'s', () => {
    const t = afterglowTrack()
    const picker = new RoadPicker(t)
    const S = t.samples
    const bad: string[] = []
    const scr = { sx: 0, sy: 0, depth: 0 }
    let tested = 0
    let worstM = 0
    let worstPx = 0
    let reachIn = 0
    let reachOut = 0
    let ms = 0
    let picks = 0
    let infront = 0
    for (let i = 0; i < S.count; i += 97) {
      if (S.surface[i] !== 0) continue
      for (let yaw = 0; yaw < 360; yaw += 72) {
        for (const [pitch, dist] of [
          [25, 90],
          [45, 260],
          [70, 600],
        ]) {
          const o: Orbit = { x: S.px[i], y: picker.ground(S.px[i], S.pz[i]), z: S.pz[i], yaw: yaw * DEG, pitch: pitch * DEG, dist }
          const cam = orbitCamera(o, picker)
          if (!project(cam, S.px[i], S.py[i], S.pz[i], W, H, scr)) continue
          if (scr.sx < 40 || scr.sx > W - 40 || scr.sy < 40 || scr.sy > H - 40) continue
          // Only where nothing hides it (checked a metre at a time along the line, not the picker's way).
          if (groundInTheWay(picker, cam.position, new THREE.Vector3(S.px[i], S.py[i], S.pz[i]), 0.3) > 0) continue
          const sx = scr.sx
          const sy = scr.sy
          const depth = scr.depth
          const t0 = performance.now()
          const hit = picker.pick(cam, sx, sy, W, H)
          ms += performance.now() - t0
          picks++
          tested++
          if (!hit || !hit.direct) {
            bad.push(`sample ${i} from yaw ${yaw} pitch ${pitch} dist ${dist}: ${hit ? 'only a near miss' : 'nothing'} picked`)
            continue
          }
          const m = Math.hypot(hit.x - S.px[i], hit.y - S.py[i], hit.z - S.pz[i])
          const mpp = (2 * depth * Math.tan((LOOK.fovDeg * DEG) / 2)) / H
          if (m > Math.max(0.6, 2 * mpp)) {
            // Another bit of road in front of it (a bridge over it) rightly wins, if it really is nearer the camera.
            const apart = Math.min(Math.abs(hit.i - i), S.count - Math.abs(hit.i - i))
            if (apart > 20 && cam.position.distanceTo(new THREE.Vector3(hit.x, hit.y, hit.z)) < depth) {
              infront++
              continue
            }
            bad.push(`sample ${i} from yaw ${yaw} pitch ${pitch}: picked ${m.toFixed(2)} m away`)
          }
          worstM = Math.max(worstM, m)
          if (project(cam, hit.x, hit.y, hit.z, W, H, scr)) {
            const px = Math.hypot(scr.sx - sx, scr.sy - sy)
            worstPx = Math.max(worstPx, px)
            if (px > 1) bad.push(`sample ${i}: the pick shows ${px.toFixed(2)} px from the mouse`)
          }
          // The reach: out from the road's right edge on screen, half the reach (picked) and twice it (not this road).
          const hw = S.halfWidth[i]
          if (!project(cam, S.px[i] + S.rx[i] * hw, S.py[i] + S.ry[i] * hw, S.pz[i] + S.rz[i] * hw, W, H, scr)) continue
          const ex = scr.sx
          const ey = scr.sy
          const ol = Math.hypot(ex - sx, ey - sy)
          if (ol < 2) continue
          const ux = (ex - sx) / ol
          const uy = (ey - sy) / ol
          const reach = Math.max(PICK_REACH.px, PICK_REACH.metres / mpp)
          if (reach > 250) continue
          // The reach is across the road (as on the map): only where the road crosses the screen, not where it runs end-on away.
          const j = (i + 5) % S.count
          if (!project(cam, S.px[j], S.py[j], S.pz[j], W, H, scr)) continue
          const al = Math.hypot(scr.sx - sx, scr.sy - sy)
          if (al < 2 || Math.abs(((scr.sx - sx) * ux + (scr.sy - sy) * uy) / al) > 0.5) continue
          let t1 = performance.now()
          const inHit = picker.pick(cam, ex + ux * reach * 0.5, ey + uy * reach * 0.5, W, H)
          ms += performance.now() - t1
          picks++
          const near = (h: typeof inHit) => !!h && Math.min(Math.abs(h.i - i), S.count - Math.abs(h.i - i)) * S.ds <= 10
          // Picked: this road, or a road at least as near the mouse on screen (the nearest wins, as on the map).
          if (near(inHit) || (inHit && (inHit.direct || inHit.px <= reach * 0.5 + 1.5))) reachIn++
          else bad.push(`sample ${i} yaw ${yaw} pitch ${pitch}: ${(reach * 0.5).toFixed(0)} px off the edge (inside the ${reach.toFixed(0)} px reach) did not pick it (${inHit ? `picked sample ${inHit.i}, ${inHit.direct ? 'direct' : `${inHit.px.toFixed(1)} px off`}` : 'nothing'})`)
          t1 = performance.now()
          const outHit = picker.pick(cam, ex + ux * reach * 2.2, ey + uy * reach * 2.2, W, H)
          ms += performance.now() - t1
          picks++
          if (near(outHit)) bad.push(`sample ${i} yaw ${yaw} pitch ${pitch}: ${(reach * 2.2).toFixed(0)} px off the edge (past the ${reach.toFixed(0)} px reach) still picked it`)
          else reachOut++
          if (bad.length > 5) return bad
        }
      }
    }
    if (tested < 40) bad.push(`only ${tested} spots could be tested`)
    return bad.length
      ? bad
      : `${tested} road spots on Afterglow from 15 camera angles each: picked within ${worstM.toFixed(2)} m (${infront} with a bridge in front, rightly picked instead), shown back within ${worstPx.toFixed(2)} px; half the reach off the edge picked ${reachIn} times, over twice it never (${reachOut}); ${Math.round((ms / picks) * 1000)} microseconds a pick (${picks} picks)`
  })

  check('3D picking: at a crossing you get the road you are looking at (the bridge from above, the road under it from below)', () => {
    const eight = eightTrack()
    if (!eight) return ['the figure-eight did not build']
    const t = eight.runtime
    const picker = new RoadPicker(t)
    const S = t.samples
    // The crossing: two samples far apart along the road but on top of each other.
    let up = -1
    let low = -1
    let best = Infinity
    for (let i = 0; i < S.count; i += 2) {
      for (let j = 0; j < S.count; j += 2) {
        const apart = Math.min(Math.abs(i - j), S.count - Math.abs(i - j))
        if (apart < 100) continue
        const d = Math.hypot(S.px[i] - S.px[j], S.pz[i] - S.pz[j])
        if (d < best && S.py[i] - S.py[j] > 4) {
          best = d
          up = i
          low = j
        }
      }
    }
    if (up < 0 || best > 3) return [`no bridge found on the figure-eight (closest ${best.toFixed(1)} m)`]
    const bad: string[] = []
    const rc = roadCurve(eight.points)
    const same = (a: number, b: number, within: number) => Math.min(Math.abs(a - b), S.count - Math.abs(a - b)) <= within
    const scr = { sx: 0, sy: 0, depth: 0 }
    /** The editor's road at the pick heads the same way as the built road the pick is on. */
    const editorAgrees = (hit: NonNullable<ReturnType<RoadPicker['pick']>>, want: number) => {
      const e = nearestOnRoadHeading(rc, { x: hit.x, z: hit.z }, hit.dirX, hit.dirZ)
      const f = frameAt(rc, e.at)
      const tl = Math.hypot(S.tx[want], S.tz[want]) || 1
      return (f.dir.x * S.tx[want] + f.dir.z * S.tz[want]) / tl
    }
    // 1. From above, at a slant, from four sides: the crossing's spot picks the bridge.
    for (const yaw of [20, 110, 200, 290]) {
      const o: Orbit = { x: S.px[up], y: S.py[low], z: S.pz[up], yaw: yaw * DEG, pitch: 55 * DEG, dist: 140 }
      const cam = orbitCamera(o, picker)
      if (!project(cam, S.px[up], S.py[up], S.pz[up], W, H, scr)) {
        bad.push(`from above, yaw ${yaw}: the bridge is off screen`)
        continue
      }
      const hit = picker.pick(cam, scr.sx, scr.sy, W, H)
      if (!hit || !same(hit.i, up, 8)) bad.push(`from above, yaw ${yaw}: picked ${hit ? `sample ${hit.i}` : 'nothing'}, not the bridge (sample ${up})`)
      else if (editorAgrees(hit, up) < 0.95) bad.push(`from above, yaw ${yaw}: the editor's road there heads another way (${editorAgrees(hit, up).toFixed(2)})`)
    }
    // 2. Low on the road underneath, looking along it under the bridge: the road beyond picks that road.
    const step = Math.max(1, Math.round(1 / S.ds))
    for (const sign of [1, -1]) {
      const a = (low - sign * 45 * step + S.count * 4) % S.count
      const b = (low + sign * 25 * step + S.count * 4) % S.count
      const from = new THREE.Vector3(S.px[a], S.py[a] + 2.5, S.pz[a])
      const to = new THREE.Vector3(S.px[b], S.py[b], S.pz[b])
      const cam = lookCamera(from, to)
      if (!project(cam, to.x, to.y, to.z, W, H, scr)) {
        bad.push(`under the bridge (${sign > 0 ? 'forwards' : 'backwards'}): the road beyond is off screen`)
        continue
      }
      const hit = picker.pick(cam, scr.sx, scr.sy, W, H)
      if (!hit || !same(hit.i, b, 6)) bad.push(`under the bridge (${sign > 0 ? 'forwards' : 'backwards'}): picked ${hit ? `sample ${hit.i} (${hit.y.toFixed(1)} m up)` : 'nothing'}, not the road beyond it (sample ${b}, ${S.py[b].toFixed(1)} m up)`)
      else if (editorAgrees(hit, b) < 0.95) bad.push(`under the bridge: the editor's road there heads another way`)
    }
    // 3. The editor's road at the very spot where the two middle lines cross (as near to one road as the
    //    other): only the heading of the road you picked can say which, and it must.
    let mid: { x: number; z: number } | null = null
    for (let a = up - 12; a < up + 12 && !mid; a++) {
      for (let b = low - 12; b < low + 12 && !mid; b++) {
        const i = (a + S.count) % S.count
        const j = (b + S.count) % S.count
        const i2 = (i + 1) % S.count
        const j2 = (j + 1) % S.count
        const rx = S.px[i2] - S.px[i]
        const rz = S.pz[i2] - S.pz[i]
        const qx = S.px[j2] - S.px[j]
        const qz = S.pz[j2] - S.pz[j]
        const den = rx * qz - rz * qx
        if (Math.abs(den) < 1e-9) continue
        const t = ((S.px[j] - S.px[i]) * qz - (S.pz[j] - S.pz[i]) * qx) / den
        const u = ((S.px[j] - S.px[i]) * rz - (S.pz[j] - S.pz[i]) * rx) / den
        if (t >= 0 && t <= 1 && u >= 0 && u <= 1) mid = { x: S.px[i] + rx * t, z: S.pz[i] + rz * t }
      }
    }
    if (!mid) bad.push('could not find where the two roads cross')
    else
      for (const [want, name] of [
        [up, 'the bridge'],
        [low, 'the road under it'],
      ] as const) {
        const tl = Math.hypot(S.tx[want], S.tz[want]) || 1
        const e = nearestOnRoadHeading(rc, mid, S.tx[want] / tl, S.tz[want] / tl)
        const f = frameAt(rc, e.at)
        if ((f.dir.x * S.tx[want] + f.dir.z * S.tz[want]) / tl < 0.95) bad.push(`where the roads cross, heading along ${name}: the editor picked the other road`)
      }
    return bad.length ? bad : `the figure-eight's bridge (${(S.py[up] - S.py[low]).toFixed(1)} m over the road under it): from above at 4 angles the bridge is picked; looking along the road under it both ways, the road beyond the bridge is; the editor's road agrees every time, even exactly where the two roads cross`
  })

  check('3D picking: a road behind a hill is never picked through the hill', () => {
    const t = afterglowTrack()
    const picker = new RoadPicker(t)
    const S = t.samples
    const scr = { sx: 0, sy: 0, depth: 0 }
    const bad: string[] = []
    let hidden = 0
    let controls = 0
    for (let i = 0; i < S.count && hidden < 6; i += 61) {
      if (S.surface[i] !== 0) continue
      const road = new THREE.Vector3(S.px[i], S.py[i], S.pz[i])
      for (let yaw = 0; yaw < 360 && hidden < 6; yaw += 30) {
        for (const dist of [120, 220, 380]) {
          const cx = S.px[i] + Math.sin(yaw * DEG) * dist
          const cz = S.pz[i] + Math.cos(yaw * DEG) * dist
          if (Math.abs(cx) > t.world.half - 60 || Math.abs(cz) > t.world.half - 60) continue
          const from = new THREE.Vector3(cx, picker.ground(cx, cz) + 2.5, cz)
          // A hill at least 4 m over the line of sight, somewhere between.
          if (groundInTheWay(picker, from, road, 0) < 4) continue
          const cam = lookCamera(from, road)
          if (!project(cam, road.x, road.y, road.z, W, H, scr)) continue
          const hit = picker.pick(cam, scr.sx, scr.sy, W, H)
          const sameRoad = !!hit && Math.hypot(hit.x - road.x, hit.z - road.z) < 30
          if (sameRoad) bad.push(`sample ${i} from ${dist} m away (yaw ${yaw}) behind a hill: picked through the hill`)
          // The control: the same road from straight above it is picked.
          const above = lookCamera(new THREE.Vector3(road.x + 1, road.y + 300, road.z), road)
          if (project(above, road.x, road.y, road.z, W, H, scr)) {
            const seen = picker.pick(above, scr.sx, scr.sy, W, H)
            if (!seen || Math.hypot(seen.x - road.x, seen.z - road.z) > 2) bad.push(`sample ${i} from straight above: not picked`)
            else controls++
          }
          hidden++
          break
        }
      }
    }
    if (hidden < 3) bad.push(`only ${hidden} road spots behind a hill found to test`)
    return bad.length ? bad : `${hidden} road spots behind a hill on Afterglow (a hill 4 m or more over the line of sight): none picked through it; each picked from above (${controls})`
  })
}
