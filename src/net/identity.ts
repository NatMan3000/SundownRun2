// ============================================================
//  IDENTITY - who this browser is in a multiplayer game
// ------------------------------------------------------------
//  Multiplayer is switched on by the page address, not by a setting:
//
//    http://localhost:5201/?mp=1&name=JOSH
//    http://192.168.0.10:5201/?mp=1&name=DAD&color=orange
//
//  The address is the one thing that is different on every computer
//  (config.ts is shared by everyone because they all load the game
//  from the host), so name and colour ride on it.
//
//    mp=1         join the game
//    name=JOSH    your name tag (14 letters max; remembered for next time)
//    color=pink   your car's glow, trail and paint tint. A colour word
//                 (see COLOR_WORDS) or a hex code (%23ff8a3d).
//    relay=5218   talk to a relay on another port (tests and checkers)
//
//  The colour is applied to this browser's own car for this visit only
//  (not saved), so you see yourself the way everyone else sees you.
// ============================================================

import * as THREE from 'three'
import { PALETTE } from '../core/palette'
import { urlParam } from '../core/devHandles'
import { useSettings } from '../core/settings'
import { RELAY_PORT } from './protocol'

/** Colour words a kid can type into the link, mapped onto the game's palette. */
export const COLOR_WORDS: Record<string, string> = {
  cyan: PALETTE.glowDefault,
  blue: PALETTE.glowDefault,
  pink: PALETTE.propCrate,
  magenta: PALETTE.propCrate,
  orange: PALETTE.skySunGlow,
  red: PALETTE.aiColors[0],
  yellow: PALETTE.aiColors[1],
  gold: PALETTE.aiColors[1],
  mint: PALETTE.aiColors[2],
  green: PALETTE.aiColors[2],
  purple: PALETTE.aiColors[4],
  violet: PALETTE.aiColors[4],
  white: PALETTE.stars,
}

export function mpEnabled(): boolean {
  return urlParam('mp') === '1'
}

/** The relay's port: ?relay=<port> or the reserved 5202. */
export function relayPort(): number {
  const n = Number(urlParam('relay'))
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : RELAY_PORT
}

const NAME_KEY = 'sr2.playerName'

/** Strip anything odd and keep it short enough for a name tag. */
function cleanName(raw: string): string {
  return raw
    .replace(/[^\p{L}\p{N} _.'-]/gu, '')
    .trim()
    .slice(0, 14)
    .toUpperCase()
}

let cachedName: string | null = null

/** Your name: ?name= (remembered), else the last one used here, else RACER 123. */
export function playerName(): string {
  if (cachedName) return cachedName
  const fromUrl = cleanName(urlParam('name') ?? '')
  let name = fromUrl
  if (!name) {
    try {
      name = cleanName(localStorage.getItem(NAME_KEY) ?? '')
    } catch {
      name = ''
    }
  }
  // A stable-ish default so two anonymous computers still read differently.
  if (!name) name = `RACER ${Math.floor(100 + Math.random() * 900)}`
  try {
    localStorage.setItem(NAME_KEY, name)
  } catch {
    // Private window: the name just won't be remembered.
  }
  cachedName = name
  return name
}

/** ?color= as a hex string, or null when absent or unreadable. */
export function urlColor(): string | null {
  const raw = (urlParam('color') ?? '').trim().toLowerCase()
  if (!raw) return null
  if (COLOR_WORDS[raw]) return COLOR_WORDS[raw]
  const hex = raw.startsWith('#') ? raw : `#${raw}`
  return /^#[0-9a-f]{6}$/.test(hex) ? hex : null
}

/**
 * Paint for a chosen colour: the default dark paint pulled 35% toward it,
 * so the body stays dark glass (the neon look) but clearly reads as yours.
 */
export function paintFor(color: string): string {
  const c = new THREE.Color(PALETTE.paintDefault)
  c.lerp(new THREE.Color(color), 0.35)
  return `#${c.getHexString()}`
}

let colorApplied = false

/**
 * Put ?color= onto this browser's own car (glow, trail, paint tint) for
 * this visit. Uses setState directly so it is NOT saved: next time you open
 * the game without the link, your garage choice is back.
 */
export function applyUrlColor(): void {
  if (colorApplied) return
  colorApplied = true
  const color = urlColor()
  if (!color) return
  useSettings.setState({ glow: color, trail: color, paint: paintFor(color) })
}
