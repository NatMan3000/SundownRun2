// ============================================================
//  FAKE PAD - a virtual Xbox controller for checkers and tests
// ------------------------------------------------------------
//  The harness can't press a real controller, so this puts a
//  standard-mapping gamepad behind navigator.getGamepads(). The
//  input system (src/core/input.ts) polls it exactly like a real
//  Bluetooth pad: same mapping, same deadzones, same hot-swap.
//
//    window.__dev.fakePad()                    plug it in
//    window.__dev.pad({ rt: 1, lx: -0.5 })     hold the right trigger, stick half left
//    window.__dev.pad({ a: true })             press A ... pad({ a: false }) to release
//    window.__dev.pad({})                      release everything
//    window.__dev.fakePad(false)               unplug
//
//  Names: lx, ly (left stick, -1..1), lt, rt (triggers 0..1), a, b,
//  x, y, lb, rb, view, menu, up, down, left, right (buttons).
//  Dev only in spirit, but harmless in a build: nothing happens
//  until someone calls it.
// ============================================================

import { registerDev } from '../core/devHandles'

const BUTTONS = ['a', 'b', 'x', 'y', 'lb', 'rb', 'lt', 'rt', 'view', 'menu', 'ls', 'rs', 'up', 'down', 'left', 'right', 'home'] as const

interface FakeButton {
  pressed: boolean
  touched: boolean
  value: number
}

const fake = {
  id: 'Sundown Run virtual Xbox pad (STANDARD GAMEPAD)',
  index: 0,
  connected: true,
  mapping: 'standard' as GamepadMappingType,
  timestamp: 0,
  axes: [0, 0, 0, 0] as number[],
  buttons: BUTTONS.map((): FakeButton => ({ pressed: false, touched: false, value: 0 })),
  hapticActuators: [],
  vibrationActuator: null,
}

let installed = false
let original: (() => (Gamepad | null)[]) | null = null

function plug(on: boolean): string {
  if (typeof navigator === 'undefined') return 'no navigator'
  if (on && !installed) {
    original = navigator.getGamepads ? navigator.getGamepads.bind(navigator) : null
    Object.defineProperty(navigator, 'getGamepads', {
      configurable: true,
      value: () => [fake as unknown as Gamepad, null, null, null],
    })
    installed = true
    fake.timestamp = performance.now()
    return 'virtual pad plugged in'
  }
  if (!on && installed) {
    Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: original ?? (() => []) })
    installed = false
    return 'virtual pad unplugged'
  }
  return installed ? 'already plugged in' : 'not plugged in'
}

type PadState = Partial<Record<(typeof BUTTONS)[number] | 'lx' | 'ly', number | boolean>>

/** Set the pad's state. Anything not mentioned is released. */
function setPad(state: PadState = {}): PadState {
  if (!installed) plug(true)
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0)
  fake.axes[0] = num(state.lx)
  fake.axes[1] = num(state.ly)
  BUTTONS.forEach((name, i) => {
    const v = state[name]
    const value = typeof v === 'number' ? Math.max(0, Math.min(1, v)) : v ? 1 : 0
    fake.buttons[i].value = value
    fake.buttons[i].pressed = value > 0.5
    fake.buttons[i].touched = value > 0
  })
  fake.timestamp = performance.now()
  return state
}

registerDev('fakePad', ((on = true) => plug(on !== false)) as never, 'fakePad(on = true): plug a virtual Xbox pad in behind navigator.getGamepads (tests the real pad path)')
registerDev('pad', ((state: PadState) => setPad(state)) as never, "pad({ lx, ly, lt, rt, a, b, x, y, lb, rb, view, menu, up, down, left, right }): set the virtual pad (unmentioned = released)")
