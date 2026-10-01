// ============================================================
//  TWO-CLIENT MULTIPLAYER CHECK - `bun run mp:check`
// ------------------------------------------------------------
//  Proves multiplayer end to end with two real browsers (headless
//  Chrome on the GPU), on PRIVATE ports so it never disturbs a game
//  someone is playing on 5201/5202:
//
//    relay  5218 (started here, in-process)
//    game   5219 (`vite --host`, started here unless --no-vite)
//
//  The HOST page loads from localhost (so the relay sees loopback and
//  makes it host); the JOINER loads from this machine's LAN address,
//  exactly like a second computer on the wifi would.
//
//  Sections (pick with --only client,game,...; default: all that apply):
//    client   the bare net client: connect, hello, host detection,
//             poses flowing, broken packets dropped, reconnect after a drop
//    game     both in a drive: each sees the other in `cars`, the
//             joiner got the host's track, a ram shoves the joiner
//    drawn    a track that exists only in the host's browser reaches
//             the joiner and is drivable there
//    race     (stage B) synced countdown, grid, finish, winner
//    tag      (stage B) "it" passes on contact
//
//  Options: --track <id> (default afterglow), --join-track <id> (the
//  joiner's own first track, default hyperdrome), --shots <dir> (default
//  /tmp/sr2/net), --no-vite (a vite is already running on --port),
//  --port 5219, --relay-port 5218, --headed, --live (serve the working
//  tree instead of a frozen snapshot copied to /tmp/sr2-mpcheck/game).
//
//  Exit code 0 only if every check that ran passed.
// ============================================================

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import puppeteer from 'puppeteer-core'
import type { Browser, Page } from 'puppeteer-core'
import { startRelay } from './relay'

// ---------------------------------------------------------------- options

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const flag = (name: string) => process.argv.includes(`--${name}`)

const GAME_PORT = Number(arg('port') ?? 5219)
const RELAY = Number(arg('relay-port') ?? 5218)
const TRACK = arg('track') ?? 'afterglow'
const JOIN_TRACK = arg('join-track') ?? 'hyperdrome'
const SHOTS = arg('shots') ?? '/tmp/sr2/net'
const ONLY = (arg('only') ?? 'client,game,drawn,race,tag').split(',')
mkdirSync(SHOTS, { recursive: true })
const ROOT = dirname(import.meta.dir)
const SNAPSHOT = join(arg('snapshot-dir') ?? '/tmp/sr2-mpcheck', 'game')

function lanIPv4(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) return a.address
  }
  return null
}

function findChrome(): string {
  const explicit = arg('chrome') ?? process.env.CHROME_PATH
  if (explicit && existsSync(explicit)) return explicit
  const cache = join(homedir(), '.cache', 'puppeteer', 'chrome')
  if (existsSync(cache)) {
    for (const v of readdirSync(cache).sort().reverse()) {
      const mac = join(cache, v, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')
      if (existsSync(mac)) return mac
      const linux = join(cache, v, 'chrome-linux64', 'chrome')
      if (existsSync(linux)) return linux
      const win = join(cache, v, 'chrome-win64', 'chrome.exe')
      if (existsSync(win)) return win
    }
  }
  for (const a of [
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
  ])
    if (existsSync(a)) return a
  throw new Error('No Chrome found. Pass --chrome <path> or set CHROME_PATH.')
}

// ---------------------------------------------------------------- tiny test kit

let failures = 0
let passes = 0
function check(name: string, ok: boolean, detail: unknown = ''): void {
  if (ok) passes++
  else failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Poll a page expression until it is truthy (returns its value) or time runs out (returns null). */
async function until<T>(page: Page, expr: string, ms = 8000): Promise<T | null> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const v = await page.evaluate(expr).catch(() => null)
    if (v) return v as T
    await sleep(100)
  }
  return null
}

async function openPage(browser: Browser, url: string, label: string): Promise<Page> {
  const page = await browser.newPage()
  page.on('console', (m) => {
    const t = m.type()
    if (t === 'error' || t === 'warn') console.log(`  [${label} ${t}] ${m.text()}`)
  })
  page.on('pageerror', (e) => console.log(`  [${label} threw] ${(e as Error).message}`))
  await page.goto(url, { waitUntil: 'load', timeout: 60000 })
  return page
}

// ---------------------------------------------------------------- servers

const relay = startRelay(RELAY, (l) => (flag('verbose') ? console.log(l) : undefined))
let vite: ReturnType<typeof Bun.spawn> | null = null
if (!flag('no-vite')) {
  // Serve a frozen SNAPSHOT of the game, not the live tree: other people
  // editing files mid-check would hot-reload the pages and wipe the test.
  // (--live serves the working tree instead.)
  let cwd = ROOT
  if (!flag('live')) {
    cwd = SNAPSHOT
    rmSync(SNAPSHOT, { recursive: true, force: true })
    mkdirSync(SNAPSHOT, { recursive: true })
    for (const entry of ['src', 'tracks', 'public', 'index.html', 'vite.config.ts', 'tsconfig.json', 'package.json']) {
      if (existsSync(join(ROOT, entry))) cpSync(join(ROOT, entry), join(SNAPSHOT, entry), { recursive: true })
    }
    symlinkSync(join(ROOT, 'node_modules'), join(SNAPSHOT, 'node_modules'))
    console.log(`serving a snapshot of the game from ${SNAPSHOT}`)
  }
  vite = Bun.spawn([join(ROOT, 'node_modules', '.bin', 'vite'), '--host', '--port', String(GAME_PORT), '--strictPort'], { cwd, stdout: 'ignore', stderr: 'inherit' })
}
{
  const t0 = Date.now()
  let up = false
  while (!up && Date.now() - t0 < 30000) {
    up = await fetch(`http://127.0.0.1:${GAME_PORT}/`).then((r) => r.ok).catch(() => false)
    if (!up) await sleep(250)
  }
  if (!up) throw new Error(`game server on ${GAME_PORT} never came up`)
}

const lan = lanIPv4()
if (!lan) throw new Error('No LAN address: the joiner needs one to look like a second computer.')
const hostBase = `http://localhost:${GAME_PORT}`
const joinBase = `http://${lan}:${GAME_PORT}`

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: !flag('headed'),
  defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
  args: [
    '--use-angle=metal',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--no-first-run',
  ],
})

try {
  // ============================================================ client
  if (ONLY.includes('client')) {
    console.log('\n== client: the bare net client (no game scene needed)')
    // Load the page (any URL without ?track) and drive client.ts directly.
    const q = `?mp=1&relay=${RELAY}`
    const host = await openPage(browser, `${hostBase}/${q}&name=HOSTY`, 'host')
    const join = await openPage(browser, `${joinBase}/${q}&name=JOINY&color=orange`, 'join')
    const start = `(async () => { const c = await import('/src/net/client.ts'); window.__netc = c; window.__nets = await import('/src/net/netStore.ts'); window.__netp = await import('/src/net/poses.ts'); c.startNet(); return true })()`
    await host.evaluate(start)
    await sleep(300)
    await join.evaluate(start)

    const hostState = await until<{ isHost: boolean; myId: number }>(host, `(() => { const s = window.__nets.getNet(); return s.status === 'online' && Object.keys(s.peers).length === 1 ? { isHost: s.isHost, myId: s.myId } : null })()`)
    const joinState = await until<{ isHost: boolean; hostId: number; peerName: string }>(join, `(() => { const s = window.__nets.getNet(); const p = Object.values(s.peers)[0]; return s.status === 'online' && p ? { isHost: s.isHost, hostId: s.hostId, peerName: p.name } : null })()`)
    check('host page is online and sees one peer', !!hostState, hostState ?? '')
    check('localhost page is the host', hostState?.isHost === true)
    check('LAN page is NOT the host and knows who is', joinState?.isHost === false && joinState?.hostId === hostState?.myId, joinState ?? '')
    check("joiner sees the host's name from hello", joinState?.peerName === 'HOSTY')

    // Poses: the host sends 30 packets; the joiner's buffer for the host fills.
    await host.evaluate(`(async () => { for (let i = 0; i < 30; i++) { window.__netc.sendPose(i, 2, -i, 0, 0, 0, 1, 100, 0.5, 0.1, 1); await new Promise(r => setTimeout(r, 16)) } })()`)
    const got = await until<{ n: number; x: number }>(join, `(() => { const s = window.__nets.getNet(); const b = window.__netp.peerPoses.get(s.hostId); return b && b.received >= 30 ? { n: b.received, x: b.latest(0) } : null })()`, 3000)
    check('30 pose packets arrive, newest last', got?.n === 30 && got?.x === 29, got ?? '')
    // The NaN firewall: a broken pose is never sent (or accepted).
    await host.evaluate(`window.__netc.sendPose(NaN, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0)`)
    await sleep(200)
    const after = await join.evaluate(`window.__netp.peerPoses.get(window.__nets.getNet().hostId).received`)
    check('a NaN pose is never sent', after === 30, `received=${after}`)
    // Receive side: a raw socket (no client code) pushes a NaN packet through the relay.
    const rawId = await host.evaluate(`new Promise((res) => { const w = new WebSocket('ws://localhost:${RELAY}'); w.binaryType = 'arraybuffer'; w.onmessage = (e) => { if (typeof e.data !== 'string') return; const m = JSON.parse(e.data); if (m.t !== 'welcome') return; const f = new Float32Array(11); f[0] = NaN; f[6] = 1; w.send(f); const g = new Float32Array(11); g[0] = 5; g[6] = 1; w.send(g); setTimeout(() => res(m.id), 300); setTimeout(() => w.close(), 1500) } })`)
    const rawSeen = await join.evaluate(`window.__netp.peerPoses.get(${rawId})?.received ?? 0`)
    check('the receive-side firewall drops a NaN packet and keeps the good one', rawSeen === 1, `raw sender ${rawId}: received=${rawSeen}`)

    // Reconnect: cut the joiner's socket; it heals and is welcomed again.
    const oldId = await join.evaluate(`window.__nets.getNet().myId`)
    await join.evaluate(`window.__netc.dropConnection()`)
    const healed = await until<number>(join, `(() => { const s = window.__nets.getNet(); return s.status === 'online' && s.myId !== ${oldId} && Object.keys(s.peers).length === 1 ? s.myId : 0 })()`, 6000)
    check('joiner reconnects by itself after a drop (new id, host still listed)', !!healed, `old=${oldId} new=${healed}`)
    const hostSeesNew = await until<boolean>(host, `(() => !!window.__nets.getNet().peers[${healed ?? -1}])()`, 3000)
    check('host sees the reconnected joiner', !!hostSeesNew)

    // Host leaves: the joiner (only one left) becomes host.
    await host.close()
    const promoted = await until<boolean>(join, `window.__nets.getNet().isHost`, 3000)
    check('when the host leaves, the joiner takes over hosting', !!promoted)
    await join.close()
  }

  // ============================================================ game sections
  const gameSections = ['game', 'drawn', 'race', 'tag'].filter((s) => ONLY.includes(s))
  if (gameSections.length) {
    const { runGameChecks } = await import('./mp-check-game')
    await runGameChecks({ browser, hostBase, joinBase, relayPort: RELAY, track: TRACK, joinTrack: JOIN_TRACK, shots: SHOTS, sections: gameSections, check, until, openPage, sleep })
  }
} catch (err) {
  failures++
  console.log(`FAIL  crashed: ${(err as Error).stack ?? err}`)
} finally {
  await browser.close()
  relay.stop(true)
  vite?.kill()
}

console.log(`\n${passes} passed, ${failures} failed`)
process.exit(failures ? 1 : 0)
