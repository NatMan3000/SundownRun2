// ============================================================
//  CONTROLS CONTRACT - what the input system hands the game
// ------------------------------------------------------------
//  CONTRACT (orchestrator-owned). src/core/input.ts (vehicle
//  worker) polls the keyboard and the Gamepad API and writes into
//  these singletons; everything else reads them. Nobody else
//  touches window keyboard events for driving or menu navigation.
//
//  Context decides where input goes:
//    'drive'  - driveInput is live, menu actions are not emitted
//               (except 'pause').
//    'menu'   - driveInput reads zero (arrow keys must NEVER leak into
//               throttle); menu actions are emitted on menuBus.
//    'editor' - the editor owns the mouse/keyboard; driveInput zero.
//    'text'   - a text field has focus; nothing is captured.
// ============================================================

export type InputContext = 'drive' | 'menu' | 'editor' | 'text'
export type InputDevice = 'keyboard' | 'gamepad'

/** The player's driving input after smoothing and response curves. */
export const driveInput = {
  throttle: 0, // 0..1
  brake: 0, //    0..1 (also reverse when stopped)
  steer: 0, //    -1..1, left negative
  handbrake: false,
  /** Held: the world runs backwards (rewind). Backspace / LB, only in the 'drive' context. */
  rewind: false,
  /** Whichever device was touched last (hot-swap, no config). */
  device: 'keyboard' as InputDevice,
}

/**
 * Autopilot channel (demo drive, test harness). When active, the player's
 * car takes these values instead of driveInput - through the same steering
 * rack and tyre model, so nothing is bypassed.
 */
export const driveOverride = {
  active: false,
  throttle: 0,
  brake: 0,
  steer: 0,
  handbrake: false,
}

/**
 * Edge-triggered commands. Each is a nonce: the input system increments it
 * once per press; a consumer remembers the last value it saw and acts when
 * it changes. (Holding a button fires once.)
 */
export const controlSignals = {
  reset: 0, //        R / Y        - back to the road
  restart: 0, //      Shift+R / View - back to the start line
  cameraCycle: 0, //  C / RB
  pause: 0, //        Esc / Menu   - fires in every context
  screenshot: 0, //   F9 (dev)     - capture the canvas
  race: 0, //         G / X        - multiplayer: start a synced race / tag round
  nextSong: 0, //     N / B        - music: skip to another song (drive context)
}

/** Current input routing. Set by the UI / phase logic. */
export const inputState = {
  context: 'menu' as InputContext,
}

export function setInputContext(ctx: InputContext): void {
  inputState.context = ctx
}

export type MenuAction = 'up' | 'down' | 'left' | 'right' | 'accept' | 'back' | 'tabPrev' | 'tabNext'

type MenuListener = (action: MenuAction, device: InputDevice) => void
const menuListeners = new Set<MenuListener>()

/**
 * Menu navigation bus. Keyboard: arrows/WASD, Enter/Space accept,
 * Esc/Backspace back, Q/E tabs. Pad: d-pad / left stick (with repeat),
 * A accept, B back, LB/RB tabs. Emitted only in the 'menu' context.
 */
export const menuBus = {
  emit(action: MenuAction, device: InputDevice): void {
    for (const fn of menuListeners) fn(action, device)
  },
  on(fn: MenuListener): () => void {
    menuListeners.add(fn)
    return () => {
      menuListeners.delete(fn)
    }
  },
}
