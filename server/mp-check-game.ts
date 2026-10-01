// ============================================================
//  TWO-CLIENT CHECK, GAME SECTIONS (used by server/mp-check.ts)
// ------------------------------------------------------------
//  Two real game pages in one headless Chrome:
//    HOST    http://localhost:<port>/?mp=1&...      (loopback -> host)
//    JOINER  http://<lan-ip>:<port>/?mp=1&...       (looks like a 2nd PC)
//
//  The pages are driven like a player would: through the game's own
//  autopilot channel (core/controls driveOverride), which goes through
//  the same steering, tyres and physics as the keyboard. A small
//  page-side pilot (PILOT below) follows the road centreline, or chases
//  another car (for rams and tag).
//
//  Sections:
//    game   join + see each other + host's track reaches the joiner + a ram shoves
//    drawn  a track that exists only in the host's browser reaches the joiner, drivable
//    race   synced countdown, frozen grid, a real lap, finish, same winner on both
//    tag    "it" chosen, "it" rams the other, "it" passes on (both screens agree)
// ============================================================

import type { Page } from 'puppeteer-core'

const flag = (name: string) => process.argv.includes(`--${name}`)

interface Kit {
  hostBase: string
  joinBase: string
  relayPort: number
  track: string
  /** The joiner opens this track first; the host's must replace it. */
  joinTrack: string
  shots: string
  sections: string[]
  check: (name: string, ok: boolean, detail?: unknown) => void
  until: <T>(page: Page, expr: string, ms?: number) => Promise<T | null>
  /** Opens a page in its own browser (one per player, both in the foreground). */
  openPage: (url: string, label: string) => Promise<Page>
  sleep: (ms: number) => Promise<unknown>
}

/**
 * Installed into each page as window.__pilot. Loads the game's own modules
 * (Vite serves them at the same URLs the game uses, so these are the SAME
 * instances the running game holds).
 */
const PILOT = `(async () => {
  if (window.__pilot) return true
  const [tel, controls, current, store, settings, registry, net, rounds] = await Promise.all([
    import('/src/core/telemetry.ts'),
    import('/src/core/controls.ts'),
    import('/src/track/current.ts'),
    import('/src/core/store.ts'),
    import('/src/core/settings.ts'),
    import('/src/track/registry.ts'),
    import('/src/net/netStore.ts'),
    import('/src/net/rounds.ts'),
  ])
  const o = controls.driveOverride
  const frame = { s: 0, position: { x: 0, y: 0, z: 0 }, tangent: {}, up: {}, right: {}, halfWidth: 0, bank: 0, curvature: 0, surface: 'road' }
  // three's Vector3 is needed by frameAt's out object; borrow one from telemetry's vectors.
  const V = tel.telemetry.carPosition.constructor
  frame.position = new V(); frame.tangent = new V(); frame.up = new V(); frame.right = new V()
  const hit = { s: 0, index: 0, lateral: 0, height: 0, distance: 0, onRoad: false }
  let target = null // null = follow the road; a car id = chase that car
  let maxKmh = 140
  let running = false
  function step() {
    if (!running) return
    const t = tel.telemetry
    const track = current.getTrack()
    if (track) {
      let tx, tz
      const chased = target && tel.getCar(target)
      if (chased) {
        tx = chased.position.x; tz = chased.position.z
      } else {
        track.nearest(t.carPosition.x, t.carPosition.y, t.carPosition.z, hit, t.trackS || undefined)
        const ahead = 10 + Math.max(0, t.speedKmh) / 3.6 * 0.6
        track.frameAt(track.wrapS(hit.s + ahead), frame)
        tx = frame.position.x; tz = frame.position.z
      }
      const f = t.carForward, u = t.carUp
      const rx = f.y * u.z - f.z * u.y, ry = f.z * u.x - f.x * u.z, rz = f.x * u.y - f.y * u.x
      const dx = tx - t.carPosition.x, dz = tz - t.carPosition.z
      const side = dx * rx + dz * rz, fwd = dx * f.x + dz * f.z
      o.steer = Math.max(-1, Math.min(1, 2.2 * Math.atan2(side, Math.max(0.1, fwd))))
      const turn = Math.abs(o.steer)
      const want = chased ? maxKmh : maxKmh * (1 - 0.55 * turn)
      o.throttle = t.speedKmh < want ? 1 : 0
      o.brake = t.speedKmh > want + 15 ? 0.6 : 0
      o.handbrake = false
    }
    requestAnimationFrame(step)
  }
  window.__pilot = {
    tel, controls, current, store, settings, registry, net, rounds,
    go(chase, kmh) { target = chase || null; if (kmh) maxKmh = kmh; o.active = true; if (!running) { running = true; requestAnimationFrame(step) } },
    stop() { running = false; o.active = false; o.throttle = 0; o.steer = 0; o.brake = 1 },
    release() { running = false; o.active = false; o.brake = 0 },
    player() { return tel.getCar('player') },
    /** Put our car on the road at distance s, lateral offset, facing the driving direction. */
    place(s, lateral) {
      const track = current.getTrack()
      track.frameAt(track.wrapS(s), frame)
      const p = new V(frame.position.x + frame.right.x * lateral, frame.position.y + frame.up.y * 0.6 + 0.4, frame.position.z + frame.right.z * lateral)
      const q = tel.telemetry.carQuaternion.clone()
      // Face along the tangent. The car model's nose is +z (vehicle/carSim: fwd = (0,0,1)).
      const yaw = Math.atan2(frame.tangent.x, frame.tangent.z)
      q.set(0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2))
      tel.getCar('player').api.teleport(p, q)
      return { x: p.x, y: p.y, z: p.z }
    },
  }
  return true
})()`

export async function runGameChecks(k: Kit): Promise<void> {
  const { check, until, sleep } = k
  const q = `mp=1&relay=${k.relayPort}`
  console.log(`\n== game: two players in a drive on "${k.track}"`)
  // The joiner opens a DIFFERENT track on purpose: the host's must replace it.
  const host = await k.openPage(`${k.hostBase}/?${q}&name=JOSH&track=${k.track}&mode=free`, 'host')
  await sleep(1500)
  const join = await k.openPage(`${k.joinBase}/?${q}&name=DAD&color=orange&track=${k.joinTrack}&mode=free`, 'join')
  for (const p of [host, join]) await p.evaluate(PILOT)

  const hostKey = await until<string>(host, `window.__pilot.current.getTrack()?.key`, 20000)
  const joinKey = await until<string>(join, `(() => { const k = window.__pilot.current.getTrack()?.key; return k === ${JSON.stringify(hostKey)} ? k : null })()`, 20000)
  check("the host's track replaced the joiner's own choice", !!hostKey && joinKey === hostKey, { hostKey, joinKey })
  const mpTrackEvent = await until<boolean>(join, `window.__events.recent.some((e) => e.type === 'mp.track' && e.fromHost)`, 8000)
  check('the joiner emitted mp.track (fromHost)', mpTrackEvent === true)

  const hostSees = await until<{ id: string; name: string }>(host, `(() => { const c = window.__game.cars.find((c) => c.kind === 'remote'); return c ? { id: c.id, name: c.name } : null })()`, 15000)
  const joinSees = await until<{ id: string; name: string; glow: string }>(join, `(() => { const c = window.__game.cars.find((c) => c.kind === 'remote'); return c ? { id: c.id, name: c.name, glow: c.glow } : null })()`, 15000)
  if (!hostSees || !joinSees) {
    console.log('  host net:', JSON.stringify(await host.evaluate(`window.__game.get('net')`)))
    console.log('  join net:', JSON.stringify(await join.evaluate(`window.__game.get('net')`)))
    console.log('  host player car:', await host.evaluate(`!!window.__game.cars.find((c) => c.id === 'player')`), 'phase', await host.evaluate(`window.__game.state.phase`))
  }
  check('host sees the joiner in cars (kind remote)', hostSees?.name === 'DAD', hostSees ?? '')
  check('joiner sees the host in cars (kind remote)', joinSees?.name === 'JOSH', joinSees ?? '')
  const joinGlow = await join.evaluate(`window.__game.settings.glow`)
  check('?color=orange is on the joiner car and in what the host sees', hostSees !== null && joinGlow === (await host.evaluate(`window.__game.cars.find((c) => c.kind === 'remote')?.glow`)), { joinGlow })
  const isHost = [await host.evaluate(`window.__pilot.net.getNet().isHost`), await join.evaluate(`window.__pilot.net.getNet().isHost`)]
  check('isHost: host true, joiner false', isHost[0] === true && isHost[1] === false, isHost)

  if (k.sections.includes('game')) {
    // ---- line up: host in front, joiner 14 m behind it, both stopped ----
    await host.evaluate(`window.__pilot.stop(); window.__pilot.place(60, 0)`)
    await join.evaluate(`window.__pilot.stop(); window.__pilot.place(46, 0)`)
    await sleep(1500)
    await join.screenshot({ path: `${k.shots}/game-joiner-sees-host.png` })
    console.log(`  shot ${k.shots}/game-joiner-sees-host.png`)
    // Further back, so the name tag reads clear of the car's own glow.
    await join.evaluate(`window.__pilot.place(30, 0)`)
    await sleep(1500)
    await join.screenshot({ path: `${k.shots}/game-name-tag.png`, clip: { x: 340, y: 120, width: 600, height: 340 } })
    console.log(`  shot ${k.shots}/game-name-tag.png`)
    const tagInfo = await join.evaluate(`(() => { const c = window.__game.cars.find((c) => c.kind === 'remote'); if (!c || !c.object) return null; const t = c.object.children.find((o) => o.isSprite); return t ? { visible: t.visible, opacity: t.material.opacity, rootVisible: c.object.visible, scale: +t.scale.x.toFixed(2), y: +t.position.y.toFixed(2) } : 'no sprite' })()`)
    console.log(`  name tag: ${JSON.stringify(tagInfo)}`)
    // Smooth motion: sample the remote car's render pose over a second while the host drives.
    await host.evaluate(`window.__pilot.go(null, 60)`)
    const steps = (await join.evaluate(`new Promise((res) => { const out = []; const c = () => window.__game.cars.find((c) => c.kind === 'remote'); let last = c()?.position.clone(); let n = 0; function f() { const p = c()?.position; if (p && last) { out.push(+p.distanceTo(last).toFixed(3)); last.copy(p) } if (++n < 60) requestAnimationFrame(f); else res(out) } requestAnimationFrame(f) })`)) as number[]
    await host.evaluate(`window.__pilot.stop()`)
    const moving = steps.filter((d) => d > 0)
    const maxStep = Math.max(...steps)
    const meanStep = moving.reduce((a, b) => a + b, 0) / Math.max(1, moving.length)
    check('remote car moves smoothly (no frame jumps more than 3x the average step)', moving.length > 40 && maxStep < meanStep * 3 + 0.05, { frames: steps.length, moving: moving.length, meanStep: +meanStep.toFixed(3), maxStep })

    // ---- a teleport is a jump, never a sweep ----
    // The joiner parks on the road; the host teleports from behind it to in
    // front of it. Its body must jump, not sweep through the joiner.
    await host.evaluate(`window.__pilot.stop(); window.__pilot.place(20, 0)`)
    await join.evaluate(`window.__pilot.stop(); window.__pilot.place(50, 0)`)
    await sleep(2000)
    await join.evaluate(`window.__pilot.release()`)
    await sleep(500)
    const parked = (await join.evaluate(`(() => { const p = window.__pilot.tel.telemetry.carPosition; return { x: p.x, z: p.z } })()`)) as { x: number; z: number }
    await host.evaluate(`window.__pilot.place(85, 0)`)
    await sleep(1500)
    const sweptBy = (await join.evaluate(`(() => { const p = window.__pilot.tel.telemetry.carPosition; return +Math.hypot(p.x - ${parked.x}, p.z - ${parked.z}).toFixed(2) })()`)) as number
    check('a remote teleport jumps past a parked car without sweeping it away', sweptBy < 0.5, { joinerMovedM: sweptBy })

    // ---- the ram: joiner sits still, host drives into it ----
    await host.evaluate(`window.__pilot.stop(); window.__pilot.place(40, 0)`)
    await join.evaluate(`window.__pilot.stop(); window.__pilot.place(62, 0)`)
    await sleep(1500)
    // Control: released with nobody near, does the joiner sit still on its own?
    await join.evaluate(`window.__pilot.release()`)
    await sleep(500)
    const before = (await join.evaluate(`(() => { const p = window.__pilot.tel.telemetry.carPosition; return { x: p.x, y: p.y, z: p.z } })()`)) as { x: number; y: number; z: number }
    await sleep(2500)
    const drift = (await join.evaluate(`(() => { const t = window.__pilot.tel.telemetry; const p = t.carPosition; return { m: +Math.hypot(p.x - ${before.x}, p.z - ${before.z}).toFixed(2), kmh: Math.round(t.speedKmh), throttle: t.throttle, brake: t.brake, handbrake: t.handbrake, overrideActive: window.__pilot.controls.driveOverride.active } })()`)) as { m: number }
    console.log(`  control (joiner released, host parked 22 m back): ${JSON.stringify(drift)}`)
    check('control: the released joiner sits still with nobody touching it', drift.m < 0.3, drift)
    await host.evaluate(`window.__pilot.go(window.__game.cars.find((c) => c.kind === 'remote').id, 70)`)
    // Watch the joiner for 8 s: how far it is pushed, its peak speed and impact,
    // and how fast the host was going when it arrived (the ram's strength).
    const watch = join.evaluate(`new Promise((res) => {
      const t = window.__pilot.tel.telemetry
      let moved = 0, peakKmh = 0, peakImpact = 0
      const t0 = performance.now()
      const trace = []; let hitAt = 0
      function f() {
        const d = Math.hypot(t.carPosition.x - ${before.x}, t.carPosition.z - ${before.z})
        if (!hitAt && (t.impact > 0.05 || t.speedKmh > 2)) hitAt = performance.now()
        if (hitAt && trace.length < 60 && (performance.now() - hitAt) >= trace.length * 133) trace.push([Math.round(performance.now() - hitAt), Math.round(t.speedKmh), +t.carPosition.y.toFixed(1), t.airborne ? 1 : 0])
        window.__ramTrace = trace
        moved = Math.max(moved, d); peakKmh = Math.max(peakKmh, t.speedKmh); peakImpact = Math.max(peakImpact, t.impact)
        if (performance.now() - t0 < 8000) requestAnimationFrame(f)
        else res({ moved: +moved.toFixed(2), peakKmh: Math.round(peakKmh), peakImpact: +peakImpact.toFixed(2), hitPeakKmh: Math.max(0, ...trace.filter((p) => p[0] <= 1500).map((p) => p[1])) })
      }
      requestAnimationFrame(f)
    })`)
    // One ram: the host chases until its first bump goes out, then lets go.
    let hostPeak = 0
    let closest = Infinity
    const sentBefore = (await host.evaluate(`window.__game.get('net').bumps.sent`)) as number
    for (let i = 0; i < 80; i++) {
      hostPeak = Math.max(hostPeak, (await host.evaluate(`window.__pilot.tel.telemetry.speedKmh`)) as number)
      const d = (await host.evaluate(`(() => { const r = window.__game.cars.find((c) => c.kind === 'remote'); const p = window.__pilot.tel.telemetry.carPosition; return r ? r.position.distanceTo(p) : 999 })()`)) as number
      closest = Math.min(closest, d)
      if (((await host.evaluate(`window.__game.get('net').bumps.sent`)) as number) > sentBefore) break
      await sleep(100)
    }
    await host.evaluate(`window.__pilot.stop()`)
    console.log(`  ram: closest the host got to the joiner (centres): ${closest.toFixed(2)} m; bumps host ${JSON.stringify(await host.evaluate(`window.__game.get('net').bumps`))} joiner ${JSON.stringify(await join.evaluate(`window.__game.get('net').bumps`))}`)
    const hit = (await watch) as { moved: number; peakKmh: number; peakImpact: number; hitPeakKmh: number }
    if (flag('trace')) console.log(`  ram trace [ms, kmh, y, airborne]: ${JSON.stringify(await join.evaluate('window.__ramTrace'))}`)
    await join.screenshot({ path: `${k.shots}/game-ram.png` })
    await host.evaluate(`window.__pilot.stop()`)
    console.log(`  ram: host reached ${Math.round(hostPeak)} km/h; joiner ${JSON.stringify(hit)}`)
    check('a ram from the host shoves the joiner (pushed over 1 m with its controls untouched)', hit.moved > 1, hit)
    // One ram hands over roughly BUMP_SHARE (0.65) of the closing speed: a shove, not a launch.
    // Judged on the 1.5 s after the hit (later, a coasting car can roll over a boost pad).
    check('the shove is in proportion: in the 1.5 s after the hit the joiner peaks at 35-100% of the rammer speed', hit.hitPeakKmh >= hostPeak * 0.35 && hit.hitPeakKmh <= hostPeak, { hostKmh: Math.round(hostPeak), joinerKmhAfterHit: hit.hitPeakKmh })
    const crashEvt = await join.evaluate(`window.__events.recent.filter((e) => e.type === 'crash').map((e) => e.what)`)
    console.log(`  joiner crash events: ${JSON.stringify(crashEvt)}`)
  }

  if (k.sections.includes('drawn')) {
    console.log('\n== drawn: a track that only exists in the host browser')
    const drawnId = 'josh-drawn-check'
    await host.evaluate(`(() => {
      const P = window.__pilot
      const base = JSON.parse(JSON.stringify(P.current.getCurrentTrackFile()))
      base.id = ${JSON.stringify(drawnId)}
      base.name = 'Josh Drawn Check'
      base.author = 'JOSH'
      // Stretch it so it is genuinely a different road.
      for (const pt of base.road.points) { pt.x *= 1.15; pt.z *= 0.9 }
      P.registry.saveDrawnTrack(base)
      return P.current.setTrackFromFile(base).ok
    })()`)
    const joinDrawn = await until<{ id: string; source: string; key: string }>(join, `(() => { const t = window.__pilot.current.getTrack(); return t && t.name === 'Josh Drawn Check' ? { id: t.id, source: window.__pilot.registry.getTrackSource(t.id), key: t.key } : null })()`, 20000)
    const hostDrawnKey = await host.evaluate(`window.__pilot.current.getTrack()?.key`)
    const joinHasLocal = await join.evaluate(`(() => { try { return !!JSON.parse(localStorage.getItem('sr2.tracks.drawn.v1') || '{}')[${JSON.stringify(drawnId)}] } catch { return false } })()`)
    check('the drawn track was never in the joiner browser storage', joinHasLocal === false)
    check('the drawn track reached the joiner as a shared track with the same key', !!joinDrawn && joinDrawn.source === 'shared' && joinDrawn.key === hostDrawnKey, { joinDrawn, hostDrawnKey })
    // Drivable: follow the road for 8 s and stay on it.
    await sleep(2500)
    await join.evaluate(`window.__pilot.place(20, 0)`)
    await sleep(800)
    await join.evaluate(`window.__pilot.go(null, 90)`)
    await sleep(8000)
    const drive = (await join.evaluate(`(() => { const t = window.__pilot.tel.telemetry; return { kmh: Math.round(t.speedKmh), onRoad: t.onRoad, s: Math.round(t.trackS) } })()`)) as { kmh: number; onRoad: boolean; s: number }
    await join.screenshot({ path: `${k.shots}/drawn-joiner-driving.png` })
    await join.evaluate(`window.__pilot.stop()`)
    check('the joiner drives the drawn track (moving, on the road, made progress)', drive.kmh > 30 && drive.onRoad && drive.s > 60, drive)
    const seeEach = await until<boolean>(host, `window.__game.cars.some((c) => c.kind === 'remote')`, 8000)
    check('on the drawn track they still see each other', !!seeEach)
  }

  if (k.sections.includes('race')) {
    console.log('\n== race: G on the host starts a synced race')
    for (const p of [host, join]) await p.evaluate(`window.__pilot.stop(); window.__pilot.settings.useSettings.getState().set('raceLaps', 1)`)
    // Laps come from the track file when it sets them; the check reads what was actually used.
    await host.evaluate(`window.__pilot.rounds.requestStart()`)
    const hostRound = await until<{ grid: number[]; raceId: number; laps: number }>(host, `(() => { const r = window.__pilot.rounds.currentRound(); return r && r.kind === 'race' ? { grid: r.grid, raceId: r.raceId, laps: r.laps } : null })()`, 3000)
    const joinRound = await until<{ grid: number[]; raceId: number }>(join, `(() => { const r = window.__pilot.rounds.currentRound(); return r && r.kind === 'race' ? { grid: r.grid, raceId: r.raceId } : null })()`, 3000)
    check('both are in the same race with the same grid', !!hostRound && joinRound?.raceId === hostRound.raceId && JSON.stringify(joinRound?.grid) === JSON.stringify(hostRound.grid), { hostRound, joinRound })
    const states = [await host.evaluate(`window.__game.state.raceState`), await join.evaluate(`window.__game.state.raceState`)]
    check('both count down', states[0] === 'countdown' && states[1] === 'countdown', states)
    // Frozen on the grid: trying to drive during the countdown goes nowhere.
    await join.evaluate(`window.__pilot.go(null, 100)`)
    await sleep(1200)
    const frozenKmh = await join.evaluate(`window.__pilot.tel.telemetry.speedKmh`)
    check('cars are frozen during the countdown', (frozenKmh as number) < 2, { kmh: frozenKmh })
    await join.screenshot({ path: `${k.shots}/race-countdown-joiner.png` })
    const goAts = [await host.evaluate(`window.__game.state.raceGoAt - performance.now()`), await join.evaluate(`window.__game.state.raceGoAt - performance.now()`)] as number[]
    check('GO lands within 150 ms on both screens', Math.abs(goAts[0] - goAts[1]) < 150, { goInMs: goAts.map(Math.round) })
    await host.evaluate(`window.__pilot.go(null, 120)`)
    const running = await until<boolean>(join, `window.__game.state.raceState === 'running'`, 5000)
    check('GO: the race runs', !!running)
    // Let the host win: the joiner backs off to a cruise.
    await join.evaluate(`window.__pilot.go(null, 70)`)
    const laps = hostRound?.laps ?? 1
    const done = await until<boolean>(host, `window.__game.state.raceState === 'finished'`, 240000 * laps)
    const results = [await host.evaluate(`window.__game.state.raceResults.map((r) => [r.position, r.name, r.ms])`), await join.evaluate(`window.__game.state.raceResults.map((r) => [r.position, r.name, r.ms])`)] as unknown[][][]
    await host.screenshot({ path: `${k.shots}/race-results-host.png` })
    await join.screenshot({ path: `${k.shots}/race-results-joiner.png` })
    check(`a real ${laps}-lap race finished on the host`, !!done, results[0])
    const joinDone = await until<boolean>(join, `window.__game.state.raceState === 'finished'`, 60000)
    check('the joiner gets results too, with the same winner', !!joinDone && results[1]?.[0]?.[1] === results[0]?.[0]?.[1], { host: results[0], joiner: await join.evaluate(`window.__game.state.raceResults.map((r) => [r.position, r.name, r.ms])`) })
    const props = [await host.evaluate(`(async () => (await import('/src/core/propsSignal.ts')).propsSignal.round)()`), await join.evaluate(`(async () => (await import('/src/core/propsSignal.ts')).propsSignal.round)()`)]
    check('the race dealt one shared crash-prop round to both', props[0] === props[1] && props[0] !== 0, props)
    for (const p of [host, join]) await p.evaluate(`window.__pilot.stop()`)
  }

  if (k.sections.includes('tag')) {
    console.log('\n== tag: G in tag mode starts a round; "it" passes on contact')
    for (const p of [host, join]) await p.evaluate(`(async () => { window.__pilot.stop(); (await import('/src/core/session.ts')).resumeGame(); window.__pilot.store.useGame.setState({ mode: 'tag' }) })()`)
    await sleep(500)
    await host.evaluate(`window.__pilot.rounds.requestStart()`)
    const it0 = await until<{ itId: number; grid: number[] }>(join, `(() => { const r = window.__pilot.rounds.currentRound(); return r && r.kind === 'tag' ? { itId: r.itId, grid: r.grid } : null })()`, 3000)
    const hostIt0 = await host.evaluate(`window.__pilot.rounds.currentRound()?.itId`)
    check('both agree who starts as "it"', !!it0 && it0.itId === hostIt0, { joiner: it0, host: hostIt0 })
    await until<boolean>(join, `window.__game.state.raceState === 'running'`, 6000)
    // The "it" page chases the other; the other sits still.
    const hostId = await host.evaluate(`window.__pilot.net.getNet().myId`)
    const itPage = it0?.itId === hostId ? host : join
    const otherPage = itPage === host ? join : host
    const otherId = await otherPage.evaluate(`window.__pilot.net.getNet().myId`)
    await otherPage.evaluate(`window.__pilot.stop(); window.__pilot.place(80, 0)`)
    await itPage.evaluate(`window.__pilot.stop(); window.__pilot.place(55, 0)`)
    await sleep(2600) // past the no-tag-back window the start gives nobody, and settle
    const itGlow = await otherPage.evaluate(`window.__game.cars.find((c) => c.kind === 'remote')?.isIt`)
    check('the other screen marks the "it" car (isIt)', itGlow === true)
    await otherPage.evaluate(`window.__pilot.release()`)
    await itPage.evaluate(`window.__pilot.go('net-${otherId}', 60)`)
    const passed = await until<number>(otherPage, `(() => { const r = window.__pilot.rounds.currentRound(); return r && r.itId === ${otherId} ? r.seq : 0 })()`, 15000)
    await itPage.evaluate(`window.__pilot.stop()`)
    const itAgree = [await host.evaluate(`window.__pilot.rounds.currentRound()?.itId`), await join.evaluate(`window.__pilot.rounds.currentRound()?.itId`)]
    check('"it" passed on by contact, and both screens agree', !!passed && itAgree[0] === otherId && itAgree[1] === otherId, { seq: passed, itAgree, expected: otherId })
    const tagEvt = await otherPage.evaluate(`window.__events.recent.filter((e) => e.type === 'tag.it').map((e) => e.id)`)
    check('tag.it events fired', Array.isArray(tagEvt) && (tagEvt as unknown[]).length >= 2, tagEvt)
    const noBack = await otherPage.evaluate(`window.__pilot.rounds.canTag()`)
    check('no tag-backs right after the hand-over', noBack === false)
    await otherPage.screenshot({ path: `${k.shots}/tag-new-it.png` })
    const secs = await host.evaluate(`window.__game.state.tagSeconds`)
    console.log(`  tagSeconds on host: ${JSON.stringify(secs)}`)
  }

  await host.close()
  await join.close()
}
