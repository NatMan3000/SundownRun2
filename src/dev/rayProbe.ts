// ============================================================
//  RAY PROBE - measure the real collision surface from the console
// ------------------------------------------------------------
//  The track's frames say where the road SHOULD be; the colliders
//  are what the wheels actually hit. This casts a ray through the
//  physics world (the same filter the wheels use) so the two can be
//  compared - e.g. walk a loop and look for a seam or a dip:
//
//    window.__dev.surfaceAt(s, lateral = 0, above = 2)
//      -> { s, gap }   gap = how far the hit is from the road the
//                      frame describes (0 = exactly there), metres
//
//  Dev only. No allocation worries: it is a console tool.
// ============================================================

import * as THREE from 'three'
import { registerDev } from '../core/devHandles'
import { GROUPS, surfaceOf } from '../core/physics'
import { getTrack } from '../track/current'
import type { TrackFrame } from '../track/types'
import { links } from '../vehicle/links'

const frame: TrackFrame = {
  s: 0,
  position: new THREE.Vector3(),
  tangent: new THREE.Vector3(),
  up: new THREE.Vector3(),
  right: new THREE.Vector3(),
  halfWidth: 7,
  bank: 0,
  curvature: 0,
  surface: 'road',
}

function surfaceAt(s: number, lateral = 0, above = 2): unknown {
  const t = getTrack()
  const world = links.world
  const rapier = links.rapier
  if (!t || !world || !rapier) return 'no track or physics'
  const f = t.frameAt(Number(s), frame)
  const o = f.position.clone().addScaledVector(f.right, Number(lateral) || 0).addScaledVector(f.up, Number(above) || 2)
  const ray = new rapier.Ray({ x: o.x, y: o.y, z: o.z }, { x: -f.up.x, y: -f.up.y, z: -f.up.z })
  const hit = world.castRayAndGetNormal(ray, (Number(above) || 2) * 3, true, undefined, GROUPS.wheelRay, undefined, links.playerBody ?? undefined)
  if (!hit) return { s: +f.s.toFixed(2), hit: false }
  return {
    s: +f.s.toFixed(2),
    surface: surfaceOf(hit.collider.handle),
    gap: +(hit.timeOfImpact - (Number(above) || 2)).toFixed(3),
    normalVsUp: +(hit.normal.x * f.up.x + hit.normal.y * f.up.y + hit.normal.z * f.up.z).toFixed(4),
  }
}

/**
 * What lies UNDER the road: from s0 to s1 every ds metres, at each lateral offset, cast from the
 * road surface down its own normal and report the first collider that is not the road itself
 * (ground tiles, skirts ...). gap = how far below the road surface it is along the road's normal
 * (negative = it pokes up through the road); along = its normal's tilt along the road's direction
 * (deg; + = facing back toward a car driving forward, the way a speculative contact pushes).
 * Returns the worst (smallest gap) rows first.
 */
function groundUnder(s0: number, s1: number, ds = 2, lats: number[] = [-6, -4, -2, 0, 2, 4, 6], depth = 4): unknown {
  const t = getTrack()
  const world = links.world
  const rapier = links.rapier
  if (!t || !world || !rapier) return 'no track or physics'
  const rows: { s: number; lat: number; gap: number; what: string; nUp: number; along: number }[] = []
  const notRoad = (c: { handle: number }) => {
    const k = surfaceOf(c.handle)
    return k !== 'road' && k !== 'loop' && k !== 'wall' && k !== 'ramp'
  }
  for (let s = Number(s0); s <= Number(s1); s += Math.max(0.25, Number(ds) || 2)) {
    const f = t.frameAt(s, frame)
    for (const lat of lats) {
      const o = f.position.clone().addScaledVector(f.right, lat).addScaledVector(f.up, 1)
      const ray = new rapier.Ray({ x: o.x, y: o.y, z: o.z }, { x: -f.up.x, y: -f.up.y, z: -f.up.z })
      const hit = world.castRayAndGetNormal(ray, depth + 1, true, undefined, GROUPS.wheelRay, undefined, links.playerBody ?? undefined, notRoad as never)
      if (!hit) continue
      const n = hit.normal
      rows.push({
        s: +s.toFixed(1),
        lat,
        gap: +(hit.timeOfImpact - 1).toFixed(3),
        what: surfaceOf(hit.collider.handle),
        nUp: +(n.x * f.up.x + n.y * f.up.y + n.z * f.up.z).toFixed(3),
        along: +((Math.asin(Math.max(-1, Math.min(1, -(n.x * f.tangent.x + n.y * f.tangent.y + n.z * f.tangent.z)))) * 180) / Math.PI).toFixed(1),
      })
    }
  }
  rows.sort((a, b) => a.gap - b.gap)
  return { count: rows.length, worst: rows.slice(0, 40) }
}

registerDev(
  'groundUnder',
  groundUnder as never,
  'groundUnder(s0, s1, ds = 2, lats = [-6..6], depth = 4): the first non-road collider under the road surface; gap below it (m), its normal vs the road up, its tilt along the road (deg)',
)

registerDev('surfaceAt', surfaceAt as never, 'surfaceAt(s, lateral = 0, above = 2): cast a wheel-style ray at the road frame; gap = real collider vs the frame (m), normalVsUp = their alignment')
