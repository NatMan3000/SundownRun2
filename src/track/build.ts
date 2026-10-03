// ============================================================
//  BUILD TRACK - a validated track file becomes a TrackRuntime
// ------------------------------------------------------------
//  buildTrack(file, params, previous?) runs the whole pipeline:
//
//    natural ground  (terrain.ts)  hills / flat + features + edge
//    road            (road.ts)     spline, samples, banking, loops
//    ground to road  (terrain.ts)  cut and fill to meet the road
//    meshes          (ribbon.ts, ramps.ts)
//    derived data    (derived.ts)  checkpoints, racing line, grid,
//                                  minimap, roadside, pieces
//
//  The result is pure data plus a few query methods: no three.js
//  scene objects and no physics bodies. index.tsx turns it into
//  colliders; the look and world workers turn it into visuals.
//
//  Live rebuilds (the Hyperdrome's bank slider) pass `previous`: the
//  natural ground is reused rather than recomputed, so a rebuild only
//  redoes the road and the cut-and-fill (a few tens of milliseconds).
// ============================================================

import * as THREE from 'three'
import type { ResolvedTrackFile, BoostPiece, RampPiece, WallRidePiece, TunnelPiece } from './schema'
import { TRACK_DEFAULTS } from './schema'
import type { BoostZone, GroundPose, PropAnchor, ResolvedPiece, TrackFrame, TrackRuntime, TrackWorldInfo } from './types'
import {
  BIGAIR_LAYOUT,
  flattenToRoad,
  gridHeight,
  hillGroundOf,
  makeNaturalTerrain,
  makeTerrainGrid,
  roundedRadius,
  roundedToEuclid,
  sampleNaturalGrid,
  type FlattenInput,
  type NaturalGrid,
  type NaturalTerrain,
} from './terrain'
import { buildCenterline, SAME_STRETCH, WALL_FULL_INSET, type LoopInfo } from './road'
import { SURFACE_CODE } from './types'
import { buildRibbonMeshes } from './ribbon'
import { buildRampMeshes, type RampSolid } from './ramps'
import { buildSampleHash, makeRoadQueries } from './query'
import { makeBillboards, makeCheckpoints, makeMinimap, makePosts, makeRacingLine } from './derived'
import { hashString } from './noise'
import { makeTunnelFootprint, type TunnelSamples } from './tunnels'
import { buildTunnelMeshes, type TunnelSolids } from './tunnelMeshes'

/**
 * Version of the road builder itself. Bump it whenever the way geometry is generated
 * changes (where loops sit, how banking or easing works, ...), so old ghosts and records
 * don't replay through moved geometry: it goes into every track's hash and key, so a
 * bump gives every track a new key once and old local records stop matching.
 *   1: the first builder.
 *   2: loops run straight into the mouth and ease back over 180 m after (track2, round 1).
 *   3: the bank flattens over a loop's run-in and landing; a loop on a curve drifts to its inside.
 *   4: billboards closer to the road (14-30 m) and kept out of every place cars fly or crowd.
 *   5: a loop's roll is spread evenly from mouth to landing instead of all over the top, so
 *      its road surface (and its edges) turn about the centre line; the centre line is unchanged.
 *   6: stadium barriers stand upright on a bank's low edge, with level ground behind them
 *      (no ditch); a bridge's clearance cut no longer digs beside or under the grounded road
 *      where it rises into the bridge, and tapers in over the bridge's first 10 m.
 *   7: a bank roll that would lift a car off a lane at 250 km/h is made longer, as an
 *      even S, into the straight as far as the bank there stays near what the bend wants,
 *      then into the banked corner (bankRolls.ts): the Hyperdrome's rolls go from about
 *      95 m to 126 m (bank 30), 162 m (45) and 201-211 m (60).
 *   8: stadium barriers are one smooth solid along the road in physics (they were a chain of
 *      8 m boxes whose square ends stopped a car sliding along the wall), and on the ground
 *      a barrier's back stops at the floor behind it, closed off underneath, with the slab's
 *      side ending there too (on a steep bank's high edge the back used to meet the ground
 *      along a stair-stepped line).
 *   9: an open road banks about its LOW edge, which stays where the road would sit unbanked
 *      (on the ground), and the high side rises with the ground filled up under it; the ground
 *      beside the low edge stays level with it (it was a ditch, GitHub #9). The lift is rounded
 *      off over the 100-200 m into and out of a banked corner, so the bank rolls themselves are
 *      unchanged. The ground beside an open road follows its grade between samples. Roads with
 *      barriers (the Hyperdrome) still bank about their middle and keep their geometry.
 *  10: a road point with no `y` sits on the ground smoothed over about 60 m (a bell-shaped
 *      average, ROAD_GROUND_SIGMA = 30 m in terrain.ts) instead of 12 m, so a road follows the
 *      hills but not every little bump (Nathan: "the road needs to sort of smooth out what's
 *      underneath it"); the terrain is cut and filled to meet it. Points with a `y` keep it.
 *      A track can set its own smoothing (road.surfaceSmoothing, 5-50 m). A wall ride's wall
 *      grows in and fades out over 40 m (was 15), reaching 25 m past both ends of its stretch,
 *      so its full-height part stays where it was.
 */
export const BUILDER_VERSION = 10

/** Grid slots: the first row this far behind the line, then a row every GRID_ROW metres. */
const GRID_FIRST = 7
const GRID_ROW = 8
/** Cars spawn this far above the road surface. */
const GRID_LIFT = 0.6

/** Private extras a runtime carries for the next live rebuild and for colliders. */
export interface TrackInternals {
  nat: NaturalTerrain
  natGrid: NaturalGrid
  envKey: string
  /** Build time in ms (for the checker and check-tracks). */
  buildMs: number
  /** Ramp collision meshes: one closed solid per ramp. */
  rampSolids: RampSolid[]
  /** Slab thickness per sample. */
  thickness: Float32Array
  /** Edge geometry for colliders. */
  world: TrackWorldInfo
  /** The control-point position nearest a final s (for messages). */
  atOfS: (s: number) => number
  /** 0..1 per sample: how much of the bank comes from a file override. */
  overrideWeight: Float32Array
  /** Metres the bank's pivot lifted the middle of the road per sample (see Centerline.pivotLift). */
  pivotLift: Float32Array
  /** Each loop as built (where it sits, which way it drifts, how far it was bent to land). */
  loops: LoopInfo[]
  /**
   * Per terrain grid vertex, 1 where it is inside the road's slab or a barrier box
   * (see flattenToRoad). The physics ground leaves out every triangle whose three
   * corners are covered (terrainTiles.ts).
   */
  groundCovered: Uint8Array
  /** The tunnels per sample (tunnels.ts), every tunnel piece's plan (built or not) included. */
  tunnels: TunnelSamples
  /** Each built tunnel's physics: walls and ceiling, and the hill on top (tunnelMeshes.ts). */
  tunnelSolids: TunnelSolids[]
  /**
   * The hill the tunnels are dug through (terrain.ts hillGroundOf): the ground as every other road
   * shaped it, on the terrain grid. The natural grid itself on a track with no tunnel.
   */
  hillGrid: NaturalGrid
  /** Per grid vertex under a tunnel's solid: the solid's top, and metres inside its outer edge (terrain.ts). */
  tunnelTop: Float32Array | null
  tunnelIn: Float32Array | null
}

const internals = new WeakMap<TrackRuntime, TrackInternals>()

/** The builder's extras for a runtime (colliders and rebuilds use them). */
export function trackInternals(t: TrackRuntime): TrackInternals | undefined {
  return internals.get(t)
}

/** Seconds of now, in ms, that works in browsers and Bun. */
function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

export function buildTrack(file: ResolvedTrackFile, params: Record<string, number>, previous?: TrackRuntime | null): TrackRuntime {
  const t0 = now()
  const env = file.environment

  // ---- natural ground (reused from `previous` when the environment is unchanged) ----
  const envKey = JSON.stringify([env.seed, env.size, env.terrain, env.sky.sunAzimuthDeg])
  const prev = previous ? internals.get(previous) : undefined
  let nat: NaturalTerrain
  let natGrid: NaturalGrid
  if (prev && prev.envKey === envKey) {
    nat = prev.nat
    natGrid = prev.natGrid
  } else {
    nat = makeNaturalTerrain(env)
    natGrid = sampleNaturalGrid(nat)
  }

  // ---- the road ----
  const banking = file.road.banking
  const bankMax = banking.adjustable && typeof params.bankDeg === 'number' ? params.bankDeg : banking.maxDeg
  const c = buildCenterline(file, bankMax, nat)
  const S = c.samples
  const L = c.length

  // ---- the ground, cut and filled to the road ----
  const flatInput: FlattenInput = { samples: S, thickness: c.thickness, barrierHeight: file.road.barriers === 'walls' ? file.road.barrierHeight : 0, overCut: c.overCut, underCut: c.underCut, sameStretch: SAME_STRETCH, tunnels: c.tunnels }
  // With tunnels: first the hill they are dug through (every other road shaping the ground), so a
  // road crossing over a tunnel runs on its roof as on the ground (terrain.ts hillGroundOf).
  const hill = hillGroundOf(natGrid, flatInput)
  const hillGrid: NaturalGrid = hill ? { n: natGrid.n, half: natGrid.half, cellSize: natGrid.cellSize, heights: hill } : natGrid
  const flat = flattenToRoad(natGrid, { ...flatInput, hill: hill ?? undefined })
  const heights = flat.heights
  const terrain = makeTerrainGrid(natGrid, heights)
  const terrainHeight = (x: number, z: number) => gridHeight(terrain, x, z)
  const terrainNormal = (x: number, z: number, out: THREE.Vector3): THREE.Vector3 => {
    const e = terrain.cellSize
    const hx = gridHeight(terrain, x + e, z) - gridHeight(terrain, x - e, z)
    const hz = gridHeight(terrain, x, z + e) - gridHeight(terrain, x, z - e)
    return out.set(-hx, 2 * e, -hz).normalize()
  }

  // ---- queries ----
  const hash = buildSampleHash(S)
  const q = makeRoadQueries(S, L, hash, { wallLeft: c.wallLeft, wallRight: c.wallRight, wallRadius: c.wallRadius })
  const tmpFrame: TrackFrame = {
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

  // ---- pieces on the final road ----
  const pieces: ResolvedPiece[] = []
  const boostZones: BoostZone[] = []
  const speedTraps: { s: number }[] = []
  const rampSpots: { s: number; piece: RampPiece }[] = []
  file.pieces.forEach((p, index) => {
    if (p.type === 'loop') {
      const info = c.loops.find((l) => l.pieceIndex === index)!
      pieces.push({ index, type: 'loop', s0: info.s0, s1: q.wrapS(info.s1), center: info.center, source: p, radius: info.radius, loopCenter: info.center })
      return
    }
    const s = c.sOfAt(p.at)
    if (p.type === 'boost') {
      const b = p as BoostPiece
      const len = b.length ?? 10
      const wid = b.width ?? 5
      const off = b.offset ?? 0
      q.frameAt(s, tmpFrame)
      const center = {
        x: tmpFrame.position.x + tmpFrame.right.x * off,
        y: tmpFrame.position.y + tmpFrame.right.y * off,
        z: tmpFrame.position.z + tmpFrame.right.z * off,
      }
      const zone: BoostZone = {
        s0: q.wrapS(s - len / 2),
        s1: q.wrapS(s + len / 2),
        lat0: off - wid / 2,
        lat1: off + wid / 2,
        strength: b.strength ?? 1,
        center,
        tangent: { x: tmpFrame.tangent.x, y: tmpFrame.tangent.y, z: tmpFrame.tangent.z },
        up: { x: tmpFrame.up.x, y: tmpFrame.up.y, z: tmpFrame.up.z },
        length: len,
        width: wid,
      }
      boostZones.push(zone)
      pieces.push({ index, type: 'boost', s0: zone.s0, s1: zone.s1, center, source: p })
    } else if (p.type === 'ramp') {
      const r = p as RampPiece
      const len = r.length ?? 12
      q.frameAt(s, tmpFrame)
      const off = r.offset ?? 0
      rampSpots.push({ s, piece: r })
      pieces.push({
        index,
        type: 'ramp',
        s0: q.wrapS(s - len / 2),
        s1: q.wrapS(s + len / 2),
        center: {
          x: tmpFrame.position.x + tmpFrame.right.x * off,
          y: tmpFrame.position.y + tmpFrame.right.y * off,
          z: tmpFrame.position.z + tmpFrame.right.z * off,
        },
        source: p,
      })
    } else if (p.type === 'wallride') {
      const w = p as WallRidePiece
      const info = c.walls.find((x) => x.pieceIndex === index)!
      q.frameAt(info.s0 + (info.s1 - info.s0) / 2, tmpFrame)
      pieces.push({
        index,
        type: 'wallride',
        s0: q.wrapS(info.s0),
        s1: q.wrapS(info.s1),
        center: { x: tmpFrame.position.x, y: tmpFrame.position.y, z: tmpFrame.position.z },
        source: p,
        side: w.side,
        height: info.radius,
      })
    } else if (p.type === 'speedtrap') {
      q.frameAt(s, tmpFrame)
      speedTraps.push({ s })
      pieces.push({ index, type: 'speedtrap', s0: s, s1: s, center: { x: tmpFrame.position.x, y: tmpFrame.position.y, z: tmpFrame.position.z }, source: p })
    } else if (p.type === 'tunnel') {
      // A built tunnel spans its portals; one that couldn't be built (the tunnel check says
      // why) still reports where it was asked for.
      const built = c.tunnels.list.find((x) => x.index === index)
      const s0 = built ? built.s0 : s
      const s1 = built ? built.s1 : s + ((p as TunnelPiece).length ?? TRACK_DEFAULTS.tunnelLength)
      q.frameAt(s0 + (s1 - s0) / 2, tmpFrame)
      pieces.push({ index, type: 'tunnel', s0: q.wrapS(s0), s1: q.wrapS(s1), center: { x: tmpFrame.position.x, y: tmpFrame.position.y, z: tmpFrame.position.z }, source: p })
    }
  })
  speedTraps.sort((a, b) => a.s - b.s)

  // ---- meshes ----
  const ribbon = buildRibbonMeshes(c, file.road.barriers === 'walls', file.road.barrierHeight)
  const ramps = buildRampMeshes(rampSpots, q, tmpFrame)
  const tunnelBuild = buildTunnelMeshes(S, c.tunnels, hillGrid, terrain)

  // ---- world edges ----
  const minGround = Math.min(terrain.minHeight, minOf(S.py) - 2)
  let playRadius: number
  if (nat.edge === 'ridge') {
    playRadius = 0
    for (let k = 0; k < 360; k++) {
      const th = (k / 360) * Math.PI * 2
      playRadius = Math.max(playRadius, roundedToEuclid(nat.ridgeCrestAt(th), th))
    }
  } else playRadius = nat.wallRadius
  const world: TrackWorldInfo = {
    size: env.size,
    half: env.size / 2,
    resetY: minGround - 6,
    catchFloorY: minGround - 20,
    edge: nat.edge,
    playRadius,
  }
  const insideWorld = (x: number, z: number, margin: number): boolean => {
    if (nat.edge === 'ridge') return roundedRadius(x, z) < nat.ridgeFootMin - margin
    return Math.hypot(x, z) < nat.wallRadius - margin
  }

  // ---- derived data ----
  const pinned: { s0: number; s1: number; value?: number }[] = []
  const fast: { s0: number; s1: number }[] = []
  for (const l of c.loops) {
    // Centred into the mouth and out of the landing; the pin's ease (makeRacingLine)
    // brings the line in gently, square to the mouth, over the 60 m before it.
    pinned.push({ s0: q.wrapS(l.s0 - 15), s1: q.wrapS(l.s1 + 10) })
    fast.push({ s0: q.wrapS(l.s0 - 30), s1: q.wrapS(l.s1 + 5) })
  }
  // Wall rides are NOT in `fast`: the line runs on the flat floor beside the wall (no
  // magnetic grip there), so a wall-ride bend is planned on tyre grip like any other
  // corner. Forcing magnetic-grip speed onto the floor asked for ~1.6-1.9 g on a tight
  // wall-ride bend. Riding up the wall is the player's choice.
  for (const r of rampSpots) {
    const len = r.piece.length ?? 12
    pinned.push({ s0: q.wrapS(r.s - len / 2 - 25), s1: q.wrapS(r.s + len / 2 + 5), value: r.piece.offset ?? 0 })
  }
  // A live bank change leaves the road's plan view untouched: keep the line, redo the speeds.
  let reuseOffset: Float32Array | undefined
  if (previous && previous.samples.count === S.count && previous.file.id === file.id) {
    let same = true
    for (let i = 0; i < S.count && same; i += 7) same = Math.abs(previous.samples.px[i] - S.px[i]) < 1e-3 && Math.abs(previous.samples.pz[i] - S.pz[i]) < 1e-3
    if (same) reuseOffset = previous.racingLine.offset
  }
  const racingLine = makeRacingLine({ samples: S, length: L, pinned, fast, ramps: rampSpots.map((r) => r.s), edgeMargin: file.road.barriers === 'walls' ? 3 : 2.5, reuseOffset })

  const noPosts: { s0: number; s1: number }[] = []
  // Round a loop: nothing beside the mouth or under the way out (the loop's legs stand there).
  for (const l of c.loops) noPosts.push({ s0: q.wrapS(l.s0 - 40), s1: q.wrapS(l.s1 + 40) })
  // A wall ride's wall (its ramps included) and 15 m either side of it.
  for (const w of c.walls) noPosts.push({ s0: q.wrapS(w.s0 - WALL_FULL_INSET), s1: q.wrapS(w.s1 + WALL_FULL_INSET) })
  for (const r of rampSpots) noPosts.push({ s0: q.wrapS(r.s - 25), s1: q.wrapS(r.s + 25) })
  // A tunnel's whole stretch: its walls of ground stand where the posts would.
  for (const tn of c.tunnels.list) noPosts.push({ s0: q.wrapS(tn.a0 - 10), s1: q.wrapS(tn.a1 + 10) })
  // Keep the start grid clear too.
  noPosts.push({ s0: q.wrapS(-GRID_FIRST - GRID_ROW * 7), s1: 12 })
  // Billboards: never where cars fly or crowd. Round loops and wall rides, ramps and the
  // 150 m they throw you over, crests that go light under ~220 km/h (vertical radius
  // under 380 m) and the 150 m after them, and every big-air run's flight path.
  const noBillboards: { s0: number; s1: number }[] = []
  for (const l of c.loops) noBillboards.push({ s0: q.wrapS(l.s0 - 60), s1: q.wrapS(l.s1 + 60) })
  for (const w of c.walls) noBillboards.push({ s0: q.wrapS(w.s0 - 30), s1: q.wrapS(w.s1 + 30) })
  for (const r of rampSpots) noBillboards.push({ s0: q.wrapS(r.s - 20), s1: q.wrapS(r.s + 150) })
  for (const tn of c.tunnels.list) noBillboards.push({ s0: q.wrapS(tn.a0 - 20), s1: q.wrapS(tn.a1 + 20) })
  {
    const W = Math.max(1, Math.round(6 / S.ds))
    let lastS = -Infinity
    for (let i = 0; i < S.count; i++) {
      if (S.surface[i] !== SURFACE_CODE.road) continue
      const a = (i - W + S.count) % S.count
      const b = (i + W) % S.count
      const ga = S.ty[a] / (Math.hypot(S.tx[a], S.tz[a]) || 1)
      const gb = S.ty[b] / (Math.hypot(S.tx[b], S.tz[b]) || 1)
      const kv = (gb - ga) / (2 * W * S.ds)
      if (kv < -1 / 380 && i * S.ds > lastS + 20) {
        noBillboards.push({ s0: q.wrapS(i * S.ds - 10), s1: q.wrapS(i * S.ds + 150) })
        lastS = i * S.ds
      }
    }
  }
  const bigAirRuns = env.terrain.features.filter((f) => f.type === 'bigAir')
  const keepOut = (x: number, z: number): boolean => {
    for (const f of bigAirRuns) {
      if (f.type !== 'bigAir') continue
      const k = f.scale ?? 1
      const hd = (f.headingDeg * Math.PI) / 180
      const ax = Math.sin(hd)
      const az = -Math.cos(hd)
      const u = (x - f.x) * ax + (z - f.z) * az
      const v = -(x - f.x) * az + (z - f.z) * ax
      // From the kicker's foot to well past the furthest landing seen (u ~410 at 200 km/h).
      if (u > BIGAIR_LAYOUT.kickerFootU * k - 20 && u < (BIGAIR_LAYOUT.kickerCrestU + 300) * k && Math.abs(v) < 60 * k) return true
    }
    return false
  }
  // Nothing placed by the road stands on or in a tunnel's solid (its roof, walls or their tops).
  const tunnelAt = makeTunnelFootprint(S, c.tunnels)
  const keepOff = (x: number, z: number): boolean => tunnelAt(x, z, 4) !== null
  const roadsideIn = { file, c, hash, terrainHeight, insideWorld, noPosts, noBillboards, keepOut: (x: number, z: number) => keepOut(x, z) || keepOff(x, z), keepOff, seed: env.seed }
  const posts = makePosts(roadsideIn)
  const billboards = makeBillboards(roadsideIn)

  // Ground height that knows about the road: on a grounded road, its surface.
  const nearestTmp = { s: 0, index: 0, lateral: 0, height: 0, distance: 0, onRoad: false }
  const groundAt = (x: number, z: number): number => {
    const ty = terrainHeight(x, z)
    q.nearest(x, ty, z, nearestTmp)
    const i = nearestTmp.index
    if (Math.abs(nearestTmp.lateral) <= S.halfWidth[i] && S.uy[i] > 0.5 && Math.abs(nearestTmp.height) < 3) {
      q.frameAt(nearestTmp.s, tmpFrame)
      const lat = nearestTmp.lateral
      return Math.max(ty, tmpFrame.position.y + tmpFrame.right.y * lat)
    }
    return ty
  }
  // A crash prop or energy core whose spot falls on (or in) a tunnel moves sideways off it, to
  // the ground beside the tunnel's walls.
  const offTunnel = (x: number, z: number, margin: number): { x: number; z: number } => {
    const hit = tunnelAt(x, z, margin)
    if (!hit) return { x, z }
    // (lateral counts along the road's right vector, as the ground builder does.)
    const move = hit.side * (hit.outer + margin + 1) - hit.lateral
    return { x: x + S.rx[hit.i] * move, z: z + S.rz[hit.i] * move }
  }
  const props: PropAnchor[] = file.props.map((p) => {
    const at = offTunnel(p.x, p.z, 8)
    return { x: at.x, y: groundAt(at.x, at.z), z: at.z, kind: p.kind ?? 'mixed', size: p.size ?? 'medium' }
  })
  const cores = file.cores.map((c0) => {
    const at = offTunnel(c0.x, c0.z, 3)
    return { x: at.x, y: groundAt(at.x, at.z) + (c0.y ?? 1.6), z: at.z }
  })

  const checkpoints = makeCheckpoints(L, c.loops.map((l) => ({ s0: l.s0, s1: l.s1 })))
  const minimap = makeMinimap(S)

  // ---- identity ----
  const hashText = JSON.stringify({ builder: BUILDER_VERSION, road: file.road, pieces: file.pieces, start: file.start, params, env: [env.seed, env.size, env.terrain] })
  const geomHash = hashString(hashText).toString(16).padStart(8, '0')

  const basis = new THREE.Matrix4()
  const negRight = new THREE.Vector3()
  const gridSlot = (i: number, outPosition: THREE.Vector3, outQuaternion: THREE.Quaternion): void => {
    const row = Math.floor(Math.max(0, i) / 2)
    const col = Math.max(0, i) % 2
    q.frameAt(-(GRID_FIRST + row * GRID_ROW), tmpFrame)
    const lat = (col === 0 ? -1 : 1) * Math.min(tmpFrame.halfWidth * 0.42, 3.4)
    outPosition
      .copy(tmpFrame.position)
      .addScaledVector(tmpFrame.right, lat)
      .addScaledVector(tmpFrame.up, GRID_LIFT)
    // Car convention: local +z forward, +y up, so local +x is the car's left (-right).
    negRight.copy(tmpFrame.right).negate()
    basis.makeBasis(negRight, tmpFrame.up, tmpFrame.tangent)
    outQuaternion.setFromRotationMatrix(basis)
  }

  const runtime: TrackRuntime = {
    file,
    id: file.id,
    name: file.name,
    hash: geomHash,
    key: `${file.id}@${geomHash}`,
    params: { ...params },
    length: L,
    samples: S,
    frameAt: q.frameAt,
    nearest: q.nearest,
    wrapS: q.wrapS,
    deltaS: q.deltaS,
    terrainHeight,
    terrainNormal,
    terrain,
    startS: 0,
    checkpoints,
    gridSlot,
    racingLine,
    minimap,
    pieces,
    boostZones,
    speedTraps,
    props,
    cores,
    roadside: { posts, billboards },
    world,
    tunnels: c.tunnels.list,
    meshes: { road: ribbon.road, skirt: ribbon.skirt, barriers: ribbon.barriers, ramps: ramps.mesh, tunnels: tunnelBuild ? tunnelBuild.meshes : null },
  }
  internals.set(runtime, {
    nat,
    natGrid,
    envKey,
    buildMs: now() - t0,
    rampSolids: ramps.solids,
    thickness: c.thickness,
    world,
    atOfS: c.atOfS,
    overrideWeight: c.overrideWeight,
    pivotLift: c.pivotLift,
    loops: c.loops,
    groundCovered: flat.covered,
    tunnels: c.tunnels,
    tunnelSolids: tunnelBuild ? tunnelBuild.solids : [],
    hillGrid,
    tunnelTop: flat.tunnelTop,
    tunnelIn: flat.tunnelIn,
  })
  return runtime
}

function minOf(a: Float32Array): number {
  let m = Infinity
  for (let i = 0; i < a.length; i++) if (a[i] < m) m = a[i]
  return m
}

export type { GroundPose }
