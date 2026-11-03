// ============================================================
//  RELAY BEHAVIOUR, OVER THE WIRE - for any running relay
// ------------------------------------------------------------
//    SR2_RELAY_URL=ws://127.0.0.1:5211/relay bun test cloud/relay.remote.test.ts
//
//  Points plain WebSocket clients at a running relay and checks what
//  the game relies on. Run it against the internet relay under
//  `wrangler dev` (cloud:dev) and against the LAN relay reached through
//  this machine's LAN address (`bun run relay --port 5212`, then
//  ws://<lan ip>:5212): nobody is on loopback either way, so both must
//  give exactly the same answers. Skipped when SR2_RELAY_URL isn't set.
//
//  The room must be empty when it starts (ids are compared relative to
//  the first client, so a room that has been used before is fine).
// ============================================================

import { expect, test } from 'bun:test'
import { MAX_MESSAGE_BYTES, POSE_BYTES, POSE_FLOATS, PROTOCOL_VERSION, TAGGED_POSE_BYTES } from '../src/net/protocol'

const URL = process.env.SR2_RELAY_URL ?? ''

class Client {
  ws: WebSocket
  json: any[] = []
  binary: ArrayBuffer[] = []
  opened: Promise<void>
  closed: Promise<number>
  constructor() {
    this.ws = new WebSocket(URL)
    this.ws.binaryType = 'arraybuffer'
    this.opened = new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve()
      this.ws.onerror = (e) => reject(new Error(`could not connect to ${URL}: ${String((e as any)?.message ?? e)}`))
    })
    this.closed = new Promise((resolve) => (this.ws.onclose = (e) => resolve(e.code)))
    this.ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') this.json.push(JSON.parse(ev.data))
      else this.binary.push(ev.data as ArrayBuffer)
    }
  }
  send(msg: unknown) {
    this.ws.send(typeof msg === 'string' || msg instanceof Float32Array ? (msg as any) : JSON.stringify(msg))
  }
  async waitFor(pred: (m: any) => boolean, ms = 3000): Promise<any> {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      const hit = this.json.find(pred)
      if (hit) return hit
      await Bun.sleep(10)
    }
    throw new Error(`timed out waiting; got ${JSON.stringify(this.json.map((m) => m.t))}`)
  }
  async welcome(): Promise<any> {
    await this.opened
    return this.waitFor((m) => m.t === 'welcome')
  }
  close() {
    this.ws.close()
  }
}

test.skipIf(!URL)('the relay behaves the same over the wire (join, welcome, poses, from, late joiners, host handover)', async () => {
  // First in hosts (nobody is on the relay's own machine).
  const a = new Client()
  const wa = await a.welcome()
  expect(wa.v).toBe(PROTOCOL_VERSION)
  expect(wa.hostId).toBe(wa.id)
  expect(wa.peers).toEqual([])
  expect(wa.track).toBeNull()
  expect(wa.live).toBeNull()

  // A second player joins: told who hosts, and the first hears the join.
  const b = new Client()
  const wb = await b.welcome()
  expect(wb.id).toBeGreaterThan(wa.id)
  expect(wb.hostId).toBe(wa.id)
  expect(wb.peers.map((p: any) => p.id)).toEqual([wa.id])
  await a.waitFor((m) => m.t === 'join' && m.id === wb.id)

  // JSON gets the sender's id as `from`.
  a.send({ t: 'hello', v: PROTOCOL_VERSION, name: 'DAD', body: 'dart', paint: '#1b1f3b', glow: '#ff8a3d', trail: '#ff8a3d' })
  const hello = await b.waitFor((m) => m.t === 'hello')
  expect(hello.from).toBe(wa.id)
  expect(hello.name).toBe('DAD')

  // Only the host's track counts.
  b.send({ t: 'track', file: { id: 'sneaky', name: 'Sneaky' }, params: {} })
  a.send({ t: 'track', file: { id: 'my-drawn-track', name: 'My Drawn Track', road: { points: [1, 2, 3, 4] } }, params: { bankDeg: 20 } })
  const track = await b.waitFor((m) => m.t === 'track')
  expect(track.from).toBe(wa.id)
  // (the non-host's track still reaches others as a message; the relay just doesn't remember it)

  // Poses: tagged with the sender id; a wrong size is dropped.
  const pose = new Float32Array(POSE_FLOATS)
  pose[0] = 12.5
  pose[6] = 1
  a.send(pose)
  a.send(new Float32Array(3))
  const t0 = Date.now()
  while (b.binary.length === 0 && Date.now() - t0 < 3000) await Bun.sleep(10)
  await Bun.sleep(100)
  expect(b.binary.length).toBe(1)
  expect(b.binary[0].byteLength).toBe(TAGGED_POSE_BYTES)
  expect(new DataView(b.binary[0]).getUint32(0, true)).toBe(wa.id)
  expect(new Float32Array(b.binary[0].slice(4))[0]).toBe(12.5)
  expect(POSE_BYTES).toBe(48)
  expect(a.binary.length).toBe(0)

  // Ping is answered to the sender alone.
  b.send({ t: 'ping', c: 42 })
  expect((await b.waitFor((m) => m.t === 'pong')).c).toBe(42)
  await Bun.sleep(100)
  expect(a.json.some((m) => m.t === 'pong')).toBe(false)

  // A round starts: remembered for late joiners.
  b.send({ t: 'start', kind: 'race', raceId: 7, round: 3, laps: 3, seconds: 0, itId: 0, grid: [wa.id, wb.id] })
  const start = await a.waitFor((m) => m.t === 'start' && m.raceId === 7)
  expect(start.from).toBe(wb.id)

  // A late joiner gets everyone's hello, the HOST's track and the live round.
  const c = new Client()
  const wc = await c.welcome()
  expect(wc.hostId).toBe(wa.id)
  expect(wc.peers.find((p: any) => p.id === wa.id)?.hello?.name).toBe('DAD')
  expect(wc.peers.find((p: any) => p.id === wb.id)?.hello).toBeNull()
  expect(wc.track?.file?.id).toBe('my-drawn-track')
  expect(wc.track?.params?.bankDeg).toBe(20)
  expect(wc.live?.raceId).toBe(7)
  expect(wc.live?.from).toBe(wb.id)
  expect(typeof wc.live?.startedAgoMs).toBe('number')

  // A racer comes back under a new id: the remembered round follows them.
  const re = new Client()
  const wr = await re.welcome()
  re.send({ t: 'rejoin', raceId: 7, oldId: wb.id })
  await a.waitFor((m) => m.t === 'rejoin' && m.from === wr.id)
  const d = new Client()
  const wd = await d.welcome()
  expect(wd.live?.grid).toEqual([wa.id, wr.id])
  d.close()
  re.close()
  await a.waitFor((m) => m.t === 'leave' && m.id === wd.id)

  // A message bigger than the limit closes that socket (1009), and only that one.
  const big = new Client()
  const wbig = await big.welcome()
  big.send('x'.repeat(MAX_MESSAGE_BYTES + 1))
  expect(await big.closed).toBe(1009)
  await a.waitFor((m) => m.t === 'leave' && m.id === wbig.id)

  // The host leaves: the longest-present player hosts, everyone hears it, and the old track is forgotten.
  a.close()
  await b.waitFor((m) => m.t === 'leave' && m.id === wa.id)
  expect((await b.waitFor((m) => m.t === 'host' && m.id === wb.id)).id).toBe(wb.id)
  await c.waitFor((m) => m.t === 'host' && m.id === wb.id)
  const e = new Client()
  const we = await e.welcome()
  expect(we.hostId).toBe(wb.id)
  expect(we.track).toBeNull()
  expect(we.live?.raceId).toBe(7)

  // Everyone leaves: the room forgets the round and the next player hosts an empty room.
  for (const x of [b, c, e]) x.close()
  await Promise.all([b.closed, c.closed, e.closed])
  await Bun.sleep(300)
  const f = new Client()
  const wf = await f.welcome()
  expect(wf.hostId).toBe(wf.id)
  expect(wf.peers).toEqual([])
  expect(wf.live).toBeNull()
  expect(wf.track).toBeNull()
  f.close()
  await f.closed
}, 30000)
