// ============================================================
//  MODE RULES - what is switched on in each game mode
// ------------------------------------------------------------
//  One small table so nobody has to hunt through the code to find
//  out why the crates vanished in time trial. The mode controller
//  (ModeController.tsx) reads this when a round starts and copies
//  the answer into `playFlags`, which every play system checks.
//
//    free       props, smashables, the core hunt, speed traps
//    timetrial  a clean track: no props, no cores (smashables stay)
//    race       props and smashables stay (chaos is fun), no hunt
//    stunt      props count toward the score, no hunt
//    tag        multiplayer: props and smashables, no hunt
// ============================================================

import type { GameMode } from '../core/store'

export interface ModeFeatures {
  props: boolean
  smashables: boolean
  cores: boolean
  speedTraps: boolean
}

export function featuresFor(mode: GameMode): ModeFeatures {
  switch (mode) {
    case 'free':
      return { props: true, smashables: true, cores: true, speedTraps: true }
    case 'timetrial':
      return { props: false, smashables: true, cores: false, speedTraps: true }
    case 'race':
      return { props: true, smashables: true, cores: false, speedTraps: true }
    case 'stunt':
      return { props: true, smashables: true, cores: false, speedTraps: true }
    case 'tag':
      return { props: true, smashables: true, cores: false, speedTraps: true }
  }
}

/**
 * Live flags for this round. A mutable singleton (no React state), read
 * by the play systems every frame. Written only by the mode controller.
 */
export const playFlags: ModeFeatures & {
  /** The round number the layouts are rolled from (store.round, or propsSignal.round in multiplayer). */
  layoutRound: number
} = {
  props: true,
  smashables: true,
  cores: true,
  speedTraps: true,
  layoutRound: 0,
}
