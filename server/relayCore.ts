// ============================================================
//  RELAY CORE - the relay's one brain, with no network in it
// ------------------------------------------------------------
//  Every rule about what the relay does with a message lives here,
//  and nothing else: no sockets, no ports, no timers. Two relays
//  use it, so they can never drift apart:
//
//    server/relay.ts    the LAN relay (Bun, `bun run mp`)
//    cloud/room.ts      the internet relay (a Cloudflare Durable Object)
//
//  Each one hands the core its own socket type (`S`) and a send()
//  that knows how to write to it.
//
//  What the core does:
//    binary pose packets  -> a 4-byte sender id is glued on the front
//    JSON messages        -> a `from` field is added
//  and what it remembers, so a player who joins late catches up:
//    - each player's latest `hello` (name, car, colours)
//    - who the HOST is: the player whose browser runs on the relay's own
//      machine (it connects from loopback, 127.0.0.1). If nobody is on
//      loopback (always the case in the cloud), the player who has been
//      here longest hosts instead.
//    - the host's latest track file, sent to every joiner in `welcome`
//    - the race, tag or Hunt Turns round in progress
//
//  Like protocol.ts, this file imports nothing at runtime except
//  protocol.ts, so Bun and the Cloudflare runtime both run it as is.
// ============================================================

import { MAX_MESSAGE_BYTES, POSE_BYTES, PROTOCOL_VERSION } from '../src/net/protocol'
import type { HelloMsg, StartMsg, TrackMsg, WelcomeMsg } from '../src/net/protocol'

/** What the relay knows about one connection. Plain data: the cloud relay keeps it on the socket. */
export interface ClientData {
  id: number
  hello: HelloMsg | null
  /** Connected from the relay's own machine (127.0.0.1 / ::1) - a candidate for host. Never true in the cloud. */
  loopback: boolean
  address: string
}

/** A live race or tag round, remembered for late joiners. */
export interface LiveRound {
  msg: StartMsg & { from: number }
  startedAt: number
}

/** Everything the room remembers beyond its connections (the cloud relay saves it, to survive an eviction). */
export interface RoomMemory {
  nextId: number
  /** Who hosts (0 = nobody), so a wake-up can tell whether the host left while the room slept. */
  hostId: number
  hostTrack: TrackMsg | null
  live: LiveRound | null
}

export interface RelayCoreOptions<S> {
  /** Write to one socket. Must not throw for a socket that is already closed. */
  send: (sock: S, payload: string | Uint8Array) => void
  log?: (line: string) => void
  now?: () => number
  /** Called when a client's remembered data changes (its hello), so the transport can keep it. */
  onClientData?: (sock: S, data: ClientData) => void
  /** Called when the room memory changes (a new id handed out, the host's track, the live round). */
  onMemory?: (what: MemoryPart) => void
}

export type MemoryPart = 'nextId' | 'host' | 'track' | 'live'

/** How long a remembered round stays "live" if nobody says otherwise. */
export const RACE_MEMORY_MS = 20 * 60 * 1000

/** A live client says something at least twice a second (stats); this long silent means gone. */
export const IDLE_TIMEOUT_S = 30

/** What a remembered hello keeps: the fields a welcome needs, each a short string. */
const HELLO_TEXT = 64

export function isLoopback(address: string): boolean {
  return address === '::1' || address === '127.0.0.1' || address.startsWith('127.') || address === '::ffff:127.0.0.1'
}

/** UTF-8 size of a string, counted only when it could be near the limit. */
function tooBig(message: string | Uint8Array): boolean {
  if (typeof message !== 'string') return message.byteLength > MAX_MESSAGE_BYTES
  if (message.length > MAX_MESSAGE_BYTES) return true
  if (message.length * 3 <= MAX_MESSAGE_BYTES) return false
  return new TextEncoder().encode(message).byteLength > MAX_MESSAGE_BYTES
}

/**
 * The copy of a hello the relay keeps for welcomes: only the fields a peer reads,
 * each a short string, so a huge or odd hello can't bloat every welcome (or the
 * cloud relay's per-socket memory, which has a 16 KB cap). The hello itself is
 * still passed on to everyone exactly as sent.
 */
function rememberHello(msg: any): HelloMsg {
  const text = (x: unknown) => (typeof x === 'string' ? x.slice(0, HELLO_TEXT) : '')
  return { t: 'hello', v: Number(msg.v) || 0, name: text(msg.name), body: text(msg.body), paint: text(msg.paint), glow: text(msg.glow), trail: text(msg.trail) }
}

export type MessageResult = 'ok' | 'too-big'

export class RelayCore<S> {
  private readonly clients = new Map<number, { sock: S; data: ClientData }>()
  private nextId = 1
  private hostId = 0
  private hostTrack: TrackMsg | null = null
  private live: LiveRound | null = null
  private readonly send: (sock: S, payload: string | Uint8Array) => void
  private readonly log: (line: string) => void
  private readonly now: () => number
  private readonly onClientData?: (sock: S, data: ClientData) => void
  private readonly onMemory?: (what: MemoryPart) => void
  /** Messages received since the counter was last read (for the cloud relay's budget log). */
  private incoming = 0

  constructor(opts: RelayCoreOptions<S>) {
    this.send = opts.send
    this.log = opts.log ?? (() => {})
    this.now = opts.now ?? (() => Date.now())
    this.onClientData = opts.onClientData
    this.onMemory = opts.onMemory
  }

  // ---------------------------------------------------------------- state for the transports

  get size(): number {
    return this.clients.size
  }

  /** The room memory, to save. */
  memory(): RoomMemory {
    return { nextId: this.nextId, hostId: this.hostId, hostTrack: this.hostTrack, live: this.live }
  }

  /** Messages received since the last call. */
  takeIncoming(): number {
    const n = this.incoming
    this.incoming = 0
    return n
  }

  /**
   * Rebuild after the cloud relay was woken from hibernation (or evicted) with players
   * still connected: the same connections, the saved memory, and the host they already
   * know about. Nobody is told anything unless the host left while the room slept
   * (then everyone hears the new host, exactly as if it had happened awake).
   */
  restore(connections: { sock: S; data: ClientData }[], memory: RoomMemory | null): void {
    this.clients.clear()
    for (const c of connections) this.clients.set(c.data.id, c)
    let maxId = 0
    for (const id of this.clients.keys()) maxId = Math.max(maxId, id)
    this.nextId = Math.max(memory?.nextId ?? 1, maxId + 1)
    // Nobody here: the round and the track are over (the relay forgets them the same way when the last one leaves).
    const anyone = this.clients.size > 0
    this.hostId = anyone ? (memory?.hostId ?? this.pickHost()) : 0
    this.hostTrack = anyone ? (memory?.hostTrack ?? null) : null
    this.live = anyone ? (memory?.live ?? null) : null
    this.refreshHost()
  }

  // ---------------------------------------------------------------- connections

  /** A new connection's data, with the next id. Call before open(). */
  newClient(address: string, loopback = isLoopback(address)): ClientData {
    const data: ClientData = { id: this.nextId++, hello: null, loopback, address }
    this.onMemory?.('nextId')
    return data
  }

  open(sock: S, data: ClientData): void {
    this.clients.set(data.id, { sock, data })
    const prevHost = this.hostId
    // Pick the host BEFORE the welcome so the newcomer learns the truth.
    const next = this.pickHost()
    const round = this.liveRound()
    const welcome: WelcomeMsg = {
      t: 'welcome',
      v: PROTOCOL_VERSION,
      id: data.id,
      hostId: next,
      peers: [...this.clients.values()].filter((c) => c.data.id !== data.id).map((c) => ({ id: c.data.id, hello: c.data.hello })),
      track: next === prevHost ? this.hostTrack : null,
      live: round ? { ...round.msg, startedAgoMs: this.now() - round.startedAt } : null,
    }
    this.send(sock, JSON.stringify(welcome))
    this.broadcast(data.id, JSON.stringify({ t: 'join', id: data.id }))
    this.log(`[relay] player ${data.id} connected from ${data.loopback ? 'this machine' : data.address || 'the internet'} (${this.clients.size} online)`)
    this.refreshHost()
  }

  /** One message from a client. 'too-big' means the transport should close that socket (Bun does it by itself). */
  message(sock: S, sent: ClientData, raw: string | Uint8Array | ArrayBuffer): MessageResult {
    this.incoming++
    // The room's own record of this player: the cloud relay hands in a fresh copy read off the socket.
    const data = this.clients.get(sent.id)?.data ?? sent
    const message = raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw
    if (tooBig(message)) return 'too-big'
    if (typeof message !== 'string') {
      // Pose packet: check the size, tag it with the sender id, fan it out.
      if (message.byteLength !== POSE_BYTES) return 'ok'
      const tagged = new Uint8Array(4 + POSE_BYTES)
      new DataView(tagged.buffer).setUint32(0, data.id, true)
      tagged.set(message, 4)
      this.broadcast(data.id, tagged)
      return 'ok'
    }
    let msg: any
    try {
      msg = JSON.parse(message)
    } catch {
      return 'ok'
    }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return 'ok'
    switch (msg.t) {
      case 'ping':
        // Answer the sender alone: this measures the round trip to the relay.
        this.send(sock, JSON.stringify({ t: 'pong', c: msg.c }))
        return 'ok'
      case 'hello':
        if (data.hello?.name !== msg.name) this.log(`[relay] player ${data.id} is "${String(msg.name)}"`)
        data.hello = rememberHello(msg)
        this.onClientData?.(sock, data)
        break
      case 'track':
        // Only the host decides the track. Anyone else's is ignored.
        if (data.id !== this.hostId || !msg.file || typeof msg.file !== 'object') return 'ok'
        this.hostTrack = { t: 'track', file: msg.file, params: msg.params ?? {} }
        this.onMemory?.('track')
        this.log(`[relay] host track: ${String(msg.file.name ?? msg.file.id)} (${Math.round(message.length / 1024)} KB)`)
        break
      case 'start':
        this.live = { msg: { ...msg, from: data.id }, startedAt: this.now() }
        this.onMemory?.('live')
        this.log(`[relay] ${msg.kind} started by player ${data.id}`)
        break
      case 'rejoin': {
        // A racer came back with a new id: keep the remembered round in step.
        const live = this.live
        if (live && live.msg.raceId === msg.raceId && Array.isArray(live.msg.grid)) {
          live.msg.grid = live.msg.grid.map((id: number) => (id === msg.oldId ? data.id : id))
          if (live.msg.itId === msg.oldId) live.msg.itId = data.id
          this.onMemory?.('live')
          this.log(`[relay] player ${msg.oldId} rejoined the ${live.msg.kind} as ${data.id}`)
        }
        break
      }
    }
    msg.from = data.id
    this.broadcast(data.id, JSON.stringify(msg))
    return 'ok'
  }

  /**
   * A connection ended (closed, errored or reaped). Safe to call twice.
   * `known` false: a player the room no longer lists (it closed while the cloud room
   * slept, so the wake-up never saw it): everyone is still told it left.
   */
  close(data: ClientData, known = true): void {
    if (!this.clients.delete(data.id) && known) return
    this.broadcast(data.id, JSON.stringify({ t: 'leave', id: data.id }))
    this.log(`[relay] player ${data.id} left (${this.clients.size} online)`)
    if (this.clients.size === 0 && this.live) {
      this.live = null
      this.onMemory?.('live')
    }
    this.refreshHost()
  }

  // ---------------------------------------------------------------- inside

  private broadcast(except: number, payload: string | Uint8Array): void {
    for (const [id, c] of this.clients) if (id !== except) this.send(c.sock, payload)
  }

  /** Lowest-id loopback client, else lowest-id client, else 0 (nobody). */
  private pickHost(): number {
    let best = 0
    for (const [id, c] of this.clients) if (c.data.loopback && (best === 0 || id < best)) best = id
    if (best) return best
    for (const id of this.clients.keys()) if (best === 0 || id < best) best = id
    return best
  }

  /** Re-pick the host; if it changed, forget the old host's track and tell everyone. */
  private refreshHost(): void {
    const next = this.pickHost()
    if (next === this.hostId) return
    this.hostId = next
    this.onMemory?.('host')
    // The new host sends its own track as soon as it hears it is host.
    if (this.hostTrack) {
      this.hostTrack = null
      this.onMemory?.('track')
    }
    if (this.hostId) {
      const who = this.clients.get(this.hostId)?.data.hello?.name ?? `player ${this.hostId}`
      this.log(`[relay] host is now ${who} (${this.hostId})`)
    }
    for (const c of this.clients.values()) this.send(c.sock, JSON.stringify({ t: 'host', id: this.hostId }))
  }

  private liveRound(): LiveRound | null {
    const live = this.live
    if (!live) return null
    const m = live.msg
    // Hunt Turns: one turn per player, each followed by a break.
    const turns = m.kind === 'turns' && m.turns ? m.turns : null
    const players = Array.isArray(m.grid) ? m.grid.length : 0
    const limit = m.kind === 'tag' ? (m.seconds + 15) * 1000 : turns ? players * (m.seconds * 1000 + turns.breakMs) + 15000 : RACE_MEMORY_MS
    if (this.now() - live.startedAt > limit) {
      this.live = null
      this.onMemory?.('live')
    }
    return this.live
  }
}
