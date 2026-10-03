// ============================================================
//  CUTTINGS - checks for road dug down into the ground
// ------------------------------------------------------------
//  A road can go below the ground: a negative `lift` (the editor's
//  Height tool digs down to 10 m, and "Send this road under" makes
//  an underpass). The ground is then cut away into a cutting with
//  sloped sides (terrain.ts), and where another road crosses over
//  it, that road becomes a short bridge (road.ts, "over a cutting").
//
//  Two gates in runTrackGates (gates.ts) come from here:
//
//    cutting   the sides of every cutting are a slope a car can
//              drive or slide down, never a cliff: no steeper than
//              CUT_SLOPE_MAX_DEG, and no step bigger than
//              CUT_STEP_MAX between ground points a grid cell apart.
//    dips      a car doesn't take off at the lip of a dip (a tunnel's
//              ramps down included): where
//              the road tips over the top of its ramp down, the
//              road falls away from the car no faster than gravity
//              can hold it on (CREST_LIMIT, the bank-roll crests'
//              own limit), at the speed a car is likely to be doing
//              there. The same rule the editor's Height tool uses
//              before it lets Josh dig (editor/raise.ts).
//
//  Pure: reads the built track, changes nothing.
// ============================================================

import { trackInternals } from './build'
import { CREST_CHECK_KMH, CREST_LIMIT } from './bankRolls'
import { SAME_STRETCH } from './road'
import { averagedHeight, shoulderWidth } from './terrain'
import { SURFACE_CODE, type TrackRuntime } from './types'

const G = 9.81
/** How far past a bridge's deck edge its clearance cut reaches (terrain.ts flattenToRoad: hw + 3). */
const BRIDGE_CUT_REACH = 3

/** Road the file digs at least this far (metres) below its ground is in a cutting (the `cutting` gate looks at its sides). */
export const CUT_MIN_DEPTH = 1
/**
 * The steepest a cutting's side may be, degrees from flat: steeper is a cliff, not a slope.
 * About 45: the builder's own shoulders reach 37 degrees beside an 8 m underpass and 47
 * where Afterglow's road cuts 10 m into a hillside that keeps rising beyond the cutting.
 */
export const CUT_SLOPE_MAX_DEG = 50
/**
 * The biggest step (metres) in a cutting's side: how much the ground's rise over one grid
 * cell (3 m) may change from the cell before. A smooth slope changes gently; a ledge, or
 * the top or foot of a cliff, changes all at once. The builder's own shoulder bends by up
 * to 1.5 m a cell beside an 8 m underpass and 1.7 m beside a 10 m dig (more on a hillside),
 * so 2 m: a wedge of ground left standing in a cutting stepped 2.9 m.
 */
export const CUT_STEP_MAX = 2
/** A dip is road the track file puts at least this far (metres) below its ground somewhere along it... */
export const DIP_MIN_DEPTH = 3
/** ...and it runs from where the road goes this far below the ground to where it comes back up. */
const DIP_EDGE = 0.25
/** The speed a car arrives at a dip is the fastest the racing line plans from this far before it to this far after (metres). */
const DIP_MARGIN = 30
/** A car can be going this much faster than the racing line plans (a later brake, a boost): the crest gate's own margin. */
const LINE_MARGIN = 1.15

/**
 * How far either way (metres) the take-off check looks along a dip or hill `metres`
 * long: an eighth of it, 6 to 20 m. Long enough that ripples a few metres long (a
 * car's springs soak those up) don't count, short enough to see the lip's true
 * sharpness. (The editor's Height tool judges a stretch it raises or digs the same way.)
 */
export function crestHalf(metres: number): number {
  return Math.max(6, Math.min(20, metres / 8))
}

/**
 * At sample i of the built road: the share of gravity's pull a car at `v` m/s needs to
 * stay on where the road crests (1 = it just floats), measured from the change of
 * slope over 2 x `half` metres. 0 where the road dips (it presses the car on) or isn't
 * plain road.
 */
export function crestShareAt(t: TrackRuntime, i: number, v: number, half: number): number {
  const S = t.samples
  const W = Math.max(1, Math.round(half / S.ds))
  const a = (i - W + S.count) % S.count
  const b = (i + W) % S.count
  if (S.surface[a] !== SURFACE_CODE.road || S.surface[i] !== SURFACE_CODE.road || S.surface[b] !== SURFACE_CODE.road) return 0
  const ga = S.ty[a] / (Math.hypot(S.tx[a], S.tz[a]) || 1)
  const gb = S.ty[b] / (Math.hypot(S.tx[b], S.tz[b]) || 1)
  const crest = -(gb - ga) / (2 * W * S.ds)
  if (crest <= 0 || S.uy[i] <= 0) return 0
  return (v * v * crest) / (G * S.uy[i])
}

/** Per sample: metres the road sits below the natural ground (where it would be unbanked; negative = above). */
function depthBelowGround(t: TrackRuntime): Float32Array | null {
  const x = trackInternals(t)
  if (!x) return null
  const S = t.samples
  const out = new Float32Array(S.count)
  for (let i = 0; i < S.count; i++) out[i] = x.nat.height(S.px[i], S.pz[i]) - (S.py[i] - x.pivotLift[i])
  return out
}

/**
 * The sides of every cutting: walking out from both edges of every road sample the
 * track file digs CUT_MIN_DEPTH or more below its ground (dugDepth: a negative lift, or a
 * `y` that low; a road riding the smoothed ground through a hilltop is the world's own
 * cut, not judged here), across its shoulder to the natural ground,
 * a ground point every half metre. The steepest the ground gets there (degrees from
 * flat) and the biggest change of grade from one grid cell to the next (a ledge, a
 * cliff's top or foot). Ground under another stretch of road, or near it (BRIDGE_CUT_REACH,
 * a grid cell and a metre past its edge), is left out: under a bridge the ground is cut
 * clear of its slab on purpose (terrain.ts, 3 m past the deck's edges, steep-sided where
 * the road below already runs in a cut), and the grid's triangles reach a cell out from there.
 * null when no road is that far down.
 */
export function cuttingSides(t: TrackRuntime): { slopeDeg: number; slopeAt: number; step: number; stepAt: number; metres: number } | null {
  const S = t.samples
  const depth = depthBelowGround(t)
  const dug = dugDepth(t)
  if (!depth || !dug) return null
  const cell = t.terrain.cellSize
  const tunnelSlot = trackInternals(t)?.tunnels.slot
  // Road samples bucketed on a 16 m grid, so "is this ground under another road?" only looks nearby.
  const CELL = 16
  const key = (cx: number, cz: number) => cx * 100003 + cz
  const cells = new Map<number, number[]>()
  for (let i = 0; i < S.count; i++) {
    const k = key(Math.floor(S.px[i] / CELL), Math.floor(S.pz[i] / CELL))
    const list = cells.get(k)
    if (list) list.push(i)
    else cells.set(k, [i])
  }
  const same = Math.round(SAME_STRETCH / S.ds)
  const underOther = (i: number, x: number, z: number): boolean => {
    const cx = Math.floor(x / CELL)
    const cz = Math.floor(z / CELL)
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        for (const j of cells.get(key(cx + dx, cz + dz)) ?? []) {
          const apart = Math.abs(i - j)
          if (Math.min(apart, S.count - apart) < same) continue
          const ex = x - S.px[j]
          const ez = z - S.pz[j]
          if (Math.abs(ex * S.tx[j] + ez * S.tz[j]) > S.ds) continue
          if (Math.abs(ex * S.rx[j] + ez * S.rz[j]) <= S.halfWidth[j] + BRIDGE_CUT_REACH + cell + 1) return true
        }
      }
    }
    return false
  }
  const STEP = 0.5
  const perCell = Math.round(cell / STEP)
  const e = 0.25
  let slopeDeg = 0
  let slopeAt = 0
  let step = 0
  let stepAt = 0
  let sunk = 0
  const hs: number[] = []
  for (let i = 0; i < S.count; i++) {
    // (A tunnel's stretch is walled in, not sloped: the tunnel check judges it.)
    if (S.surface[i] !== SURFACE_CODE.road || dug[i] < CUT_MIN_DEPTH || depth[i] < CUT_MIN_DEPTH || tunnelSlot?.[i]) continue
    sunk++
    const hw = S.halfWidth[i]
    const rl = Math.hypot(S.rx[i], S.rz[i]) || 1
    const ox = S.rx[i] / rl
    const oz = S.rz[i] / rl
    const reach = shoulderWidth(depth[i]) + 3
    for (const side of [-1, 1]) {
      hs.length = 0
      for (let d = 0; d <= reach; d += STEP) {
        const x = S.px[i] + ox * side * (hw + d)
        const z = S.pz[i] + oz * side * (hw + d)
        if (underOther(i, x, z)) {
          hs.push(NaN)
          continue
        }
        const h = t.terrainHeight(x, z)
        hs.push(h)
        const gx = (t.terrainHeight(x + e, z) - t.terrainHeight(x - e, z)) / (2 * e)
        const gz = (t.terrainHeight(x, z + e) - t.terrainHeight(x, z - e)) / (2 * e)
        const deg = (Math.atan(Math.hypot(gx, gz)) * 180) / Math.PI
        if (deg > slopeDeg) {
          slopeDeg = deg
          slopeAt = i * S.ds
        }
      }
      // A step: the ground's rise over one grid cell changes by this much from the cell before.
      for (let k = 2 * perCell; k < hs.length; k++) {
        const dh = Math.abs(hs[k] - 2 * hs[k - perCell] + hs[k - 2 * perCell])
        if (dh > step) {
          step = dh
          stepAt = i * S.ds
        }
      }
    }
  }
  return sunk ? { slopeDeg, slopeAt, step, stepAt, metres: Math.round(sunk * S.ds) } : null
}

/**
 * Per sample: how far the track file puts the road below its own ground (where a point
 * with no `y` sits: the natural ground smoothed by road.surfaceSmoothing), from the
 * points' `lift` (or `y`), blended between points, plus how far a tunnel digs it down
 * (tunnels.ts). A road over a dune sits below the dune's sharp top without being dug down
 * (it rides the smoothed ground): that is not a dip. null without the builder's extras.
 */
function dugDepth(t: TrackRuntime): Float32Array | null {
  const x = trackInternals(t)
  if (!x) return null
  const pts = t.file.road.points
  const n = pts.length
  const sigma = t.file.road.surfaceSmoothing
  const lift = pts.map((p) => (typeof p.y === 'number' ? p.y - averagedHeight(x.nat, p.x, p.z, sigma) : (p.lift ?? 0)))
  const S = t.samples
  const out = new Float32Array(S.count)
  for (let i = 0; i < S.count; i++) {
    const at = x.atOfS(i * S.ds)
    const a = ((Math.floor(at) % n) + n) % n
    const f = at - Math.floor(at)
    out[i] = -(lift[a] * (1 - f) + lift[(a + 1) % n] * f) + x.tunnels.dig[i]
  }
  return out
}

/**
 * Every dip in the road (a stretch the track file puts DIP_MIN_DEPTH or more below its
 * ground, from where it goes below to where it comes back up: dugDepth) and the lips at
 * the top of its ramps:
 * over the dip, the most of gravity's pull a car needs to stay on (crestShareAt, looked
 * at over crestHalf of the dip's length), at the fastest a car is likely to be there
 * (the racing line's speed from DIP_MARGIN metres before it to as far after, plus 15%,
 * up to CREST_CHECK_KMH). The worst dip, or null when there are none.
 */
export function dipLips(t: TrackRuntime): { worst: number; at: number; kmh: number; dips: number; metres: number } | null {
  const S = t.samples
  const n = S.count
  const depth = dugDepth(t)
  if (!depth) return null
  const below = (i: number) => S.surface[i] === SURFACE_CODE.road && depth[i] >= DIP_EDGE
  const seen = new Uint8Array(n)
  const vMax = CREST_CHECK_KMH / 3.6
  let worst = 0
  let at = 0
  let kmh = 0
  let dips = 0
  let metres = 0
  for (let i0 = 0; i0 < n; i0++) {
    if (seen[i0] || !below(i0) || depth[i0] < DIP_MIN_DEPTH) continue
    // The whole dip around this deep spot.
    let a = i0
    while (a > i0 - n && below((((a - 1) % n) + n) % n)) a--
    let b = i0
    while (b < i0 + n && below((b + 1) % n)) b++
    for (let k = a; k <= b; k++) seen[((k % n) + n) % n] = 1
    dips++
    const len = (b - a + 1) * S.ds
    metres = Math.max(metres, len)
    const half = crestHalf(len)
    const m = Math.round(DIP_MARGIN / S.ds)
    let v = 0
    for (let k = a - m; k <= b + m; k++) v = Math.max(v, t.racingLine.speed[((k % n) + n) % n])
    v = Math.min(vMax, v * LINE_MARGIN)
    // The lips: the dip itself, from half a look either side of where it goes below the ground (a hilltop
    // the road crosses before the dip, on the natural ground, is the world's own and isn't judged here).
    const h = Math.round(half / S.ds)
    for (let k = a - h; k <= b + h; k++) {
      const i = ((k % n) + n) % n
      const share = crestShareAt(t, i, v, half)
      if (share > worst) {
        worst = share
        at = i * S.ds
        kmh = v * 3.6
      }
    }
  }
  return dips ? { worst, at, kmh, dips, metres: Math.round(metres) } : null
}

export { CREST_LIMIT }
