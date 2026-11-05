// ============================================================
//  DEV SERVER CHECK - the game server never hands out the GitHub key
// ------------------------------------------------------------
//  `bun run mp` starts the dev server with --host, so everyone on the wifi can ask it for files.
//  This starts the dev server AND the production preview on scratch ports, from a throwaway
//  COPY of the game folder holding a FAKE github-token.txt (never the real one: the real key is
//  not read, copied or touched), and asks for the key and its neighbours every way we know.
//  Fails on any answer, whatever its status, whose body holds a fake file's contents (the
//  single-page fallback answers unknown paths with index.html and a 200: told apart by body).
//  It also checks the game and its two post-office routes still answer.
//
//    bun run dev:check [--port 5221]     (uses port and port+1 for the two servers)
// ============================================================

import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { startFakeGithub } from '../server/fakeGithub'

const ROOT = join(import.meta.dir, '..')
const flag = process.argv.indexOf('--port')
const devPort = flag > 0 ? Number(process.argv[flag + 1]) : 5221
const previewPort = devPort + 1

let fails = 0
const ok = (c: boolean, s: string, extra?: unknown) => {
  console.log(`${c ? 'PASS' : 'FAIL'} ${s}${!c && extra !== undefined ? ` ${JSON.stringify(extra)}` : ''}`)
  if (!c) fails++
}

// ---- a throwaway copy of the game folder with fake secrets in it
const KEY = 'fakekey_dev_check_0123456789abcdef'
const secrets: Record<string, string> = {
  'github-token.txt': KEY,
  '.env': 'FAKE_ENV_SECRET_7f3a',
  '.env.local': 'FAKE_ENV_LOCAL_SECRET_7f3a',
  'cert.pem': 'FAKE_PEM_SECRET_7f3a',
  'reports/pending/r1.json': 'FAKE_REPORT_SECRET_7f3a',
  '.git/config': 'FAKE_GIT_SECRET_7f3a',
}
const markers = Object.values(secrets)
const tmp = mkdtempSync(join(tmpdir(), 'sr2-dev-check-'))
for (const item of ['index.html', 'vite.config.ts', 'package.json', 'tsconfig.json', 'src', 'server', 'public', 'tracks', 'cloud', 'docs', 'spec']) {
  if (existsSync(join(ROOT, item))) cpSync(join(ROOT, item), join(tmp, item), { recursive: true })
}
symlinkSync(join(ROOT, 'node_modules'), join(tmp, 'node_modules'))
for (const [file, text] of Object.entries(secrets)) {
  mkdirSync(dirname(join(tmp, file)), { recursive: true })
  writeFileSync(join(tmp, file), text)
}

// The post office posts to a fake GitHub, never the real one; the waiting pile is elsewhere than the bait in reports/.
const fake = startFakeGithub({ keys: { [KEY]: { push: true, login: 'owner' } } })
const pending = mkdtempSync(join(tmpdir(), 'sr2-dev-check-pending-'))
const env: Record<string, string | undefined> = { ...process.env, SR2_ISSUES_API: fake.url, SR2_REPORTS_DIR: pending }
delete env.SR2_GITHUB_TOKEN

const vite = join(tmp, 'node_modules', '.bin', 'vite')
const kids: ReturnType<typeof Bun.spawn>[] = []
const run = (args: string[]) => {
  const p = Bun.spawn([vite, ...args], { cwd: tmp, env, stdout: 'pipe', stderr: 'pipe' })
  kids.push(p)
  return p
}
const cleanup = () => {
  for (const k of kids) k.kill()
  fake.stop()
  rmSync(tmp, { recursive: true, force: true })
  rmSync(pending, { recursive: true, force: true })
}
process.on('SIGINT', () => {
  cleanup()
  process.exit(130)
})

async function waitUp(port: number): Promise<boolean> {
  for (let i = 0; i < 240; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/`)).status > 0) return true
    } catch {
      // not up yet
    }
    await Bun.sleep(250)
  }
  return false
}

/** A request line sent as-is (fetch tidies ".." away before it leaves). */
async function rawGet(port: number, path: string): Promise<{ status: number; body: string }> {
  let body = ''
  const sock = await Bun.connect({
    hostname: '127.0.0.1',
    port,
    socket: {
      data(_s, d) {
        body += d.toString()
      },
      close() {},
      error() {},
    },
  })
  sock.write(`GET ${path} HTTP/1.0\r\nHost: 127.0.0.1:${port}\r\n\r\n`)
  await Bun.sleep(600)
  sock.end()
  return { status: Number(/^HTTP\/1\.\d (\d+)/.exec(body)?.[1] ?? 0), body }
}

/** Ask for the key and its neighbours every way we know; no body may hold a fake file's contents. */
async function probeSecrets(label: string, port: number): Promise<void> {
  const paths = [
    '/github-token.txt',
    '/github-token.txt?raw',
    '/github-token.txt?import',
    '/github-token.txt?url',
    `/@fs${tmp}/github-token.txt`,
    `/@fs${tmp}/github-token.txt?raw`,
    '/.env',
    '/.env.local',
    '/cert.pem',
    '/reports/',
    '/reports/pending/r1.json',
    '/.git/config',
    '/src/../github-token.txt',
    '/src/%2e%2e/github-token.txt',
  ]
  for (const p of paths) {
    let status = 0
    let body = ''
    try {
      if (p.includes('..')) ({ status, body } = await rawGet(port, p))
      else {
        const r = await fetch(`http://127.0.0.1:${port}${p}`)
        status = r.status
        body = await r.text()
      }
    } catch (e) {
      body = String(e)
    }
    const leaked = markers.find((m) => body.includes(m))
    ok(!leaked, `${label}: ${p} (${status}) does not hand out a secret`, leaked ? `body holds "${leaked}"` : undefined)
  }
}

/** The game and its two post-office routes still answer. */
async function probeGame(label: string, port: number): Promise<void> {
  const home = await fetch(`http://127.0.0.1:${port}/`)
  const html = await home.text()
  ok(home.status === 200 && html.includes('<div id="root"'), `${label}: the game page loads`, home.status)
  if (label === 'dev') {
    const main = await fetch(`http://127.0.0.1:${port}/src/main.tsx`)
    ok(main.status === 200 && (await main.text()).includes('import'), `${label}: the game's own code is still served`, main.status)
  }
  const report = await fetch(`http://127.0.0.1:${port}/api/report`)
  const info = (await report.json().catch(() => null)) as { ready?: boolean } | null
  ok(report.status === 200 && info?.ready === true, `${label}: /api/report answers and finds the key`, { status: report.status, info })
  const tracks = await fetch(`http://127.0.0.1:${port}/api/tracks`)
  const list = (await tracks.json().catch(() => null)) as { status?: string } | null
  ok(tracks.status === 200 && typeof list?.status === 'string', `${label}: /api/tracks answers`, { status: tracks.status, list })
}

try {
  const dev = run(['--host', '0.0.0.0', '--port', String(devPort), '--strictPort'])
  ok(await waitUp(devPort), 'the dev server starts')
  await probeGame('dev', devPort)
  await probeSecrets('dev', devPort)
  dev.kill()

  const build = run(['build', '--logLevel', 'error'])
  const built = await build.exited
  ok(built === 0, 'the production build runs', built === 0 ? undefined : await new Response(build.stderr as ReadableStream).text())
  if (built === 0) {
    run(['preview', '--host', '0.0.0.0', '--port', String(previewPort), '--strictPort'])
    ok(await waitUp(previewPort), 'the preview server starts')
    await probeGame('preview', previewPort)
    await probeSecrets('preview', previewPort)
  }
} finally {
  cleanup()
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS')
process.exit(fails ? 1 : 0)
