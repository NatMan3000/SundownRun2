// ============================================================
//  WIDE ADS - 512 x 256 pictures for the wide hologram panels
//  and the big double screens
// ------------------------------------------------------------
//  One function per ad. Each draws into a 512 x 256 box from
//  (0, 0), bright on black, with the helpers in adKit.ts.
//
//  Josh: want your own ad? Copy one of these, change the words
//  and the picture, and it shows up beside the road next time the
//  game loads (billboardArt.ts finds room for it automatically).
// ============================================================

import type { AdDef } from './adKit'
import {
  C,
  bolt,
  can,
  checkered,
  chevrons,
  controller,
  donut,
  eqBars,
  gauge,
  glowing,
  gridFloor,
  heart,
  mountains,
  notes,
  outlineText,
  ovalTrack,
  palm,
  pizzaSlice,
  poly,
  ringedPlanet,
  robotHead,
  rocket,
  roundRect,
  speedLines,
  sprite,
  star,
  stripedSun,
  text,
  ufo,
  wedgeCar,
} from './adKit'

export const WIDE_ADS: AdDef[] = [
  {
    name: 'Sundown FM',
    shape: 'wide',
    draw: (c) => {
      stripedSun(c, 120, 140, 84)
      text(c, 'SUNDOWN FM', 230, 118, { size: 64, color: C.pink, maxW: 260, glow: 10 })
      text(c, '88.4', 232, 190, { size: 72, color: C.cyan })
      text(c, 'SYNTHS ALL NIGHT', 234, 228, { size: 24, color: C.ice, face: 'body', weight: 700, maxW: 250 })
    },
  },
  {
    name: 'Hyper Cola',
    shape: 'wide',
    draw: (c) => {
      bolt(c, 48, 28, 204, C.amber)
      text(c, 'HYPER COLA', 180, 126, { size: 70, color: C.pink, maxW: 300, glow: 10 })
      text(c, 'ZERO GRAVITY TASTE', 184, 170, { size: 22, color: C.ice, face: 'body', weight: 600, maxW: 300 })
      text(c, 'NOW 30% MORE FIZZ', 184, 224, { size: 34, color: C.mint, maxW: 300 })
    },
  },
  {
    name: 'Gridline Motors',
    shape: 'wide',
    draw: (c) => {
      wedgeCar(c, 40, 152, 290, C.cyan)
      speedLines(c, 480, 100, 4, 120, 14, C.cyan)
      text(c, 'GRIDLINE MOTORS', 40, 224, { size: 52, color: C.ice, maxW: 432 })
    },
  },
  {
    name: 'Visit Orbit 9',
    shape: 'wide',
    draw: (c) => {
      ringedPlanet(c, 118, 128, 62)
      text(c, 'VISIT ORBIT 9', 250, 118, { size: 58, color: C.ring, maxW: 236, glow: 8 })
      text(c, 'RINGSIDE ROOMS FROM 99 CREDITS', 252, 162, { size: 20, color: C.ice, face: 'body', weight: 600, maxW: 234 })
      text(c, 'BOOK NOW', 252, 222, { size: 40, color: C.pink })
    },
  },
  {
    name: 'Turbo Noodles',
    shape: 'wide',
    draw: (c) => {
      c.fillStyle = C.amber
      c.beginPath()
      c.arc(116, 128, 76, 0, Math.PI)
      c.closePath()
      c.fill()
      c.strokeStyle = C.ice
      c.lineWidth = 5
      for (let i = 0; i < 3; i++) {
        const x = 82 + i * 34
        c.beginPath()
        c.moveTo(x, 110)
        c.bezierCurveTo(x - 16, 84, x + 16, 66, x, 36)
        c.stroke()
      }
      text(c, 'TURBO', 230, 110, { size: 72, color: C.mint, glow: 8 })
      text(c, 'NOODLES', 230, 180, { size: 72, color: C.amber, maxW: 256 })
      text(c, 'READY BEFORE THE NEXT LAP', 232, 226, { size: 20, color: C.ice, face: 'body', weight: 600, maxW: 254 })
    },
  },
  {
    name: 'Neon Valley',
    shape: 'wide',
    draw: (c) => {
      gridFloor(c, 12, 140, 488, 244, C.grid)
      mountains(c, 12, 140, 488, 100, C.pink)
      stripedSun(c, 256, 120, 44)
      text(c, 'NEON VALLEY', 256, 230, { size: 54, color: C.cyan, align: 'center', glow: 12 })
    },
  },
  {
    name: 'Arcade 3000',
    shape: 'wide',
    draw: (c) => {
      sprite(c, ['..XXXX..', '.XXXXXX.', 'XXoXXoXX', 'XXXXXXXX', 'XXXXXXXX', 'X.X..X.X'], 48, 72, 14, C.mint, '#000')
      text(c, 'ARCADE 3000', 210, 120, { size: 64, color: C.mint, maxW: 280, glow: 8 })
      text(c, 'HIGH SCORES / FREE PLAY FRIDAY', 212, 164, { size: 20, color: C.ice, face: 'body', weight: 600, maxW: 274 })
      text(c, 'INSERT COIN', 212, 222, { size: 38, color: C.pink })
    },
  },
  {
    name: 'Pizza Hyperloop',
    shape: 'wide',
    draw: (c) => {
      pizzaSlice(c, 130, 40, 150, C.amber, C.pink)
      text(c, 'PIZZA', 236, 108, { size: 74, color: C.pink })
      text(c, 'HYPERLOOP', 236, 176, { size: 62, color: C.amber, maxW: 250 })
      text(c, 'HOT IN 90 SECONDS OR IT FLIES FREE', 238, 222, { size: 18, color: C.ice, face: 'body', weight: 600, maxW: 248 })
    },
  },
  {
    name: 'Robo Pizza',
    shape: 'wide',
    draw: (c) => {
      robotHead(c, 390, 130, 130, C.cyan, C.amber)
      text(c, 'ROBO', 34, 100, { size: 80, color: C.cyan, glow: 10 })
      text(c, 'PIZZA', 34, 172, { size: 80, color: C.amber })
      text(c, 'BAKED BY ROBOTS, FLOWN BY DRONES', 36, 222, { size: 19, color: C.ice, face: 'body', weight: 600, maxW: 270 })
    },
  },
  {
    name: 'Team Voltage',
    shape: 'wide',
    draw: (c) => {
      checkered(c, 34, 34, 6, 4, 20, C.ice)
      outlineText(c, '07', 40, 228, { size: 120, color: C.yellow, line: 5, glow: 6 })
      text(c, 'TEAM', 300, 82, { size: 40, color: C.yellow })
      text(c, 'VOLTAGE', 300, 146, { size: 64, color: C.yellow, maxW: 190, glow: 8 })
      text(c, 'CHAMPIONS 2087', 302, 190, { size: 26, color: C.ice, maxW: 186 })
      bolt(c, 440, 196, 42, C.yellow)
    },
  },
  {
    name: 'Afterglow Valley',
    shape: 'wide',
    draw: (c) => {
      stripedSun(c, 384, 140, 84)
      c.fillStyle = '#000'
      c.fillRect(270, 140, 232, 106)
      gridFloor(c, 270, 140, 232, 246, C.grid, 4)
      // the road running into the sunset
      c.fillStyle = '#000'
      poly(c, [370, 140, 398, 140, 470, 246, 298, 246])
      c.fill()
      c.strokeStyle = C.pink
      c.lineWidth = 4
      poly(c, [370, 140, 298, 246], false)
      c.stroke()
      poly(c, [398, 140, 470, 246], false)
      c.stroke()
      text(c, 'AFTERGLOW', 30, 84, { size: 56, color: C.pink, glow: 10, maxW: 226 })
      text(c, 'VALLEY', 32, 142, { size: 56, color: C.pink })
      text(c, 'RACE THE SUNSET', 32, 196, { size: 30, color: C.gold, glow: 6, maxW: 226 })
      text(c, 'A TRACK IN SUNDOWN RUN II', 32, 230, { size: 18, color: C.ice, face: 'body', weight: 700, maxW: 226 })
    },
  },
  {
    name: 'The Hyperdrome',
    shape: 'wide',
    draw: (c) => {
      ovalTrack(c, 130, 128, 200, 120, C.pink, C.ice)
      gauge(c, 130, 140, 40, 0.86, C.cyan, C.amber)
      text(c, 'THE HYPERDROME', 254, 98, { size: 46, color: C.pink, maxW: 236, glow: 8 })
      text(c, '250', 254, 192, { size: 96, color: C.amber })
      text(c, 'KM/H', 414, 156, { size: 32, color: C.ice, maxW: 76 })
      text(c, 'ON THE', 414, 176, { size: 16, color: C.ice, face: 'body', weight: 700, maxW: 76 })
      text(c, 'BANK', 414, 194, { size: 16, color: C.ice, face: 'body', weight: 700, maxW: 76 })
    },
  },
  {
    name: 'Learn To Code',
    shape: 'wide',
    draw: (c) => {
      text(c, '</>', 120, 168, { size: 120, color: C.mint, align: 'center', face: 'mono', weight: 700, glow: 14 })
      text(c, 'LEARN TO CODE', 236, 96, { size: 54, color: C.mint, maxW: 252 })
      text(c, 'WITH JOSH', 238, 148, { size: 46, color: C.cyan })
      text(c, 'MAKE YOUR OWN GAME', 238, 198, { size: 28, color: C.ice, maxW: 250 })
      c.fillStyle = C.mint
      c.fillRect(238, 214, 16, 24)
    },
  },
  {
    name: 'Moon Bounce',
    shape: 'wide',
    draw: (c) => {
      // a crescent moon
      c.fillStyle = C.gold
      c.beginPath()
      c.arc(440, 76, 44, 0, Math.PI * 2)
      c.fill()
      c.fillStyle = '#000'
      c.beginPath()
      c.arc(420, 62, 40, 0, Math.PI * 2)
      c.fill()
      // a trampoline, and a bouncer's path off it
      c.strokeStyle = C.ice
      c.lineWidth = 5
      c.beginPath()
      c.ellipse(400, 214, 62, 12, 0, 0, Math.PI * 2)
      c.stroke()
      c.beginPath()
      c.moveTo(350, 220)
      c.lineTo(342, 244)
      c.moveTo(450, 220)
      c.lineTo(458, 244)
      c.stroke()
      c.fillStyle = C.ring
      for (let i = 0; i < 6; i++) {
        const a = i / 5
        c.beginPath()
        c.arc(372 + a * 60, 196 - Math.sin(a * Math.PI) * 120, 4 + a * 5, 0, Math.PI * 2)
        c.fill()
      }
      text(c, 'MOON', 34, 104, { size: 82, color: C.gold, glow: 10 })
      text(c, 'BOUNCE', 34, 178, { size: 82, color: C.ice })
      text(c, 'LOW GRAVITY TRAMPOLINES', 36, 226, { size: 20, color: C.ring, face: 'body', weight: 600, maxW: 290 })
    },
  },
  {
    name: 'Mars By Monday',
    shape: 'wide',
    draw: (c) => {
      c.fillStyle = C.red
      c.beginPath()
      c.arc(458, 62, 28, 0, Math.PI * 2)
      c.fill()
      c.save()
      c.translate(130, 128)
      c.rotate(0.5)
      rocket(c, 0, -100, 200, C.ice, C.orange)
      c.restore()
      text(c, 'MARS BY', 240, 120, { size: 58, color: C.ice, maxW: 160 })
      text(c, 'MONDAY', 240, 186, { size: 66, color: C.red, glow: 10 })
      text(c, 'WEEKEND ROCKETS, WINDOW SEATS', 242, 228, { size: 17, color: C.ice, face: 'body', weight: 600, maxW: 244 })
    },
  },
  {
    name: 'Dragon Fuel',
    shape: 'wide',
    draw: (c) => {
      can(c, 96, 226, 190, C.mint, C.mint)
      text(c, 'D', 96, 150, { size: 46, color: '#000', align: 'center' })
      text(c, 'DRAGON', 186, 104, { size: 74, color: C.mint, glow: 10 })
      text(c, 'FUEL', 186, 178, { size: 74, color: C.orange })
      text(c, 'ROAR INTO THE NIGHT', 190, 224, { size: 22, color: C.ice, face: 'body', weight: 700, maxW: 296 })
    },
  },
  {
    name: 'Cosmic Donuts',
    shape: 'wide',
    draw: (c) => {
      donut(c, 116, 128, 90, C.warm, C.pink, C.cyan)
      text(c, 'COSMIC', 236, 108, { size: 72, color: C.pink, glow: 8 })
      text(c, 'DONUTS', 236, 178, { size: 72, color: C.warm })
      text(c, 'A HOLE NEW GALAXY', 238, 222, { size: 22, color: C.ice, face: 'body', weight: 600, maxW: 250 })
    },
  },
  {
    name: 'Laser Tag Arena',
    shape: 'wide',
    draw: (c) => {
      c.lineWidth = 5
      const beams: [string, number, number, number, number][] = [
        [C.red, 20, 40, 300, 200],
        [C.mint, 20, 220, 260, 30],
        [C.cyan, 492, 30, 200, 236],
      ]
      for (const [col, x0, y0, x1, y1] of beams) {
        c.strokeStyle = col
        glowing(c, col, 10, () => {
          c.beginPath()
          c.moveTo(x0, y0)
          c.lineTo(x1, y1)
          c.stroke()
        })
      }
      c.fillStyle = '#000'
      c.fillRect(70, 84, 372, 120)
      text(c, 'LASER TAG', 256, 152, { size: 74, color: C.red, align: 'center', glow: 10 })
      text(c, 'ARENA / LEVEL -3', 256, 192, { size: 28, color: C.ice, align: 'center' })
    },
  },
  {
    name: 'Hoverboard Sale',
    shape: 'wide',
    draw: (c) => {
      c.strokeStyle = C.cyan
      c.lineWidth = 7
      roundRect(c, 40, 170, 200, 26, 13)
      c.stroke()
      c.fillStyle = C.mint
      for (let i = 0; i < 3; i++) c.fillRect(70 + i * 60, 206 + i * 2, 40, 5 - i)
      for (let i = 0; i < 3; i++) c.fillRect(80 + i * 60, 220 + i * 2, 20, 4 - i)
      text(c, 'HOVERBOARD', 268, 88, { size: 52, color: C.cyan, maxW: 224, glow: 8 })
      text(c, 'SALE', 268, 166, { size: 86, color: C.mint })
      text(c, 'NO WHEELS, NO PROBLEMS', 270, 210, { size: 19, color: C.ice, face: 'body', weight: 600, maxW: 220 })
      text(c, '50%', 46, 132, { size: 92, color: C.pink, glow: 8 })
    },
  },
  {
    name: 'The Manta',
    shape: 'wide',
    draw: (c) => {
      wedgeCar(c, 222, 216, 262, C.cyan, C.pink)
      text(c, 'THE', 34, 64, { size: 34, color: C.ice })
      text(c, 'MANTA', 34, 138, { size: 80, color: C.cyan, glow: 12 })
      text(c, 'NOW IN EVERY', 36, 194, { size: 22, color: C.ice, face: 'body', weight: 700, maxW: 150 })
      text(c, 'GARAGE', 36, 224, { size: 22, color: C.ice, face: 'body', weight: 700, maxW: 150 })
    },
  },
  {
    name: 'Neon Pocket',
    shape: 'wide',
    draw: (c) => {
      // a tiny twisty track squiggle
      c.strokeStyle = C.pink
      c.lineWidth = 10
      c.lineJoin = 'round'
      c.beginPath()
      c.moveTo(60, 190)
      c.bezierCurveTo(20, 120, 90, 40, 140, 90)
      c.bezierCurveTo(180, 130, 210, 40, 240, 80)
      c.bezierCurveTo(270, 130, 200, 230, 140, 210)
      c.bezierCurveTo(100, 200, 90, 230, 60, 190)
      c.stroke()
      text(c, 'NEON POCKET', 276, 104, { size: 56, color: C.pink, maxW: 214, glow: 10 })
      text(c, 'TINY TRACK', 278, 158, { size: 40, color: C.ice })
      text(c, 'BIG DRIFTS', 278, 208, { size: 40, color: C.amber })
    },
  },
  {
    name: 'Star Burger',
    shape: 'wide',
    draw: (c) => {
      c.fillStyle = C.warm
      c.beginPath()
      c.arc(120, 120, 74, Math.PI, 0)
      c.fill()
      c.fillStyle = C.mint
      c.fillRect(42, 126, 156, 12)
      c.fillStyle = C.red
      c.fillRect(46, 144, 148, 24)
      c.fillStyle = C.warm
      roundRect(c, 46, 174, 148, 30, 12)
      c.fill()
      star(c, 120, 86, 22, 5, C.gold)
      text(c, 'STAR', 240, 112, { size: 76, color: C.gold, glow: 10 })
      text(c, 'BURGER', 240, 182, { size: 76, color: C.warm })
      text(c, 'OUT OF THIS WORLD', 242, 224, { size: 22, color: C.ice, face: 'body', weight: 600, maxW: 244 })
    },
  },
  {
    name: 'Synth Shop',
    shape: 'wide',
    draw: (c) => {
      // piano keys
      c.strokeStyle = C.ice
      c.lineWidth = 3
      for (let i = 0; i < 10; i++) c.strokeRect(30 + i * 45, 150, 45, 84)
      c.fillStyle = C.violet
      for (const i of [0, 1, 3, 4, 5, 7, 8]) c.fillRect(30 + i * 45 + 30, 150, 28, 50)
      notes(c, 400, 30, 80, C.pink)
      text(c, 'SYNTH SHOP', 30, 96, { size: 72, color: C.violet, maxW: 340, glow: 10 })
      text(c, 'EVERY SOUND IN THIS GAME, FOR SALE', 32, 132, { size: 20, color: C.ice, face: 'body', weight: 600, maxW: 340 })
    },
  },
  {
    name: 'UFO Tours',
    shape: 'wide',
    draw: (c) => {
      ufo(c, 120, 90, 180, C.ring, C.mint, C.mint)
      text(c, 'UFO TOURS', 236, 108, { size: 66, color: C.mint, maxW: 252, glow: 10 })
      text(c, 'SEE YOUR HOUSE FROM SPACE', 238, 156, { size: 22, color: C.ice, face: 'body', weight: 600, maxW: 250 })
      text(c, 'BEAM UP TODAY', 238, 212, { size: 38, color: C.ring, maxW: 250 })
    },
  },
  {
    name: 'Pixel Pets',
    shape: 'wide',
    draw: (c) => {
      sprite(
        c,
        ['X......X', 'XX....XX', 'XXXXXXXX', 'XoXXXXoX', 'XXXXXXXX', '.XX..XX.', '.XXXXXX.', 'XX.XX.XX'],
        50,
        48,
        20,
        C.warm,
        '#000',
      )
      heart(c, 236, 56, 40, C.pink)
      text(c, 'PIXEL PETS', 266, 118, { size: 58, color: C.warm, maxW: 222, glow: 8 })
      text(c, 'ROBOT CATS THAT', 268, 160, { size: 26, color: C.ice, maxW: 220 })
      text(c, 'NEVER SCRATCH', 268, 196, { size: 26, color: C.ice, maxW: 220 })
    },
  },
  {
    name: 'Level Up Games',
    shape: 'wide',
    draw: (c) => {
      controller(c, 130, 120, 210, C.blue, C.mint)
      chevrons(c, 270, 64, 3, 34, 30, C.mint)
      text(c, 'LEVEL UP', 270, 150, { size: 72, color: C.blue, maxW: 220, glow: 10 })
      text(c, 'GAMES', 272, 206, { size: 52, color: C.mint })
    },
  },
  {
    name: 'Palm Drive Hotel',
    shape: 'wide',
    draw: (c) => {
      stripedSun(c, 410, 150, 66)
      c.fillStyle = '#000'
      c.fillRect(300, 196, 200, 40)
      palm(c, 352, 236, 130, C.pink)
      palm(c, 470, 236, 110, C.violet)
      text(c, 'PALM DRIVE', 34, 100, { size: 58, color: C.ice, maxW: 240 })
      text(c, 'HOTEL', 34, 172, { size: 74, color: C.pink, glow: 10 })
      text(c, 'POOL ON THE ROOF', 36, 220, { size: 22, color: C.warm, face: 'body', weight: 700, maxW: 230 })
    },
  },
  {
    name: 'Radio Bass',
    shape: 'wide',
    draw: (c) => {
      eqBars(c, 30, 230, 14, 22, 150, C.cyan)
      c.fillStyle = '#000'
      c.fillRect(90, 50, 332, 134)
      text(c, 'BASS 101.9', 256, 128, { size: 70, color: C.cyan, align: 'center', glow: 12 })
      text(c, 'TURN IT UP', 256, 168, { size: 28, color: C.pink, align: 'center' })
    },
  },
]
