// ============================================================
//  FLOW STATE - what the current round is doing right now
// ------------------------------------------------------------
//  Shared by the mode controller (which runs the flow) and the Ai
//  racer mount (which puts the cars in the world). Two parts:
//
//    flow        a plain mutable object read every frame
//    useRoster   a tiny zustand store holding the Ai line-up, so
//                React mounts / unmounts the Ai cars when it
//                changes (a few times per session, never per frame)
// ============================================================

import { create } from 'zustand'
import type { RacerSpec } from './aiRoster'
import type { AiDriver } from './aiDriver'

export type FlowKind = 'none' | 'race' | 'stunt'
export type FlowStage = 'idle' | 'staging' | 'countdown' | 'running' | 'finished'

/** Seconds on the 3-2-1 countdown, and a short settle before it starts counting. */
export const COUNTDOWN_S = 3
export const SETTLE_MS = 250
/** Stunt score attack length, seconds. */
export const STUNT_SECONDS = 90
/** Give up waiting for the Ai cars to appear after this long, and start with whoever is there. */
export const STAGING_TIMEOUT_MS = 5000

export const flow = {
  kind: 'none' as FlowKind,
  stage: 'idle' as FlowStage,
  /** Bumped every time a new round is set up; the Ai mount echoes it back once its cars exist. */
  version: 0,
  stagingSince: 0,
  goAt: 0,
  /** 0 until the countdown is announced (once, when the visible 3 begins), then COUNTDOWN_S. */
  lastCount: 0,
  /** Stunt: score already on the board when the clock started. */
  trickBase: 0,
  propBase: 0,
  /** When the round was paused (0 = not paused), to slide every clock forward on resume. */
  pausedAt: 0,
  /** Set by restartSession: put the player back on the start line when the next round starts. */
  restartToGrid: false,
  /** Position sort / store sync timer. */
  positionTimer: 0,
  /** The player rewound in this race: its time can't be a race record (like a rewound lap). */
  rewound: false,
}

interface RosterState {
  racers: RacerSpec[]
  /** flow.version this line-up belongs to. */
  version: number
  /** Last version whose cars mounted (set by the Ai mount). */
  committed: number
}

export const useRoster = create<RosterState>(() => ({ racers: [], version: 0, committed: -1 }))

/** The live drivers by car id, for the inspector and staging (set by the Ai mount). */
export const drivers = new Map<string, AiDriver>()
