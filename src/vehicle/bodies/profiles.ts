// ============================================================
//  BODY RECIPES - the five cars, part by part
// ------------------------------------------------------------
//  Each car is a recipe: a list of chunky parts (bodies/build.ts
//  has the tools, bodies/kit.ts the shapes underneath). The look
//  is a toy-like stunt car: short overhangs, big fender pods over
//  big wheels, a shape you can name from behind at 50 m, and a
//  rocket nozzle that flares when you boost.
//
//  CAR SPACE (metres): +Z forward (nose), +Y up, +X the car's LEFT.
//  The road is at y = -0.542 when the car sits at rest.
//
//  Rules every recipe keeps (physics does not change with the body):
//    - the wheels never move: centres at x = +/-0.80, z = +/-1.42,
//      y = -0.20, radius 0.35. Fenders cut their arch round them.
//    - the physics box is x +/-0.88, y -0.24..0.56, z +/-2.0. The
//      body covers it, so what you see is what you hit. Wings, fins,
//      fenders and canopies may stick out of it.
//    - near a wheel (within 0.43 m along z) the tub's lower flank
//      stays inside x 0.56, so the tyre is never swallowed.
//    - each recipe says where its bonnet camera sits (bonnetAt): on
//      top of the bonnet, by the windscreen, never inside the paint.
//    - at night a car is recognised by its lines alone, so each one
//      traces its own shape in neon (arches, pod shoulders, wing and
//      fin edges, the canopy) in its glow colour, at the T2 tier.
//
//  Josh: change a number, save, and look at the car lab
//  (src/dev/carlab.html) to see what it did.
// ============================================================

import type { BodyId } from './catalog'
import type { BodyBuilder, FenderSpec, WingSpec } from './build'
import { AXLE_Z, bar, lathe, plateFront, plateSide, rbox, tube } from './kit'
import type { V2 } from './kit'
import * as THREE from 'three'

/** Tilt a part sideways about a point (fins that lean out). */
function cant(g: THREE.BufferGeometry, angle: number, px: number, py: number): THREE.BufferGeometry {
  g.translate(-px, -py, 0)
  g.rotateZ(angle)
  g.translate(px, py, 0)
  return g
}

/** The same fender, mirrored front to back (round pods that look the same both ways). */
function flipFender(f: FenderSpec): FenderSpec {
  const flip = (k: V2[]) => k.map(([z, v]) => [-z, v] as V2).reverse()
  return { ...f, zc: -f.zc, front: -f.back, back: -f.front, xOut: flip(f.xOut), yTop: flip(f.yTop) }
}

// ---------------------------------------------------------------- Dart: the all-rounder

/**
 * The poster car. Short blunt nose, a tall round bubble cab, big rear
 * haunches, a proud wing on swan-neck struts and one big rocket.
 * Night lines: four arch outlines, the haunch shoulders, the waist, the wing.
 */
function dart(b: BodyBuilder): void {
  b.wheel = 'star'
  b.tub(
    [
      // z     yBot   wBot  yMid   wMid  ySh   wSh   yTop  wTop  yCrown
      [2.03, -0.22, 0.4, -0.06, 0.6, 0.18, 0.62, 0.3, 0.5, 0.34],
      [1.88, -0.27, 0.48, 0.02, 0.56, 0.34, 0.68, 0.48, 0.56, 0.52],
      [1.6, -0.29, 0.5, 0.08, 0.55, 0.42, 0.72, 0.55, 0.6, 0.59],
      [1.3, -0.29, 0.5, 0.1, 0.55, 0.44, 0.74, 0.57, 0.62, 0.61],
      [0.99, -0.3, 0.52, 0.12, 0.55, 0.45, 0.76, 0.57, 0.64, 0.61],
      [0.85, -0.3, 0.66, -0.1, 0.84, 0.45, 0.85, 0.56, 0.68, 0.61],
      [0.0, -0.31, 0.68, -0.12, 0.86, 0.46, 0.86, 0.57, 0.68, 0.61],
      [-0.85, -0.31, 0.66, -0.1, 0.84, 0.48, 0.85, 0.59, 0.68, 0.62],
      [-0.99, -0.3, 0.52, 0.12, 0.55, 0.5, 0.76, 0.61, 0.66, 0.64],
      [-1.42, -0.29, 0.5, 0.12, 0.55, 0.52, 0.76, 0.63, 0.66, 0.66],
      [-1.85, -0.28, 0.5, 0.1, 0.55, 0.52, 0.76, 0.63, 0.66, 0.66],
      [-2.02, -0.22, 0.48, 0.0, 0.56, 0.48, 0.72, 0.6, 0.62, 0.63],
    ],
    { bulge: 0.06 },
  )
  const front: FenderSpec = {
    zc: AXLE_Z,
    front: 2.02,
    back: 0.76,
    xIn: 0.42,
    xOut: [[0.76, 0.84], [1.0, 0.98], [1.42, 1.02], [1.85, 0.99], [2.02, 0.86]],
    yTop: [[0.76, 0.46], [1.05, 0.56], [1.42, 0.6], [1.8, 0.52], [2.02, 0.3]],
    yFloor: -0.27,
    archR: 0.43,
    round: 0.14,
  }
  const rear: FenderSpec = {
    zc: -AXLE_Z,
    front: -0.68,
    back: -2.02,
    xIn: 0.42,
    xOut: [[-2.02, 0.98], [-1.85, 1.07], [-1.42, 1.09], [-0.95, 1.03], [-0.68, 0.86]],
    yTop: [[-2.02, 0.62], [-1.6, 0.72], [-1.2, 0.7], [-0.9, 0.62], [-0.68, 0.5]],
    yFloor: -0.27,
    archR: 0.43,
    round: 0.16,
    lean: 0.05,
  }
  b.fender(front).fender(rear)
  b.rocker(0.76, -0.68, 0.04, 0.87)
  b.canopy(
    [
      [1.15, 0.54, 0.6, 0.58, 0.56],
      [0.8, 0.56, 0.7, 0.9, 0.56],
      [0.25, 0.58, 0.72, 1.1, 0.52],
      [-0.4, 0.6, 0.72, 1.12, 0.52],
      [-0.95, 0.62, 0.7, 0.98, 0.56],
      [-1.35, 0.64, 0.66, 0.7, 0.62],
    ],
    { bulge: 0.1 },
  )
  // the big rear wing on swan-neck struts, endplates in the accent colour
  const wing: WingSpec = { span: 0.92, z: -1.6, y: 1.14, chord: 0.46, thick: 0.075, angle: 0.15, sweep: 0.06, dihedral: 0.03, accent: true }
  b.wing(wing)
  b.paint(plateSide([[-1.52, 1.0], [-2.14, 1.02], [-2.16, 1.32], [-1.72, 1.27]], 0.04, 0.93), { accent: true, mirror: true })
  b.paint(plateSide([[-1.55, 0.64], [-1.8, 0.64], [-1.86, 1.16], [-1.7, 1.16]], 0.045, 0.42), { mirror: true })
  // one big rocket
  b.nozzle({ x: 0, y: 0.16, z: -2.02, r: 0.2, len: 0.17, flame: 0.95 })
  // lights: angular eyes across the nose and pods, hooked tail lamps on the haunches
  b.light(plateFront([[0.46, 0.22], [0.8, 0.15], [0.8, 0.07], [0.52, 0.12]], 0.03, 2.045, 1), 'head', { mirror: true })
  b.headAt(0.64, 0.14, 2.05)
  b.light(plateFront([[0.5, 0.56], [0.94, 0.56], [0.94, 0.26], [0.87, 0.26], [0.87, 0.49], [0.5, 0.49]], 0.03, -2.035, -1), 'tail', { mirror: true })
  b.tailAt(0.9, 0.4, -2.05)
  // trim: splitter, nose intake, bonnet vents, side scoops, diffuser
  b.trim(rbox(1.56, 0.035, 0.22, 0, -0.275, 1.96, 0.012))
  b.trim(plateFront([[-0.38, -0.18], [0.38, -0.18], [0.32, 0.0], [-0.32, 0.0]], 0.02, 2.045, 1))
  for (const x of [-0.18, 0, 0.18]) b.trim(rbox(0.1, 0.02, 0.26, x, 0.615, 1.3, 0.008, -0.06))
  b.trim(plateSide([[-0.6, 0.06], [-0.92, 0.04], [-0.92, 0.34], [-0.72, 0.3]], 0.03, 0.865), { mirror: true })
  b.trim(rbox(1.0, 0.14, 0.2, 0, -0.22, -1.95, 0.02))
  b.wells(0.57)
  // night signature
  b.archLight(front).archLight(rear)
  b.podLight(rear, -0.72, -1.98)
  b.tubStrip(3, 0.76, -0.68, 0.028)
  b.wingLight(wing)
  b.bonnetAt(0.69, 1.62)
}

// ---------------------------------------------------------------- Blade: the wedge

/**
 * Long, low-slung and sharp: a wedge rising from pointed front pontoons
 * to a high tail, a fighter canopy sunk into it, twin raked fins and twin
 * rockets. Night lines: one knife-crease down each side and the fin edges.
 */
function blade(b: BodyBuilder): void {
  b.wheel = 'turbine'
  b.tub(
    [
      [2.08, -0.2, 0.34, -0.15, 0.46, 0.02, 0.5, 0.12, 0.38, 0.15],
      [1.95, -0.25, 0.42, -0.08, 0.52, 0.22, 0.6, 0.34, 0.48, 0.38],
      [1.8, -0.27, 0.46, -0.02, 0.54, 0.36, 0.66, 0.5, 0.52, 0.53],
      [1.5, -0.29, 0.5, 0.06, 0.55, 0.4, 0.72, 0.52, 0.58, 0.56],
      [0.99, -0.3, 0.52, 0.1, 0.55, 0.43, 0.76, 0.54, 0.62, 0.58],
      [0.85, -0.31, 0.66, -0.1, 0.86, 0.43, 0.86, 0.54, 0.66, 0.59],
      [0.0, -0.32, 0.68, -0.12, 0.87, 0.46, 0.87, 0.57, 0.68, 0.62],
      [-0.85, -0.32, 0.66, -0.1, 0.86, 0.5, 0.86, 0.61, 0.7, 0.66],
      [-0.99, -0.31, 0.52, 0.12, 0.55, 0.51, 0.8, 0.62, 0.7, 0.67],
      [-1.42, -0.3, 0.5, 0.12, 0.55, 0.54, 0.8, 0.65, 0.72, 0.69],
      [-1.85, -0.29, 0.5, 0.1, 0.55, 0.56, 0.8, 0.67, 0.72, 0.71],
      [-2.04, -0.24, 0.48, 0.0, 0.56, 0.56, 0.78, 0.67, 0.72, 0.71],
    ],
    { bulge: 0 },
  )
  const front: FenderSpec = {
    zc: AXLE_Z,
    front: 2.2,
    back: 0.8,
    xIn: 0.42,
    xOut: [[0.8, 0.86], [1.1, 0.98], [1.42, 1.0], [1.85, 0.93], [2.2, 0.58]],
    yTop: [[0.8, 0.44], [1.1, 0.54], [1.42, 0.56], [1.85, 0.5], [2.2, 0.06]],
    yFloor: -0.28,
    archR: 0.43,
    round: 0.035,
    lean: -0.04,
  }
  const rear: FenderSpec = {
    zc: -AXLE_Z,
    front: -0.75,
    back: -2.04,
    xIn: 0.44,
    xOut: [[-2.04, 0.97], [-1.8, 1.01], [-1.42, 1.02], [-1.0, 0.98], [-0.75, 0.86]],
    yTop: [[-2.04, 0.7], [-1.42, 0.7], [-1.0, 0.63], [-0.75, 0.5]],
    yFloor: -0.28,
    archR: 0.43,
    round: 0.035,
    lean: -0.03,
  }
  b.fender(front).fender(rear)
  b.rocker(0.8, -0.75, 0.0, 0.88)
  b.canopy(
    [
      [0.95, 0.5, 0.36, 0.53, 0.3],
      [0.55, 0.53, 0.52, 0.76, 0.32],
      [-0.05, 0.56, 0.56, 0.9, 0.28],
      [-0.7, 0.6, 0.52, 0.88, 0.26],
      [-1.3, 0.65, 0.42, 0.78, 0.24],
      [-1.75, 0.69, 0.3, 0.73, 0.2],
    ],
    { bulge: 0.05 },
  )
  // twin fins, raked back and leaning out, in the accent colour, with neon leading and top edges
  const finAt = (g: THREE.BufferGeometry) => cant(g, -0.18, 0.72, 0.68)
  b.paint(finAt(plateSide([[-1.2, 0.66], [-2.04, 0.7], [-2.22, 1.16], [-1.98, 1.16]], 0.045, 0.72)), { accent: true, mirror: true })
  b.light(finAt(bar({ x: 0.72, y: 0.69, z: -1.24 }, { x: 0.72, y: 1.16, z: -1.97 }, 0.055, 0.03)), 'livery', { mirror: true })
  b.light(finAt(bar({ x: 0.72, y: 1.165, z: -1.97 }, { x: 0.72, y: 1.165, z: -2.22 }, 0.055, 0.03)), 'livery', { mirror: true })
  b.nozzle({ x: 0.36, y: 0.2, z: -2.04, r: 0.13, len: 0.15, mirror: true, flame: 0.8 })
  // lights: slits across the nose corners, a thin full-width tail bar with hooked ends
  b.light(plateFront([[0.16, 0.1], [0.46, 0.04], [0.46, 0.0], [0.2, 0.05]], 0.03, 2.095, 1), 'head', { mirror: true })
  b.headAt(0.32, 0.05, 2.1)
  b.light(plateFront([[-0.72, 0.66], [0.72, 0.66], [0.72, 0.62], [-0.72, 0.62]], 0.03, -2.055, -1), 'tail')
  b.light(plateFront([[0.82, 0.66], [0.94, 0.66], [0.94, 0.3], [0.82, 0.36]], 0.03, -2.055, -1), 'tail', { mirror: true })
  b.tailAt(0.88, 0.48, -2.06)
  // trim: a wide blade splitter, side blades ahead of the rear wheels, diffuser
  b.trim(rbox(1.74, 0.03, 0.32, 0, -0.28, 1.98, 0.01))
  b.trim(plateSide([[-0.2, 0.18], [-0.92, 0.24], [-0.92, 0.44], [-0.5, 0.36]], 0.03, 0.875), { mirror: true })
  b.trim(rbox(1.0, 0.14, 0.2, 0, -0.24, -1.97, 0.02))
  b.wells(0.58)
  // night signature: one knife-crease down each side (pontoon edge, waist, rear pod)
  b.podLight(front, 2.12, 0.84, 0.024)
  b.tubStrip(4, 0.82, -0.78, 0.024)
  b.podLight(rear, -0.78, -2.0, 0.024)
  b.bonnetAt(0.66, 1.55)
}

// ---------------------------------------------------------------- Brick: the armoured truck

/**
 * A tall armoured box on big steel wheels: a flat bonnet, bull bar,
 * boxy flared arches, a roof light bar, twin rockets low in the back.
 * Night lines: arch outlines, the roof's edge, the light bar, the waist.
 */
function brick(b: BodyBuilder): void {
  b.wheel = 'steelie'
  b.tub(
    [
      [2.04, -0.24, 0.6, -0.05, 0.72, 0.32, 0.76, 0.46, 0.7, 0.48],
      [1.85, -0.28, 0.6, 0.05, 0.6, 0.4, 0.8, 0.55, 0.74, 0.57],
      [1.42, -0.29, 0.6, 0.12, 0.56, 0.42, 0.82, 0.56, 0.76, 0.58],
      [0.99, -0.3, 0.6, 0.12, 0.56, 0.43, 0.84, 0.57, 0.78, 0.59],
      [0.85, -0.3, 0.7, -0.1, 0.88, 0.44, 0.88, 0.58, 0.8, 0.6],
      [0.0, -0.3, 0.7, -0.1, 0.89, 0.45, 0.89, 0.58, 0.8, 0.6],
      [-0.85, -0.3, 0.7, -0.1, 0.88, 0.46, 0.88, 0.58, 0.8, 0.6],
      [-0.99, -0.3, 0.6, 0.12, 0.56, 0.46, 0.84, 0.58, 0.8, 0.6],
      [-1.42, -0.29, 0.6, 0.12, 0.56, 0.46, 0.84, 0.58, 0.8, 0.6],
      [-1.85, -0.28, 0.6, 0.1, 0.56, 0.46, 0.84, 0.58, 0.8, 0.6],
      [-2.02, -0.24, 0.6, 0.0, 0.64, 0.44, 0.82, 0.58, 0.78, 0.6],
    ],
    { bulge: 0.01 },
  )
  const front: FenderSpec = {
    zc: AXLE_Z,
    front: 2.04,
    back: 0.8,
    xIn: 0.5,
    xOut: [[0.8, 0.9], [1.0, 1.0], [1.85, 1.0], [2.04, 0.92]],
    yTop: [[0.8, 0.5], [1.0, 0.56], [1.85, 0.56], [2.04, 0.5]],
    yFloor: -0.27,
    archR: 0.45,
    round: 0.04,
    lean: 0,
  }
  const rear: FenderSpec = {
    zc: -AXLE_Z,
    front: -0.8,
    back: -2.02,
    xIn: 0.5,
    xOut: [[-2.02, 0.95], [-1.85, 1.02], [-1.0, 1.02], [-0.8, 0.9]],
    yTop: [[-2.02, 0.56], [-1.85, 0.6], [-1.0, 0.6], [-0.8, 0.54]],
    yFloor: -0.27,
    archR: 0.45,
    round: 0.04,
    lean: 0,
  }
  b.fender(front).fender(rear)
  b.rocker(0.8, -0.8, 0.02, 0.9)
  // a boxy greenhouse with a near-upright screen, under an armoured roof slab
  b.canopy(
    [
      [1.14, 0.56, 0.74, 0.6, 0.72],
      [1.0, 0.58, 0.76, 1.0, 0.7],
      [0.6, 0.6, 0.78, 1.04, 0.72],
      [-0.9, 0.6, 0.78, 1.04, 0.72],
      [-1.55, 0.6, 0.78, 1.02, 0.72],
      [-1.75, 0.6, 0.76, 0.66, 0.72],
    ],
    { bulge: 0.01 },
  )
  b.paint(rbox(1.56, 0.1, 2.5, 0, 1.06, -0.35, 0.04))
  b.paint(rbox(1.6, 0.44, 0.12, 0, 0.82, -0.25, 0.02))
  b.paint(rbox(0.06, 0.06, 2.3, 0.6, 1.14, -0.35, 0.02), { accent: true, mirror: true })
  // bull bar, bumpers, side steps (dark chrome)
  for (const x of [0.3, -0.3]) b.trim(tube({ x, y: -0.22, z: 2.16 }, { x, y: 0.44, z: 2.16 }, 0.034), { metal: true })
  b.trim(tube({ x: -0.48, y: 0.44, z: 2.16 }, { x: 0.48, y: 0.44, z: 2.16 }, 0.034), { metal: true })
  b.trim(tube({ x: -0.8, y: -0.08, z: 2.15 }, { x: 0.8, y: -0.08, z: 2.15 }, 0.032), { metal: true })
  b.trim(rbox(1.86, 0.2, 0.18, 0, -0.18, 2.06, 0.03))
  b.trim(rbox(1.84, 0.18, 0.16, 0, -0.2, -2.04, 0.03))
  b.trim(rbox(0.14, 0.05, 1.5, 0.92, -0.27, 0, 0.015), { metal: true, mirror: true })
  b.trim(plateFront([[-0.44, 0.02], [0.44, 0.02], [0.44, 0.38], [-0.44, 0.38]], 0.02, 2.05, 1))
  for (const x of [-0.3, -0.15, 0, 0.15, 0.3]) b.trim(rbox(0.05, 0.3, 0.03, x, 0.2, 2.065, 0.01), { metal: true })
  b.nozzle({ x: 0.36, y: 0.06, z: -2.02, r: 0.13, len: 0.12, mirror: true, flame: 0.7 })
  // lights: square lamps, a roof light bar, tall tail stacks
  b.light(plateFront([[0.52, 0.14], [0.74, 0.14], [0.74, 0.36], [0.52, 0.36]], 0.03, 2.06, 1), 'head', { mirror: true })
  b.light(rbox(1.1, 0.05, 0.06, 0, 1.14, 0.8, 0.015), 'head')
  b.headAt(0.63, 0.25, 2.07)
  b.light(plateFront([[0.8, 0.14], [0.93, 0.14], [0.93, 0.54], [0.8, 0.54]], 0.03, -2.035, -1), 'tail', { mirror: true })
  b.tailAt(0.86, 0.34, -2.05)
  b.wells(0.58, 0.46)
  // night signature: the arches, the roof slab's edge, the waist
  b.archLight(front, 0.04, 0.96).archLight(rear, 0.04, 0.96)
  b.light(bar({ x: 0.786, y: 1.06, z: 0.88 }, { x: 0.786, y: 1.06, z: -1.58 }, 0.012, 0.03), 'livery', { mirror: true })
  b.tubStrip(3, 0.8, -0.8, 0.032)
  b.bonnetAt(0.69, 1.64)
}

// ---------------------------------------------------------------- Manta: the ray

/**
 * Wide and flat like a ray: two horn pods reaching past the nose, wide
 * wing-tip pods at the back, a raised spine with a small canopy set far
 * back, a T-tail fin and three rockets.
 * Night lines: the ray's outline down both pods, the T-tail, the fin.
 */
function manta(b: BodyBuilder): void {
  b.wheel = 'aero'
  b.tub(
    [
      [2.0, -0.2, 0.38, -0.12, 0.48, 0.14, 0.54, 0.3, 0.44, 0.34],
      [1.82, -0.27, 0.44, -0.04, 0.5, 0.34, 0.6, 0.5, 0.5, 0.55],
      [1.42, -0.29, 0.48, 0.08, 0.54, 0.38, 0.68, 0.52, 0.58, 0.58],
      [0.99, -0.3, 0.52, 0.1, 0.55, 0.38, 0.74, 0.52, 0.62, 0.58],
      [0.85, -0.3, 0.66, -0.1, 0.86, 0.38, 0.88, 0.5, 0.72, 0.58],
      [0.0, -0.31, 0.68, -0.12, 0.88, 0.38, 0.9, 0.5, 0.72, 0.58],
      [-0.85, -0.31, 0.66, -0.1, 0.86, 0.38, 0.88, 0.5, 0.72, 0.58],
      [-0.99, -0.3, 0.52, 0.1, 0.55, 0.4, 0.76, 0.52, 0.66, 0.58],
      [-1.42, -0.29, 0.5, 0.1, 0.55, 0.4, 0.76, 0.52, 0.66, 0.58],
      [-1.85, -0.28, 0.5, 0.06, 0.55, 0.4, 0.74, 0.52, 0.64, 0.57],
      [-2.04, -0.22, 0.46, -0.02, 0.54, 0.36, 0.7, 0.48, 0.6, 0.53],
    ],
    { bulge: 0.03 },
  )
  const front: FenderSpec = {
    zc: AXLE_Z,
    front: 2.22,
    back: 0.76,
    xIn: 0.4,
    xOut: [[0.76, 0.9], [1.05, 1.08], [1.42, 1.1], [1.85, 1.06], [2.22, 0.88]],
    yTop: [[0.76, 0.44], [1.1, 0.5], [1.42, 0.52], [1.9, 0.46], [2.22, 0.12]],
    yFloor: -0.27,
    archR: 0.43,
    round: 0.14,
    lean: 0.05,
  }
  const rear: FenderSpec = {
    zc: -AXLE_Z,
    front: -0.74,
    back: -2.24,
    xIn: 0.4,
    xOut: [[-2.24, 1.02], [-1.85, 1.1], [-1.42, 1.12], [-1.0, 1.08], [-0.74, 0.9]],
    yTop: [[-2.24, 0.4], [-1.85, 0.5], [-1.42, 0.52], [-1.0, 0.5], [-0.74, 0.46]],
    yFloor: -0.26,
    archR: 0.43,
    round: 0.14,
    lean: 0.05,
  }
  b.fender(front).fender(rear)
  b.rocker(0.76, -0.74, 0.02, 0.89)
  b.canopy(
    [
      [0.2, 0.54, 0.36, 0.57, 0.3],
      [-0.15, 0.56, 0.46, 0.76, 0.32],
      [-0.65, 0.58, 0.48, 0.8, 0.3],
      [-1.15, 0.58, 0.42, 0.74, 0.26],
      [-1.55, 0.58, 0.3, 0.62, 0.2],
    ],
    { bulge: 0.06 },
  )
  // the T-tail: one dorsal fin carrying a swept blade, both in the accent colour
  b.paint(plateSide([[-1.0, 0.58], [-1.95, 0.58], [-2.12, 1.02], [-1.84, 1.02]], 0.05, 0), { accent: true })
  const tail: WingSpec = { span: 0.8, z: -1.8, y: 1.01, chord: 0.34, thick: 0.045, angle: 0.02, sweep: 0.14, dihedral: -0.05, accent: true }
  b.wing(tail)
  // three rockets in a row
  b.nozzle({ x: 0, y: 0.14, z: -2.04, r: 0.14, len: 0.15, flame: 0.9 })
  b.nozzle({ x: 0.36, y: 0.12, z: -2.04, r: 0.1, len: 0.12, mirror: true, flame: 0.65 })
  // lights: one wide slit across the nose, lamps in the horn tips, a wide tail bar
  b.light(plateFront([[-0.42, 0.2], [0.42, 0.2], [0.38, 0.15], [-0.38, 0.15]], 0.03, 2.015, 1), 'head')
  b.light(plateFront([[0.5, 0.04], [0.8, 0.04], [0.8, -0.01], [0.5, -0.01]], 0.03, 2.235, 1), 'head', { mirror: true })
  b.headAt(0.62, 0.02, 2.24)
  b.light(plateFront([[-0.58, 0.42], [0.58, 0.42], [0.58, 0.38], [-0.58, 0.38]], 0.03, -2.055, -1), 'tail')
  b.light(plateFront([[0.62, 0.32], [0.96, 0.32], [0.96, 0.26], [0.62, 0.26]], 0.03, -2.255, -1), 'tail', { mirror: true })
  b.tailAt(0.8, 0.29, -2.26)
  b.trim(rbox(1.0, 0.03, 0.26, 0, -0.25, 1.9, 0.01))
  b.trim(rbox(1.2, 0.12, 0.2, 0, -0.22, -1.97, 0.02))
  b.wells(0.57)
  // night signature: the ray's outline, the T-tail and the fin's top
  b.podLight(front, 2.16, 0.8, 0.026, 0.02)
  b.podLight(rear, -0.78, -2.2, 0.026, 0.02)
  b.wingLight(tail)
  b.light(bar({ x: 0, y: 0.6, z: -1.02 }, { x: 0, y: 1.0, z: -1.85 }, 0.06, 0.025), 'livery')
  b.underglow = { halfWidth: 0.76, halfLength: 1.72, y: -0.42 }
  b.bonnetAt(0.67, 1.66)
}

// ---------------------------------------------------------------- Pulse: the bubble pod

/**
 * A tiny round pod: a huge bubble canopy on four round humps, frog-eye
 * lamps, a whip antenna and one big round rocket.
 * Night lines: a visor ring round the bubble, the four arches, the antenna tip.
 */
function pulse(b: BodyBuilder): void {
  b.wheel = 'pod'
  b.tub(
    [
      [2.03, -0.14, 0.4, -0.02, 0.54, 0.2, 0.6, 0.34, 0.48, 0.4],
      [1.92, -0.24, 0.46, 0.0, 0.55, 0.3, 0.66, 0.44, 0.56, 0.5],
      [1.7, -0.28, 0.48, 0.06, 0.55, 0.34, 0.7, 0.48, 0.58, 0.54],
      [1.42, -0.29, 0.5, 0.1, 0.55, 0.36, 0.72, 0.5, 0.6, 0.56],
      [0.99, -0.3, 0.52, 0.1, 0.55, 0.36, 0.76, 0.5, 0.62, 0.56],
      [0.85, -0.3, 0.64, -0.06, 0.84, 0.36, 0.85, 0.5, 0.64, 0.56],
      [0.0, -0.31, 0.66, -0.08, 0.86, 0.38, 0.86, 0.52, 0.66, 0.58],
      [-0.85, -0.3, 0.64, -0.06, 0.84, 0.36, 0.85, 0.5, 0.64, 0.56],
      [-0.99, -0.3, 0.52, 0.1, 0.55, 0.36, 0.76, 0.5, 0.62, 0.56],
      [-1.42, -0.29, 0.5, 0.1, 0.55, 0.36, 0.72, 0.5, 0.6, 0.56],
      [-1.7, -0.28, 0.48, 0.06, 0.55, 0.34, 0.7, 0.48, 0.58, 0.54],
      [-1.92, -0.24, 0.46, 0.0, 0.55, 0.3, 0.66, 0.44, 0.56, 0.5],
      [-2.03, -0.14, 0.4, -0.02, 0.54, 0.2, 0.6, 0.34, 0.48, 0.4],
    ],
    { bulge: 0.18 },
  )
  const pod: FenderSpec = {
    zc: AXLE_Z,
    front: 2.02,
    back: 0.82,
    xIn: 0.42,
    xOut: [[0.82, 0.8], [1.05, 1.0], [1.42, 1.05], [1.79, 1.0], [2.02, 0.8]],
    yTop: [[0.82, 0.06], [1.0, 0.46], [1.42, 0.62], [1.84, 0.46], [2.02, 0.12]],
    yFloor: -0.22,
    archR: 0.42,
    round: 0.2,
    lean: 0.0,
  }
  const podR = flipFender(pod)
  b.fender(pod).fender(podR)
  b.rocker(0.82, -0.82, 0.0, 0.87)
  b.canopy(
    [
      [1.55, 0.5, 0.5, 0.54, 0.44],
      [1.2, 0.52, 0.74, 0.88, 0.6],
      [0.55, 0.54, 0.82, 1.12, 0.56],
      [-0.25, 0.55, 0.82, 1.16, 0.56],
      [-0.95, 0.54, 0.78, 0.98, 0.6],
      [-1.5, 0.52, 0.62, 0.6, 0.54],
    ],
    { bulge: 0.18 },
  )
  // frog-eye lamp pods on the front humps, low and forward
  const eyePod: V2[] = [
    [0, 0],
    [0.085, 0],
    [0.1, 0.03],
    [0.1, 0.16],
    [0.07, 0.21],
    [0, 0.21],
  ]
  b.paint(lathe(eyePod, 16, { x: 0.74, y: 0.5, z: 1.9 }), { mirror: true, shading: 0.8 })
  const eye = new THREE.CircleGeometry(0.072, 16)
  eye.translate(0.74, 0.5, 1.906)
  b.light(eye, 'head', { mirror: true })
  b.headAt(0.74, 0.5, 1.92)
  // whip antenna with a glowing tip
  b.trim(tube({ x: -0.44, y: 0.82, z: -1.15 }, { x: -0.52, y: 1.48, z: -1.4 }, 0.012, 6), { metal: true })
  const tip = new THREE.SphereGeometry(0.05, 10, 8)
  tip.translate(-0.52, 1.5, -1.41)
  b.light(tip, 'livery')
  // one big round rocket and round tail lamps
  b.nozzle({ x: 0, y: 0.12, z: -2.03, r: 0.21, len: 0.17, flame: 0.95 })
  const lamp = new THREE.CircleGeometry(0.08, 16)
  lamp.rotateY(Math.PI)
  lamp.translate(0.64, 0.16, -2.01)
  b.light(lamp, 'tail', { mirror: true })
  b.tailAt(0.64, 0.16, -2.03)
  b.wells(0.57, 0.43)
  // night signature: a visor ring round the bubble and the four round arches
  b.canopyLight(1.4, -1.4, 0.5)
  // the pulse: a ring of light round the big rocket
  const halo = new THREE.TorusGeometry(0.245, 0.014, 4, 32)
  halo.translate(0, 0.12, -2.035)
  b.light(halo, 'livery')
  b.archLight(pod, 0.08, 0.92).archLight(podR, 0.08, 0.92)
  b.underglow = { halfWidth: 0.7, halfLength: 1.62, y: -0.4 }
  b.bonnetAt(0.65, 1.76)
}

export const RECIPES: Record<BodyId, (b: BodyBuilder) => void> = { dart, blade, brick, manta, pulse }
