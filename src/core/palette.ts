// ============================================================
//  PALETTE - every colour in the game lives here.
// ------------------------------------------------------------
//  CONTRACT (orchestrator-owned). Scene code and UI read these
//  tokens instead of writing hex literals, so the whole world
//  stays one look. See CONSTITUTION.md section 1 for the roles.
//
//  Josh: changing a colour here recolours it everywhere.
// ============================================================

export const PALETTE = {
  // ---- sky at sundown (timeOfDay 0) ----
  skyZenithDusk: '#1b0b3a',
  skyMidDusk: '#5b1670',
  skyHorizonDusk: '#ff3d7f',
  skySunGlow: '#ff8a3d',

  // ---- sky at full night (timeOfDay 1) ----
  skyZenithNight: '#04020c',
  skyMidNight: '#120726',
  skyHorizonNight: '#3a0f52',

  // ---- the synthwave sun, top to bottom ----
  sunTop: '#ffe66b',
  sunMid: '#ff9a3c',
  sunBottom: '#ff2e7e',

  // ---- night sky ----
  stars: '#e6ebff',
  planet: '#4a3a8a',
  planetRing: '#a99bff',

  // ---- megacity ----
  citySilhouette: '#0a0618',
  cityWindowWarm: '#ffb35c',
  cityWindowCool: '#62e6ff',

  // ---- ground ----
  ground: '#07050e',
  groundSheen: '#1a1030',
  grid: '#6b4dff',
  haze: '#43175e',

  // ---- road ----
  road: '#0a0a12',
  roadEdge: '#ff2bd6', //      default track accent (a track file may override)
  roadEdgeAlt: '#19e3ff', //   secondary accent
  laneLine: '#c4f7ff',
  chevron: '#ffb000',

  // ---- track pieces ----
  boost: '#3dffb0',
  loopRing: '#19e3ff',
  wallRide: '#b14dff',
  ramp: '#ffb000',
  speedTrap: '#ffb000',

  // ---- pickups and props ----
  core: '#c77dff',
  coreHot: '#fff2ff',
  propCrate: '#ff2bd6',
  propCube: '#19e3ff',

  // ---- cars ----
  paintDefault: '#1b1f3b',
  glowDefault: '#19e3ff',
  aiColors: ['#ff5d3d', '#ffd23f', '#3dffb0', '#ff2bd6', '#8f7bff'] as readonly string[],
  ghost: '#b8f4ff',
  tagIt: '#ff5d3d',

  // ---- UI (CSS reads these too) ----
  uiPanel: 'rgba(12, 6, 28, 0.72)',
  uiPanelSolid: '#0c061c',
  uiLine: 'rgba(196, 247, 255, 0.18)',
  uiText: '#f2eaff',
  uiDim: '#a99cc7',
  uiAccent: '#19e3ff',
  uiAccent2: '#ff2bd6',
  uiWarn: '#ffb000',
  uiGood: '#3dffb0',
  uiBad: '#ff5d3d',
} as const

/**
 * Glow tiers - emissive intensity multipliers (HDR). Bloom only picks up
 * luminance above 1.0, so T0 never blooms and T3 is reserved for short
 * flashes. Every emissive material picks one of these; see CONSTITUTION.md.
 */
export const GLOW = {
  T0: 0.85, // no bloom: far grid, silhouettes, planet, structure
  T1: 1.6, //  soft halo: near grid, lane lines, windows, posts, stars
  T2: 3.2, //  hero: road edges, chevrons, car lights/livery/trail, boost, loops, cores, sun
  T3: 8.0, //  flash, under half a second: impacts, shards, boost kick, pickups
} as const

export type GlowTier = keyof typeof GLOW

/** System font stacks - no web fonts (self-contained rule). */
export const FONTS = {
  display: '"Avenir Next Condensed", "DIN Condensed", "Bahnschrift", "Arial Narrow", "Roboto Condensed", system-ui, sans-serif',
  body: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  mono: 'ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace',
} as const
