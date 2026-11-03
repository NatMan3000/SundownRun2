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
//    sametrack the host drives a track the joiner downloaded from Shared tracks (same id,
//           different file): same key and world, each sees the other, G puts both on the grid
//    race   synced countdown, frozen grid, a real lap, finish, same winner on both
//    tag    "it" chosen, "it" rams the other, "it" passes on, the round ends, results agree
//    props  a crash-prop burst on one screen bursts on the other
//    leave  leaving a race mid-way (mode change) frees G; a tag started meanwhile picks you up
//    turns  Hunt Turns in the Thunder Bowl: everyone starts far apart, both agree who hunts, a
//           catch by reach (no contact) counts on both screens, the runner is thrown 100 m+,
//           the 2 s fresh-chase window holds, the tag pulse catches a runner 12 m ahead but not
//           12 m behind, the turn swaps, and the round ends with the same results on both
//           (D8 points: a runner's points rise and agree on both screens, a hunter's tricks
//           score nothing, a catch gives the hunter 500 and wipes only the runner's last few
//           seconds, the winner is the most points even with fewer catches); a player leaving ends it
//    robust a 3rd player arriving mid-round, three players, reconnects mid-round
//           and mid-race, the host reloading its page
// ============================================================

import type { Page } from 'puppeteer-core'

const flag = (name: string) => process.argv.includes(`--${name}`)

interface Kit {
  hostBase: string
  joinBase: string
  /** Added to every page address to find the relay ('&relay=5218' on LAN, '' online). */
  relayQuery: string
  track: string
  /** The joiner opens this track first; the host's must replace it. */
  joinTrack: string
  shots: string
  sections: string[]
  check: (name: string, ok: boolean, detail?: unknown) => void
  until: <T>(page: Page, expr: string, ms?: number) => Promise<T | null>
  /** Opens a page in its own browser (one per player, both in the foreground). */
  openPage: (url: string, label: string, preload?: string) => Promise<Page>
  sleep: (ms: number) => Promise<unknown>
}

/**
 * Installed into each page as window.__pilot. Loads the game's own modules
 * through net's dev kit, window.__game.get('netKit'), so it works on the dev
 * server and on a built preview alike).
 */
const PILOT = `(async () => {
  if (window.__pilot) return true
  // The game's own handles, from net's dev kit (present in dev AND built previews).
  let K = null
  for (let i = 0; i < 200 && !K; i++) {
    K = window.__game && window.__game.get('netKit')
    if (!K) await new Promise((r) => setTimeout(r, 100))
  }
  if (!K) throw new Error('netKit not registered: is this a multiplayer page (?mp=1) with a track loaded?')
  const tel = { telemetry: K.telemetry, getCar: K.getCar }
  const controls = { driveOverride: K.driveOverride }
  const current = { getTrack: K.getTrack, getCurrentTrackFile: K.getCurrentTrackFile, setTrackFromFile: K.setTrackFromFile, loadTrackById: K.loadTrackById }
  const store = { useGame: K.useGame }
  const settings = { useSettings: K.useSettings }
  const registry = { saveDrawnTrack: K.saveDrawnTrack, getTrackSource: K.getTrackSource }
  const net = { getNet: K.net.getNet }
  const rounds = K.rounds
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
    K, tel, controls, current, store, settings, registry, net, rounds,
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

/**
 * Per-frame sampler: the closest any other (remote) car is DRAWN to our own
 * car, every frame, from when it starts. Read with window.__closest.
 * As a preload it runs from the page's very first frame.
 */
const CLOSEST_SAMPLER = `(() => {
  const S = (window.__closest = { min: Infinity, frames: 0, under4: 0, worst: null })
  function f() {
    const g = window.__game
    const cars = g && g.cars
    if (cars) {
      const me = cars.find((c) => c.kind === 'player')
      if (me) {
        for (const c of cars) {
          if (c.kind !== 'remote' || !c.object || !c.object.visible) continue
          const d = c.position.distanceTo(me.position)
          S.frames++
          if (d < 4) S.under4++
          if (d < S.min) { S.min = d; S.worst = { t: Math.round(performance.now()), d: +d.toFixed(2) } }
        }
      }
    }
    requestAnimationFrame(f)
  }
  requestAnimationFrame(f)
})()`

/** Start a fresh closest-car sample on an already-loaded page. */
const resetClosest = (p: Page) => p.evaluate(`window.__closest ? Object.assign(window.__closest, { min: Infinity, frames: 0, under4: 0, worst: null }) : (${CLOSEST_SAMPLER}, true)`)
const readClosest = (p: Page) => p.evaluate(`(() => { const c = window.__closest; return c ? { min: c.min === Infinity ? null : +c.min.toFixed(2), frames: c.frames, under4: c.under4, worst: c.worst } : null })()`) as Promise<{ min: number | null; frames: number; under4: number } | null>

export async function runGameChecks(k: Kit): Promise<void> {
  const { check, until, sleep } = k
  const q = `mp=1${k.relayQuery}&tagSeconds=25&turnSeconds=40`
  console.log(`\n== game: two players in a drive on "${k.track}"`)
  // The joiner opens a DIFFERENT track on purpose: the host's must replace it.
  const host = await k.openPage(`${k.hostBase}/?${q}&name=JOSH&track=${k.track}&mode=free`, 'host', CLOSEST_SAMPLER)
  await sleep(1500)
  await resetClosest(host)
  const join = await k.openPage(`${k.joinBase}/?${q}&name=DAD&color=orange&track=${k.joinTrack}&mode=free`, 'join', CLOSEST_SAMPLER)
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

  if (k.sections.includes('spawn')) await spawnChecks(k, host, join)

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
    // The rammer's own speed through the hit (mp-1's D2: it used to stop dead and bounce back).
    const rammerWatch = host.evaluate(`new Promise((res) => {
      const t = window.__pilot.tel.telemetry
      const sent0 = window.__game.get('net').bumps.sent
      let last = 0, hitAt = 0, before = 0, minAfter = 999, after = 0, backwards = false
      const t0 = performance.now()
      function f() {
        const sent = window.__game.get('net').bumps.sent
        if (!hitAt && sent > sent0) { hitAt = performance.now(); before = last }
        if (hitAt) {
          const fwd = t.forwardSpeed * 3.6
          minAfter = Math.min(minAfter, fwd)
          if (fwd < -0.5) backwards = true
          if (performance.now() - hitAt < 120) after = fwd
        }
        last = t.speedKmh
        if (performance.now() - t0 < 9000 && (!hitAt || performance.now() - hitAt < 600)) requestAnimationFrame(f)
        else res(hitAt ? { before: Math.round(before), after: Math.round(after), minAfter: Math.round(minAfter), backwards } : null)
      }
      requestAnimationFrame(f)
    })`)
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
    const rammer = (await rammerWatch) as { before: number; after: number; minAfter: number; backwards: boolean } | null
    if (flag('trace')) console.log(`  ram trace [ms, kmh, y, airborne]: ${JSON.stringify(await join.evaluate('window.__ramTrace'))}`)
    await join.screenshot({ path: `${k.shots}/game-ram.png` })
    await host.evaluate(`window.__pilot.stop()`)
    console.log(`  ram: host reached ${Math.round(hostPeak)} km/h; joiner ${JSON.stringify(hit)}`)
    check('a ram from the host shoves the joiner (pushed over 1 m with its controls untouched)', hit.moved > 1, hit)
    // One ram hands over roughly BUMP_SHARE (0.65) of the closing speed: a shove, not a launch.
    // Judged on the 1.5 s after the hit (later, a coasting car can roll over a boost pad).
    check('the shove is in proportion: in the 1.5 s after the hit the joiner peaks at 35-100% of the rammer speed', hit.hitPeakKmh >= hostPeak * 0.35 && hit.hitPeakKmh <= hostPeak, { hostKmh: Math.round(hostPeak), joinerKmhAfterHit: hit.hitPeakKmh })
    // The rammer keeps its share: about 35% of its speed carries on (no dead stop, no bounce back).
    check('the rammer carries on (keeps 15-60% of its speed, never goes backwards)', !!rammer && rammer.after >= rammer.before * 0.15 && rammer.after <= rammer.before * 0.6 && !rammer.backwards, rammer)
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

  if (k.sections.includes('sametrack')) await sameTrackChecks(k, host, join)

  if (k.sections.includes('race')) {
    console.log('\n== race: G on the JOINER starts a synced race, with the host\'s laps')
    // The joiner wants 3 laps, the host 1: the host's number decides (D2), whoever presses G.
    await host.evaluate(`window.__pilot.stop(); window.__pilot.settings.useSettings.getState().set('raceLaps', 1)`)
    await join.evaluate(`window.__pilot.stop(); window.__pilot.settings.useSettings.getState().set('raceLaps', 3)`)
    const heard = await until<number>(join, `window.__pilot.net.getNet().hostLaps === 1 ? 1 : 0`, 3000)
    check('the joiner hears the host\'s Laps setting', heard === 1, { hostLaps: await join.evaluate(`window.__pilot.net.getNet().hostLaps`) })
    // Far apart before the start (mp-2's repro for the countdown gap).
    await host.evaluate(`window.__pilot.place(window.__pilot.current.getTrack().length * 0.3, 0)`)
    await join.evaluate(`window.__pilot.place(window.__pilot.current.getTrack().length * 0.05, 0)`)
    await sleep(2500)
    // Every frame on both screens for 12 s: wall time, race state, position, gap text.
    const RECORD = `new Promise((res) => {
      const out = []
      const t0 = performance.now()
      function f() {
        const g = window.__game.state
        out.push([Date.now(), g.raceState, g.racePosition, (document.querySelector('[data-hud="raceGap"]')?.textContent || '').trim()])
        if (performance.now() - t0 < 12000) requestAnimationFrame(f)
        else res(out)
      }
      requestAnimationFrame(f)
    })`
    const recs = Promise.all([host.evaluate(RECORD), join.evaluate(RECORD)]) as Promise<[number, string, number, string][][]>
    // Laps come from the track file when it sets them; the check reads what was actually used.
    await join.evaluate(`window.__pilot.rounds.requestStart()`)
    const hostRound = await until<{ grid: number[]; raceId: number; laps: number }>(host, `(() => { const r = window.__pilot.rounds.currentRound(); return r && r.kind === 'race' ? { grid: r.grid, raceId: r.raceId, laps: r.laps } : null })()`, 3000)
    const joinRound = await until<{ grid: number[]; raceId: number }>(join, `(() => { const r = window.__pilot.rounds.currentRound(); return r && r.kind === 'race' ? { grid: r.grid, raceId: r.raceId } : null })()`, 3000)
    const fileLaps = await host.evaluate(`window.__pilot.current.getTrack().file.laps ?? null`)
    check('the race uses the host\'s laps, not the joiner\'s (or the track\'s own)', !!hostRound && hostRound.laps === (fileLaps ?? 1), { laps: hostRound?.laps, fileLaps })
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
    // Close racing, as mp-2: 97 against 92 km/h.
    await host.evaluate(`window.__pilot.go(null, 97)`)
    await join.evaluate(`window.__pilot.go(null, 92)`)
    const running = await until<boolean>(join, `window.__game.state.raceState === 'running'`, 5000)
    check('GO: the race runs', !!running)
    const [hostRec, joinRec] = await recs
    // Countdown, every frame: never a gap over 1 s (they sit side by side on the grid).
    const countdownGaps = [hostRec, joinRec].map((rec) => rec.filter((x) => x[1] === 'countdown').map((x) => Number((x[3].match(/([0-9.]+) s/) || [])[1] ?? 0)))
    const worstGap = countdownGaps.map((g) => (g.length ? Math.max(...g) : -1))
    const worstText = [hostRec, joinRec].map((rec) => rec.filter((x) => x[1] === 'countdown').map((x) => x[3]).find((t) => Number((t.match(/([0-9.]+) s/) || [])[1] ?? 0) >= 1) ?? null)
    check('countdown, every frame on both screens: no gap of 1 s or more (mp-2 D1)', worstGap.every((g) => g >= 0 && g < 1), { worstGapS: worstGap, frames: countdownGaps.map((g) => g.length), firstBad: worstText })
    // After GO, every frame: how long do both screens claim the same place at the same wall time?
    const at = (rec: [number, string, number, string][], t: number) => {
      let v = rec[0]
      for (const x of rec) { if (x[0] > t) break; v = x }
      return v
    }
    const goWall = Math.max(hostRec.find((x) => x[1] === 'running')?.[0] ?? Infinity, joinRec.find((x) => x[1] === 'running')?.[0] ?? Infinity)
    let clashStart = 0
    let longest = 0
    let clashes = 0
    const end = Math.min(hostRec[hostRec.length - 1][0], joinRec[joinRec.length - 1][0])
    for (let t = goWall; t <= end; t += 10) {
      const same = at(hostRec, t)[2] === at(joinRec, t)[2]
      if (same && !clashStart) { clashStart = t; clashes++ }
      if (!same && clashStart) { longest = Math.max(longest, t - clashStart); clashStart = 0 }
    }
    if (clashStart) longest = Math.max(longest, end - clashStart)
    check('after GO, every 10 ms for the recorded window: the two screens never claim the same place for 0.5 s or more (mp-2 D2)', Number.isFinite(goWall) && longest < 500, { windowS: Number.isFinite(goWall) ? +((end - goWall) / 1000).toFixed(1) : null, clashes, longestMs: longest })
    // Then let the host pull away: the joiner backs off to a cruise.
    await host.evaluate(`window.__pilot.go(null, 140)`)
    await join.evaluate(`window.__pilot.go(null, 90)`)
    const laps = hostRound?.laps ?? 1
    const done = await until<boolean>(host, `window.__game.state.raceState === 'finished'`, 180000 * laps)
    if (!done) {
      console.log('  host lap state:', JSON.stringify(await host.evaluate(`(() => { const g = window.__game.state; const t = window.__game.telemetry; return { lapCount: g.lapCount, lapStartedAt: g.lapStartedAt, dirty: g.currentLapDirty, sectors: g.sectorsPassed + '/' + g.sectorCount, s: Math.round(t.trackS), kmh: Math.round(t.speedKmh), onRoad: t.onRoad, round: window.__game.get('net').round } })()`)))
    }
    // The host crossed first: its results screen opens at once, while the joiner is still racing.
    const early = { hostPhase: await host.evaluate(`window.__game.state.phase`), hostWaiting: await host.evaluate(`window.__pilot.rounds.waitingForRacers()`), joinState: await join.evaluate(`window.__game.state.raceState`), hostAgain: await host.evaluate(`window.__pilot.rounds.requestStart()`) }
    check('the first to finish sees results straight away, while the other is still racing, and "Again" waits', !!done && early.hostPhase === 'results' && early.hostWaiting === true && early.joinState === 'running' && early.hostAgain === false, early)
    const joinDone = await until<boolean>(join, `window.__game.state.raceState === 'finished'`, 60000)
    // Results read AFTER the race has ended on both; an empty list never counts as agreement.
    await Promise.all([host, join].map((p) => until<boolean>(p, `!!window.__pilot.rounds.currentRound()?.ended`, 10000)))
    const resultsOf = (p: Page) => p.evaluate(`window.__game.state.raceResults.map((r) => [r.position, r.name, r.ms])`) as Promise<[number, string, number | null][]>
    const hostResults = await resultsOf(host)
    const joinResults = await resultsOf(join)
    await host.screenshot({ path: `${k.shots}/race-results-host.png` })
    await join.screenshot({ path: `${k.shots}/race-results-joiner.png` })
    check(`a real ${laps}-lap race finished on the host`, !!done, hostResults)
    check('the joiner gets results too, with the same finishing order', !!joinDone && hostResults.length === 2 && joinResults.length === 2 && hostResults.map((r) => r[1]).join() === joinResults.map((r) => r[1]).join(), { host: hostResults, joiner: joinResults })
    check('the winner has a finishing time', typeof hostResults[0]?.[2] === 'number', hostResults[0])
    const props = [await host.evaluate(`window.__pilot.K.propsSignal.round`), await join.evaluate(`window.__pilot.K.propsSignal.round`)]
    check('the race dealt one shared crash-prop round to both', props[0] === props[1] && props[0] !== 0, props)
    for (const p of [host, join]) await p.evaluate(`window.__pilot.stop()`)
  }

  if (k.sections.includes('tag')) {
    console.log('\n== tag: G in tag mode starts a round; "it" passes on contact')
    for (const p of [host, join]) await p.evaluate(`(() => { window.__pilot.stop(); window.__pilot.K.resumeGame(); window.__pilot.store.useGame.setState({ mode: 'tag' }) })()`)
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
    // Hunter boost (D4): "it" gets a faster car and an arrow to the nearest player; the other doesn't.
    await sleep(400)
    const huntOf = (p: Page) => p.evaluate(`(() => { const row = document.querySelector('[data-hud="tagHunt"]'); return { top: window.__game.get('vehicle')?.topSpeedKmh ?? null, base: window.__pilot.settings.useSettings.getState().topSpeedKmh, arrow: !!row && row.style.display !== 'none', dist: document.querySelector('[data-hud="tagDist"]')?.textContent ?? null } })()`) as Promise<{ top: number | null; base: number; arrow: boolean; dist: string | null }>
    const [itHunt, otherHunt] = [await huntOf(itPage), await huntOf(otherPage)]
    check('"it" drives a faster car than the runner (hunter boost)', itHunt.top !== null && itHunt.top > itHunt.base && otherHunt.top === otherHunt.base, { it: itHunt, runner: otherHunt })
    check('"it" sees the arrow and the distance to the runner; the runner doesn\'t', itHunt.arrow && /^\d+ m$/.test(itHunt.dist ?? '') && !otherHunt.arrow, { it: itHunt, runner: otherHunt })
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
    // mp-1's observation: ramming "it" when you're NOT "it" must count too (it used
    // to do nothing, because the bump shoved "it" away before its screen saw contact).
    await sleep(2300) // past the no-tag-back window
    const itPageId = await itPage.evaluate(`window.__pilot.net.getNet().myId`)
    await otherPage.evaluate(`window.__pilot.stop(); window.__pilot.place(110, 0)`)
    await itPage.evaluate(`window.__pilot.stop(); window.__pilot.place(85, 0)`)
    await sleep(2000)
    await otherPage.evaluate(`window.__pilot.release()`)
    await itPage.evaluate(`window.__pilot.go('net-${otherId}', 60)`)
    const back = await until<number>(itPage, `(() => { const r = window.__pilot.rounds.currentRound(); return r && r.itId === ${itPageId} ? r.seq : 0 })()`, 15000)
    await itPage.evaluate(`window.__pilot.stop()`)
    const backAgree = [await host.evaluate(`window.__pilot.rounds.currentRound()?.itId`), await join.evaluate(`window.__pilot.rounds.currentRound()?.itId`)]
    check('ramming "it" while NOT it passes "it" to the rammer (touch claim), both screens agree', !!back && backAgree[0] === itPageId && backAgree[1] === itPageId, { seq: back, backAgree, expected: itPageId })
    const secs = await host.evaluate(`window.__game.state.tagSeconds`)
    console.log(`  tagSeconds on host: ${JSON.stringify(secs)}`)
    // The round ends (25 s in checks): both get the same results, least time as "it" first.
    const tagDone = await Promise.all([host, join].map((p) => until<boolean>(p, `window.__game.state.raceState === 'finished' && window.__game.state.mode === 'tag'`, 40000)))
    const tagRes = await Promise.all([host, join].map((p) => p.evaluate(`window.__game.state.raceResults.map((r) => [r.position, r.name, r.ms])`))) as [number, string, number][][]
    const endEvt = await join.evaluate(`window.__events.recent.find((e) => e.type === 'tag.end')?.results ?? null`)
    await join.screenshot({ path: `${k.shots}/tag-results-joiner.png` })
    check('the tag round ends on both screens', tagDone.every(Boolean))
    check('tag results agree on both screens (names and order)', tagRes[0].length === 2 && tagRes[0].map((r) => r[1]).join() === tagRes[1].map((r) => r[1]).join(), { host: tagRes[0], joiner: tagRes[1] })
    check('least time as "it" wins', tagRes[0].length === 2 && tagRes[0][0][2] <= tagRes[0][1][2], tagRes[0])
    check('tag.end event fired with every player', Array.isArray(endEvt) && (endEvt as unknown[]).length === 2, endEvt)
    // Times as "it" agree to within a second across screens.
    const byName = (r: [number, string, number][]) => Object.fromEntries(r.map((x) => [x[1], x[2]]))
    const a = byName(tagRes[0])
    const b = byName(tagRes[1])
    check('each player\'s time as "it" matches on both screens (within 1 s)', Object.keys(a).every((n) => Math.abs((a[n] ?? 0) - (b[n] ?? -9999)) < 1000), { host: a, joiner: b })
  }

  if (k.sections.includes('leave')) {
    console.log('\n== leave: switching mode mid-race takes you out of it (D3)')
    const roundOf = (p: Page) => p.evaluate(`(() => { const r = window.__pilot.rounds.currentRound(); return r ? { kind: r.kind, raceId: r.raceId, ended: r.ended, quit: [...r.quit] } : null })()`) as Promise<{ kind: string; raceId: number; ended: boolean; quit: number[] } | null>
    for (const p of [host, join]) await p.evaluate(`(() => { window.__pilot.stop(); window.__pilot.K.resumeGame(); window.__pilot.settings.useSettings.getState().set('raceLaps', 3); window.__pilot.store.useGame.setState({ mode: 'race' }) })()`)
    await sleep(800)
    check('a race starts (nobody will finish it)', (await host.evaluate(`window.__pilot.rounds.requestStart()`)) === true)
    await until<boolean>(join, `window.__game.state.raceState === 'running'`, 6000)
    const raceId = (await roundOf(host))?.raceId
    // The joiner switches to Tag mid-race, the way the pause menu's mode change does.
    await join.evaluate(`window.__pilot.store.useGame.setState({ mode: 'tag' })`)
    const joinId = await join.evaluate(`window.__pilot.net.getNet().myId`)
    const hostSaw = await until<boolean>(host, `(() => { const r = window.__pilot.rounds.currentRound(); return !!r && r.quit.has(${joinId}) })()`, 3000)
    const joinR = await roundOf(join)
    check('the joiner is out of the race on its own screen', !!joinR && joinR.raceId === raceId && joinR.ended && (await join.evaluate(`window.__game.state.raceState`)) === 'idle', joinR)
    check('...and the host stops waiting for them', !!hostSaw, await roundOf(host))
    // The joiner presses G for Tag while the host is still in the race: the host's screen keeps its race...
    check('the joiner can start a tag round straight away', (await join.evaluate(`window.__pilot.rounds.requestStart()`)) === true)
    await sleep(600)
    const hostStill = await roundOf(host)
    check('...the host, still racing, keeps its race for now', !!hostStill && hostStill.kind === 'race' && !hostStill.ended, hostStill)
    // ...until the host switches to Tag too: it leaves the race and lands in the joiner's round.
    await host.evaluate(`window.__pilot.store.useGame.setState({ mode: 'tag' })`)
    const tagIds = await Promise.all([host, join].map((p) => until<number>(p, `(() => { const r = window.__pilot.rounds.currentRound(); return r && r.kind === 'tag' && !r.ended ? r.raceId : 0 })()`, 3000)))
    check('switching to Tag drops the host into the tag round the joiner started', !!tagIds[0] && tagIds[0] === tagIds[1], tagIds)
    const running = await until<boolean>(host, `window.__game.state.raceState === 'running' && window.__game.state.mode === 'tag'`, 6000)
    check('...and it runs on the host', !!running)
    // The joiner leaves the tag round: with one player left it ends.
    await join.evaluate(`window.__pilot.store.useGame.setState({ mode: 'race' })`)
    const tagOver = await until<boolean>(host, `!!window.__pilot.rounds.currentRound()?.ended`, 4000)
    check('a tag round with only one player left ends', !!tagOver, await roundOf(host))
    for (const p of [host, join]) await p.evaluate(`(() => { window.__pilot.stop(); window.__pilot.K.resumeGame(); window.__pilot.settings.useSettings.getState().set('raceLaps', 1) })()`)
    await sleep(500)
  }

  if (k.sections.includes('turns')) await turnsChecks(k, host, join)

  if (k.sections.includes('props')) {
    console.log('\n== props: a crash-prop burst on one screen bursts on the other')
    const round = [await host.evaluate(`window.__pilot.K.propsSignal.round`), await join.evaluate(`window.__pilot.K.propsSignal.round`)]
    check('both screens play the same prop deal', round[0] === round[1], round)
    const clusters = (await host.evaluate(`window.__pilot.current.getTrack().props.length`)) as number
    if (clusters === 0) console.log('  (this track has no crash props: run props on afterglow to test a burst)')
    const before = (await join.evaluate(`window.__events.recent.filter((e) => e.type === 'prop.burst' && e.remote).length`)) as number
    // The host bursts cluster 0 exactly the way play reports a local burst.
    await host.evaluate(`window.__pilot.K.propsSignal.onLocalPop({ cluster: 0, vx: 20, vy: 0, vz: 0 })`)
    const got = await until<number>(join, `(() => { const n = window.__events.recent.filter((e) => e.type === 'prop.burst' && e.remote).length; return n > ${before} ? n : 0 })()`, 4000)
    if (clusters > 0) check('the joiner bursts the same cluster (prop.burst remote, no points)', !!got, { remoteBursts: got })
  }

  if (k.sections.includes('robust')) await robust(k, host, join, q)

  await host.close()
  await join.close()
}

/**
 * Hunt Turns (D6): a whole round on the Thunder Bowl with 40 s turns (?turnSeconds=40). The
 * cars are placed by the pilot for each check and sit still otherwise.
 */
/**
 * The shared-and-downloaded track (Nathan, 3 Nov 2026: "even though we're on the same track, he is
 * not in it racing with me"). The host draws a track and shares it; the joiner downloads it from
 * Shared tracks, so the joiner holds a track with the SAME id whose file differs (Share writes the
 * Made by name into `author`). When the host drives it, the joiner's copy of the host's road must
 * count as the same track: same key, same world, each sees the other, and G puts both on the grid,
 * while the joiner's own download is never overwritten. Needs the dev server (it loads the Share
 * modules by path), so it is a LAN-only section.
 */
async function sameTrackChecks(k: Kit, host: Page, join: Page): Promise<void> {
  const { check, until, sleep } = k
  console.log('\n== sametrack: the host drives a track the joiner downloaded from Shared tracks')
  const before = await host.evaluate(`(() => { window.__sameBefore = window.__pilot.current.getCurrentTrackFile(); return window.__sameBefore.id })()`)
  const terrainAt = `(() => { const t = window.__pilot.current.getTrack(); return [[0, 0], [100, 50], [-200, 300], [400, -250], [-350, -100]].map(([x, z]) => +t.terrainHeight(x, z).toFixed(4)) })()`
  /** The joiner downloads the host's track the way Shared tracks' Download does: issue text, fingerprint, import. */
  const download = (file: string) => `(async () => {
    const proto = await import('/src/editor/share/protocol.ts')
    const share = await import('/src/editor/share/client.ts')
    const issue = proto.buildTrackIssue(proto.publicTrackFile(${file}, 'Dad'), 'Neon Valley', 'dadsharekey12345')
    const read = proto.readTrackIssue(issue.body)
    const r = share.downloadShared({ number: 4242, url: '', title: issue.title, createdAt: '', updatedAt: '', ...read })
    const saved = JSON.parse(localStorage.getItem('sr2.tracks.drawn.v1') || '{}')[r.id]
    return { ok: r.ok, id: r.id, why: r.why ?? null, saved: saved ? JSON.stringify(saved) : null }
  })()`

  // Two variants: one with no world seed (the world then comes from the track's id, so a renamed
  // copy must keep the host's), then a drawn track as the editor saves it (with its own seed),
  // which stays on for the see-each-other and race grid checks below.
  for (const variant of ['no seed', 'seeded']) {
    const id = variant === 'seeded' ? 'dad-shared-check' : 'dad-shared-check-noseed'
    const hostFile = (await host.evaluate(`(async () => {
      // From the built-in file, not the current track: an earlier section may have stretched that already.
      const registry = await import('/src/track/registry.ts')
      const f = JSON.parse(JSON.stringify(registry.getTrackFile(${JSON.stringify(k.track)})))
      f.id = ${JSON.stringify(id)}
      f.name = ${JSON.stringify(variant === 'seeded' ? 'Dad Shared Check' : 'Dad Shared Check Two')}
      delete f.author
      f.environment = { ...f.environment }
      ${variant === 'seeded' ? 'f.environment.seed = 4242' : 'delete f.environment.seed'}
      for (const pt of f.road.points) { pt.x *= 1.1; pt.z *= 0.95 }
      window.__sameT = f
      return JSON.stringify(f)
    })()`)) as string
    const got = (await join.evaluate(download(hostFile))) as { ok: boolean; id: string; why: string | null; saved: string | null }
    check(`[${variant}] the joiner downloads the shared track under the same id, with a different file (Made by)`, got.ok && got.id === id && !!got.saved && got.saved !== hostFile, { ok: got.ok, id: got.id, why: got.why, differs: got.saved !== hostFile })

    await host.evaluate(`(() => { const P = window.__pilot; P.registry.saveDrawnTrack(window.__sameT); return P.current.setTrackFromFile(window.__sameT).ok })()`)
    const hostKey = await until<string>(host, `(() => { const t = window.__pilot.current.getTrack(); return t && t.id === ${JSON.stringify(id)} ? t.key : null })()`, 10000)
    const name = JSON.parse(hostFile).name as string
    const joinT = await until<{ id: string; key: string; source: string }>(join, `(() => { const t = window.__pilot.current.getTrack(); return t && t.name === ${JSON.stringify(name)} ? { id: t.id, key: t.key, source: window.__pilot.registry.getTrackSource(t.id) } : null })()`, 20000)
    const stillMine = await join.evaluate(`JSON.stringify(JSON.parse(localStorage.getItem('sr2.tracks.drawn.v1') || '{}')[${JSON.stringify(id)}] ?? null)`)
    check(`[${variant}] the joiner's own download is untouched (the host's copy is held beside it)`, stillMine === got.saved && !!joinT && joinT.source === 'shared' && joinT.id !== id, { joinT, untouched: stillMine === got.saved })
    check(`[${variant}] both players' copies of the road have the same track key`, !!hostKey && joinT?.key === hostKey, { hostKey, joinKey: joinT?.key })
    const worlds = [await host.evaluate(terrainAt), await join.evaluate(terrainAt)]
    check(`[${variant}] the joiner's world is the host's (same ground heights)`, JSON.stringify(worlds[0]) === JSON.stringify(worlds[1]), worlds)
    // The stunt park (Hunt Turns' arena spots come from it) is seeded from the track: the same park on both.
    const parkOf = (p: Page) => until<string>(p, `(() => { const d = window.__dev; const t = window.__pilot.current.getTrack(); if (!t || t.name !== ${JSON.stringify(name)} || !('park' in d)) return null; const r = d.park(); return r && r.items ? JSON.stringify({ zones: r.zones, items: r.items }) : null })()`, 10000)
    await sleep(2000) // the old track's park hands its dev handle over as the new one mounts
    const parks = [await parkOf(host), await parkOf(join)]
    check(`[${variant}] the joiner's stunt park is the host's`, !!parks[0] && parks[0] === parks[1], parks.map((x) => (x ? (JSON.parse(x) as { items: string[] }).items.slice(0, 2) : null)))
  }

  // On the seeded track: the one Nathan and Josh had.
  await sleep(2000)
  await host.evaluate(`window.__pilot.stop(); window.__pilot.place(40, -2)`)
  await join.evaluate(`window.__pilot.stop(); window.__pilot.place(25, 2)`)
  const seen = await Promise.all(
    [host, join].map((p) => until<boolean>(p, `window.__game.cars.some((c) => c.kind === 'remote' && c.object && c.object.visible)`, 8000)),
  )
  const sameFlags = [await host.evaluate(`window.__game.get('net').peers.map((p) => p.sameTrack)`), await join.evaluate(`window.__game.get('net').peers.map((p) => p.sameTrack)`)]
  check('each player sees the other car on the shared track', seen[0] === true && seen[1] === true, { hostSees: seen[0], joinerSees: seen[1], sameTrack: sameFlags })
  // G on the host: both on the grid.
  await host.evaluate(`window.__pilot.settings.useSettings.getState().set('raceLaps', 1)`)
  await sleep(600)
  const started = await host.evaluate(`window.__pilot.rounds.requestStart()`)
  const hostRound = await until<{ grid: number[]; raceId: number }>(host, `(() => { const r = window.__pilot.rounds.currentRound(); return r && r.kind === 'race' && !r.ended ? { grid: r.grid, raceId: r.raceId } : null })()`, 3000)
  const joinRound = await until<{ grid: number[]; raceId: number }>(join, `(() => { const r = window.__pilot.rounds.currentRound(); return r && r.kind === 'race' && !r.ended ? { grid: r.grid, raceId: r.raceId } : null })()`, 3000)
  const ids = [await host.evaluate(`window.__pilot.net.getNet().myId`), await join.evaluate(`window.__pilot.net.getNet().myId`)] as number[]
  check('G on the host puts both players on the race grid', started === true && !!hostRound && ids.every((i) => hostRound.grid.includes(i)) && joinRound?.raceId === hostRound.raceId, { started, ids, hostRound, joinRound })
  // Should the joiner become host while on its renamed copy, it sends the road under the host's id.
  const outgoing = await join.evaluate(`(async () => { const m = await import('/src/net/trackSync.ts'); const P = window.__pilot; const f = P.current.getCurrentTrackFile(); const t = P.current.getTrack(); return { held: f.id, sends: m.outgoingFile ? m.outgoingFile(f, t.keyId).id : null } })()`)
  check("a joiner who takes over hosting sends the shared road under the host's id", (outgoing as { sends: string | null }).sends === 'dad-shared-check', outgoing)
  // Leave the race (a mode change, as the pause menu does) so later sections start clean.
  for (const p of [host, join]) await p.evaluate(`window.__pilot.stop(); window.__pilot.store.useGame.setState({ mode: 'tag' })`)
  await Promise.all([host, join].map((p) => until<boolean>(p, `(() => { const r = window.__pilot.rounds.currentRound(); return !r || r.ended })()`, 4000)))
  for (const p of [host, join]) await p.evaluate(`(() => { window.__pilot.store.useGame.setState({ mode: 'free' }); window.__pilot.K.resumeGame() })()`)

  // Back to the track the earlier sections left, on both.
  await host.evaluate(`window.__pilot.current.setTrackFromFile(window.__sameBefore).ok`)
  const backKey = await until<string>(host, `(() => { const t = window.__pilot.current.getTrack(); return t && t.id === ${JSON.stringify(before)} ? t.key : null })()`, 10000)
  const joinBack = await until<string>(join, `(() => { const k = window.__pilot.current.getTrack()?.key; return k === ${JSON.stringify(backKey)} ? k : null })()`, 20000)
  check('back on the earlier track, both again', !!backKey && joinBack === backKey, { backKey, joinBack })
  await sleep(1500)
}

async function turnsChecks(k: Kit, host: Page, join: Page): Promise<void> {
  const { check, until, sleep } = k
  console.log('\n== turns: Hunt Turns in the Thunder Bowl (D6)')
  const startKey = await host.evaluate(`window.__pilot.current.getTrack()?.key`)
  for (const p of [host, join]) await p.evaluate(`(() => { window.__pilot.stop(); window.__pilot.K.resumeGame() })()`)
  const loaded = await host.evaluate(`window.__pilot.current.loadTrackById('thunder-bowl').ok`)
  const bowl = await Promise.all([host, join].map((p) => until<string>(p, `(() => { const t = window.__pilot.current.getTrack(); return t && t.id === 'thunder-bowl' ? t.key : null })()`, 20000)))
  check('the host loads the Thunder Bowl and the joiner gets it', loaded === true && !!bowl[0] && bowl[0] === bowl[1], bowl)
  for (const p of [host, join]) await p.evaluate(`(() => { window.__pilot.stop(); window.__pilot.K.resumeGame(); window.__pilot.store.useGame.setState({ mode: 'turns' }) })()`)
  await sleep(1500)
  // The wipe window is shortened to 6 s (the presser's rule, carried in the start message) so the check can wait past it.
  await host.evaluate(`window.__pilot.settings.useSettings.getState().set('catchWipeSeconds', 6)`)
  check('G in Hunt Turns starts a round', (await host.evaluate(`window.__pilot.rounds.requestStart()`)) === true)
  const r0 = await Promise.all([host, join].map((p) => until<{ itId: number; raceId: number; order: number[] }>(p, `(() => { const r = window.__pilot.rounds.currentRound(); return r && r.kind === 'turns' ? { itId: r.itId, raceId: r.raceId, order: r.turns.order } : null })()`, 3000)))
  check('both screens are in the same round and agree who hunts first (and the order)', !!r0[0] && !!r0[1] && r0[0].raceId === r0[1].raceId && r0[0].itId === r0[1].itId && r0[0].order.join() === r0[1].order.join(), r0)
  const posOf = (p: Page) => p.evaluate(`(() => { const c = window.__pilot.player(); return { x: +c.position.x.toFixed(1), z: +c.position.z.toFixed(1) } })()`) as Promise<{ x: number; z: number }>
  await sleep(1200)
  const [hp, jp] = [await posOf(host), await posOf(join)]
  const apart = Math.hypot(hp.x - jp.x, hp.z - jp.z)
  check('the two cars start far apart round the arena (at least 150 m)', apart >= 150, { host: hp, joiner: jp, metres: Math.round(apart) })
  const running = await Promise.all([host, join].map((p) => until<boolean>(p, `window.__game.state.raceState === 'running' && window.__game.state.mode === 'turns'`, 6000)))
  check('turn 1 runs on both', running.every(Boolean))
  const hostId = (await host.evaluate(`window.__pilot.net.getNet().myId`)) as number
  const hunterPage = r0[0]?.itId === hostId ? host : join
  const runnerPage = hunterPage === host ? join : host
  const hunterId = r0[0]?.itId ?? 0
  const runnerId = (await runnerPage.evaluate(`window.__pilot.net.getNet().myId`)) as number

  // ---- the hunter hunts: boost and the arrow to the runner; the runner sees how far the hunter is ----
  await sleep(400)
  const huntOf = (p: Page) => p.evaluate(`(() => { const row = document.querySelector('[data-hud="turnsHunt"]'); return { top: window.__game.get('vehicle')?.topSpeedKmh ?? null, base: window.__pilot.settings.useSettings.getState().topSpeedKmh, arrow: !!row && row.style.display !== 'none', label: document.querySelector('[data-hud="turnsHuntLabel"]')?.textContent ?? null, dist: document.querySelector('[data-hud="turnsDist"]')?.textContent ?? null, pulse: (() => { const b = document.querySelector('[data-hud="turnsPulse"]'); return b && b.parentElement.style.display !== 'none' ? b.textContent : null })() } })()`) as Promise<{ top: number | null; base: number; arrow: boolean; label: string | null; dist: string | null; pulse: string | null }>
  const [hh, rh] = [await huntOf(hunterPage), await huntOf(runnerPage)]
  check('the hunter drives a faster car (hunter boost) and has the pulse; the runner has neither', hh.top !== null && hh.top > hh.base && rh.top === rh.base && hh.pulse === 'Ready' && rh.pulse === null, { hunter: hh, runner: rh })
  check('the hunter has an arrow to the nearest runner; the runner sees the hunter\'s distance', hh.arrow && hh.label === 'Nearest' && rh.arrow && rh.label === 'Hunter' && /^\d+ m$/.test(rh.dist ?? ''), { hunter: hh, runner: rh })
  for (const [p, who] of [[host, 'host'], [join, 'joiner']] as const) {
    await p.screenshot({ path: `${k.shots}/turns-panel-${who}.png` })
    console.log(`  shot ${k.shots}/turns-panel-${who}.png`)
  }


  // ---- D8 points: a runner scores, a hunter's tricks don't, a catch pays 500 and wipes only the recent points ----
  // Check-only: __dev.net('award', n) banks n trick points exactly as a landing does (trickScore + trick.land), no real stunt needed.
  type PtsView = { run: [number, number][]; catches: [number, number][]; per: number; wipeMs: number }
  const ptsOn = (p: Page) => p.evaluate(`(() => { const t = window.__pilot.rounds.currentRound().turns; return { run: [...t.run.entries()], catches: [...t.catches.entries()], per: t.rules.catchPoints, wipeMs: t.rules.catchWipeMs } })()`) as Promise<PtsView>
  const totalOf = (v: PtsView, id: number) => (v.run.find((e) => e[0] === id)?.[1] ?? 0) + (v.catches.find((e) => e[0] === id)?.[1] ?? 0) * v.per
  const bothPts = async (id: number, want: number, ms = 3000) => {
    const got = await Promise.all([host, join].map((p) => until<number>(p, `(() => { const t = window.__pilot.rounds.currentRound().turns; const run = t.run.get(${id}) ?? 0; const c = t.catches.get(${id}) ?? 0; return run + c * t.rules.catchPoints === ${want} ? 1 : 0 })()`, ms)))
    return got.every(Boolean)
  }
  const rules0 = await ptsOn(host)
  check('the round carries the knobs: a catch pays 500, the wipe window is the presser\'s (6 s)', rules0.per === 500 && rules0.wipeMs === 6000, { per: rules0.per, wipeMs: rules0.wipeMs })
  await runnerPage.evaluate(`window.__dev.net('award', 300)`)
  check("a runner's points rise (300) and both screens agree", await bothPts(runnerId, 300), await Promise.all([ptsOn(host), ptsOn(join)]))
  await hunterPage.evaluate(`window.__dev.net('award', 700)`)
  await sleep(900)
  check("the hunter's own tricks while hunting score nothing (700 awarded, 0 counted), on both screens", (await bothPts(hunterId, 0, 1500)) && (await bothPts(runnerId, 300, 1500)), await Promise.all([ptsOn(host), ptsOn(join)]))
  await sleep(6800) // past the 6 s wipe window
  await runnerPage.evaluate(`window.__dev.net('award', 150)`)
  check('a later award (150) lands too: 450 on both screens', await bothPts(runnerId, 450), [await Promise.all([ptsOn(host), ptsOn(join)]), await runnerPage.evaluate(`window.__events.recent.filter((e) => /^(trick|drift|prop|stunt)/.test(e.type)).map((e) => [e.type, e.points ?? e.lostPoints ?? null, Math.round(e.t)])`), await runnerPage.evaluate(`(() => { const g = window.__game.state; return [g.trickScore, g.propScore] })()`)])
  const panelOf = (p: Page) => p.evaluate(`(() => { const rows = [...document.querySelectorAll('.hud-turnsp__row')].map((r) => r.textContent); return { rows, earn: document.querySelector('.hud-turnsp__earn')?.textContent ?? null } })()`) as Promise<{ rows: string[]; earn: string | null }>
  await sleep(500)
  const [runnerPanel, hunterPanel] = [await panelOf(runnerPage), await panelOf(hunterPage)]
  check('the panel shows points big, catches small, and tells the runner tricks score / the hunter what a catch pays', runnerPanel.rows.some((t) => /450/.test(t) && /0 catches/i.test(t)) && /tricks and rings score/i.test(runnerPanel.earn ?? '') && /catches score 500/i.test(hunterPanel.earn ?? ''), { runnerPanel, hunterPanel })
  await runnerPage.screenshot({ path: `${k.shots}/turns-points-runner.png` })
  await hunterPage.screenshot({ path: `${k.shots}/turns-points-hunter.png` })
  console.log(`  shot ${k.shots}/turns-points-runner.png, turns-points-hunter.png`)

  const catchesOn = (p: Page) => p.evaluate(`(() => { const c = window.__game.state.turns; return c ? Object.values(c.catches).reduce((a, b) => a + b, 0) : -1 })()`) as Promise<number>
  // ---- a catch by reach: side by side 5 m apart, nobody moving, no contact ----
  await runnerPage.evaluate(`window.__pilot.stop(); window.__pilot.place(170, 0)`)
  await sleep(1200)
  await hunterPage.evaluate(`window.__pilot.stop(); window.__pilot.place(170, 5)`)
  const caught1 = await until<number>(hunterPage, `(() => { const r = window.__pilot.rounds.currentRound(); return r && r.turns.seq >= 1 ? performance.now() : 0 })()`, 4000)
  const how1 = await hunterPage.evaluate(`window.__events.recent.filter((e) => e.type === 'turns.catch').map((e) => e.how)`)
  const both1 = await Promise.all([host, join].map((p) => until<number>(p, `(() => { const c = window.__game.state.turns; const n = c ? Object.values(c.catches).reduce((a, b) => a + b, 0) : 0; return n === 1 ? 1 : 0 })()`, 3000)))
  check('getting within reach (5 m, no contact) catches the runner, and both screens count it', !!caught1 && Array.isArray(how1) && (how1 as string[])[0] === 'reach' && both1.every(Boolean), { how: how1, counted: both1 })
  // The catch (reach) pays the hunter 500 and wipes the runner's 150 from the last 6 s but not the 300 from before the window.
  check('the catch paid the hunter 500 and the runner lost only the last 150 (450 -> 300), on both screens', (await bothPts(hunterId, 500)) && (await bothPts(runnerId, 300)), await Promise.all([ptsOn(host), ptsOn(join)]))
  const wipeEvt = await runnerPage.evaluate(`window.__events.recent.filter((e) => e.type === 'turns.catch').map((e) => ({ points: e.points, wiped: e.wiped }))`)
  check("the runner's catch event says 500 for the hunter and 150 wiped", JSON.stringify(wipeEvt) === JSON.stringify([{ points: 500, wiped: 150 }]), wipeEvt)
  // ---- the fresh-chase window: the runner straight back beside the hunter is safe for 2 s ----
  const win = (await hunterPage.evaluate(`(() => { const r = window.__pilot.rounds.currentRound(); return { canTag: window.__pilot.rounds.canTag(), leftMs: Math.round(r.turns.noCatchUntil - performance.now()), rule: r.turns.rules.noCatchMs } })()`)) as { canTag: boolean; leftMs: number; rule: number }
  await sleep(300)
  const [hAfter, rAfter] = [await posOf(hunterPage), await posOf(runnerPage)]
  const thrown = Math.hypot(hAfter.x - rAfter.x, hAfter.z - rAfter.z)
  check('the caught runner is thrown at least 100 m from the hunter', thrown >= 100, { hunter: hAfter, runner: rAfter, metres: Math.round(thrown) })
  await runnerPage.evaluate(`window.__pilot.stop(); window.__pilot.place(170, 0)`)
  await sleep(600)
  const seqMid = (await hunterPage.evaluate(`window.__pilot.rounds.currentRound().turns.seq`)) as number
  await runnerPage.evaluate(`window.__pilot.stop(); window.__pilot.place(40, 0)`)
  check('no catch inside the 2 s fresh-chase window (the runner sat 5 m away)', win.rule === 2000 && !win.canTag && win.leftMs > 0 && win.leftMs <= 2000 && seqMid === 1, { win, seqMid })
  await sleep(1600)
  check('after the window the hunter can catch again', (await hunterPage.evaluate(`window.__pilot.rounds.canTag()`)) === true)

  // ---- the tag pulse: 12 m behind is safe, 12 m ahead is caught ----
  // On the start straight, 40 m before the line (the south straight's boost pad would launch a parked car).
  // The runner goes first and settles (a remote car glides to its new place, and gliding THROUGH the hunter's 6 m reach is a catch),
  // then the hunter steps in 12 m in front of it.
  await runnerPage.evaluate(`window.__pilot.stop(); window.__pilot.place(-52, 0)`)
  await sleep(1200)
  await hunterPage.evaluate(`window.__pilot.stop(); window.__pilot.place(-40, 0)`)
  await sleep(1400)
  const behind = (await hunterPage.evaluate(`window.__pilot.rounds.firePulse()`)) as number
  await sleep(500)
  const afterBehind = await catchesOn(hunterPage)
  check('a pulse at a runner 12 m BEHIND fires but catches nobody', behind === 0 && afterBehind === 1, { fired: behind, catches: afterBehind })
  const cool = (await hunterPage.evaluate(`window.__pilot.rounds.firePulse()`)) as number
  check('the pulse cools down (a second press straight away does nothing)', cool === -1, { second: cool })
  // 12 m AHEAD: the hunter backs up 24 m (its own car moves at once; the runner stays put, so nothing glides through reach).
  await hunterPage.evaluate(`window.__pilot.stop(); window.__pilot.place(-64, 0)`)
  await sleep(3800) // the rest of the 4 s cooldown
  const aim = await hunterPage.evaluate(`(() => { const t = window.__pilot.tel.telemetry, c = window.__game.cars.find((c) => c.kind === 'remote'); const r = (v) => Math.round(v * 10) / 10; return { hunter: [r(t.carPosition.x), r(t.carPosition.z)], nose: [r(t.carForward.x), r(t.carForward.z)], runner: c ? [r(c.position.x), r(c.position.z)] : null } })()`)
  const ahead = (await hunterPage.evaluate(`window.__pilot.rounds.firePulse()`)) as number
  await sleep(150)
  const pulseText = await hunterPage.evaluate(`document.querySelector('[data-hud="turnsPulse"]')?.textContent ?? null`)
  await hunterPage.screenshot({ path: `${k.shots}/turns-pulse.png` })
  console.log(`  shot ${k.shots}/turns-pulse.png`)
  const both2 = await Promise.all([host, join].map((p) => until<number>(p, `(() => { const c = window.__game.state.turns; const n = c ? Object.values(c.catches).reduce((a, b) => a + b, 0) : 0; return n === 2 ? 1 : 0 })()`, 3000)))
  const pulseSeen = await runnerPage.evaluate(`window.__events.recent.filter((e) => e.type === 'turns.pulse').length`)
  check('a pulse at a runner 12 m AHEAD catches them, counted on both screens', ahead === 1 && both2.every(Boolean), { caught: ahead, counted: both2, aim })
  check('the second catch pays 500 more (1000) and wipes nothing: the runner\'s 300 is older than the window', (await bothPts(hunterId, 1000)) && (await bothPts(runnerId, 300)), await Promise.all([ptsOn(host), ptsOn(join)]))
  // The runner then out-scores the hunter's two catches with tricks: 300 + 1500.
  await runnerPage.evaluate(`window.__dev.net('award', 1500)`)
  check('the runner passes the hunter on points with fewer catches (1800 vs 1000, 0 catches vs 2), both screens', (await bothPts(runnerId, 1800)) && (await bothPts(hunterId, 1000)), await Promise.all([ptsOn(host), ptsOn(join)]))
  check("the runner's screen saw both pulses fire (the burst is drawn for everyone)", pulseSeen === 2, { pulses: pulseSeen })
  check('the HUD shows the pulse cooling down right after it fires', typeof pulseText === 'string' && /^\d\.\d s$/.test(pulseText), { pulseText })

  // ---- the turn swaps: the other player hunts (after the between-turns card) ----
  const cardUp = await until<boolean>(runnerPage, `!!window.__game.state.turns && window.__game.state.turns.cardUntil > performance.now()`, 30000)
  if (cardUp) {
    await sleep(400)
    await runnerPage.screenshot({ path: `${k.shots}/turns-card.png` })
    console.log(`  shot ${k.shots}/turns-card.png`)
  }
  const t2 = await Promise.all([host, join].map((p) => until<number>(p, `(() => { const r = window.__pilot.rounds.currentRound(); return r && r.turns.index === 1 && r.turns.phase === 'play' ? r.itId : 0 })()`, 60000)))
  check('the turn swaps and the other player hunts, on both screens', t2[0] === runnerId && t2[1] === runnerId, { hunters: t2, expected: runnerId, first: hunterId })
  const [hp2, jp2] = [await posOf(host), await posOf(join)]
  const apart2 = Math.hypot(hp2.x - jp2.x, hp2.z - jp2.z)
  check('turn 2 starts far apart again (at least 150 m)', apart2 >= 150, { metres: Math.round(apart2) })
  await sleep(700) // the HUD loop catches up with the new turn's pulse state
  const t2hunt = await huntOf(runnerPage)
  check('the new hunter gets the boost and the pulse', t2hunt.top !== null && t2hunt.top > t2hunt.base && t2hunt.pulse === 'Ready', t2hunt)
  // Turn 2: the first hunter now runs and scores 250; the new hunter's own 400 counts for nothing.
  await hunterPage.evaluate(`window.__dev.net('award', 250)`)
  await runnerPage.evaluate(`window.__dev.net('award', 400)`)
  check('turn 2: the new runner scores (1000 + 250), the new hunter\'s 400 does not (still 1800)', (await bothPts(hunterId, 1250)) && (await bothPts(runnerId, 1800)), await Promise.all([ptsOn(host), ptsOn(join)]))

  // ---- the round ends: the same catches on both screens ----
  const done = await Promise.all([host, join].map((p) => until<boolean>(p, `window.__game.state.raceState === 'finished' && window.__game.state.mode === 'turns' && !!window.__game.state.turns?.done`, 60000)))
  check('the round ends on both screens', done.every(Boolean))
  await sleep(800)
  const res = await Promise.all([host, join].map((p) => p.evaluate(`window.__game.state.raceResults.map((r) => [r.position, r.name, r.ms])`))) as [number, string, number][][]
  check('the results agree on both screens (places, names, points)', res[0].length === 2 && JSON.stringify(res[0]) === JSON.stringify(res[1]), { host: res[0], joiner: res[1] })
  const hunterName = (await hunterPage.evaluate(`window.__game.state.turns.names.player`)) as string
  check('ranked by points: 1800 (0 catches) beats 1250 (2 catches); the higher score wins, not the catches', res[0][0][0] === 1 && res[0][0][1] !== hunterName && res[0][0][2] === 1800 && res[0][1][0] === 2 && res[0][1][2] === 1250, res[0])
  const catchesFinal = await Promise.all([host, join].map((p) => p.evaluate(`Object.values(window.__game.state.turns.catches).sort().join()`)))
  check('catches still counted and agree (0 and 2)', catchesFinal[0] === '0,2' && catchesFinal[1] === '0,2', catchesFinal)
  const heroes = await Promise.all([host, join].map((p) => p.evaluate(`document.querySelector('.result-hero__big')?.textContent ?? null`)))
  check('the results screens name the points winner, not a draw', heroes.every((h) => typeof h === 'string' && h !== 'Draw') && heroes.filter((h) => h === 'You win').length === 1, heroes)
  const endEvt = await join.evaluate(`window.__events.recent.find((e) => e.type === 'turns.end') ?? null`)
  check('turns.end fired with every player', !!endEvt && Array.isArray((endEvt as { results: unknown[] }).results) && (endEvt as { results: unknown[] }).results.length === 2 && (endEvt as { results: { points: number }[] }).results[0].points === 1800 && (endEvt as { draw: boolean }).draw === false, endEvt)
  await sleep(600)
  for (const [p, who] of [[host, 'host'], [join, 'joiner']] as const) {
    await p.screenshot({ path: `${k.shots}/turns-results-${who}.png` })
    console.log(`  shot ${k.shots}/turns-results-${who}.png`)
  }

  // ---- D3: Again starts a new round; the joiner leaving it (mode change) ends it for the host ----
  check('Again (G) starts a new round after the results', (await host.evaluate(`window.__pilot.rounds.requestStart()`)) === true)
  const again = await Promise.all([host, join].map((p) => until<number>(p, `(() => { const r = window.__pilot.rounds.currentRound(); return r && r.kind === 'turns' && !r.ended && window.__game.state.raceState === 'running' ? r.raceId : 0 })()`, 8000)))
  check('...on both screens', !!again[0] && again[0] === again[1], again)
  await join.evaluate(`window.__pilot.store.useGame.setState({ mode: 'free' })`)
  const over = await until<boolean>(host, `(() => { const r = window.__pilot.rounds.currentRound(); return !!r && r.ended && window.__game.state.raceState === 'finished' })()`, 5000)
  check('a Hunt Turns round with only one player left ends (results up for the one left)', !!over, await host.evaluate(`(() => { const r = window.__pilot.rounds.currentRound(); return r ? { ended: r.ended, quit: [...r.quit], state: window.__game.state.raceState } : null })()`))

  // Back to where the other sections expect to be.
  for (const p of [host, join]) await p.evaluate(`(() => { window.__pilot.stop(); window.__pilot.K.resumeGame(); window.__pilot.store.useGame.setState({ mode: 'free' }) })()`)
  const back = (await host.evaluate(`window.__pilot.current.loadTrackById(${JSON.stringify(k.track)}).ok`)) as boolean
  await until<boolean>(join, `window.__pilot.current.getTrack()?.key === ${JSON.stringify(startKey)}`, 20000)
  if (!back) console.log('  (could not reload the starting track)')
}

/**
 * mp-1's D1: every player spawns on their own grid slot, on joining, when the
 * host changes track, and after Shift+R. Nobody lands on anybody.
 */
async function spawnChecks(k: Kit, host: Page, join: Page): Promise<void> {
  const { check, until, sleep } = k
  console.log('\n== spawn: own grid slot on join, track change and Shift+R')
  // Car-on-car trouble since a moment: crashes with another player, long airtime, tricks.
  const trouble = (p: Page, since: number) => p.evaluate(`(() => {
    const ev = window.__events.recent.filter((e) => e.t >= ${since})
    return {
      carCrashes: ev.filter((e) => e.type === 'crash' && e.what === 'car').length,
      longAir: ev.filter((e) => e.type === 'trick.land' && e.airTimeS > 1.5).map((e) => +e.airTimeS.toFixed(2)),
      airborne: window.__pilot.tel.telemetry.airborne,
    }
  })()`) as Promise<{ carCrashes: number; longAir: number[]; airborne: boolean }>
  const apart = async () => {
    // Measured on the host's screen: our car versus the joiner's drawn car.
    return (await host.evaluate(`(() => { const r = window.__game.cars.find((c) => c.kind === 'remote'); const p = window.__pilot.tel.telemetry.carPosition; return r ? +r.position.distanceTo(p).toFixed(2) : -1 })()`)) as number
  }
  const slotOf = (p: Page) => p.evaluate(`window.__game.get('net').spawn`)

  // 1) Joining: both already loaded and on the host's track (the joiner came in on another track).
  await sleep(3000)
  const c1 = [await readClosest(host), await readClosest(join)]
  check('arrival, every frame on both screens: the other car is never drawn within 4 m (mp-2 M1)', c1.every((c) => !!c && c.frames > 0 && c.under4 === 0), { host: c1[0], joiner: c1[1] })
  const d1 = await apart()
  const t1 = [await trouble(host, 0), await trouble(join, 0)]
  check('on joining, the two cars spawn on different grid slots (over 3 m apart)', d1 > 3, { apartM: d1, host: await slotOf(host), joiner: await slotOf(join) })
  check('...and nobody hit or landed on anybody', t1.every((t) => t.carCrashes === 0 && t.longAir.length === 0 && !t.airborne), t1)
  await host.screenshot({ path: `${k.shots}/spawn-join-host.png` })

  // 2) The host switches track: everyone respawns, each on their own slot.
  const otherTrack = (await host.evaluate(`window.__pilot.current.getTrack().id`)) === 'hyperdrome' ? 'afterglow' : 'hyperdrome'
  const since2 = [await host.evaluate(`performance.now()`), await join.evaluate(`performance.now()`)] as number[]
  for (const p of [host, join]) await resetClosest(p)
  await host.evaluate(`window.__pilot.current.loadTrackById(${JSON.stringify(otherTrack)}).ok`)
  await until<boolean>(join, `window.__pilot.current.getTrack()?.id === ${JSON.stringify(otherTrack)}`, 20000)
  await sleep(4000)
  const c2 = [await readClosest(host), await readClosest(join)]
  check('track change, every frame on both screens: the other car is never drawn within 4 m', c2.every((c) => !!c && c.frames > 0 && c.under4 === 0), { host: c2[0], joiner: c2[1] })
  const d2 = await apart()
  const t2 = [await trouble(host, since2[0]), await trouble(join, since2[1])]
  check(`after the host switches to ${otherTrack}, the cars are on different slots (over 3 m apart)`, d2 > 3, { apartM: d2, host: await slotOf(host), joiner: await slotOf(join) })
  check('...and nobody hit or landed on anybody', t2.every((t) => t.carCrashes === 0 && t.longAir.length === 0 && !t.airborne), t2)
  await join.screenshot({ path: `${k.shots}/spawn-switch-joiner.png` })

  // 3) Shift+R (restart at the line) on both: back to their own slots, not slot 0 together.
  const since3 = [await host.evaluate(`performance.now()`), await join.evaluate(`performance.now()`)] as number[]
  for (const p of [host, join]) await resetClosest(p)
  for (const p of [host, join]) {
    await p.keyboard.down('ShiftLeft')
    await p.keyboard.press('KeyR')
    await p.keyboard.up('ShiftLeft')
  }
  await sleep(3000)
  const c3 = [await readClosest(host), await readClosest(join)]
  check('Shift+R, every frame on both screens: the other car is never drawn within 4 m', c3.every((c) => !!c && c.frames > 0 && c.under4 === 0), { host: c3[0], joiner: c3[1] })
  const d3 = await apart()
  const t3 = [await trouble(host, since3[0]), await trouble(join, since3[1])]
  check('after Shift+R on both, they restart on different slots (over 3 m apart)', d3 > 3, { apartM: d3 })
  check('...and nobody hit or landed on anybody', t3.every((t) => t.carCrashes === 0 && t.longAir.length === 0 && !t.airborne), t3)
}

/**
 * Stage C: three players, a player arriving mid-round, a reconnect mid-round
 * (tag and race), and the host reloading its page.
 */
async function robust(k: Kit, host: Page, join: Page, q: string): Promise<void> {
  const { check, until, sleep } = k
  console.log('\n== robust: mid-round arrival, three players, reconnects, host reload')
  const idOf = (p: Page) => p.evaluate(`window.__pilot.net.getNet().myId`) as Promise<number>
  const roundOf = (p: Page) => p.evaluate(`(() => { const r = window.__pilot.rounds.currentRound(); return r ? { raceId: r.raceId, kind: r.kind, grid: r.grid, inGrid: r.inGrid, ended: r.ended, itId: r.itId } : null })()`) as Promise<{ raceId: number; kind: string; grid: number[]; inGrid: boolean; ended: boolean; itId: number } | null>
  for (const p of [host, join]) await p.evaluate(`(() => { window.__pilot.stop(); window.__pilot.K.resumeGame(); window.__pilot.store.useGame.setState({ mode: 'tag' }) })()`)
  await sleep(800)

  // ---- a tag round starts with two; a third player arrives in the middle of it ----
  check('a 2-player tag round starts', (await host.evaluate(`window.__pilot.rounds.requestStart()`)) === true)
  const r1 = await until<{ raceId: number }>(host, `(() => { const r = window.__pilot.rounds.currentRound(); return r && !r.ended ? { raceId: r.raceId } : null })()`, 3000)
  await sleep(4000)
  const mum = await k.openPage(`${k.joinBase}/?${q}&name=MUM&color=mint&track=${k.joinTrack}&mode=free`, 'mum')
  await mum.evaluate(PILOT)
  const mumRound = await until<{ raceId: number; inGrid: boolean }>(mum, `(() => { const r = window.__pilot.rounds.currentRound(); return r ? { raceId: r.raceId, inGrid: r.inGrid } : null })()`, 20000)
  const mumState = await mum.evaluate(`window.__game.state.raceState`)
  const props3 = [await host.evaluate(`window.__pilot.K.propsSignal.round`), await mum.evaluate(`window.__pilot.K.propsSignal.round`)]
  check('a player arriving mid-round learns the live round and watches it (not on the grid)', !!mumRound && mumRound.raceId === r1?.raceId && mumRound.inGrid === false && mumState !== 'countdown' && mumState !== 'running', { mumRound, mumState })
  check('the late arrival plays the same crash-prop deal', props3[0] === props3[1], props3)

  // ---- three players see each other ----
  const sees = async (p: Page) => (await until<string[]>(p, `(() => { const n = window.__game.cars.filter((c) => c.kind === 'remote').map((c) => c.name).sort(); return n.length === 2 ? n : null })()`, 20000)) ?? []
  const seen = { host: await sees(host), join: await sees(join), mum: await sees(mum) }
  check('three players: everyone sees the other two in cars', seen.host.join() === 'DAD,MUM' && seen.join.join() === 'JOSH,MUM' && seen.mum.join() === 'DAD,JOSH', seen)
  await mum.screenshot({ path: `${k.shots}/robust-three-players.png` })

  // ---- the next round includes the late arrival ----
  await until<boolean>(host, `(() => { const r = window.__pilot.rounds.currentRound(); return !!r && r.ended })()`, 40000)
  for (const p of [host, join, mum]) await p.evaluate(`(() => { window.__pilot.stop(); window.__pilot.K.resumeGame(); window.__pilot.store.useGame.setState({ mode: 'tag' }) })()`)
  await sleep(1000)
  check('the next round starts (G)', (await host.evaluate(`window.__pilot.rounds.requestStart()`)) === true)
  await sleep(500)
  const rounds3 = [await roundOf(host), await roundOf(join), await roundOf(mum)]
  check('...with all three on the same grid and the same "it"', rounds3.every((r) => r && r.grid.length === 3 && r.inGrid && r.raceId === rounds3[0]!.raceId && r.itId === rounds3[0]!.itId), rounds3)

  // ---- a reconnect mid-round keeps your place ----
  await until<boolean>(join, `window.__game.state.raceState === 'running'`, 6000)
  await sleep(1500)
  const oldId = await idOf(join)
  await join.evaluate(`window.__pilot.K.net.dropConnection()`)
  const newId = await until<number>(join, `(() => { const s = window.__pilot.net.getNet(); return s.status === 'online' && s.myId !== ${oldId} ? s.myId : 0 })()`, 8000)
  await sleep(800)
  const afterRe = [await roundOf(host), await roundOf(join), await roundOf(mum)]
  check('mid-round reconnect: the dropped player comes back with a new id', !!newId && newId !== oldId, { oldId, newId })
  check('...and every screen swaps them onto the grid under the new id (round still on)', afterRe.every((r) => r && !r.ended && r.grid.includes(newId!) && !r.grid.includes(oldId)), afterRe)
  check('...and they are still in the round on their own screen', (await join.evaluate(`window.__game.state.raceState`)) === 'running')
  // The round ends with three results everywhere.
  const ends = await Promise.all([host, join, mum].map((p) => until<boolean>(p, `(() => { const r = window.__pilot.rounds.currentRound(); return !!r && r.ended && window.__game.state.raceState === 'finished' })()`, 45000)))
  const names = await Promise.all([host, join, mum].map((p) => p.evaluate(`window.__game.state.raceResults.map((r) => r.name).join()`)))
  // Results carry real names on every screen (the ui shows "You" for your own row).
  check('the 3-player round ends on every screen with three results in the same order', ends.every(Boolean) && names.every((n) => (n as string).split(',').length === 3) && new Set(names).size === 1, names)

  // ---- the host reloads its page ----
  const joinTrackVersion = await join.evaluate(`window.__game.state.trackVersion`)
  const joinKey = await join.evaluate(`window.__pilot.current.getTrack().key`)
  await host.reload({ waitUntil: 'load' })
  const hostLeft = await until<boolean>(join, `window.__events.recent.some((e) => e.type === 'mp.leave' && e.name === 'JOSH')`, 10000)
  await host.evaluate(PILOT)
  const hostBack = await until<boolean>(host, `window.__pilot.net.getNet().isHost`, 20000)
  const joinSeesHost = await until<boolean>(join, `window.__game.cars.some((c) => c.kind === 'remote' && c.name === 'JOSH')`, 20000)
  await sleep(2000)
  const joinAfter = { trackVersion: await join.evaluate(`window.__game.state.trackVersion`), key: await join.evaluate(`window.__pilot.current.getTrack().key`), isHost: await join.evaluate(`window.__pilot.net.getNet().isHost`) }
  check('host reload: joiners see the host leave', !!hostLeft)
  check('...the reloaded page is the host again', !!hostBack)
  check('...joiners see the host car again', !!joinSeesHost)
  // The reloaded host boots its link's ?track (or its last played track), which may differ
  // from what it was on. Joiners follow it either way; same track means no rebuild.
  const hostKeyAfter = await host.evaluate(`window.__pilot.current.getTrack().key`)
  const sameTrack = hostKeyAfter === joinKey
  check(`...and joiners follow the host's track${sameTrack ? ' without a rebuild' : ' (it booted a different one)'}`, joinAfter.key === hostKeyAfter && joinAfter.isHost === false && (!sameTrack || joinAfter.trackVersion === joinTrackVersion), { before: { trackVersion: joinTrackVersion, key: joinKey }, after: joinAfter, hostKeyAfter })

  // ---- a reconnect mid-RACE keeps your grid place ----
  for (const p of [host, join, mum]) await p.evaluate(`(() => { window.__pilot.stop(); window.__pilot.K.resumeGame(); window.__pilot.store.useGame.setState({ mode: 'race' }) })()`)
  await sleep(1500)
  check('a 3-player race starts', (await host.evaluate(`window.__pilot.rounds.requestStart()`)) === true)
  await until<boolean>(join, `window.__game.state.raceState === 'running'`, 6000)
  for (const p of [host, join, mum]) await p.evaluate(`window.__pilot.go(null, 80)`)
  await sleep(3000)
  const raceOld = await idOf(join)
  await join.evaluate(`window.__pilot.K.net.dropConnection()`)
  const raceNew = await until<number>(join, `(() => { const s = window.__pilot.net.getNet(); return s.status === 'online' && s.myId !== ${raceOld} ? s.myId : 0 })()`, 8000)
  await sleep(800)
  const raceAfter = [await roundOf(host), await roundOf(join), await roundOf(mum)]
  check('mid-race reconnect: every screen keeps the racer on the grid under the new id', !!raceNew && raceAfter.every((r) => r && r.kind === 'race' && !r.ended && r.grid.includes(raceNew!) && !r.grid.includes(raceOld)), { raceOld, raceNew, raceAfter })
  check('...and they are still racing on their own screen', (await join.evaluate(`window.__game.state.raceState`)) === 'running')
  const hostSeesRacer = await until<boolean>(host, `window.__game.cars.some((c) => c.kind === 'remote' && c.name === 'DAD')`, 8000)
  check('...and the others see their car again', !!hostSeesRacer)
  for (const p of [host, join, mum]) await p.evaluate(`window.__pilot.stop()`)
  await mum.close()
}
