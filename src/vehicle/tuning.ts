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
  /**
   *  BUMP STOPS - forgiving landings. Past `bumpStart` metres of travel the
   *  spring stiffens steeply and the force cap rises, so a big drop is caught by
   *  the suspension instead of the chassis slamming the road (which scrubbed
   *  40% of the car's speed off a 12 m drop).
   */
  bumpStart: 0.28,
  bumpStiffness: 160000,
  bumpMaxScale: 2.5,
  /** Damping multiplier inside the bump zone: soak the hit, don't bounce it back. */
  bumpDamp: 3,
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
   *  STIFFER AT SPEED. How long a car takes to build cornering force after
   *  the wheel turns grows with speed and with how much slip angle the tyre
   *  needs (lag ~ mass x speed / tyre stiffness). With the 7.4 deg peak, full
   *  lock at 220 km/h took ~1 s to bite, and a boost pad (more speed) made it
   *  worse. Between stiffLo and stiffHi (m/s) the peak moves to peakSlipFast,
   *  so the same grip arrives at a smaller angle and the car turns in on cue
   *  (see ASSIST.turnInK for the other half). Below stiffLo (90 km/h: drifts,
   *  handbrake turns) it is the slow-speed curve, untouched.
   */
  peakSlipFast: 0.07,
  stiffLo: 25,
  stiffHi: 55,
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
   * Soft limiter: drive force fades out between these fractions of the top
   * speed, so the car settles AT the top speed (within a couple of km/h)
   * instead of bouncing off a wall. Measured: 260 setting -> ~260 on the flat.
   */
  limiterLo: 0.98,
  limiterHi: 1.03,
  /** Load-biased limited-slip rear diff: torque goes where the grip is. */
  torqueBiasMin: 0.2,
  torqueBiasMax: 0.8,
  /**
   * Engine braking on a lifted throttle, m/s^2 = base + perMs x speed, through the
   * rear tyres. Coasting used to barely slow (0.1 m/s^2) and read floaty; now a coast
   * is ~0.7 m/s^2 at 50 km/h (with rolling resistance and drag) and more at speed.
   */
  engineBrakeBase: 0.45,
  engineBrakePerMs: 0.004,
  reverseForce: 3800,
  reverseTopKmh: 45,
  /** Total brake force N (x the brakes setting) and how much of it the front takes. */
  brakeForce: 16000,
  brakeFrontBias: 0.68,
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
  driftRestore: 4200,
  driftRestoreMax: 5200,
  /** Drift angle (rad) inside which nothing is applied: ordinary cornering is untouched. */
  driftDeadband: 0.09,
  /**
   *  HIGH-SPEED STABILITY. The assists above are absolute, so they fade exactly
   *  where they matter: at 230 km/h a 1 g corner has a yaw rate of only
   *  0.15 rad/s, and 5 deg of slide is already a big one. Measured: lifting off
   *  mid-corner at 231 km/h grew a slide 3.6 -> 11.5 deg in one second. Between
   *  hsLo and hsHi (m/s) the deadband narrows, the restore strengthens and extra
   *  yaw damping comes in - all scaled by "hands off" (assistGain), so a
   *  deliberate drift is never fought.
   */
  hsLo: 20,
  hsHi: 60,
  driftDeadbandFast: 0.035,
  /** Restore multiplier added at full speed (x2.5 total). */
  hsRestore: 1.5,
  /** Yaw damping added at full speed, Nm per rad/s. */
  hsYawDamp: 3000,
  /** How much of the high-speed assist a full steering input switches off (cornering is not sliding). */
  hsSteerRelief: 0.75,
  /**
   *  TURN-IN. At speed the rack angle is tiny (about 1 deg at 200 km/h), so the
   *  tyres only grip once the whole body has rotated into the corner. The car
   *  also likes to rotate (front grip > rear), so after that slow start it kept
   *  rotating into a 13 deg slide. Between turnInLo and turnInHi (m/s) a torque
   *  drives the yaw rate toward the turn the front wheels ask for (the rack's
   *  no-slip turn, capped at turnInMaxG x the grip setting): quick to turn in,
   *  then held there. Adding rotation fades out as the rear tyres' slip angle
   *  passes turnInSlipLo..Hi x the tyre's peak slip, so it never feeds a slide;
   *  slowing an over-rotation is always allowed. Measured with TYRE.peakSlipFast,
   *  full lock at 220 km/h: 63% of the cornering force in 0.35 s on a pad
   *  (was 0.75 s), 0.48 s on keys (was 0.95 s); body slip 5 deg (was 13).
   *  The full-lock grip itself is unchanged (src/core/gripTable.ts).
   */
  turnInLo: 25,
  turnInHi: 50,
  turnInK: 20000, //   Nm per rad/s of yaw-rate error
  turnInMax: 8000, //  Nm cap
  turnInMaxG: 1.45, // the yaw target never asks for more cornering than this (g)
  turnInSlipLo: 0.9,
  turnInSlipHi: 1.6,
  /** Drift angle (rad) across which it hands over to the slide assists (8.6 .. 17 deg). */
  turnInBetaLo: 0.15,
  turnInBetaHi: 0.3,
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
  brakeYawDamp: 2400,
  /**
   *  DRIFT CEILING. A held handbrake with full lock and full throttle spun the car
   *  to backwards in 1.4 s, so there was nothing left to catch. Past `ceilStart`
   *  a spring pulls the nose back toward the path and a damper brakes any rotation
   *  that is making the slide deeper. It stays on even while the player asks for
   *  a drift: a held drift lives at a big, steady angle instead of becoming a spin,
   *  and a counter-steer can always catch it.
   */
  ceilStart: 0.5, //     rad (29 deg): the spring starts here
  ceilSpring: 16000, //  Nm per rad past the start
  ceilDampFrom: 0.12, // rad (7 deg): the damper fades in from here to ceilStart
  ceilDamp: 4500, //     Nm per rad/s of rotation deeper into the slide
  /** Rotation deeper into a slide is capped near this rate (rad/s, ~92 deg/s): plenty for any drift entry. */
  maxDriftYaw: 1.1,
  yawCapK: 7000, //      Nm per rad/s over the cap
  ceilEnd: 1.9, //       rad (109 deg): beyond this the car has really spun (a crash) - let it go
  /**
   *  AIR CONTROL - generous but calm.
   *  A kid holds the throttle through every jump, so throttle / brake on their
   *  own only lean the car gently (airPitchCalm) and a self-levelling torque
   *  (airLevel) settles it for the landing. HOLD THE HANDBRAKE in the air for
   *  trick mode: full pitch authority (flips) and steering rolls the car
   *  (barrel rolls). Steering always spins it. Measured: a held throttle
   *  through a 1.4 s drop used to pitch the car 65 deg and tumble it.
   */
  airPitch: 3500, //      trick mode pitch, Nm
  airPitchCalm: 300, //   normal pitch lean, Nm (held throttle settles ~6 deg nose-up)
  airYaw: 4000,
  airRoll: 3000, //       trick mode roll, Nm
  airLevel: 3000, //      Nm per rad of tilt from upright (pitch and roll only, never yaw)
  airAngularDamp: 6, //   x100 Nm per rad/s
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
  /**
   *  LOOP GUIDANCE. A loop has a corkscrew offset (so it doesn't drive through
   *  itself); without steering the car slid 7.6 m sideways and flew off a
   *  quarter of the way round. Nobody steers a corkscrew upside down, so on a
   *  loop surface the car is guided: a lateral spring toward the centre line and
   *  a yaw alignment to the road. Wall rides are left free - steering there is
   *  the fun.
   */
  loopLatK: 2.0, //      1/s: target sideways speed per metre off the line
  loopLatGain: 7, //      1/s: how fast the sideways speed is corrected
  loopLatMax: 16, //      m/s^2 cap on the correction
  loopYawK: 7000, //      Nm per rad of heading error to the road
  loopYawDamp: 2500, //   Nm per rad/s of heading-error rate
  /**
   *  ...but on a loop the tyres carry ~10 g of load, so the car goes where its
   *  nose points and forces alone can't hold it (measured: pinned at the cap and
   *  still sliding off). So the loop also STEERS for you, like a driver would:
   *  toward the road's direction and back to the centre line, blended over
   *  whatever the player is doing.
   */
  loopSteerHeading: 4, //  steer per rad of heading error
  loopSteerLateral: 0.18, // steer per metre off the centre line
  loopSteerDamp: 0.12, //    steer per m/s of sideways speed (stops it swinging across)
  loopSteerBlend: 0.85, //   how much of the steering the loop takes over
  /**
   *  WALL LIP GUARD. Steering hard up a wall ride at speed carried the car
   *  straight over the 9 m lip and 18 m into the sky, like a skate ramp. High on
   *  the wall, speed that is carrying the car UP the face is bent back along the
   *  wall, so you ride the wall instead of launching off its top.
   */
  wallGuardFrom: 0.3, //   fraction of the wall height where the guard starts
  wallGuardFull: 0.8, //   ...and is fully on
  wallGuardK: 8, //        1/s: how hard upward speed is removed
  wallGuardMax: 55, //     m/s^2 cap
  /** ...and the nose is steered back along the wall (the tyres would otherwise keep climbing). */
  wallSteerHeading: 3,
  wallSteerBlend: 0.8,
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

/**
 *  AUTO-HOLD. A car sitting still with no pedal down stays put, even on a
 *  sloped or banked grid (idle cars used to creep backwards on Neon Pocket's
 *  start). It engages below engageSpeed (m/s) and lets go the moment the
 *  throttle or the brake (reverse) is touched, or if a shove pushes the car
 *  past releaseSpeed. It can hold at most mu of the car's weight sideways.
 */
export const HOLD = {
  engageSpeed: 0.5,
  releaseSpeed: 1.5,
  /** Leftover drift is soaked up over about this long, seconds. */
  settleSeconds: 0.15,
  mu: 0.9,
}

export const STATE = {
  /** Speed (m/s) and rear slip above which `drifting` is true. */
  driftSpeed: 5,
  driftSlip: 0.25,
  /** Impact = |dv| per step above this, normalised over this range (dv x mass IS the impulse). */
  impactThreshold: 1.2,
  impactRange: 6,
  impactDecay: 3,
  /**
   * A crash is a velocity change ACROSS the car's forward / side axes (a landing is
   * along its up axis, so it can never be one). Fires above crashMinDv m/s; intensity
   * = (dv - crashMinDv) / crashRange, so 1 takes a ~50 km/h hit.
   */
  crashMinDv: 3,
  crashRange: 11,
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
