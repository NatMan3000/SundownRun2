// ============================================================
//  BODY BUILDER - turns a car's recipe (profiles.ts) into geometry
// ------------------------------------------------------------
//  Each body becomes four geometries, built once per body and
//  cached for the session (cycling the garage is instant):
//
//    paint   tub, fender pods, wings, fins - everything painted.
//            `aAccent` per vertex: 0 the player's paint, 1 the
//            contrast accent (a deep shade of their glow colour)
//    glass   the canopy
//    trim    splitters, intakes, wheel wells, nozzles, bars.
//            `aMetal` per vertex: 0 matte black, 1 dark chrome
//    lights  every glowing part in ONE mesh. `aLight` per vertex
//            picks the colour in the shader (carModel.ts):
//              0 livery strips, 1 headlights, 2 tail lights,
//              3 rocket nozzle core, 4 rocket flame
//            `aFlame` (0 at the nozzle, the flame's full length in
//            metres at its tip) lets the shader stretch the flame
//            backward while boosting, so the set stays one draw call
//
//  Wheels are shared by every car with the same rim style: tyre
//  with sidewall and tread lugs, a designed rim, and a glowing ring
//  (`aGlow`) - see wheelGeometry() at the bottom.
//
//  How a car is made (the RECIPE in profiles.ts calls these):
//    tub       the main body, lofted from cross-sections nose to tail
//    fender    a chunky pod over a wheel, with the arch cut out of it
//    canopy    the glass bubble
//    wing      an aerofoil across the car
//    nozzle    a rocket bell with a glowing core and a flame
//    paint / trim / glass / light   any other part, from bodies/kit.ts
// ============================================================

import * as THREE from 'three'
import type { BodyId } from './catalog'
import { RECIPES } from './profiles'
import { AXLE_Z, bar, curve, densify, HUB_Y, lathe, loft, mirroredRing, PartList, plateSide, ringXY, roundHalf, steps } from './kit'
import type { Shading, V2 } from './kit'

/** The tyre as drawn: radius (the physics wheel is 0.34) and width. */
export const WHEEL_VIS = { radius: 0.35, width: 0.34 }

export type WheelStyle = 'star' | 'turbine' | 'steelie' | 'aero' | 'pod'

export interface BodyGeometry {
  paint: THREE.BufferGeometry
  glass: THREE.BufferGeometry
  trim: THREE.BufferGeometry
  lights: THREE.BufferGeometry
  /** Light anchor points in car space, for fx. */
  tailLights: THREE.Vector3[]
  headLights: THREE.Vector3[]
  /** Underside half extents and height, for the underglow. */
  underglow: { halfWidth: number; halfLength: number; y: number }
  /** Which rim this car rolls on. */
  wheel: WheelStyle
  /** Bonnet camera mount, car space. */
  bonnet: THREE.Vector3
  /** Triangles in the four body geometries (wheels not included). */
  triangles: number
}

// ---------------------------------------------------------------- recipe pieces

/**
 * A tub station is ten numbers, one half of the cross-section (mirrored
 * to make the other side):
 *   [ z,  yBot, wBot,  yMid, wMid,  ySh, wSh,  yTop, wTop,  yCrown ]
 *     z            where along the car
 *     yBot / wBot  underside height and half-width
 *     yMid / wMid  lower flank (tucked in over the wheels)
 *     ySh  / wSh   the shoulder
 *     yTop / wTop  the deck edge
 *     yCrown       height on the centre line
 */
export type TubStation = number[]

/** A canopy station is five numbers: [ z, yBase, wBase, yTop, wTop ]. */
export type CanopyStation = number[]

export interface FenderSpec {
  /** Wheel centre z: AXLE_Z or -AXLE_Z. */
  zc: number
  /** Front and back ends of the pod (front > back). */
  front: number
  back: number
  /** Inner edge, buried in the tub. */
  xIn: number
  /** Outer edge along the pod: keyframes [z, x]. */
  xOut: V2[]
  /** Top height along the pod: keyframes [z, y]. */
  yTop: V2[]
  /** Bottom height away from the arch (the sill). */
  yFloor: number
  /** Arch radius (the tyre is 0.35). */
  archR: number
  /** Size of the rounded outer-top edge. */
  round: number
  /** How far the top face leans in toward the car (0 flat, 0.1 sloping). */
  lean?: number
  accent?: boolean
}

export interface WingSpec {
  /** Half span (tip x). */
  span: number
  /** Leading edge z and height at the centre. */
  z: number
  y: number
  chord: number
  thick: number
  /** Angle of attack, radians (+ = trailing edge up). */
  angle: number
  /** Tip leading edge moves this far back (- z) relative to the centre. */
  sweep?: number
  /** Tips rise (or fall) this much. */
  dihedral?: number
  accent?: boolean
}

export interface NozzleSpec {
  x: number
  y: number
  /** The face the nozzle is mounted on. */
  z: number
  /** Exit radius. */
  r: number
  /** How far the bell sticks out behind the face. */
  len: number
  /** Also put one at -x. */
  mirror?: boolean
  /** Squash into an oval (1 round). */
  scaleY?: number
  /** How long the flame gets at full boost, metres. */
  flame?: number
}

const LIGHT_LIVERY = 0
const LIGHT_HEAD = 1
const LIGHT_TAIL = 2
const LIGHT_NOZZLE = 3
const LIGHT_FLAME = 4
export const LIGHT_KIND = { livery: LIGHT_LIVERY, head: LIGHT_HEAD, tail: LIGHT_TAIL } as const
export type LightKind = keyof typeof LIGHT_KIND

/** Crease angles: panels meeting at less than this are smoothed together; sharper meets stay a crisp line. */
const PAINT_CREASE = 0.62 // ~35 deg: rounded, toy-like panels, crisp at real edges
const GLASS_CREASE = 0.8
/** Flames are drawn at rest this long (hidden behind the core), then stretched by the shader. */
export const FLAME_REST = 0.01

/** Half cross-section of a tub station, bottom centre -> top centre. */
function tubHalf(st: TubStation): V2[] {
  const [, yBot, wBot, yMid, wMid, ySh, wSh, yTop, wTop, yCrown] = st
  return [
    [0, yBot],
    [wBot, yBot],
    [wMid, yMid],
    [wSh, ySh],
    [wTop, yTop],
    [0, yCrown],
  ]
}

/** Half cross-section of a canopy station (a faceted bubble). */
function canopyHalf(st: CanopyStation): V2[] {
  const [, yBase, wBase, yTop, wTop] = st
  const midX = wBase + (wTop - wBase) * 0.35 + 0.02
  const midY = yBase + (yTop - yBase) * 0.6
  return [
    [0, yBase - 0.14],
    [wBase, yBase],
    [midX, midY],
    [wTop, yTop - 0.035],
    [0, yTop],
  ]
}

/** Aerofoil outline: [along the chord 0..1 backward, up in thicknesses]. */
const AEROFOIL: V2[] = [
  [0, 0],
  [0.05, 0.6],
  [0.28, 1],
  [0.7, 0.72],
  [1, 0.14],
  [1, -0.06],
  [0.68, -0.3],
  [0.26, -0.48],
  [0.05, -0.38],
]

// ---------------------------------------------------------------- the builder

/** What a recipe uses to make a car. */
export class BodyBuilder {
  readonly paintParts = new PartList(['aAccent'])
  readonly glassParts = new PartList()
  readonly trimParts = new PartList(['aMetal'])
  readonly lightParts = new PartList(['aLight', 'aFlame'])
  headLights: THREE.Vector3[] = []
  tailLights: THREE.Vector3[] = []
  underglow = { halfWidth: 0.72, halfLength: 1.72, y: -0.42 }
  wheel: WheelStyle = 'star'
  /** Bonnet camera mount (car space): on the bonnet, by the windscreen base. */
  bonnet = new THREE.Vector3(0, 0.5, 1.55)
  private tubDense: number[][] | null = null
  private canopyDense: number[][] | null = null
  private canopyBulge = 0.07

  // ---- painted parts

  /** The main body, lofted nose to tail through the stations (smoothed between them). */
  tub(stations: TubStation[], opts: { bulge?: number; sub?: number; accent?: boolean } = {}): this {
    // z, underside and lower flank go in straight lines between stations, so they never bulge into a tyre
    const dense = densify(stations, opts.sub ?? 3, [0, 1, 2, 3, 4])
    this.tubDense = dense
    const bulge = opts.bulge ?? 0.04
    const rings = dense.map((st) => {
      const half = tubHalf(st)
      const cy = (half[0][1] + half[half.length - 1][1]) / 2
      return mirroredRing(roundHalf(half, bulge, cy), st[0])
    })
    return this.paint(loft(rings), { accent: opts.accent, shading: PAINT_CREASE })
  }

  /** A point on the tub's surface (index into the station: 1 bottom edge .. 4 deck edge) at any z. */
  tubPoint(pi: number, z: number, out = new THREE.Vector2()): THREE.Vector2 {
    const h = this.tubDense
    if (!h) return out.set(0, 0)
    for (let i = 0; i < h.length - 1; i++) {
      const a = h[i]
      const b = h[i + 1]
      if ((z <= a[0] && z >= b[0]) || i === h.length - 2) {
        const t = a[0] === b[0] ? 0 : THREE.MathUtils.clamp((a[0] - z) / (a[0] - b[0]), 0, 1)
        const pa = tubHalf(a)[pi]
        const pb = tubHalf(b)[pi]
        return out.set(pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t)
      }
    }
    return out
  }

  /**
   * A fender pod over one wheel, both sides of the car. The arch is cut out of
   * its underside as a circle round the hub, so the whole tyre shows.
   */
  fender(f: FenderSpec): this {
    const zs = new Set<number>()
    for (const z of steps(f.back, f.front, 12)) zs.add(Math.round(z * 1000) / 1000)
    for (let k = 0; k <= 12; k++) {
      const z = f.zc + f.archR * Math.cos((k / 12) * Math.PI)
      if (z > f.back && z < f.front) zs.add(Math.round(z * 1000) / 1000)
    }
    // just outside the arch: the legs drop straight to the sill
    for (const s of [-1, 1]) {
      const z = f.zc + s * (f.archR + 0.003)
      if (z > f.back && z < f.front) zs.add(Math.round(z * 1000) / 1000)
    }
    const sorted = [...zs].sort((a, b) => b - a)
    const lean = f.lean ?? 0.04
    const rings = sorted.map((z) => {
      const dz = z - f.zc
      const yArch = Math.abs(dz) < f.archR ? HUB_Y + Math.sqrt(f.archR * f.archR - dz * dz) : f.yFloor
      const yTop = curve(f.yTop, z)
      const xOut = curve(f.xOut, z)
      const yBot = Math.min(yArch, yTop - 0.05)
      const r = Math.max(0.01, Math.min(f.round, (yTop - yBot) * 0.45, (xOut - f.xIn) * 0.4))
      const pts: V2[] = [
        [f.xIn, yBot],
        [xOut - 0.02, yBot],
        [xOut, yBot + 0.03],
        [xOut, yTop - r],
        [xOut - r * 0.29, yTop - r * 0.29],
        [xOut - r, yTop],
        [f.xIn, yTop + lean],
      ]
      return ringXY(pts, z)
    })
    return this.paint(loft(rings), { accent: f.accent, mirror: true, shading: PAINT_CREASE })
  }

  /** The glass canopy, lofted like the tub. */
  canopy(stations: CanopyStation[], opts: { bulge?: number; sub?: number } = {}): this {
    const dense = densify(stations, opts.sub ?? 4)
    this.canopyDense = dense
    const bulge = opts.bulge ?? 0.07
    this.canopyBulge = bulge
    const rings = dense.map((st) => {
      const half = canopyHalf(st)
      const cy = (half[0][1] + half[half.length - 1][1]) / 2
      return mirroredRing(roundHalf(half, bulge, cy), st[0])
    })
    this.glassParts.add(loft(rings), { shading: GLASS_CREASE })
    return this
  }

  /** An aerofoil wing across the car (lofted tip to tip). */
  wing(w: WingSpec): this {
    const rings: THREE.Vector3[][] = []
    for (const x of steps(-w.span, w.span, 4)) {
      const tip = Math.abs(x) / w.span
      const zLE = w.z - (w.sweep ?? 0) * tip
      const yLE = w.y + (w.dihedral ?? 0) * tip
      const c = Math.cos(w.angle)
      const s = Math.sin(w.angle)
      rings.push(
        AEROFOIL.map(([u, v]) => {
          const dz = -u * w.chord
          const dy = v * w.thick
          return new THREE.Vector3(x, yLE - dz * s + dy * c, zLE + dz * c + dy * s)
        }),
      )
    }
    return this.paint(loft(rings), { accent: w.accent, shading: 0.9 })
  }

  /**
   * A rocket nozzle: a dark chrome bell, a glowing core inside its throat, and
   * a flame the shader stretches backward while boosting.
   */
  nozzle(n: NozzleSpec): this {
    const sy = n.scaleY ?? 1
    const flameLen = n.flame ?? 0.8
    const sides = n.mirror ? [1, -1] : [1]
    for (const side of sides) {
      const at = { x: n.x * side, y: n.y, z: n.z }
      const r = n.r
      const L = n.len
      // bell: a collar on the body, outer skin backward, round the lip, inner skin forward to the throat
      const bell: V2[] = [
        [r * 0.84, -0.05],
        [r * 1.04, -0.01],
        [r * 0.9, 0.03],
        [r * 0.92, L * 0.4],
        [r * 1.1, L],
        [r * 1.03, L + 0.012],
        [r * 0.9, L * 0.9],
        [r * 0.6, L * 0.3],
        [r * 0.54, L * 0.12],
      ]
      this.trim(lathe(bell, 22, at, sy), { metal: true, shading: 1.0 })
      // the glowing core across the throat
      const coreZ = n.z - L * 0.12 - 0.002
      const core = new THREE.CircleGeometry(r * 0.56, 20)
      core.rotateY(Math.PI) // face backward (-z)
      core.scale(1, sy, 1)
      core.translate(at.x, at.y, coreZ)
      this.lightParts.add(core, { attrs: { aLight: LIGHT_NOZZLE }, shading: 'flat' })
      // the flame: a plume lathed at rest to FLAME_REST long, just inside the core (hidden until boost)
      const base = coreZ + 0.016
      const plume: V2[] = [
        [0.0, 0],
        [r * 0.5, 0],
        [r * 0.5, 0.3],
        [r * 0.26, 0.7],
        [0.0, 1],
      ]
      const flame = lathe(
        plume.map(([pr, a]) => [pr, a * FLAME_REST] as V2),
        14,
        { x: at.x, y: at.y, z: base },
        sy,
      )
      this.lightParts.add(flame, {
        // aFlame = how far back this point travels at full boost (0 at the nozzle, the flame's length at the tip)
        attrs: { aLight: LIGHT_FLAME, aFlame: (_x, _y, z) => THREE.MathUtils.clamp((base - z) / FLAME_REST, 0, 1) * flameLen },
        shading: 'flat',
      })
    }
    return this
  }

  /** Dark wheel wells: a plate inboard of each tyre so the arches read deep, not see-through. */
  wells(x = 0.56, archR = 0.44): this {
    for (const zc of [AXLE_Z, -AXLE_Z]) {
      const pts: V2[] = []
      for (let k = 0; k <= 14; k++) {
        const a = (k / 14) * Math.PI
        pts.push([zc + archR * Math.cos(a), HUB_Y + archR * Math.sin(a)])
      }
      pts.push([zc - archR, -0.3], [zc + archR, -0.3])
      // drawn with z flipped, then stood up facing outward (+x)
      const shape = new THREE.Shape(pts.map(([z, y]) => new THREE.Vector2(-z, y)))
      const g = new THREE.ShapeGeometry(shape, 4)
      g.rotateY(Math.PI / 2)
      g.translate(x, 0, 0)
      // a single-sided plate facing outward (+x); the mirror faces -x
      this.trim(g, { mirror: true, shading: 'flat' })
    }
    return this
  }

  /**
   * A dark rocker panel down each side between the wheels: the lower body goes
   * matte black, so the painted fender pods and upper body stand out from it.
   */
  rocker(front: number, back: number, yTop: number, x: number, metal = false): this {
    const outline: V2[] = [
      [front, -0.31],
      [back, -0.31],
      [back + 0.06, yTop],
      [front - 0.06, yTop],
    ]
    return this.trim(plateSide(outline, 0.04, x), { metal, mirror: true, shading: 0.5 })
  }

  /** A neon strip along the tub's surface line `pi` (3 shoulder, 4 deck edge, 2 lower flank). */
  tubStrip(pi: number, zFrom: number, zTo: number, width: number, kind: LightKind = 'livery'): this {
    const v = new THREE.Vector2()
    const n = 24
    const rings: THREE.Vector3[][] = []
    for (let k = 0; k <= n; k++) {
      const z = zFrom + ((zTo - zFrom) * k) / n
      this.tubPoint(pi, z, v)
      const x = v.x + 0.012
      rings.push([
        new THREE.Vector3(x, v.y - width / 2, z),
        new THREE.Vector3(x, v.y + width / 2, z),
        new THREE.Vector3(x - 0.02, v.y + width / 2, z),
        new THREE.Vector3(x - 0.02, v.y - width / 2, z),
      ])
    }
    return this.light(loft(rings), kind, { mirror: true })
  }

  // ---- raw parts

  paint(g: THREE.BufferGeometry, o: { accent?: boolean; mirror?: boolean; shading?: Shading } = {}): this {
    this.paintParts.add(g, { attrs: { aAccent: o.accent ? 1 : 0 }, mirror: o.mirror, shading: o.shading ?? PAINT_CREASE })
    return this
  }

  trim(g: THREE.BufferGeometry, o: { metal?: boolean; mirror?: boolean; shading?: Shading } = {}): this {
    this.trimParts.add(g, { attrs: { aMetal: o.metal ? 1 : 0 }, mirror: o.mirror, shading: o.shading ?? 0.5 })
    return this
  }

  glass(g: THREE.BufferGeometry, o: { mirror?: boolean; shading?: Shading } = {}): this {
    this.glassParts.add(g, { mirror: o.mirror, shading: o.shading ?? GLASS_CREASE })
    return this
  }

  light(g: THREE.BufferGeometry, kind: LightKind, o: { mirror?: boolean } = {}): this {
    this.lightParts.add(g, { attrs: { aLight: LIGHT_KIND[kind] }, mirror: o.mirror, shading: 'flat' })
    return this
  }

  // ---- neon lines: each car's night signature traces its own shape

  /**
   * A neon arc round a fender's wheel arch, on the pod's outer face: from
   * `from` to `to` of the half circle (0 = front, 1 = back).
   */
  archLight(f: FenderSpec, from = 0.06, to = 0.94, width = 0.03, gap = 0.03): this {
    const n = 20
    const rings: THREE.Vector3[][] = []
    for (let k = 0; k <= n; k++) {
      const t = Math.PI * (from + ((to - from) * k) / n)
      const c = Math.cos(t)
      const sn = Math.sin(t)
      const r0 = f.archR + gap
      const r1 = r0 + width
      const z0 = f.zc + r0 * c
      const x = curve(f.xOut, z0)
      rings.push([
        new THREE.Vector3(x + 0.006, HUB_Y + r0 * sn, f.zc + r0 * c),
        new THREE.Vector3(x + 0.006, HUB_Y + r1 * sn, f.zc + r1 * c),
        new THREE.Vector3(x - 0.014, HUB_Y + r1 * sn, f.zc + r1 * c),
        new THREE.Vector3(x - 0.014, HUB_Y + r0 * sn, f.zc + r0 * c),
      ])
    }
    return this.light(loft(rings), 'livery', { mirror: true })
  }

  /** A neon line along a fender pod's outer face, just under its rounded shoulder. */
  podLight(f: FenderSpec, zFrom: number, zTo: number, width = 0.026, drop = 0.0): this {
    const n = 18
    const rings: THREE.Vector3[][] = []
    for (let k = 0; k <= n; k++) {
      const z = zFrom + ((zTo - zFrom) * k) / n
      const x = curve(f.xOut, z)
      const yTop = curve(f.yTop, z)
      const r = Math.min(f.round, 0.2)
      const y = yTop - r - drop - 0.004
      rings.push([
        new THREE.Vector3(x + 0.006, y - width, z),
        new THREE.Vector3(x + 0.006, y, z),
        new THREE.Vector3(x - 0.014, y, z),
        new THREE.Vector3(x - 0.014, y - width, z),
      ])
    }
    return this.light(loft(rings), 'livery', { mirror: true })
  }

  /** A neon line along a wing's trailing edge, tip to tip. */
  wingLight(w: WingSpec, width = 0.022): this {
    const rings: THREE.Vector3[][] = []
    const c = Math.cos(w.angle)
    const s = Math.sin(w.angle)
    for (const x of steps(-w.span, w.span, 8)) {
      const tip = Math.abs(x) / w.span
      const zLE = w.z - (w.sweep ?? 0) * tip
      const yLE = w.y + (w.dihedral ?? 0) * tip
      const dz = -w.chord - 0.004
      const z = zLE + dz * c
      const y = yLE - dz * s
      rings.push([
        new THREE.Vector3(x, y + width / 2, z),
        new THREE.Vector3(x, y + width / 2, z + 0.02),
        new THREE.Vector3(x, y - width / 2, z + 0.02),
        new THREE.Vector3(x, y - width / 2, z),
      ])
    }
    return this.light(loft(rings), 'livery')
  }

  /**
   * A neon line round the canopy's side, `h` of the way up its lower panel
   * (0 at the base, 0.5 on the panel's bulge, 1 at the panel's top), riding
   * just proud of the rounded glass.
   */
  canopyLight(zFrom: number, zTo: number, h = 0.5, width = 0.024): this {
    const d = this.canopyDense
    if (!d) return this
    const rings: THREE.Vector3[][] = []
    for (const st of d) {
      const z = st[0]
      if (z > zFrom || z < zTo) continue
      const half = canopyHalf(st)
      const cy = (half[0][1] + half[half.length - 1][1]) / 2
      const rh = roundHalf(half, this.canopyBulge, cy) // base, bulge, panel top ...
      const [a, m, c] = [rh[1], rh[2], rh[3]]
      const t = h < 0.5 ? h * 2 : (h - 0.5) * 2
      const p0 = h < 0.5 ? a : m
      const p1 = h < 0.5 ? m : c
      const x = p0[0] + (p1[0] - p0[0]) * t + 0.01
      const y = p0[1] + (p1[1] - p0[1]) * t
      rings.push([
        new THREE.Vector3(x, y - width / 2, z),
        new THREE.Vector3(x, y + width / 2, z),
        new THREE.Vector3(x - 0.024, y + width / 2, z),
        new THREE.Vector3(x - 0.024, y - width / 2, z),
      ])
    }
    if (rings.length < 2) return this
    return this.light(loft(rings), 'livery', { mirror: true })
  }

  /** Where the bonnet camera sits on this body. */
  bonnetAt(y: number, z: number): this {
    this.bonnet.set(0, y, z)
    return this
  }

  /** Where the headlight beams start (both lamps): x, y, z of the left lamp. */
  headAt(x: number, y: number, z: number): this {
    this.headLights = [new THREE.Vector3(x, y, z), new THREE.Vector3(-x, y, z)]
    return this
  }

  /** Where the tail-light trails start (both lamps): x, y, z of the left lamp. */
  tailAt(x: number, y: number, z: number): this {
    this.tailLights = [new THREE.Vector3(x, y, z), new THREE.Vector3(-x, y, z)]
    return this
  }

  finish(): BodyGeometry {
    const paint = this.paintParts.build('paint')
    const glass = this.glassParts.build('glass')
    const trim = this.trimParts.build('trim')
    const lights = this.lightParts.build('lights')
    const tri = (g: THREE.BufferGeometry) => g.getAttribute('position').count / 3
    return {
      paint,
      glass,
      trim,
      lights,
      headLights: this.headLights,
      tailLights: this.tailLights,
      underglow: { ...this.underglow },
      wheel: this.wheel,
      bonnet: this.bonnet.clone(),
      triangles: tri(paint) + tri(glass) + tri(trim) + tri(lights),
    }
  }
}

// ---------------------------------------------------------------- the cache

const cache = new Map<BodyId, BodyGeometry>()

/** Geometry for a body, built on first use and kept for the session (never disposed). */
export function bodyGeometry(id: BodyId): BodyGeometry {
  let g = cache.get(id)
  if (!g) {
    const b = new BodyBuilder()
    RECIPES[id](b)
    g = b.finish()
    cache.set(id, g)
  }
  return g
}

// ---------------------------------------------------------------- the wheel

const wheelCache = new Map<WheelStyle, THREE.BufferGeometry>()

/** Shades for wheel parts: `aMetal` 0 = rubber, 0.3 = the satin sidewall band, 1 = dark chrome. */
const RUBBER = { aGlow: 0, aMetal: 0 }
const BAND = { aGlow: 0, aMetal: 0.3 }
const METAL = { aGlow: 0, aMetal: 1 }

/**
 * Tyre + rim + glowing ring, axle along X, outer face at +X. Built to read
 * as a chunky toy wheel inside the fixed radius: a fat rounded tyre with two
 * staggered rows of tread blocks, a satin band round the sidewall, and a rim
 * set deep inside it with spokes that dish inward (so it has real depth),
 * framed by a chrome lip and the glowing ring.
 */
export function wheelGeometry(style: WheelStyle): THREE.BufferGeometry {
  const hit = wheelCache.get(style)
  if (hit) return hit
  const parts = new PartList(['aGlow', 'aMetal'])
  const r = WHEEL_VIS.radius
  const hw = WHEEL_VIS.width / 2

  // Tyre: lathed round the axle. Inner bead -> fat inner shoulder -> tread with a
  // centre groove -> fat outer shoulder -> outer sidewall -> bead into the rim.
  const prof: V2[] = [
    [0.25, -hw + 0.01],
    [0.31, -hw],
    [r - 0.035, -hw + 0.012],
    [r - 0.012, -hw + 0.04],
    [r - 0.012, -0.022],
    [r - 0.026, -0.014],
    [r - 0.026, 0.014],
    [r - 0.012, 0.022],
    [r - 0.012, hw - 0.04],
    [r - 0.035, hw - 0.012],
    [0.31, hw],
    [0.262, hw - 0.006],
    [0.255, hw - 0.04],
  ]
  const tyre = new THREE.LatheGeometry(
    prof.map(([pr, a]) => new THREE.Vector2(pr, a)),
    24,
  )
  tyre.rotateZ(-Math.PI / 2) // lathe axis +y -> +x
  parts.add(tyre, { attrs: RUBBER, shading: 0.7 })

  // The satin sidewall band: a raised ring on the outer sidewall, like a tyre's lettering.
  const band = new THREE.LatheGeometry(
    [
      [0.268, hw - 0.004],
      [0.272, hw + 0.006],
      [0.3, hw + 0.006],
      [0.305, hw - 0.004],
    ].map(([pr, a]) => new THREE.Vector2(pr, a)),
    24,
  )
  band.rotateZ(-Math.PI / 2)
  parts.add(band, { attrs: BAND, shading: 0.5 })

  // Tread blocks: two staggered rows across the tread, standing proud of it.
  const BLOCKS = 13
  for (let i = 0; i < BLOCKS; i++) {
    for (const side of [-1, 1]) {
      const a = ((i + (side > 0 ? 0.5 : 0)) / BLOCKS) * Math.PI * 2
      const blk = new THREE.BoxGeometry(0.12, 0.024, 0.085)
      blk.translate(side * 0.085, r - 0.012, 0)
      blk.rotateX(a)
      parts.add(blk, { attrs: RUBBER, shading: 'flat' })
    }
  }

  // Rim: a barrel inside the tyre, a dished base deep inside it, the style's
  // own spokes running from the deep hub out to the lip, the chrome lip.
  const face = hw - 0.01
  const barrel = new THREE.CylinderGeometry(0.256, 0.256, 0.16, 22, 1, true)
  barrel.rotateZ(Math.PI / 2)
  barrel.translate(face - 0.08, 0, 0)
  parts.add(barrel, { attrs: METAL, shading: 0.6 })
  const base = new THREE.CircleGeometry(0.256, 22)
  base.rotateY(Math.PI / 2)
  base.translate(face - 0.1, 0, 0)
  parts.add(base, { attrs: METAL, shading: 'flat' })
  const lip = new THREE.TorusGeometry(0.252, 0.012, 3, 24)
  lip.rotateY(Math.PI / 2)
  lip.translate(face - 0.004, 0, 0)
  parts.add(lip, { attrs: METAL, shading: 0.8 })
  rimStyle(style, parts, face)

  // The neon ring just inside the lip: the car's glow colour, our signature.
  const ring = new THREE.TorusGeometry(0.234, 0.012, 3, 32)
  ring.rotateY(Math.PI / 2)
  ring.translate(face - 0.012, 0, 0)
  parts.add(ring, { attrs: { aGlow: 1, aMetal: 0 }, shading: 'keep' })

  const merged = parts.build(`wheel:${style}`)
  wheelCache.set(style, merged)
  return merged
}

/** One spoke from the deep hub (radius r0) out to the lip (r1), dishing outward, rotated `angle` round the axle. */
function spoke(face: number, r0: number, r1: number, w: number, h: number, angle: number, twist = 0): THREE.BufferGeometry {
  const g = bar({ x: face - 0.075, y: r0, z: 0 }, { x: face - 0.012, y: r1, z: 0 }, w, h)
  if (twist) g.rotateY(twist)
  g.rotateX(angle)
  return g
}

/** Spokes and caps for each rim style. `face` is the rim's outer face (x). */
function rimStyle(style: WheelStyle, parts: PartList, face: number): void {
  const cap = (r0: number, r1: number, depth: number, x: number, seg = 14) => {
    const g = new THREE.CylinderGeometry(r1, r0, depth, seg)
    g.rotateZ(-Math.PI / 2)
    g.translate(x, 0, 0)
    parts.add(g, { attrs: METAL, shading: 0.6 })
  }
  switch (style) {
    case 'star': {
      // five fat spokes dishing out to the lip, the all-rounder
      for (let i = 0; i < 5; i++) parts.add(spoke(face, 0.05, 0.236, 0.05, 0.06, (i / 5) * Math.PI * 2), { attrs: METAL, shading: 'flat' })
      cap(0.075, 0.055, 0.07, face - 0.07)
      break
    }
    case 'turbine': {
      // twelve thin twisted vanes: spins up like a jet
      for (let i = 0; i < 12; i++) parts.add(spoke(face, 0.06, 0.236, 0.012, 0.045, (i / 12) * Math.PI * 2, 0.5), { attrs: METAL, shading: 'flat' })
      cap(0.06, 0.04, 0.08, face - 0.06)
      break
    }
    case 'steelie': {
      // a deep steel dish: a thick raised ring and eight lug bolts, built for shoving
      const ringG = new THREE.TorusGeometry(0.16, 0.034, 4, 20)
      ringG.rotateY(Math.PI / 2)
      ringG.translate(face - 0.075, 0, 0)
      parts.add(ringG, { attrs: METAL, shading: 0.7 })
      for (let i = 0; i < 8; i++) {
        const b = new THREE.CylinderGeometry(0.018, 0.018, 0.04, 5)
        b.rotateZ(Math.PI / 2)
        b.translate(face - 0.08, 0.095, 0)
        b.rotateX((i / 8) * Math.PI * 2)
        parts.add(b, { attrs: METAL, shading: 'flat' })
      }
      cap(0.065, 0.05, 0.05, face - 0.085)
      break
    }
    case 'aero': {
      // a flat aero cover flush with the lip, four raised fins: smooth and fast
      const disc = new THREE.CylinderGeometry(0.236, 0.236, 0.016, 22)
      disc.rotateZ(Math.PI / 2)
      disc.translate(face - 0.03, 0, 0)
      parts.add(disc, { attrs: METAL, shading: 0.5 })
      for (let i = 0; i < 4; i++) {
        const f = new THREE.BoxGeometry(0.02, 0.17, 0.035)
        f.translate(face - 0.016, 0.13, 0)
        f.rotateX((i / 4) * Math.PI * 2 + Math.PI / 4)
        parts.add(f, { attrs: METAL, shading: 'flat' })
      }
      cap(0.05, 0.04, 0.03, face - 0.02)
      break
    }
    case 'pod': {
      // three round, fat spokes and a big domed cap: a toy's wheel
      for (let i = 0; i < 3; i++) {
        const c = new THREE.CapsuleGeometry(0.04, 0.12, 1, 6)
        c.rotateZ(-0.35) // tip the outer end outward: the dish
        c.translate(face - 0.045, 0.14, 0)
        c.rotateX((i / 3) * Math.PI * 2)
        parts.add(c, { attrs: METAL, shading: 0.8 })
      }
      const dome = new THREE.SphereGeometry(0.09, 12, 4, 0, Math.PI * 2, 0, Math.PI / 2)
      dome.rotateZ(-Math.PI / 2)
      dome.translate(face - 0.06, 0, 0)
      parts.add(dome, { attrs: METAL, shading: 'keep' })
      break
    }
  }
}
