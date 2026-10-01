// ============================================================
//  RAPIER TYPES - the physics engine the game actually runs
// ------------------------------------------------------------
//  Two copies of rapier sit in node_modules: the one
//  @react-three/rapier uses (the game's), and an older one that
//  @types/three pulls in. These aliases always point at the game's
//  copy, so the track code is typed against what really runs.
// ============================================================

import type { RapierContext } from '@react-three/rapier'

export type Rapier = RapierContext['rapier']
export type World = RapierContext['world']
export type RigidBody = ReturnType<World['createRigidBody']>
export type Collider = ReturnType<World['createCollider']>
export type ColliderDesc = NonNullable<ReturnType<Rapier['ColliderDesc']['convexHull']>>
