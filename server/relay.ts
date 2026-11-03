// ============================================================
//  MULTIPLAYER RELAY - a dumb, fast fan-out. Runs with Bun.
// ------------------------------------------------------------
//  No rooms, no passwords, almost no game logic: every message a
//  client sends is passed on to every other client. What it does with
//  each message, and what it remembers for late joiners (hellos, who
//  hosts, the host's track, the round in progress), lives in
//  server/relayCore.ts, shared with the internet relay (cloud/room.ts).
//  This file is only the Bun socket around it.
//
//  Runs on its own (`bun run relay`, optional `--port 5218`) or inside
//  `bun run mp` (server/mp.ts).
//
//  Outside tsconfig's `include`: Bun runs it directly. Bun-specific
//  types are kept loose so the editor stays quiet without @types/bun.
// ============================================================

import { RELAY_PORT, MAX_MESSAGE_BYTES } from '../src/net/protocol'
import { IDLE_TIMEOUT_S, RelayCore, type ClientData } from './relayCore'

export function startRelay(port = RELAY_PORT, log: (line: string) => void = (l) => console.log(l)) {
  // Bun's ServerWebSocket carries our ClientData in .data
  const core = new RelayCore<any>({
    // send() returns 0 when the socket is closed / -1 on backpressure; a dead
    // socket is reaped by its close handler, so nothing to do here.
    send: (ws, payload) => ws.send(payload),
    log,
  })

  const server = (Bun as any).serve({
    port,
    hostname: '0.0.0.0',
    fetch(req: Request, srv: any) {
      const address: string = srv.requestIP(req)?.address ?? ''
      if (srv.upgrade(req, { data: core.newClient(address) })) return undefined
      return new Response('Sundown Run II relay - connect with a WebSocket.\n', { status: 200 })
    },
    websocket: {
      // A tab that reloads or crashes can leave a half-open socket: a "zombie"
      // player parked in everyone's list. Live clients send stats twice a
      // second even when their tab is hidden, so 30 s of silence means gone.
      idleTimeout: IDLE_TIMEOUT_S,
      maxPayloadLength: MAX_MESSAGE_BYTES,
      open(ws: any) {
        core.open(ws, ws.data as ClientData)
      },
      message(ws: any, message: string | Uint8Array) {
        core.message(ws, ws.data as ClientData, message)
      },
      close(ws: any) {
        core.close(ws.data as ClientData)
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
