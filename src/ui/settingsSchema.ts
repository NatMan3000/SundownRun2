// ============================================================
//  SETTINGS SCHEMA - what each settings tab shows
// ------------------------------------------------------------
//  Every row in the settings menu is described here: which
//  setting it changes, its name on screen, a one-line help text
//  and how its value is written. The menu (screens/Settings.tsx)
//  just draws these rows, so adding a setting to the menu is one
//  line in this file.
//
//  The value ranges come from SETTING_RANGES in core/settings.ts
//  and the defaults from core/config.ts (Josh's knob file).
// ============================================================

import type { Settings } from '../core/settings'
import type { SettingsTab } from './uiStore'
import {
  formatDifficulty,
  formatMult,
  formatPct,
  formatTimeOfDay,
} from './format'
import type { ColourTone } from './colour'
import { NEON_SWATCHES, PAINT_SWATCHES } from './colour'

type NumKey = { [K in keyof Settings]: Settings[K] extends number ? K : never }[keyof Settings]
type BoolKey = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings]

export interface SliderRowSpec {
  kind: 'slider'
  key: NumKey
  label: string
  help: string
  format: (v: number) => string
}

export interface ToggleRowSpec {
  kind: 'toggle'
  key: BoolKey
  label: string
  help: string
}

export interface ChoiceRowSpec {
  kind: 'choice'
  key: 'camera' | 'quality' | 'carBody'
  label: string
  help: string
}

export interface ColourRowSpec {
  kind: 'colour'
  key: 'paint' | 'glow' | 'trail'
  label: string
  help: string
  swatches: readonly string[]
  tone: ColourTone
}

/** Rows filled in at runtime (the current track's live params, the quality in use). */
export interface SpecialRowSpec {
  kind: 'trackParams' | 'qualityInUse'
  label: string
  help: string
}

export type RowSpec = SliderRowSpec | ToggleRowSpec | ChoiceRowSpec | ColourRowSpec | SpecialRowSpec

export const TAB_LABELS: Record<SettingsTab, string> = {
  car: 'Car',
  handling: 'Handling',
  camera: 'Camera',
  audio: 'Audio',
  world: 'World',
  racing: 'Racing',
  track: 'Track',
  graphics: 'Graphics',
  fun: 'Fun',
  multiplayer: 'Multiplayer',
}

const kmh = (v: number) => `${Math.round(v)} km/h`
const metres = (v: number) => `${v.toFixed(1)} m`

export const COLOUR_ROWS: ColourRowSpec[] = [
  { kind: 'colour', key: 'paint', label: 'Paint', help: 'The colour of the car body.', swatches: PAINT_SWATCHES, tone: 'paint' },
  { kind: 'colour', key: 'glow', label: 'Underglow', help: 'The neon under the car and along its light strips.', swatches: NEON_SWATCHES, tone: 'neon' },
  { kind: 'colour', key: 'trail', label: 'Light trail', help: 'The light trail you leave behind you.', swatches: NEON_SWATCHES, tone: 'neon' },
]

export const SETTINGS_ROWS: Record<SettingsTab, RowSpec[]> = {
  car: [{ kind: 'choice', key: 'carBody', label: 'Car', help: 'Which car you drive. The Garage on the title screen shows them all.' }, ...COLOUR_ROWS],
  handling: [
    { kind: 'slider', key: 'grip', label: 'Grip', help: 'Low is a slippery drift machine, high is glued to the road.', format: formatMult },
    { kind: 'slider', key: 'steering', label: 'Steering', help: 'How quickly the car turns. Low is calm and easy, high is a twitchy go-kart.', format: formatMult },
    { kind: 'slider', key: 'stability', label: 'Stability', help: 'How hard the car catches its own slides. High is very hard to spin.', format: formatMult },
    { kind: 'slider', key: 'power', label: 'Power', help: 'Engine power. Low is grandma mode, high is rocket mode.', format: formatMult },
    { kind: 'slider', key: 'brakes', label: 'Brakes', help: 'Low is soft brakes, high stops on a coin.', format: formatMult },
    { kind: 'slider', key: 'topSpeedKmh', label: 'Top speed', help: 'The fastest the engine will push you. Boost pads still go past it.', format: kmh },
  ],
  camera: [
    { kind: 'choice', key: 'camera', label: 'Camera', help: 'Chase, close or bonnet. C or RB cycles it while you drive.' },
    { kind: 'slider', key: 'cameraDistance', label: 'Distance', help: 'How far behind the car the chase camera sits.', format: metres },
    { kind: 'slider', key: 'cameraHeight', label: 'Height', help: 'How high above the car the camera sits.', format: metres },
    { kind: 'slider', key: 'fov', label: 'Field of view', help: 'How wide the camera sees. Wider feels faster.', format: (v) => `${Math.round(v)}°` },
    { kind: 'slider', key: 'fovBoost', label: 'Boost kick', help: 'Extra view the camera opens up when you hit a boost pad.', format: (v) => `+${Math.round(v)}°` },
  ],
  audio: [
    { kind: 'slider', key: 'musicVolume', label: 'Music', help: 'The synthwave soundtrack.', format: formatPct },
    { kind: 'slider', key: 'sfxVolume', label: 'Effects', help: 'Engine, crashes, pickups and menu sounds.', format: formatPct },
  ],
  world: [
    { kind: 'slider', key: 'timeOfDay', label: 'Time of day', help: 'From the sun sitting on the horizon to full night with headlights.', format: formatTimeOfDay },
    { kind: 'slider', key: 'sunsetMinutes', label: 'Sunset speed', help: 'Minutes for the sun to go down while you drive. 0 stops time.', format: (v) => (v <= 0 ? 'Time stands still' : `${Math.round(v)} min`) },
  ],
  racing: [
    { kind: 'slider', key: 'aiRacers', label: 'Ai racers', help: 'How many Ai cars race you, 0 to 5.', format: (v) => String(Math.round(v)) },
    { kind: 'slider', key: 'aiDifficulty', label: 'Difficulty', help: 'How badly the Ai racers want to win.', format: formatDifficulty },
    { kind: 'toggle', key: 'catchUp', label: 'Catch-up', help: 'Ai racers ease off when far ahead and push when far behind.' },
    { kind: 'slider', key: 'raceLaps', label: 'Laps', help: 'Laps in a race. A track can set its own number.', format: (v) => String(Math.round(v)) },
  ],
  track: [{ kind: 'trackParams', label: 'Track', help: 'Live settings of the track you are on. They change the road while you watch.' }],
  graphics: [
    { kind: 'choice', key: 'quality', label: 'Quality', help: 'Lower it if the game stutters. Auto starts high and steps down if it has to.' },
    { kind: 'qualityInUse', label: 'In use', help: 'The quality the game is actually running right now.' },
    { kind: 'toggle', key: 'showFps', label: 'Show FPS', help: 'Frames per second in the corner of the screen.' },
  ],
  fun: [
    { kind: 'toggle', key: 'tricks', label: 'Trick scoring', help: 'Score points for air, spins, flips and rolls.' },
    { kind: 'toggle', key: 'ghost', label: 'Ghost car', help: 'Race a see-through copy of your best lap.' },
    { kind: 'slider', key: 'boostStrength', label: 'Boost strength', help: 'How hard the boost pads kick. 2 is silly.', format: (v) => `${v.toFixed(1)}x` },
    { kind: 'slider', key: 'smashKmh', label: 'Smash speed', help: 'Hit roadside stuff faster than this and it smashes. Slower, it is solid.', format: kmh },
    { kind: 'slider', key: 'magGripKmh', label: 'Magnet speed', help: 'On loops and wall rides you stick above this speed. Below it you fall off.', format: kmh },
  ],
  multiplayer: [
    { kind: 'toggle', key: 'multiplayerRam', label: 'Ramming', help: 'On: you can shove each other. Off: cars pass through like ghosts.' },
  ],
}

export const CAMERA_CHOICES = [
  { value: 'chase', label: 'Chase' },
  { value: 'close', label: 'Close' },
  { value: 'bonnet', label: 'Bonnet' },
] as const

export const QUALITY_CHOICES = [
  { value: 'auto', label: 'Auto' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
] as const
