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

registerDev('surfaceAt', surfaceAt as never, 'surfaceAt(s, lateral = 0, above = 2): cast a wheel-style ray at the road frame; gap = real collider vs the frame (m), normalVsUp = their alignment')
