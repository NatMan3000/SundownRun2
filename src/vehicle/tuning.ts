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

/**
 *  LANDING CATCH - the other half of forgiving landings. A big jump comes down faster than
 *  0.4 m of suspension can stop (a 3 s jump lands at 17-20 m/s, 0.3 m a step), so the body
 *  slammed into the road: that hit scrubbed 20-45 km/h off the landing, and pushing the body
 *  back out of the road threw the car into the air again for 0.3-0.5 s. Now each wheel on the
 *  ground, and each bottom corner of the body over an axle that is down, checks whether the
 *  springs can stop it within the room it has left (travel for a wheel, clearance for the body),
 *  stopping `margin` short. If not, the car's fall is slowed at its centre of mass, along the
 *  ground's normal, and if the car is spinning into the ground (nose dropping, rolling onto its
 *  far wheels) that spin is damped. It only ever takes speed and spin away: it never pushes the
 *  car back up, never starts a rotation, and carries no tyre load (so it scrubs no speed). The
 *  26 kN spring cap above stays.
 *  (The first catch pushed at the wheels that touched. On one axle that was a kick about the
 *  centre of mass: a nose-first ramp landing pitched at 9 rad/s and rolled onto its side.)
 */
export const LANDING = {
  /** Travel kept spare, m: the catch stops the corner this far before the body would touch. */
  margin: 0.06,
  /** Closing speeds under this (m/s) are ordinary bumps the springs deal with (1 m/s had it working off-road). */
  minApproach: 3,
  /** Only ground facing the car's underside: car up . ground normal at least this (0.6 = 53 deg). */
  minFacing: 0.6,
  /**
   * Look-ahead: coming down faster than minApproach, the wheel rays reach this many seconds of
   * the fall further (at most lookMax m), so the catch starts a few steps BEFORE the wheels touch
   * and the stop is spread out. Without it an 18 m/s landing had 0.1 m of room left at the nose
   * when the rays first saw the road, and the whole stop happened in one step (-14 km/h, a hop).
   */
  lookSeconds: 0.08,
  lookMax: 1.5,
  /** The catch leaves the car this much of its fall, m/s, for its springs to settle it onto all four wheels. */
  sink: 1.5,
  /** The catch only damps a spin that drives a point into the ground faster than this, m/s. */
  minSpin: 0.5,
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
  /**
   *  BRAKING GRIP. Under the brake pedal a tyre grips this much harder ALONG the car than
   *  across it, so its grip is an ellipse, not a circle (real tyres do this a little; an
   *  arcade car does it a lot). With a circle every tyre ran out of grip at about 1.5 g, so
   *  the top half of the brakes slider did nothing: 1.5 stopped only 15% shorter than 1.0.
   *  Cornering grip is untouched, and the handbrake still uses the plain circle.
   */
  brakeGrip: 1.35,
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
  /**
   *  BRAKES. Total brake force, N, times the brakes setting. Full brake from 200 km/h:
   *  0.6 -> ~0.85 g, 1.0 -> ~1.4 g (about 110 m to stop), 1.5 -> ~2 g (about 80 m), where
   *  the tyres' braking grip (TYRE.brakeGrip) runs out; past that the setting adds nothing.
   */
  brakeForce: 16000,
  /**
   *  BRAKE BALANCE (like a real car's EBD). Braking moves weight onto the front wheels, so
   *  the brake force is split between the axles by how much grip each one has right now
   *  (mu x the load on its springs). The rear's share is cut to brakeRearShare of its grip
   *  so the front always runs out first: a washed-out front is understeer, the safe failure.
   *  A fixed 68 / 32 split over-braked the light rear (it was out of grip at the default
   *  setting) and left the front's spare grip unused.
   */
  brakeRearShare: 0.85,
  /** The front's share never goes outside this range. */
  brakeFrontMin: 0.55,
  brakeFrontMax: 0.9,
  /** The front's share with no wheel loads to go by (all four wheels in the air). */
  brakeFrontBias: 0.68,
  /**
   *  Brake pressure builds over this long, seconds (0 to full), like a real brake's
   *  hydraulics, so a trigger stamped to full comes in firm but never as a jolt. Letting go
   *  is instant. The keyboard's own smoothing is already about this slow.
   */
  brakeRiseSeconds: 0.12,
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
  /**
   *  BANKS. On a banked road gravity pulls the car along the road toward the inside, and that
   *  pull carries part of any turn into the bank. So on a bank full lock asks the tyres for the
   *  same latLimitG as on the flat, PLUS gravity's pull, and the car turns tighter by just that
   *  much (the turn-in target, ASSIST.turnInMaxG, gets the same help). On the Hyperdrome's 60 deg
   *  ends at 240 km/h the pull is 0.87 g: without it full lock turned the car no tighter than on
   *  flat road, the line needed 80% of it, and nothing was left to correct with. A bank leaning
   *  the other way never takes lock away (flat road and off-camber stay exactly as they were).
   *  The pull counted is capped at this many g (sin 60 deg, the steepest bank in the game).
   */
  bankHelpMaxG: 0.87,
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
  /** ...but on a loop, where the loop support carries the turn, only this much (m/s^2). */
  loopStickAccel: 4,
  /**
   *  LOOPS ARE JUDGED BY THEIR OWN SIZE. On a loop the magnet holds whenever the car is
   *  going fast enough for that loop's local radius: v^2 / R at or above loopHoldG (in g),
   *  fading in over loopHoldFadeG below it - not just above the flat magGripKmh. A car
   *  that entered at a sane speed never lets go at the top; one crawling in still falls.
   */
  loopHoldG: 0.6,
  loopHoldFadeG: 0.2,
  /**
   * How much of the turn the loop carries itself (carSim stepLoopSupport, 1 = all of it); the
   * springs then carry only gravity and the light loop stick, so they stay off their bump stops
   * and the chassis box's ends stay clear of the curve.
   */
  loopSupport: 1,
  /** Metres either side of the car used to measure the loop's curvature. */
  loopCurveStep: 1.5,
  /**
   * The grip never steps: its strength moves at most this much per second, up (gripRise) and
   * down (gripFall). A car sliding down a wall right at the hold test's edge flickered it on and
   * off, chirping mag.on / mag.off five times in a second. Full grip in 0.12 s, gone in 0.25 s.
   */
  gripRise: 8,
  gripFall: 4,
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
  loopLatMax: 30, //      m/s^2 cap on the correction
  /**
   *  ...and its attitude follows the loop like a rail car: a spring (loopAttK, 1/s^2) toward
   *  the road's attitude and a damper (loopAttD, 1/s) toward the road's own rate of turn x
   *  speed, per axis, times that axis's inertia. ~7.7 rad/s, a touch under critical.
   */
  loopAttK: 60,
  loopAttD: 14,
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
   *  WALL RIDES carry their own turn too (carSim stepWallSupport, 1 = all of it): driving up
   *  the curved wall asks the springs for up to 8 g, which bottomed them and scrubbed half the
   *  car's speed away. The magnet judges a wall by how hard its curve presses the car in, the
   *  same test as a loop (loopHoldG); below that and below magGripKmh the stick fades and the
   *  car slides down the wall (the pull cancelling gravity's pull off an overhang stays on).
   */
  wallSupport: 1,
  /**
   * Below the minimum on a wall the magnet keeps this light pull in (m/s^2, faded in as the
   * stick fades out) so a stalled car can't tip off: nose-up on a steep wall a car flips over
   * backwards past ~69 deg, side-on past ~58. The tyres don't grip with it, so the car still
   * slides or rolls down the wall instead of parking on it.
   */
  wallSlideStick: 8,
  /**
   *  WALL LIP GUARD. Steering hard up a wall ride at speed carried the car
   *  straight over the lip and 18 m into the sky, like a skate ramp. The guard
   *  watches how fast the car closes on a line wallLipMargin (m, round the
   *  curve) below the lip, and pushes back down the wall with just enough to
   *  stop it there (beyond what gravity does), up to wallGuardMax (m/s^2).
   *  It turns the car back along the wall first (the speed is kept); only
   *  what a turn can't do - a car pointing straight up the wall - brakes the
   *  climb. Past the line a spring (wallGuardSpring, m/s^2 per metre) pushes
   *  it back under.
   */
  wallLipMargin: 1.0,
  wallGuardMinDist: 0.3, // m: the stopping distance never counts as less than this
  wallGuardMax: 60,
  wallGuardSpring: 40,
  /**
   * The lip comes down to the road over the wall's last metres: the guard looks this many
   * seconds of travel ahead (at most wallGuardLookMax m, every wallGuardLookStep m) so a car
   * riding high is eased down before the wall ends instead of launched off its end.
   */
  wallGuardLook: 1.2,
  wallGuardLookMax: 45,
  wallGuardLookStep: 1.5,
  /** ...and the nose is steered back along the wall (the tyres would otherwise keep climbing), */
  wallSteerHeading: 3,
  wallSteerBlend: 0.8,
  /** ...fully once the guard pushes this hard (m/s^2). */
  wallGuardSteerAt: 10,
  /**
   * ...and while it bends the path, the nose turns with it: the turn's own rate fed forward
   * plus a spring (wallYawK, 1/s^2) and damper (wallYawD, 1/s) on the nose-to-path angle, times
   * the car's yaw inertia. Left to the tyres, the car crabbed 30 deg down the wall's ramp-out.
   */
  wallYawK: 40,
  wallYawD: 10,
  /**
   * LEVELLING OUT at a wall's end. The guard reads the lip wallLevelTime seconds of travel
   * early, so a car riding high is down before the wall ends; then, for wallLevelHold s after
   * the guard last pushed, a descent that would reach the bottom still heading down the wall
   * is bent back along the road (up to wallLevelMax m/s^2, as a turn). Without it the car left
   * the wall's end 30 deg across the road and ran off the far edge.
   */
  wallLevelTime: 0.4,
  wallLevelHold: 1.0,
  wallLevelMax: 25,
}

/**
 *  BARRIERS are scraped along, upright. Wheels never stand on one (carSim: a wheel ray that meets
 *  a `barrier` gets no support and no grip; wall rides are the `wall` surface). The body still hits
 *  it, but that push lands above the centre of mass, so a car pressed into the wall through a bend
 *  taken too fast rolled until its underside faced the wall and slid along on its side. While the
 *  body touches a barrier (and holdSeconds after) a righting torque holds the car to the road's up.
 */
export const BARRIER = {
  /** Righting spring, Nm per rad of tilt from the road's up, and damper on roll / pitch rate, Nm per rad/s. */
  rightK: 20000,
  rightD: 5000,
  holdSeconds: 0.3,
  /** Car up . road up below this = on its roof: left alone (a wipeout, not a scrape). */
  minUp: -0.2,
  /** Perched on it with no wheel down and beyond halfWidth - shedInside (m) from the centre line: pushed back toward the road (m/s^2). */
  shedInside: 0.5,
  shedAccel: 4,
  /**
   * Scraping along a barrier costs speed: a drag of scrubFloorG g, plus scrubPerG for every g the
   * barrier pushes on the body (leaning harder on it scrubs more), at most scrubMaxG g.
   */
  scrubFloorG: 0.5,
  scrubPerG: 0.25,
  scrubMaxG: 1.0,
}

export const BOOST = {
  /** Instant forward kick, m/s (x pad strength x boostStrength setting). */
  kick: 7,
  /** Extra forward push while the envelope decays, m/s^2 at envelope 1. */
  accel: 9,
  /** Envelope 1 -> 0 over this long. */
  seconds: 1.5,
  /**
   * How far past the top speed boost may carry the car: the kick, the push and the engine all
   * stop at top speed x (1 + overTop x envelope), so pads never stack past +35% and the ceiling
   * sinks back to the top speed as the envelope fades.
   */
  overTop: 0.35,
  /** The same pad cannot fire again for this long. */
  cooldown: 1.0,
  /**
   *  BRAKES BEAT BOOST. Afterglow has two pads in the braking zone for its hairpin: each one
   *  kicked a braking car up by 25 km/h and then pushed at 0.9 g, two thirds of the brakes,
   *  so braking from 250 km/h there took 70 m longer than on a clear straight. Now a pad
   *  crossed with the brake past `brakeIgnore` does not fire, and a running boost's push
   *  fades out as the brake goes from `brakeCutFrom` to `brakeIgnore` (its glow fading up
   *  to `brakeFade` times faster), so a light brake through a pad keeps most of it. Only for
   *  a person driving: the Ai brain plans its braking around each pad's kick, and with the
   *  rule on it lost 1.5-2 s a lap on Neon Pocket.
   */
  brakeCutFrom: 0.3,
  brakeIgnore: 0.8,
  brakeFade: 4,
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
  /**
   * PARKED AFTER A RESET. R (and Shift+R and the automatic resets) put the car back on the road
   * on its wheels, `resetLift` m above where it sits at rest, and it stays parked there: the hold
   * cancels ALL of gravity's pull along the road, not just mu of it, until the first pedal (or a
   * shove past `parkedRelease` m/s). A stopped car can't grip a 60 deg bank by itself (that takes
   * mu 1.73): R there used to drop the car from a metre up and it slid down into the inner barrier.
   */
  resetLift: 0.03,
  parkedRelease: 3,
  /** A pedal past this much (0..1) lets go of a parked car: a deliberate press, not a trigger easing off. */
  parkedPedal: 0.3,
  /**
   * PULLING AWAY FROM A RESET on a steep bank: a bank only carries a car that is going fast enough
   * for it (about 40 km/h at 60 deg; slower, gravity drags it down the slope faster than the tyres
   * can hold). So after a reset the hold keeps cancelling gravity's pull ACROSS the car (never along
   * it: the car rolls and speeds up as normal) until it passes launchFadeLo, gone by launchFadeHi
   * (km/h), or launchSeconds after it set off. Flat road: nothing to cancel.
   */
  launchFadeLo: 40,
  launchFadeHi: 60,
  launchSeconds: 6,
  /**
   * The hold (and the roll-back catch) only work on a slope a car could park on: never with the
   * car or the ground under it tilted more than this, degrees off level. The steepest road in the
   * game is the Hyperdrome's banking at its 30 deg default (every other road is under 15), so 35
   * keeps that with room for the car's lean on its springs, and it sits under the 42 deg that
   * mu 0.9 could hold anyway. Wedged at 55 deg against a loop's slab, the hold parked a car there
   * for good (feel-3 F1).
   */
  maxTiltDeg: 35,
}

/**
 *  BEACHED. A car nearly stopped with no pedal down, resting on its body with only some of its
 *  wheels on the ground - high-centred on a ribbon's edge, or leaning on a slab in the gap beside
 *  a loop - slides off under gravity instead of hanging there. The body's own friction is 0.1, but
 *  against a road's 1.0 the two average to 0.55, enough to hold a crawling car on two wheels on the
 *  edge of a loop's climb for as long as you like (feel-3 F1). While beached the lower of the two
 *  counts, so the body slides like the smooth underside it is.
 */
export const BEACH = {
  /** Beached below this speed (m/s)... */
  speed: 1,
  /** ...and it stays beached while sliding off, up to this speed (m/s). */
  releaseSpeed: 2.5,
  /**
   * The same goes for a car stopped on a loop's ribbon, too slow for its magnet, where the ribbon
   * tilts more than loopTiltDeg (the foot of the way-out leg leans 14 deg with the corkscrew): the
   * tyres on it keep only loopGrip of their grip, so it slides down instead of parking on the loop.
   */
  loopTiltDeg: 10,
  loopGrip: 0.1,
  /**
   * Belly down only: car up . world up above this (and with no wheel down, the surface it rests on
   * . car up too). On its side or roof it is a wipeout, not a slide.
   */
  minUp: 0.2,
}

/**
 *  ROLL-BACK CATCH. With no pedal down, a car rolling backwards (tail first) is braked to a
 *  stop, and then the auto-hold above keeps it there. S is brake AND reverse: a kid who
 *  tapped S at rest facing up a hill started a reverse, let go already faster than the
 *  hold's releaseSpeed, and rolled 45 m back down the hill at 30 km/h. Holding S still
 *  reverses as far as you like. Steering while it rolls back is a roll-back on purpose
 *  (swinging the nose round), so then it only stops the roll getting faster than steerKmh.
 *  It stands down on loops and wall rides (a car too slow for those must roll off them).
 */
export const ROLLBACK = {
  /** How much of the full brake force the catch uses: 0.35 stops a roll in well under a second. */
  brake: 0.35,
  /**
   * Full catch up to this backwards speed (km/h; reverse tops out at 45, a hill can add a few),
   * fading out by fadeKmh: a car spun round and sliding backwards fast is left to the driver.
   */
  fullKmh: 50,
  fadeKmh: 80,
  /** Steering past this much (0..1) while rolling back means "I'm steering this roll"... */
  steerIntent: 0.3,
  /** ...and then the roll may run up to this speed (km/h) before the catch leans on it. */
  steerKmh: 10,
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
  /**
   * Hitting the GROUND with the body counts only the hit along the surface (sliding, digging in),
   * never the landing itself, while car up . surface up is at least this: wheels-side down, up to
   * lying on its side. Below it (on the roof) the whole hit counts.
   */
  crashLandUp: 0,
  /**
   * Upright on its wheels with the body scraping the ground (a kicker's lip, a dip): a crash only
   * past this much speed lost along the surface in one step, m/s (~29 km/h).
   */
  crashScrapeDv: 8,
  /** For this long after the wheels come back down (s, the tricks' recovery window), a body hit on the ground is the landing, not a crash. */
  crashLandWindow: 0.4,
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
