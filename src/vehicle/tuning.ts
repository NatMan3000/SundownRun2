// ============================================================
//  HANDLING BASELINE - the numbers that make the car feel right
// ------------------------------------------------------------
//  Lifted from Sundown Run v1, where every value here survived a
//  checker or a playtest round, then retuned for this game: a
//  260 km/h top speed, boost pads, loops and wall rides.
//
//  The Settings menu MULTIPLIES some of these (grip, steering,
//  stability, power, brakes) and replaces the top speed. The
//  baseline must feel great with every setting at 1.0.
//
//  Josh: the knobs you are meant to turn live in src/core/config.ts.
//  This file is the car's engineering - change it carefully and
//  drive a lap after every edit.
// ============================================================

/** Fixed physics step. Must match <Physics timeStep> in App.tsx. */
export const DT = 1 / 60
export const GRAVITY = 9.81

export const CHASSIS = {
  /** kg - a light, quick coupe. Each body scales this a little (see bodies/catalog.ts). */
  mass: 1200,
  /** Centre of mass height, chassis-local metres. Low = it corners instead of capsizing. */
  comY: -0.05,
  /**
   * Principal moments of inertia (pitch, yaw, roll), kg m^2, for the base mass.
   * Yaw sits a little under a solid box so the car rotates eagerly; roll sits well
   * above it so a slide leans the body instead of tripping it.
   */
  inertia: { x: 1800, y: 1700, z: 620 },
  /** Half-extents of the physics box: a touch inside every visual body so it never snags. */
  halfExtents: { x: 0.88, y: 0.4, z: 2.0 },
  /** Box centre height, chassis-local. Its underside rides ~0.3 m over the road at rest. */
  offsetY: 0.16,
  angularDamping: 0.28,
}

export const WHEEL = {
  radius: 0.34,
  /** Half the track width and half the wheelbase. */
  halfTrack: 0.8,
  halfBase: 1.42,
  /** Suspension mount height, chassis-local. */
  anchorY: 0.1,
  /** Mount -> wheel centre at full droop. The ray is restLength + radius long. */
  restLength: 0.4,
}

export const RAY_LENGTH = WHEEL.restLength + WHEEL.radius

/** Chassis-local y of the road surface when the car sits at rest (for bodies and fx). */
export const ROAD_Y_AT_REST = -0.542

export const SUSPENSION = {
  /** N/m per corner. Over a 300 kg quarter mass that is a 1.6 Hz ride, a real car's number. */
  stiffness: 30000,
  /** Rebound damps harder than compression, like a real damper: soak the bump, settle once. */
  dampCompress: 3600,
  dampRebound: 4600,
  /** Never launch the car into orbit off a kerb. */
  maxForce: 26000,
  /** Anti-roll bars, N/m of left-right difference. Front stiffer: the limit is understeer, the safe failure. */
  antiRollFront: 22000,
  antiRollRear: 14000,
}

export const TYRE = {
  /** Peak friction (x the grip setting). The rear a touch under the front: the car likes to rotate. */
  muFront: 1.62,
  muRear: 1.5,
  /**
   *  SLIP CURVE: lateral grip vs slip angle, 0..1 of mu.
   *
   *      1.0 |      /\_
   *          |     /   \____   <- slide plateau
   *      0.0 |___/________________  slip angle
   *             ^peak      ^tail
   *
   *  Past the peak, more angle gives LESS grip - that is what makes a drift
   *  hold instead of snapping back. The plateau (not zero) is why you can
   *  always catch it.
   */
  peakSlip: 0.13,
  tailSlip: 0.6,
  /**
   *  THE PLATEAUS ARE NOT EQUAL - THAT IS THE WHOLE STABILITY STORY (v1 defect D1).
   *  Below ~20 deg the front out-grips the rear, so the car rotates into a slide
   *  (fun). Above ~20 deg the rear out-grips the front, so it straightens on its
   *  own (catchable). Equal plateaus spun the car to backwards with hands off.
   *  A held drift still works because the handbrake attacks the rear's grip.
   */
  slideFrontFrac: 0.6,
  slideRearFrac: 0.7,
  /** The handbrake multiplies rear grip by this: the tail steps out on command. */
  handbrakeGrip: 0.3,
  rollingResistance: 0.014,
  /** Below this speed the slip angle is measured against a floor, so parking is not "sliding". */
  slipSpeedFloor: 2.0,
}

export const DRIVE = {
  /** Drive force at low speed, N (x the power setting). ~0.78 g off the line. */
  maxForce: 9200,
  /**
   * Engine power is sized from the top speed so the car still pulls hard at
   * the top whatever the setting says: P = headroom x (drag + rolling) x vTop.
   */
  powerHeadroom: 1.8,
  /**
   * Soft limiter: drive force fades out over the last `limiterBand` of the top
   * speed, so the car settles AT the top speed instead of bouncing off a wall.
   */
  limiterBand: 0.08,
  /** Load-biased limited-slip rear diff: torque goes where the grip is. */
  torqueBiasMin: 0.2,
  torqueBiasMax: 0.8,
  reverseForce: 3800,
  reverseTopKmh: 45,
  /** Total brake force N (x the brakes setting) and how much of it the front takes. */
  brakeForce: 16000,
  brakeFrontBias: 0.62,
  /** Extra rear brake when the handbrake is pulled. */
  handbrakeForce: 5200,
}

export const AERO = {
  /** F_drag = drag * v^2. */
  drag: 0.3,
  /** F_down = downforce * v^2 along -carUp while grounded. ~20% of weight at 260 km/h. */
  downforce: 0.45,
}

export const STEERING = {
  /** Mechanical lock at a standstill, radians (34 deg). */
  maxAngleLow: 0.593,
  /** The rack never welds itself straight at top speed. */
  minAngle: 0.01,
  /**
   *  THE RACK IS LIMITED BY PHYSICS, NOT A FADE CURVE (rebuilt three times in v1).
   *  Full lock always asks for the same cornering force at any speed:
   *      maxAngle(v) = wheelbase * latLimitG * gain * g / v^2
   *  latLimitG sits right at the tyres' grip (1.62 g): full lock carves at the
   *  limit with the tyre just starting to slip. Less than that is "it won't turn".
   */
  latLimitG: 1.8,
  wheelbase: 2 * WHEEL.halfBase,
  /** While CATCHING a slide (and only then) the rack opens this far, so counter-steer is always there. */
  driftAngle: 0.42,
  /** Rack slew rate, rad/s. */
  rackRate: 7,
}

export const ASSIST = {
  /** Yaw damping torque, Nm per rad/s (scaled with the body's inertia). */
  yawDamp: 800,
  /** Slashed while the player ASKS for a slide, so the drift stays alive. */
  yawDampDrift: 250,
  /** Raised while sliding with hands off: the car settles itself. */
  yawDampRecover: 1600,
  /**
   *  DRIFT RECOVERY: a restoring torque toward the velocity vector, Nm per
   *  radian of drift angle. Zero the moment the player asks for a slide
   *  (handbrake, or a real counter-steer). With everything released it is what
   *  a driver's hands would do - for a 12-year-old on a keyboard who has not
   *  learned to counter-steer yet.
   */
  driftRestore: 2900,
  driftRestoreMax: 3600,
  /** Drift angle (rad) inside which nothing is applied: ordinary cornering is untouched. */
  driftDeadband: 0.09,
  /** The assist ramps in across this speed band (m/s). */
  assistSpeedLo: 2.5,
  assistSpeedHi: 8,
  /** Steering across this band reads as "I meant that" and releases the assist... */
  driftIntentLo: 0.15,
  driftIntentHi: 0.55,
  /** ...but only fully for a COUNTER-steer. Steering into a slide earns this fraction. */
  steerIntoIntent: 0.3,
  /** Drift angle (rad) below which "counter-steer" means nothing. */
  counterSteerBeta: 0.12,
  /**
   *  BRAKE STABILITY. Braking mid-corner moves load forward and the rear goes
   *  light. On top of the brake balance (rears keep cornering grip first - see
   *  carSim.ts), extra yaw damping comes in with the brake pedal, scaled by the
   *  stability setting. This is the "brake in a corner never spins" guarantee.
   */
  brakeYawDamp: 1400,
  /** Air control: enough to style a jump and straighten a landing, calm enough not to fly. */
  airPitch: 3500,
  airYaw: 4000,
  airRoll: 1800,
  airAngularDamp: 0.9,
  /** Extra lateral damping below walking pace so the car does not creep sideways. */
  lowSpeedLateral: 0.6,
}

export const MAG = {
  /** Grip fades in over this many km/h below the magGripKmh setting. */
  fadeKmh: 15,
  /** Firm extra pull into the surface at full strength, m/s^2 (on top of cancelling gravity). */
  stickAccel: 14,
  /** Wheels that must be on a magnetic surface. */
  minWheels: 2,
}

export const BOOST = {
  /** Instant forward kick, m/s (x pad strength x boostStrength setting). */
  kick: 7,
  /** Extra forward push while the envelope decays, m/s^2 at envelope 1. */
  accel: 9,
  /** Envelope 1 -> 0 over this long. */
  seconds: 1.5,
  /** How far past the top speed boost may carry the car (fades with the envelope). */
  overTop: 0.35,
  /** The same pad cannot fire again for this long. */
  cooldown: 1.0,
}

export const STATE = {
  /** Speed (m/s) and rear slip above which `drifting` is true. */
  driftSpeed: 5,
  driftSlip: 0.25,
  /** Impact = |dv| per step above this, normalised over this range (dv x mass IS the impulse). */
  impactThreshold: 1.2,
  impactRange: 6,
  impactDecay: 3,
  /** A crash event fires above this impact, at most this often. */
  crashImpact: 0.22,
  crashCooldown: 0.6,
  /** Upside down and nearly stopped this long = auto reset. */
  upsideDownSeconds: 2.5,
  upsideDownSpeed: 3,
  /** Tunnelling guard: this far below the terrain for this long = reset. */
  belowTerrainDepth: 6,
  belowTerrainSeconds: 0.5,
}

/** Gear tops in km/h. Six close ratios so the engine note is always busy. */
export const GEAR_TOP_KMH = [56, 96, 138, 178, 218, 270]
export const RPM = {
  base: 0.2,
  span: 0.78,
  idle: 0.1,
  idleThrottle: 0.3,
  spinBoost: 0.22,
  downshiftHysteresis: 0.9,
  shiftCut: 0.78,
  shiftSeconds: 0.16,
  smoothing: 11,
  /** In the air the engine free-revs: it chases this much of the throttle. */
  airRev: 0.85,
  airRate: 7,
}

export const VISUAL = {
  /** Extra body lean on top of the physics roll, rad per m/s^2. */
  rollGain: 0.0042,
  rollMax: 0.055,
  pitchGain: 0.006,
  pitchMax: 0.06,
  /** Critically damped spring, rad/s. */
  omega: 12,
  /** Wheel spin chases road speed at this rate. */
  spinRate: 12,
}

export const LAP = {
  /** A line crossing within this long of the lap start is noise, not a lap. */
  minLapMs: 5000,
  /** Cumulative off-road time before the lap goes dirty (it counts, it can't set a best). */
  dirtyGraceMs: 3000,
  /** A forward jump in s larger than this between two steps is a teleport, not travel. */
  maxStepJump: 40,
}
