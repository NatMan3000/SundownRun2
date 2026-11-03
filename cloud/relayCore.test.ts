// ============================================================
//  CLOUD RELAY UNIT TESTS - `bun run test:cloud`
// ------------------------------------------------------------
//  The parts of the internet relay that can't be reached from
//  outside: waking up after hibernation (the room's memory comes back
//  from storage, the players from their sockets), the track saved in
//  pieces, and which relay address a page picks.
// ============================================================

import { expect, test } from 'bun:test'
import { RelayCore } from '../server/relayCore'
import type { ClientData } from '../server/relayCore'
import { relayUrlFor } from '../src/net/protocol'
import { TRACK_PIECE_CHARS, loadMemory, saveMemory } from './memoryStore'
import type { KvStore } from './memoryStore'

/** A pretend socket: remembers what was sent to it. */
class Sock {
  out: any[] = []
  send(p: string | Uint8Array) {
    this.out.push(typeof p === 'string' ? JSON.parse(p) : p)
  }
}

function makeCore() {
  return new RelayCore<Sock>({ send: (s, p) => s.send(p) })
}

/** A pretend Durable Object storage. */
class FakeStore implements KvStore {
  map = new Map<string, unknown>()
  async get(key: any): Promise<any> {
    if (Array.isArray(key)) return new Map(key.filter((k) => this.map.has(k)).map((k) => [k, this.map.get(k)]))
    return this.map.get(key)
  }
  async put(entries: Record<string, unknown>) {
    for (const [k, v] of Object.entries(entries)) this.map.set(k, structuredClone(v))
  }
  async delete(keys: string[]) {
    let n = 0
    for (const k of keys) if (this.map.delete(k)) n++
    return n
  }
}

test('waking up mid-game keeps the host, the track and the round, and tells nobody anything', async () => {
  const before = makeCore()
  const [sa, sb] = [new Sock(), new Sock()]
  const a = before.newClient('', false)
  const b = before.newClient('', false)
  before.open(sa, a)
  before.open(sb, b)
  before.message(sa, a, JSON.stringify({ t: 'hello', v: 5, name: 'DAD', body: 'dart', paint: '#111111', glow: '#222222', trail: '#333333' }))
  before.message(sa, a, JSON.stringify({ t: 'track', file: { id: 'drawn', name: 'Drawn' }, params: { bankDeg: 12 } }))
  before.message(sb, b, JSON.stringify({ t: 'start', kind: 'tag', raceId: 9, round: 1, laps: 0, seconds: 300, itId: b.id, grid: [a.id, b.id] }))

  // Saved and loaded back the way the room does it.
  const store = new FakeStore()
  const { pieces, done } = saveMemory(store, before.memory(), true, 0)
  await done
  expect(pieces).toBe(1)
  const loaded = await loadMemory(store)
  expect(loaded.pieces).toBe(1)

  // The sockets carry their data through hibernation (serializeAttachment).
  const after = makeCore()
  const outBefore = [sa.out.length, sb.out.length]
  after.restore(
    [
      { sock: sa, data: structuredClone(a) },
      { sock: sb, data: structuredClone(b) },
    ],
    loaded.memory,
  )
  expect([sa.out.length, sb.out.length]).toEqual(outBefore)

  const sc = new Sock()
  const c = after.newClient('', false)
  expect(c.id).toBe(b.id + 1)
  after.open(sc, c)
  const w = sc.out[0]
  expect(w.t).toBe('welcome')
  expect(w.hostId).toBe(a.id)
  expect(w.track?.file?.id).toBe('drawn')
  expect(w.live?.raceId).toBe(9)
  expect(w.peers.find((p: any) => p.id === a.id)?.hello?.name).toBe('DAD')
})

test('a host that left while the room slept is replaced on waking, and its track is forgotten', async () => {
  const before = makeCore()
  const [sa, sb] = [new Sock(), new Sock()]
  const a = before.newClient('', false)
  const b = before.newClient('', false)
  before.open(sa, a)
  before.open(sb, b)
  before.message(sa, a, JSON.stringify({ t: 'track', file: { id: 'drawn' }, params: {} }))
  const memory = before.memory()

  // Only b is still connected when the room wakes.
  const after = makeCore()
  after.restore([{ sock: sb, data: structuredClone(b) }], memory)
  expect(sb.out.at(-1)).toEqual({ t: 'host', id: b.id })
  expect(after.memory().hostTrack).toBeNull()
  // The close that woke it arrives for a player the room no longer lists: still announced.
  after.close(a, false)
  expect(sb.out.at(-1)).toEqual({ t: 'leave', id: a.id })
})

test('waking with nobody left forgets the round and the track, but keeps counting ids', async () => {
  const after = makeCore()
  after.restore([], { nextId: 40, hostId: 3, hostTrack: { t: 'track', file: { id: 'x' } as any, params: {} }, live: { msg: { t: 'start', kind: 'race', raceId: 1, round: 0, laps: 3, seconds: 0, itId: 0, grid: [3], from: 3 }, startedAt: Date.now() } })
  const m = after.memory()
  expect(m.hostTrack).toBeNull()
  expect(m.live).toBeNull()
  expect(m.hostId).toBe(0)
  expect(after.newClient('', false).id).toBe(40)
})

test('a big track is saved in pieces and comes back whole; a smaller one clears the old pieces', async () => {
  const store = new FakeStore()
  const bigFile = { id: 'huge', name: 'Huge', road: { points: Array.from({ length: 200_000 }, (_, i) => i * 1.5) } }
  const mem = { nextId: 5, hostId: 1, hostTrack: { t: 'track' as const, file: bigFile as any, params: {} }, live: null }
  const first = saveMemory(store, mem, true, 0)
  await first.done
  expect(first.pieces).toBeGreaterThan(1)
  const back = await loadMemory(store)
  expect(JSON.stringify(back.memory?.hostTrack)).toBe(JSON.stringify(mem.hostTrack))
  for (const [k, v] of store.map) if (k.startsWith('track.')) expect((v as string).length).toBeLessThanOrEqual(TRACK_PIECE_CHARS)

  const small = saveMemory(store, { ...mem, hostTrack: { t: 'track', file: { id: 'tiny' } as any, params: {} } }, true, first.pieces)
  await small.done
  expect(small.pieces).toBe(1)
  expect([...store.map.keys()].filter((k) => k.startsWith('track.'))).toEqual(['track.0'])
  expect((await loadMemory(store)).memory?.hostTrack?.file.id).toBe('tiny')

  // A save without the track keeps it.
  const quick = saveMemory(store, { ...mem, nextId: 9, hostTrack: null }, false, small.pieces)
  await quick.done
  const kept = await loadMemory(store)
  expect(kept.memory?.nextId).toBe(9)
  expect(kept.memory?.hostTrack?.file.id).toBe('tiny')
})

test('a remembered hello keeps only short text fields', () => {
  const core = makeCore()
  const s = new Sock()
  const d: ClientData = core.newClient('', false)
  core.open(s, d)
  core.message(s, d, JSON.stringify({ t: 'hello', v: 5, name: 'N'.repeat(500), body: 'dart', paint: 1, glow: '#fff', trail: '#fff', junk: 'x'.repeat(100_000) }))
  expect(d.hello).toEqual({ t: 'hello', v: 5, name: 'N'.repeat(64), body: 'dart', paint: '', glow: '#fff', trail: '#fff' })
  expect(JSON.stringify(d).length).toBeLessThan(16 * 1024)
})

test('the page picks its relay: LAN unchanged, https goes to wss://<host>/relay', () => {
  const lan = { protocol: 'http:', host: '192.168.0.10:5201', hostname: '192.168.0.10' }
  const local = { protocol: 'http:', host: 'localhost:5201', hostname: 'localhost' }
  const online = { protocol: 'https:', host: 'sundown.nathans-lab.fyi', hostname: 'sundown.nathans-lab.fyi' }
  expect(relayUrlFor(lan, null)).toBe('ws://192.168.0.10:5202')
  expect(relayUrlFor(local, null)).toBe('ws://localhost:5202')
  expect(relayUrlFor(local, '5218')).toBe('ws://localhost:5218')
  expect(relayUrlFor(local, 'nonsense')).toBe('ws://localhost:5202')
  expect(relayUrlFor(local, '')).toBe('ws://localhost:5202')
  expect(relayUrlFor(online, null)).toBe('wss://sundown.nathans-lab.fyi/relay')
  expect(relayUrlFor({ ...online, host: 'sundown.example:8443', hostname: 'sundown.example' }, null)).toBe('wss://sundown.example:8443/relay')
  expect(relayUrlFor(online, '5218')).toBe('wss://sundown.nathans-lab.fyi:5218')
})
