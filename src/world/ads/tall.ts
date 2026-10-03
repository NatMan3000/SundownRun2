// ============================================================
//  TALL ADS - 256 x 512 pictures for the tall hanging banners
// ------------------------------------------------------------
//  One function per ad, drawn into a 256 wide x 512 high box from
//  (0, 0), bright on black. Tall banners are read from far away
//  as you drive at them, so keep the words few and big: stacked
//  letters or two or three short lines.
//
//  Josh: copy one, change it, and it appears in the game.
// ============================================================

import type { AdDef } from './adKit'
import { C, bolt, can, checkered, controller, iceCream, notes, outlineText, ringedPlanet, rocket, star, stripedSun, text, wedgeCar } from './adKit'

/** Letters stacked one above the other, centred on x. */
function stacked(c: CanvasRenderingContext2D, word: string, x: number, top: number, step: number, size: number, color: string, glow?: number) {
  for (let i = 0; i < word.length; i++) text(c, word[i], x, top + i * step, { size, color, align: 'center', glow })
}

export const TALL_ADS: AdDef[] = [
  {
    name: 'Loop Kings',
    shape: 'tall',
    draw: (c) => {
      c.strokeStyle = C.cyan
      c.lineWidth = 12
      c.beginPath()
      c.arc(128, 130, 82, 0, Math.PI * 2)
      c.stroke()
      wedgeCar(c, 74, 216, 110, C.pink)
      text(c, 'LOOP', 128, 300, { size: 76, color: C.cyan, align: 'center', glow: 10 })
      text(c, 'KINGS', 128, 372, { size: 76, color: C.ice, align: 'center' })
      text(c, 'RACING TEAM', 128, 420, { size: 28, color: C.pink, align: 'center' })
      checkered(c, 40, 444, 11, 2, 16, C.ice)
    },
  },
  {
    name: 'Zap Energy',
    shape: 'tall',
    draw: (c) => {
      can(c, 128, 330, 280, C.yellow, C.yellow)
      bolt(c, 98, 120, 160, '#000')
      text(c, 'ZAP!', 128, 410, { size: 84, color: C.yellow, align: 'center', glow: 12 })
      text(c, 'TASTES LIKE THUNDER', 128, 460, { size: 22, color: C.ice, align: 'center', face: 'body', weight: 700, maxW: 220 })
    },
  },
  {
    name: 'Drift School',
    shape: 'tall',
    draw: (c) => {
      // Tyre marks swinging round the bottom
      c.strokeStyle = C.lilac
      c.lineWidth = 7
      for (const off of [0, 20]) {
        c.beginPath()
        c.moveTo(30, 440 + off)
        c.bezierCurveTo(110, 430 + off, 160, 500 - off * 0.5, 226, 470 + off * 0.4)
        c.stroke()
      }
      stacked(c, 'DRIFT', 128, 70, 46, 52, C.pink, 8)
      text(c, 'SCHOOL', 128, 326, { size: 54, color: C.ice, align: 'center' })
      text(c, 'SIDEWAYS IS', 128, 370, { size: 24, color: C.lilac, align: 'center' })
      text(c, 'THE RIGHT WAY', 128, 398, { size: 24, color: C.lilac, align: 'center' })
    },
  },
  {
    name: 'Rocket Launch',
    shape: 'tall',
    draw: (c) => {
      ringedPlanet(c, 190, 64, 30)
      for (let i = 0; i < 12; i++) star(c, 20 + ((i * 73) % 220), 30 + ((i * 131) % 200), 4, 4, C.ice)
      rocket(c, 128, 90, 230, C.ice, C.orange)
      text(c, 'LAUNCH', 128, 388, { size: 66, color: C.orange, align: 'center', glow: 10 })
      text(c, 'PARTIES', 128, 446, { size: 54, color: C.ice, align: 'center' })
      text(c, 'BIRTHDAYS IN ORBIT', 128, 484, { size: 20, color: C.ring, align: 'center', face: 'body', weight: 700, maxW: 220 })
    },
  },
  {
    name: 'Ice Comet',
    shape: 'tall',
    draw: (c) => {
      iceCream(c, 128, 60, 200, C.warm, C.pink, C.mint)
      text(c, 'ICE', 128, 384, { size: 72, color: C.mint, align: 'center', glow: 10 })
      text(c, 'COMET', 128, 448, { size: 70, color: C.pink, align: 'center' })
      text(c, 'COLD AS SPACE', 128, 486, { size: 22, color: C.ice, align: 'center', face: 'body', weight: 700 })
    },
  },
  {
    name: 'Sky Mall',
    shape: 'tall',
    draw: (c) => {
      // a skyscraper of lit windows
      c.strokeStyle = C.sky
      c.lineWidth = 4
      c.strokeRect(70, 60, 116, 300)
      c.fillStyle = C.warm
      for (let r = 0; r < 12; r++) for (let k = 0; k < 4; k++) if ((r * 7 + k * 3) % 5 !== 0) c.fillRect(82 + k * 26, 72 + r * 24, 16, 12)
      c.beginPath()
      c.moveTo(128, 60)
      c.lineTo(128, 26)
      c.stroke()
      text(c, 'SKY MALL', 128, 416, { size: 58, color: C.sky, align: 'center', glow: 10, maxW: 220 })
      text(c, '200 FLOORS', 128, 452, { size: 30, color: C.warm, align: 'center' })
      text(c, 'OF SHOPS', 128, 484, { size: 30, color: C.warm, align: 'center' })
    },
  },
  {
    name: 'Game Night',
    shape: 'tall',
    draw: (c) => {
      controller(c, 128, 110, 200, C.mint, C.pink)
      stacked(c, 'GG', 128, 290, 90, 110, C.mint, 12)
      text(c, 'GAME NIGHT', 128, 420, { size: 44, color: C.pink, align: 'center', maxW: 220 })
      text(c, 'EVERY FRIDAY', 128, 460, { size: 26, color: C.ice, align: 'center' })
    },
  },
  {
    name: 'Brick Car',
    shape: 'tall',
    draw: (c) => {
      // a boxy car from the front
      c.strokeStyle = C.amber
      c.lineWidth = 7
      c.strokeRect(48, 120, 160, 110)
      c.strokeRect(70, 80, 116, 50)
      c.fillStyle = C.ice
      c.fillRect(62, 160, 34, 20)
      c.fillRect(160, 160, 34, 20)
      c.fillStyle = C.amber
      c.fillRect(54, 230, 34, 30)
      c.fillRect(168, 230, 34, 30)
      text(c, 'THE', 128, 320, { size: 32, color: C.ice, align: 'center' })
      text(c, 'BRICK', 128, 398, { size: 82, color: C.amber, align: 'center', glow: 10 })
      text(c, 'BUILT LIKE A WALL', 128, 440, { size: 24, color: C.ice, align: 'center', face: 'body', weight: 700, maxW: 220 })
      text(c, 'STOPS LIKE ONE TOO', 128, 470, { size: 20, color: C.lilac, align: 'center', face: 'body', weight: 600, maxW: 220 })
    },
  },
  {
    name: 'Night Owl Radio',
    shape: 'tall',
    draw: (c) => {
      stripedSun(c, 128, 120, 80)
      notes(c, 80, 230, 90, C.cyan)
      outlineText(c, 'NIGHT', 128, 390, { size: 64, color: C.violet, align: 'center', line: 4, glow: 8 })
      text(c, 'OWL', 128, 450, { size: 64, color: C.violet, align: 'center' })
      text(c, 'RADIO 77.7', 128, 488, { size: 28, color: C.ice, align: 'center' })
    },
  },
]
