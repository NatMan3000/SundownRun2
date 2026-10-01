// ============================================================
//  RELAY TESTS - `bun test server/relay.test.ts`
// ------------------------------------------------------------
//  Starts a private relay and connects plain WebSocket clients to
//  it: one through 127.0.0.1 (this machine, so it should become the
//  host) and others through this machine's LAN address (so they look
//  like a second computer). Checks the things the game relies on:
//  who hosts, the host's track reaching a late joiner, pose packets
//  tagged with the sender, ping/pong, and the host handing over when
//  it leaves and coming back when it returns.
// ============================================================

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { networkInterfaces } from 'node:os'
import { startRelay } from './relay'
import { POSE_BYTES, POSE_FLOATS, TAGGED_POSE_BYTES } from '../src/net/protocol'

const PORT = 5218
let server: { stop: (force?: boolean) => void }

function lanIPv4(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) return a.address
  }
  return null
}

/** A test client: collects every JSON message and binary packet it receives. */
class Client {
  ws: WebSocket
  json: any[] = []
  binary: ArrayBuffer[] = []
  opened: Promise<void>
  constructor(host: string) {
    this.ws = new WebSocket(`ws://${host}:${PORT}`)
    this.ws.binaryType = 'arraybuffer'
    this.opened = new Promise((resolve) => (this.ws.onopen = () => resolve()))
    this.ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') this.json.push(JSON.parse(ev.data))
      else this.binary.push(ev.data as ArrayBuffer)
    }
  }
  send(msg: unknown) {
    this.ws.send(typeof msg === 'string' || msg instanceof Float32Array ? (msg as any) : JSON.stringify(msg))
  }
  /** Wait until a JSON message matching `pred` has arrived. */
  async waitFor(pred: (m: any) => boolean, ms = 2000): Promise<any> {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      const hit = this.json.find(pred)
      if (hit) return hit
      await Bun.sleep(10)
    }
    throw new Error(`timed out waiting; got ${JSON.stringify(this.json.map((m) => m.t))}`)
  }
  close() {
    this.ws.close()
  }
}

const lan = lanIPv4()

beforeAll(() => {
  server = startRelay(PORT, () => {})
})
afterAll(() => {
  server.stop(true)
})

test('the loopback client hosts, its track reaches a late LAN joiner, poses are tagged', async () => {
  if (!lan) throw new Error('no LAN address on this machine - cannot simulate a second computer')

  // A LAN client arrives first: with nobody on loopback, it hosts for now.
  const early = new Client(lan)
  await early.opened
  const w0 = await early.waitFor((m) => m.t === 'welcome')
  expect(w0.hostId).toBe(w0.id)

  // The real host (this machine) connects: it takes over hosting.
  const host = new Client('127.0.0.1')
  await host.opened
  const wh = await host.waitFor((m) => m.t === 'welcome')
  expect(wh.hostId).toBe(wh.id)
  await early.waitFor((m) => m.t === 'host' && m.id === wh.id)

  host.send({ t: 'hello', v: 2, name: 'JOSH', body: 'dart', paint: '#1b1f3b', glow: '#19e3ff', trail: '#19e3ff' })
  const file = { id: 'my-drawn-track', name: 'My Drawn Track', road: { points: [1, 2, 3, 4] } }
  host.send({ t: 'track', file, params: { bankDeg: 20 } })
  // A non-host trying to change the track is ignored.
  early.send({ t: 'track', file: { id: 'sneaky', name: 'Sneaky' }, params: {} })
  await early.waitFor((m) => m.t === 'track' && m.from === wh.id)

  // A late joiner gets the host's hello and the HOST's track in its welcome.
  const late = new Client(lan)
  await late.opened
  const wl = await late.waitFor((m) => m.t === 'welcome')
  expect(wl.hostId).toBe(wh.id)
  expect(wl.track?.file?.id).toBe('my-drawn-track')
  expect(wl.track?.params?.bankDeg).toBe(20)
  expect(wl.peers.find((p: any) => p.id === wh.id)?.hello?.name).toBe('JOSH')

  // Pose packets: the right size goes out tagged with the sender id; a wrong size is dropped.
  const pose = new Float32Array(POSE_FLOATS)
  pose[0] = 12.5
  pose[6] = 1
  host.send(pose)
  host.send(new Float32Array(3))
  const t0 = Date.now()
  while (late.binary.length === 0 && Date.now() - t0 < 2000) await Bun.sleep(10)
  expect(late.binary.length).toBe(1)
  expect(late.binary[0].byteLength).toBe(TAGGED_POSE_BYTES)
  expect(new DataView(late.binary[0]).getUint32(0, true)).toBe(wh.id)
  expect(new Float32Array(late.binary[0].slice(4))[0]).toBe(12.5)
  expect(POSE_BYTES).toBe(44)

  // Ping is answered to the sender alone.
  late.send({ t: 'ping', c: 42 })
  const pong = await late.waitFor((m) => m.t === 'pong')
  expect(pong.c).toBe(42)
  await Bun.sleep(50)
  expect(host.json.some((m) => m.t === 'pong')).toBe(false)

  // A race start is remembered for players who arrive mid-race.
  late.send({ t: 'start', kind: 'race', raceId: 7, round: 3, laps: 3, seconds: 0, itId: 0, grid: [wh.id, w0.id, wl.id] })
  await host.waitFor((m) => m.t === 'start' && m.raceId === 7)
  const mid = new Client(lan)
  await mid.opened
  const wm = await mid.waitFor((m) => m.t === 'welcome')
  expect(wm.live?.raceId).toBe(7)
  expect(wm.live?.from).toBe(wl.id)

  // The host leaves: the longest-connected LAN client takes over and everyone hears it.
  host.close()
  const hostMsg = await late.waitFor((m) => m.t === 'host' && m.id === w0.id)
  expect(hostMsg.id).toBe(w0.id)
  await late.waitFor((m) => m.t === 'leave' && m.id === wh.id)

  // The host comes back (a reload): it hosts again.
  const back = new Client('127.0.0.1')
  await back.opened
  const wb = await back.waitFor((m) => m.t === 'welcome')
  expect(wb.hostId).toBe(wb.id)
  await late.waitFor((m) => m.t === 'host' && m.id === wb.id)

  for (const c of [early, late, mid, back]) c.close()
})
