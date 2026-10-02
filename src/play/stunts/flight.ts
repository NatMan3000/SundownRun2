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
