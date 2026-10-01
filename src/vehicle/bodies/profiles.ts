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
//    - the wheels never move: centres at x = +/-0.80, z = +/-1.42.
//      Each car picks how big its tyres LOOK (wheels(): radius and
//      width, front and rear; the physics wheel is only 0.34). The
//      hub is drawn where that tyre's bottom touches the road, and
//      the fenders cut their arches round it (FenderSpec.gap).
//    - the physics box is x +/-0.88, y -0.24..0.56, z +/-2.0. The
//      body covers it, so what you see is what you hit. Wings, fins,
//      fenders and canopies may stick out of it.
//    - over a wheel (within its arch along z) the tub's lower flank
//      stays inside the tyre's inner face (x 0.8 - width / 2), so the
//      tyre is never swallowed.
//    - a fender pod's top stays well above its tyre: the suspension
//      lifts the tyre into the pod on a bump, never out through it.
//    - each recipe says where its bonnet camera sits (bonnetAt) and
//      draws a neon line across its nose (noseLight): from the mount
//      the line sits about 30 deg below level, just inside the bottom
//      of the bonnet view (34 deg down at rest, more at speed), so the
//      view keeps a sliver of this car's own nose and its line.
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
  const yFloor = typeof f.yFloor === 'number' ? f.yFloor : flip(f.yFloor)
  return { ...f, zc: -f.zc, front: -f.back, back: -f.front, xOut: flip(f.xOut), yTop: flip(f.yTop), yFloor }
}

/**
 * Tub stations that close a body into a smooth dome: from the full section
 * `base` at z0 to a point at zTip, every width and height shrinking along a
 * rounded curve toward the nose's centre height `yc`. Ordered z0 -> zTip.
 */
function dome(base: number[], z0: number, zTip: number, yc: number): number[][] {
  const out: number[][] = []
  for (const t of [0, 0.35, 0.6, 0.78, 0.9, 0.97, 1]) {
    const e = Math.max(0.06, Math.sqrt(1 - Math.pow(t, 2.4)))
    const z = z0 + (zTip - z0) * t
    const [, yBot, wBot, yMid, wMid, ySh, wSh, yTop, wTop, yCrown] = base
    const y = (v: number) => yc + (v - yc) * e
    out.push([z, y(yBot), wBot * e, y(yMid), wMid * e, y(ySh), wSh * e, y(yTop), wTop * e, y(yCrown)])
  }
  return out
}

// ---------------------------------------------------------------- Dart: the all-rounder

/**
 * The poster car. Short blunt nose, a tall round bubble cab, big rear
 * haunches over bigger rear tyres (the hot-rod rake), a proud wing on
 * swan-neck struts and one big rocket.
 * Night lines: four arch outlines, the haunch shoulders, the waist, the
 * wing and the nose line.
 */
function dart(b: BodyBuilder): void {
  b.wheel = 'star'
  b.wheels({ r: 0.45, w: 0.4 }, { r: 0.48, w: 0.44 })
  b.tub(
    [
      // z     yBot   wBot  yMid   wMid  ySh   wSh   yTop  wTop  yCrown
      [2.0, -0.18, 0.44, 0.0, 0.56, 0.24, 0.6, 0.34, 0.5, 0.38],
      [1.9, -0.25, 0.48, 0.06, 0.56, 0.38, 0.62, 0.5, 0.54, 0.54],
      [1.68, -0.27, 0.5, 0.1, 0.55, 0.44, 0.64, 0.56, 0.58, 0.6],
      [1.3, -0.28, 0.5, 0.11, 0.55, 0.46, 0.66, 0.58, 0.6, 0.62],
      [0.91, -0.29, 0.52, 0.11, 0.55, 0.47, 0.7, 0.59, 0.62, 0.63],
      [0.78, -0.3, 0.66, -0.12, 0.84, 0.48, 0.85, 0.6, 0.66, 0.64],
      [0.0, -0.31, 0.68, -0.14, 0.86, 0.5, 0.86, 0.62, 0.68, 0.66],
      [-0.74, -0.31, 0.66, -0.12, 0.84, 0.52, 0.85, 0.64, 0.66, 0.68],
      [-0.89, -0.3, 0.52, 0.11, 0.55, 0.54, 0.74, 0.66, 0.62, 0.7],
      [-1.42, -0.29, 0.5, 0.12, 0.55, 0.56, 0.72, 0.68, 0.6, 0.71],
      [-1.86, -0.28, 0.5, 0.1, 0.55, 0.56, 0.72, 0.68, 0.6, 0.71],
      [-2.04, -0.22, 0.48, 0.0, 0.56, 0.52, 0.7, 0.64, 0.58, 0.67],
    ],
    // smooth across gentle bends (a clean bonnet, not a crumpled one), crisp at real edges
    { bulge: 0.04, crease: 0.9 },
  )
  // the front pods stand clear above the bonnet (never level with it: two surfaces
  // crossing at the same height is what made the old nose look dented)
  const front: FenderSpec = {
    zc: AXLE_Z,
    front: 2.05,
    back: 0.82,
    xIn: 0.42,
    xOut: [[0.82, 0.9], [1.05, 1.04], [1.42, 1.07], [1.78, 1.04], [2.05, 0.9]],
    yTop: [[0.82, 0.46], [1.02, 0.64], [1.42, 0.69], [1.76, 0.64], [2.05, 0.36]],
    yFloor: -0.27,
    round: 0.13,
    lean: 0.02,
    crease: 0.9,
  }
  // big haunches over the bigger rear tyres, well above the rear deck
  const rear: FenderSpec = {
    zc: -AXLE_Z,
    front: -0.78,
    back: -2.05,
    xIn: 0.42,
    xOut: [[-2.05, 1.0], [-1.86, 1.1], [-1.42, 1.12], [-0.98, 1.06], [-0.78, 0.9]],
    yTop: [[-2.05, 0.72], [-1.6, 0.82], [-1.2, 0.8], [-0.94, 0.7], [-0.78, 0.52]],
    yFloor: -0.27,
    round: 0.16,
    lean: 0.03,
    crease: 0.9,
  }
  b.fender(front).fender(rear)
  b.rocker(0.82, -0.78, -0.08, 0.87)
  b.canopy(
    [
      [1.12, 0.57, 0.58, 0.62, 0.54],
      [0.8, 0.59, 0.68, 0.96, 0.56],
      [0.25, 0.61, 0.7, 1.17, 0.52],
      [-0.4, 0.63, 0.7, 1.19, 0.52],
      [-0.95, 0.65, 0.68, 1.04, 0.56],
      [-1.35, 0.67, 0.62, 0.74, 0.6],
    ],
    { bulge: 0.1 },
  )
  // the big rear wing on swan-neck struts, endplates in the accent colour
  const wing: WingSpec = { span: 0.92, z: -1.62, y: 1.22, chord: 0.46, thick: 0.075, angle: 0.15, sweep: 0.06, dihedral: 0.03, accent: true }
  b.wing(wing)
  b.paint(plateSide([[-1.54, 1.08], [-2.16, 1.1], [-2.18, 1.4], [-1.74, 1.35]], 0.04, 0.93), { accent: true, mirror: true })
  b.paint(plateSide([[-1.56, 0.66], [-1.82, 0.66], [-1.88, 1.24], [-1.72, 1.24]], 0.045, 0.42), { mirror: true })
  // one big rocket
  b.nozzle({ x: 0, y: 0.2, z: -2.04, r: 0.2, len: 0.17, flame: 4.2 })
  // lights: angular eyes across the nose and pods, hooked tail lamps on the haunches
  b.light(plateFront([[0.46, 0.25], [0.8, 0.18], [0.8, 0.1], [0.52, 0.15]], 0.03, 2.065, 1), 'head', { mirror: true })
  b.headAt(0.66, 0.19, 2.07)
  b.light(plateFront([[0.5, 0.62], [0.96, 0.62], [0.96, 0.3], [0.89, 0.3], [0.89, 0.55], [0.5, 0.55]], 0.03, -2.065, -1), 'tail', { mirror: true })
  b.tailAt(0.92, 0.46, -2.08)
  // trim: splitter, nose intake, bonnet vents, side scoops, diffuser
  b.trim(rbox(1.62, 0.035, 0.24, 0, -0.275, 1.98, 0.012))
  b.trim(plateFront([[-0.36, -0.16], [0.36, -0.16], [0.3, 0.08], [-0.3, 0.08]], 0.02, 2.005, 1))
  for (const x of [-0.16, 0, 0.16]) b.trim(rbox(0.09, 0.02, 0.24, x, 0.618, 1.4, 0.008, -0.03))
  b.trim(plateSide([[-0.56, 0.08], [-0.76, 0.06], [-0.76, 0.34], [-0.62, 0.3]], 0.03, 0.865), { mirror: true })
  b.trim(rbox(1.0, 0.14, 0.2, 0, -0.2, -1.97, 0.02))
  b.wells(0.55)
  // night signature
  b.archLight(front).archLight(rear)
  b.podLight(rear, -0.82, -1.98)
  b.tubStrip(3, 0.78, -0.74, 0.028)
  b.wingLight(wing)
  b.noseLight(1.88)
  b.bonnetAt(0.96, 1.27)
}

// ---------------------------------------------------------------- Blade: the wedge

/**
 * Long, low-slung and sharp: a wedge rising from pointed front pontoons
 * to a high tail over big rear tyres, a fighter canopy sunk into it, twin
 * raked fins and twin rockets.
 * Night lines: one knife-crease down each side, the fin edges, the nose line.
 */
function blade(b: BodyBuilder): void {
  b.wheel = 'turbine'
  b.wheels({ r: 0.42, w: 0.38 }, { r: 0.48, w: 0.46 })
  b.tub(
    [
      [2.08, -0.2, 0.34, -0.15, 0.46, 0.02, 0.5, 0.14, 0.38, 0.17],
      [1.97, -0.25, 0.42, -0.08, 0.52, 0.26, 0.6, 0.38, 0.48, 0.42],
      [1.8, -0.27, 0.46, -0.02, 0.54, 0.4, 0.66, 0.52, 0.52, 0.56],
      [1.45, -0.29, 0.5, 0.06, 0.55, 0.43, 0.72, 0.56, 0.58, 0.6],
      [0.94, -0.3, 0.52, 0.1, 0.55, 0.46, 0.76, 0.58, 0.62, 0.62],
      [0.8, -0.31, 0.66, -0.1, 0.86, 0.46, 0.86, 0.58, 0.66, 0.63],
      [0.0, -0.32, 0.68, -0.12, 0.87, 0.5, 0.87, 0.62, 0.68, 0.67],
      [-0.74, -0.32, 0.66, -0.1, 0.86, 0.55, 0.86, 0.67, 0.7, 0.72],
      [-0.89, -0.31, 0.52, 0.12, 0.55, 0.58, 0.8, 0.7, 0.7, 0.75],
      [-1.42, -0.3, 0.5, 0.12, 0.55, 0.62, 0.8, 0.74, 0.72, 0.78],
      [-1.86, -0.29, 0.5, 0.1, 0.55, 0.64, 0.8, 0.76, 0.72, 0.8],
      [-2.04, -0.24, 0.48, 0.0, 0.56, 0.64, 0.78, 0.76, 0.72, 0.8],
    ],
    { bulge: 0 },
  )
  const front: FenderSpec = {
    zc: AXLE_Z,
    front: 2.14,
    back: 0.84,
    xIn: 0.42,
    xOut: [[0.84, 0.88], [1.1, 1.02], [1.42, 1.04], [1.8, 0.98], [2.16, 0.6]],
    yTop: [[0.84, 0.46], [1.1, 0.56], [1.42, 0.58], [1.8, 0.54], [2.16, 0.08]],
    yFloor: -0.28,
    round: 0.035,
    lean: -0.04,
  }
  const rear: FenderSpec = {
    zc: -AXLE_Z,
    front: -0.78,
    back: -2.04,
    xIn: 0.44,
    xOut: [[-2.04, 1.02], [-1.8, 1.08], [-1.42, 1.09], [-1.0, 1.04], [-0.78, 0.88]],
    yTop: [[-2.04, 0.76], [-1.42, 0.78], [-1.0, 0.7], [-0.78, 0.54]],
    yFloor: -0.28,
    round: 0.035,
    lean: -0.03,
  }
  b.fender(front).fender(rear)
  b.rocker(0.84, -0.78, 0.0, 0.88)
  b.canopy(
    [
      [0.95, 0.54, 0.36, 0.57, 0.3],
      [0.55, 0.57, 0.52, 0.8, 0.32],
      [-0.05, 0.6, 0.56, 0.95, 0.28],
      [-0.7, 0.65, 0.52, 0.93, 0.26],
      [-1.3, 0.7, 0.42, 0.83, 0.24],
      [-1.75, 0.74, 0.3, 0.78, 0.2],
    ],
    { bulge: 0.05 },
  )
  // twin fins, raked back and leaning out, in the accent colour, with neon leading and top edges
  const finAt = (g: THREE.BufferGeometry) => cant(g, -0.18, 0.72, 0.74)
  b.paint(finAt(plateSide([[-1.2, 0.72], [-2.04, 0.76], [-2.22, 1.24], [-1.98, 1.24]], 0.045, 0.72)), { accent: true, mirror: true })
  b.light(finAt(bar({ x: 0.72, y: 0.75, z: -1.24 }, { x: 0.72, y: 1.24, z: -1.97 }, 0.055, 0.03)), 'livery', { mirror: true })
  b.light(finAt(bar({ x: 0.72, y: 1.245, z: -1.97 }, { x: 0.72, y: 1.245, z: -2.22 }, 0.055, 0.03)), 'livery', { mirror: true })
  b.nozzle({ x: 0.36, y: 0.24, z: -2.04, r: 0.13, len: 0.15, mirror: true, flame: 3.8 })
  // lights: slits across the nose corners, a thin full-width tail bar with hooked ends
  b.light(plateFront([[0.16, 0.12], [0.46, 0.06], [0.46, 0.02], [0.2, 0.07]], 0.03, 2.095, 1), 'head', { mirror: true })
  b.headAt(0.32, 0.07, 2.1)
  b.light(plateFront([[-0.72, 0.72], [0.72, 0.72], [0.72, 0.68], [-0.72, 0.68]], 0.03, -2.055, -1), 'tail')
  b.light(plateFront([[0.82, 0.72], [0.96, 0.72], [0.96, 0.36], [0.82, 0.42]], 0.03, -2.055, -1), 'tail', { mirror: true })
  b.tailAt(0.9, 0.54, -2.06)
  // trim: a wide blade splitter, side blades ahead of the rear wheels, diffuser
  b.trim(rbox(1.74, 0.03, 0.32, 0, -0.28, 1.98, 0.01))
  b.trim(plateSide([[-0.2, 0.18], [-0.84, 0.24], [-0.84, 0.44], [-0.5, 0.36]], 0.03, 0.875), { mirror: true })
  b.trim(rbox(1.0, 0.14, 0.2, 0, -0.22, -1.97, 0.02))
  b.wells(0.55)
  // night signature: one knife-crease down each side (pontoon edge, waist, rear pod)
  b.podLight(front, 2.08, 0.88, 0.024)
  b.tubStrip(4, 0.8, -0.74, 0.024)
  b.podLight(rear, -0.82, -2.0, 0.024)
  b.noseLight(1.86, 0.016, 0.1)
  b.bonnetAt(0.92, 1.25)
}

// ---------------------------------------------------------------- Brick: the armoured truck

/**
 * A tall armoured box on big fat steel wheels: a flat bonnet, bull bar,
 * boxy flared arches, a roof light bar, twin rockets low in the back.
 * Night lines: arch outlines, the roof's edge, the light bar, the waist,
 * the nose line.
 */
function brick(b: BodyBuilder): void {
  b.wheel = 'steelie'
  b.wheels({ r: 0.48, w: 0.44 })
  b.tub(
    [
      [2.05, -0.24, 0.54, -0.05, 0.7, 0.36, 0.76, 0.52, 0.7, 0.54],
      [1.92, -0.28, 0.54, 0.05, 0.54, 0.46, 0.8, 0.62, 0.74, 0.64],
      [1.42, -0.29, 0.54, 0.12, 0.54, 0.48, 0.82, 0.64, 0.76, 0.66],
      [0.88, -0.3, 0.54, 0.12, 0.54, 0.49, 0.84, 0.65, 0.78, 0.67],
      [0.76, -0.3, 0.7, -0.1, 0.88, 0.5, 0.88, 0.66, 0.8, 0.68],
      [0.0, -0.3, 0.7, -0.1, 0.89, 0.51, 0.89, 0.66, 0.8, 0.68],
      [-0.76, -0.3, 0.7, -0.1, 0.88, 0.52, 0.88, 0.66, 0.8, 0.68],
      [-0.88, -0.3, 0.54, 0.12, 0.54, 0.52, 0.84, 0.66, 0.8, 0.68],
      [-1.42, -0.29, 0.54, 0.12, 0.54, 0.52, 0.84, 0.66, 0.8, 0.68],
      [-1.92, -0.28, 0.54, 0.1, 0.54, 0.52, 0.84, 0.66, 0.8, 0.68],
      [-2.03, -0.24, 0.54, 0.0, 0.62, 0.5, 0.82, 0.66, 0.78, 0.68],
    ],
    { bulge: 0.01 },
  )
  const front: FenderSpec = {
    zc: AXLE_Z,
    front: 2.06,
    back: 0.78,
    xIn: 0.5,
    xOut: [[0.78, 0.94], [0.95, 1.08], [1.9, 1.08], [2.06, 0.98]],
    yTop: [[0.78, 0.56], [0.95, 0.66], [1.9, 0.66], [2.06, 0.58]],
    yFloor: -0.27,
    round: 0.04,
    lean: 0,
  }
  const rear: FenderSpec = {
    zc: -AXLE_Z,
    front: -0.78,
    back: -2.03,
    xIn: 0.5,
    xOut: [[-2.03, 1.02], [-1.9, 1.1], [-0.95, 1.1], [-0.78, 0.94]],
    yTop: [[-2.03, 0.66], [-1.9, 0.7], [-0.95, 0.7], [-0.78, 0.6]],
    yFloor: -0.27,
    round: 0.04,
    lean: 0,
  }
  b.fender(front).fender(rear)
  b.rocker(0.78, -0.78, 0.02, 0.9)
  // a boxy greenhouse with a near-upright screen, under an armoured roof slab
  b.canopy(
    [
      [1.14, 0.62, 0.74, 0.66, 0.72],
      [1.0, 0.64, 0.76, 1.1, 0.7],
      [0.6, 0.66, 0.78, 1.14, 0.72],
      [-0.9, 0.66, 0.78, 1.14, 0.72],
      [-1.55, 0.66, 0.78, 1.12, 0.72],
      [-1.75, 0.66, 0.76, 0.72, 0.72],
    ],
    { bulge: 0.01 },
  )
  b.paint(rbox(1.56, 0.1, 2.5, 0, 1.16, -0.35, 0.04))
  b.paint(rbox(1.6, 0.44, 0.12, 0, 0.9, -0.25, 0.02))
  b.paint(rbox(0.06, 0.06, 2.3, 0.6, 1.24, -0.35, 0.012), { accent: true, mirror: true })
  // bull bar, bumpers, side steps (dark chrome)
  for (const x of [0.3, -0.3]) b.trim(tube({ x, y: -0.2, z: 2.18 }, { x, y: 0.5, z: 2.18 }, 0.036), { metal: true })
  b.trim(tube({ x: -0.48, y: 0.5, z: 2.18 }, { x: 0.48, y: 0.5, z: 2.18 }, 0.036), { metal: true })
  b.trim(tube({ x: -0.8, y: -0.06, z: 2.17 }, { x: 0.8, y: -0.06, z: 2.17 }, 0.034), { metal: true })
  b.trim(rbox(1.86, 0.2, 0.18, 0, -0.16, 2.08, 0.03))
  b.trim(rbox(1.84, 0.18, 0.16, 0, -0.18, -2.05, 0.03))
  b.trim(rbox(0.14, 0.05, 1.5, 0.92, -0.27, 0, 0.012), { metal: true, mirror: true })
  b.trim(plateFront([[-0.44, 0.04], [0.44, 0.04], [0.44, 0.42], [-0.44, 0.42]], 0.02, 2.055, 1))
  for (const x of [-0.3, -0.15, 0, 0.15, 0.3]) b.trim(rbox(0.05, 0.32, 0.03, x, 0.23, 2.07, 0.01), { metal: true })
  b.nozzle({ x: 0.36, y: 0.08, z: -2.03, r: 0.13, len: 0.12, mirror: true, flame: 3.6 })
  // lights: square lamps, a roof light bar, tall tail stacks
  b.light(plateFront([[0.52, 0.16], [0.74, 0.16], [0.74, 0.4], [0.52, 0.4]], 0.03, 2.07, 1), 'head', { mirror: true })
  b.light(rbox(1.1, 0.05, 0.06, 0, 1.24, 0.8, 0.012), 'head')
  b.headAt(0.63, 0.28, 2.08)
  b.light(plateFront([[0.8, 0.16], [0.93, 0.16], [0.93, 0.6], [0.8, 0.6]], 0.03, -2.045, -1), 'tail', { mirror: true })
  b.tailAt(0.86, 0.38, -2.06)
  b.wells(0.54)
  // night signature: the arches, the roof slab's edge, the waist
  b.archLight(front, 0.04, 0.96).archLight(rear, 0.04, 0.96)
  b.light(bar({ x: 0.786, y: 1.16, z: 0.88 }, { x: 0.786, y: 1.16, z: -1.58 }, 0.012, 0.03), 'livery', { mirror: true })
  b.tubStrip(3, 0.76, -0.76, 0.032)
  b.noseLight(1.96, 0.018, 0.08)
  b.bonnetAt(0.97, 1.45)
}

// ---------------------------------------------------------------- Manta: the ray

/**
 * Wide and flat like a ray: two horn pods reaching past the nose, wide
 * wing-tip pods at the back, a raised spine with a small canopy set far
 * back, a T-tail fin and three rockets.
 * Night lines: the ray's outline down both pods, the T-tail, the fin,
 * the nose line.
 */
function manta(b: BodyBuilder): void {
  b.wheel = 'aero'
  b.wheels({ r: 0.43, w: 0.4 }, { r: 0.46, w: 0.44 })
  b.tub(
    [
      [2.02, -0.2, 0.38, -0.12, 0.48, 0.16, 0.54, 0.32, 0.44, 0.36],
      [1.86, -0.27, 0.44, -0.04, 0.5, 0.36, 0.6, 0.52, 0.5, 0.57],
      [1.42, -0.29, 0.48, 0.08, 0.54, 0.4, 0.68, 0.54, 0.58, 0.6],
      [0.93, -0.3, 0.52, 0.1, 0.55, 0.4, 0.74, 0.54, 0.62, 0.6],
      [0.8, -0.3, 0.66, -0.1, 0.86, 0.4, 0.88, 0.52, 0.72, 0.6],
      [0.0, -0.31, 0.68, -0.12, 0.88, 0.4, 0.9, 0.52, 0.72, 0.6],
      [-0.78, -0.31, 0.66, -0.1, 0.86, 0.4, 0.88, 0.52, 0.72, 0.6],
      [-0.91, -0.3, 0.52, 0.1, 0.55, 0.42, 0.76, 0.54, 0.66, 0.6],
      [-1.42, -0.29, 0.5, 0.1, 0.55, 0.42, 0.76, 0.54, 0.66, 0.6],
      [-1.86, -0.28, 0.5, 0.06, 0.55, 0.42, 0.74, 0.54, 0.64, 0.59],
      [-2.04, -0.22, 0.46, -0.02, 0.54, 0.38, 0.7, 0.5, 0.6, 0.55],
    ],
    { bulge: 0.03 },
  )
  const front: FenderSpec = {
    zc: AXLE_Z,
    front: 2.18,
    back: 0.8,
    xIn: 0.4,
    xOut: [[0.8, 0.92], [1.05, 1.1], [1.42, 1.12], [1.85, 1.08], [2.18, 0.9]],
    yTop: [[0.8, 0.48], [1.1, 0.56], [1.42, 0.58], [1.9, 0.52], [2.18, 0.16]],
    yFloor: -0.27,
    round: 0.14,
    lean: 0.05,
  }
  const rear: FenderSpec = {
    zc: -AXLE_Z,
    front: -0.78,
    back: -2.2,
    xIn: 0.4,
    xOut: [[-2.2, 1.04], [-1.85, 1.12], [-1.42, 1.14], [-1.0, 1.1], [-0.78, 0.92]],
    yTop: [[-2.2, 0.46], [-1.85, 0.58], [-1.42, 0.62], [-1.0, 0.58], [-0.78, 0.5]],
    yFloor: -0.26,
    round: 0.14,
    lean: 0.05,
  }
  b.fender(front).fender(rear)
  b.rocker(0.8, -0.78, 0.02, 0.89)
  b.canopy(
    [
      [0.2, 0.56, 0.36, 0.59, 0.3],
      [-0.15, 0.58, 0.46, 0.8, 0.32],
      [-0.65, 0.6, 0.48, 0.84, 0.3],
      [-1.15, 0.6, 0.42, 0.78, 0.26],
      [-1.55, 0.6, 0.3, 0.64, 0.2],
    ],
    { bulge: 0.06 },
  )
  // the T-tail: one dorsal fin carrying a swept blade, both in the accent colour
  b.paint(plateSide([[-1.0, 0.6], [-1.95, 0.6], [-2.12, 1.06], [-1.84, 1.06]], 0.05, 0), { accent: true })
  const tail: WingSpec = { span: 0.8, z: -1.8, y: 1.05, chord: 0.34, thick: 0.045, angle: 0.02, sweep: 0.14, dihedral: -0.05, accent: true }
  b.wing(tail)
  // three rockets in a row
  b.nozzle({ x: 0, y: 0.14, z: -2.04, r: 0.14, len: 0.15, flame: 4.0 })
  b.nozzle({ x: 0.36, y: 0.12, z: -2.04, r: 0.1, len: 0.12, mirror: true, flame: 3.0 })
  // lights: one wide slit across the nose, lamps in the horn tips, a wide tail bar
  b.light(plateFront([[-0.42, 0.22], [0.42, 0.22], [0.38, 0.17], [-0.38, 0.17]], 0.03, 2.015, 1), 'head')
  b.light(plateFront([[0.5, 0.06], [0.8, 0.06], [0.8, 0.01], [0.5, 0.01]], 0.03, 2.195, 1), 'head', { mirror: true })
  b.headAt(0.62, 0.04, 2.2)
  b.light(plateFront([[-0.58, 0.44], [0.58, 0.44], [0.58, 0.4], [-0.58, 0.4]], 0.03, -2.055, -1), 'tail')
  b.light(plateFront([[0.62, 0.34], [0.96, 0.34], [0.96, 0.28], [0.62, 0.28]], 0.03, -2.215, -1), 'tail', { mirror: true })
  b.tailAt(0.8, 0.31, -2.22)
  b.trim(rbox(1.0, 0.03, 0.26, 0, -0.25, 1.9, 0.01))
  b.trim(rbox(1.2, 0.12, 0.2, 0, -0.22, -1.97, 0.02))
  b.wells(0.55)
  // night signature: the ray's outline, the T-tail and the fin's top
  b.podLight(front, 2.12, 0.84, 0.026, 0.02)
  b.podLight(rear, -0.82, -2.16, 0.026, 0.02)
  b.wingLight(tail)
  b.light(bar({ x: 0, y: 0.62, z: -1.02 }, { x: 0, y: 1.04, z: -1.85 }, 0.06, 0.025), 'livery')
  b.noseLight(1.84, 0.016, 0.1)
  b.underglow = { halfWidth: 0.76, halfLength: 1.72, y: -0.42 }
  b.bonnetAt(0.88, 1.4)
}

// ---------------------------------------------------------------- Pulse: the bubble pod

/**
 * A tiny round pod: a huge bubble canopy on four round humps over four
 * fat round tyres, frog-eye lamps, a whip antenna and one big round rocket.
 * Night lines: a visor ring round the bubble, the four arches, the antenna
 * tip, the nose line.
 */
function pulse(b: BodyBuilder): void {
  b.wheel = 'pod'
  b.wheels({ r: 0.47, w: 0.42 })
  // The middle is authored; the nose and tail are worked out as smooth domes
  // from it (an ellipse in side and plan view), so the pebble has no lumps.
  const mid: number[][] = [
    [0.93, -0.3, 0.52, 0.1, 0.55, 0.4, 0.76, 0.54, 0.62, 0.6],
    [0.8, -0.3, 0.64, -0.06, 0.84, 0.4, 0.85, 0.54, 0.64, 0.6],
    [0.0, -0.31, 0.66, -0.08, 0.86, 0.42, 0.86, 0.56, 0.66, 0.62],
    [-0.8, -0.3, 0.64, -0.06, 0.84, 0.4, 0.85, 0.54, 0.64, 0.6],
    [-0.93, -0.3, 0.52, 0.1, 0.55, 0.4, 0.76, 0.54, 0.62, 0.6],
  ]
  const end: number[] = [1.42, -0.29, 0.5, 0.1, 0.55, 0.4, 0.72, 0.54, 0.6, 0.6]
  b.tub(
    [...dome(end, 1.42, 2.09, 0.22).reverse(), ...mid, ...dome(end, -1.42, -2.09, 0.22)],
    // a wide smoothing angle: a pebble, not a cut gem
    { bulge: 0.18, sub: 2, crease: 1.15 },
  )
  const pod: FenderSpec = {
    zc: AXLE_Z,
    front: 2.04,
    back: 0.82,
    xIn: 0.42,
    xOut: [[0.82, 0.8], [1.02, 1.04], [1.42, 1.09], [1.82, 1.04], [2.04, 0.78]],
    yTop: [[0.82, 0.08], [0.98, 0.52], [1.42, 0.7], [1.86, 0.52], [2.04, 0.12]],
    // the hump closes up over the tyre's front and back: round, like a pebble
    yFloor: [[0.82, -0.04], [0.9, -0.07], [1.94, -0.07], [2.04, 0.0]],
    round: 0.2,
    lean: 0.0,
    crease: 1.0,
  }
  const podR = flipFender(pod)
  b.fender(pod).fender(podR)
  b.rocker(0.88, -0.88, 0.0, 0.87)
  b.canopy(
    [
      [1.55, 0.54, 0.5, 0.58, 0.44],
      [1.2, 0.56, 0.74, 0.94, 0.6],
      [0.55, 0.58, 0.82, 1.2, 0.56],
      [-0.25, 0.59, 0.82, 1.24, 0.56],
      [-0.95, 0.58, 0.78, 1.04, 0.6],
      [-1.5, 0.56, 0.62, 0.64, 0.54],
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
  b.paint(lathe(eyePod, 16, { x: 0.74, y: 0.54, z: 1.9 }), { mirror: true, shading: 0.8 })
  const eye = new THREE.CircleGeometry(0.072, 16)
  eye.translate(0.74, 0.54, 1.906)
  b.light(eye, 'head', { mirror: true })
  b.headAt(0.74, 0.54, 1.92)
  // whip antenna with a glowing tip
  b.trim(tube({ x: -0.44, y: 0.86, z: -1.15 }, { x: -0.52, y: 1.52, z: -1.4 }, 0.012, 6), { metal: true })
  const tip = new THREE.SphereGeometry(0.05, 10, 8)
  tip.translate(-0.52, 1.54, -1.41)
  b.light(tip, 'livery')
  // one big round rocket and round tail lamps
  b.nozzle({ x: 0, y: 0.14, z: -2.03, r: 0.21, len: 0.17, flame: 4.2 })
  const lamp = new THREE.CircleGeometry(0.08, 16)
  lamp.rotateY(Math.PI)
  lamp.translate(0.64, 0.2, -2.045)
  b.light(lamp, 'tail', { mirror: true })
  b.tailAt(0.64, 0.2, -2.06)
  b.wells(0.55)
  // night signature: a visor ring round the bubble and the four round arches
  b.canopyLight(1.4, -1.4, 0.5)
  // the pulse: a ring of light round the big rocket
  const halo = new THREE.TorusGeometry(0.245, 0.014, 4, 32)
  halo.translate(0, 0.14, -2.035)
  b.light(halo, 'livery')
  b.archLight(pod, 0.08, 0.92).archLight(podR, 0.08, 0.92)
  b.noseLight(1.8, 0.016, 0.12)
  b.underglow = { halfWidth: 0.7, halfLength: 1.62, y: -0.4 }
  b.bonnetAt(0.91, 1.4)
}

export const RECIPES: Record<BodyId, (b: BodyBuilder) => void> = { dart, blade, brick, manta, pulse }
