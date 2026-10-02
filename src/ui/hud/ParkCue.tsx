// ============================================================
//  PARK CUE - "hit it at 98", above the speedo
// ------------------------------------------------------------
//  While you're lined up on a stunt-park launch (a kicker, the
//  sky table, a gap jump, the mega ramp), this small panel says
//  which one, the speed painted on its face (the speed to leave
//  its lip at), and how you're doing against it:
//
//    Faster     you're too slow to make its rings or bullseye
//    On speed   within a few km/h: hold it there up the ramp
//    Ease off   too fast: you'll fly past them
//
//  The park works out the cue (src/play/stunts/parkCue.ts) and
//  announces it on the event feed only when it changes, so this
//  re-renders a few times a run, never per frame (feed.ts keeps it).
// ============================================================

import { useFeed } from './feed'

const BAND_TEXT = { slow: 'Faster', on: 'On speed', fast: 'Ease off' } as const

export function ParkCue() {
  const cue = useFeed((s) => s.lineup)
  if (!cue) return null
  const say = BAND_TEXT[cue.band]
  return (
    <div key={`${cue.label}:${cue.kmh}`} className={`hud-cue is-${cue.band}`} role="status" aria-label={`${cue.label}: hit it at ${cue.kmh} kilometres an hour. ${say}`}>
      <span className="hud-label">{cue.label}</span>
      <span className="hud-cue__row">
        <span className="hud-cue__band">{say}</span>
        <span className="hud-cue__kmh">
          {cue.kmh}
          <i>km/h</i>
        </span>
      </span>
    </div>
  )
}
