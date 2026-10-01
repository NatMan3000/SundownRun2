// ============================================================
//  PROPS SIGNAL - the multiplayer seam for crash props
// ------------------------------------------------------------
//  CONTRACT (orchestrator-owned). Lifted from v1.
//
//  Crash-prop layouts are deterministic: a layout is a pure function
//  of (track, round). Single player re-scatters on every new round
//  (store.round). In multiplayer that would diverge, so the net
//  layer turns `shared` on and drives `round` itself: everyone boots
//  on the same round, and every synced race start deals a new one.
//
//  Pops flow both ways through here so play never imports net:
//    outgoing - play calls onLocalPop when THIS car bursts a cluster;
//               net broadcasts it.
//    incoming - net queues remote bursts in `pending`; play drains
//               them each frame (burst, no points - the smasher
//               already scored on their own machine).
//
//  Mutable singleton: mutate, never replace.
// ============================================================

export interface PropPop {
  /** Cluster index into the round's deterministic layout. */
  cluster: number
  /** The smashing car's velocity - shapes the burst. */
  vx: number
  vy: number
  vz: number
}

export const propsSignal = {
  /** When true, play scatters from `round` below instead of store.round. */
  shared: false,
  round: 0,
  /** Bumped by net when `round` changes, so play re-scatters. */
  nonce: 0,
  /** Remote bursts waiting to be applied (drained by play). */
  pending: [] as PropPop[],
  /** Set by net; called by play on a local burst. */
  onLocalPop: null as ((pop: PropPop) => void) | null,
}
