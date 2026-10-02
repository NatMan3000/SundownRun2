// ============================================================
//  SUNDOWN RUN II - THE FUN KNOBS
// ------------------------------------------------------------
//  This file is yours, Josh. Change a number, save the file,
//  and the game changes straight away - no restart needed.
//  Nothing here can break the game in a way Ctrl+Z won't fix.
//
//  These are the DEFAULTS. The in-game Settings menu can change
//  most of them while you play (and remembers what you picked).
//  If you edit a value here, your edit wins over an older menu
//  choice for that same setting.
//
//  Colours are written like '#19e3ff' (red-green-blue in hex).
//  Any colour picker app shows you the code - paste it in.
// ============================================================

export const CONFIG = {
  // ---------- YOUR CAR ----------
  carBody: 'dart' as string, //    which car you start in: 'dart', 'blade', 'brick', 'manta' or 'pulse'
  paint: '#1b1f3b', //             body paint
  glow: '#19e3ff', //              underglow + light strips
  trail: '#19e3ff', //             the light trail you leave behind

  // ---------- HANDLING ----------
  grip: 1.0, //        0.7 = slippery drift machine ... 1.4 = glued to the road
  steering: 1.0, //    steering sensitivity. 0.6 = calm and easy ... 1.5 = twitchy go-kart
  stability: 1.0, //   how hard the car catches its own slides. 0.6 = loose ... 1.6 = very hard to spin
  power: 1.0, //       engine power. 0.6 = grandma mode ... 1.6 = rocket mode
  brakes: 1.0, //      0.6 = soft brakes ... 1.6 = stops on a coin
  topSpeedKmh: 260, // the fastest the engine will push you (boost pads go past it!)

  // ---------- CAMERA ----------
  camera: 'chase' as 'chase' | 'close' | 'bonnet', // press C (or RB) to cycle while driving
  cameraDistance: 7.5, // metres behind the car (chase camera)
  cameraHeight: 2.6, //   metres above the car
  fov: 62, //             normal field of view in degrees
  fovBoost: 16, //        extra degrees of view when you hit a boost pad (speed feel!)

  // ---------- TIME OF DAY ----------
  timeOfDay: 0.12, //  0 = the sun sitting on the horizon ... 1 = full night with headlights
  sunsetMinutes: 8, // the sun keeps going down while you drive. 0 = time stands still

  // ---------- AUDIO ----------
  musicVolume: 0.7, // 0 = silent ... 1 = full
  sfxVolume: 0.85, //  engine, crashes, pickups

  // ---------- RACING ----------
  aiRacers: 3, //       how many Ai cars race you (0 to 5)
  aiDifficulty: 0.55, // 0 = sunday drivers ... 1 = they want it more than you
  catchUp: true, //     true = Ai cars ease off when far ahead and push when far behind
  raceLaps: 3, //       laps in a race (a track file can change its own number)

  // ---------- FUN ----------
  tricks: true, //       score points for air, spins, flips and rolls
  ghost: true, //        race a see-through copy of your best lap
  boostStrength: 1.0, // how hard the boost pads kick. 2 = silly
  smashKmh: 45, //       hit roadside stuff faster than this and it smashes (slower = solid)
  magGripKmh: 70, //     on loops and wall rides you stick above this speed, below it you fall off

  // ---------- GRAPHICS ----------
  quality: 'auto' as 'auto' | 'low' | 'medium' | 'high', // lower it if the game stutters
  showFps: false, //     true = show the frames-per-second counter

  // ---------- MULTIPLAYER ----------
  multiplayerRam: true, // true = you can shove each other, false = drive through like ghosts
} as const

export type GameConfig = typeof CONFIG
