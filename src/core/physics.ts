// ============================================================
//  PHYSICS CONTRACT - collision groups and surface tags
// ------------------------------------------------------------
//  CONTRACT (orchestrator-owned).
//
//  Collision groups: rapier interaction groups are 16-bit
//  "member of" + 16-bit "collides with" masks. Use the helpers
//  below rather than hand-written bitmasks.
//
//  Surface tags: every static collider the track builds is tagged
//  with a SurfaceKind, so a wheel ray that hits it knows what it is
//  standing on (mag grip on loops and wall rides, off-road on
//  terrain). Look it up with surfaceOf(collider.handle).
// ============================================================

/** Collision group indices (0-15). */
export const GROUP = {
  WORLD: 0, //   road ribbon, terrain, walls, catch floor, ramps
  CAR: 1, //     player and Ai cars (dynamic)
  REMOTE: 2, //  remote multiplayer cars (kinematic)
  PROP: 3, //    crash props, smashables, debris
  SENSOR: 4, //  trigger volumes (boost pads, cores, checkpoints)
  GHOST: 5, //   things nothing collides with
} as const

/** Pack an interaction-groups value: member of `member`, collides with `filter`. */
export function groups(member: readonly number[], filter: readonly number[]): number {
  let m = 0
  let f = 0
  for (let i = 0; i < member.length; i++) m |= 1 << member[i]
  for (let i = 0; i < filter.length; i++) f |= 1 << filter[i]
  return ((m & 0xffff) << 16) | (f & 0xffff)
}

/** Ready-made group values. */
export const GROUPS = {
  world: groups([GROUP.WORLD], [GROUP.CAR, GROUP.REMOTE, GROUP.PROP]),
  car: groups([GROUP.CAR], [GROUP.WORLD, GROUP.CAR, GROUP.REMOTE, GROUP.PROP, GROUP.SENSOR]),
  /** Remote cars: shove local cars; ignore each other (each client owns its own car). */
  remote: groups([GROUP.REMOTE], [GROUP.CAR]),
  /** Remote cars with ramming turned off. */
  remoteGhost: groups([GROUP.REMOTE], []),
  prop: groups([GROUP.PROP], [GROUP.WORLD, GROUP.CAR, GROUP.PROP]),
  sensor: groups([GROUP.SENSOR], [GROUP.CAR]),
  /** Wheel rays: hit only the world (never your own chassis or props). */
  wheelRay: groups([GROUP.CAR], [GROUP.WORLD]),
} as const

/**
 * What a collider is. 'loop' and 'wall' are magnetic (mag grip applies above
 * the minimum speed). 'terrain' counts as off-road for lap validity.
 */
export type SurfaceKind =
  | 'road' //     the ribbon's drivable top
  | 'loop' //     loop surface (magnetic)
  | 'wall' //     wall-ride surface (magnetic)
  | 'ramp' //     kicker ramps on the road
  | 'barrier' //  stadium walls, road-side barriers (not drivable)
  | 'skirt' //    underside and sides of the road slab
  | 'terrain' //  ground (off-road)
  | 'floor' //    the catch floor under everything (touching it = auto reset)

export function isMagnetic(s: SurfaceKind): boolean {
  return s === 'loop' || s === 'wall'
}

export function isOnRoad(s: SurfaceKind): boolean {
  return s === 'road' || s === 'loop' || s === 'wall' || s === 'ramp'
}

const surfaceByHandle = new Map<number, SurfaceKind>()

/** Track builder: tag a collider when it is created. */
export function tagSurface(colliderHandle: number, kind: SurfaceKind): void {
  surfaceByHandle.set(colliderHandle, kind)
}

/** Track builder: forget a collider when it is removed. */
export function untagSurface(colliderHandle: number): void {
  surfaceByHandle.delete(colliderHandle)
}

/** Vehicle: what did my wheel ray hit? Unknown colliders read as 'terrain'. */
export function surfaceOf(colliderHandle: number): SurfaceKind {
  return surfaceByHandle.get(colliderHandle) ?? 'terrain'
}

/** What a non-world collider belongs to, so a crash knows what it hit. */
export interface ColliderOwner {
  kind: 'car' | 'remote' | 'prop' | 'smashable' | 'billboard'
  /** Car id, prop cluster id, smashable index... */
  id: string
}

const ownerByHandle = new Map<number, ColliderOwner>()

/** Owners call this when they create a collider (cars, props, smashables, billboards). */
export function tagCollider(colliderHandle: number, owner: ColliderOwner): void {
  ownerByHandle.set(colliderHandle, owner)
}

export function untagCollider(colliderHandle: number): void {
  ownerByHandle.delete(colliderHandle)
}

/** Who owns this collider? undefined for world colliders (use surfaceOf for those). */
export function ownerOf(colliderHandle: number): ColliderOwner | undefined {
  return ownerByHandle.get(colliderHandle)
}

/** NaN firewall helper: true if every number is finite. */
export function finite3(x: number, y: number, z: number): boolean {
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)
}
