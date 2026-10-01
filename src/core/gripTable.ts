// ============================================================
//  GRIP TABLE - how hard a car can corner at full steering lock
// ------------------------------------------------------------
//  A contract file: pure data plus one lookup, no imports.
//
//  The VALUES are measured and owned by the vehicle worker: drive
//  the car round a steady circle on flat road at full lock and read
//  the sideways acceleration (in g) at each speed. Whenever the car's
//  steering rack, tyre grip or a body's grip changes, re-measure and
//  update the numbers here.
//
//  The track builder READS them (src/track/derived.ts): the Ai racing
//  line never plans a corner tighter than the least grippy car can
//  steer at that speed. So if these numbers go down, the Ai slows
//  for corners by itself; nothing else needs to change.
// ============================================================

export const FULL_LOCK_GRIP = {
  /** When and on which body the numbers below were measured. */
  measured: '2026-10-01',
  body: 'dart',
  /** Flat road, analog full lock, part throttle. Downforce adds a little with speed. */
  kmh: [89, 124, 160, 196],
  g: [1.37, 1.46, 1.52, 1.57],
  /**
   * The lowest body grip multiplier in the garage (tuning.grip in
   * src/vehicle/bodies/catalog.ts; today the Blade at 0.95). Keep it in step
   * with the catalog: the racing line has to suit every car.
   */
  leastBodyGrip: 0.95,
} as const

/**
 * Sideways acceleration (g) a car can hold at full lock at `kmh`, for a body with
 * grip multiplier `bodyGrip` (1 = the measured body). Straight lines between the
 * measured speeds, held flat beyond the ends.
 */
export function fullLockG(kmh: number, bodyGrip = 1): number {
  const K = FULL_LOCK_GRIP.kmh
  const G = FULL_LOCK_GRIP.g
  let g = G[G.length - 1]
  if (kmh <= K[0]) g = G[0]
  else {
    for (let i = 0; i < K.length - 1; i++) {
      if (kmh <= K[i + 1]) {
        g = G[i] + ((G[i + 1] - G[i]) * (kmh - K[i])) / (K[i + 1] - K[i])
        break
      }
    }
  }
  return g * bodyGrip
}
