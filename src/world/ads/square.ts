// ============================================================
//  SQUARE ADS - 256 x 256 pictures for the small roadside signs
//  and the spinning hologram cubes
// ------------------------------------------------------------
//  One function per ad, drawn into a 256 x 256 box from (0, 0),
//  bright on black. These are the smallest signs, seen for a
//  second at speed: one picture and one or two big words.
//
//  Josh: copy one, change it, and it appears in the game.
// ============================================================

import type { AdDef } from './adKit'
import { C, bolt, checkered, chevrons, crown, donut, heart, outlineText, poly, robotHead, roundRect, sprite, star, text, trophy, ufo, wedgeCar } from './adKit'

export const SQUARE_ADS: AdDef[] = [
  {
    name: 'Boost',
    shape: 'square',
    draw: (c) => {
      chevrons(c, 46, 96, 4, 70, 46, C.mint)
      text(c, 'BOOST', 128, 212, { size: 70, color: C.mint, align: 'center', glow: 12 })
    },
  },
  {
    name: 'Robot Chef',
    shape: 'square',
    draw: (c) => {
      robotHead(c, 128, 104, 112, C.cyan, C.pink)
      text(c, 'ROBOT CHEF', 128, 216, { size: 44, color: C.cyan, align: 'center', maxW: 220 })
      text(c, 'NEVER BURNS TOAST', 128, 240, { size: 16, color: C.ice, align: 'center', face: 'body', weight: 700, maxW: 220 })
    },
  },
  {
    name: 'Neko Cafe',
    shape: 'square',
    draw: (c) => {
      sprite(c, ['X.....X', 'XX...XX', 'XXXXXXX', 'XoXXXoX', 'XXXoXXX', '.XXXXX.'], 58, 34, 20, C.pink, '#000')
      text(c, 'NEKO CAFE', 128, 200, { size: 46, color: C.pink, align: 'center', glow: 8, maxW: 220 })
      text(c, 'CATS + CAKE', 128, 232, { size: 22, color: C.ice, align: 'center', face: 'body', weight: 700 })
    },
  },
  {
    name: 'Drive Nice',
    shape: 'square',
    draw: (c) => {
      heart(c, 128, 96, 150, C.rose)
      text(c, 'DRIVE', 128, 196, { size: 48, color: C.ice, align: 'center' })
      text(c, 'NICE', 128, 238, { size: 40, color: C.rose, align: 'center' })
    },
  },
  {
    name: 'GG',
    shape: 'square',
    draw: (c) => {
      outlineText(c, 'GG', 128, 160, { size: 150, color: C.mint, align: 'center', line: 6, glow: 10 })
      text(c, 'GOOD GAME', 128, 222, { size: 36, color: C.ice, align: 'center' })
    },
  },
  {
    name: 'Race Day',
    shape: 'square',
    draw: (c) => {
      checkered(c, 36, 34, 8, 4, 23, C.ice)
      text(c, 'RACE', 128, 188, { size: 62, color: C.amber, align: 'center', glow: 10 })
      text(c, 'DAY', 128, 238, { size: 50, color: C.ice, align: 'center' })
    },
  },
  {
    name: 'Super Star',
    shape: 'square',
    draw: (c) => {
      star(c, 128, 96, 76, 5, C.gold)
      text(c, 'SUPER STAR', 128, 220, { size: 46, color: C.gold, align: 'center', glow: 8, maxW: 220 })
    },
  },
  {
    name: 'King Of Drift',
    shape: 'square',
    draw: (c) => {
      crown(c, 128, 66, 150, C.yellow)
      text(c, 'KING OF', 128, 190, { size: 40, color: C.ice, align: 'center' })
      text(c, 'DRIFT', 128, 238, { size: 52, color: C.yellow, align: 'center', glow: 8 })
    },
  },
  {
    name: 'Win Big',
    shape: 'square',
    draw: (c) => {
      trophy(c, 128, 30, 130, C.amber)
      text(c, 'WIN BIG', 128, 214, { size: 56, color: C.amber, align: 'center', glow: 8 })
      text(c, 'BEAT YOUR GHOST', 128, 240, { size: 18, color: C.ice, align: 'center', face: 'body', weight: 700 })
    },
  },
  {
    name: 'Aliens Welcome',
    shape: 'square',
    draw: (c) => {
      ufo(c, 128, 80, 190, C.lilac, C.mint)
      text(c, 'ALIENS', 128, 178, { size: 52, color: C.mint, align: 'center', glow: 10 })
      text(c, 'WELCOME', 128, 228, { size: 44, color: C.lilac, align: 'center' })
    },
  },
  {
    name: 'Lucky 7',
    shape: 'square',
    draw: (c) => {
      c.strokeStyle = C.red
      c.lineWidth = 7
      c.strokeRect(40, 30, 176, 120)
      text(c, '777', 128, 128, { size: 96, color: C.red, align: 'center', glow: 10 })
      text(c, 'LUCKY', 128, 222, { size: 58, color: C.yellow, align: 'center' })
    },
  },
  {
    name: 'Zap',
    shape: 'square',
    draw: (c) => {
      bolt(c, 40, 30, 140, C.cyan)
      text(c, 'ZAP', 182, 126, { size: 64, color: C.cyan, align: 'center', glow: 10 })
      text(c, 'CHARGE IN 9 SECONDS', 128, 222, { size: 20, color: C.ice, align: 'center', face: 'body', weight: 700, maxW: 220 })
    },
  },
  {
    name: 'Donut Stop',
    shape: 'square',
    draw: (c) => {
      donut(c, 128, 96, 72, C.warm, C.violet, C.mint)
      text(c, 'DONUT', 128, 210, { size: 52, color: C.violet, align: 'center', glow: 8 })
      text(c, 'STOP', 128, 244, { size: 30, color: C.warm, align: 'center' })
    },
  },
  {
    name: 'Max Speed',
    shape: 'square',
    draw: (c) => {
      text(c, '300', 128, 136, { size: 120, color: C.pink, align: 'center', glow: 12 })
      text(c, 'KM/H CLUB', 128, 196, { size: 40, color: C.ice, align: 'center' })
      chevrons(c, 70, 228, 4, 24, 32, C.pink)
    },
  },
  {
    name: 'Ghost Race',
    shape: 'square',
    draw: (c) => {
      sprite(c, ['..XXXX..', '.XXXXXX.', 'XXoXXoXX', 'XXXXXXXX', 'XXXXXXXX', 'X.XX.XX.'], 72, 30, 14, C.ice, '#000')
      text(c, 'GHOST', 128, 182, { size: 58, color: C.ice, align: 'center', glow: 10 })
      text(c, 'RACE YOURSELF', 128, 226, { size: 26, color: C.sky, align: 'center', maxW: 220 })
    },
  },
  {
    name: 'Rewind',
    shape: 'square',
    draw: (c) => {
      // A round arrow turning back (anticlockwise): drawn mirrored, left to right.
      c.save()
      c.translate(256, 0)
      c.scale(-1, 1)
      c.strokeStyle = C.lilac
      c.lineWidth = 12
      c.lineCap = 'round'
      c.beginPath()
      c.arc(128, 92, 56, Math.PI * 0.15, Math.PI * 1.75)
      c.stroke()
      c.fillStyle = C.lilac
      poly(c, [150, 18, 196, 50, 146, 70]) // the arrow head
      c.fill()
      c.restore()
      text(c, 'REWIND', 128, 202, { size: 54, color: C.lilac, align: 'center', glow: 10 })
      text(c, 'HOLD TO UNDO A CRASH', 128, 234, { size: 18, color: C.ice, align: 'center', face: 'body', weight: 700, maxW: 220 })
    },
  },
  {
    name: 'Space Fries',
    shape: 'square',
    draw: (c) => {
      c.fillStyle = C.yellow
      for (let i = 0; i < 7; i++) c.fillRect(80 + i * 14, 40 + ((i * 37) % 30), 9, 70)
      c.fillStyle = C.red
      poly(c, [70, 96, 186, 96, 172, 160, 84, 160])
      c.fill()
      star(c, 128, 126, 18, 5, C.yellow)
      text(c, 'SPACE', 128, 206, { size: 46, color: C.yellow, align: 'center', glow: 8 })
      text(c, 'FRIES', 128, 242, { size: 36, color: C.red, align: 'center' })
    },
  },
  {
    name: 'Robo Dinos',
    shape: 'square',
    draw: (c) => {
      sprite(c, ['....XXXX', '....XoXX', '....XXXX', 'X...XX..', 'XX.XXXXX', 'XXXXXX..', '.XXXXX..', '..X..X..'], 60, 26, 17, C.mint, '#000')
      text(c, 'ROBO DINOS', 128, 202, { size: 44, color: C.mint, align: 'center', glow: 8, maxW: 220 })
      text(c, 'THEY ONLY BITE BUGS', 128, 234, { size: 18, color: C.ice, align: 'center', face: 'body', weight: 700, maxW: 220 })
    },
  },
  {
    name: 'Mega Ramp',
    shape: 'square',
    draw: (c) => {
      c.strokeStyle = C.amber
      c.lineWidth = 6
      c.beginPath() // the ramp's curve
      c.moveTo(24, 150)
      c.quadraticCurveTo(110, 150, 126, 70)
      c.stroke()
      c.save()
      c.translate(176, 56)
      c.rotate(-0.35)
      wedgeCar(c, -50, 20, 100, C.cyan)
      c.restore()
      text(c, 'MEGA RAMP', 128, 206, { size: 50, color: C.amber, align: 'center', glow: 8, maxW: 220 })
      text(c, 'IN THE STUNT PARK', 128, 236, { size: 20, color: C.ice, align: 'center', face: 'body', weight: 700, maxW: 220 })
    },
  },
  {
    name: "Josh's Garage",
    shape: 'square',
    draw: (c) => {
      // a spanner
      c.save()
      c.translate(128, 86)
      c.rotate(-0.7)
      c.fillStyle = C.cyan
      roundRect(c, -12, -10, 24, 110, 10)
      c.fill()
      c.beginPath()
      c.arc(0, -24, 34, 0, Math.PI * 2)
      c.fill()
      c.fillStyle = '#000'
      c.fillRect(-12, -62, 24, 40)
      c.restore()
      text(c, "JOSH'S", 128, 188, { size: 44, color: C.ice, align: 'center' })
      text(c, 'GARAGE', 128, 236, { size: 50, color: C.cyan, align: 'center', glow: 8 })
    },
  },
  {
    name: 'Bubble Tea',
    shape: 'square',
    draw: (c) => {
      c.strokeStyle = C.rose
      c.lineWidth = 6
      poly(c, [84, 50, 172, 50, 160, 160, 96, 160])
      c.stroke()
      c.beginPath() // the straw
      c.moveTo(140, 56)
      c.lineTo(156, 18)
      c.stroke()
      c.fillStyle = C.lilac
      for (let i = 0; i < 9; i++) {
        c.beginPath()
        c.arc(100 + (i % 4) * 18 + (i > 3 ? 9 : 0), 146 - Math.floor(i / 4) * 16, 7, 0, Math.PI * 2)
        c.fill()
      }
      text(c, 'BUBBLE TEA', 128, 212, { size: 46, color: C.rose, align: 'center', glow: 8, maxW: 220 })
      text(c, 'POP POP POP', 128, 240, { size: 20, color: C.ice, align: 'center', face: 'body', weight: 700 })
    },
  },
  {
    name: 'Hover Taxi',
    shape: 'square',
    draw: (c) => {
      c.strokeStyle = C.yellow
      c.lineWidth = 6
      roundRect(c, 52, 70, 152, 54, 22)
      c.stroke()
      roundRect(c, 86, 44, 84, 32, 12)
      c.stroke()
      checkered(c, 60, 88, 10, 1, 14, C.yellow)
      c.fillStyle = C.mint
      c.fillRect(70, 136, 40, 5)
      c.fillRect(146, 136, 40, 5)
      text(c, 'HOVER', 128, 196, { size: 48, color: C.yellow, align: 'center', glow: 8 })
      text(c, 'TAXI', 128, 240, { size: 40, color: C.ice, align: 'center' })
    },
  },
]
