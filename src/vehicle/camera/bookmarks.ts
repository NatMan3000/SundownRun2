// ============================================================
//  CAMERA BOOKMARKS - fixed shots for checkers and screenshots
// ------------------------------------------------------------
//  ?cam=<name> in the URL, or window.__dev.cam('<name>') live:
//
//    start      behind the grid, down the straight toward the line
//    aerial     a high three-quarter view of the whole track
//    piece:<i>  looking at track piece i (loop, wall ride, boost ...)
//    s:<m>      trackside at m metres along the road
//    free       back to the normal driving camera
//
//  Every shot is computed from the track file's runtime, so it
//  works on any track, drawn ones included.
// ============================================================

import * as THREE from 'three'
import type { TrackRuntime } from '../../track/types'
import { frameAt } from '../trackNav'

export interface Shot {
  position: THREE.Vector3
  look: THREE.Vector3
}

/** Fill `out` with the named shot. Returns false for an unknown name or a missing piece. */
export function computeShot(name: string, track: TrackRuntime, out: Shot): boolean {
  if (name === 'start') {
    const back = frameAt(track, -38)
    out.position.copy(back.position).addScaledVector(back.up, 4.5).addScaledVector(back.right, 2.5)
    const ahead = frameAt(track, 140)
    out.look.copy(ahead.position).addScaledVector(ahead.up, 3)
    return true
  }
  if (name === 'aerial') {
    const m = track.minimap
    const cx = (m.minX + m.maxX) / 2
    const cz = (m.minZ + m.maxZ) / 2
    const size = Math.max(60, m.maxX - m.minX, m.maxZ - m.minZ)
    const gy = track.terrainHeight(cx, cz)
    out.position.set(cx - size * 0.42, (Number.isFinite(gy) ? gy : 0) + size * 0.55, cz + size * 0.6)
    out.look.set(cx, Number.isFinite(gy) ? gy : 0, cz)
    return true
  }
  if (name.startsWith('piece:')) {
    const i = Number(name.slice(6))
    const p = Number.isInteger(i) ? track.pieces[i] : undefined
    if (!p) return false
    const f = frameAt(track, p.s0 - 32)
    out.position.copy(f.position).addScaledVector(f.right, f.halfWidth + 8).addScaledVector(f.up, 7)
    out.look.set(p.center.x, p.center.y, p.center.z)
    return true
  }
  if (name.startsWith('s:')) {
    const s = Number(name.slice(2))
    if (!Number.isFinite(s)) return false
    const f = frameAt(track, s)
    out.position.copy(f.position).addScaledVector(f.right, f.halfWidth + 9).addScaledVector(f.up, 3.5).addScaledVector(f.tangent, -6)
    out.look.copy(f.position).addScaledVector(f.up, 1)
    return true
  }
  return false
}
