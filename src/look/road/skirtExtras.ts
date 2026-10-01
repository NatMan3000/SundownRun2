// ============================================================
//  SKIRT EXTRAS - two more numbers per vertex for the slab sides
// ------------------------------------------------------------
//  The skirt shader (skirtMaterial.ts) draws a light strip along
//  the bottom edge of a raised road, so a bridge reads as a slim
//  lit deck instead of a dark wall. For that it needs to know, at
//  every vertex of the slab's sides and underside:
//
//    aSlabT  how thick the slab is here (metres from the top lip
//            down to the bottom corner). The track builds raised
//            roads thinner than grounded ones, so this varies.
//    aLift   0..1, how clear of the ground the slab's bottom is on
//            this side (0 = sitting in the ground, 1 = at least
//            3 m of air under it). The strip only shows on roads
//            you can see under.
//
//  Both come from the track runtime (the skirt mesh's own uv.x and
//  the terrain height), computed once when the road is built.
//  The runtime's arrays are never changed: these are new arrays
//  added to our own copy of the geometry.
// ============================================================

import type { MeshBuffers, TrackRuntime } from '../../track/types'
import { SLAB_GROUNDED, SLAB_THICKNESS } from '../../track/road'

/** Air under the slab (metres) where the strip starts to show, and where it is full. */
const LIFT_FROM = 0.8
const LIFT_FULL = 3

/**
 * Per-sample slab thickness: uv.x at the bottom corner of each side face.
 * The slab's edge vertices carry uv.x 0 (the lip) and the thickness (the
 * bottom corner); a wall ride's lip and back reuse the same lateral, with
 * other uv.x values, so only values in the track builder's thickness range
 * (lifted .. grounded) count.
 */
function slabThickness(track: TrackRuntime, skirt: MeshBuffers): Float32Array {
  const S = track.samples
  const n = S.count
  const out = new Float32Array(n)
  const uv = skirt.uvs
  const lat = skirt.attributes.aLateral?.array
  const half = skirt.attributes.aHalfWidth?.array
  if (!lat || !half) return out.fill(SLAB_THICKNESS)
  const lo = SLAB_THICKNESS - 0.01
  const hi = SLAB_GROUNDED + 0.01
  const vertices = uv.length / 2
  for (let v = 0; v < vertices; v++) {
    const u = uv[v * 2]
    if (u < lo || u > hi || Math.abs(Math.abs(lat[v]) - half[v]) > 1e-3) continue
    const i = (((Math.round(uv[v * 2 + 1] / S.ds) % n) + n) % n)
    if (u > out[i]) out[i] = u
  }
  // a sample the scan missed borrows its neighbour's value
  for (let i = 0; i < n; i++) if (out[i] <= 0) out[i] = out[(i + n - 1) % n] || SLAB_THICKNESS
  return out
}

/** 0..1 air under each side's bottom corner, per sample (smoothed along the road so it never flickers). */
function sideLift(track: TrackRuntime, thick: Float32Array, side: -1 | 1): Float32Array {
  const S = track.samples
  const n = S.count
  const raw = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const l = side * S.halfWidth[i]
    const t = thick[i]
    const x = S.px[i] + S.rx[i] * l - S.ux[i] * t
    const y = S.py[i] + S.ry[i] * l - S.uy[i] * t
    const z = S.pz[i] + S.rz[i] * l - S.uz[i] * t
    const air = y - track.terrainHeight(x, z)
    raw[i] = Number.isFinite(air) ? Math.min(1, Math.max(0, (air - LIFT_FROM) / (LIFT_FULL - LIFT_FROM))) : 0
  }
  // box blur over about 8 m, so the strip eases in and out
  const r = Math.max(1, Math.round(4 / S.ds))
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let sum = 0
    for (let k = -r; k <= r; k++) sum += raw[(i + k + n) % n]
    out[i] = sum / (2 * r + 1)
  }
  return out
}

/** The aSlabT and aLift arrays for the skirt mesh (one value per vertex), and the per-sample thickness. */
export function skirtExtras(track: TrackRuntime): { slabT: Float32Array; lift: Float32Array; thickness: Float32Array } {
  const skirt = track.meshes.skirt
  const S = track.samples
  const n = S.count
  const thick = slabThickness(track, skirt)
  const liftL = sideLift(track, thick, -1)
  const liftR = sideLift(track, thick, 1)
  const uv = skirt.uvs
  const lat = skirt.attributes.aLateral?.array
  const vertices = uv.length / 2
  const slabT = new Float32Array(vertices)
  const lift = new Float32Array(vertices)
  for (let v = 0; v < vertices; v++) {
    const i = (((Math.round(uv[v * 2 + 1] / S.ds) % n) + n) % n)
    slabT[v] = thick[i]
    const l = lat ? lat[v] : 0
    // the underside's middle sits between the two sides: take the larger
    lift[v] = l < -1e-3 ? liftL[i] : l > 1e-3 ? liftR[i] : Math.max(liftL[i], liftR[i])
  }
  return { slabT, lift, thickness: thick }
}
