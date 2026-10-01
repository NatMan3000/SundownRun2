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
//              3 rocket nozzle core
//    plume   the rocket flames (one soft plume per nozzle, all in one
//            mesh). Drawn only while the car boosts; the shader
//            stretches each plume out behind its nozzle (carModel.ts)
//
//  BIG WHEELS. Each car says how big its tyres look, front and back
//  (wheels()). The physics wheel is smaller (tuning.ts WHEEL.radius):
//  it only decides where the suspension ray meets the road, so the
//  drawn tyre can be any size. Its hub is raised by the difference,
//  so the bottom of the tyre still sits exactly on the road, and the
//  fenders cut their arches round the bigger tyre.
//  Wheels are shared by every car with the same rim style and size:
//  tyre with sidewall and tread lugs, a designed rim, and a glowing
//  ring (`aGlow`) - see wheelGeometry() at the bottom.
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
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { AXLE_Z, bar, curve, densify, lathe, loft, mirroredRing, PartList, plateSide, ringXY, roundHalf, steps } from './kit'
import type { Shading, V2 } from './kit'
import { ROAD_Y_AT_REST } from '../tuning'

/** A tyre as drawn: outer radius and width, metres. */
export interface TyreSize {
  r: number
  w: number
}

/** Tyre size when a recipe doesn't say (the physics wheel is 0.34: the drawn one is bigger). */
export const TYRE_DEFAULT: TyreSize = { r: 0.46, w: 0.4 }

/** Room between a tyre and its arch, metres. */
export const ARCH_GAP = 0.055

/** Paint skin kept over a tyre at its highest (the fender's top never shows the tyre through it). */
const TYRE_SKIN = 0.03

/** Wheel centre across the car (the physics track never moves). */
const WHEEL_X = 0.8

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
  /** Tyres as drawn: [front, rear]. */
  tyres: [TyreSize, TyreSize]
  /**
   * Highest a wheel's hub may be drawn, [front, rear], body space (before
   * lean): above this the tyre would push up through the fender's top.
   */
  hubMax: [number, number]
  /** The rocket plumes (empty for a car with no nozzle). */
  plume: THREE.BufferGeometry
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
  /**
   * Bottom height away from the arch (the sill): one height, or keyframes
   * [z, y] (raise it toward the pod's ends to round them off over the tyre).
   */
  yFloor: number | V2[]
  /** Room between the tyre and the arch (default ARCH_GAP). The arch is cut round the tyre the recipe chose. */
  gap?: number
  /** Size of the rounded outer-top edge (the same all along the pod). */
  round: number
  /** How far the top face leans in toward the car (0 flat, 0.1 sloping). */
  lean?: number
  accent?: boolean
  /** Smoothing angle for its normals (radians; default the paint's crisp 0.62). */
  crease?: number
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
  /** How long the flame plume gets at full boost, metres (about a car length for the main rocket). */
  flame?: number
}

const LIGHT_LIVERY = 0
const LIGHT_HEAD = 1
const LIGHT_TAIL = 2
const LIGHT_NOZZLE = 3
export const LIGHT_KIND = { livery: LIGHT_LIVERY, head: LIGHT_HEAD, tail: LIGHT_TAIL } as const
export type LightKind = keyof typeof LIGHT_KIND

/** Crease angles: panels meeting at less than this are smoothed together; sharper meets stay a crisp line. */
const PAINT_CREASE = 0.62 // ~35 deg: rounded, toy-like panels, crisp at real edges
const GLASS_CREASE = 0.8

/**
 * A rocket plume's shape along its length (0 at the nozzle, 1 at the tip):
 * [how far along, width x the nozzle's radius]. It swells as it leaves the
 * bell, then tapers; the shader makes its edges soft and stretches it.
 */
const PLUME: V2[] = [
  [0, 0.9],
  [0.06, 1.5],
  [0.18, 1.85],
  [0.38, 1.8],
  [0.6, 1.45],
  [0.8, 0.95],
  [1, 0.3],
]

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

// ---------------------------------------------------------------- fender pod helpers

/**
 * The rounded outer-top edge of a pod at z: the recipe's size all along the
 * pod (a size that changed along it made the pod look dented), smaller only
 * where the pod is too thin or too narrow to hold it.
 */
function podRound(f: FenderSpec, z: number, yBot: number): number {
  const yTop = curve(f.yTop, z)
  const xOut = curve(f.xOut, z)
  return Math.max(0.01, Math.min(f.round, yTop - yBot - 0.04, (xOut - f.xIn) * 0.45))
}

/** A pod's sill height at z. */
function floorAt(f: FenderSpec, z: number): number {
  return typeof f.yFloor === 'number' ? f.yFloor : curve(f.yFloor, z)
}

/** Height of a pod's top surface at (x, z): the flat top leaning inward, rounding over at the outer edge. */
function podTopAt(f: FenderSpec, z: number, r: number, lean: number, x: number): number {
  const yTop = curve(f.yTop, z)
  const xOut = curve(f.xOut, z)
  const edge = xOut - r
  if (x <= edge) {
    const span = Math.max(1e-3, edge - f.xIn)
    return yTop + (lean * (edge - Math.max(f.xIn, x))) / span
  }
  // the rounded edge as drawn: (edge, yTop) -> (xOut - 0.29r, yTop - 0.29r) -> (xOut, yTop - r)
  const xm = xOut - r * 0.29
  if (x <= xm) return yTop - (0.29 * r * (x - edge)) / Math.max(1e-4, xm - edge)
  if (x <= xOut) return yTop - 0.29 * r - (0.71 * r * (x - xm)) / Math.max(1e-4, xOut - xm)
  return yTop - r // the tyre pokes out past the pod's side
}

// ---------------------------------------------------------------- the builder

/** What a recipe uses to make a car. */
export class BodyBuilder {
  readonly paintParts = new PartList(['aAccent'])
  readonly glassParts = new PartList()
  readonly trimParts = new PartList(['aMetal'])
  readonly lightParts = new PartList(['aLight'])
  /** Rocket plumes: `aT` 0 at the nozzle .. 1 at the tip, `aRad` the plume's width there, `aCx`/`aCy` its axis, `aLen` its length at full boost. */
  readonly plumeParts = new PartList(['aT', 'aRad', 'aCx', 'aCy', 'aLen'])
  headLights: THREE.Vector3[] = []
  tailLights: THREE.Vector3[] = []
  underglow = { halfWidth: 0.72, halfLength: 1.72, y: -0.42 }
  wheel: WheelStyle = 'star'
  /** Tyres as drawn, front and rear (set with wheels() before any fender). */
  tyreFront: TyreSize = { ...TYRE_DEFAULT }
  tyreRear: TyreSize = { ...TYRE_DEFAULT }
  /** Highest hub per axle before a tyre reaches its fender's top (worked out by fender()). */
  readonly hubMax: [number, number] = [Infinity, Infinity]
  /** Bonnet camera mount (car space): on the bonnet, by the windscreen base. */
  bonnet = new THREE.Vector3(0, 0.5, 1.55)
  private tubDense: number[][] | null = null
  private tubBulge = 0.04
  private canopyDense: number[][] | null = null
  private canopyBulge = 0.07

  // ---- wheels

  /**
   * How big this car's tyres look: radius and width, front and rear (a bigger
   * rear tyre gives the raked hot-rod stance). Call it before the fenders:
   * they cut their arches round these.
   */
  wheels(front: TyreSize, rear: TyreSize = front): this {
    this.tyreFront = { ...front }
    this.tyreRear = { ...rear }
    return this
  }

  /** The tyre on the axle at wheel-centre z `zc` (front if zc > 0). */
  tyre(zc: number): TyreSize {
    return zc > 0 ? this.tyreFront : this.tyreRear
  }

  /** Where that axle's hub is drawn at rest: the tyre's bottom on the road. */
  hubY(zc: number): number {
    return ROAD_Y_AT_REST + this.tyre(zc).r
  }

  /** The arch radius over that axle's tyre. */
  archR(zc: number, gap = ARCH_GAP): number {
    return this.tyre(zc).r + gap
  }

  // ---- painted parts

  /** The main body, lofted nose to tail through the stations (smoothed between them). */
  tub(stations: TubStation[], opts: { bulge?: number; sub?: number; accent?: boolean; crease?: number } = {}): this {
    // z, underside and lower flank go in straight lines between stations, so they never bulge into a tyre
    const dense = densify(stations, opts.sub ?? 3, [0, 1, 2, 3, 4])
    this.tubDense = dense
    const bulge = opts.bulge ?? 0.04
    this.tubBulge = bulge
    const rings = dense.map((st) => {
      const half = tubHalf(st)
      const cy = (half[0][1] + half[half.length - 1][1]) / 2
      return mirroredRing(roundHalf(half, bulge, cy), st[0])
    })
    return this.paint(loft(rings), { accent: opts.accent, shading: opts.crease ?? PAINT_CREASE })
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
   * its underside as a circle round the (drawn) hub, so the whole tyre shows.
   * It also works out how high that tyre may rise on its suspension before it
   * would push up through the pod's top (hubMax).
   */
  fender(f: FenderSpec): this {
    const archR = this.archR(f.zc, f.gap)
    const hub = this.hubY(f.zc)
    const r3 = (z: number) => Math.round(z * 1000) / 1000
    // rings that must stay: the pod's ends, the arch's ends and the legs just outside them
    const keep = new Set<number>([r3(f.front), r3(f.back)])
    for (const s of [-1, 1]) for (const d of [archR, archR + 0.003]) keep.add(r3(f.zc + s * d))
    const zs = new Set<number>()
    for (const z of steps(f.back, f.front, 14)) zs.add(r3(z))
    for (let k = 0; k <= 14; k++) {
      const z = f.zc + archR * Math.cos((k / 14) * Math.PI)
      if (z > f.back && z < f.front) zs.add(r3(z))
    }
    // just outside the arch: the legs drop straight to the sill
    for (const s of [-1, 1]) {
      const z = f.zc + s * (archR + 0.003)
      if (z > f.back && z < f.front) zs.add(r3(z))
    }
    // drop in-between rings closer than 1.5 cm to a neighbour: a sliver of a ring makes a crumpled facet
    const sorted: number[] = []
    for (const z of [...zs].sort((a, b) => b - a)) {
      const prev = sorted[sorted.length - 1]
      if (prev === undefined || keep.has(z) || prev - z > 0.015) sorted.push(z)
      else if (!keep.has(prev)) sorted[sorted.length - 1] = z
    }
    const lean = f.lean ?? 0.04
    const yArchAt = (z: number) => {
      const dz = z - f.zc
      return Math.abs(dz) < archR ? hub + Math.sqrt(archR * archR - dz * dz) : floorAt(f, z)
    }
    const yBotAt = (z: number) => Math.min(yArchAt(z), curve(f.yTop, z) - 0.05)
    const rAt = (z: number) => podRound(f, z, yBotAt(z))
    // the tyre's highest safe hub: under every ring over the tyre, its tread's top stays a skin below the pod's top
    const ty = this.tyre(f.zc)
    const xTread = [WHEEL_X - ty.w / 2, WHEEL_X + ty.w / 2]
    const axle = f.zc > 0 ? 0 : 1
    for (const z of sorted) {
      const dz = z - f.zc
      if (Math.abs(dz) >= ty.r) continue
      const top = Math.min(podTopAt(f, z, rAt(z), lean, xTread[0]), podTopAt(f, z, rAt(z), lean, xTread[1]))
      this.hubMax[axle] = Math.min(this.hubMax[axle], top - TYRE_SKIN - Math.sqrt(ty.r * ty.r - dz * dz))
    }
    const rings = sorted.map((z) => {
      const yTop = curve(f.yTop, z)
      const xOut = curve(f.xOut, z)
      const yBot = yBotAt(z)
      const r = rAt(z)
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
    return this.paint(loft(rings), { accent: f.accent, mirror: true, shading: f.crease ?? PAINT_CREASE })
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
   * a soft flame plume the shader stretches out behind it while boosting.
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
      // the plume: lathed one metre long from the bell's exit; the shader stretches it to
      // `flame` metres (and back to nothing) with the boost, and softens its edges
      const exitZ = n.z - L
      const width = r * (1 + sy) * 0.5
      const plume = lathe(
        PLUME.map(([t, k]) => [r * k, t] as V2),
        14,
        { x: at.x, y: at.y, z: exitZ },
        sy,
      )
      this.plumeParts.add(plume, {
        attrs: {
          aT: (_x, _y, z) => THREE.MathUtils.clamp(exitZ - z, 0, 1),
          aRad: (_x, _y, z) => width * curve(PLUME, THREE.MathUtils.clamp(exitZ - z, 0, 1)),
          aCx: at.x,
          aCy: at.y,
          aLen: flameLen,
        },
        shading: 'flat',
      })
    }
    return this
  }

  /** Dark wheel wells: a plate inboard of each tyre so the arches read deep, not see-through. */
  wells(x = 0.55, gap = ARCH_GAP): this {
    for (const zc of [AXLE_Z, -AXLE_Z]) {
      const pts: V2[] = []
      const archR = this.archR(zc, gap) + 0.01
      const hub = this.hubY(zc)
      for (let k = 0; k <= 14; k++) {
        const a = (k / 14) * Math.PI
        pts.push([zc + archR * Math.cos(a), hub + archR * Math.sin(a)])
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
    const n = 24
    const rings: THREE.Vector3[][] = []
    const hub = this.hubY(f.zc)
    for (let k = 0; k <= n; k++) {
      const t = Math.PI * (from + ((to - from) * k) / n)
      const c = Math.cos(t)
      const sn = Math.sin(t)
      const r0 = this.archR(f.zc, f.gap) + gap
      const r1 = r0 + width
      const z0 = f.zc + r0 * c
      const x = curve(f.xOut, z0)
      rings.push([
        new THREE.Vector3(x + 0.006, hub + r0 * sn, f.zc + r0 * c),
        new THREE.Vector3(x + 0.006, hub + r1 * sn, f.zc + r1 * c),
        new THREE.Vector3(x - 0.014, hub + r1 * sn, f.zc + r1 * c),
        new THREE.Vector3(x - 0.014, hub + r0 * sn, f.zc + r0 * c),
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

  /**
   * A neon line straight across the bonnet at z, riding just proud of the
   * tub's top (from deck edge to deck edge, `inset` of the way in from each
   * edge). It is the strip of car the bonnet camera keeps at the bottom of
   * its frame, and a face to the car from the front at night.
   */
  noseLight(z: number, width = 0.016, inset = 0.12): this {
    const h = this.tubDense
    if (!h) return this
    // the tub's cross-section at z, rounded the way the tub was
    let st = h[h.length - 1]
    for (let i = 0; i < h.length - 1; i++) {
      const a = h[i]
      const b = h[i + 1]
      if (z <= a[0] && z >= b[0]) {
        const t = a[0] === b[0] ? 0 : (a[0] - z) / (a[0] - b[0])
        st = a.map((v, j) => v + (b[j] - v) * t)
        break
      }
    }
    const half = tubHalf(st)
    const cy = (half[0][1] + half[half.length - 1][1]) / 2
    const rh = roundHalf(half, this.tubBulge, cy)
    // the top panel: deck edge, its rounded middle, crown (points 7, 8, 9 of the rounded half).
    // The line follows a smooth arc through those three, so it never zigzags over a bulgy top.
    const [p0, pm, p2] = [rh[7], rh[8], rh[9]]
    const c: V2 = [2 * pm[0] - (p0[0] + p2[0]) / 2, 2 * pm[1] - (p0[1] + p2[1]) / 2]
    const arc = (t: number): V2 => {
      const u = 1 - t
      return [u * u * p0[0] + 2 * u * t * c[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p2[1]]
    }
    const pts: V2[] = []
    for (let k = 0; k <= 12; k++) {
      const [x, y] = arc(inset + ((1 - inset) * k) / 12)
      pts.push([x, y + 0.012])
    }
    const full: V2[] = [...pts, ...pts.slice(0, -1).reverse().map(([x, y]) => [-x, y] as V2)]
    const rings = full.map(([x, y]) => [
      new THREE.Vector3(x, y + 0.004, z + width / 2),
      new THREE.Vector3(x, y + 0.004, z - width / 2),
      new THREE.Vector3(x, y - 0.012, z - width / 2),
      new THREE.Vector3(x, y - 0.012, z + width / 2),
    ])
    return this.light(loft(rings), 'livery')
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
    const plume = this.plumeParts.build('plume')
    const tri = (g: THREE.BufferGeometry) => g.getAttribute('position').count / 3
    // an axle with no fender over it: let the tyre ride a tyre's height
    const hubMax: [number, number] = [0, 1].map((a) => {
      const zc = a === 0 ? AXLE_Z : -AXLE_Z
      return Number.isFinite(this.hubMax[a]) ? this.hubMax[a] : this.hubY(zc) + this.tyre(zc).r
    }) as [number, number]
    return {
      paint,
      glass,
      trim,
      lights,
      headLights: this.headLights,
      tailLights: this.tailLights,
      underglow: { ...this.underglow },
      wheel: this.wheel,
      tyres: [{ ...this.tyreFront }, { ...this.tyreRear }],
      hubMax,
      plume,
      bonnet: this.bonnet.clone(),
      triangles: tri(paint) + tri(glass) + tri(trim) + tri(lights) + tri(plume),
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

// ---------------------------------------------------------------- the ghost's body

const ghostCache = new Map<BodyId, THREE.BufferGeometry>()

/**
 * The whole body (paint, glass, trim, lights) as ONE geometry with just
 * positions and normals, for the see-through ghost: it is drawn with a
 * single material anyway, so one mesh is one draw call instead of four.
 */
export function ghostBodyGeometry(id: BodyId): THREE.BufferGeometry {
  const hit = ghostCache.get(id)
  if (hit) return hit
  const g = bodyGeometry(id)
  const parts = [g.paint, g.glass, g.trim, g.lights].map((src) => {
    const c = new THREE.BufferGeometry()
    c.setAttribute('position', src.getAttribute('position'))
    c.setAttribute('normal', src.getAttribute('normal'))
    return c
  })
  const merged = mergeGeometries(parts, false)
  if (!merged) throw new Error(`[vehicle] ghost body merge failed for "${id}"`)
  merged.computeBoundingSphere()
  ghostCache.set(id, merged)
  return merged
}

// ---------------------------------------------------------------- the wheel

const wheelCache = new Map<string, THREE.BufferGeometry>()

/** Shades for wheel parts: `aMetal` 0 = rubber, 0.3 = the satin sidewall band, 1 = dark chrome. */
const RUBBER = { aGlow: 0, aMetal: 0 }
const BAND = { aGlow: 0, aMetal: 0.3 }
const METAL = { aGlow: 0, aMetal: 1 }

/** The rim's size as a share of the tyre's radius: a fat, toy-like balloon sidewall round it. */
const RIM_SHARE = 0.66
/** Rims are designed at this radius and scaled to fit each tyre. */
const RIM_DESIGN = 0.256

/**
 * Tyre + rim + glowing ring, axle along X, outer face at +X, at any size.
 * Built to read as a chunky toy wheel: a fat rounded balloon tyre with two
 * staggered rows of big tread lugs, a satin band round the sidewall, and a
 * rim set deep inside it with spokes that dish inward (so it has real
 * depth), framed by a chrome lip and the glowing ring.
 */
export function wheelGeometry(style: WheelStyle, size: TyreSize): THREE.BufferGeometry {
  const key = `${style}:${size.r.toFixed(3)}:${size.w.toFixed(3)}`
  const hit = wheelCache.get(key)
  if (hit) return hit
  const tyreParts = new PartList(['aGlow', 'aMetal'])
  const r = size.r
  const hw = size.w / 2
  const rim = r * RIM_SHARE
  const s = r / 0.35 // the lugs and shoulders grow with the tyre

  // Tyre: lathed round the axle. Inner bead -> fat inner shoulder -> tread with a
  // centre groove -> fat outer shoulder -> outer sidewall -> bead into the rim.
  const sh = 0.05 * s // shoulder roll
  const prof: V2[] = [
    [rim - 0.004, -hw + 0.012],
    [rim + 0.05 * s, -hw],
    [r - sh, -hw + 0.008],
    [r - 0.014 * s, -hw + sh],
    [r - 0.012 * s, -0.026],
    [r - 0.03 * s, -0.016],
    [r - 0.03 * s, 0.016],
    [r - 0.012 * s, 0.026],
    [r - 0.014 * s, hw - sh],
    [r - sh, hw - 0.008],
    [rim + 0.05 * s, hw],
    [rim + 0.006, hw - 0.006],
    [rim, hw - 0.04],
  ]
  const tyre = new THREE.LatheGeometry(
    prof.map(([pr, a]) => new THREE.Vector2(pr, a)),
    28,
  )
  tyre.rotateZ(-Math.PI / 2) // lathe axis +y -> +x
  tyreParts.add(tyre, { attrs: RUBBER, shading: 0.7 })

  // The satin sidewall band: a raised ring on the outer sidewall, like a tyre's lettering.
  const b0 = rim + 0.018 * s
  const b1 = rim + 0.052 * s
  const band = new THREE.LatheGeometry(
    [
      [b0, hw - 0.004],
      [b0 + 0.004, hw + 0.007],
      [b1 - 0.004, hw + 0.007],
      [b1, hw - 0.004],
    ].map(([pr, a]) => new THREE.Vector2(pr, a)),
    28,
  )
  band.rotateZ(-Math.PI / 2)
  tyreParts.add(band, { attrs: BAND, shading: 0.5 })

  // Tread lugs: two staggered rows of big blocks across the tread, standing proud of it.
  const LUGS = 14
  const lugW = Math.max(0.1, hw - 0.05)
  for (let i = 0; i < LUGS; i++) {
    for (const side of [-1, 1]) {
      const a = ((i + (side > 0 ? 0.5 : 0)) / LUGS) * Math.PI * 2
      const blk = new THREE.BoxGeometry(lugW, 0.03 * s, 0.1 * s)
      blk.translate(side * (lugW / 2 + 0.012), r - 0.014 * s, 0)
      blk.rotateX(a)
      tyreParts.add(blk, { attrs: RUBBER, shading: 'flat' })
    }
  }

  // Rim: designed at RIM_DESIGN radius (a barrel, a dished base, the style's own
  // spokes from the deep hub to the lip, the chrome lip and the neon ring), then
  // scaled across to fit this tyre. The depth along the axle stays as designed.
  const rimParts = new PartList(['aGlow', 'aMetal'])
  const face = 0
  const barrel = new THREE.CylinderGeometry(RIM_DESIGN, RIM_DESIGN, 0.16, 24, 1, true)
  barrel.rotateZ(Math.PI / 2)
  barrel.translate(face - 0.08, 0, 0)
  rimParts.add(barrel, { attrs: METAL, shading: 0.6 })
  const base = new THREE.CircleGeometry(RIM_DESIGN, 24)
  base.rotateY(Math.PI / 2)
  base.translate(face - 0.1, 0, 0)
  rimParts.add(base, { attrs: METAL, shading: 'flat' })
  const lip = new THREE.TorusGeometry(RIM_DESIGN - 0.004, 0.012, 3, 28)
  lip.rotateY(Math.PI / 2)
  lip.translate(face - 0.004, 0, 0)
  rimParts.add(lip, { attrs: METAL, shading: 0.8 })
  rimStyle(style, rimParts, face)
  // The neon ring just inside the lip: the car's glow colour, our signature.
  const ring = new THREE.TorusGeometry(0.234, 0.012, 3, 36)
  ring.rotateY(Math.PI / 2)
  ring.translate(face - 0.012, 0, 0)
  rimParts.add(ring, { attrs: { aGlow: 1, aMetal: 0 }, shading: 'keep' })
  const rimGeo = rimParts.build(`rim:${style}`)
  const k = rim / RIM_DESIGN
  rimGeo.scale(1, k, k) // three turns the normals with it
  rimGeo.translate(hw - 0.01, 0, 0)

  const merged = mergeGeometries([tyreParts.build(`tyre:${key}`), rimGeo], false)
  if (!merged) throw new Error(`[vehicle] wheel merge failed for "${key}"`)
  merged.computeBoundingSphere()
  wheelCache.set(key, merged)
  return merged
}

const ghostWheelCache = new Map<string, THREE.BufferGeometry>()

/**
 * The ghost's tyre: one smooth closed puck, no lugs or spokes. The ghost is
 * see-through and does not write depth, so every overlapping part of a real
 * wheel (lugs on the tread, spokes in the rim) would stack into stripes; a
 * single outward-facing shell shows exactly one layer from any side.
 */
export function ghostWheelGeometry(size: TyreSize): THREE.BufferGeometry {
  const key = `${size.r.toFixed(3)}:${size.w.toFixed(3)}`
  const hit = ghostWheelCache.get(key)
  if (hit) return hit
  const r = size.r
  const hw = size.w / 2
  const sh = 0.05 * (r / 0.35)
  const prof: V2[] = [
    [0, -hw + 0.02],
    [r * RIM_SHARE, -hw],
    [r - sh, -hw + 0.008],
    [r, -hw + sh],
    [r, hw - sh],
    [r - sh, hw - 0.008],
    [r * RIM_SHARE, hw],
    [0, hw - 0.02],
  ]
  const g = new THREE.LatheGeometry(
    prof.map(([pr, a]) => new THREE.Vector2(pr, a)),
    28,
  )
  g.rotateZ(-Math.PI / 2)
  const parts = new PartList(['aGlow', 'aMetal'])
  parts.add(g, { attrs: RUBBER, shading: 0.7 })
  const merged = parts.build(`ghost-wheel:${key}`)
  ghostWheelCache.set(key, merged)
  return merged
}

/** One spoke from the deep hub (radius r0) out to the lip (r1), dishing outward, rotated `angle` round the axle. */
function spoke(face: number, r0: number, r1: number, w: number, h: number, angle: number, twist = 0): THREE.BufferGeometry {
  const g = bar({ x: face - 0.075, y: r0, z: 0 }, { x: face - 0.012, y: r1, z: 0 }, w, h)
  if (twist) g.rotateY(twist)
  g.rotateX(angle)
  return g
}

/** Spokes and caps for each rim style, at the design size. `face` is the rim's outer face (x). */
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
      for (let i = 0; i < 5; i++) parts.add(spoke(face, 0.05, 0.236, 0.055, 0.06, (i / 5) * Math.PI * 2), { attrs: METAL, shading: 'flat' })
      cap(0.075, 0.055, 0.07, face - 0.07)
      break
    }
    case 'turbine': {
      // twelve thin twisted vanes: spins up like a jet
      for (let i = 0; i < 12; i++) parts.add(spoke(face, 0.06, 0.236, 0.014, 0.045, (i / 12) * Math.PI * 2, 0.5), { attrs: METAL, shading: 'flat' })
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
      const disc = new THREE.CylinderGeometry(0.236, 0.236, 0.016, 24)
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
