// ============================================================
//  FLIGHT - where a car goes when it leaves a ramp
// ------------------------------------------------------------
//  The stunt park puts its landing ramps, rings and bullseye pads
//  where a car actually comes down, so it works this out the way
//  the physics will: speed lost climbing the ramp, the lip's angle,
//  gravity, and a little air drag. Pure maths, no physics engine.
//
//  Everything is in a ramp's own side view: `a` metres forward
//  from the lip, `h` metres above the ground the ramp stands on.
//  The path is the car's middle (about 0.55 m above its wheels).
// ============================================================

const G = 9.81
/** The car's middle sits this far above the surface its wheels are on. */
export const CAR_MID = 0.55
/** Air drag per kg: F = 0.3 v^2 on a 1200 kg car (src/vehicle/tuning.ts AERO.drag). */
const DRAG_PER_KG = 0.3 / 1200
const DT = 1 / 120

export interface FlightPath {
  /** Samples every DT seconds: a forward of the lip, h above the ground, and the time. */
  a: number[]
  h: number[]
  t: number[]
  /** Speed leaving the lip, m/s. */
  lipSpeed: number
}

/** Speed left at the top of a ramp `climb` metres tall, approached at `kmh` (energy only; the engine helps a little). */
export function speedAtLip(kmh: number, climb: number): number {
  const v = kmh / 3.6
  return Math.sqrt(Math.max(25, v * v - 2 * G * climb))
}

/**
 * The flight off a lip `lipH` metres up whose surface climbs `lipSlope` (rise per metre) as it
 * ends, approached at `kmh`. Runs until the car's middle drops to `floor` metres (or 12 s).
 */
export function flightFrom(kmh: number, lipH: number, lipSlope: number, floor = 0): FlightPath {
  const v = speedAtLip(kmh, lipH)
  const ang = Math.atan(lipSlope)
  let vx = v * Math.cos(ang)
  let vy = v * Math.sin(ang)
  // The car's middle starts above the lip, along the surface's normal.
  let x = -Math.sin(ang) * CAR_MID
  let y = lipH + Math.cos(ang) * CAR_MID
  const path: FlightPath = { a: [x], h: [y], t: [0], lipSpeed: v }
  let t = 0
  while (t < 12 && y > floor + CAR_MID - 1e-6) {
    const s = Math.hypot(vx, vy)
    vx -= DRAG_PER_KG * s * vx * DT
    vy -= (G + DRAG_PER_KG * s * vy) * DT
    x += vx * DT
    y += vy * DT
    t += DT
    path.a.push(x)
    path.h.push(y)
    path.t.push(t)
  }
  return path
}

/**
 * A car leaving a short, curved kicker flies a touch steeper than the face's last stretch: its
 * springs, squashed by the curve, push off as they unload. Measured on 2026-10-03 on two Afterglow
 * kickers (1.3 m) whose bullseyes sit on differently tilted ground: the middle of the x3 ring came
 * at 88.6 and 81.7 km/h at the lip; the flight below, with this much extra slope, says 89 and 82.
 */
export const KICKER_POP = 0.02

/**
 * How far forward of a lip (metres) a car leaving it at `v` m/s, climbing `slope` (rise per metre,
 * in the world), first brings its wheels down to a flat surface `drop` metres below the lip
 * (negative = above it). -1 if it never does (a surface above the top of the flight).
 */
export function reachAt(v: number, slope: number, drop: number): number {
  const ang = Math.atan(slope)
  let vx = v * Math.cos(ang)
  let vy = v * Math.sin(ang)
  let x = -Math.sin(ang) * CAR_MID
  let y = Math.cos(ang) * CAR_MID
  const floor = CAR_MID - drop
  for (let t = 0; t < 12; t += DT) {
    const s = Math.hypot(vx, vy)
    vx -= DRAG_PER_KG * s * vx * DT
    vy -= (G + DRAG_PER_KG * s * vy) * DT
    const nx = x + vx * DT
    const ny = y + vy * DT
    // Coming down through the surface this step: where between the two samples.
    if (vy < 0 && ny <= floor && y > floor) return x + ((nx - x) * (y - floor)) / (y - ny)
    x = nx
    y = ny
  }
  return -1
}

/**
 * The lip speed (m/s) that brings a car's wheels down `distance` metres forward of a lip, on a
 * surface `drop` metres below it, the lip climbing `slope` in the world. Used to paint the right
 * speed on a launch whose bullseye sits on its own patch of ground (not quite level with the ramp).
 */
export function lipSpeedFor(distance: number, slope: number, drop: number): number {
  let lo = 4
  let hi = 100
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    const r = reachAt(mid, slope, drop)
    if (r < 0 || r < distance) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/** Something a jump off a lip should do, in the lip's own vertical plane (metres forward of it, metres above it). */
export interface FlightTarget {
  /**
   * 'ring': the car's middle crosses the ring's plane (normal (na, nh): the way through it) within
   * `radius` of its centre (dist, rise), as the scoring tests it. 'clear': the wheels are above
   * (dist, rise) as the car passes it (a landing's near edge).
   */
  kind: 'ring' | 'clear'
  dist: number
  rise: number
  radius: number
  na: number
  nh: number
}

/** Does a flight leaving a lip at `v` m/s, climbing `slope`, do every target? */
function doesAll(v: number, slope: number, targets: FlightTarget[]): boolean {
  const ang = Math.atan(slope)
  let vx = v * Math.cos(ang)
  let vy = v * Math.sin(ang)
  let x = -Math.sin(ang) * CAR_MID
  let y = Math.cos(ang) * CAR_MID
  let far = 0
  for (const t of targets) far = Math.max(far, t.dist + t.radius)
  const done: boolean[] = targets.map(() => false)
  for (let t = 0; t < 12 && x <= far; t += DT) {
    const s = Math.hypot(vx, vy)
    vx -= DRAG_PER_KG * s * vx * DT
    vy -= (G + DRAG_PER_KG * s * vy) * DT
    const nx = x + vx * DT
    const ny = y + vy * DT
    for (let k = 0; k < targets.length; k++) {
      const T = targets[k]
      if (T.kind === 'ring') {
        const d0 = (x - T.dist) * T.na + (y - T.rise) * T.nh
        const d1 = (nx - T.dist) * T.na + (ny - T.rise) * T.nh
        if ((d0 < 0) !== (d1 < 0)) {
          const u = d0 / (d0 - d1)
          if (Math.hypot(x + (nx - x) * u - T.dist, y + (ny - y) * u - T.rise) <= T.radius) done[k] = true
        }
      } else if (x < T.dist && nx >= T.dist) {
        const yAt = y + ((ny - y) * (T.dist - x)) / Math.max(1e-9, nx - x)
        done[k] = yAt - CAR_MID >= T.rise
      }
    }
    if (ny < -200) break
    x = nx
    y = ny
  }
  for (let k = 0; k < targets.length; k++) if (!done[k]) return false
  return true
}

/**
 * The lip speeds (km/h) at which a jump does every target, as [slowest, fastest], scanning from
 * `from` to `to` km/h; null if no speed does them all. Used to paint a launch's sign in the middle
 * of the speeds that score everything it offers, worked out on the ground where it really stands.
 */
export function scoringBand(slope: number, targets: FlightTarget[], from = 40, to = 220): [number, number] | null {
  let lo = -1
  let hi = -1
  for (let kmh = from; kmh <= to; kmh += 0.5) {
    if (doesAll(kmh / 3.6, slope, targets)) {
      if (lo < 0) lo = kmh
      hi = kmh
    } else if (lo >= 0) {
      break
    }
  }
  return lo < 0 ? null : [lo, hi]
}

/**
 * Where the flight's wheels first meet a surface `surf(a)` (height of the surface at `a`, or
 * -Infinity where there is none). Returns the sample index, or -1 if it never does.
 */
export function landingIndex(p: FlightPath, surf: (a: number) => number): number {
  for (let i = 1; i < p.a.length; i++) {
    if (p.h[i] - CAR_MID <= surf(p.a[i])) return i
  }
  return -1
}

/** The flight's highest point (index). */
export function apexIndex(p: FlightPath): number {
  let best = 0
  for (let i = 1; i < p.h.length; i++) if (p.h[i] > p.h[best]) best = i
  return best
}

/** Direction of travel at sample i, as a unit (along, up) pair. */
export function directionAt(p: FlightPath, i: number): [number, number] {
  const j = Math.min(p.a.length - 1, i + 1)
  const k = Math.max(0, j - 2)
  const da = p.a[j] - p.a[k]
  const dh = p.h[j] - p.h[k]
  const L = Math.hypot(da, dh) || 1
  return [da / L, dh / L]
}
