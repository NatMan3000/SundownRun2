// ============================================================
//  AI RACERS - puts the Ai cars in the world
// ------------------------------------------------------------
//  Mounts one vehicle <SimCar> per racer in the current line-up
//  (flow.ts useRoster) and gives each one an AiDriver brain. The
//  cars are the very same simulation as yours, so they are solid,
//  they bump, and they can crash.
//
//  When the line-up changes (a new race, a restart), the old cars
//  unmount and the new ones mount; once they exist this component
//  tells the mode controller (roster.committed) so it can line them
//  up on the grid and start the countdown.
//
//  Each brain also joins the rewind recorder, so a rewind puts its
//  plans and its stuck watchdog back with its car.
// ============================================================

import { useEffect, useMemo } from 'react'
import { addRewindPart, SimCar } from '../vehicle'
import { AiDriver } from './aiDriver'
import { drivers, useRoster } from './flow'

export function AiRacers() {
  const racers = useRoster((s) => s.racers)
  const version = useRoster((s) => s.version)

  const brains = useMemo(
    () => racers.map((r, i) => new AiDriver(r.id, r.personality, i * 2.399963)),
    // a new line-up (new version) always gets fresh brains
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [racers, version],
  )

  useEffect(() => {
    const offs = brains.map((b) =>
      addRewindPart({ size: AiDriver.REWIND_FLOATS, save: (out, at) => b.saveRewind(out, at), load: (src, at) => b.loadRewind(src, at) }),
    )
    return () => offs.forEach((off) => off())
  }, [brains])

  useEffect(() => {
    drivers.clear()
    for (const b of brains) drivers.set(b.id, b)
    // Child effects (the SimCars registering themselves) have run by now.
    useRoster.setState({ committed: version })
    return () => {
      for (const b of brains) if (drivers.get(b.id) === b) drivers.delete(b.id)
    }
  }, [brains, version])

  return (
    <>
      {racers.map((r, i) => (
        <SimCar
          key={`${version}:${r.id}`}
          id={r.id}
          name={r.name}
          body={r.body}
          paint={r.paint}
          glow={r.glow}
          trail={r.trail}
          gridSlot={r.gridSlot}
          driver={brains[i]}
        />
      ))}
    </>
  )
}
