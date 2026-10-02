// ============================================================
//  TELEMETRY + CAR REGISTRY - per-frame state
// ------------------------------------------------------------
//  CONTRACT (orchestrator-owned).
//
//  Mutable singletons. Written every physics step / render frame,
//  read by camera, HUD, audio, fx, Ai and net. They exist so nothing
//  does React setState per frame (CONSTITUTION section 2). Never
//  replace these objects or their vectors - mutate in place.
//
//  Writers:
//    telemetry      - vehicle (the player's car) and its trick/lap trackers
//    cars[]         - each car's owner: vehicle for 'player' and 'ai'
//                     cars (sim), net for 'remote', vehicle for 'ghost'
//  Everyone else only reads.
// ============================================================

import * as THREE from 'three'
import type { SurfaceKind } from './physics'

/** The player's car, in detail. */
export const telemetry = {
  // ---- motion ----
  speedKmh: 0,
  /** Signed forward speed in m/s (negative while reversing). */
  forwardSpeed: 0,
  /** 0..1 normalised engine rpm (audio pitch). Free-revs in the air. */
  rpm: 0,
  gear: 1,
  /** True top speed seen this session, km/h. */
  topSpeedKmh: 0,

  // ---- driver inputs after smoothing (what the car actually received) ----
  throttle: 0, //  0..1
  brake: 0, //     0..1
  steer: 0, //     -1..1, left negative
  handbrake: false,

  // ---- state ----
  /** 0..1 how much the tyres are sliding (trails, audio). */
  slip: 0,
  drifting: false,
  /** Signed drift angle in radians between heading and velocity. */
  driftAngle: 0,
  airborne: false,
  /** Seconds since all four wheels left the ground (0 when grounded). */
  airTime: 0,
  /** Wheels touching something, 0..4. */
  wheelsDown: 0,
  /** Surface under the car right now. */
  surface: 'terrain' as SurfaceKind,
  onRoad: true,
  /** On a loop or wall ride AND fast enough to stick. */
  magGrip: false,
  /** 0..1 how strongly the car is held by magnetic grip (fades as speed drops). */
  magStrength: 0,
  /** 0..1 boost envelope (1 at the kick, eases back to 0). Drives FOV, aberration, speed lines, audio. */
  boost: 0,
  /** 0..1 set on a collision, decays. Drives camera kick, audio thump, fx. */
  impact: 0,
  /** Up-ness of the car: dot(car up, world up). -1 upside down, 1 upright. */
  upright: 1,

  // ---- where on the track ----
  /** Distance along the road centreline, metres (0 = start line). */
  trackS: 0,
  /** Lateral offset from the centreline, metres (+ = right of travel direction). */
  lateral: 0,

  // ---- pose (world space, RENDER-interpolated - smooth at any refresh rate) ----
  carPosition: new THREE.Vector3(0, 2, 0),
  carQuaternion: new THREE.Quaternion(),
  /** Car's local up in world space (render pose). The camera springs its up toward this on loops. */
  carUp: new THREE.Vector3(0, 1, 0),
  carForward: new THREE.Vector3(0, 0, 1),
  carVelocity: new THREE.Vector3(),
  carAngularVelocity: new THREE.Vector3(),
}

export type Telemetry = typeof telemetry

/** Anchor points on a car body, in the car's local space, for fx (trails, lights, underglow). */
export interface CarAnchors {
  /** Rear light positions (trail emitters and tail-light streaks). */
  tailLights: THREE.Vector3[]
  headLights: THREE.Vector3[]
  /** Underglow rectangle half-extents (x = half width, z = half length) and height. */
  underglow: { halfWidth: number; halfLength: number; y: number }
  /** Wheel contact points (for sparks / skid fx), local space at rest. */
  wheels: THREE.Vector3[]
  /** Bonnet camera mount, car space: on top of this body's bonnet, just behind the windscreen base. Absent = the camera rig's default mount. */
  bonnet?: THREE.Vector3
}

export type CarKind = 'player' | 'ai' | 'remote' | 'ghost'

/** One car in the world. Every visible car has an entry in `cars`. */
export interface CarState {
  id: string //       'player', 'ai-1'..'ai-5', 'net-<relayId>', 'ghost'
  kind: CarKind
  name: string
  body: string //     car body id (see vehicle catalog)
  paint: string
  glow: string
  trail: string
  // render pose (interpolated), velocity
  position: THREE.Vector3
  quaternion: THREE.Quaternion
  velocity: THREE.Vector3
  speedKmh: number
  /** 0..1 boost envelope, as telemetry.boost. */
  boost: number
  /** 0..1 slip, as telemetry.slip. */
  slip: number
  airborne: boolean
  // track progress (race positions, minimap)
  trackS: number
  lap: number //       completed laps this race/session
  /** lap + trackS / track length - the race position sort key. */
  progress: number
  /** The car's last completed lap was dirty (too long off-road): it can't count as a best. Writer: the car's lap tracker (vehicle). */
  lastLapDirty: boolean
  /** Exact time of the car's last completed lap, ms (null before the first). Writer: the car's lap tracker. */
  lastLapMs: number | null
  finished: boolean
  finishMs: number
  /** Multiplayer tag: this car is "it". */
  isIt: boolean
  /** Fx anchors for this car's body (set by vehicle when the body is built). */
  anchors: CarAnchors | null
  /** The car's visual root (set by its owner), for fx that need a live transform. */
  object: THREE.Object3D | null
  /** Commands the owner implements. Null for cars nobody can command (remote, ghost). */
  api: CarApi | null
}

export interface CarApi {
  /** Teleport (the one sanctioned snap): zero velocities, place exactly. */
  teleport: (position: THREE.Vector3, quaternion: THREE.Quaternion) => void
  /** Frozen cars ignore input and hold still (countdowns, results). */
  setFrozen: (frozen: boolean) => void
  /** Reset to the nearest road point, facing the driving direction (R). */
  resetToRoad: () => void
}

export function makeCarState(id: string, kind: CarKind, name: string): CarState {
  return {
    id,
    kind,
    name,
    body: 'dart',
    paint: '#1b1f3b',
    glow: '#19e3ff',
    trail: '#19e3ff',
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    velocity: new THREE.Vector3(),
    speedKmh: 0,
    boost: 0,
    slip: 0,
    airborne: false,
    trackS: 0,
    lap: 0,
    progress: 0,
    lastLapDirty: false,
    lastLapMs: null,
    finished: false,
    finishMs: 0,
    isIt: false,
    anchors: null,
    object: null,
    api: null,
  }
}

/**
 * Every car in the world. Add on mount, remove on unmount (owners do this).
 * Readers iterate with a plain for loop (no allocation).
 */
export const cars: CarState[] = []

/** Bumped whenever a car is added or removed, so React lists can re-read `cars`. */
export const carsVersion = { value: 0 }

export function addCar(car: CarState): void {
  const i = cars.findIndex((c) => c.id === car.id)
  if (i >= 0) cars[i] = car
  else cars.push(car)
  carsVersion.value++
}

export function removeCar(id: string): void {
  const i = cars.findIndex((c) => c.id === id)
  if (i >= 0) {
    cars.splice(i, 1)
    carsVersion.value++
  }
}

export function getCar(id: string): CarState | undefined {
  for (let i = 0; i < cars.length; i++) if (cars[i].id === id) return cars[i]
  return undefined
}

/**
 * Rewind: hold Backspace (or LB) and the world runs backwards, up to the rewindSeconds setting.
 * Writer: the vehicle's rewind recorder (src/vehicle/rewind.ts), once per physics step.
 * Readers: the HUD (meter, REWIND tag, lap clock) and its screen tint, audio, play (props and cores ignore a rewinding car).
 */
export const rewind = {
  /** True while the world is running backwards. */
  active: false,
  /** Seconds of rewind stored right now: how far back a hold can go. */
  stored: 0,
  /** The most it can store (the rewindSeconds setting). */
  capacity: 10,
  /** Seconds taken back so far in this hold (0 when not rewinding). */
  rewound: 0,
  /** While rewinding: the player's lap clock at the moment shown, ms (-1 = no lap being timed). */
  lapMs: -1,
  /** Rewind is held but not allowed right now, and why ('' = not refused). The HUD says so in one line. */
  refused: '' as '' | 'multiplayer' | 'countdown',
}

/**
 * The world's light, per frame. Writer: world (its time-of-day clock).
 * Readers: look (headlights, road reflections, env map), audio (night mood),
 * ui. timeOfDay runs 0 (sundown) -> 1 (full night).
 */
export const environment = {
  timeOfDay: 0.12,
  /** 0..1 how "night" it is (stars, windows, headlights follow this). */
  night: 0,
  /** 0..1 headlight strength: 0 before timeOfDay 0.35, 1 by 0.6. */
  headlights: 0,
  /** Unit vector toward the sun (may be below the horizon at night). */
  sunDirection: new THREE.Vector3(0, 0.1, -1),
  /** Unit vector toward the main light actually lighting the scene (sun, then moon/planet glow). */
  keyLightDirection: new THREE.Vector3(0, 0.3, -1),
  /** Current horizon colour (fog / haze), linear-space r,g,b 0..1. */
  horizon: new THREE.Color('#ff3d7f'),
  /** Current zenith colour. */
  zenith: new THREE.Color('#1b0b3a'),
}
