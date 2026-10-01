// ============================================================
//  INPUT - keyboard + Xbox controller, last touched wins
// ------------------------------------------------------------
//  Implements the controls contract (src/core/controls.ts). This
//  is the ONLY file that listens to the keyboard and polls the
//  Gamepad API for driving and menu navigation. It writes:
//
//    driveInput      smoothed throttle / brake / steer / handbrake
//                    (only in the 'drive' context; zero elsewhere)
//    controlSignals  edge-triggered nonces: reset, restart, camera,
//                    pause, screenshot, race
//    menuBus         up / down / left / right / accept / back / tabs
//                    (only in the 'menu' context, with key repeat)
//
//  pollInput() runs once per rendered frame, BEFORE the physics step
//  (InputSystem registers it with r3f's addEffect), so the car always
//  steps with this frame's input.
//
//  Three things this file is careful about, each learned the hard way:
//
//  1. Arrow keys on a menu must never become throttle. A key only
//     drives the car if it was pressed while in the 'drive' context;
//     a key (or pad button) still held from the menu is ignored until
//     it is released and pressed again.
//  2. Keyboard steering is digital (full or nothing), so it is eased
//     in and out and gets gentler at speed. A stick is already analog
//     and only gets a soft response curve.
//  3. A gamepad press is not a browser "gesture", so the browser will
//     not let audio start from it on its own. Every pad press calls
//     audio.unlock() so a controller-only player still gets sound.
// ============================================================

import { controlSignals, driveInput, inputState, menuBus } from './controls'
import type { InputContext, InputDevice, MenuAction } from './controls'
import { audio } from './api'
import { useGame } from './store'
import { getSettings } from './settings'
import { telemetry } from './telemetry'

// ---------------------------------------------------------------- tuning

// Smoothing rates, per second (exponential approach - frame-rate proof).
// Attack is faster than release so the car answers at once but centres
// lazily; flipping across centre is fastest of all, because that is a
// counter-steer and it has to be there NOW.
const STEER_ATTACK = 8
const STEER_RELEASE = 6
const STEER_FLIP = 14
const THROTTLE_ATTACK = 7
const THROTTLE_RELEASE = 10
const BRAKE_ATTACK = 11
const BRAKE_RELEASE = 14
/** Analog axes only need enough smoothing to kill stick noise. */
const ANALOG_RATE = 26

const STICK_DEADZONE = 0.14
const TRIGGER_DEADZONE = 0.05
/** How far the stick must move to count as "the pad was touched" (hot-swap). */
const PAD_ACTIVE_AXIS = 0.35
/** Menu navigation with the stick: past this it counts as a d-pad press. */
const MENU_STICK = 0.55
/** Pad menu repeat: first repeat after this long, then this often. */
const MENU_REPEAT_DELAY_MS = 350
const MENU_REPEAT_MS = 110

// Keyboard taming. A held key would snap to full lock at any speed, and at
// 200 km/h full lock is a spin request. So the digital path loses a little
// authority and a lot of attack speed as the car goes faster. The steering
// rack (src/vehicle/carSim.ts) carries most of the speed sensitivity; this
// only stops a key being quite as absolute as a pinned stick.
const KB_TAME_LO_KMH = 30
const KB_TAME_HI_KMH = 140
const KB_AUTHORITY_DROP = 0.08
const KB_ATTACK_DROP = 0.4

/**
 * Steering knob gamma. The setting runs 0.5..1.6 around 1.0; a straight map
 * makes the calm end limp. 0.8 pulls the bottom up and stretches the top.
 */
const KNOB_GAMMA = 0.8

// Standard Gamepad mapping (Xbox layout).
const PAD = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  VIEW: 8,
  MENU: 9,
  UP: 12,
  DOWN: 13,
  LEFT: 14,
  RIGHT: 15,
} as const
const PAD_BUTTONS = 17

// ---------------------------------------------------------------- helpers

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}
function approach(current: number, target: number, rate: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * dt))
}
function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1)
  return t * t * (3 - 2 * t)
}
function deadzone(v: number, dz: number): number {
  const a = Math.abs(v)
  if (a <= dz) return 0
  return Math.sign(v) * ((a - dz) / (1 - dz))
}
/** Gentle stick curve: x * |x|^0.5, so small movements stay small. */
function stickCurve(x: number): number {
  const a = Math.abs(x)
  return Math.sign(x) * a * Math.sqrt(a)
}

/** The steering setting after its gamma: what the rack and the keyboard scale by. 1 in, 1 out. */
export function steeringGain(): number {
  const v = getSettings().steering
  const knob = Number.isFinite(v) ? clamp(v, 0.5, 1.6) : 1
  return Math.pow(knob, KNOB_GAMMA)
}

// ---------------------------------------------------------------- state

/** Driving keys. A key counts only if it went down while in the 'drive' context. */
const keys = { fwd: false, back: false, left: false, right: false, hand: false }

let device: InputDevice = 'keyboard'
let lastContext: InputContext = inputState.context

const padPrev = new Uint8Array(PAD_BUTTONS)
const padNow = new Uint8Array(PAD_BUTTONS)
/** Buttons held when we entered 'drive': ignored until released (no menu leak). */
const padSuppressed = new Uint8Array(PAD_BUTTONS)
let padStickSuppressed = false
let padConnected = false

/** Pad menu direction currently held (from d-pad or stick) and its repeat clock. */
let menuDir: MenuAction | null = null
let menuDirSince = 0
let menuDirLastFire = 0

let lastPollMs = 0

/** Read-only snapshot for the dev inspector (window.__game.get('input')). */
export const inputDebug = {
  context: inputState.context as InputContext,
  device: device as InputDevice,
  padConnected: false,
  padId: '',
  keys,
}

function setDevice(d: InputDevice): void {
  if (device === d) return
  device = d
  driveInput.device = d
  inputDebug.device = d
  useGame.setState({ inputDevice: d })
}

function clearDriveKeys(): void {
  keys.fwd = keys.back = keys.left = keys.right = keys.hand = false
}

function zeroDrive(): void {
  driveInput.throttle = 0
  driveInput.brake = 0
  driveInput.steer = 0
  driveInput.handbrake = false
}

// ---------------------------------------------------------------- keyboard

function menuActionForKey(code: string): MenuAction | null {
  switch (code) {
    case 'ArrowUp':
    case 'KeyW':
      return 'up'
    case 'ArrowDown':
    case 'KeyS':
      return 'down'
    case 'ArrowLeft':
    case 'KeyA':
      return 'left'
    case 'ArrowRight':
    case 'KeyD':
      return 'right'
    case 'Enter':
    case 'NumpadEnter':
    case 'Space':
      return 'accept'
    case 'Backspace':
    case 'Escape':
      return 'back'
    case 'KeyQ':
      return 'tabPrev'
    case 'KeyE':
      return 'tabNext'
    default:
      return null
  }
}

const REPEATABLE: Record<MenuAction, boolean> = {
  up: true,
  down: true,
  left: true,
  right: true,
  accept: false,
  back: false,
  tabPrev: false,
  tabNext: false,
}

function onKeyDown(e: KeyboardEvent): void {
  const ctx = inputState.context
  if (ctx === 'text') return // a text field owns the keyboard
  const code = e.code || e.key

  // Never let the page scroll out from under the game.
  if (code === 'Space' || code.startsWith('Arrow')) e.preventDefault()

  if (code === 'F9') {
    if (!e.repeat) controlSignals.screenshot++
    e.preventDefault()
    return
  }
  if (code === 'Escape' && !e.repeat) controlSignals.pause++ // every context but text

  if (ctx === 'menu') {
    const action = menuActionForKey(code)
    if (action && (!e.repeat || REPEATABLE[action])) {
      setDevice('keyboard')
      menuBus.emit(action, 'keyboard')
    }
    return
  }
  if (ctx !== 'drive') return // 'editor': only pause and screenshot from here

  if (e.repeat) return
  let handled = true
  switch (code) {
    case 'KeyW':
    case 'ArrowUp':
      keys.fwd = true
      break
    case 'KeyS':
    case 'ArrowDown':
      keys.back = true
      break
    case 'KeyA':
    case 'ArrowLeft':
      keys.left = true
      break
    case 'KeyD':
    case 'ArrowRight':
      keys.right = true
      break
    case 'Space':
      keys.hand = true
      break
    case 'KeyR':
      // One press, one meaning: Shift+R is the bigger hammer.
      if (e.shiftKey) controlSignals.restart++
      else controlSignals.reset++
      break
    case 'KeyC':
      controlSignals.cameraCycle++
      break
    case 'KeyG':
      controlSignals.race++
      break
    default:
      handled = code === 'Escape'
  }
  if (handled) setDevice('keyboard')
}

function onKeyUp(e: KeyboardEvent): void {
  // Releases always count, whatever the context - a key let go on the
  // pause menu must not stay "held" when the drive resumes.
  switch (e.code || e.key) {
    case 'KeyW':
    case 'ArrowUp':
      keys.fwd = false
      break
    case 'KeyS':
    case 'ArrowDown':
      keys.back = false
      break
    case 'KeyA':
    case 'ArrowLeft':
      keys.left = false
      break
    case 'KeyD':
    case 'ArrowRight':
      keys.right = false
      break
    case 'Space':
      keys.hand = false
      break
  }
}

function onBlur(): void {
  clearDriveKeys()
}

let mounted = 0

/** Attach the keyboard listeners. Returns a disposer. Safe under StrictMode double mounts and HMR. */
export function initInput(): () => void {
  mounted++
  if (mounted === 1 && typeof window !== 'undefined') {
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
  }
  return () => {
    mounted--
    if (mounted === 0 && typeof window !== 'undefined') {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      clearDriveKeys()
      zeroDrive()
    }
  }
}

// ---------------------------------------------------------------- gamepad

/** The connected pad touched most recently (Chrome only lists a pad after a press). */
function readGamepad(): Gamepad | null {
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return null
  const pads = navigator.getGamepads()
  let best: Gamepad | null = null
  for (let i = 0; i < pads.length; i++) {
    const p = pads[i]
    if (p && p.connected && (!best || p.timestamp > best.timestamp)) best = p
  }
  return best
}

function buttonValue(p: Gamepad, i: number): number {
  const b = p.buttons[i]
  return b ? b.value : 0
}
function buttonDown(p: Gamepad, i: number): boolean {
  const b = p.buttons[i]
  return b ? b.pressed || b.value > 0.5 : false
}

function rising(i: number): boolean {
  return padNow[i] === 1 && padPrev[i] === 0
}

/** The pad's menu direction this frame (d-pad first, then the stick), or null. */
function padMenuDirection(p: Gamepad): MenuAction | null {
  if (padNow[PAD.UP]) return 'up'
  if (padNow[PAD.DOWN]) return 'down'
  if (padNow[PAD.LEFT]) return 'left'
  if (padNow[PAD.RIGHT]) return 'right'
  const x = p.axes[0] ?? 0
  const y = p.axes[1] ?? 0
  if (Math.abs(x) < MENU_STICK && Math.abs(y) < MENU_STICK) return null
  if (Math.abs(y) >= Math.abs(x)) return y < 0 ? 'up' : 'down'
  return x < 0 ? 'left' : 'right'
}

function pollGamepad(nowMs: number, ctx: InputContext, dt: number): Gamepad | null {
  const pad = readGamepad()
  if (!pad) {
    if (padConnected) {
      padConnected = false
      inputDebug.padConnected = false
      padPrev.fill(0)
      padSuppressed.fill(0)
      if (device === 'gamepad') setDevice('keyboard')
    }
    menuDir = null
    return null
  }
  if (!padConnected) {
    padConnected = true
    inputDebug.padConnected = true
    inputDebug.padId = pad.id
  }

  let anyRising = false
  for (let i = 0; i < PAD_BUTTONS; i++) {
    padNow[i] = buttonDown(pad, i) ? 1 : 0
    if (padNow[i] === 1 && padPrev[i] === 0) anyRising = true
    if (padNow[i] === 0) padSuppressed[i] = 0 // released: it may act again
  }
  const ax = pad.axes[0] ?? 0
  const ay = pad.axes[1] ?? 0
  const stickActive = Math.abs(ax) > PAD_ACTIVE_AXIS || Math.abs(ay) > PAD_ACTIVE_AXIS
  if (!stickActive && Math.abs(ax) < STICK_DEADZONE) padStickSuppressed = false

  if (anyRising) {
    // A pad press is not a browser gesture; this is how sound starts for a pad-only player.
    audio.unlock()
    setDevice('gamepad')
  } else if (stickActive || buttonValue(pad, PAD.RT) > 0.3 || buttonValue(pad, PAD.LT) > 0.3) {
    setDevice('gamepad')
  }

  if (ctx !== 'text') {
    if (rising(PAD.MENU)) controlSignals.pause++

    if (ctx === 'drive') {
      if (rising(PAD.Y)) controlSignals.reset++
      if (rising(PAD.VIEW)) controlSignals.restart++
      if (rising(PAD.RB) && !padSuppressed[PAD.RB]) controlSignals.cameraCycle++
      if (rising(PAD.X)) controlSignals.race++
    } else if (ctx === 'menu') {
      if (rising(PAD.A)) menuBus.emit('accept', 'gamepad')
      if (rising(PAD.B)) menuBus.emit('back', 'gamepad')
      if (rising(PAD.LB)) menuBus.emit('tabPrev', 'gamepad')
      if (rising(PAD.RB)) menuBus.emit('tabNext', 'gamepad')

      // Directions with repeat: fire on press, again after 350 ms, then every 110 ms.
      const dir = padMenuDirection(pad)
      if (dir !== menuDir) {
        menuDir = dir
        menuDirSince = nowMs
        menuDirLastFire = nowMs
        if (dir) {
          setDevice('gamepad')
          menuBus.emit(dir, 'gamepad')
        }
      } else if (dir && nowMs - menuDirSince >= MENU_REPEAT_DELAY_MS && nowMs - menuDirLastFire >= MENU_REPEAT_MS) {
        menuDirLastFire = nowMs
        menuBus.emit(dir, 'gamepad')
      }
    }
  }
  if (ctx !== 'menu') menuDir = null

  // Analog driving (only while the pad owns the car and we are driving).
  if (ctx === 'drive' && device === 'gamepad') {
    const steer = padStickSuppressed ? 0 : stickCurve(deadzone(ax, STICK_DEADZONE))
    const throttle = padSuppressed[PAD.RT] ? 0 : deadzone(buttonValue(pad, PAD.RT), TRIGGER_DEADZONE)
    const brake = padSuppressed[PAD.LT] ? 0 : deadzone(buttonValue(pad, PAD.LT), TRIGGER_DEADZONE)
    driveInput.steer = approach(driveInput.steer, steer, ANALOG_RATE, dt)
    driveInput.throttle = approach(driveInput.throttle, throttle, ANALOG_RATE, dt)
    driveInput.brake = approach(driveInput.brake, brake, ANALOG_RATE, dt)
    driveInput.handbrake = padNow[PAD.A] === 1 && !padSuppressed[PAD.A]
  }

  padPrev.set(padNow)
  return pad
}

// ---------------------------------------------------------------- per frame

/**
 * Poll every device, smooth, and write driveInput. Called once per rendered
 * frame before the physics step (InputSystem -> addEffect).
 */
export function pollInput(nowMs: number): void {
  const dt = lastPollMs === 0 ? 1 / 60 : clamp((nowMs - lastPollMs) / 1000, 0, 0.1)
  lastPollMs = nowMs

  const ctx = inputState.context
  if (ctx !== lastContext) {
    if (ctx === 'drive') {
      // Anything held from the menu stays dead until it is released.
      clearDriveKeys()
      for (let i = 0; i < PAD_BUTTONS; i++) padSuppressed[i] = padPrev[i]
      padStickSuppressed = true
    } else {
      clearDriveKeys()
    }
    lastContext = ctx
    inputDebug.context = ctx
  }

  pollGamepad(nowMs, ctx, dt)

  if (ctx !== 'drive') {
    zeroDrive()
    return
  }
  if (device === 'gamepad' && padConnected) {
    sanitise()
    return // the pad path above already wrote driveInput
  }

  // Keyboard: digital in, analog out.
  const dir = (keys.left ? -1 : 0) + (keys.right ? 1 : 0)
  const gain = steeringGain()
  // speedKmh comes back from the physics; a NaN there must not latch in here.
  const kmh = Number.isFinite(telemetry.speedKmh) ? telemetry.speedKmh : 0
  const tame = smoothstep(KB_TAME_LO_KMH, KB_TAME_HI_KMH, kmh)
  const steerTarget = dir * (1 - KB_AUTHORITY_DROP * tame)
  let steerRate: number
  if (dir === 0) steerRate = STEER_RELEASE
  else if (driveInput.steer !== 0 && Math.sign(dir) !== Math.sign(driveInput.steer)) steerRate = STEER_FLIP
  else steerRate = STEER_ATTACK * gain * (1 - KB_ATTACK_DROP * tame)
  driveInput.steer = approach(driveInput.steer, steerTarget, steerRate, dt)
  if (Math.abs(driveInput.steer) < 0.002) driveInput.steer = 0

  const tt = keys.fwd ? 1 : 0
  driveInput.throttle = approach(driveInput.throttle, tt, tt > 0 ? THROTTLE_ATTACK : THROTTLE_RELEASE, dt)
  const bt = keys.back ? 1 : 0
  driveInput.brake = approach(driveInput.brake, bt, bt > 0 ? BRAKE_ATTACK : BRAKE_RELEASE, dt)
  if (driveInput.throttle < 0.001) driveInput.throttle = 0
  if (driveInput.brake < 0.001) driveInput.brake = 0
  driveInput.handbrake = keys.hand
  sanitise()
}

/** approach() holds a NaN forever once it has one; nothing leaves here non-finite. */
function sanitise(): void {
  if (!Number.isFinite(driveInput.steer)) driveInput.steer = 0
  if (!Number.isFinite(driveInput.throttle)) driveInput.throttle = 0
  if (!Number.isFinite(driveInput.brake)) driveInput.brake = 0
  driveInput.steer = clamp(driveInput.steer, -1, 1)
  driveInput.throttle = clamp(driveInput.throttle, 0, 1)
  driveInput.brake = clamp(driveInput.brake, 0, 1)
}
