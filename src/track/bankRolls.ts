// ============================================================
//  BANK ROLLS - how gently the road rolls into and out of a bank
// ------------------------------------------------------------
//  Where a banked corner starts, the road ROLLS about its middle:
//  one edge climbs and the other drops. A car driving down one lane
//  (say 10 m from the middle) rides that roll like a hill. Where the
//  roll speeds up, the low lane drops away under the car; where it
//  slows down, the high lane does. Each of those is a crest, and
//  over a crest the road curves away from the car.
//
//  How hard? A lane `lat` metres from the middle curves away from
//  the car by lat x (how fast the roll speeds up or slows down), so
//  at speed v the car needs
//
//      lat x rollAccel x v^2      (m/s^2)
//
//  of pull toward the road to stay on it. Gravity gives at most
//  g x cos(bank) of that (less on a steep bank), and a banked
//  corner's own curve presses the car in by v^2 x curvature x
//  sin(bank). Ask for more than that and the car goes light, or
//  flies. It grows with the SQUARE of the speed, with how far from
//  the middle you drive, and with the size of the roll: a 60 degree
//  bank needs a roll about twice as long as a 15 degree one.
//
//  shapeBankRolls() checks every roll at CREST_CHECK_KMH and makes
//  any that asks too much longer: a smooth S (no sudden roll at
//  either end), as long as its size needs, taken first from the flat
//  road beside it (the straight) so the banked corner keeps its full
//  angle, and from the corner only when the straight runs out. A roll
//  never grows into the start grid, a loop (with its run-in and the S
//  back after it) or road that bends the other way. A roll from one
//  lean to the other (an S-bend) stays level where the bend changes
//  hand. Rolls that are already gentle enough are left exactly as
//  they are.
//
//  The crest gate in gates.ts measures the same thing on the finished
//  3D road, lane by lane, so a roll this file could not fix is caught
//  there with a sentence saying what to change.
// ============================================================

/** Rolls are made gentle enough for a car at this speed (about the cars' top speed). */
export const CREST_CHECK_KMH = 250
/**
 * The most of gravity's pull (toward the road) a roll's crest may use up. 0.8 keeps
 * at least a fifth of the car's weight on its tyres over the worst crest.
 */
export const CREST_LIMIT = 0.8
/** The car's middle stays at least this far inside the road's edge, so lanes run to halfWidth minus this. */
export const CREST_LANE_INSET = 1
/**
 * Crests are measured over this many metres either side (a stretch about as long as a
 * car). Shorter would count millimetre ripples in the road as crests; a car's
 * suspension soaks those up.
 */
export const CREST_SPAN = 3
/** What a roll this file reshapes is built to: a little under CREST_LIMIT, so the real 3D road passes with room. */
const CREST_BUILD = 0.72
const G = 9.81
/** A bank change smaller than this between two turns of the road is a wobble, not a roll. */
const TURN_TOL = (0.5 * Math.PI) / 180
/** Road counts as level-banked (a plateau a roll may grow into) while it stays this close to one angle. */
const FLAT_TOL = (0.05 * Math.PI) / 180
/** The steepest the S curve gets: the smootherstep's peak second derivative (10 / sqrt 3). */
const S_PEAK = 10 / Math.sqrt(3)
/** How far either side a corner's curvature is looked at for its press (the least is used). */
const PRESS_REACH = 10
/**
 * A roll stops growing where the road bends against the way it leans by more than this
 * (1/m, averaged over 40 m): the same "clearly curved" line the banking gate uses.
 */
const BEND_AGAINST = 1 / 600
/**
 * A roll that grows into the straight leans ahead of its bend. On a dead straight a bank
 * of b pulls a car down the slope by tan(b) of its weight whatever its speed (a 50 deg
 * bank on a straight needs more sideways grip than a car has). So a reshaped roll may
 * lean at most LEAN_AHEAD_DEG more than the bend under it wants at the track's design
 * speed (capped at LEAN_SPEED_KMH): 15 deg on a dead straight is a light hand on the
 * wheel (a quarter of the car's weight sideways). Where the old roll already leaned
 * more, that stays allowed.
 */
export const LEAN_AHEAD_DEG = 15
export const LEAN_SPEED_KMH = 200
/** How far at a time a roll's steep end moves into its banked corner when growing alone can't fit it. */
const SHIFT_STEP = 5
/** Metres of extra smoothing at each end of a reshaped roll, so it joins the road beside it seamlessly. */
const JOIN = 5

/** 0 -> 1 with zero slope and zero bend at both ends (6u^5 - 15u^4 + 10u^3). */
function smootherstep(u: number): number {
  const x = u < 0 ? 0 : u > 1 ? 1 : u
  return x * x * x * (x * (x * 6 - 15) + 10)
}

/**
 * How much of gravity's pull the worse lane needs at sample k (> 1 = the car leaves
 * the road). Roll acceleration from the bank CREST_SPAN metres either side, less the press of
 * a corner banked into its curve (`press`: the corner's curvature, see shapeBankRolls).
 */
function crestAt(bank: ArrayLike<number>, half: ArrayLike<number>, press: ArrayLike<number>, k: number, ds: number, v2: number): number {
  const n = bank.length
  const h = Math.max(1, Math.round(CREST_SPAN / ds))
  const a = (((k - h) % n) + n) % n
  const c = (k + h) % n
  const i = ((k % n) + n) % n
  const rollAccel = (bank[a] + bank[c] - 2 * bank[i]) / (h * h * ds * ds)
  const lane = Math.max(0, half[i] - CREST_LANE_INSET)
  const b = bank[i]
  // A bend the bank leans into presses the car on (+); one it leans out of lifts it (-).
  const pressing = v2 * Math.abs(Math.sin(b)) * (b >= 0 ? press[i * 2] : press[i * 2 + 1])
  return (lane * Math.abs(rollAccel) * v2 - pressing) / (G * Math.cos(b))
}

/** The worst crest (see crestAt) over samples k0..k1 (unwrapped indices). */
function worstCrest(bank: ArrayLike<number>, half: ArrayLike<number>, press: ArrayLike<number>, k0: number, k1: number, ds: number, v2: number): number {
  let w = -Infinity
  for (let k = k0; k <= k1; k++) w = Math.max(w, crestAt(bank, half, press, k, ds, v2))
  return w
}

/**
 * How hard a corner presses a car into its bank, per sample: the least of `curv` within
 * PRESS_REACH metres (a road's curvature wobbles where a bend starts, so the smallest
 * nearby is the safe number). Two values a sample: for a bank leaning right (curvature
 * +) and left (-). `credit` keeps only the help (never below 0).
 */
function pressFrom(curv: ArrayLike<number>, ds: number, credit: boolean): Float64Array {
  const n = curv.length
  const press = new Float64Array(n * 2)
  const reach = Math.max(1, Math.round(PRESS_REACH / ds))
  for (let i = 0; i < n; i++) {
    let pos = Infinity
    let neg = Infinity
    for (let j = i - reach; j <= i + reach; j++) {
      const c = curv[((j % n) + n) % n]
      pos = Math.min(pos, credit ? Math.max(0, c) : c)
      neg = Math.min(neg, credit ? Math.max(0, -c) : -c)
    }
    press[i * 2] = pos
    press[i * 2 + 1] = neg
  }
  return press
}

/**
 * The roll is shaped in "steepness" w = asinh(tan bank) rather than in the bank angle
 * itself. w grows like the angle on a gentle bank and faster on a steep one (60 deg is
 * w 1.32), so an S in w rolls a little slower where the bank is steep: right where
 * gravity holds the car on the road less (it gives g x cos(bank)).
 */
const steepness = (b: number) => Math.asinh(Math.tan(b))
const bankOfSteepness = (w: number) => Math.atan(Math.sinh(w))

/**
 * Make every bank roll gentle enough for a car at CREST_CHECK_KMH on every lane.
 *
 * `bank` (radians, + = left edge up) is changed in place. `half` is the road's half
 * width, `curv` its signed horizontal curvature (+ = turning right) smoothed over a few
 * metres, and `curvRaw` the same unsmoothed (it keeps the small wobble a spline makes
 * where a straight meets a bend), per sample, `ds` metres apart round a closed lap.
 * `designSpeedKmh` is the speed the track's corners are banked for (see LEAN_AHEAD_DEG). `keepLevel` marks samples a roll must not grow into
 * (they stay as they are: the start grid, a loop and the road either side of it).
 * Returns how many rolls were reshaped.
 */
export function shapeBankRolls(bank: Float32Array, half: Float32Array, curv: Float32Array, curvRaw: Float32Array, keepLevel: Uint8Array, ds: number, designSpeedKmh: number): number {
  const n = bank.length
  const v = CREST_CHECK_KMH / 3.6
  const v2 = v * v
  const vLean = Math.min(designSpeedKmh, LEAN_SPEED_KMH) / 3.6
  const leanAhead = (LEAN_AHEAD_DEG * Math.PI) / 180
  const at = (k: number) => bank[((k % n) + n) % n]
  // Which rolls ask too much is judged with the corners' help only (press). A roll this
  // file reshapes is then judged on everything (pressAll): a corner's help, and the lift
  // where it leans against a wobble of the road the other way, which a long roll can
  // reach (a 60 deg roll that grows into a straight leans 50 deg where the straight's
  // spline wobbles before the bend).
  const press = pressFrom(curv, ds, true)
  const pressAll = pressFrom(curvRaw, ds, false)
  // 1. Anything to do? Most tracks' rolls are already gentle and stay exactly as built.
  if (worstCrest(bank, half, press, 0, n - 1, ds, v2) <= CREST_LIMIT) return 0

  // 2. The turns of the bank: alternating highest and lowest points, ignoring wobbles
  //    under TURN_TOL. Indices are unwrapped (they may run past n) so a roll that crosses
  //    the start line is one piece. Starts and ends at the highest bank on the lap.
  let k0 = 0
  for (let k = 1; k < n; k++) if (bank[k] > bank[k0]) k0 = k
  let lo = Infinity
  for (let k = 0; k < n; k++) lo = Math.min(lo, bank[k])
  if (bank[k0] - lo < TURN_TOL) return 0
  const turns: number[] = [k0]
  let goingUp = false
  let ext = k0
  for (let step = 1; step < n; step++) {
    const k = k0 + step
    const b = at(k)
    if (goingUp) {
      if (b > at(ext)) ext = k
      else if (b < at(ext) - TURN_TOL) {
        turns.push(ext)
        goingUp = false
        ext = k
      }
    } else if (b < at(ext)) ext = k
    else if (b > at(ext) + TURN_TOL) {
      turns.push(ext)
      goingUp = true
      ext = k
    }
  }
  turns.push(k0 + n)

  // 3. The level stretch (plateau) round each turn: where the bank stays within FLAT_TOL
  //    of the turn's own angle. A roll may grow into the half of it on its own side.
  // Each turn's angle, read now: reshaping one roll rewrites the plateaus it grows into.
  const turnBank = turns.map((t) => at(t))
  const plo: number[] = []
  const phi: number[] = []
  for (const t of turns) {
    let a = t
    let b = t
    while (t - a < n && Math.abs(at(a - 1) - at(t)) <= FLAT_TOL) a--
    while (b - t < n && Math.abs(at(b + 1) - at(t)) <= FLAT_TOL) b++
    plo.push(a)
    phi.push(b)
  }

  // 4. Each roll runs from one turn's plateau to the next's. Reshape the ones that ask too much.
  // The corner's own bend, averaged over 20 m either side: a roll never grows into road
  // that bends against the way it leans (that is leaning out of a corner).
  const bend = new Float64Array(n)
  {
    const W = Math.max(1, Math.round(20 / ds))
    let sum = 0
    for (let k = -W; k <= W; k++) sum += curv[((k % n) + n) % n]
    for (let i = 0; i < n; i++) {
      bend[i] = sum / (2 * W + 1)
      sum += curv[(i + W + 1) % n] - curv[(((i - W) % n) + n) % n]
    }
  }
  let reshaped = 0
  const h = Math.max(1, Math.round(CREST_SPAN / ds))
  const original = Float32Array.from(bank)
  const work = new Float64Array(n)
  for (let r = 0; r + 1 < turns.length; r++) {
    const from = phi[r] // the roll starts where turn r's plateau ends...
    const to = plo[r + 1] // ...and ends where turn r+1's begins
    if (to - from < 1) continue
    // Does this roll ask too much (on the corners' help only)?
    if (worstCrest(original, half, press, from - 3, to + 3, ds, v2) <= CREST_LIMIT) continue
    const b0 = turnBank[r]
    const b1 = turnBank[r + 1]
    // Grow toward the lower bank (the straight) when both ends lean the same way; a roll
    // from one side to the other (an S-bend) keeps the spot where it is level and grows
    // both ways from there.
    const sameSide = !((b0 < -TURN_TOL && b1 > TURN_TOL) || (b0 > TURN_TOL && b1 < -TURN_TOL))
    const growBack = sameSide && Math.abs(b1) >= Math.abs(b0) // the high end is the far one: grow backward
    const lean = sameSide ? Math.sign(growBack ? b1 : b0) : 0
    // Room either side: half of each plateau, stopping short of anything that stays level
    // or bends the other way.
    const roomBefore = room(from, -1, Math.floor((phi[r] - plo[r]) / 2), sameSide ? lean : Math.sign(b0))
    const roomAfter = room(to, 1, Math.floor((phi[r + 1] - plo[r + 1]) / 2), sameSide ? lean : Math.sign(b1))
    let lane = 0
    for (let k = from; k <= to; k++) lane = Math.max(lane, half[((k % n) + n) % n] - CREST_LANE_INSET)
    // An S-bend's level spot (where the road's bend changes hand, so it never leans out of
    // either corner), and how far along its S the new roll is level.
    let level = from
    while (level < to && bend[((level % n) + n) % n] * b1 <= 0) level++
    const w0 = steepness(b0)
    const dw = steepness(b1) - w0
    let uLevel = 0.5
    if (!sameSide) {
      let lo = 0
      let hi = 1
      for (let it = 0; it < 30; it++) {
        const mid = (lo + hi) / 2
        if (Math.sign(w0 + dw * smootherstep(mid)) === Math.sign(b1)) hi = mid
        else lo = mid
      }
      uLevel = (lo + hi) / 2
    }
    // The shortest an S roll of this size can be (ignoring a corner's help), then longer
    // until it fits. When both ends lean the same way and growing alone can't fit it, the
    // steep end moves into the banked corner a little at a time (the corner gives up some
    // of its full angle, least first).
    const lenMin = Math.max(to - from, Math.sqrt((S_PEAK * Math.abs(dw) * lane * v2) / (CREST_BUILD * G)) / ds)
    let best = worstCrest(original, half, pressAll, from - h, to + h, ds, v2)
    let bestSpan: [number, number] | null = null
    const highRoom = sameSide ? (growBack ? roomAfter : roomBefore) : 0
    search: for (let shift = 0; shift <= highRoom; shift += Math.max(1, Math.round(SHIFT_STEP / ds))) {
      let len = lenMin
      for (let tries = 0; tries < 40; tries++) {
        const span = sameSide ? place(from, to, len, roomBefore, roomAfter, growBack, shift) : placeAround(from, to, level, uLevel, len, from - roomBefore, to + roomAfter)
        if (!span) break search
        const [s0, s1, full] = span
        writeRoll(s0, s1, b0, b1)
        // A longer roll from the same steep end only leans further ahead, so on to the next shift.
        if (leansTooFar(s0, s1)) {
          restore(s0 - JOIN - 3, s1 + JOIN + 3)
          break
        }
        // Judged inside the new roll: at a shared turn with no level stretch the next roll's
        // own bend is still there until that roll is reshaped in its turn.
        const w = worstCrest(bank, half, pressAll, s0 + h, s1 - h, ds, v2)
        restore(s0 - JOIN - 3, s1 + JOIN + 3)
        if (w < best) {
          best = w
          bestSpan = [s0, s1]
        }
        if (w <= CREST_BUILD) break search
        if (!full) break
        len *= 1.05
      }
      if (!sameSide) break
    }
    if (bestSpan) {
      writeRoll(bestSpan[0], bestSpan[1], b0, b1)
      // Keep it: the next roll compares against the road as it now is.
      for (let k = bestSpan[0] - JOIN - 3; k <= bestSpan[1] + JOIN + 3; k++) original[((k % n) + n) % n] = at(k)
      reshaped++
    }
  }
  return reshaped

  /**
   * Does the roll just written over s0..s1 lean further ahead of its bend than
   * LEAN_AHEAD_DEG anywhere the old road didn't already?
   */
  function leansTooFar(s0: number, s1: number): boolean {
    for (let k = s0; k <= s1; k++) {
      const i = ((k % n) + n) % n
      const b = bank[i]
      const into = Math.max(0, b >= 0 ? press[i * 2] : press[i * 2 + 1])
      const wants = Math.atan((vLean * vLean * into) / G) + leanAhead
      if (Math.abs(b) > wants && Math.abs(b) > Math.abs(original[i]) + 1e-4) return true
    }
    return false
  }

  /**
   * Samples a roll may grow from `edge` in direction `dir`, up to `limit`: it stops short
   * of anything kept level, and of road bending against `lean` (the sign of the bank it
   * would grow there; 0 = either way is fine) by more than BEND_AGAINST.
   */
  function room(edge: number, dir: 1 | -1, limit: number, lean: number): number {
    let m = 0
    for (; m < limit; m++) {
      const i = ((((edge + dir * (m + 1 + JOIN)) % n) + n) % n)
      if (keepLevel[i] || bend[i] * lean < -BEND_AGAINST) break
    }
    return m
  }

  /**
   * Where an S roll `len` samples long goes when both ends lean the same way: its steep
   * end `shift` samples into the banked corner (0 = where the old roll reached full bank),
   * growing the other way (into the straight), then into the corner once that room runs
   * out. It always covers the old roll. `full` = it got the whole length.
   */
  function place(from: number, to: number, len: number, roomBefore: number, roomAfter: number, growBack: boolean, shift: number): [number, number, boolean] {
    if (growBack) {
      const end = to + Math.min(shift, roomAfter)
      const start = Math.max(from - roomBefore, Math.min(from, end - len))
      const s1 = Math.min(to + roomAfter, Math.max(end, start + len))
      return [Math.round(start), Math.round(s1), s1 - start >= len - 0.5]
    }
    const start = from - Math.min(shift, roomBefore)
    const end = Math.min(to + roomAfter, Math.max(to, start + len))
    const s0 = Math.max(from - roomBefore, Math.min(start, end - len))
    return [Math.round(s0), Math.round(end), end - s0 >= len - 0.5]
  }

  /**
   * Where an S roll `len` samples long goes from one lean to the other: level at `level`
   * (`uLevel` of the way along the S), where the road's bend changes hand, so it never
   * leans out of either corner. It must still cover the old roll (from..to), so it joins
   * the road either side without a step, and stay within first..last. null when it can't.
   */
  function placeAround(from: number, to: number, level: number, uLevel: number, len: number, first: number, last: number): [number, number, boolean] | null {
    const cover = Math.max((level - from) / uLevel, (to - level) / (1 - uLevel))
    const fits = Math.min((level - first) / uLevel, (last - level) / (1 - uLevel))
    if (cover > fits) return null
    const L = Math.min(Math.max(len, cover), fits)
    return [Math.floor(level - uLevel * L), Math.ceil(level + (1 - uLevel) * L), L >= len - 0.5]
  }

  /** Write an S roll (in steepness) from bank b0 to b1 over samples s0..s1, then soften its joins. */
  function writeRoll(s0: number, s1: number, b0: number, b1: number): void {
    const span = Math.max(1, s1 - s0)
    const w0 = steepness(b0)
    const dw = steepness(b1) - w0
    for (let k = s0; k <= s1; k++) bank[((k % n) + n) % n] = bankOfSteepness(w0 + dw * smootherstep((k - s0) / span))
    // A plateau is level only to within FLAT_TOL, so the S may meet it with a tiny step:
    // three passes of a small blur over each join make that seamless (a level plateau is
    // untouched by it).
    for (const c of [s0, s1]) {
      const a = c - JOIN - 2
      const b = c + JOIN + 2
      for (let pass = 0; pass < 3; pass++) {
        for (let k = a; k <= b; k++) work[k - a] = (at(k - 1) + at(k) + at(k + 1)) / 3
        for (let k = a + 1; k < b; k++) bank[((k % n) + n) % n] = work[k - a]
      }
    }
  }

  function restore(k0: number, k1: number): void {
    for (let k = k0; k <= k1; k++) {
      const i = ((k % n) + n) % n
      bank[i] = original[i]
    }
  }
}
