// ============================================================
//  MULTIPLAYER RELAY - a dumb, fast fan-out. Runs with Bun.
// ------------------------------------------------------------
//  No rooms, no passwords, almost no game logic: every message a
//  client sends is passed on to every other client.
//
//    binary pose packets  -> a 4-byte sender id is glued on the front
//    JSON messages        -> a `from` field is added
//
//  The few things it remembers, so a player who joins late catches up:
//    - each player's latest `hello` (name, car, colours)
//    - who the HOST is: the player whose browser runs on this same
//      machine (it connects from loopback, 127.0.0.1). If nobody is on
//      loopback, the player who has been here longest hosts instead.
//    - the host's latest track file, sent to every joiner in `welcome`
//      (that is how a track drawn in the host's browser reaches you)
//    - the race or tag round in progress
//
//  Runs on its own (`bun run relay`, optional `--port 5218`) or inside
//  `bun run mp` (server/mp.ts).
//
//  Outside tsconfig's `include`: Bun runs it directly. Bun-specific
//  types are kept loose so the editor stays quiet without @types/bun.
// ============================================================

import { MAX_MESSAGE_BYTES, POSE_BYTES, PROTOCOL_VERSION, RELAY_PORT } from '../src/net/protocol'
import type { HelloMsg, StartMsg, TrackMsg, WelcomeMsg } from '../src/net/protocol'

interface ClientData {
  id: number
  hello: HelloMsg | null
  /** Connected from this machine (127.0.0.1 / ::1) - a candidate for host. */
  loopback: boolean
  address: string
}

/** A live race or tag round, remembered for late joiners. */
interface LiveRound {
  msg: StartMsg & { from: number }
  startedAt: number
}

/** How long a remembered round stays "live" if nobody says otherwise. */
const RACE_MEMORY_MS = 20 * 60 * 1000

function isLoopback(address: string): boolean {
  return address === '::1' || address === '127.0.0.1' || address.startsWith('127.') || address === '::ffff:127.0.0.1'
}

export function startRelay(port = RELAY_PORT, log: (line: string) => void = (l) => console.log(l)) {
  let nextId = 1
  // Bun's ServerWebSocket carries our ClientData in .data
  const clients = new Map<number, { ws: any; data: ClientData }>()
  let hostId = 0
  let hostTrack: TrackMsg | null = null
  let live: LiveRound | null = null

  const send = (ws: any, payload: string | Uint8Array) => {
    // send() returns 0 when the socket is closed / -1 on backpressure; a dead
    // socket is reaped by its close handler, so nothing to do here.
    ws.send(payload)
  }

  const broadcast = (except: number, payload: string | Uint8Array) => {
    for (const [id, c] of clients) if (id !== except) send(c.ws, payload)
  }

  /** Lowest-id loopback client, else lowest-id client, else 0 (nobody). */
  const pickHost = (): number => {
    let best = 0
    for (const [id, c] of clients) if (c.data.loopback && (best === 0 || id < best)) best = id
    if (best) return best
    for (const id of clients.keys()) if (best === 0 || id < best) best = id
    return best
  }

  /** Re-pick the host; if it changed, forget the old host's track and tell everyone. */
  const refreshHost = () => {
    const next = pickHost()
    if (next === hostId) return
    hostId = next
    // The new host sends its own track as soon as it hears it is host.
    hostTrack = null
    if (hostId) {
      const who = clients.get(hostId)?.data.hello?.name ?? `player ${hostId}`
      log(`[relay] host is now ${who} (${hostId})`)
    }
    for (const c of clients.values()) send(c.ws, JSON.stringify({ t: 'host', id: hostId }))
  }

  const liveRound = (): LiveRound | null => {
    if (!live) return null
    const limit = live.msg.kind === 'tag' ? (live.msg.seconds + 15) * 1000 : RACE_MEMORY_MS
    if (Date.now() - live.startedAt > limit) live = null
    return live
  }

  const server = (Bun as any).serve({
    port,
    hostname: '0.0.0.0',
    fetch(req: Request, srv: any) {
      const address: string = srv.requestIP(req)?.address ?? ''
      const data: ClientData = { id: nextId++, hello: null, loopback: isLoopback(address), address }
      if (srv.upgrade(req, { data })) return undefined
      return new Response('Sundown Run II relay - connect with a WebSocket.\n', { status: 200 })
    },
    websocket: {
      // A tab that reloads or crashes can leave a half-open socket: a "zombie"
      // player parked in everyone's list. Live clients send stats twice a
      // second even when their tab is hidden, so 30 s of silence means gone.
      idleTimeout: 30,
      maxPayloadLength: MAX_MESSAGE_BYTES,
      open(ws: any) {
        const data: ClientData = ws.data
        clients.set(data.id, { ws, data })
        const prevHost = hostId
        // Pick the host BEFORE the welcome so the newcomer learns the truth.
        const next = pickHost()
        const round = liveRound()
        const welcome: WelcomeMsg = {
          t: 'welcome',
          v: PROTOCOL_VERSION,
          id: data.id,
          hostId: next,
          peers: [...clients.values()].filter((c) => c.data.id !== data.id).map((c) => ({ id: c.data.id, hello: c.data.hello })),
          track: next === prevHost ? hostTrack : null,
          live: round ? { ...round.msg, startedAgoMs: Date.now() - round.startedAt } : null,
        }
        send(ws, JSON.stringify(welcome))
        broadcast(data.id, JSON.stringify({ t: 'join', id: data.id }))
        log(`[relay] player ${data.id} connected from ${data.loopback ? 'this machine' : data.address} (${clients.size} online)`)
        refreshHost()
      },
      message(ws: any, message: string | Uint8Array) {
        const data: ClientData = ws.data
        if (typeof message !== 'string') {
          // Pose packet: check the size, tag it with the sender id, fan it out.
          if (message.byteLength !== POSE_BYTES) return
          const tagged = new Uint8Array(4 + POSE_BYTES)
          new DataView(tagged.buffer).setUint32(0, data.id, true)
          tagged.set(message, 4)
          broadcast(data.id, tagged)
          return
        }
        let msg: any
        try {
          msg = JSON.parse(message)
        } catch {
          return
        }
        if (!msg || typeof msg.t !== 'string') return
        switch (msg.t) {
          case 'ping':
            // Answer the sender alone: this measures the round trip to the relay.
            send(ws, JSON.stringify({ t: 'pong', c: msg.c }))
            return
          case 'hello':
            if (data.hello?.name !== msg.name) log(`[relay] player ${data.id} is "${msg.name}"`)
            data.hello = msg
            break
          case 'track':
            // Only the host decides the track. Anyone else's is ignored.
            if (data.id !== hostId || !msg.file || typeof msg.file !== 'object') return
            hostTrack = { t: 'track', file: msg.file, params: msg.params ?? {} }
            log(`[relay] host track: ${String(msg.file.name ?? msg.file.id)} (${Math.round(message.length / 1024)} KB)`)
            break
          case 'start':
            live = { msg: { ...msg, from: data.id }, startedAt: Date.now() }
            log(`[relay] ${msg.kind} started by player ${data.id}`)
            break
          case 'rejoin':
            // A racer came back with a new id: keep the remembered round in step.
            if (live && live.msg.raceId === msg.raceId) {
              live.msg.grid = live.msg.grid.map((id: number) => (id === msg.oldId ? data.id : id))
              if (live.msg.itId === msg.oldId) live.msg.itId = data.id
              log(`[relay] player ${msg.oldId} rejoined the ${live.msg.kind} as ${data.id}`)
            }
            break
        }
        msg.from = data.id
        broadcast(data.id, JSON.stringify(msg))
      },
      close(ws: any) {
        const data: ClientData = ws.data
        if (!clients.delete(data.id)) return
        broadcast(data.id, JSON.stringify({ t: 'leave', id: data.id }))
        log(`[relay] player ${data.id} left (${clients.size} online)`)
        if (clients.size === 0) live = null
        refreshHost()
      },
    },
  })

  log(`[relay] listening on ws://0.0.0.0:${server.port}`)
  return server
}

/** `--port 5218` or RELAY_PORT=5218, else the reserved 5202. */
function portFromArgs(): number {
  const i = process.argv.indexOf('--port')
  const raw = i >= 0 ? process.argv[i + 1] : process.env.RELAY_PORT
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : RELAY_PORT
}

if ((import.meta as any).main) startRelay(portFromArgs())
