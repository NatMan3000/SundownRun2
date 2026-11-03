// ============================================================
//  THE ROOM - the internet relay, as a Cloudflare Durable Object
// ------------------------------------------------------------
//  One room for everyone (the Worker always asks for the room named
//  "main"). Every player's browser connects OUT to it, so neither
//  house has to let anything in, and nobody's computer hosts.
//
//  The relay's rules are server/relayCore.ts, the same brain the LAN
//  relay (server/relay.ts) uses. This file is only the socket side:
//
//    - sockets are taken with the Hibernation API (ctx.acceptWebSocket),
//      so Cloudflare can put the room to sleep with players still
//      connected and wake it on their next message. In practice that
//      rarely happens mid-game: every client sends stats twice a second.
//    - a sleep wipes memory, so each player's details live on their own
//      socket (serializeAttachment) and the room's memory (next id, the
//      host's track, the round in progress) is saved in the room's own
//      storage (memoryStore.ts). The constructor rebuilds from both.
//      Losing it all once the last player leaves is fine (the relay
//      forgets it then anyway).
//    - nobody connects from loopback here, so the player who has been
//      in the room longest is the host.
//    - a player silent for 30 s is a zombie (a tab that crashed, a lid
//      shut): the room closes them. The LAN relay gets this from Bun's
//      idleTimeout; here it is checked whenever anyone else talks or
//      joins, which needs no timer and so never keeps the room awake.
// ============================================================

import { DurableObject } from 'cloudflare:workers'
import { IDLE_TIMEOUT_S, RelayCore } from '../server/relayCore'
import type { ClientData, MemoryPart } from '../server/relayCore'
import { loadMemory, saveMemory } from './memoryStore'

export interface Env {
  ROOM: DurableObjectNamespace<Room>
  ASSETS: Fetcher
}

/** How often the room checks for silent players, at most (ms). */
const REAP_EVERY_MS = 5000
/** How often the room logs its incoming message rate while anyone is here (ms). */
const RATE_LOG_MS = 60_000
/** The host drags a live slider: save its track once it settles, not on every step. */
const TRACK_SAVE_DELAY_MS = 1000

export class Room extends DurableObject<Env> {
  private readonly core: RelayCore<WebSocket>
  /** When each player last said anything (wall clock, ms), by relay id. Not saved: a wake-up starts everyone fresh. */
  private readonly lastSeen = new Map<number, number>()
  /** Players already handed to the core as gone (a close and an error can both arrive for one socket). */
  private readonly closed = new Set<number>()
  /** Each socket's data, read off it once (60 pose packets a second each would otherwise unpack it every time). */
  private readonly dataBySocket = new WeakMap<WebSocket, ClientData>()
  private lastReap = 0
  private rateSince = Date.now()
  private trackPieces = 0
  private trackTimer: ReturnType<typeof setTimeout> | null = null

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.core = new RelayCore<WebSocket>({
      send: (ws, payload) => {
        try {
          ws.send(payload)
        } catch {
          // Already closing: its close event tidies up.
        }
      },
      log: (line) => console.log(line),
      onClientData: (ws, data) => ws.serializeAttachment(data),
      onMemory: (what) => this.remember(what),
    })
    // Nothing else may run until the room is rebuilt from the sockets and its saved memory.
    void ctx.blockConcurrencyWhile(async () => {
      try {
        const now = Date.now()
        const connections: { sock: WebSocket; data: ClientData }[] = []
        for (const ws of ctx.getWebSockets()) {
          const data = ws.deserializeAttachment() as ClientData | null
          if (!data || typeof data.id !== 'number') continue
          connections.push({ sock: ws, data })
          this.dataBySocket.set(ws, data)
          this.lastSeen.set(data.id, now)
        }
        const { memory, pieces } = await loadMemory(ctx.storage)
        this.trackPieces = pieces
        this.core.restore(connections, memory)
        if (connections.length) console.log(`[relay] woke up with ${connections.length} online`)
        // An empty room keeps no track or round: make the saved copy say so too.
        else if (memory && (memory.hostTrack || memory.live)) await this.save(true)
      } catch (err) {
        // A broken save must never lock the room: start empty-handed instead.
        console.error('[relay] could not rebuild the room', err)
      }
    })
  }

  /** The Worker hands every /relay request here. */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Sundown Run II relay - connect with a WebSocket.\n', { status: 426 })
    }
    this.reapSilent(true)
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    // In the cloud nobody is on the relay's own machine: loopback is always false, so the longest-present player hosts.
    // The player's address is left out: it would only end up in the logs.
    const data = this.core.newClient('', false)
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment(data)
    this.dataBySocket.set(server, data)
    this.lastSeen.set(data.id, Date.now())
    if (this.core.size === 0) {
      // A fresh session: count its rate from now.
      this.rateSince = Date.now()
      this.core.takeIncoming()
    }
    this.core.open(server, data)
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const data = this.dataOf(ws)
    if (!data) return
    this.lastSeen.set(data.id, Date.now())
    try {
      if (this.core.message(ws, data, message) === 'too-big') {
        // The LAN relay's Bun closes the socket the same way (1009: message too big).
        this.drop(ws, data, 1009, 'message too big')
        return
      }
    } catch (err) {
      // One odd message must never take the room down for everyone.
      console.error(`[relay] message from player ${data.id} failed`, err)
    }
    this.reapSilent(false)
    this.logRate()
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.gone(ws)
    // Answer the player's goodbye. Without this the browser waits (seen: over 8 s under
    // wrangler dev) before it believes the socket is closed, so a reconnect after a drop stalls.
    const sendable = code === 1000 || (code >= 1001 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999)
    try {
      ws.close(sendable ? code : 1000, reason)
    } catch {
      // Already closed.
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.gone(ws)
  }

  // ---------------------------------------------------------------- inside

  private dataOf(ws: WebSocket): ClientData | null {
    const known = this.dataBySocket.get(ws)
    if (known) return known
    const data = ws.deserializeAttachment() as ClientData | null
    if (!data || typeof data.id !== 'number') return null
    this.dataBySocket.set(ws, data)
    return data
  }

  private gone(ws: WebSocket): void {
    const data = this.dataOf(ws)
    if (data) this.forget(data)
  }

  /** Tell the core a player is gone, once. Unlisted is fine: one that closed while the room slept is still announced. */
  private forget(data: ClientData): void {
    if (this.closed.has(data.id)) return
    this.closed.add(data.id)
    this.lastSeen.delete(data.id)
    this.core.close(data, false)
  }

  private drop(ws: WebSocket, data: ClientData, code: number, reason: string): void {
    this.forget(data)
    try {
      ws.close(code, reason)
    } catch {
      // Already closed.
    }
  }

  /** Close anyone silent for longer than the LAN relay's idle timeout. */
  private reapSilent(force: boolean): void {
    const now = Date.now()
    if (!force && now - this.lastReap < REAP_EVERY_MS) return
    this.lastReap = now
    for (const ws of this.ctx.getWebSockets()) {
      const data = this.dataOf(ws)
      if (!data) continue
      const seen = this.lastSeen.get(data.id) ?? now
      if (now - seen > IDLE_TIMEOUT_S * 1000) {
        console.log(`[relay] player ${data.id} has been silent for ${IDLE_TIMEOUT_S} s: closing`)
        this.drop(ws, data, 1001, 'silent too long')
      }
    }
  }

  /** Once a minute: incoming messages per second (what the free plan counts, 20 messages = 1 request). */
  private logRate(): void {
    const now = Date.now()
    if (now - this.rateSince < RATE_LOG_MS) return
    const n = this.core.takeIncoming()
    const perS = n / ((now - this.rateSince) / 1000)
    this.rateSince = now
    console.log(`[relay] ${this.core.size} online, ${perS.toFixed(1)} messages/s in (${(perS / 20).toFixed(2)} requests/s)`)
  }

  /** Save the room memory: ids and rounds straight away, the track once it settles. */
  private remember(what: MemoryPart): void {
    if (what === 'track') {
      if (this.trackTimer) clearTimeout(this.trackTimer)
      this.trackTimer = setTimeout(() => {
        this.trackTimer = null
        void this.save(true)
      }, TRACK_SAVE_DELAY_MS)
      return
    }
    void this.save(false)
  }

  private async save(withTrack: boolean): Promise<void> {
    try {
      const { pieces, done } = saveMemory(this.ctx.storage, this.core.memory(), withTrack, this.trackPieces)
      this.trackPieces = pieces
      await done
    } catch (err) {
      console.error('[relay] could not save the room memory', err)
    }
  }
}
