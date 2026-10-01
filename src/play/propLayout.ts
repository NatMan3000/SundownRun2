// ============================================================
//  PROP LAYOUT - what stands at each crash-prop spot this round
// ------------------------------------------------------------
//  A pure function of (track, round): the same inputs always give
//  the same layout, on every machine. That is what lets multiplayer
//  share prop rounds by sending just a round number (core/propsSignal).
//
//  Each spot in the track file (track.props) becomes a CLUSTER of
//  PIECES. Four kinds:
//
//    crates  a pyramid of dark crates with glowing magenta edges
//    cubes   a loose heap of translucent cyan energy cubes
//    tower   a tall 2 x 2 stack of crates (falls over beautifully)
//    mixed   a small crate pyramid ringed with energy cubes
//
//  Sizes small / medium / large set how many pieces. Each round the
//  cluster is nudged a few metres and turned, so it never looks the
//  same twice, and a 'mixed' spot rolls its own recipe.
//
//  Points: a cluster pays out only when you burst it by speed (no
//  points for touching it). Bigger and rarer clusters pay more.
// ============================================================

import type { PropAnchor, TrackRuntime } from '../track/types'
import { mulberry32, roundSeed } from './random'

export const CRATE = 1.1 //      crate edge, metres
export const TOWER_CRATE = 0.9
export const CUBE = 0.85 //      energy cube edge
export const MAX_PIECES_PER_CLUSTER = 16

export const PIECE_CRATE = 0
export const PIECE_CUBE = 1

/** Base points per kind, before the size multiplier and the speed bonus. */
export const KIND_POINTS: Record<PropAnchor['kind'], number> = { crates: 20, cubes: 25, tower: 30, mixed: 25 }
const SIZE_MULT: Record<PropAnchor['size'], number> = { small: 0.6, medium: 1, large: 1.6 }

/** How far a cluster may wander from its spot each round, metres. */
const JITTER = 3

export interface PropLayout {
  clusterCount: number
  /** Cluster centre on the ground. */
  cx: Float32Array
  cy: Float32Array
  cz: Float32Array
  kind: PropAnchor['kind'][]
  points: Int32Array
  pieceStart: Int32Array
  pieceCount: Int32Array
  pieceTotal: number
  /** Per piece: type (crate / cube), half edge, world position and rotation. */
  type: Uint8Array
  half: Float32Array
  px: Float32Array
  py: Float32Array
  pz: Float32Array
  qx: Float32Array
  qy: Float32Array
  qz: Float32Array
  qw: Float32Array
  /** Owning cluster of each piece. */
  owner: Int32Array
}

interface LocalPiece {
  type: number
  edge: number
  x: number
  y: number
  z: number
}

/** Pieces of a crate pyramid, rows along x, stacked up. */
function pyramid(rows: number, out: LocalPiece[]): void {
  for (let level = 0; level < rows; level++) {
    const count = rows - level
    for (let j = 0; j < count; j++) {
      out.push({ type: PIECE_CRATE, edge: CRATE, x: (j - (count - 1) / 2) * CRATE * 1.03, y: level * CRATE + CRATE / 2, z: 0 })
    }
  }
}

/** A heap of energy cubes: a ring on the ground and a few on top. */
function heap(count: number, radius: number, rng: () => number, out: LocalPiece[]): void {
  const ground = Math.ceil(count * 0.7)
  for (let i = 0; i < ground; i++) {
    const a = (i / ground) * Math.PI * 2 + rng() * 0.4
    const r = radius * (0.55 + rng() * 0.45)
    out.push({ type: PIECE_CUBE, edge: CUBE, x: Math.cos(a) * r, y: CUBE / 2, z: Math.sin(a) * r })
  }
  for (let i = ground; i < count; i++) {
    const base = out[out.length - ground + ((i - ground) % ground)]
    out.push({ type: PIECE_CUBE, edge: CUBE, x: base.x * 0.85, y: CUBE * 1.5, z: base.z * 0.85 })
  }
}

/** A 2 x 2 crate tower, `levels` high. */
function tower(levels: number, out: LocalPiece[]): void {
  const h = TOWER_CRATE / 2
  for (let level = 0; level < levels; level++) {
    for (let k = 0; k < 4; k++) {
      out.push({
        type: PIECE_CRATE,
        edge: TOWER_CRATE,
        x: k & 1 ? h * 1.02 : -h * 1.02,
        y: level * TOWER_CRATE + h,
        z: k & 2 ? h * 1.02 : -h * 1.02,
      })
    }
  }
}

function recipe(kind: PropAnchor['kind'], size: PropAnchor['size'], rng: () => number, out: LocalPiece[]): void {
  const s = size === 'small' ? 0 : size === 'medium' ? 1 : 2
  switch (kind) {
    case 'crates':
      pyramid(2 + s, out) // 3, 6, 10 crates
      break
    case 'cubes':
      heap([4, 7, 11][s], [1.5, 2.1, 2.7][s], rng, out)
      break
    case 'tower':
      tower(2 + s, out) // 8, 12, 16 crates
      break
    case 'mixed':
      pyramid(1 + s, out) // 1, 3, 6 crates ...
      heap([3, 5, 7][s], [2.0, 2.6, 3.2][s], rng, out) // ... ringed with cubes
      break
  }
  if (out.length > MAX_PIECES_PER_CLUSTER) out.length = MAX_PIECES_PER_CLUSTER
}

/** Points for bursting a cluster, before the speed bonus. */
function basePoints(kind: PropAnchor['kind'], size: PropAnchor['size']): number {
  return Math.max(5, Math.round((KIND_POINTS[kind] * SIZE_MULT[size]) / 5) * 5)
}

/** Capacity needed for a track (every cluster at its biggest). */
export function pieceCapacity(track: TrackRuntime): number {
  return Math.max(1, track.props.length * MAX_PIECES_PER_CLUSTER)
}

/** Deal the layout for a round. */
export function buildPropLayout(track: TrackRuntime, round: number): PropLayout {
  const rng = mulberry32(roundSeed(track.key, round, 3))
  const anchors = track.props
  const cap = pieceCapacity(track)
  const n = anchors.length
  const L: PropLayout = {
    clusterCount: n,
    cx: new Float32Array(n),
    cy: new Float32Array(n),
    cz: new Float32Array(n),
    kind: [],
    points: new Int32Array(n),
    pieceStart: new Int32Array(n),
    pieceCount: new Int32Array(n),
    pieceTotal: 0,
    type: new Uint8Array(cap),
    half: new Float32Array(cap),
    px: new Float32Array(cap),
    py: new Float32Array(cap),
    pz: new Float32Array(cap),
    qx: new Float32Array(cap),
    qy: new Float32Array(cap),
    qz: new Float32Array(cap),
    qw: new Float32Array(cap),
    owner: new Int32Array(cap),
  }
  const hit = { s: 0, index: 0, lateral: 0, height: 0, distance: 0, onRoad: true }
  const local: LocalPiece[] = []
  let p = 0
  for (let c = 0; c < n; c++) {
    const a = anchors[c]
    // wander a little, unless that would put it on the road
    let x = a.x + (rng() * 2 - 1) * JITTER
    let z = a.z + (rng() * 2 - 1) * JITTER
    track.nearest(x, a.y, z, hit)
    const roadHalf = track.samples.halfWidth[hit.index] ?? 7
    if (Math.abs(hit.lateral) < roadHalf + 3) {
      x = a.x
      z = a.z
    }
    const kind: PropAnchor['kind'] = a.kind === 'mixed' && rng() < 0.35 ? (rng() < 0.5 ? 'crates' : 'cubes') : a.kind
    // sit on the highest ground under the footprint so nothing hangs half underground
    let y = a.y
    for (let k = 0; k < 5; k++) {
      const ox = k === 1 ? 1.6 : k === 2 ? -1.6 : 0
      const oz = k === 3 ? 1.6 : k === 4 ? -1.6 : 0
      y = Math.max(y, track.terrainHeight(x + ox, z + oz))
    }
    y += 0.02
    const yaw = rng() * Math.PI * 2
    const cosY = Math.cos(yaw)
    const sinY = Math.sin(yaw)
    const qy = Math.sin(yaw / 2)
    const qw = Math.cos(yaw / 2)

    local.length = 0
    recipe(kind, a.size, rng, local)
    L.cx[c] = x
    L.cy[c] = y
    L.cz[c] = z
    L.kind.push(kind)
    L.points[c] = basePoints(kind, a.size)
    L.pieceStart[c] = p
    L.pieceCount[c] = local.length
    for (const lp of local) {
      L.type[p] = lp.type
      L.half[p] = lp.edge / 2
      L.px[p] = x + lp.x * cosY + lp.z * sinY
      L.py[p] = y + lp.y
      L.pz[p] = z - lp.x * sinY + lp.z * cosY
      L.qx[p] = 0
      L.qy[p] = qy
      L.qz[p] = 0
      L.qw[p] = qw
      L.owner[p] = c
      p++
    }
  }
  L.pieceTotal = p
  return L
}
