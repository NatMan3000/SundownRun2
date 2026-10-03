// ============================================================
//  TRACK RUNTIME + ROAD RIBBON API
// ------------------------------------------------------------
//  CONTRACT (orchestrator-owned). Implemented by the track worker
//  (src/track/build.ts and friends); consumed by everyone who needs
//  to know where the road is.
//
//  buildTrack(file, params) turns a validated TrackFile into a
//  TrackRuntime: pure data (typed arrays + methods), no scene objects
//  and no physics bodies. Rendering (look/world) and colliders (track)
//  are built FROM it.
//
//  The road is a 3D ribbon: a closed centreline sampled every `ds`
//  metres, each sample with a full frame (tangent, up, right). Up is
//  the road surface normal - banked on corners, pointing at the centre
//  of a loop, sideways on a wall ride - so "along the road" queries
//  work everywhere, including upside down.
//
//  Distances along the road (`s`) run from 0 at the start line to
//  `length`, then wrap. Loops add their length to the road.
// ============================================================

import type * as THREE from 'three'
import type { SurfaceKind } from '../core/physics'
import type { ResolvedTrackFile } from './schema'

/** Surface codes stored per sample / per vertex (`aKind`). */
export const SURFACE_CODE = {
  road: 0,
  loop: 1,
  wall: 2,
  ramp: 3,
  barrier: 4,
  skirt: 5,
} as const

export const SURFACE_FROM_CODE: readonly SurfaceKind[] = ['road', 'loop', 'wall', 'ramp', 'barrier', 'skirt']

/** The centreline, sampled at a constant spacing. Struct of arrays; index i is at s = i * ds. */
export interface TrackSamples {
  /** Number of samples. Sample `count` would be sample 0 again (closed loop). */
  count: number
  /** Spacing in metres (constant, about 1 m). */
  ds: number
  /** Centre of the road surface. */
  px: Float32Array
  py: Float32Array
  pz: Float32Array
  /** Unit tangent (driving direction). */
  tx: Float32Array
  ty: Float32Array
  tz: Float32Array
  /** Unit surface normal ("up" for a car on the road here). */
  ux: Float32Array
  uy: Float32Array
  uz: Float32Array
  /** Unit right vector = tangent x up. */
  rx: Float32Array
  ry: Float32Array
  rz: Float32Array
  /** Half the drivable width here, metres. */
  halfWidth: Float32Array
  /** Bank (roll) in radians, + = left edge up. 0 on loops (they use the frame instead). */
  bank: Float32Array
  /** Signed horizontal curvature, 1/m. + = turning right. */
  curvature: Float32Array
  /** SURFACE_CODE of the centre of the road here. */
  surface: Uint8Array
  /** 1 where the road sits on the ground (terrain flattened up to it); 0 on bridges, loops, raised sections. */
  grounded: Uint8Array
}

/** A full frame at a distance along the road. Reuse one `out` object per caller. */
export interface TrackFrame {
  s: number
  position: THREE.Vector3
  tangent: THREE.Vector3
  up: THREE.Vector3
  right: THREE.Vector3
  halfWidth: number
  bank: number
  curvature: number
  surface: SurfaceKind
}

/** Result of a nearest-point query. Reuse one `out` object per caller. */
export interface NearestHit {
  /** Distance along the road of the closest centreline point. */
  s: number
  /** Sample index of that point. */
  index: number
  /** Signed metres right (+) / left (-) of the centreline, measured along `right`. */
  lateral: number
  /** Signed metres above the road surface, measured along `up`. */
  height: number
  /** Straight-line distance to the centreline point. */
  distance: number
  /** Within the drivable width (+0.6 m grace) and within 3 m of the surface. */
  onRoad: boolean
}

/** Mesh data ready for a three.js BufferGeometry. All arrays are owned by the runtime; do not mutate. */
export interface MeshBuffers {
  positions: Float32Array
  normals: Float32Array
  /** u: 0 at the left edge -> 1 at the right edge of the drivable width; v: s in metres along the road. */
  uvs: Float32Array
  indices: Uint32Array
  /**
   * Extra per-vertex attributes for shaders. The road ribbon provides:
   *   aLateral   (1)  signed metres from the centreline (+ right)
   *   aHalfWidth (1)  drivable half width at this vertex's sample
   *   aCurv      (1)  signed curvature at this sample (chevrons: + = right-hander)
   *   aKind      (1)  SURFACE_CODE (road / loop / wall / ramp ...)
   *   aCover     (1)  0..1 how far inside a covered tunnel (0 in the open, 1 from
   *                    30 m inside a portal on): sun, sky, reflections and haze dim by it
   */
  attributes: Record<string, { array: Float32Array; itemSize: number }>
}

/** A boost pad's trigger zone along the road. */
export interface BoostZone {
  s0: number
  s1: number
  /** Lateral extent (metres from the centreline). */
  lat0: number
  lat1: number
  strength: number
  /** Pad centre in world space and its frame (for drawing the arrow). */
  center: { x: number; y: number; z: number }
  tangent: { x: number; y: number; z: number }
  up: { x: number; y: number; z: number }
  length: number
  width: number
}

export interface ResolvedPiece {
  index: number
  type: 'boost' | 'ramp' | 'loop' | 'wallride' | 'speedtrap' | 'tunnel'
  /** Start and end distance along the final road. */
  s0: number
  s1: number
  /** World-space centre of the piece (for visuals). */
  center: { x: number; y: number; z: number }
  /** The source piece from the file. */
  source: ResolvedTrackFile['pieces'][number]
  /** Loop: radius and the loop centre; wall ride: side and height. */
  radius?: number
  loopCenter?: { x: number; y: number; z: number }
  side?: 'left' | 'right' | 'both'
  height?: number
}

/**
 * A covered tunnel (a `tunnel` piece) as built. The road dips into the ground on a ramp,
 * runs between walls of ground (the approach, open to the sky), under a roof from portal
 * s0 to portal s1, and back out the same way. Distances are along the final road.
 */
export interface TunnelInfo {
  /** The piece's index in file.pieces. */
  index: number
  /** The portals: the covered stretch runs from s0 to s1 (s1 may pass the lap length: it wraps). */
  s0: number
  s1: number
  /** Where the dug approaches start and end (the walls of ground stand between a0 and a1). */
  a0: number
  a1: number
  /** The deepest the road was dug, metres. */
  depth: number
  /** Metres from the road surface up to the ceiling, at the tightest. */
  clearance: number
}

/** The tunnels as meshes (MeshBuffers, like the road). */
export interface TunnelMeshes {
  /**
   * Inside every covered stretch: the walls and the ceiling, facing in. uv.x = metres above the
   * road's edge on a wall, metres right of the middle on the ceiling; uv.y = s. Attributes:
   * aCover (as the road), aPart (0 a wall, 1 the ceiling).
   */
  inside: MeshBuffers
  /**
   * The hillside the tunnel is dug into, drawn like the ground: the roof over each covered
   * stretch, the walls of ground along its approaches and their tops, and the portal faces
   * over each mouth. Positions and normals only.
   */
  hill: MeshBuffers
}

/** A placed thing beside the road: position on the ground + heading. */
export interface GroundPose {
  x: number
  y: number
  z: number
  /** Radians, rotation about +y (0 = facing north/-z). */
  heading: number
}

export interface PropAnchor {
  x: number
  y: number
  z: number
  kind: 'crates' | 'cubes' | 'tower' | 'mixed'
  size: 'small' | 'medium' | 'large'
}

/**
 * The terrain height grid (final heights, road-flattened).
 * Layout: heights[iz * (n + 1) + ix], ix along +x, iz along +z,
 * covering x, z in [-half, +half]. NOTE rapier's heightfield wants
 * column-major (iz + ix * (n + 1)); the track worker converts when it
 * builds the collider - nobody else should need to.
 */
export interface TerrainGrid {
  /** Cells per side; there are n + 1 vertices per side. */
  n: number
  half: number
  cellSize: number
  heights: Float32Array
  minHeight: number
  maxHeight: number
}

export interface TrackWorldInfo {
  /** World square side, metres. */
  size: number
  half: number
  /** Car below this y gets auto-reset. */
  resetY: number
  /** The catch floor sits here. */
  catchFloorY: number
  edge: 'ridge' | 'wall'
  /** Max distance from the centre the car can physically reach (inside the boundary). */
  playRadius: number
}

export interface TrackRuntime {
  readonly file: ResolvedTrackFile
  readonly id: string
  readonly name: string
  /** Geometry hash: changes when the road or pieces change. */
  readonly hash: string
  /** `${id}@${hash}` - the key for records and the ghost. */
  readonly key: string
  /** Live parameters in effect, e.g. { bankDeg: 32 }. */
  readonly params: Readonly<Record<string, number>>

  /** Total road length in metres (including loops). */
  readonly length: number
  readonly samples: TrackSamples

  /** Interpolated frame at distance s (wraps). Writes into `out` and returns it. No allocation. */
  frameAt(s: number, out: TrackFrame): TrackFrame
  /**
   * Closest point on the road to (x, y, z). Pass the caller's last `s` as
   * hintS for a fast local search that never jumps to another level of a
   * bridge or the other side of a loop. No allocation.
   */
  nearest(x: number, y: number, z: number, out: NearestHit, hintS?: number): NearestHit
  /** s wrapped into [0, length). */
  wrapS(s: number): number
  /** Signed shortest distance along the road from a to b, in (-length/2, length/2]. */
  deltaS(a: number, b: number): number

  /** Final ground height (road-flattened) at x, z. Cheap (bilinear on the grid). */
  terrainHeight(x: number, z: number): number
  /** Ground normal at x, z. Writes into out. */
  terrainNormal(x: number, z: number, out: THREE.Vector3): THREE.Vector3
  readonly terrain: TerrainGrid

  /** The start/finish line is at s = 0 by construction (startS kept for clarity: always 0). */
  readonly startS: number
  /** Ordered sector checkpoints (s values). checkpoints[0] = 0 = the start line. 8-16 of them. */
  readonly checkpoints: Float32Array
  /** Start grid slot i (0 = pole), two abreast, behind the line. Writes into the outs. */
  gridSlot(i: number, outPosition: THREE.Vector3, outQuaternion: THREE.Quaternion): void

  /** Per-sample racing line for Ai and the demo autopilot. */
  readonly racingLine: {
    /** Lateral offset from the centreline, metres (+ right). */
    offset: Float32Array
    /** Target speed, m/s (already slowed for corners, loops and landings). */
    speed: Float32Array
  }

  /** Minimap: the centreline as xz pairs (decimated) and the bounds of the drivable area. */
  readonly minimap: { path: Float32Array; minX: number; minZ: number; maxX: number; maxZ: number }

  readonly pieces: readonly ResolvedPiece[]
  readonly boostZones: readonly BoostZone[]
  /** Speed traps by s. */
  readonly speedTraps: readonly { s: number }[]
  readonly props: readonly PropAnchor[]
  readonly cores: readonly { x: number; y: number; z: number }[]
  /** Smashable posts (both edges) and billboard spots, placed clear of the road. */
  readonly roadside: { posts: readonly GroundPose[]; billboards: readonly GroundPose[] }

  readonly world: TrackWorldInfo

  /** Covered tunnels (tunnel pieces that could be built), in the order of the file. */
  readonly tunnels: readonly TunnelInfo[]

  /** Geometry for rendering and colliders. */
  readonly meshes: {
    /** Drivable top surface (road, loops, wall rides). Has the shader attributes. */
    road: MeshBuffers
    /**
     * Sides and underside of the road slab. uv.x = metres from the top lip
     * along the cross-section (0 at the lip, growing down the side and
     * across the underside); uv.y = s. Also carries aLateral and aHalfWidth
     * like the road, so the edge strip can continue down the side.
     */
    skirt: MeshBuffers
    /** Edge barrier walls (when road.barriers = 'walls'), else null. */
    barriers: MeshBuffers | null
    /** Kicker ramps, else null. */
    ramps: MeshBuffers | null
    /** Covered tunnels, else null. */
    tunnels: TunnelMeshes | null
  }
}

/** Live parameters a track can expose (see BankingSpec.adjustable). */
export interface TrackParamInfo {
  id: string //   'bankDeg'
  label: string
  min: number
  max: number
  value: number
  /** The track file's own value (what "reset to default" goes back to). */
  default: number
}
