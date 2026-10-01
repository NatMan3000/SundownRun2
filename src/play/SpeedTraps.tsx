// ============================================================
//  SPEED TRAPS - how fast were you going, right there?
// ------------------------------------------------------------
//  A speed trap is a point along the road (track.speedTraps, by s).
//  When the player's distance along the road crosses it, moving
//  forward, we read the speedometer: that reading goes on the HUD
//  (store.trapLastKmh), and if it's your best on this track it is
//  saved (store.trapBestKmh, records.trapBestKmh).
//
//  A reset or a restart jumps the car along the road; a jump that
//  big is ignored, so teleporting past a trap never records a speed.
//  The look worker draws the trap's marker; this is only the timing.
// ============================================================

import { useFrame } from '@react-three/fiber'
import { telemetry } from '../core/telemetry'
import { getGame, useGame } from '../core/store'
import { emit } from '../core/events'
import { offerRecord } from '../core/records'
import { getTrack } from '../track/current'
import { playFlags } from './modes'

/** A jump along the road bigger than this in one frame is a teleport, not driving. */
const MAX_JUMP_M = 40

const trap = { lastS: -1, version: -1 }

export function SpeedTraps() {
  useFrame((_, delta) => {
    const track = getTrack()
    if (!track || track.speedTraps.length === 0 || !playFlags.speedTraps) {
      trap.lastS = -1
      return
    }
    const g = getGame()
    if (g.trackVersion !== trap.version) {
      trap.version = g.trackVersion
      trap.lastS = -1
    }
    const s = telemetry.trackS
    if (g.phase !== 'playing' || trap.lastS < 0) {
      trap.lastS = s
      return
    }
    const ds = track.deltaS(trap.lastS, s)
    const prev = trap.lastS
    trap.lastS = s
    const maxStep = Math.max(MAX_JUMP_M, Math.abs(telemetry.forwardSpeed) * Math.min(delta, 0.1) * 4)
    if (ds <= 0 || ds > maxStep || telemetry.forwardSpeed <= 0) return

    for (let i = 0; i < track.speedTraps.length; i++) {
      const ts = track.speedTraps[i].s
      // crossed if the trap lies in (prev, prev + ds] along the road
      const ahead = track.deltaS(prev, ts)
      if (ahead > 0 && ahead <= ds) {
        const kmh = Math.round(telemetry.speedKmh)
        const { best, previous } = offerRecord(track.key, 'trapBestKmh', kmh)
        useGame.setState({ trapLastKmh: kmh, trapBestKmh: best ? kmh : previous })
        emit('speedtrap', { kmh, best, previousBestKmh: previous })
      }
    }
  })
  return null
}
