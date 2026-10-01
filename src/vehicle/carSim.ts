// ============================================================
//  CAR SIM - one raycast-suspension car (player and Ai alike)
// ------------------------------------------------------------
//  One dynamic rigid body (the chassis). No wheel colliders: each
//  corner is a ray from a mount point along the car's own "down",
//  and everything the car does is a force at the four contact
//  patches:
//
//    suspension    spring + damper along the car's up axis
//    longitudinal  engine / brakes / rolling resistance
//    lateral       slip-angle tyre curve (TYRE in tuning.ts)
//    ...clipped together by a friction circle, which is what turns
//    "throttle in a corner" into "the rear steps out".
//
//  On top of v1's proven core this adds, for this world:
//    magnetic grip  loops and wall rides hold the car above a speed
//    boost pads     a kick plus a decaying push past top speed
//    track position every car knows its distance along the road
//    resets         to the road, to the grid, and automatic
//    crash sensing  what the chassis hit and how hard
//
//  Every car owns one CarSim. step() runs in useBeforePhysicsStep at
//  a fixed 60 Hz, so the physics is deterministic and the same for a
//  human, the demo autopilot and an Ai racer.
//
//  ALLOCATION: none per step from this file. Vectors are module temps
//  shared by every car (cars step one after another, never at once)
//  or per-car fields made once. rapier's own getters (translation(),
//  linvel() ...) return small objects; that is unavoidable.
// ============================================================

import * as THREE from 'three'
import type { RapierCollider, RapierContext, RapierRigidBody } from '@react-three/rapier'
import { GROUPS, isMagnetic, isOnRoad, ownerOf, surfaceOf } from '../core/physics'
import type { SurfaceKind } from '../core/physics'
import type { NearestHit, TrackRuntime } from '../track/types'
import type { BodyTuning } from './bodies/catalog'
import { roadResetPose, startPose } from './trackNav'
import {
  AERO,
  ASSIST,
  BOOST,
  CHASSIS,
  DRIVE,
  DT,
  GEAR_TOP_KMH,
  GRAVITY,
  MAG,
  RAY_LENGTH,
  RPM,
  STATE,
  STEERING,
  SUSPENSION,
  TYRE,
  VISUAL,
  WHEEL,
} from './tuning'

type RapierWorld = RapierContext['world']
type RapierApi = RapierContext['rapier']
type RapierRay = InstanceType<RapierApi['Ray']>

// ---------------------------------------------------------------- module temps

const _arm = new THREE.Vector3()
const _pointVel = new THREE.Vector3()
const _ground = new THREE.Vector3()
const _force = new THREE.Vector3()
const _tyreSum = new THREE.Vector3()
const _tmp = new THREE.Vector3()
const _anchor = new THREE.Vector3()
const _magN = new THREE.Vector3()
const _resetPos = new THREE.Vector3()
const _resetQuat = new THREE.Quaternion()
const _rv = { x: 0, y: 0, z: 0 }
const _rp = { x: 0, y: 0, z: 0 }
const _rq = { x: 0, y: 0, z: 0, w: 1 }
const WORLD_UP = new THREE.Vector3(0, 1, 0)

const WHEELS = 4
/** Mount points, chassis-local: FL, FR, RL, RR (+X is the car's left). */
const ANCHORS: readonly THREE.Vector3[] = [
  new THREE.Vector3(WHEEL.halfTrack, WHEEL.anchorY, WHEEL.halfBase),
  new THREE.Vector3(-WHEEL.halfTrack, WHEEL.anchorY, WHEEL.halfBase),
  new THREE.Vector3(WHEEL.halfTrack, WHEEL.anchorY, -WHEEL.halfBase),
  new THREE.Vector3(-WHEEL.halfTrack, WHEEL.anchorY, -WHEEL.halfBase),
]

// ---------------------------------------------------------------- helpers

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}
function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1)
  return t * t * (3 - 2 * t)
}
function approach(cur: number, target: number, rate: number, dt: number): number {
  return cur + (target - cur) * (1 - Math.exp(-rate * dt))
}
function finiteV(v: THREE.Vector3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)
}

/**
 * Lateral grip vs slip angle, 0..1 of mu. Climbs to 1 at the peak, then eases
 * DOWN to the axle's slide plateau. The per-axle plateaus decide whether a
 * slide straightens or spins - see TYRE in tuning.ts.
 */
function tyreCurve(slipAngle: number, slideFrac: number): number {
  const a = slipAngle < 0 ? -slipAngle : slipAngle
  if (a <= TYRE.peakSlip) return a / TYRE.peakSlip
  if (a >= TYRE.tailSlip) return slideFrac
  const t = (a - TYRE.peakSlip) / (TYRE.tailSlip - TYRE.peakSlip)
  return 1 + (slideFrac - 1) * (t * t * (3 - 2 * t))
}

// ---------------------------------------------------------------- types

/** What drives the car this step (a person, the autopilot or an Ai brain). */
export interface CarControls {
  throttle: number
  brake: number
  steer: number //  -1..1, left negative
  handbrake: boolean
  /** Engine power multiplier (Ai difficulty / catch-up). 1 = normal. */
  powerScale: number
}

/** Live handling multipliers (the player's come from Settings; Ai cars use neutral ones). */
export interface Handling {
  grip: number
  /** Steering gain after the knob's gamma (1 = default). */
  steerGain: number
  stability: number
  power: number
  brakes: number
  topSpeedKmh: number
  magGripKmh: number
  boostStrength: number
}

export type ResetKind = 'road' | 'start' | 'auto'

/** One-shot things that happened this step, for the owner to turn into events. */
export interface StepNews {
  boosted: number //       pad strength, 0 = none
  magOn: SurfaceKind | null
  magOff: SurfaceKind | null
  magFell: boolean
  crash: number //         intensity 0..1, 0 = none
  crashWhat: 'wall' | 'terrain' | 'prop' | 'car' | 'smashable' | 'barrier'
  crashCarId: string | null
  reset: ResetKind | null
  resetReason: string
  teleported: boolean
}

// ---------------------------------------------------------------- the sim

export class CarSim {
  readonly id: string

  // ---- inputs, set by the owner every step ----
  readonly controls: CarControls = { throttle: 0, brake: 0, steer: 0, handbrake: false, powerScale: 1 }
  readonly handling: Handling = {
    grip: 1,
    steerGain: 1,
    stability: 1,
    power: 1,
    brakes: 1,
    topSpeedKmh: 260,
    magGripKmh: 70,
    boostStrength: 1,
  }
  tuning: BodyTuning = { mass: 1, power: 1, grip: 1 }
  frozen = false
  /** Start-grid slot for Shift+R / spawn. */
  gridSlot = 0

  // ---- raw physics pose and basis (this step, not interpolated) ----
  readonly pos = new THREE.Vector3()
  readonly quat = new THREE.Quaternion()
  readonly fwd = new THREE.Vector3(0, 0, 1)
  readonly up = new THREE.Vector3(0, 1, 0)
  readonly right = new THREE.Vector3(-1, 0, 0)
  readonly linvel = new THREE.Vector3()
  readonly angvel = new THREE.Vector3()
  /** Average ground normal under the grounded wheels (world up when airborne). */
  readonly groundNormal = new THREE.Vector3(0, 1, 0)
  private readonly prevLinvel = new THREE.Vector3()

  // ---- outputs (telemetry for the player, CarState for everyone) ----
  speed = 0 //          m/s, full 3D
  speedKmh = 0
  forwardSpeed = 0 //   signed m/s along the nose
  rpm: number = RPM.idle
  gear = 1
  reversing = false
  slip = 0
  drifting = false
  driftAngle = 0 //     radians, + = travelling to the car's right
  airborne = false
  airTime = 0
  wheelsDown = 0
  surface: SurfaceKind = 'road'
  onRoad = true
  magGrip = false
  magStrength = 0
  boost = 0
  impact = 0
  upright = 1
  trackS = 0
  lateral = 0
  hasTrackS = false
  /** Body-frame accelerations for the visual roll / pitch springs. */
  latAccel = 0
  longAccel = 0
  /** Brake light level 0..1. */
  brakeLight = 0
  /** Physics steps since the car (re)spawned. */
  steps = 0

  // ---- per-wheel ----
  readonly wheelContact: boolean[] = [false, false, false, false]
  readonly wheelSurface: SurfaceKind[] = ['road', 'road', 'road', 'road']
  readonly wheelCompression = new Float64Array(WHEELS) //  0..1 of travel
  readonly wheelHubY = new Float64Array(WHEELS) //          chassis-local hub height (visual)
  readonly wheelSpin = new Float64Array(WHEELS) //          accumulated radians
  readonly wheelSlip = new Float64Array(WHEELS) //          lateral slide 0..1
  steerAngle = 0 //                                         road-wheel angle, + = left

  /** What happened this step (read after step(), reset at the start of the next). */
  readonly news: StepNews = {
    boosted: 0,
    magOn: null,
    magOff: null,
    magFell: false,
    crash: 0,
    crashWhat: 'wall',
    crashCarId: null,
    reset: null,
    resetReason: '',
    teleported: false,
  }

  // ---- private per-car state ----
  private readonly hit: NearestHit = { s: 0, index: 0, lateral: 0, height: 0, distance: 0, onRoad: true }
  private readonly compression = new Float64Array(WHEELS)
  private readonly suspForce = new Float64Array(WHEELS)
  private readonly rayToi = new Float64Array(WHEELS)
  private readonly wheelOmega = new Float64Array(WHEELS)
  private readonly longClip = new Float64Array(WHEELS)
  private readonly driveShare = new Float64Array(WHEELS)
  private readonly contactPts = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]
  private readonly wheelNormals = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]
  private readonly wheelFwd = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]
  private readonly wheelRight = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]
  private readonly magNormal = new THREE.Vector3(0, 1, 0)
  private appliedMass = 0
  private shiftTimer = 0
  private settleSteps = 6
  private uprightTimer = 0
  private buriedTimer = 0
  private magGrace = 0
  private magSurface: SurfaceKind = 'loop'
  private boostAge = 99
  private boostPower = 0
  private boostCooldown: Float64Array = new Float64Array(0)
  private crashCooldown = 0
  private nanReported = false
  private pendingReset: ResetKind | null = null
  private pendingReason = ''
  private pendingTeleport = false
  private readonly teleportPos = new THREE.Vector3()
  private readonly teleportQuat = new THREE.Quaternion()
  private teleportS = -1
  private pendingSpeed = -1

  constructor(id: string) {
    this.id = id
  }

  // ------------------------------------------------------------ commands (queued for the next step)

  /** Put the car exactly here, stopped (the one sanctioned snap). */
  teleport(position: THREE.Vector3, quaternion: THREE.Quaternion, s = -1): void {
    if (!finiteV(position) || !Number.isFinite(quaternion.w)) return
    this.teleportPos.copy(position)
    this.teleportQuat.copy(quaternion).normalize()
    this.teleportS = s
    this.pendingTeleport = true
    this.pendingReset = null
  }

  /** Dev / test harness: set the car moving along its nose at this speed next step. */
  setForwardSpeed(kmh: number): void {
    if (Number.isFinite(kmh)) this.pendingSpeed = kmh / 3.6
  }

  /** R: back to the nearest road point. 'start' = Shift+R. 'auto' = the game noticed you're stuck. */
  requestReset(kind: ResetKind, reason = ''): void {
    if (this.pendingTeleport) return
    // A restart outranks a road reset queued in the same step.
    if (this.pendingReset === 'start' && kind !== 'start') return
    this.pendingReset = kind
    this.pendingReason = reason
  }

  // ------------------------------------------------------------ the step

  /**
   * Advance one fixed physics step. `chassis` is the car's own collider (for
   * crash sensing); `track` may be null while a track is loading.
   */
  step(body: RapierRigidBody, world: RapierWorld, ray: RapierRay, chassis: RapierCollider | null, track: TrackRuntime | null): void {
    const news = this.news
    news.boosted = 0
    news.magOn = null
    news.magOff = null
    news.magFell = false
    news.crash = 0
    news.crashCarId = null
    news.reset = null
    news.teleported = false

    this.applyMass(body)
    // rapier's addForce / addTorque PERSIST until reset. Everything below is a
    // fresh per-step force, so clear last step's first (forgetting this hands
    // the car a permanent thruster).
    body.resetForces(false)
    body.resetTorques(false)

    // ---- queued teleports and resets: the step ends here when one fires ----
    if (this.pendingReset && track) {
      const kind = this.pendingReset
      this.pendingReset = null
      const t = body.translation()
      let s: number
      if (kind === 'start') s = startPose(track, this.gridSlot, _resetPos, _resetQuat)
      else s = roadResetPose(track, t.x, t.y, t.z, this.hasTrackS ? this.trackS : undefined, 1.0, _resetPos, _resetQuat)
      this.place(body, _resetPos, _resetQuat, s)
      news.reset = kind
      news.resetReason = this.pendingReason
      return
    }
    if (this.pendingTeleport) {
      this.pendingTeleport = false
      this.place(body, this.teleportPos, this.teleportQuat, this.teleportS)
      return
    }

    if (this.pendingSpeed >= 0) {
      const r0 = body.rotation()
      this.quat.set(r0.x, r0.y, r0.z, r0.w)
      this.fwd.set(0, 0, 1).applyQuaternion(this.quat)
      _rv.x = this.fwd.x * this.pendingSpeed
      _rv.y = this.fwd.y * this.pendingSpeed
      _rv.z = this.fwd.z * this.pendingSpeed
      this.pendingSpeed = -1
      if (finiteV(this.fwd)) {
        body.setLinvel(_rv, true)
        this.prevLinvel.set(_rv.x, _rv.y, _rv.z)
        this.settleSteps = 2
      }
    }

    // ---- read the body (rapier allocates these; nothing else here does) ----
    const t = body.translation()
    const r = body.rotation()
    const lv = body.linvel()
    const av = body.angvel()
    const cm = body.worldCom()
    this.pos.set(t.x, t.y, t.z)
    this.quat.set(r.x, r.y, r.z, r.w)
    this.linvel.set(lv.x, lv.y, lv.z)
    this.angvel.set(av.x, av.y, av.z)
    const comX = cm.x
    const comY = cm.y
    const comZ = cm.z

    // The NaN firewall, part 1: a poisoned body never gets fed back to rapier.
    if (!finiteV(this.pos) || !finiteV(this.linvel) || !finiteV(this.angvel) || !Number.isFinite(this.quat.w) || !Number.isFinite(comX + comY + comZ)) {
      this.reportNaN('body state')
      this.requestReset('auto', 'nan')
      return
    }

    this.steps++
    const pos = this.pos
    const linvel = this.linvel
    const angvel = this.angvel
    const up = this.up
    const fwd = this.fwd
    const right = this.right
    // Chassis basis: +Z forward, +Y up, +X the car's LEFT, so right = -X.
    fwd.set(0, 0, 1).applyQuaternion(this.quat)
    up.set(0, 1, 0).applyQuaternion(this.quat)
    right.set(-1, 0, 0).applyQuaternion(this.quat)
    this.upright = up.y

    const massRatio = this.appliedMass > 0 ? this.appliedMass / CHASSIS.mass : 1
    const mass = CHASSIS.mass * massRatio
    const h = this.handling
    const c = this.controls
    // Inputs are clamped and finite before they touch anything.
    let throttle = Number.isFinite(c.throttle) ? clamp(c.throttle, 0, 1) : 0
    let brake = Number.isFinite(c.brake) ? clamp(c.brake, 0, 1) : 0
    let steer = Number.isFinite(c.steer) ? clamp(c.steer, -1, 1) : 0
    let handbrake = c.handbrake
    const powerScale = Number.isFinite(c.powerScale) ? clamp(c.powerScale, 0.3, 1.6) : 1
    if (this.frozen) {
      throttle = 0
      brake = 1
      steer = 0
      handbrake = false
    }

    // ---- impact: |dv| in one step (dv x mass IS the collision impulse) ----
    if (this.settleSteps > 0) {
      this.settleSteps--
    } else {
      const dv = _tmp.subVectors(linvel, this.prevLinvel).length()
      const hit = clamp((dv - STATE.impactThreshold) / STATE.impactRange, 0, 1)
      if (hit > this.impact) this.impact = hit
      if (hit > STATE.crashImpact && this.crashCooldown <= 0 && chassis) this.senseCrash(world, chassis, hit)
    }
    this.prevLinvel.copy(linvel)
    if (this.crashCooldown > 0) this.crashCooldown -= DT
    this.impact = Math.max(0, this.impact - STATE.impactDecay * DT)

    const speed = linvel.length()
    this.speed = speed
    this.speedKmh = speed * 3.6
    const vLongCar = linvel.dot(fwd)
    const vLatCar = linvel.dot(right)
    this.forwardSpeed = vLongCar

    // Drift angle: + when the car travels to its own right (nose pointing left of the path).
    const beta = speed > 1.5 ? Math.atan2(vLatCar, vLongCar) : 0
    this.driftAngle = beta

    // Counter-steer = turning the nose BACK toward the velocity. beta > 0 needs a
    // right yaw and steer is +right, so it is simply sign(steer) === sign(beta).
    const counterSteer = Math.abs(beta) > ASSIST.counterSteerBeta && Math.abs(steer) > 0.15 && Math.sign(steer) === Math.sign(beta)

    // ---- steering: constant-g rack, rate limited ----
    const gCap = (STEERING.wheelbase * STEERING.latLimitG * GRAVITY * h.steerGain) / Math.max(speed * speed, 1)
    let limit = Math.min(STEERING.maxAngleLow, Math.max(STEERING.minAngle, gCap))
    // The rack opens wider only to CATCH a slide, never to feed one.
    if (this.drifting && counterSteer) limit = Math.max(limit, STEERING.driftAngle)
    const steerTarget = -steer * limit // a positive road-wheel angle steers left
    const maxDelta = STEERING.rackRate * DT
    this.steerAngle += clamp(steerTarget - this.steerAngle, -maxDelta, maxDelta)

    // ---- boost envelope ----
    this.boostAge += DT
    this.boost = this.boostAge < BOOST.seconds ? 1 - smoothstep(0, 1, this.boostAge / BOOST.seconds) : 0

    // ---- engine / brakes / reverse ----
    const vTop = Math.max(10, h.topSpeedKmh / 3.6)
    const vLimit = vTop * (1 + BOOST.overTop * this.boost)
    let brakeCmd = brake
    let engineTotal = 0
    let reversing = false
    if (brake > 0.05 && throttle < 0.1 && vLongCar < 0.6 && !this.frozen) {
      reversing = true
      brakeCmd = 0
      if (Math.abs(vLongCar) * 3.6 < DRIVE.reverseTopKmh) engineTotal = -brake * DRIVE.reverseForce * massRatio
    } else if (throttle > 0) {
      const power = h.power * this.tuning.power * powerScale
      // Power sized from the top speed: the car still pulls at the top, whatever the setting.
      const pMax = DRIVE.powerHeadroom * (AERO.drag * vTop * vTop + TYRE.rollingResistance * mass * GRAVITY) * vTop
      const v = Math.max(vLongCar, 1)
      const traction = Math.min(DRIVE.maxForce, pMax / v)
      // Soft limiter across the last band before the (boost-raised) limit.
      const lim = 1 - smoothstep(vLimit * (1 - DRIVE.limiterBand), vLimit, vLongCar)
      engineTotal = throttle * power * traction * lim
    }
    this.reversing = reversing
    const brakeTotal = DRIVE.brakeForce * h.brakes * massRatio
    const brakeFrontWheel = (brakeTotal * DRIVE.brakeFrontBias) / 2
    const brakeRearWheel = (brakeTotal * (1 - DRIVE.brakeFrontBias)) / 2
    const quarterMass = mass / 4
    const grip = h.grip * this.tuning.grip

    // =========================================================
    //  PASS A - raycast + spring / damper
    // =========================================================
    const k = SUSPENSION.stiffness * massRatio
    const dC = SUSPENSION.dampCompress * massRatio
    const dR = SUSPENSION.dampRebound * massRatio
    const fMax = SUSPENSION.maxForce * massRatio
    let grounded = 0
    let magWheels = 0
    let onRoadWheels = 0
    let floorTouch = false
    _magN.set(0, 0, 0)
    this.groundNormal.set(0, 0, 0)
    ray.dir.x = -up.x
    ray.dir.y = -up.y
    ray.dir.z = -up.z
    for (let i = 0; i < WHEELS; i++) {
      _anchor.copy(ANCHORS[i]).applyQuaternion(this.quat).add(pos)
      ray.origin.x = _anchor.x
      ray.origin.y = _anchor.y
      ray.origin.z = _anchor.z
      const hit = world.castRayAndGetNormal(ray, RAY_LENGTH, true, undefined, GROUPS.wheelRay, undefined, body)
      if (!hit) {
        this.wheelContact[i] = false
        this.compression[i] = 0
        this.suspForce[i] = 0
        this.rayToi[i] = RAY_LENGTH
        continue
      }
      const toi = hit.timeOfImpact
      const surf = surfaceOf(hit.collider.handle)
      this.wheelContact[i] = true
      this.wheelSurface[i] = surf
      grounded++
      this.rayToi[i] = toi
      this.compression[i] = clamp(RAY_LENGTH - toi, 0, WHEEL.restLength)
      this.contactPts[i].copy(up).multiplyScalar(-toi).add(_anchor)
      const n = this.wheelNormals[i].set(hit.normal.x, hit.normal.y, hit.normal.z)
      if (!finiteV(n) || n.lengthSq() < 0.5) n.copy(up)
      this.groundNormal.add(n)
      if (isMagnetic(surf)) {
        magWheels++
        _magN.add(n)
        this.magSurface = surf
      }
      if (isOnRoad(surf)) onRoadWheels++
      if (surf === 'floor') floorTouch = true

      // Velocity of the chassis at the contact patch: v + w x r.
      _arm.set(this.contactPts[i].x - comX, this.contactPts[i].y - comY, this.contactPts[i].z - comZ)
      _pointVel.crossVectors(angvel, _arm).add(linvel)
      const suspVel = _pointVel.dot(up) // + extending, - compressing
      const f = k * this.compression[i] - (suspVel < 0 ? dC : dR) * suspVel
      this.suspForce[i] = clamp(f, 0, fMax) // a suspension pushes, never pulls
    }
    if (grounded > 0) this.groundNormal.normalize()
    else this.groundNormal.copy(WORLD_UP)
    this.wheelsDown = grounded
    const airborne = grounded === 0
    this.airTime = airborne ? this.airTime + DT : 0

    // ---- anti-roll bars: load the outside corner, unload the inside ----
    const sf = this.suspForce
    const cp = this.compression
    if (this.wheelContact[0] || this.wheelContact[1]) {
      const d = (cp[0] - cp[1]) * SUSPENSION.antiRollFront * massRatio
      sf[0] = clamp(sf[0] + d, 0, fMax)
      sf[1] = clamp(sf[1] - d, 0, fMax)
    }
    if (this.wheelContact[2] || this.wheelContact[3]) {
      const d = (cp[2] - cp[3]) * SUSPENSION.antiRollRear * massRatio
      sf[2] = clamp(sf[2] + d, 0, fMax)
      sf[3] = clamp(sf[3] - d, 0, fMax)
    }

    // ---- limited-slip diff: torque goes where the load is ----
    // A flat 50/50 split saturates the unloaded inside rear mid-corner and the
    // tail snaps. Biasing by load makes that a slide you feel arriving.
    const rearLoad = sf[2] + sf[3]
    const shareRL = rearLoad > 1 ? clamp(sf[2] / rearLoad, DRIVE.torqueBiasMin, DRIVE.torqueBiasMax) : 0.5
    this.driveShare[2] = shareRL
    this.driveShare[3] = 1 - shareRL

    // =========================================================
    //  PASS B - tyres, friction circle, apply
    // =========================================================
    _tyreSum.set(0, 0, 0)
    const cosS = Math.cos(this.steerAngle)
    const sinS = Math.sin(this.steerAngle)
    let nanForce = false
    for (let i = 0; i < WHEELS; i++) {
      const isFront = i < 2
      const wf = this.wheelFwd[i]
      const wr = this.wheelRight[i]
      if (isFront) {
        wf.copy(fwd).multiplyScalar(cosS).addScaledVector(right, -sinS).normalize()
        wr.copy(right).multiplyScalar(cosS).addScaledVector(fwd, sinS).normalize()
      } else {
        wf.copy(fwd)
        wr.copy(right)
      }
      if (!this.wheelContact[i]) {
        this.wheelSlip[i] = 0
        this.longClip[i] = 0
        continue
      }
      const load = sf[i]
      const cpi = this.contactPts[i]
      _arm.set(cpi.x - comX, cpi.y - comY, cpi.z - comZ)
      _pointVel.crossVectors(angvel, _arm).add(linvel)
      _ground.copy(_pointVel).addScaledVector(up, -_pointVel.dot(up)) // flatten into the tyre plane
      const vLong = _ground.dot(wf)
      const vLat = _ground.dot(wr)

      // ---- lateral: slip angle -> curve -> force ----
      const alpha = Math.atan2(Math.abs(vLat), Math.max(Math.abs(vLong), TYRE.slipSpeedFloor))
      let mu = (isFront ? TYRE.muFront : TYRE.muRear) * grip
      if (!isFront && handbrake) mu *= TYRE.handbrakeGrip
      const maxF = mu * load
      let fLat = -Math.sign(vLat) * maxF * tyreCurve(alpha, isFront ? TYRE.slideFrontFrac : TYRE.slideRearFrac)
      if (speed < 2) fLat -= vLat * load * ASSIST.lowSpeedLateral
      this.wheelSlip[i] = clamp((alpha - TYRE.peakSlip) / (TYRE.tailSlip - TYRE.peakSlip), 0, 1)

      // ---- longitudinal: drive + brakes + rolling resistance ----
      const driveHere = isFront ? 0 : engineTotal * this.driveShare[i]
      let fLong = driveHere
      const brakeF = brakeCmd * (isFront ? brakeFrontWheel : brakeRearWheel) + (!isFront && handbrake ? DRIVE.handbrakeForce * massRatio : 0)
      if (brakeF > 0) {
        // Never brake past a standstill: cap at what stops this corner this step.
        fLong -= Math.sign(vLong) * Math.min(brakeF, (Math.abs(vLong) * quarterMass) / DT)
      }
      fLong -= Math.sign(vLong) * TYRE.rollingResistance * load

      // ---- friction circle: one grip budget for cornering AND driving ----
      const requestedLong = Math.abs(fLong)
      const mag = Math.hypot(fLong, fLat)
      if (mag > maxF && mag > 1e-4) {
        if (!isFront && brakeCmd > 0.05 && !handbrake && engineTotal <= 0) {
          // BRAKE BALANCE (v1's "braking into a corner spins me" fix). Scaling
          // proportionally stole the rears' cornering grip exactly when load
          // transfer had already halved it. Street-car rule: the rears keep their
          // LATERAL grip first and braking gets what is left. Fronts stay
          // proportional (a washed-out front is understeer - safe).
          if (Math.abs(fLat) > maxF) fLat = Math.sign(fLat) * maxF
          const room = Math.sqrt(Math.max(0, maxF * maxF - fLat * fLat))
          if (Math.abs(fLong) > room) fLong = Math.sign(fLong) * room
        } else {
          const scale = maxF / mag
          fLong *= scale
          fLat *= scale
        }
      }
      const availableLong = Math.sqrt(Math.max(0, maxF * maxF - fLat * fLat))
      this.longClip[i] = clamp((requestedLong - availableLong) / Math.max(availableLong, 500), 0, 1)

      // ---- apply: suspension along up, tyre forces in the ground plane ----
      _force.copy(up).multiplyScalar(load).addScaledVector(wf, fLong).addScaledVector(wr, fLat)
      _tmp.set(0, 0, 0).addScaledVector(wf, fLong).addScaledVector(wr, fLat)
      _tyreSum.add(_tmp)
      // The NaN firewall, part 2: the last gate before rapier.
      if (!finiteV(_force) || !finiteV(cpi)) {
        nanForce = true
        continue
      }
      _rv.x = _force.x
      _rv.y = _force.y
      _rv.z = _force.z
      _rp.x = cpi.x
      _rp.y = cpi.y
      _rp.z = cpi.z
      body.addForceAtPoint(_rv, _rp, true)
    }
    if (nanForce) {
      this.reportNaN('wheel force')
      this.requestReset('auto', 'nan')
    }
    this.latAccel = _tyreSum.dot(right) / mass
    this.longAccel = _tyreSum.dot(fwd) / mass

    // ---- aero ----
    if (speed > 0.1) {
      const drag = AERO.drag * speed
      this.addForce(body, -linvel.x * drag, -linvel.y * drag, -linvel.z * drag)
    }
    if (!airborne) {
      const down = AERO.downforce * speed * speed
      this.addForce(body, -up.x * down, -up.y * down, -up.z * down)
    }

    // ---- magnetic grip on loops and wall rides ----
    this.stepMagnet(body, mass, magWheels, airborne)

    // ---- boost pads ----
    if (track) this.stepBoost(body, track, mass, airborne)
    if (this.boost > 0 && !airborne && vLongCar > 0) {
      const push = BOOST.accel * this.boostPower * this.boost * mass
      this.addForce(body, fwd.x * push, fwd.y * push, fwd.z * push)
    }

    // ---- intent: does the player MEAN to be sideways? ----
    // The handbrake says yes outright. Steering says yes only as a counter-steer
    // (a driver holding a slide); steering INTO a slide is a player who has lost
    // it, so the safety net stays mostly on. Throttle never counts: a kid holds
    // throttle all the time, it says nothing.
    const steerMag = smoothstep(ASSIST.driftIntentLo, ASSIST.driftIntentHi, Math.abs(steer))
    const steerIntent = counterSteer ? steerMag : steerMag * ASSIST.steerIntoIntent
    const wantsDrift = Math.max(handbrake ? 1 : 0, steerIntent)
    const assistGain = 1 - wantsDrift
    const stab = clamp(Number.isFinite(h.stability) ? h.stability : 1, 0.4, 2)
    const inertiaScale = massRatio

    if (!airborne) {
      // ---- yaw stability: a light hand, released for a slide, firmed up hands-off ----
      const yawRate = angvel.dot(up)
      let yawK = this.drifting ? ASSIST.yawDampDrift + (ASSIST.yawDampRecover * stab - ASSIST.yawDampDrift) * assistGain : ASSIST.yawDamp
      // Brake stability: braking mid-corner adds yaw damping (never while handbraking).
      if (!handbrake && brakeCmd > 0.05) yawK += ASSIST.brakeYawDamp * stab * brakeCmd
      const yt = -yawRate * yawK * inertiaScale
      this.addTorque(body, up.x * yt, up.y * yt, up.z * yt)

      // ---- drift recovery: the missing spring that pulls the nose back onto the path ----
      if (!reversing && assistGain > 0.01 && speed > ASSIST.assistSpeedLo) {
        const m = Math.abs(beta)
        if (m > ASSIST.driftDeadband) {
          const over = Math.sign(beta) * Math.min(m - ASSIST.driftDeadband, 1.2)
          const ramp = smoothstep(ASSIST.assistSpeedLo, ASSIST.assistSpeedHi, speed)
          const tq = clamp(-ASSIST.driftRestore * stab * over * assistGain * ramp, -ASSIST.driftRestoreMax * stab, ASSIST.driftRestoreMax * stab) * inertiaScale
          this.addTorque(body, up.x * tq, up.y * tq, up.z * tq)
        }
      }

      // ---- landing save: one to three wheels down and tilted -> ease it onto its wheels ----
      if (grounded < 4) {
        _tmp.crossVectors(up, this.groundNormal)
        const tilt = _tmp.length()
        if (tilt > 0.05 && up.dot(this.groundNormal) > -0.2) {
          const g = 2600 * inertiaScale
          this.addTorque(body, _tmp.x * g, _tmp.y * g, _tmp.z * g)
        }
      }
    } else {
      // ---- air control: generous but calm. Handbrake + steer rolls instead of yawing. ----
      const pitchT = (throttle - brake) * ASSIST.airPitch * inertiaScale
      const yawT = handbrake ? 0 : -steer * ASSIST.airYaw * inertiaScale
      const rollT = handbrake ? steer * ASSIST.airRoll * inertiaScale : 0
      const damp = ASSIST.airAngularDamp * 100 * inertiaScale
      this.addTorque(
        body,
        right.x * pitchT + WORLD_UP.x * yawT + fwd.x * rollT - angvel.x * damp,
        right.y * pitchT + WORLD_UP.y * yawT + fwd.y * rollT - angvel.y * damp,
        right.z * pitchT + WORLD_UP.z * yawT + fwd.z * rollT - angvel.z * damp,
      )
    }

    // =========================================================
    //  STATE
    // =========================================================
    const rearLat = (this.wheelSlip[2] + this.wheelSlip[3]) * 0.5
    const frontLat = (this.wheelSlip[0] + this.wheelSlip[1]) * 0.5
    let longSlip = 0
    for (let i = 0; i < WHEELS; i++) if (this.longClip[i] > longSlip) longSlip = this.longClip[i]
    this.drifting = !airborne && speed > STATE.driftSpeed && (rearLat > STATE.driftSlip || (handbrake && speed > STATE.driftSpeed - 1))
    // slip means LATERAL slide only - trails and squeal must not light up on straight braking.
    this.slip = airborne ? this.slip * 0.9 : clamp(Math.max(rearLat, frontLat * 0.55), 0, 1)
    this.airborne = airborne
    this.brakeLight = this.frozen ? 0.3 : Math.max(brakeCmd, handbrake ? 0.6 : 0)

    // Surface under the car: magnetic wins, then road, then whatever the first wheel sees.
    if (grounded > 0) {
      if (magWheels > 0) this.surface = this.magSurface
      else if (onRoadWheels > 0) this.surface = 'road'
      else for (let i = 0; i < WHEELS; i++) if (this.wheelContact[i]) {
        this.surface = this.wheelSurface[i]
        break
      }
    }

    this.updateGearAndRpm(throttle, reversing, longSlip, airborne)

    // ---- wheel visuals ----
    for (let i = 0; i < WHEELS; i++) {
      this.wheelHubY[i] = ANCHORS[i].y - (this.rayToi[i] - WHEEL.radius)
      this.wheelCompression[i] = this.compression[i] / WHEEL.restLength
      let target: number
      if (!this.wheelContact[i]) target = this.wheelOmega[i] * 0.985
      else if (i >= 2 && handbrake) target = 0 // locked rears: the visual half of a handbrake turn
      else {
        target = linvel.dot(this.wheelFwd[i]) / WHEEL.radius
        if (i >= 2 && engineTotal > 0 && this.longClip[i] > 0) target *= 1 + this.longClip[i] * 1.1
      }
      // In the air the driven wheels spin up with the throttle (it looks like the engine sounds).
      if (!this.wheelContact[i] && i >= 2) target += throttle * 60
      this.wheelOmega[i] = approach(this.wheelOmega[i], target, VISUAL.spinRate, DT)
      this.wheelSpin[i] += this.wheelOmega[i] * DT
      if (this.wheelSpin[i] > 1e4 || this.wheelSpin[i] < -1e4) this.wheelSpin[i] %= Math.PI * 2
    }

    // ---- where on the track ----
    if (track) this.updateTrackPosition(track, onRoadWheels, grounded)

    // ---- frozen cars hold still (countdowns, results): keep only vertical settling ----
    if (this.frozen) {
      const v = body.linvel()
      _rv.x = 0
      _rv.y = Number.isFinite(v.y) ? v.y : 0
      _rv.z = 0
      body.setLinvel(_rv, true)
      _rv.y = 0
      body.setAngvel(_rv, true)
    }

    // ---- automatic resets ----
    if (track) this.checkAutoReset(track, floorTouch)
  }

  // ------------------------------------------------------------ pieces of the step

  private addForce(body: RapierRigidBody, x: number, y: number, z: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      this.reportNaN('force')
      return
    }
    _rv.x = x
    _rv.y = y
    _rv.z = z
    body.addForce(_rv, true)
  }

  private addTorque(body: RapierRigidBody, x: number, y: number, z: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      this.reportNaN('torque')
      return
    }
    _rv.x = x
    _rv.y = y
    _rv.z = z
    body.addTorque(_rv, true)
  }

  /**
   * Mass, centre of mass and inertia come from here, not from the collider (it
   * has density 0), so they are explicit and tunable per body. Re-applied when
   * the garage swaps the body.
   */
  private applyMass(body: RapierRigidBody): void {
    const want = CHASSIS.mass * clamp(this.tuning.mass, 0.6, 1.6)
    if (Math.abs(want - this.appliedMass) < 0.5) return
    const s = want / CHASSIS.mass
    _rv.x = 0
    _rv.y = CHASSIS.comY
    _rv.z = 0
    body.setAdditionalMassProperties(want, _rv, { x: CHASSIS.inertia.x * s, y: CHASSIS.inertia.y * s, z: CHASSIS.inertia.z * s }, _rq, true)
    this.appliedMass = want
  }

  /** Snap the body to a pose with zero velocity, and forget anything in flight. */
  private place(body: RapierRigidBody, p: THREE.Vector3, q: THREE.Quaternion, s: number): void {
    if (!finiteV(p) || !Number.isFinite(q.x + q.y + q.z + q.w)) return
    _rp.x = p.x
    _rp.y = p.y
    _rp.z = p.z
    body.setTranslation(_rp, true)
    _rq.x = q.x
    _rq.y = q.y
    _rq.z = q.z
    _rq.w = q.w
    body.setRotation(_rq, true)
    _rq.x = 0
    _rq.y = 0
    _rq.z = 0
    _rq.w = 1
    _rv.x = 0
    _rv.y = 0
    _rv.z = 0
    body.setLinvel(_rv, true)
    body.setAngvel(_rv, true)
    body.resetForces(true)
    body.resetTorques(true)
    this.pos.copy(p)
    this.quat.copy(q)
    this.fwd.set(0, 0, 1).applyQuaternion(q)
    this.up.set(0, 1, 0).applyQuaternion(q)
    this.right.set(-1, 0, 0).applyQuaternion(q)
    this.linvel.set(0, 0, 0)
    this.angvel.set(0, 0, 0)
    this.prevLinvel.set(0, 0, 0)
    this.speed = 0
    this.speedKmh = 0
    this.forwardSpeed = 0
    this.impact = 0
    this.boostAge = 99
    this.boost = 0
    this.magGrip = false
    this.magStrength = 0
    this.magGrace = 0
    this.uprightTimer = 0
    this.buriedTimer = 0
    this.settleSteps = 6
    this.steps = 0
    this.airTime = 0
    this.steerAngle = 0
    for (let i = 0; i < WHEELS; i++) this.wheelOmega[i] = 0
    if (s >= 0) {
      this.trackS = s
      this.hasTrackS = true
    } else {
      this.hasTrackS = false
    }
    this.news.teleported = true
  }

  /**
   * Magnetic grip. With at least two wheels on a loop or wall-ride surface and
   * enough speed, cancel the part of gravity pulling the car OFF the surface and
   * add a firm pull INTO it. Below the speed it fades out over MAG.fadeKmh and
   * gravity wins, so the car drops off cleanly. A short grace bridges seams.
   */
  private stepMagnet(body: RapierRigidBody, mass: number, magWheels: number, airborne: boolean): void {
    const thr = this.handling.magGripKmh
    const strength = smoothstep(thr - MAG.fadeKmh, thr, this.speedKmh)
    const touching = magWheels >= MAG.minWheels
    if (touching) {
      this.magNormal.copy(_magN).normalize()
      this.magGrace = 0.12
    } else if (this.magGrace > 0) {
      this.magGrace -= DT
    }
    const active = (touching || this.magGrace > 0) && strength > 0 && finiteV(this.magNormal)
    const wasGrip = this.magGrip
    this.magStrength = active ? strength : 0
    this.magGrip = active
    if (active) {
      const n = this.magNormal
      // Gravity is (0, -g, 0); its component along n is -g * n.y. Positive = pulling away.
      const away = -GRAVITY * n.y
      const cancel = away > 0 ? away * strength : 0
      const pull = (cancel + MAG.stickAccel * strength) * mass
      this.addForce(body, -n.x * pull, -n.y * pull, -n.z * pull)
    }
    if (active && !wasGrip) this.news.magOn = this.magSurface
    if (!active && wasGrip) {
      this.news.magOff = this.magSurface
      this.news.magFell = strength <= 0 || airborne || this.up.y < 0.2
    }
  }

  /** Boost pads: a kick on entry, then the envelope pushes and lifts the top speed. */
  private stepBoost(body: RapierRigidBody, track: TrackRuntime, mass: number, airborne: boolean): void {
    const zones = track.boostZones
    if (this.boostCooldown.length !== zones.length) this.boostCooldown = new Float64Array(zones.length)
    if (!this.hasTrackS || zones.length === 0) return
    for (let z = 0; z < zones.length; z++) {
      if (this.boostCooldown[z] > 0) {
        this.boostCooldown[z] -= DT
        continue
      }
      const zone = zones[z]
      const along = track.deltaS(zone.s0, this.trackS)
      const len = track.deltaS(zone.s0, zone.s1)
      if (along < 0 || along > (len > 0 ? len : zone.length)) continue
      if (this.lateral < zone.lat0 - 0.6 || this.lateral > zone.lat1 + 0.6) continue
      if (airborne && this.hit.height > 2.5) continue
      this.boostCooldown[z] = BOOST.cooldown
      const strength = (Number.isFinite(zone.strength) ? zone.strength : 1) * clamp(this.handling.boostStrength, 0, 3)
      if (strength <= 0) continue
      this.boostPower = strength
      this.boostAge = 0
      this.boost = 1
      // The kick goes along the pad's direction (the road), whatever the car is pointing at.
      const tx = zone.tangent.x
      const ty = zone.tangent.y
      const tz = zone.tangent.z
      const imp = BOOST.kick * strength * mass
      if (Number.isFinite(tx + ty + tz)) {
        _rv.x = tx * imp
        _rv.y = ty * imp
        _rv.z = tz * imp
        body.applyImpulse(_rv, true)
      }
      this.settleSteps = Math.max(this.settleSteps, 2) // the kick is not a crash
      this.news.boosted = strength
      break
    }
  }

  private updateTrackPosition(track: TrackRuntime, onRoadWheels: number, grounded: number): void {
    const hit = track.nearest(this.pos.x, this.pos.y, this.pos.z, this.hit, this.hasTrackS ? this.trackS : undefined)
    if (Number.isFinite(hit.s)) {
      this.trackS = hit.s
      this.hasTrackS = true
    }
    this.lateral = Number.isFinite(hit.lateral) ? hit.lateral : 0
    if (grounded > 0) {
      // Wheels first: they know exactly what they stand on.
      this.onRoad = onRoadWheels > 0
    } else {
      // Flying over the road counts as on it, however high (jumps must not dirty a lap).
      const hw = track.samples.halfWidth[hit.index] ?? 7
      this.onRoad = Math.abs(this.lateral) <= hw + 0.6
    }
  }

  private checkAutoReset(track: TrackRuntime, floorTouch: boolean): void {
    const w = track.world
    const p = this.pos
    if (p.y < w.resetY) return this.requestReset('auto', 'fell')
    if (floorTouch || p.y < w.catchFloorY + 1.5) return this.requestReset('auto', 'floor')
    if (Math.hypot(p.x, p.z) > w.playRadius + 8) return this.requestReset('auto', 'outside')

    // Upside down and nearly stopped (a car on its roof never "lands").
    if (this.up.y < 0.1 && this.speed < STATE.upsideDownSpeed && !this.magGrip) {
      this.uprightTimer += DT
      if (this.uprightTimer > STATE.upsideDownSeconds) return this.requestReset('auto', 'upside-down')
    } else {
      this.uprightTimer = 0
    }

    // Tunnelled through the terrain (heightfields are infinitely thin).
    if ((this.steps & 3) === 0) {
      const g = track.terrainHeight(p.x, p.z)
      const onRoadHere = this.hit.onRoad
      if (Number.isFinite(g) && p.y < g - STATE.belowTerrainDepth && !onRoadHere) {
        this.buriedTimer += 4 * DT
        if (this.buriedTimer >= STATE.belowTerrainSeconds) return this.requestReset('auto', 'below-terrain')
      } else {
        this.buriedTimer = 0
      }
    }
  }

  /** A hard hit: find what the chassis is touching, rank it, and report it. */
  private senseCrash(world: RapierWorld, chassis: RapierCollider, intensity: number): void {
    let rank = -1
    let what: StepNews['crashWhat'] = 'terrain'
    let carId: string | null = null
    world.contactPairsWith(chassis, (other) => {
      let touching = false
      world.contactPair(chassis, other, (m) => {
        if (m.numContacts() > 0) touching = true
      })
      if (!touching) return
      const owner = ownerOf(other.handle)
      let r: number
      let w: StepNews['crashWhat']
      let id: string | null = null
      if (owner) {
        if (owner.kind === 'car' || owner.kind === 'remote') {
          r = 6
          w = 'car'
          id = owner.id
        } else if (owner.kind === 'smashable') {
          r = 5
          w = 'smashable'
        } else if (owner.kind === 'prop') {
          r = 4
          w = 'prop'
        } else {
          r = 3
          w = 'wall'
        }
      } else {
        const s = surfaceOf(other.handle)
        if (s === 'barrier') {
          r = 3
          w = 'barrier'
        } else if (s === 'skirt' || s === 'wall') {
          r = 2
          w = 'wall'
        } else {
          r = 1
          w = 'terrain'
        }
      }
      if (r > rank) {
        rank = r
        what = w
        carId = id
      }
    })
    if (rank < 0) return // no chassis contact: a hard landing on the wheels, not a crash
    this.crashCooldown = STATE.crashCooldown
    this.news.crash = intensity
    this.news.crashWhat = what
    this.news.crashCarId = carId
  }

  /**
   * The gearbox is a fiction: no clutch, no torque curve. It exists so the engine
   * note rises through a gear, drops on the shift and rises again. In the air the
   * engine free-revs with the throttle instead of falling silent (a v1 lesson).
   */
  private updateGearAndRpm(throttle: number, reversing: boolean, longSlip: number, airborne: boolean): void {
    const kmh = Math.abs(this.forwardSpeed) * 3.6
    if (this.shiftTimer > 0) this.shiftTimer -= DT
    let target: number
    if (reversing) {
      target = 0.15 + 0.65 * clamp(kmh / DRIVE.reverseTopKmh, 0, 1)
    } else {
      if (kmh > GEAR_TOP_KMH[this.gear - 1] && this.gear < GEAR_TOP_KMH.length) {
        this.gear++
        this.shiftTimer = RPM.shiftSeconds
      } else if (this.gear > 1 && kmh < GEAR_TOP_KMH[this.gear - 2] * RPM.downshiftHysteresis) {
        this.gear--
        this.shiftTimer = RPM.shiftSeconds
      }
      const lo = this.gear === 1 ? 0 : GEAR_TOP_KMH[this.gear - 2]
      const hi = GEAR_TOP_KMH[this.gear - 1]
      const frac = clamp((kmh - lo) / Math.max(hi - lo, 1), -0.19, 1)
      target = Math.max(RPM.idle + 0.04, RPM.base + RPM.span * frac)
      if (kmh < 3) target = RPM.idle + RPM.idleThrottle * throttle + kmh * 0.02
    }
    target += longSlip * RPM.spinBoost
    if (this.shiftTimer > 0) target *= RPM.shiftCut
    if (airborne && !reversing) {
      // Free-rev: the needle chases the throttle, from a floor that sags as you lift.
      const air = RPM.idle + RPM.airRev * throttle
      this.rpm = clamp(approach(this.rpm, Math.max(air, target * 0.55), RPM.airRate, DT), 0, 1)
      return
    }
    this.rpm = clamp(approach(this.rpm, clamp(target, 0, 1), RPM.smoothing, DT), 0, 1)
  }

  /** Loud once, never per step: sixty identical errors a second bury their own cause. */
  private reportNaN(where: string): void {
    if (this.nanReported) return
    this.nanReported = true
    console.error(
      `[vehicle] ${this.id}: non-finite value at "${where}" - refusing to hand it to rapier, resetting to the road. ` +
        'Left unchecked this panics the physics WASM for good.',
    )
  }
}
