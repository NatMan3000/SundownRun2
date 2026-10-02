// ============================================================
//  MULTIPLAYER LAUNCHER - `bun run mp` and you're racing
// ------------------------------------------------------------
//  One command on ONE computer (the host). It starts:
//    - the relay (server/relay.ts) on port 5202, inside this process
//    - the game's dev server (vite) on port 5201 with --host, so other
//      computers on the same wifi can load the game straight from here
//  and prints the links to open. Nobody else installs anything: they
//  open the link in a browser and they're in.
//
//  The host's track (even one drawn in the editor) is sent to everyone
//  who joins, so only the host picks the track.
//
//  Testing on other ports: `bun server/mp.ts --port 5219 --relay-port 5218`
//  (the links then carry &relay=5218 so the page finds that relay).
//
//  Ctrl+C stops everything.
// ============================================================

import { networkInterfaces } from 'node:os'
import { startRelay } from './relay'
import { GAME_PORT, RELAY_PORT } from '../src/net/protocol'

function numArg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`)
  const n = i >= 0 ? Number(process.argv[i + 1]) : NaN
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback
}

const gamePort = numArg('port', GAME_PORT)
const relayPort = numArg('relay-port', RELAY_PORT)

/** Adapters that are usually NOT the wifi / ethernet a friend can reach. */
const VIRTUAL = /vethernet|virtualbox|vmware|docker|wsl|hyper-v|utun|bridge|tailscale|zerotier|loopback|vpn/i

/** Every usable IPv4 address, the most likely "real LAN" one first. */
function lanAddresses(): string[] {
  const found: { address: string; score: number }[] = []
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      // 169.254.* is link-local noise (no router handed it out) - never give that to a kid.
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue
      let score = 0
      if (a.address.startsWith('192.168.')) score += 3
      else if (a.address.startsWith('10.')) score += 2
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(a.address)) score += 1
      if (VIRTUAL.test(name)) score -= 5
      found.push({ address: a.address, score })
    }
  }
  return found.sort((x, y) => y.score - x.score).map((f) => f.address)
}

// ---- output: colour only where the console understands it ----
// Classic Windows consoles print ANSI escape codes as garbage; Windows
// Terminal (WT_SESSION) is fine.
const tty = process.platform !== 'win32' || !!process.env.WT_SESSION
const amber = tty ? '\x1b[33m' : ''
const cyan = tty ? '\x1b[36m' : ''
const bold = tty ? '\x1b[1m' : ''
const dim = tty ? '\x1b[2m' : ''
const reset = tty ? '\x1b[0m' : ''

const relay = startRelay(relayPort)

const vite = Bun.spawn(['bun', 'run', 'dev', '--host', '--port', String(gamePort), '--strictPort'], {
  stdout: 'inherit',
  stderr: 'inherit',
})

/** Poll the game server until it answers, so the links we print actually work. */
async function waitForGame(timeoutMs: number): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${gamePort}/`)
      if (r.ok) return true
    } catch {
      // not up yet
    }
    await Bun.sleep(250)
  }
  return false
}

const relayQuery = relayPort === RELAY_PORT ? '' : `&relay=${relayPort}`

const up = await waitForGame(30000)
const ips = lanAddresses()
const firewall =
  process.platform === 'win32'
    ? `Friends can't connect? Windows Firewall must let ports ${gamePort}-${relayPort} in.
  "Sundown Run II Multiplayer.bat" adds that rule for you (click YES once).`
    : process.platform === 'darwin'
      ? `Friends can't connect? If macOS asks whether "bun" may accept incoming
  connections, click Allow (System Settings > Network > Firewall).`
      : `Friends can't connect? Allow TCP ports ${gamePort}-${relayPort} in through the firewall.`

console.log(`
${bold}${amber}  SUNDOWN RUN II - MULTIPLAYER${reset}
${up ? '' : `\n  ${amber}The game server is slow to start - the links below work once it is up.${reset}\n`}
  This computer (the host):  ${bold}${cyan}http://localhost:${gamePort}/?mp=1&name=JOSH${relayQuery}${reset}
  Other computers:           ${bold}${cyan}${ips[0] ? `http://${ips[0]}:${gamePort}/?mp=1&name=DAD&color=orange${relayQuery}` : '(no network address found - is the wifi on?)'}${reset}
${ips.length > 1 ? `  ${dim}If that one doesn't load, try: ${ips.slice(1).map((ip) => `http://${ip}:${gamePort}/?mp=1&name=DAD&color=orange${relayQuery}`).join('  ')}${reset}\n` : ''}
  ${dim}Change name=... to your own name, and color=... to orange, yellow, mint,
  pink, purple, cyan, red or white (or a hex code like %23ff8a3d) so every car
  looks different. The host picks the track - everyone else gets it sent over,
  even one you drew in the editor. Press G (or X on the controller) to start a
  race for everyone, or a tag round in Tag mode.

  ${firewall}

  Ctrl+C stops everything.${reset}
`)

let stopping = false
const shutdown = () => {
  if (stopping) return
  stopping = true
  vite.kill()
  relay.stop(true)
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

await vite.exited
if (!stopping) {
  console.log(`\n  The game server stopped (port ${gamePort} busy? Is another copy already running?).`)
  relay.stop(true)
  process.exit(1)
}
